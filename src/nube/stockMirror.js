/**
 * Espejo del stock del servidor en la caja (F3), incremental (S5 · auditoría 2026-11-19).
 *
 * Antes cada caja releía TODO `stock_levels` de su sede en cada aviso en vivo y cada
 * 60 s, incluida la caja que vendió. Ahora:
 *   · `refresh()` baja solo lo que cambió desde la última lectura (con margen); la
 *     primera de la sesión baja todo;
 *   · `applyRealtime(row)` escribe directo lo que trae el aviso en vivo (`payload.new`
 *     ya tiene product_id, qty y updated_at), sin leer nada.
 *
 * Se guarda en memoria TODO lo conocido y se aplica entero cada vez: si el nivel de un
 * producto llega antes que el producto (creado en otra caja y aún sin bajar), se aplica
 * cuando el producto aparezca, aunque ninguna lectura incremental lo vuelva a traer.
 */
import { fetchStockChanges, mergeKnownLevels, applyLevels } from './stockService.js';
import { sinceWithOverlap, CHANGES_OVERLAP_MS } from './changedRows.js';

/**
 * @param {object} deps
 * @param {object} deps.client
 * @param {string|null} deps.sedeId
 * @param {{ flush, pendingProducts, setBaseline }} deps.watcher  vigilante de ajustes de stock
 * @param {() => Promise<any[]>} deps.readProducts
 * @param {(products) => Promise<void>} deps.writeProducts  escribe SIN volver a subir
 * @param {() => Promise<void>} [deps.onServerContact]  p. ej. renovar el permiso sin internet
 * @param {number} [deps.overlapMs]  margen hacia atrás de cada lectura (ver changedRows.js)
 */
export function createStockMirror({
    client,
    sedeId,
    watcher,
    readProducts,
    writeProducts,
    withLocalLock = (fn) => fn(),
    onServerContact = async () => {},
    overlapMs = CHANGES_OVERLAP_MS,
}) {
    const known = {}; // product_id → { qty, at }
    let cursor = null;
    let chain = Promise.resolve();
    // Leer-aplicar-escribir la copia local va en turno: un aviso y una lectura a la vez
    // no se pisan.
    const serial = (fn) => {
        const run = chain.then(fn);
        chain = run.catch(() => {});
        return run;
    };

    async function applyKnown() {
        const pending = await watcher.pendingProducts();
        const levels = {};
        for (const [id, lv] of Object.entries(known)) levels[id] = lv.qty;
        for (const id of pending) delete levels[id]; // no pisar ajustes sin subir
        return withLocalLock(async () => {
            const local = await readProducts();
            const { products, changed } = applyLevels(local, levels);
            if (changed) await writeProducts(products);
            // El «último stock conocido» es el del servidor (o el de un ajuste que aún sube).
            // Un stock local que el servidor no tiene NO se da por conocido: si no, el
            // vigilante nunca lo subiría y las otras cajas lo verían en 0.
            await watcher.setBaseline(products, { only: new Set([...Object.keys(levels), ...pending]) });
            return changed;
        });
    }

    let busy = null;
    let again = false;
    /** Baja lo cambiado y lo aplica. Las llamadas que llegan mientras otra lee se suman a UNA vuelta extra. */
    function refresh() {
        if (busy) { again = true; return busy; }
        busy = (async () => {
            try {
                do {
                    again = false;
                    await watcher.flush();
                    const { levels, newest } = await fetchStockChanges(client, sedeId, sinceWithOverlap(cursor, overlapMs));
                    await onServerContact();
                    mergeKnownLevels(known, levels);
                    if (newest && (!cursor || newest > cursor)) cursor = newest;
                    await serial(applyKnown);
                } while (again);
            } finally {
                busy = null;
            }
        })();
        return busy;
    }

    /** Aviso en vivo de `stock_levels`. Devuelve false si no sirve (y hay que leer). */
    function applyRealtime(row) {
        if (!row || row.product_id === undefined || row.product_id === null || row.qty === undefined || row.qty === null) return false;
        if (sedeId && row.sede_id && row.sede_id !== sedeId) return true; // de otra sede: no es nuestro
        if (!cursor) return false; // aún sin la primera lectura completa
        mergeKnownLevels(known, { [String(row.product_id)]: { qty: Number(row.qty), at: row.updated_at ?? null } });
        serial(applyKnown).catch((e) => console.warn('[nube] no se pudo aplicar el stock en vivo', e?.message || e));
        return true;
    }

    return {
        refresh,
        applyRealtime,
        applyKnown: () => serial(applyKnown),
        known: () => ({ ...known }),
        cursor: () => cursor,
        idle: () => chain,
    };
}
