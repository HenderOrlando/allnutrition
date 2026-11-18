#!/usr/bin/env bash
# Run on the authorized Linux/amd64 bastion, never on production.
set -euo pipefail
umask 077
pool=/var/lib/libvirt/images/allnutrition-audit
[[ $(id -u) == 0 && $(uname -m) == x86_64 && ! -e /home/allnutrition/app/.env.server.local ]]
[[ $# == 1 && $1 =~ ^[A-Za-z0-9+/=]+$ && ! -e "$pool" ]]
mkdir -m 0711 -- "$pool"
work=$(mktemp -d "$pool/provision-XXXXXX")
uuid=$(cat /proc/sys/kernel/random/uuid)
virt() { virsh --connect qemu:///system "$@"; }
cleanup() {
  local status=$? list
  set +e
  list=$(virt list --all --uuid) || { echo 'Cannot confirm that the provisioning guest stopped; preserving own staging.' >&2; exit 1; }
  if grep -Fxq "$uuid" <<< "$list"; then
    [[ $(virt domname "$uuid") == "allnutrition-audit-provision-${uuid:0:8}" ]] && virt destroy "$uuid" >/dev/null || exit 1
  fi
  list=$(virt list --all --uuid) || exit 1
  if grep -Fxq "$uuid" <<< "$list"; then exit 1; fi
  rm -rf -- "$work"
  if [[ ! -f "$pool/golden.qcow2" ]]; then rmdir "$pool"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$work"

fetch() { curl --proto '=https' -fsSL --retry 2 --max-time 240 "$1" -o "$2"; }
ubuntu=https://cloud-images.ubuntu.com/noble/current
image=noble-server-cloudimg-amd64.img
fingerprint=D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81
fetch "$ubuntu/SHA256SUMS" SHA256SUMS
fetch "$ubuntu/SHA256SUMS.gpg" SHA256SUMS.gpg
mkdir -m 0700 gpg
fetch "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x$fingerprint" ubuntu-key.asc
gpg --batch --homedir "$work/gpg" --import ubuntu-key.asc >/dev/null 2>&1
gpg --batch --homedir "$work/gpg" --export "$fingerprint" > ubuntu.gpg
gpgv --keyring "$work/ubuntu.gpg" SHA256SUMS.gpg SHA256SUMS
fetch "$ubuntu/$image" "$image"
awk -v name="$image" '$2==name || $2=="*"name {print; n++} END {exit n!=1}' SHA256SUMS | sha256sum -c -
qemu-img convert -f qcow2 -O qcow2 "$image" golden-build.qcow2
qemu-img resize golden-build.qcow2 120G

cat > provision-in-guest.sh <<'GUEST'
#!/usr/bin/env bash
set -euo pipefail
umask 077
stage=/root/audit-build-status
phase=packages
trap 'echo "failed:$phase" > "$stage"' ERR
export DEBIAN_FRONTEND=noninteractive
# QEMU user networking may filter plain HTTP. Ubuntu's signed APT repositories
# are also served over HTTPS; use those without touching host network policy.
sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources
apt-get -o Acquire::Retries=0 -o Acquire::https::Timeout=30 -q update
apt-get -qy install --no-install-recommends qemu-guest-agent ca-certificates curl gnupg git ffmpeg xz-utils
systemctl start qemu-guest-agent.service
phase=docker
install -d -m 0755 /etc/apt/keyrings
curl --proto '=https' -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
[[ $(gpg --batch --with-colons --show-keys /etc/apt/keyrings/docker.asc | awk -F: '$1=="fpr" {print $10; exit}') == 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]]
chmod 0644 /etc/apt/keyrings/docker.asc
printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n' > /etc/apt/sources.list.d/docker.list
apt-get -q update
apt-get -qy install --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker.service
phase=node
stage_dir=$(mktemp -d)
cd "$stage_dir"
version=v24.22.2
binary=node-${version}-linux-x64.tar.xz
curl --proto '=https' -fsSL https://github.com/nodejs/release-keys/raw/HEAD/gpg/pubring.kbx -o node.gpg
curl --proto '=https' -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt.asc" -o SHA.asc
gpgv --keyring "$stage_dir/node.gpg" --output SHA < SHA.asc
curl --proto '=https' -fsSL "https://nodejs.org/dist/$version/$binary" -o "$binary"
awk -v name="$binary" '$2==name {print; n++} END {exit n!=1}' SHA | sha256sum -c -
tar -xJf "$binary" --strip-components=1 -C /usr/local
phase=chromium
/usr/local/bin/npx --yes --package=playwright@1.63.0 -- playwright install-deps chromium
cd /
rm -rf -- "$stage_dir" /root/.npm /root/.gnupg
phase=account
[[ -z $(getent passwd 1000 || true) && -z $(getent group 1000 || true) ]]
groupadd --gid 1000 allnutrition-audit
useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin allnutrition-audit
systemctl mask --now ssh.service ssh.socket
rm -f /etc/ssh/ssh_host_* /root/.ssh/authorized_keys
touch /etc/cloud/cloud-init.disabled
[[ -z $(find /root /home -type f \( -name authorized_keys -o -name 'id_*' \) -print -quit) ]]
[[ ! -e /etc/allnutrition-audit/production.env && ! -e /home/allnutrition/app ]]
printf 'ready\n' > "$stage"
GUEST
cat > user-data <<EOF
#cloud-config
users: []
ssh_pwauth: false
ssh_deletekeys: true
ssh_genkeytypes: []
disable_root: true
write_files:
  - path: /usr/local/sbin/allnutrition-golden-build
    owner: root:root
    permissions: '0700'
    encoding: b64
    content: $(base64 -w0 provision-in-guest.sh)
  - path: /opt/allnutrition-audit/guest.mjs
    owner: root:root
    permissions: '0644'
    encoding: b64
    content: $1
runcmd:
  - [ /usr/local/sbin/allnutrition-golden-build ]
EOF
printf 'instance-id: %s\nlocal-hostname: allnutrition-audit\n' "$uuid" > meta-data
cloud-localds seed.iso user-data meta-data
chmod 0444 seed.iso
chmod 0711 "$work"
touch serial.log
cat > domain.xml <<EOF
<domain type='kvm'>
  <name>allnutrition-audit-provision-${uuid:0:8}</name><uuid>$uuid</uuid>
  <memory unit='MiB'>12288</memory><vcpu>4</vcpu>
  <os><type arch='x86_64' machine='q35'>hvm</type><boot dev='hd'/></os>
  <features><acpi/><apic/></features><cpu mode='host-passthrough'/>
  <on_poweroff>destroy</on_poweroff><on_reboot>destroy</on_reboot><on_crash>destroy</on_crash>
  <devices>
    <disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='$work/golden-build.qcow2'/><target dev='vda' bus='virtio'/></disk>
    <disk type='file' device='disk'><driver name='qemu' type='raw'/><source file='$work/seed.iso'/><target dev='vdb' bus='virtio'/><readonly/></disk>
    <interface type='user'><mac address='52:54:00:68:57:16'/><model type='virtio'/></interface>
    <serial type='file'><source path='$work/serial.log'/><target port='0'/></serial>
    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>
  </devices>
</domain>
EOF
virt create --validate "$work/domain.xml"
node=/home/allnutrition/native-toolchain-91b7ab6b/bin/node
if ! "$node" --input-type=module - "$uuid" <<'JS'
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const uuid=process.argv[2];
function qga(execute,args) {
 const result=spawnSync('virsh',['--connect','qemu:///system','qemu-agent-command','--timeout','5',uuid,JSON.stringify({execute, arguments:args})],{encoding:'utf8',timeout:8000});
 return result.status===0 ? JSON.parse(result.stdout).return : null;
}
const deadline=Date.now()+60*60_000;
while(Date.now()<deadline) {
 if(qga('guest-ping',{})!==null) {
  const pid=qga('guest-exec',{path:'/usr/bin/cat',arg:['/root/audit-build-status'],'capture-output':true})?.pid;
  if(pid) {
   let p; for(let i=0;i<5;i++) { p=qga('guest-exec-status',{pid}); if(p?.exited)break; await delay(500); }
   if(p?.exited&&p.exitcode===0){
    const message=Buffer.from(p['out-data']||'','base64').toString().trim();
    if(message==='ready')process.exit(0);
    if(/^failed:[a-z]+$/.test(message))throw Error(message);
   }
  }
 }
 await delay(10_000);
}
throw Error('Provisioning guest did not reach readiness.');
JS
then
  grep -E 'Cloud-init|cloud-init|Failed to fetch|Network is unreachable|Could not resolve|failed:' serial.log | tail -18 >&2 || true
  exit 1
fi
virt shutdown "$uuid" --mode agent
for ((count=0;count<60;count++)); do
  list=$(virt list --all --uuid)
  if ! grep -Fxq "$uuid" <<< "$list"; then break; fi
  sleep 2
done
[[ $count -lt 60 ]]
qemu-img check golden-build.qcow2 >/dev/null
chown 0:0 golden-build.qcow2
chmod 0444 golden-build.qcow2
mv -T -- golden-build.qcow2 "$pool/golden.qcow2"
sha256sum "$pool/golden.qcow2"
