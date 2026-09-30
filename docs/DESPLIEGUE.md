# Despliegue — Node 24, Docker Compose y PostgreSQL

La arquitectura elegida es **un servidor Linux con Docker Compose: Next.js + PostgreSQL 16 + Caddy HTTPS**. Staging usa la misma imagen runtime y composición, con HTTPS local. SQLite local y Vercel/Supabase siguen siendo alternativas, no la topología del Compose común.

La aceptación local terminó con exit 0; evidencia sanitizada: `.test-data/docker/10199872067871b1/artifacts/result.json`. Release: `allnutrition:release-d73775caf9a9`, ID `sha256:d73775caf9a97224255ef6544989d1b565c15fd56762a7a78db03564a2e4619b`, plataforma `linux/arm64`; Node host `24.14.1`, runtime `24.21.0`. Incluye contratos SQLite/PostgreSQL, navegador desktop/mobile, TLS, privilegios, caída/recuperación, persistencia y restauración. Ver [VERIFICACION.md](VERIFICACION.md) para resultados y superficie observada. **Esto no acredita publicación remota ni ejecución de CI**: no se ha proporcionado servidor o dominio real.

## 1. Prerrequisitos y aceptación de una imagen

Ejecutar desde la raíz del repositorio, con Node 24 (`.nvmrc`), npm, OpenSSL CLI, Docker Engine/Desktop activo y Docker Compose. En este Mac se puede iniciar Docker Desktop con `open -a Docker`; esperar a que `docker info` responda, con un límite de 120 segundos. En Linux instalar previamente Engine/Compose. No continuar sin daemon ni sustituir PostgreSQL por SQLite.

```sh
node --version
openssl version
docker info
docker compose version
npm ci
npx playwright install chromium
# En Linux/CI, usar en su lugar:
# npx playwright install --with-deps chromium
npm run verify:docker
```

El verificador exige Node major 24 y el puerto local 9443 libre. Construye runtime y checks, verifica el contenedor compilado y PostgreSQL real; no arranca `next dev`. Cada ejecución usa `allnutrition-test-ID` y `.test-data/docker/ID/`. Elimina únicamente sus contenedores/volúmenes efímeros al terminar, preservando evidencia. Solo tras aprobar etiqueta el ID comprobado como `allnutrition:release-<12 hex>`; no reconstruir bajo ese tag ni sustituirlo por otra imagen.

`artifacts/result.json` registra ID, plataforma, release, pruebas y exit code. Los reportes Playwright quedan en las rutas indicadas allí. `operational.json`, dumps, env y claves son privados: contienen datos/sesiones o secretos; no adjuntarlos a CI, incidencias ni soporte. El workflow utiliza el mismo verificador; una ejecución local no demuestra que CI remoto haya pasado.

## 2. Configuración privada e idempotencia

```sh
npm run deploy:env -- staging
# Producción: sustituir ambos argumentos por valores reales del titular.
npm run deploy:env -- production --domain DOMINIO_REAL --admin-email CORREO_REAL
# Solo lo invoca el verificador en su entorno descartable:
# npm run deploy:env -- test --id IDENTIFICADOR
```

| Entorno | Archivo privado | TLS / evidencia | Dumps |
| --- | --- | --- | --- |
| Staging | `.env.staging.local` | `data/deploy/staging/{tls,artifacts}` | `backups/staging` |
| Producción | `.env.server.local` | `data/deploy/production/{tls,artifacts}` | `backups/production` |
| Test | `.test-data/docker/ID/env` | `.test-data/docker/ID/{tls,artifacts}` | `.test-data/docker/ID/backups` |

El generador usa rutas absolutas y el UID/GID del usuario administrador del host. Generarlo en el host definitivo; no copiar el env de staging a producción ni mover las carpetas después. Los directorios privados son `0700`, env/claves/certificado de servidor `0600`; la CA pública `ca.crt` es `0644`. Las contraseñas aleatorias de PostgreSQL, rol limitado y administrador se guardan solo en el env. Abrirlo con un editor privado o gestor de secretos, no imprimirlo ni ejecutar `docker compose config` sin `--quiet`.

La CA PostgreSQL RSA-3072 dura 10 años; el certificado del servidor, 365 días, con SAN `DNS:db`. Reejecutar conserva configuración/certificados válidos, sin rotar contraseñas ni claves. Configuración parcial, permisos incoherentes, certificados caducados, hostname/clave incompatibles o cambio de host/rutas producen error sin sobrescribir datos. Avisa si faltan menos de 30 días: planificar renovación controlada antes del vencimiento; el generador no es un renovador automático. No borrar el env para intentar reparar un volumen existente. Tampoco cambia contraseñas de cuentas existentes al repetir setup.

`DB_CA_CERT_FILE` permite leer la CA PEM para PostgreSQL. No combinarlo con `DB_CA_CERT`; archivo ausente/vacío o ambas opciones fallan explícitamente. Nunca desactivar verificación TLS para resolver un error.

## 3. Staging persistente

Origen: **https://localhost:8443**. No se publica a la LAN. Primero aprobar `verify:docker`; elegir su evidencia y confirmar que el tag local sigue apuntando al ID probado. Este ejemplo usa la aceptación registrada; en releases nuevos actualizar `RESULT`:

```sh
RESULT=.test-data/docker/10199872067871b1/artifacts/result.json
RELEASE=$(node -e 'const r=require("./"+process.argv[1]); if(r.exitCode!==0 || !r.releaseTag) process.exit(1); console.log(r.releaseTag)' "$RESULT")
EXPECTED_IMAGE=$(node -e 'console.log(require("./"+process.argv[1]).imageId)' "$RESULT")
test "$(docker image inspect --format '{{.Id}}' "$RELEASE")" = "$EXPECTED_IMAGE" || exit 1
npm run deploy:env -- staging
```

En un editor privado, cambiar **solo `APP_IMAGE`** de `.env.staging.local` al valor de `RELEASE`. No cambiar contraseñas. Los comandos siguientes, en la misma sesión de shell, fijan siempre proyecto/env/ambos archivos:

```sh
sc() { docker compose -p allnutrition-staging --env-file .env.staging.local -f compose.yaml -f compose.staging.yaml "$@"; }
sc config --quiet
sc up -d --no-build --wait --wait-timeout 120 db
sc run --rm --pull never migrate
sc run --rm --pull never setup
sc up -d --no-build --wait --wait-timeout 120 web proxy
test "$(docker inspect --format '{{.Image}}' "$(sc ps -q web)")" = "$EXPECTED_IMAGE" || exit 1
sc ps
```

`migrate` provisiona/verifica `allnutrition_app` y concede DML, sin ownership ni DDL; comprueba también la conexión limitada. `setup` crea el administrador y contenido inicial sin duplicarlos. No importar cuentas E2E ni pedidos del verificador. No ejecutar fixtures, resetters, checks destructivos ni outage sobre este staging. Conservar los servicios funcionando.

### HTTPS verificable y acceso

Caddy utiliza una CA HTTPS local **distinta de la CA PostgreSQL**. Exportar solo su certificado público desde su API interna y comprobar cadena/hostname, sin `curl -k`:

```sh
sc exec -T proxy wget -qO- http://127.0.0.1:2019/pki/ca/local | node --input-type=module -e '
import { writeFileSync } from "node:fs";
let body=""; for await (const chunk of process.stdin) body+=chunk;
const cert=JSON.parse(body).root_certificate;
if (!cert?.includes("BEGIN CERTIFICATE")) throw new Error("CA HTTPS ausente");
writeFileSync("data/deploy/staging/artifacts/https-ca.crt",cert,{mode:0o644});'
curl --fail --silent --show-error --ipv4 --max-time 15 --cacert data/deploy/staging/artifacts/https-ca.crt https://localhost:8443/api/health
curl --silent --show-error --ipv4 --max-time 15 --cacert data/deploy/staging/artifacts/https-ca.crt --output /dev/null --write-out '%{http_code}\n' https://localhost:8443/api/admin/orders
```

Esperar `200` con `{"ok":true}` en salud y `401` en pedidos sin sesión. `--wait-timeout 120` limita readiness de Compose; si falla, revisar `sc ps` y logs de forma privada, no ignorar errores TLS. El navegador puede advertir sobre la CA local: no se instala confianza en el sistema automáticamente. La excepción Playwright solo se admite en localhost y no reemplaza la comprobación con CA explícita anterior.

Credenciales: `ADMIN_EMAIL` y `ADMIN_PASSWORD` en `.env.staging.local`, nunca en esta guía. Comprobar login al panel, cookie Secure/HttpOnly/SameSite=Strict, preview autenticado del catálogo en escritorio/móvil y logout seguido de pedidos `401`. La portada anónima debe permanecer en preparación hasta la aprobación comercial (`launchApproved`); preview no implica publicación. Guardar capturas sin secretos en `data/deploy/staging/artifacts/`.

## 4. Fronteras de infraestructura

- Si Caddy termina TLS en el servidor, solo ese proxy publica puertos; PostgreSQL 5432 y Next 3000 no se exponen. Para una VM privada detrás del Nginx ya existente, usar `compose.nginx.yaml`: solo publica `web:3000` en la red NAT privada; la base continúa exclusivamente en `backend`. Nunca usar ese override en una VM con interfaz pública.
- `backend` es interna para DB/web/herramientas; `frontend` conecta proxy/web (checks también necesita salida para audit). Proxy no entra en backend y DB no entra en frontend.
- PostgreSQL persiste en `postgres_data`; Caddy en `caddy_data`/`caddy_config`. Los volúmenes quedan aislados por proyecto, sin nombres globales. Logs persistentes rotan a 10 MB × 3.
- PostgreSQL recibe únicamente `tls/server/server.crt` y `server.key`; el wrapper copia la clave como `postgres:postgres`, `0600`. La CA privada no se monta. Web recibe solo la CA pública y exige TLS verificado; HBA rechaza todo TCP sin TLS y usa SCRAM para TLS. La confianza del socket Unix queda dentro del contenedor.
- Web ejecuta como `node`, sin credenciales ADMIN ni conexión DDL. La conexión DDL de aplicación queda en migrate; backup usa `postgres` para `pg_dump` y checks recibe una conexión privilegiada solo para la base descartable. Setup recibe las credenciales de alta. `DB_DRIVER=supabase` designa PostgreSQL estándar, sin SDK ni dependencia de Supabase alojado.

## 5. Promoción a un servidor Linux real

Requiere acceso autorizado a Docker/Compose, almacenamiento persistente suficiente, dominio real apuntando al servidor, firewall/NAT con 80/443 accesibles y correo real del administrador. La guía Caddy es genérica; validar DNS, ACME, recursos, firewall, carga, recuperación y flujos funcionales en el destino antes de aceptar cada despliegue.

Transportar el código/configuración correspondiente al release sin `node_modules`, `.env*` privados, datos ni backups. Exportar imagen y evidencia sanitizada, sin secretos:

```sh
# En el host que aprobó la imagen; RELEASE y RESULT son los del apartado 3.
docker image save --output data/deploy/staging/artifacts/allnutrition-release.tar "$RELEASE"
# Transferir por un canal autorizado el tar y result.json al servidor.
# En el servidor, desde la raíz del proyecto:
docker image load --input /RUTA_FUERA_DEL_REPOSITORIO/allnutrition-release.tar
RESULT=result.json
RELEASE=$(node -e 'const r=require("./"+process.argv[1]); if(r.exitCode!==0 || !r.releaseTag) process.exit(1); console.log(r.releaseTag)' "$RESULT")
EXPECTED_IMAGE=$(node -e 'console.log(require("./"+process.argv[1]).imageId)' "$RESULT")
test "$(docker image inspect --format '{{.Id}}' "$RELEASE")" = "$EXPECTED_IMAGE" || exit 1
docker info --format '{{.OSType}}/{{.Architecture}}'
docker image inspect --format '{{.Os}}/{{.Architecture}}' "$RELEASE"
```

La plataforma debe coincidir con el servidor (Docker puede mostrar `aarch64` para `arm64`, `x86_64` para `amd64`). **Si difiere, ejecutar el mismo verificador nativamente en la arquitectura destino y usar su nuevo release/evidencia**. No promover por emulación ni reconstruir una imagen con el tag ya probado.

En el servidor generar configuración nueva, con Node 24/OpenSSL, valores reales y usuario de operación definitivo:

```sh
npm run deploy:env -- production --domain DOMINIO_REAL --admin-email CORREO_REAL
```

No copiar secretos ni volúmenes del staging. En la VM dejar `.env.server.local` intacto y fijar la imagen probada en un archivo aparte `.env.release.local`, privado y con solo `APP_IMAGE`:

```sh
RESULT=.test-data/docker/RUN_ID/artifacts/result.json
RELEASE=$(node -e 'const r=require("./"+process.argv[1]); if(r.exitCode!==0 || !r.releaseTag) process.exit(1); console.log(r.releaseTag)' "$RESULT")
(umask 077; set -o noclobber; printf 'APP_IMAGE=%s\n' "$RELEASE" > .env.release.local)
```

```sh
pc() { docker compose -p allnutrition-production --env-file .env.server.local --env-file .env.release.local -f compose.yaml -f compose.production.yaml "$@"; }
pc config --quiet
pc up -d --no-build --wait --wait-timeout 120 db
pc run --rm --pull never migrate
pc run --rm --pull never setup
pc up -d --no-build --wait --wait-timeout 120 web proxy
test "$(docker inspect --format '{{.Image}}' "$(pc ps -q web)")" = "$EXPECTED_IMAGE" || exit 1
```

Producción usa Caddy con HTTPS público automático, **sin `tls internal`**. No iniciar ese proxy con dominios ficticios ni intentar ACME para `production.example.invalid`: el verificador solo emplea ese nombre como fixture de sintaxis de Compose/Caddy, no como publicación. Con el dominio real comprobar salud HTTPS mediante confianza pública normal, login/preview/logout y API anónima `401`, antes de aprobar la vitrina.

### VM privada detrás de un Nginx existente

Cuando el servidor ya sirve otros dominios con Nginx, crear una red NAT/libvirt independiente con DHCP reservado `192.168.201.10` para la VM `allnutrition-prod`; no conectar esta VM a redes de otras cargas. Instalar Ubuntu 24.04, Docker/Compose y Node 24 en la VM; clonar el repositorio e instalar dependencias con `npm ci --legacy-peer-deps`. En una VM Ubuntu limpia instalar también Chromium y bibliotecas del runner E2E con `npx playwright install --with-deps chromium`; después ejecutar `npm run verify:docker` en la arquitectura destino y promover únicamente si deja evidencia aprobada. No instalar Docker ni PostgreSQL directamente en el host compartido.

En este host compartido la política global `FORWARD` es `DROP`. Antes de que el guest necesite salida, instalar la unidad del mismo commit: añade permisos solo desde `virbr-anprod` hacia `enp4s0` y para las respuestas establecidas, después de las cadenas `DOCKER-USER`/`DOCKER-FORWARD`; no cambia la política global ni otras reglas.

```sh
install -m 0755 deploy/kvm/allnutrition-prod-forwarding.sh /usr/local/sbin/allnutrition-prod-forwarding.sh
install -m 0644 deploy/kvm/allnutrition-prod-forwarding.service /etc/systemd/system/allnutrition-prod-forwarding.service
systemctl daemon-reload
systemctl enable --now allnutrition-prod-forwarding.service
```

```sh
npm run deploy:env -- production --domain allnutrition.wintimeapp.co --admin-email CORREO_REAL
```

Generar `.env.server.local` privadamente **dentro de la VM**. Para operar detrás del Nginx del host, fijar la imagen del verificador en `.env.release.local`; no usar `compose.production.yaml` ni iniciar Caddy:

```sh
np() { docker compose -p allnutrition-production --env-file .env.server.local --env-file .env.release.local -f compose.yaml -f compose.nginx.yaml "$@"; }
np config --quiet
np up -d --no-build --wait --wait-timeout 120 db
np run --rm --pull never migrate
np run --rm --pull never setup
np up -d --no-build --wait --wait-timeout 120 web
```

El enlace `3000:3000` de ese override solo es accesible en la interfaz privada del guest; no publicar PostgreSQL, Docker ni la API directamente en la IP pública. En el host Nginx instalar primero `deploy/nginx/allnutrition-acme.conf` como vhost exclusivo, crear `/var/lib/letsencrypt`, ejecutar `nginx -t` y recargar. Solicitar el certificado con `certbot certonly --webroot -w /var/lib/letsencrypt -d allnutrition.wintimeapp.co --email CORREO_REAL --agree-tos --non-interactive`; luego instalar `deploy/nginx/allnutrition.wintimeapp.co.conf` en su lugar, repetir `nginx -t` y solo si pasa ejecutar `systemctl reload nginx`. El vhost final reenvía únicamente a `192.168.201.10:3000`; no reemplazar el Nginx compartido ni cambiar sus otros archivos.

`deploy/kvm/allnutrition-prod-network.xml` define la red e IP reservada; los volúmenes de PostgreSQL, la imagen de Ubuntu, el disco y los env/certificados de aplicación deben residir en almacenamiento persistente del guest/host, nunca en el pool temporal de VMs de CI. Comprobar antes de registrar una red nueva que su nombre, bridge y subred no existen ni se solapan. Antes y después del reload validar al menos un dominio previo del host. Si DNS no apunta a ese host o no se puede expedir el certificado, detenerse sin tocar las otras cargas.

Confiar en la CA pública normal desde clientes; validar `/api/health`, login, cookie segura y API autenticada `200`. La VM no recibe puertos públicos ni reemplaza al host proxy.

## 6. Backups y restauración aislada

```sh
# Usar la función del entorno correspondiente definida arriba:
sc run --rm --pull never backup
# En producción:
pc run --rm --pull never backup
```

El servicio usa `pg_dump --format=custom`, conexión TLS `verify-full`, CA explícita y `umask 077`. Los dumps `allnutrition-<UTC>.dump` son `0600` en `backups/staging` o `backups/production`, propiedad del UID/GID del operador del host. Contienen cuentas/sesiones y datos comerciales: tratarlos como secretos. No equivalen al JSON comercial del panel, que omite cuentas. Las imágenes externas no se respaldan, solo sus URLs; los recursos estáticos versionados viajan con la imagen.

**Antes de datos reales**, configurar manualmente frecuencia, retención, copia cifrada fuera del servidor y responsables; no hay scheduler, destino off-host ni SLA implementados. Comprobar restauraciones periódicas, no solo existencia del archivo.

Restaurar exclusivamente en una base distinta y vacía, sin reconectar web ni sustituir la base activa. Este ejemplo de producción crea `allnutrition_restore`; si existe, detenerse y elegir una base de recuperación nueva, no borrarla:

```sh
pc exec -T db createdb -U postgres allnutrition_restore || exit 1
# Sustituir NOMBRE_REAL.dump por un dump existente de backups/production.
pc run --rm --pull never -e PGDATABASE=allnutrition_restore backup pg_restore --exit-on-error --dbname=allnutrition_restore /backups/NOMBRE_REAL.dump || exit 1
# Conexión TLS y comprobación básica con el mismo rol limitado que web:
pc run --rm --pull never --no-deps web node --input-type=module -e '
import { databaseConfig } from "./lib/db/config.mjs";
import { openPostgres } from "./lib/db/postgres.mjs";
const url=new URL(process.env.DATABASE_URL); url.pathname="/allnutrition_restore";
const db=await openPostgres(databaseConfig({...process.env,DATABASE_URL:url.href}));
try {
  const row=await db.get("SELECT current_database() AS database, current_user AS role, ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()");
  if (row.database!=="allnutrition_restore" || row.role!=="allnutrition_app" || !row.ssl) throw new Error("Conexión de restauración incompatible");
  console.log("Restauración: esquema v2 y conexión limitada TLS verificados");
} finally { await db.close(); }'
```

Esa salud es solo comprobación básica, no aceptación integral. Antes de utilizar una recuperación, comprobar con acceso limitado cuentas, sesiones, productos, totales, numeración, historial y replay/idempotencia contra evidencia privada tomada del origen, en una instancia aislada sin tráfico real. Confirmar también que el runtime no puede crear tablas. No ejecutar seed ni fixtures sobre el dump.

El verificador ya restaura su pedido exacto de **119000**, cuenta, sesión e historial y comprueba replay/privilegios con `tests/docker/operations.mjs`. Ese auxiliar requiere las guardas de prueba y su snapshot privado; `prepare`/reset solo permiten `allnutrition_test` y `assert` también `allnutrition_restore`. **No es un procedimiento de reset ni un validador genérico de los datos de producción**. No ejecutar la suite contra staging/producción para probar un backup.

## 7. Actualizaciones, rollback y fallos

1. Aprobar el nuevo release con `verify:docker` en la arquitectura destino, transportar/cargarlo y comparar ID/evidencia como arriba. Guardar el tag anterior.
2. Hacer backup y coordinar una ventana sin escrituras cuando el cambio lo requiera. Revisar compatibilidad de migración con la aplicación anterior.
3. Cambiar únicamente `APP_IMAGE` al nuevo release. Ejecutar `pc run --rm --pull never migrate` **antes** de `pc up -d --no-build --wait --wait-timeout 120 web proxy`. Comprobar ID en ejecución, salud y flujos autenticados.
4. Para rollback de aplicación, fijar `APP_IMAGE` al release anterior compatible y recrear web con el mismo comando, verificando salud. **No retroceder automáticamente la base**. Una restauración/cutover de datos requiere decisión y recuperación ensayada aparte.

En staging aplicar la misma secuencia usando `sc`. **Nunca ejecutar `down -v` sobre staging o producción** ni eliminar volúmenes para arreglar una migración. Reinicios conservan datos/sesiones. Si PostgreSQL cae, salud y escrituras fallan con `503`; no hay fallback SQLite, cola offline, réplica ni alta disponibilidad. No comunicar guardados exitosos hasta confirmar recuperación. Proteger evidencia y logs: no publicar cadenas de conexión.

## 8. Alternativas conservadas

### Vercel y PostgreSQL remoto / Supabase

Son una ruta alternativa, no el destino elegido. Usar Node 24, `npm ci` y las variables de servidor de `.env.production.example`, con `APP_URL` HTTPS real. `npm run deploy` y `npm run deploy -- --prod` siguen siendo el CLI de **Vercel**, no comandos para este servidor Docker. Requieren cuenta/proyecto autorizados; no copian automáticamente el env privado.

En Supabase copiar cadenas reales desde Connect: Transaction pooler para runtime cuando corresponda; Direct connection o Session pooler para DDL. No deducir host/usuario/región. Configurar `DB_DRIVER=supabase`, `DATABASE_URL`, `DATABASE_DIRECT_URL` para migraciones y `DB_SSL=verify`; usar `DB_CA_CERT` o `DB_CA_CERT_FILE` si lo requiere la CA, nunca `rejectUnauthorized:false`. En Vercel el archivo CA debe estar disponible realmente en runtime si se usa esa opción.

Migrar con `npm run db:migrate` antes de publicar y usar `npm run setup` solo al inicializar un destino sin contenido. Separar rol administrativo del rol limitado runtime y retirar ADMIN del entorno de aplicación. `--provision-app-role` automatiza el rol del Compose con `DB_APP_PASSWORD`; en servicios gestionados comprobar las capacidades y formato de conexión del proveedor. El esquema `allnutrition` no se expone por Data API; no se utilizan API keys públicas/service-role en el navegador ni Supabase Auth para las cuentas del panel. Separar bases de preview y producción; exigir aceptación antes de publicar y verificar luego salud/login/escrituras/logout en el destino real.

### SQLite local y cambio de motor

SQLite permanece disponible con `DB_DRIVER=sqlite` para desarrollo/instalación local de un único escritor; **el Compose común ya no lo configura ni monta su archivo**. Usar el entorno local documentado en README, `npm ci`, `npm run db:migrate` y `npm run setup`. Una instalación pública alternativa necesitaría su propio HTTPS y persistencia administrada; no reutilizar los comandos Compose antiguos.

Para cambiar de motor: detener escrituras, respaldar, migrar estructura del destino vacío, importar y validar cantidades/totales/historial antes de reabrir. No ejecutar setup/seed primero en el destino de una importación:

```sh
# Con .env privado apuntando al origen:
npm run backup
# Configurar .env para el destino vacío:
npm run db:migrate
npm run db:import -- backups/ARCHIVO_REAL.json
npm run admin:add
```

También se admite `npm run db:import -- --sqlite ./COPIA_DE_LA_BASE.sqlite`; hacer una copia antes, pues abrir SQLite v1 añade tablas v2 de forma no destructiva. Reemplazar imágenes antiguas `/api/media/...` por URLs antes de importar. La exportación comercial no migra binarios ni sesiones. Conservar respaldo del origen sin operar simultáneamente sobre dos bases independientes.
