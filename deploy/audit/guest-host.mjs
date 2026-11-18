import { randomUUID } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';
import { imageId, privateJSON, publicState, requireThat, same, sha } from '../../scripts/production-host.mjs';
import { hashFile, releaseCache, remoteStream, run, vmArgs } from '../../scripts/production-release.mjs';

const pool = '/var/lib/libvirt/images/allnutrition-audit';
const golden = join(pool, 'golden.qcow2');
const journal = '/var/lib/allnutrition-audit/active-guest.json';
const virsh = (args, options) => run('/usr/bin/virsh', ['--connect', 'qemu:///system', ...args], options);
const xml = value => value.replaceAll('&', '&amp;').replaceAll("'", '&apos;').replaceAll('<', '&lt;');

async function sourceArchive(commit) {
  requireThat(sha.test(commit), 'Falta fuente comprobada de la unidad desplegada.');
  const directory = join(releaseCache(), 'cache', 'sources', commit);
  const names = readdirSync(directory).filter(name => /^[a-f0-9]{64}\.tar\.gz$/.test(name)).sort();
  requireThat(names.length > 0, 'Falta el archivo sellado de la fuente desplegada.');
  const path = join(directory, names[0]);
  requireThat(lstatSync(path).isFile() && await hashFile(path) === names[0].slice(0, 64), 'Fuente alterada en caché.');
  requireThat(run('/bin/bash', ['-c', 'git get-tar-commit-id < <(gzip -dc "$1")', 'audit', path]).trim() === commit,
    'El tar de fuente no acredita su SHA desplegado.');
  return { path, name: `source-${commit}.tar.gz` };
}

async function imageArchive(id, work) {
  requireThat(imageId.test(id), 'Identidad de imagen inválida.');
  const name = `image-${id.slice(7)}.tar.gz`;
  const cached = join(releaseCache(), 'cache', 'images', `${id.slice(7)}.tar.gz`);
  if (existsSync(cached)) {
    requireThat(lstatSync(cached).isFile(), 'La caché de imagen no es un archivo regular.');
    return { path: cached, name };
  }
  const path = join(work, name);
  // The VM sees a read-only image export by full ID; no Docker socket on the host is opened.
  const { process, exit } = remoteStream(['-a', ...vmArgs(`exec docker image save ${id}`, true)]);
  process.stdin.end();
  try {
    await Promise.all([pipeline(process.stdout, createGzip({ level: 1 }), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(30 * 60_000) }), exit]);
  } catch {
    process.kill();
    throw Error('No se pudo transferir una imagen desplegada por ID.');
  }
  return { path, name };
}

export function auditGuestDomain(uuid, work) {
  return `<domain type='kvm'>
  <name>allnutrition-audit-${uuid.slice(0, 8)}</name><uuid>${uuid}</uuid>
  <memory unit='MiB'>12288</memory><vcpu>4</vcpu>
  <cputune><shares>128</shares></cputune>
  <os><type arch='x86_64' machine='q35'>hvm</type><boot dev='hd'/></os>
  <features><acpi/><apic/></features><cpu mode='host-passthrough'/>
  <on_poweroff>destroy</on_poweroff><on_reboot>destroy</on_reboot><on_crash>destroy</on_crash>
  <devices>
    <disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='${xml(join(work, 'overlay.qcow2'))}'/><target dev='vda' bus='virtio'/>
      <backingStore type='file'><format type='qcow2'/><source file='${xml(golden)}'><seclabel model='dac' relabel='no'/></source><backingStore/></backingStore></disk>
    <disk type='file' device='disk'><driver name='qemu' type='raw'/><source file='${xml(join(work, 'input.iso'))}'><seclabel model='dac' relabel='no'/></source><target dev='vdb' bus='virtio'/><readonly/></disk>
    <interface type='user'><mac address='52:54:00:68:57:16'/><model type='virtio'/></interface>
    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>
    <memballoon model='virtio'/>
  </devices>
</domain>`;
}

async function guestProof(uuid, mode) {
  function agent(execute, args, optional = false) {
    const reply = virsh(['qemu-agent-command', '--timeout', '5', uuid, JSON.stringify({ execute, arguments: args })], { optional, timeout: 10_000 });
    return reply === null ? null : JSON.parse(reply);
  }
  const bootDeadline = Date.now() + 180_000;
  let ready = false;
  while (!ready && Date.now() < bootDeadline) {
    ready = agent('guest-ping', {}, true)?.return !== undefined;
    if (!ready) await delay(2000);
  }
  requireThat(ready, 'El agente del invitado de auditoría no inició.');
  const launch = 'set -eu; at=$(mktemp -d /run/allnutrition-driver-XXXXXX); trap \'umount "$at"; rmdir "$at"\' EXIT; test "$(blockdev --getro /dev/vdb)" = 1; mount -t iso9660 -o ro,nodev,noexec,nosuid /dev/vdb "$at"; /usr/local/bin/node "$at/driver.mjs"';
  const pid = agent('guest-exec', { path: '/bin/bash', arg: ['-c', launch], 'capture-output': true })?.return?.pid;
  requireThat(Number.isSafeInteger(pid) && pid > 0, 'No se pudo iniciar el arnés de auditoría en el invitado.');
  const deadline = Date.now() + (mode === 'pair' ? 30 * 60_000 : 5 * 60 * 60_000);
  while (Date.now() < deadline) {
    const status = agent('guest-exec-status', { pid })?.return;
    if (status?.exited) {
      const detail = Buffer.from(status['err-data'] || '', 'base64').toString('utf8').trim();
      const failureStage = /^audit-guest:[a-z-]+$/.test(detail) ? ` ${detail}` : '';
      requireThat(status.exitcode === 0 && !status['out-truncated'] && typeof status['out-data'] === 'string' && status['out-data'].length < 170_000,
        `La suite del invitado falló (${status.exitcode ?? status.signal ?? 'sin evidencia'}).${failureStage}`);
      return JSON.parse(Buffer.from(status['out-data'], 'base64').toString('utf8'));
    }
    await delay(5000);
  }
  throw Error('Plazo del invitado agotado.');
}

function cleanupGuest() {
  if (!existsSync(journal)) return;
  const entry = lstatSync(journal);
  requireThat(entry.isFile() && entry.uid === 0 && !(entry.mode & 0o077) && entry.size < 4096, 'Registro de invitado inválido.');
  const { uuid, name } = JSON.parse(readFileSync(journal, 'utf8'));
  requireThat(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid) && /^run-[a-zA-Z0-9]{6}$/.test(name), 'Identidad de huésped inválida.');
  const exists = () => virsh(['list', '--all', '--uuid']).split(/\s+/).includes(uuid);
  if (exists()) {
    requireThat(virsh(['domname', uuid]).trim() === `allnutrition-audit-${uuid.slice(0, 8)}`, 'Identidad del dominio inesperada; no se detuvo.');
    virsh(['destroy', uuid], { timeout: 120_000 });
  }
  requireThat(!exists(), 'No se retiró el invitado; se conservaron sus archivos aislados.');
  rmSync(join(pool, name), { recursive: true, force: true });
  rmSync(journal);
}

export async function runAuditGuest(manifest, { mode = 'full', bundleSha256 } = {}) {
  requireThat(['pair', 'full'].includes(mode) && (bundleSha256 === undefined || mode === 'pair' && /^[a-f0-9]{64}$/.test(bundleSha256)), 'Modo o comprobante de imágenes inválido.');
  requireThat(!existsSync(journal), 'Hay un invitado de auditoría pendiente de limpieza.');
  const storage = lstatSync(pool);
  requireThat(storage.isDirectory() && storage.uid === 0 && !(storage.mode & 0o022), 'El directorio de trabajo del hipervisor debe estar controlado por root.');
  const base = lstatSync(golden);
  requireThat(base.isFile() && base.uid === 0 && !(base.mode & 0o222), 'La imagen golden del invitado debe ser de root y de solo lectura.');
  const info = JSON.parse(run('/usr/bin/qemu-img', ['info', '--output=json', golden]));
  requireThat(info.format === 'qcow2' && !info['backing-filename'] && !info['format-specific']?.data?.['data-file'], 'Golden debe ser qcow2 autónoma, sin backing ni datos externos.');
  const work = mkdtempSync(join(pool, 'run-')), uuid = randomUUID();
  requireThat(/^run-[a-zA-Z0-9]{6}$/.test(work.split('/').at(-1)), 'Identificador temporal inesperado.');
  privateJSON(journal, { uuid, name: work.split('/').at(-1) });
  try {
    const commits = mode === 'pair' ? [manifest.coveredThrough, manifest.configCommit]
      : [manifest.coveredThrough, manifest.configCommit, ...Object.values(manifest.services).map(ref => ref.sourceCommit)];
    const inputs = [];
    for (const commit of new Set(commits)) inputs.push(await sourceArchive(commit));
    const bundleIds = bundleSha256 ? [...new Set(Object.values(manifest.services)
      .filter(ref => ref.sourceCommit === manifest.coveredThrough).map(ref => ref.imageId))] : [];
    if (bundleSha256) {
      const path = join(releaseCache(), 'cache', 'bundles', `${bundleSha256}.tar.gz`);
      requireThat(bundleIds.length && lstatSync(path).isFile() && await hashFile(path) === bundleSha256, 'Bundle candidato no acreditado.');
      inputs.push({ path, name: 'bundle.tar.gz' });
    }
    for (const id of new Set(Object.values(manifest.services).map(ref => ref.imageId))) if (!bundleIds.includes(id)) inputs.push(await imageArchive(id, work));
    const hashes = {};
    for (const { path, name } of inputs) hashes[name] = await hashFile(path);
    const input = join(work, 'snapshot.json');
    privateJSON(input, { format: 1, mode, manifest, hashes, bundleIds });
    run('/usr/bin/xorriso', ['-abort_on', 'FAILURE', '-outdev', join(work, 'input.iso'), '-volid', 'ALLNUTRITION_AUDIT', '-rockridge', 'on', '-compliance', 'iso_9660_level=3', '-map', input, '/snapshot.json',
      '-map', fileURLToPath(new URL('./guest.mjs', import.meta.url)), '/driver.mjs',
      ...inputs.flatMap(({ path, name }) => ['-map', path, `/${name}`]), '-commit', '-end'], { timeout: 30 * 60_000 });
    run('/usr/bin/qemu-img', ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', golden, join(work, 'overlay.qcow2')]);
    chmodSync(join(work, 'input.iso'), 0o444);
    chmodSync(work, 0o711); // Allow libvirt's QEMU user to traverse; original archives stay private.
    const definition = join(work, 'domain.xml');
    writeFileSync(definition, auditGuestDomain(uuid, work), { mode: 0o600, flag: 'wx' });
    virsh(['create', definition], { timeout: 180_000 });
    return await guestProof(uuid, mode);
  } finally {
    cleanupGuest();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireThat(process.getuid() === 0 && !existsSync('/home/allnutrition/app/.env.server.local'), 'Operación reservada al recolector del constructor.');
    const [, , operation, path, bundle, ...extra] = process.argv;
    if (operation === '--cleanup' && !path) cleanupGuest();
    else if (operation === '--pair' && path && !extra.length) {
      const manifest = publicState(JSON.parse(readFileSync(path, 'utf8')));
      const proof = await runAuditGuest(manifest, { mode: 'pair', bundleSha256: bundle });
      const ids = Object.fromEntries(Object.entries(manifest.services).map(([service, ref]) => [service, ref.imageId]));
      requireThat(proof.accepted === true && proof.zeroOwnedLeftovers === true && same(proof.images, ids), 'El invitado no acreditó el conjunto exacto de imágenes.');
      console.log(JSON.stringify({ accepted: true, zeroOwnedLeftovers: true, images: ids }));
    } else throw Error('Uso: guest-host.mjs --cleanup | --pair <manifest.json> [bundle-sha256]; ejecutar bajo audit.lock.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
