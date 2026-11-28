/**
 * payrollReceipt.js — Recibo de nómina y mercancía al personal (ticket térmico y PDF).
 *
 * Usa la misma línea visual, ancho de papel (58mm/80mm) y encabezado con logo/datos
 * del negocio que el ticket de venta (`ticketHtmlTemplate.js`), agregando bloque de
 * trazabilidad y respaldo ante malentendidos (registrado por, autorizado por, origen,
 * saldo anterior/restante y firma de recibido conforme).
 *
 * `buildPayrollReceiptData` es puro (fácil de probar); imprimir y bajar el PDF usan el navegador.
 *
 * @module utils/payrollReceipt
 */

import { escapeHtml, openPrintWindow } from './printerUtils';
import { formatBs, formatUsd } from './calculatorUtils';
import { mulR } from './dinero';
import { ENTRY_TYPE_LABELS, FRECUENCIA_LABELS, GOODS_TYPE, GOODS_VALUATION_LABELS, periodLabel } from './payrollModel';
import { getPaymentLabel } from '../config/paymentMethods';
import { getLogoSrc } from './brandLogo';
import { getRoleLabel } from '../security/permissions';

function businessSettings() {
    const get = (k, d = '') => {
        try { return localStorage.getItem(k) || d; } catch { return d; }
    };
    return {
        name: get('business_name', 'Bodega'),
        rif: get('business_rif'),
        address: get('business_address'),
        phone: get('business_phone'),
        instagram: get('business_instagram'),
        logoSrc: getLogoSrc(),
    };
}

/**
 * Datos del recibo, ya estructurados y listos para imprimir o exportar PDF.
 * `saldoDespuesUsd` es el saldo del periodo después del movimiento.
 */
export function buildPayrollReceiptData({ entry, employee, saldoDespuesUsd, business = businessSettings(), methodLabel }) {
    const fecha = new Date(entry.timestamp);
    const isGoods = entry.tipo === GOODS_TYPE;
    const tasa = Number(entry.tasa) || 0;
    const rows = [
        ['Empleado', employee?.nombre || entry.employeeName || '—'],
        ...(employee?.cedula ? [['Cédula', employee.cedula]] : []),
        ...(employee?.cargo ? [['Cargo', employee.cargo]] : []),
        ['Frecuencia', FRECUENCIA_LABELS[employee?.frecuencia] || '—'],
        ['Periodo', periodLabel(entry.periodoId)],
        ['Concepto', ENTRY_TYPE_LABELS[entry.tipo] || entry.tipo],
    ];
    if (entry.metodoId) rows.push(['Forma de pago', methodLabel || getPaymentLabel(entry.metodoId) || entry.metodoId]);

    const items = [];
    if (isGoods && Array.isArray(entry.items)) {
        rows.push(['Precio', GOODS_VALUATION_LABELS[entry.valoracion] || 'Precio de venta']);
        for (const i of entry.items) {
            const qty = Number(i.qty) || 1;
            const subtotalUsd = Number(i.subtotalUsd) || 0;
            const unitUsd = Number(i.unitUsd) || (qty > 0 ? subtotalUsd / qty : subtotalUsd);
            const subtotalBs = tasa > 0 ? mulR(subtotalUsd, tasa) : 0;
            const unitBs = tasa > 0 ? mulR(unitUsd, tasa) : 0;
            const presSuffix = i.presentationName ? ` (${i.presentationName})` : '';
            items.push({
                name: `${i.name}${presSuffix}`,
                qty,
                unitUsd,
                unitBs,
                subtotalUsd,
                subtotalBs,
            });
            rows.push([`${qty} × ${i.name}${presSuffix}`, `$${formatUsd(subtotalUsd)}`]);
        }
    }

    const montoPrincipal = entry.moneda === 'BS' ? `Bs ${formatBs(entry.montoBs)}` : `$${formatUsd(entry.montoUsd)}`;
    const montoSecundario = entry.moneda === 'BS'
        ? `Equivale a $${formatUsd(entry.montoUsd)} (tasa ${entry.tasa})`
        : (tasa > 0 ? `Equivale a Bs ${formatBs(entry.montoBs)} (tasa ${tasa})` : '');

    const hasSaldoAntes = entry.saldoAntesUsd !== undefined && entry.saldoAntesUsd !== null && Number.isFinite(Number(entry.saldoAntesUsd));
    const saldoAntesUsd = hasSaldoAntes ? Number(entry.saldoAntesUsd) : null;
    const saldoRestanteUsd = Math.max(0, Number(saldoDespuesUsd) || 0);
    const excedenteUsd = hasSaldoAntes && (Number(entry.montoUsd) || 0) > saldoAntesUsd
        ? Math.max(0, (Number(entry.montoUsd) || 0) - saldoAntesUsd)
        : 0;

    const sourceLabel = entry.source === 'CAJA'
        ? 'Caja (Punto de Venta)'
        : (entry.source === 'NOMINA' ? 'Módulo de Nómina' : '');
    const actorRolLabel = entry.actorRol ? getRoleLabel(entry.actorRol) : '';
    const authorizedBy = entry.authorizedBy || entry.actor || 'Administrador';
    const authorizedByRolLabel = entry.authorizedByRol ? getRoleLabel(entry.authorizedByRol) : '';

    return {
        business: {
            logoSrc: business?.logoSrc ?? getLogoSrc(),
            ...business,
        },
        isGoods,
        titulo: `Recibo de ${(ENTRY_TYPE_LABELS[entry.tipo] || 'nómina').toLowerCase()}`,
        numero: String(entry.id).slice(-8).toUpperCase(),
        fecha: fecha.toLocaleString('es-VE', { timeZone: 'America/Caracas', dateStyle: 'short', timeStyle: 'short' }),
        employeeName: employee?.nombre || entry.employeeName || '—',
        employeeCedula: employee?.cedula || '',
        employeeCargo: employee?.cargo || '',
        periodoLabel: periodLabel(entry.periodoId),
        frecuenciaLabel: FRECUENCIA_LABELS[employee?.frecuencia] || '—',
        conceptoLabel: ENTRY_TYPE_LABELS[entry.tipo] || entry.tipo,
        valuationLabel: isGoods ? (GOODS_VALUATION_LABELS[entry.valoracion] || 'Precio de venta') : '',
        methodLabel: entry.metodoId ? (methodLabel || getPaymentLabel(entry.metodoId) || entry.metodoId) : '',
        sourceLabel,
        deviceLabel: entry.createdByDevice || '',
        items,
        rows,
        montoPrincipal,
        montoSecundario,
        tasa,
        saldoAntesUsd,
        saldoDespuesUsd: saldoRestanteUsd,
        excedenteUsd,
        saldo: `Queda por pagar en el periodo: $${formatUsd(saldoRestanteUsd)}`,
        nota: entry.nota || '',
        anulado: entry.status === 'ANULADO',
        firma: entry.tipo === 'ADELANTO' || entry.tipo === 'PAGO' || isGoods,
        actor: entry.actor || '—',
        actorRolLabel,
        authorizedBy,
        authorizedByRolLabel,
    };
}

export function buildPayrollReceiptHtml(data, paperWidth = '58') {
    const is80 = paperWidth === '80';
    const cssPageSize = is80 ? '80mm auto' : '58mm auto';
    const cssBodyWidth = is80 ? '72mm' : '50mm';
    const cssLogoW = is80 ? '36mm' : '26mm';
    const fTitle = is80 ? '15px' : '13px';
    const fBase = is80 ? '12px' : '11px';
    const fSmall = is80 ? '11px' : '10px';
    const fTiny = is80 ? '10px' : '9px';
    const fTotal = is80 ? '20px' : '17px';
    const e = escapeHtml;

    const infoRows = [
        ['Empleado', data.employeeName],
        ...(data.employeeCedula ? [['C.I.', data.employeeCedula]] : []),
        ...(data.employeeCargo ? [['Cargo', data.employeeCargo]] : []),
        ['Periodo', data.periodoLabel],
        ['Concepto', data.conceptoLabel],
        ...(data.valuationLabel ? [['Valoración', data.valuationLabel]] : []),
        ...(data.methodLabel ? [['Forma de pago', data.methodLabel]] : []),
        ...(data.sourceLabel ? [['Origen', data.sourceLabel]] : []),
        ...(data.deviceLabel ? [['Equipo', data.deviceLabel]] : []),
    ];

    const infoHtml = infoRows.map(([k, v]) => `
        <tr>
            <td style="text-align:left;font-size:${fTiny};padding:1.5px 4px 1.5px 0;vertical-align:top;">${e(k)}:</td>
            <td style="text-align:right;font-size:${fTiny};padding:1.5px 0;vertical-align:top;word-break:break-word;">${e(v)}</td>
        </tr>`).join('');

    const itemsHtml = data.isGoods && Array.isArray(data.items) && data.items.length > 0
        ? `
        <hr class="dash">
        <table style="margin-bottom:4px;width:100%;">
            <tr style="font-size:${fTiny};">
                <td style="text-align:left;width:70%;">CONCEPTO</td>
                <td style="text-align:right;width:30%;">TOTAL</td>
            </tr>
        </table>
        <table style="width:100%;">
            ${data.items.map((item) => `
            <tr>
                <td colspan="2" style="text-align:left;font-size:${fBase};padding:5px 0 1px 0;line-height:1.25;word-break:break-word;">
                    ${e(item.name)}
                </td>
            </tr>
            <tr>
                <td style="text-align:left;font-size:${fTiny};padding:1px 4px 5px 0;width:65%;border-bottom:1px dotted #999;">
                    ${item.qty} x $${formatUsd(item.unitUsd)}${item.unitBs > 0 ? ` (Bs ${formatBs(item.unitBs)})` : ''}
                </td>
                <td style="text-align:right;font-size:${fBase};padding:1px 0 5px 0;width:35%;white-space:nowrap;border-bottom:1px dotted #999;">
                    $${formatUsd(item.subtotalUsd)}
                </td>
            </tr>`).join('')}
        </table>`
        : '';

    const balanceHtml = `
        <table style="width:100%;margin-top:4px;">
            ${data.saldoAntesUsd !== null ? `
            <tr>
                <td style="text-align:left;font-size:${fTiny};padding:1px 0;">Saldo antes:</td>
                <td style="text-align:right;font-size:${fTiny};padding:1px 0;">$${formatUsd(data.saldoAntesUsd)}</td>
            </tr>` : ''}
            <tr>
                <td style="text-align:left;font-size:${fSmall};padding:2px 0;">${e(data.saldo)}</td>
                <td style="text-align:right;font-size:${fSmall};padding:2px 0;"></td>
            </tr>
            ${data.excedenteUsd > 0 ? `
            <tr>
                <td colspan="2" style="text-align:center;font-size:${fTiny};padding:3px 2px;border:1px dashed #000;margin-top:3px;">
                    EXCEDENTE PRÓXIMO PERIODO: $${formatUsd(data.excedenteUsd)}
                </td>
            </tr>` : ''}
        </table>`;

    const actorLine = data.actorRolLabel ? `${data.actor} (${data.actorRolLabel})` : data.actor;
    const authLine = data.authorizedByRolLabel && data.authorizedBy !== 'Dentro de saldo permitido'
        ? `${data.authorizedBy} (${data.authorizedByRolLabel})`
        : data.authorizedBy;

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${e(data.titulo)} #${e(data.numero)}</title>
<style>
    @page { size: ${cssPageSize}; margin: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; font-weight: bold !important; color: #000 !important; }
    body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        width: ${cssBodyWidth};
        max-width: ${cssBodyWidth};
        margin: 0 auto;
        padding: 4mm 2mm;
        background: #fff;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
    }
    .center { text-align: center; }
    .dash { border: none; border-top: 1px dashed #000 !important; margin: ${is80 ? '7px 0' : '5px 0'}; }
    .total { font-size: ${fTotal}; font-weight: 900; text-align: center; margin: 3px 0; }
    .anulado { text-align: center; font-size: ${fTitle}; border: 2px solid #000; padding: 3px; margin: 5px 0; letter-spacing: 1px; }
    .firma { margin-top: 26px; border-top: 1px solid #000; text-align: center; padding-top: 3px; font-size: ${fTiny}; }
    table { width: 100%; border-collapse: collapse; }
    @media print { body { width: ${cssBodyWidth}; max-width: ${cssBodyWidth}; } }
    @media screen { body { border: 1px solid #ccc; margin-top: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); } }
</style>
</head>
<body>
    ${data.business?.logoSrc ? `
    <div class="center" style="margin-bottom:6px;">
        <img src="${e(data.business.logoSrc)}" alt="Logo" style="max-width:${cssLogoW};max-height:16mm;" onerror="this.style.display='none'">
    </div>` : ''}

    <div class="center" style="margin-bottom:5px;line-height:1.25;">
        <div style="font-size:${fTitle};text-transform:uppercase;">${e(data.business?.name || 'Bodega')}</div>
        ${data.business?.rif ? `<div style="font-size:${fTiny};">RIF: ${e(data.business.rif)}</div>` : ''}
        ${data.business?.address ? `<div style="font-size:${fTiny};">${e(data.business.address)}</div>` : ''}
        ${data.business?.phone ? `<div style="font-size:${fTiny};">Tel: ${e(data.business.phone)}</div>` : ''}
        ${data.business?.instagram ? `<div style="font-size:${fTiny};">Ig: ${e(data.business.instagram)}</div>` : ''}
    </div>

    <hr class="dash">

    <div class="center" style="font-size:${fBase};margin-bottom:2px;">${e(data.titulo.toUpperCase())}</div>
    <div class="center" style="font-size:${fTiny};margin-bottom:4px;">N.º ${e(data.numero)} · ${e(data.fecha)}</div>
    ${data.anulado ? '<div class="anulado">ANULADO</div>' : ''}

    <hr class="dash">

    <table>${infoHtml}</table>

    ${itemsHtml}

    <hr class="dash">

    <div class="center" style="font-size:${fTiny};">TOTAL</div>
    <div class="total">${e(data.montoPrincipal)}</div>
    ${data.montoSecundario ? `<div class="center" style="font-size:${fTiny};margin-bottom:3px;">${e(data.montoSecundario)}</div>` : ''}

    <hr class="dash">

    ${balanceHtml}
    ${data.nota ? `<div style="font-size:${fTiny};margin-top:4px;word-break:break-word;">Nota: ${e(data.nota)}</div>` : ''}

    <hr class="dash">

    <!-- Bloque de control y autorización (respaldo ante malentendidos) -->
    <table style="width:100%;">
        <tr>
            <td style="text-align:left;font-size:${fTiny};padding:1px 4px 1px 0;">Registrado por:</td>
            <td style="text-align:right;font-size:${fTiny};padding:1px 0;">${e(actorLine)}</td>
        </tr>
        <tr>
            <td style="text-align:left;font-size:${fTiny};padding:1px 4px 1px 0;">Autorizado por:</td>
            <td style="text-align:right;font-size:${fTiny};padding:1px 0;">${e(authLine)}</td>
        </tr>
    </table>

    ${data.firma ? `
    <div class="firma">
        Recibí conforme · ${e(data.employeeName)}${data.employeeCedula ? ` (${e(data.employeeCedula)})` : ''}
    </div>` : ''}

    <div class="center" style="font-size:8px;margin-top:8px;line-height:1.35;">
        Comprobante interno de nómina / consumo de personal.<br>
        Conservar como respaldo ante aclaratorias.
    </div>
</body>
</html>`;
}

export function printPayrollReceipt(data) {
    let paper = '58';
    try { paper = localStorage.getItem('printer_paper_width') || '58'; } catch { /* sin almacenamiento */ }
    openPrintWindow(buildPayrollReceiptHtml(data, paper));
}

/** Baja el recibo como PDF (para enviarlo por WhatsApp). */
export async function downloadPayrollReceiptPdf(data) {
    const { jsPDF } = await import('jspdf');
    const W = 80;
    const M = 6;
    const extraItemsH = data.isGoods && data.items?.length ? data.items.length * 8 + 10 : 0;
    const H = 148 + data.rows.length * 5 + extraItemsH + (data.nota ? 8 : 0) + (data.firma ? 18 : 0);
    const doc = new jsPDF('p', 'mm', [W, H]);
    let y = 10;
    const center = (txt, size = 9, bold = false) => {
        doc.setFont('helvetica', bold ? 'bold' : 'normal');
        doc.setFontSize(size);
        doc.splitTextToSize(String(txt), W - 2 * M).forEach(line => { doc.text(line, W / 2, y, { align: 'center' }); y += size * 0.45; });
        y += 1;
    };
    const rule = () => { doc.setLineDashPattern([1, 1], 0); doc.line(M, y, W - M, y); doc.setLineDashPattern([], 0); y += 4; };
    const kv = (k, v) => {
        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal'); doc.text(String(k), M, y);
        doc.setFont('helvetica', 'bold'); doc.text(String(v).slice(0, 36), W - M, y, { align: 'right' });
        y += 5;
    };

    center((data.business?.name || 'Bodega').toUpperCase(), 12, true);
    if (data.business?.rif) center(`RIF: ${data.business.rif}`, 8);
    if (data.business?.address) center(data.business.address, 7);
    if (data.business?.phone) center(`Tel: ${data.business.phone}`, 7);
    rule();
    center(data.titulo.toUpperCase(), 10, true);
    center(`N.º ${data.numero} · ${data.fecha}`, 7);
    if (data.anulado) center('ANULADO', 12, true);
    rule();

    kv('Empleado', data.employeeName);
    if (data.employeeCedula) kv('C.I.', data.employeeCedula);
    if (data.employeeCargo) kv('Cargo', data.employeeCargo);
    kv('Periodo', data.periodoLabel);
    kv('Concepto', data.conceptoLabel);
    if (data.valuationLabel) kv('Valoración', data.valuationLabel);
    if (data.methodLabel) kv('Forma de pago', data.methodLabel);
    if (data.sourceLabel) kv('Origen', data.sourceLabel);
    if (data.deviceLabel) kv('Equipo', data.deviceLabel);

    if (data.isGoods && data.items?.length) {
        rule();
        doc.setFontSize(7.5);
        doc.setFont('helvetica', 'bold');
        doc.text('CONCEPTO', M, y);
        doc.text('TOTAL', W - M, y, { align: 'right' });
        y += 4;
        data.items.forEach((item) => {
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8);
            doc.text(String(item.name).slice(0, 38), M, y);
            y += 3.8;
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7);
            doc.text(`${item.qty} x $${formatUsd(item.unitUsd)}`, M, y);
            doc.setFont('helvetica', 'bold');
            doc.text(`$${formatUsd(item.subtotalUsd)}`, W - M, y, { align: 'right' });
            y += 4.5;
        });
    }

    rule();
    center(data.montoPrincipal, 16, true);
    if (data.montoSecundario) center(data.montoSecundario, 7);
    rule();
    if (data.saldoAntesUsd !== null) kv('Saldo antes', `$${formatUsd(data.saldoAntesUsd)}`);
    center(data.saldo, 8, true);
    if (data.excedenteUsd > 0) center(`Excedente próximo periodo: $${formatUsd(data.excedenteUsd)}`, 7.5, true);
    if (data.nota) center(`Nota: ${data.nota}`, 7);
    rule();
    kv('Registrado por', data.actor);
    kv('Autorizado por', data.authorizedBy);
    if (data.firma) {
        y += 10;
        doc.line(M + 6, y, W - M - 6, y);
        y += 4;
        center(`Recibí conforme · ${data.employeeName}`, 7.5, true);
    }
    center('Comprobante interno de nómina — conservar como respaldo.', 6);
    doc.save(`recibo_nomina_${data.numero}.pdf`);
}
