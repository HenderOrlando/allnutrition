# All Nutrition — Next.js, Supabase y SQLite · v2

Vitrina autoadministrada y panel privado. WhatsApp es el canal principal; Facebook e Instagram son enlaces complementarios. La fase 1 incluye administración de contenidos y pedidos manuales. No incluye captación de leads, seguimiento de oportunidades, chatbot, pasarela de pago, lectura de WhatsApp ni inventario automático.

## Estado de esta entrega

La aceptación local con `npm run verify:docker` terminó con código 0 sobre la imagen de producción: 118 pruebas Node (SQLite y PostgreSQL, sin omisiones), 12 pruebas Playwright de escritorio/móvil y auditoría sin vulnerabilidades. También se comprobaron TLS, permisos limitados, caída/recuperación, persistencia y respaldo/restauración. La arquitectura elegida es **un único servidor Linux con Docker Compose, PostgreSQL y Caddy HTTPS**. Esto no acredita una publicación remota, una ejecución remota de CI ni una conexión a un proyecto alojado en Supabase. Consulta [la evidencia y los límites](docs/VERIFICACION.md) y [el procedimiento de despliegue](docs/DESPLIEGUE.md).

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

## Imágenes y enlaces

En **Productos** se puede pegar una URL pública HTTPS o subir JPEG/JPG, PNG y WebP de hasta 10 MiB. La carga validada se optimiza a WebP, conserva la proporción y limita cada lado a 2400 px. El panel muestra el uso de la cuota local exacta de 1.000.000.000 bytes; el archivo se guarda fuera de la base de datos y el servidor lo entrega a la vitrina. En desarrollo local el directorio predeterminado es `data/product-images` (ignorado por Git); `MEDIA_DIR` permite configurarlo.

El volumen Docker persistente `product_images` conserva las imágenes locales de productos entre reinicios. El logo, las portadas de catálogos/combos y los comprobantes siguen usando los mecanismos existentes (recursos estáticos o enlaces HTTPS); no se copian al almacenamiento local. Si el selector del dispositivo ofrece iCloud Drive, un archivo JPEG/PNG/WebP compatible puede importarse desde allí como archivo local y consume esta misma cuota: no es una conexión de cuenta iCloud.

Las imágenes remotas se solicitan directamente desde el navegador y su disponibilidad depende del sitio de origen. Enlaces a carpetas o páginas sociales no son imágenes directas. La vista previa detecta errores de carga, pero no certifica propiedad ni disponibilidad futura.

## Funciones del panel

Productos y referencias, catálogos/colecciones, combos, preguntas frecuentes, mensajes comerciales, condiciones de envío, WhatsApp, redes, datos de contacto y pedidos. Incluye borradores/publicación/archivo, filtros, búsqueda, paginación de pedidos, prevención de conflictos de edición, datos históricos de líneas, historial de cambios y exportación comercial.

La sección **Usuarios** permite crear y consultar cuentas; todas reciben rol **Administrador**. Quien las crea define la contraseña inicial y debe compartirla por un canal seguro; no hay invitación automática ni roles de menor privilegio.

Cada presentación/sabor con precio o disponibilidad propios es una referencia independiente. Los combos reúnen referencias y cantidades con precio manual. La disponibilidad es manual: no hay entradas/salidas ni descuento de stock.

Pedidos: Nuevo → Preparando → Enviado → Entregado; Cancelado antes del despacho y Devuelto después del envío. Cancelar/devolver requiere motivo. Pago y pedido son independientes. El estado de pago puede ser Pendiente, Abono parcial, Pagado o Reembolsado; no se consulta a bancos. Los detalles y decisiones por confirmar están en `docs/REQUISITOS_Y_DECISIONES.md`.

## Despliegue

Arquitectura elegida: **Linux + Docker Compose + PostgreSQL 16 + Caddy** en un único servidor. El staging local usa `https://localhost:8443` con CA local; no se instala confianza automáticamente en el sistema. Credenciales y certificados se generan en archivos privados, nunca se copian de las pruebas a producción.

```bash
# Requiere Node 24, OpenSSL, Docker/Compose y Chromium de Playwright.
npm run verify:docker
# Genera o conserva configuración privada coherente; no arranca servicios.
npm run deploy:env -- staging
```

Sigue [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md) para iniciar staging, migrar con el rol privilegiado separado del runtime, generar configuración de producción y promover la imagen comprobada sin reconstruirla. No se ha proporcionado servidor ni dominio remoto: DNS, HTTPS público, firewall, capacidad y copias fuera del host siguen requiriendo validación allí.

**Vercel + Supabase sigue siendo una alternativa**, no el destino elegido. `npm run deploy` y `npm run deploy -- --prod` son exclusivamente el CLI de Vercel y requieren cuenta/proyecto configurados; no despliegan Compose. `vercel.json` conserva esa opción. El flujo CI reutiliza `npm run verify:docker`; la evidencia local no implica que CI remoto haya ejecutado correctamente.

## Cuentas, respaldos y cambio de motor

```bash
npm run admin:add       # usa ADMIN_EMAIL / ADMIN_PASSWORD del .env local
npm run admin:password  # modifica una cuenta existente y revoca sus sesiones
npm run backup         # respaldo comercial JSON, sin cuentas ni sesiones
npm run backup -- --full-sqlite # también copia completa SQLite, cuando corresponde
npm run db:import -- respaldo.json
npm run db:import -- --sqlite ./copia-original.sqlite
```

La importación solo acepta un destino sin productos ni pedidos; no sobrescribe ni fusiona. Conserva identificadores, pedidos e historial; obliga a revisar otra vez la publicación. Las cuentas se configuran en el destino, no se exportan al navegador. Mantén la base anterior respaldada y fuera de escritura al cambiar de motor. Una vuelta a SQLite exige otro respaldo/importación, no cambiar solamente la variable.

## Pruebas y reproducibilidad

```bash
npm ci
npm test               # SQLite; PostgreSQL opcional si no se configura su fixture
npm run check
npm run build
npx playwright install chromium
npm run verify:docker  # Aceptación completa obligatoria sobre PostgreSQL y runtime compilado
```

El lockfile real está incluido: no lo regeneres desde cero ni uses `npm update` para reproducir esta entrega. `verify:docker` construye la imagen, prepara una base descartable aislada `allnutrition_test`, ejecuta ambos contratos y E2E, comprueba operaciones y conserva evidencia sanitizada antes de eliminar exclusivamente su proyecto de pruebas.

`npm run test:e2e` es un subcomando, no un arranque autónomo: exige `E2E_BASE_URL` con origen **HTTPS de `localhost`**, el servidor compilado ya disponible y PostgreSQL descartable previamente migrado y sembrado con `node tests/e2e/setup.mjs`. El fixture requiere `TEST_DATABASE_URL` apuntando exactamente a `allnutrition_test` y `TEST_ALLOW_DATABASE_RESET=allnutrition_test`, más la configuración TLS `TEST_DB_*`. No arranca `next dev`, no tiene `webServer` ni fallback SQLite. `E2E_ALLOW_SELF_SIGNED=1` permite solo la CA local en el navegador; no desactiva TLS de PostgreSQL. Usa el verificador para coordinar estos pasos: nunca ejecutes reset, E2E destructivo ni pruebas de caída sobre staging persistente o producción.

## Documentación

- `docs/REQUISITOS_Y_DECISIONES.md`: trazabilidad de requisitos, flujos y decisiones de negocio pendientes.
- `docs/DESPLIEGUE.md`: Linux/Compose, staging HTTPS, promoción, permisos, respaldos y vuelta atrás; alternativas Vercel/Supabase y SQLite local.
- `docs/VERIFICACION.md`: qué se probó y qué sigue pendiente.
- `docs/ALCANCE_Y_FASES.md`: separación comercial, sin precio de fase 2.
- `docs/FUENTES.md`: archivos aportados y documentación técnica consultada.
- `docs/REGISTRO_PROVEEDORES_ALMACENAMIENTO.md`: pasos oficiales y límites verificados para registrar futuras aplicaciones de almacenamiento; no configura conectores ni cuentas.
