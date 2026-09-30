# Verificación observada — Node 24 y staging Docker

Ejecución local del 29 de septiembre de 2026. No acredita publicación remota ni una ejecución de GitHub Actions. Los archivos `RESULTADOS_*.txt` anteriores son registros históricos; la evidencia vigente es la indicada aquí.

## Resultado de aceptación

`npm run verify:docker` terminó con **exit 0** en el proyecto descartable `allnutrition-test-10199872067871b1`.

| Comprobación ejecutada | Resultado observado |
|---|---|
| Host | Node `v24.14.1`, npm `11.11.0`, Docker Engine `29.3.1`, Compose `5.1.1`, LibreSSL `3.3.6`. Docker Desktop instalado se inició, sin reinstalarlo. |
| Imagen runtime | Node `v24.21.0`, Next.js `16.3.6`, Linux/arm64, UID 1000 (`node`). Build terminado; sin Playwright/TypeScript. `next start` ejecutado directamente con Node. |
| Lockfile | Metadata raíz migrada a Node `24.x` con npm de Node 24; entradas de dependencias conservadas. `npm ci` ejecutado. |
| `npm run check` en checks | 62 archivos JavaScript/JSX, 0 errores de sintaxis/imports locales. No es un chequeo de tipos. |
| `npm test` en checks | **118 aprobadas, 0 fallidas, 0 omitidas**; contratos reales SQLite y PostgreSQL 16. |
| `npm audit --omit=dev --audit-level=high` | Exit 0, sin vulnerabilidades informadas. |
| Playwright contra runtime compilado HTTPS | **12 aprobadas, 0 fallidas**, escritorio y móvil Chromium. Sin servidor dev ni SQLite E2E. |
| HTTPS | `/api/health` devuelve `200 {"ok":true}` con CA explícita, hostname localhost e IPv4; no se usó `curl -k` como prueba TLS. |
| PostgreSQL | Conexión autenticada TLS; CA equivocada rechazada por validación de cadena; TCP sin TLS rechazado por HBA con `28000`. |
| Permisos runtime | `current_user=allnutrition_app`, `pg_stat_ssl.ssl=true`; DML funciona y `CREATE TABLE` falla con `42501`. |
| Migración repetida | Conserva cuenta, contraseña, sesión, producto y pedido; no duplica registros ni rota credenciales. |
| Fronteras HTTP | Cookie Secure/HttpOnly/SameSite=Strict; CSRF ausente y Origin ajeno → 403 sin mutación; versión obsoleta → 409; logout → pedidos 401. Publicación anónima activada y revertida por formulario solo en test. |
| Caída real de DB | Salud y POST autenticado con cookie/CSRF/Origin válidos → **503**. Recuperación → 200; recuento de pedidos sin incremento. |
| Reinicio web/DB | Pedido, número, historial, cuenta, sesión y replay conservados en una conexión nueva. |
| `pg_dump` / restore | Dump custom privado 0600 restaurado en **otra base vacía**, `allnutrition_restore`; rol limitado conserva cuentas, sesiones, idempotencia, numeración, historial y total **119000 = 2 × 55000 + 9000**. |
| Producción, solo sintaxis | Compose y `caddy adapt` aprobados con `production.example.invalid`; no se inició proxy de producción ni ACME con ese nombre. |
| Limpieza | Solo contenedores, redes y volúmenes del proyecto descartable fueron eliminados; evidencia y dump retenidos. |
| CI | Workflow actualizado a Node 24 y el mismo verificador; `actionlint` lo validó localmente. **CI remoto no ejecutado aquí**. |

El contrato PostgreSQL reveló una diferencia que SQLite ocultaba: la búsqueda de guía convertía la consulta a minúsculas pero no el campo almacenado. Se corrigió `LOWER(tracking)` en `Store.pageOrders`; el contrato existente pasó en ambos motores. No se cambiaron los selectores recientes del editor de pedidos ni la lectura SQLite mediante `resolve(process.cwd(), 'db/sqlite.sql')`.

El primer recorrido Docker se detuvo en readiness tras reiniciar web: Caddy respondía temporalmente 502 sin cuerpo JSON. Se corrigió el lector del verificador para distinguir transporte de JSON y esperar recuperación con plazo de 120 segundos. El recorrido completo posterior aprobó; no se alteraron estados HTTP de negocio ni se aceptó un 502 como éxito.

También se ejercitaron generación/reuso de env y certificados, rechazo de claves incompatibles/archivos parciales sin sobrescritura, dominios inválidos, guardas de reset/origen E2E y rechazo del puerto 9443 ocupado sin terminar su listener. Migración con contraseña desincronizada y rol sobreprivilegiado falla; setup repetido conserva contenido. Los tests CA-file cubren archivo inexistente/vacío/ilegible y conflicto con CA inline.

## Imagen promovible e identidad

Release: **`allnutrition:release-d73775caf9a9`**, plataforma **`linux/arm64`**.

| Imagen | ID observado |
|---|---|
| Runtime/release | `sha256:d73775caf9a97224255ef6544989d1b565c15fd56762a7a78db03564a2e4619b` |
| Checks | `sha256:ddf1b20fc208f2f9567582259d4799e6c075643450fd73432ec00ee879d09af7` |
| PostgreSQL 16 | `sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67` |
| Caddy 2 | `sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b` |

Se ejecutó `docker image save` y `docker image load` localmente, comprobando que el ID sigue coincidiendo con `result.json`. Archivo transportable: `data/deploy/staging/artifacts/allnutrition-release-d73775caf9a9.tar` (200257536 bytes). Evidencia: `data/deploy/staging/artifacts/image-promotion.json`. No se reconstruyó bajo el tag del release.

## Staging persistente dejado en ejecución

- URL: **https://localhost:8443**; panel: **https://localhost:8443/admin/login**.
- Proyecto `allnutrition-staging`: web, PostgreSQL y proxy saludables. Solo `127.0.0.1:8443` publicado; ni 3000, 5432 ni 2019 tienen binding de host.
- `.env.staging.local` fija el release anterior. ID del contenedor web comparado con la aceptación exitosa.
- Conexión TLS autenticada como `allnutrition_app` a `allnutrition_staging`; **1 producto seed, 4 catálogos, 0 pedidos, sin cuenta E2E**, publicación desactivada.
- Smoke no destructivo en desktop/mobile: portada de preparación; API anónima 401 y ficha privada 404; login real UI, cookie segura, panel, preview del catálogo y logout seguido de API 401. No se ejecutaron fixtures, reset, outage ni restauración sobre staging.
- Se creó un backup no destructivo: `backups/staging/allnutrition-20260929T231136Z.dump`, 20336 bytes, permisos 0600 y propietario del host.
- La CA HTTPS local **no se instaló** en el sistema/llavero. El navegador del propietario puede mostrar advertencia hasta decidir confiar en ella.

### Ubicaciones privadas y capturas

| Evidencia/secretos | Ubicación |
|---|---|
| Resultado sanitizado de aceptación | `.test-data/docker/10199872067871b1/artifacts/result.json` |
| Logs/estado de aceptación | `commands.log`, `containers.log`, `state.json` en ese mismo directorio |
| Reporte y capturas E2E | `playwright-report/` y `test-results/` dentro de esos artifacts |
| Dump descartable restaurado | `.test-data/docker/10199872067871b1/backups/allnutrition-20260929T230218Z.dump` |
| Credenciales de staging, no publicarlas | `.env.staging.local` (0600) |
| TLS PostgreSQL staging | `data/deploy/staging/tls/` (CA privada fuera de contenedores; aplicación recibe únicamente `ca.crt`) |
| CA HTTPS pública staging | `data/deploy/staging/artifacts/https-ca.crt` |
| Smoke HTTPS/UI staging | `data/deploy/staging/artifacts/staging-smoke.json` |
| Capturas reales staging | `data/deploy/staging/artifacts/{desktop,mobile}-{preparation,login,panel,preview}.png` |

Se observaron capturas de panel desktop y catálogo móvil; los ocho archivos de staging provienen de navegación real Chromium. `operational.json` contiene sesión/hash de prueba y no se incluye en los artifacts de CI; env, claves y dumps tampoco se suben. No publicar carpetas privadas completas.

## Límites antes de datos reales en producción

No se suministraron dominio, correo real del administrador ni acceso/arquitectura del servidor remoto. Por ello **no se generó `.env.server.local` con valores inventados ni se publicó remotamente**. El generador y Compose de producción están preparados; seguir [DESPLIEGUE.md](DESPLIEGUE.md).

Pendientes del destino real: DNS y ACME público, firewall/puertos, capacidad/carga, almacenamiento y operación del host, cuentas reales y aprobación comercial, frecuencia/retención de backups y copia cifrada fuera del servidor, recuperación comprobada allí. Si la arquitectura difiere de arm64, ejecutar el mismo verificador nativamente en el servidor y promover su propio release. Los dumps manuales probados aquí no constituyen una política de respaldo ni alta disponibilidad. Una aceptación local no es una auditoría integral de seguridad ni una certificación de producción.
