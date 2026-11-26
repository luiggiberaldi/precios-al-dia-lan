# Auditoría · Sincronización entre dispositivos de Precios al Día Nube (2026-11-19)

**Alcance:** `src/nube/` (rama `nube/fix-entrada-pin`, 3 commits por delante de `main`; el motor de sincronización es idéntico en las dos) y la base `nube-pruebas` (`hfuzyauiefhllohonvim`): funciones, disparadores, RLS y Realtime.
**Método:** lectura de código y SQL en vivo, más una prueba de reproducción contra el SQL real (arnés PGlite de `tests/nube/sql`).
**Ya cubierto antes, y no se repite aquí:** auditoría de sync del 16-nov (`337d908`, en `main`: paginación, borrados fantasma, carreras) y auditoría de egress (`AUDITORIA-EGRESS-2026-11-16.md`).

## Cómo sincroniza hoy

| Vía | Qué viaja | Sube | Baja | Conflictos |
|---|---|---|---|---|
| Registros (`recordSync.js` → `push_records`) | productos, clientes, proveedores, métodos de pago, categorías, tasa | registro entero si cambió su hash | solo lo cambiado desde el cursor (`updated_at`, `id`) | **gana el último, registro entero** |
| Caja (`cash`) | turno de cada caja | cada caja lo suyo | nadie (solo el dueño lo consulta) | no hay: cada registro es de una caja |
| Cobro (`stockService.js` → `process_checkout`) | ventas | en el momento; sin internet, a una cola | — | el servidor decide el stock |
| Stock | niveles por sede | ajustes vía `stockWatcher` | **toda la tabla de la sede** | libro de solo agregar (bien) |
| Cartera (`customerLedgerSync.js`) | fiados, abonos, saldos | movimientos por id | movimientos nuevos + **todos los saldos** | saldo oficial del servidor (bien) |
| Avisos | `account_sync_state`, `stock_levels`, `customer_balances` por Realtime | — | canal que se reabre solo + sondeo cada 60 s (tasa: 10 s si el canal cae) | — |

**Lo que está bien hecho y hay que conservar:** el stock y los saldos son libros de solo agregar, calculados en el servidor, así que dos cajas nunca discrepan en stock ni en deuda. Las colas nunca se vacían solas (G10). Reenviar no duplica (G7). Los canales se reabren solos. El permiso de 72 h sin internet. Los turnos por colección y la paginación ya se arreglaron. Toda la lectura está aislada por cuenta (RLS `my_account_id()`).

---

## Hallazgos

### ✅ S1 · Una caja puede quedarse mostrando datos distintos de la nube, para siempre (CONFIRMADO · ARREGLADO)
`recordSync.js:323-348` (`applyPulled`) + `:252-262` (`flushCollection`)

**Reproducción** (prueba contra el SQL real, borrada después para no dejar un test en rojo):
1. A y B tienen «Harina, $1».
2. B cambia el precio a $2, pero no puede subirlo (sin internet o sin sesión). Queda en su cola.
3. A cambia el nombre a «Harina PAN» y lo sube.
4. B baja el cambio de A: su pantalla pasa a «Harina PAN, $1», **pero su cola conserva «Harina, $2»**.
5. B recupera la conexión y sube la cola. La nube queda en «Harina, $2» y A también lo recibe.
6. B vuelve a bajar: la versión ya «la conoce» (es la suya), así que no la aplica.

**Resultado:** nube = «Harina, $2» · Caja A = «Harina, $2» · **Caja B = «Harina PAN, $1»**. Además se perdió el cambio de nombre de A.

**Por qué:** al bajar, se pisa la copia local aunque ese registro tenga un cambio local sin subir, y la cola sigue enviando la versión vieja. Después de subir, la caja guarda como «conocida» la versión que ella mandó, pero su pantalla muestra otra cosa.

**Impacto:** precios distintos según la caja que cobre. En Venezuela, con cambios de precio frecuentes y conexiones que se caen, es muy probable.

**Arreglado (2026-11-19):** `applyPulled` ya no pisa en pantalla un registro con un cambio local sin subir, si el empleado puede subir esa colección (`canPush`, misma regla que `push_records`). Tests nuevos en `syncAudit.test.js` («Sin internet · cada caja termina igual que la nube»): cambio + cambio, alta + edición, borrado + edición, y cajero sin permiso; sin el arreglo, 2 de ellos fallan.

**Propuesta original:** en `applyPulled`, si un registro bajado tiene un cambio local pendiente en la cola, **no pisar la copia local** con lo bajado. La cola sube después lo local, y la caja queda igual que la nube. Eso convierte el caso en «gana el último» de forma coherente (como S2), sin divergencia. Hace falta un test nuevo en `syncAudit.test.js`.

### ✅ S2 · Dos cajas que editan el mismo registro: gana la última y el resto se pierde sin aviso (ARREGLADO)
`push_records` (en la base): `on conflict … do update set data = excluded.data, version = r.version + 1`. No compara con la versión de la que partió la caja.

Ya está documentado como abierto (`syncAudit.test.js:163`, `it.fails`). Sigue sin arreglarse.

**Arreglado (2026-11-19, migración 016):** cada caja manda la `base_version` de la que partió su cambio (la de la primera edición si se acumulan varias sin internet). Si la nube va por una versión más nueva, `push_records` funde por campo con la versión base, que la nube guarda 7 días en `account_record_history`: los campos que cambió la caja ganan y los demás se conservan. Si las dos cambian el mismo campo, gana la última. La respuesta trae `merged` y lo fundido, y la caja lo muestra enseguida. Cajas viejas o base vencida: gana la última entera, como antes. Tests en `syncAudit.test.js`; el `it.fails` pasó a `it`.

**Propuesta original:** que `push_records` reciba `base_version` por registro. Si la del servidor es mayor, fusionar por campo (el `mergeCatalog3Way` de `utils/catalogLock.js` ya existe en el cliente) o devolver el conflicto para que la caja fusione y reintente. Con S1 arreglado, S2 deja de causar divergencia; solo pierde ediciones simultáneas.

### ✅ S3 · Una venta atascada en la cola deja la caja «sin internet» indefinidamente (ARREGLADO)
`stockService.js:139-152` (`submit`) y `:160-182` (`replay`)

- `replay` se detiene en el primer error y lo reintenta en cada vuelta. Si el servidor rechaza esa venta por algo que no sea la red (por ejemplo, datos inválidos o un equipo dado de baja), nunca sale de la cola.
- Mientras la cola tenga algo, **toda venta nueva se encola** sin consultar el stock del servidor (`submit` mira primero la cola). La caja sigue vendiendo como si no tuviera internet, sin control de stock, hasta que se venzan las 72 h y deje de vender.

**Arreglado (2026-11-19):** `isDefinitiveRejection` (solo errores de datos, clases 22/23). Esas ventas se apartan a `pdn_sale_rejected_v1` (nunca se borran) y la cola sigue. Red, sesión vencida o servidor caído siguen reintentándose. En la caja aparece «N venta(s) con problema · reintentar». Tests en `stockService.test.js` (S3).

**Propuesta original:** distinguir errores de red de rechazos definitivos. Un rechazo definitivo pasa a una lista de «ventas con problema», visible para el dueño, y la cola sigue con las demás.

### ✅ S4 · Un cajero puede borrar clientes de todas las cajas (ARREGLADO)
`push_records` exige dueño o administrador para todo **menos** `customers` y `cash`, y no distingue alta de borrado. Si un cajero elimina un cliente en su caja, desaparece en todas, aunque tenga deuda. El saldo sigue en `customer_balances`, pero el cliente ya no se ve.

La app ya ocultaba el botón al cajero, pero el borrado también llega sin querer: guardar una lista vieja borra lo que falte.

**Arreglado (2026-11-19, migración 016):** `push_records` no aplica el borrado de un cliente si quien lo pide no es dueño ni administrador. Republica el registro (versión nueva) y lo marca como `rejected`; la caja lo vuelve a bajar y avisa «Solo el dueño o un administrador pueden borrar clientes». Sigue pendiente, como opción, rechazar en el servidor el borrado de un cliente con saldo (la app ya lo impide en pantalla).

### ✅ S5 · Coste por venta: cada caja relee todo el stock y todos los saldos (ARREGLADO)
Ya medido en `AUDITORIA-EGRESS-2026-11-16.md` (recomendaciones 1 y 2: stock incremental y aplicar el aviso de Realtime). **Siguen sin implementar**: `fetchStockLevels` no tiene cursor y `useNubeSync` relee todo en cada aviso de `stock_levels`, incluida la caja que vendió. Con varias cajas y miles de productos es lo primero que agotará el plan gratuito.

**Arreglado (2026-11-19):** recomendaciones 1 a 4 de la auditoría de egress. Stock y saldos se leen solo desde lo último visto (`changedRows.js`, margen de 60 s, desempate por clave; índices en la migración 017). El aviso en vivo de `stock_levels` se aplica sin releer (`stockMirror.js`). Cada caja guarda en memoria todo lo conocido y lo aplica entero, así el stock o saldo que llega antes que su producto o cliente se aplica cuando este aparece. Con los tres canales en vivo arriba, la relectura de la nube pasa de cada 60 s a cada 5 min (las colas locales siguen cada 60 s). Tests en `egressIncremental.test.js`.

### ✅ S6 · Un aviso por fila (ARREGLADO)
El disparador `account_records_touch` es `FOR EACH ROW`: subir 200 registros genera 200 avisos por caja. El cliente ya los agrupa en una sola bajada (bien), pero los mensajes de Realtime cuentan para la cuota. Además, el registro `cash` de cada venta avisa a todas las cajas, aunque ninguna lo baja.

**Arreglado (2026-11-19, migración 017):** dentro de una transacción solo la primera fila cambia `changed_at` (las demás no escriben, así que no hay mensaje): un aviso por colección y subida. `cash` ya no avisa. Medido en el test: 50 productos → 1 aviso (antes 50); registro de caja → 0 (antes 1). Sigue habiendo un mensaje por producto vendido en `stock_levels`, pero ahora ese mensaje trae el dato y se aplica sin releer.

### 🟡 S7 · Tasa automática por equipo
En modo BCV/euro/USDT, cada caja consulta la tasa por su cuenta. Durante unos minutos tras un cambio de tasa, dos cajas pueden cobrar con tasas distintas. Cada venta guarda su tasa, así que no hay error contable, pero sí diferencias visibles para el cliente.

**Opción:** que la caja del dueño o el servidor publique la tasa automática en `pdn_rate_v1`, como ya se hace con la manual.

### Ya documentado como abierto (no se repite)
- Movimiento de cartera con un `seq` menor que el cursor que nunca baja (`syncAudit.test.js:181`, `it.fails`).

---

## Prioridad sugerida
1. ~~S1~~ ✅, ~~S2~~ ✅, ~~S3~~ ✅, ~~S4~~ ✅, ~~S5~~ ✅ y ~~S6~~ ✅ (2026-11-19).
2. ~~S5 + S6~~ (egress y mensajes): antes de tener varios negocios reales.
3. **S7**.
