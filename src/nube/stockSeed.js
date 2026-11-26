/**
 * Siembra del stock que el servidor nunca recibió (F3).
 *
 * Caso real: el dueño restaura un respaldo de Bodega con «Importar respaldo» de la app
 * (escribe directo en IndexedDB y recarga). Al arrancar, los productos suben como
 * registros, pero el registro no lleva stock (lo maneja el libro), y la escritura no pasó
 * por el vigilante. Resultado: la caja que importó ve su stock local y las demás ven 0.
 *
 * Arreglo: al leer los niveles, cada producto con stock local > 0 que en el servidor NO
 * tiene fila de nivel (nunca tuvo movimientos en esta sede) se carga como INICIAL.
 * El id sale de la cuenta, la sede y el producto: otra caja con el mismo respaldo, o un
 * reintento, no lo duplica (G7). Un producto que sí tiene nivel (aunque sea 0) no se
 * toca: ahí manda el servidor.
 *
 * Solo dueño o administrador mueven inventario; con un cajero no se intenta.
 */
import { stableUuid } from './importBackup';

const BATCH = 400;
export const SEED_ROLES = Object.freeze(['dueno', 'administrador']);

/** Movimientos INICIAL para los productos con stock local y sin nivel en el servidor. */
export async function missingStockMovements(products, levels, { accountId, sedeId, skip = new Set() }) {
    const movements = [];
    for (const p of Array.isArray(products) ? products : []) {
        if (p?.id === undefined || p?.id === null) continue;
        const id = String(p.id);
        if (id in levels || skip.has(id)) continue;
        const qty = Math.round(Number(p.stock) * 1000) / 1000;
        if (!(qty > 0)) continue;
        movements.push({
            id: await stableUuid(`${accountId}:${sedeId || 'principal'}:inicial-local:${id}`),
            product_id: id,
            qty,
            note: 'Stock inicial tomado de la copia local (respaldo restaurado en el equipo)',
        });
    }
    return movements;
}

/**
 * Sube como INICIAL el stock local que falta en el servidor. Devuelve cuántos movimientos
 * se mandaron (0 si no había nada o el rol no puede mover inventario).
 */
export async function seedMissingStock(client, { session, role, accountId, sedeId, products, levels, skip }) {
    if (!session || !accountId || !SEED_ROLES.includes(role)) return 0;
    const movements = await missingStockMovements(products, levels, { accountId, sedeId, skip });
    for (let i = 0; i < movements.length; i += BATCH) {
        const { error } = await client.rpc('process_stock_movements', {
            p_session: session, p_reason: 'INICIAL', p_movements: movements.slice(i, i + BATCH), p_reference: 'copia-local', p_sede_id: null,
        });
        if (error) throw new Error(error.message || 'No se pudo cargar el stock inicial');
    }
    return movements.length;
}
