#!/usr/bin/env node
/**
 * Logo de Precios al Día Nube a partir del logo de fábrica de Bodega:
 * el turquesa pasa a azul nube y el lema cambia por el de la nube.
 * Uso: node scripts/nube/generate-logo.mjs [--from <ref git>]  (usa el Chromium de Playwright)
 * Lee el original desde git (por defecto upstream/main) para poder regenerarlo siempre.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const fromIdx = process.argv.indexOf('--from');
const REF = fromIdx > 0 ? process.argv[fromIdx + 1] : 'upstream/main';
const TAGLINE = 'Nube · todas tus cajas en línea';

const variants = [
    { file: 'public/logo.png', blue: [43, 89, 195], text: '#1f1d1a' },
    { file: 'public/logodark.png', blue: [110, 168, 255], text: '#f2f0ec' },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const v of variants) {
    const original = execFileSync('git', ['show', `${REF}:${v.file}`]);
    const dataUrl = `data:image/png;base64,${original.toString('base64')}`;
    const out = await page.evaluate(async ({ dataUrl, blue, text, tagline }) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        const px = d.data;
        // Turquesa = verde y azul altos frente al rojo. Se recolorea conservando el alfa.
        for (let i = 0; i < px.length; i += 4) {
            const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
            if (a > 0 && g - r > 35 && b - r > 35) {
                px[i] = blue[0]; px[i + 1] = blue[1]; px[i + 2] = blue[2];
            }
        }
        ctx.putImageData(d, 0, 0);
        // Lema: se borra la franja inferior (último ~28 %) y se escribe el nuevo.
        const bandTop = Math.round(c.height * 0.72);
        ctx.clearRect(0, bandTop, c.width, c.height - bandTop);
        ctx.fillStyle = text;
        const size = Math.round((c.height - bandTop) * 0.78);
        ctx.font = `600 ${size}px "Work Sans", "Segoe UI", Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tagline, c.width / 2, bandTop + (c.height - bandTop) / 2);
        return c.toDataURL('image/png');
    }, { dataUrl, blue: v.blue, text: v.text, tagline: TAGLINE });
    writeFileSync(v.file, Buffer.from(out.split(',')[1], 'base64'));
    console.log('✓', v.file);
}
await browser.close();
