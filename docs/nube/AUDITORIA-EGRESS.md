# Auditoría de consumo de datos (egress) — Precios al Día Nube

Fecha: 2026-11-16 · Proyecto medido: `nube-pruebas` (`hfuzyauiefhllohonvim`, plan gratuito) · Código: `main` @ `6eefbda` (+ revisión de los PR #13 y #14 sin unir).

## Resumen en una página

- **La sospecha es correcta en lo esencial.** Cada caja baja **todo** el stock de su sede (`stock_levels`) **cada 60 s** y además **cada vez que cambia una fila de stock** (es decir, en cada venta de cualquier caja de la sede). También baja **todos** los saldos de clientes (`customer_balances`) cada 60 s y con cada fiado/abono. Los registros (`account_records`) y los movimientos de clientes sí bajan **solo lo cambiado**.
- **Los 0,8 GB/día son un techo realista, no el caso típico.** Medido con 5.000 productos, 12 h abiertas y 500 ventas/día, una caja baja **≈ 0,5 GB/día sin comprimir** en `main` (≈ 0,7 GB con el PR #14). Pero Supabase sirve esas respuestas **con gzip** y lo que viaja por el cable es ≈ **1/3**: **≈ 170 MB/día por caja** (≈ 210 MB con el PR #14). La estimación de 0,8 GB sale de contar bytes sin comprimir y/o un catálogo más grande.
- **Igual se pasa del plan gratuito.** La cuota de egress (5 GB/mes) es **por organización**, compartida por todos los negocios. Un negocio típico (2.000 productos, 3 cajas, 12 h, 300 ventas/día) consume **≈ 5,9 GB/mes** (7,4 GB con el PR #14): **uno solo ya la agota en ≈ 25 días**; con **10 negocios se agota en ≈ 2,5 días**; con 50 negocios ni el plan Pro (250 GB) alcanza.
- **Hay un segundo límite que llega antes de lo previsto: los mensajes de Realtime.** Cada fila de stock cambiada es un mensaje **por cada caja que escucha**. El negocio típico genera ≈ 111 mil mensajes/mes: el plan gratuito (2 M) aguanta **18 negocios** y el Pro (5 M) **45**.
- **Arreglo con más ahorro:** dejar de releer el stock completo (aplicar el aviso de Realtime + leer solo `updated_at > cursor`). Con eso solo, el negocio típico baja de 5,9 GB a ≈ 1,2 GB/mes (−80 %). Con todos los arreglos propuestos: **≈ 0,1 GB/mes (−98 %)**.

## 1. Qué peticiones hace una caja

Fuente: `src/nube/useNubeSync.js`, `recordSync.js`, `stockService.js`, `customerLedgerSync.js`, `stockWatcher.js`, `NubeGate.jsx`, `ownerDashboard.js`. «Cable» = cuerpo gzip + cabeceras (~1,2 KB por respuesta); «crudo» = sin comprimir.

| # | Petición | Qué baja / sube | Cuándo se dispara | ¿Todo o solo lo cambiado? | Medido (respuesta) |
|---|---|---|---|---|---|
| 1 | `GET stock_levels?select=product_id,qty&sede_id=eq.…` (páginas de 1.000) — `fetchStockLevels` | Stock de **todos** los productos de la sede | Arranque · **tick 60 s** (tras `sales.replay`) · **cada aviso Realtime de `stock_levels`** (uno por fila cambiada; si ya hay una lectura en curso se descarta, en el PR #14 se repite una vez) · al volver a la pestaña · al volver internet | **TODO** | 500 prod.: 38,5 KB crudo / 13,7 KB cable · 2.000: 154 / 52,6 KB (3 peticiones) · 5.000: 385 / 128,7 KB (6 peticiones) |
| 2 | `GET customer_balances?select=customer_id,balance_usd` — `ledger.pull` | Saldo de **todos** los clientes | Arranque · **tick 60 s** · **cada aviso Realtime de `customer_balances`** (cada fiado, abono, vuelto de cualquier caja) · pestaña / internet | **TODO** (y sin paginar: con >1.000 clientes se corta en 1.000) | 200 clientes: 17,1 KB crudo / 6,7 KB cable |
| 3 | `GET customer_movements?seq=gt.<cursor>` | Movimientos de clientes nuevos | Igual que #2 | Solo lo nuevo (cursor `seq`) | vacío: 2 B + 1,2 KB cabeceras |
| 4 | `GET account_records?collection=eq.X&updated_at=gt.<cursor−5 s>` ×5 (products, customers, suppliers, payment_methods, settings) | Registros cambiados | Arranque · tick 60 s · pestaña / internet · aviso Realtime de `account_sync_state` (solo esa colección) | Solo lo cambiado (en el PR #14 el margen pasa a 60 s: re-baja lo del último minuto, se descarta por versión) | vacío: 5 × (2 B + 1,2 KB) |
| 5 | `RPC push_records` | **Sube** registros cambiados (y el registro de caja de cada venta) | Cada escritura local que cambia algo | Solo lo cambiado | Subida = ingress (no se cobra); respuesta pequeña |
| 6 | `RPC process_checkout` | **Sube** la venta | Cada venta | — | respuesta ~0,2 KB |
| 7 | `RPC process_stock_movements` (`stockWatcher`) | **Sube** ajustes de stock hechos fuera del cobro | Al guardar productos con stock cambiado | Solo diferencias | respuesta pequeña |
| 8 | `RPC push_customer_movements` | **Sube** fiados/abonos | Al escribir el libro local | Solo nuevos | respuesta pequeña |
| 9 | `getDeviceStatus` (4 lecturas: `account_devices`, `accounts`, `account_licenses`, `sedes`) | Estado del equipo (¿expulsado?) | **Cada 5 min** y al volver a la pestaña (`NubeGate`) | Pequeño | 0,5 KB + 4 × 1,2 KB cabeceras |
| 10 | Realtime: 1 WebSocket, 3 canales `postgres_changes` (`account_sync_state`, `stock_levels` de la sede, `customer_balances`) | Avisos | Cada cambio en esas tablas; latido cada 25 s | Un mensaje **por fila cambiada y por caja que escucha** | `stock_levels`: ~515 B/mensaje · `customer_balances`: ~436 B · `account_sync_state`: ~345 B |
| 11 | Panel del dueño (equipo de consulta) | Pestaña abierta (Hoy, Ventas, Inventario, Clientes, Diferencias) | **Cada 30 s** mientras está visible | **TODO**: Inventario = `stock_levels` de todas las sedes + nombre de todos los productos (`data->>name`) | Inventario con 5.000 prod.: ≈ 895 KB crudo / ≈ 267 KB cable cada 30 s → **≈ 32 MB/h** |

Detalles que multiplican el consumo:

- **La caja que vende también se avisa a sí misma.** El canal de `stock_levels` no excluye los cambios propios: cada venta provoca una relectura completa en **todas** las cajas de la sede, incluida la que vendió.
- **Un aviso por fila.** Una venta de 3 productos cambia 3 filas de `stock_levels` → 3 mensajes por caja. El trigger `account_records_touch` es `FOR EACH ROW`: subir 200 registros genera 200 avisos de `account_sync_state` por caja. Además, el registro de caja de cada venta (`cash`) también genera un aviso, aunque ninguna caja lo baja.
- **El PR #14 (`nube/auditoria-sync`) aumenta el consumo por venta:** `refreshLevels` ahora hace «una vuelta más» si llegó un aviso mientras leía. En la simulación pasó de ≈ 1 a ≈ 2 lecturas completas de stock por venta (+24 % en el negocio típico). Eso no lo hace incorrecto, pero sí lo hace más caro mientras se siga releyendo todo. Su `pull` coalescido ayuda con las ráfagas de `account_sync_state`. El PR #13 (`nube/usuarios-y-acceso`) no cambia la sincronización: solo pantallas de equipo y PIN.
- El tick se salta si la pestaña no está visible: una caja minimizada no consume (pero las cajas de mostrador suelen estar siempre visibles).

## 2. Mediciones reales

Cómo se midió (repetible, en `scripts/nube/`):

1. `medir-egress.mjs seed N 200` cargó en `nube-pruebas`, con la sesión del dueño de prueba y las mismas RPC de la importación de respaldos, N productos con la forma real del formulario de Bodega (ids tipo UUID, sin imagen), stock inicial en la sede y 200 clientes con saldo. Todo con prefijo `egtest-`.
2. `medir-egress.mjs medir` hizo las **mismas consultas** que la caja con `Accept-Encoding: gzip, br` (como el navegador) y midió bytes por el cable, bytes descomprimidos y cabeceras.
3. `simular-caja.mjs` corrió **los módulos reales de `src/nube`** (`createRecordSync`, `fetchStockLevels`/`applyLevels`, `createCustomerLedgerSync`) con la misma orquestación de `useNubeSync` (tick 60 s + 3 canales Realtime y sus reacciones), contando cada respuesta y cada mensaje Realtime. Las ventas se simularon con `process_stock_movements` (mueven las mismas filas de `stock_levels` que `process_checkout`).
4. `medir-egress.mjs realtime` midió los mensajes de una «venta» de 3 productos, un fiado y una edición de producto.

> No se usó el navegador con sesión de cajero: no había permiso para leer las credenciales de prueba en el chat. El simulador ejecuta el mismo código de sincronización y las mismas consultas, así que los bytes son los mismos. No incluye las subidas (ingress, que no se cobran) ni el registro de caja por venta (necesita una sesión de equipo). Se estimó como un mensaje Realtime más por venta.

### 2.1 Costo de cada lectura (archivos `egress-mediciones/m*.json`)

| Lectura | 500 productos | 2.000 productos | 5.000 productos |
|---|---|---|---|
| Stock completo — crudo | 38,5 KB | 154 KB | 385 KB |
| Stock completo — cable (gzip + cabeceras) | 13,7 KB | 52,6 KB | 128,7 KB |
| Peticiones por lectura de stock | 1 | 3 | 6 |
| Saldos (200 clientes) — crudo / cable | 17,1 / 6,7 KB | = | = |
| Lecturas incrementales vacías (×6 por tick) | 6 × 1,2 KB | = | = |
| Primer arranque: todos los productos (`account_records`) — crudo / cable | 278 KB / 34 KB | 1,1 MB / 135 KB | 2,8 MB / 336 KB |

- ≈ 77 bytes crudos por producto de stock (≈ 25 B con gzip). gzip deja el stock en ≈ 1/3 y los productos completos en ≈ 1/8.
- Las respuestas chicas (<1 KB) llegan sin comprimir; ahí lo que pesa son las **cabeceras (~1,2 KB por respuesta)**.

### 2.2 Simulación de una caja (5.000 productos, 3 min de régimen; `egress-mediciones/sim-5000-*.json`)

| Escenario | Peticiones/min | Crudo/min | Cable/min | Mensajes RT/min |
|---|---|---|---|---|
| En reposo (solo tick) | 12,5 | 437 KB | 138 KB | 0 |
| 2 ventas de 3 productos + 1 fiado por minuto, `main` | 20,2 | 820 KB | 268 KB | 6,7 |
| Ídem con el comportamiento del PR #14 | 31,7 | 1.542 KB | 503 KB | 6,7 |

De ahí: **cada venta cuesta ≈ 1 lectura completa de stock por caja en `main` y ≈ 2 con el PR #14**. Cada fiado cuesta una lectura completa de saldos por caja.

### 2.3 Realtime (medido)

| Evento | Mensajes por caja que escucha | Tamaño |
|---|---|---|
| Venta de K productos | K (`stock_levels`) + 1 (`account_sync_state` del registro `cash`) | ~515 B c/u |
| Fiado / abono / vuelto | 1 (`customer_balances`) | ~436 B |
| Editar un producto, cliente, etc. | 1 por registro (`account_sync_state`) | ~345 B |

Los mensajes de Realtime también cuentan como egress, pero pesan poco (≈ 1-2 % del total). Lo que importa es su **cantidad**, que se cobra aparte.

### 2.4 Base de datos (tamaño medido por fila)

`stock_movements` ≈ 191 B/fila · `stock_levels` ≈ 120 B · producto en `account_records` ≈ 606 B · cliente ≈ 320 B · `customer_movements` ≈ 218 B (sin índices). Estimación por venta (3 productos): ≈ 0,6 KB de movimientos + ≈ 0,8 KB de `sales` + ≈ 1,2 KB del registro de caja, más índices: **≈ 3 KB por venta**. 300 ventas/día ≈ 27 MB/mes por negocio. **Free (500 MB) aguanta ≈ 18 negocios-mes de historial**: es otro límite a vigilar, pero llega después que el egress y los mensajes.

## 3. Límites de Supabase (fuentes oficiales, consultadas el 2026-11-16)

| Recurso | Free | Pro (desde US$ 25/mes) | Fuente |
|---|---|---|---|
| Egress (no cacheado) | 5 GB/mes | 250 GB/mes, luego US$ 0,09/GB | [Manage Egress usage](https://supabase.com/docs/guides/platform/manage-your-usage/egress) |
| Mensajes Realtime | 2 millones/mes | 5 millones, luego US$ 2,50/millón | [Realtime Pricing](https://supabase.com/docs/guides/realtime/pricing) |
| Conexiones Realtime simultáneas (pico) | 200 | 500, luego US$ 10/1.000 | [Realtime Limits](https://supabase.com/docs/guides/realtime/limits) |
| Mensajes Realtime por segundo | 100 | 500 | [Realtime Limits](https://supabase.com/docs/guides/realtime/limits) |
| Tamaño de base de datos | 500 MB | 8 GB por proyecto, luego US$ 0,125/GB | [Pricing](https://supabase.com/pricing) · [Database size](https://supabase.com/docs/guides/platform/database-size) |

Cómo se cuenta: el egress es «data sent out» de la base, Auth, Realtime, etc. a los clientes. La cuota es **por organización**, no por proyecto. Cada cambio en la base «counts as one message per client that listens to the event». Al pasarse en Free, tras un periodo de gracia se aplican restricciones: respuestas 402, base en solo lectura o proyecto pausado ([Billing FAQ](https://supabase.com/docs/guides/platform/billing-faq)).

## 4. Proyecciones

Supuestos: 3 productos por venta, 10 % de ventas a fiado, 200 clientes, todas las cajas en la misma sede (todas oyen cada venta), 30 días/mes, tick siempre visible. «Ventas/día» son del **negocio** (repartidas entre sus cajas). Tablas completas en `egress-mediciones/proyeccion-main.md` y `proyeccion-pr14.md` (`node scripts/nube/proyectar-egress.mjs <lecturas_por_venta>`).

### 4.1 Por caja (`main`)

| Productos | Horas | Ventas/día | Por caja/día (cable) | Por caja/día (crudo) | Por caja/mes (cable) |
|---|---|---|---|---|---|
| 500 | 8 | 100 | 16 MB | 36 MB | 0,47 GB |
| 500 | 12 | 500 | 30 MB | 71 MB | 0,90 GB |
| 2.000 | 8 | 100 | 38 MB | 105 MB | 1,15 GB |
| 2.000 | 12 | 500 | 77 MB | 214 MB | 2,32 GB |
| 5.000 | 8 | 100 | 82 MB | 241 MB | 2,47 GB |
| 5.000 | 12 | 500 | 170 MB | 501 MB | 5,10 GB |

El consumo por caja casi no depende de cuántas cajas haya, porque cada caja oye todas las ventas de la sede. El del negocio se multiplica por el número de cajas.

### 4.2 Por negocio: días hasta agotar los 5 GB gratis (una sola cuenta en el proyecto)

| Productos / horas / ventas-día | 1 caja | 3 cajas | 5 cajas |
|---|---|---|---|
| 500 / 8 h / 100 | 313 días | 106 | 64 |
| 2.000 / 12 h / 300 (típico) | ≈ 75 | **25** | ≈ 15 |
| 2.000 / 12 h / 500 | 64 | 22 | 13 |
| 5.000 / 8 h / 500 | 37 | 12 | **7,4** |
| 5.000 / 12 h / 500 | 29 | 9,8 | **5,9** |

Con el PR #14 unido, los días bajan ≈ 20-35 % (por ejemplo, el típico de 3 cajas pasa de 25 a 20 días).

### 4.3 Varias cuentas (negocio típico: 2.000 productos, 3 cajas, 12 h, 300 ventas/día; `main`)

| Negocios | Egress/mes | % de Free (5 GB) | % de Pro (250 GB) | Mensajes RT/mes | % Free (2 M) | % Pro (5 M) | Conexiones RT pico (Free 200 / Pro 500) | Días hasta 5 GB |
|---|---|---|---|---|---|---|---|---|
| 1 | 5,9 GB | 119 % | 2 % | 0,11 M | 6 % | 2 % | 3 | 25 |
| 10 | 59 GB | 1.189 % | 24 % | 1,1 M | 55 % | 22 % | 30 | 2,5 |
| 50 | 297 GB | 5.943 % | **119 %** | 5,5 M | 277 % | **111 %** | 150 | 0,5 |
| 100 | 594 GB | 11.887 % | **238 %** | 11,1 M | 553 % | **221 %** | 300 (**> Free**) | 0,25 |

Con el PR #14: 7,4 GB/mes por negocio y 2 días hasta 5 GB con 10 negocios. Panel del dueño: si queda abierto en «Inventario» todo el día, **suma ≈ 157 MB/día con 2.000 productos (≈ 385 MB/día con 5.000)**, más que una caja entera.

### 4.4 ¿0,8 GB/día? Veredicto

- **Parcialmente confirmado.** El mecanismo es exactamente el sospechado: todo el stock y todos los saldos, cada minuto y en cada venta.
- **La cifra sobreestima la caja típica.** Con 5.000 productos, 12 h y 500 ventas/día, una caja baja ≈ 0,5 GB/día **sin comprimir** (`main`) o ≈ 0,7 GB (PR #14), pero ≈ **0,17-0,21 GB/día por el cable**, que es lo que mide Supabase. La diferencia viene de tres cosas:
  1. gzip deja el stock en ≈ 1/3.
  2. Por cada venta se relee el stock ≈ 1 vez, no una vez por producto, porque las lecturas en curso absorben avisos.
  3. Con catálogos de 500 a 2.000 productos, el costo baja casi en proporción.
- **La conclusión práctica se sostiene, e incluso empeora.** La cuota es de toda la organización:
  - Un negocio grande (5.000 productos, 3 a 5 cajas, 500 ventas/día) se acaba los 5 GB en **6 a 10 días**.
  - Diez negocios típicos se los acaban en **2,5 días**.
  - Con decenas de negocios ni el plan Pro alcanza, ni en egress ni en mensajes de Realtime.

## 5. Recomendaciones, ordenadas por ahorro

Ahorro sobre el negocio típico (`main`: 66 MB por caja/día, 5,9 GB por negocio/mes). Los pasos son acumulativos; la columna «solo» indica el ahorro aproximado de cada arreglo aislado.

| # | Arreglo | Ahorro acumulado | Solo | Egress negocio/mes | Esfuerzo |
|---|---|---|---|---|---|
| 1 | **Stock incremental**: `fetchStockLevels(client, sedeId, since)` con `.gt('updated_at', cursor − margen)`. `stock_levels.updated_at` ya lo actualiza `stock_movement_apply`; falta un índice `(account_id, sede_id, updated_at)`. Usar un margen como el del PR #14 (`now()` es la hora de inicio de la transacción) y fusionar con `applyLevels` sin borrar lo que no vino. | **79 %** | **≈ 79 %** (el tick y cada aviso dejan de bajar 52 KB) | 1,2 GB | Bajo |
| 2 | **Aplicar el aviso Realtime** en vez de releer: el `payload.new` de `stock_levels` ya trae `product_id` y `qty` (y el de `customer_balances`, `customer_id` y `balance_usd`). Escribir esos valores en la copia local; releer solo si se pierde el canal. | 1+2: **80 %** | ≈ 24 % | 1,2 GB | Bajo |
| 3 | **Saldos incrementales**: lo mismo para `customer_balances` (ya tiene `updated_at`). De paso corrige el límite de 1.000 clientes sin paginar. | **86 %** | ≈ 6 % | 0,8 GB | Bajo |
| 4 | **Alargar el tick** a 5 min mientras el canal Realtime está `SUBSCRIBED`, y volver a 60 s si se cae. | **95 %** | ≈ 58 % | 0,32 GB | Bajo |
| 5 | **Un solo RPC «¿qué cambió?»** (`sync_changes(cursores)`) en vez de 7-8 GET por tick. Las cabeceras (~1,2 KB por respuesta) pasan a ser lo que más pesa. También juntar `getDeviceStatus` (4 lecturas cada 5 min) en un RPC. | **97 %** | — | 0,16 GB | Medio |
| 6 | **Menos mensajes Realtime**: un aviso por venta y no uno por fila. Por ejemplo, una fila `stock_version` por sede tocada por sentencia, o un Broadcast desde `process_checkout` con las cantidades. Además, sacar `cash` de `touch_sync_state` y pasar `account_records_touch` a `FOR EACH STATEMENT`. | **98 %** · mensajes −73 % | — | 0,11 GB · Free aguanta 67 negocios por mensajes (hoy 18) | Medio |
| 7 | **Panel del dueño**: no recargar Inventario cada 30 s (hacerlo a demanda o cada 5 min, y de forma incremental). Guardar los nombres de productos en caché en vez de bajarlos todos en cada recarga. | hasta −385 MB/día por panel abierto | — | — | Bajo |
| 8 | **Columnas**: ya se piden pocas columnas en stock y saldos. Lo que queda es usar ids más cortos o paginar por cursor. Es un ahorro menor (<5 %) y no vale la pena antes de 1 a 6. | — | < 5 % | — | — |

Notas:
- Con 1 a 3 (cambios chicos y locales en `stockService.js`, `customerLedgerSync.js` y `useNubeSync.js`, más un índice), el negocio típico pasa de 5,9 a ≈ 0,8 GB/mes. Con eso caben ≈ 6 negocios en Free y ≈ 300 en Pro por egress. El siguiente techo pasa a ser el de **mensajes Realtime** (arreglo 6).
- Si se une el PR #14 sin los arreglos 1 y 2, el costo por venta se duplica. Conviene unir el PR #14 junto con el arreglo 2: con el aviso aplicado ya no hace falta «una vuelta más».
- Ninguno de estos arreglos está implementado: esta tarea es solo una auditoría.

## 6. Limpieza

- Todos los datos de prueba llevaban el prefijo `egtest-` y se borraron con `scripts/nube/limpiar-egtest.sql`. El script apaga y vuelve a encender, dentro de una transacción, los disparadores que protegen los libros.
- Verificación: 0 filas `egtest-` en `account_records`, `stock_levels`, `stock_movements`, `customer_movements` y `customer_balances`. Los dos disparadores quedaron activos.
- Quedan solo las filas de aviso de `account_sync_state` (products y customers) de la cuenta de prueba, con su `changed_at` actualizado. Son inofensivas.
