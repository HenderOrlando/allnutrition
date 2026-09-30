#!/usr/bin/env bash
set -euo pipefail

iptables=(/usr/bin/iptables -w 10)
add_if_missing() {
  if ! "${iptables[@]}" -C FORWARD "$@" >/dev/null 2>&1; then
    "${iptables[@]}" -I FORWARD 3 "$@"
  fi
}

# Preserve Docker's DOCKER-USER and DOCKER-FORWARD processing; allow only this
# guest subnet to initiate host-uplink traffic and its established return path.
add_if_missing -s 192.168.201.0/24 -i virbr-anprod -o enp4s0 -m comment --comment allnutrition-prod -j ACCEPT
add_if_missing -d 192.168.201.0/24 -i enp4s0 -o virbr-anprod -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment allnutrition-prod -j ACCEPT
