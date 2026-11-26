/**
 * Enganche entre el cobro heredado (checkoutProcessor) y el cobro en el servidor (F3).
 * Sin la nube activa no hace nada y el cobro de Bodega sigue igual (baranda G9).
 */
import { saleItemsFromCart, toServerSale } from './stockService';

let submitter = null;
let voider = null;

/** Anulación en el servidor: fn(saleId, reason) → { ok, message }. */
export function setNubeVoider(fn) {
    voider = typeof fn === 'function' ? fn : null;
}

export function setNubeSaleSubmitter(s) {
    submitter = s || null;
}

export function isNubeCheckoutActive() {
    return submitter !== null;
}

function newId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/**
 * Llamar justo antes de guardar la venta en el equipo.
 * Devuelve null (nube apagada), { rejected: true, message } o { nube: {...} } para
 * guardar dentro de la venta (id de servidor, número #A-00001 o «pendiente de subir»).
 */
export async function nubeCommitSale({ sale, cart }) {
    if (!submitter) return null;
    const items = saleItemsFromCart(cart);
    if (!items.length) return null; // servicios sin inventario: nada que descontar
    const nubeId = sale.nubeId || newId();
    const result = await submitter.submit(toServerSale({ ...sale, nubeId }, items));
    if (!result.ok) return { rejected: true, message: result.message };
    return {
        nube: {
            saleId: nubeId,
            number: result.number ?? null,
            pending: Boolean(result.queued),
            shortages: result.shortages?.length ? result.shortages : undefined,
        },
    };
}

/**
 * Llamar antes de anular localmente. Devuelve null (nube apagada o venta sin servidor)
 * o { rejected: true, message } si el servidor no pudo anularla.
 * La anulación necesita internet: no se encola (nada se resuelve a ciegas, G10).
 */
export async function nubeVoidSale(sale, reason) {
    if (!voider || !sale?.nube?.saleId) return null;
    if (sale.nube.pending && submitter) await submitter.replay();
    const res = await voider(sale.nube.saleId, reason);
    return res?.ok ? null : { rejected: true, message: res?.message || 'No se pudo anular en el servidor' };
}
