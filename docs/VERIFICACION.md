# Verificación observada — All Nutrition v2

Preparación: 28 de septiembre de 2026. El año de los mensajes comerciales históricos no se deduce de esta fecha.

## Resultado real

| Comprobación | Resultado |
|---|---|
| `npm test`, Node 22.16.0 | 78 pruebas contabilizadas: **77 aprobadas, 0 fallidas y 1 omitida**. La omitida corresponde a la integración PostgreSQL sin credenciales de prueba. |
| Adaptador SQLite | Ejecutado con SQLite real, en memoria y en archivo temporal. |
| Sintaxis e importaciones locales | **56 archivos JavaScript/JSX**, sin errores detectados por el analizador. No equivale a comprobación de tipos ni a una compilación Next.js. |
| Comandos CLI sobre SQLite temporal | Migración, setup repetido sin duplicados, respaldo JSON y SQLite completo, importación a destino vacío: ejecutados correctamente. |
| Instalación de dependencias | Intentada; falló con `EAI_AGAIN` al resolver `registry.npmjs.org`. |
| Integración PostgreSQL/Supabase real | No ejecutada. La suite está preparada, pero no se suministró una base de pruebas ni hay un servidor PostgreSQL local. |
| Compilación Next.js | No ejecutada por falta de dependencias instaladas. |
| Playwright / navegador | Pruebas escritas para escritorio y celular, **no ejecutadas**. |
| Docker, Vercel, dominio y proyecto Supabase | Configuración y comandos preparados; **no desplegados ni verificados en infraestructura real**. |

Los registros completos de pruebas, sintaxis e instalación están en esta carpeta. Las claves y cuentas que aparecen en los tests son únicamente datos ficticios de una base de pruebas, no accesos de producción.

## Cobertura ejercitada

Validación de enlaces y datos; selección de base por entorno; rechazo de SQLite en Vercel y de configuración ambigua; orígenes y CSRF; creación/edición/publicación/archivo de entidades; relaciones entre catálogos, productos y combos; proyección pública sin pedidos; paginación y búsqueda; protección ante versiones obsoletas; numeración concurrente e idempotencia; precios y composición históricos; transiciones y datos de despacho; pagos manuales separados; historial; autenticación, bloqueo temporal de intentos y revocación; persistencia después de cerrar/reabrir SQLite; exportación/importación y rechazo de importaciones conflictivas.

Las pruebas de lógica no equivalen a una auditoría de seguridad, ensayo de carga, validación del diseño real en móvil ni compatibilidad comprobada con el pooler de Supabase. El código no ha sido instalado o probado en la cuenta del cliente.

## Próxima comprobación obligatoria en un entorno con red

Ejecutar `npm install`, conservar el lockfile generado, `npm run check`, `npm test` y `npm run build`. Ejecutar las pruebas PostgreSQL en una base desechable llamada `allnutrition_test`, nunca sobre producción. Ejecutar Playwright, probar Docker o Vercel según la infraestructura elegida y realizar la lista de `ACEPTACION_Y_PENDIENTES.md`.

La configuración CI incluida realiza estas comprobaciones en GitHub cuando el titular suba y habilite el repositorio; esa ejecución aún no ocurrió aquí. La entrega es código implementado con evidencia parcial de verificación, **no una certificación de aplicación lista para producción**.
