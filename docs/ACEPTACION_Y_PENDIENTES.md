# Aceptación de All Nutrition v3

Realizar estas comprobaciones en Next.js compilado y en un entorno de revisión separado. Consultar `REQUISITOS_Y_DECISIONES.md` para distinguir respuestas del cliente, instrucciones posteriores y reglas propuestas.

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
- Crear el primer producto sin salir de la guía con nombre, precio y conteo físico; confirmar disponibilidad administrativa, sin foto/costo/inventario inventados ni publicación automática.
- Confirmar reglas vigentes sin modificar su historia; comprobar que los detalles avanzados son opcionales y accesibles.
- Con caja, productos y pedidos ya guardados, abrir la guía sin las marcas antiguas de confirmación: comprobar etapas «Realizado» con motivos concretos y resumen visible también en la etapa final. Los pedidos previos no deben presentarse como una revisión explícita de reglas.
- Continuar y finalizar sin importar pedidos, subir archivos ni configurar perfiles. La importación debe aparecer como opcional.
- Ejecutar dos diagnósticos, también después de finalizar la guía: botón disponible tras cada éxito, recibos ficticios con identificadores/fechas distintos y último resultado conservado al recargar. Comparar antes y después informes del período y futuro, métricas, productos/reservas, caja, numeración, revisión, auditoría y snapshots: todo debe permanecer igual.
- Comprobar que el ID de práctica no permite registrar cobros ni envíos; crear después un pedido comercial sintético únicamente en el entorno descartable y comprobar numeración e inventario normales.
- Finalizar también sin ejecutar la práctica. No aceptar finalización inicial si falta cuenta/responsable activo, producto con precio/existencias o reglas vigentes; sin pedidos previos se exige confirmar las reglas. Un fallo durante el guardado real del diagnóstico debe revertir todas sus escrituras y conservar el último recibo correcto.
- Revisar en móvil, teclado y navegación con cambios pendientes; agotar existencias después no debe impedir editar preferencias normales.

## Productos, catálogos e imágenes

- Crear producto con URL HTTPS o carga local JPEG/PNG/WebP de hasta 10 MiB. Verificar vista previa, guardado, publicación y ficha/vitrina pública.
- Confirmar detección por contenido, rechazo de formatos ajenos y archivos corruptos, optimización WebP con proporción preservada y máximo 2400 px por lado.
- Probar cuota local exacta: uso mostrado en el panel, subida que llega al límite, rechazo al excederlo y persistencia del archivo tras reiniciar web.
- Confirmar que solo la fotografía de producto acepta referencias `/api/media/<uuid>`; logo, catálogos, combos y comprobantes conservan sus mecanismos existentes.
- Confirmar que las imágenes existentes de marca y creatina se mantienen; no solicitarlas nuevamente como si faltaran.
- Cambiar precio y conteo físico, comprobar físicas/reservadas/disponibles, archivar, crear colecciones con portada y editar su orden. Vacío no equivale a cero; los productos existentes requieren conteo real.
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

## Negocio, importación y automatización

- Entrar en **Nuevo lote** antes de cargar el Excel sintético principal y el reordenado por UI; la entrada inicial ofrece retomar lotes guardados. Comprobar la misma venta/guía/recaudo/cargos, sin duplicados; mapear y resolver identidades de productos/vendedor reales por cuenta.
- Abrir un Excel con portada en la fila 1 y encabezados reales en la 2, incluso sin dimensiones declaradas: leer muestras y generar la revisión completa, conservando encabezados repetidos por posición.
- Provocar un archivo truncado y una fila de encabezados fuera de rango: comprobar diagnóstico de archivo o extracción con ubicación y acción, sin error de página completa. Navegar a Inicio, volver a Importar Excel, retomar el mismo lote y recargar: archivo y configuración guardada deben conservarse.
- Corregir la extracción sin volver a subir el original y comprobar que se releen muestras pendientes, aunque la configuración ya estuviera guardada. Durante el procesamiento debe poder navegarse; confirmar exige una revisión real sin error. Comprobar con saldo cero y positivo, sin alterar pedidos, existencias ni caja al generar la vista previa.
- Confirmar retenciones y recepción bancaria, preparar/confirmar/pagar sueldo; cotejar cifras exactas de septiembre y secuencia de caja en `VERIFICACION.md`.
- Cambiar A a costo30000 desde octubre y crear un pedido nuevo A×1 el1octubre, sin guía/cobro: snapshot30000; septiembre conserva costo46000. Devolver A recuperable el2octubre, luego reembolso/flete el3octubre; contribución de octubre−36250, no septiembre.
- Con saldo127500, detener worker, configurar mínimo128000 y solicitar snapshot septiembre. Cerrar paneles y ejecutar la orden Compose exacta impresa; reabrir snapshot/alerta y repetir sin duplicar. Abrir **En atención / asignar**, marcar explícitamente la casilla **En atención**, guardar y comprobar estado «En atención» manteniendo saldo127500; no basta escribir el motivo. Solo después registrar ingreso no comercial500 con referencia del manifest y otra corrida: mismo episodio resuelto y saldo128000.
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
