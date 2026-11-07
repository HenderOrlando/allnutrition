# Verificación v3 — administración de negocio

## Caja clara y guiada · comprobación local · 7 de noviembre de 2026

- Entorno exclusivo `allnutrition-test-cash-ux-ad7a11ab3646`, PostgreSQL descartable `allnutrition_test`, HTTPS dinámico `https://localhost:61208`, CA y secretos sintéticos propios. No se usaron `.env.staging.local`, producción ni `data/all-nutrition.sqlite`; no se inició scheduler.
- Antes del cambio, reproducción real: un gasto de 1.000 COP heredó la cuenta predeterminada y quedó pagado sin elección; Caja bajó de 120.000 a 119.000 COP. El cierre del 5 de noviembre mostró esos 119.000 actuales en lugar de 100.000 históricos. Seleccionar Banco en Gastos conservó ambas filas porque ese filtro no se aplicaba en el servidor.
- Compilación Next.js 16.4.3 aprobada y runtime reconstruido/recreado después de los cambios. Selección `node --test tests/business-cash.test.mjs tests/business-finance-query.test.mjs tests/business-settlements.test.mjs tests/business-payroll.test.mjs tests/admin-view.test.mjs`: **64 aprobadas, cero fallos/omisiones**. Incluye saldos históricos por cuenta, ausencia de escrituras en preview, validaciones, cambio intermedio antes del guardado, reapertura e identidad de filtros en la URL.
- Pase final sobre la imagen final: **14/14 E2E desktop/mobile**, cero fallos/omisiones, con `caja guiada:|rechazar Atrás|apertura cero|navegación conserva destino|pedido manual:`. Pago pendiente, alternar pago y volver a pendiente, pago explícito, corrección sin duplicado y formulario embebido en Pedidos; preview fuera de orden/error/reintento, comparación autoritativa tras movimiento concurrente; filtros reales, chips, recarga/historial y guía de teclado sin escrituras.
- Primer pase E2E rechazado: 13 aprobadas y un timeout móvil. La traza mostró que `selectWorkspace` consultaba visibilidad antes de montarse la navegación del pedido y esperaba el botón de escritorio. El helper ahora espera la navegación; el cuerpo de la prueba tiene un plazo propio que deja margen para restaurar preferencias con la versión vigente. No se amplió el timeout total ni se cambió la aplicación para ocultar el fallo. El pase corregido y el de la imagen final aprobaron los 14 casos.
- Primera visita manual desde fixture vacío: requisitos visibles para ingreso/traslado/cierre, gasto pendiente disponible sin cuenta, guía opcional operable por teclado sin peticiones de escritura ni dirty state. Responsable creado sin correo/contraseña; Caja y Banco con apertura explícita de 0 COP el 4 de noviembre.
- Jornada real por UI: aporte de 100.000 COP; gasto de 20.000 pendiente sin salida; abono de 5.000 deja disponible 95.000 y pendiente 15.000. Traslado de 30.000 deja Caja 65.000, Banco 30.000 y total 95.000. Ventas de productos conservadas en cero.
- Cierre histórico del 5 de noviembre: esperado 95.000, contado 94.000, faltante 1.000 COP; Caja actual siguió en 65.000. Un ingreso en la fecha cerrada devolvió 409 con instrucción de reapertura. Reabrir con motivo y cerrar contado 95.000 produjo revisión 2 sin diferencia, conservando revisión 1 reabierta y el total.
- Corrección del gasto a 3.000 COP mantuvo el pago de 5.000 y generó crédito de 2.000 sin mover dinero. Recuperar 2.000 por UI agotó el crédito y dejó Caja 67.000, Banco 30.000, total 97.000; el gasto siguió en 3.000. Archivar Banco conservó sus 30.000 en el total, abrió el desplegable de archivadas para su URL y lo excluyó del selector de nuevos ingresos; el detalle bancario no mostró cierres vacíos.
- Teclado real, sin clic ni llenado programático de campos en esas operaciones: ingreso adicional de 1 COP, gasto pendiente de 1 COP y cierre del día contado 67.001 COP, sin diferencia ni ajuste. Importe `12.34` mantuvo el borrador y validación nativa de agrupación inválida; vacío no se convirtió en cero.
- Segundo reset, solo del mismo proyecto, y `createBusinessFixture`: septiembre de 2026. Banco 100.000; recepción de 122.000 brutos menos 17.000 de deducciones dejó 205.000 y pendiente cero, con soportes visibles. Preparar/revisar/confirmar sueldo de 15.500 no cambió Banco; pagarlo dejó 189.500. Otra confirmación fue rechazada como período ya confirmado, sin cambiar los IDs de las 31 obligaciones ni el saldo.
- Persona nueva y convenio mensual de 100.000 COP creados por UI, vigencia del 1 al 30 de septiembre. Anticipo de 20.000 el día 10 dejó Banco 169.500 y todavía cero gastos para esa persona. Revisar/confirmar produjo 100.000 devengados y 80.000 de pago nuevo; pagar 80.000 dejó **89.500 COP**, anticipo aplicado 20.000 y pendiente cero, sin descontarlo dos veces.
- Movimiento vinculado de la liquidación abrió **Revertir documento**, no una reversión de asiento aislado. Cancelar conservó detalle/período y devolvió foco al botón real. La revisión de declaración mostró el nombre de plataforma y omitió el neto de líneas al vaciar el bruto, sin sustituirlo por cero. El borrador de gasto en modo pagar ahora se descartó sin escribir.
- Superficie inspeccionada en Chromium independiente: 1440×900, 390×844 y reflujo a 320 px; documento sin desbordamiento horizontal, texto base de Caja/guía 16 px, ayudas asociadas y controles de al menos 44 px en el pie comprobado. Zoom **nativo al 200 %** mediante la configuración del perfil propio: viewport CSS 720×450, `devicePixelRatio=2.5`, sin desbordamiento y pie del formulario visible; restaurado al 100 %. Cuerpo del formulario con scroll independiente. Capturas de resumen, guía, modos de gasto y comparación de cierre.
- El navegador compartido bloqueó capturas aunque las acciones/lecturas funcionaban; las pruebas visuales se hicieron con un Chrome for Testing independiente y perfil propio. Sus pestañas se cerraron. El único fallo de solicitud recogido al final fue un prefetch RSC abortado durante navegación; no se usa como prueba de una operación financiera fallida.
- Evidencia privada: `.test-data/docker/cash-ux-ad7a11ab3646/artifacts/`, `manual-results.json`, capturas y `acceptance-playwright-report/`. Se retiraron únicamente contenedores, redes y volúmenes de ese proyecto con `compose down --volumes`; no se ejecutó limpieza global. Esta aceptación local no publica cambios, no ejecuta recuperación/despliegue ni acredita CI remoto o integración bancaria.

## Flete / costo de envío publicado · 7 de noviembre de 2026 (Bogotá)

- Aceptación nativa nueva `f545725cad982c64`, código 0: **1258 contratos SQLite/PostgreSQL y 48 E2E desktop/mobile**, cero fallos/omisiones; auditoría productiva sin vulnerabilidades conocidas, HTTPS/CA/hostname, rol limitado, scheduler, caída/reinicio y pg_dump/restore aprobados. Ninguna puerta reutilizada; el primer pase rechazado y sus dos fixtures corregidos se conservan abajo.
- Imagen aceptada y ejecutada por web/scheduler: `allnutrition:release-206306367028`, ID `sha256:2063063670287aeaaf451a9e917d292762c250628fc782272b52afb1307bb135`, Linux/amd64, Node 24.22.2, UID 1000, Next 16.4.3. Fuente sellada de 356 archivos, SHA-256 `7564969f977b983a809c922cd2148df85ecde5ea49a2926de160c1dff9c60f09`; transferencia del mismo ID sin rebuild.
- Respaldo real con 300 pedidos restaurado en PostgreSQL privado: las **56 tablas y el esquema 9 permanecieron exactos**, bundle validado por runtime anterior y nuevo, lectura repetida idempotente y cuatro medios intactos. TLS verificado, DDL limitado rechazado `42501`, conexión sin TLS rechazada `28000`. No se ejecutó migración. Se retiraron únicamente web, DB, red y volumen propios tras la prueba.
- Humo de la imagen compilada sobre ese clon: pedido entregado `AN-000007`, flete de **16.310 a 16.311 COP**, mismo gasto, fuente/corte y fecha desconocida; total, líneas y resumen de cobros del pedido intactos. Siguen 300 gastos, cero pagos/recaudos y una entrada de caja con saldo cero. Se completaron concepto/motivo y revisión explícita; la única corrección guardada fue descartable, nunca productiva.
- El puerto del contenedor en red interna no quedó publicado: el acceso de prueba usó túnel SSH directo a su IP privada. El navegador compartido dejó animaciones pendientes y no produjo capturas válidas; la comprobación visual se completó con un Chrome independiente y perfil propio, sin alterar estilos de la aplicación.
- Corte terminado a las **2026-11-07T09:41:13.126Z / 04:41:13 Bogotá**. Solo dos componentes cliente, un contrato de pruebas y documentación cambiaron; API/modelo/SQL permanecieron iguales. Respaldo consistente en línea antes de recrear web y luego scheduler, sin detener ambos para el dump, sin migración ni reinicio de PostgreSQL y sin reimportar filas.
- Interfaz productiva real: tarjeta del flete original **16.310 COP** y formulario habilitado de corrección en el pedido entregado, escritorio y viewport móvil 390×844 inspeccionados. Importe precargado, fecha vacía, revisión desmarcada y ninguna cuenta de pago. No se guardó ningún gasto productivo. Las **300 guías** se cotejaron nuevamente con el XLSX original, SHA-256 `4a30a5678d9bd3482fa24b85cce2021b92c6899c1dee1ef807bb9d8e840abb93`: cada importe sigue exacto, **5.022.141 COP** en total y las 300 fechas de costo siguen desconocidas.
- Comprobación posterior al scheduler: marcadores 2–9, 300 pedidos/guías/gastos, cero pagos de gastos y recaudos, una entrada de caja y saldo cero; conteos/importes conservados. Heartbeat nuevo vigente y evaluador de alertas sin error. Mismos PostgreSQL, cuatro medios y archivos productivos env/TLS; flags sociales `false`, sin habilitar Meta ni tocar Nginx/DNS/firewall.
- Respaldo final de **10.697.893 bytes**, `0600`, snapshot exportado y catálogo legible; dump, medios, fuentes anteriores y selector tienen copia fuera de la VM verificada por SHA-256. Este dump final no se restauró nuevamente; el ensayo utilizó su propia copia anterior consistente. Rutas, hashes y compatibilidad en [DESPLIEGUE.md](DESPLIEGUE.md).
- Builder/red/volumen de caché propios y tres imágenes descartables retirados; cero recursos de los tres proyectos nativos. Se conservan la imagen nueva y la anterior compatible `f2b3aefc3393`, sin prune global. Clon y túneles retirados; 11 duplicados temporales de credenciales/claves eliminados, env/TLS productivos preservados. Sesión propia identificada por hash antes de cerrar: logout real, API 401, cero filas de esa sesión; perfil, pestañas y archivo temporal eliminados. Opera no fue navegado ni cerrado.
- Evidencia privada: `.test-data/freight-editor-20261107T035940256Z-830d84/`. Esta documentación posterior no cambia la aplicación compilada. No se acredita CI remoto, Supabase alojado ni envío de correo/WhatsApp.

## Flete / costo de envío en el pedido · comprobación local del 7 de noviembre de 2026 (UTC)

- Diagnóstico productivo de solo lectura: las 300 guías tienen exactamente el costo de la columna `Costo de envío` del XLSX original, cotejado por guía, por **5.022.141 COP**. No faltaban gastos: el editor mostraba únicamente el flete cobrado al cliente, cero en este lote, y no exponía los gastos asociados. No se reimportó ni modificó producción durante este diagnóstico.
- El editor ahora muestra y corrige el gasto real desde Acuerdo, incluso con el pedido entregado. Conserva separado el cobro al cliente y reutiliza `expense`, sin cambios de API, modelo ni esquema 9. La corrección usa la versión del gasto y pide motivo/revisión explícita para costos importados; no falsea la confirmación de autoridad.
- `npm run check`: **283 archivos, cero errores**. Humo real Next 16.4.3/Chromium con SQLite privado sintético: costo importado y pagado corregido de 15.000 a 12.000 COP, mismo ID y fuente/corte, pago de 15.000 conservado y crédito de 3.000 sin ingreso ficticio. Se registró/corrigió costo manual faltante, se registró costo de pedido sin guía y se completó una observación importada desconocida mediante revisión explícita. Capturas de escritorio y móvil inspeccionadas.
- Resultado sintético persistido: cuatro pedidos conservan cada total de 55.000 COP; cuatro gastos por 37.000 COP, un pago previo de 15.000, las mismas dos entradas de caja y saldo de 85.000; cero cobros. Las cuatro fechas de gasto siguen desconocidas: no se tomó la fecha comercial ni la fecha actual como gasto/pago. El formulario de costo no ofrece ni precarga una cuenta de pago.
- El primer verificador privado suponía saldos de pago en el DTO bruto de gastos del pedido; se corrigió para leer el detalle financiero que realmente los calcula. No se repitió la mutación ya confirmada. Un helper de espera de cierre se corrigió a la opción `hidden` de Puppeteer; tampoco causó una nueva escritura.
- Evidencia privada: `.test-data/freight-editor-20261107T035940256Z-830d84/`. Estas pruebas locales por sí solas no acreditaban aceptación nativa ni publicación; la comprobación posterior está registrada arriba.

### Primer pase nativo de flete rechazado

- Pase Linux/amd64 `1f304b69d20d90a4`, fuente SHA-256 `3dea83406a6c4c469acb47d93913a075be5b00780aef84f8a108425d5d49d2b1`: build, runtime Node 24.22.2/UID 1000 y check aprobados; **1255 contratos aprobados, 3 fallidos, cero omisiones**. Dos casos concretos PostgreSQL y su suite padre fallaron. No se ejecutaron auditoría/E2E ni se promovió `sha256:2ae795763598dc77ed765ea942418b4cccaad4fbe68b94356c59ee9670d865db`.
- El caso de respuesta perdida suponía `base + 61 s`, aunque el reloj del trabajo añade el tiempo real consumido y persiste su propio vencimiento. Ahora controla `Date` y comprueba el instante previo y exacto del mayor plazo guardado por operación/trabajo, conservando estado incierto, reconciliación por lectura y un único efecto remoto.
- El caso de aislamiento confundía un benchmark de dos segundos con independencia del navegador. Ahora exige contabilidad terminada mientras la promesa del navegador sigue pendiente y su barrera permanece retenida; conserva un watchdog de prueba de 30 s y drena ambas tareas al liberar. No se modificaron código productivo, leases ni los cinco minutos del paso de navegador.
- La suite SQLite afectada pasó después: **37 aprobadas, cero fallos/omisiones**. Este pase dirigido no sustituye la aceptación completa del sucesor ni autoriza su despliegue. Producción permaneció con `allnutrition:release-f2b3aefc3393`.

## Existencias e historial publicados · 6 de noviembre de 2026 (Bogotá)

- Aceptación nativa completa `e03eca971e01b8a4`, código 0: **1258 contratos SQLite/PostgreSQL y 48 E2E desktop/mobile**, cero fallos/omisiones; auditoría productiva sin vulnerabilidades conocidas, TLS/CA/hostname, rol limitado, scheduler, caída/reinicio y pg_dump/restore aprobados. Se reutilizaron únicamente instalación, Chromium y builder privados; ninguna puerta de aceptación. El primer pase rechazado permanece abajo.
- Imagen aprobada y ejecutada por ambos escritores: `allnutrition:release-f2b3aefc3393`, ID `sha256:f2b3aefc3393ea4515337df33ca4229d3f22300931aca488d6eb6418aea71336`, Linux/amd64, Node 24.22.2, UID 1000, Next 16.4.3. Fuente sellada SHA-256 `e3dfb0f9b2acdb005ff7c15d99c62d16686da6b3fb8bc030039b685060d622cc`, 356 archivos; promoción exacta sin rebuild. Esta sección es documentación posterior a la aceptación y no cambia la aplicación compilada.
- Recuperación real v8→v9 e idempotencia comprobadas en PostgreSQL privado sin puertos/consumidores: 56 tablas, filas previas y esquema conservados salvo el CHECK autorizado y las nuevas filas de regla/migración. Bundle validado, cuatro medios intactos, TLS verificado, DDL limitado 42501 y conexión sin TLS 28000. El clon importó las 300 operaciones; su verificación final pasó 27.360 aserciones y luego se retiraron exclusivamente sus recursos.
- Corte terminado **2026-11-07T02:34:56Z / 6 de noviembre 21:34:56 Bogotá**: ambos escritores detenidos para respaldo final y migración 9. Antes de importar se conservaron las 56 tablas con web abierta; tras scheduler solo cambió `job_runs`. PostgreSQL mantuvo contenedor/proceso; env/TLS, medios, Nginx/DNS/firewall y flags sociales permanecieron iguales. Sesión previa válida; Meta API/navegador deshabilitados.
- Lote real `c62c5e3f-462f-4931-b14f-8013fa5b4237`, original SHA-256 `4a30a5678d9bd3482fa24b85cce2021b92c6899c1dee1ef807bb9d8e840abb93`: revisión de 300 válidas y cero rechazos/conflictos/omisiones; confirmación íntegra, revisión aceptada 1, finalizado a las **02:39:53 UTC**. Resultado: **300 pedidos, 300 guías, 329 unidades y 19.321.000 COP**. La comprobación productiva pasó **27.361 aserciones**, cotejando XLSX, destinatarios, referencias, cantidades, precios, fechas comerciales, hechos logísticos e identidades. Los seis conteos físicos siguen desconocidos; reservas/salidas históricas quedan trazadas sin inventar saldos.
- Se registraron los 300 fletes observados como gastos sin simular pagos. Caja de apertura, recaudos recibidos y política global permanecieron exactos. `Seguro` no creó gastos de seguro; los dos convencionales usan su total comercial confirmado. `Fecha` es fecha comercial autorizada, no entrega/cobro inferido. La línea de tres unidades de la fila 284 conserva el total exacto con ajuste de un centavo.
- El verificador privado inicial suponía que las claves generadas de preview eran identidades persistidas y que todas las filas tenían estado. Se corrigió su comparación para distinguir claves explícitas, hechos equivalentes y celdas ausentes; se conservó el rechazo previo. La base preimportación se recuperó desde producción de solo lectura, comprobando igualdad exacta de las 25 tablas pertinentes con el respaldo restaurado. No se repitió la importación del clon ni se alteraron sus hechos para aprobarlo.
- Interfaz productiva: tras recargar mostró **Importación completada**, 300 nuevas, cero excepciones y cero omitidas. La espera inicial al selector tras confirmar por API venció cuando el servidor ya estaba completo; no se repitió el commit. Se verificaron seis productos sin conteo seleccionables en un pedido manual, sin guardarlo: siguen exactamente 300 pedidos. Formulario real de alertas inspeccionado sin editar: habilitado, anticipación inicial de una semana, opciones días/semanas/meses de 30 días y recordatorio independiente de 24 horas. Captura de viewport del formulario y confirmación final inspeccionadas.
- Respaldo final consistente: **675.583 bytes**, `0600`, catálogo legible, SHA-256 `c0b07215435e8763d5b2ec7fcc145f7ec46c985114085997ebcb266877d976a2`; medios de 501.760 bytes, SHA-256 `4ed0f12b2696ccb16d3fa51e4c33c431e90e57606d777acff46ee774ea7d46f1`. Copias fuera de la VM y fuentes anteriores verificadas por hash. Evidencia privada `.test-data/import-history-repair-20261106T204153737Z-f6b299/`; rutas y advertencia de recuperación en [DESPLIEGUE.md](DESPLIEGUE.md). No se acredita CI remoto, correo/WhatsApp ni habilitación de Meta.
- Respaldo posterior con los datos importados: `post-import/production.dump`, 10.648.334 bytes, `0600`, SHA-256 `eded9d88ca1924d73f9a0894da0be1c2f8544ec35f7ffdb7430c1b98be895bc3`; snapshot consistente propio de `pg_dump`, catálogo legible y copia fuera de la VM verificada. La exportación comercial de los 300 pedidos y guías pasó íntegramente el validador, incluida la regla de existencias. No se repitió una restauración de este dump posterior.
- Retirados exclusivamente builder/red/volumen privados, runtime rechazado y checks descartables. Cero recursos de los dos proyectos nativos restantes; imagen aprobada y respaldos conservados, sin prune global ni cambios en la VM productiva.
- Evaluador heredado `scheduler:alerts`: conservaba `ALERT_EVALUATION_INVALID` desde el 5 de noviembre; la causa original no se estableció. Se archivó el registro completo, se ejecutó satisfactoriamente el evaluador vigente y se reencoló únicamente ese trabajo con auditoría, sin afectar indicadores. El demonio lo consumió realmente entre **03:09:57 y 03:10:33 UTC del 7 de noviembre**: 938 evaluadas, cero creadas/actualizadas/resueltas y `stale=false`, sin CLI posterior al reencolado. Los 938 avisos existentes son de otras categorías; ningún `stock_low` trata como cero los seis conteos desconocidos.
- Respaldo final posterior a esa recuperación: `post-alert-recovery/production.dump`, **10.698.029 bytes**, `0600`, SHA-256 `c17a4398cbcf358cf789d71e72bfad3bbe2d446db5e7e729f8c7d54848c134e4`; snapshot propio consistente, catálogo y copia fuera de la VM verificados. La exportación comercial real con 300 pedidos, 300 guías y 938 alertas pasó el validador. No se repitió la restauración física de este dump.
- Comprobación final: continúan 300 pedidos, 300 guías, cero recaudos recibidos, una entrada de caja y cero pagos de gastos. Se retiraron 13 duplicados temporales de credenciales/claves, preservando los archivos productivos. Sesión de reparación identificada por huella antes de cerrar: logout real, API protegida respondió 401, pestaña propia cerrada y archivo de autenticación temporal eliminado. No se navegó ni cerró la ventana Opera del usuario.

## Existencias por producto e importación histórica · comprobación local

- Se reprodujo el rechazo de las 300 filas con productos vinculados. El borrador real se corrigió por API con resoluciones auditadas: `Recaudo` como total comercial; los dos envíos convencionales usan `Seguro`; `Fecha` como fecha comercial autorizada, nunca como entrega o cobro. La política inicial se confirma para este lote sin ampliar su vigencia global. `Seguro` no genera un gasto de seguro ni `Recaudo` un cobro recibido.
- Réplica SQLite con catálogo real sin conteos y el XLSX original: **300 pedidos, 300 envíos, 329 unidades y 19.321.000 COP**; precios/fechas/vínculos comprobados por operación, caja de apertura intacta, cero recaudos recibidos y cero gastos de seguro. Reimportar no duplica operaciones. Esta prueba no aplica filas en producción ni sustituye la aceptación PostgreSQL.
- `npm run check`: 283 archivos JS/JSX sin errores de sintaxis/importación local. Último pase dirigido de inventario, importaciones, restauración y migraciones: **120 aprobadas, cero fallos/omisiones**. El pase anterior se rechazó por dos fixtures incorrectos y una aserción incidental de marcadores; se corrigieron los fixtures, se eliminó esa aserción y se repitieron las cuatro suites afectadas, sin presentarlo como aceptación completa.
- Interfaz real Next/Chromium con SQLite sintético aislado: producto sin conteo aceptado manteniendo cantidades desconocidas; producto con cinco unidades muestra dos salidas y tres restantes; producto con cero rechazado. Apertura de inventario opcional. Alertas reales de cero disponible y cobertura de cinco días; su acción abre el producto correcto. Se guardaron y recargaron anticipaciones de tres días, dos semanas y un mes. Capturas sintéticas inspeccionadas, sesión propia cerrada.
- Evidencia privada: `.test-data/import-history-repair-20261106T204153737Z-f6b299/`. Migración v9 y publicación requieren todavía aceptación nativa completa y recuperación separada del respaldo real. No se acredita despliegue ni importación productiva con estas pruebas locales.

### Primer pase nativo rechazado

- Aceptación Linux/amd64 `055ed38749c21d35`, fuente SHA-256 `701c424e9f578aaa3be76234588a9ebcbb66accf41b54f968883dbbb92bef751`: compilación, runtime Node 24/UID 1000 y check aprobados; **1254 contratos aprobados, 4 fallidos, cero omisiones**. No se ejecutaron auditoría/E2E ni se promovió `sha256:f4f3a4024cbc7db9ff793c7e0ec3f1f2af725a062a2f6f91e40633496149439d`.
- Los dos casos concretos, uno por motor, y sus suites padre fallaron por un fixture nuevo de fechas sin retorno JSON para `runCommand`; no por un rechazo de inventario. Se devolvieron los IDs modificados sin cambiar código de aplicación ni aserciones. La suite completa compartida SQLite pasó después: **95 aprobadas, cero fallos/omisiones**. El sucesor debe repetir la aceptación completa; estos resultados no la sustituyen.
- Respaldo productivo restaurado en PostgreSQL aislado: 56 tablas con contenido exacto, cuatro medios, bundle v8 válido, TLS verificado, DDL runtime rechazado (`42501`) y TCP sin TLS rechazado (`28000`). Se admitieron únicamente tres reagrupaciones exactas de `AND` de `pg_restore`; la tercera, del presupuesto social, conservó los 13 casos de límites/tipos ejercitados. Dump y medios se copiaron fuera de la VM con SHA-256 coincidente. Aún no se migró ni aplicó el archivo en producción.
- El CLI real del scheduler se ejercitó también con datos sintéticos: cero disponible avisó sin fecha inventada; cinco disponibles y treinta unidades pedidas en la ventana dieron cobertura de cinco días. Se conservaron las cantidades semánticas con anticipación guardada de un mes. Servicio, credenciales y base sintética retirados.


## Entrega integral publicada · 6 de noviembre de 2026

- Corte completado a las **12:39:52 UTC / 07:39:52 Bogotá**, con el runtime inmutable descrito en la aceptación siguiente. Web y scheduler ejecutan ese mismo ID; PostgreSQL conserva el contenedor y proceso anteriores. Sólo están activos esos tres servicios; no hay runner ni consumidor de navegador social.
- Recuperación real `allnutrition-recovery-91b7ab6b-r9`: respaldo v7 restaurado en base aislada y migrado con la imagen aceptada. Se conservaron contenido de las 41 tablas heredadas, esquema, marcadores anteriores, hash comercial y medios; validación completa nueva aprobada, TLS verificado, DDL runtime denegado y TCP sin TLS rechazado. La repetición fue idempotente y el clon quedó retirado. La validación rechazada del lector v7 usado sólo para exportar permanece registrada; no se convirtió en aprobación.
- Producción: escritores detenidos antes de la copia final y migración v8; 14 tablas nuevas vacías, 56 tablas totales y marcadores 2–8. Antes de arrancar scheduler se conservaron las 56 tablas; en la comprobación posterior sólo cambió `job_runs`. Los cuatro medios, env/TLS y esquema heredado permanecieron iguales; no se reinició la base.
- Respaldo final privado: dump de 463.683 bytes, modo `0600`, catálogo legible y snapshot exportado; medios y fuentes anteriores conservados por separado. Ubicación y advertencia de recuperación compatible en [DESPLIEGUE.md](DESPLIEGUE.md).
- Humo HTTPS real: salud 200, pedidos anónimos 401 y lecturas autenticadas 200. Los conteos se mantuvieron en cero pedidos y cuatro importaciones; la misma sesión anterior al corte siguió válida. Plantilla descargada con 200/`no-store`, cinco hojas y sólo cabeceras en las cuatro hojas comerciales. CSRF ausente y origen ajeno devolvieron 403 sobre un ID confirmado inexistente, sin usar endpoints de creación.
- Publicidad: listas de campañas, conexiones y piezas 200/vacías; `SOCIAL_PUBLISHING_ENABLED=false` y `SOCIAL_BROWSER_ENABLED=false` en web y scheduler. Runner deshabilitado y consumidor inactivo; no hubo OAuth, publicación ni gasto en Meta.
- Nginx: vhost SHA-256 `789deae90ef1d49e99b82af1b394368a65aa12172d5baf7eed879e152d6ed474`, sintaxis válida y recarga gradual con el mismo master. Configuraciones ajenas sin cambios y otro dominio con 200. Peticiones sólo de cabeceras, declarando 10 MiB + 1 byte: PUT con UUID canónico alcanzó autenticación (401); POST y PUT con ID no canónico fueron rechazados (413), sin enviar cuerpo.
- Interfaz productiva en Chromium privado: escritorio 1440×900 y móvil 390×844. Alta vacía de importación, pasos posteriores bloqueados, archivo sin seleccionar y continuación deshabilitada; lista de Publicidad vacía y conexiones API/navegador deshabilitadas. Sin desbordamiento horizontal móvil ni excepciones JavaScript observadas; se registró un `net::ERR_ABORTED` de prefetch `/?_rsc=…`. No se guardaron orígenes, archivos, vínculos ni campañas. Navegador cerrado; logout de la sesión propia 200, token rechazado con 401 y demás sesiones intactas.
- Dos incidencias del auxiliar operativo, sin cambio de aplicación: una validación manual duplicó el archivo exclusivo que preflight crea; se conservó aparte y preflight ejecutó su propia validación. El primer humo de plantilla lanzó el worker Excel desde HOME, donde no existe; ejecutado desde la fuente sellada completó la lectura y el resto de puertas. Ambos rechazos se conservaron como evidencia, sin omitir comprobaciones ni reconstruir el runtime.
- Cierre a las 13:00 UTC: salud 200, cero reinicios en web/scheduler/BD y heartbeat del scheduler de 28 segundos de antigüedad. Imagen anterior conservada; la sesión de comprobación ya estaba cerrada.
- Limpieza posterior acotada al constructor físico: retirados el builder privado, su red, el volumen de caché que ocupaba 5.729.673.216 bytes y tres imágenes descartables (checks y dos runtimes rechazados). Runtime aprobado, imagen anterior, respaldos y registros conservados; sin prune global ni cambios de recursos en la VM productiva.

## Aceptación del mismo binario · 6 de noviembre de 2026

Aplicación inmutable de `cc372473ee585d3454cb3ec7e65251e56ac09f66`, paquete SHA-256 `485f71bd48cdb57e6b9dd670af21fafd8cfb6fd0150eafeaa1633a9891d340c6`. Runtime aprobado: `allnutrition:release-b39d48b56e34`, ID `sha256:b39d48b56e34f3c3a41259773f4a58aa3da7a7e23a72f534bbe19809a22a8b1f`, Linux/amd64, Node 24.22.2, UID 1000.

| Puerta | Resultado observado | Procedencia |
| --- | --- | --- |
| Contratos SQLite/PostgreSQL | 1.213 aprobados, cero fallos/omisiones; 93,7 minutos | Pase íntegro `7b6ccf12771710e0`, reutilizado con autorización expresa |
| E2E escritorio/móvil | 48 aprobados; 20,2 minutos | Pase completo nuevo `61489437b66cba89` |
| Sintaxis/imports y auditoría de producción | 283 archivos sin errores; cero vulnerabilidades conocidas | Ejecutados de nuevo en la continuación |
| Scheduler, idempotencia, TLS, caída, reinicio y dump/restore | Todas las puertas aprobadas | Ejecutadas de nuevo en el proyecto descartable |
| Cierre del proyecto descartable | Cero contenedores, volúmenes y redes propios | `cleanup.json` de la continuación |

El primer pase completo conservó el resultado contractual, pero rechazó tres E2E: dos expectativas del título antiguo de importaciones y un selector ambiguo entre dos acciones de alta válidas. Se eliminaron las aserciones de redacción incidental y se abrió el alta por su URL explícita; no se omitieron escenarios ni se modificó el código de aplicación.

La continuación mantuvo los IDs exactos de runtime/checks y su mismo `BUILD_ID` (`V6OgD72RobcYV8Si3SzCV`), sin reconstruir. El arnés separado modifica únicamente `tests/e2e/app.spec.mjs`, SHA-256 `e48beb14b6d27e8deeb80db6215511d114ff48bc3a8df6aa60644493d783afc7`. `acceptance.json` conserva los hashes del resultado y registro anteriores, declara `reusedGates` y distingue esas pruebas de las recién ejecutadas. No se presenta como una repetición contractual nueva.

Esta aprobación se utilizó para el corte y recuperación comprobados arriba. Distingue las puertas reutilizadas de las recién ejecutadas; no acredita una ejecución de CI remoto ni habilita Meta.

## Reanudación de la entrega integral · 6 de noviembre de 2026

- Se retomó el HEAD publicado `4658dfb` en un constructor físico Linux/amd64 con Node 24 privado, usuario no root y acceso Docker acotado al proceso; no se reemplazó el Node global ni se copiaron credenciales productivas.
- El candidato `release-all-adjustments-20261106T020425Z-91b7ab6b-r6`, paquete SHA-256 `2b4e733c9b43b3644fe111317453201314a687e45042ece9747c12a6f3fac74a`, se interrumpió después de preparar fuentes y validar Compose: una revisión detectó que el verificador seguía exigiendo únicamente `backend`, aunque Compose conecta el scheduler a `backend` y `social_egress`. No se promovió; su proyecto `allnutrition-test-6616d46a019e2327` quedó sin contenedores, volúmenes ni redes.
- Reproducción con Docker real: imagen runtime conservada, usuario `node`, ningún puerto y las dos redes previstas. La guarda anterior rechazó el contenedor; la corregida lo aceptó y rechazó una tercera red real no prevista. Se conservaron las otras condiciones y se retiraron contenedor/redes del humo. La suite completa y la recuperación de copia real siguen siendo puertas obligatorias del sucesor.
- El primer pase de `f283916`, paquete `13f78e2003714e08b0de27a6d23fa89a742976b7707b68b503b6d1e09c4fe678`, se rechazó al no resolver Debian desde la red del constructor predeterminado. Una red Docker propia resolvió DNS y respondió HTTPS 200. Se seleccionó un BuildKit dedicado, sin cambiar el firewall global, el Node global ni el código de los contratos.
- Con ese constructor se completaron runtime y checks; el runtime observado fue Node `24.22.2`, UID 1000, sin Chromium/devDependencies. El proyecto `allnutrition-test-0f67d6c947962b28` se rechazó antes de ejecutar `npm run check`: `runc 1.5.1`/`libpathrs 0.2.5` sufrió SIGSEGV en `pathrs_reopen` con el perfil restringido. Su limpieza dejó cero contenedores, volúmenes y redes propios.
- Diagnóstico sin datos de negocio ni red: añadir sólo `openat2` o sólo `close_range` no resolvió ese arranque; sólo `faccessat2` permitió `/bin/true`. El perfil mínimo más el fallback `clone3`→`ENOSYS` permitió Node, un hilo e interacción real en Chromium con sandbox, UID 1000, capacidades nulas, raíz de solo lectura y `no-new-privileges`. El sucesor mantiene todas las etapas de aceptación y no se publica por este humo.
- Candidato `07e2c8b`, paquete `f3ee8645aa10d0a027d85e250a6e0a4d067b92e2b2403f83cf1408f2019ad621`, aceptación `8ba4f8bf5a6f45ee`: build, identidad runtime y sintaxis/imports completados. Los contratos SQLite/PostgreSQL agotaron 45 minutos agregados: el registro contiene 576 líneas de casos aprobados, sin fallos registrados antes del corte, pero ningún resumen final. Los contratos seriales observados tardaron hasta 53 segundos por caso; no se acreditan los pendientes ni se ejecutaron auditoría/E2E. El proyecto quedó sin recursos propios. Se amplía únicamente ese plazo agregado a tres horas, manteniendo límites SQL, todos los contratos y PostgreSQL durable.

## Preparación de entrega integral · 5 de noviembre de 2026

- Se consolidaron primero los ajustes ya publicados de v7 y después publicidad, medios, API, análisis, panel e importaciones en commits temáticos. Libros reales, copia local de entorno, archivo de macOS y contexto local no versionado quedaron fuera del código y del paquete.
- Candidato inicial, fuente `207f6f4`, paquete SHA-256 `c872aacf39d815cce93939ea97656a92684b906d5a6042054499bf56eefcd8e0`: aceptación `45850fa44448a7db` rechazada por el límite de construcción de diez minutos durante dpkg, antes de las pruebas.
- Sucesor de fuente `75faf0f`, paquete `ee5bce3c94c35f6ad1fe8ea239e595c1ee01271ba5402750b082eaa31c385574`: build Linux/amd64 completado, runtime Node `24.22.2`/UID 1000 sin Chromium ni herramientas de desarrollo. No se promovió `sha256:d724148e81c10e23b27517678d459c042626185ed7188697f43471fe0a2b85e2`: el healthcheck por socket pasó durante la inicialización temporal y la migración recibió «the database system is starting up». Se cambia la señal a TCP, sin repetir DDL automáticamente.
- Respaldo real restaurado en el clon interno `allnutrition-recovery-91b7ab6b-r2`: las 42 tablas conservaron contenido y esquema, salvo las dos normalizaciones de paréntesis de pg_restore ya documentadas. El lector v7 rechazó una resolución `accept_formulas` con hoja y sin fila, admitida por el importador; se inspeccionaron únicamente tipos/conteos de alcance para diagnosticarla. El clon se retiró conservando respaldo y evidencia; imagen y escritores anteriores continuaron activos y no se migró ni restauró la base productiva. La sesión propia de comprobación se registra por separado.
- La regresión permanente del libro falló antes con el mismo error de fila y pasó después junto con sus otros contratos: **43 aprobados, cero fallos/omisiones** en SQLite. La restauración conserva autorización en una hoja y bloqueo en la otra, también la evidencia aceptada; referencias de fila inválidas y fórmulas sin caché siguen rechazadas. La imagen sucesora aún requiere aceptación nativa completa y validación del respaldo con el validador corregido.
- Tercer candidato, fuente `df5e184`, paquete `2f67e8fb0a7157c672e68c56dc130d54d7f30732c91c7df50b220331ff34d751`, aceptación `88b86388435919a6`: Next compiló correctamente, pero se rechazó de nuevo antes de las pruebas al agotar treinta minutos en dpkg. Los 134 MB de paquetes se descargaron en un segundo; el coste observado fue su instalación, no la descarga. El Dockerfile anterior reinstalaba las herramientas de checks tras cada cambio de fuentes. Se separan las capas, se comparte FFmpeg y se amplía sólo el plazo de construcción fría; no se acredita todavía el sucesor.
- Preparación del clon `allnutrition-recovery-91b7ab6b-r3` completada: 42 tablas y marcadores 2–7 preservados, TLS 1.3, rol limitado sin DDL (`42501`) y acceso sin TLS rechazado (`28000`). El lector antiguo se usó explícitamente sólo para exportar y obtener el hash comercial: su validación conocida está rechazada, no aprobada. La imagen nueva deberá validar íntegramente ese respaldo, conservar el hash heredado y superar la migración/idempotencia antes de publicar.
- Cuarto candidato, fuente `d6dec7b`, paquete `4482d2c32b9071069a091e790f11d12872ffc70d2a8eb3df649cc2bc8ac21bd1`, aceptación `416fd89047ebc284`: construcción nativa completada, runtime Linux/amd64 Node `24.22.2`/UID 1000 sin Chromium/herramientas de desarrollo y `npm run check` aprobado. La suite terminó **900 aprobados y 312 fallidos**, sin omisiones; el primer contrato PostgreSQL dejó v8 sin marcador tras el ensayo de rollback y los siguientes rechazaron arrancar. La imagen `sha256:f8c525c450cdc0417ccd3cf00b7b0278edd7b6874ce370b5ff1ecce0d5ff8055` quedó rechazada; no se ejecutaron todavía auditoría ni E2E de ese candidato.
- Diagnóstico separado en PostgreSQL sintético: el primer arranque también encontró `Query read timeout`. Con la preparación corregida, el adaptador original devolvió esa excepción tras 15062 ms, reutilizó el mismo backend y una segunda transacción confirmó las filas 1 y 2. No eran datos de producción. Corregido, tras 15063 ms se descartó el backend y sólo persistió la fila 2; un snapshot con rollback agotado también se descartó y permitió una escritura posterior correcta.
- El humo de las fuentes corregidas se ejecutó como módulos de sólo lectura sobre la imagen rechazada, no como aceptación de un release: fallo sintético del marcador v8 revirtió las 14 tablas y la función, las 41 tablas comerciales anteriores conservaron su hash, la migración completa y su repetición fueron correctas. Los proyectos de diagnóstico quedaron sin contenedores, volúmenes ni redes. El contrato permanente conserva el rechazo del marcador exacto y comprueba todos los objetos; otra regresión exige que la siguiente transacción no confirme una escritura rechazada. No se fijan mensajes ni texto SQL de categorías ya comprobadas mediante operaciones reales.
- `node --test tests/business-migration.test.mjs`: **22 aprobados, cero fallos/omisiones** tras la corrección. El sucesor aún debe completar de nuevo la aceptación nativa íntegra y la recuperación del respaldo real antes de actualizar producción; ninguno de los ensayos sintéticos sustituye esas puertas.
- Quinto candidato, fuente `2c5a934`, paquete `0a1a5fd8a96f7842983500c037e20e2d93999c03ba68fbd50cfd352e86d07515`, aceptación `6943a211596c4545`: las regresiones permanentes de conexión tras rollback incierto y atomicidad v8 pasaron dentro de los contratos PostgreSQL reales. El pase completo agotó sus 45 minutos agregados mientras seguían aprobándose casos; no produjo un resultado final de suite ni ejecutó auditoría/E2E. Se rechaza `sha256:93b206e09d5c4720a9b4757cf0e7d854180977d0f300960755362fc62a744db8`. La etiqueta base de Node cambió de digest y produjo otra construcción fría; no se atribuye ese coste a una caché de fuentes invalidada.
- La limpieza de ese pase dejó dos redes vacías después de terminar el one-off. Se comprobaron sus labels/IDs y la ausencia de endpoints, contenedores y volúmenes antes de retirarlas; cero recursos propios restantes y ningún prune global. El sucesor comprueba explícitamente el cierre de todos sus recursos, también al cancelar un comando.
- Incidencia observada antes del corte: el scheduler v7 conservó contenedor e imagen anteriores, pero acumuló tres reinicios; el log del 5 de noviembre a las 07:09 UTC registró `SCHEDULER_ERROR`. La evaluación de alertas quedó `failed / ALERT_EVALUATION_INVALID`, mientras el heartbeat volvió a avanzar. Estas evidencias sanitizadas no identifican la causa original: no se atribuye automáticamente a timeout ni memoria. Web y PostgreSQL conservaron sus procesos originales; no se reintentó ni borró el trabajo fallido.
- La guarda estricta rechazó inicialmente retirar el cuarto clon por ese cambio de uptime. Su retiro posterior tomó una base operativa explícita, conservó la observación anterior, exigió los mismos contenedores/imágenes, web/BD sin reinicio y ningún cambio de servicios/entorno/TLS/medios durante la operación. Se preservaron las 42 tablas de la copia y los respaldos antes de eliminar exclusivamente sus recursos. Esta operación no aprobó el candidato ni relajó las guardas de recuperación/publicación del sucesor.
- La siguiente aceptación se prepara en el host físico Linux/amd64, en directorio y proyecto descartables, sin credenciales productivas y con Node 24 privado; su Node global es 26.4.0. No se instalan paquetes globales, no se altera Nginx y no se desactiva la durabilidad de PostgreSQL. La suite íntegra y la recuperación real continúan pendientes; los resultados parciales anteriores no sustituyen esa aprobación.
- Comprobación previa del dominio real: salud 200, anónimo 401, sesión propia segura y lecturas autenticadas 200; cero pedidos y cuatro importaciones. No se aplicaron archivos ni se cambiaron credenciales. Nginx coincide con la base publicada y otro dominio respondió 200. Estos resultados previos no acreditan todavía el nuevo corte ni habilitan Meta.

## Publicidad: conexiones, piezas privadas y operación API/navegador · ensayo local del 2–3 de noviembre de 2026

- Migración v7→v8, respaldo/restauración y custodia: comando dirigido SQLite con **41 pruebas aprobadas**, cero fallos/omisiones. El humo inicial abrió una SQLite nueva, migró v8, cifró/leyó credenciales, exportó sin secretos y conservó `business_revision=0`. Las ejecuciones integradas vigentes, incluidos contratos de aprobación, figuran abajo.
- Cliente Meta, OAuth y controles: último comando integrado `node --test tests/social-browser.test.mjs tests/social.test.mjs tests/social-oauth.test.mjs tests/social-meta.test.mjs`: **56 aprobadas**, cero fallos/omisiones. Los contratos de exclusión/custodia se ejecutaron también por separado en PostgreSQL real: **17 aprobados**, cero omisiones. Se reprodujo primero el error que sustituía `OPERATION_UNCERTAIN` por `LEASE_LOST` tras enviar y se conservó su regresión corregida.
- Puente OAuth ejercitado con aplicación `http://localhost:3310` y proveedor `http://127.0.0.1:3321`, sitios distintos: navegación inicial sin cookie Strict, GET/POST de finalización autenticados desde el documento puente, recursos seleccionados verificados y replay 403. Sin CSRF, inicio 403. URL retirada, sin OAuth en localStorage y sin código/tokens en logs observados.
- Humo de dominio con Chromium real y transporte firmado, sin `META_APP_*`: login asistido, sesión cifrada, cierre/reinicio del runner y consulta sin volver a introducir contraseña. Expirar la cookie remota dejó `reconnect_required`; cero publicaciones/activaciones, credenciales excluidas y revisión contable cero. Ningún archivo de estado o frame de login se persistió.
- `docker compose --profile social-browser build social-browser` aprobado en Linux/arm64. Proyecto descartable saludable con UID `1000:1000`, raíz de solo lectura, `CapDrop=ALL`, `NoNewPrivs=1`, seccomp activo, 512 MiB de shm y límite 2 GiB; sin puertos publicados, CDP público, claves API/BD/sesión ni volumen de medios escribible. El humo firmado dentro de ese aislamiento completó login y JPEG en memoria; un redirect al servidor privado produjo **cero solicitudes** a ese servidor. Recursos Compose propios retirados.
- Fallos detectados y corregidos antes de acreditar el runner: etiquetas nativas de selects con opciones, raíz canónica de `/var` en macOS, comprobación obsoleta de identidad y redirect que Playwright no interceptaba tras el primer salto. El guard privado Chromium Fetch comprueba cada salto antes de conectar; se mantiene el bloqueo de popups/orígenes ajenos. La copia para `setInputFiles` se hace por streaming a tmpfs privado y se elimina, sin Buffer completo de video ni cambio de archivo después del hash.
- El primer arranque Linux falló en `sys_chroot` al eliminar todas las capacidades: el perfil oficial condicionaba ese syscall a una capacidad del contenedor exterior. Se permitió el syscall para que el sandbox lo use dentro de su namespace no privilegiado; **no** se añadieron capacidades, privilegios ni `--no-sandbox`. El arranque y el humo posteriores aprobaron con las restricciones anteriores.
- Consumidor navegador, CLI, leases e integración Chromium: `node --test tests/social-browser.test.mjs tests/social-browser-jobs.test.mjs tests/business-jobs-cli.test.mjs tests/business-job-leases.test.mjs tests/business-jobs.test.mjs`, **53 aprobadas**, cero fallos/omisiones. Ambos modos `--once` se ejecutaron además como programa real y mantuvieron sus heartbeats separados.
- Humo integrado worker → RPC firmado → Chromium, con proveedor sintético independiente: cerrar/reiniciar el runner tras el login, consumir una intención durable, subir JPEG y confirmar una publicación nativa. La segunda vuelta no publicó otra vez, `hasMore=false` y `business_revision=0`. Un permalink visible se valida como evidencia HTTPS de Meta sin conceder navegación externa a la fixture; un host impostor se rechaza. No hubo llamada ni publicación en Meta real.
- Medios, firmas, recuperación y migraciones: `node --test tests/social-media.test.mjs tests/social-media-backup.test.mjs tests/social-media-http.test.mjs tests/backup-restore.test.mjs tests/business-migration.test.mjs`, **67 aprobadas**, cero fallos/omisiones. El contrato dirigido de medios también aprobó **17 pruebas** con PostgreSQL TLS real.
- Build arm64 de aplicación y checks aprobado. Runtime observado con UID 1000, directorio privado `0700`, FFmpeg/ffprobe **5.1.9**, sin Chromium instalado en la imagen de aplicación. La suite nativa de navegador/worker/medios aprobó **62 pruebas** en checks con sandbox, capacidades eliminadas y seccomp; las regresiones actuales de medios/custodia aprobaron otras **31** con fuente montada de solo lectura sobre ese toolchain, sin red. No se suman estas suites solapadas ni se acredita un release final.
- HTTP real Next: registro 201, carga raw 202 y rechazo sin CSRF 403 para JPEG orientado, PNG transparente, MOV con audio y una imagen incompatible. Sharp/FFmpeg prepararon los tres válidos; la pieza incompatible conservó su original con diagnóstico, sin derivado publicable. Chromium abrió el JPEG de 800×1000 y el video de 540×960, duración 3 s, sin error de reproducción observado; captura de preview inspeccionada.
- Enlace firmado local: GET parcial 206 con bytes exactos, HEAD 200 sin cuerpo; firma adulterada, vencimiento, variante original y query adicional devolvieron 404. Preview privado anónimo 401 y método no admitido 405. El registro observado no contenía firmas ni el canario EXIF. Este ensayo no acredita descarga HTTPS desde Meta.
- Copia/restauración ejecutable con escritores sintéticos detenidos: **7 archivos, 2319662 bytes**, JSON comercial y copia SQLite física en destinos nuevos. Antes del volumen había cuatro piezas bloqueadas; la verificación recuperó tres listas y mantuvo el original incompatible fallido. El reset físico eliminó la custodia cifrada browser de prueba, exigió reconexión y conservó la revisión contable en 32. No se acreditó una sesión real de Meta mediante ese canario.
- Regresiones reproducidas antes de corregir: diagnóstico multimedia legítimo tratado como código OAuth privado; alias del volumen que ocultaba una copia anidada; fences de carga/procesamiento presentes en respaldo y detalle de campaña. Ahora se admiten sólo diagnósticos públicos registrados, se comparan raíces canónicas y los tokens operativos se excluyen sin invalidar el trabajo vivo. El humo independiente confirmó exportación durante una carga y lease activos, recuperación posterior y DTO sin el token.
- `nginx -t` aprobó el vhost original. Humo HTTPS con upstream sintético aislado: PUT de 11 MiB recibió íntegros 11534336 bytes, URI y headers preservados; GET/POST en esa URL, otra carga y un ID inválido conservaron el rechazo de 10 MiB. PUT declarado de 251 MiB devolvió 413; acceso directo a la URI interna, 404. Proxy, upstream y red descartables retirados.

### Preparación y aprobación inmutable

Suites solapadas; no sumar sus resultados:

| Ejecución | Pruebas aprobadas | Fallos | Omisiones |
|---|---:|---:|---:|
| `node --test tests/social*.test.mjs tests/backup-restore.test.mjs tests/business-migration.test.mjs`, SQLite y Chromium nativo | 197 | 0 | 0 |
| `npm run test:postgres`, PostgreSQL 16 `allnutrition_test`, TLS/CA y reset autorizado | 195 | 0 | 0 |
| Spec/campañas con fuente actual montada de solo lectura en checks Linux, UID 1000, sin red, sandbox/seccomp | 36 | 0 | 0 |

- API Next ejercitada desde sesión administrativa real del ensayo: creación/replay 201 con el mismo ID, PATCH 200, edición obsoleta 409, método contradictorio 400, duplicación 201 y filtros exactos 200. Sin CSRF 403; JSON null, página repetida y red excluida 400. Preparar con el flag deshabilitado devolvió 409 y no creó revisiones ni entregas. El tab fue cerrado; no se acredita todavía el editor de Publicidad.
- Programa independiente sobre esa misma SQLite y derivado real: derechos no aceptados bloquearon la transición; aprobación exacta COP 50000 produjo una revisión y una sola entrega `meta_ads` todavía en cola, no `ready` ni activa. Replay no hizo nuevas lecturas al proveedor; edición posterior 409; duplicado sin fechas/aceptación/previsión. Dos entregas orgánicas futuras se aprobaron y cancelaron localmente, revocando sus jobs sin perder la revisión.
- El respaldo comercial de ese estado volvió a validar sin credenciales/fences. `business_revision` permaneció en 32 y las filas de pedidos/gastos comparadas no cambiaron. El proveedor local recibió **cero escrituras Meta**. Para aislar la aprobación se insertaron forecasts de prueba `insufficient`, sin rangos ni muestras: este humo **no acredita el generador de estimaciones**, que se implementa por separado.
- Regresiones reproducidas y corregidas: acción del body rechazada por el adaptador HTTP; hash de una fila SQLite sin prototipo que impedía aprobar; duplicación que reinterpretaba un importe COP al seleccionar cuenta USD; prohibición excesiva de comercio alimentario general; enum Facebook Reels y límites de radios incorrectos. Se mantienen las pruebas de consentimiento, carreras, contexto, dinero, segmentación y versiones; no se relajó `canonicalJSON` global.
- Referencias primarias consultadas: [ubicaciones por red](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/placement-targeting), [radios y presencia geográfica](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/basic-targeting) y [desactivación de ampliación geográfica](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/advanced-targeting). El spec usa `facebook_reels` frente a `reels` de Instagram, radios de ciudad 17–80 km/10–50 mi, presencia `home/recent` explícita y solicitud de ampliación geográfica desactivada para regiones/ciudades. La activación posterior deberá comprobar los valores efectivos de Meta.

### Publicación API, agenda y resolución durable

Suites solapadas; no sumar sus resultados:

| Ejecución | Pruebas aprobadas | Fallos | Omisiones |
|---|---:|---:|---:|
| `node --test tests/social*.test.mjs tests/backup-restore.test.mjs tests/business-migration.test.mjs tests/business-jobs.test.mjs tests/business-jobs-cli.test.mjs` | 259 | 0 | 0 |
| `npm run test:postgres`, PostgreSQL 16 descartable con TLS/CA | 222 | 0 | 0 |
| Adaptador/consumidor API, campañas, spec y permalinks en checks Linux, fuente actual de solo lectura, UID 1000, sin red externa/capacidades | 92 | 0 | 0 |

- Siete ejecuciones reales de `node scripts/business-jobs.mjs --once` terminaron con código 0 contra el servidor HTTP sintético con objetos/uploads propios. Prepararon una sola campaña, conjunto, creativo y anuncio PAUSED; activar y dos ciclos de pausa/reanudación conservaron COP 50000 totales y el fin original. El inicio futuro quedó `scheduled`, no entregando ficticiamente. Cada control/replay mantuvo una operación y los hijos se activaron antes de la campaña.
- El comando normal también materializó **30 obligaciones salariales** del acuerdo sintético preexistente `salary-september`; la revisión comercial pasó de 32 a 62. La primera aserción del controlador de humo asumía incorrectamente que todo el worker era social y falló después de completar los controles. No se ocultó ni revirtió ese resultado: el ensayo posterior aisló `processSocialTurn` y comparó pedidos, gastos, pagos, caja, cobros y revisión 62 antes/después, sin cambios.
- Respuesta IG perdida después del efecto: el journal quedó incierto. Vincular el ID con cuenta/pieza/texto verificados sólo hizo lecturas y mantuvo la incertidumbre hasta que el worker inspeccionó; terminó publicado con un único objeto. Una desconexión sintética antes de llegar al proveedor exigió confirmación explícita de ausencia/riesgo; se registró al nuevo ejecutor y se publicó una sola vez. No se acredita exactly-once.
- Recuperación ejercitada con aprobador histórico deshabilitado y consentimiento de otro administrador: revisión original intacta, presupuesto restante explícito y cero activaciones al liberar el hold. Las regresiones permanentes prueban también la posterior activación expresamente autorizada por el actor nuevo.
- HTTP autenticado real: detalle 200 con estados confirmados; pausa/replay 202 idénticos mientras el flag de publicación seguía deshabilitado. El consumidor confirmó después `paused`, con revisión comercial 62 intacta. Reanudar con ese flag devolvió 409; sin CSRF, 403. Se cerró el tab.
- Contratos cubren agenda futura sin giro, atraso de más de 15 minutos, fence perdido antes/después del envío, éxitos parciales sin republicar otra red, cooldown compartido por cuenta, Retry-After, agotamiento de backoff, token 190, rechazo de revisión, presupuesto externo y reanudación por offsets confirmados. Un chunk pagado ambiguo sin cursor documentado permanece incierto, sin reenviarse.
- Regresiones reproducidas antes del arreglo: gasto limitado solicitado en ubicaciones excluidas, cierre del FD durante cargas sucesivas y nombre mutable de una imagen deduplicada tratado como identidad. Se exige `placement_soft_opt_out={}` y targeting efectivo sin expansión; los streams conservan el descriptor del caller; el hash conocido se verifica en la cuenta propietaria sin depender del nombre compartido.
- Protocolos fundamentados en documentación oficial: [carga pagada `advideos`](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/advideos), [publicación Instagram](https://developers.facebook.com/documentation/instagram-platform/content-publishing), [mejoras creativas individuales](https://developers.facebook.com/documentation/ads-commerce/marketing-api/creative/advantage-creative/get-started) y [gasto limitado por ubicación](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/placement-targeting). No se usa `video_ads`, cuyo formato documentado no corresponde al derivado normalizado.
- La declaración IA no se descarta: pauta e imagen FB con IA declarada se bloquean cuando no existe un campo oficial acreditado para aplicar esa etiqueta; imagen IG y Reels usan sus campos documentados. No se inventa una divulgación política como sustituto.
- Límites: las previsiones de aprobación de este humo eran fixtures explícitas `insufficient`, no el generador de la etapa siguiente. La fixture IG aceptó la URL HTTPS sintética pero no descargó sus bytes; sigue pendiente la descarga desde Meta sobre un origen público HTTPS. No se acreditan DOM actual de Meta, métricas, editor final, release sellado ni permisos reales mediante este pase.

### Preflight, publicación y controles nativos independientes

Suites solapadas; no sumar sus resultados:

| Ejecución | Pruebas aprobadas | Fallos | Omisiones |
|---|---:|---:|---:|
| `node --test tests/social*.test.mjs tests/backup-restore.test.mjs tests/business-migration.test.mjs tests/business-jobs.test.mjs tests/business-jobs-cli.test.mjs`, SQLite y Chromium real | 273 | 0 | 0 |
| `npm run test:postgres`, PostgreSQL 16 descartable con TLS/CA, incluidos contratos del consumidor nativo | 261 | 0 | 0 |
| Consumidores API/navegador, campañas, spec, evidencia y publicación API en checks Linux con fuente de solo lectura, UID 1000, sin red/capacidades | 133 | 0 | 0 |

- Programa desechable ejecutado contra SQLite nueva, transporte HTTP firmado y Chromium con proveedor DOM independiente, sin `META_APP_ID/SECRET`: preparar propuesta incompleta con consentimiento, buscar una ciudad con publicación deshabilitada, seleccionar jerarquía/radio de 25 km, subir el JPEG privado real, validar y adoptar el mismo borrador. Una sola campaña privada, referencias reales del conjunto/creativo/anuncio de la fixture y estado `ready` sin gasto antes de activar.
- El dominio público confirmó una activación y dos ciclos de pausa/reanudación, conservando COP 50000 totales y el fin original. La primera pausa se comprobó sin presupuesto, IDs de componentes ni indicador de activación anterior visibles; exportar/cifrar la sesión siguió funcionando. Las regresiones cubren además Page/IG, pieza, revisión, forecast, hold y flags ausentes sin convertirlos en requisitos para detener gasto.
- El borrado con «pausar y desconectar» devolvió primero pendiente y `remoteSpendStopped:false`, conservó custodia y esperó al consumidor. Sólo después de la tercera pausa confirmada eliminó los datos de esa conexión y produjo el recibo con gasto detenido; conservó la pieza. El fingerprint de hechos comerciales anterior/posterior fue idéntico. Cambiar las cantidades de evidencia mientras espera exige consentimiento nuevo antes de borrar.
- HTTP Next real con cookie administrativa: campaña 201, preflight de cuenta sin capacidad 409, falta de CSRF 403, operación confirmada 200 y lectura anónima 401; revisión comercial 62 intacta. No se acredita el editor ni un preflight HTTP 202 mediante este ensayo.
- Regresiones encontradas por el humo real: lectura de `ready` sin una operación explícita, inspección previa de activación confundida con reconciliación de un envío incierto, y exportación de pausa que perdía las identidades ya verificadas. Se distingue preparación no enviada de activación ambigua y se conserva el contexto mínimo de cuenta durante el CAS de cookies.
- Se corrigieron también el rechazo no observado de una promesa de cancelación sin petición activa y la replanificación inmediata de una sesión ocupada. La espera quedó en el deadline durable de operación/sync; una pausa API puede intentar validar acceso en `reconnect_required` sin exigir que Page/IG se recuperen antes. Los tests de Retry-After no cruzan accidentalmente su límite por avanzar el reloj del fixture.
- Una navegación de formulario con socket perdido antes del nombre UUID produjo dos borradores sin marcador en Chromium, pese a un único clic de aplicación. No se promete exactly-once: la inspección queda incierta y no crea otro; vincular uno sin nombre exige ID/cuenta y aceptación humana explícitos, y un nombre ajeno no se adopta. El journal conserva la ambigüedad hasta inspección.
- La versión activa es `meta-ui-v2`; geografía nativa estructurada, radios, bienvenida WhatsApp, formato real, mejoras/IA/recorte/ubicaciones y hash del medio forman parte de las guardas. Restaurar un borrador no aprobado exige consentimiento actual y retira trabajos viejos sin prepararlo ni publicarlo automáticamente. Las previsiones de este humo fueron fixtures explícitas `insufficient`, no el generador todavía pendiente.

### Métricas canónicas, exportaciones y ciclos de consulta

Suites solapadas; no sumar sus resultados:

| Ejecución | Pruebas aprobadas | Fallos | Omisiones |
|---|---:|---:|---:|
| Contratos sociales completos, backup, migración y workers en Node, SQLite y Chromium | 322 | 0 | 0 |
| `npm run test:postgres`, PostgreSQL 16 descartable con TLS/CA, incluido el límite manual de consulta | 273 | 0 | 0 |
| Modelo, métricas, consumidores y backup en checks Linux: fuente readonly, UID 1000, sin red/capacidades | 121 | 0 | 0 |
| Lector Excel e incorporación de libros existentes tras ampliar únicamente el límite explícito del export social | 75 | 0 | 0 |

- Programa desechable real: SQLite nueva, API HTTP con estado propio y transporte de navegador firmado con Chromium, ambos consumidores reales. Completaron cinco consultas por vía: acumulado, día, ubicación, edad/género y país. Gasto exacto de 10000000 centavos COP e impresiones 4000 produjeron CTR de enlace 2,5 % en cada fuente. El alcance permaneció separado; no se sumó ni se inventó alcance global.
- No hubo publicaciones ni activaciones; los accesos Graph del humo fueron GET. La lectura no dependió del archivo multimedia ni, en navegador, de claves Meta. El fingerprint financiero permaneció idéntico y se preparó el respaldo comercial con las capturas tipadas. La configuración no verificable por permisos/interfaz quedó como evidencia explícita, no como certificación de comparabilidad.
- HTTP Next real con cookie administrativa: resultados 200, filtro duplicado o desconocido 400 y anónimo 401. Esa base original no tenía capturas; su respuesta vacía y alcance desconocido no se presentan como el dataset del humo separado. Revisión comercial 62 intacta. La acción pública de dominio rechazó una segunda consulta manual con 429 en ambas vías.
- Una consulta por turno, cursor durable y fences de entrega/conexión/custodia evitan mantener transacciones abiertas durante la red. Pauta activa: una hora; tras final confirmado: siete días y captura final al día 28. Orgánico: seis horas durante observación más dos días y captura final al día 28. «Actualizar» respeta quince minutos; reconciliar estado es una acción separada.
- Ventanas acumulada/reciente y desgloses no se mezclan. Se preservan zona horaria, moneda, atribución, origen, definición y precisión. Cero conocido no equivale a permiso ausente; datos redondeados y denominadores inválidos no generan ratios exactos. Una captura parcial posterior conserva la última completa y su antigüedad real.
- Export CSV/XLSX acotado antes del parseo; identificadores, ámbito, separadores y formatos monetarios ambiguos se rechazan. Fallback de tabla/virtualización exige evidencia de cobertura. El export se elimina tras usarlo y no se conservan filas de personas ni un workbook bruto. El lector comercial mantiene sus límites previos.
- La lectura API usa capacidades independientes de publicación. Token revocado invalida conexión; límites por cuenta y backoff no duplican publicaciones. Métricas retiradas se cachean por versión; el tiempo de video sólo declara segundos/milisegundos si su definición recibida los documenta. Un desglose numérico de orgánico/pagado no acreditado no se interpreta como orgánico.
- El respaldo comercial y el reset físico eliminan cursores y solicitudes de lectura ejecutables, conservando hechos históricos. La restauración no genera sincronización por sí sola. El reset no vuelve a versionar entregas que ya carecen de trabajo operativo.
- Regresiones corregidas durante el pase: pausa mínima sin spec, dinero tipado tratado como importe escalar, traducción de errores del export, validación de sesión antes de buscar el objeto y mutación innecesaria de entregas al reset. El primer pase completo tuvo un fallo de esta última regresión; sólo el pase posterior indicado en la tabla está aprobado.
- Pendientes externos: permisos/capacidades reales, definiciones y retrasos efectivos de Meta, DOM/exports actuales y autorización de automatización. Este pase no valida pronósticos históricos, vínculos financieros, recomendaciones ni el panel final de las etapas siguientes.

### Estimación comparable y vínculos comerciales declarados

Suites solapadas; no sumar sus resultados:

| Ejecución | Pruebas aprobadas | Fallos | Omisiones |
|---|---:|---:|---:|
| Contratos sociales completos, backup, migración, workers y leases en Node/SQLite/Chromium | 358 | 0 | 0 |
| `npm run test:postgres`, PostgreSQL 16 con TLS/CA, incluidos estimación, vínculos y respaldo del análisis | 297 | 0 | 0 |
| Estimación, vínculos, modelo/consumidor de métricas y SDK Meta en Linux readonly, UID 1000 y sin red/capacidades | 76 | 0 | 0 |

- Humo Node real sobre SQLite nueva y servidor HTTP loopback: el SDK obtuvo una audiencia potencial fija del proveedor sintético; el primer forecast fue escenario manual sin historial. Después se sembraron explícitamente cinco campañas/capturas analíticas sintéticas, incluido un resultado cero. El generador produjo cuartiles tipo 7 para el presupuesto propuesto, no una predicción visual ni un intervalo de confianza.

| Métrica proyectada | Inferior | Mediana | Superior |
|---|---:|---:|---:|
| Clics de enlace, cinco campañas comparables | 150 | 200 | 250 |

- La acción pública aprobó ese forecast inmutable y encoló preparación pagada; no se ejecutó publicación remota. Una captura analítica sintética posterior, con reloj/corte explícitos, quedó por debajo del rango. Los contratos comprueban que una estimación nueva no reemplaza retrospectivamente la aprobada, y separan avance pagado, mediana cero, definición incompatible y primer horizonte orgánico 7/14/28.
- Programa separado contra la misma base descartable: crear y estimar una propuesta de navegador sin `META_APP_ID/SECRET` guardó el escenario manual, dejó audiencia no disponible sin preflight y realizó cero llamadas SDK. No se creó un borrador Meta para intentar obtener una cifra.
- En otra campaña histórica sintética, un pedido real del dominio fue entregado, cobrado y devuelto parcialmente después del fin de pauta. Se registró y pagó parcialmente un gasto publicitario existente antes de vincular ambos. Al corte 1 de noviembre, las magnitudes permanecieron independientes:

| Magnitud comercial al corte | COP |
|---|---:|
| Presupuesto aprobado | 50000 |
| Gasto acumulado reportado en la captura Meta sintética | 40000 |
| Gasto publicitario registrado vinculado | 70000 |
| Pagos de ese gasto | 30000 |
| Ventas netas de producto reconocidas, después de devolución | 400000 |
| Contribución conocida de los pedidos | 308000 |
| Contribución después de descontar Meta una sola vez | 268000 |

- El retorno declarado fue 10, sin atribución causal ni interpretación de utilidad. Vincular y consultar conservaron idéntico fingerprint de pedidos, gastos, pagos, caja, devoluciones, cobros, envíos y contadores; no modificaron etiquetas importadas ni crearon otro gasto.
- Versiones monotónicas sobreviven a desvincular/revincular: un cliente viejo no puede sobrescribir una asociación nueva. El ámbito de la ruta se valida dentro de la transacción idempotente; repetir una desvinculación ya aplicada no vuelve a borrar un vínculo posterior. Candidatos paginados buscan número/concepto/etiqueta literal, sólo gastos `advertising`, sin campos de clientes.
- Sin vínculos, reconocimiento pendiente, costos desconocidos, Meta parcial/redondeado o moneda incompatible, se conservan componentes conocidos sin afirmar retorno/contribución final. Las fechas del panel financiero son acumuladas al corte e independientes del futuro filtro social.
- El humo completo encontró un rechazo real del respaldo: `analysis.comparisons[].spendMinor` es métrica tipada, no entero escalar. Ahora se valida por su esquema; valores negativos, fraccionarios o unidad incorrecta se rechazan atómicamente. Exportar y preparar el respaldo del forecast/aprobación/análisis/vínculos terminó correctamente; la regresión de restauración está incluida en ambos motores.
- Los primeros intentos del programa desechable fallaron por configuración de fixture: nombre del flag, identidad IG, fechas monetarias futuras, referencias faltantes y uso incorrecto del exportador. Se corrigió el ensayo, sin debilitar guardas del producto. Sólo el programa completo posterior se considera aprobado. Programas propios retirados; bases y claves exclusivamente sintéticas.
- Este pase de estimación/vínculos no acredita las reglas de mejora, su consumidor ni la integración visual. La evidencia posterior de mejoras se registra en el apartado siguiente; la aceptación externa sigue requiriendo cuentas, permisos y DOM actuales de Meta.

### Mejoras deterministas y recálculo local · 3 de noviembre de 2026

- Pase integrado posterior: 393 contratos Node/SQLite/Chromium, incluidos filtros de resultados, vistas, backup, CLI y leases, sin fallos ni omisiones. Los 47 contratos focalizados de reglas, análisis, ventanas y replay están incluidos en ese pase; no se suman. PostgreSQL y la superficie visual final se verifican por separado.
- Las siete reglas usan evidencia tipada y condiciones explícitas: días completos en la zona de la cuenta, cuartiles comparables, agregados únicos de tres días, resultados primarios por ubicación, mismo horizonte orgánico y cobertura financiera completa. El máximo es cinco tarjetas, sin causalidad ni aumentos automáticos de presupuesto.
- El hash representa forecast aprobado, configuración, capturas/cohortes pertinentes, versiones de vínculos y hechos comerciales. La revisión contable detecta obsolescencia; un gasto ajeno obliga a comprobar frescura, pero no crea otra evaluación, tarjeta ni auditoría si los hechos pertinentes no cambiaron. Los contratos cubren tanto el paso administrador→scheduler como un replay posterior del propio scheduler.
- Humo Node real en clon SQLite privado: la historia y las capturas se sembraron explícitamente como datos analíticos sintéticos, con corte futuro declarado del 12 de noviembre. El consumidor produjo `weak_link_ctr`; aplicar creó un borrador sin fechas, aprobación, previsión ni referencias remotas, con el mismo presupuesto de 50000 COP. El usuario aportó texto; no se aprobó ni publicó. Otra captura sintética produjo una nueva tarjeta y descartarla exigió versión y motivo.
- Las acciones sociales conservaron el fingerprint de pedidos, gastos, pagos, caja, devoluciones, cobros, envíos, contadores e informes. Exportar y preparar el respaldo con recomendaciones aplicadas/descartadas terminó correctamente. Los contratos SQL verifican además evaluación de un hijo confirmado y rechazan considerar mejora un aumento de monto/volumen.
- `node scripts/business-jobs.mjs --once` ejecutó después el mismo consumidor y dejó el caché vigente, sin llamadas de red. Ese turno también materializó 30 obligaciones salariales legítimas del dataset, con incremento contable de 30; no se atribuye esa mutación del worker general a las acciones sociales ni se afirma que el turno completo fuera financiero de sólo lectura.
- Una campaña financiera histórica sembrada sin forecast aprobado terminó con `APPROVED_FORECAST_REQUIRED`, no con una evaluación inventada. Los primeros intentos del programa desechable fallaron por asumir `null` en un campo ausente y por importar un helper desde el módulo incorrecto; se corrigió el ensayo, sin cambiar el contrato del producto. Sólo el programa completo posterior se considera aprobado. Cero llamadas Meta reales, activaciones o inversión.

### Panel completo, consumidores independientes y pase final · 3 de noviembre de 2026

| Comprobación | Resultado observado |
|---|---|
| Suite completa `node --test --test-concurrency=2 tests/*.test.mjs` | 1211 aprobadas; cero fallos, cancelaciones u omisiones. Incluye 312 contratos PostgreSQL con TLS verificado. |
| Pase focalizado previo de backend en Linux aislado | 81 aprobadas; cero fallos u omisiones. No se suma a la suite completa. |
| `npm run check` | 288 archivos JavaScript/JSX; cero errores de sintaxis/imports locales. |
| Next.js 16.4.3 compilado | Build correcto sin warnings; rutas dinámicas administrativas y sociales presentes. |
| Superficie real en Chromium | Escritorio 1440 × 900 y móvil 390 × 844; ancho documental igual al viewport en las comprobaciones focalizadas. |

- El ensayo usa SQLite nueva/privada, medios sintéticos reales y transporte Meta propio con estado. Web y workers bloquean toda llamada Meta fuera de la fixture; los flags `true` sólo se usan allí. El retorno OAuth se ejercitó entre `localhost` y `127.0.0.1`, con puente y cookie Strict, sin presentar la navegación local como autorización real de Facebook.
- Recorrido API por el wizard: PNG convertido a JPEG, dos redes feed y un total de 50000 COP; audiencia potencial 10000–20000 e historial insuficiente, sin mediana inventada. La aprobación preparó un único conjunto/anuncio PAUSED, con presupuesto remoto 50000. Con pestaña cerrada y runner scraper detenido, el CLI normal confirmó la activación futura como `scheduled`; la fixture tuvo una activación y el scraper ninguna publicación.
- Recorrido navegador por la UI móvil: MP4 real de 3 s/540 × 960 reproducido, misma huella SHA-256 subida y leída en el borrador nativo, configuración efectiva/ubicaciones Reels verificadas, forecast conservado y preparación sin activación. Los consumidores ejecutaron con `META_APP_*` y `META_LOGIN_CONFIG_ID` eliminados después de cargar el entorno CLI; el guard de ensayo observó cero llamadas Graph.
- La pérdida de respuesta se inyectó en la primera activación nativa: un efecto remoto y salida `OPERATION_UNCERTAIN`, visible como **Efecto incierto**. Reiniciar runner y reconciliar desde la UI confirmó el mismo objeto, sin otra activación ni subida. Dos ciclos posteriores e independientes pausa→reanudación terminaron confirmados. La pérdida no se inyecta en esos ciclos: la fixture limita ese control a publish/activate.
- Login asistido→estado cifrado→reinicio→consulta sin escribir contraseña otra vez; invalidar cookie produjo `reconnect_required`. El desafío quedó pendiente de intervención y sólo se completó con OTP explícito por el visor. La cola corregida procesó 43 entradas de texto sin `BROWSER_BUSY`. El canvas móvil mantuvo su bitmap 1280 × 800 pero se mostró ajustado al diálogo, sin clipping horizontal.
- La sincronización manual posterior al inicio real completó un ciclo de cinco consultas: agregado y fila diaria completos; edad/género, ubicación y país quedaron no soportados, sin filas inventadas. Los valores sintéticos del proveedor fueron gasto COP 100000, impresiones 4000, alcance 3000 y clics 100: CTR 2,5 %, CPC COP 1000 y CPM COP 25000. Conversaciones de este objetivo permanecieron desconocidas. Son datos de lectura sintéticos independientes, no inversión real ni una simulación financiera de entrega.
- En escritorio se vincularon un pedido existente y un gasto de Publicidad creado expresamente como fixture antes del baseline. La UI separó presupuesto COP 50000, Meta sin dato para esa campaña API, registrado COP 70000 y pagado COP 0; ventas de producto reconocidas COP 110000, contribución conocida COP 47500 y cobros COP 122000. Sin gasto Meta completo no afirmó retorno ni contribución final. El fingerprint íntegro de pedidos, registros, envíos, gastos/pagos, caja, devoluciones, cobros, contadores e informes se mantuvo idéntico durante vínculos, operación social, capturas y análisis; revisión 64.
- La historia API explícitamente sembrada permitió aplicar una receta sustentada. La campaña nativa sin comparables produjo una instrucción de medición, no una recomendación de escalar. Aplicarla por la UI devolvió un borrador nuevo con el mismo total, sin fechas, previsión, revisión, entrega ni operación. Se editó y guardó el texto; cancelar la confirmación de descarte conservó URL y contenido. Guardar no añadió otra entrada de historial; Atrás volvió al listado, Adelante recuperó el borrador y recargar conservó el texto y foco de encabezado.
- El humo encontró y corrigió guardias de ocupado que impedían navegar tras aplicar, colisión frame/teclado, clipping del visor, lectura local detenida en incertidumbre y navegación redundante al guardar en el mismo registro. La comprobación visual separa también valor, precisión, definición y motivo; no se ocultan faltantes ni errores.
- El build dejó de rastrear raíces de medios/secretos del host: los volúmenes se resuelven en runtime y se excluyen `data`/`.env*`. Los manifiestos finales no contienen la SQLite productiva, `.env`, tests ni reportes Playwright. Previews JPEG/MP4 siguieron funcionando con el servidor compilado; no se relajaron controles de ruta/hash/firma.
- El perfil Compose `social-browser` se construyó y ejecutó en proyecto/volumen descartables, sin salida externa: health real, UID 1000, sandbox Chromium, raíz de sólo lectura, capacidades eliminadas, `no-new-privileges` y ningún puerto publicado. Un segundo runtime de humo dentro de ese aislamiento permitió sólo el origen de fábrica de la fixture: login HMAC confirmado, frame JPEG, estado conservable, comando sin firma 401 y redirección privada rechazada como `AUTH_FAILED` con cero solicitudes al destino.
- La imagen final `allnutrition:social-verified-54952b89` (Linux/arm64) ejecutó Next real como UID 1000, sin red externa y con volumen descartable: health 200, consulta anónima 401, login 200 con cookie HttpOnly/Strict, escritura sin CSRF 403 y creación de borrador incompleto 201. FFmpeg/ffprobe estaban disponibles. Detener y volver a arrancar con el mismo volumen conservó usuario y borrador, sin historial de publicación. La comprobación de la imagen sin volumen confirmó ausencia de secretos embebidos, `.env*`, SQLite productiva, artefactos de despliegue y `.test-data`. No se promovió ni desplegó esa imagen.
- Los primeros intentos no son un pase: la fixture del runner tenía publicación deshabilitada y se corrigió sólo su configuración; el reintento exigió antes ausencia/riesgo/motivo por la UI. Una corrida antigua falló al abrir el fixture TLS, sin causa demostrada. El último intento previo al pase completo usó equivocadamente el usuario `postgres` para un contenedor cuyo propietario era `social_test` y terminó 899/900; se corrigió únicamente la credencial descartable, sin cambios al driver ni a las pruebas. El pase final conserva toda la cobertura con concurrencia acotada.


Estos resultados no acreditan una app real de Meta, permiso de automatización, DOM/exports actuales autorizados, publicaciones reales, inversión, aceptación de release ni despliegue productivo. Faltan cuentas de prueba/negocio, permisos/revisión, callback y medios HTTPS públicos y autorización explícita del propietario para cada publicación y total; la aprobación del plan no los sustituye. Los flags siguen siendo `false` por defecto. Los datos, archivos y claves del ensayo fueron sintéticos/efímeros. No se consultó ni modificó la base productiva.

## Combos privados y obsequios desde Excel · verificación local

El importador permite vincular referencias existentes o crear producto, combo y obsequio sin publicar la vitrina. El permiso de pedidos privados es independiente de publicación. El obsequio ocupa una línea real con precio de venta cero y conserva los costos e inventario de sus componentes; su cantidad exige columna o confirmación fija explícita por hoja. No se interpreta el nombre ni se reutiliza la cantidad vendida.

Smoke con Next.js **16.4.3** compilado, SQLite sintético, worker real y HTTPS loopback: creación de combo privado con dos unidades de un componente y obsequio privado con una unidad del mismo componente; confirmación móvil de un obsequio por fila e importación completa desde la UI. Consulta del pedido: dos líneas, combo **55.000 COP**, obsequio **0 COP**; total **55.000 COP**. Conteo físico **10**, reserva **3**, cero cobros/pagos/movimientos de caja. Reimportar el preparado mantuvo un único pedido y la misma reserva. Exportar y restaurar en otra base vacía conservó ambas líneas, total, privacidad y existencias.

Superficie comprobada a **1440×900** y **390×844**, sin desbordamiento horizontal en las comprobaciones focalizadas. Reabrir el lote mostró «Importación completada»; el detalle móvil mostró cantidad 1 y precio 0 del obsequio. La vitrina siguió en preparación y el DTO público no contenía productos ni combos privados. Sin errores de navegador observados en esta sesión. Se cerraron la pestaña y los servicios privados propios. El certificado autofirmado requirió una excepción solo en el navegador local.

El contrato de respaldo detectó y corrigió dos rechazos: los alias de combos se validaban solo contra productos, y las observaciones históricas combinadas se exigían del último lote. Se mantienen las comprobaciones de fuente/lote/hoja/fila originales; los datos entrantes no combinados siguen limitados al lote actual. Contratos focalizados de catálogo, lector y libro: **84 aprobados**, cero fallos/omisiones. `npm run check`: **195 archivos**, cero errores; `npm run build` aprobado.

Suite integrada final `npm test` con SQLite real y PostgreSQL **16** descartable: **682 aprobados**, cero fallos/omisiones. El contenedor propio se retiró al terminar con código 0. Incluye reimportación original/preparado y restauración del respaldo con combo privado y obsequio. Los dos pases previos fallaron por las validaciones de respaldo descritas arriba y no se consideran aprobados.

Evidencia privada sintética: `.test-data/import-combos-bd89b0ce/`, incluidos `browser-evidence.json`, `domain-smoke.json`, `restore-smoke.json` y capturas. **Este pase no acredita publicación, aceptación nativa de release ni ejecución de la suite E2E completa. No se modificaron el libro original ni datos de producción.**

### Ensayo nativo previo al corte de combos

El candidato inicial `allnutrition:release-e0a8fac5bddc` aprobó 682 contratos SQLite/PostgreSQL sin fallos/omisiones y 44 E2E (22,8 min), auditoría sin vulnerabilidades conocidas y las comprobaciones operativas completas. No se promovió: el ensayo separado sobre un respaldo real restaurado detectó validación excesivamente costosa. El perfil CPU concentró el trabajo en parsear repetidamente el JSON completo de cada lote por observación y fila. Se comparte ahora un índice de nombres de hojas por lote, local a cada validación; fuente, lote, hoja y fila siguen comprobándose para cada dato.

Smoke sobre el clon PostgreSQL aislado con la corrección montada: exportación y validación completas en **9.202 ms**, hash comercial idéntico al exportado por la imagen anterior, TLS y prohibición de DDL comprobados. No hubo escrituras productivas. La aprobación inicial no acredita la corrección: requiere un nuevo candidato sellado y aceptación nativa completa antes de publicar. Evidencia privada `.test-data/compound-release-6c2b1a90/`.

### Publicación de combos privados y obsequios · 30 de octubre de 2026 (Bogotá)

- Web y scheduler ejecutan **`allnutrition:release-4d054869563c`**, ID `sha256:4d054869563c815a67e8ad23fe956ddec65910c16f13e9247b42f529f31f5b69`, Linux/amd64, Next `16.4.3`, Node `24.22.2`, UID 1000. Fuente sellada SHA-256 `b6e5fb2feb1cdbbdfae186b3dcacc9f37bbe2cc4352720530a6779a4505ac9c6`, 251 archivos. Corte terminado `2026-10-31T04:17:22Z`; promoción exacta sin rebuild ni migración.
- Aceptación nativa final `63d7267b9d8e4f49`: **682 contratos SQLite/PostgreSQL, cero fallos/omisiones; 44 E2E en 21,8 min**. Build/check, auditoría sin vulnerabilidades conocidas, HTTPS CA/hostname, scheduler idempotente, rol sin DDL, caída y recuperación con 503 autenticado, reinicio, WebP y dump/restore aprobados; recursos descartables retirados. El primer pase `a19d8240e219877e` falló en migración de prueba por plazo de consulta; no se promovió. El candidato intermedio aprobado quedó sustituido por el sucesor con la corrección de rendimiento.
- La imagen final validó un respaldo real restaurado en clon aislado sin puertos: **42 tablas**, esquema y hash comercial preservados, bundle válido, TLS y rechazo DDL comprobados; sin migraciones ni escrituras productivas. `pg_restore` solo normalizó la asociación de paréntesis AND de dos CHECK de importes; se compararon sus definiciones exactas equivalentes y no se admitieron otras diferencias. Clon y volúmenes retirados.
- Ambos escritores detenidos para respaldo final consistente con snapshot exportado: dump **2.150.283 bytes**, modo `0600`, SHA-256 `e25294e042151d2d18a35c875c5e8fc193d3ca6cca44e72d4dba8e27333b1717`, catálogo legible; cuatro medios y fuentes previas respaldados. Archivos privados `/home/allnutrition/compound-release-6c2b1a90-r2/{production.dump,media.tar,source-before.tar}`. Las 42 tablas/esquema coincidieron congelados y con web abierta; tras scheduler solo cambió `job_runs` y quedaron **41 tablas idénticas**. PostgreSQL mantuvo ID/arranque; env/TLS y medios intactos.
- Dominio real: health 200, pedidos anónimos 401 y autenticados 200; sesión previa conservada, cuatro lotes y cero pedidos; plantilla privada de cinco hojas vacías 200. UI real a 1440 y 390 px mostró las tres opciones de alta, con diálogo dentro del viewport, sin alertas ni errores observados en la comprobación final. Inspección DOM, sin capturas con datos reales; prueba visual sintética arriba. El primer intento usó un selector de rol en vez del `dialog` nativo y el worker del navegador terminó al manejar confirmación; la comprobación final abrió una pestaña nueva y activó por teclado el diálogo correcto. No se guardó resolución ni se aplicó el libro real. Logout propio 200 y acceso posterior 401; otras sesiones no modificadas.
- Evidencia privada local `.test-data/compound-release-6c2b1a90-r2/`: aceptación, artefactos, restore, backup, preservación y `production-ui-evidence.json`. Documentación sincronizada después sin reconstruir la imagen aceptada.

## Continuidad de productos pendientes · publicada · 30 de octubre de 2026

Reporte: al guardar un vínculo se dejaban de ver los demás productos. `updateImportBatch` invalida correctamente `preview`; la lista estaba dentro del bloque que solo renderiza con preview válido. Se separó la cola de trabajo de la aprobación: `getImportBatch` entrega `pendingProductLinks`, calculada sobre diagnósticos persistidos de todas las filas y resoluciones guardadas, respetando hoja/fila/grupo. La UI la muestra también sin preview, en Hojas y datos y Completar y revisar. Los efectos y la confirmación de importación siguen requiriendo revisión nueva.

Smoke local previo con build real Next `16.4.3`, TLS sintético y SQLite privado: tres referencias distintas, primer guardado conserva las otras dos, recarga conserva pendientes, segundo y tercer vínculo sin revisión intermedia; al terminar, tres vínculos, cero pendientes, preview y aceptación nulos y cero pedidos. Inspección visual de lista móvil y guardados en escritorio; 390 px sin desbordamiento y sin errores de navegador. Evidencia privada `.test-data/product-pending-2525bd81/smoke-evidence.json`. `npm run check`: 195 archivos sin errores; `npm run build` aprobado; contratos SQLite del libro: 41 aprobados, cero fallos/omisiones. Esa verificación local no modificó producción ni aplicó el libro real; la publicación posterior se acredita abajo.

Regresión permanente ampliada: **2 E2E aprobados**, escritorio y móvil (8,0 min), contra ese build y worker real. Comprueba segundo vínculo sin preview intermedio, pendientes visibles tras guardado/recarga y desaparición de la cola solo al guardar ambos, sin productos/pedidos nuevos ni commit. Contratos compartidos del libro: **41 aprobados con SQLite y 41 con PostgreSQL real descartable**, cero fallos/omisiones; incluye 56 operaciones en dos hojas, vínculo limitado a una fila que no oculta las otras 54, cola independiente de página/filtro y rechazo de commit con hash anterior. Suite `npm test`: **533 aprobados, cero fallos, una omisión** (runner PostgreSQL completo sin entorno; el contrato del libro se ejecutó por separado en PostgreSQL). No equivale a aceptación nativa de release ni despliegue. Resultados privados `.test-data/product-pending-2525bd81/e2e-results` y `e2e-report`; contenedor PostgreSQL, servidores, proxy y runner temporal retirados.

### Publicación de la corrección de pendientes

- Web y scheduler ejecutan la misma imagen aceptada **`allnutrition:release-54dffbbf173d`**, ID `sha256:54dffbbf173da626653696eb0151a7d01991a7b33c6d1cf87c149c143cb4737b`, Linux/amd64, Next `16.4.3`, Node `24.22.2`, UID 1000. Fuente SHA-256 `3cc849fcee23286ae0579f17e5d882a2af0f75bd02e31afa6ed2c8ab08dd2c91`; 251 archivos sin datos privados. Corte terminado `2026-10-31T00:19:17Z` (30 de octubre en Bogotá), sin rebuild ni migración.
- Aceptación nativa `5e8cf98d06247cda`: **672 contratos SQLite/PostgreSQL aprobados, cero fallos/omisiones; 44 E2E aprobados en 21,7 min**. Build/check, auditoría productiva sin vulnerabilidades conocidas, HTTPS CA/hostname, scheduler idempotente, rol sin DDL, migración repetida, caída con 503 autenticado y recuperación sin pedido extra, reinicio, sesión, WebP y dump/restore en base distinta. Entorno descartable retirado.
- Ambos escritores detenidos para dump con snapshot exportado, **3.652.672 bytes**, modo `0600`, catálogo legible; cuatro medios respaldados. El helper se interrumpió antes de cambiar fuentes/selector al intentar aplicar un permiso ausente de `manifest.changes`; el README solo quedó como archivo temporal. Se comprobó el estado detenido y el respaldo, se tomó el permiso del registro sellado `manifest.files` y se reanudó desde allí. La primera versión del helper de reanudación fue rechazada por sintaxis antes de ejecutarse; la corregida terminó. No hubo restauración automática ni cambio en la imagen aceptada.
- Las **42 tablas y el esquema** se conservaron con web abierta antes del scheduler; después solo cambió `job_runs`, con **41 tablas idénticas** y medios intactos. PostgreSQL no se reinició; env/TLS conservados. Backup privado `/home/allnutrition/product-pending-release-a66b8712/{production.dump,media.tar,source-before.tar}`.
- Dominio real: health 200, anónimo 401, sesión previa autenticada 200; cuatro lotes y cero pedidos conservados, plantilla privada de cinco hojas vacías 200. API y UI muestran **43 referencias pendientes, 307 operaciones y 6 vínculos guardados**; escritorio 1440 px y móvil 390 px sin desbordamiento ni alertas por inspección DOM. No se guardó ni aplicó el lote real. Captura productiva agotó plazo; la prueba visual con datos sintéticos consta arriba. Logout de sesión propia 200 y acceso posterior 401; otras sesiones intactas.
- Evidencia local privada `.test-data/product-pending-release-a66b8712/`: aceptación completa, artefactos, respaldo, preservación, publicación y `production-ui-evidence.json`. La sincronización posterior de documentación no reconstruye el runtime aceptado.

## Vincular productos existentes desde Excel · publicada · 30 de octubre de 2026

Reproducción con SQLite y catálogo sintéticos, sin tocar datos productivos: con un producto existente seleccionado, **Guardar lote y crear producto** abría un alta y dejaba cero vínculos guardados; guardar el borrador invalidaba la revisión. La corrección separa **Guardar vínculo** del alta, conserva la selección aunque no coincida con el filtro, muestra los vínculos persistidos al retomar/recargar y restaura referencia, motivo y búsqueda al cancelar la creación.

Smoke real de navegador: PUT del vínculo 200, revisión invalidada sin importación automática, recarga y reapertura con el ID guardado, alta deshabilitada con selección y cancelación sin perder el borrador. Inspección móvil a 390 px sin desbordamiento; también se abrió el diálogo en el build de producción local detrás de TLS sintético. `npm run check`: 195 archivos, cero errores; `npm run build` aprobado; `npm test`: **532 aprobadas, cero fallos, una omitida** (contrato PostgreSQL no configurado). No equivale a repetir la aceptación PostgreSQL ni a publicar esta corrección en producción. Evidencia privada: `.test-data/product-link-21b5148e/smoke-evidence.json`.

Regresión permanente `tests/e2e/workbook.spec.mjs`: **2 E2E aprobados**, escritorio y móvil, contra el build de producción local y el worker real con SQLite descartable. Cubre guardado antes de revisar, persistencia tras recarga, selección retenida con búsqueda sin coincidencias, segundo vínculo después de cancelar un alta con datos introducidos y resolución de `IMPORT_PRODUCT_LINK` al ID correcto. Verifica catálogo sin nuevos productos, cero pedidos aplicados y ninguna aceptación/commit. La ejecución inicial se rechazó por selector de etiqueta exacta que dejó de coincidir al poblar las opciones; el selector final usa el rol `combobox` y su nombre accesible. Resultados privados: `.test-data/product-link-21b5148e/final-results`.

### Aceptación nativa y publicación

- Imagen publicada sin rebuild en web y scheduler: `allnutrition:release-58b701b9dd7a`, ID `sha256:58b701b9dd7abe41520aa2647517f0c5dae7f7d0074d591f3c97e509a3ac627b`, Linux/amd64, Next `16.4.3`, Node `24.22.2`, UID 1000. Fuente sellada SHA-256 `d62e8d4834709169141e84673b66808600a1401ac726eee48d207ffd7daf578b`.
- Aceptación final `7d1e8a5082db2229`: **670 contratos SQLite/PostgreSQL, cero fallos y omisiones; 44 E2E aprobados en 23,2 min**, incluidos los dos de vinculación. Build/check y auditoría productiva sin vulnerabilidades conocidas; HTTPS con CA/hostname, scheduler idempotente, migración repetida, rol sin DDL, caída real con 503 autenticado, recuperación, reinicio, WebP persistente y dump/restore en base distinta. Recursos descartables retirados.
- Intentos no promovidos: `be81f0e905688331` agotó los 30 min de contratos; el plazo agregado pasó a 45 min, sin omitir pruebas. `fdd7220c80db94c9` aprobó 670 contratos y 44 E2E, pero perdió el supervisor tras el corte SSH durante la prueba de caída: no tuvo aceptación final. Sus recursos propios se retiraron; el pase final ejecutó todo desde cero con supervisor desacoplado de SSH.
- Corte sin migración: ambos escritores detenidos, dump con snapshot exportado de **3.615.884 bytes**, modo `0600`, catálogo legible, y copia de cuatro medios. Las **42 tablas y el esquema** fueron idénticos antes y después de arrancar web; tras iniciar scheduler, solo cambió `job_runs` y quedaron **41 tablas idénticas**. PostgreSQL no se reinició; env/TLS y medios conservados. Respaldo privado `/home/allnutrition/product-link-release-e27ca034-r3/{production.dump,media.tar}` y fuentes anteriores `source-before.tar`.
- Dominio real: health 200; pedidos anónimos 401 y autenticados 200; sesión previa conservada, cuatro lotes y cero pedidos; plantilla privada 200 con cinco hojas y sin registros comerciales. UI real mostró vínculos guardados, selección existente, **Guardar vínculo** habilitado y alta deshabilitada; diálogo dentro de 390 px, sin desbordamiento por geometría DOM. No se pulsó guardar ni se aplicó el libro real. Las capturas productivas agotaron su plazo y el worker del navegador terminó durante la confirmación de descarte: no se acredita captura visual productiva ni confirmación completada. Se cerró por API únicamente la sesión propia (logout 200, acceso posterior 401).
- Evidencia privada local `.test-data/product-link-release-e27ca034-r3/`: `acceptance-summary.json`, `native-artifacts`, `published.json`, `backup.json`, `final-preservation.json`, `production-ui-evidence.json` y comprobante de logout. La actualización posterior de estos documentos no reconstruye la imagen aceptada.

## Subida Excel bloqueada por Nginx · corregida · 30 de octubre de 2026

Reporte: el importador permanecía en «Consultando datos del servidor». El último lote solo tenía la creación del borrador (`version:1`, fase `file`, sin hash/bytes). Las consultas de plataformas/importaciones y la reapertura del borrador devolvieron 200; no se observó una caída de Next/PostgreSQL. **Fallo comprobado en la subida:** Nginx no declaraba límite propio y rechazaba un cuerpo de 1.520.289 bytes con 413 HTML antes de la aplicación (default 1 MiB). No se atribuye el mensaje de espera por sí solo al formato del Excel.

Se agregó `client_max_body_size 10m` exclusivamente al vhost HTTPS del dominio, alineado con los 10 MiB crudos del endpoint existente. Configuración previa comparada antes del reemplazo, respaldo privado `/root/allnutrition-import-upload-58eeb929/nginx-recovery.conf`, `nginx -t` aprobado y `systemctl reload nginx` graceful; sin reinicio de web/scheduler/PostgreSQL, rebuild ni migración.

Smoke aislado con imagen ya aceptada, SQLite descartable y Nginx real: libro sintético de **2.330.727 bytes**, dos hojas y cero registros comerciales; la UI recibió **202**, el worker real produjo `review`, ambas tarjetas visibles y cero alertas de aplicación; escritorio y móvil 390 px sin desbordamiento. El registro del navegador conserva dos precargas RSC abortadas durante la navegación de login, sin fallo de la subida. Frontera HTTP aislada: 10 MiB alcanza autenticación (401 sin sesión), 10 MiB + 1 byte sigue rechazado (413).

Producción tras la recarga: cuerpos sintéticos anónimos a ID inexistente, 1.520.289 y 10.485.760 bytes → **401 JSON** de la aplicación; 10.485.761 → **413** del proxy. Health 200 y dominio previo `wirego.io` con mismo estado/hash de contenido. No se cargó ni aplicó el libro real ni se modificó el borrador del usuario. Evidencia privada `.test-data/import-upload-58eeb929/http-evidence.json`; la sesión propia de diagnóstico se cierra al terminar. Esta corrección de proxy no requiere repetir contratos financieros ni sustituye la aceptación de la imagen existente.

## Next.js 16.4.3 e incorporación Excel · publicados · 30 de octubre de 2026

El usuario eligió validar Next primero y publicar juntos el framework corregido y los ajustes recientes. Se fijó Next `16.4.3`, manteniendo React/React DOM `19.3.0` y Node 24. **Web y scheduler productivos ejecutan la misma imagen aceptada, sin rebuild**: `allnutrition:release-decc826bb156`, ID `sha256:decc826bb156becb300b749124483f9286a8c286bf665d5ec3d437056d14bb9f`, Linux/amd64, Node `24.22.2`, UID 1000.

### Aceptación del candidato final

| Comprobación | Evidencia observada |
|---|---|
| Fuente sellada | Paquete SHA-256 `f4d4c521e04526a08a9489496282cf3cdcb42943489c54ffb3b75cdafaa735f1`; 251 archivos, sin libros Excel, credenciales ni datos privados. Registros de procedencia vinculan manifiesto, imagen y SHA de cada resultado; archivos y permisos comprobados después de la aceptación. |
| Local Linux/arm64 | `dd1d9580c690a31c`, código 0; 670 contratos SQLite/PostgreSQL, 0 fallos/omisiones; 42 E2E, 39,0 min; auditoría productiva: 0 vulnerabilidades conocidas. Imagen `13c67575f03d…`. |
| Nativa Linux/amd64 | `7aa4e6c65d8cc57e`, código 0; 670 contratos, 0 fallos/omisiones; 42 E2E, 15,4 min; auditoría productiva: 0 vulnerabilidades conocidas. Imagen exacta `decc826bb156…`. |
| Operación completa en ambas arquitecturas | Build/check; HTTPS con CA y hostname; scheduler real e idempotente; migración repetida; rol limitado sin DDL; rechazo de CA incorrecta y TCP sin TLS; health y POST autenticado 503 durante caída; recuperación sin pedido adicional; reinicio conservando sesión, replay, numeración e historial; WebP persistente; dump/restore en base distinta. Recursos descartables retirados. |
| Restore del backup real, antes de publicar | Clon aislado sin puertos: 42/42 tablas idénticas por conteo y hash canónico, cuatro medios idénticos. La imagen final migró v5→v7 conservando las 41 tablas no-migrations, registros anteriores de migración y hash completo del bundle; segunda migración idempotente. Clon y volúmenes retirados. |

### Ejecuciones rechazadas y correcciones del verificador

- Los pases local `d3be2091e78fcfb5` y nativo `58f4692a60f413df` quedaron rechazados por `socket hang up`, aunque hubieran aprobado fases previas. Una prueba Linux/Node24 aislada reprodujo `ECONNRESET` con `reusedSocket:true`: los comandos síncronos impedían procesar el cierre del socket del pool HTTPS. `agent:false` obtuvo 200/200 con CA/hostname verificados, sin reintentos ni relajación de comprobaciones.
- El candidato nativo v3 `736a0741f0137395` aprobó 670 contratos y 41/42 E2E; quedó rechazado. La traza mostró el pedido en «Preparando»: retirar una ruta Playwright al completar PUT dejaba lecturas de productos/combos sin respuesta. El mecanismo se reprodujo sin aplicación comercial; conservar la ruta liberada hasta el cierre de página completó 40/40 iteraciones. Solo cambió el ciclo de vida del interceptor del test, no la aplicación, sus plazos ni las expectativas. La aprobación final corresponde a v4, no a estos pases.

### Corte productivo y smoke real

Se detuvieron web/scheduler antiguos y se registró la detención a las **04:27:10 UTC**. El respaldo final consistente usa el mismo snapshot exportado que los hashes de las 42 tablas: `/home/allnutrition/next1643-9fd26bc4-r4/rehearsal/capture-cutover/production.dump`, **246.920 bytes**, modo `0600`, SHA-256 `63e6ec359b09466dda2c106cccc05f0a30a51b3901fb5a5555605bdff93d8236`; catálogo `pg_restore --list` comprobado. `media.tar` conserva los cuatro archivos. El restore ensayado fue el respaldo previo de la misma base; **no se restauró el dump final sobre producción**.

Antes de cambiar el selector o arrancar escritores, comparación congelada en `REPEATABLE READ READ ONLY`: las **41 tablas no-migrations permanecieron idénticas**, incluidos usuarios/password hashes, sesiones, settings, contadores y bytes de importaciones. Se conservaron los marcadores existentes y solo se agregaron 6/7; único cambio de esquema: `expenses_category_check`. Los cuatro medios y los archivos env/TLS coincidieron. PostgreSQL conservó ID y fecha de arranque: **no se recreó ni reinició la base**.

Se reemplazaron 76 fuentes con hashes previos comprobados y copia atómica; respaldo de fuentes en `/home/allnutrition/next1643-9fd26bc4/cutover-v4/source-before.tar`. Se cambió únicamente `APP_IMAGE` del selector privado. Web arrancó con la imagen aceptada; la sesión anterior leyó pedidos/importaciones con 200, anónimo obtuvo 401, health 200 y cabeceras de seguridad intactas. Plantilla autenticada: 13.712 bytes, cinco hojas y tablas comerciales solo con encabezados. Se arrancó scheduler con la misma imagen y heartbeat nuevo a las **04:28:20 UTC**. Nginx, DNS y firewall no se modificaron.

Chromium en el dominio real: vitrina con imágenes, importador y sus cuatro pasos visibles, escritorio 1440×900 y móvil 390×844; ancho móvil 390 sin desbordamiento, cero alertas/errores observados. «Nuevo lote» abrió el formulario vacío; **no se subió archivo ni se creó/aplicó un lote**. Se conservaron 0 pedidos y 3 importaciones anteriores; logout revocó solo la sesión propia y su API posterior devolvió 401. **No se aplicó el libro real ni se crearon hechos comerciales.**

Evidencia privada local `.test-data/next1643-9fd26bc4/`: `native-v4-acceptance/`, `rehearsal-v4/`, `cutover-v4/`, procedencias, smoke y capturas. Respaldos productivos permanecen privados en la VM. La documentación de resultado se publica después de sellar la imagen y no implica rebuild. No acredita CI remoto, Safari/Firefox, auditoría integral ni ausencia de todo posible defecto; el backup sigue sin acreditar programación/retención o copia off-host.

## Incorporación desde libros Excel · verificación aislada · 28 de octubre de 2026

Implementación integrada de contratos de libro, perfiles por hoja, gastos, costos históricos, apertura física, descargas y respaldos. Evidencia de contratos reales SQLite/PostgreSQL, smoke privado y suite E2E completa con datos sintéticos; el libro real solo se revisó sin aplicar. **No acredita aceptación de release, publicación, push ni migración de la base real.** Los resultados históricos posteriores pertenecen a sus respectivas versiones, no al pase actual.

### Resultados observados del pase

| Comprobación | Resultado observado |
|---|---|
| `node --test tests/import-excel.test.mjs` | Ejecución inicial: 30 aprobados, 0 fallidos, 0 omitidos. Ejecución dirigida posterior al ajuste de exclusiones: 31 aprobados. |
| Contratos dirigidos de catálogo, costos, envíos, inventario y vistas administrativas | 67 aprobados, 0 fallidos, 0 omitidos. |
| Contratos dirigidos de migración del negocio | 20 aprobados, 0 fallidos, 0 omitidos; incluye prerrequisito, rollback, FK e índices de v7. |
| `node --test tests/business-workbook.test.mjs tests/business-imports.test.mjs tests/backup-restore.test.mjs` | 100 aprobados, 0 fallidos, 0 omitidos, incluidos subtests anidados. Los contratos compartidos usan APIs SQLite reales; comprenden 34 subtests de libro, incluidas fórmulas. No se suman de nuevo al total. |
| Smoke transaccional con APIs reales | Importes exactos en centavos coincidentes con el desglose único del informe de septiembre en la tabla de smoke manual siguiente; no se deducen importes del formato visual de Excel. |
| Efecto físico y financiero del smoke | Stock físico 10 tras historia incluida en apertura y 11 tras recuperación posterior; ninguna entrada de caja, pago de gasto ni cobro creado. |
| Lector del libro original privado | Catálogo de 20 hojas pese a primera hoja `REVISION` comprobada vacía. Propuestas de 15 hojas mensuales requieren confirmación; PAUTA corresponde a campaña comercial. |
| Copia ampliada privada | 21 hojas legibles; 35 partes originales no modificables conservadas por comparación de hashes; original sin cambios. Hoja de operación vacía con 7 encabezados. No se publican hashes ni contenido del libro. |
| Plantilla separada | 5 hojas; tablas comerciales/de gastos solo con encabezados, sin registros de ejemplo. |
| `npm run check` del pase | 195 archivos, 0 errores. |
| Build Docker posterior a la corrección semántica de observaciones | Web/checks compilados correctamente en proyecto privado `excel-onboarding-34ca0189`, Next.js 16.3.8 y Node de imagen 24.22.1; build observado de 32,45 s. Auditoría conserva 1 vulnerabilidad crítica, sin override ni rebaja de seguridad. |
| Migración PostgreSQL privada | Ejecutada hasta esquema 7. El mensaje de servicio todavía decía v6; se corrigió el logger, no se interpretó ese texto como versión efectiva del esquema. No se migró producción. |
| Primera suite completa `npm test` en checks | 659 pruebas: 653 aprobadas, 6 fallidas, 0 omitidas; incluye 2 wrappers fallidos y 4 fallos reales, reproducidos en SQLite/PostgreSQL. No constituye aceptación. |
| Correcciones posteriores a la primera suite | Respuesta de cancelación tomada del estado durable tras el backlog, contrato de revisión sin aliases/preview y fixture de manipulación de respaldo dirigido a una revisión con eventos reales. La segunda suite integrada siguiente registra el resultado posterior, sin convertir la primera en aprobada. |
| Contratos dirigidos posteriores de libro y exclusiones | 37 subtests de libro aprobados y 31 de lector aprobados. El intento combinado previo tuvo 68 pruebas: 66 aprobadas y 2 fallidas, incluido wrapper, por reutilizar una fábrica ocupada al restaurar el nuevo fixture; corregida a fábrica nueva y repetición de libro aprobada. No reemplaza la suite completa. |
| Segunda suite completa `npm test` en checks | 664 pruebas: 662 aprobadas, 2 fallidas, 0 omitidas. Fallos de disponibilidad SQLite: el turno devolvía `previewing`/`applying` en lugar de `queued` tras el cambio de respuesta de cancelación. Migración registrada como v7 y conexión runtime limitada observadas. No constituye aceptación. |
| Corrección tras la segunda suite | Se conserva el resultado original del turno y solo prevalece `cancelled` cuando la lectura durable final, después del backlog, lo confirma. Leases y nuevas revisiones conservados; contratos dirigidos de importación/cancelación: 66 aprobados, incluidos los 2 de disponibilidad y 11 de cancelación. |
| Suite integrada `npm test` anterior a la última corrección de inspección | **664 aprobadas, 0 fallidas, 0 omitidas**, SQLite y PostgreSQL real. Duración Node 84,2 s; job 85,65 s. Código anterior al cambio posterior de concurrencia inspección/preview: no se declara como aceptación de la versión actual. No se suman de nuevo contratos dirigidos ni acredita E2E/release. |
| Reanudación real entre procesos del worker | 60 gastos sintéticos aceptados en revisión 1; 4 procesos de contenedor independientes con `scripts/business-jobs.mjs --once` aplicaron 25/25/10/0, con acumulados 25/50/60/60. IDs y bytes/hash de revisión conservados; el último turno no duplicó hechos. |
| Perfil modificado tras aceptar, durante reanudación | Después de 25 operaciones se cambió la categoría del perfil a publicidad; las 60 aceptadas siguieron siendo operación, según revisión congelada. Total 777.000 centavos; 0 entradas de caja, pagos de gasto, cuentas, personas y nóminas. |
| Primer E2E completo del recorrido actual | **No aprobado**: 42 escenarios planificados, sin conteo final completo. Pasaron 18 escenarios base de escritorio y 18 de móvil; descarga/copia sintética de escritorio aprobada en 40,8 s y decisiones masivas de escritorio en 4 min. Libro completo agotó 10 min tanto en escritorio como en móvil antes de subir el archivo, por selección del control de reglas. El límite global del job de 1.800 s interrumpió antes de terminar descargas/decisiones masivas móviles. No se declara aprobación de los 42 ni conteo de omisiones. |
| Regresión real de concurrencia detectada después | Lector real pausado fuera de transacción reprodujo `409` al guardar perfil y solicitar preview mientras la inspección seguía activa. Antes del fix: 38 pruebas SQLite, 36 aprobadas y 2 fallidas, incluido wrapper. Después: contratos dirigidos 105 aprobados, 0 fallidos y 0 omitidos, en 40,35 s; incluyen inspector revocado, petición de preview, lease APPLY protegido y aplicación correcta. |
| Suite integrada `npm test` previa al defecto de asignaciones del preparado | **666 aprobadas, 0 fallidas, 0 omitidas**, SQLite y PostgreSQL real. Duración Node 86,32 s; job 122 s incluyendo build/preparación/arranque privados. Incluye regresión con lector real, protección de APPLY y guardado de resoluciones sin inspecciones innecesarias. Es anterior a la nueva regresión de exportación de asignaciones: no se extrapola a su corrección posterior. |
| E2E dirigido y regresión de asignaciones | Fallo E2E real previo: **2 asignaciones esperadas, 0 exportadas** para dos líneas y una guía. Regresión SQLite antes del fix: 39 pruebas, 37 aprobadas y 2 fallidas, incluido wrapper. Después del fix: dirigidos **116 aprobados, 0 fallidos, 0 omitidos**, en 40,04 s. Incluyen preparado antes de aplicar, aplicación del preparado primero, reimportación del original, asignaciones de guía existente y conservación de IDs/eventos/gastos/stock/caja. La repetición E2E siguiente superó asignaciones, pero no completó preparado. |
| Suite integrada anterior a normalizar observaciones redundantes del preparado | **668 aprobadas, 0 fallidas, 0 omitidas, 0 canceladas**, SQLite y PostgreSQL real; duración 89,331 s. Incluye asignaciones, guía existente, reordenación, backup cruzado con v7 y leases. Check posterior: 195 archivos, 0 errores. Es anterior al fix de autoridad informativa siguiente; no acredita el código posterior ni E2E/release. |
| Último E2E dirigido de escritorio | **No aprobado**, tras 12,7 min. Superó asignaciones, aplicación del original y reimportación del original con perfil; el preparado reordenado produjo `IMPORT_EXPENSE_AUTHORITY` por observaciones redundantes generadas al pasar de gastos anchos/valores fijos a formato largo. Evidencia privada en `artifacts/workbook-assignment-results/`. |
| Regresión de autoridad informativa, antes y después | Antes: 40 pruebas, 38 aprobadas y 2 fallidas, incluido wrapper; reproduce `IMPORT_EXPENSE_AUTHORITY` en `GASTOS` del preparado. Después: libro/importaciones **94 aprobadas, 0 fallidas, 0 omitidas, 0 canceladas**, en 42,44 s. Conservación exacta de gastos completos, IDs/versiones/procedencia/importes, eventos, stock 10 y caja 0; cambios de campaña y cantidad tipada al mismo corte sin motivo rechazados con `409`, sin escrituras. |
| Suite integrada del backend actual, posterior a normalización canónica | **670 aprobadas, 0 fallidas, 0 omitidas, 0 canceladas**, SQLite y PostgreSQL real; duración 95,156 s. Incluye original→preparado sin mutar gastos, rechazo de discrepancias, v7, backup cruzado, revisiones heredadas sin alterar bytes y leases/cancelación. Check actual: 195 archivos, 0 errores. Seed privado con guardas y web/scheduler saludables con imagen actual. No acredita E2E/release. |
| E2E completo final del código actual | **42 de 42 aprobados**, sin filtro de proyecto/spec, en los 2 proyectos escritorio/móvil; duración 36,5 min (2.190,70 s). Escenario de libro: escritorio 19,0 min y móvil 13,2 min. Incluye los cuatro pasos, alta real de producto, corrección de celular, reglas del pedido, stock/costos, asignaciones antes de aplicar, perfil reutilizado sin remapeo y reimportación del preparado reordenado sin mutar gastos/IDs/eventos/apertura/stock/dinero. También descargas/preservación y 101 decisiones en ambos proyectos; 0 errores de consola en el recorrido comprobado. Artefactos privados `workbook-canonical-final-results` y `workbook-canonical-final-report`. No convierte en aprobadas las ejecuciones anteriores ni levanta el bloqueo de release. |
| Aceptación de release y producción | No realizada. El bloqueo crítico de Next documentado en **Bloqueo de auditoría** se mantiene; no se cambió Next ni se rebajó la auditoría. |

La normalización nueva evita tratar como corrección una observación redundante de concepto, proveedor, referencia, notas o campaña solo si coincide su valor y fuente con el gasto existente y no había observación original para esa clave. Conserva la procedencia original; no autoriza cambios automáticamente ni descarta diferencias reales. Guards de autoridad, merge informativo, escritor financiero, versiones y revisión permanecen. Contratos dirigidos/suite integrada comprobaron conservación exacta y bloqueo de cambios reales al mismo corte; el E2E final comprobó además la reimportación idéntica del preparado por navegador.

El preparado omitía las asignaciones de una guía única porque la preparación dejaba `assignments` vacío, mientras validación/aplicación utilizaban el fallback existente de todas las líneas. Se conserva la expectativa de exportar las asignaciones reales: no se acepta un preparado incompleto por pasar conteos de pedido/gastos. La regresión cubre líneas distintas, descarga previa, aplicación del preparado primero y reimportación del original sin generar identidades nuevas. Se sustituyeron comprobaciones del formato interno de `review_policy` por validación del `ruleSnapshot` y hechos del pedido real, sin reducir expectativas financieras.

La corrección posterior materializa en `prepareGroup` el fallback ya existente de todas las líneas para la primera guía única y captura asignaciones vigentes de guías existentes vinculadas. Exportación, simulación de inventario y aplicación consumen la misma lista congelada, sin un fallback duplicado en el cómputo asignado. No se modificaron writer, decoder, reglas financieras, identidades ni revisiones previamente aceptadas. La regresión pasó en dirigidos y en la suite integrada actual de ambos motores, incluyendo exportación al reencontrar una guía existente y conservación de IDs de eventos, costos y stock.

Los fallos de la primera suite completa fueron una respuesta de turno desactualizada durante una pausa posterior a terminar el trabajo —la base ya conservaba `cancelled`— y un fixture de respaldo que elegía una revisión arbitraria sin eventos y producía `TypeError` al intentar manipularlos. Cada caso afectó ambos motores y sus wrappers. La segunda ejecución detectó además el estado de disponibilidad descrito en la tabla. Ambas se conservan como ejecuciones rechazadas; el resultado final aprobado corresponde exclusivamente al código posterior a sus correcciones.

Los contextos de error iniciales localizaron la espera en el selector de reglas antes de subir el libro. Se corrigieron selectores accesibles y navegación del propio test, sin alterar expectativas financieras. El timeout por acción quedó en 30 s y se reutilizó el helper de disclosure existente para **Costos y obsequios**. El escenario final aprobado reutiliza el perfil sin reaplicar propuestas al libro reordenado, confirma solo el nuevo corte cuando corresponde y configura las tablas auxiliares del preparado. La preparación conjunta evita ciclos redundantes sin modificar la cadencia de producción. El plazo del escenario pasó de 600 s a 20 min para fases reales del scheduler, con polling de 120 s; expectativas de dinero/identidad intactas. Las ejecuciones rechazadas se conservan separadas de la aprobación final.

La continuación E2E detectó el conflicto real entre inspección activa y preview: guardar perfil reencolaba inspección aunque sus muestras siguieran vigentes. La corrección reutiliza muestras por hoja/encabezado y permite sustituir únicamente la fase interna `inspect`, revocando el token anterior para impedir publicaciones obsoletas. Las otras fases siguen protegidas; sin opción pública, reintento encubridor ni sustitución de leases de aplicación. La regresión pasó en dirigidos/suite integrada y el recorrido final aprobó la aplicación con celular corregido, stock y caja esperados. Guardar resoluciones por bloques no reencola inspección innecesaria.

La reanudación entre procesos conserva evidencia privada en **`.test-data/excel-onboarding-34ca0189/recovery-evidence.json`**. El primer checkpoint del harness esperaba incorrectamente `applying`; el estado durable entre turnos era `queued`. Se corrigió solo esa comprobación descartable y se continuó desde lo ya confirmado, sin reset ni repetición del primer turno, y sin cambio de código de aplicación. Los procesos terminaron normalmente con `--once`: **no se probó un SIGKILL ni caída a mitad de transacción**.

Los importes del smoke equivalen al resultado operativo esperado en COP; son datos sintéticos, no ventas del negocio real. El libro real se inspeccionó y configuró solo en el entorno privado, sin aplicar sus pedidos ni divulgar filas de clientes. Artefactos de trabajo bajo **`.test-data/excel-onboarding-34ca0189/` (privado)**; no deben incorporarse al repositorio, imágenes publicadas ni archivos estáticos. Las capturas de este pase son privadas y sintéticas; no se publican capturas de datos reales ni el libro bruto.

### Smoke manual observado en PostgreSQL privado

| Superficie | Resultado observado |
|---|---|
| Inicio sin negocio preparado | Base privada con 0 pedidos, personas, cuentas, entradas de caja, gastos, plataformas y nóminas; solo administrador. Entrada **Ya llevo mi negocio en Excel** y alta de origen inline realizadas por UI, sin exigir caja. |
| Plantilla y libro sintético | Descarga de plantilla de 13.712 bytes, 5 hojas con tablas solo de encabezados. Libro sintético completado con 7 hojas y primera `REVISION` vacía; configuración, corte y exclusión de `TOTAL CHATS` realizados en UI. |
| Producto y corrección | Stock contado 10; costo de catálogo 2.300.000 centavos; costo importado de línea 2.000.000. Celular originalmente vacío completado mediante resolución `cell_value`, sin alterar el original. |
| Apertura y reglas | Conteo físico `2026-10-01`; regla confirmada por UI desde `2026-09-01`, reconocimiento al entregar, comisiones deshabilitadas y gastos por fecha del cargo. Preview: 3 operaciones válidas, 0 errores, reserva 0, consumo posterior a apertura 0 y stock 10. |
| Preparado antes de aplicar | Descarga observada de 19.768 bytes; no se interpreta como prueba de reimportación de ese archivo. |
| Aplicación durable real | Scheduler completó 3 operaciones: 1 pedido, 1 envío y 5 gastos, de los cuales 3 directos y 2 logísticos. Sin personas, cuentas, nóminas, cobros ni caja disponible; disponible de caja 0. |
| Informe de septiembre por UI | Neto 11.000.000; costo vendido 4.000.000; transporte/seguro 1.300.000; publicidad 2.500.000; operación 1.000.000; contribución 5.700.000; resultado operativo 2.200.000, todos en centavos. Catálogo conservó costo de 2.300.000. |
| Pedido pendiente y movimientos posteriores | Pedido B manual de 3 unidades: stock 10, reserva 3, disponible 7. Devolución física recuperable de 1 unidad de A el `2026-10-02`: stock 11, reserva 3, disponible 8, comprobados por DOM/API; no se acredita una captura con ese contador visible. Guía B y evento `collected` del `2026-10-03` guardados por UI: stock 8, reserva 0, disponible 8, comprobados también por API privada. |
| Escritorio y móvil | Informe y pedido observados a 1440×900 y 390×844 sin desbordamiento; campaña `CAMP-7` visible. Escape cerró el diálogo y devolvió foco a **Pedidos**. Capturas privadas sintéticas finales de inventario, pedido, envío y gasto en móvil, y resultado en escritorio, obtenidas con Chromium/Playwright. La primera captura de pedido coincidió con animación y no se usa como evidencia final. No acredita todas las pantallas ni ausencia global de errores de consola. |
| Catálogo móvil tras despacho | Viewport 390×844 sin desbordamiento; texto visible «8 físicas · 0 reservadas · 8 disponibles», también en captura privada final `inventory-dispatch-mobile.png`. Costo actual de catálogo 2.300.000 e histórico de A 2.000.000 centavos, sin sustitución. |
| Detalle de gasto móvil | `expense-mobile.png` muestra **Datos importados**, cantidad 10 y procedencia, a 390×844 sin desbordamiento y con 0 errores de consola observados en esa comprobación focalizada. No se extrapola a toda la aplicación. |
| Perfil real privado reabierto, sin aplicación | Versión 2 recargada: 20 hojas, 16 seleccionadas y 15 de pedidos `order_rows`. Posiciones C/D/F/G/H/I/J/N/S verificadas en las 15; campaña en todas, 0 mapeos de celular sin significado confirmado y 149 columnas ignoradas explícitamente. `UND NEG` ambiguo conservado como adicional, sin corte inventado. Exclusiones de `REVISION`, `Hoja 3`, `Hoja 2` y `LISTANEGRA`; duplicación de publicidad A1:K32 comprobada. |
| Preview completo del libro real privado | 16 hojas revisadas: 5.562 grupos, 3.714 rechazados, 1.848 omitidos estructurales, 0 válidos. No se aceptó ni aplicó el libro real; no se ocultaron pendientes bajo un resultado exitoso. |
| Incidencias del preview real, no registros únicos | Años: 2.694; corte: 6.570; productos: 4.032; incompletos: 3.691; fila duplicada: 313; identidad duplicada: 388; `IMPORT_DATA`: 3; campo repetido: 4; fórmulas: 24; `EXCEL_DATE`: 2. Una operación puede presentar varias incidencias: no sumar como transacciones. |
| Descarga autenticada de copia ampliada real | 21 hojas, 1.386.043 bytes y 35 partes originales no modificables idénticas; SHA del original intacto, conservado únicamente en evidencia privada. No se publican los hashes ni se exige identidad del ZIP completo entre expansiones. |
| Negocio tras revisar y descargar el libro real | Conservó solo los 2 pedidos y 5 gastos sintéticos; stock 8, reserva 0, disponible 8, costo de catálogo 2.300.000 centavos. Cuentas, movimientos de caja, personas, sueldos y caja disponible: 0. La revisión y descarga no incorporaron hechos del libro real. |

Durante el smoke se observaron un bloqueo del driver tras emulación y un problema de opción TLS del controlador, reportados como incidencias de herramienta; no se atribuyen como fallos ni aceptación de la aplicación. La continuación con Chromium/Playwright permitió terminar las capturas sintéticas. Resumen agregado sin PII en **`.test-data/excel-onboarding-34ca0189/private-ui-evidence.json` (privado)**; libro, copia y evidencia detallada permanecen privados. La cobertura registrada se limita a las acciones que sí terminaron y se observaron.

### Alcance administrativo y de aceptación

La migración v7 requiere v6, preserva el historial y amplía categorías sin convertirlas en pagos. Su ejecución en SQLite descartable y PostgreSQL privado no autoriza un corte de producción: se necesita respaldo recuperable, validar la versión integrada en el motor destino, detener escritores antiguos, migrar y arrancar web/scheduler con la misma versión. Una importación aceptada congela su revisión, pero cada operación se confirma por separado; cancelar no deshace lo ya aplicado ni convierte un resultado parcial en completo.

Se observaron reapertura del perfil real y revisión completa sin aplicación, reimportación del original sintético con perfil, reimportación del preparado por UI sin duplicar/mutar hechos y reanudación del worker entre procesos normales con revisión congelada. Las regresiones reales de inspección/preview, asignaciones del preparado y autoridad informativa quedaron corregidas y verificadas por contratos y E2E posteriores. **No se acredita SIGKILL o caída a mitad de transacción, CI remoto, dispositivo móvil físico ni aceptación de release/producción**. El bloqueo crítico de Next permanece; no se usa la aprobación funcional aislada para rebajar seguridad.

### Cierre del entorno privado

El cierre de Compose terminó correctamente y retiró únicamente proxy, scheduler, web, base de datos y redes frontend/backend del proyecto **`excel-onboarding-34ca0189`**. No utilizó `--volumes`, no eliminó imágenes ni afectó servicios de producción. El Chromium privado se identificó por su perfil exclusivo: `TERM` devolvió éxito pero el proceso seguía presente; se terminó con `SIGKILL` y la búsqueda posterior por la ruta exacta del perfil no encontró procesos coincidentes. No se cerró el navegador del usuario. Se eliminaron los scripts descartables de smoke y el controlador final `runtime.mjs`; no quedan scaffolds ni comandos de cierre pendientes. Libro/copia genuina, datos, certificados y evidencia permanecen privados para su conservación, no como servicios publicados. No hubo deploy ni push.


## Asignación completa de columnas y seguro opcional · local · 27 de octubre de 2026

Implementación y pruebas en SQLite privado y proyectos Docker exclusivos con PostgreSQL `allnutrition_test`, HTTPS y scheduler real. **Sin push, despliegue ni migración de la base real. No hay aceptación integral de `verify:docker` ni imagen autorizada para producción en este pase.**

### Resultados observados

| Comprobación | Resultado |
|---|---|
| `npm run check` final | **180 archivos** JavaScript/JSX, cero errores de sintaxis/imports locales. |
| Build productivo final | Next.js **16.3.8** compilado correctamente con el selector y teclado finales, en `mapping-e2e-55f3188df8fc`. |
| Contratos del dominio actual, SQLite/PostgreSQL | **577 aprobados**, cero fallidos y cero omitidos, en `mapping-e2e-8df968bd9888`. Incluyen el perfil heredado duplicado en ambos motores. |
| Migración 6 y seguro | CHECK real v5, relaciones, rollback, repetición y alta nueva; seguro opcional, cero/desconocido, fecha pendiente, cortes y autoridad. Contribución, informes, deducciones por guía e idempotencia sin pagos automáticos. |
| Respaldo v3 | SQLite→PostgreSQL y PostgreSQL→SQLite reales; observaciones, procedencia, primas/pagos y perfil heredado conservados; datos inválidos rechazados atómicamente. |
| E2E final, escritorio/móvil | **36 aprobados** sobre HTTPS/PostgreSQL y scheduler real; `mapping-e2e-55f3188df8fc`, **código 0**. Incluye Tab/Shift+Tab, Escape con búsqueda y foco de retorno. |
| E2E intermedio, previo al último ajuste de foco | **35 aprobados / 1 fallido** en `mapping-e2e-8df968bd9888`. El importador pasó en escritorio y móvil; falló la reapertura del editor de comisión en `app.spec.mjs:560`. |
| `npm run verify:docker` original, sin modificar | Build/check y **575 contratos** aprobados; **código 1 en auditoría**, antes de E2E y las fases operativas posteriores. Ejecución `5cf59da73179f7bb`. |

El fallo E2E intermedio esperaba `Comisión (%) = 5,25` al reabrir las reglas. El PUT había devuelto `200` y el GET comprobado conservaba `525` puntos básicos; la captura mostró la comisión deshabilitada en el formulario reabierto. Se conservan captura, contexto y traza. No se modificaron el editor ni las expectativas de comisiones para ocultarlo.

En el pase final el escenario de comisiones pasó en ambos proyectos. No se determinó la causa del fallo anterior ni se lo considera reparado por haber pasado después; su evidencia permanece disponible.

### Bloqueo de auditoría

`npm audit --omit=dev --audit-level=high` notificó **una vulnerabilidad crítica en Next.js 16.3.8**, rango informado `16.0.0–16.4.0`: [SVG/Image Optimization](https://github.com/advisories/GHSA-2464-fhr4-w9xw), [Server Actions](https://github.com/advisories/GHSA-p3m5-59mp-jv5r) y [`use cache` con typed arrays](https://github.com/advisories/GHSA-673q-mjm6-r5xr). Propuso `next@16.4.3`, fuera de la versión fijada.

En aquel pase no se actualizaron dependencias ni se relajó la auditoría. Las comprobaciones independientes no sustituían la aceptación bloqueada. **Bloqueo levantado posteriormente** con Next `16.4.3` y las aceptaciones/publicación del 30 de octubre documentadas al inicio; se conserva este resultado histórico.

### Smoke de UI real

- Navegador real a **1440×900** y **390×844**, sin desbordamiento horizontal: búsqueda por seguro/entrega/referencia, categorías, flechas/Inicio/Fin/Enter, Escape con búsqueda no vacía y retorno de foco. Tab/Shift+Tab comprobados en ambos límites del selector; un solo diálogo portaleado.
- Archivo sintético con dos encabezados `Estado` separados por posición: administrativo `PAGADA`, seguimiento `Entrega Exitosa`, entrega logística independiente, valor declarado/solicitado **55.000 COP**, prima **1.000 COP**, flete cero conocido y dos adicionales. Revisión, importación completa y reimportación móvil **sin cambios**, conservando guía, evento, gastos y procedencia.
- Detalle de envío y sección de envíos del pedido muestran datos importados de solo lectura por fuente. El destinatario observado no sustituyó al del pedido. Informe de septiembre: **Transporte y seguros = 1.000 COP**; caja, cobros y pagos idénticos antes/después, con disponible **100.000 COP**. El sueldo sintético pendiente es independiente y no se pagó.
- **200 columnas** con encabezados repetidos/largos, muestra de texto completo y texto escapado: catálogo completo accesible, grupos **1–50**, destino ocupado deshabilitado por grupo, ambos conflictos señalados y guardar/revisar enfoca el primero. Se corrigió y guardó un perfil antiguo duplicado sin perder ninguna asignación; **198 columnas ignoradas explícitamente**. Los dos lotes de esta prueba se descartaron sin aplicar.
- `Historial Guías.xlsx`, solo en el entorno privado: `Sheet1`, encabezado 2, **15 columnas**, C administrativa y E de seguimiento. K–N conservadas como adicionales, sin inferir corte, prima, flete ni recaudo. Perfil guardado/reabierto, `IMPORT_CUTOFF_REQUIRED` localizado y original privado legible durante revisión; **lote descartado antes de aceptar**, original privado eliminado. Pedidos, envíos, eventos, gastos, caja, cobros y pagos conservaron conteos y hashes exactos.
- Cero entradas de error de navegador al cierre, sin entradas descartadas del registro. Capturas solo de datos sintéticos; la prueba del archivo real tiene resumen sanitizado, no capturas de sus filas.

Evidencia local privada en **`.test-data/column-mapping-5pke9j/`**: `real-review-proof.json`, `mapping-200-proof.json`, `browser-close-proof.json`, línea base y comparación financiera, capturas antes/después, revisión, detalle de envío/pedido, informe y caja. El directorio y la SQLite tienen permisos `0700`/`0600`; la SQLite conserva historial fuente del lote real descartado y **no debe publicarse**.

E2E final: **`.test-data/docker/mapping-e2e-55f3188df8fc/artifacts/`**, con `independent-e2e-result.json`, `independent-e2e.log` y resultados/capturas Playwright. Contratos y E2E intermedio: **`.test-data/docker/mapping-e2e-8df968bd9888/artifacts/`**, incluido `node-contracts-result.json` y la traza del escenario rechazado. Bloqueo nativo: **`.test-data/docker/5cf59da73179f7bb/artifacts/result.json`**. Web, worker y pestaña SQLite retirados; proyectos Docker eliminados con sus volúmenes y runner temporal retirado. No se acredita CI remoto, dispositivo móvil físico ni publicación.

## Cancelación publicada · aceptación nativa y producción · 19 de octubre de 2026

Fuente de aplicación `cfaee8070f45ec78fe9903af82205cdcf165b780`, publicada en `origin/trunk`. Commits separados: `d11a4dc` (dominio/API/migración), `ad050af` (importador), `23936a8` (contrato y evidencia local) y `cfaee80` (preparación PostgreSQL). Git archive SHA-256 `3a74fe2b4b2e1184dcec99ddb26d769384f160161d6a86f1b9c62b8ac3b0c5e1`. La documentación posterior no reconstruye la imagen.

Imagen aprobada y ejecutada por **web y scheduler**: `allnutrition:release-73620e997c62`, ID `sha256:73620e997c629329a2a77c6974da899a42e44595242e54d1212295c9529e11f7`; Linux/amd64, Node **24.22.0**, UID **1000**, Next.js **16.3.8**.

### Aceptación nativa y recuperación previa

`npm run verify:docker -- --interactive`, ejecución **`cbb6674080e6a41a`**, terminó con **código 0**. Controlador Node 24.21.0, Docker 29.8.1 y Compose 5.5.1.

| Comprobación | Resultado observado |
|---|---|
| Build y sintaxis | Build productivo correcto; **172 archivos** JavaScript/JSX, cero errores. Runtime sin herramientas de desarrollo. |
| Contratos SQLite/PostgreSQL | **535 aprobados**, cero fallidos y cero omitidos. |
| E2E escritorio/móvil | **36 aprobados**. |
| Auditoría de dependencias de producción | Cero vulnerabilidades notificadas. |
| UI de cancelación sobre la imagen nativa | Descarte local sin cambios en la base; cancelación del original guardado `200`, estado `cancelled`, original `404` y hechos comerciales intactos. La cancelación no añadió revisión comercial; las dos revisiones internas correspondieron a crear/subir el borrador. |
| Importación terminada | `canCancel=false`, intento posterior `409` y original todavía `200`. |
| Recorrido comercial | Main y reordenado sin duplicar venta; recepción/retenciones, sueldo/comisión, informe de septiembre, costo prospectivo, devolución, reembolso y flete comprobados desde formularios reales. Snapshot y alerta procesados con todos los paneles cerrados; repetición sin hechos duplicados y mismo episodio resuelto solo tras el aporte real. |
| Reinicio y móvil | Revisión válida de 60 guías con scheduler activo; cola 0 con worker detenido y cancelación habilitada a **390 px**, sin desbordamiento. El verificador comprobó **0→25→60**, reinicio y repetición sin ventas ni dinero adicionales. |
| Operación aislada | Rol runtime sin DDL, rechazo de CA incorrecta y TCP sin TLS, caída real con 503 y recuperación, persistencia de WebP/datos/sesiones y dump/restore separado aprobados. |

Un primer pase fue rechazado por `Query read timeout` en **la preparación `TRUNCATE`**, antes de ejecutar tres escenarios; PostgreSQL esperaba fsync. Se amplió únicamente esa consulta de limpieza descartable a **120 s**. El límite de consultas del runtime sigue en **15 s**; no se modificaron expectativas funcionales ni se promovió la imagen fallida.

Recuperación independiente con la imagen final: dump nuevo de producción por TLS, **42 tablas / 65 filas**, restaurado en `allnutrition_recovery_d6e2bf32be`. Tras migrar, las **41 tablas restantes** conservaron conteos y hashes completos; marcadores **[2,3,4]→[2,3,4,5]** y filas previas de migración intactas. Conexión `allnutrition_app` con TLS verificado; clon/red/volumen retirados. Evidencia `recovery-approved/result.json`; dump SHA-256 `21a7fca6174138688226a97905bc6c30464679e21a1c468c7f1710f12ff7857f`.

### Corte y comprobación del dominio real

Producción **https://allnutrition.wintimeapp.co** actualizada entre **21:26:10 y 21:27:34 UTC**:

- Respaldo final con **ambos escritores detenidos**: dump de 42 tablas, listado y bloques comprimidos validados; archivo separado de medios y copia de las fuentes reemplazadas.
- Migración 5 validada antes del arranque: contenido exacto de las 41 tablas ajenas a `migrations` y filas de marcadores 2/3/4 intactos; solo se añadió el marcador 5.
- Mismo contenedor PostgreSQL, configuración/contraseñas/TLS y proxy Nginx. Los dos escritores arrancaron con el ID aprobado, sin rebuild, y el scheduler emitió un heartbeat nuevo.
- Salud pública y catálogo `200`; cuatro WebP comparados con sus bytes almacenados (**494.094 bytes**). Catálogo y volumen de medios conservados.
- Sesión propia creada antes del corte todavía válida (`200`); cierre posterior y rechazo del token revocado (`401`), sin revocar otras sesiones.
- Cancelación sin sesión `401`, sin CSRF `403` y sobre ID confirmado inexistente `404`. No se cancelaron ni reimportaron lotes reales.
- UI real en escritorio y **390×844**, cero errores de navegador observados y ancho documental **390 px**. `Historial Guías.xlsx` conserva su estado/diagnóstico histórico, configuración y original; **Descartar archivo** aparece habilitado. La comprobación fue de lectura, no una corrección ni reaplicación del lote.

El primer corte se detuvo **antes de intentar migrar**: `tar` dentro del contenedor creó el respaldo de medios con su propia umask, y la barrera de permisos privados lo rechazó. Se recuperaron fuentes/selector y escritores v4, con salud comprobada y marcadores 2/3/4. Se conservó ese intento, se creó el archivo de respaldo con modo **0600 desde el inicio** y se repitieron preflight, congelación y respaldos nuevos; únicamente el segundo corte llegó a esquema 5. No se restauró ni degradó automáticamente la base.

Evidencia privada de corte: `/home/allnutrition/cancel-release-d6e2bf32be/` y `.test-data/cancel-release-d6e2bf32be/` local. `production-frozen-v4.dump` SHA-256 **`359029e7dc7a80abce626697b45393c6c6b6ceb987f84dd5b5283695f0265509`**; `production-frozen-media.tar` SHA-256 **`4ed0f12b2696ccb16d3fa51e4c33c431e90e57606d777acff46ee774ea7d46f1`**. Aceptación nativa en `/home/allnutrition/cancel-release-d6e2bf32be-candidate/.test-data/docker/cbb6674080e6a41a/artifacts/`; recorrido UI adicional en `native-ui/` local y `native-ui-evidence.tar` remoto.

No se acredita CI remoto, dispositivo móvil físico ni una política nueva de copias cifradas/off-host. Los respaldos manuales no sustituyen esa política. Una imagen v4 aislada **no es rollback seguro** después de esta migración.

## Cancelación de importaciones · verificación local · 19 de octubre de 2026

Verificado sobre Next.js **16.3.8** compilado y Node **24.14.1**, con SQLite aislado y PostgreSQL **16** en un contenedor propio publicado únicamente en loopback. La suite PostgreSQL usó `allnutrition_test`, la autorización explícita de reset y `DB_SSL=disable` solo en esa conexión local. Chromium accedió mediante HTTPS de localhost con certificado de prueba. **Este pase local fue anterior a la aceptación nativa y al corte documentados arriba.**

| Comprobación | Resultado observado |
|---|---|
| `npm run check` | **179 archivos** JavaScript/JSX, cero errores de sintaxis/imports locales. |
| Suite Node completa con entorno PostgreSQL descartable | **535 aprobadas**, cero fallidas y cero omitidas; SQLite y PostgreSQL reales. |
| `npm run build` | Compilación y generación correctas; incluye `POST /api/admin/imports/[id]/cancel`. |
| Migración 5 | Conservación de originales, perfiles, revisiones, filas, usuarios, sesiones e historia SQLite v4; claves foráneas restrictivas, idempotencia y rollback del reemplazo de tabla al fallar el marcador. Esquema PostgreSQL 5 ejercido por los contratos reales. |
| Cancelación y worker | Borrador, inspección en cola/ejecutándose, preparación, revisión aceptada en cola y aplicación parcial. Barreras después de commits reales comprobaron que un worker revocado no aplica el grupo siguiente ni publica una revisión tardía. |
| Terminación y revisiones posteriores | Rechazo `409` cuando la última operación ya confirmó aunque siga `applying`, después de terminar con/sin excepciones y durante la revisión/reaplicación de pendientes de un lote antes terminado. |
| Respaldo | Restauración de cancelación parcial sin reencolar ni perder hechos; huellas comerciales de productos válidas aceptadas y huellas arbitrarias rechazadas antes de restaurar. |
| Archivo local | Descarte antes de enviar y nueva selección del mismo archivo; origen conservado. |
| Creación con respuesta retenida por CDP | Cancelación disponible antes de recibir el ID; resultado `cancelled`, cero PUT de archivo y URL del resultado conservada. **Nuevo lote** vuelve a abrir el selector. |
| Upload recibido, respuesta todavía retenida | Se comprobó un hash guardado real antes de cancelar. Cancelación `200`, original `404`, respuesta antigua sin resucitar archivo/paso y resultado móvil de **390 px**, sin overflow horizontal. |
| Parcial y excepciones | Hechos comerciales/contadores idénticos antes y después de cancelar. Se conservó un grupo y se detuvo su liquidación pendiente. Otra cancelación conservó dos grupos y una excepción anterior, detuvo la declaración restante y explicó el error como historial; repetir el worker procesó **0 operaciones**. |
| Diálogo móvil | Descarte desde el resolver, sin exigir completar sus campos; cierre correcto y original `404`. Tres acciones accesibles a 390 px, alturas superiores a 44 px, captura después de finalizar la animación. |
| Pantalla antigua tras finalizar | El control antiguo seguía habilitado, pero el servidor devolvió **409**. La pantalla cargó `completed`, sin controles de descarte/cancelación; original todavía **200**. |
| Frontera HTTP | Cancelación autenticada **200**, sin sesión **401** y sin CSRF **403**. |

Durante el humo se reprodujo un problema del flujo nuevo: cancelar antes de terminar la creación dejaba el resultado sin ID en la URL y **Nuevo lote** no abría el formulario. Tras conservar la URL del lote cancelado, se repitió la respuesta retenida y se comprobó la apertura del siguiente lote. La restauración también detectó la validación antigua de versiones enteras sobre las huellas comerciales de productos; se corrigió y quedó cubierta sin relajar los demás destinos.

Evidencia sanitizada y capturas finales en **`.test-data/import-cancel-745d0bcc/smoke.json`** y su directorio. Los Excel de este pase son sintéticos: no se reimportó `Historial Guías.xlsx`, no se accedió a producción ni se acredita una nueva aceptación Docker/amd64, suite E2E completa, CI remoto o dispositivo móvil físico. Los escritores, navegador y PostgreSQL de prueba se retiraron; se conservan únicamente evidencia y datos locales aislados.

## Importación recuperable y diagnóstico publicados · 18 de octubre de 2026

Producción **https://allnutrition.wintimeapp.co** actualizada entre **19:58:15 y 19:59:14 UTC**. Fuente de aplicación `1f51ad4269614f2e6135e8ead2263da485dbc3db`, publicada en `origin/trunk`; Git archive SHA-256 `085b2fbb1dbcaf1558b68e46f8b8eb04652e8e3bb8ab957c3a1e356074da3528`. Los commits posteriores de documentación no reconstruyen la imagen aprobada.

Imagen ejecutada por **web y scheduler**, sin rebuild: `allnutrition:release-1bc0af86a251`, ID `sha256:1bc0af86a251cc433bfd9dcf55cc7318e79b3789beb0aa584402b94968ae5acb`, Linux/amd64, runtime Node **24.22.0**, UID **1000**. El contenedor PostgreSQL permaneció siendo el mismo.

### Aceptación nativa y correcciones del recorrido

`npm run verify:docker -- --interactive`, ejecución **`196c12cbe881b794`**, terminó con **código 0**. Controlador Node 24.21.0, Docker 29.8.1 y Compose 5.5.1.

| Comprobación final | Resultado observado |
|---|---|
| Build y check del contenedor | Next.js 16.3.8 compilado; 169 archivos JS/JSX revisados, cero errores. |
| Contratos SQLite/PostgreSQL reales | **510 aprobados**, cero fallidos y cero omitidos. |
| E2E serial escritorio/móvil | **36 aprobados**, incluidos archivo/resolver, recarga y fronteras HTTP. |
| Auditoría productiva | Cero vulnerabilidades conocidas en la ejecución consultada. |
| Recorrido comercial por UI | Principal y reordenado sin duplicados; liquidación 105.000, nómina 15.500, septiembre 37.500, costo prospectivo 30.000, devolución/reembolso/retorno y banco 127.500→128.000. |
| Atención de alerta | Casilla «En atención» marcada y estado comprobado manteniendo 127.500 por debajo del mínimo 128.000; después, aporte real sintético de 500 y resolución del mismo episodio. |
| Reinicio sin paneles | Lote real de 60 grupos aceptado con scheduler detenido: **0→25→60**, misma revisión, sin nuevas ventas ni dinero y sin duplicación al repetir. |
| Operación y recuperación | CA/hostname, runtime sin DDL, migración idempotente, caída con 503 y recuperación sin pedidos adicionales, sesiones/WebP tras restart y dump/restore en base separada. |

Dos ejecuciones previas se rechazaron, no se promovieron: `605ce67539939dcc` detectó que el E2E intentaba abrir «Crear plataforma» sin entrar en **Nuevo lote**; se corrigió únicamente ese recorrido en `1f51ad4`. `f4ecbe57614f8917` aprobó los 36 E2E, pero el operador guardó el aviso sin marcar la casilla «En atención»: el verificador rechazó correctamente la ausencia de ese estado intermedio. No requirió cambiar el producto ni debilitar la comprobación.

Humo PostgreSQL adicional con esas mismas fuentes: dos diagnósticos desde UI conservaron exactamente **38 tablas operativas** y los hashes de los informes septiembre/octubre; solo aumentaron los recibos aislados **0→1→2**. Corresponde al segundo recorrido, no a su aprobación integral fallida. Las capas de filesystem coinciden con la imagen final; la diferencia de configuración identificada es la etiqueta de proyecto Compose. Evidencia privada: `.test-data/native-retry-ui/diagnostic-isolation.json`.

El controlador de navegador sufrió fallos de conexión/espera; el recorrido final se completó con Chromium Linux nativo mediante CDP privado, retomando los lotes ya guardados. No se atribuyen esos timeouts al producto ni se presenta este pase como cronometraje de usabilidad.

### Recuperación real y corte conservador

Se restauró un respaldo real en clones exclusivos y se comparó el runtime anterior con el candidato final mediante el rol limitado, TLS y transacción `READ ONLY`: **42 tablas**, exportación comercial, contraseñas, configuración y medios idénticos. Los cuatro archivos de imágenes también se extrajeron y cotejaron independientemente. Los clones se eliminaron; no se restauró sobre producción.

Durante el corte se detuvieron solo web y scheduler. Se tomaron respaldos nuevos, se repitió v4 idempotentemente con la imagen aprobada y se compararon exactamente las 42 tablas/exportación/contraseñas/settings/medios antes de reabrir los escritores. `.env.server.local` mantuvo SHA-256 `c5fc55f11e4d0d7032c6fc009e39a322c91991ab42f9771ea4db98045be29b0b`; solo cambió `APP_IMAGE` en el selector. Sin setup, seed, reset, cambio de claves, Nginx, DNS ni firewall.

Directorio privado **`/home/allnutrition/import-release-0c834d19a4/cutover/`**, archivos `0600`:

| Respaldo final | Bytes | SHA-256 | Verificación |
|---|---:|---|---|
| `allnutrition-20261018T195834Z.dump` | 173532 | `184679947f65aba09213d419416e70bfbb4b4b7b6d1e222fa29aae44e58557d7` | Catálogo `pg_restore --list`; el restore real se ensayó con el dump previo, no sobre la base activa. |
| `product-images.tar.gz` | 494862 | `9898f86d8173008adcda6d3acc6359df599c32bd39bf7201ae1770eb9bf3cc70` | Catálogo tar; extracción independiente previa y cuatro archivos/hashes conservados. |
| `source-before.tar.gz` | 181217 | `005dc4835664f894fe9a0084d53deadeb0c9bf490c01ddf5c55dc5cc386f2e4b` | Las 21 fuentes sobrescritas; sin env ni datos comerciales. |

El dump previo restaurado fue `recovery/allnutrition-20261018T171204Z.dump`, SHA-256 `15fd7790d327056e91296211d96579373e2e58a2a439fa35c05bc6fcabc19188`. Rollback compatible v4 conservado: `allnutrition:release-fd6be0fc71de`, selector `cutover/rollback.env.release.local` y fuentes anteriores. Recrear juntos web/scheduler; nunca degradar ni restaurar automáticamente la base. No se añadió programación, retención ni copia cifrada off-host.

### Dominio real después de publicar

| Superficie ejercitada | Resultado observado |
|---|---|
| Salud pública | HTTPS 200, `{"ok":true}`, con confianza normal del certificado. |
| Sesión anterior | Siguió autorizando onboarding 200 con el mismo token; cookie Secure/HttpOnly/SameSite=Strict. |
| Guía | Caja «Realizado» con cuentas/responsables activos y motivos; importación expresamente opcional. No se inventaron datos para completar las demás etapas. |
| Lote real | El mismo `Historial Guías.xlsx`, mismo hash del original local y configuración `Sheet1`/encabezado 2; diagnóstico legible dentro del importador. |
| Navegación y recarga | Inicio→Pedidos→Importar Excel→Retomar lote y reload conservaron el lote, sin fallback de página completa. |
| Móvil administrativo | 390×844; documento de 390 px y cero errores JS observados en el recorrido. |
| Logout propio y vitrina | API de onboarding 401 tras cerrar únicamente la sesión del smoke; vitrina anónima con cuatro productos y cuatro WebP 200. |
| Móvil público | Menú→Catálogo, diálogo cerrado y ancla visible bajo la cabecera; sin overflow horizontal. |
| Conservación final | Solo variaron `job_runs` y la sesión propia revocada: 2 sesiones durante el corte, 1 ajena al smoke al terminar. Usuarios/contraseñas, configuración, medios y las demás tablas exactos; cero pedidos reales. |
| Scheduler | Heartbeat de 22 segundos en la comprobación final; lectura limitada sobre PostgreSQL con TLS. |

El error histórico `EXCEL_HEADER` carece de categoría moderna: se muestra como causa no determinada, sin afirmar que el archivo esté dañado. No se reintentó, reconfiguró ni aplicó ese lote real durante el despliegue. La revisión completa de sus 339 filas sigue acreditada por el humo aislado descrito más abajo, no por una importación comercial en producción.

Evidencia nativa: `/home/allnutrition/import-release-0c834d19a4-candidate-1f51ad4/.test-data/docker/196c12cbe881b794/artifacts/`. Recuperación/corte: `/home/allnutrition/import-release-0c834d19a4/{recovery,cutover}/`. Evidencia local sanitizada y capturas en `.test-data/import-release-0c834d19a4/`. No se acredita CI remoto, estudio humano cronometrado, checkout, pagos ni logística externos.

## Inventario autorizado: devoluciones con instantes empatados · 18 de octubre de 2026

Tras autorizar el usuario ampliar el alcance, se aisló el 409 de inventario: una devolución nueva podía ordenarse antes por UUID si compartía el instante de registro con otra anterior, consumir su unidad despachada y dejar sin respaldo la atribución ya persistida. Se reprodujo de forma determinista para una devolución previa recuperable y otra irrecuperable. La corrección reserva todas las atribuciones previas antes de asignar nuevas, sin cambiar la fecha, IDs, documentos de dinero ni reglas comerciales. Eliminar la evidencia de despacho continúa rechazándose con 409.

Humo adicional mediante las APIs de dominio reales sobre SQLite en memoria: producto con tres unidades, pedido de dos, despacho parcial de una y dos devoluciones irrecuperables. Un reloj controlado hizo que la segunda se registrara antes que la primera; no se alteraron manualmente los documentos persistidos.

| Resultado del humo | Antes de corregir | Después de corregir |
|---|---:|---:|
| Segunda devolución | 409 | Guardada |
| Existencias finales | 2 | 1 |
| Unidades reservadas | 1 | 0 |
| Documentos de devolución | 1 | 2 |
| Movimientos de caja | 0 | 0 |

| Comprobación final | Resultado observado |
|---|---|
| `node --test tests/business-inventory.test.mjs` | **15 aprobadas**, cero fallidas; incluye las regresiones deterministas y la protección de evidencia de despacho. |
| `env TEST_DATABASE_URL= TEST_ALLOW_DATABASE_RESET= npm test` | **430 aprobadas**, cero fallidas, **una omitida** por no configurar PostgreSQL descartable. Código **0**. |
| `npm run check` | **176 archivos**, cero errores de sintaxis/imports locales. |
| `npm run build` | Compilación y generación aprobadas, código **0**. |

El bloqueo anterior queda resuelto, no ignorado ni ocultado mediante reintentos. Tres intentos de corrección en total —dos del importador y uno de inventario—, dentro del máximo de veinte. Evidencia privada en `.test-data/import-preview-zf44ag/{verification,inventory-verification}.json`. No se acredita PostgreSQL, CI remoto, push, despliegue ni cambios de producción.

## Importación recuperable de Historial Guías · 18 de octubre de 2026

Verificación local sobre Next.js **16.3.8** compilado, Node **24.14.1**, Chromium y dos bases SQLite aisladas. No se accedió a producción ni se ejecutaron comandos de migración. El Excel original permaneció intacto y no se añadió al repositorio: SHA-256 anterior, posterior y del original descargado por la API `45ae9ead4fd8003e7547e3ec1cf153c83cb739e474af1099698fbc9495d3284f`.

### Causa y recorrido comprobados

`Historial Guías.xlsx` contiene una hoja `Sheet1`, **341 filas y 15 columnas**: portada en fila 1, encabezados en fila 2, dos columnas «Estado» y **339 filas de datos**. La lectura parcial informaba 1×1 sin dimensiones completas; configurar el encabezado real provocaba `EXCEL_HEADER` y el objeto de error terminaba en la pantalla completa «No pudimos cargar la página». Se reprodujo esa cadena en una compilación anterior, no la duración de 5–10 minutos reportada en producción.

Tras corregir dimensiones y renderizado se recuperó **el mismo lote ya fallido**, sin cambiar artificialmente la extracción ni subir de nuevo sus bytes. La extracción de comprobación asignó ID externo de envío, guía, transportadora, destinatario, teléfono y ciudad, con propósito de seguimiento. No se inventaron productos, cantidades, precios ni semántica financiera o fechas del reporte: el archivo no contiene las líneas comerciales necesarias para crear ventas completas.

| Variante aislada | Saldo de apertura añadido al fixture (COP) | Filas de revisión válidas | Grupos rechazados |
|---|---:|---:|---:|
| Caja en cero | 0 | 339 | 0 |
| Caja positiva | 12.345 | 339 | 0 |

Ambas variantes llegaron al paso **3. Revisión** en navegador. Diez tablas de hechos comerciales conservaron sus filas frente al fixture de origen; la única diferencia intencional de preparación fue la nueva cuenta sintética y su apertura positiva. No se aceptaron ni aplicaron los grupos de este archivo.

Una extracción con encabezado **999** produjo diagnóstico de configuración con hoja/fila, acción y código `EXCEL_HEADER`, sin romper el panel. Se navegó a Inicio, volvió a la entrada de importaciones, retomó el lote y recargó: conservaba archivo y encabezado 999. Corregir a 2 generó otra revisión de 339 filas en el mismo lote. Una copia truncada produjo diagnóstico de archivo `EXCEL_INVALID`, conservó el original de su lote y permitió navegar. Durante la generación de fondo también se salió del panel; la revisión solo se mostró al existir un resultado real. Vista móvil **390×844**, sin desbordamiento horizontal.

### Comandos y fallo posteriormente resuelto

| Comprobación | Resultado observado |
|---|---|
| `node --test tests/business-imports.test.mjs tests/import-excel.test.mjs` | **59 aprobadas**, cero fallidas u omitidas. Incluye dimensiones ausentes, recuperación, diagnóstico, disponibilidad, reversión y rechazo de revisiones obsoletas. |
| `npm run check` | **176 archivos**, cero errores de sintaxis/imports locales. |
| `npm run build` | Compilación y generación aprobadas, código **0**. |
| Primer `npm test`, con conexión PostgreSQL de pruebas vacía | **426 aprobadas**, cero fallidas, una omitida PostgreSQL. |
| `npm test` anterior a la ampliación de inventario, después de añadir la regresión de relectura pendiente | **425 aprobadas**, dos fallos contabilizados —la subprueba de devolución irrecuperable y su contrato SQLite padre—, una omitida PostgreSQL. |

El fallo detectado estaba en `tests/business-inventory-contract.mjs`, caso «una devolución irrecuperable despachada no descuenta dos veces y una pendiente sí consume»: el cálculo de atribuciones devolvía 409. Se detuvo la ampliación de alcance para consultar al usuario; tras su autorización se corrigió inventario con regresión y commit independiente, como se detalla arriba. La suite final quedó aprobada; no se reintentó sin cambios para ocultar el fallo.

Dos intentos de corrección del importador: el primero pasó los contratos pero el navegador detectó que un lote ya fallido con configuración guardada no reencolaba sus muestras; se añadió una regresión fallando antes y pasando después. Evidencia privada sanitizada en `.test-data/import-preview-zf44ag/{baseline,verification}.json` y capturas del recorrido. No se acredita ejecución PostgreSQL, E2E completo, CI remoto, push ni despliegue.

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
