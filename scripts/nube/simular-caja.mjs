/**
 * Simulador de cajas de Precios al Día Nube para medir egress (nube-pruebas).
 *
 * Usa los MÓDULOS REALES de src/nube (recordSync, stockService, customerLedgerSync,
 * stockWatcher) con la misma orquestación de useNubeSync: tick de 60 s, tres canales
 * Realtime (account_sync_state, stock_levels, customer_balances) y sus reacciones.
 * Cuenta los bytes de cada respuesta HTTP (sin comprimir y gzip estimado) y de cada
 * mensaje Realtime, por motivo.
 *
 *   node scripts/nube/simular-caja.mjs <minutos> <cajas> <ventas_por_minuto> <items_por_venta> [fiados_por_minuto] [--pr14]
 *
 * Las «ventas» se simulan con process_stock_movements (AJUSTE −1 por producto): mueven
 * exactamente las mismas filas de stock_levels que process_checkout. Datos egtest-*.
 * Credenciales: las lee el script de cuenta-prueba-nube.local; nunca se imprimen.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createRecordSync } from '../../src/nube/recordSync.js';
import { fetchStockLevels, applyLevels } from '../../src/nube/stockService.js';
import { createCustomerLedgerSync } from '../../src/nube/customerLedgerSync.js';
import { createStockWatcher } from '../../src/nube/stockWatcher.js';

const ROOT = process.env.PDN_ROOT || 'C:/Users/luigg/Desktop/precios al dia cloud';
const readKv = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const env = readKv(`${ROOT}/.env.local`);
const URL_ = env.VITE_SUPABASE_CLOUD_URL || env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_CLOUD_KEY || env.VITE_SUPABASE_ANON_KEY;
if (!URL_.includes('hfuzyauiefhllohonvim')) throw new Error('Solo nube-pruebas');
const cuenta = readKv(`${ROOT}/cuenta-prueba-nube.local`);

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const PR14 = process.argv.includes('--pr14');
const [MIN = 5, CAJAS = 1, VPM = 1, ITEMS = 3, FPM = 0] = args.map(Number);
const HEADER_BYTES = 1200; // cabeceras de respuesta medidas (~1,2 KB por petición)

function uid(kind, i) {
    const h = createHash('sha1').update(`${kind}:${i}`).digest('hex');
    return `egtest-${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const stats = {}; // motivo → { req, body, gzip, headers, rtMsgs, rtBytes }
const bump = (reason, k, v) => { stats[reason] ??= { req: 0, body: 0, gzip: 0, headers: 0, rtMsgs: 0, rtBytes: 0 }; stats[reason][k] += v; };

function countingFetch(label, ctx) {
    return async (input, init) => {
        const reason = ctx.reason;
        const res = await fetch(input, init);
        const buf = Buffer.from(await res.clone().arrayBuffer());
        const url = String(input?.url || input);
        if (url.includes('/rest/v1/') || url.includes('/auth/v1/')) {
            const gz = buf.length > 1024 ? zlib.gzipSync(buf).length : buf.length; // el servidor no comprime respuestas chicas
            bump(`${label}:${reason}`, 'req', 1);
            bump(`${label}:${reason}`, 'body', buf.length);
            bump(`${label}:${reason}`, 'gzip', gz);
            bump(`${label}:${reason}`, 'headers', HEADER_BYTES);
        }
        return res;
    };
}

function memStore() {
    const m = new Map();
    return { getItem: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null), setItem: async (k, v) => { m.set(k, structuredClone(v)); } };
}

async function startCaja(n, accountId, sedeId) {
    const label = `caja${n}`;
    const ctx = { reason: 'login' };
    const client = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: countingFetch(label, ctx) } });
    const { error } = await client.auth.signInWithPassword({ email: cuenta.CORREO, password: cuenta.CLAVE });
    if (error) throw new Error(error.message);
    await client.realtime.setAuth((await client.auth.getSession()).data.session.access_token);

    const local = new Map();
    const readLocal = async (k) => (local.has(k) ? structuredClone(local.get(k)) : null);
    const writeLocal = async (k, v) => { local.set(k, structuredClone(v)); };
    const store = memStore();
    const getSession = () => null; // solo lecturas: las subidas de la caja son ingress
    const engine = createRecordSync({ client, getSession, store, readLocal, writeLocal });
    const watcher = createStockWatcher({ client, getSession, store });
    const ledger = createCustomerLedgerSync({ client, getSession, store, readLocal, writeLocal });

    let levelsBusy = false; let levelsAgain = false;
    const refreshLevels = async (why) => {
        if (levelsBusy) { if (PR14) levelsAgain = true; return; }
        levelsBusy = true;
        try {
            ctx.reason = why;
            const levels = await fetchStockLevels(client, sedeId);
            const { products, changed } = applyLevels((await readLocal('bodega_products_v1')) || [], levels);
            if (changed) await writeLocal('bodega_products_v1', products);
        } finally {
            levelsBusy = false;
            if (levelsAgain) { levelsAgain = false; refreshLevels(`${why}+repetición(PR14)`); }
        }
    };
    const pullRecords = async (why, cols) => { ctx.reason = why; await engine.pull(cols); };
    const pullLedger = async (why) => { ctx.reason = why; await ledger.pull(); };

    // Arranque (como useNubeSync).
    await pullRecords('arranque');
    await refreshLevels('arranque');
    await pullLedger('arranque');

    const rt = (bucket) => (payload) => bump(`${label}:realtime ${bucket}`, 'rtMsgs', 1) || bump(`${label}:realtime ${bucket}`, 'rtBytes', JSON.stringify(payload).length + 120);
    const subscribed = (ch) => new Promise((resolve) => ch.subscribe((s) => { if (s === 'SUBSCRIBED') resolve(); }));
    await subscribed(client.channel(`pdn-sync-${accountId}-${n}`).on('postgres_changes', { event: '*', schema: 'public', table: 'account_sync_state', filter: `account_id=eq.${accountId}` },
        (p) => { rt('account_sync_state')(p); const c = p?.new?.collection; if (c !== 'cash') pullRecords('aviso account_sync_state', c ? [c] : undefined); }));
    await subscribed(client.channel(`pdn-stock-${accountId}-${sedeId}-${n}`).on('postgres_changes', { event: '*', schema: 'public', table: 'stock_levels', filter: `sede_id=eq.${sedeId}` },
        (p) => { rt('stock_levels')(p); refreshLevels('aviso stock_levels'); }));
    await subscribed(client.channel(`pdn-cartera-${accountId}-${n}`).on('postgres_changes', { event: '*', schema: 'public', table: 'customer_balances', filter: `account_id=eq.${accountId}` },
        (p) => { rt('customer_balances')(p); pullLedger('aviso customer_balances'); }));

    const tick = async () => {
        await pullRecords('tick 60 s');
        await refreshLevels('tick 60 s');
        await pullLedger('tick 60 s');
    };
    const timer = setInterval(tick, 60_000);
    return { stop: async () => { clearInterval(timer); await client.removeAllChannels(); } };
}

async function main() {
    const admin = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    await admin.auth.signInWithPassword({ email: cuenta.CORREO, password: cuenta.CLAVE });
    const { data: acc } = await admin.from('accounts').select('id').limit(1);
    const { data: sedes } = await admin.from('sedes').select('id').is('archived_at', null).order('created_at');
    const accountId = acc[0].id; const sedeId = sedes[0].id;
    const { count: nProd } = await admin.from('stock_levels').select('product_id', { count: 'exact', head: true }).eq('sede_id', sedeId);

    const cajas = [];
    for (let i = 1; i <= CAJAS; i += 1) cajas.push(await startCaja(i, accountId, sedeId));
    // Se descarta el arranque: interesa el régimen.
    const startup = structuredClone(stats);
    for (const k of Object.keys(stats)) delete stats[k];

    const t0 = Date.now();
    let sales = 0; let fiados = 0;
    const saleEvery = VPM > 0 ? 60_000 / VPM : 0;
    const fiadoEvery = FPM > 0 ? 60_000 / FPM : 0;
    const saleTimer = saleEvery ? setInterval(async () => {
        const base = 1 + ((sales * ITEMS) % Math.max(1, nProd - ITEMS));
        sales += 1;
        const moves = Array.from({ length: ITEMS }, (_, i) => ({ id: crypto.randomUUID(), product_id: uid('p', base + i), qty: -1, note: 'egtest-venta-sim' }));
        const { error } = await admin.rpc('process_stock_movements', { p_session: null, p_reason: 'AJUSTE', p_movements: moves, p_reference: 'egtest-sim', p_sede_id: sedeId });
        if (error) console.error('venta sim:', error.message);
    }, saleEvery) : null;
    const fiadoTimer = fiadoEvery ? setInterval(async () => {
        fiados += 1;
        const { error } = await admin.rpc('push_customer_movements', { p_session: null, p_movements: [{ id: crypto.randomUUID(), customer_id: uid('c', 1 + (fiados % 200)), type: 'VENTA_FIADA', direction: 'DEBIT', amount_usd: 1.25, reason: 'egtest-sim' }] });
        if (error) console.error('fiado sim:', error.message);
    }, fiadoEvery) : null;

    await new Promise((r) => setTimeout(r, MIN * 60_000 + 3_000));
    clearInterval(saleTimer); clearInterval(fiadoTimer);
    await new Promise((r) => setTimeout(r, 4_000));
    for (const c of cajas) await c.stop();
    const minutes = (Date.now() - t0) / 60_000;
    console.log(JSON.stringify({ config: { minutos: MIN, cajas: CAJAS, ventasPorMinuto: VPM, itemsPorVenta: ITEMS, fiadosPorMinuto: FPM, pr14: PR14, productos: nProd }, minutosReales: minutes, ventas: sales, fiados, arranque: startup, regimen: stats }, null, 2));
    process.exit(0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
