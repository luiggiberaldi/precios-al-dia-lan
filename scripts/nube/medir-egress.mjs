/**
 * Medición de egress de Precios al Día Nube contra nube-pruebas (NUNCA producción).
 *
 *   node scripts/nube/medir-egress.mjs seed <n_productos> [n_clientes]   carga datos egtest-*
 *   node scripts/nube/medir-egress.mjs medir                            mide las lecturas de una caja
 *   node scripts/nube/medir-egress.mjs realtime                         mide los avisos de una «venta»
 *   node scripts/nube/medir-egress.mjs limpiar                          borra todo lo egtest-*
 *
 * Lee la URL y la llave anónima de `.env.local` y las credenciales del dueño de prueba de
 * `cuenta-prueba-nube.local` (carpeta principal). No imprime ninguna credencial.
 * Todo lo que crea lleva el prefijo `egtest-` para poder borrarlo.
 */
import fs from 'node:fs';
import https from 'node:https';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const ROOT = process.env.PDN_ROOT || 'C:/Users/luigg/Desktop/precios al dia cloud';
const PREFIX = 'egtest-';

function readKv(file) {
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) out[m[1]] = m[2].trim();
    }
    return out;
}

const env = readKv(`${ROOT}/.env.local`);
const URL_ = env.VITE_SUPABASE_CLOUD_URL || env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_CLOUD_KEY || env.VITE_SUPABASE_ANON_KEY;
if (!URL_.includes('hfuzyauiefhllohonvim')) throw new Error('Solo se mide contra nube-pruebas');
const cuenta = readKv(`${ROOT}/cuenta-prueba-nube.local`);

const client = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function login() {
    const { data, error } = await client.auth.signInWithPassword({ email: cuenta.CORREO, password: cuenta.CLAVE });
    if (error) throw new Error(`login: ${error.message}`);
    const token = data.session.access_token;
    const { data: acc } = await client.from('accounts').select('id, name').limit(1);
    const { data: sedes } = await client.from('sedes').select('id, name').is('archived_at', null).order('created_at');
    return { token, accountId: acc[0].id, sedeId: sedes[0].id };
}

const pad = (n) => String(n).padStart(5, '0');
/** Id como los de la app (crypto.randomUUID), estable por número y con el prefijo de prueba. */
function uid(kind, i) {
    const h = createHash('sha1').update(`${kind}:${i}`).digest('hex');
    return `${PREFIX}${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const CATS = ['viveres', 'bebidas', 'limpieza', 'charcuteria', 'otros', 'higiene', 'snacks'];

/** Producto con la forma que guarda el formulario de Bodega (sin imagen). */
function product(i) {
    const price = Math.round((0.5 + (i % 97) * 0.37) * 100) / 100;
    return {
        id: uid('p', i),
        name: `Producto de prueba ${i} ${CATS[i % CATS.length]} 500g`,
        barcode: String(7590000000000 + i),
        priceUsdt: price,
        priceUsd: price,
        costUsd: Math.round(price * 0.7 * 100) / 100,
        costBs: Math.round(price * 0.7 * 36.5 * 100) / 100,
        unit: 'unidad',
        unitsPerPackage: '',
        unitPriceUsd: '',
        category: CATS[i % CATS.length],
        lowStockAlert: 5,
        packagingType: 'suelto',
        createdAt: new Date(1_760_000_000_000 + i * 1000).toISOString(),
        updatedAt: new Date(1_760_000_000_000 + i * 1000).toISOString(),
    };
}

function customer(i) {
    return {
        id: uid('c', i),
        name: `Cliente de prueba ${i}`,
        phone: `0414${String(1000000 + i)}`,
        documentId: `V-${20000000 + i}`,
        createdAt: new Date(1_760_000_000_000 + i * 1000).toISOString(),
    };
}

async function rpc(fn, args) {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
}

async function seed(nProducts, nCustomers) {
    const { sedeId } = await login();
    const { count: have } = await client.from('account_records').select('id', { count: 'exact', head: true })
        .eq('collection', 'products').like('id', `${PREFIX}%`);
    for (let i = (have || 0) + 1; i <= nProducts; i += 200) {
        const batch = [];
        for (let j = i; j < i + 200 && j <= nProducts; j += 1) batch.push({ id: product(j).id, data: product(j), deleted: false });
        await rpc('push_records', { p_session: null, p_collection: 'products', p_records: batch });
        const moves = batch.map((r, k) => ({ id: crypto.randomUUID(), product_id: r.id, qty: 10 + ((i + k) % 90), note: `${PREFIX}inicial` }));
        await rpc('process_stock_movements', { p_session: null, p_reason: 'INICIAL', p_movements: moves, p_reference: `${PREFIX}seed`, p_sede_id: sedeId });
    }
    if (nCustomers) {
        const { count: haveC } = await client.from('account_records').select('id', { count: 'exact', head: true })
            .eq('collection', 'customers').like('id', `${PREFIX}%`);
        for (let i = (haveC || 0) + 1; i <= nCustomers; i += 200) {
            const batch = [];
            for (let j = i; j < i + 200 && j <= nCustomers; j += 1) batch.push({ id: customer(j).id, data: customer(j), deleted: false });
            await rpc('push_records', { p_session: null, p_collection: 'customers', p_records: batch });
            const moves = batch.map((r, k) => ({
                id: crypto.randomUUID(), customer_id: r.id, type: 'SALDO_INICIAL_MIGRADO',
                direction: (i + k) % 3 ? 'DEBIT' : 'CREDIT', amount_usd: Math.round((1 + ((i + k) * 7.37) % 80) * 100) / 100, reason: `${PREFIX}saldo`,
            }));
            await rpc('push_customer_movements', { p_session: null, p_movements: moves });
        }
    }
    console.log(`seed listo: ${nProducts} productos, ${nCustomers || 0} clientes`);
}

/** GET crudo como lo pide el navegador (gzip/br): bytes por el cable y descomprimidos. */
function rawGet(path, token, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(path, URL_);
        const req = https.request(u, {
            method: 'GET',
            headers: {
                apikey: KEY, authorization: `Bearer ${token}`, accept: 'application/json',
                'accept-encoding': 'gzip, deflate, br', 'accept-profile': 'public', ...extraHeaders,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const wire = Buffer.concat(chunks);
                const enc = res.headers['content-encoding'] || 'identity';
                const body = enc === 'br' ? zlib.brotliDecompressSync(wire) : enc === 'gzip' ? zlib.gunzipSync(wire) : wire;
                const headerBytes = Object.entries(res.headers).reduce((s, [k, v]) => s + k.length + String(v).length + 4, 20);
                resolve({ status: res.statusCode, enc, wire: wire.length, body: body.length, headerBytes, rows: (() => { try { return JSON.parse(body).length; } catch { return null; } })() });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function medir() {
    const { token, sedeId } = await login();
    const now = new Date().toISOString();
    const q = (s) => encodeURIComponent(s);
    const out = {};
    const run = async (name, paths) => {
        const tot = { requests: 0, wire: 0, body: 0, headerBytes: 0, rows: 0, enc: '' };
        for (const p of paths) {
            const r = await rawGet(p, token);
            if (r.status >= 300) throw new Error(`${name}: HTTP ${r.status}`);
            tot.requests += 1; tot.wire += r.wire; tot.body += r.body; tot.headerBytes += r.headerBytes; tot.rows += r.rows || 0; tot.enc = r.enc;
        }
        out[name] = tot;
    };

    const { count: nLevels } = await client.from('stock_levels').select('product_id', { count: 'exact', head: true }).eq('sede_id', sedeId);
    const pages = Math.max(1, Math.ceil((nLevels + 1) / 1000));
    await run('stock_levels completo (fetchStockLevels)', Array.from({ length: pages }, (_, i) =>
        `/rest/v1/stock_levels?select=product_id,qty&sede_id=eq.${sedeId}&order=product_id.asc&offset=${i * 1000}&limit=1000`));
    await run('customer_balances completo (ledger.pull)', ['/rest/v1/customer_balances?select=customer_id,balance_usd']);
    await run('customer_movements incremental vacío', [`/rest/v1/customer_movements?select=id,customer_id,type,direction,amount_usd,balance_after,source_type,source_id,source_sale_id,reversal_of,reason,device_at,server_at,seq&seq=gt.999999999&order=seq.asc&limit=500`]);
    await run('account_records incremental vacío ×5 colecciones', ['products', 'customers', 'suppliers', 'payment_methods', 'settings'].slice(0, 5).map((c) =>
        `/rest/v1/account_records?select=id,data,version,deleted_at,updated_at&collection=eq.${c}&updated_at=gt.${q(now)}&order=updated_at.asc&limit=500`));
    const { count: nProd } = await client.from('account_records').select('id', { count: 'exact', head: true }).eq('collection', 'products');
    await run('account_records products completo (primer arranque)', Array.from({ length: Math.max(1, Math.ceil((nProd + 1) / 500)) }, (_, i) =>
        `/rest/v1/account_records?select=id,data,version,deleted_at,updated_at&collection=eq.products&order=updated_at.asc&offset=${i * 500}&limit=500`));
    await run('panel dueño: nombres de productos (loadNames)', Array.from({ length: Math.max(1, Math.ceil((nProd + 1) / 1000)) }, (_, i) =>
        `/rest/v1/account_records?select=id,name:data->>name&collection=eq.products&deleted_at=is.null&offset=${i * 1000}&limit=1000`));
    await run('estado del equipo (getDeviceStatus, 4 lecturas)', [
        '/rest/v1/accounts?select=id,name&limit=1',
        '/rest/v1/account_licenses?select=status,max_cajas,max_sedes,expires_at&limit=1',
        '/rest/v1/sedes?select=id,name,archived_at&archived_at=is.null&order=created_at.asc',
        '/rest/v1/account_devices?select=id,account_id,sede_id,role,caja_letter,label,revoked_at,auth_user_id&limit=1',
    ]);
    console.log(JSON.stringify({ productos: nProd, niveles: nLevels, medido: out }, null, 2));
}

/** Simula el efecto de una venta de K productos (K filas de stock_levels) y cuenta los avisos. */
async function realtime(k = 3) {
    const { accountId, sedeId } = await login();
    const listener = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    await listener.auth.signInWithPassword({ email: cuenta.CORREO, password: cuenta.CLAVE });
    await listener.realtime.setAuth((await listener.auth.getSession()).data.session.access_token);
    const got = { stock: [], balances: [], sync: [] };
    const sub = (name, table, filter, bucket) => new Promise((resolve) => {
        listener.channel(name).on('postgres_changes', { event: '*', schema: 'public', table, filter }, (p) => got[bucket].push(JSON.stringify(p).length))
            .subscribe((s) => { if (s === 'SUBSCRIBED') resolve(); });
    });
    await sub(`pdn-stock-${accountId}-${sedeId}`, 'stock_levels', `sede_id=eq.${sedeId}`, 'stock');
    await sub(`pdn-cartera-${accountId}`, 'customer_balances', `account_id=eq.${accountId}`, 'balances');
    await sub(`pdn-sync-${accountId}`, 'account_sync_state', `account_id=eq.${accountId}`, 'sync');
    await new Promise((r) => setTimeout(r, 1500));
    const moves = Array.from({ length: k }, (_, i) => ({ id: crypto.randomUUID(), product_id: uid('p', i + 1), qty: -1, note: `${PREFIX}venta-simulada` }));
    await rpc('process_stock_movements', { p_session: null, p_reason: 'AJUSTE', p_movements: moves, p_reference: `${PREFIX}rt`, p_sede_id: sedeId });
    await rpc('push_customer_movements', { p_session: null, p_movements: [{ id: crypto.randomUUID(), customer_id: uid('c', 1), type: 'VENTA_FIADA', direction: 'DEBIT', amount_usd: 1, reason: `${PREFIX}rt` }] });
    await rpc('push_records', { p_session: null, p_collection: 'products', p_records: [{ id: uid('p', 1), data: { ...product(1), name: `Producto de prueba 1 editado ${Date.now()}` }, deleted: false }] });
    await new Promise((r) => setTimeout(r, 5000));
    console.log(JSON.stringify({ k, mensajes: Object.fromEntries(Object.entries(got).map(([b, l]) => [b, { n: l.length, bytes: l }])) }, null, 2));
    await listener.removeAllChannels();
}

async function limpiar() {
    await login();
    console.log('limpieza: usar SQL de servicio (los libros no se pueden borrar desde el cliente). Ver informe.');
}

const [cmd, a, b] = process.argv.slice(2);
const runCmd = { seed: () => seed(Number(a), Number(b || 0)), medir, realtime: () => realtime(Number(a || 3)), limpiar }[cmd];
if (!runCmd) { console.log('uso: seed <n> [clientes] | medir | realtime [k] | limpiar'); process.exit(1); }
runCmd().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
