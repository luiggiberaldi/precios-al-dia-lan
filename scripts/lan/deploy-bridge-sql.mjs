/**
 * Despliega `supabase/lan/001_puente_supervisor.sql` al proyecto Supabase del puente
 * usando `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `PDN_CLOUD_BRIDGE_URL` y
 * `PDN_CLOUD_BRIDGE_KEY` desde `.env.local` (nunca imprime secretos).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function readEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const out = {};
    const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=(.*)$/);
        if (m) out[m[1]] = m[2].trim();
    }
    return out;
}

async function runQuery(ref, tok, query) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${tok}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Supabase SQL error (${res.status}): ${text}`);
    }
    return text ? JSON.parse(text) : [];
}

async function main() {
    const env = readEnvFile(path.join(ROOT, '.env.local'));
    const tok = env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
    const ref = env.SUPABASE_PROJECT_REF || process.env.SUPABASE_PROJECT_REF;
    const url = env.PDN_CLOUD_BRIDGE_URL || process.env.PDN_CLOUD_BRIDGE_URL;
    const key = env.PDN_CLOUD_BRIDGE_KEY || process.env.PDN_CLOUD_BRIDGE_KEY;

    if (!tok || !ref || !url || !key) {
        throw new Error('Faltan credenciales en .env.local (SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, PDN_CLOUD_BRIDGE_URL, PDN_CLOUD_BRIDGE_KEY).');
    }

    const sql = fs.readFileSync(path.join(ROOT, 'supabase/lan/001_puente_supervisor.sql'), 'utf8');
    await runQuery(ref, tok, sql);
    console.log('SQL_DEPLOY_OK');

    const tables = await runQuery(ref, tok, "select tablename from pg_tables where schemaname = 'public' order by tablename;");
    console.log(`TABLES=${tables.map((t) => t.tablename).join(',')}`);

    await runQuery(ref, tok, "notify pgrst, 'reload schema';");
    await new Promise((r) => setTimeout(r, 1500));

    const rpcRes = await fetch(`${url}/rest/v1/rpc/lan_supervisor_login`, {
        method: 'POST',
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_supervisor_code: 'SUP-NOEXIST', p_pin: '123456' }),
    });
    console.log(`LIVE_RPC_STATUS=${rpcRes.status} BODY=${await rpcRes.text()}`);

    const rlsRes = await fetch(`${url}/rest/v1/lan_cloud_accounts?select=*`, {
        method: 'GET',
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
        },
    });
    console.log(`LIVE_RLS_TABLE_STATUS=${rlsRes.status}`);
}

main().catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
});
