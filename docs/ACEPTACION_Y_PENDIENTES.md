# Aceptación de All Nutrition v3

Realizar estas comprobaciones en Next.js compilado y en un entorno de revisión separado. Consultar `REQUISITOS_Y_DECISIONES.md` para distinguir respuestas del cliente, instrucciones posteriores y reglas propuestas.

Las existencias por producto, avisos de agotamiento, importación histórica y **esquema 9**, con **Next.js 16.4.3**, aprobaron aceptación nativa completa y promoción al dominio real el **6 de noviembre de 2026 (Bogotá)**: 1258 contratos y 48 E2E sin fallos/omisiones, recuperación real ensayada y respaldo final. El lote autorizado quedó aplicado: 300 pedidos/guías, 329 unidades y 19.321.000 COP, sin cobros ni saldos físicos inventados. Evidencia y límites en [VERIFICACION.md](VERIFICACION.md); este documento conserva el recorrido para próximas aceptaciones.

La corrección de **Flete / costo de envío** se publicó después, el **7 de noviembre de 2026**, como `allnutrition:release-206306367028`: aceptación nativa nueva de 1258 contratos y 48 E2E, recuperación real de 56 tablas y edición compilada en clon aprobadas. En producción se inspeccionaron escritorio/móvil y el formulario sin guardar gastos; los 300 fletes siguen exactos por guía, por 5.022.141 COP. No hubo reimportación, migración ni movimiento de caja.

**Caja clara y guiada** se publicó el **7 de noviembre de 2026, 12:57:52 Bogotá**, como `allnutrition:release-e91b4832ea0e`: aceptación nativa nueva de **1263 contratos y 54 E2E**, recuperación real de 56 tablas y humo compilado en clon aprobados. Se verificaron resumen, gasto pendiente, cierre consultado y guía de teclado en producción de escritorio/móvil, sin guardar operaciones financieras reales. Respaldo final congelado y copia externa comprobados antes de promover; mismo esquema 9, PostgreSQL preservado y ninguna reimportación. Detalles y límites en [VERIFICACION.md](VERIFICACION.md).

**Informes y Publicidad sencillos y guiados** se publicaron el **8 de noviembre de 2026, 16:34:42 Bogotá**, como `allnutrition:release-f0474580c564`: aceptación nativa nueva de **1268 contratos y 64 E2E**, con las 17 compuertas oficiales, recuperación real y UI en clon aprobadas. Producción conserva esquema 9, PostgreSQL, datos comerciales, fletes y medios; respaldo final congelado y copia fuera de VM verificados antes de promover. Sesión anterior, consultas persistentes, guía de teclado, escritorio/móvil y logout comprobados sin guardar operaciones comerciales. Meta sigue deshabilitado; detalle y límites en [VERIFICACION.md](VERIFICACION.md).

## Instalación y acceso

- Ejecutar `npm run verify:docker -- --interactive` con Node24, Docker/Compose, OpenSSL, puerto9443 libre y Chromium. Mantiene build, check, contratos SQLite/PostgreSQL reales, auditoría, E2E, TLS, rol limitado, caída/reinicio y restore.
- Usar únicamente el entorno descartable generado. El recorrido comercial no carga env de producción ni prepara pedidos/cobros por fuera de la UI.
- Probar acceso, cierre de sesión, caducidad y cambio de contraseña; comprobar revocación de sesiones.
- Sin sesión, no deben estar disponibles pedidos, panel ni exportaciones. Rechazar escrituras con origen o CSRF inválido.
- Confirmar cookies HTTPS, APP_URL y orígenes de preview sin aceptar cualquier Host.
- Verificar que secretos, respaldos y datos no están en el repositorio ni en recursos públicos.
- Verificar separación entre una vitrina aún no aprobada y la previsualización del administrador.

## Puesta en marcha sin soporte

- Con una cuenta nueva y negocio vacío, abrir **Inicio → Abrir guía de inicio** y cronometrar hasta completar Caja, Producto, Pedidos y recibir la práctica: máximo diez minutos.
- Confirmar el saldo real de apertura, incluido cero; comprobar caja editable, responsable reutilizado y cuentas/avisos predeterminados. Volver o reintentar no duplica personas, cuentas ni aperturas.
- Crear el primer producto sin salir de la guía con nombre y precio, dejando opcional el conteo físico real; confirmar disponibilidad administrativa con existencias desconocidas o positivas, sin foto/costo/inventario inventados ni publicación automática. Cero debe guardarse sin habilitar ventas nuevas.
- Confirmar reglas vigentes sin modificar su historia; comprobar que los detalles avanzados son opcionales y accesibles.
- Con caja, productos y pedidos ya guardados, abrir la guía sin las marcas antiguas de confirmación: comprobar etapas «Realizado» con motivos concretos y resumen visible también en la etapa final. Los pedidos previos no deben presentarse como una revisión explícita de reglas.
- Continuar y finalizar sin importar pedidos, subir archivos ni configurar perfiles. La importación debe aparecer como opcional.
- Ejecutar dos diagnósticos, también después de finalizar la guía: botón disponible tras cada éxito, recibos ficticios con identificadores/fechas distintos y último resultado conservado al recargar. Comparar antes y después informes del período y futuro, métricas, productos/reservas, caja, numeración, revisión, auditoría y snapshots: todo debe permanecer igual.
- Comprobar que el ID de práctica no permite registrar cobros ni envíos; crear después un pedido comercial sintético únicamente en el entorno descartable y comprobar numeración e inventario normales.
- Finalizar también sin ejecutar la práctica. No aceptar finalización inicial si falta cuenta/responsable activo, producto habilitado con precio y existencias desconocidas o disponibles positivos, o reglas vigentes; sin pedidos previos se exige confirmar las reglas. Un fallo durante el guardado real del diagnóstico debe revertir todas sus escrituras y conservar el último recibo correcto.
- Revisar en móvil, teclado y navegación con cambios pendientes; agotar existencias después no debe impedir editar preferencias normales.

## Productos, catálogos e imágenes

- Crear producto con URL HTTPS o carga local JPEG/PNG/WebP de hasta 10 MiB. Verificar vista previa, guardado, publicación y ficha/vitrina pública.
- Confirmar detección por contenido, rechazo de formatos ajenos y archivos corruptos, optimización WebP con proporción preservada y máximo 2400 px por lado.
- Probar cuota local exacta: uso mostrado en el panel, subida que llega al límite, rechazo al excederlo y persistencia del archivo tras reiniciar web.
- Confirmar que solo la fotografía de producto acepta referencias `/api/media/<uuid>`; logo, catálogos, combos y comprobantes conservan sus mecanismos existentes.
- Confirmar que las imágenes existentes de marca y creatina se mantienen; no solicitarlas nuevamente como si faltaran.
- Cambiar precio y conteo físico, comprobar físicas/reservadas/disponibles, archivar, crear colecciones con portada y editar su orden. Sin conteo permite pedidos/guías manteniendo cantidades desconocidas; positivo controla reservas/salidas; cero rechaza ventas nuevas. Registrar después un conteo no descuenta otra vez salidas anteriores; no borrar un conteo conocido para eludir un saldo insuficiente.
- Crear combo con dos referencias, cantidades, precio y condiciones. Probar producto archivado/agotado dentro de combo.
- Probar slugs repetidos, campos vacíos y protección al eliminar referencias usadas.
- Competir por la última unidad; agregar demanda compartida de producto/combo/obsequio; editar y cancelar reservas; despachar parcialmente; devolver unidades recuperables/irrecuperables; comprobar reintentos, reenvíos y rectificaciones sin duplicar salidas ni modificar caja.

## Contenido y contacto

- Aprobar cada mensaje, FAQ, precio, costo, cobertura y tiempo antes de hacerlo visible.
- Agregar enlaces oficiales de Facebook/Instagram y verificar destino desde celular.
- Probar WhatsApp general y contextual. Un clic no genera un pedido ni confirma envío de mensaje.
- Confirmar que no hay campañas, bot, lectura de chats ni catálogo sincronizado de Meta.

## Pedido y pago manual

- Crear pedido con dos líneas, cantidades, precio acordado y costo de envío; comprobar total calculado por el servidor.
- Completar ciudad/departamento, dirección y referencias; correo/documento solo cuando corresponda.
- Probar requisitos de transportadora y guía al despachar; no exigirlos para el registro inicial.
- Registrar recaudos parciales/completos y reembolso real con fecha/cuenta; confirmar que el estado calculado no sustituye el documento.
- Probar cancelación antes del despacho, devolución parcial/recuperación y rectificación de eventos con motivo; nunca sobrescribir el historial.
- Confirmar que recaudar no despacha y entregar no simula banco: la plataforma queda pendiente hasta liquidar.
- Reintentar un mismo guardado y verificar que no aparecen dos pedidos; editar desde dos sesiones y comprobar conflicto.
- Editar catálogo y verificar que no se alteran precios ni componentes históricos.
- Revisar historial de cambios, autor, versión, búsqueda por nombre/teléfono/número/guía y paginación.
- Probar con una persona que solo conozca el negocio: buscar un pedido, revisar su estado y registrar la acción que corresponda sin ayuda ni errores, en un máximo de 10 intentos.
- Confirmar que los atajos visibles permiten llegar con un clic a todas las alertas operativas: novedades, liquidaciones, datos/costos faltantes y pagos históricos por conciliar.
- Después del despacho comprobar snapshots históricos; corregir costo explícitamente, no recostear al cambiar la ficha.
- Desde **Acuerdo → Flete / costo de envío**, consultar el costo de la transportadora separado del envío cobrado al cliente, incluso con pedido entregado. Completar concepto, importe y motivo; para costos importados confirmar explícitamente la revisión del soporte. Conservar vacía una fecha desconocida y no ofrecer cuenta/pago en este flujo.
- Corregir el mismo gasto conservando ID, fuente/corte y pagos anteriores; una reducción bajo lo pagado deja crédito por recuperar, no ingreso ficticio. Registrar un costo faltante por guía, uno de pedido sin guía y completar una observación importada desconocida sin duplicarlos ni cambiar el total del cliente.

## Negocio, importación y automatización

Contrato vigente: [README.md, «Excel e informes»](../README.md#excel-e-informes). Para aceptación parcial y filas, consultar las [regresiones E2E existentes](../tests/e2e/workbook.spec.mjs#L846-L1074) y el [contrato de consulta exacta](../tests/business-imports.test.mjs#L54-L93); no son trabajo de implementación pendiente.

Evidencia histórica: la [verificación local de «Importaciones claras y completas» del 4 de noviembre de 2026](CAMBIOS_V2.md#importaciones-claras-y-completas--verificación-local--4-de-noviembre-de-2026) registró comprobaciones con libros sintéticos y PostgreSQL descartable; «sin publicación» se refiere solo a ese pase. La [aceptación del mismo binario](VERIFICACION.md#aceptación-del-mismo-binario--6-de-noviembre-de-2026) y la [entrega integral publicada](VERIFICACION.md#entrega-integral-publicada--6-de-noviembre-de-2026) del 6 de noviembre de 2026 son posteriores, con contratos reutilizados con autorización y un pase E2E nuevo. El recorrido visual productivo del importador se limitó al alta vacía, sin aplicar libros reales.

Este ajuste documental no acredita pruebas, recorridos visuales ni validación nueva con personas no técnicas; tampoco requiere otra implementación, migración o despliegue.

- Entrar por **Pedidos → Importar Excel**: la entrada general sin `batch` abre el historial; **Nueva importación** (`batch=new`) abre el alta y seleccionar un registro (`batch=<id>`) permite retomarlo. Cargar el Excel sintético principal y el reordenado por UI como importaciones nuevas; comprobar la misma venta/guía/recaudo/cargos, sin duplicados, y mapear/resolver identidades de productos/vendedor reales por cuenta.
- Filtrar el historial por origen y estado, avanzar de página, abrir una importación y volver; repetir al recargar y usar Atrás/Adelante: conservar origen, estado y página.
- Abrir un Excel con portada en la fila 1 y encabezados reales en la 2, incluso sin dimensiones declaradas: leer muestras y generar la revisión completa, conservando encabezados repetidos por posición.
- Provocar un archivo truncado y una fila de encabezados fuera de rango: comprobar diagnóstico de archivo o extracción con ubicación y acción, sin error de página completa. Navegar a Inicio, volver a Importar Excel, retomar el mismo lote y recargar: archivo y configuración guardada deben conservarse.
- Corregir la extracción sin volver a subir el original y comprobar que se releen muestras pendientes, aunque la configuración ya estuviera guardada. Durante el procesamiento debe poder navegarse; confirmar exige una revisión real sin error. Comprobar con saldo cero y positivo, sin alterar pedidos, existencias ni caja al generar la vista previa.
- Abrir desde un problema su hoja y fila exactas en **Filas originales y motivos**, incluso entre hojas y fuera de la página visible, solo dentro de esa importación. Mantener la búsqueda privada, fuera de URL/localStorage, y conservar filtros y búsqueda al consultar el estado y paginar; las filas aplicadas deben ser de solo lectura.
- Aceptar solo las operaciones válidas exige marcar expresamente la casilla en **Confirmar**; entrar a revisar la importación parcial no acepta nada. Volver a corregir o cambiar la revisión debe desmarcarla. Tras una aplicación parcial, **Revisar pendientes** genera una revisión nueva y exige otra confirmación; corregir solo lo pendiente, sin duplicar operaciones ni crear pagos o movimientos de caja.
- Retomar una revisión cuyo archivo venció, también después de una aplicación parcial: mostrar resultado de solo consulta con salidas a los registros y motivos de disponibilidad en **Archivos y descargas**, sin reactivar corrección ni confirmación aunque conserve estado `review`. Distinguir la última revisión no aceptada de los hechos aplicados; no presentar contadores de lectura/revisión como operaciones aplicadas.
- Seleccionar un Excel, descartarlo antes de enviarlo y volver a seleccionar el mismo archivo: conservar el origen y no crear una importación por el descarte local.
- Cancelar con la respuesta de creación retenida y durante una carga ya recibida por el servidor: control disponible, original descartado, ninguna respuesta tardía restaura el proceso y **Nueva importación** vuelve a abrir la selección.
- Cerrar primero la corrección en el diálogo de resolución, respetando la guarda de cambios; después usar **Descartar archivo** antes de aceptar o **Cancelar importación** después de aceptar, desde la cabecera. El diálogo de decisión debe mostrar el archivo y las consecuencias; cerrarlo no escribe y aceptar no anuncia éxito antes de la respuesta del servidor.
- Cancelar durante preparación, cola y aplicación parcial. Comparar hechos comerciales antes/después de cancelar: conservar exactamente lo confirmado y detener grupos/declaraciones pendientes, incluso tras reiniciar el worker o restaurar un respaldo.
- Conservar y mostrar como historial las excepciones anteriores de un lote cancelado; no ofrecer continuar ese lote ni generar otra revisión sobre él.
- Intentar cancelar al confirmar la última operación, tras finalizar con o sin excepciones y desde una pantalla antigua: `409`, original intacto y sin reversión de cambios. Revisar/reaplicar pendientes de una importación antes terminada no vuelve a habilitar la cancelación.
- Confirmar retenciones y recepción bancaria, preparar/confirmar/pagar sueldo; cotejar cifras exactas de septiembre y secuencia de caja en `VERIFICACION.md`.
- Cambiar A a costo30000 desde octubre y crear un pedido nuevo A×1 el1octubre, sin guía/cobro: snapshot30000; septiembre conserva costo46000. Devolver A recuperable el2octubre, luego reembolso/flete el3octubre; contribución de octubre−36250, no septiembre.
- Con saldo127500, detener worker, configurar mínimo128000 y solicitar snapshot septiembre. Cerrar paneles y ejecutar la orden Compose exacta impresa; reabrir snapshot/alerta y repetir sin duplicar. Abrir **En atención / asignar**, marcar explícitamente la casilla **En atención**, guardar y comprobar estado «En atención» manteniendo saldo127500; no basta escribir el motivo. Solo después registrar ingreso no comercial500 con referencia del manifest y otra corrida: mismo episodio resuelto y saldo128000.
- Configurar la alerta de existencias en días, semanas y meses de 30 días, guardar y recargar cada valor sin cambiar las horas del recordatorio. Con disponibles cinco y demanda neta de una unidad diaria, siete días debe avisar y tres no; cero avisa inmediatamente, sin conteo o demanda positiva no se inventa agotamiento. Ejecutar el scheduler con paneles cerrados, comprobar episodio/resolución y que **Revisar existencias** abre el producto correcto.
- Preparar preview válido de60 guías sintéticas con worker activo; detenerlo antes de confirmar. Lote queued y paneles cerrados: el verificador demuestra0→25→60, misma revisión, sin nuevos pedidos ni dinero. Esas guías sin costo vuelven parcial el informe vivo, no cambian snapshots anteriores.
- Probar costo desconocido/cero, obsequios y devoluciones; saldos parciales/créditos/anticipos/reversos; seis calendarios Bogotá; archivo viejo/estado desconocido; aislamiento de cuentas y pérdida de lease.
- Comprobar devoluciones con el mismo instante y orden de UUID contrario al registro: conservar la asignación despachada previa, descontar solo la pérdida pendiente nueva y mantener caja intacta. Repetir con devolución previa recuperable y comprobar que eliminar el despacho que la respalda sigue devolviendo 409.
- Revisar desktop1440×900 y móvil390×844: seis áreas, navegación compacta, teclado/foco/Escape, Back/Forward/recarga, borrador retenido ante rechazo y ausencia de modales anidados. Caducidad también al descargar original/errores/XLSX.


## Persistencia y operación

- Reiniciar y comprobar persistencia en la base elegida. SQLite solo en disco persistente; nunca como respaldo automático de Vercel.
- Simular indisponibilidad de Supabase: no mostrar guardado exitoso ni escribir en una SQLite independiente.
- Exportar v3 con `inventoryVersion:1` y restaurar JSON/SQLite entre motores en destino comercialmente vacío; comparar existencias, reservas, caja, relaciones, auditoría, originales Excel, revisiones y snapshots. Un respaldo anterior recibe línea base sin descontar el pasado; uno inválido no deja filas ni altera defaults/counters. Autenticación no viaja; imágenes aparte.
- Probar backup integral del proveedor además del JSON comercial. No hay tarea programada de backup configurada por este ZIP.
- Verificar formularios, modales, teclado, foco, navegación y legibilidad en escritorio y celular.
- Revisar conservación de datos personales y enlaces de comprobantes; no publicar comprobantes en el catálogo.
- Confirmar cuentas individuales, permisos y capacitación. En esta versión todas las cuentas del panel tienen acceso administrativo completo.

## Materiales y decisiones pendientes

No volver a pedir logo, foto de creatina, número WhatsApp, métodos ya recibidos ni dominio/topología ya documentados. Sí confirmar redes oficiales, referencias/combos que faltan, precios vigentes, cobertura/costos/tiempos, horario y contenido aprobado.

Confirmar contenido y capacitación: catálogos/variantes, cuentas/responsables, saldos y conteos físicos reales, políticas históricas y vigencias salariales/comisiones, costos y reglas de cierre/alerta. La topología real está documentada y la administración v3, el inventario y la guía ya aprobaron promoción nativa y comprobación en producción; véase `VERIFICACION.md`. No hay precio ni contrato nuevo de fase2 en el software. Precisar aparte mantenimiento y política de backups cifrados/off-host; no confundirla con el scheduler de negocio.
