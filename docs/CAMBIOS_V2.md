# Cambios v2 respecto de la base anterior

Base de datos: repositorio asíncrono común, adaptadores SQLite y PostgreSQL/Supabase, migraciones privadas, configuración .env y selección segura sin conmutación automática por caída. SQLite no se permite en Vercel.

Imágenes: se retiraron cargas y almacenamiento del administrador; ahora se guardan URLs y el navegador carga la imagen. Los endpoints de carga/media antiguos responden 410. Las dos imágenes de marca entregadas se conservan como recursos estáticos. Antes de migrar una base v1 con imágenes `/api/media/...`, reemplazar esas direcciones por enlaces.

Pedidos: campos de destinatario y despacho de la Planilla, valores/fechas/referencia/comprobante de pago, control separado de pago y envío, transiciones propuestas y razones, historiales, idempotencia, instantáneas históricas y protección ante ediciones simultáneas.

Administración: modales con control de foco y aviso de cambios sin guardar, vista previa autenticada y aprobación de publicación, enlaces de redes y catálogo con páginas propias. No se añade captación ni CRM de fase 2 ni se publica su precio.

Operación: Vercel y Docker, flujo CI, pruebas SQLite/PostgreSQL compartidas, suite Playwright preparada, comandos de configuración/cuentas/migración/backup/importación y documentación de requisitos y aceptación. Consultar VERIFICACION.md: Next.js no se compiló ni se desplegó aquí y Supabase real no se conectó.
