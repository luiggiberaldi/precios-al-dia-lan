#!/usr/bin/env node
/**
 * Copia dist/ -> desktop/dist-web/ para que electron-builder lo empaquete dentro de app.asar
 * (en lugar de miles de archivos sueltos en extraResources) y limpia mapas de depuración.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const srcDist = path.join(root, 'dist');
const destDist = path.join(root, 'desktop', 'dist-web');

if (!fs.existsSync(srcDist)) {
    console.error('[prepare-desktop] Falta dist/. Ejecuta bun run build primero.');
    process.exit(1);
}

fs.rmSync(destDist, { recursive: true, force: true });
fs.cpSync(srcDist, destDist, {
    recursive: true,
    filter: (src) => !src.endsWith('.map'),
});

let fileCount = 0;
let totalBytes = 0;
const stack = [destDist];
while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else {
            fileCount += 1;
            totalBytes += fs.statSync(full).size;
        }
    }
}
console.log(`[prepare-desktop] dist-web listo: ${fileCount} archivos (${(totalBytes / 1024 / 1024).toFixed(2)} MB) para app.asar.`);
