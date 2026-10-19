# Despliegue — Node 24, Docker Compose y PostgreSQL

La arquitectura usa **un servidor Linux con Docker Compose: Next.js + PostgreSQL 16**. La producción actual reside en una VM privada detrás del Nginx del host; staging y la topología autónoma usan Caddy HTTPS con la misma imagen runtime. SQLite local y Vercel/Supabase siguen siendo alternativas, no la topología del Compose común.

La producción publicada es **https://allnutrition.wintimeapp.co**, en la VM privada `allnutrition-prod` (`amd64`) detrás del Nginx del host, según el apartado 5. Las imágenes `arm64` y resultados locales de septiembre son antecedentes, no candidatos válidos para esa VM. Cada actualización debe obtener su propia aceptación nativa con `verify:docker` y comparar la imagen ejecutada con la evidencia aprobada. Los resultados vigentes y sus límites se registran en [VERIFICACION.md](VERIFICACION.md); no acreditan una ejecución de CI remoto.

**Corte de inventario (migración 4):** respaldar primero y detener web y scheduler de la versión anterior antes de ejecutar la migración con la nueva imagen. Reiniciar ambos con esa misma imagen después; no mezclar escritores anteriores y nuevos. La migración no descuenta despachos históricos ni asigna stock inicial: toma reservas pendientes y deja desconocidos los conteos no aportados. Registrar después el conteo físico real, incluidas las unidades reservadas. PostgreSQL rechaza el arranque de la nueva versión si falta la migración; SQLite la aplica al abrir una conexión nueva. Reiniciar también los servidores de desarrollo ya abiertos. La aceptación local de este cambio no promueve una imagen ni actualiza producción.

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

Para el corte comercial v3 ejecutar `npm run verify:docker -- --interactive`. Mantiene la aceptación automatizada y añade el recorrido de importación, caja, sueldo, devolución, snapshot sin paneles, alerta y reinicio de lote. La pausa imprime las rutas/órdenes exactas de su proyecto descartable; no reemplazarlas por configuración de staging o producción. EOF/SIGINT cancela.

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
RESULT=.test-data/docker/27de6a7636ce20e2/artifacts/result.json
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
sc up -d --no-build --wait --wait-timeout 120 web proxy scheduler
test "$(docker inspect --format '{{.Image}}' "$(sc ps -q web)")" = "$EXPECTED_IMAGE" || exit 1
test "$(docker inspect --format '{{.Image}}' "$(sc ps -q scheduler)")" = "$EXPECTED_IMAGE" || exit 1
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
- `backend` es interna para DB/web/scheduler/herramientas; `frontend` conecta proxy/web (checks también necesita salida para audit). Scheduler no publica puertos; proxy no entra en backend y DB no entra en frontend.
- PostgreSQL persiste en `postgres_data`; las imágenes locales de productos, en `product_images`; Caddy, en `caddy_data`/`caddy_config`. Son volúmenes distintos, aislados por proyecto y sin nombres globales. Reiniciar web conserva los archivos locales. Logs persistentes rotan a 10 MB × 3.
- PostgreSQL recibe únicamente `tls/server/server.crt` y `server.key`; el wrapper copia la clave como `postgres:postgres`, `0600`. La CA privada no se monta. Web recibe solo la CA pública y exige TLS verificado; HBA rechaza todo TCP sin TLS y usa SCRAM para TLS. La confianza del socket Unix queda dentro del contenedor.
- Web ejecuta como `node`, sin credenciales ADMIN ni conexión DDL. La conexión DDL de aplicación queda en migrate; backup usa `postgres` para `pg_dump` y checks recibe una conexión privilegiada solo para la base descartable. Setup recibe las credenciales de alta. `DB_DRIVER=supabase` designa PostgreSQL estándar, sin SDK ni dependencia de Supabase alojado.

## 5. Promoción a un servidor Linux real

Requiere acceso autorizado a Docker/Compose, almacenamiento persistente suficiente, dominio real apuntando al servidor, firewall/NAT con 80/443 accesibles y correo real del administrador. La guía Caddy es genérica; validar DNS, ACME, recursos, firewall, carga, recuperación y flujos funcionales en el destino antes de aceptar cada despliegue.

Transportar el código/configuración correspondiente al release sin `node_modules`, `.env*` privados, datos ni backups. Exportar imagen y evidencia sanitizada, sin secretos:

Al empaquetar desde macOS, desactivar AppleDouble y atributos extendidos (`COPYFILE_DISABLE=1` y tar con `--format=ustar --no-xattrs --no-acls`); excluir también `._*`, `.DS_Store` y `__MACOSX`. No relajar los chequeos para aceptar esos archivos binarios como código. Extraer en un directorio de candidato aislado, comprobar el SHA-256 del paquete y ejecutar allí la aceptación nativa antes de tocar la selección de producción.

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
pc up -d --no-build --wait --wait-timeout 120 web proxy scheduler
test "$(docker inspect --format '{{.Image}}' "$(pc ps -q web)")" = "$EXPECTED_IMAGE" || exit 1
```

Producción usa Caddy con HTTPS público automático, **sin `tls internal`**. No iniciar ese proxy con dominios ficticios ni intentar ACME para `production.example.invalid`: el verificador solo emplea ese nombre como fixture de sintaxis de Compose/Caddy, no como publicación. Con el dominio real comprobar salud HTTPS mediante confianza pública normal, login/preview/logout y API anónima `401`, antes de aprobar la vitrina.

### VM privada detrás de un Nginx existente

Cuando el servidor ya sirve otros dominios con Nginx, crear una red NAT/libvirt independiente con DHCP reservado `192.168.201.10` para la VM `allnutrition-prod`; no conectar esta VM a redes de otras cargas. Instalar Ubuntu 24.04, Docker/Compose y Node 24 en la VM; clonar el repositorio e instalar dependencias con `npm ci --legacy-peer-deps`. En una VM Ubuntu limpia instalar también Chromium y bibliotecas del runner E2E con `npx playwright install --with-deps chromium`; después ejecutar `npm run verify:docker -- --interactive` en la arquitectura destino, completar también el recorrido comercial indicado y promover únicamente si deja evidencia aprobada. No instalar Docker ni PostgreSQL directamente en el host compartido.

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
np up -d --no-build --wait --wait-timeout 120 web scheduler
```

El enlace `3000:3000` de ese override solo es accesible en la interfaz privada del guest; no publicar PostgreSQL, Docker ni la API directamente en la IP pública. En el host Nginx instalar primero `deploy/nginx/allnutrition-acme.conf` como vhost exclusivo, crear `/var/lib/letsencrypt`, ejecutar `nginx -t` y recargar. Solicitar el certificado con `certbot certonly --webroot -w /var/lib/letsencrypt -d allnutrition.wintimeapp.co --email CORREO_REAL --agree-tos --non-interactive`; luego instalar `deploy/nginx/allnutrition.wintimeapp.co.conf` en su lugar, repetir `nginx -t` y solo si pasa ejecutar `systemctl reload nginx`. El vhost final reenvía únicamente a `192.168.201.10:3000`; no reemplazar el Nginx compartido ni cambiar sus otros archivos.

`deploy/kvm/allnutrition-prod-network.xml` define la red e IP reservada; los volúmenes de PostgreSQL, la imagen de Ubuntu, el disco y los env/certificados de aplicación deben residir en almacenamiento persistente del guest/host, nunca en el pool temporal de VMs de CI. Comprobar antes de registrar una red nueva que su nombre, bridge y subred no existen ni se solapan. Antes y después del reload validar al menos un dominio previo del host. Si DNS no apunta a ese host o no se puede expedir el certificado, detenerse sin tocar las otras cargas.

Confiar en la CA pública normal desde clientes; validar `/api/health`, login, cookie segura y API autenticada `200`. La VM no recibe puertos públicos ni reemplaza al host proxy.

### Registro de despliegue probado (2026-09-30)

- VM independiente `allnutrition-prod`, Ubuntu 24.04 `amd64`, 2 vCPU, 8 GiB RAM, disco qcow2 de 60 GiB; pool dedicado `allnutrition-prod`, `/var/lib/libvirt/images/allnutrition-prod`. Imagen cloud Ubuntu Noble verificada con SHA-256 `6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2`.
- Red NAT libvirt `allnutrition-prod`, bridge `virbr-anprod`, guest `192.168.201.10`; VM, red y pool configurados para autostart. El guest no tiene dirección/puertos públicos; el único puerto publicado es `web:3000` en la red privada, y PostgreSQL permanece sin puertos publicados.
- Código probado en `3199e460e617b3ebc4e0ec26a652b7e8514de881`; `npm run verify:docker` aprobó y promovió `allnutrition:release-8efed7d1630b`, `amd64`, `sha256:8efed7d1630b8e943cf234217bd355dac8eebe103074e5c9996ea9d16280f44e`. Docker 29.8.1, Compose 5.5.1, Node 24.21.0; los 12 casos Playwright escritorio/móvil y las verificaciones TLS, caída/recuperación y pg_dump/restore terminaron aprobados.
- El DNS ya apuntaba al host; no se modificaron registros. Certificado público Let's Encrypt ECDSA válido hasta 2026-12-29; el timer existente y el hook `reload-nginx.sh` renuevan y recargan Nginx. Único vhost añadido: `/etc/nginx/sites-enabled/allnutrition-wintimeapp.co.conf`. La regla de salida está aislada en `allnutrition-prod-forwarding.service`; no cambió la política global del firewall.
- El backup manual inicial es `backups/production/allnutrition-20260930T041653Z.dump`, formato PostgreSQL custom, 20 291 bytes, modo `0600`, SHA-256 `cee7606ba026a9349fe9b419af86540cbe21ccd168caafedd0405a73ebb37bc2`. Se comprobó con `pg_restore --list`. Reside solo en el disco persistente de esta VM: **aún no hay programación, retención ni copia fuera del host**.
- Setup creó un producto y cuatro catálogos para revisión; el público ve “Estamos preparando nuestro catálogo” hasta que el responsable apruebe la vitrina desde **Contacto y redes**. No se publicó contenido comercial sin aprobación.

### Actualización del panel de usuarios (2026-09-30)

- Código `f15b9db76e8628192fa1dab8f14520e1cfed0d48`, commit `feat: add administrator user management`. `npm run verify:docker` pasó en el guest `amd64`; imagen `allnutrition:release-719f42285a22`, `sha256:719f42285a22a0e0ec405270f9143003cdadf41914338eea869c7cb6474e97d5`.
- Se cambió únicamente `APP_IMAGE`; se conservó `allnutrition:release-8efed7d1630b` para rollback. La migración v2 documentada terminó sin borrar registros.
- `web` y `db` quedaron saludables. Login real, sección **Usuarios** y `GET /api/admin/users` autenticado respondieron correctamente; petición anónima recibió `401`. La lista expuso solo cuentas administradoras, sin contraseña ni hash. No se creó ninguna cuenta real.

### Actualización de Mesa de trabajo y seguridad (2026-10-14)

- Imagen `allnutrition:release-5791e836302c`, `amd64`, ID `sha256:5791e836302c24ce93b3a0885ca45c8c4bfbd2f8d62ccecccd1ba8de7070bf50`. Aprobada con `verify:docker` nativo: 138 pruebas Node sin omisiones, 16 E2E, TLS, persistencia y restore descartable. Fuente exacta: paquete SHA-256 `4ce3890617c6178a1071c17b865afa8ee98036cf1eb0c8955a626787b0fd4243`.
- Next `16.3.8` y `source-map-js 1.2.2`; auditoría dentro de web: 0 vulnerabilidades conocidas. La imagen en ejecución coincide con la aprobada. La vitrina se mantuvo publicada; datos, cuentas e imágenes se conservaron.
- Rollback de aplicación disponible con `allnutrition:release-ef825a06fb21`. Selección anterior: `/home/allnutrition/update-20261014-73cfe2a7fde6/rollback.env.release.local`. Restaurar únicamente esa selección y recrear web mediante `np`; no restaurar ni degradar automáticamente la base.
- Respaldos previos privados: `backups/production/allnutrition-20261014T152049Z.dump` y `allnutrition-images-update-20261014-73cfe2a7fde6.tar.gz`, ambos `0600`, verificados. Evidencia nativa en `/home/allnutrition/update-20261014-73cfe2a7fde6-candidate/.test-data/docker/78944180f50fffb2/artifacts/`.
- Login, editor, preview, WebP, cookie segura y logout fueron ejercitados en el dominio real, sin escrituras comerciales. Nginx compartido, DNS y firewall no se modificaron. Detalle y límites en [VERIFICACION.md](VERIFICACION.md).

### Administración de negocio, inventario y menús (2026-10-18 UTC)

- Código de aplicación `7d88580610d3c7505ca21c81d08b62ab923744d1`, publicado en `origin/trunk` antes del corte. Paquete de fuentes SHA-256 `48f5b43caddec69db365e32cd5944099b8f37b08dbc6e7b8a292da4aba312a66`. Imagen aprobada y ejecutada: `allnutrition:release-f66d59566966`, ID `sha256:f66d59566966cc4052daaa12731ba52c5ba0835641d33d3280ede48023d39bfb`, Linux/amd64, Node 24.22.0 y usuario `node`. La aceptación nativa completa y su primer intento fallido se detallan en [VERIFICACION.md](VERIFICACION.md#promoción-nativa-amd64-y-producción--18-de-octubre-de-2026).
- Primero se restauró un respaldo real en un proyecto privado sin web pública y se ensayó la migración v2→v4 con esa misma imagen. En el corte se detuvo el escritor anterior, se tomó un respaldo final y se migró antes de arrancar juntos `web` y `scheduler`. Ambos ejecutan exactamente el ID aprobado; el scheduler no publica puertos. No se modificaron Nginx compartido, DNS ni firewall.
- Se conservaron los dos usuarios y sus contraseñas, los once registros del catálogo y sus campos comerciales, la configuración/publicación, los pedidos existentes —cero en este corte— y las cuatro imágenes. Los contadores originales permanecieron exactos; se añadió `business_revision`. Las referencias sin conteo físico quedaron con existencias desconocidas, no con cantidades inventadas.
- Respaldo final: `backups/production/cutover-20261018020706627-34bf8435.dump`, 21 238 bytes, `0600`, SHA-256 `bfb4b4d7be63ac5f09b53399756918c97224f110c87d0afd630b2eef52a3e771`, comprobado mediante `pg_restore --list`. Imágenes: `backups/production/allnutrition-images-20261018020706627-34bf8435.tar.gz`, 494 838 bytes, `0600`, SHA-256 `d22b79b8ac747536a3d56bc5f88fa6dcc6fdf77cfdf7b21dc913ed000f80687a`, comprobado mediante `tar -tzf`. Código sobrescrito, configuración de selección anterior y metadatos privados se conservan en `/home/allnutrition/production-20261018020706627-34bf8435/`.
- La imagen anterior `allnutrition:release-5791e836302c` se conserva como antecedente, **no como rollback de aplicación compatible con la base v4**. Volver a v2 requiere una recuperación coordinada de datos e imagen, sin escritores y con una decisión explícita; no basta restaurar el selector ni se degrada automáticamente la base.
- En el dominio real se ejercitaron ingreso, seis áreas administrativas, lanzador por teclado, guía de atajos, menú/ancla móvil, vista previa autenticada con publicación ya habilitada y logout. Salud HTTPS `200`, API autenticada `200`, API tras logout `401`, origen ajeno `403`, cookie Secure/HttpOnly/SameSite=Strict y cuatro imágenes WebP `200`. El heartbeat del scheduler fue reciente. No se crearon pedidos ni movimientos comerciales reales.
- La evidencia nativa está en `/home/allnutrition/production-20261018020706627-34bf8435-candidate/.test-data/docker/388c05ef848ab4ba/artifacts/`. Los respaldos siguen en almacenamiento persistente de la VM, sin programación, retención ni copia fuera del host añadidas por esta actualización.

### Guía de puesta en marcha (2026-10-18 UTC)

- Código de aplicación `76a088160692d7c3236ec425bd97cff74c286c21`, publicado en `origin/trunk` antes del corte. Paquete Git archive SHA-256 `513df6bed3d1bb11df300f7fbaacae3087de7340d842218c6b4c9c16917ebc02`. Aceptación nativa completa con código 0: `/home/allnutrition/onboarding-release-7271b8cb4c-candidate/.test-data/docker/b1735ce827ffd49b/artifacts/`. El intento anterior se rechazó por una carrera del E2E móvil y quedó documentado, no promovido.
- Imagen aprobada y ejecutada por **web y scheduler**: `allnutrition:release-fd6be0fc71de`, ID `sha256:fd6be0fc71dea4021f77dbb00e6e39bfb2ebcbe481a7d64ce2698ec6b3686b9f`, Linux/amd64 y runtime Node 24.22.0. Se promovió esa imagen sin reconstruirla. Migración v4 idempotente, sin setup, seed ni reset; `.env.server.local`, TLS, volúmenes, Nginx, DNS y firewall no se sustituyeron.
- Antes del corte se ensayó la recuperación de un dump real en una base distinta sin web ni worker; usuarios, sesiones, exportación comercial e imágenes restauradas coincidieron. El clon y los archivos de extracción temporales se retiraron. Durante el corte se detuvieron web/scheduler, se tomaron respaldos finales y se compararon exactamente negocio, usuarios, sesiones, contadores, publicación y medios con ambos escritores detenidos, antes y después de la migración.
- Respaldos finales privados en `backups/production/`: `cutover-onboarding-b1735ce827ffd49b.dump` y `allnutrition-images-onboarding-b1735ce827ffd49b.tar.gz`, comprobados con `pg_restore --list` y `tar -tzf`. Tamaños, SHA-256 y distinción entre el restore ensayado y el respaldo final en [VERIFICACION.md](VERIFICACION.md).
- Rollback de aplicación compatible con v4: `allnutrition:release-f66d59566966`, ID `sha256:f66d59566966cc4052daaa12731ba52c5ba0835641d33d3280ede48023d39bfb`. Selector anterior: `/home/allnutrition/onboarding-release-7271b8cb4c/cutover/rollback.env.release.local`. Fuentes sobrescritas: `cutover/source-before.tar.gz` en ese mismo directorio de release. Restaurar únicamente el selector compatible y recrear **web y scheduler** juntos siguiendo §7; no degradar ni restaurar automáticamente la base.
- Dominio real comprobado: guía y opciones avanzadas, seis áreas, sesión anterior conservada, ingreso nuevo/logout, HTTPS público, CSRF/origen, vitrina anónima/preview, menú/ancla móvil y cuatro WebP. No se crearon cuentas comerciales, productos, pedidos ni movimientos reales durante el smoke. La guía sigue requiriendo que el responsable confirme saldo y conteo físico; no se inventaron datos para marcarla completa.
- No se añadió programación, retención ni copia cifrada fuera del host. Evidencia privada del corte y recuperación en `/home/allnutrition/onboarding-release-7271b8cb4c/{cutover,recovery}/`.

### Importación recuperable y diagnóstico repetible (2026-10-18, 19:58 UTC)

- Fuente `1f51ad4269614f2e6135e8ead2263da485dbc3db`, publicada en `origin/trunk`; Git archive SHA-256 `085b2fbb1dbcaf1558b68e46f8b8eb04652e8e3bb8ab957c3a1e356074da3528`. Aceptación nativa interactiva `196c12cbe881b794`, código 0: 510 contratos SQLite/PostgreSQL sin omisiones, 36 E2E, auditoría, recorrido comercial, reinicio 0→25→60, caída/recuperación y dump/restore.
- Imagen aprobada y ejecutada sin rebuild por **web y scheduler**: `allnutrition:release-1bc0af86a251`, ID `sha256:1bc0af86a251cc433bfd9dcf55cc7318e79b3789beb0aa584402b94968ae5acb`, Linux/amd64 y Node 24.22.0. El contenedor PostgreSQL no se recreó.
- Antes de publicar se restauró un dump real en clones separados: 42 tablas, exportación, contraseñas, settings y medios coincidieron con ambos runtimes. Los clones se retiraron. Durante el corte 19:58:15–19:59:14 UTC se detuvieron web/scheduler, se respaldó y se repitió v4 idempotentemente; la comparación congelada fue exacta antes de arrancar los dos escritores nuevos.
- Respaldos privados en `/home/allnutrition/import-release-0c834d19a4/cutover/`: `allnutrition-20261018T195834Z.dump`, `product-images.tar.gz` y `source-before.tar.gz` con las 21 fuentes sustituidas. Catálogos comprobados; tamaños, hashes y distinción entre restore ensayado y dump final en [VERIFICACION.md](VERIFICACION.md).
- `.env.server.local` y las claves se conservaron byte por byte; solo cambió `APP_IMAGE` en `.env.release.local`. Sin setup, seed, reset ni sustitución de volúmenes, TLS, Nginx, DNS o firewall.
- Rollback de aplicación compatible con v4: `allnutrition:release-fd6be0fc71de`, ID `sha256:fd6be0fc71dea4021f77dbb00e6e39bfb2ebcbe481a7d64ce2698ec6b3686b9f`. Selector `cutover/rollback.env.release.local` y fuentes `cutover/source-before.tar.gz` en la raíz privada de esta entrega. Restaurar únicamente esos archivos y recrear web/scheduler juntos según §7; no restaurar ni degradar automáticamente la base.
- Dominio real: salud 200, sesión previa conservada, guía con motivos y opción de importación, lote antiguo retomable tras navegar/recargar, móvil sin overflow, logout propio 401, vitrina y cuatro WebP 200, heartbeat reciente. No se volvió a importar el Excel ni se crearon pedidos o movimientos comerciales reales. Solo variaron `job_runs` y la sesión propia del smoke.
- Evidencia nativa en `/home/allnutrition/import-release-0c834d19a4-candidate-1f51ad4/.test-data/docker/196c12cbe881b794/artifacts/`; recuperación y corte bajo `/home/allnutrition/import-release-0c834d19a4/`. No se añadió retención, programación ni copia cifrada off-host.

## Esquema 5: cancelación de importaciones

El código de esta revisión requiere esquema **5**, publicado el **19 de octubre de 2026** con fuente `cfaee8070f45ec78fe9903af82205cdcf165b780` e imagen nativa `allnutrition:release-73620e997c62`. Los cortes anteriores documentados arriba son antecedentes, no una alternativa de rollback de imagen sobre este esquema.

Para otra promoción o recuperación autorizada:

1. Aceptar la imagen candidata en la arquitectura del servidor y ensayar la migración sobre una recuperación separada. Respaldar y detener juntos **web y scheduler** antes del cambio de esquema.
2. Ejecutar `npm run db:migrate` con la conexión privilegiada del entorno autorizado. PostgreSQL amplía el `CHECK` de estados; SQLite reconstruye la tabla de lotes y comprueba sus claves foráneas antes del commit. La migración es atómica e idempotente y no reescribe hechos, contraseñas ni sesiones. SQLite la aplica también al abrir la base; prever espacio para la reconstrucción y un respaldo válido.
3. Comprobar los marcadores **2, 3, 4 y 5** y arrancar web/scheduler con la misma imagen aprobada. El runtime PostgreSQL exige el marcador 5 y no ejecuta DDL.

No mezclar escritores v4/v5 ni asumir que una imagen anterior interpreta lotes `cancelled`. No hay degradación automática del esquema ni rollback de datos por cancelar un archivo; una recuperación a una versión anterior requiere una decisión y un procedimiento coordinados.

Una cancelación confirmada elimina la entrada `import:<id>` de `job_runs`, revocando el lease bajo el bloqueo de escritura. Su ausencia es esperada: actor, instante y cantidades conservadas/detenidas quedan en `import_batches.data.cancellation` y en `business_audit`. Las revisiones/filas fuente y los hechos confirmados permanecen; el original privado se elimina. Restaurar el respaldo no reconstruye trabajo para ese lote.

### Corte auditado de esquema 5 (2026-10-19, 21:26–21:27 UTC)

- Aceptación interactiva nativa `cbb6674080e6a41a`, código 0; la misma imagen Linux/amd64 se ejecuta en web y scheduler, sin rebuild.
- Recuperación previa en una base TLS separada: marcadores 2/3/4→2/3/4/5, 41 tablas conservadas por contenido completo y tres filas de migración anteriores intactas. El clon, su red y su volumen se retiraron.
- Web y scheduler detenidos juntos durante el respaldo final y la migración. PostgreSQL mantuvo su contenedor; no se modificaron `.env.server.local`, certificados, Nginx, DNS ni volúmenes.
- Respaldos privados en `/home/allnutrition/cancel-release-d6e2bf32be/`: `production-frozen-v4.dump` (42 tablas y bloques de datos validados), `production-frozen-media.tar` y `production-oldchangedsource.tar`. Copias privadas y evidencia en `.test-data/cancel-release-d6e2bf32be/` del equipo de operación; no están en Git.
- Antes de reabrir escritores se comprobó igualdad exacta de las 41 tablas restantes y de los marcadores previos, añadiendo únicamente el 5. Catálogo, cuatro imágenes, sesión anterior, rol limitado/TLS y nuevo heartbeat se comprobaron después del arranque.
- El dominio real mostró el lote histórico conservado y **Descartar archivo** disponible, también a 390 px. Se comprobaron rechazos 401/403/404 sin tocar importaciones reales. Detalle de incidencias, hashes y límites en [VERIFICACION.md](VERIFICACION.md).


## Automatización de negocio v3

`scheduler` ejecuta `node scripts/business-jobs.mjs` con la misma `${APP_IMAGE}`, usuario `node`, conexión limitada y CA de web; solo usa backend y no publica puertos. Debe actualizarse junto con web. No es un cron del navegador ni se ejecuta por GET.

- Loop secuencial: hasta 25 grupos de importación por turno; después devengos/comisiones, alertas vencidas y hasta 10 informes. Con backlog cede 100 ms y continúa; sin backlog espera hasta 60 s. Progreso, revisión aceptada y actor quedan en DB.
- Lease de 120 s, renovación cada 30 s y verificación transaccional del token antes de cada commit. Reiniciar no autoriza al worker anterior a escribir.
- Heartbeat independiente cada 30 s; Inicio/Configuración lo consideran detenido tras 180 s sin avance. Revisar logs privados y la conectividad si deja de avanzar; abrir la web no reanima el proceso.
- Informes cerrados: primera corrida posterior a 06:00 Bogotá, con devengos completos; recupera períodos desde `reportsStartOn`. Históricos anteriores se solicitan expresamente. Datos tardíos producen revisión nueva, nunca reemplazan las cifras guardadas.

Para observar un turno con todos los paneles cerrados, usar la función del entorno autorizado, por ejemplo `sc run --rm --no-deps scheduler npm run business:jobs:once`. Puede devolver `hasMore:true`: no implica que todo el backlog terminó. Detener scheduler **antes** de restauraciones, resets de pruebas o migraciones incompatibles; reiniciarlo después de validar la base. No ejecutar dos instancias sobre dos copias independientes del mismo negocio.

En desarrollo local ejecutar `npm run dev` y `npm run business:jobs` en terminales separadas desde la raíz, con idéntica DB. La alternativa Vercel sirve la web, pero requiere este mismo proceso en un host persistente con acceso autorizado a PostgreSQL; Vercel no ejecuta el daemon.



## 6. Backups y restauración aislada

```sh
# Usar la función del entorno correspondiente definida arriba:
sc run --rm --pull never backup
# En producción:
pc run --rm --pull never backup
```

El servicio usa `pg_dump --format=custom`, conexión TLS `verify-full`, CA explícita y `umask 077`. Los dumps `allnutrition-<UTC>.dump` son `0600` en `backups/staging` o `backups/production`, propiedad del UID/GID del operador. Contienen autenticación, negocio v3 y Excel retenidos: tratarlos como secretos. El JSON comercial v3 omite autenticación/leases, conserva finanzas, relaciones, originales, revisiones, snapshots e idempotencia y reconstruye intenciones pendientes. Ambos excluyen los binarios de `product_images`; las imágenes externas conservan solo su URL.

El scheduler de negocio **no programa backups**. El volumen `product_images` sigue requiriendo copia/restore por separado, junto con política explícita de frecuencia, retención, cifrado fuera del host y responsables. Los dumps manuales no constituyen esa política ni un SLA.

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
  console.log("Conexión limitada TLS de la restauración verificada; validar estructura v3 y negocio por separado");
} finally { await db.close(); }'
```

Esa salud es solo comprobación básica, no aceptación integral. Antes de utilizar una recuperación, comprobar con acceso limitado cuentas, sesiones, productos, totales, numeración, historial y replay/idempotencia contra evidencia privada tomada del origen, en una instancia aislada sin tráfico real. Confirmar también que el runtime no puede crear tablas. No ejecutar seed ni fixtures sobre el dump.

El verificador comprueba el pedido de control **119000**, cuenta, sesión, historial, replay y privilegios, además de comparar la exportación comercial v3 completa antes/después de restart y pg_dump/restore. `tests/docker/operations.mjs` requiere guardas y snapshot privado; `prepare`/reset solo permiten `allnutrition_test` y `assert` también `allnutrition_restore`. **No es un procedimiento de reset ni un validador genérico de producción**. No ejecutar la suite contra staging/producción para probar un backup.

## 7. Actualizaciones, rollback y fallos

1. Aprobar el nuevo release con `verify:docker` en la arquitectura destino, transportar/cargarlo y comparar ID/evidencia como arriba. Guardar el tag anterior.
2. Hacer backup de DB/imágenes y coordinar una ventana sin escrituras. Detener web/scheduler cuando el cambio de contrato lo requiera. La migración v3 convierte registros v2 sin inventar costos, vendedor ni movimientos de caja; revisar los pagos históricos marcados pendientes.
3. Cambiar únicamente `APP_IMAGE` al nuevo release. Ejecutar `pc run --rm --pull never migrate` **antes** de `pc up -d --no-build --wait --wait-timeout 120 web proxy scheduler`. Comprobar identidad de ambas imágenes, salud, heartbeat y flujos autenticados.
4. Rollback solo entre aplicaciones demostrablemente compatibles con la base actual, recreando **web y scheduler** juntos. No ejecutar una aplicación v2 sobre negocio v3 ni degradar automáticamente la base. Un cutover/restauración de datos exige decisión y recuperación ensayada aparte.

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

También se admite `npm run db:import -- --sqlite ./COPIA_DE_LA_BASE.sqlite`: abre el original `READ ONLY`, realiza backup nativo consistente con WAL a un temporal privado y migra únicamente esa copia, que cierra/elimina al terminar. No ejecutar PRAGMA/DDL ni modificar permisos del respaldo original. El destino debe estar comercialmente vacío; admite defaults y usuarios locales. Validación/restore son atómicos y dejan `launchApproved=false`. No aplica el límite de filas Excel al respaldo completo. Imágenes se copian por separado; sesiones solo viajan en copia integral SQLite o pg_dump, no en importación comercial. Conservar el origen sin escrituras paralelas hasta aceptar el cambio.
