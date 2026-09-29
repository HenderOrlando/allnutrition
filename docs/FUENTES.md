# Fuentes y decisiones de v2

## Información aportada

- `ALL NUTRITION COLOMBIA - planilla.pdf`, página 1: marca/eslogan, tono, categorías, logo como respuesta 5 y foto/datos de creatina como respuesta 7. Página 2: WhatsApp, responsables, pagos y datos solicitados para despachar.
- `Formulario_All_Nutrition_Paquete_Completo_Corto.pdf`: preguntas numeradas que corresponden a la Planilla; no tratar el formulario sin respuestas impresas como información no entregada.
- `Alcance_All_Nutrition_Mantenimiento_Inventario.pdf`: referencia histórica de página base, módulo opcional, responsabilidades y límites. No se traslada automáticamente todo ese alcance a fase 1.
- Instrucciones posteriores del usuario: panel autoadministrado Next.js con productos/catálogos/combos/redes/FAQ/mensajes/envíos/pedidos; WhatsApp principal, redes complementarias, dominio aún en búsqueda; Supabase por .env, alternativa SQLite y archivos mediante enlaces; separación de fase 2 sin precio.

Los dos JPEG de public/brand provienen de las imágenes de la página 1 de la Planilla. Son recursos estáticos ya incluidos, no archivos nuevos cargados por el administrador. Las imágenes nuevas se enlazan; no se usa almacenamiento integrado.

Las 50 unidades son el umbral consultado, no una existencia inicial. Textos propuestos, transiciones, pago parcial, opciones de entrega y arquitectura técnica se identifican como decisiones de diseño; no se atribuyen al cliente como respuestas confirmadas.

## Documentación técnica primaria

Consultada el 28 de septiembre de 2026; la documentación no prueba ni audita esta implementación.

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

Las versiones fijadas en package.json no se instalaron desde este entorno por un error de red. Consultar VERIFICACION.md y generar/guardar el lockfile en el equipo de integración.
