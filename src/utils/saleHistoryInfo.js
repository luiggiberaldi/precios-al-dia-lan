/**
 * Datos de identificación de una venta para el historial: quién cobró, correlativo de la
 * nube y fecha con hora. Funciones puras (las usa SalesHistory y sus pruebas).
 */

/** Quién hizo la venta: lo guardado al cobrar, el vendedor remoto o quien la subió a la nube. */
export function saleSellerName(sale) {
    if (!sale) return null;
    return sale.vendedor || sale.remoteSale?.sellerName || sale._vendedor || null;
}

/** Correlativo de la cuenta en la nube (p. ej. «A-00001»), sin el «#». */
export function saleNubeNumber(sale) {
    const raw = sale?.nube?.number;
    if (!raw) return null;
    return String(raw).replace(/^#/, '');
}

/** «17/11/2026 · 02:11 p. m.» (fecha y hora locales de Venezuela). */
export function formatSaleDateTime(timestamp) {
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return '';
    const date = d.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
    return `${date} · ${time}`;
}
