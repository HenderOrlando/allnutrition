#!/usr/bin/env bash
# Run only under root on the authorized builder. Stdin is a reviewed, public tar.
set -euo pipefail
umask 077
node=/home/allnutrition/native-toolchain-91b7ab6b/bin/node
pool=/var/lib/libvirt/images/allnutrition-audit
[[ $(id -u) == 0 && $(uname -m) == x86_64 && ! -e /home/allnutrition/app/.env.server.local ]]
[[ $# == 3 && $1 =~ ^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$ && $2 = /* && $3 =~ ^[a-f0-9]{64}$ ]]
vm=$1; key=$2; digest=$3
[[ -f "$key" && ! -L "$key" && $(stat -c '%a' "$key") == 600 ]]
ssh-keygen -F "${vm#*@}" -f /root/.ssh/known_hosts >/dev/null
for f in /opt/allnutrition-audit /etc/allnutrition-audit /var/lib/allnutrition-audit /etc/systemd/system/allnutrition-audit.service /etc/systemd/system/allnutrition-audit.timer; do [[ ! -e "$f" ]]; done
[[ -f "$pool/golden.qcow2" && ! -L "$pool/golden.qcow2" && $(stat -c '%a' "$pool/golden.qcow2") == 444 ]]
printf '%s  %s\n' "$digest" "$pool/golden.qcow2" | sha256sum --check --status
chown 0:0 "$pool/golden.qcow2"
stage=$(mktemp -d /opt/.allnutrition-audit-XXXXXX)
trap 'rm -rf -- "$stage"' EXIT
collector_files=(
  scripts/{audit-production,audit-issues,production-host,production-release,release-impact,release-impact-matrix}.mjs
  deploy/audit/{README.md,guest-host.mjs,guest.mjs,install-builder.sh,provision-golden.sh,smoke-golden.sh}
  deploy/systemd/allnutrition-audit.{service,timer}
)
tar --no-same-owner --no-same-permissions -xf - -C "$stage" -- "${collector_files[@]}"
find "$stage" -type d -exec chmod 0755 {} +; find "$stage" -type f -exec chmod 0644 {} +
chmod 0755 "$stage/deploy/audit/"*.sh
for f in "$stage/scripts/"*.mjs "$stage/deploy/audit/"*.mjs; do "$node" --check "$f"; done
install -d -m 0700 /etc/allnutrition-audit /var/lib/allnutrition-audit
install -m 0600 "$key" /etc/allnutrition-audit/vm-identity
printf 'ALLNUTRITION_VM=%s\nALLNUTRITION_VM_KEY=/etc/allnutrition-audit/vm-identity\n' "$vm" > /etc/allnutrition-audit/production.env
mv -T -- "$stage" /opt/allnutrition-audit
for unit in allnutrition-audit.service allnutrition-audit.timer; do install -m 0644 "/opt/allnutrition-audit/deploy/systemd/$unit" "/etc/systemd/system/$unit"; done
systemd-analyze verify /etc/systemd/system/allnutrition-audit.service /etc/systemd/system/allnutrition-audit.timer
systemd-analyze calendar 'Sun *-*-* 08:17:00 UTC' | awk '/Normalized form|Next elapse/'
systemctl daemon-reload
[[ $(systemctl is-enabled allnutrition-audit.timer || true) == disabled && $(systemctl is-active allnutrition-audit.timer || true) == inactive ]]
[[ $(stat -c '%a %u' /etc/allnutrition-audit) == '700 0' && $(stat -c '%a %u' /etc/allnutrition-audit/production.env) == '600 0' && $(stat -c '%a %u' /etc/allnutrition-audit/vm-identity) == '600 0' ]]
if "$node" /opt/allnutrition-audit/deploy/audit/guest-host.mjs --pair /dev/null >/dev/null 2>&1; then exit 1; fi
printf 'Collector installed; environment and identity root-private; timer disabled and inactive. Pair CLI rejected invalid manifest.\n'
