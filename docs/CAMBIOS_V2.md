# Cambios v2 respecto de la base anterior

Base de datos: repositorio asíncrono común, adaptadores SQLite y PostgreSQL/Supabase, migraciones privadas, configuración .env y selección segura sin conmutación automática por caída. SQLite no se permite en Vercel.

Imágenes: se retiraron cargas y almacenamiento del administrador; ahora se guardan URLs y el navegador carga la imagen. Los endpoints de carga/media antiguos responden 410. Las dos imágenes de marca entregadas se conservan como recursos estáticos. Antes de migrar una base v1 con imágenes `/api/media/...`, reemplazar esas direcciones por enlaces.

Pedidos: campos de destinatario y despacho de la Planilla, valores/fechas/referencia/comprobante de pago, control separado de pago y envío, transiciones propuestas y razones, historiales, idempotencia, instantáneas históricas y protección ante ediciones simultáneas.

Administración: modales con control de foco y aviso de cambios sin guardar, vista previa autenticada y aprobación de publicación, enlaces de redes y catálogo con páginas propias. No se añade captación ni CRM de fase 2 ni se publica su precio.

Operación: Node 24 y dependencias reproducibles con `npm ci` y lockfile incluido. Arquitectura elegida: un servidor Linux con Docker Compose, PostgreSQL 16 y Caddy HTTPS; SQLite local y Vercel/Supabase se conservan como alternativas. `deploy:env` genera configuración privada por entorno; `verify:docker` verifica la imagen compilada y solo promueve un release si toda la aceptación aprueba.

Seguridad PostgreSQL: CA en archivo mediante `DB_CA_CERT_FILE`, mutuamente excluyente con `DB_CA_CERT` inline, sin rebajar la verificación TLS. La migración `--provision-app-role` separa la conexión privilegiada del rol runtime limitado `allnutrition_app`; el adaptador sigue llamándose `supabase` y usa `pg` estándar. Se comprobaron rechazo de CA incorrecta, rechazo de TCP sin TLS y denegación de DDL al runtime.

Pruebas: reset PostgreSQL compartido y protegido por nombre exacto de base, autorización explícita y comprobación de la base conectada. E2E exige HTTPS localhost y PostgreSQL descartable previamente sembrado; no arranca un servidor de desarrollo ni recurre a SQLite. La aceptación sobre el contenedor compilado comprueba cookies seguras, CSRF/origen, conflictos de edición, privacidad/publicación, caída 503 y recuperación sin duplicados, persistencia de sesiones y restauración completa.

Corrección reproducida en PostgreSQL: búsqueda de guía de envío insensible a mayúsculas mediante `LOWER(tracking)`, manteniendo el contrato común con SQLite.

Resultado local observado: `npm run verify:docker` terminó con código 0, 118 pruebas Node aprobadas sin omisiones, 12 E2E escritorio/móvil aprobadas y auditoría sin vulnerabilidades. El pedido de control de 119.000 COP conservó datos, historial, cuenta, sesión e idempotencia tras reinicio y respaldo/restauración. Consultar [VERIFICACION.md](VERIFICACION.md) para evidencia e IDs y [DESPLIEGUE.md](DESPLIEGUE.md) para operación. No se acredita publicación remota, CI remoto ni un proyecto alojado en Supabase.
