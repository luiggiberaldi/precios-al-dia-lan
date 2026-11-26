/**
 * Proyección de egress y mensajes Realtime de Precios al Día Nube a partir de lo MEDIDO
 * en nube-pruebas (medir-egress.mjs y simular-caja.mjs). Imprime tablas en Markdown.
 *
 *   node scripts/nube/proyectar-egress.mjs [refrescos_por_venta]
 *
 * Supuestos (editar aquí): 3 productos por venta, 10 % de ventas a fiado, 200 clientes,
 * todas las cajas del negocio en la misma sede (el peor caso: todas oyen cada venta).
 */
const R = Number(process.argv[2] || 1); // lecturas completas de stock que dispara cada venta en CADA caja

// Medido (bytes). cable = cuerpo gzip + ~1,2 KB de cabeceras por petición; crudo = sin comprimir + cabeceras.
const H = 1200;
const STOCK = {
    500: { cable: 12_487 + 1 * H, crudo: 38_498 + 1 * H },
    2000: { cable: 49_000 + 3 * H, crudo: 153_998 + 3 * H },
    5000: { cable: 121_421 + 6 * H, crudo: 384_992 + 6 * H },
};
const BAL = { cable: 5_548 + H, crudo: 17_108 + H }; // 200 clientes
const TICK_FIJO = 6 * H; // 5 colecciones de account_records + customer_movements, vacías
const ESTADO_EQUIPO_HORA = 12 * 4 * (H + 130); // getDeviceStatus cada 5 min (4 lecturas)
const HEARTBEAT_HORA = (3600 / 25) * 110; // latido de Realtime cada 25 s
const MSG = 640; // un aviso postgres_changes (~515 B de JSON + marco)
const VENTA_PROPIA = 3 * H; // respuesta de process_checkout + push_records (caja que vende)
const ITEMS = 3;
const FIADO = 0.10;

const GB = 1e9;
const fmt = (b) => (b >= GB ? `${(b / GB).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`);

/** Bytes por caja y día. */
function cajaDia({ productos, horas, ventasNegocio, cajas, modo = 'cable' }) {
    const st = STOCK[productos][modo];
    const bal = BAL[modo];
    const ticks = horas * 60;
    const tick = ticks * (st + bal + TICK_FIJO);
    const fondo = horas * (ESTADO_EQUIPO_HORA + HEARTBEAT_HORA);
    const ventas = ventasNegocio * (R * st + (ITEMS + 1) * MSG) + (ventasNegocio / cajas) * VENTA_PROPIA;
    const fiados = ventasNegocio * FIADO * (bal + MSG + H);
    return { total: tick + fondo + ventas + fiados, tick, ventas: ventas + fiados, stockTick: ticks * st };
}

/** Mensajes Realtime por negocio y día (cada aviso cuenta una vez por caja que escucha). */
const mensajesDia = ({ ventasNegocio, cajas }) => cajas * ventasNegocio * (ITEMS + 1 + FIADO);

const out = [];
out.push(`## Por caja (refrescos de stock por venta = ${R})\n`);
out.push('| Productos | Horas | Ventas/día (negocio) | Cajas | Por caja/día (cable) | Por caja/día (sin comprimir) | Por caja/mes (cable) | solo tick de stock/día (sin comprimir) |');
out.push('|---|---|---|---|---|---|---|---|');
for (const productos of [500, 2000, 5000]) for (const horas of [8, 12]) for (const v of [100, 500]) for (const cajas of [1, 3, 5]) {
    const c = cajaDia({ productos, horas, ventasNegocio: v, cajas });
    const r = cajaDia({ productos, horas, ventasNegocio: v, cajas, modo: 'crudo' });
    out.push(`| ${productos} | ${horas} | ${v} | ${cajas} | ${fmt(c.total)} | ${fmt(r.total)} | ${fmt(c.total * 30)} | ${fmt(r.stockTick)} |`);
}

out.push('\n## Por negocio y días hasta agotar 5 GB (plan gratuito, una sola cuenta)\n');
out.push('| Productos | Horas | Ventas/día | Cajas | Negocio/día (cable) | Negocio/mes (cable) | Días hasta 5 GB | Mensajes RT/mes |');
out.push('|---|---|---|---|---|---|---|---|');
for (const productos of [500, 2000, 5000]) for (const horas of [8, 12]) for (const v of [100, 500]) for (const cajas of [1, 3, 5]) {
    const d = cajas * cajaDia({ productos, horas, ventasNegocio: v, cajas }).total;
    out.push(`| ${productos} | ${horas} | ${v} | ${cajas} | ${fmt(d)} | ${fmt(d * 30)} | ${(5 * GB / d).toFixed(1)} | ${(mensajesDia({ ventasNegocio: v, cajas }) * 30 / 1e3).toFixed(0)} mil |`);
}

out.push('\n## Varias cuentas (negocio típico: 2.000 productos, 3 cajas, 12 h, 300 ventas/día)\n');
out.push('| Negocios | Egress/mes (cable) | vs Free 5 GB | vs Pro 250 GB | Mensajes RT/mes | vs Free 2 M | vs Pro 5 M | Conexiones RT pico | Días hasta 5 GB |');
out.push('|---|---|---|---|---|---|---|---|---|');
const tip = { productos: 2000, horas: 12, ventasNegocio: 300, cajas: 3 };
const tipDia = tip.cajas * cajaDia(tip).total;
for (const n of [1, 10, 50, 100]) {
    const mes = n * tipDia * 30;
    const msgs = n * mensajesDia(tip) * 30;
    out.push(`| ${n} | ${fmt(mes)} | ${(mes / (5 * GB) * 100).toFixed(0)} % | ${(mes / (250 * GB) * 100).toFixed(0)} % | ${(msgs / 1e6).toFixed(2)} M | ${(msgs / 2e6 * 100).toFixed(0)} % | ${(msgs / 5e6 * 100).toFixed(0)} % | ${n * tip.cajas} | ${(5 * GB / (n * tipDia)).toFixed(2)} |`);
}
console.log(out.join('\n'));

// ─── Arreglos propuestos: ahorro acumulado sobre el negocio típico ─────────────
/**
 * Modelo con interruptores. Cada arreglo cambia una pieza del costo por caja y día.
 *   incStock:   stock_levels por updated_at > cursor (sin cambios = 1 petición vacía)
 *   payload:    aplicar el aviso Realtime (trae product_id y qty) en vez de releer
 *   incBal:     customer_balances por updated_at > cursor + aplicar el aviso
 *   tick5:      tick de respaldo cada 5 min mientras Realtime está conectado
 *   unaRpc:     un solo RPC «¿qué cambió?» en vez de 7-8 lecturas por tick (menos cabeceras)
 *   unAviso:    un aviso por venta (no uno por fila de stock) y sin aviso por registro de caja
 */
function cajaDiaOpt({ productos, horas, ventasNegocio, cajas }, f) {
    const st = STOCK[productos].cable;
    const vacia = H + 2;
    const ticksPorHora = f.tick5 ? 12 : 60;
    const ticks = horas * ticksPorHora;
    const cambiosPorTick = (ventasNegocio * ITEMS) / (horas * ticksPorHora); // filas de stock cambiadas entre ticks
    const stockTick = f.incStock ? vacia + cambiosPorTick * 30 : st; // ~30 B gzip por fila
    const balTick = f.incBal ? vacia : BAL.cable;
    const tickFijo = f.unaRpc ? 0 : TICK_FIJO;
    const tickCosto = f.unaRpc ? (H + cambiosPorTick * 30) : (stockTick + balTick + tickFijo);
    const tick = ticks * tickCosto;
    const fondo = horas * ((f.unaRpc ? 12 * (H + 300) : ESTADO_EQUIPO_HORA) + HEARTBEAT_HORA);
    const relectura = f.payload ? 0 : R * (f.incStock ? vacia + ITEMS * 30 : st);
    const msgsVenta = f.unAviso ? 1 : ITEMS + 1;
    const ventas = ventasNegocio * (relectura + msgsVenta * MSG) + (ventasNegocio / cajas) * VENTA_PROPIA;
    const fiados = ventasNegocio * FIADO * ((f.payload || f.incBal ? vacia : BAL.cable) + MSG + H);
    return { total: tick + fondo + ventas + fiados, msgs: cajas * ventasNegocio * (msgsVenta + FIADO) };
}
const pasos = [
    [`Hoy (${R} lectura(s) de stock por venta)`, {}],
    ['1. Aplicar el aviso Realtime en vez de releer todo el stock', { payload: true }],
    ['2. + stock_levels incremental (updated_at > cursor)', { payload: true, incStock: true }],
    ['3. + saldos incrementales / desde el aviso', { payload: true, incStock: true, incBal: true }],
    ['4. + tick de respaldo cada 5 min con Realtime conectado', { payload: true, incStock: true, incBal: true, tick5: true }],
    ['5. + un solo RPC «qué cambió» por tick', { payload: true, incStock: true, incBal: true, tick5: true, unaRpc: true }],
    ['6. + un aviso Realtime por venta (no por fila)', { payload: true, incStock: true, incBal: true, tick5: true, unaRpc: true, unAviso: true }],
];
out.length = 0;
out.push('\n## Arreglos acumulados (negocio típico: 2.000 productos, 3 cajas, 12 h, 300 ventas/día)\n');
out.push('| Paso | Por caja/día | Negocio/mes | Ahorro vs hoy | Mensajes RT/mes (negocio) | Negocios que caben en Free 5 GB | Negocios en Pro 250 GB | Negocios por mensajes Free 2 M / Pro 5 M |');
out.push('|---|---|---|---|---|---|---|---|');
const base = cajaDiaOpt(tip, {}).total;
for (const [name, f] of pasos) {
    const r = cajaDiaOpt(tip, f);
    const mes = r.total * tip.cajas * 30;
    const msgsMes = r.msgs * 30;
    out.push(`| ${name} | ${fmt(r.total)} | ${fmt(mes)} | ${((1 - r.total / base) * 100).toFixed(0)} % | ${(msgsMes / 1e3).toFixed(0)} mil | ${Math.floor(5 * GB / mes)} | ${Math.floor(250 * GB / mes)} | ${Math.floor(2e6 / msgsMes)} / ${Math.floor(5e6 / msgsMes)} |`);
}
console.log(out.join('\n'));
