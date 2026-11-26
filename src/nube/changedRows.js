/**
 * Lectura incremental de una tabla con `updated_at` (S5, auditoría de sync 2026-11-19).
 *
 * Baja solo las filas cambiadas desde `since`, paginando por (updated_at, clave): todo lo
 * que escribe una transacción comparte la MISMA hora (now()), así que cortar solo por hora
 * saltaría filas cuando un lote cae entre dos páginas (igual que recordSync).
 *
 * `updated_at` es la hora en que EMPEZÓ la transacción: una escritura lenta confirma filas
 * «del pasado». Quien llama vuelve a mirar un margen hacia atrás (`sinceWithOverlap`).
 */

export const CHANGES_OVERLAP_MS = 60_000;
const PAGE = 1000;

/** Cursor guardado → desde dónde volver a mirar (con margen). null = leer todo. */
export function sinceWithOverlap(cursor, overlapMs = CHANGES_OVERLAP_MS) {
    if (!cursor) return null;
    return new Date(Date.parse(cursor) - overlapMs).toISOString();
}

/**
 * @param {object} client  cliente Supabase
 * @param {string} table
 * @param {object} opts
 * @param {string} opts.select   columnas (debe incluir `updated_at` y la clave)
 * @param {string} opts.key      columna que desempata dentro de la misma hora
 * @param {string|null} opts.since  ISO; null = todo
 * @param {(q) => q} [opts.filter]  filtros extra (p. ej. la sede)
 * @returns {Promise<{ rows: object[], newest: string|null }>}
 */
export async function fetchChangedRows(client, table, { select, key, since = null, filter = (q) => q, page = PAGE }) {
    const rows = [];
    let cursor = since;
    let tie = null;
    for (;;) {
        let query = filter(client.from(table).select(select));
        if (tie !== null) query = query.eq('updated_at', cursor).gt(key, tie);
        else if (cursor) query = query.gt('updated_at', cursor);
        const { data, error } = await query.order('updated_at').order(key).limit(page);
        if (error) throw new Error(error.message || `No se pudo leer ${table}`);
        const list = data || [];
        rows.push(...list);
        const last = list[list.length - 1];
        if (tie !== null) {
            tie = list.length < page ? null : last[key]; // terminada esa hora: seguir con gt
            continue;
        }
        if (list.length < page) break;
        cursor = last.updated_at;
        tie = last[key];
    }
    const newest = rows.reduce((max, r) => (r.updated_at && (!max || r.updated_at > max) ? r.updated_at : max), null);
    return { rows, newest };
}
