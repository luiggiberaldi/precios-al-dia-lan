#!/usr/bin/env node
/**
 * Sincroniza public/images/catalog/catalog.json con todos los archivos .webp
 * reales en disco dentro de public/images/catalog/ (raíz y subcarpetas).
 *
 * - Conserva nombre, categoría y tienda origen de las entradas existentes.
 * - Repara image_path cuando el archivo se movió a una subcarpeta o a la raíz.
 * - Incorpora todas las fotos .webp presentes en disco que no estaban en el JSON.
 */
import fs from 'node:fs';
import path from 'node:path';

const catalogDir = path.resolve(process.cwd(), 'public', 'images', 'catalog');
const catalogJsonPath = path.join(catalogDir, 'catalog.json');

const CATEGORY_LABELS = {
    'aseo-del-hogar': 'Aseo del Hogar',
    'carnes-y-proteinas': 'Carnes y Proteínas',
    'electricidad-y-pilas': 'Electricidad y Pilas',
    'frutas-y-verduras': 'Frutas y Verduras',
    'granos-pastas-y-harinas': 'Granos, Pastas y Harinas',
    'higiene-y-belleza': 'Higiene y Belleza',
    'lacteos-y-huevos': 'Lácteos y Huevos',
    mascotas: 'Mascotas',
    varios: 'Varios',
    'viveres-y-despensa': 'Víveres y Despensa',
};

const LOWERCASE_CONNECTORS = new Set(['de', 'del', 'la', 'el', 'las', 'los', 'y', 'en', 'con', 'para', 'por', 'a', 'al']);

function humanizeSlug(slug) {
    const parts = String(slug || '').split('-').filter(Boolean);
    return parts
        .map((word, index) => {
            if (/^\d+(?:g|gr|kg|ml|l|lt|oz|und|uds|w|v)$/i.test(word)) {
                return word
                    .replace(/kg$/i, 'Kg')
                    .replace(/ml$/i, 'ml')
                    .replace(/lt$/i, 'Lt')
                    .replace(/l$/i, 'L')
                    .replace(/gr?$/i, 'g')
                    .replace(/und$/i, 'Und');
            }
            if (index > 0 && LOWERCASE_CONNECTORS.has(word)) return word;
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(' ');
}

function collectDiskWebps(dir) {
    const bySlug = new Map();
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.webp')) {
                const slug = entry.name.slice(0, -5).toLowerCase();
                const relFromCatalog = path.relative(catalogDir, full).replace(/\\/g, '/');
                const webPath = `/images/catalog/${relFromCatalog}`;
                const folder = relFromCatalog.includes('/') ? relFromCatalog.split('/')[0] : '';
                const existing = bySlug.get(slug);
                // Preferir ruta en subcarpeta categorizada si el archivo está duplicado en raíz y subcarpeta.
                if (!existing || (!existing.folder && folder)) {
                    bySlug.set(slug, { slug, image_path: webPath, folder });
                }
            }
        }
    };
    walk(catalogDir);
    return bySlug;
}

const diskBySlug = collectDiskWebps(catalogDir);
const existingRaw = fs.existsSync(catalogJsonPath)
    ? JSON.parse(fs.readFileSync(catalogJsonPath, 'utf8'))
    : [];

const out = [];
const seenSlugs = new Set();
let repaired = 0;
let added = 0;
let droppedMissing = 0;

for (const item of existingRaw) {
    const slug = String(item.slug || '').toLowerCase().trim();
    if (!slug || seenSlugs.has(slug)) continue;
    const diskEntry = diskBySlug.get(slug);
    const currentFileExists = item.image_path
        && fs.existsSync(path.resolve(process.cwd(), 'public', item.image_path.replace(/^\/+/, '')));

    if (!currentFileExists && !diskEntry) {
        droppedMissing += 1;
        continue;
    }

    const resolvedPath = currentFileExists ? item.image_path : diskEntry.image_path;
    if (resolvedPath !== item.image_path) repaired += 1;

    seenSlugs.add(slug);
    out.push({
        name: item.name || humanizeSlug(slug),
        slug,
        price: item.price ?? 0,
        category: item.category || CATEGORY_LABELS[diskEntry?.folder] || 'General',
        image_path: resolvedPath,
        source_store: item.source_store || 'Catálogo Local',
    });
}

for (const [slug, diskEntry] of [...diskBySlug.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    added += 1;
    out.push({
        name: humanizeSlug(slug),
        slug,
        price: 0,
        category: CATEGORY_LABELS[diskEntry.folder] || 'General',
        image_path: diskEntry.image_path,
        source_store: 'Catálogo Local',
    });
}

fs.writeFileSync(catalogJsonPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.info(`[sync-catalog-index] Total=${out.length} | Reparadas=${repaired} | Nuevas indexadas=${added} | Sin archivo=${droppedMissing}`);
