/**
 * Historial de ventas de TODAS las cajas de la cuenta (solo dueño y administrador).
 *
 * Cada caja sube su turno a la colección `cash` de account_records (id `venta@equipo`,
 * aligerado: sin stockEffects y con los productos en id/nombre/cantidad/precio); el servidor
 * anota en `updated_by_device` qué caja lo subió. Ahí está
 * tanto el historial que trajo un respaldo restaurado como cada venta nueva, así que basta
 * esta fuente. Solo lectura: anular o reciclar se hace en la caja que vendió.
 *
 * Barandas: G12 (por páginas de 1000, sin bajar todo de una; solo `cash` sin borrar).
 */

const PAGE = 1000;
const MAX_PAGES = 20; // tope de 20 000 registros (el sincronizador solo sube 120 días)

/**
 * La colección `cash` guarda todo el movimiento de cada caja, no solo ventas. Los ajustes
 * de stock del Inventario (total 0), las aperturas y los cierres no son transacciones del
 * historial de ventas: si pasan, se ven como «Consumidor Final · $0.00». El Inicio sí los
 * necesita (efectivo del turno), por eso se filtran solo al armar el historial.
 */
const NOT_HISTORY_TYPES = new Set([
    'AJUSTE_ENTRADA', 'AJUSTE_SALIDA', 'INVENTORY_MOVEMENT',
    'APERTURA_CAJA', 'APORTE_CAJA', 'REGISTRO_CIERRE',
]);

/** ¿Este registro de `cash` va en el historial de ventas? */
export function isSalesHistoryRecord(record) {
    return Boolean(record) && !NOT_HISTORY_TYPES.has(record.tipo);
}

/** El historial sin ajustes de inventario ni aperturas/cierres de caja. */
export function onlySalesHistory(list) {
    return (Array.isArray(list) ? list : []).filter(isSalesHistoryRecord);
}

/** `venta@equipo` → { saleId, deviceId }. Sin `@` (importación del dueño) no hay equipo. */
export function splitCashId(id) {
    const text = String(id ?? '');
    const at = text.lastIndexOf('@');
    return at > 0 ? { saleId: text.slice(0, at), deviceId: text.slice(at + 1) } : { saleId: text, deviceId: null };
}

/** El registro aligerado tiene que verse como una venta local (sin romper la lista). */
export function toHistorySale(row, cajaByDevice = {}, memberNames = {}) {
    const split = splitCashId(row.id);
    const saleId = split.saleId;
    // La caja que lo subió la guarda el servidor; el sufijo del id es el respaldo.
    const deviceId = row.updated_by_device || split.deviceId;
    const data = row.data && typeof row.data === 'object' ? row.data : {};
    return {
        ...data,
        id: data.id ?? saleId,
        items: Array.isArray(data.items)
            ? data.items.map((i) => ({ ...i, qty: Number(i?.qty) || 0, priceUsd: Number(i?.priceUsd) || 0 }))
            : data.items,
        _nubeRecordId: row.id,
        _deviceId: deviceId,
        _caja: deviceId ? (cajaByDevice[deviceId] || null) : null,
        // Quién la subió (PIN de la nube). Sirve de vendedor para las ventas viejas que no
        // lo traen dentro; en una venta anulada después puede ser quien la anuló.
        _vendedor: (row.updated_by_member && memberNames[row.updated_by_member]) || null,
    };
}

/**
 * Junta y ordena (más reciente primero). Una misma venta puede estar con y sin equipo
 * (importación del dueño + caja que la sube): se queda la que dice de qué caja es.
 */
export function mergeCajasSales(rows, cajaByDevice = {}, memberNames = {}) {
    const byId = new Map();
    for (const row of rows) {
        if (!row || row.deleted_at) continue;
        const sale = toHistorySale(row, cajaByDevice, memberNames);
        const key = String(sale.id);
        const prev = byId.get(key);
        if (!prev || (!prev._deviceId && sale._deviceId)) byId.set(key, sale);
    }
    return [...byId.values()].sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
}

async function readCajaLetters(client) {
    const { data, error } = await client.from('account_devices').select('id, caja_letter');
    if (error) return {};
    return Object.fromEntries((data || []).filter((d) => d.caja_letter).map((d) => [d.id, d.caja_letter]));
}

/** Nombre de cada miembro del equipo (account_members.display_name). */
async function readMemberNames(client) {
    const { data, error } = await client.from('account_members').select('id, display_name');
    if (error) return {};
    return Object.fromEntries((data || []).filter((m) => m.display_name).map((m) => [m.id, m.display_name]));
}

/** Baja el historial de todas las cajas (RLS: solo la cuenta propia). */
export async function loadAllCajasSales(client) {
    const rows = [];
    let last = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
        let query = client.from('account_records').select('id, data, deleted_at, updated_by_device, updated_by_member').eq('collection', 'cash').is('deleted_at', null);
        if (last !== null) query = query.gt('id', last);
        const { data, error } = await query.order('id').limit(PAGE);
        if (error) throw new Error(error.message || 'No se pudo leer el historial de las cajas');
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
        last = data[data.length - 1].id;
    }
    const [letters, members] = await Promise.all([readCajaLetters(client), readMemberNames(client)]);
    return mergeCajasSales(rows, letters, members);
}
