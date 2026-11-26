#!/usr/bin/env node
/**
 * Compila Precios al Día LAN para Windows y publica el instalador + latest.yml en GitHub Releases.
 * Lee GH_TOKEN / GITHUB_TOKEN desde .env o .env.local sin imprimir credenciales.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();

function loadEnvToken() {
    for (const file of ['.env.local', '.env']) {
        const full = path.join(root, file);
        if (!fs.existsSync(full)) continue;
        const lines = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
        for (const raw of lines) {
            const m = raw.match(/^\s*(GH_TOKEN|GITHUB_TOKEN)\s*=\s*(.+)\s*$/);
            if (m && m[2]) return m[2].trim();
        }
    }
    return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
}

const token = loadEnvToken();
if (!token) {
    console.error('[release] Falta GH_TOKEN o GITHUB_TOKEN en .env / .env.local.');
    process.exit(1);
}

const env = {
    ...process.env,
    ELECTRON_BUILD: 'true',
    VITE_NUBE_ACCOUNTS: 'true',
    VITE_LAN_MODE: 'true',
    GH_TOKEN: token,
};

console.log('[release] 1/3 Compilando frontend Electron...');
execSync('bun run build', { cwd: root, stdio: 'inherit', env });

console.log('[release] 2/3 Verificando build sin llaves de Supabase heredadas...');
execSync('node scripts/nube/check-no-legacy-supabase.mjs dist', { cwd: root, stdio: 'inherit', env });

console.log('[release] 3/3 Empaquetando y publicando release en GitHub...');
const desktopDir = path.join(root, 'desktop');
const ebBin = path.join(desktopDir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
execSync(`"${ebBin}" --win --publish always`, { cwd: desktopDir, stdio: 'inherit', env });
