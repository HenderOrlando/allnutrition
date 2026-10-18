# Cambios — administración v3 y antecedentes

## Unificación UI/UX de menús, acciones y atajos · 17 de octubre de 2026

- Navegación local compartida con `WorkspaceTabs`: botones nativos en escritorio y selector nativo en móvil, sin estado paralelo al propietario. Se migran Catálogo, Pedidos, Caja, Informes y Configuración; se retira la repetición de subtareas en la barra lateral.
- «Más» conserva las seis áreas y un directorio completo inicialmente plegado. «Atajos» explica únicamente combinaciones existentes. El lanzador usa foco real con flechas, Inicio/Fin y Enter/Espacio; Ctrl/⌘ K respeta campos, diálogos, composición de texto y operaciones en curso. Menú, lanzador y guía no se superponen.
- Títulos y encabezados identifican los 31 destinos, también mediante URL directa. Cambiar área/subvista enfoca su encabezado sin robar foco a búsquedas o filtros ordinarios. Iconos y estados de envío comparten significado y etiquetas.
- Listados con búsqueda y creación visibles, filtros compactos y chips que quitan solo su propio criterio y reinician página. Vacíos sin creación duplicada y recuperación hacia la acción real. Pedidos y Envíos ocultan sus paginadores cuando no hay filas. La búsqueda conserva filtros y evita sobrescribirlos con una captura antigua.
- Editores con campos antes de ayuda general, advertencias junto a su tarea, un solo anuncio pendiente y acciones contextuales. Las guardas conservan borradores al rechazar navegación y bloquean salida/segunda operación durante escrituras.
- Datos y publicación distingue el estado guardado de la selección pendiente: marcar la aprobación no anuncia una publicación antes de guardar.
- Caja e Informes muestran contenido útil en la primera pantalla móvil. Las listas de Caja reúnen filtros en un disclosure; Informes sitúa el selector de área antes de la consulta y conserva período/identidad al abrir un informe guardado. No cambia qué devenga, qué mueve caja ni cómo se revierten los hechos.
- Comisiones porcentuales con coma o punto y hasta dos decimales, convertidas exactamente a puntos básicos. Vacío o formato inválido participa en la guarda y bloquea guardar; cambiar a importe fijo o deshabilitar no deja una invalidez oculta. Sin redondeo ni cambios de regla histórica.
- Vitrina con menú móvil nativo, pedido vacío enlazado al catálogo, conteos separados de productos/combos y una sola recuperación del vacío global. Atrás restaura búsqueda, categoría y scroll aun sin BFCache, conservando estado de Next, tema y pedido. Se mantienen el límite 99, subtotal y mensaje de WhatsApp, sin enviar mensajes ni crear checkout.
- Tipografía operativa de al menos 14 px, campos de 16 px —incluido el selector de Excel sin override heredado— y áreas pulsables de 44 px. Se corrigen cortes de importes/acciones en tablas de 768 px y el contraste del rótulo sobre la cuadrícula pública, reutilizando la paleta existente, sin recortar envases ni cambiar recursos de marca.
- Contratos E2E de interacción ampliados. El verificador ejecuta el scheduler durante las pruebas de importación y conserva comprobaciones estrictas tras reservas; los contratos de observaciones no dependen del orden accidental de UUID con igual milisegundo. Sin cambios de API, esquema, autenticación, dependencias ni reglas financieras.
- Aceptación final Docker interactiva con código 0, 478 pruebas SQLite/PostgreSQL y 36 E2E aprobadas, escenario comercial desde UI, reinicio 0→25→60, caída/recuperación y respaldo/restauración. Matriz visual completa, teclado, temas y límites documentados en [VERIFICACION.md](VERIFICACION.md). Sin despliegue ni publicación real.

## Inventario conectado a Pedidos · 17 de octubre de 2026

- Productos sustituye disponibilidad manual por existencias físicas, reservas del servidor y unidades libres. El editor y los listados de escritorio/móvil distinguen conteo desconocido de cero. Combos y obsequios consumen sus componentes históricos.
- Pedidos reserva al guardar, ajusta al editar, libera al cancelar y descuenta las asignaciones efectivamente despachadas. Incluye despachos parciales, devoluciones recuperables/irrecuperables, reenvíos, rectificaciones e idempotencia, con transacción única y rechazo de sobreventa.
- Las devoluciones conservan su asignación física para que un despacho posterior no absorba unidades cerradas previamente. Los conteos y cambios quedan auditados; no se crean movimientos de caja ni se recostea el historial.
- Migración JSON 4 sin stock inventado ni descuento retroactivo. Respaldos v3 con `inventoryVersion:1`, normalización de respaldos anteriores y validación de reservas antes de restaurar. PostgreSQL exige migrar y reiniciar todos los escritores de la misma versión.
- Excel distingue cambios de inventario de cambios reales del catálogo al validar una revisión: varios grupos del mismo producto pueden reservar sin invalidarse entre sí, sin ignorar cambios de nombre, precio, composición o costos.
- Verificación: contratos SQLite y PostgreSQL reales, compilación productiva aislada y flujo UI/API con conteo, reserva, exceso rechazado, despacho parcial, devolución y cancelación. Detalle y límites en [VERIFICACION.md](VERIFICACION.md). Sin despliegue.

## Caja · orientación de tareas · 17 de octubre de 2026

- Las pestañas explicitan su contenido: «Resumen y cuentas», «Gastos y pagos» y «Sueldos y anticipos», junto a Movimientos y Liquidaciones. Cada vista mantiene su guía contextual.
- E2E recorre las cinco vistas y comprueba que la pestaña elegida y el destino contextual coincidan.

## Configuración orientada a tareas · 17 de octubre de 2026

- Portada con 11 entradas agrupadas en operación del negocio, vitrina pública, acceso al panel y primeros pasos. Acciones con verbo y objeto y descripciones que distinguen personas de usuarios, cuentas de caja de plataformas y condiciones públicas de seguimiento de envíos.
- Un único directorio sustituye la navegación duplicada de Configuración. Las subpantallas ofrecen retorno y selector de tarea; títulos de página y foco identifican el destino también al abrir una URL directamente.
- Cuentas del negocio tiene una vista propia con URL `section=business&tab=accounts`, reutilizando los formularios, preferencias y operaciones existentes. No requiere recorrer el asistente. Crear otra cuenta de plataforma y configurar avisos dejan de estar ocultos tras un desplegable adicional.
- Vitrina separa identidad, contacto, información de pago y publicación, con saltos a cada grupo, ejemplo vivo de WhatsApp y guardado explícito. Usuarios muestra primero las cuentas existentes y permite saltar al alta, aclarando el perfil único Administrador y la ausencia de invitaciones automáticas.
- Diálogos con acciones específicas, resumen de contenido desplazable por teclado y foco visible sin quedar debajo del guardado o del pie del editor. Se retiran estilos de Configuración sustituidos por módulos locales, sin cambiar las otras áreas.
- Verificación del tercer ciclo sobre compilación productiva y copia SQLite: 44 recorridos de pantallas, 104 de diálogos y 22 estados adicionales, con ratón/teclado a 390×844 y 1440×900. Cero incidencias de axe en los estados estabilizados, cero desbordamientos y cero escrituras API; las 42 tablas y sus 340 registros se conservaron. Evidencia, comandos y límites en [VERIFICACION.md](VERIFICACION.md).
- No se cambian lógica de negocio, permisos, endpoints, modelos, datos ni dependencias; no hubo despliegue.

## Administrador · continuidad de Mesa de trabajo · 17 de octubre de 2026

- Se retoma el tema cálido, los formularios agrupados y las guardas del rediseño anterior. No se sustituye por la identidad visual de la vitrina.
- Inicio incorpora «Todas las tareas»: 29 destinos agrupados por trabajo, accesibles en dos pulsaciones. «Más» y «Ir a…» incluyen los destinos secundarios; el lanzador encuentra también los nombres actuales de las secciones, con o sin tildes. La barra lateral muestra las tareas del área activa y el encabezado identifica la ubicación.
- Pestañas, listados y estados comparten jerarquía visual. Productos, obsequios, combos, catálogos, FAQ, mensajes, condiciones de envío y usuarios tienen agrupaciones e instrucciones propias; añadir o quitar componentes conserva un foco útil.
- Pedidos separa destinatario, referencias, preparación y hechos financieros/logísticos. El importador explica sus cuatro pasos. Caja distingue operaciones de cifras, e Informes agrupa origen, período y filtros sin ocultar cobertura ni datos incompletos.
- En móvil, el área desplazable queda entre las barras fijas. Los diálogos financieros conservan el pie de acciones visible mientras se desplazan sus campos; los importes vacíos no se describen como costos cuando representan saldos o movimientos.
- Verificación local sobre compilación y copia SQLite descartable: 60 recorridos de pantallas, 48 comprobaciones de diálogos y 16 flujos funcionales. No se modifican la tienda pública, APIs, autenticación, esquema de datos ni dependencias. Evidencia y límites en [VERIFICACION.md](VERIFICACION.md).


## Vitrina · octubre de 2026

- Inicio y fichas con imágenes ampliadas, tarjetas con precio y compra visibles, búsqueda y filtros conservados. Temas claro/oscuro con preferencia local y CSS aislado de administración.
- Selección de productos/combos, cantidades y subtotal durante la sesión de la pestaña. WhatsApp conserva el cierre comercial con un mensaje prellenado de referencias, cantidades y total; también siguen disponibles las consultas individuales.
- Agotados: consulta de reposición sin añadir al pedido. Sin cambios en precios, inventario, base de datos, autenticación, panel ni integraciones; sin checkout, pagos internos ni alta automática de pedidos.
- Refinamiento visual posterior: paleta marfil/carbón, jerarquía tipográfica más marcada, galería equilibrada para dos a cuatro referencias y producto destacado primero en móvil. Tarjetas, ficha, guía de compra, información comercial, cierre y pedido comparten el mismo lenguaje visual. Se mantienen o amplían las imágenes anteriores y se renuevan los textos de elección/compra sin alterar los contenidos editables ni prometer descuentos, urgencia o resultados.
- Identidad de gimnasio: Barlow Condensed ExtraBold local con licencia SIL OFL, titulares en alto contraste, etiquetas técnicas y marcadores gráficos deportivos. «Selección para tu entrenamiento» sustituye «En primera fila» sin afirmar ventas o popularidad no acreditadas; imágenes, temas, selección y datos del negocio se conservan.
- WhatsApp simplificado: la plantilla comercial se mantiene; el pedido usa una línea por referencia con cantidad y un solo total, sin volver a solicitar disponibilidad al final ni repetir importes unitarios/de línea. Las consultas individuales incorporan presentación y sabor para identificar la referencia, omitiendo los detalles que ya figuran en el nombre mediante comparación de palabras completas, mayúsculas y puntuación normalizadas.
- Navegación pública de documento coherente para inicio, productos, catálogos, combos y secciones: Atrás desde una ficha restaura el catálogo real y su posición, no solo la URL. Se elimina la mezcla de anclas nativas con transiciones `Link` que desincronizaba el historial; las rutas cargan documentos completos y los fragmentos no se concatenan. Al restaurar una página desde la caché del navegador, pedido y tema se sincronizan con sus valores guardados mediante `pageshow`, sin resucitar avisos de compra antiguos.

## Administración de negocio v3

- Corte a esquema/exportación v3 en SQLite y PostgreSQL; conversión v2 transaccional sin costos, vendedores, ventas ni caja inventados. Costos y composiciones históricos, dinero en centavos seguros y calendario Bogotá.
- Obsequios con componentes reales; pedidos con varias guías y eventos rectificables; recaudos, devoluciones y reembolsos separados. Liquidaciones parciales, retenciones, créditos, gastos, cuentas, anticipos, cierres y sueldos/comisiones sin duplicar salidas.
- Importador `.xlsx/.xls/.xlsb/.xlsm`: original privado inmutable, columnas por posición, resolución de identidades por cuenta, revisión congelada y grupos atómicos reanudables. Parseo aislado, límites de expansión y fórmulas sin ejecución.
- Inicio con cobertura, acciones y observaciones sustentadas; seis áreas y navegación móvil compacta; formularios financieros individuales, responsables sin login, guardas nativas y detalle sin modales anidados.
- Informes de seis periodicidades, consultas solo lectura, explicación de cada importe, snapshots inmutables y XLSX. Los agregados grandes se escriben como texto decimal exacto para distinguir centavos que Excel redondearía.
- Worker independiente con leases y heartbeat: devengos, alertas por episodio y reportes aunque no haya paneles abiertos. Acusar una alerta no corrige la condición; solo los hechos reales la resuelven.
- Respaldo comercial completo sin autenticación/leases; restore entre motores, validación atómica y lectura SQLite original sin migrarlo ni ignorar WAL. Imágenes fuera de la base siguen siendo una copia separada.
- `verify:docker --interactive` amplía el verificador existente sin reemplazar su ejecución automatizada, TLS, PostgreSQL real, E2E, outage ni restore. Evidencia y límites de esta actualización en [VERIFICACION.md](VERIFICACION.md). No implica despliegue v3 en producción.

## Antecedente: cambios v2 respecto de la base anterior

Base de datos: repositorio asíncrono común, adaptadores SQLite y PostgreSQL/Supabase, migraciones privadas, configuración .env y selección segura sin conmutación automática por caída. SQLite no se permite en Vercel.

Imágenes: el editor de Productos admite carga local JPEG/JPG, PNG y WebP (entrada máxima 10 MiB), optimiza a WebP de hasta 2400 px por lado y muestra una cuota de 1.000.000.000 bytes. El formulario agrupa los campos por tarea; después de una carga local muestra la vista previa y oculta el campo URL, que queda disponible bajo demanda. Los archivos se sirven por `/api/media/<id>` y persisten fuera de PostgreSQL. En desarrollo local el directorio predeterminado es `data/product-images` (ignorado por Git); en Docker el volumen `product_images` se monta en `/app/data/product-images`. Catálogos, combos, logo y comprobantes siguen usando enlaces/recursos estáticos; no hay conectores externos. Antes de migrar referencias locales antiguas `/api/media/...`, copiar también sus binarios o reemplazarlas por enlaces.

Pedidos: campos de destinatario y despacho de la Planilla, valores/fechas/referencia/comprobante de pago, control separado de pago y envío, transiciones propuestas y razones, historiales, idempotencia, instantáneas históricas y protección ante ediciones simultáneas.

Administración — «Mesa de trabajo»: tema cálido aislado en `/admin` y `/admin/login`; la vitrina conserva su CSS público. Navegación agrupada, barra inferior con «Más» en móvil y lanzador «Ir a…» mediante `Ctrl K`/`⌘ K`. Sección, búsqueda, filtros y página tienen URL normalizada y retorno seguro después del acceso; no se serializan formularios ni contraseñas. Back/Forward, salida y diálogos nativos protegen los cambios y las escrituras en curso.

El Inicio muestra colas reales de pedidos nuevos/en preparación y borradores por sección, sin ventas, stock ni métricas inventadas. Las cargas y errores son independientes; un guardado confirmado actualiza el registro y sus conteos antes de revalidar. Si esa lectura falla, se informa que el cambio sí se guardó; «Reintentar» repite solo la lectura, no la escritura.

Continuidad al editar: abrir o crear aplica la búsqueda pendiente antes de cargar detalle/dependencias y cancela su debounce. Esto evita que una búsqueda aún en espera invalide la apertura del pedido tras un clic rápido. El recorrido E2E comprueba la URL/filtro aceptados; el acceso espera la respuesta real de autenticación y la creación de pedido elige el CTA de su barra de herramientas.

Listados con tablas desde 768 px y tarjetas en móvil, filtros de pedido/pago separados y paginación del servidor. Los editores agrupan los campos existentes, ofrecen resumen vivo e índice interno y conservan validación, carga WebP, versiones, instantáneas históricas y registro manual de pago/entrega. Ante 409 se puede cargar la versión guardada de un registro existente tras confirmar descarte; una lectura fallida no reemplaza el formulario. El footer permanece fuera del cuerpo desplazable; en ventanas bajas la barra de filtros deja de ser sticky para no tapar acciones al ampliar la página.

Configuración agrupada con un único guardado y ejemplo de WhatsApp que no se envía. Acceso y alta de usuario permiten mostrar/ocultar la contraseña; después del alta se vacían ambos campos de contraseña. Se mantiene el único rol administrador. No se añaden CRM, captación, mensajes automáticos, validación bancaria, transportadoras ni inventario automático.

Operación: Node 24 y dependencias reproducibles con `npm ci` y lockfile incluido. Producción usa una VM Linux aislada con Docker Compose y PostgreSQL 16, detrás del Nginx existente del host; Caddy se conserva para staging/pruebas y la topología autónoma. SQLite local y Vercel/Supabase siguen como alternativas. `deploy:env` genera configuración privada por entorno; `verify:docker` verifica la imagen compilada y solo promueve un release si toda la aceptación aprueba. Despliegue remoto del 14 de octubre: `allnutrition:release-5791e836302c`, `amd64`, con respaldo y reversión de aplicación disponibles.

Seguridad de dependencias (13 de octubre de 2026): Next.js pasa de `16.3.6` a `16.3.8`, parche de seguridad de la misma rama, y `source-map-js` de `1.2.1` a `1.2.2` dentro de la dependencia de PostCSS. `package-lock.json` fija las versiones resueltas; no se añaden dependencias directas, overrides ni cambios de React. La auditoría local completa y la del runtime de producción dejaron de informar los dos paquetes vulnerables. Referencias: [release de Next.js 16.3.8](https://github.com/vercel/next.js/releases/tag/v16.3.8), [SSRF de Next.js](https://github.com/advisories/GHSA-cjq9-62q9-8jv4) y [DoS de source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). Evidencia y alcance en [VERIFICACION.md](VERIFICACION.md).

Seguridad PostgreSQL: CA en archivo mediante `DB_CA_CERT_FILE`, mutuamente excluyente con `DB_CA_CERT` inline, sin rebajar la verificación TLS. La migración `--provision-app-role` separa la conexión privilegiada del rol runtime limitado `allnutrition_app`; el adaptador sigue llamándose `supabase` y usa `pg` estándar. Se comprobaron rechazo de CA incorrecta, rechazo de TCP sin TLS y denegación de DDL al runtime.

Pruebas: reset PostgreSQL compartido y protegido por nombre exacto de base, autorización explícita y comprobación de la base conectada. E2E exige HTTPS localhost y PostgreSQL descartable previamente sembrado; no arranca un servidor de desarrollo ni recurre a SQLite. La aceptación sobre el contenedor compilado comprueba cookies seguras, CSRF/origen, conflictos de edición, privacidad/publicación, caída 503 y recuperación sin duplicados, persistencia de sesiones y restauración completa.

Corrección reproducida en PostgreSQL: búsqueda de guía de envío insensible a mayúsculas mediante `LOWER(tracking)`, manteniendo el contrato común con SQLite.

Resultado histórico del 29 de septiembre de 2026: `npm run verify:docker` terminó con código 0, 118 pruebas Node aprobadas sin omisiones, 12 E2E escritorio/móvil aprobadas y auditoría sin vulnerabilidades en aquella ejecución. El pedido de control de 119.000 COP conservó datos, historial, cuenta, sesión e idempotencia tras reinicio y respaldo/restauración. La verificación vigente del rediseño y los límites observados están en [VERIFICACION.md](VERIFICACION.md); la operación, en [DESPLIEGUE.md](DESPLIEGUE.md). No se acredita publicación remota, CI remoto ni un proyecto alojado en Supabase.
