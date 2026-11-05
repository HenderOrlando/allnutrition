# All Nutrition — administración de negocio · v3

Vitrina autoadministrada y panel privado para pedidos, inventario por referencia, seguimiento, recaudos, caja, gastos, liquidaciones, sueldos e informes. WhatsApp sigue siendo el canal comercial principal. No incluye CRM de interesados, chatbot, pasarela de pago, integración bancaria/logística ni facturación legal.

## Estado de esta entrega

La vitrina está publicada en **https://allnutrition.wintimeapp.co**. El destino real es una **VM Linux aislada con Docker Compose y PostgreSQL 16, detrás del Nginx del host**; Caddy se conserva para pruebas/staging y despliegues autónomos. Las aceptaciones, versiones, parches y límites se registran en [VERIFICACION.md](docs/VERIFICACION.md). El [procedimiento de despliegue](docs/DESPLIEGUE.md) exige validar la imagen en la arquitectura destino antes de promoverla; una aceptación local no acredita CI remoto ni una conexión a Supabase alojado.

Web y scheduler ejecutan la misma imagen **`allnutrition:release-4d054869563c`** (`amd64`), publicada el **30 de octubre de 2026 (Bogotá)** sin rebuild ni migración. Incluye incorporación Excel mult hoja, vínculos retomables, combos privados y obsequios con composición real. Aceptación nativa: 682 contratos SQLite/PostgreSQL y 44 E2E sin fallos/omisiones; respaldo/restauración y preservación de tablas, esquema y medios comprobados. El libro real no se aplicó. Evidencia y límites en [VERIFICACION.md](docs/VERIFICACION.md).

La guía reconoce recursos previos y explica por qué están realizados; importar pedidos es opcional y el diagnóstico repetible no altera la operación ni los informes. Los lotes fallidos conservan archivo y extracción para retomarlos, con errores dentro del panel. Las cantidades no aportadas siguen desconocidas y deben contarse antes de reservar esas referencias. Evidencia y límites en [VERIFICACION.md](docs/VERIFICACION.md).

## Inicio local

Node.js **24.x** y npm. Usa el `package-lock.json` incluido mediante `npm ci`. No hace falta Supabase ni Docker para desarrollo local con SQLite.

```bash
npm ci
cp .env.example .env
# Editar .env: correo y contraseña únicos para el administrador.
# DB_DRIVER=auto y DATABASE_URL vacío seleccionan SQLite local.
npm run db:migrate
npm run setup
npm test
npm run check
npm run dev
```

En **otra terminal**, desde la misma raíz y con las mismas variables DB:

```bash
npm run business:jobs
# Un turno acotado para operación puntual:
npm run business:jobs:once
```

El worker procesa Excel, devengos, alertas e informes aunque nadie abra el panel. La web sola no lo sustituye. Inicio y Configuración muestran su heartbeat; tras tres minutos sin avance indican que la actualización automática está detenida.

Abre `http://localhost:3000/admin/login`. La vitrina pública empieza en modo preparación. El propietario puede revisar el catálogo en `http://localhost:3000/?preview=1` después de iniciar sesión. Para publicarlo debe activar **Publicar la vitrina** en Contacto y redes, después de revisar productos, textos, enlaces y envíos.

El comando setup no cambia contraseñas existentes ni duplica la carga inicial. No hay credenciales predefinidas. ADMIN_EMAIL y ADMIN_PASSWORD son solo para comandos locales de configuración; no hacen falta como secretos del frontend ni del runtime de Vercel después del alta.

## PostgreSQL y alternativa Supabase

El adaptador conserva el nombre de configuración `DB_DRIVER=supabase`, pero usa PostgreSQL estándar mediante `pg`; también conecta al servicio PostgreSQL de Docker sin una cuenta de Supabase. **No se utilizan la Data API, Supabase Auth ni Supabase Storage.** No necesitas anon key ni service-role key. Para la alternativa alojada en Supabase:

```dotenv
DB_DRIVER=supabase
DATABASE_URL=postgresql://USUARIO:CLAVE_CODIFICADA@HOST_REAL:6543/postgres
DATABASE_DIRECT_URL=postgresql://USUARIO:CLAVE_CODIFICADA@HOST_REAL_DE_MIGRACIONES:5432/postgres
DB_SSL=verify
DB_POOL_MAX=1
APP_URL=https://URL_REAL_DEL_DESPLIEGUE
```

Las cadenas se copian desde Connect en el proyecto de Supabase; no construyas el host suponiendo la región. Usa transaction pooler en Vercel y conexión directa o session pooler para migrar. `DATABASE_DIRECT_URL` es opcional y solo lo usa `db:migrate`. `SUPABASE_DATABASE_URL` es un alias opcional de DATABASE_URL con prioridad explícita. Codifica los caracteres reservados de la contraseña, también para evitar expansión accidental de `$` en `.env`.

Si la conexión necesita una CA específica, configura `DB_CA_CERT_FILE` con la ruta a un archivo PEM legible y no vacío, o `DB_CA_CERT` con el PEM inline, **nunca ambos**. TLS verifica cadena y hostname; no se desactiva la verificación para resolver un error de certificado. `DB_SSL=disable` solo admite loopback; no admite el hostname Docker `db`. La composición usa `DB_SSL=verify` y monta únicamente la CA en la aplicación.

```bash
npm run db:migrate
npm run setup
npm run dev
```

La migración crea un esquema **privado** `allnutrition`. No lo agregues a los esquemas expuestos por la Data API. Las rutas de Next.js autentican y autorizan al administrador. El navegador nunca recibe DATABASE_URL. La guía de despliegue explica un rol de ejecución con permisos limitados.

## Qué significa fallback

| Configuración | Resultado |
|---|---|
| `auto` con cadena PostgreSQL | PostgreSQL (adaptador `supabase`) |
| `auto` sin cadena, desarrollo local | SQLite persistente |
| `sqlite` explícito | SQLite, salvo en Vercel |
| `supabase` sin cadena | Error de configuración |
| PostgreSQL configurado pero no responde | Error; no cambia de motor |
| SQLite en Vercel | Error preventivo |

No hay failover automático ni replicación. Una caída de PostgreSQL NO crea otra base, NO copia datos y NO acepta pedidos en un SQLite vacío. Cambiar de motor requiere migración deliberada y comprobación. La composición Docker entregada configura PostgreSQL explícitamente, no un fallback SQLite.

## Vitrina y pedido por WhatsApp

Inicio, tarjetas, fichas de producto, combos y pedido comparten una identidad de gimnasio de alto contraste: titulares condensados, etiquetas técnicas y acentos rojos sobre claro/oscuro. Las imágenes siguen ampliadas y las acciones de compra son visibles sin hover. Las selecciones de dos a cuatro productos se equilibran en dos columnas en escritorio; en móvil el destacado aparece primero con precio y compra. El tema respeta inicialmente el dispositivo y conserva la elección en este navegador; los estilos están aislados del panel.

**Añadir a mi pedido** reúne referencias y cantidades en **Mi pedido**, muestra el subtotal y conserva la selección durante la sesión de la pestaña, incluso al navegar entre fichas. Los agotados permiten consultar reposición, pero no añadirse al pedido. Las consultas individuales incluyen producto, presentación y sabor. Los mensajes comerciales editables, descripciones, precios y condiciones se conservan. **Selección para tu entrenamiento** identifica la selección editorial, no un ranking de ventas ni popularidad.

**Continuar por WhatsApp** abre el número comercial configurado con la plantilla de consulta, una línea por producto con cantidad/presentación/sabor y un único total de productos. No repite precios unitarios, subtotales de línea ni añade otra solicitud al final; respeta el texto de la plantilla. Si la presentación o el sabor ya aparecen en el nombre, no se vuelven a añadir: la comparación usa palabras completas sin distinguir mayúsculas ni puntuación. El visitante revisa y envía el mensaje en WhatsApp; disponibilidad, pago y envío se acuerdan con el equipo. No hay checkout, cobro, reserva de inventario ni creación automática de pedidos en administración.

La tipografía [Barlow Condensed ExtraBold](https://github.com/google/fonts/tree/main/ofl/barlowcondensed) se sirve localmente mediante `next/font/local`, sin consultar a Google durante las visitas. El archivo original y su licencia SIL OFL 1.1 están incluidos en `public/brand/barlow-condensed-extrabold.ttf` y `public/brand/barlow-condensed-OFL.txt`. No se añaden afirmaciones de ventas, descuentos, urgencia o resultados.

## Imágenes y enlaces

En **Productos** se puede pegar una URL pública HTTPS o subir JPEG/JPG, PNG y WebP de hasta 10 MiB. La carga validada se optimiza a WebP, conserva la proporción y limita cada lado a 2400 px. El panel muestra el uso de la cuota local exacta de 1.000.000.000 bytes; el archivo se guarda fuera de la base de datos y el servidor lo entrega a la vitrina. En desarrollo local el directorio predeterminado es `data/product-images` (ignorado por Git); `MEDIA_DIR` permite configurarlo.

El volumen Docker persistente `product_images` conserva las imágenes locales de productos entre reinicios. El logo, las portadas de catálogos/combos y los comprobantes siguen usando los mecanismos existentes (recursos estáticos o enlaces HTTPS); no se copian al almacenamiento local. Si el selector del dispositivo ofrece iCloud Drive, un archivo JPEG/PNG/WebP compatible puede importarse desde allí como archivo local y consume esta misma cuota: no es una conexión de cuenta iCloud.

Las imágenes remotas se solicitan directamente desde el navegador y su disponibilidad depende del sitio de origen. Enlaces a carpetas o páginas sociales no son imágenes directas. La vista previa detecta errores de carga, pero no certifica propiedad ni disponibilidad futura.

## Funciones del panel

Siete áreas: **Inicio, Pedidos, Productos, Caja, Informes, Publicidad y Configuración**. En móvil: Inicio/Pedidos/Caja/Más; Publicidad se encuentra en Más. Combos, catálogos, contenidos de la vitrina y Usuarios siguen disponibles como subdestinos y en «Ir a…». Los filtros y detalles usan URL normalizada; nunca se serializan formularios, contactos ni tokens. Atrás/adelante, Escape y cambios pendientes conservan el borrador hasta aceptar descartarlo.

**Configuración** abre la guía de inicio; el directorio completo se despliega con **Más opciones de configuración**, separado en operación del negocio, vitrina pública y acceso al panel. **Configurar cuentas del negocio** permite revisar cuentas y preferencias sin recorrer la guía. Las pantallas secundarias ofrecen **Volver a la guía de inicio** y **Cambiar de tarea**; los formularios conservan sus confirmaciones de cambios pendientes.

La sección **Usuarios** permite crear y consultar cuentas; todas reciben rol **Administrador**. Quien las crea define la contraseña inicial y debe compartirla por un canal seguro; no hay invitación automática ni roles de menor privilegio.

Cada presentación/sabor con precio o existencias propios es una referencia independiente. Combos y obsequios conservan composición histórica; un obsequio puede tener precio cero y costo real. Los costos y las cantidades son privados. Productos permite registrar existencias físicas, reservadas y disponibles: guardar un pedido reserva unidades, editar ajusta la reserva, cancelar la libera y despachar descuenta las unidades asignadas. Las devoluciones recuperables reingresan solo las unidades despachadas; combos y obsequios utilizan sus componentes. Vacío significa sin contar, no cero: bloquea nuevas reservas y despachos hasta registrar un conteo real. Las operaciones son transaccionales y auditadas, sin crear movimientos de caja.

Las devoluciones ya registradas conservan primero su asignación física, aunque otra devolución tenga el mismo instante de registro o el reloj retroceda. Una devolución nueva solo puede usar unidades despachadas aún no atribuidas; esto no permite eliminar un despacho que respalde devoluciones anteriores ni genera movimientos de caja.

La migración de inventario **4** conserva los despachos históricos sin volver a descontarlos y toma las reservas de pedidos pendientes; no inventa cantidades iniciales. SQLite actualiza al abrir una conexión nueva. En PostgreSQL, respaldar, detener todos los escritores antiguos, ejecutar `npm run db:migrate` con la nueva versión y reiniciar web/scheduler con esa misma versión. No mezclar procesos anteriores y nuevos. Los respaldos comerciales mantienen el formato v3: los pedidos sin apertura conservan `inventoryVersion:1`; cuando hay incorporación con conteo físico se exporta `inventoryVersion:2`, con apertura y proyecciones validadas al restaurar, sin alterar existencias. Detalles de la incorporación en **Excel e informes**.

Pedidos: destinatario, productos, vendedor opcional y acuerdo económico; envíos, cobros y rentabilidad dentro del detalle. Guías/eventos, devoluciones, recaudos y reembolsos son documentos separados y auditables, no un campo «Pagado» editable. El recaudo de plataforma queda pendiente hasta confirmar la recepción de una liquidación. Después del despacho se preserva el acuerdo histórico; las correcciones explícitas conservan el registro anterior.

Caja registra cuentas con apertura explícita —también cero—, ingresos no comerciales, transferencias, gastos/pagos, anticipos y cierres. Un aporte del propietario no es una venta; una transferencia no altera el consolidado. Personas responsables y vendedores no necesitan credenciales de acceso. Sueldos/comisiones distinguen devengo, compensación y salida efectiva de dinero. Responsables, cuentas y vigencias se encuentran en **Configuración**, mediante **Gestionar personas y sueldos**, **Configurar cuentas del negocio** y **Revisar reglas y preferencias**.

**Seguro de envío** es un gasto logístico opcional y separado del flete. Usa la fecha explícita del cargo, no la entrega ni el corte del archivo. Sin observación no se exige; vacío observado significa costo desconocido, cero explícito significa sin cargo, y un importe sin fecha mantiene cobertura pendiente. Reduce contribución y la métrica **Transporte y seguros** sin mover caja: pagar o confirmar una retención sigue siendo una acción explícita. Requiere **esquema 6**: SQLite migra al abrir una conexión nueva; PostgreSQL exige `npm run db:migrate` antes de iniciar web y scheduler con la misma versión. Esta entrega no actualiza producción.

### Publicidad orgánica y pauta de Facebook/Instagram

Módulo implementado y verificado localmente, **sin habilitación ni aceptación real de Meta en producción**. Se abre en **Publicidad** (`/admin?section=advertising`) y separa **Publicaciones y pauta, Piezas, Resultados y Conexiones**.

1. **Conexiones:** elegir API oficial mediante OAuth o navegador/scraper mediante acceso asistido. Son vías independientes; un fallo de API nunca publica mediante navegador. La sesión del navegador se conserva cifrada, puede caducar y exige intervención ante 2FA, restricciones o cambios de interfaz. El visor sólo permite completar el acceso, no publicar ni invertir.
2. **Piezas:** subir material propio ya terminado. El original es privado; la aprobación usa el JPEG o MP4 normalizado que se puede revisar/reproducir. No se generan creativos, recortan piezas ni inventa audio. La cuota y el volumen son independientes del catálogo.
3. **Preparación:** completar vía/cuenta/objetivo, pieza/texto, audiencia/ubicaciones, inversión/fechas y estimación/confirmación. Se puede guardar incompleto y retomar por URL. El presupuesto pagado es un total único para ambas redes, no diario ni duplicado. La preparación nativa requiere consentimiento explícito para crear y validar el mismo borrador privado.
4. **Aceptación:** audiencia potencial, historial comparable y escenario declarado son cosas distintas; datos insuficientes no producen una predicción. Aprobar orgánico encola su publicación inmediata o programada; aprobar pauta sólo prepara objetos PAUSED o un borrador sin entrega. Activar o reanudar gasto exige otra aceptación del total/restante y fechas originales.
5. **Resultados:** conservar fuente, período, definición, precisión y cobertura; no sumar alcance entre redes ni convertir faltantes en cero. Presupuesto, gasto reportado por Meta, gastos registrados y pagos se muestran separados. Vincular documentos existentes declara origen, no causalidad, y no crea dinero ni ventas. Aplicar una mejora abre un borrador nuevo sin fechas/aprobaciones/IDs remotos, sin aumentar presupuesto ni publicar automáticamente.

El worker general procesa piezas, API y análisis local, además de sus trabajos contables habituales. El navegador usa un consumidor adicional, con heartbeat y proceso independientes:

```sh
npm run business:jobs
npm run business:jobs -- --social-browser
# Un turno acotado de cada modo:
npm run business:jobs -- --once
npm run business:jobs -- --once --social-browser
```

`SOCIAL_PUBLISHING_ENABLED` y `SOCIAL_BROWSER_ENABLED` siguen en `false` por defecto. No habilitarlos con cuentas reales sin permisos, autorización del propietario y aceptación del proveedor actual. Claves, perfil aislado, volumen de medios, backup y prerrequisitos externos: [DESPLIEGUE.md](docs/DESPLIEGUE.md#publicidad-habilitación-y-custodia). Evidencia y límites del ensayo: [VERIFICACION.md](docs/VERIFICACION.md).


### Puesta en marcha guiada

Desde **Inicio → Abrir guía de inicio**, el recorrido guarda cuatro etapas: **Caja → Producto → Pedidos → Prueba y listo**. El objetivo es completar lo mínimo en diez minutos con los datos reales a mano; se puede recargar o volver después sin repetir etapas guardadas.

- **Caja:** reconoce las cuentas, responsables y asignaciones válidas existentes y explica por qué la etapa está realizada. Si faltan, propone «Caja principal», la fecha de hoy en Bogotá y al administrador como responsable editable. Solo pide confirmar el dinero real de apertura, incluso si es cero. Reutiliza los datos guardados, completa las asignaciones predeterminadas que falten y no crea sueldos ni comisiones. La cuenta se puede editar con el editor habitual; su apertura se conserva como hecho histórico.
- **Producto:** reconoce los productos habilitados, no archivados, con precio y unidades disponibles, mostrando los datos que acreditan la etapa. Si no hay ninguno, pide nombre, precio de venta en pesos enteros y unidades físicas contadas. La dirección corta se genera automáticamente; presentación, SKU y costo son opcionales. Queda habilitado para pedidos del panel, en borrador y sin publicarse en la vitrina. No se inventan imagen, costo ni inventario.
- **Pedidos:** reconoce los pedidos reales ya guardados y muestra su cantidad y último número, sin exigir repetir la confirmación de inicio ni afirmar que se revisaron las reglas. Si no existen pedidos, permite revisar y confirmar las reglas vigentes sin cambiarlas. **Importar pedidos es opcional:** no se necesita un archivo ni un perfil de importación para continuar.
- **Prueba y listo:** ofrece un diagnóstico repetible, incluso después de finalizar la guía. Ejecuta la creación y consulta mediante el mismo guardado de los pedidos manuales dentro de un punto de restauración transaccional; revierte sus escrituras operativas y conserva únicamente un recibo ficticio con identificador y fecha propios. **No cobra ni deja reservas de stock, cambios en productos o movimientos de caja; tampoco consume numeración ni aparece en informes o ventas reales.** No verifica checkout, pagos ni logística. La práctica es opcional, nunca se convierte en una venta y no es requisito para finalizar.

La guía muestra las etapas realizadas y sus motivos basados en los datos guardados, también al abrir directamente la etapa final. Solo declara todo listo si existen cuenta/responsable activos y asignaciones válidas, un producto con precio y unidades disponibles, y reglas vigentes con pedidos previos o confirmación explícita. Bancos, sueldos, comisiones, importación, catálogo completo y publicación de la vitrina siguen disponibles como opciones avanzadas. Terminar la guía no publica la web ni inicia el scheduler.

Si ya llevas la operación en un libro, **Ya llevo mi negocio en Excel** abre el mismo importador de Pedidos. Es una alternativa a la guía manual: no exige crear antes caja ni un pedido de prueba, y registrar gastos no marca la caja como preparada.

## Excel e informes

**Pedidos → Importar Excel** abre **Importaciones**, un historial filtrable por origen y estado, con página/filtros conservados al abrir, volver, recargar o usar Atrás/Adelante. **Nueva importación** inicia un recorrido separado: **Archivo → Hojas y columnas → Revisar datos → Confirmar**. Puedes crear un origen para tus archivos, usar su cuenta Principal o elegir otra cuenta independiente, y reutilizar una **configuración guardada** opcional. El original permanece privado; guardar un borrador no valida ni aplica sus operaciones.

Sin `batch` la URL representa el historial; `batch=new` abre el alta y `batch=<id>` retoma una importación guardada. No se guardan archivos, celdas, contactos ni búsquedas de filas en la URL o localStorage. Una carga fallida conserva el ID creado para reintentar en la misma importación, sin sustituir bytes ya recibidos.

| Límite del libro | Valor |
|---|---|
| Formatos de entrada | `.xlsx`, `.xls`, `.xlsb`, `.xlsm` |
| Tamaño comprimido | 10 MiB |
| Hojas | 50 |
| Columnas por hoja | 200 |
| Filas por hoja seleccionada | 10.000 |
| Filas seleccionadas del libro | 50.000 |
| Conservación del original privado | 7 días abandonado; 90 días después de finalizar |

Las dimensiones y muestras no son un conteo de transacciones; una hoja sin encabezado reconocible permite selección manual o exclusión expresa. Se conservan títulos, columnas repetidas por posición y errores localizados por hoja. No se ejecutan macros, enlaces externos ni fórmulas: usar sus valores guardados exige aceptación explícita, y un error o caché ausente en un campo utilizado bloquea la fila. Los hechos y el historial no caducan con el archivo.

Visitar una hoja no la incluye: cada hoja real necesita una decisión explícita **Incluir esta hoja** o **No importar esta hoja**. El catálogo distingue sin decidir, por configurar, lista para revisar y excluida; «lista para revisar» no equivale a datos comercialmente válidos. **Siguiente hoja pendiente** y **Ir a la siguiente columna pendiente** conducen al trabajo faltante sin aceptar propuestas ni exclusiones.

El perfil **v2** guarda propósito, encabezado, columnas, estados, valores fijos y exclusión por hoja. Las propuestas y **Aplicar a hojas similares** requieren confirmar las hojas afectadas; una columna de aspecto numérico no demuestra que sea celular. Al reutilizar un perfil, confirma **Este archivo está actualizado hasta…** para las hojas elegidas: no se arrastra un corte constante antiguo ni se toma la hora de subida. Una columna real de corte mantiene prioridad. Los perfiles anteriores se adaptan al abrirlos y el próximo guardado usa v2; no se reescriben revisiones ya aceptadas.

La revisión solo queda disponible cuando el trabajo del servidor termina. Antes de aceptar puedes completar celdas con motivo conservando el original, vincular productos reales, resolver identidades/duplicados y revisar fechas discrepantes. Nunca se corrige un año por el nombre del mes o del archivo. Sin IDs, generar identidades requiere confirmar que cada fila representa un pedido y un envío; no usa nombre, celular ni número de fila como identificador. Una operación parecida no se suma ni se convierte silenciosamente en otra venta: debe vincularse, omitirse como duplicada o declararse independiente.

**Filas originales y motivos** permite buscar dentro de esta importación, filtrar por estado y abrir la hoja/fila exactas de un problema, incluso fuera de la página visible. **Ver todas las filas** elimina esa ubicación; buscar o cambiar estado vuelve a página 1. Una ubicación inexistente muestra que no está disponible, nunca otra fila. Las filas ya aplicadas no reciben controles de corrección.

Las acciones masivas muestran primero las columnas, hojas o registros afectados. Puedes confirmar una lista de exclusiones propuestas y aplicar reglas realmente comunes a los seleccionados; no rellenan clientes, celulares ni costos inventados. Declarar operaciones independientes asigna una identidad técnica distinta a cada fila. En apertura, cada casilla corresponde a una observación física concreta, sin respuesta preseleccionada. Las resoluciones se guardan por bloques conservando el progreso confirmado; si falla uno, se indica lo pendiente en vez de afirmar que se guardó todo.

La asignación muestra **Columna del archivo → Ejemplo → Dato en All Nutrition** por posición, con resumen de asignadas, sin decidir, ignoradas y problemas. Busca por encabezado, letra, número o destino; filtra el listado sin perder el borrador. Un único diálogo permite buscar todo el catálogo, consultar tipo/efecto y elegir grupos de producto **1–50**. Flechas, Inicio/Fin y Enter recorren los resultados; Tab/Shift+Tab permanecen dentro del diálogo y Escape cierra sin cambiar, devolviendo el foco.

Una columna **sin decidir** bloquea la revisión: asigna un destino o confirma **Ignorar columnas sin decidir**, con su lista completa de afectados. Guardar nunca convierte pendientes en ignoradas. Los destinos ocupados indican su columna y no se pueden repetir en el mismo grupo. Los perfiles antiguos con destinos repetidos conservan ambas asignaciones y señalan todas las columnas afectadas; deben corregirse antes de guardar o revisar. Los valores largos pueden desplegarse completos, también en móvil.

El **estado del envío en la plataforma** es administrativo e informativo; **estado de la entrega / seguimiento** conserva `rawStatus` y sus equivalencias explícitas. `PAGADA` no demuestra entrega ni cobro. Tipo de envío, valor asegurado/declarado y valor a recaudar tampoco generan dinero. Las observaciones del envío y del destinatario se conservan por fuente con corte, lote, hoja, columna y filas; un corte anterior no sustituye el vigente y un valor discrepante sin corte posterior comparable exige revisión con motivo. No se usa la fecha de carga para decidir autoridad.

**Conservar como campo adicional** admite nombres propios distintos (1–100 caracteres) y texto de hasta 4.000 caracteres, sin ejecutar HTML ni fórmulas. La identidad normaliza Unicode, espacios y mayúsculas; nombres como `status` o `__proto__` siguen siendo datos, no propiedades de negocio. Máximo 200 claves informativas por fuente y envío. Vacíos no borran valores anteriores. Los campos nuevos del pedido llegan al pedido nuevo; modificar uno existente exige autorización comercial explícita con motivo, respetando las restricciones posteriores al despacho. Los perfiles y respaldos v3 conservan nombres adicionales, grupos y procedencia.

### Gastos, costos y conteo físico

**Publicidad** (`advertising`), **Operación** (`operating`) y **Otros** (`other`) son categorías distintas. Los gastos pueden venir por fila o por campañas con cantidad × costo unitario; el cálculo monetario es exacto y un total de control discrepante exige corrección, no genera otro gasto. Vacío no equivale a cero. Registrar estos gastos no requiere cuenta ni crea pagos, cobros o entradas de caja; «Pagado» en Excel no acredita dinero recibido.

**Campaña de origen** del pedido es atribución comercial, aunque el archivo la llame PAUTA: no es un importe ni otro gasto publicitario. El **costo histórico unitario** pertenece a la línea del pedido y no cambia el costo actual del catálogo; los productos compuestos requieren costos reales de componentes. Publicidad y operación reducen el resultado operativo, no se descuentan otra vez de contribución ni se duplican en Otros gastos.

Para incorporar historia, confirma **Fecha del conteo físico** y las existencias actuales reales de los productos. La apertura solo se aplica a pedidos nuevos: un despacho anterior ya reflejado en ese conteo no vuelve a descontar, un pendiente reserva y los hechos físicos posteriores modifican existencias. No se estiman saldos sumando ventas. Movimientos y devoluciones del mismo día del conteo o sin fecha real requieren decidir explícitamente **Ya estaba reflejado en el conteo** o **Ocurrió después**; no se usa corte, carga o confirmación como fecha del hecho. Las correcciones conservan evidencia y recalculan la proyección, sin reintegros ficticios por borrar consumo histórico.

La apertura auditable y sus decisiones incluidas/excluidas se conservan al reimportar y respaldar. La proyección de inventario v2 separa consumo físico y consumo incluido en apertura; la restauración valida ambas y las reservas agregadas, sin convertir pedidos antiguos ni cambiar stock por restaurarlos.

### Descargas y reimportación segura

Todas las descargas requieren sesión administrativa; ninguna se publica como archivo estático:

- **Original:** el archivo recibido sin modificar, con las celdas no importadas.
- **Copia ampliada:** para XLSX ordinario agrega únicamente `GASTOS OPERACION`, vacía y con encabezados, conservando las partes originales ajenas al registro de la nueva hoja. Si ya existe con otra estructura, informa conflicto y no sobrescribe. XLS/XLSB/XLSM mantienen su importación normal y usan la plantilla separada, sin prometer conversión sin pérdida ni eliminar macros.
- **Plantilla de negocio:** tablas vacías de ventas, envíos, publicidad y operación con instrucciones; fechas `AAAA-MM-DD`, moneda COP e identificadores como texto. No contiene gastos de ejemplo que puedan importarse por accidente.
- **Datos preparados para volver a importar:** requieren original y revisión actualizada o aceptada y pueden descargarse antes de aplicar. Llevan los datos seleccionados/corregidos e IDs estables para editar, reordenar y reimportar sin duplicar; no son una copia íntegra del original ni confirman políticas o autorizaciones del siguiente lote. Tras aceptar, descargan esa revisión congelada, no correcciones posteriores. Incluyen tablas auxiliares de asignaciones, costos de componentes y observaciones, y **POR COMPLETAR** con pendientes excluidos de las tablas activas. Los auxiliares acompañan entidades reales, no las crean por sí solos. El origen previo que declara el archivo (`declaredOrigin`) se muestra como **Origen declarado en el archivo**; la procedencia autoritativa es la del nuevo lote.
- **Pendientes y errores:** filas con motivos conservados; pueden seguir disponibles sin original y no requieren un preview vigente. El archivo puede estar vacío si no hay pendientes.

El preparado divide tablas grandes sin truncarlas y respeta los mismos límites de lectura; si los supera, falla antes de entregar un archivo inválido. **Archivos y descargas** muestra disponibilidad y motivo por tipo. Al caducar o descartar el original, las descargas que necesitan sus bytes quedan indisponibles; otro archivo requiere **Nueva importación**, no reemplazar la importación existente. Los hechos aplicados se conservan; el vencimiento de una pendiente no garantiza conservar todas sus filas fuente.

El original no disponible también bloquea una revisión retomada después de una aplicación parcial, aunque el servidor conserve su estado `review`. Se presenta el resultado de archivo no disponible, no acciones de corrección deshabilitadas sin salida. La última revisión no aceptada queda identificada como tal; los contadores de lectura/revisión no se presentan como operaciones aplicadas.

### Aplicación y administración

La aceptación congela configuración, resoluciones y destinos de la revisión. Cada operación comercial o fila de gastos se aplica en su propia transacción: **no existe atomicidad de todo el libro**. El resumen distingue creados, actualizados, sin cambios, omitidos y pendientes por hoja/tipo. Importar solo válidos exige marcar explícitamente la casilla en **Confirmar**; volver a corregir o cambiar la revisión la desmarca. **Confirmar e importar** es la única aceptación final y no confirma cobros ni pagos.

**Importación parcial: quedan pendientes** no es éxito total. **Revisar pendientes** solicita una revisión nueva sin volver a aceptar: conserva lo ya aplicado, permite corregir solo lo pendiente y exige otra confirmación. Los hechos de `progress` se muestran separados de la proyección anterior aceptada. Editar después una configuración guardada no cambia lo ya aceptado.

La incorporación requiere **esquema 7, después del 6**. La migración v7 amplía las categorías de gasto, exige el prerrequisito v6, es idempotente y conserva relaciones/índices; fallo de DDL y marcador revierte conjuntamente. Antes de un rollout: respaldo recuperable, aceptación aislada en ambos motores, detener escritores antiguos, ejecutar la migración con la versión nueva y arrancar web y scheduler con esa misma versión. No mezclar versiones ni usar una imagen antigua como rollback de un esquema migrado sin restauración compatible. **Producción quedó en esquema 7 con Next.js 16.4.3 el 30 de octubre de 2026**; evidencia de aceptación y preservación en [VERIFICACION.md](docs/VERIFICACION.md).

La incorporación original obtuvo aceptación local y nativa Linux/amd64 con 670 contratos SQLite/PostgreSQL y 42 E2E. La corrección de continuidad de vínculos está publicada como `allnutrition:release-54dffbbf173d`: aceptación nativa completa con 672 contratos sin fallos ni omisiones y 44 E2E de escritorio/móvil, auditoría sin vulnerabilidades conocidas y caída/reinicio/restauración; sin rebuild ni migración al publicar. El libro real se revisó por completo y mostró pendientes accionables; **no se aceptó ni aplicó con datos no confirmados**. Resultados, límites y ejecuciones rechazadas en [VERIFICACION.md](docs/VERIFICACION.md).

Si falla la lectura o la extracción, el diagnóstico indica código, fase, ubicación conocida y acción acreditada. **Actualizar estado** solo consulta; **Generar revisión nueva** vuelve a revisar y **Volver a leer el archivo** solo se ofrece para una lectura recuperable sin workbook. Un archivo defectuoso exige conservar evidencia y una nueva importación explícita, no reintentos silenciosos. Un conflicto `409` conserva el borrador y permite **Recargar lo guardado**, con guarda si hay cambios locales; no repite la aceptación automáticamente. Desde el historial puedes continuar, revisar pendientes o consultar el resultado conservando archivo retenido, configuración guardada y estado actual. Un historial de guías sin productos, cantidades y precios se revisa como seguimiento o se vincula con pedidos existentes; no genera ventas incompletas ni exige un saldo específico de caja.

Para vincular una referencia del Excel con un producto que ya existe, selecciona **Registro que se vinculará** y pulsa **Guardar vínculo**: se guarda en el lote sin crear otro producto ni importar pedidos. **Vínculos guardados** muestra la referencia y el producto, permite cambiarlo y permanece al retomar o recargar. Después usa **Guardar cambios y revisar** para validar sus efectos. **Guardar lote y crear producto** es una alternativa solo sin selección existente; cancelar esa alta restaura el diálogo, la referencia, el motivo y la búsqueda, sin borrar los vínculos ya guardados.

**Productos por vincular** conserva los pendientes de la última revisión aunque guardes un vínculo y se invalide el preview. Puedes vincularlos consecutivamente, salir y retomar sin recalcular todo después de cada producto; solo desaparecen las referencias cubiertas por los vínculos guardados. Es una lista de trabajo, no una revisión aprobada: al terminar usa **Guardar cambios y revisar** antes de importar.

Antes de terminar puedes **Descartar archivo** durante la carga/preparación o **Cancelar importación** después de confirmar, incluso con el worker activo. El diálogo lista archivo y consecuencias; cerrarlo no escribe nada. Solo la respuesta del servidor confirma el descarte: se detiene lo pendiente al concluir la transacción en curso y se elimina el original privado; **no se revierten pedidos, existencias, recaudos ni liquidaciones ya confirmados**. Se conservan revisiones y filas fuente como evidencia. La importación cancelada queda de solo lectura: para otro archivo, usa **Nueva importación**.

Una importación terminada, también con excepciones, **no admite descarte ni cancelación**, aunque la pantalla esté desactualizada o después se revisen sus pendientes. El servidor rechaza la operación con `409`; confirmar la última operación también cierra la posibilidad de cancelar antes de que el worker publique su estado final. Esta ampliación requiere **esquema 5** y está publicada en producción desde el **19 de octubre de 2026** con `allnutrition:release-73620e997c62`; véase [DESPLIEGUE.md](docs/DESPLIEGUE.md).


Informes diarios, semanales, mensuales, trimestrales, semestrales y anuales en `America/Bogota`: consulta viva, detalle explicativo, snapshots inmutables y XLSX con Resumen/Detalle/Definiciones. Los períodos históricos anteriores a `reportsStartOn` se solicitan expresamente. Falta de costo/fecha se muestra como cobertura pendiente, no beneficio ficticio; un corte de archivo sin hora no adquiere la hora de subida. Los importes internos son centavos enteros seguros. Agregados con 16 o más dígitos en centavos se exportan como texto decimal COP exacto para evitar la pérdida de precisión de Excel.

## Despliegue

Producción usa la VM privada `allnutrition-prod` y el Nginx existente del host; no se publica PostgreSQL ni se inicia otro proxy sobre los puertos públicos. Caddy sirve el HTTPS local de las instancias de prueba y sigue disponible para un despliegue autónomo. Las credenciales y certificados privados del servidor se conservan entre actualizaciones; nunca se copian desde las pruebas a producción.

```bash
# Requiere Node 24, OpenSSL, Docker/Compose y Chromium de Playwright.
npm run verify:docker
# Añade recorrido comercial visible y pausa de aceptación:
npm run verify:docker -- --interactive
# Genera o conserva configuración privada coherente; no arranca servicios.
npm run deploy:env -- staging
```

Sigue [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md) para la topología real, aceptación nativa, backup, migración con rol privilegiado separado y promoción de la imagen comprobada sin reconstruir su tag. Las actualizaciones conservan la configuración privada y los volúmenes de producción, cambian la selección de `APP_IMAGE` y verifican HTTPS, acceso y datos después del cambio. Las copias cifradas fuera del host y su política de retención siguen requiriendo operación explícita.

**Vercel + Supabase sigue siendo una alternativa**, no el destino elegido. `npm run deploy` y `npm run deploy -- --prod` son exclusivamente el CLI de Vercel y requieren cuenta/proyecto configurados; no despliegan Compose. `vercel.json` conserva esa opción. El flujo CI reutiliza `npm run verify:docker`; la evidencia local no implica que CI remoto haya ejecutado correctamente.

## Cuentas, respaldos y cambio de motor

```bash
npm run admin:add       # usa ADMIN_EMAIL / ADMIN_PASSWORD del .env local
npm run admin:password  # modifica una cuenta existente y revoca sus sesiones
npm run backup         # JSON comercial v3 privado: finanzas y Excel retenidos, sin autenticación
npm run backup -- --full-sqlite # también copia completa SQLite, cuando corresponde
npm run db:import -- respaldo.json
npm run db:import -- --sqlite ./copia-original.sqlite
```

La importación exige un destino sin contenidos, pedidos ni entidades comerciales; admite defaults iniciales y usuarios locales, pero no fusiona ni sobrescribe un negocio existente. Conserva relaciones, importes, auditoría, snapshots, originales retenidos e idempotencia; obliga a revisar otra vez la publicación. Admite respaldo v3 y conversión v2. No transporta usuarios, sesiones ni leases; reconstruye trabajos pendientes con su actor original. Un vínculo de persona a usuario solo permanece si ese usuario existe localmente. Al importar SQLite se abre el origen solo lectura y se migra una copia temporal consistente con WAL, nunca el archivo original. Las imágenes se restauran por separado. Mantén el origen respaldado y fuera de escritura al cambiar de motor.

## Pruebas y reproducibilidad

```bash
npm ci
npm test               # SQLite; PostgreSQL opcional si no se configura su fixture
npm run check
npm run build
npx playwright install chromium
npm run verify:docker -- --interactive # Aceptación completa con PostgreSQL, scheduler y recorrido comercial UI
```

El lockfile real está incluido: no lo regeneres desde cero ni uses `npm update` para reproducir esta entrega. `verify:docker` construye la imagen, prepara únicamente `allnutrition_test`, ejecuta contratos/E2E, TLS, rol limitado, scheduler, caída/reinicio y restore, y conserva evidencia sanitizada antes de eliminar solo su proyecto. `--interactive` añade el escenario comercial real por UI y una pausa Enter; EOF/señal cancela. Sin flag conserva la ejecución automatizada. Nunca usa el env de producción.

`npm run test:e2e` es un subcomando, no un arranque autónomo: exige `E2E_BASE_URL` con origen **HTTPS de `localhost`**, el servidor compilado ya disponible y PostgreSQL descartable previamente migrado y sembrado con `node tests/e2e/setup.mjs`. El fixture requiere `TEST_DATABASE_URL` apuntando exactamente a `allnutrition_test` y `TEST_ALLOW_DATABASE_RESET=allnutrition_test`, más la configuración TLS `TEST_DB_*`. No arranca `next dev`, no tiene `webServer` ni fallback SQLite. `E2E_ALLOW_SELF_SIGNED=1` permite solo la CA local en el navegador; no desactiva TLS de PostgreSQL. Usa el verificador para coordinar estos pasos: nunca ejecutes reset, E2E destructivo ni pruebas de caída sobre staging persistente o producción.

## Documentación

- `docs/REQUISITOS_Y_DECISIONES.md`: trazabilidad de requisitos, flujos y decisiones de negocio pendientes.
- `docs/DESPLIEGUE.md`: Linux/Compose, staging HTTPS, promoción, permisos, respaldos y vuelta atrás; alternativas Vercel/Supabase y SQLite local.
- `docs/VERIFICACION.md`: qué se probó y qué sigue pendiente.
- `docs/CAMBIOS_V2.md`: cambios v3 y antecedentes de versiones anteriores.
- `docs/ALCANCE_Y_FASES.md`: separación comercial, sin precio de fase 2.
- `docs/FUENTES.md`: archivos aportados y documentación técnica consultada.
- `docs/REGISTRO_PROVEEDORES_ALMACENAMIENTO.md`: pasos oficiales y límites verificados para registrar futuras aplicaciones de almacenamiento; no configura conectores ni cuentas.
