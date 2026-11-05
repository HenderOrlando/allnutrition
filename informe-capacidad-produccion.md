# Evaluación de recursos y capacidad de tiendas

Evaluación de solo lectura del repositorio y de producción. Ventana remota: **2026-11-01 02:58:15–03:03:30 UTC**, según los relojes remotos. Histórico consultado: siete días; muestreo directo dirigido: 15 segundos y 60 segundos, sin tráfico de prueba. Se completaron tres rondas: descubrimiento, observación dirigida y cierre local.

**Conclusión:** la instalación actual aloja una sola tienda. El servidor físico tiene RAM disponible, pero esa RAM no está asignada automáticamente a la aplicación. El presupuesto conservador de CPU/RAM/espacio permite modelar **7 tiendas ligeras, 3 habituales o 1 intensa en total**, como instalaciones independientes. Son techos condicionales del modelo, **no capacidad demostrada ni autorización para ampliar**: faltan costes reales por petición y límites de E/S bajo actividad comercial. Con el código actual no se pueden incorporar tiendas independientes dentro de la misma instancia. No se demostró ninguna capacidad adicional que garantice no afectar a los demás servicios.

## Recursos actuales

| Recurso | Servidor físico compartido | VM `allnutrition-prod` |
|---|---|---|
| CPU | Intel Xeon E5-1650 v3, 6 núcleos físicos / 12 hilos, 3,50 GHz nominales | 2 vCPU; afinidad en los 12 hilos del host, no dedicadas |
| RAM | 257.618 MiB = 251,58 GiB | 8 GiB configurados; 7.941 MiB visibles al SO |
| RAM utilizada / disponible | 100.095 / 157.523 MiB en muestra dirigida | 1.454 / 6.487 MiB; al cierre 1.467 / 6.474 MiB |
| Swap | 4.090 MiB totales, aproximadamente 47 MiB ocupados | Sin swap |
| Raíz | `/dev/md2`, ext4, 1.981,19 GiB totales; 195,21 GiB usados; 1.685,27 GiB disponibles; 11 % informado por df | `/dev/vda1`, ext4, 57,07 GiB totales; 39,61 GiB usados; 17,45 GiB disponibles; 70 % informado por df |
| Almacenamiento físico | Dos discos de 3,6 TiB, `ROTA=1`; RAID1 con ambos miembros activos `[UU]` | qcow2 de 60 GiB virtuales en `/var/lib/libvirt/images/allnutrition-prod/` |
| Red | Interfaz `enp4s0`: velocidad reportada 1.000 Mbit/s | Red privada `192.168.201.10`, NAT libvirt; Nginx del host termina TLS |
| Otras cargas | Otras cinco VM y 28 contenedores en ejecución durante el inventario | Solo tres contenedores activos de esta aplicación |

GiB = 2^30 bytes, MiB = 2^20 bytes. `MemAvailable` incluye memoria recuperable; no equivale a RAM reservada. Las cifras de df no necesariamente suman por reserva de bloques del filesystem. RAID1 no duplica la capacidad útil. La velocidad del enlace no demuestra ancho de banda disponible.

La consulta `virsh dominfo` confirmó 2 vCPU y 8 GiB actualmente, no solo en documentación histórica. `virsh schedinfo` no mostró una cuota efectiva restrictiva; no hay pinning exclusivo. La memoria de QEMU residente ronda 8,14 GiB en el host: no debe confundirse con los 1,4 GiB usados dentro del guest ni sumarse a ellos como dos aplicaciones diferentes.

## Consumo observado

### Aplicación y base

| Servicio | Versión / imagen observada | Memoria Docker observada | CPU instantánea observada |
|---|---|---|---|
| web | Node v24.22.2, Next 16.4.3; `allnutrition:release-4d054869563c` | 161,2 MiB | 0–20,51 % de un núcleo en las muestras puntuales |
| scheduler | Misma imagen de aplicación | 280,1 MiB | 0–1,62 % de un núcleo en las muestras puntuales |
| PostgreSQL | `postgres:16-bookworm` | 78,29–80,36 MiB | 0–0,02 % de un núcleo en las muestras puntuales |

Suma inicial: **521,66 MiB**. Docker muestra uso de memoria ajustado por caché, no una reserva ni un pico histórico. La memoria de toda la VM incluye sistema operativo, demonios y demás memoria: no se debe extrapolar solo la suma de contenedores. Los porcentajes Docker son por núcleo; 100 % corresponde aproximadamente a una vCPU, mientras que vmstat informa porcentajes del conjunto de CPU.

Los tres contenedores tenían reinicios 0 y `OOMKilled=false` en la consulta. No tenían límites de memoria ni cuotas CPU propios: comparten el límite de la VM. En el cgroup de web, `oom`, `oom_kill` y `nr_throttled` eran 0; no se comprobó su historia anterior a la creación actual.

| Muestra directa, excluyendo la primera fila acumulada de vmstat | CPU us+sy media | CPU us+sy máxima | I/O wait medio | I/O wait máximo |
|---|---:|---:|---:|---:|
| Host, 15 muestras de 1 s | 5,47 % | 9 % | 1,60 % | 3 % |
| Guest, 15 muestras de 1 s | 7,60 % | 28 % | 0,33 % | 4 % |
| Host, 12 muestras de 5 s | 11,08 % | 17 % | 3,75 % | 14 % |
| Guest, 12 muestras de 5 s | 6,92 % | 9 % | 2,42 % | 20 % |

Los valores us+sy del host excluyen el campo separado de ejecución guest, que promedió 2,67 % y 2,17 % respectivamente. No son la utilización total de todas las VM. El contador libvirt de CPU de esta VM pasó de 455.836,838718 a 455.847,109865 segundos en aproximadamente 60 segundos: **0,1712 segundos de CPU por segundo**, aproximadamente 8,56 % de sus dos vCPU, incluyendo trabajo de virtualización contabilizado por libvirt. La medición incluye el pequeño coste de observación. En web, el contador pasó de 3.316.260.203 a 3.318.844.770 microsegundos en aproximadamente 62 segundos: alrededor de 0,0417 núcleos de media; sus healthchecks periódicos ya existentes también consumen recursos.

La muestra de 60 segundos incluyó al menos un ciclo nominal del scheduler. No incluyó importación aplicada, carga comercial, backup, restauración ni despliegue. No se midió el pico de esos procesos.

### Histórico disponible del servidor físico

Prometheus respondió correctamente a consultas acotadas sobre métricas existentes. Único target devuelto para node: `node-exporter:9100`, host `vivo-servicios`; no apareció un target separado para esta VM en esas consultas.

| Indicador histórico del host | Resultado | Alcance exacto |
|---|---:|---|
| CPU no idle media | 19,07 % | Ventanas de 5 min, evaluadas cada hora, últimos 7 días |
| CPU no idle máxima | 28,19 % | Misma cuadrícula horaria, últimos 7 días |
| CPU no idle máxima | 29,63 % | Ventanas de 5 min, evaluadas cada 5 min, últimas 24 h |
| RAM disponible mínima | 153,57 GiB | `min_over_time` de las muestras disponibles, últimos 7 días |
| Disco sda ocupado, máximo | 35,67 % | Ventanas de 5 min, cada 5 min, últimas 24 h |
| Disco sdb ocupado, máximo | 78,67 % | Mismo alcance |
| PSI I/O full máximo | 16,46 % | Rate de 5 min del tiempo stalled, evaluado cada hora, últimos 7 días |
| Muestras `up` de node | 20.160; mínimo 1 | Últimos 7 días; compatible con scrape cada 30 s |

CPU no idle = `1 - avg(rate(idle))`: incluye espera de E/S y otros estados no idle, no solo ejecución útil. Se utiliza como presupuesto deliberadamente conservador. Los máximos de 7 días a resolución horaria pueden ser menores que los de 24 h a resolución de cinco minutos: no son máximos continuos ni p99. El mínimo de `up=1` y el número de muestras no prueban ausencia de todo hueco de recolección. La primera evaluación horaria recuperada tiene timestamp 1792900793,781; las consultas finales se realizaron alrededor de 1793502206,7.

En la observación inicial, PSI I/O full avg300 del host era 6,64 %. Hay presión de disco real aun con mucha RAM disponible. El indicador de ocupación no mide directamente IOPS disponibles ni latencia fsync; **no se puede inferir capacidad de escrituras por tienda del porcentaje libre de disco**.

### Estado de datos y PostgreSQL

- Consultas agregadas, en transacciones `READ ONLY`, con `statement_timeout=1500ms` y `lock_timeout=300ms`: **0 pedidos, 5 productos, 0 envíos, 733 filas de importación**. No se leyeron contenidos de registros, clientes, usuarios ni archivos importados.
- Cuatro lotes: uno `review`, uno `expired`, dos `cancelled`. El repositorio describe funcionalidad comercial amplia, pero la base observada todavía no contiene pedidos reales con los que calibrar su coste.
- Tamaño de base: **18.824.215 bytes = 17,95 MiB**. `pg_stat_user_tables` estimaba 733 filas vivas en import_rows y 40 snapshots; esas estadísticas son estimaciones, a diferencia de los cuatro COUNT explícitos anteriores.
- PostgreSQL: `max_connections=100`, `shared_buffers=128 MiB`, `work_mem=4 MiB`, `maintenance_work_mem=64 MiB`, `effective_cache_size=4 GiB` —este último es una estimación del optimizador, no una asignación—; hasta 2 workers paralelos por gather. No se cambiaron valores.
- Tres conexiones al consultar: dos idle y la sesión observadora activa. Acumulados: 2.497.004 commits, 25 rollbacks, 723 bloques leídos, 96.436.863 hits, cero temp_files y deadlocks. Sin `stats_reset` disponible: no se convierten en tasas ni se usa el hit ratio para prometer rendimiento futuro.
- Los estados consultados de heartbeat, alertas, nómina e informes eran `succeeded`, sin error_code. El heartbeat observado se había actualizado 26 segundos antes; esto no prueba ausencia de backlog en todas las colas.
- Docker informó imágenes de 10,25 GB y build cache de 24,21 GB; 8,134 GB y 16,45 GB respectivamente etiquetados recuperables. Son cifras decimales del daemon, pueden compartir capas y **no se suman como espacio recuperable garantizado**. No se ejecutó prune ni se borró nada. La ocupación actual del guest no procede principalmente de los 18,8 MB de la base; el cache de builds es relevante.

## Arquitectura y límites

### Unidad de tienda: una instalación, no un tenant

- `db/supabase.sql:5-19`: esquema fijo `allnutrition`; settings con `CHECK(id=1)`; tablas comunes de usuarios, pedidos y contadores. `lib/db/postgres.mjs:16-23`: un pool y nombres de tabla en ese esquema fijo.
- `lib/server.mjs:7-9`: una Store global por proceso, no un selector por dominio/tienda. `lib/store.mjs:40-46`: una configuración global; `app/page.jsx:6-11`: usa esa configuración para la marca y la vitrina.
- `compose.yaml:25-89`: una base, un web y un scheduler. `deploy/nginx/allnutrition.wintimeapp.co.conf:23-47`: un dominio reenvía a una única VM.

**Decisión de modelado:** tienda adicional significa instalación con su propia base/configuración, medios, web y scheduler; para no asumir un rediseño se reserva una VM de **2 vCPU, 8 GiB y 60 GiB** por tienda, igual a la asignación actual. No se crean VM ni se propone aquí una migración. Añadir catálogos, usuarios, dominios o plataformas a la base actual no equivale a aislar negocios. Capacidad funcional actual: **1 tienda por instancia; 0 tiendas independientes adicionales dentro de ella sin cambios de arquitectura/despliegue**.

### Operaciones que determinan el consumo

| Ruta / sección | Evidencia del código | Consecuencia para la estimación |
|---|---|---|
| `app/page.jsx:4-11`, `app/[section]/[slug]/page.jsx:4`, `lib/store.mjs:121-133` | Render dinámico; publicData carga productos completos, filtra publicados y compone catálogos/combos y otras secciones | El coste de una visita crece con el catálogo; no es una página estática servida solo por Nginx |
| `lib/store.mjs:27-36,121-133` | Listados sin paginar; combos pueden volver a obtener todos los productos para disponibilidad | No extrapolar cinco productos a miles con coste constante |
| `lib/server.mjs:33-36`, `app/api/media/[id]/route.js:9-20` | JSON y adjuntos no-store; medios inmutables con max-age de un año y streaming | Las imágenes repetidas pueden aprovechar caché cliente; lecturas comerciales siguen llegando al backend |
| `lib/business/orders.mjs:447-499` | Página de 20 pedidos, pero COUNT y CTE calculan cobros/devoluciones sobre el conjunto filtrado; filtros JSON y LIKE | Paginar la respuesta no garantiza trabajo O(20); el histórico cambia el coste de búsqueda |
| `lib/business/reports.mjs:116-164`, `lib/business/dashboard.mjs:93-104` | Proyecciones leen colecciones históricas; dashboard genera informe, comparación y finanzas en snapshot | Informes y panel no tienen el coste de un SELECT trivial; retienen una conexión durante el cálculo |
| `lib/store.mjs:24-25`, `lib/business/jobs.mjs:20-42` | `lockWrites` bloquea una misma fila de counters para escrituras coordinadas | Límite de concurrencia de escrituras por instalación; más CPU no elimina la serialización |
| `compose.yaml:1-7`, `lib/db/postgres.mjs:16-20,35-49` | DB_POOL_MAX=5 confirmado en web; pool por proceso, timeout de consultas 15 s | Web y scheduler pueden consumir hasta 10 conexiones si ambos conservan esa configuración; no son 10 usuarios máximos |
| `lib/business/excel.mjs:8,22-53` | Archivo máximo 10 MiB; worker con old generation de 256 MiB y young de 16 MiB; plazo reiniciado con progreso de 30 s | Ese límite no es RSS total ni un máximo global de importaciones simultáneas; buffers/copias/resultados agregan consumo |
| `scripts/business-jobs.mjs:24-42`, `lib/business/jobs.mjs:16,219-233` | Heartbeat cada 30 s; vueltas cada 60 s sin pendientes o 100 ms con trabajo; hasta 25 grupos y 10 reportes por turno | Existe coste fijo incluso sin visitantes; importaciones e informes pendientes elevan CPU y escrituras |
| `compose.yaml:67-72` | Healthcheck web cada 5 s consultando `/api/health` y su base | Parte del consumo idle ya incluye observación interna periódica |

No se cambió código. La guía de la versión instalada `node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md:78-99` confirma que `force-dynamic` renderiza por petición; `next.config.mjs` no activa Cache Components. No se presupone caché automática sobre consultas pg. El vhost leído no configura proxy_cache.

Cinco archivos clave del runtime y el vhost activo coinciden por SHA-256 con las copias locales usadas para el análisis; no es una comparación exhaustiva de todo el release. Imagen web/scheduler observada: `sha256:4d054869563c815a67e8ad23fe956ddec65910c16f13e9247b42f529f31f5b69`.

## Tres escenarios de actividad

**Supuestos**, no mediciones ni perfiles del cliente. Usuarios activos realizan acciones intermitentes, no conexiones ejecutando trabajo continuamente. RPS cuenta peticiones dinámicas que llegan al backend; no imágenes y assets cacheados. Pedidos y cambios administrativos están incluidos en esa tasa, no se suman de nuevo. El coste CPU por petición es agregado de web + base + scheduler asociado, en segundos de CPU, **no latencia de respuesta**.

| Escenario | Visitantes activos y frecuencia dinámica | Administradores activos y frecuencia | RPS dinámicos por tienda | Pedidos/hora | Productos / pedidos históricos | CPU asumida por petición | Reserva CPU por tienda | Reserva RAM / disco |
|---|---|---|---:|---:|---|---:|---:|---|
| 1. Ligera | 5; una petición cada 30 s | 1; una cada 12 s | 0,25 | 2 | 100 / 1.000 | 100 ms | 0,25 núcleos equivalentes | 8 GiB / 60 GiB |
| 2. Habitual | 20; una cada 25 s | 3; una cada 10 s | 1,10 | 10 | 500 / 10.000 | 200 ms | 0,50 núcleos equivalentes | 8 GiB / 60 GiB |
| 3. Intensa | 60; una cada 20 s | 6; una cada 10 s | 3,60 | 30 | 2.000 / 50.000 | 250 ms | 1,20 núcleos equivalentes | 8 GiB / 60 GiB |

Base fija supuesta: **0,20 núcleos por instalación**, redondeada hacia arriba desde los 0,1712 observados en la VM casi sin datos. Fórmula `C_tienda = redondeo_conservador(0,20 + RPS × CPU_segundos_por_petición)`: da 0,225→0,25; 0,420→0,50; 1,100→1,20. Los redondeos son decisiones de reserva, no precisión de benchmark. El aumento de coste supuesto entre catálogos/históricos no fue calibrado; puede quedarse corto para reportes complejos.

Los tres escenarios suponen **sin importaciones, backups, builds ni informes históricos masivos coincidentes con la punta**, y base/medios/retención dentro de 60 GiB por instalación. Es una condición del cálculo, no algo configurado ni asegurado actualmente. No se cuenta con una medición de bytes por pedido comercial; 60 GiB es una reserva de despliegue, no una proyección demostrada de retención.

Criterio de servicio propuesto para una validación posterior autorizada, **no medido ni aprobado aquí**: p95 de peticiones dinámicas ordinarias ≤1 s y errores HTTP 5xx <1 %, evaluados durante 15 minutos de punta representativa con los datos del escenario; importaciones asincrónicas fuera de ese SLO. No se envió ninguna petición para comprobarlo.

## Estimación de tiendas

### Fórmulas y margen de seguridad

Presupuesto deliberadamente conservador sobre recursos actuales, sin reclamar la RAM de otros servicios:

1. CPU: objetivo de no idle total ≤60 % del host; referencia histórica más alta recuperada = 29,6312 % en 24 h. Saldo lógico `(12 × 0,60) - (12 × 0,2963117284) = 3,6443` núcleos lógicos equivalentes. Se reserva solo el **50 % de ese saldo**, por SMT, antigüedad de CPU y variabilidad de otras cargas: **B_CPU = 1,8221**. El factor no convierte rigurosamente hilos en núcleos físicos ni demuestra capacidad útil: es un descuento de planificación.
2. Memoria: mínimo histórico de MemAvailable = `164890759168 / 2^30 = 153,5665 GiB`; conservar otros **64 GiB** de colchón: **B_RAM = 89,5665 GiB**. Se cargan 8 GiB completos por tienda: sin sobreasignación de memoria en el modelo.
3. Espacio raíz del host: disponibles `1809542676480 / 2^30 = 1685,2679 GiB`; mantener libre el 20 % del total `2127283216384 / 2^30 = 1981,1869 GiB`: **B_DISCO = 1289,0306 GiB**. Se cargan 60 GiB completos por instalación; no se aprovecha sparse ni se cuenta ninguna limpieza hipotética.
4. `N_modelo = min(floor(B_CPU / C_tienda), floor(B_RAM / 8), floor(B_DISCO / 60))`.

**N_modelo incluye la tienda actual.** Se carga su reserva completa de nuevo aunque su consumo y asignación actuales ya estén dentro de las referencias del host. Es doble contabilidad conservadora intencional: evita vender toda la holgura como capacidad adicional o asumir que la tienda existente permanecerá vacía. Para adicionales se resta una tienda al total. Los otros cinco guests permanecen incluidos en el consumo histórico de referencia.

| Escenario | Límite CPU | Límite RAM | Límite espacio | Total condicional N_modelo | Adicionales sobre la actual | Recurso que limita el modelo |
|---|---:|---:|---:|---:|---:|---|
| 1. Ligera | 7 | 11 | 21 | **7** | **6** | CPU; E/S sin validar |
| 2. Habitual | 3 | 11 | 21 | **3** | **2** | CPU; E/S sin validar |
| 3. Intensa | 1 | 11 | 21 | **1** | **0** | CPU global y posible hilo web; E/S sin validar |

**Lectura operativa:** usar tres tiendas habituales en total solo como hipótesis de presupuesto del servidor, no como compromiso comercial. Ni tres ni siete están demostradas. La instancia actual sigue siendo una sola tienda; replicar sus contenedores o VM sería un cambio de producción que no se realizó. Las 2 vCPU por VM no serían dedicadas: siete VM sumarían 14 vCPU virtuales sobre los 12 hilos existentes, además de otras cargas. El cálculo utiliza uso efectivo supuesto, no garantiza CPU simultánea asignada.

**Cuello de botella no cuantificado:** PostgreSQL sobre HDD compartido/RAID1, con esperas ya observadas; en 24 h sdb alcanzó 78,67 % ocupado en una ventana de cinco minutos. No hay un presupuesto medido de IOPS o fsync por tienda, ni atribución de ese I/O a cada servicio. Por ello el mínimo de CPU/RAM/espacio es **incompleto como límite integral de capacidad** y la capacidad sin impacto puede ser menor. No hay una cifra de expansión segura verificada.

Dentro de la VM actual: conservar el 20 % de los 57,07 GiB deja solo aproximadamente **6,04 GiB adicionales de crecimiento** antes de ese umbral, pese a los 17,45 GiB disponibles reportados por df. No se propone llenarlos con otras tiendas. Build cache, imágenes, backups locales y datos comparten ese disco; no se eliminó nada para inflar la capacidad.

Sensibilidad: si el coste variable por petición fuese el doble, sin cambiar la base fija y usando `ceil((0,20 + RPS × 2 × CPU_segundos) × 20) / 20`, las reservas serían 0,25 / 0,65 / 2,00 núcleos y los límites CPU serían 7 / 2 / 0 tiendas. El cero del caso intenso significa que **este presupuesto no lo respalda**, no que la tienda existente se detenga. La diferencia demuestra la incertidumbre del coste asumido.

## Limitaciones

- La base sin pedidos impide inferir consumo por venta, búsqueda o informe comercial. No se midieron RPS productivos, sesiones simultáneas, p95/p99 ni tasa de errores por endpoint. La consulta de existencia de tres nombres habituales de métricas HTTP devolvió vector vacío; no es una búsqueda exhaustiva de toda la observabilidad.
- No se leyeron access logs, secretos, variables de entorno completas, credenciales de base, sesiones, datos personales ni archivos de importación. Solo se imprimieron DB_POOL_MAX y DB_DRIVER como valores no secretos de web.
- La aplicación se mantuvo en ejecución. No hubo pruebas de carga, visitas HTTP de prueba, login, jobs disparados manualmente, instalación, migración, reinicio, cambios de configuración, actualización ni escritura en base. No se adjuntaron backups ni logs privados.
- Las consultas SQL fueron pequeñas, agregadas y limitadas por tiempo; aun siendo READ ONLY, observadores y consultas incrementan estadísticas internas y pueden dejar registros normales de auditoría/SSH del sistema. “Solo lectura” significa sin modificación intencional de datos/configuración, no impacto físico exactamente cero.
- El primer SSH del host al guest usando identidad predeterminada fue rechazado por publickey. El salto desde el equipo autorizado con la clave ya facilitada funcionó. No se copiaron claves ni se modificaron known_hosts; StrictHostKeyChecking permaneció habilitado. QEMU guest agent no estaba conectado, y su balloon tenía timestamp obsoleto: no se usó esa RAM “disponible” antigua para estimar capacidad.
- El histórico de siete días reduce el sesgo del instante, pero no incluye campañas futuras ni garantiza cubrir la peor carga de CI u otras aplicaciones. La muestra directa está cerca de las 03:00 UTC y no fue elegida como punta comercial.
- Disco libre no es rendimiento de disco; RAM libre no es capacidad de CPU; cantidad de usuarios configurados no equivale a concurrencia. Tampoco max_connections equivale a clientes HTTP simultáneos. El proceso web no escala automáticamente su JavaScript síncrono a los seis núcleos físicos.
- Los modelos de CPU, retención y simultaneidad están etiquetados como supuestos. El criterio de no afectar producción impidió validarlos con carga. No se puede prometer un máximo exacto o un SLO con esta evidencia.
- **Escalación:** cualquier expansión, limpieza de cache/imágenes, reasignación de RAM/vCPU, acceso a información sensible o validación con carga necesita una autorización distinta. La evaluación se cierra en la tercera ronda; no se prosigue con experimentos para compensar los datos ausentes.

## Evidencia y verificación

### Acceso y comandos realmente ejecutados

Identidad autorizada: `~/vivo-server`. SSH al host:

```sh
ssh -i ~/vivo-server -p 22 -o BatchMode=yes -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes root@168.119.37.246 'COMANDO_DE_LECTURA'
```

SSH al guest con la misma identidad, sin copiarla al servidor:

```sh
ssh -i ~/vivo-server -p 22 -o BatchMode=yes -o ConnectTimeout=8 \
  -o StrictHostKeyChecking=yes \
  -o 'ProxyCommand=ssh -i ~/vivo-server -p 22 -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes -W %h:%p root@168.119.37.246' \
  allnutrition@192.168.201.10 'COMANDO_DE_LECTURA'
```

Los marcadores indican que se sustituyó el argumento remoto por los comandos siguientes, no órdenes ejecutables para lanzar cargas. Comandos remotos relevantes ejecutados en lotes breves:

```sh
# Host: inventario y recursos
date -u +%Y-%m-%dT%H:%M:%SZ
uname -srm
getconf _NPROCESSORS_ONLN
lscpu
uptime
free -m
df -hT /
df -B1 /
cat /proc/loadavg
lsblk -d -o NAME,SIZE,ROTA,TYPE
cat /proc/mdstat
cat /sys/class/net/enp4s0/speed
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}'
ps -eo comm,pcpu,pmem,rss --sort=-rss  # salida limitada a 16 líneas en la ejecución
virsh list --all
virsh dominfo allnutrition-prod
virsh domblklist allnutrition-prod
virsh domifaddr allnutrition-prod
virsh domstats allnutrition-prod --vcpu --balloon --block --interface
virsh cpu-stats allnutrition-prod --total
virsh schedinfo allnutrition-prod
virsh vcpupin allnutrition-prod
cat /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io
cat /proc/diskstats
vmstat 1 16
vmstat 5 13
sha256sum /etc/nginx/sites-enabled/allnutrition-wintimeapp.co.conf

# Guest: recursos, aplicación y daemon; no arranque del programa de negocio
getconf _NPROCESSORS_ONLN
uptime
free -m
df -hT /
df -B1 /
cat /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}'
docker system df
vmstat 1 16
vmstat 5 13
docker inspect --format '{{.Name}} memory={{.HostConfig.Memory}} nanocpus={{.HostConfig.NanoCpus}} cpuquota={{.HostConfig.CpuQuota}} cpuset={{.HostConfig.CpusetCpus}} restart={{.RestartCount}} oom={{.State.OOMKilled}} image={{.Image}}' allnutrition-production-web-1 allnutrition-production-scheduler-1 allnutrition-production-db-1
docker exec allnutrition-production-web-1 node --version
docker exec allnutrition-production-web-1 node -p 'require("next/package.json").version'
docker exec allnutrition-production-web-1 node -e 'console.log(JSON.stringify({poolMax:process.env.DB_POOL_MAX,driver:process.env.DB_DRIVER}))'
docker exec allnutrition-production-web-1 sha256sum /app/lib/store.mjs /app/lib/business/reports.mjs /app/lib/business/excel.mjs /app/lib/business/jobs.mjs /app/scripts/business-jobs.mjs
docker exec allnutrition-production-web-1 sh -c 'for f in /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.events; do echo "$f"; cat "$f"; done'
```

También se consultó disponibilidad con `command -v`, `systemctl is-active sysstat prometheus prometheus-node-exporter` y `docker port vivo-observability-prometheus`. Los servicios systemd salieron inactivos porque el Prometheus observado es contenedor. La primera tanda devolvió exit 1 al finalizar con `command -v sar` ausente; los recursos anteriores sí se recuperaron. Intento QEMU: `virsh qemu-agent-command allnutrition-prod '{"execute":"guest-ping"}'`, agente no conectado; no se ejecutó ningún comando dentro del guest por ese mecanismo.

La IP interna de Prometheus se obtuvo con `docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' vivo-observability-prometheus`: `10.240.2.2`. Las consultas fueron `curl -fsS --max-time 8` a `http://10.240.2.2:9090/api/v1/query`, con `query` codificado como URL. PromQL exacto:

```promql
max_over_time((1 - avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))[7d:1h])
avg_over_time((1 - avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))[7d:1h])
min_over_time(node_memory_MemAvailable_bytes[7d])
node_memory_MemTotal_bytes
max_over_time((rate(node_disk_io_time_seconds_total{device=~"sda|sdb"}[5m]))[7d:1h])
max_over_time((rate(node_pressure_io_stalled_seconds_total[5m]))[7d:1h])
min_over_time(up{job=~".*node.*"}[7d])
count({__name__=~"nginx_http_requests_total|nginx_requests_total|http_server_requests_seconds_count"})
count_over_time(up{job="node"}[7d])
min_over_time((timestamp(up{job="node"}))[7d:1h])
max_over_time((1 - avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))[24h:5m])
max_over_time((rate(node_disk_io_time_seconds_total{device=~"sda|sdb"}[5m]))[24h:5m])
```

Consultas SQL ejecutadas mediante `docker exec allnutrition-production-db-1 sh -c 'exec psql -X -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c ...'`, sin imprimir POSTGRES_DB ni credenciales. Se ejecutaron dos transacciones con estos límites; se agrupan aquí sus SELECT:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout='1500ms';
SET LOCAL lock_timeout='300ms';
SELECT name,setting,unit FROM pg_settings WHERE name IN
 ('max_connections','shared_buffers','work_mem','maintenance_work_mem',
  'effective_cache_size','max_worker_processes','max_parallel_workers',
  'max_parallel_workers_per_gather');
SELECT pg_database_size(current_database()) AS database_bytes;
SELECT relname,n_live_tup,n_dead_tup,pg_total_relation_size(relid) AS total_bytes
 FROM pg_stat_user_tables WHERE schemaname='allnutrition'
 ORDER BY pg_total_relation_size(relid) DESC LIMIT 12;
SELECT state,wait_event_type,COUNT(*) FROM pg_stat_activity
 WHERE datname=current_database() GROUP BY state,wait_event_type;
SELECT numbackends,xact_commit,xact_rollback,blks_read,blks_hit,temp_files,
 temp_bytes,deadlocks,stats_reset FROM pg_stat_database
 WHERE datname=current_database();
COMMIT;

BEGIN READ ONLY;
SET LOCAL statement_timeout='1500ms';
SET LOCAL lock_timeout='300ms';
SELECT 'orders' AS metric,COUNT(*) AS count FROM allnutrition.orders
 UNION ALL SELECT 'products',COUNT(*) FROM allnutrition.records WHERE kind='products'
 UNION ALL SELECT 'shipments',COUNT(*) FROM allnutrition.shipments
 UNION ALL SELECT 'import_rows',COUNT(*) FROM allnutrition.import_rows;
SELECT state,COUNT(*) FROM allnutrition.import_batches GROUP BY state;
SELECT key,state,error_code,updated_at FROM allnutrition.job_runs WHERE key IN
 ('scheduler:heartbeat','scheduler:alerts','scheduler:payroll','scheduler:reports');
COMMIT;
```

### Trazabilidad del código y reproducción local

`shasum -a 256` local coincidió con `sha256sum` remoto:

| Archivo | SHA-256 |
|---|---|
| `lib/store.mjs` | `9e304189b70a3840f12beedbde88b2b02a0d3ef33bf176c18768efb787e3a2af` |
| `lib/business/reports.mjs` | `2b4596512e9f2e7acab236415a8d097d140fd1098cd4de6fa22f74dd164ca88f` |
| `lib/business/excel.mjs` | `b2d559de4b4b5eba6d30b410ca324a78a7662598fae08832d4c4c6416804ab65` |
| `lib/business/jobs.mjs` | `ddd489af2ac58db334a6a96e99e8d5dcaa24cbf15eeb5418586289718d9fc822` |
| `scripts/business-jobs.mjs` | `20d5fd77cc158db69e62cc6a86d4f03bf64162c9c7e13296258499d2642d4ec8` |
| `deploy/nginx/allnutrition.wintimeapp.co.conf` | `3921aaf0b3424ccdd23d6e22a371c58309ab6ce4a9cb9d42adbacde744a52981` |

Las cifras y referencias restantes se obtuvieron por lectura directa de los archivos citados. No se abrieron bases locales ni se ejecutó openStore para medir: `lib/db/index.mjs:18` inicializa filas, por lo que no era adecuado para esta evaluación sin escrituras.

Verificación local del entregable: `test -s informe-capacidad-produccion.md` y Node.js para comprobar las siete secciones, los tres escenarios numerados en ambas tablas, fórmulas, supuestos, referencias existentes y evidencia SSH; también se recalcula el mínimo de recursos y la sensibilidad. Se conserva el informe como único archivo creado; no se añaden pruebas ni scripts permanentes. Esta verificación comprueba integridad y aritmética del informe, no rendimiento de producción.

Resultado observado del verificador local: **exit 0 en test -s y Node.js; PASS**, siete secciones en el orden exigido, tres escenarios, 18 referencias a archivos existentes, totales `[7,3,1]`, adicionales `[6,2,0]` y sensibilidad `[7,2,0]`. No se ejecutó la suite de la aplicación: no hubo cambios de software y esa suite no demostraría capacidad productiva.

Comando local para repetir la comprobación estructural y los cálculos principales, sin escribir archivos ni acceder a producción:

```sh
test -s informe-capacidad-produccion.md && node --input-type=module -e '
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const t=readFileSync("informe-capacidad-produccion.md","utf8");
assert.deepEqual([...t.matchAll(/^## (.+)$/gm)].map(m=>m[1]),["Recursos actuales","Consumo observado","Arquitectura y límites","Tres escenarios de actividad","Estimación de tiendas","Limitaciones","Evidencia y verificación"]);
const s=t.split("## Tres escenarios de actividad\n")[1].split("## Estimación de tiendas")[0];
assert.equal((s.match(/^\| [123]\. /gm)||[]).length,3);
const cpu=(12*.60-12*.29631172839529174)*.5;
const ram=164890759168/2**30-64;
const disk=1809542676480/2**30-2127283216384/2**30*.20;
const totals=[.25,.5,1.2].map(c=>Math.min(Math.floor(cpu/c),Math.floor(ram/8),Math.floor(disk/60)));
assert.deepEqual(totals,[7,3,1]);
console.log("PASS: 7 secciones, 3 escenarios; totales="+totals+"; adicionales="+totals.map(n=>n-1));
'
```
