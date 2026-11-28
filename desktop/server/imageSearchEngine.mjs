/**
 * Motor backend unificado de búsqueda y proxy de fotos de productos (3 capas):
 *
 *  Capa 1 (0 ms, 100% sin internet): Catálogo local `catalog.json` (1.143 fotos .webp).
 *  Capa 2 (~150 ms, nube curada): Tabla `product_images_catalog` en Supabase vía REST.
 *  Capa 3 (~600 ms, web abierta sin Chromium): InstaMarket VE (WooCommerce Store API),
 *         OpenFoodFacts JSON y Bing Images HTML ligero — solo si Capas 1 y 2 no cubren
 *         el producto buscado.
 *
 * Cero dependencias npm externas: funciona idéntico dentro de `app.asar` (Electron LAN),
 * en el servidor de desarrollo Vite y en funciones serverless de Vercel (`api/`).
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_PROXY_IMAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_WEB_TIMEOUT_MS = 4500;
const DEFAULT_PROXY_TIMEOUT_MS = 8000;
const WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CUSTOM_PRODUCT_MAPPINGS = {
    TRIFOGON: 'trifogon chupeta',
    'TOM GUAYABANA': 'dulce tom guayabana',
    'TOM PLATANO': 'dulce tom platano',
    'ALISOFT PAPEL': 'papel higienico alisoft',
    EURO: 'papel euro',
    'BAMBOO 4 ROLLO': 'papel bamboo',
    'BAMBOO UNIDA': 'papel bamboo',
    'LA PAMPA': 'margarina pampa',
    'AURORA SOYA': 'aceite aurora soya',
    'DONA TITA VINAGRE': 'vinagre dona tita',
    'CAPRI SALSA': 'salsa capri',
    KETCHUP: 'salsa ketchup',
    'PAZCUM SALSA': 'salsa pazcum',
    'SARDINES OIL': 'sardinas aceite',
    TWISTI: 'twisti',
    'DIABLITO UNDER': 'diablito underwood',
    DIABLITOS: 'diablitos underwood',
    'BLANCA FLOR LEUDANTE': 'harina trigo blanca flor leudante',
    'BLANCA FLOR TODO': 'harina trigo blanca flor todo uso',
    'KONFIT AZUCAR': 'azucar konfit',
    'RONCO CORTA PLUMA 500 GR': 'pasta pluma ronco 500g',
    'MARY PASTA PLUMA 500 GR': 'pasta pluma mary 500g',
    'SAN SIMON LECHE 400GR': 'leche polvo san simon 400g',
    'ARROZ MARY SUPERIOR': 'arroz mary superior',
    'ARROZ MARY PREMIUM': 'arroz mary dorado',
    'DONA BELEN': 'dona belen',
    'PRIMOR PASTA LARGA': 'pasta larga primor',
    'MARY PASTA LARGA PREMIUM 500G': 'pasta larga mary 500g',
    'SAL PROSANCA': 'sal prosanca',
    'CAFE LA PROTECTORA 100GR': 'cafe protectora 100g',
    'CAFE LA PROTECTORA 200GR': 'cafe protectora 200g',
    'ALIVE DETERGENTE POLVO 400GR': 'detergente polvo alive 400g',
    'AVENA 400GR GRAVENCA': 'avena gravenca 400g',
    'JUMBY RIKO': 'jumby',
    'BUEN ARROZ 900GR': 'buen arroz 900g',
    'HARINA BUDARE': 'harina maiz budare',
    'HARINA MARY 900G': 'harina maiz mary 900g',
    'HARINA PAN': 'harina maiz pan',
    'HARINA PAN 1KG': 'harina maiz pan 1kg',
    'HARINA PAN AMARILLA': 'harina maiz amarillo pan',
    'WYNCON BUZZY': 'buzzy',
    'JABON ANITA': 'jabon anita',
    'LA LLAVES JABON': 'jabon las llaves',
    'LAS LLAVES': 'jabon las llaves',
    'BON BON SURTIDO': 'bon bon bum',
    'CARAMELO CAFE': 'caramelo cafe',
    'TOALLAS WANITA': 'toallas sanitarias wanita',
    'PRESTOBALBA DORCO AZUL ROSADA': 'afeitadora dorco',
    PRESTOBALBA: 'afeitadora dorco',
    'GALLETAS MARIA ALIVAL': 'galletas maria alival',
    'MIMLOT JABON': 'jabon mimlot',
    'MAVESA MARGARINA MANTEQUILLA': 'margarina mavesa',
    'MAYONESAMAVESA 500G': 'mayonesa mavesa 500g',
    'MAYONES MAVESA 175G': 'mayonesa mavesa 175g',
    'JUSTY DURAZNO 400L': 'refresco justy durazno',
    'JUSTY MANZANA 400L': 'refresco justy manzana',
    'GLUP COLA 2L': 'refresco glup cola 2l',
    'GLUP SABORES 1L': 'refresco glup 1l',
    'GLUP COLA 400L': 'refresco glup cola',
    'CIGARRO CONSUL PAQ': 'cigarrillos consul',
    'CIGARRO VICEBOY PAQ': 'cigarrillos viceroy',
    'CHEESKING 50G': 'cheeseking',
    'CREMA ALIDENT AZUL': 'crema dental alident',
    'SUAVITETWL 180ML': 'suavizante suavitel',
    'AGUA COLL 1 5L': 'agua mineral coll',
    'AGUA COLL 600M': 'agua mineral coll',
    'GALLETA COCO RANCH': 'galleta coco ranch',
    'GALLETA ANIMALITOS': 'galletas animalitos',
    'GALLETA SODA': 'galleta soda puig',
    'GALLETA CLUB SOCIAL': 'galleta club social',
    'LECHE DOBON 120G': 'leche polvo dobon',
    'PALITO DANIBISK': 'palitos danibisk',
    'FLIPS 120GR CHOCO': 'cereal flips chocolate 120g',
    'FLIPS 120GR DULCE': 'cereal flips dulce de leche 120g',
    'TIP TOP CHOCO': 'galleta tip top',
    'GALLETA INDEPENDENCIA': 'galleta maria independencia',
    'GALLETA DANINBISK': 'galleta danibisk',
    'OREO TUBO': 'galleta oreo',
    'RAQUETY PICANTE': 'raquety picante',
    'CHEESE TRIS 4G': 'cheese tris',
    'CHISKESITOS 45G': 'chiskesitos',
    'TOSTON TOM 80G': 'toston tom',
    'ESPONJA AMARILLA': 'esponja fregar',
    'HUEVOS TIPO A UND': 'huevos carton',
    'MANTEQUILLA NELLY 250G': 'margarina nelly 250g',
    'DESIFENTANTE 1LT': 'desinfectante 1l',
};

const STOPWORDS = new Set([
    'de', 'del', 'la', 'el', 'las', 'los', 'y', 'e', 'o', 'u', 'en', 'con',
    'sin', 'para', 'por', 'al', 'un', 'una', 'unos', 'unas',
    'und', 'unid', 'unida', 'unidad', 'unidades', 'uds',
    'paq', 'paque', 'paquete', 'bulto', 'caja', 'lote', 'sobre', 'bolsa',
    'tipo', 'producto', 'marca',
]);

const INLINE_TYPOS = {
    mayonesamavesa: 'mayonesa mavesa',
    mayones: 'mayonesa',
    suavitetwl: 'suavitel',
    desifentante: 'desinfectante',
    prestobalba: 'afeitadora',
    daninbisk: 'danibisk',
    cheesking: 'cheeseking',
};

export function normalizeSearchText(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\b([a-z])\.(?=[a-z]\b)/g, '$1')
        .replace(/\./g, ' ')
        .replace(/\b(\d+)\s*(kg|kilo|kilos)\b/g, '$1kg')
        .replace(/\b(\d+)\s*(grs?|gramos?)\b/g, '$1g')
        .replace(/\b(\d+)\s*(lts?|litros?)\b/g, '$1l')
        .replace(/\b(\d+)\s*(ml|cc)\b/g, '$1ml')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function canonicalizeUnitToken(token) {
    if (/^\d+grs?$/.test(token)) return token.replace(/grs?$/, 'g');
    if (/^\d+lts?$/.test(token)) return token.replace(/lts?$/, 'l');
    if (/^\d+cc$/.test(token)) return token.replace(/cc$/, 'ml');
    if (token === '1000g') return '1kg';
    if (token === '1000ml') return '1l';
    return token;
}

function isMeasureToken(token) {
    return /^\d+(?:g|kg|ml|l|oz|w|v)$/.test(token);
}

function stemSpanishPlural(word) {
    if (word.length >= 5 && word.endsWith('es') && !word.endsWith('tes')) {
        return word.slice(0, -2);
    }
    if (word.length >= 4 && word.endsWith('s')) {
        return word.slice(0, -1);
    }
    return word;
}

export function extractSearchTokens(rawQuery) {
    const baseClean = normalizeSearchText(rawQuery);
    if (!baseClean) {
        return { normalized: '', expanded: '', slug: '', coreTokens: [], sizeTokens: [] };
    }
    const upperKey = baseClean.toUpperCase();
    let expanded = CUSTOM_PRODUCT_MAPPINGS[upperKey]
        ? normalizeSearchText(CUSTOM_PRODUCT_MAPPINGS[upperKey])
        : baseClean;
    expanded = expanded
        .split(' ')
        .map((w) => INLINE_TYPOS[w] || w)
        .join(' ');

    const rawTokens = expanded.split(' ').map(canonicalizeUnitToken).filter(Boolean);
    const coreTokens = [];
    const sizeTokens = [];
    const seenCore = new Set();
    const seenSize = new Set();

    for (const tok of rawTokens) {
        if (STOPWORDS.has(tok)) continue;
        if (isMeasureToken(tok)) {
            if (!seenSize.has(tok)) {
                seenSize.add(tok);
                sizeTokens.push(tok);
            }
            continue;
        }
        if (/^\d+$/.test(tok) || tok.length < 2) continue;
        if (!seenCore.has(tok)) {
            seenCore.add(tok);
            coreTokens.push(tok);
        }
    }

    return {
        normalized: baseClean,
        expanded,
        slug: expanded.replace(/\s+/g, '-'),
        coreTokens,
        sizeTokens,
    };
}

export function scoreProductCandidate(queryInfo, candidate) {
    const q = typeof queryInfo === 'string' ? extractSearchTokens(queryInfo) : queryInfo;
    if (!q || (q.coreTokens.length === 0 && q.sizeTokens.length === 0)) return 0;

    const titleRaw = candidate?.name || candidate?.title || '';
    const slugRaw = candidate?.slug || candidate?.id || '';
    const tagsRaw = Array.isArray(candidate?.tags) ? candidate.tags.join(' ') : '';

    const candidateNorm = normalizeSearchText(`${titleRaw} ${slugRaw.replace(/-/g, ' ')} ${tagsRaw}`);
    if (!candidateNorm) return 0;

    const candidateSlug = normalizeSearchText(slugRaw || titleRaw).replace(/\s+/g, '-');
    const rawWords = candidateNorm.split(' ').map(canonicalizeUnitToken).filter(Boolean);
    const wordSet = new Set(rawWords);
    const stemSet = new Set(rawWords.map(stemSpanishPlural));

    let score = 0;
    let matchedCore = 0;

    if (q.slug && candidateSlug === q.slug) score += 120;

    const titleWords = normalizeSearchText(titleRaw).split(' ').filter(Boolean);
    const firstWord = titleWords[0] || '';

    for (const token of q.coreTokens) {
        const tokenStem = stemSpanishPlural(token);
        if (wordSet.has(token) || (token.length >= 4 && stemSet.has(tokenStem))) {
            matchedCore += 1;
            score += 30;
            if (firstWord === token || stemSpanishPlural(firstWord) === tokenStem) score += 8;
            continue;
        }
        if (token.length <= 3) continue;
        const partialHit = rawWords.some(
            (cw) => cw.length >= 4 && (cw.startsWith(token) || token.startsWith(cw)),
        );
        if (partialHit) {
            matchedCore += 1;
            score += 18;
        }
    }

    if (q.coreTokens.length > 0 && matchedCore === 0) return 0;
    if (q.coreTokens.length >= 2 && matchedCore === q.coreTokens.length) score += 40;
    else if (q.coreTokens.length >= 3 && matchedCore * 2 < q.coreTokens.length) return 0;

    for (const sz of q.sizeTokens) {
        if (wordSet.has(sz)) score += 18;
    }

    return score;
}

export function isSafePublicHttpUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    let parsed;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return false;
    if (
        host === 'localhost'
        || host === '0.0.0.0'
        || host === '::1'
        || host.startsWith('fe80:')
        || host.startsWith('fc')
        || host.startsWith('fd')
        || host.endsWith('.local')
        || host.endsWith('.internal')
        || host.endsWith('.localhost')
    ) {
        return false;
    }
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const a = Number(ipv4[1]);
        const b = Number(ipv4[2]);
        if (a === 10 || a === 127 || a === 0) return false;
        if (a === 169 && b === 254) return false;
        if (a === 192 && b === 168) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
    }
    return true;
}

const catalogCacheByPath = new Map();

function resolveCatalogJsonPath(staticDir) {
    const candidates = [];
    if (staticDir) {
        candidates.push(path.join(staticDir, 'images', 'catalog', 'catalog.json'));
    }
    candidates.push(
        path.resolve(process.cwd(), 'public', 'images', 'catalog', 'catalog.json'),
        path.resolve(process.cwd(), 'dist', 'images', 'catalog', 'catalog.json'),
        path.resolve(process.cwd(), 'desktop', 'dist-web', 'images', 'catalog', 'catalog.json'),
    );
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch { /* continuar */ }
    }
    return null;
}

export function loadLocalCatalogEntries(staticDir = null) {
    const targetPath = resolveCatalogJsonPath(staticDir);
    if (!targetPath) return [];
    if (catalogCacheByPath.has(targetPath)) {
        return catalogCacheByPath.get(targetPath);
    }
    try {
        const raw = fs.readFileSync(targetPath, 'utf8');
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : [];
        catalogCacheByPath.set(targetPath, list);
        return list;
    } catch {
        return [];
    }
}

async function fetchJsonWithTimeout(url, { headers = {}, timeoutMs = DEFAULT_WEB_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, {
            method: 'GET',
            headers: { 'User-Agent': WEB_USER_AGENT, Accept: 'application/json', ...headers },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchTextWithTimeout(url, { headers = {}, timeoutMs = DEFAULT_WEB_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, {
            method: 'GET',
            headers: {
                'User-Agent': WEB_USER_AGENT,
                'Accept-Language': 'es-VE,es;q=0.9,en;q=0.7',
                ...headers,
            },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Capa 2: consulta ligera vía PostgREST a `product_images_catalog` en Supabase.
 */
async function searchSupabaseCatalog(queryInfo, { supabaseUrl, supabaseKey, fetchImpl = globalThis.fetch, timeoutMs = 2800 } = {}) {
    if (!supabaseUrl || !supabaseKey) return [];
    const base = String(supabaseUrl).replace(/\/+$/, '');
    const headers = {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
    };

    const results = [];
    if (queryInfo.slug) {
        const exactUrl = `${base}/rest/v1/product_images_catalog?select=id,name,image_url,tags&id=eq.${encodeURIComponent(queryInfo.slug)}&limit=1`;
        const exactRows = await fetchJsonWithTimeout(exactUrl, { headers, timeoutMs, fetchImpl });
        if (Array.isArray(exactRows)) {
            for (const r of exactRows) {
                if (r?.image_url) results.push({ ...r, source: 'cloud' });
            }
        }
    }

    const tagWords = queryInfo.coreTokens.filter((w) => w.length >= 3);
    if (tagWords.length > 0) {
        const pgArray = `{${tagWords.map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean).join(',')}}`;
        const overlapUrl = `${base}/rest/v1/product_images_catalog?select=id,name,image_url,tags&tags=ov.${encodeURIComponent(pgArray)}&limit=25`;
        const rows = await fetchJsonWithTimeout(overlapUrl, { headers, timeoutMs, fetchImpl });
        if (Array.isArray(rows)) {
            for (const r of rows) {
                if (r?.image_url) results.push({ ...r, source: 'cloud' });
            }
        }
    }

    return results;
}

function decodeHtmlEntities(str) {
    return String(str || '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
}

/**
 * Capa 3A: Supermercado venezolano InstaMarket (API oficial JSON WooCommerce Store v1).
 */
async function searchInstaMarketVe(rawQuery, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_WEB_TIMEOUT_MS } = {}) {
    const q = encodeURIComponent(rawQuery.trim());
    const url = `https://instamarketca.com/wp-json/wc/store/v1/products?search=${q}&per_page=8`;
    const items = await fetchJsonWithTimeout(url, { fetchImpl, timeoutMs });
    if (!Array.isArray(items)) return [];
    const out = [];
    for (const item of items) {
        const img = item?.images?.[0]?.src || item?.images?.[0]?.thumbnail;
        if (img && isSafePublicHttpUrl(img)) {
            out.push({
                name: decodeHtmlEntities(item.name || '').trim(),
                slug: item.slug || '',
                image_url: img,
                source: 'web',
                provider: 'InstaMarket',
            });
        }
    }
    return out;
}

/**
 * Capa 3B: OpenFoodFacts API abierta (cobertura global y latinoamericana sin navegador).
 */
async function searchOpenFoodFacts(rawQuery, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_WEB_TIMEOUT_MS } = {}) {
    const q = encodeURIComponent(rawQuery.trim());
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=8&fields=product_name,product_name_es,brands,quantity,image_front_url,image_url`;
    const data = await fetchJsonWithTimeout(url, { fetchImpl, timeoutMs });
    if (!Array.isArray(data?.products)) return [];
    const out = [];
    for (const prod of data.products) {
        const img = prod?.image_front_url || prod?.image_url;
        const baseName = prod?.product_name_es || prod?.product_name || '';
        const brand = prod?.brands ? String(prod.brands).split(',')[0].trim() : '';
        const qty = prod?.quantity ? String(prod.quantity).trim() : '';
        const fullTitle = [baseName, brand && !baseName.toLowerCase().includes(brand.toLowerCase()) ? brand : '', qty]
            .filter(Boolean)
            .join(' ')
            .trim();
        if (img && fullTitle && isSafePublicHttpUrl(img)) {
            out.push({
                name: fullTitle,
                image_url: img,
                source: 'web',
                provider: 'OpenFoodFacts',
            });
        }
    }
    return out;
}

/**
 * Capa 3C: Bing Images HTML ligero (extracción de metadatos JSON embebidos en atributos m="...").
 */
async function searchBingImagesLight(rawQuery, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_WEB_TIMEOUT_MS } = {}) {
    const q = encodeURIComponent(`${rawQuery.trim()} producto empaque`);
    const url = `https://www.bing.com/images/search?q=${q}&form=HDRSC2`;
    const html = await fetchTextWithTimeout(url, { fetchImpl, timeoutMs });
    if (!html) return [];

    const out = [];
    const attrRegex = /\bm="([^"]{20,2500})"/g;
    let match;
    while ((match = attrRegex.exec(html)) !== null && out.length < 10) {
        try {
            const decoded = decodeHtmlEntities(match[1]);
            const meta = JSON.parse(decoded);
            const imgUrl = meta?.murl || meta?.turl;
            const title = String(meta?.t || meta?.desc || '').replace(/[\ue000-\uf8ff]/g, '').trim();
            if (
                imgUrl
                && title
                && isSafePublicHttpUrl(imgUrl)
                && !/\.(svg|gif)(\?|$)/i.test(imgUrl)
            ) {
                out.push({
                    name: title,
                    image_url: imgUrl,
                    source: 'web',
                    provider: 'Web',
                });
            }
        } catch { /* atributo no JSON */ }
    }
    return out;
}

/**
 * Orquesta las 3 capas y devuelve hasta `limit` opciones rankeadas y deduplicadas.
 */
export async function searchProductImagesMultiTier(
    rawQuery,
    {
        staticDir = null,
        localEntries = null,
        supabaseUrl = '',
        supabaseKey = '',
        enableWebFallback = true,
        fetchImpl = globalThis.fetch,
        limit = 6,
    } = {},
) {
    const trimmed = String(rawQuery || '').trim();
    if (trimmed.length < 2) return [];

    const queryInfo = extractSearchTokens(trimmed);
    if (!queryInfo.normalized) return [];

    const fullCoreScoreThreshold =
        queryInfo.coreTokens.length > 0
            ? queryInfo.coreTokens.length * 30 + (queryInfo.coreTokens.length >= 2 ? 40 : 0)
            : 30;

    const pool = [];

    // 1. Capa Local (instantánea, funciona sin internet)
    const catalogList = Array.isArray(localEntries) ? localEntries : loadLocalCatalogEntries(staticDir);
    for (const entry of catalogList) {
        const imgPath = entry?.image_path || entry?.image_url;
        if (!imgPath) continue;
        const score = scoreProductCandidate(queryInfo, entry);
        if (score >= 24) {
            pool.push({
                title: entry.name || 'Producto',
                slug: entry.slug || '',
                dataUri: imgPath,
                source: 'local',
                score,
            });
        }
    }

    pool.sort((a, b) => b.score - a.score);
    const strongLocalCount = pool.filter((x) => x.score >= fullCoreScoreThreshold).length;

    // 2. Capa Nube Curada (si faltan opciones fuertes y hay Supabase configurado)
    if (strongLocalCount < 3 && supabaseUrl && supabaseKey && typeof fetchImpl === 'function') {
        const cloudRows = await searchSupabaseCatalog(queryInfo, { supabaseUrl, supabaseKey, fetchImpl });
        for (const row of cloudRows) {
            const score = scoreProductCandidate(queryInfo, row);
            if (score >= 24) {
                pool.push({
                    title: row.name || 'Producto',
                    slug: row.id || '',
                    dataUri: row.image_url,
                    source: 'cloud',
                    score,
                });
            }
        }
    }

    pool.sort((a, b) => b.score - a.score);
    const strongCuratedCount = pool.filter((x) => x.score >= fullCoreScoreThreshold).length;

    // 3. Capa Web Abierta (solo si el producto no está bien cubierto en el catálogo curado)
    if (enableWebFallback && strongCuratedCount < 2 && typeof fetchImpl === 'function') {
        const settled = await Promise.allSettled([
            searchInstaMarketVe(trimmed, { fetchImpl }),
            searchOpenFoodFacts(trimmed, { fetchImpl }),
            searchBingImagesLight(trimmed, { fetchImpl }),
        ]);
        for (const res of settled) {
            if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
            for (const webItem of res.value) {
                const score = scoreProductCandidate(queryInfo, webItem);
                // Umbral levemente más estricto en web abierta para evitar ruido
                if (score >= 30) {
                    pool.push({
                        title: webItem.name || trimmed,
                        slug: webItem.slug || '',
                        dataUri: webItem.image_url,
                        source: 'web',
                        provider: webItem.provider || 'Web',
                        score: score - 3, // A igual puntaje, priorizar catálogo curado sobre web
                    });
                }
            }
        }
    }

    pool.sort((a, b) => b.score - a.score || a.title.length - b.title.length);

    const unique = [];
    const seenUrls = new Set();
    const seenSlugs = new Set();
    for (const candidate of pool) {
        const urlKey = candidate.dataUri;
        const slugKey = candidate.slug || normalizeSearchText(candidate.title).replace(/\s+/g, '-');
        if (seenUrls.has(urlKey)) continue;
        if (slugKey && candidate.source !== 'web' && seenSlugs.has(slugKey)) continue;
        seenUrls.add(urlKey);
        if (slugKey) seenSlugs.add(slugKey);
        unique.push({
            title: candidate.title,
            dataUri: candidate.dataUri,
            source: candidate.source,
            provider: candidate.provider || undefined,
        });
        if (unique.length >= limit) break;
    }

    return unique;
}

/**
 * Descarga de forma segura una imagen pública externa validando protocolo, IP pública,
 * tipo MIME (`image/*`) y tamaño máximo (`4 MB`).
 */
export async function fetchExternalImageSafe(
    targetUrl,
    { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PROXY_TIMEOUT_MS, maxBytes = MAX_PROXY_IMAGE_BYTES } = {},
) {
    if (!isSafePublicHttpUrl(targetUrl)) {
        const err = new Error('URL de imagen no permitida o privada.');
        err.status = 400;
        throw err;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(targetUrl.trim(), {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'User-Agent': WEB_USER_AGENT,
                Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            },
            signal: controller.signal,
        });

        if (!res.ok) {
            const err = new Error(`El servidor de la imagen respondió HTTP ${res.status}`);
            err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
            throw err;
        }

        if (res.url && !isSafePublicHttpUrl(res.url)) {
            const err = new Error('Redirección hacia dirección privada bloqueada.');
            err.status = 403;
            throw err;
        }

        const rawContentType = (res.headers.get('content-type') || '').toLowerCase();
        const contentType = rawContentType.split(';')[0].trim() || 'image/jpeg';
        if (!contentType.startsWith('image/') || contentType.includes('svg')) {
            const err = new Error('El enlace no apunta a una foto válida (JPG, PNG o WebP).');
            err.status = 415;
            throw err;
        }

        const arrayBuf = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        if (!buffer.length || buffer.length > maxBytes) {
            const err = new Error('La imagen supera el tamaño máximo permitido (4 MB).');
            err.status = 413;
            throw err;
        }

        return {
            buffer,
            contentType,
            dataUri: `data:${contentType};base64,${buffer.toString('base64')}`,
        };
    } catch (err) {
        if (err?.name === 'AbortError' || controller.signal.aborted) {
            const timeoutErr = new Error('Tiempo de espera agotado descargando la imagen.');
            timeoutErr.status = 504;
            throw timeoutErr;
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
