/**
 * productImageSearchService.js — Cliente unificado de búsqueda y compresión de
 * fotos automáticas para productos (Caja Local, Red LAN, Electron `.exe`, PWA y Supervisor).
 *
 * Resuelve automáticamente:
 *  1. Rutas del servidor LAN (`http://<ip>:47800/api/search-image`) cuando opera en red local o Electron `file://`.
 *  2. Rutas web estándar (`/api/search-image`) en Vercel / Dev.
 *  3. Fallback 100% local en navegador/Electron leyendo `images/catalog/catalog.json` si no hay servidor disponible.
 *  4. Descarga por proxy + compresión a `data:image/webp` (400px) al elegir cualquier opción,
 *     evitando hotlinking externo y garantizando visualización sin internet en todas las cajas.
 */
import { getLanServerUrl } from '../lan/lanConfig';
import { rankImageCandidates } from '../utils/productImageMatcher';

let browserCatalogCache = null;

function isFileProtocol() {
    return typeof window !== 'undefined' && window.location?.protocol === 'file:';
}

/**
 * Devuelve la base de API (`http://127.0.0.1:47800`, `http://192.168.x.x:47800` o `''`).
 */
export function resolveImageApiBaseUrl() {
    const lanBase = getLanServerUrl();
    if (lanBase) return lanBase.replace(/\/+$/, '');
    if (isFileProtocol()) return 'http://127.0.0.1:47800';
    return '';
}

/**
 * Convierte una ruta `/images/catalog/...` en una URL cargable en cualquier entorno
 * (incluyendo `file://` en Electron o cajas secundarias LAN).
 */
export function resolveCatalogAssetUrl(assetPath) {
    if (!assetPath || typeof assetPath !== 'string') return assetPath;
    if (!assetPath.startsWith('/images/catalog/')) return assetPath;
    const lanBase = getLanServerUrl();
    if (lanBase) return `${lanBase.replace(/\/+$/, '')}${assetPath}`;
    if (isFileProtocol()) return `.${assetPath}`;
    return assetPath;
}

function isSameOriginOrStorageUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:') || rawUrl.startsWith('/') || rawUrl.startsWith('./')) {
        return true;
    }
    const lanBase = getLanServerUrl();
    if (lanBase && rawUrl.startsWith(lanBase)) return true;
    if (/\.supabase\.co\/storage\/v1\/object\/public\//i.test(rawUrl)) return true;
    if (typeof window !== 'undefined' && window.location?.origin && rawUrl.startsWith(window.location.origin)) {
        return true;
    }
    return false;
}

/**
 * Construye la URL segura para previsualizar miniaturas en la galería sin errores CORS.
 */
export function buildMatchPreviewUrl(rawUri) {
    if (!rawUri || typeof rawUri !== 'string') return '';
    if (rawUri.startsWith('/images/catalog/')) {
        return resolveCatalogAssetUrl(rawUri);
    }
    if (isSameOriginOrStorageUrl(rawUri)) {
        return rawUri;
    }
    const apiBase = resolveImageApiBaseUrl();
    return `${apiBase}/api/image-proxy?url=${encodeURIComponent(rawUri)}`;
}

async function loadBrowserLocalCatalog(fetchImpl = globalThis.fetch) {
    if (browserCatalogCache) return browserCatalogCache;
    const candidates = [];
    const lanBase = getLanServerUrl();
    if (lanBase) candidates.push(`${lanBase.replace(/\/+$/, '')}/images/catalog/catalog.json`);
    if (isFileProtocol()) candidates.push('./images/catalog/catalog.json');
    candidates.push('/images/catalog/catalog.json');

    for (const url of candidates) {
        try {
            const res = await fetchImpl(url, { cache: 'force-cache' });
            if (res.ok) {
                const json = await res.json();
                if (Array.isArray(json) && json.length > 0) {
                    browserCatalogCache = json;
                    return json;
                }
            }
        } catch { /* probar siguiente ruta */ }
    }
    return [];
}

function decorateMatches(matches) {
    if (!Array.isArray(matches)) return [];
    return matches
        .filter((m) => m && m.dataUri)
        .map((m) => ({
            title: m.title || 'Opción',
            dataUri: m.dataUri,
            previewUrl: m.previewUrl || buildMatchPreviewUrl(m.dataUri),
            source: m.source || (String(m.dataUri).startsWith('/images/catalog/') ? 'local' : 'cloud'),
            provider: m.provider || undefined,
        }));
}

/**
 * Busca fotos para un nombre de producto usando el endpoint activo y cae al catálogo
 * local embebido si la app está completamente offline o sin servidor.
 */
export async function searchProductImages(productName, { fetchImpl = globalThis.fetch } = {}) {
    const trimmed = String(productName || '').trim();
    if (trimmed.length < 2) return [];

    const apiBase = resolveImageApiBaseUrl();
    const endpoint = `${apiBase}/api/search-image?q=${encodeURIComponent(trimmed)}`;

    try {
        const res = await fetchImpl(endpoint);
        if (res.ok) {
            const data = await res.json();
            if (data?.success && Array.isArray(data.matches) && data.matches.length > 0) {
                return decorateMatches(data.matches);
            }
        }
    } catch {
        /* Caer a búsqueda local offline en navegador/Electron */
    }

    // Fallback offline directo en cliente contra catalog.json
    const localCatalog = await loadBrowserLocalCatalog(fetchImpl);
    if (localCatalog.length === 0) return [];
    const ranked = rankImageCandidates(trimmed, localCatalog, { limit: 6 });
    return decorateMatches(
        ranked.map((r) => ({
            title: r.title,
            dataUri: r.imageUrl,
            source: 'local',
        })),
    );
}

/**
 * Comprime cualquier fuente cargable a `data:image/webp` (máx 400px) mediante Canvas.
 */
export function compressImageSourceToWebp(imageSrc, { maxSize = 400, quality = 0.75 } = {}) {
    return new Promise((resolve, reject) => {
        if (typeof Image === 'undefined' || typeof document === 'undefined') {
            resolve(imageSrc);
            return;
        }
        const img = new Image();
        if (!String(imageSrc).startsWith('data:')) {
            img.crossOrigin = 'anonymous';
        }
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                let width = img.naturalWidth || img.width || maxSize;
                let height = img.naturalHeight || img.height || maxSize;
                if (width > height) {
                    if (width > maxSize) {
                        height = Math.round((height * maxSize) / width);
                        width = maxSize;
                    }
                } else if (height > maxSize) {
                    width = Math.round((width * maxSize) / height);
                    height = maxSize;
                }
                canvas.width = Math.max(1, width);
                canvas.height = Math.max(1, height);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/webp', quality));
            } catch (err) {
                reject(err);
            }
        };
        img.onerror = () => reject(new Error('No se pudo decodificar la imagen seleccionada'));
        img.src = imageSrc;
    });
}

function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('No se pudo leer los bytes de la imagen'));
        reader.readAsDataURL(blob);
    });
}

/**
 * Convierte cualquier foto elegida (catálogo local, URL externa web o enlace pegado)
 * en un `data:image/webp;base64,...` liviano y listo para guardar offline en LAN o Nube.
 */
export async function resolveImageChoiceToDataUri(rawUrlOrDataUri, { fetchImpl = globalThis.fetch } = {}) {
    const src = String(rawUrlOrDataUri || '').trim();
    if (!src) throw new Error('No se recibió ninguna imagen');

    // 1. Ya es data URI: solo comprimir a WebP 400px
    if (src.startsWith('data:')) {
        return compressImageSourceToWebp(src).catch(() => src);
    }

    // 2. Imagen del catálogo local o mismo origen / Storage con CORS habilitado
    if (src.startsWith('/images/catalog/') || src.startsWith('./images/catalog/') || isSameOriginOrStorageUrl(src)) {
        const resolvedLocal = src.startsWith('/images/catalog/') ? resolveCatalogAssetUrl(src) : src;
        try {
            const res = await fetchImpl(resolvedLocal);
            if (res.ok) {
                const blob = await res.blob();
                const base64 = await blobToDataUri(blob);
                return await compressImageSourceToWebp(base64);
            }
        } catch {
            /* Intentar carga directa en Image/Canvas */
        }
        return compressImageSourceToWebp(resolvedLocal);
    }

    // 3. URL externa (supermercado web / enlace pegado): descargar por proxy anti-CORS
    const apiBase = resolveImageApiBaseUrl();
    const proxyUrl = `${apiBase}/api/image-proxy?url=${encodeURIComponent(src)}&format=json`;
    const res = await fetchImpl(proxyUrl);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success || !data?.dataUri) {
        throw new Error(data?.error || 'No se pudo descargar la imagen externa');
    }
    return compressImageSourceToWebp(data.dataUri);
}
