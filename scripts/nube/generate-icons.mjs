#!/usr/bin/env node
/**
 * Íconos de Precios al Día Nube: la misma «D» de Bodega y Farmacia, en azul nube.
 * Toma los íconos de fábrica de Bodega desde git y cambia el verde azulado por el azul
 * (conservando el borde suavizado y el alfa).
 * Uso: node scripts/nube/generate-icons.mjs [--from <ref git>]  (usa el Chromium de Playwright)
 * Escribe en public/: pwa-*.png, pwa-maskable-*.png, apple-touch-icon*.png y favicon.ico.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const fromIdx = process.argv.indexOf('--from');
const REF = fromIdx > 0 ? process.argv[fromIdx + 1] : 'upstream/main';
const OUT = 'public';
const BLUE = [43, 89, 195]; // #2b59c3, igual que brand.js

const ICONS = [
    'pwa-144x144.png', 'pwa-192x192.png', 'pwa-512x512.png',
    'pwa-maskable-192.png', 'pwa-maskable-512.png',
    'apple-touch-icon.png', 'apple-touch-icon-180x180.png',
];

/** ICO con PNG embebido (formato soportado por todos los navegadores actuales). */
function pngToIco(pngs) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
    const entries = []; const datas = [];
    let offset = 6 + 16 * pngs.length;
    for (const { size, data } of pngs) {
        const e = Buffer.alloc(16);
        e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
        e.writeUInt8(0, 2); e.writeUInt8(0, 3); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
        e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
        offset += data.length; entries.push(e); datas.push(data);
    }
    return Buffer.concat([header, ...entries, ...datas]);
}

const browser = await chromium.launch();
const page = await browser.newPage();

/** Recolorea un PNG de Bodega; si se pasa size, además lo redimensiona. */
async function recolor(png, size) {
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const out = await page.evaluate(async ({ dataUrl, blue, size }) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = size || img.width; c.height = size || img.height;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        const px = d.data;
        // El dibujo es verde azulado (rojo ≈ 18) sobre blanco: el rojo dice cuánta «tinta» hay.
        // Se mezcla blanco→azul con esa proporción, así los bordes quedan suaves.
        for (let i = 0; i < px.length; i += 4) {
            const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
            if (a === 0 || !(g - r > 25 && b - r > 25)) continue;
            const t = Math.min(1, Math.max(0, (255 - r) / (255 - 18)));
            px[i] = Math.round(255 + (blue[0] - 255) * t);
            px[i + 1] = Math.round(255 + (blue[1] - 255) * t);
            px[i + 2] = Math.round(255 + (blue[2] - 255) * t);
        }
        ctx.putImageData(d, 0, 0);
        return c.toDataURL('image/png');
    }, { dataUrl, blue: BLUE, size });
    return Buffer.from(out.split(',')[1], 'base64');
}

const original = (name) => execFileSync('git', ['show', `${REF}:public/${name}`]);
for (const name of ICONS) {
    writeFileSync(join(OUT, name), await recolor(original(name)));
    console.log('✓', name);
}
const big = original('pwa-512x512.png');
const ico = pngToIco([{ size: 32, data: await recolor(big, 32) }, { size: 64, data: await recolor(big, 64) }]);
writeFileSync(join(OUT, 'favicon.ico'), ico);
console.log('✓ favicon.ico');
await browser.close();
