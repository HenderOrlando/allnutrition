# Requisitos y decisiones — All Nutrition v2

## Base de trabajo y límites de interpretación

El Formulario es el documento de preguntas; la Planilla contiene las respuestas correlativas. Las imágenes de la página 1 de la Planilla son respuestas: logo en pregunta 5 y fotografía de creatina en pregunta 7. El alcance V5 se usa como referencia histórica, no como si todas sus funciones se hubieran contratado. Las instrucciones posteriores del desarrollador amplían fase 1 con autoadministración y pedidos manuales.

Esta matriz describe lo programado y las decisiones aún por aceptar. No sustituye la revisión técnica pendiente ni demuestra aceptación comercial del cliente. No se inventan perfiles sociales, cobertura, tarifas, productos adicionales, políticas, credenciales ni un dominio.

## Trazabilidad funcional

| Requisito | Base aportada | Implementación y límite |
|---|---|---|
| Marca y tono fitness | Planilla respuestas 1–5 | Nombre y eslogan cargados; logo incorporado; contenido modificable. |
| Catálogo inicial | Formulario 6–8; Planilla 6–8 | Categorías Creatinas, Proteínas, Preentrenos y Aminoácidos. Una creatina con fotografía, 70 servicios, sin sabor y precio informado 55.000 COP; pendiente confirmar vigencia antes de publicar. |
| Productos autoadministrados | Instrucción del desarrollador | Alta/edición/publicación/archivo; imagen por URL HTTPS o carga local JPEG/JPG, PNG y WebP (máximo 10 MiB); optimización WebP a 2400 px por lado y cuota local de 1.000.000.000 bytes; precio COP entero, descripción, presentación, sabor, información de etiqueta, destacado y disponibilidad manual. |
| Catálogos | Instrucción del desarrollador | Colecciones con portada y descripción; un producto/ combo puede pertenecer a varias. Página propia `/catalogos/slug`. No PDF ni sincronización del catálogo de WhatsApp. |
| Combos | Planilla respuesta 9; instrucción del desarrollador | Productos y cantidades con precio y condiciones manuales. No se cargaron combos ficticios ni precios supuestos. |
| Disponibilidad | Planilla respuesta 10 | Disponible, Consultar y Agotado, elegidos por el administrador. No descuento de existencias. |
| Bajo stock | Formulario 11; Planilla 11 | 50 era umbral de bajo stock, NO existencia del producto. No se cargó como stock inicial ni se añadió inventario automático. |
| WhatsApp principal | Planilla 13; conversación | +57 3043440035, editable; mensaje prellenado con producto. Un clic no crea un pedido ni confirma que se envió un mensaje. |
| Mensaje de espera | Planilla 15 | Es un mensaje de la empresa en WhatsApp; no se confunde con el texto del visitante. No se configura un bot ni se lee WhatsApp. |
| Facebook e Instagram | Aclaración del desarrollador | Campos para enlaces oficiales; se muestran cuando se completan. No se necesitan contraseñas ni administración de redes. |
| Preguntas frecuentes | Formulario 23; Planilla 23 | CRUD, orden y publicación. Las propuestas incompletas permanecen en borrador. |
| Mensajes comerciales | Formulario 24–25; Planilla 24–25 | Hero, franja y bloques informativos editables. Los textos base son propuestas; no se atribuyen al cliente como respuestas confirmadas. |
| Datos públicos de envío | Formulario 20–21; Planilla 20–21 | Cobertura, costos informados, tiempos, contraentrega y detalles. No hay tarifador, cotización automática ni generación de guías. |
| Destinatario | Planilla 21 | Nombre, celular, dirección, barrio/referencias, ciudad/departamento y correo. Documento opcional solo cuando se requiere, no como requisito general. |
| Pedidos y estados | Formulario 22; Planilla 22; instrucción posterior | Registro privado y manual; cantidades, precio acordado, costo de envío, transportadora, guía, estado, notas, historial y búsqueda. |
| Pagos manuales | Formulario 18–19; Planilla 18–19 | Nequi, Daviplata, transferencia y efectivo contraentrega. Valor, fecha, referencia, estado y comprobante por enlace; no verificación bancaria. |
| Autoadministración | Instrucción del desarrollador | El propietario puede actualizar los módulos desde el panel; no hay caducidad de acceso ligada al mantenimiento. |
| Next.js + Supabase y SQLite | Última instrucción técnica | App Router y backend Node; repositorio común con dos adaptadores y selección por .env. |
| Enlaces y archivos | Última instrucción técnica | Productos: URL HTTPS o binario optimizado en volumen local persistente Docker; la base conserva solo la referencia. Logo, catálogos, combos y comprobantes conservan recursos estáticos o URL. Exportaciones PostgreSQL/comerciales no incluyen el volumen de medios; debe respaldarse por separado. |
| Fase 2 sin precio ni entrega anticipada | Instrucción comercial | Explicación opcional y discreta en el panel. Sin embudo, captación, asignación de leads ni seguimiento de no compradores. |

## Flujos implementados

### Publicación del catálogo

Administrador inicia sesión → crea/selecciona catálogo → completa el producto y pega una URL o sube una imagen compatible → revisa la vista previa y el uso de cuota → guarda borrador o publica → revisa la página privada → aprueba la vitrina pública.

La validación del servidor comprueba los campos y la referencia de imagen. Las cargas de producto verifican formato, tamaño de entrada y cuota antes de guardar el binario optimizado; se aceptan referencias locales únicamente en Productos. Publicar un producto exige nombre, dirección corta, foto/enlace, presentación y precio positivo. No se exige completar redes o todos los productos para empezar a diseñar. Al editar una referencia, si otro administrador cambió su versión, se informa el conflicto en lugar de sobrescribir.

Un combo publicado requiere referencias publicadas. Si después se archiva una de ellas, el combo deja de aparecer públicamente. Si se marca agotada, no admite nuevos pedidos de ese combo. El combo conserva precio manual; no existe cálculo de inventario.

### Consulta y pedido

Visitante consulta vitrina → botón contextual abre WhatsApp → equipo conversa y confirma la compra → operador registra pedido → prepara → despacha → registra entrega.

No hay formulario público de captación, carrito, checkout, cobro automático, creación de pedidos por clic, monitor de conversaciones ni solicitud de pago desde la web. El panel no certifica que el pedido sea una venta real: registra lo que introduce el equipo.

El formulario de pedido muestra cuatro grupos: destinatario, productos y valor acordado, entrega/estado, pago. Ciudad/nombre/celular y al menos una referencia son requeridos al crear. Antes de despachar por transportadora exige dirección, departamento, transportadora y guía. Correo y documento no bloquean el alta; se completan cuando la operación lo requiera.

### Estados y correcciones

Nuevo → Preparando → Enviado → Entregado. Puede cancelarse desde Nuevo/Preparando. Puede devolverse desde Enviado/Entregado. Cancelación y devolución requieren motivo y no eliminan el pedido. Las líneas y totales se conservan después de despacho o cierre; los demás datos operativos aún pueden corregirse con historial.

Estos son **valores por defecto de diseño, pendientes de aceptación**: la Planilla aceptó los estados propuestos, pero no definió reglas de transición, reversión o edición después del despacho. Si necesitan rectificar un estado final por un error, esa excepción debe definirse expresamente antes de usarlo en operación; no debe alterarse directamente la BD como rutina.

Un pago no cambia el estado de envío ni un envío confirma un pago. Se permite contraentrega con pago pendiente. Para marcar Pagado se exige monto completo y fecha. Abono parcial es una propuesta adicional para registrar un pago menor que el total. Reembolsado requiere una referencia/nota. No hay libro contable, conciliación ni registro detallado de múltiples transacciones de pago/reembolso.

Al guardar se conserva la composición histórica de productos/combos. Cambiar un combo mañana no cambia lo que figuraba en un pedido anterior. Un identificador de intento evita que reintentar el mismo guardado cree dos pedidos. Una edición antigua recibe conflicto 409 y requiere recargar.

### Acceso y datos

Sesiones privadas de ocho horas con cookies HttpOnly; origen y token CSRF en escrituras; contraseñas con scrypt; intentos de acceso limitados en la base, no solo en memoria. Registro público de cuentas desactivado. Las cuentas adicionales se crean mediante comando local por el responsable técnico y tienen los mismos permisos administrativos. Eso no es un sistema de asignación de interesados a asesores.

Los datos personales y enlaces de comprobantes no aparecen en las consultas públicas. La privacidad del archivo externo depende de los permisos en su origen; no se vuelve privado por guardar su URL en el panel. Las imágenes locales de productos se sirven desde el servidor y no se guardan en la base. La exportación del panel incluye datos comerciales e historial, no contraseñas, sesiones ni binarios; debe guardarse como información privada. Las imágenes enlazadas siguen dependiendo de la disponibilidad de su sitio de origen.

## Decisiones que faltan confirmar

| Tema | Valor de trabajo en el código | Confirmación necesaria |
|---|---|---|
| Plataforma de publicación | Elegida: servidor Linux único con Docker Compose, PostgreSQL y Caddy HTTPS | Faltan servidor/dominio reales y validación remota. Vercel/Supabase queda como alternativa no desplegada. |
| Fallback | SQLite para desarrollo local; sin failover por caída | Docker usa PostgreSQL explícitamente. Cambiar de motor exige migración deliberada, no continuidad automática ni replicación. |
| Catálogos | Colecciones navegables dentro de la web | Confirmar que no significa archivos PDF descargables ni varios catálogos de precios. |
| Presentaciones y sabores | Referencias independientes | Confirmar si necesitan un selector de variantes dentro de un único producto. |
| Alta de pedidos | Manual después de WhatsApp | Confirmar que el visitante no debe crear directamente un pedido en esta fase. |
| Pago parcial | Estado manual Abono parcial | Confirmar si lo usan; se puede retirar si solo manejan pendiente/pagado/reembolsado. |
| Transiciones y correcciones | Secuencia anterior; estados finales no se reabren | Confirmar reglas, especialmente cancelación después del despacho y corrección de errores. |
| Entregas | Transportadora predeterminada; local/recogida disponibles en el panel | La Planilla solo confirmó ciudad, transportadora y contraentrega. Confirmar otras modalidades antes de ofrecerlas. |
| Operadores | Cuenta inicial y altas CLI adicionales con acceso completo | Indicar correos de acceso y si todos deben ver/editar lo mismo. No compartir contraseñas en el chat. |
| Redes y dominio | Campos vacíos; dominio aún sin registrar | Enlaces oficiales de Facebook/Instagram y dominio cuando lo elijan. |
| Contenido | Solo material entregado + borradores identificados | Productos adicionales, combos/precios, costos/cobertura/tiempos, horario y respuestas aprobadas. |
| Mantenimiento | No se modifica ni se cobra desde el software | Precisar fechas/tareas por los cinco meses ofrecidos; no se programa vencimiento ni tarifa de fase 2. |

## Criterios para entrega y publicación real

La aceptación técnica local de compilación, contratos SQLite/PostgreSQL, navegador HTTPS, permisos, caída/recuperación y respaldo/restauración se registra en [VERIFICACION.md](VERIFICACION.md). Los pedidos ficticios, cuentas E2E, resets y pruebas de caída se ejecutan exclusivamente en la base descartable `allnutrition_test`; la restauración se comprueba en otra base vacía del mismo proyecto descartable. El staging persistente usa el seed de contenido aportado y su administrador propio, sin copiar cuentas ni pedidos de prueba: revisar allí portada de preparación, login, panel, preview y enlaces desde celular. Antes de publicar en el servidor Linux con Compose elegido, validar la infraestructura remota según [DESPLIEGUE.md](DESPLIEGUE.md), confirmar reglas pendientes y aprobar contenido; luego entregar cuentas individuales e instrucciones.
