/**
 * Importar a la nube el respaldo de Precios al Día (Bodega) — decisión D10.
 *
 * Toma el archivo de «Exportar respaldo» (formato 2.0 o legado), saca productos,
 * clientes, proveedores, métodos de pago y categorías, y los sube a la cuenta con la
 * sesión del DUEÑO (push_records sin PIN). Reintentar no duplica (cada registro
 * conserva su id, G7).
 *
 * El stock de cada producto entra como CONTEO del libro (F3): la nube queda con el stock
 * del respaldo. El id sale de la cuenta, la sede, el respaldo y el producto: importar otra
 * vez el mismo respaldo no duplica.
 * Las deudas y saldos a favor entran como SALDO_INICIAL_MIGRADO del libro de clientes
 * (F4), también con id estable. Las ventas viejas se quedan en el respaldo.
 */
import { validateBackupJson } from '../utils/backupRestoreService';
import { SYNCED_KEYS, toRecords, MAX_RECORD_ID, MAX_RECORD_BYTES, utf8ByteLength } from './recordSync';
import { toNubeError } from './accountService';

const BATCH = 400;

/** Datos de la app dentro del respaldo (2.0: data.idb; legado: data). */
export function backupData(json) {
    validateBackupJson(json);
    const idb = json?.data?.idb && typeof json.data.idb === 'object' ? json.data.idb : json.data;
    return idb || {};
}

/** Qué se importaría, sin subir nada: [{ key, collection, count }]. */
export function previewImport(json) {
    const data = backupData(json);
    return Object.keys(SYNCED_KEYS)
        .filter((key) => data[key] != null)
        .map((key) => ({ key, collection: SYNCED_KEYS[key].collection, count: toRecords(key, data[key]).length }));
}

/**
 * Sube el respaldo a la cuenta del dueño. `onProgress({ collection, done, total })`.
 * Devuelve { [collection]: cantidad }. Con `session` (PIN del dueño) sube desde el equipo.
 * `exclude`: claves que no se suben (p. ej. la caja, que el equipo sube con su propio id).
 */
export async function importBackupToCloud(ownerClient, json, { onProgress = () => {}, session = null, exclude = [] } = {}) {
    const data = backupData(json);
    const result = {};
    for (const key of Object.keys(SYNCED_KEYS)) {
        if (data[key] == null || exclude.includes(key)) continue;
        const { collection } = SYNCED_KEYS[key];
        const records = toRecords(key, data[key]).filter((rec) => {
            if (!rec?.id || rec.id.length > MAX_RECORD_ID) return false;
            return utf8ByteLength(rec.data) <= MAX_RECORD_BYTES;
        });
        let done = 0;
        for (let i = 0; i < records.length; i += BATCH) {
            const batch = records.slice(i, i + BATCH).map(({ id, data: d }) => ({ id, data: d, deleted: false }));
            let { error } = await ownerClient.rpc('push_records_v2', { p_session: session, p_collection: collection, p_records: batch });
            if (error && (error.code === 'PGRST202' || error.code === '42883')) {
                ({ error } = await ownerClient.rpc('push_records', { p_session: session, p_collection: collection, p_records: batch }));
            }
            if (error) throw toNubeError(error);
            done += batch.length;
            onProgress({ collection, done, total: records.length });
        }
        result[collection] = (result[collection] || 0) + done;
    }
    return result;
}

/** UUID estable (formato v5) a partir de un texto, con SHA-1. */
export async function stableUuid(text) {
    const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))).slice(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Marca del respaldo para los ids: otro respaldo corrige, el mismo no duplica. */
export function backupStamp(json) {
    return String(json?.timestamp || json?.exportedAt || json?.date || 'sin-fecha');
}

/**
 * Deja el stock de la nube IGUAL al del respaldo (CONTEO: el servidor registra la
 * diferencia contra el nivel actual). Incluye los productos en 0, para que un nivel viejo
 * no sobreviva a la restauración. Id estable por cuenta, sede, respaldo y producto:
 * reintentar el mismo respaldo no duplica; restaurar otro sí corrige.
 * Devuelve cuántos productos se contaron.
 */
export async function importInitialStock(ownerClient, json, { accountId, sedeId = null, session = null } = {}) {
    if (!accountId) throw new Error('Falta la cuenta para importar el stock');
    const products = backupData(json).bodega_products_v1;
    if (!Array.isArray(products)) return 0;
    const stamp = backupStamp(json);
    const movements = [];
    for (const p of products) {
        if (p?.id === undefined || p?.id === null || String(p.id) === '') continue;
        const raw = Number(p?.stock);
        const qty = Number.isFinite(raw) && raw > 0 ? Math.round(raw * 1000) / 1000 : 0;
        movements.push({
            id: await stableUuid(`${accountId}:${sedeId || 'principal'}:conteo:${stamp}:${p.id}`),
            product_id: String(p.id), qty, note: 'Stock del respaldo restaurado',
        });
    }
    let done = 0;
    for (let i = 0; i < movements.length; i += BATCH) {
        const batch = movements.slice(i, i + BATCH);
        const { error } = await ownerClient.rpc('process_stock_movements', {
            p_session: session, p_reason: 'CONTEO', p_movements: batch, p_reference: 'importacion', p_sede_id: sedeId,
        });
        if (error) throw toNubeError(error);
        done += batch.length;
    }
    return done;
}

/** ¿El respaldo trae el libro de clientes? (entonces los saldos suben por el libro). */
export function backupHasLedger(json) {
    const ledger = backupData(json).bodega_customer_ledger_v1;
    return Array.isArray(ledger) && ledger.length > 0;
}

/**
 * Carga deudas y saldos a favor de los clientes del respaldo como SALDO_INICIAL_MIGRADO
 * (CREDIT si tiene saldo a favor, DEBIT si debe). Reimportar no duplica (id estable).
 */
export async function importInitialBalances(ownerClient, json, { accountId, session = null } = {}) {
    if (!accountId) throw new Error('Falta la cuenta para importar los saldos');
    const customers = backupData(json).bodega_customers_v1;
    if (!Array.isArray(customers)) return 0;
    const stamp = backupStamp(json);
    const { data: existingRows } = await ownerClient.from('customer_balances').select('customer_id, balance_usd');
    const currentByCust = new Map((existingRows || []).map((r) => [String(r.customer_id), Number(r.balance_usd) || 0]));
    const movements = [];
    for (const c of customers) {
        if (c?.id === undefined) continue;
        const cid = String(c.id);
        const target = Math.round(((Number(c.favor) || 0) - (Number(c.deuda) || 0)) * 100) / 100;
        const hasPrev = currentByCust.has(cid);
        const current = currentByCust.get(cid) || 0;
        const delta = Math.round((target - current) * 100) / 100;
        if (delta === 0) continue;
        const isFirst = !hasPrev;
        movements.push({
            id: await stableUuid(isFirst ? `${accountId}:saldo-inicial:${cid}` : `${accountId}:saldo-restore:${stamp}:${cid}`),
            customer_id: cid,
            type: isFirst ? 'SALDO_INICIAL_MIGRADO' : (delta > 0 ? 'AJUSTE_CREDITO' : 'AJUSTE_DEBITO'),
            direction: delta > 0 ? 'CREDIT' : 'DEBIT',
            amount_usd: Math.abs(delta),
            source_type: isFirst ? 'MIGRATION' : 'RESTORE',
            source_id: isFirst ? `backup:${cid}` : `restore:${stamp}:${cid}`,
            reason: isFirst ? 'Saldo importado del respaldo de Precios al Día' : 'Ajuste de saldo desde respaldo restaurado',
        });
    }
    let done = 0;
    for (let i = 0; i < movements.length; i += BATCH) {
        const batch = movements.slice(i, i + BATCH);
        const { error } = await ownerClient.rpc('push_customer_movements', { p_session: session, p_movements: batch });
        if (error) throw toNubeError(error);
        done += batch.length;
    }
    return done;
}
