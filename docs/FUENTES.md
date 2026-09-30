# Fuentes y decisiones de v2

## Información aportada

- `ALL NUTRITION COLOMBIA - planilla.pdf`, página 1: marca/eslogan, tono, categorías, logo como respuesta 5 y foto/datos de creatina como respuesta 7. Página 2: WhatsApp, responsables, pagos y datos solicitados para despachar.
- `Formulario_All_Nutrition_Paquete_Completo_Corto.pdf`: preguntas numeradas que corresponden a la Planilla; no tratar el formulario sin respuestas impresas como información no entregada.
- `Alcance_All_Nutrition_Mantenimiento_Inventario.pdf`: referencia histórica de página base, módulo opcional, responsabilidades y límites. No se traslada automáticamente todo ese alcance a fase 1.
- Instrucciones posteriores del usuario: panel autoadministrado Next.js con productos/catálogos/combos/redes/FAQ/mensajes/envíos/pedidos; WhatsApp principal, redes complementarias, dominio aún en búsqueda; Supabase por .env, alternativa SQLite y archivos mediante enlaces; separación de fase 2 sin precio.
- Decisión posterior de infraestructura: Node 24 y un único servidor Linux con Docker Compose, PostgreSQL y Caddy; staging HTTPS local y aceptación descartable sobre la imagen de producción. No se suministraron servidor ni dominio remoto.

Los dos JPEG de public/brand provienen de las imágenes de la página 1 de la Planilla. Son recursos estáticos ya incluidos, no archivos nuevos cargados por el administrador. Las imágenes nuevas se enlazan; no se usa almacenamiento integrado.

Las 50 unidades son el umbral consultado, no una existencia inicial. Textos propuestos, transiciones, pago parcial y opciones de entrega se identifican como decisiones de diseño; no se atribuyen al cliente como respuestas confirmadas. La elección posterior de infraestructura se registra por separado.

## Documentación técnica primaria

Fuentes consultadas durante la preparación técnica del 28–29 de septiembre de 2026; la documentación por sí sola no prueba ni audita esta implementación.

- Next.js, entorno: https://nextjs.org/docs/app/guides/environment-variables
- Next.js, autoalojamiento: https://nextjs.org/docs/app/guides/self-hosting
- Next.js, autenticación: https://nextjs.org/docs/app/guides/authentication
- Supabase, conexiones, pooler y TLS: https://supabase.com/docs/guides/database/connecting-to-postgres
- Supabase, separación de esquemas y Data API: https://supabase.com/docs/guides/api/securing-your-api
- node-postgres, TLS: https://node-postgres.com/features/ssl
- node-postgres, consultas parametrizadas: https://node-postgres.com/features/queries
- Vercel, SQLite y persistencia: https://vercel.com/kb/guide/is-sqlite-supported-in-vercel
- Vercel, integración Git: https://vercel.com/docs/git
- Metadatos de Next.js/React: https://registry.npmjs.org/next/latest y https://registry.npmjs.org/react/latest
- PostgreSQL 16, TLS: https://www.postgresql.org/docs/16/ssl-tcp.html
- PostgreSQL 16, autenticación HBA: https://www.postgresql.org/docs/16/auth-pg-hba-conf.html
- PostgreSQL, entrypoint de la imagen oficial: https://raw.githubusercontent.com/docker-library/postgres/master/docker-entrypoint.sh
- Caddy, TLS: https://caddyserver.com/docs/caddyfile/directives/tls
- Caddy, API y CA local: https://caddyserver.com/docs/api

Las dependencias están instaladas y el `package-lock.json` real se incluye para reproducirlas con Node 24 y `npm ci`. La aceptación local `npm run verify:docker` aprobó compilación, contratos SQLite/PostgreSQL, navegador HTTPS y operaciones de persistencia/restauración. Consultar [VERIFICACION.md](VERIFICACION.md) para resultados observados y límites, y [DESPLIEGUE.md](DESPLIEGUE.md) para el procedimiento: las fuentes técnicas y la evidencia local no acreditan una publicación ni una ejecución de CI remotas.
