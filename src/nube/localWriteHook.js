/**
 * Enganche entre storageService (heredado) y el sincronizador de la nube.
 *
 * storageService no conoce a la nube: solo pregunta aquí si hay un manejador activo.
 * Mientras la puerta de la nube no lo instale (o con la nube apagada), todo sigue
 * igual que en Bodega. Un solo desvío corto en el archivo heredado (baranda G9).
 */
let handler = null;

export function setNubeLocalWriteHandler(fn) {
    handler = typeof fn === 'function' ? fn : null;
}

/** ¿La nube se encarga de sincronizar? (si sí, no se usa el sincronizador viejo). */
export function isNubeSyncActive() {
    return handler !== null;
}

// Escrituras avisadas que aún se están encolando (para poder esperarlas).
const inFlight = new Set();

/** Avisa de una escritura local. Nunca lanza: un error de red no rompe el guardado local. */
export function notifyNubeLocalWrite(key, value) {
    if (!handler) return false;
    try {
        const job = Promise.resolve(handler(key, value)).catch((e) => console.warn('[nube] no se pudo encolar', key, e?.message || e));
        inFlight.add(job);
        job.finally(() => inFlight.delete(job));
    } catch (e) {
        console.warn('[nube] no se pudo encolar', key, e?.message || e);
    }
    return true;
}

// ─── Subir el stock YA (ajuste confirmado en Inventario) ─────────────────────
// La puerta de la nube instala aquí quién sube los ajustes de stock en cola:
// fn() → { ok, message?, queued? }.
let stockFlusher = null;

export function setNubeStockFlusher(fn) {
    stockFlusher = typeof fn === 'function' ? fn : null;
}

// ─── Ajustar baseline de stock tras venta/anulación (C1) ─────────────────────
let stockBaselineAdjuster = null;

export function setNubeStockBaselineAdjuster(fn) {
    stockBaselineAdjuster = typeof fn === 'function' ? fn : null;
}

/**
 * Actualiza el baseline local de stockWatcher tras una escritura con `skipSyncPush: true`
 * (venta o anulación) para impedir doble deducción/restauración. Nunca lanza.
 */
export async function adjustNubeStockBaseline(deltas) {
    if (!stockBaselineAdjuster || !deltas) return false;
    try {
        await stockBaselineAdjuster(deltas);
        return true;
    } catch (e) {
        console.warn('[nube] no se pudo ajustar el baseline de stock', e?.message || e);
        return false;
    }
}

// ─── Encolar conteo físico explícito (CONTEO objetivo en servidor) ───────────
let stockCountSubmitter = null;

export function setNubeStockCountSubmitter(fn) {
    stockCountSubmitter = typeof fn === 'function' ? fn : null;
}

export async function submitNubeStockCount(productId, targetQty, note) {
    if (!stockCountSubmitter) return false;
    try {
        await stockCountSubmitter(productId, targetQty, note);
        return true;
    } catch (e) {
        console.warn('[nube] no se pudo encolar conteo físico', e?.message || e);
        return false;
    }
}

/**
 * Espera a que las escrituras ya avisadas se encolen y sube los ajustes de stock al
 * momento. null con la nube apagada (Bodega sigue igual). Nunca lanza.
 */
export async function flushNubeStockNow() {
    if (!stockFlusher) return null;
    await Promise.all([...inFlight]);
    try {
        return (await stockFlusher()) || { ok: true };
    } catch (e) {
        return { ok: false, message: e?.message || String(e) };
    }
}

// ─── Restaurar un respaldo con la nube activa ────────────────────────────────
// Ajustes → Importar respaldo escribe directo en el equipo. Con la nube activa eso no
// basta: el stock y los saldos viajan por sus libros, no dentro de los productos. La
// puerta de la nube instala aquí quién sube el respaldo: { check(), upload(json, opts) }.
let backupRestorer = null;

export function setNubeBackupRestorer(restorer) {
    backupRestorer = restorer && typeof restorer.upload === 'function' ? restorer : null;
}

/** null con la nube apagada (la restauración sigue igual que en Bodega). */
export function getNubeBackupRestorer() {
    return backupRestorer;
}
