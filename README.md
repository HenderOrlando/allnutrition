# All Nutrition — administración de negocio · v3

Vitrina autoadministrada y panel privado para pedidos, inventario por referencia, seguimiento, recaudos, caja, gastos, liquidaciones, sueldos e informes. WhatsApp sigue siendo el canal comercial principal. No incluye CRM de interesados, chatbot, pasarela de pago, integración bancaria/logística ni facturación legal.

## Estado de esta entrega

La vitrina está publicada en **https://allnutrition.wintimeapp.co**. El destino real es una **VM Linux aislada con Docker Compose y PostgreSQL 16, detrás del Nginx del host**; Caddy se conserva para pruebas/staging y despliegues autónomos. Las aceptaciones, versiones, parches y límites se registran en [VERIFICACION.md](docs/VERIFICACION.md). El [procedimiento de despliegue](docs/DESPLIEGUE.md) exige validar la imagen en la arquitectura destino antes de promoverla; una aceptación local no acredita CI remoto ni una conexión a Supabase alojado.

La administración v3, el inventario v4, los menús, la guía y la recuperación de importaciones están desplegados con `allnutrition:release-1bc0af86a251` (`amd64`), aprobada nativamente antes del corte del **18 de octubre de 2026, 19:58–19:59 UTC**. Web y scheduler usan la misma imagen; las 42 tablas, contraseñas, configuración y medios coincidieron exactamente durante el corte.

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

Seis áreas: **Inicio, Pedidos, Productos, Caja, Informes y Configuración**. En móvil: Inicio/Pedidos/Caja/Más. Combos, catálogos, contenidos de la vitrina y Usuarios siguen disponibles como subdestinos y en «Ir a…». Los filtros y detalles usan URL normalizada; nunca se serializan formularios, contactos ni tokens. Atrás/adelante, Escape y cambios pendientes conservan el borrador hasta aceptar descartarlo.

**Configuración** abre la guía de inicio; el directorio completo se despliega con **Más opciones de configuración**, separado en operación del negocio, vitrina pública y acceso al panel. **Configurar cuentas del negocio** permite revisar cuentas y preferencias sin recorrer la guía. Las pantallas secundarias ofrecen **Volver a la guía de inicio** y **Cambiar de tarea**; los formularios conservan sus confirmaciones de cambios pendientes.

La sección **Usuarios** permite crear y consultar cuentas; todas reciben rol **Administrador**. Quien las crea define la contraseña inicial y debe compartirla por un canal seguro; no hay invitación automática ni roles de menor privilegio.

Cada presentación/sabor con precio o existencias propios es una referencia independiente. Combos y obsequios conservan composición histórica; un obsequio puede tener precio cero y costo real. Los costos y las cantidades son privados. Productos permite registrar existencias físicas, reservadas y disponibles: guardar un pedido reserva unidades, editar ajusta la reserva, cancelar la libera y despachar descuenta las unidades asignadas. Las devoluciones recuperables reingresan solo las unidades despachadas; combos y obsequios utilizan sus componentes. Vacío significa sin contar, no cero: bloquea nuevas reservas y despachos hasta registrar un conteo real. Las operaciones son transaccionales y auditadas, sin crear movimientos de caja.

Las devoluciones ya registradas conservan primero su asignación física, aunque otra devolución tenga el mismo instante de registro o el reloj retroceda. Una devolución nueva solo puede usar unidades despachadas aún no atribuidas; esto no permite eliminar un despacho que respalde devoluciones anteriores ni genera movimientos de caja.

La migración de inventario **4** conserva los despachos históricos sin volver a descontarlos y toma las reservas de pedidos pendientes; no inventa cantidades iniciales. SQLite actualiza al abrir una conexión nueva. En PostgreSQL, respaldar, detener todos los escritores antiguos, ejecutar `npm run db:migrate` con la nueva versión y reiniciar web/scheduler con esa misma versión. No mezclar procesos anteriores y nuevos. Los respaldos comerciales conservan el formato v3 con `inventoryVersion:1`; los anteriores reciben una línea base histórica al restaurarlos. Detalles y límites en [REQUISITOS_Y_DECISIONES.md](docs/REQUISITOS_Y_DECISIONES.md).

Pedidos: destinatario, productos, vendedor opcional y acuerdo económico; envíos, cobros y rentabilidad dentro del detalle. Guías/eventos, devoluciones, recaudos y reembolsos son documentos separados y auditables, no un campo «Pagado» editable. El recaudo de plataforma queda pendiente hasta confirmar la recepción de una liquidación. Después del despacho se preserva el acuerdo histórico; las correcciones explícitas conservan el registro anterior.

Caja registra cuentas con apertura explícita —también cero—, ingresos no comerciales, transferencias, gastos/pagos, anticipos y cierres. Un aporte del propietario no es una venta; una transferencia no altera el consolidado. Personas responsables y vendedores no necesitan credenciales de acceso. Sueldos/comisiones distinguen devengo, compensación y salida efectiva de dinero. Responsables, cuentas y vigencias se encuentran en **Configuración**, mediante **Gestionar personas y sueldos**, **Configurar cuentas del negocio** y **Revisar reglas y preferencias**.

### Puesta en marcha guiada

Desde **Inicio → Abrir guía de inicio**, el recorrido guarda cuatro etapas: **Caja → Producto → Pedidos → Prueba y listo**. El objetivo es completar lo mínimo en diez minutos con los datos reales a mano; se puede recargar o volver después sin repetir etapas guardadas.

- **Caja:** reconoce las cuentas, responsables y asignaciones válidas existentes y explica por qué la etapa está realizada. Si faltan, propone «Caja principal», la fecha de hoy en Bogotá y al administrador como responsable editable. Solo pide confirmar el dinero real de apertura, incluso si es cero. Reutiliza los datos guardados, completa las asignaciones predeterminadas que falten y no crea sueldos ni comisiones. La cuenta se puede editar con el editor habitual; su apertura se conserva como hecho histórico.
- **Producto:** reconoce los productos habilitados, no archivados, con precio y unidades disponibles, mostrando los datos que acreditan la etapa. Si no hay ninguno, pide nombre, precio de venta en pesos enteros y unidades físicas contadas. La dirección corta se genera automáticamente; presentación, SKU y costo son opcionales. Queda habilitado para pedidos del panel, en borrador y sin publicarse en la vitrina. No se inventan imagen, costo ni inventario.
- **Pedidos:** reconoce los pedidos reales ya guardados y muestra su cantidad y último número, sin exigir repetir la confirmación de inicio ni afirmar que se revisaron las reglas. Si no existen pedidos, permite revisar y confirmar las reglas vigentes sin cambiarlas. **Importar pedidos es opcional:** no se necesita un archivo ni un perfil de importación para continuar.
- **Prueba y listo:** ofrece un diagnóstico repetible, incluso después de finalizar la guía. Ejecuta la creación y consulta mediante el mismo guardado de los pedidos manuales dentro de un punto de restauración transaccional; revierte sus escrituras operativas y conserva únicamente un recibo ficticio con identificador y fecha propios. **No cobra ni deja reservas de stock, cambios en productos o movimientos de caja; tampoco consume numeración ni aparece en informes o ventas reales.** No verifica checkout, pagos ni logística. La práctica es opcional, nunca se convierte en una venta y no es requisito para finalizar.

La guía muestra las etapas realizadas y sus motivos basados en los datos guardados, también al abrir directamente la etapa final. Solo declara todo listo si existen cuenta/responsable activos y asignaciones válidas, un producto con precio y unidades disponibles, y reglas vigentes con pedidos previos o confirmación explícita. Bancos, sueldos, comisiones, importación, catálogo completo y publicación de la vitrina siguen disponibles como opciones avanzadas. Terminar la guía no publica la web ni inicia el scheduler.

## Excel e informes

**Pedidos → Importaciones** permite guardar el original, seleccionar plataforma/cuenta y hoja, mapear columnas/estados, resolver productos/vendedores reales y revisar grupos completos antes de aceptar. Admite `.xlsx`, `.xls`, `.xlsb` y `.xlsm`: máximo 10 MiB, 20 hojas, 200 columnas y 10.000 filas por hoja seleccionada. No ejecuta macros ni recalcula fórmulas; valores guardados de fórmulas requieren revisión. Un archivo aceptado conserva su revisión y puede reanudarse sin repetir dinero ni ventas. Originales privados: 7 días abandonados y 90 días después de finalizar; los hechos e historial no caducan con el archivo.

La lectura de muestras no se usa como tamaño completo de la hoja: los archivos sin dimensiones declaradas también admiten títulos antes del encabezado y columnas repetidas por posición. La revisión solo queda disponible cuando el trabajo del servidor termina; solicitarla no equivale a haber generado una vista previa válida.

Si falla la lectura o la extracción, el diagnóstico permanece dentro del importador e indica código, fase, ubicación conocida y una acción correctiva. Distingue archivo, configuración y fallo interno cuando hay evidencia; una fecha o importe ambiguos no se atribuyen automáticamente a una causa. Puedes navegar y volver a **Retomar lote**: conserva el archivo, las columnas guardadas y el último paso válido. **Nuevo lote** es una elección explícita, no un reinicio automático. Un historial de guías sin productos, cantidades y precios se revisa como seguimiento o se vincula con pedidos existentes; no genera ventas incompletas ni exige un saldo específico de caja.

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
