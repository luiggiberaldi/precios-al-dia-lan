#!/usr/bin/env node
/**
 * Guardia de Precios al Día Nube (barandas G2 y G3).
 *
 * Revisa los archivos que se publican (por defecto `dist/`) y falla si encuentra:
 *  - la referencia de algún proyecto Supabase de Precios al Día (producción,
 *    staging, respaldos, Estación Maestra vieja): la nube no debe hablar con ellos;
 *  - una llave de servidor (`service_role`, `sb_secret_`): solo vive en el servidor.
 *
 * Uso: node scripts/nube/check-no-legacy-supabase.mjs [carpeta]
 * Sale con código 1 si hay hallazgos, 2 si la carpeta no existe.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEGACY_SUPABASE_REFS = [
    'sodgzkablshladvbtnes', // producción de Precios al Día
    'tdfcpwctvumbdjmifypd', // staging del Supervisor
    'qlujyvauumzfpdefdkyl', // proyecto de respaldos
    'jjbzevntreoxpuofgkyi', // Estación Maestra vieja
    'oshexsmweswzbwaksvra', // ref vieja de imágenes
];

export const SERVER_KEY_PATTERNS = [/sb_secret_[A-Za-z0-9_-]{8,}/, /["']service_role["']/];

const TEXT_EXT = /\.(js|mjs|cjs|css|html|json|webmanifest|map|txt|svg)$/i;

/** Hallazgos en un texto: [{ kind, match }]. */
export function scanText(text) {
    const found = [];
    for (const ref of LEGACY_SUPABASE_REFS) {
        if (text.includes(ref)) found.push({ kind: 'supabase-legacy', match: ref });
    }
    for (const pattern of SERVER_KEY_PATTERNS) {
        const m = text.match(pattern);
        if (m) found.push({ kind: 'server-key', match: m[0].slice(0, 16) });
    }
    return found;
}

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) yield* walk(full);
        else if (TEXT_EXT.test(name)) yield full;
    }
}

/** Revisa una carpeta completa: [{ file, kind, match }]. */
export function scanDir(dir) {
    const results = [];
    for (const file of walk(dir)) {
        for (const hit of scanText(readFileSync(file, 'utf8'))) {
            results.push({ file: relative(dir, file), ...hit });
        }
    }
    return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const dir = process.argv[2] || 'dist';
    if (!existsSync(dir)) {
        console.error(`[nube] No existe la carpeta ${dir}. Corre el build primero.`);
        process.exit(2);
    }
    const results = scanDir(dir);
    if (results.length) {
        console.error('[nube] ❌ El build contiene referencias prohibidas:');
        for (const r of results) console.error(`  - ${r.file}: ${r.kind} (${r.match})`);
        process.exit(1);
    }
    console.log(`[nube] ✅ ${dir} sin proyectos de Precios al Día ni llaves de servidor.`);
}
