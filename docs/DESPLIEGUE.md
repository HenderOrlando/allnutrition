# Despliegue v2 — Vercel, Supabase y alternativa SQLite

Esta guía configura infraestructura. No acredita un despliegue ya realizado. No hay proyectos, dominios, claves ni bases reales creados desde esta conversación.

## 1. Preparar Supabase

Crear o seleccionar un proyecto del titular. Copiar sus cadenas reales desde Connect. Para Vercel usar Transaction pooler (normalmente puerto 6543); para migraciones, Direct connection o Session pooler. Copiar usuario, host y puerto del panel, no deducirlos por región.

En .env LOCAL establecer DB_DRIVER=supabase, DATABASE_URL (runtime), DATABASE_DIRECT_URL (DDL, opcional), DB_SSL=verify y DB_CA_CERT si lo exige la cadena TLS. Las credenciales se mantienen privadas. El certificado se usa para verificar el servidor; no se reemplaza por rejectUnauthorized:false.

```bash
npm install
npm run db:migrate
npm run setup
npm run check
npm test
npm run build
```

La migración también puede ejecutarse pegando `db/supabase.sql` en el SQL Editor. Es no destructiva y se puede repetir. El setup carga material inicial solo cuando no hay productos/catálogos. Para migrar una SQLite con contenido, **no ejecutar setup/seed primero en el destino**: migrar estructura, importar, y luego crear la cuenta con admin:add.

## 2. Privacidad del esquema y permisos

El esquema `allnutrition` no se expone por la Data API. La migración revoca acceso de PUBLIC, anon y authenticated cuando esos roles existen. Mantener desactivada su exposición. No se utilizan API keys públicas ni service-role keys en el navegador.

Para producción, usar un rol PostgreSQL de ejecución con acceso únicamente al esquema. Crear el rol mediante una operación administrativa segura con contraseña propia. Luego otorgar, sustituyendo `allnutrition_app` por ese rol real:

```sql
GRANT USAGE ON SCHEMA allnutrition TO allnutrition_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA allnutrition TO allnutrition_app;
```

El role no necesita permisos DDL para operar. DATABASE_DIRECT_URL puede pertenecer al administrador de migraciones y DATABASE_URL al role limitado. Las cuentas del panel se almacenan aparte, con contraseña derivada mediante scrypt; no son los usuarios de PostgreSQL ni Supabase Auth.

La cadena de conexión de un rol personalizado mediante pooler usa el formato que indique Supabase para ese rol y proyecto. No colocar valores secretos en el código, cliente, repositorio o mensajes de soporte.

## 3. Publicar Next.js en Vercel

Subir el proyecto a un repositorio propio (sin .env, datos, respaldos ni node_modules). La raíz debe contener package.json y vercel.json. Generar y guardar package-lock.json en un equipo que sí tenga acceso a npm.

En Vercel importar ese repositorio, seleccionar Next.js y Node 22. Configurar las variables de **servidor** según `.env.production.example`. DATABASE_URL debe ser real; APP_URL debe ser el origen HTTPS correcto del despliegue. No agregar prefijo NEXT_PUBLIC_. ADMIN_EMAIL y ADMIN_PASSWORD solo se necesitan en los comandos de alta local, no en el runtime después del setup.

Usar proyectos/bases separados para revisión y producción. Las variables de Preview no deben apuntar sin control a los pedidos reales. El origen específico de preview se obtiene de VERCEL_URL; el código no confía ciegamente en el Host de una solicitud. El esquema se migra antes del deploy, no en cada build.

Publicar desde la integración Git o usar:

```bash
npm run deploy
# Verificar el entorno de revisión, luego:
npm run deploy -- --prod
```

La CLI requiere acceso a la cuenta de Vercel. El script no copia automáticamente .env a la nube. Configurar las variables del proyecto por su panel o CLI de forma privada. Una vez publicado, comprobar `/api/health` (debe responder 200), acceso al panel, lectura/escritura y rechazo de API sin sesión. Después de aprobar contenido se activa la vitrina pública.

Se puede iniciar con la URL de despliegue asignada y conectar el dominio cuando se registre. Después, actualizar APP_URL y redes/enlaces que dependan de esa dirección. No se ha comprado ni supuesto un dominio.

## 4. Comprobación continua

`.github/workflows/ci.yml` contiene un servicio PostgreSQL de pruebas, comprobación de sintaxis, contrato de repositorio en ambos motores, next build y pruebas Playwright de escritorio/celular. Las credenciales incluidas en ese servicio son únicamente para una base efímera llamada allnutrition_test.

Vercel publica mediante su propia integración Git. Para no publicar cambios sin verificar, proteger main y exigir el check verify antes de fusionar. El workflow no crea automáticamente una cuenta de Vercel ni sustituye las comprobaciones del entorno de producción.

Las pruebas de navegador usan `.test-data/e2e.sqlite` con datos ficticios. No usar la base de producción para pruebas. El contrato PostgreSQL se niega a limpiar una base que no se llame allnutrition_test y requiere autorización explícita de la variable TEST_ALLOW_DATABASE_RESET.

## 5. Docker y SQLite persistente

Configurar .env con DB_DRIVER=sqlite, APP_URL real y credenciales de alta. Los volúmenes guardan SQLite y respaldos fuera del ciclo de vida del contenedor. No usar múltiples réplicas independientes para escribir sobre copias distintas.

```bash
docker compose build
docker compose run --rm web npm run db:migrate
docker compose run --rm web npm run setup
docker compose up -d
docker compose exec web npm run backup
```

El puerto 3000 se expone solo en 127.0.0.1 para colocarlo detrás de un reverse proxy con HTTPS. Configurar TLS en ese proxy; no exponer el panel por HTTP abierto. El contenedor ejecuta Node como usuario no root. Quitar ADMIN_PASSWORD del env de runtime después del alta y conservar las credenciales en un gestor privado.

El mismo Docker puede usar Supabase estableciendo DB_DRIVER=supabase y su DATABASE_URL. Tener un volumen no implica que SQLite reciba copia de Supabase.

## 6. Caídas y cambio de motor

Si Supabase deja de responder, no se aceptan escrituras en otra base. El panel debe mostrar error, no un éxito ficticio. La siguiente solicitud vuelve a intentar la misma base. Este proyecto no implementa replicación, cola offline ni alta disponibilidad entre motores.

Para mover datos: detener nuevas escrituras, generar respaldo, preparar la estructura del destino vacío, importar, crear cuentas, probar totales/cantidades/historial, configurar el nuevo entorno y solo entonces reabrir la operación. Conservar la base anterior respaldada sin seguir usándola en paralelo.

```bash
# Con .env apuntando a la base de origen:
npm run backup
# Cambiar .env al destino vacío:
npm run db:migrate
npm run db:import -- backups/ARCHIVO_REAL.json
npm run admin:add
```

También se admite `npm run db:import -- --sqlite ./COPIA_DE_LA_BASE.sqlite` con .env apuntando al destino. Hacer primero una copia del original: abrir una SQLite v1 añade las tablas v2 no destructivas. Imágenes antiguas `/api/media/...` deben reemplazarse por URLs antes de esa importación. No se exportan archivos binarios ni sesiones.

## 7. Respaldos y límites de operación

El panel exporta un JSON comercial sin cuentas, no un volcado completo de PostgreSQL. Para un respaldo integral de Supabase usar también el mecanismo del proveedor o pg_dump desde conexión adecuada. Establecer frecuencia/retención y hacer una restauración de prueba; este ZIP no configura por sí solo una tarea programada ni un SLA.

Las imágenes externas no forman parte del respaldo: solo sus URLs. No hay upload ni caché de archivos en el servidor. Las dos imágenes iniciales son recursos estáticos versionados del proyecto. Los dominios, planes del host y costes del proveedor los decide el titular; no se presupone gratuidad ni están confundidos con el mantenimiento de cinco meses.
