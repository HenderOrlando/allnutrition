# Aceptación de All Nutrition v2

Realizar estas comprobaciones en Next.js compilado y en un entorno de revisión separado. Consultar `REQUISITOS_Y_DECISIONES.md` para distinguir respuestas del cliente, instrucciones posteriores y reglas propuestas.

## Instalación y acceso

- Instalar dependencias, generar/conservar package-lock y ejecutar check, tests, contrato PostgreSQL, build y Playwright.
- Configurar URL y TLS de Supabase; migrar esquema; comprobar que `allnutrition` no está expuesto por Data API. Comprobar permisos del rol de ejecución.
- Probar acceso, cierre de sesión, caducidad y cambio de contraseña; comprobar revocación de sesiones.
- Sin sesión, no deben estar disponibles pedidos, panel ni exportaciones. Rechazar escrituras con origen o CSRF inválido.
- Confirmar cookies HTTPS, APP_URL y orígenes de preview sin aceptar cualquier Host.
- Verificar que secretos, respaldos y datos no están en el repositorio ni en recursos públicos.
- Verificar separación entre una vitrina aún no aprobada y la previsualización del administrador.

## Productos, catálogos e imágenes

- Crear producto con URL HTTPS o carga local JPEG/PNG/WebP de hasta 10 MiB. Verificar vista previa, guardado, publicación y ficha/vitrina pública.
- Confirmar detección por contenido, rechazo de formatos ajenos y archivos corruptos, optimización WebP con proporción preservada y máximo 2400 px por lado.
- Probar cuota local exacta: uso mostrado en el panel, subida que llega al límite, rechazo al excederlo y persistencia del archivo tras reiniciar web.
- Confirmar que solo la fotografía de producto acepta referencias `/api/media/<uuid>`; logo, catálogos, combos y comprobantes conservan sus mecanismos existentes.
- Confirmar que las imágenes existentes de marca y creatina se mantienen; no solicitarlas nuevamente como si faltaran.
- Cambiar precio/disponibilidad, archivar, crear colecciones con portada y editar su orden.
- Crear combo con dos referencias, cantidades, precio y condiciones. Probar producto archivado/agotado dentro de combo.
- Probar slugs repetidos, campos vacíos y protección al eliminar referencias usadas.

## Contenido y contacto

- Aprobar cada mensaje, FAQ, precio, costo, cobertura y tiempo antes de hacerlo visible.
- Agregar enlaces oficiales de Facebook/Instagram y verificar destino desde celular.
- Probar WhatsApp general y contextual. Un clic no genera un pedido ni confirma envío de mensaje.
- Confirmar que no hay campañas, bot, lectura de chats ni catálogo sincronizado de Meta.

## Pedido y pago manual

- Crear pedido con dos líneas, cantidades, precio acordado y costo de envío; comprobar total calculado por el servidor.
- Completar ciudad/departamento, dirección y referencias; correo/documento solo cuando corresponda.
- Probar requisitos de transportadora y guía al despachar; no exigirlos para el registro inicial.
- Probar contraentrega con pago pendiente, pago completo y el estado parcial si se acepta usarlo.
- Probar todas las transiciones propuestas y el motivo obligatorio de cancelación/devolución.
- Confirmar que cambiar pago no despacha un pedido y despachar no confirma un pago.
- Reintentar un mismo guardado y verificar que no aparecen dos pedidos; editar desde dos sesiones y comprobar conflicto.
- Editar catálogo y verificar que no se alteran precios ni componentes históricos.
- Revisar historial de cambios, autor, versión, búsqueda por nombre/teléfono/número/guía y paginación.
- Acordar cómo corregir errores después del despacho o en estados finales antes de usar el flujo en operación real.

## Persistencia y operación

- Reiniciar y comprobar persistencia en la base elegida. SQLite solo en disco persistente; nunca como respaldo automático de Vercel.
- Simular indisponibilidad de Supabase: no mostrar guardado exitoso ni escribir en una SQLite independiente.
- Generar exportación y restaurarla en destino vacío; comparar cantidades, totales e historial.
- Probar backup integral del proveedor además del JSON comercial. No hay tarea programada de backup configurada por este ZIP.
- Verificar formularios, modales, teclado, foco, navegación y legibilidad en escritorio y celular.
- Revisar conservación de datos personales y enlaces de comprobantes; no publicar comprobantes en el catálogo.
- Confirmar cuentas individuales, permisos y capacitación. En esta versión todas las cuentas del panel tienen acceso administrativo completo.

## Materiales y decisiones pendientes

No volver a pedir logo, foto de creatina, número WhatsApp ni los métodos ya recibidos. Sí confirmar redes oficiales, referencias/combos que faltan, precios vigentes, cobertura/costos/tiempos, horario, contenido aprobado y dominio cuando lo elijan.

Confirmar Vercel u otro host; significado de “catálogos”; variantes; alta manual de pedidos; pagos parciales; modalidades local/recogida; reglas de transición/corrección; permisos del equipo. No hay un precio ni contrato nuevo de fase 2 en el software. Precisar por separado las tareas y fechas del mantenimiento ya ofrecido.
