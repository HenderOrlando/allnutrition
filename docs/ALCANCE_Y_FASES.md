# All Nutrition — alcance propuesto y separación de fases

Documento de trabajo para el desarrollador. No es evidencia de que el cliente haya aceptado las ampliaciones descritas aquí. No incluye un precio para la fase 2.

**Actualización v3:** el plan técnico posterior aprobado añade administración de negocio (costos privados, caja, liquidaciones, sueldos, importación Excel, informes y alertas). Es una ampliación del código descrita en README/REQUISITOS, no la fase2 de captación ni prueba de un nuevo acuerdo comercial. Las secciones1–9 conservan el razonamiento histórico, salvo el alcance técnico actualizado a continuación.

## 1. Base de la decisión

Según lo relatado en la conversación: el 4 de julio se ofrecieron $350.000 de inicio y cinco mensualidades de $100.000, total $850.000, incluyendo página, direccionamiento a WhatsApp y cinco meses de mantenimiento. El anticipo se recibió el 2 de septiembre y las respuestas el 19 de septiembre. No se infiere el año ni los vencimientos que no se han confirmado.

La última instrucción del desarrollador añade autoadministración con Next.js y gestión de productos, catálogos, combos, redes, FAQ, mensajes, envíos y pedidos con estados. El código refleja esa instrucción actual. No prueba que todas estas funciones estuvieran incluidas en la oferta original ni que el plazo original cubra este alcance ampliado.

El documento V5, páginas 3–5, distingue la página base del módulo de captación/asesor; en ese módulo ubica estados, pagos y envíos manuales. El formulario corto pregunta por un paquete completo. La Planilla responde sus preguntas. Una respuesta de levantamiento de información no equivale por sí sola a contratar cada módulo.

## 2. Fase 1 propuesta: vitrina autoadministrada + registro operativo manual

Incluye la web y el panel privado de contenidos, alta/edición/archivo, imágenes, publicación, colecciones, combos, enlaces a redes, WhatsApp y textos. Incluye las entidades de pedido, ítems, dirección, transportadora/guía introducidas a mano, registro básico del pago, estado manual y un historial mínimo de cambios.

No se requiere escribir código para actualizar contenido. Cada presentación con precio o disponibilidad propia se registra como referencia independiente; no existe un configurador de variantes complejo. Las colecciones son catálogos dentro de esta web, no sincronizaciones externas.

La ampliación posterior del 17 de octubre de 2026 incorpora inventario por referencia conectado a pedidos: conteo físico privado, reservas, salidas por envío y devoluciones. Sustituye la disponibilidad manual; no convierte la selección pública/WhatsApp en una reserva ni añade compras o integraciones. Su contrato vigente y la migración histórica están en `REQUISITOS_Y_DECISIONES.md`.

El catálogo inicial a cargar por el desarrollador y la capacitación se deben precisar. El límite de hasta 12 referencias del V5 es una referencia de carga inicial, no se convierte automáticamente en un límite del software autoadministrado. Que el cliente pueda añadir contenido no obliga al desarrollador a hacer cargas o cambios ilimitados durante el mantenimiento.

## 3. Qué queda fuera del código entregado

No se construyeron formularios públicos de captación, base de leads previa al pedido, embudo comercial, próximos contactos, asignación de leads a asesores, seguimiento a no compradores, medición de conversión, chatbot ni agentes de IA. Las alertas v3 son operativas de pedidos/caja/datos, no recordatorios comerciales a interesados. No hay lectura/sincronización WhatsApp, conexión con bancos/transportadoras, facturación, checkout ni generación de guías. El inventario conectado a pedidos sí está incluido por la instrucción posterior citada arriba.

Estos conceptos no se ofrecen todos como un único paquete futuro ni se promete que entren en el alcance o tiempo mencionado en mensajes anteriores. Cada ampliación requiere selección y cotización propia. Algunas automatizaciones ya estaban excluidas incluso del módulo opcional del V5: no se debe presentarlas ahora como si siempre hubieran estado prometidas.

## 4. Fase 2 sugerida: captación y seguimiento comercial

La diferencia útil no es “ahora puedes editar un producto” ni “ahora puedes cambiar un estado”, porque eso ya existe. La diferencia propuesta es organizar al interesado antes de que compre y gestionar acciones comerciales, no limitarse a registrar el pedido ya conversado.

Una fase 2 acotada podría incluir: formulario de consulta con datos mínimos aprobados; ficha de oportunidad comercial; producto de interés; responsable; estado comercial; próxima acción; fecha de seguimiento; vistas de pendientes y motivos de pérdida. Las cuentas de administrador del CMS no equivalen a asignación de oportunidades, permisos o reportes por asesor.

La recomendación comercial es empezar por ese proceso asistido por personas. Automatizaciones o integraciones se evaluarán después, solo cuando exista una necesidad y un alcance verificable. No convertir el proceso manual incluido en una obligación de contratar la fase 2.

## 5. Cómo comunicarla sin dar su precio ni adelantar su desarrollo

Mensaje central: “En esta etapa tendrás control de tu catálogo y de los pedidos que registres. Más adelante podemos añadir una herramienta para organizar los interesados, los pendientes y el seguimiento del equipo, aprovechando la base que ya tendrás”.

Mostrar una explicación breve en el panel privado, sin precios, promesas de ventas, fechas de disponibilidad o botones de funciones no operativas. El sitio público es para compradores de suplementos, no para venderle servicios de desarrollo al propietario. El aviso se puede ocultar desde configuración.

No retener contraseñas, impedir exportación, desactivar el panel al terminar el mantenimiento ni limitar artificialmente las funciones incluidas. La continuidad hacia fase 2 debe responder a una necesidad y una aceptación, no al deterioro deliberado de la fase 1.

## 6. Ejemplo de diferencia entre pedido e interesado

Fase 1: una persona abre el enlace a WhatsApp, conversa y acuerda una compra. El equipo registra ese pedido y mueve su estado conforme opera.

Fase 2 propuesta: una persona consulta y todavía no compra. El equipo registra su interés, asigna responsable y organiza una próxima acción. Ese seguimiento es anterior y distinto al pedido.

Un clic a WhatsApp no confirma una conversación. No se deben llamar “leads captados”, “clientes nuevos” o “ventas generadas” a simples clics sin información que lo respalde.

## 7. Mantenimiento y cronograma

El mantenimiento de cinco meses ofrecido sigue incluido según el relato. Falta confirmar su fecha de inicio y fin, tareas, canal y tiempos de soporte. No se crea una nueva tarifa ni renovación automática en este código.

Autoadministración significa edición cotidiana por el cliente; mantenimiento técnico, corrección de defectos, soporte, respaldos y cambios de alcance son categorías diferentes que deben definirse sin retirar lo prometido.

Next.js es una decisión técnica; la ampliación funcional del panel y pedidos debe quedar aceptada por separado de la lectura histórica del chat. Revalidar el plazo real con este alcance, los materiales recibidos y las aprobaciones; no asumir automáticamente que todo cabe en la promesa inicial de dos semanas.

## 8. Fuentes del alcance

- Conversación aportada y aclaraciones posteriores del usuario.
- `Alcance_All_Nutrition_Mantenimiento_Inventario.pdf`, páginas 3–5, 8–10.
- `Formulario_All_Nutrition_Paquete_Completo_Corto.pdf`, preguntas 6–25 y nota de entrega.
- `ALL NUTRITION COLOMBIA - planilla.pdf`, respuestas correlativas e imágenes de la página 1.

La interpretación manual/seguimiento de esta propuesta es una delimitación actual sugerida, no una transcripción de un nuevo acuerdo del cliente.

## 9. Alcance técnico vigente v3

Producción previa: VM Linux con Compose/PostgreSQL detrás del Nginx del host; Caddy para staging/pruebas o despliegue autónomo. SQLite es alternativa local; Vercel/Supabase requiere worker persistente aparte. No hay failover ni replicación. Imágenes locales persisten en volumen separado de los respaldos de negocio.

Pedidos conservan precios, costos, componentes, vendedor y políticas históricos. Recaudos, liquidaciones, gastos/pagos, devoluciones, compensaciones y cierres son documentos auditables, no integración automática. Las fechas desconocidas y costos faltantes no se inventan para completar beneficios.

Excel se revisa por fuente/cuenta y se aplica en grupos atómicos con revisión congelada. Informes explican cobertura y hechos en seis periodicidades Bogotá; snapshots no se sobrescriben. Worker, leases y heartbeat permiten importaciones/alertas/reportes sin panel abierto. Todas las cuentas de acceso siguen siendo administradoras; personas responsables no necesitan login.

Esta actualización no incorpora CRM, reglas fiscales, conectores, pagos automáticos ni política de backups off-host; tampoco publica v3 por el solo hecho de aprobar localmente. La promoción y recuperación deben aceptarse en el destino real.
