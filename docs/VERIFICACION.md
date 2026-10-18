# Verificación v3 — administración de negocio

## Onboarding con datos previos y diagnóstico repetible · 18 de octubre de 2026

Ajuste verificado **solo en local**, con Node **24.14.1**, Next.js **16.3.8**, Chromium y una copia privada de SQLite sintética. Sin acceso a datos reales, configuración productiva ni despliegue. No hay cambios de esquema de aplicación ni se ejecutaron comandos de migración.

| Comprobación | Resultado observado |
|---|---|
| `node --test tests/business-onboarding.test.mjs tests/onboarding-report-isolation.test.mjs tests/business-settings-alerts.test.mjs` | **23 aprobadas**, cero fallidas u omitidas. Incluye ambos caminos de finalización, recursos inválidos, reejecución con fechas empatadas, reversión tras escrituras parciales y conservación de informes/snapshots/Excel. |
| `npm run check` | **176 archivos JS/JSX**, cero errores de sintaxis/imports locales. |
| `npm run build` | Compilación productiva y generación de páginas aprobadas, código **0**. |
| Navegador con datos previos | Caja, producto y pedidos como «Realizado», con cuentas/responsables, precio/unidades y **3 pedidos reales, último #3** como motivos. `setupPolicyConfirmed` permaneció falso; no se fingió una revisión explícita de reglas. |
| Avance sin importación | Finalización desde UI con **0 lotes de importación**, sin archivo ni perfil. |
| Diagnóstico en UI | Dos ejecuciones en desarrollo y otras dos en la compilación productiva móvil. IDs y fechas propios, botón repetible después de cada éxito y de finalizar; recibo conservado tras recarga y cambio a `next start`. |
| Aislamiento de las ejecuciones | Comparación exacta de **40 tablas** y de los informes del mes y año futuro, con cortes fijos. Sin diferencias en productos/reservas, pedidos, caja, auditorías, idempotencia operativa, contadores ni snapshots. Solo se excluyeron sesiones/intentos y los recibos `onboarding:trial` de la comparación. El informe actual no estaba vacío: ventas netas **55.000 COP**. |
| Error visible y último resultado | Tras deshabilitar el único producto vendible desde otra conexión del fixture, una prueba con datos de pantalla desactualizados devolvió un error real, sin escrituras ni nuevo recibo y conservando el último éxito identificado. Se restauró el producto sintético y «Actualizar datos guardados» recuperó la guía sin ejecutar una prueba automáticamente. |
| Superficie móvil | **390×844**, documento de **390 px**, sin desbordamiento horizontal; resumen, diagnóstico y recibo legibles, acción disponible. |

Hash de las tablas comparadas antes/después de los diagnósticos: `a7bce6605f425978280fcb88fb65ea28e01f4391087a8304d5be3108abd74803`. Evidencia privada sanitizada y capturas: `.test-data/onboarding-existing-OSZtPd/verification.json`, `mobile-onboarding.png`, `mobile-compiled.png` y `expected-error.png`.

El primer pase encontró una aserción nueva dependiente de la redacción del error; se sustituyó por comprobaciones del estado HTTP y de la configuración persistida. El segundo pase de los 23 contratos aprobó. No se acredita ejecución PostgreSQL para este ajuste, CI remoto, nueva aceptación Docker, despliegue, estudio de usabilidad humano ni comprobación de checkout, pagos o logística.

## Guía publicada y verificada en producción · 18 de octubre de 2026

Producción **https://allnutrition.wintimeapp.co** actualizada entre **14:52:05 y 14:52:50 UTC**, después de aprobar el candidato nativo completo. Código de aplicación `76a088160692d7c3236ec425bd97cff74c286c21`, ya publicado en `origin/trunk`; paquete Git archive SHA-256 `513df6bed3d1bb11df300f7fbaacae3087de7340d842218c6b4c9c16917ebc02`. Los commits posteriores de documentación no reconstruyen ni sustituyen la imagen aprobada.

### Aceptación nativa completa y promoción

`npm run verify:docker -- --interactive`, ejecución **`b1735ce827ffd49b`**, terminó con **código 0** en la VM amd64. Controlador Node 24.21.0; runtime comprobado Node 24.22.0, UID 1000 y sin herramientas de desarrollo.

| Comprobación del candidato final | Resultado observado |
|---|---|
| Build productivo y check | Next.js 16.3.8; 169 archivos JS/JSX sin errores de sintaxis/imports. |
| Contratos SQLite/PostgreSQL reales | 491 aprobados; cero fallidos y cero omitidos. |
| E2E serial escritorio/móvil | 36 aprobados, 5,8 min; incluye la sincronización corregida de Atrás descrita más abajo. |
| Auditoría productiva | Cero vulnerabilidades conocidas en el registro consultado. |
| Recorrido comercial por UI | Excel principal/reordenado sin duplicación, liquidación, sueldo, costo prospectivo, devolución/reembolso/flete, snapshot inmutable y mismo episodio de alerta resuelto por el ingreso real sintético, no por acusar recibo. |
| Automatización sin paneles | Lote válido de 60 grupos, aceptación con worker detenido, reinicio durable 0→25→60 y repetición sin nuevas ventas ni dinero. |
| Operación y recuperación | TLS/CA/hostname, conexión limitada sin DDL, caída con 503 y recuperación sin pedidos adicionales, persistencia de sesión/WebP, migración idempotente, dump/restore y reanudación del scheduler aprobados. |

Imagen aprobada y ejecutada sin rebuild: **`allnutrition:release-fd6be0fc71de`**, ID `sha256:fd6be0fc71dea4021f77dbb00e6e39bfb2ebcbe481a7d64ce2698ec6b3686b9f`. Web y scheduler ejecutan ese mismo ID. Artefactos nativos en `/home/allnutrition/onboarding-release-7271b8cb4c-candidate/.test-data/docker/b1735ce827ffd49b/artifacts/`; observaciones y capturas del recorrido en `.test-data/onboarding-release-7271b8cb4c/native-ui/`.

### Primer arranque PostgreSQL y práctica sin efecto financiero

Humo adicional sobre **PostgreSQL vacío**, proyecto local exclusivo `allnutrition-test-onboarding-pg-first-run-7271b8cb4c`, HTTPS loopback 19443 e imagen arm64 previamente aprobada `allnutrition:release-f00250e7b6a9`. Sin seed de productos: caja cero confirmada, responsable propuesto, un producto en borrador de 55.000 COP con dos unidades físicas y reglas vigentes se guardaron desde la guía móvil.

La práctica se recibió por UI. Antes y después se compararon **las filas completas de once tablas operativas**, settings/contadores y los hechos, cobertura, métricas y hashes de dos informes: mes de la práctica y año siguiente, calculados con un corte futuro fijo. Coincidieron exactamente; cero pedidos comerciales y existencias intactas. Después se finalizó y recargó: cuatro etapas guardadas y el mismo recibo persistido. Superficie final a 390×844, sin scroll lateral.

Se reanudó el recorrido desde lo ya guardado tras interrupciones del controlador y esperas sobre campos transitoriamente deshabilitados o fuera de vista; no se repitieron las mutaciones. La captura del navegador compartido falló y se obtuvo en Chromium dedicado con la sesión sintética existente. Este pase no se usa como cronometraje de usabilidad ni acredita otra aceptación nativa: complementa el humo SQLite y la aceptación Docker de cada arquitectura. Proyecto descartable retirado. Evidencia: `.test-data/onboarding-release-7271b8cb4c/pg-first-run/`.

### Recuperación real ensayada y corte conservador

Antes de cambiar producción se restauró `rehearsal-onboarding-7271b8cb4c.dump` en la base separada `allnutrition_restore_onboarding_7271b8cb4c`, sin web ni scheduler conectados a esa copia. La exportación comercial, usuarios, sesiones, contadores, publicación y medios coincidieron; las cuatro imágenes también se extrajeron del tar a un directorio privado y sus bytes/hashes coincidieron. Se eliminaron únicamente el clon y la extracción temporal, sin detener producción durante ese ensayo.

En el corte se detuvieron web y scheduler, se respaldó y se repitió v4 con la nueva imagen. La comparación congelada anterior/posterior fue exacta, incluidas las dos sesiones iniciales y las contraseñas hash. `.env.server.local` conservó su SHA-256; solo cambió el selector `APP_IMAGE`. No hubo setup, seed, reset ni restauración sobre la base activa; tampoco cambios de Nginx, DNS, firewall o publicación.

Respaldos en `/home/allnutrition/app/backups/production/`, todos `0600`:

| Respaldo | Bytes | SHA-256 | Verificación realizada |
|---|---:|---|---|
| `rehearsal-onboarding-7271b8cb4c.dump` | 123668 | `81030059f36a920217faefc1c3db990c6c2523ccf0b72fd16aee4f3d37277311` | Restore real en base distinta y comparación exacta; clon retirado. |
| `cutover-onboarding-b1735ce827ffd49b.dump` | 123671 | `07680888c257af54d4b7c3d9d48f7a1792af812d730f5720ce691fa433ad7f1c` | PostgreSQL custom, `pg_restore --list`; no se restauró este dump final sobre producción. |
| `allnutrition-images-onboarding-b1735ce827ffd49b.tar.gz` | 494838 | `d22b79b8ac747536a3d56bc5f88fa6dcc6fdf77cfdf7b21dc913ed000f80687a` | `tar -tzf`, cuatro archivos; el tar del ensayo previo sí se extrajo y cotejó. |

Rollback compatible con v4 conservado: `allnutrition:release-f66d59566966`. Selector previo y evidencia del corte: `/home/allnutrition/onboarding-release-7271b8cb4c/cutover/`. El archivo `source-before.tar.gz` contiene 222 fuentes sobrescritas, SHA-256 `f3c3d602c3ef9ba4be57f3b47bf7c7f3ce5c01ea0900fcbbbc3c2c4cbdf13816`. La recuperación de aplicación recrea juntos web/scheduler con el selector anterior, sin degradar automáticamente la base. No se añadió una política de retención, programación o copia cifrada off-host.

### Comprobación del dominio real después del corte

| Comprobación ejercitada | Resultado observado |
|---|---|
| Salud HTTPS pública y vitrina anónima | 200; `{\"ok\":true}` en salud y validación normal de certificado, sin excepción de CA para producción. |
| Sesión previa y API de guía | Sesión anterior al despliegue siguió autorizando; GET de onboarding 200. |
| Guía y capacidades avanzadas | Cuatro etapas, directorio avanzado inicialmente plegado, acceso real a Personas y vuelta a la guía. No se guardó configuración comercial real. |
| Seis áreas administrativas | Pedidos, Productos, Caja, Informes, Configuración e Inicio abrieron su URL y encabezado correspondientes. |
| Seguridad | Cookie Secure/HttpOnly/SameSite=Strict; origen ajeno con CSRF válido 403, CSRF ausente 403 y API anónima 401. |
| Vitrina y medios | Preview autenticado 200, cuatro WebP 200 y contacto WhatsApp observado sin enviar mensajes. |
| Móvil anónimo | 390×844, menú y ancla de Catálogo alcanzados tras terminar el desplazamiento, sin overflow horizontal. |
| Autenticación de la imagen nueva | Login nuevo 200; logout de sesión conservada y de sesión nueva 200, seguido en ambos casos de onboarding 401. |
| Automatización | Estado `running`, heartbeat reciente, límite 180 s y sin código de error. |
| Conservación tras el smoke | Negocio completo, usuarios/contraseñas, once registros de contenido, contadores, publicación y cuatro imágenes exactos; cero pedidos. Solo cambió la revocación de sesión intencional: dos sesiones durante el corte, una ajena a este smoke al finalizar. |

La guía productiva muestra honestamente Caja, Producto y Pedidos pendientes: no se inventaron saldo, conteo ni confirmaciones para marcar el negocio listo. El responsable debe proporcionar los datos reales; la prueba sintética de la aceptación no se ejecutó sobre producción.

Evidencia privada sanitizada local en `.test-data/onboarding-release-7271b8cb4c/`: `native-result.json`, `recovery-result.json`, `production-cutover-result.json`, snapshots hash antes/después y `production-ui/` (datos de cuenta enmascarados). Evidencia operativa adicional en `/home/allnutrition/onboarding-release-7271b8cb4c/{cutover,recovery}/`. No se copiaron credenciales ni dumps productivos al repositorio. No se acredita CI remoto, auditoría integral de seguridad ni ausencia de todo posible defecto.

## Aceptación Docker completa antes de commits · 18 de octubre de 2026

`npm run verify:docker -- --interactive` terminó con **código 0** en el candidato aislado, ejecución `381f0a52ac0df55d`. Incluye las tres correcciones de revisión descritas a continuación. Se empaquetaron únicamente los cambios de esta entrega; `.DS_Store`, `.env copy.example` y `CLAUDE.md` quedaron fuera.

| Comprobación completa | Resultado observado |
|---|---|
| Imagen productiva | Next.js 16.3.8, Linux/arm64, Node 24.22.0, UID 1000 y sin herramientas de desarrollo. |
| Sintaxis/imports del candidato limpio | 169 archivos JS/JSX; cero errores. |
| Contratos SQLite/PostgreSQL reales | 491 aprobados, cero fallidos y cero omitidos. |
| E2E serial escritorio/móvil | 36 aprobados; suite completa, no solo el subconjunto anterior. |
| Auditoría de dependencias productivas | Cero vulnerabilidades. |
| Operación | TLS/CA/hostname, runtime limitado sin DDL, caída con 503 y recuperación sin pedidos adicionales, persistencia de sesión/WebP y pg_dump/restore aprobados. |
| Escenario comercial en navegador | Importación principal/reordenada sin duplicación, recepción de 105.000 COP, sueldo/comisión de 15.500, resultado septiembre de 37.500, costo nuevo de 30.000 con snapshot histórico, devolución/reembolso y retorno hasta 127.500; aporte real sintético de 500 hasta 128.000 y mismo episodio de alerta resuelto. |
| Automatización sin paneles | Snapshot de septiembre inmutable con 189.500 al corte; lote de seguimiento válido, aceptado con scheduler detenido y secuencia durable 0→25→60, sin ventas ni dinero duplicados. |

Imagen local aprobada: `allnutrition:release-f00250e7b6a9`, ID `sha256:f00250e7b6a9ca60756a46b2d8c35becf5f8e4cada768f53eef8c445a047d856`. Es arm64 y **no se promueve a la VM amd64**: el despliegue exige aceptación nativa independiente.

Evidencia completa en el candidato temporal `allnutrition-onboarding-release-vkujw9o_/.test-data/docker/381f0a52ac0df55d/artifacts/`; observaciones y capturas comerciales locales en `.test-data/onboarding-release-7271b8cb4c/local-ui/`. El primer pase local se canceló después de detectar las regresiones y se repitió con las correcciones. Durante el recorrido hubo que reanudar un lote ya procesado tras el límite del ejecutor de navegador; se continuó desde sus datos persistidos, sin repetir la importación ni modificar las comprobaciones del verificador.

## Sincronización del E2E móvil durante la aceptación nativa · 18 de octubre de 2026

El primer candidato amd64, ejecución `b86a3ab235779adc`, aprobó los 491 contratos sin omisiones y 35 de 36 E2E, pero se rechazó antes del recorrido comercial y **no se promovió**. El caso de continuidad móvil consultaba `window.scrollY` inmediatamente después de Atrás; la traza muestra que `goBack` todavía devolvía la URL del producto y la lectura perdía su contexto al llegar al catálogo. La captura final conservaba búsqueda «Creatina», filtro, tema oscuro y una unidad en el pedido.

Se sincroniza el recorrido con la URL del producto y el pedido ya hidratado antes de Atrás, y con la búsqueda restaurada antes de medir. Se conservan la comparación original del scroll, su tolerancia y todas las aserciones de continuidad; no se añaden esperas fijas, omisiones ni reintentos.

Con esa sincronización, el escenario móvil dirigido aprobó en la VM (**1 aprobado; 19,3 s de Playwright**) sobre datos sintéticos nuevos, proyecto `allnutrition-test-onboarding-navigation-7271b8cb4c`, eliminado al terminar. Evidencia en `/home/allnutrition/onboarding-release-7271b8cb4c/navigation-smoke/`. Este pase dirigido no sustituye la aceptación nativa completa requerida para promover.

## Regresiones de revisión previa a publicación · 18 de octubre de 2026

Tres incidencias reproducidas en Chromium con SQLite exclusiva y corregidas antes de crear commits:

- Al archivar la cuenta propuesta después de marcar su confirmación, se conservaba la casilla para una caja distinta y se podía crear una nueva apertura sin confirmarla. Después de la corrección, la casilla se desmarca y pulsar Guardar no crea ninguna cuenta hasta una nueva confirmación explícita.
- Crear un producto de una unidad, reservarla mediante un pedido abierto desde el lanzador y repetir el alta con idénticos valores reutilizaba el identificador ya confirmado: formulario vacío, un solo producto y disponibilidad todavía falsa. Después, la segunda alta utiliza otra operación y deja dos referencias, con una realmente disponible. Los identificadores se conservan únicamente para reintentos cuyo resultado siga siendo incierto.
- El nombre de producto admitía 161 caracteres en navegador y fallaba con 400 por el límite 160 del servidor. Se alinearon los campos nuevos: producto 160 y caja/responsable 150, comprobando el límite al escribir y el guardado posterior.

Evidencia comparativa privada: `.test-data/onboarding-release-7271b8cb4c/edge-regressions.json`. Se empleó humo aislado porque estos escenarios requieren una configuración inicial incompleta y reservar la única referencia sin desmontar la guía; no se manipularon los datos compartidos de la suite E2E ni producción.

## Puesta en marcha autónoma y progresiva · 18 de octubre de 2026

Aceptación local de la guía Caja → Producto → Pedidos → Prueba y listo. Node **24.14.1**, Next.js **16.3.8**, SQLite descartable y PostgreSQL **16** en un contenedor nuevo ligado solo a loopback. No se usaron bases, credenciales ni servicios de producción y no hubo despliegue.

| Comprobación | Resultado observado |
|---|---|
| `npm run check` | 176 archivos JS/JSX; cero errores de sintaxis/imports locales. |
| `npm test` con `TEST_DATABASE_URL` de la base descartable `allnutrition_test`, `TEST_ALLOW_DATABASE_RESET=allnutrition_test` y `TEST_DB_SSL=disable` exclusivamente en loopback | **491 aprobadas**, cero fallidas y cero omitidas; contratos SQLite y PostgreSQL reales, incluidos los helpers transaccionales reutilizados. |
| `node --test tests/business-onboarding.test.mjs tests/onboarding-report-isolation.test.mjs` | **13 aprobadas**: apertura explícita/atómica, reintentos y concurrencia, reutilización, producto vendible sin publicar, reglas vigentes, finalización sin prueba, recursos agotados/archivados y aislamiento de la práctica. |
| `npm run build` | Compilación productiva/Turbopack y generación de páginas aprobadas, código 0; incluye `/api/admin/business/onboarding`. |
| `npm run test:e2e -- --grep 'los 31 destinos\|comisiones porcentuales\|APIs operativas exactas\|sesión HTTPS'` | **8 aprobadas** en 22,5 s, sobre la compilación con HTTPS local; escritorio y móvil. Incluye los 31 destinos, directorio avanzado plegable, comisiones históricas, cookie segura, origen/CSRF y la nueva API. Es un subconjunto dirigido, no toda la suite E2E. |
| Recorrido móvil Chromium, 390×844, cuenta nueva y PostgreSQL vacío | **41,726 s** desde abrir la guía hasta finalizar y recibir la práctica, por debajo de diez minutos. Incluyó recarga después de guardar caja y rechazo de descarte de un borrador de producto, conservado sin pérdida. |
| Recarga y reinicio de `next start` | Caja, producto, reglas y recibo de práctica persistidos; estado completo derivado de datos guardados e informe sin cambios. |

La aceptación compilada sirvió SQLite en `https://localhost:9448` y PostgreSQL en `https://localhost:9449`, detrás de proxies TLS exclusivamente locales con certificado de prueba. Se utilizó `E2E_ALLOW_SELF_SIGNED=1` para ese navegador; PostgreSQL sin TLS estuvo limitado al contenedor descartable publicado en `127.0.0.1:35436`, sin modificar la política de conexiones remotas de la aplicación.

### Comportamiento observado

- Caja predeterminada «Caja principal», responsable propuesto desde la cuenta y apertura de cero confirmada; no se repitieron datos del administrador. La caja se editó con el formulario habitual y reapareció como «Caja de mostrador», conservando su apertura.
- Primer producto creado dentro de la guía con nombre, precio de 55.000 COP y conteo físico real del fixture; presentación, SKU y costo permanecieron opcionales. Guardado en borrador, habilitado para pedidos administrativos y sin publicar la vitrina.
- Reglas vigentes confirmadas sin agregar comisiones ni sueldos. La interfaz explicó panel manual/WhatsApp y ausencia de checkout, pasarela o integración logística. El directorio avanzado siguió accesible, sin exigir sus diez tareas para terminar.
- En PostgreSQL, la práctica dejó **cero pedidos comerciales**, ventas y caja en cero, cuatro unidades físicas y cero reservadas. La revisión del informe permaneció **2→2** y su `factHash` y métricas se conservaron antes/después, tras recarga y después de reiniciar la aplicación.
- La regresión de aislamiento coexistió con una venta histórica real del fixture, cerró/reabrió SQLite y comparó informes histórico, actual y futuro, snapshot inmutable, Excel Resumen/Detalle, inventario, caja y numeración sin variaciones por la práctica. Un intento de cobro con el ID de práctica fue rechazado con 404.
- Después de la práctica se creó desde la UI un pedido comercial sintético en SQLite: **AN-000001**, una unidad reservada de tres físicas y caja en cero. La práctica no consumió numeración ni bloqueó ventas. Otra regresión finalizó sin ejecutar la práctica.
- La guía móvil no desbordó horizontalmente: documento y área principal de 390 px. Se observaron estados y acciones reales en escritorio y móvil, opciones avanzadas plegadas y guardas de cambios pendientes.

El primer pase dirigido detectó dos defectos de los fixtures nuevos —comparación de un row SQLite con prototipo nulo y una referencia obligatoria omitida en el intento de cobro—, corregidos sin relajar el comportamiento exigido. El runtime de desarrollo, abierto antes de introducir los helpers transaccionales, devolvió un 500 en el alta; el proceso reiniciado y la compilación limpia completaron el mismo recorrido. Un E2E móvil anterior quedó bloqueado por el indicador flotante de Next dev sobre Inicio; la aceptación final se ejecutó en `next start`, sin ocultar overlays ni forzar clics.

Evidencia local privada en `.test-data/onboarding-bda78b4b9d/`: `acceptance.json`, capturas de aceptación y `compiled-e2e-report/`. Los proxies/configuraciones temporales se retiran al terminar; no son funcionalidad del producto. La medición es un recorrido automatizado con datos sintéticos, **no un estudio de usabilidad con personas ni una garantía de tiempo universal**. No acredita CI remoto, despliegue, Safari/Firefox, lector de pantalla ni auditoría integral de accesibilidad.

## Unificación UI/UX de menús, acciones y atajos · 17 de octubre de 2026

Resultado vigente de esta unificación; los apartados posteriores conservan sus comprobaciones históricas. Código probado: `0e3049be4af5a4b87698906c35b804c6777beef2`, integrado desde `b414bb9b89ba7e896cf9966ebcd9b73aa1322d00` en worktrees privados. Sin cambios de dependencias, esquema, endpoints ni reglas comerciales. Después de esta aceptación solo se actualizó documentación.

### Aceptación ejecutada

Desde integración: `npm run verify:docker -- --interactive`, sin heredar rutas SQLite, datos, imágenes ni conexiones del árbol original. Proyecto privado `allnutrition-test-26e46225258295f7`, HTTPS `localhost:9443`, PostgreSQL 16 real y datos sintéticos. Finalizó con **código 0**.

| Comprobación | Resultado observado |
|---|---|
| Compilación productiva | Next.js 16.3.8/Turbopack; runtime Linux/arm64, Node 24.22.0, UID 1000 y sin herramientas de desarrollo. |
| `npm run check` | 164 archivos JavaScript/JSX, cero errores de sintaxis/imports locales. |
| `npm test` | 478 aprobadas, cero fallidas y cero omitidas; SQLite y PostgreSQL reales. |
| `npm run test:e2e` | 36 aprobadas, ejecución serial en escritorio y móvil. Incluye los 31 destinos, títulos, selección local, lanzador, guardas, filtros, comisión, importador y navegación/pedido públicos. |
| Auditoría de producción | Cero vulnerabilidades en `npm audit --omit=dev --audit-level=high`. |
| Operación Docker | CA/hostname explícitos, rechazo de TLS incorrecto, rol runtime limitado, caída con HTTP 503 y recuperación sin pedidos adicionales, persistencia de sesión e imagen WebP, respaldo/restauración y recuperación del scheduler. |

Imagen probada: `sha256:7cfb1872f796a05fd70e2f61cc29977643ba2e708ae5b65de3355dc2b749473f`; etiqueta local `allnutrition:release-7cfb1872f796`. Resultado, comandos, informe Playwright, golden comercial y reinicio en `.test-data/docker/26e46225258295f7/artifacts/` **del worktree de integración**, no del árbol original.

El recorrido comercial se realizó mediante formularios reales: Excel principal y reordenado sin duplicación; recepción de 105.000 COP; sueldo/comisión de 15.500; resultado de septiembre de 37.500; costo A de 30.000 vigente desde octubre y pedido nuevo sin envío/cobro con ese snapshot; devolución recuperable de 55.000/23.000, reembolso de 55.000 y retorno de 7.000, hasta disponible de 127.500. Con mínimo de 128.000, «En atención» conservó la condición; un aporte real de 500 con referencia `APORTE-SINTETICO-500` elevó disponible a 128.000 y resolvió el mismo episodio.

El snapshot se solicitó con scheduler detenido. Todos los paneles privados quedaron en `about:blank` antes de cada `business:jobs:once`; las repeticiones no crearon trabajo duplicado. El informe guardado conservó la subvista Caja y mostró 189.500 al corte de septiembre, distinto del disponible actual. El lote de seguimiento de 60 grupos se revisó con scheduler activo y se confirmó en cola después de detenerlo: el verificador comprobó **0→25→60**, reinicio y estabilidad al repetir.

### Presentación e interacción observadas

- Matriz completa de 31 vistas: Inicio; Pedidos/Envíos/Importar; Productos/Obsequios/Combos/Catálogos; cinco de Caja; siete de Informes; Primeros pasos/Personas/Cuentas/Plataformas/Reglas/Alertas; Usuarios; Datos y publicación/Preguntas/Mensajes/Condiciones de envío.
- **155 capturas administrativas** a 320×700, 390×844, 768×1024, 1440×900 y zoom nativo 200 %. Este último usó ventana 1440×900, viewport CSS 720×450 y DPR 2, no `zoom` de CSS. Dos revisiones independientes abrieron las 155 imágenes y no encontraron defectos reportables. La matriz corresponde a `20f6fc1`; el campo de archivo, único control administrativo ajustado después, se volvió a comprobar y capturar en los cinco perfiles sobre `ef63805`: fuente 16 px, alto 54 px y sin desbordamiento.
- En 390×844, Pedidos mostró búsqueda, creación y filtros compactos; las cinco vistas de Caja y las siete de Informes mostraron el comienzo de resultados, resumen o estado vacío antes de la barra inferior. En 768 px, importes y acciones de las tablas permanecieron completos.
- Vitrina definitiva en **ocho estados**, los cuatro tamaños y ambos temas: sin desbordamiento horizontal; etiquetas/ayudas operativas observadas de al menos 14 px y blancos táctiles de al menos 44×44 px. La búsqueda usa el área clicable de su `<label>`, no solo la caja de texto interior. Se conservaron identidad, fuentes e imágenes.
- Medición de colores efectivos sobre texto real, sin atribuir a un enlace padre colores que sus hijos sobrescriben: mínimo normal 4,95:1 en el área principal administrativa, 4,70:1 en vitrina clara y 5,73:1 en oscura. Los patrones públicos se evaluaron además con combinaciones conservadoras de sus colores; mínimo 5,99:1, sin exenciones de marca. Bordes de campos administrativos medidos: mínimo 3,81:1. Foco del menú público de 2 px: 13,88:1 claro y 16,75:1 oscuro.
- Tab/Mayús Tab recorrieron ambas direcciones en cuatro familias de formulario administrativo, 84 controles en total, sin enfocar controles de fondo. Menú público en ambos temas, pedido vacío y pedido de dos referencias conservaron recorrido nativo y retorno del foco con Esc. A 390×500 se alcanzaron últimos campos/acciones en editores y el pie del pedido público; es una comprobación de viewport reducido, no de un teclado virtual físico.
- Un guardado real de catálogo se mantuvo pendiente antes de enviar su petición: Cancelar quedó deshabilitado, Esc no cerró el editor y Ctrl K no abrió otro diálogo; se liberó una única escritura real. Un fallo de lectura del listado mostró Reintentar y se recuperó mediante GET 200, sin repetir escrituras.
- Los E2E definitivos comprobaron `5,25`/`5.25` como 525 puntos básicos, límites e invalidez, conservación del borrador al rechazar navegación y separación de publicación guardada/pendiente. La vitrina aprobada del fixture comprobó anclas nativas, vacío → catálogo, búsqueda de combos, Atrás con búsqueda/filtro/scroll, tema, pedido, límite 99 y referencias no disponibles. No se envió WhatsApp; en la vista previa manual se mantuvo bloqueada la publicación global.

Evidencia visual/manual fuera del código: `../evidence/` respecto de integración, dentro de `.omp-worktrees/ui-ux-menus-c74bf29b/`: `accepted-visual-index.json`, `final-imports-index.json`, `final-public-index.json`, `final-financial-ui.json`, `final-worker-observations.json`, `release-interactions.json` y capturas asociadas. Cada índice identifica el código observado; las interacciones anteriores a los últimos ajustes CSS conservan su revisión, sin presentarlas como nuevas ejecuciones. Los scripts de humo no forman parte de la entrega.

### Correcciones de la verificación

El verificador inicia el scheduler real antes del E2E de Excel; las esperas contemplan su cadencia de reposo de 60 segundos. El snapshot operativo del producto se toma después de reservar el pedido, manteniendo las igualdades estrictas posteriores. Se eliminaron aserciones de «último evento» dependientes de UUID cuando dos observaciones comparten milisegundo: ahora se comprueban el código externo conservado, el estado efectivo y el reconocimiento, sin cambiar el orden SQL ni la lógica comercial. Los dos contratos afectados aprobaron también de forma dirigida antes de la suite completa.

No se ejecutaron suites, semillas, migraciones ni guardados contra los servicios o bases originales. El navegador de aceptación usó perfiles privados, sin trasladar cookies del origen original. No hubo despliegue, publicación real, prueba en Safari/Firefox, lector de pantalla ni certificación WCAG; las mediciones y recorridos descritos no sustituyen una auditoría integral de accesibilidad.

## Promoción nativa amd64 y producción · 18 de octubre de 2026

El commit `74fc04c727469f1f2235f47ac3b62ac5207a1a25` conserva exactamente el árbol de la entrega UI aceptada y se publicó en `origin/trunk` después de separar código, regresiones y documentación. El primer intento nativo, `c3de518d436ec4aa`, compiló Next.js 16.3.8 en la VM `amd64` y aprobó sintaxis/imports; los contratos SQLite/PostgreSQL agotaron el límite global de 180 segundos antes de completar la suite. No llegó a E2E ni autorizó una promoción.

El verificador permite ahora hasta 30 minutos para la suite completa de contratos, necesaria también en la VM de 2 vCPU con PostgreSQL persistente. No se quitaron casos ni se relajaron aserciones; siguen siendo obligatorios PostgreSQL real, cero pruebas omitidas y el resto de la aceptación interactiva. El intento fallido y el respaldo previo se conservan privadamente; la aplicación y la base reales permanecieron en su versión anterior durante ese intento.

La segunda ejecución, `388c05ef848ab4ba`, usó el commit `7d88580610d3c7505ca21c81d08b62ab923744d1` y terminó con **código 0** a las `2026-10-18T03:15:32.699Z`. Imagen aprobada: `allnutrition:release-f66d59566966`, ID `sha256:f66d59566966cc4052daaa12731ba52c5ba0835641d33d3280ede48023d39bfb`, Linux/amd64, Node 24.22.0 y UID 1000. No se promovió la imagen arm64 de la aceptación local ni se reconstruyó el tag aprobado.

| Comprobación nativa | Resultado observado |
|---|---|
| Contratos SQLite/PostgreSQL | 478 aprobados, cero fallidos y cero omitidos; 694,38 segundos. El nuevo plazo permitió completar la misma suite, no reducirla. |
| E2E serial escritorio/móvil | 36 aprobados; 3,9 minutos. |
| Escenario comercial interactivo | Repetido desde formularios reales con los mismos importes y criterios del apartado UI/UX: reimportación sin duplicación, costos históricos/prospectivos, recepción, sueldo, devolución, reembolso y retorno. |
| Trabajo sin paneles | Snapshot solicitado con scheduler detenido; corridas y repeticiones con paneles cerrados. Acuse conservó el saldo bajo; aporte real de 500 COP resolvió el mismo episodio. El snapshot de septiembre mantuvo Caja y 189.500 al corte frente a 128.000 disponibles. |
| Reinicio durable | Sesenta guías revisadas con scheduler activo, confirmadas en cola después de detenerlo; el verificador comprobó 0→25→60 y ausencia de ventas/dinero duplicados. |
| Seguridad, persistencia y recuperación | Auditoría de dependencias, TLS/CA/hostname, rol limitado sin DDL, caída/recuperación, sesiones, WebP, pg_dump/restore y reanudación del scheduler aprobados. |

El respaldo real v2 se restauró y migró primero en `allnutrition-rehearsal-4e6ff379ffa73f9b`, sin publicar web ni utilizar credenciales de producción para esa instancia. Se comprobaron usuarios, configuración, identidades y campos comerciales; el proyecto de ensayo fue retirado después. Durante el corte real se detuvieron escritores, se respaldó de nuevo y se aplicaron los marcadores `[2,3,4]`. Se conservaron dos usuarios, once registros, cero pedidos y cuatro imágenes. Los cambios de registro se limitaron a las conversiones declaradas de las migraciones. No se inventaron existencias físicas. Los respaldos y límites de rollback se registran en [DESPLIEGUE.md](DESPLIEGUE.md#administración-de-negocio-inventario-y-menús-2026-10-18-utc).

La aplicación real quedó saludable a las `2026-10-18T03:22:10.994Z`; web y scheduler usan exactamente el ID aprobado y el heartbeat se observó en Configuración. El smoke del dominio, sin excepciones de certificado, comprobó login, API autenticada `200`, seis áreas/títulos, lanzador `gastos`→flecha abajo→Enter con diálogo cerrado y foco en Caja, guía de atajos, menú móvil y desplazamiento real al catálogo bajo la cabecera. También se abrió `/?preview=1` con sesión y publicación ya habilitada, se recibieron las cuatro imágenes WebP con `200`, y logout dejó la API en `401`. La cookie conserva Secure/HttpOnly/SameSite=Strict; un login de origen ajeno recibió `403`. No hubo escrituras comerciales de prueba en producción ni cambios de contraseñas.

Evidencia privada: `../.omp-worktrees/ui-ux-menus-c74bf29b/production-20261018020706627-34bf8435/` respecto del repositorio original; incluye `native-result.json`, comandos completos, ensayo/restauración, respaldo final, conservación, `cutover.json`, navegación, preview/logout y capturas. La evidencia nativa permanece también en la ruta del candidato indicada en el procedimiento de despliegue. No publicar env, dumps, sesiones ni claves. La aprobación nativa no equivale a una ejecución de CI remoto.

## Inventario conectado a Pedidos · 17 de octubre de 2026

Verificación local con Node **24.14.1** y Next.js **16.3.8**. Datos sintéticos y recursos aislados: SQLite nueva para UI/API y un contenedor PostgreSQL 16 descartable, publicado solo en `127.0.0.1:35432`. No se modificaron bases del negocio ni se desplegó una versión. La compilación y el navegador usaron una raíz/salida temporal independiente para no interferir con los servidores locales ya abiertos.

## Gestión de productos: búsqueda por referencia y tareas clave · 17 de octubre de 2026

La búsqueda de Productos ahora encuentra coincidencias por nombre, presentación, SKU y dirección corta. La prueba E2E cubre crear una ficha, buscarla por el texto ingresado, editar precio y existencias, cambiar publicación y recuperar los valores guardados.

| Comprobación | Resultado observado |
|---|---|
| `npm test` | 399 pruebas: 398 aprobadas, cero fallidas y una integración PostgreSQL omitida. |
| `npm run check` | 170 archivos JavaScript/JSX; cero errores de sintaxis/imports locales. |
| Chromium real en `http://localhost:3000` | Búsqueda por presentación encontró la referencia sembrada; formulario de alta expuso precio, existencias y publicación. No se guardaron cambios. |

`npm test` no ejecuta `tests/e2e/app.spec.mjs`; la prueba E2E ampliada requiere la configuración HTTPS/PostgreSQL de Playwright y no se ejecutó en esta pasada. La comprobación manual no sustituye esa prueba automatizada.

| Comprobación | Resultado observado |
|---|---|
| `npm run check` | 170 archivos JS/JSX; cero errores de sintaxis/imports locales. |
| `npm test` | 399 pruebas: 398 aprobadas, cero fallidas y una integración PostgreSQL omitida en esta ejecución sin URL. |
| `npm run test:postgres` con base descartable protegida `allnutrition_test` | 80 aprobadas, cero fallidas y cero omitidas; incluye los contratos de inventario y restauración entre motores. |
| `next build` sobre la raíz temporal con `--webpack` | Compilación productiva aprobada; generación de páginas y trazas completadas, código 0. |
| Chromium real a 1440×1050 | Login, edición del conteo físico en Productos y creación de un pedido desde el formulario. Tabla de físicas/reservadas/disponibles visible. |
| Chromium real a 390×844 | Tarjeta de inventario visible; documento y área principal de 390 px, sin desbordamiento horizontal. |
| Consulta directa de la SQLite del humo | Dos pedidos y cero filas en `cash_entries` después de completar el ciclo. |

El flujo UI/API observó los siguientes saldos, sin inferir cantidades:

| Operación | Físicas | Reservadas | Disponibles |
|---|---:|---:|---:|
| Guardar conteo desde Productos y crear pedido de cuatro unidades desde UI | 6 | 4 | 2 |
| Intentar otro pedido de tres unidades: HTTP 409 y sin cambios | 6 | 4 | 2 |
| Despachar dos unidades asignadas | 4 | 2 | 2 |
| Registrar devolución recuperable de una unidad despachada | 5 | 2 | 3 |
| Crear otro pedido de dos unidades | 5 | 4 | 1 |
| Cancelar el segundo pedido antes del despacho | 5 | 2 | 3 |

Los contratos permanentes cubren última unidad concurrente y rollback completo, demanda compartida de producto/combo/obsequio, edición/cancelación, conteos desconocidos frente a cero, versiones obsoletas, despacho parcial, reintentos, devoluciones recuperables/irrecuperables, composición histórica, reenvíos y correcciones. Una regresión comprueba que devolver unidades aún no despachadas no absorbe el consumo de una salida posterior ni permite despachar unidades cerradas.

Se corrigió una interferencia observada en los contratos de importación: una reserva del primer grupo incrementaba la versión del producto e invalidaba los siguientes. La revisión compara ahora el contenido comercial del producto sin sus contadores de inventario; los cambios reales de catálogo/costos siguen exigiendo revisión. Los contratos de grupos reanudables, liquidación compartida y cambio de destino aprobaron después.

Evidencia local ignorada por Git en `.test-data/inventory-20261017/`: `evidence.json`, `desktop-inventory.png` y `mobile-inventory.png`. Servidores, contenedor, base y scripts temporales se retiraron después del humo. Esta comprobación no ejecutó la aceptación completa `verify:docker`, la suite Playwright completa, axe, pruebas TLS ni CI/despliegue remoto; no promueve un release. PostgreSQL requiere la migración 4 y reinicio conjunto de escritores; los conteos iniciales reales siguen siendo datos del negocio, no valores inferidos del antiguo indicador de disponibilidad.

## Configuración: experiencia orientada a tareas · 17 de octubre de 2026

Implementación y aceptación completadas en tres ciclos. Se conserva el tema administrativo y toda la lógica de negocio, permisos y contratos del servidor. La comprobación usa un navegador Chromium real contra `next start` de Next.js **16.3.8**, en **http://localhost:3104**, con una copia aislada de una base SQLite ya poblada. No se enviaron operaciones de guardado.

### Criterio de experiencia

La portada permite reconocer la tarea sin recordar en qué menú estaba: [reconocimiento frente a recuerdo, Nielsen Norman Group](https://www.nngroup.com/articles/recognition-and-recall/). Los títulos y etiquetas describen su propósito, siguiendo la orientación de [WCAG 2.2, 2.4.6: encabezados y etiquetas](https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html).

Se elimina la navegación repetida entre barra lateral, subáreas y pestañas. Las ayudas distinguen capacidades que antes podían confundirse: personas responsables frente a usuarios del panel, cuentas del negocio frente a cuentas de plataforma, y condiciones públicas de envío frente a guías. Los detalles opcionales e históricos conservan divulgación progresiva; las acciones de entrada no quedan escondidas tras otro desplegable.

El máximo de dos clics es el criterio acordado para este trabajo, no una regla universal de diseño ni una medición de usabilidad con usuarios reales.

### Inventario y acceso desde Configuración

| Grupo | Entradas conservadas o reorganizadas | Acceso comprobado |
|---|---|---|
| Operación del negocio | Personas/sueldos, cuentas del negocio, plataformas/cuentas de origen, reglas/preferencias y alertas/avisos. | Un clic al destino; segundo clic para abrir el formulario disponible. |
| Vitrina pública | Identidad/contacto/publicación, preguntas frecuentes, mensajes comerciales y condiciones de envío. | Un clic al destino; segundo clic a crear/editar o al grupo del formulario. |
| Acceso al panel | Consulta y alta de usuarios administradores. | Un clic a usuarios; segundo acceso enfoca el alta. |
| Primeros pasos | Asistente existente de responsables, cuentas/preferencias y revisión/finalización. | Un clic enfoca el asistente, sin bloquear pedidos. |

La vista `business/accounts` añade únicamente navegación a los editores ya existentes. El catálogo compartido, el lanzador y la normalización de URL incluyen este destino. Se conserva el criterio de finalización del asistente, sin cambiar requisitos ni ejecutar su confirmación durante las pruebas.

### Comprobaciones ejecutadas

| Comprobación | Resultado observado |
|---|---|
| `npm run check` sobre la versión final | 159 archivos JS/JSX; cero errores de sintaxis/imports locales. |
| `npm run build`, con `DB_DRIVER=sqlite`, `SQLITE_PATH` de la copia temporal y `APP_URL=http://localhost:3104` | Compilación productiva aprobada, código 0. |
| `env TEST_DATABASE_URL= TEST_ALLOW_DATABASE_RESET= npm test` | 366 aprobadas, cero fallidas y una integración PostgreSQL omitida. |
| Navegación de las 11 tareas | 44 recorridos: ratón y teclado, a 390×844 y 1440×900. Un acceso a cada destino. |
| Formularios existentes disponibles | 104 recorridos: 26 variantes, dos tamaños y ambos métodos de entrada. Dos acciones desde la portada; Escape devuelve el foco al disparador. |
| Estados adicionales | 22: convenios nuevos, comisión porcentual/fija, retirada de un convenio no guardado, opciones de cierre de cuenta, borradores, tres pasos del asistente y filtros de alertas. |
| Teclado | 1.888 controles alcanzados en los recorridos; ninguno inaccesible ni tapado por las barras de acciones. |
| axe 4.10.3 | 170 comprobaciones de vistas/estados estabilizados; cero incidencias, incluidas las graves/críticas. No se deshabilitaron reglas. |
| Desbordamiento | En las 170 comprobaciones, `document.documentElement.scrollWidth <= innerWidth`; pies de diálogo dentro del viewport. |
| Conservación de datos | Huellas del contenido de 42 tablas idénticas antes/después: 340 registros en ambos casos y cero tablas modificadas. Cero peticiones API distintas de GET/HEAD/OPTIONS en los recorridos registrados. |

Se observó además el salto del lanzador con «configurar cuentas», la navegación a importación conservando plataforma/perfil, el ejemplo vivo de WhatsApp y el estado elegido de publicación sin guardar. Rechazar la navegación conservó el borrador y la selección actual; aceptarla lo descartó, y Atrás volvió a los valores guardados. En Usuarios se comprobó el salto con foco al alta y mostrar/ocultar contraseña sin crear ninguna cuenta.

### Problemas reproducidos y corregidos

- El título genérico de administración persistía al abrir Configuración directamente. La ruta genera metadatos específicos y las transiciones internas actualizan título/foco.
- El resumen lateral del editor de contenido podía desplazarse con ratón pero no tenía entrada de teclado. Ahora es alcanzable con Tab; la cabecera del diálogo no añade otro banner a estas pantallas.
- Un textarea de contacto podía quedar parcialmente debajo del guardado móvil y el campo de costo de envío bajo el pie del editor. El espacio de desplazamiento se ajusta solo en Configuración y sus editores; ambos controles permanecieron visibles después.

Las mediciones esperan las cargas y las animaciones de apertura. En los cambios de paso del asistente se espera también el final de la transición de color: `timing-observations.json` conserva los resultados transitorios y las comprobaciones estabilizadas, sin ocultar reglas de axe.

### Evidencia y límites

Evidencia local en `.test-data/configuration-ux-20261017/`: `verification-summary.json`, `pages.json`, `dialogs.json`, `advanced-forms.json`, `interactive-states.json`, `timing-observations.json`, `data-integrity.json`, `visual-proof.json` y capturas de portada, cuentas, vitrina/publicación, usuarios y foco en el editor.

Para repetir: abrir `/admin?section=business`, entrar a cada destino con ratón y con Tab/Enter, abrir sus formularios disponibles sin enviarlos y recorrer sus controles. En casillas se usa Espacio; en desplegables secundarios, Enter. Repetir en ambos tamaños, esperar las transiciones y ejecutar axe sin desactivar reglas. La copia utilizada tenía dos personas, dos cuentas, una plataforma y diez reglas de aviso.

No había condiciones de envío guardadas ni alertas activas en esa copia: se ejercitaron el alta de condición, los editores de contenido compartidos, los filtros y las diez reglas de aviso, no la edición de una condición inexistente ni la atención de una alerta ausente. No se ejecutaron guardados, eliminaciones, confirmaciones del asistente, escrituras de caja ni trabajos automáticos. El único rol sigue siendo Administrador. No se ejecutaron la suite E2E de HTTPS/PostgreSQL, CI ni despliegue; axe y el recorrido técnico no equivalen a certificación WCAG ni a un estudio con usuarios.

## Administrador: continuidad de Mesa de trabajo · 17 de octubre de 2026

Se tomó como base verificable el rediseño «Mesa de trabajo» documentado en los antecedentes de este archivo y la mejora previa del formulario de productos. Se conservaron su tema cálido, las URL de administración, los flujos existentes y las confirmaciones de cambios sin guardar. Límite aplicado: tres ciclos de implementación/verificación por tarea.

### Inventario y acceso

El directorio de Inicio, el menú móvil y el lanzador comparten un catálogo de 29 destinos de trabajo, además de Inicio:

| Área | Destinos |
|---|---|
| Pedidos y envíos | Gestionar pedidos, seguimiento de envíos e importar Excel. |
| Productos y colecciones | Productos, obsequios, combos y catálogos. |
| Caja y pagos | Cuentas/saldos, movimientos, liquidaciones, gastos y sueldos/anticipos. |
| Informes | Resumen, ventas, envíos, devoluciones, costos, sueldos y caja. |
| Negocio y acceso | Primeros pasos, personas responsables, plataformas/cuentas, reglas, alertas y usuarios. |
| Contenido de la vitrina | Contacto/redes/publicación, preguntas frecuentes, mensajes comerciales y condiciones públicas de envío. |

Se revisaron también las operaciones dentro de esos destinos: captura y edición de pedidos, cobros/reembolsos/devoluciones, costos e historia; guías, eventos, rectificaciones y vinculación; cuentas, ingresos, transferencias, cierres/reapertura y reversiones; gastos, abonos y recuperación de créditos; liquidaciones parciales y sus deducciones; preparación, confirmación y pago de sueldos; responsables, convenios, comisiones, perfiles, vigencias y alertas; consultas, cobertura, revisiones y exportación de informes. No se cambiaron sus reglas ni contratos de servidor.

### Comprobaciones ejecutadas

Navegador Chromium real contra `next dev` y, finalmente, `next start` de Next.js **16.3.8** en **http://localhost:3102**. Las escrituras funcionales se hicieron exclusivamente sobre una copia SQLite temporal y datos sintéticos; no sobre la base original del negocio.

| Comprobación | Resultado observado |
|---|---|
| `npm run check` | 158 archivos JS/JSX; 0 errores de sintaxis/imports locales. |
| `env TEST_DATABASE_URL= TEST_ALLOW_DATABASE_RESET= npm test` | 366 aprobadas, 0 fallidas y 1 integración PostgreSQL omitida. No se autorizó ningún reset de una base real. |
| `npm run build`, con entorno SQLite de la copia temporal | Compilación productiva aprobada, código 0. |
| Acceso desde Inicio | 29 destinos × 2 tamaños: cada recorrido usó «Todas las tareas» y el destino, exactamente 2 pulsaciones. |
| Página y área de trabajo | 60/60 comprobaciones aprobadas, incluidos Inicio y el directorio abierto, a 390×844 y 1440×1000. `scrollWidth` no superó el ancho disponible ni en el documento ni en el workspace. |
| Teclado en las pantallas pobladas | 60/60 recorridos; 1.254 controles alcanzados con Tab. Los desplegables se abrieron con Enter antes de recorrer sus controles. |
| Diálogos | 48/48 comprobaciones en la compilación final; 627 controles alcanzados, sin faltantes. Pies dentro del viewport y ancho del diálogo sin desbordamiento. |
| Acceso por teclado | Directorio, lanzador y «Más» activados con Enter; Escape cerró el lanzador y restituyó el foco. |

Las peticiones de lectura y escritura mantuvieron sesión, origen y CSRF existentes. La suite E2E estándar de HTTPS/PostgreSQL **no se ejecutó** en esta pasada; el smoke de navegador no la sustituye.

### Flujos funcionales observados

- Alta de responsable y cuenta desde la interfaz; gasto pagado e ingreso no comercial con sus efectos exactos de caja. El ingreso no se convirtió en venta.
- Pedido manual de **119.000 COP**: dos unidades de una referencia de 55.000 y flete de 9.000. Registrar la recogida dejó el pedido Enviado; cobrarlo dejó el pago Pagado, sin alterar cantidad ni total.
- FAQ guardada como borrador con dirección propuesta a partir del título. Combo guardado con su precio manual y cantidad correcta después de añadir y quitar componentes; el foco pasó al nuevo selector y volvió al restante.
- Alta de usuario confirmada en el servidor, con ambos campos de contraseña vacíos después del éxito.
- Excel privado real de 34 columnas y dos filas de contenido: archivo, columnas, revisión, resolución explícita de dos productos y un vendedor, confirmación y resultado completado. Se creó un único pedido entregado de **122.000 COP**; el recaudo de plataforma no aumentó el disponible de caja.
- Recepción de liquidación con flete y cargo vinculados, y pago de sueldo confirmado: estados, recibo único y saldos comprobados mediante lecturas reales posteriores.
- Escape sobre un producto modificado: rechazar la confirmación conservó el borrador; aceptarla después cerró el editor sin modificar el título guardado.

El lote Excel avanzó mediante el procesador real `processImportTurn` sobre esa misma copia descartable. Esto no acredita la operación de un worker permanente.

### Regresiones reproducidas y corregidas

- La barra inferior móvil recibía una pulsación destinada a un acceso parcialmente cubierto. El workspace ahora se desplaza entre ambas barras; los recorridos reales de dos pulsaciones pasaron después.
- Un `fieldset` financiero con `display: contents` no podía actuar como área desplazable y dejaba el pie fuera de la pantalla al abrir opciones adicionales. El fieldset del diálogo tiene caja propia y scroll; el pie terminó dentro de 844 y 1000 px, también con líneas/deducciones de una liquidación real.
- «Configuración» y «Datos de envío» no encontraban sus tareas en el lanzador. Se indexaron los nombres y grupos actuales de las secciones: seis resultados para configuración, también sin tilde, y uno para datos de envío.

### Evidencia y límites

Evidencia local en `.test-data/admin-ui-ux-20261017/`: `verification-summary.json`, `production-navigation.json`, `keyboard-final.json`, `keyboard-entry.json`, `dialogs-final.json`, `functional-flows.json`, `import-stages.json`, `detail-layouts.json`, `search-regression.json` y capturas de las áreas, editores, recibos e importación.

Para repetir el criterio de acceso, abrir Inicio en cada tamaño, activar «Todas las tareas» y después cada destino. Para teclado, abrir los desplegables con Enter y recorrer con Tab sus controles habilitados; en los diálogos, comprobar también Escape y las confirmaciones de borrador. Los JSON registran cada destino, tamaño y resultado, no solo un total agregado.

No hubo despliegue, cambios de APIs/autenticación/esquema/dependencias ni cambios propios en la tienda pública. No se acredita CI, TLS, infraestructura, una auditoría WCAG ni una prueba de usabilidad con usuarios reales. Los antecedentes siguientes corresponden a otras verificaciones y se conservan sin reinterpretarlos.


## Historial de vitrina: regreso directo al catálogo · 17 de octubre de 2026

Se reprodujo el fallo comunicado: después de Catálogo → producto → Atrás, la URL era `/#catalogo` pero seguía renderizada la ficha. El salto nativo había creado una entrada sin estado de Next.js y se combinaba con una transición `Link` al producto. La comprobación anterior en `.test-data/vitrina-navigation-hash/` había recorrido Atrás/Adelante después de «Volver al catálogo», no el regreso directo desde la ficha. Al probar solo `Link` también se reprodujo la concatenación de fragmentos en esta versión.

Decisión final: todos los enlaces internos de la vitrina usan navegación de documento del navegador, incluidos inicio, imágenes/títulos de productos, catálogos, combos y secciones. Las rutas cargan páginas completas en lugar de transiciones SPA; no se añaden parches de historial ni escuchas de `popstate`. Al restaurarse un documento desde la caché de páginas, `pageshow` vuelve a leer pedido y tema guardados y descarta avisos de compra anteriores.

- Compilación final: `npm run check`, 159 archivos JS/JSX y 0 errores; `npm run build`, código 0. Verificación posterior contra `next start` en Chromium real, recargando el documento para cargar el código actualizado.
- Cuatro combinaciones: 390×844 y 1440×900, claro/oscuro. Catálogo → producto → Atrás, antes de pulsar «Volver al catálogo», restauró la pantalla de inicio con sus cuatro tarjetas y exactamente la posición previa. La ficha dejó de estar renderizada; no se comprobó solamente la URL. Adelante restauró el producto seleccionado.
- Desde `/#catalogo#catalogo#catalogo`, activar Catálogo o el CTA del inicio dejó un solo fragmento. Seis clics adicionales no añadieron fragmentos ni entradas redundantes de historial. Se ejercitaron también el CTA final, Cómo comprar, «Volver al catálogo» y ausencia de desbordamiento horizontal.
- El pedido y el tema se conservaron en los recorridos principales. WhatsApp mantuvo destinatario, referencia, cantidad y un único total de productos; no se enviaron mensajes.
- Se conservaron búsqueda «CR7» y filtro Creatinas al volver directamente de la ficha. También se restauró `/catalogos/creatinas#catalogo` con su selección. El regreso desde una recomendación volvió a la ficha anterior y su sección, sin forzar siempre el inicio. Se comprobaron logo, imagen/título destacado y activación del catálogo con Enter.
- Una copia SQLite descartable comprobó ambos enlaces de un combo. Añadirlo y cambiar el tema en la ficha se reflejó al volver al catálogo; quitarlo y cambiar otra vez el tema se reflejó al usar Adelante. Se observó `pageshow.persisted: true`: la prueba ejercitó la caché de páginas real, no una recarga. El aviso antiguo de producto añadido no reapareció y WhatsApp conservó el resumen del combo. La referencia temporal no se incorporó al catálogo de revisión.

Evidencia actual en `.test-data/vitrina-back-navigation/`: `before.json` y `link-hash-failure.json` documentan los fallos de navegación; `combo-return.json`, el estado desactualizado de la caché antes de sincronizarlo; `after.json`, `combo-after.json`, `contexts.json` y las capturas corresponden a la implementación final. Vista compilada actualizada en `http://localhost:3101/`; sin despliegue ni cambios propios en datos reales, estilos, precios, inventario, administración o APIs.

## Identidad de gimnasio y WhatsApp sin redundancias · 17 de octubre de 2026

Objetivo aceptado en dos ciclos de cambios y comprobación. Se verificó la compilación final con un navegador Chromium real contra `next start`, usando una copia aislada del catálogo público y otras copias independientes para variantes. El segundo ciclo resolvió una presentación duplicada detectada al revisar los enlaces reales. No se desplegó esta actualización ni se modificaron datos reales.

- `npm run check`: 158 archivos JS/JSX revisados, 0 errores de sintaxis/imports locales.
- `npm run build`: Next.js 16.3.8 compiló correctamente, código 0.
- `document.fonts.load` confirmó Barlow Condensed ExtraBold de peso 800 cargada y aplicada a los titulares. La fuente se solicitó a `/_next/static/media/` del propio servidor, no a Google; se incluyeron el archivo original y la licencia SIL OFL 1.1 en `public/brand/`.
- Inicio y ficha a 390×844 y 1440×900, en claro y oscuro: ocho superficies sin desbordamiento horizontal, con cuatro tarjetas mostrando imagen, nombre, precio y compra sin hover. Las áreas visibles de las imágenes se mantuvieron respecto de las ocho capturas de la línea base.
- Pedido en los mismos tamaños y temas: cuatro superficies adicionales sin desbordamiento de página ni del diálogo, con el botón de WhatsApp dentro de la pantalla.
- «Selección para tu entrenamiento» se observó en el inicio; «En primera fila» dejó de mostrarse. La selección no se presentó como ranking de ventas o popularidad.

Contraste medido sobre los colores realmente renderizados:

| Elemento | Claro | Oscuro |
|---|---:|---:|
| Texto principal sobre fondo | 13,88:1 | 16,75:1 |
| Texto secundario sobre fondo | 5,04:1 | 8,66:1 |
| Texto del botón principal | 5,73:1 | 5,73:1 |

WhatsApp: 2×Vital Force y 2×CR7+ conservaron 4 unidades y total de productos de 226.000 COP. El texto decodificado incluyó una mención de cada referencia, sus cantidades/presentación/sabor, un solo importe total y una sola consulta de disponibilidad/envío. Se retiraron la solicitud duplicada del final y los importes repetidos por unidad/línea. Las consultas individuales conservaron el contexto completo; las generales no añadieron cantidades ni importes ficticios. No se enviaron mensajes.

Segundo ciclo: «Creatina Ultra Pure 100 Servicios · 100 Servicios · Sin sabor» pasó a «Creatina Ultra Pure 100 Servicios · Sin sabor» tanto en consulta individual como en pedido. La presentación apareció una sola vez y se conservó el sabor. Se comprobó además que un nombre con «(Sin sabor) · 70 servicios» no repite esos campos pese a cambios de mayúsculas/puntuación, y que «B12» no provoca descartar una presentación «12». Un pedido real de verificación con 1×Vital Force y 2×Ultra Pure conservó total de 255.000 COP, una sola solicitud y un único total. Se recompiló, se repitieron las doce superficies principales y el caso de referencia de 226.000 COP, y se mantuvieron selección, tema, recálculo, búsqueda y filtros.

En otra copia descartable se respetó la plantilla personalizada «Hola All Nutrition, ¿pueden revisar {producto}?», sin añadir una segunda pregunta. Un combo pasó de una a tres unidades y total de 366.000 COP sin repetirse en el mensaje; se comprobaron sus componentes, los agotados sin botón de añadir, anuncio editable, FAQ y bloques de información en ambos tamaños/temas.

También se ejercitaron búsqueda, recuperación del estado vacío, filtro/ruta de catálogo, recálculo al reducir/quitar y pedido vacío. La versión compilada conservó una selección al navegar por enlace a la ficha y mantuvo el tema claro guardado aun con el dispositivo emulando oscuro; Escape cerró el pedido. El catálogo no desbordó a 320×700, 768×1024 y 1024×768.

Evidencia local: `.test-data/vitrina-training-3olicapo/`, con `baseline.json`, `cycle-1-visual.json`, `production-proof.json` del segundo ciclo, `whatsapp-proof.json`, `label-deduplication-proof.json`, `second-cycle-commerce.json`, `variants-proof.json`, `contrast-proof.json`, `navigation-proof.json`, `persistence-proof.json` y capturas. La vista compilada de revisión está en `http://127.0.0.1:3101/`. Esta aceptación local no acredita CI ni despliegue remoto y no sustituye la verificación Docker/PostgreSQL de administración registrada en este archivo.

## Refinamiento estético y textos comerciales · 17 de octubre de 2026

Se refinó la vitrina sin sustituir las funciones aceptadas: identidad marfil/carbón con acentos rojos, jerarquía tipográfica y superficies coherentes en inicio, catálogo, ficha, combos, información comercial y pedido. Las selecciones de dos a cuatro referencias usan dos columnas en escritorio; en móvil, el destacado aparece antes del bloque editorial. Los contenidos editables, imágenes, precios, condiciones y plantilla de WhatsApp se conservaron.

- `npm run check`: 158 archivos JS/JSX, 0 errores de sintaxis/imports locales.
- `npm run build`: compilación productiva Next.js 16.3.8, código 0. Recorrido real posterior contra `next start`.
- Inicio y ficha en 390×844 y 1440×900, ambos temas: ocho combinaciones sin desbordamiento horizontal, con imagen/nombre/precio/compra visibles sin hover. Ninguna imagen redujo su área visible respecto de la entrega anterior. En el inicio móvil, el botón del destacado terminó dentro de los primeros 844 px, con su imagen, nombre y precio antes de él.
- Inicio adicional a 320×700, 768×1024 y 1024×768: sin desbordamiento horizontal.
- Pedido de 2×Vital Force y 2×CR7+: 4 unidades y 226.000 COP; se conservaron el mensaje completo y el número comercial, el recálculo al reducir/quitar, la persistencia al navegar y el cierre con Escape. El CTA final con selección abrió el pedido. Búsqueda, recuperación del estado vacío, consultas individuales y pedido vacío siguieron funcionando.
- Otra copia descartable independiente comprobó agotados sin botón de añadir, combinación de cantidades de un combo, anuncio editable, mensaje informativo, FAQ desplegable y condiciones de envío/pago en móvil/escritorio y claro/oscuro. Esos registros temporales no se incorporaron a la vista local del catálogo público.

Los textos de interfaz invitan a armar el pedido y continuar por WhatsApp, sin inventar descuentos, urgencia, beneficios del producto ni condiciones comerciales. No se enviaron mensajes, cobraron pagos, crearon pedidos comerciales ni alteraron datos reales.

Evidencia local: `.test-data/vitrina-refinement-t0ynzeqm/`, con `baseline.json`, `visual-proof.json`, `production-proof.json`, `commerce-proof.json`, `variants-proof.json` y capturas. Vista compilada de revisión en `http://127.0.0.1:3101/`; no implica despliegue en producción ni ejecución de CI/Docker/PostgreSQL.

## Vitrina clara/oscura y pedido por WhatsApp · 17 de octubre de 2026

Aceptación local del primer ciclo de cambios. Se usó una copia temporal aislada con los cuatro productos e imágenes públicos de la vitrina; los estados de agotado y combo se probaron con variantes descartables en esa copia. No se alteraron datos, precios ni inventario del negocio, ni se publicó esta actualización.

- `npm run check`: 157 archivos JS/JSX, 0 errores de sintaxis/imports locales.
- `npm run build`: compilación productiva Next.js 16.3.8 completada, código 0.
- Navegador Chromium real contra `next dev` y después contra `next start`: inicio y ficha a 390×844 y 1440×900, en claro y oscuro. En las ocho combinaciones productivas, `document.documentElement.scrollWidth === innerWidth`; las cuatro tarjetas mostraron imagen, nombre, precio y compra sin hover.

Área visible de las mismas imágenes antes/después, respetando su proporción dentro de `object-fit: contain`:

| Superficie | 390×844 | 1440×900 |
|---|---:|---:|
| Imagen principal del inicio | +66,2 % | +108,6 % |
| Imágenes de tarjetas, aumento mínimo entre cuatro referencias | +72,1 % | +110,5 % |
| Imagen de la ficha individual | +77,8 % | +121,4 % |

Compra ejercitada desde tarjeta y ficha: 2×Vital Force a 55.000 COP y 2×CR7+ a 58.000 COP dieron 4 unidades y subtotal 226.000 COP. El mensaje de `wa.me/573043440035` incluyó ambas referencias, presentaciones, cantidades, precios y total; no se envió. Reducir una unidad recalculó a 171.000 COP; quitar CR7+ dejó 55.000 COP. Navegar conservó pedido y tema; Escape cerró el diálogo.

También se comprobaron búsqueda, recuperación del estado vacío, filtro/ruta de catálogo, pedido vacío sin enlace de compra, reposición de agotados sin botón de añadir, y composición/cantidades de un combo temporal en ambos tamaños y temas. El pedido es una selección de sesión, no un alta automática en administración ni una reserva de stock.

Evidencia local ignorada por Git: `.test-data/vitrina-7o05twke/`, con `baseline.json`, `production-proof.json`, `cart-proof.json`, `variants-proof.json` y capturas antes/después. Esta comprobación no sustituye la aceptación Docker/PostgreSQL de administración registrada debajo ni acredita despliegue o CI remotos.

## Registro anterior de administración v3

Actualización local del 16 de octubre de 2026, calendario Bogotá. Datos exclusivamente sintéticos; **no se desplegó ni migró producción**. El registro productivo del 14 de octubre se conserva debajo como antecedente.

## Comprobaciones de código y contratos

| Comprobación ejecutada | Resultado observado |
|---|---|
| `npm test` con PostgreSQL real aislado | 434 aprobadas, 0 fallidas y 0 omitidas; mismo contrato SQLite/PostgreSQL, límites Excel, migración y restore entre motores. |
| Contrato PostgreSQL focalizado | 68 aprobadas sin omisiones; incluye v3 SQLite→PostgreSQL y PostgreSQL→SQLite, rollback de respaldo inválido y abono v2 sin caja inventada. |
| `npm run check` | 156 archivos JS/JSX, 0 errores de sintaxis/imports locales; no sustituye compilación. |
| Runtime Docker compilado | Next16.3.8, Node24.22.0, Linux/arm64, usuario1000; sin Playwright ni TypeScript en runtime. |
| Suite E2E contra ese runtime HTTPS | 26 aprobadas en desktop/mobile, incluidas guardas Back/Forward/Escape, cuenta con apertura0 y responsable sin login, ingresos no comerciales, sesión/origen/CSRF, privacidad y descarga con sesión vencida. |
| Auditoría en checks de Docker | `npm audit --omit=dev --audit-level=high`: 0 vulnerabilidades conocidas en el registro consultado. |
| CLI sin panel abierto | Solicitud UI202; navegador cerrado; turnos reales `business:jobs:once` evaluaron alertas y generaron1 snapshot. Al reabrir, informe y heartbeat real visibles; no temporizador React. |
| CLI backup/restore JSON y SQLite | Ambos destinos nuevos conservaron saldo127500 COP,2 pedidos,2 originales Excel y1 snapshot, con documentos/movimientos iguales y0 usuarios importados. |

La prueba CLI preliminar añadió después una guía sin costo: el informe vivo conserva subtotal conocido37500 y cobertura parcial; no se presenta ese subtotal como beneficio completo. El escenario comercial Docker se verifica antes de añadir su lote de seguimiento adicional.

## Recorrido comercial real por UI en Docker

Mismo runtime HTTPS y base descartable de la aceptación. `business-prepare` creó solo productos/persona/reglas/apertura y archivos sintéticos; pedidos, recaudos, liquidación, sueldo, corrección de costo, pedido nuevo, devolución y pagos se hicieron desde formularios reales.

| Hecho observado | Banco COP | Plataforma pendiente COP |
|---|---:|---:|
| Importación principal y reimportación reordenada | 100.000 | 122.000 |
| Recepción de liquidación, retenciones17.000 | 205.000 | 0 |
| Pago de sueldo/comisión15.500 | 189.500 | 0 |
| Devolución comercial de1×A recuperable, sin reembolso todavía | 189.500 | 0 |
| Reembolso55.000 | 134.500 | 0 |
| Pago del retorno7.000 | 127.500 | 0 |
| Aporte no comercial del propietario500 | 128.000 | 0 |

| Métrica de septiembre2026 | COP |
|---|---:|
| Ventas netas de productos | 110.000 |
| Flete cobrado | 12.000 |
| Costo vendido | 46.000 |
| Obsequios | 6.000 |
| Transporte | 15.000 |
| Cargo de plataforma | 2.000 |
| Comisión | 5.500 |
| Contribución | 47.500 |
| Sueldo fijo | 10.000 |
| Resultado operativo | 37.500 |

Cobertura completa antes del lote adicional. Reimportar conservó1 pedido,1 guía con ceros iniciales y los mismos importes; ambas descargas privadas fueron idénticas a los originales. Cambiar A a30000 desde1octubre conservó septiembre y el costo histórico23000 del pedido principal. Un **nuevo** pedido de octubre, A×1/flete0, quedó sin envío/cobro y mostró snapshot30000. La devolución recuperó23000 y generó crédito de comisión−2750; la contribución de octubre fue−36250, sin volver a descontar ventas al pagar el reembolso.

## Worker e informes con todos los paneles cerrados

- Con saldo127500 se detuvo el servicio; mínimo128000 y snapshot septiembre se solicitaron por UI. Se cerraron contexto y navegador antes de ejecutar la orden Compose exacta impresa.
- Primera corrida real:1 alerta abierta y1 informe procesado. Al reabrir, snapshot completo y alerta con responsable/acción. Repetir produjo0 alertas nuevas y0 informes procesados; se conservaron los mismos IDs.
- «En atención» se guardó por UI. Otra evaluación mantuvo el mismo episodio sin resolverlo; la acción «Revisar cuenta» abrió la cuenta correcta.
- Aporte real no comercial500 con referencia `APORTE-SINTETICO-500`: saldo128000. Antes de evaluar la alerta seguía en atención; la siguiente corrida resolvió1 episodio sin abrir otro.
- El snapshot de septiembre conservó su ID/cifras tras el aporte. `reports` en la salida CLI cuenta trabajos procesados, no nuevas revisiones: ese último turno procesó1 recálculo sin duplicar snapshot.

Estadísticas observadas y argumentos de las cuatro corridas en `artifacts/business-closed-panels.json`. Navegación/capturas reales en1440×900 y390×844, sin overflow horizontal de página ni errores de JavaScript en los recorridos comerciales.

## Aceptación integral final (2026-10-17 UTC)

`npm run verify:docker -- --interactive` terminó con `exitCode: 0` a las `2026-10-17T03:11:44.158Z`. El recorrido comercial anterior, el trabajo sin paneles y esta prueba operacional pertenecen a la misma ejecución: `.test-data/docker/27de6a7636ce20e2/`.

### Reinicio de una revisión aceptada

El lote de seguimiento quedó aceptado en revisión1, con60 filas y0 aplicadas. Se cerraron todos los navegadores; un turno limitado aplicó25 filas y el servicio reiniciado completó60, sin volver a aceptar ni cambiar el lote. Durante esta secuencia:

| Estado observado | Filas aplicadas | Pedidos | Guías | Cobros | Entradas de caja | Snapshots |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Aceptado, en cola | 0 | 2 | 1 | 2 | 6 | 1 |
| Primer turno limitado | 25 | 2 | 26 | 2 | 6 | 2 |
| Completado tras reinicio | 60 | 2 | 61 | 2 | 6 | 4 |
| Repetición estable | 60 | 2 | 61 | 2 | 6 | 4 |

Los dos pedidos son el comercial de septiembre y el borrador nuevo de octubre para comprobar el costo30000; las guías de seguimiento no inventaron pedidos, ventas ni dinero. El snapshot completo original de septiembre conservó sus datos inmutables. Los nuevos contenidos de25/50/60 guías produjeron revisiones distintas y reportaron explícitamente costos logísticos desconocidos; repetir el mismo estado no creó otra revisión.

### Operación, restauración e imagen probada

- Se aprobaron CA explícita/hostname, rechazo de CA equivocada y conexión PostgreSQL sin TLS, rol runtime sin DDL, migración repetible, sesiones, replay y numeración.
- La caída real de PostgreSQL devolvió503 en salud y POST autenticado; la recuperación no creó pedidos adicionales. Reiniciar web/base conservó sesiones, documentos e imagen WebP.
- `pg_dump` se restauró por TLS en otra base vacía y se comparó el negocio v3 completo. El WebP permaneció en su volumen separado; el scheduler volvió a operar después de caída/reinicio y restauración aislada.
- Se validó la sintaxis de Compose/Caddy de producción con un dominio ficticio, sin publicación ni ACME real.

Promoción **solo local**: `allnutrition:release-a9f82460335f`, imagen `sha256:a9f82460335f3310ddaa491c1ee76c4e50a3efd817c273f655ee892af1f01b27`, `linux/arm64`, Node`v24.22.0`, UID`1000`. No se desplegó v3 en staging, producción ni Vercel. Antes de promover en un destino amd64 corresponde repetir allí la aceptación nativa; no se afirma CI ni aceptación remota ejecutada.

Evidencia en `artifacts/result.json`, `business-ui.json`, `business-golden.json`, `business-closed-panels.json`, `business-restart.json`, `commands.log`, reporte Playwright y capturas desktop/móvil; las comprobaciones auxiliares están en `artifacts/supplementary/`. Conservar `env`, dumps y artefactos comerciales como evidencia privada; no publicar credenciales ni respaldos.

Se observó la eliminación exclusiva de contenedores, redes y volúmenes del proyecto descartable. Se cerraron navegadores, se detuvieron los servicios locales auxiliares y se eliminaron los scripts temporales propios; se conservaron la imagen aprobada y las evidencias, sin modificar otros proyectos ni producción.

## Correcciones reproducidas

- Un corte de seguimiento de día se mostraba como «11:59 p. m.». La UI ahora conserva la fecha original, indica «Sin hora informada» y separa una observación manual posterior; no presenta esta última como frescura del archivo.
- Dos aperturas legales sumaban más que el límite de un documento y Caja rechazaba el consolidado. Ahora valida el total como entero seguro, sin aplicar el techo individual al agregado.
- Un archivo de seguimiento con guía pero sin transportadora aparecía válido y fallaba al aplicar. Preview usa la misma validación de metadatos que el comando, sin relajar el requisito ni perder el original.
- Rechazar Atrás consumía el destino previo por interacción con History API de Next. Se conserva el estado de navegación del framework y se restaura la entrada rechazada; los E2E prueban retención, aceptación, Adelante y borrador nuevo vacío.
- Chromium/Playwright devolvía cuerpo CDP vacío para una descarga cuyo archivo físico tenía34249 bytes y firmaPK. La regresión lee el archivo realmente descargado, conserva verificación de headers privados y comprueba401 sin descargar JSON al caducar la sesión.

### Precisión del XLSX

Un escenario real de901 aperturas legales, seguido de un ingreso de1 centavo, produjo estos dos saldos distintos. Antes se exportaban como el mismo número; después permanecen como texto decimal COP exacto:

| Centavos internos | Celda XLSX corregida | Tipo |
|---:|---|---|
| `9007199254740990` | `90071992547409,90` | Texto |
| `9007199254740991` | `90071992547409,91` | Texto |

El límite individual no cambia; importes ordinarios siguen siendo numéricos. El libro incluye esta salvedad en Definiciones.

# Antecedente — producción actualizada el 14 de octubre

Despliegue realizado el **14 de octubre de 2026** en **https://allnutrition.wintimeapp.co**. VM privada `allnutrition-prod`, Linux `amd64`, Docker Compose y PostgreSQL detrás del Nginx existente. No se cambiaron DNS, firewall ni otros sitios del host.

| Comprobación ejecutada | Resultado observado |
|---|---|
| Imagen nativa aprobada y desplegada | `allnutrition:release-5791e836302c`, ID `sha256:5791e836302c24ce93b3a0885ca45c8c4bfbd2f8d62ccecccd1ba8de7070bf50`, `amd64`. El contenedor web ejecuta ese mismo ID y está saludable. |
| Versiones en producción | Next `16.3.8`, `source-map-js 1.2.2`, Node `v24.21.0`. |
| `npm run verify:docker` en la VM, entorno descartable | Exit 0; **138 pruebas Node aprobadas sin omisiones**, **16 E2E aprobados** en escritorio/móvil (54,6 s), sintaxis, TLS, rol sin DDL, caída/recuperación, reinicio, idempotencia y pg_dump/restore. No se ejecutó la suite destructiva sobre producción. |
| Auditoría dentro de web en producción | `npm audit --omit=dev --json`: **0 vulnerabilidades conocidas**. |
| HTTPS público | Salud `200 {"ok":true}`; navegador y smoke con validación normal del certificado, sin excepción de CA. |
| Smoke autenticado real | Login 200; cookie Secure/HttpOnly/SameSite=Strict; «Tu mesa de trabajo», listado y editor nativo con valores persistidos/foco; preview con imagen WebP y WhatsApp; logout seguido de pedidos 401. Sin altas ni escrituras comerciales. |
| Datos conservados | 0 pedidos, 11 registros, 2 cuentas, 0 eventos de auditoría; vitrina publicada y versión de configuración 2, antes/después. Las 4 imágenes conservaron los mismos 494094 bytes y hash agregado. |
| Superficie pública | Vitrina real inspeccionada a 1440 × 1000 y 390 × 844; mismos cuatro productos/imágenes, sin tema administrativo ni scroll lateral. |

## Trazabilidad y reversión

- Fuentes desplegadas desde un snapshot, SHA-256 `4ce3890617c6178a1071c17b865afa8ee98036cf1eb0c8955a626787b0fd4243`. No se atribuye a un commit inexistente.
- Aceptación nativa: `/home/allnutrition/update-20261014-73cfe2a7fde6-candidate/.test-data/docker/78944180f50fffb2/artifacts/result.json`. Proyecto descartable eliminado por el verificador al terminar.
- Imagen anterior conservada: `allnutrition:release-ef825a06fb21`, ID `sha256:ef825a06fb21b82f10d2557475acfbf15321955db11b3322ca4c8fc071b76b34`. Su selección anterior está en `/home/allnutrition/update-20261014-73cfe2a7fde6/rollback.env.release.local`.
- Se compararon esquema, migración y Compose antes del cambio: no variaron. Migración v2 idempotente ejecutada con la imagen nueva; se actualizó solo web, preservando la configuración privada y volúmenes, sin seed ni reset de producción.
- Backup privado PostgreSQL: `backups/production/allnutrition-20261014T152049Z.dump`, 21325 bytes, `0600`, SHA-256 `1bce97fd248ff576f5f7a2e408f8255f77f0162f4d1adc920289d56ca1a0d7d5`; legible mediante `pg_restore --list`.
- Backup privado de imágenes: `backups/production/allnutrition-images-update-20261014-73cfe2a7fde6.tar.gz`, 494838 bytes, `0600`, SHA-256 `d22b79b8ac747536a3d56bc5f88fa6dcc6fdf77cfdf7b21dc913ed000f80687a`; archivo tar verificado. Hash agregado del volumen antes/después: `b3f76f70a7e44cd6a995fcb5ba167fbfcea509c3166d93d2cd3d23baa652bc48`.
- Evidencia sanitizada local: `.test-data/deploy/update-20261014-73cfe2a7fde6/`, con `native-result.json`, `production/result.json`, captura administrativa con datos de cuenta enmascarados y capturas públicas. Env, contraseñas, sesiones y dumps no se copiaron al repositorio.

## Incidencias resueltas antes de publicar

El primer paquete de macOS introdujo metadatos AppleDouble y fue rechazado por sintaxis. Se volvió a empaquetar en formato ustar, sin atributos extendidos ni `._*`; no se relajó el chequeo.

La aceptación nativa detectó un selector E2E ambiguo cuando había dos CTA «Nuevo pedido» y una espera de URL que vencía mientras el login seguía en curso. Se eligió el CTA de la barra del listado y se esperó la respuesta real de autenticación.

También reprodujo una carrera de la UI: una búsqueda diferida podía invalidar la apertura de un pedido al terminar su GET. La apertura ahora aplica la búsqueda pendiente y cancela el temporizador antes de solicitar detalle/dependencias. El recorrido conserva su comprobación de URL/filtro y todas las aserciones de guardado, validación e historial. Solo la aceptación completa posterior se promovió.

Los backups siguen en el disco de la VM: no se configuraron retención, scheduler ni copia cifrada fuera del host. No se acredita CI remoto, auditoría integral de seguridad ni una restauración de la base productiva. Las pruebas de caída y restore se limitaron al proyecto descartable.

# Antecedente — parches locales de dependencias (13 de octubre de 2026)

Corrección del 13 de octubre de 2026 sobre el rediseño ya aceptado. La auditoría inicial de producción identificó dos paquetes con severidad alta; la actualización usa parches compatibles, sin `audit fix --force`, salto a Next 16.4, overrides ni cambios de React.

El runtime original **https://localhost:9443** también quedó actualizado a Next `16.3.8` y `source-map-js 1.2.2`. Solo se recreó web: los recuentos antes/después conservaron **28 pedidos, 16 registros de contenido y 4 cuentas**, sin reset. Se volvió a abrir el pedido AN-000023 por la UI; mantuvo estado Enviado, pago Pagado, cantidad 2, precio 55000 y envío 9000. Evidencia: `security/retained-runtime-patched.png` y `security/result.json` en los artifacts de esta aceptación.

Al terminar se detuvieron el navegador de inspección y el entorno adicional de `19443`, conservando los artifacts y volúmenes de prueba. El runtime original de `9443` permanece disponible con los parches aplicados.

| Dependencia afectada | Antes | Corregida | Referencia |
|---|---|---|---|
| Next.js | 16.3.6 | 16.3.8 | [Release oficial y avisos corregidos](https://github.com/vercel/next.js/releases/tag/v16.3.8) |
| `source-map-js`, transitiva de PostCSS | 1.2.1 | 1.2.2 | [GHSA-68fv-2mgg-jv7q: DoS por offsets de source maps](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) |

Next 16.3.8 conserva el rango peer que admite React/React DOM 19.3.0 y Node 24. Se regeneró `package-lock.json` con npm; `source-map-js` sigue siendo transitiva, dentro del rango ya permitido por PostCSS. El aviso alto de Next corresponde a [SSRF en optimización de imágenes](https://github.com/advisories/GHSA-cjq9-62q9-8jv4); el parche también corrige los demás avisos de Next incluidos por la auditoría.

## Aceptación posterior al parche

| Comprobación ejecutada | Resultado observado |
|---|---|
| `npm audit --json`, árbol local completo | **0 vulnerabilidades conocidas**, incluidas dependencias de desarrollo. |
| `npm audit --omit=dev --json`, dentro del contenedor web | **0 vulnerabilidades conocidas** en la imagen de producción podada. |
| Docker con `npm ci` y build de producción | Next `16.3.8` compiló; instalación y `npm prune --omit=dev` informaron 0 vulnerabilidades. Web, PostgreSQL y proxy saludables. |
| `npm run check`, imagen de checks actualizada | 72 archivos JavaScript/JSX; 0 errores de sintaxis/imports locales. |
| E2E completos después del parche | **16 aprobados, 0 fallidos**, escritorio y móvil Chromium; 20,9 s, una pasada de esta aceptación. |
| Smoke real posterior al build | Acceso autenticado, Inicio con colas vacías reales, listado, editor nativo del producto seed con foco/precio correctos y preview público sin tema administrativo, conservando WhatsApp. |

La nueva aceptación usó el proyecto descartable **`allnutrition-test-security-ad2f1e1e9bc2`**, origen **https://localhost:19443**. Se generó un entorno nuevo y se ejecutó su fixture una sola vez; no se reseteó el proyecto del rediseño. Esta pasada E2E es una aceptación nueva por el cambio de dependencias, no una repetición ni reinterpretación del resultado anterior.

Evidencia local bajo `.test-data/docker/security-ad2f1e1e9bc2/artifacts/`: `security/admin-patched.png`, `security/preview-patched.png`, `test-results/` y `playwright-report/`. No publicar env, sesiones ni el directorio privado completo.

Cero avisos en npm significa que no se detectaron vulnerabilidades **conocidas por el registro consultado**; no constituye una auditoría integral de seguridad. No se verificaron infraestructura remota, producción, CI remoto ni backups en esta corrección. La excepción de CA local del navegador no es una prueba TLS.

# Antecedente — aceptación de Mesa de trabajo (13 de octubre de 2026)

Ejecución local del 13 de octubre de 2026. Rediseño integral del administrador, sin despliegue remoto ni cambios en los contratos del backend. Runtime compilado de Next.js `16.3.6`, Node 24 y PostgreSQL, en el proyecto descartable **`allnutrition-test-admin-ux-e808a109a9c3`**, origen **https://localhost:9443**. El fixture se preparó una sola vez; no se reseteó durante el smoke ni antes de la suite final. El puerto 8443 se identificó como otro proyecto y no se modificó.

## Resultados ejecutados

| Comprobación | Resultado observado |
|---|---|
| Build de producción | Next compiló; contenedores web, PostgreSQL y proxy saludables. Sin servidor dev para la aceptación. |
| `npm run check` | 72 archivos JavaScript/JSX; 0 errores de sintaxis/imports locales. No es un chequeo de tipos. |
| `node --test tests/admin-view.test.mjs` | 11 aprobadas en el paso de navegación: normalización, repetidos, límites, filtros, serialización y rechazo de retornos externos/ambiguos. |
| Suite E2E existente, una sola pasada final | **16 aprobadas, 0 fallidas**, escritorio y móvil Chromium; 19,9 s. Incluye imagen WebP/cuota/ficha pública, producto, pedido e historial, cuentas, privacidad/publicación, cookie segura, CSRF/origen y concurrencia. |
| Superficie real | Inicio y editores inspeccionados a 1440 × 1000, 1024 × 768, 390 × 844 y 320 × 800. Sin desbordamiento horizontal en las superficies capturadas; footers de editores dentro del viewport. El enlace de exportación quedó con 44 px de alto. |
| Ampliación y movimiento | Zoom nativo de Chrome al 200 %: viewport de 1440 × 1000 pasó a 720 × 500; tarjetas y apertura de pedido accesibles. Filtros en flujo normal en ventanas bajas. `prefers-reduced-motion` observado con animación `none` y transición `0s`. |

La suite se ejecutó contra ese mismo runtime y sus datos sintéticos:

```bash
E2E_BASE_URL=https://localhost:9443 E2E_ALLOW_SELF_SIGNED=1 \
PLAYWRIGHT_OUTPUT_DIR=.test-data/docker/admin-ux-e808a109a9c3/artifacts/test-results \
PLAYWRIGHT_HTML_OUTPUT_DIR=.test-data/docker/admin-ux-e808a109a9c3/artifacts/playwright-report \
npm run test:e2e
```

## Smoke funcional observado

- Inicio con los 23 pedidos iniciales: 22 nuevos y uno en preparación, con hasta tres filas por cola y totales del servidor. Búsqueda `Comprador UX`: páginas de 20 + 3; pago `paid` devolvió el pedido 23. Back/Forward, filtros, recarga y respuestas retrasadas conservaron el destino/resultados aceptados.
- Los diez destinos móviles se abrieron desde «Más» en dos pulsaciones, sin scroll lateral. `Ctrl K`/`⌘ K`, búsqueda local sin tildes, vacío del lanzador y Escape ejercitados. El diálogo nativo impidió enfocar controles del fondo y restauró el activador; si quedó oculto al cambiar a móvil, se enfocó el encabezado. Chromium permite pasar del último control a la interfaz del navegador y reentrar con Tab; no se añadió un trap manual.
- Producto: resumen vivo, borrador sin imagen, publicación rechazada sin perder valores y carga local real de PNG 3200 × 1600 a WebP 2400 × 1200. Listado y ficha guardada coincidieron con la respuesta real. Dos pestañas independientes produjeron 409; cancelar la recarga mantuvo el formulario, aceptarla cargó la versión persistida y un GET 404 posterior no sustituyó los valores.
- Pedido 23: despacho sin transportadora/guía rechazado; al completarlas se guardó `sent`, con **119000 = 2 × 55000 + 9000**, actor/fecha e historial. Líneas/envío congelados; abono y pago total siguieron siendo registros manuales separados del despacho. Una referencia propia archivada/renombrada conservó nombre y composición históricos; un evento legacy sin actor mostró «Operador no identificado», sin inventar campos.
- FAQ con GET 503 no bloqueó el resto. Guardado confirmado seguido de lectura fallida mantuvo el registro y un aviso explícito de actualización pendiente; reintentar no repitió POST. Se reprodujo y corrigió el conteo local cero con una fila guardada: tras crear desde una cola vacía y fallar su GET, quedó total 1/fila 1 y una sola escritura.
- Apertura con catálogos pendientes y alta de usuario modificada: se reprodujo la apertura tardía que ocultaba los cambios. Tras corregirla, hubo una sola confirmación; al cancelar, no se abrió editor y se conservaron correo/URL. Guardado retenido de pedido: Escape y Back bloqueados, una sola escritura, total y estado conservados.
- Logout retenido: antes de la corrección producía `beforeunload` después del HTTP 200; después, HTTP 200 y acceso sin ningún prompt. POST de producto sin cookie de sesión: HTTP 401, retorno administrativo normalizado y una sola tentativa; después de entrar no se reabrió ni reenvió el formulario.
- Configuración guardada con versión, grupos completos, ejemplo de WhatsApp solo textual y `launchApproved=false`. Alta real con confirmación inválida/corregida, único rol administrador, visibilidad de contraseña y campos vacíos/ocultos tras éxito. Acceso a 390 × 844 con botón de entrada en el primer viewport y error 401 enfocado.
- Vitrina/ficha pública inspeccionadas en escritorio y móvil: sin `.admin-theme`, fuente Arial y fondo público conservados, enlace WhatsApp al número del fixture y texto con el producto. La búsqueda pública sin coincidencias conserva su tarjeta original, centrada, blanca y con padding `42px 25px`.

## Evidencia y límites

Evidencia local, no publicar la carpeta privada completa:

- `.test-data/docker/admin-ux-e808a109a9c3/artifacts/admin-ux/smoke.json`: observaciones sanitizadas, incluidas reproducciones antes/después.
- `admin-ux/home-{1440,1024,390,320}.png`, `product-*.png`, `order-*.png`, `orders-zoom-200.png`, `order-zoom-200.png` y `public-empty-320.png` en ese directorio de artifacts.
- `test-results/` y `playwright-report/`: capturas y reporte de la única pasada final.

El smoke no es una auditoría WCAG ni una prueba con usuarios reales. Se verificó un viewport reducido a 390 × 400, no un teclado físico. La excepción de CA local del navegador **no acredita TLS**. No se repitieron `verify:docker`, la suite completa Node/contratos de base, restauración/backups, caída de DB ni comprobaciones de infraestructura de septiembre.

**Dependencias en aquella aceptación:** `npm prune --omit=dev` informó **2 vulnerabilidades de severidad alta** durante el build. Entonces se conservaron versiones y lockfile, sin auditoría nueva ni `audit fix`. La corrección y auditorías posteriores de la sección inicial resuelven esos avisos; este párrafo conserva el resultado histórico del rediseño.

# Antecedente — carga local de imágenes (2 de octubre de 2026)

Ejecuciones locales del 2 de octubre de 2026. `npm run verify:docker` se intentó tres veces, sin completar una ejecución con exit 0:

| Intento | Resultado observado |
|---|---|
| 1 | Build aprobó; 126/127 pruebas pasaron. Falló el caso nuevo de limpieza porque el test guardó el archivo en un directorio temporal y el helper buscó en el directorio predeterminado. Se añadió el directorio como opción explícita. |
| 2 | Build, 127/127 pruebas (SQLite y PostgreSQL) y auditoría de producción sin vulnerabilidades aprobados. Playwright terminó 14 casos y falló en escritorio/móvil por un selector de heading ambiguo: la ficha muestra el título como `h1` y otra vez como tarjeta recomendada. La captura real de Chromium muestra la imagen local en la página pública. El selector quedó limitado a `h1`. |
| 3 | Next.js compiló sin la advertencia de trazado dinámico. BuildKit falló al exportar la imagen de checks (`parent snapshot ... does not exist`), antes de ejecutar las pruebas. |

La función de carga, conversión WebP, cuota y referencia compartida pasó sus pruebas unitarias y los contratos PostgreSQL/SQLite en el segundo intento. En ese momento la aceptación E2E quedó pendiente después de corregir el selector. La pasada de 16 E2E indicada arriba incluye ahora el recorrido de imagen local; no implica haber repetido el verificador completo de infraestructura. No se modificó producción ni sus cuentas/datos: cada intento del 2 de octubre usó un proyecto Compose `allnutrition-test-*` descartable, que el verificador eliminó.

# Antecedente — Node 24 y staging Docker (29 de septiembre de 2026)

Ejecución local histórica del 29 de septiembre de 2026. No acredita publicación remota ni una ejecución de GitHub Actions. Los archivos `RESULTADOS_*.txt` anteriores también son registros históricos; lo indicado en esta sección corresponde únicamente a aquella aceptación, no al runtime actual.

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
