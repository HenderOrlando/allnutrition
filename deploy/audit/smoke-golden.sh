#!/usr/bin/env bash
# Args: fresh UUID and base64 XML from auditGuestDomain(uuid, pool/smoke-uuid).
set -euo pipefail
umask 077
pool=/var/lib/libvirt/images/allnutrition-audit
[[ $(id -u) == 0 && ! -e /home/allnutrition/app/.env.server.local ]]
[[ $# == 2 && $1 =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ && $2 =~ ^[A-Za-z0-9+/=]+$ ]]
uuid=$1
name=allnutrition-audit-${uuid:0:8}
work=$pool/smoke-$uuid
[[ -f "$pool/golden.qcow2" && ! -e "$work" ]]
virt() { virsh --connect qemu:///system "$@"; }
existing=$(virt list --all --uuid)
! grep -Fxq "$uuid" <<< "$existing"
mkdir -m 0700 -- "$work"
cleanup() {
  local status=$? list
  set +e
  list=$(virt list --all --uuid) || exit 1
  if grep -Fxq "$uuid" <<< "$list"; then
    [[ $(virt domname "$uuid") == "$name" ]] && virt destroy "$uuid" >/dev/null || exit 1
  fi
  list=$(virt list --all --uuid) || exit 1
  if grep -Fxq "$uuid" <<< "$list"; then exit 1; fi
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s' "$2" | base64 -d > "$work/domain.xml"
qemu-img create -f qcow2 -F qcow2 -b "$pool/golden.qcow2" "$work/overlay.qcow2"
printf 'fixture-only\n' > "$work/sentinel"
xorriso -abort_on FAILURE -outdev "$work/input.iso" -volid ALLNUTRITION_AUDIT -rockridge on -map "$work/sentinel" /sentinel -commit -end
chmod 0444 "$work/input.iso"
chmod 0711 "$work"
virt create --validate "$work/domain.xml"
/home/allnutrition/native-toolchain-91b7ab6b/bin/node --input-type=module - "$uuid" <<'JS'
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const uuid=process.argv[2];
function agent(execute,args) {
 const r=spawnSync('virsh',['--connect','qemu:///system','qemu-agent-command','--timeout','5',uuid,JSON.stringify({execute, arguments:args})],{encoding:'utf8',timeout:8000});
 return r.status===0 ? JSON.parse(r.stdout).return : null;
}
const boot=Date.now()+180_000;
while(agent('guest-ping',{})===null && Date.now()<boot)await delay(2000);
const test=String.raw`set -euo pipefail
[[ ! -e /home/allnutrition/app && ! -e /etc/allnutrition-audit/production.env && -z $(printenv SSH_AUTH_SOCK || true) ]]
[[ -z $(find /root /home /etc/ssh -type f \( -name authorized_keys -o -name 'id_*' -o -name 'ssh_host_*_key' \) -print -quit) ]]
if systemctl is-active --quiet ssh.service || systemctl is-active --quiet ssh.socket; then exit 1; fi
if findmnt -rn -t virtiofs,9p >/dev/null; then exit 1; fi
[[ $(blockdev --getro /dev/vdb) == 1 ]]
work=$(mktemp -d); trap 'umount "$work/input" || true; rm -rf "$work"' EXIT
mkdir "$work/input" "$work/bind"
mount -t iso9660 -o ro,nosuid,nodev,noexec /dev/vdb "$work/input"
[[ $(cat "$work/input/sentinel") == fixture-only ]]
[[ $(/usr/local/bin/node -p 'process.versions.node.split(".")[0]') == 24 ]]
chown 1000:1000 "$work/bind"; chmod 0700 "$work/bind"
group=$(getent group docker | cut -d: -f3)
setpriv --reuid 1000 --regid 1000 --groups "$group" --no-new-privs -- docker --host unix:///run/docker.sock run --rm --network none --user 1000:1000 --mount "type=bind,src=$work/bind,dst=/fixture" node:24-bookworm-slim node -e 'const fs=require("node:fs"),assert=require("node:assert/strict");const s=fs.statSync("/fixture");assert.equal(s.uid,1000);assert.equal(s.mode&511,448);assert(!fs.existsSync("/var/run/docker.sock"));assert(!fs.existsSync("/etc/allnutrition-audit/production.env"));fs.writeFileSync("/fixture/proof","fixture-only",{mode:384});'
[[ $(stat -c '%u:%g:%a' "$work/bind/proof") == 1000:1000:600 ]]
printf 'isolated-golden-ok\n'`;
const pid=agent('guest-exec',{path:'/bin/bash',arg:['-c',test],'capture-output':true})?.pid;assert(Number.isSafeInteger(pid),'QGA unavailable');
const deadline=Date.now()+8*60_000;
while(Date.now()<deadline) {
 const state=agent('guest-exec-status',{pid});
 if(state?.exited){assert.equal(state.exitcode,0,'Golden smoke failed: '+Buffer.from(state['err-data']||'','base64').toString().trim().slice(-500));assert.match(Buffer.from(state['out-data']||'','base64').toString(),/^isolated-golden-ok\s*$/);console.log('PASS: isolated guest, readonly ISO, QGA, guest-local Docker, UID1000 private bind, no SSH material or host mounts.');process.exit(0);}
 await delay(2000);
}
throw Error('Golden smoke timed out.');
JS
