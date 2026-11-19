import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { join, resolve } from 'node:path';
import { createDeploymentEnv } from '../../scripts/deploy-env.mjs';

const database = 'allnutrition_test';
const defaultDbImage = 'postgres:16-bookworm';
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const privateDirectories = {
  INTEGRATION_SECRETS_DIR: 'integration-secrets',
  SOCIAL_BROWSER_CONTROL_DIR: 'social-browser-control',
  SOCIAL_MEDIA_DIR: 'social-media',
};

// Forward PostgreSQL's TLS stream unchanged. Only Docker's loopback port is published.
const relay = `const net = require('node:net');
net.createServer(client => {
  const db = net.connect(5432, 'db');
  db.on('error', () => client.destroy());
  client.on('error', () => db.destroy());
  db.pipe(client).pipe(db);
}).listen(5432, '0.0.0.0');`;

function assertHttpsHealth(origin, ca) {
  return new Promise((resolve, reject) => {
    const request = get(new URL('/api/health', origin), {
      ca, family: 4, rejectUnauthorized: true, agent: false, timeout: 12_000,
    }, response => {
      response.resume();
      response.once('error', reject);
      response.once('end', () => {
        if (response.statusCode === 200) resolve();
        else reject(new Error(`El fixture HTTPS devolvió salud ${response.statusCode}.`));
      });
    });
    request.once('timeout', () => request.destroy(new Error('Plazo de salud HTTPS del fixture agotado.')));
    request.once('error', reject);
  });
}

async function setupAdvertisingFixture(kind, { appImage, checksImage, dbImage, configRoot = process.cwd(), run, availablePort, suffix = 'local' }) {
  assert.match(suffix, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  const id = `guided-${kind}-${suffix}-${randomBytes(6).toString('hex')}`;
  const project = `allnutrition-${id}`;
  const root = resolve('.test-data/docker', id);
  const approval = kind === 'approval';
  const projectFilter = ['--filter', `label=com.docker.compose.project=${project}`];
  // Do not inherit deployment interpolation, profiles, or Compose env files.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|HOME|XDG_RUNTIME_DIR|DOCKER_CONFIG|DOCKER_CONTEXT|DOCKER_HOST|DOCKER_CERT_PATH|DOCKER_TLS|DOCKER_TLS_VERIFY)$/.test(key)));
  const docker = (args, label, options) => run('docker', args, `${project}: ${label}`, {
    env, quiet: true, logOutput: false, ...options,
  });

  async function resolveImage(reference, label, pullDefault = false) {
    const { tag, id: expected } = typeof reference === 'string' ? { tag: reference } : reference ?? {};
    assert(typeof tag === 'string' && tag && !tag.startsWith('-'), `Falta la referencia local de la imagen ${label}.`);
    const args = ['image', 'inspect', '--format', '{{.Id}}', tag];
    let result = await docker(args, `identidad de imagen ${label}`, { allowFailure: pullDefault });
    if (pullDefault && result.status !== 0 && !result.error && /No such (?:image|object)/i.test(result.stderr)) {
      await docker(['pull', tag], 'descarga de PostgreSQL descartable', { timeout: 300_000 });
      result = await docker(args, `identidad de imagen ${label}`);
    }
    assert(!result.error && result.status === 0, `No se pudo inspeccionar la imagen ${label}.`);
    const actual = result.stdout.trim();
    assert.match(actual, imageIdPattern, `No se obtuvo el ID de la imagen ${label}.`);
    if (expected !== undefined) assert.equal(actual, expected, `La imagen ${label} no coincide con el ID esperado.`);
    return actual;
  }

  async function projectContainers(options) {
    const result = await docker(['ps', '--all', '--quiet', '--no-trunc', ...projectFilter], 'contenedores del fixture', options);
    return result.stdout.trim().split(/\s+/).filter(Boolean);
  }

  async function inspectContainers(containers) {
    assert(containers.length, 'El fixture no creó contenedores.');
    return JSON.parse((await docker(['container', 'inspect', ...containers], 'identidad de los contenedores')).stdout);
  }

  let compose, ownsRoot = false, started = false, cleaned = false;
  const cleanupOptions = { cleanup: true };
  async function cleanup() {
    if (cleaned) return;
    if (started) {
      // A timed-out Compose run can leave behind a running one-off container.
      const containers = await projectContainers(cleanupOptions);
      if (containers.length) await docker(['container', 'rm', '--force', ...containers], 'retiro de contenedores del fixture', cleanupOptions);
      await compose(['down', '--volumes', '--remove-orphans'], 'eliminación del proyecto descartable', cleanupOptions);
      assert.equal((await projectContainers(cleanupOptions)).length, 0, 'Quedaron contenedores del fixture.');
      for (const kind of ['volume', 'network']) {
        const { stdout } = await docker([kind, 'ls', '--quiet', ...projectFilter], `limpieza de ${kind}`, cleanupOptions);
        assert.equal(stdout.trim(), '', `Quedaron recursos Docker (${kind}) del fixture.`);
      }
    }
    if (ownsRoot) rmSync(root, { recursive: true, force: true });
    cleaned = true;
  }

  try {
    const appId = await resolveImage(appImage, 'web');
    const checksId = await resolveImage(checksImage, 'checks');
    const dbId = await resolveImage(dbImage ?? defaultDbImage, 'db', dbImage === undefined);
    const httpsPort = await availablePort(0);
    let dbPort;
    if (approval) {
      dbPort = await availablePort(15433);
      if (dbPort === httpsPort) dbPort = await availablePort(0);
      assert.notEqual(dbPort, httpsPort, 'El relay y HTTPS requieren puertos distintos.');
    }
    assert(!existsSync(root), 'El directorio del fixture no es nuevo.');
    ownsRoot = true;
    const origin = `https://localhost:${httpsPort}`;
    const { envFile, values, reused } = createDeploymentEnv('test', { id });
    assert(!reused && values.POSTGRES_DB === database, 'Se requiere una base de prueba nueva.');
    const publicationWorker = 'tests/e2e/guided-publication-worker.mjs';
    const audienceWorker = 'tests/e2e/guided-audience-provider.mjs';
    const controlledPublication = !approval && existsSync(join(configRoot, publicationWorker));
    const controlledAudience = !approval && existsSync(join(configRoot, audienceWorker));
    Object.assign(env, { APP_IMAGE: appId, APP_URL: origin, HTTPS_PORT: String(httpsPort) });
    const services = { db: { image: dbId }, checks: { image: checksId }, web: {} };
    const hostDirectories = {};
    if (controlledPublication) services.web.environment = { SOCIAL_BROWSER_URL: 'http://127.0.0.1:3320' };
    if (approval) {
      // The host Playwright fixture and the web must have the same UID to use
      // the 0700 binds. /tmp avoids UID 1000-owned /app ancestors in the keyring.
      services.web = { user: `${values.LOCAL_UID}:${values.LOCAL_GID}`, environment: { HOME: '/tmp' }, volumes: [] };
      for (const [key, name] of Object.entries(privateDirectories)) {
        const path = join(root, name);
        mkdirSync(path, { mode: 0o700 });
        hostDirectories[key] = realpathSync(path);
        services.web.environment[key] = `/tmp/e2e-${name}`;
        services.web.volumes.push({
          type: 'bind', source: hostDirectories[key], target: services.web.environment[key],
          bind: { create_host_path: false },
        });
      }
      services['db-relay'] = {
        image: appId, networks: ['backend', 'frontend'], ports: [`127.0.0.1:${dbPort}:5432`],
        command: ['node', '-e', relay],
      };
    }
    const override = join(root, 'advertising-fixture.compose.json');
    writeFileSync(override, `${JSON.stringify({ services, networks: { social_egress: { internal: true } } })}\n`, { mode: 0o600, flag: 'wx' });
    const staging = existsSync(join(configRoot, 'compose.staging.yaml')) ? configRoot : process.cwd();
    const composeArgs = ['compose', '-p', project, '--env-file', envFile, '-f', join(configRoot, 'compose.yaml'), '-f', join(staging, 'compose.staging.yaml'), '-f', override];
    compose = (args, label, options) => docker([...composeArgs, ...args], label, options);
    await compose(['config', '--quiet'], 'validación de Compose');

    // Never let dependencies start the scheduler or the publication consumer.
    const up = (list, pull = 'never') => compose(['up', '-d', '--no-deps', '--no-build', '--pull', pull, '--wait', '--wait-timeout', '120', ...list], `arranque de ${list.join(', ')}`, { timeout: 180_000 });
    const oneOff = async (service, image, command = []) => {
      const name = `${project}-${service}`;
      await compose(['run', '--no-deps', '--pull', 'never', '-T', '--name', name, service, ...command], `ejecución de ${service}`, { timeout: 600_000 });
      const [{ Image, Config }] = await inspectContainers([name]);
      assert.equal(Config.Labels['com.docker.compose.project'], project);
      assert.equal(Image, image, `El servicio ${service} no usó la imagen esperada.`);
      await docker(['container', 'rm', name], `retiro de ${service}`);
    };

    started = true;
    await up(['db']);
    await oneOff('migrate', appId);
    await oneOff('checks', checksId, ['node', 'tests/e2e/setup.mjs']);
    await up(approval ? ['web', 'db-relay'] : ['web']);
    if (controlledPublication) await compose(['exec', '-d', 'web', 'node', publicationWorker, 'serve', '-', origin], 'runner sintético de publicación');
    if (controlledAudience) await compose(['exec', '-d', 'web', 'node', audienceWorker, 'serve', origin], 'proveedor sintético de audiencia');
    if (controlledPublication || controlledAudience) {
      const ports = [...(controlledPublication ? [3320] : []), ...(controlledAudience ? [3339] : [])];
      await compose(['exec', '-T', 'web', 'node', '-e', `
        const net = require('node:net');
        const { setTimeout: wait } = require('node:timers/promises');
        const ready = port => new Promise(resolve => {
          const socket = net.connect(port, '127.0.0.1');
          socket.once('connect', () => { socket.end(); resolve(true); });
          socket.once('error', () => resolve(false));
          socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
        });
        (async () => {
          for (const port of ${JSON.stringify(ports)}) {
            for (let attempt = 0; !await ready(port); attempt++) {
              if (attempt === 29) throw Error('Fixture de ensayo sin escucha loopback: ' + port);
              await wait(100);
            }
          }
        })().catch(error => { console.error(error.message); process.exitCode = 1; });
      `], 'disponibilidad de transportes privados');
    }
    await up(['proxy'], 'missing');

    const expected = { db: dbId, web: appId, proxy: null, ...(approval && { 'db-relay': appId }) };
    const containers = await inspectContainers(await projectContainers());
    assert.deepEqual(containers.map(container => container.Config.Labels['com.docker.compose.service']).sort(), Object.keys(expected).sort(), 'El fixture tiene servicios ajenos o faltantes.');
    for (const container of containers) {
      const service = container.Config.Labels['com.docker.compose.service'];
      assert(container.State.Running, `El servicio ${service} no está en ejecución.`);
      if (expected[service]) assert.equal(container.Image, expected[service], `El servicio ${service} no usa la imagen esperada.`);
      const ports = Object.values(container.NetworkSettings.Ports ?? {}).flatMap(bindings => bindings ?? []);
      const hostPort = service === 'proxy' ? httpsPort : service === 'db-relay' ? dbPort : undefined;
      assert.deepEqual(ports, hostPort === undefined ? [] : [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }], `Puertos imprevistos en ${service}.`);
    }
    if (approval) {
      await compose(['exec', '-T', 'web', 'node', '-e', `const fs = require('node:fs');
        for (const key of ${JSON.stringify(Object.keys(privateDirectories))}) {
          const stat = fs.lstatSync(process.env[key]);
          if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) throw Error(key + ': se requiere un bind privado 0700 del usuario del fixture');
        }`], 'custodia, control y medios privados');
    }
    const { stdout } = await compose(['exec', '-T', 'proxy', 'wget', '-qO-', 'http://127.0.0.1:2019/pki/ca/local'], 'CA pública del proxy de prueba');
    const ca = JSON.parse(stdout).root_certificate;
    assert(typeof ca === 'string' && ca.includes('BEGIN CERTIFICATE'), 'No se obtuvo la CA de prueba.');
    await assertHttpsHealth(origin, ca);

    const environment = approval ? {
      E2E_BASE_URL: origin,
      E2E_ALLOW_SELF_SIGNED: '1',
      ADVERTISING_APPROVAL_COMPOSE_PROJECT: project,
      TEST_DATABASE_URL: `postgresql://postgres:${values.POSTGRES_PASSWORD}@127.0.0.1:${dbPort}/${database}`,
      TEST_ALLOW_DATABASE_RESET: database,
      TEST_DB_SSL: 'verify',
      TEST_DB_CA_CERT: '',
      TEST_DB_CA_CERT_FILE: join(values.DEPLOY_TLS_DIR, 'ca.crt'),
      ...hostDirectories,
    } : {
      ADVERTISING_IMAGE_E2E_URL: origin,
      ADVERTISING_IMAGE_COMPOSE_PROJECT: project,
    };
    return { environment, cleanup };
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `Falló el fixture y su limpieza (${project}).`); }
    throw error;
  }
}

export async function setupGuidedImageFixture(options) {
  return setupAdvertisingFixture('image', options);
}

export async function setupOrganicApprovalFixture(options) {
  return setupAdvertisingFixture('approval', options);
}
