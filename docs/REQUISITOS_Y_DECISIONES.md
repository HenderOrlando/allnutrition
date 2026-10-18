# Requisitos y decisiones — All Nutrition v3

## Base de trabajo y límites de interpretación

El Formulario es el documento de preguntas; la Planilla contiene las respuestas correlativas. Las imágenes de la página 1 de la Planilla son respuestas: logo en pregunta 5 y fotografía de creatina en pregunta 7. El alcance V5 se usa como referencia histórica, no como si todas sus funciones se hubieran contratado. Las instrucciones posteriores del desarrollador amplían fase 1 con autoadministración y pedidos manuales.

Esta matriz describe lo programado y las decisiones aún por aceptar. No sustituye la revisión técnica pendiente ni demuestra aceptación comercial del cliente. No se inventan perfiles sociales, cobertura, tarifas, productos adicionales, políticas, credenciales ni un dominio.

La ampliación técnica aprobada de **administración de negocio simple** añade caja, costos privados, importación Excel, liquidaciones, sueldos, informes y alertas independientes del navegador. La instrucción posterior del usuario del 17 de octubre de 2026 añade **inventario conectado a pedidos**, sustituyendo la disponibilidad manual. No convierte la oferta comercial histórica en un contrato nuevo ni añade CRM o integraciones externas. El estado de producción previo y la aceptación local se distinguen en `VERIFICACION.md`.

## Trazabilidad funcional

| Requisito | Base aportada | Implementación y límite |
|---|---|---|
| Marca y tono fitness | Planilla respuestas 1–5 | Nombre y eslogan cargados; logo incorporado; contenido modificable. |
| Catálogo inicial | Formulario 6–8; Planilla 6–8 | Categorías Creatinas, Proteínas, Preentrenos y Aminoácidos. Una creatina con fotografía, 70 servicios, sin sabor y precio informado 55.000 COP; pendiente confirmar vigencia antes de publicar. |
| Productos autoadministrados | Instrucción del desarrollador y ampliación de inventario | Alta/edición/publicación/archivo; imagen por URL HTTPS o carga local JPEG/JPG, PNG y WebP (máximo 10 MiB); optimización WebP a 2400 px por lado y cuota local de 1.000.000.000 bytes; precio COP entero, descripción, presentación, sabor, información de etiqueta, destacado y conteo físico privado con reservas derivadas de pedidos. |
| Catálogos | Instrucción del desarrollador | Colecciones con portada y descripción; un producto/ combo puede pertenecer a varias. Página propia `/catalogos/slug`. No PDF ni sincronización del catálogo de WhatsApp. |
| Combos | Planilla respuesta 9; instrucción del desarrollador | Productos y cantidades con precio y condiciones manuales. No se cargaron combos ficticios ni precios supuestos. |
| Disponibilidad | Planilla respuesta 10; instrucción posterior del usuario | Disponible, Consultar y Agotado se derivan de existencias libres: físicas menos reservadas. El conteo desconocido conserva Consultar, pero no permite nuevas reservas ni despachos. El permiso de uso en pedidos sigue siendo independiente. |
| Bajo stock | Formulario 11; Planilla 11 | 50 era umbral de bajo stock, NO existencia del producto. No se carga como stock inicial ni se añade una alerta de bajo stock en esta ampliación. |
| WhatsApp principal | Planilla 13; conversación | +57 3043440035, editable; mensaje prellenado con producto. Un clic no crea un pedido ni confirma que se envió un mensaje. |
| Mensaje de espera | Planilla 15 | Es un mensaje de la empresa en WhatsApp; no se confunde con el texto del visitante. No se configura un bot ni se lee WhatsApp. |
| Facebook e Instagram | Aclaración del desarrollador | Campos para enlaces oficiales; se muestran cuando se completan. No se necesitan contraseñas ni administración de redes. |
| Preguntas frecuentes | Formulario 23; Planilla 23 | CRUD, orden y publicación. Las propuestas incompletas permanecen en borrador. |
| Mensajes comerciales | Formulario 24–25; Planilla 24–25 | Hero, franja y bloques informativos editables. Los textos base son propuestas; no se atribuyen al cliente como respuestas confirmadas. |
| Datos públicos de envío | Formulario 20–21; Planilla 20–21 | Cobertura, costos informados, tiempos, contraentrega y detalles. No hay tarifador, cotización automática ni generación de guías. |
| Destinatario | Planilla 21 | Nombre, celular, dirección, barrio/referencias, ciudad/departamento y correo. Documento opcional solo cuando se requiere, no como requisito general. |
| Pedidos y seguimiento | Planilla e instrucción posterior v3 | Destinatario/productos/vendedor opcional; varias guías y eventos con fecha conocida o desconocida, historial y rectificaciones explícitas. Seguimiento sin productos no crea venta ficticia. |
| Cobros y reembolsos | Planilla y plan v3 aprobado | Transacciones parciales, responsable del dinero, fecha, referencia y cuenta real. El estado de pago se deriva; no verifica bancos ni despacha automáticamente. |
| Autoadministración | Instrucción del desarrollador | El propietario puede actualizar los módulos desde el panel; no hay caducidad de acceso ligada al mantenimiento. |
| Next.js + Supabase y SQLite | Última instrucción técnica | App Router y backend Node; repositorio común con dos adaptadores y selección por .env. |
| Enlaces y archivos | Última instrucción técnica | Productos: URL HTTPS o binario optimizado en volumen local persistente Docker; la base conserva solo la referencia. Logo, catálogos, combos y comprobantes conservan recursos estáticos o URL. Exportaciones PostgreSQL/comerciales no incluyen el volumen de medios; debe respaldarse por separado. |
| Fase 2 sin precio ni entrega anticipada | Instrucción comercial | Explicación opcional y discreta en el panel. Sin embudo, captación, asignación de leads ni seguimiento de no compradores. |
| Caja y personal | Plan v3 aprobado | Aperturas explícitas, ingresos no comerciales, transferencias, gastos/retenciones, anticipos, cierres y pago de sueldo/comisión; responsable no equivale a usuario con acceso. |
| Excel e informes | Plan v3 aprobado | Identidad por fuente/cuenta, mapeo revisado y grupos atómicos; seis períodos Bogotá, cobertura, detalle, snapshots y XLSX sin beneficios inventados por datos faltantes. |
| Automatización | Plan v3 aprobado | Proceso persistente con leases/heartbeat; alertas por episodio y generación de informes sin panel abierto. No incluye notificaciones externas ni backups programados. |

## Flujos implementados

### Publicación del catálogo

Administrador inicia sesión → crea/selecciona catálogo → completa el producto y pega una URL o sube una imagen compatible → revisa la vista previa y el uso de cuota → guarda borrador o publica → revisa la página privada → aprueba la vitrina pública.

La validación del servidor comprueba los campos y la referencia de imagen. Las cargas de producto verifican formato, tamaño de entrada y cuota antes de guardar el binario optimizado; se aceptan referencias locales únicamente en Productos. Publicar un producto exige nombre, dirección corta, foto/enlace, presentación y precio positivo. No se exige completar redes o todos los productos para empezar a diseñar. Al editar una referencia, si otro administrador cambió su versión, se informa el conflicto en lugar de sobrescribir.

Un combo publicado requiere referencias publicadas. Si después se archiva una de ellas, el combo deja de aparecer públicamente. Su disponibilidad y la de los obsequios dependen de las unidades libres de cada componente y de la cantidad requerida; ninguno tiene existencias físicas propias. El combo conserva precio manual.

### Consulta y pedido

Visitante explora la vitrina en claro/oscuro → consulta un producto directamente o añade referencias y cantidades a **Mi pedido** → revisa el subtotal → comparte por WhatsApp un mensaje prellenado con productos, cantidades y total → equipo confirma disponibilidad, pago y envío → operador registra el pedido → prepara → despacha → registra entrega.

La selección del carrito se conserva solo en la sesión de la pestaña y no se guarda como pedido comercial. Desde la vitrina no hay formulario público de captación, checkout, cobro automático, reserva/descuento de inventario, creación de pedidos por clic, monitor de conversaciones ni solicitud de pago. La reserva ocurre al guardar un pedido en el panel, no al seleccionar referencias ni abrir WhatsApp. El panel registra lo que introduce el equipo; no certifica una venta externa.

El formulario comienza por destinatario y productos, vendedor opcional y total. Envíos, cobros y rentabilidad son detalles del pedido existente; sus acciones guardan documentos individuales con requestId/version, no pagos dentro del PUT completo. Ciudad/nombre/celular y una línea real son requeridos al crear. Correo/documento quedan bajo detalle; el despacho exige los datos de entrega y guía que correspondan.

### Estados y correcciones

El acuerdo económico, precios, costos y composición se conservan después del despacho. Eventos de guía y sus rectificaciones son inmutables: una corrección con motivo referencia el evento anterior y recalcula reconocimiento/comisiones sin borrar auditoría. Cancelar antes del despacho y devolver unidades son hechos distintos; una devolución registra crédito y recuperación/no recuperación, pero no simula el reembolso bancario.

Reglas de reconocimiento, comisión y fechas de gasto se versionan por vigencia. Costos actuales no recostean pedidos históricos; completar/corregir costos es una acción explícita y auditada. Costo `null` es desconocido, costo cero es conocido. Obsequios gratuitos conservan el costo real de sus componentes.

El estado de cobro se deriva de recaudos, reembolsos y créditos. Cliente pagado, plataforma pendiente y banco disponible son saldos diferentes. Confirmar una liquidación concilia bruto/retenciones/neto; pagar sueldo distingue devengo, compensaciones/anticipos y efectivo nuevo. Apertura, aporte del propietario y transferencia nunca aumentan ventas. No hay contabilidad fiscal, facturación ni conciliación bancaria automática.

Al guardar se conserva la composición histórica de productos/combos. Cambiar un combo mañana no cambia lo que figuraba en un pedido anterior. Un identificador de intento evita que reintentar el mismo guardado cree dos pedidos. Una edición antigua recibe conflicto 409 y requiere recargar.

### Existencias conectadas a pedidos

Cada producto normal guarda `stockQuantity` (conteo físico, incluidas las unidades reservadas) y `stockReserved` (calculado por el servidor). El panel deriva `stockAvailable`; la vitrina recibe únicamente disponibilidad, no cantidades. Los conteos son enteros seguros no negativos. `null` significa sin contar y cero significa ninguna unidad: una referencia sin contar no admite nuevas reservas ni salidas. Un conteo ya conocido no puede volver a quedar vacío ni bajar de las reservas vigentes. El conteo queda auditado y no registra compras, gastos ni caja.

Guardar el pedido reserva la demanda agregada de todas sus líneas, incluidos los componentes históricos de combos y obsequios. Editarlo aplica únicamente la diferencia neta; cancelar antes del despacho libera las reservas. Todo el guardado comparte transacción y bloqueo de escrituras: si falta una unidad o una referencia, no se modifica parcialmente el pedido ni sus productos. Las operaciones de inventario incrementan la versión del producto para rechazar conteos o ediciones obsoletas.

Una etiqueta o un estado desconocido no descuenta existencias. La evidencia efectiva de salida (`collected`, tránsito, reparto, entrega o retorno) descuenta únicamente las cantidades asignadas al envío y libera su reserva. Los despachos parciales conservan reservadas las unidades pendientes. Registrar otra observación o reintentar la misma operación no vuelve a descontar. Un reenvío que sustituye un envío ya despachado reserva unidades adicionales al crearse y las descuenta al salir; sustituir una guía aún no despachada no duplica la demanda.

La devolución conserva qué unidades estaban despachadas al registrarla: una devolución recuperable reingresa esas unidades y solo libera las todavía pendientes. Una unidad irrecuperable ya despachada no se descuenta otra vez; si se perdió antes de salir, sí reduce el conteo físico. Las unidades cerradas antes de salir no pueden incluirse en un despacho posterior. Las rectificaciones regeneran los efectos físicos sin duplicarlos, pero no pueden eliminar una salida que ya sustenta unidades devueltas.

La migración JSON **4**, posterior al esquema comercial v3, fija una línea base de los pedidos históricos y sus reservas sin descontar otra vez sus salidas ni inventar existencias. Los productos sin conteo permanecen desconocidos; antes de nuevos despachos se debe contar físicamente el producto, incluidas sus reservas. Las instantáneas comerciales y los movimientos de caja anteriores no cambian. El respaldo sigue siendo v3 e incorpora `inventoryVersion:1`; los respaldos anteriores se normalizan a la misma línea base y los nuevos validan reservas, referencias y estados antes de escribir en destino.


### Puesta en marcha autónoma

Objetivo acordado: desde una cuenta nueva, dejar caja operativa, al menos un producto vendible y reglas de pedidos confirmadas en un máximo de diez minutos sin soporte. La guía guarda cada etapa y presenta solo lo imprescindible; personas/sueldos, bancos, reglas completas, importación y vitrina continúan accesibles opcionalmente.

Se propone una caja editable y un responsable vinculado al usuario, reutilizando los existentes y sus preferencias válidas. El saldo de apertura requiere confirmación explícita, incluido cero. El primer producto se crea en la misma guía con nombre, precio y conteo real; queda habilitado para pedidos administrativos, sin publicar ni inventar imagen o costo. Si ya existen caja válida, productos disponibles o pedidos reales, las etapas correspondientes aparecen como realizadas y muestran el motivo con sus cuentas/responsables, producto/precio/unidades y cantidad/último número de pedido. El resumen sigue visible al abrir la etapa final. No se piden de nuevo datos ya disponibles ni se modifican ventas históricas. Importar pedidos es opcional y no exige archivo ni perfil para continuar.

El diagnóstico de práctica ejecuta el guardado real de pedidos manuales (`saveOrderTx`), incluida su consulta, dentro de un `SAVEPOINT`. Revierte y libera ese punto antes de persistir únicamente el recibo por administrador en `business_requests`, scope `onboarding:trial`, separado de `orders`. Su ID ficticio no identifica un documento financiero: no admite cobros ni envíos operativos y no deja cambios en productos, inventario/reservas, caja, numeración, auditoría operativa, revisión ni informes/snapshots/Excel. Es repetible incluso tras finalizar; cada ejecución confirmada muestra su propio identificador y fecha y se recupera al recargar. Un fallo no se anuncia como éxito ni reemplaza el último recibo correcto. La prueba es opcional, no se convierte en venta y no acredita checkout, pagos ni servicios logísticos.

Completar exige datos reales activos, producto con precio/existencias disponibles y reglas vigentes, además de pedidos reales previos o confirmación explícita de esas reglas; el servidor no acepta una finalización inicial basada solo en un flag. Los pedidos existentes acreditan uso previo, no una revisión explícita de reglas, y consultarlos no cambia las marcas de configuración. La marca histórica `setupCompleted` se conserva, pero el estado mostrado se deriva de los recursos actuales. Vender la última unidad no bloquea otras preferencias. El canal comercial sigue siendo manual/WhatsApp, sin checkout, cobro automático ni publicación automática.


### Acceso y datos

Sesiones privadas de ocho horas con cookies HttpOnly; origen y CSRF en escrituras; contraseñas con scrypt y límite persistente de intentos. Registro público desactivado. **Usuarios** y CLI crean cuentas administradoras con acceso completo; personas/vendedores pueden existir sin login. La asignación de responsables no es un permiso de menor privilegio ni asignación de leads.

Datos personales, comprobantes, costos y márgenes privados no aparecen en DTO ni páginas públicas. La privacidad de un archivo externo depende de sus permisos de origen. La exportación comercial v3 incluye finanzas, auditoría, snapshots y binarios Excel retenidos, pero no autenticación/leases ni imágenes locales. Es información privada. La restauración conserva negocio en destino vacío, no fusiona; obliga a revisar publicación y reconstruye trabajos pendientes con actor original. SQLite original se copia solo lectura de forma consistente con WAL, sin migrarlo.

## Decisiones que faltan confirmar

| Tema | Valor de trabajo en el código | Confirmación necesaria |
|---|---|---|
| Plataforma de publicación | VM Linux/Compose/PostgreSQL detrás de Nginx según registro de despliegue | V3 requiere nueva aceptación nativa y promoción explícita; esta entrega local no cambia producción. Vercel/Supabase es alternativa con worker persistente externo. |
| Fallback | SQLite para desarrollo local; sin failover por caída | Docker usa PostgreSQL explícitamente. Cambiar de motor exige migración deliberada, no continuidad automática ni replicación. |
| Catálogos | Colecciones navegables dentro de la web | Confirmar que no significa archivos PDF descargables ni varios catálogos de precios. |
| Presentaciones y sabores | Referencias independientes | Confirmar si necesitan un selector de variantes dentro de un único producto. |
| Alta de pedidos | Manual después de WhatsApp | Confirmar que el visitante no debe crear directamente un pedido en esta fase. |
| Pagos parciales | Documentos y saldos calculados v3 | Confirmar capacitación, referencias y cuentas reales; no volver a editar un estado Pagado como sustituto del recaudo. |
| Reglas y correcciones | Políticas versionadas, eventos rectificables y devoluciones auditadas | Aprobar vigencias de costos, comisiones, sueldos y responsables antes de datos reales; no editar directamente la BD como rutina. |
| Entregas | Transportadora predeterminada; local/recogida disponibles en el panel | La Planilla solo confirmó ciudad, transportadora y contraentrega. Confirmar otras modalidades antes de ofrecerlas. |
| Operadores | Usuarios administradores y personas responsables independientes | Confirmar accesos individuales y responsables; no compartir contraseñas en el chat. |
| Redes y dominio | Dominio publicado según registro de despliegue | Confirmar enlaces sociales oficiales y vigencia del contenido; no inventar perfiles ni volver a registrar el dominio. |
| Contenido | Solo material entregado + borradores identificados | Productos adicionales, combos/precios, costos/cobertura/tiempos, horario y respuestas aprobadas. |
| Mantenimiento | No se modifica ni se cobra desde el software | Precisar fechas/tareas por los cinco meses ofrecidos; no se programa vencimiento ni tarifa de fase 2. |

## Criterios para entrega y publicación real

La aceptación técnica local de compilación, contratos SQLite/PostgreSQL, navegador HTTPS, permisos, caída/recuperación y respaldo/restauración se registra en [VERIFICACION.md](VERIFICACION.md). Los pedidos comerciales sintéticos de QA, cuentas E2E, resets y pruebas de caída se ejecutan exclusivamente en bases descartables; el fixture con reset exige `allnutrition_test`, y la restauración o aceptación independiente usa otra base vacía del mismo proyecto descartable. No deben confundirse con los recibos aislados de práctica de la guía. El staging persistente usa el seed de contenido aportado y su administrador propio, sin copiar cuentas ni ventas de prueba: revisar allí portada de preparación, login, panel, preview y enlaces desde celular. Antes de publicar en el servidor Linux con Compose elegido, validar la infraestructura remota según [DESPLIEGUE.md](DESPLIEGUE.md), confirmar reglas pendientes y aprobar contenido; luego entregar cuentas individuales e instrucciones.
