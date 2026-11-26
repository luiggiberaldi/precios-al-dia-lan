/**
 * imageFallback.js — Utilidad de resolución de imágenes con fallback local de catálogo.
 *
 * Resuelve las rutas de imagen de productos para garantizar que se vean OFFLINE
 * incluso si el registro de base de datos apunta a una URL remota de Supabase Storage,
 * y reescribe imágenes LAN (`/lan/images/...` o `http://<otra-ip>:47800/lan/images/...`)
 * contra la URL actual de la Caja Principal en cada equipo.
 */
import { getLanServerUrl } from '../lan/lanConfig';

/**
 * Extrae la ruta relativa `/lan/images/...` (incluyendo query `?v=...`) si el valor
 * corresponde a una imagen servida por la Caja Principal LAN.
 */
export function extractLanImagePath(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl) return null;
    if (rawUrl.startsWith('/lan/images/')) return rawUrl;
    if (/^https?:\/\//i.test(rawUrl)) {
        try {
            const parsed = new URL(rawUrl);
            if (parsed.pathname.startsWith('/lan/images/')) {
                return `${parsed.pathname}${parsed.search || ''}`;
            }
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Resuelve una imagen LAN contra la dirección actual de la Caja Principal.
 * Si no es una imagen LAN o no hay servidor LAN configurado, devuelve el valor intacto.
 */
export function resolveLanImageUrl(rawUrl, lanBaseUrl = null) {
    if (typeof rawUrl !== 'string' || !rawUrl) return rawUrl;
    const lanPath = extractLanImagePath(rawUrl);
    if (!lanPath) return rawUrl;
    const base = (lanBaseUrl ?? getLanServerUrl() ?? '').replace(/\/+$/, '');
    return base ? `${base}${lanPath}` : rawUrl;
}

/**
 * Devuelve la lista ordenada de candidatos a probar para una imagen de producto.
 * @param {string|object} imageOrProduct — URL de la imagen o el objeto de producto.
 * @returns {string[]} Array de URLs candidatas a probar secuencialmente.
 */
export function getProductImageCandidates(imageOrProduct) {
    const product = typeof imageOrProduct === 'object' && imageOrProduct !== null
        ? imageOrProduct
        : null;
    const rawImage = product
        ? (typeof product.image === 'string' && product.image ? product.image : product.image_path)
        : imageOrProduct;

    if (!rawImage || typeof rawImage !== 'string') return [];

    // Si es data: URI base64, no requiere fallback (ya está incrustada).
    if (rawImage.startsWith('data:')) return [rawImage];

    // Imagen servida por la Caja Principal LAN: resolver siempre con la IP/puerto actual
    // de este equipo (corrige URLs guardadas como 127.0.0.1 o IPs anteriores del router).
    if (extractLanImagePath(rawImage)) {
        const resolvedLan = resolveLanImageUrl(rawImage);
        return resolvedLan ? [resolvedLan] : [rawImage];
    }

    const candidates = [];
    const add = (value) => {
        if (typeof value === 'string' && value && !candidates.includes(value)) candidates.push(value);
    };
    const addLocalVariants = (value) => {
        if (typeof value !== 'string') return;
        const withoutQuery = value.split('?')[0];
        const filename = withoutQuery.split('/').pop();
        if (!filename) return;
        const slug = filename.replace(/\.(webp|jpg|jpeg|png|gif|svg)$/i, '');
        if (!slug) return;
        const directory = withoutQuery.slice(0, withoutQuery.lastIndexOf('/') + 1);
        ['jpg', 'png', 'webp'].forEach(extension => add(`${directory}${slug}.${extension}`));
    };

    // Preferir una copia del catálogo local evita que un enlace de Storage
    // obsoleto produzca un 404 visible antes de llegar al fallback.
    const localImagePath = product?.image_path;
    if (typeof localImagePath === 'string' && localImagePath.startsWith('/images/catalog/')) {
        add(localImagePath);
        addLocalVariants(localImagePath);
    }

    if (rawImage.startsWith('/images/catalog/')) {
        add(rawImage);
        addLocalVariants(rawImage);
    } else {
        const filename = rawImage.split('/').pop();
        if (filename) addLocalVariants(`/images/catalog/${filename}`);
    }

    // La URL original queda al final para conservar imágenes remotas válidas.
    add(rawImage);
    return candidates;
}
