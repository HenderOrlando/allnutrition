#!/bin/sh
set -eu

for file in server.crt server.key; do
  if [ ! -f "/run/postgres-tls/$file" ] || [ ! -r "/run/postgres-tls/$file" ] || [ ! -s "/run/postgres-tls/$file" ]; then
    echo "Falta un archivo TLS PostgreSQL legible y no vacío: $file" >&2
    exit 1
  fi
done
install -d -m 0700 -o postgres -g postgres /var/lib/postgresql/tls
install -m 0644 -o postgres -g postgres /run/postgres-tls/server.crt /var/lib/postgresql/tls/server.crt
install -m 0600 -o postgres -g postgres /run/postgres-tls/server.key /var/lib/postgresql/tls/server.key
exec /usr/local/bin/docker-entrypoint.sh "$@"
