# All Nutrition — Next.js, Supabase y SQLite · v2

Vitrina autoadministrada y panel privado. WhatsApp es el canal principal; Facebook e Instagram son enlaces complementarios. La fase 1 incluye administración de contenidos y pedidos manuales. No incluye captación de leads, seguimiento de oportunidades, chatbot, pasarela de pago, lectura de WhatsApp ni inventario automático.

## Estado de esta entrega

El código está actualizado, con pruebas ejecutadas en SQLite y navegador, compilación Next.js y configuración para desplegar. **No está publicado ni conectado a un proyecto real de Supabase.** Consulta `docs/VERIFICACION.md`: la integración PostgreSQL, Docker, Vercel y la infraestructura real siguen pendientes. No interpretar el ZIP como una aplicación ya certificada en producción.

## Inicio local

Node.js 22.16 o posterior dentro de la rama 22; npm. No hace falta Supabase para desarrollo local.

```bash
npm install
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

## Supabase: conexión real por PostgreSQL

Se utiliza el PostgreSQL de Supabase desde el servidor con `pg`. **No se utilizan la Data API, Supabase Auth ni Supabase Storage.** No necesitas anon key ni service-role key.

```dotenv
DB_DRIVER=supabase
DATABASE_URL=postgresql://USUARIO:CLAVE_CODIFICADA@HOST_REAL:6543/postgres
DATABASE_DIRECT_URL=postgresql://USUARIO:CLAVE_CODIFICADA@HOST_REAL_DE_MIGRACIONES:5432/postgres
DB_SSL=verify
DB_POOL_MAX=1
APP_URL=https://URL_REAL_DEL_DESPLIEGUE
```

Las cadenas se copian desde Connect en el proyecto de Supabase; no construyas el host suponiendo la región. Usa transaction pooler en Vercel y conexión directa o session pooler para migrar. `DATABASE_DIRECT_URL` es opcional y solo lo usa `db:migrate`. `SUPABASE_DATABASE_URL` es un alias opcional de DATABASE_URL con prioridad explícita. Codifica los caracteres reservados de la contraseña, también para evitar expansión accidental de `$` en `.env`.

Si la conexión necesita el certificado raíz del proyecto, configura `DB_CA_CERT` con ese PEM. TLS verifica el servidor; no se desactiva la verificación para resolver un error de certificado. `DB_SSL=disable` solo admite un PostgreSQL local para pruebas.

```bash
npm run db:migrate
npm run setup
npm run dev
```

La migración crea un esquema **privado** `allnutrition`. No lo agregues a los esquemas expuestos por la Data API. Las rutas de Next.js autentican y autorizan al administrador. El navegador nunca recibe DATABASE_URL. La guía de despliegue explica un rol de ejecución con permisos limitados.

## Qué significa fallback

| Configuración | Resultado |
|---|---|
| `auto` con cadena PostgreSQL | Supabase |
| `auto` sin cadena, local o Docker | SQLite persistente |
| `sqlite` explícito | SQLite, salvo en Vercel |
| `supabase` sin cadena | Error de configuración |
| Supabase configurado pero no responde | Error; se reintenta contra la misma base |
| SQLite en Vercel | Error preventivo |

No hay failover automático ni replicación. Una caída de Supabase NO crea otra base, NO copia datos y NO acepta pedidos en un SQLite vacío. Cambiar de motor requiere migración deliberada y comprobación. Esto evita dos fuentes diferentes de pedidos.

## Imágenes y enlaces

Pegar URL HTTPS → ver vista previa → guardar contenido → publicar. Solo se guarda la URL. La imagen la solicita directamente el navegador; no hay upload, copia del archivo, proxy de imágenes, optimización en disco ni integración con almacenamiento.

Las dos imágenes originales (logo y creatina) siguen en `public/brand` como recursos estáticos entregados con el código, no como un sistema de cargas. Pueden sustituirse por enlaces. No se generan imágenes de productos ni precios ficticios. Los comprobantes de pago también pueden enlazarse desde el panel. Ocultar el enlace en el panel no hace privado el archivo externo: conserva los permisos de acceso apropiados en su sitio de origen.

El enlace tiene que apuntar a la imagen pública, no a una carpeta o página de Facebook/Instagram/Drive. Su continuidad depende del servidor de origen. Una URL expirable o un sitio que impida enlazar imágenes puede dejar de funcionar. La vista previa detecta errores de carga; no certifica propiedad ni disponibilidad futura.

## Funciones del panel

Productos y referencias, catálogos/colecciones, combos, preguntas frecuentes, mensajes comerciales, condiciones de envío, WhatsApp, redes, datos de contacto y pedidos. Incluye borradores/publicación/archivo, filtros, búsqueda, paginación de pedidos, prevención de conflictos de edición, datos históricos de líneas, historial de cambios y exportación comercial.

Cada presentación/sabor con precio o disponibilidad propios es una referencia independiente. Los combos reúnen referencias y cantidades con precio manual. La disponibilidad es manual: no hay entradas/salidas ni descuento de stock.

Pedidos: Nuevo → Preparando → Enviado → Entregado; Cancelado antes del despacho y Devuelto después del envío. Cancelar/devolver requiere motivo. Pago y pedido son independientes. El estado de pago puede ser Pendiente, Abono parcial, Pagado o Reembolsado; no se consulta a bancos. Los detalles y decisiones por confirmar están en `docs/REQUISITOS_Y_DECISIONES.md`.

## Despliegue

Opción preparada: **Vercel + Supabase**. Alternativa: **Docker con SQLite persistente o Supabase**. Consulta `docs/DESPLIEGUE.md` para el procedimiento completo.

```bash
# CLI de Vercel: requiere acceso a tu cuenta y variables ya configuradas en el proyecto.
npm run deploy
# Producción, solo después de verificar el despliegue de revisión:
npm run deploy -- --prod
```

`vercel.json` configura Next.js. `.github/workflows/ci.yml` ejecuta chequeos, el mismo contrato de repositorio con SQLite y PostgreSQL local de pruebas, compilación y pruebas de navegador. La integración Git de Vercel debe conectarse desde la cuenta del titular; este ZIP no la conecta automáticamente.

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
npm test
npm run check
npm run build
npx playwright install chromium
npm run test:e2e
```

La primera instalación genera `package-lock.json`. Revísalo y agrégalo al repositorio; las siguientes instalaciones usarán npm ci. No se incluyó un lock fabricado: el entorno no permitió resolver dependencias. El chequeo de sintaxis no sustituye la compilación ni la aceptación con el cliente.

## Documentación

- `docs/REQUISITOS_Y_DECISIONES.md`: trazabilidad de requisitos, flujos y decisiones de negocio pendientes.
- `docs/DESPLIEGUE.md`: Vercel, Supabase, permisos, Docker, migración y vuelta atrás.
- `docs/VERIFICACION.md`: qué se probó y qué sigue pendiente.
- `docs/ALCANCE_Y_FASES.md`: separación comercial, sin precio de fase 2.
- `docs/FUENTES.md`: archivos aportados y documentación técnica consultada.
