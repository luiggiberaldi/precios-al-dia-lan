/**
 * productImageMatcher.js — Motor puro de normalización, sinónimos venezolanos y
 * puntuación de relevancia para búsqueda automática de fotos de productos.
 *
 * Nota: reside en `src/utils/` (sujeto a guardrails ESLint: sin Math.round,
 * Math.ceil, Math.floor, toFixed ni parseFloat; solo aritmética entera limpia).
 */

export const CUSTOM_PRODUCT_MAPPINGS = {
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
    'DIABLITOS': 'diablitos underwood',
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
    'PRESTOBALBA': 'afeitadora dorco',
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

/**
 * Normaliza texto preservando letras latinas sin tildes (ñ -> n, á -> a)
 * y colapsando siglas con puntos (P.A.N. -> pan) y medidas separadas (1 kg -> 1kg).
 */
export function normalizeSearchText(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        // Siglas con puntos: p.a.n. -> pan
        .replace(/\b([a-z])\.(?=[a-z]\b)/g, '$1')
        .replace(/\./g, ' ')
        // Unir número + unidad separada: "1 kg" -> "1kg", "500 gr" -> "500g", "2 lt" -> "2l"
        .replace(/\b(\d+)\s*(kg|kilo|kilos)\b/g, '$1kg')
        .replace(/\b(\d+)\s*(grs?|gramos?)\b/g, '$1g')
        .replace(/\b(\d+)\s*(lts?|litros?)\b/g, '$1l')
        .replace(/\b(\d+)\s*(ml|cc)\b/g, '$1ml')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function toProductSlug(raw) {
    const clean = normalizeSearchText(raw);
    return clean ? clean.replace(/\s+/g, '-') : '';
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

/**
 * Extrae tokens semánticos principales (`coreTokens`) y tokens de medida (`sizeTokens`).
 */
export function extractSearchTokens(rawQuery) {
    const baseClean = normalizeSearchText(rawQuery);
    if (!baseClean) {
        return { normalized: '', expanded: '', slug: '', coreTokens: [], sizeTokens: [] };
    }

    const upperKey = baseClean.toUpperCase();
    let expanded = CUSTOM_PRODUCT_MAPPINGS[upperKey]
        ? normalizeSearchText(CUSTOM_PRODUCT_MAPPINGS[upperKey])
        : baseClean;

    // Corregir errores de tipeo frecuentes palabra por palabra
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
        if (/^\d+$/.test(tok)) continue;
        if (tok.length < 2) continue;
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

function stemSpanishPlural(word) {
    if (word.length >= 5 && word.endsWith('es') && !word.endsWith('tes')) {
        return word.slice(0, -2);
    }
    if (word.length >= 4 && word.endsWith('s')) {
        return word.slice(0, -1);
    }
    return word;
}

/**
 * Calcula un puntaje entero determinista entre una consulta ya tokenizada y un candidato.
 * Devuelve 0 si no hay coincidencia real de producto.
 */
export function scoreProductCandidate(queryInfo, candidate) {
    const q = typeof queryInfo === 'string' ? extractSearchTokens(queryInfo) : queryInfo;
    if (!q || (q.coreTokens.length === 0 && q.sizeTokens.length === 0)) return 0;

    const titleRaw = candidate?.name || candidate?.title || '';
    const slugRaw = candidate?.slug || candidate?.id || '';
    const tagsRaw = Array.isArray(candidate?.tags) ? candidate.tags.join(' ') : '';

    const candidateNorm = normalizeSearchText(`${titleRaw} ${slugRaw.replace(/-/g, ' ')} ${tagsRaw}`);
    if (!candidateNorm) return 0;

    const candidateSlug = toProductSlug(slugRaw || titleRaw);
    const rawWords = candidateNorm.split(' ').map(canonicalizeUnitToken).filter(Boolean);
    const wordSet = new Set(rawWords);
    const stemSet = new Set(rawWords.map(stemSpanishPlural));

    let score = 0;
    let matchedCore = 0;

    if (q.slug && candidateSlug === q.slug) {
        score += 120;
    }

    const titleWords = normalizeSearchText(titleRaw).split(' ').filter(Boolean);
    const firstWord = titleWords[0] || '';

    for (const token of q.coreTokens) {
        const tokenStem = stemSpanishPlural(token);

        if (wordSet.has(token) || (token.length >= 4 && stemSet.has(tokenStem))) {
            matchedCore += 1;
            score += 30;
            if (firstWord === token || stemSpanishPlural(firstWord) === tokenStem) {
                score += 8;
            }
            continue;
        }

        // Palabras cortas (<= 3 chars: "pan", "sal", "ron", "sol", "7up") exigen palabra exacta
        // para jamás confundir "pan" con "empanada" o "pantene".
        if (token.length <= 3) {
            continue;
        }

        const partialHit = rawWords.some(
            (cw) => cw.length >= 4 && (cw.startsWith(token) || token.startsWith(cw)),
        );
        if (partialHit) {
            matchedCore += 1;
            score += 18;
        }
    }

    // Sin coincidencia en palabras principales del producto → descartar por completo.
    if (q.coreTokens.length > 0 && matchedCore === 0) {
        return 0;
    }

    // Si hay múltiples palabras clave (ej. "harina pan" o "mayonesa mavesa") y solo
    // acertó una palabra genérica ("harina" en "harina de trigo"), penalizar vs cobertura total.
    if (q.coreTokens.length >= 2 && matchedCore === q.coreTokens.length) {
        score += 40;
    } else if (q.coreTokens.length >= 3 && matchedCore * 2 < q.coreTokens.length) {
        return 0;
    }

    // Desempate por presentación/medida ("1kg", "500g", "2l")
    for (const sz of q.sizeTokens) {
        if (wordSet.has(sz)) {
            score += 18;
        }
    }

    return score;
}

/**
 * Ordena, filtra y deduplica una lista de candidatos de imagen.
 */
export function rankImageCandidates(rawQuery, items, { limit = 6, minScore = 24 } = {}) {
    const queryInfo = extractSearchTokens(rawQuery);
    if (!queryInfo.normalized || !Array.isArray(items) || items.length === 0) return [];

    const scored = [];
    for (const item of items) {
        const imageUrl = item?.image_url || item?.image_path || item?.dataUri || item?.url || '';
        if (!imageUrl || typeof imageUrl !== 'string') continue;
        const score = scoreProductCandidate(queryInfo, item);
        if (score >= minScore) {
            scored.push({
                title: item.name || item.title || 'Producto',
                slug: item.slug || item.id || toProductSlug(item.name || item.title || ''),
                imageUrl,
                source: item.source || 'local',
                score,
                hasFullCoreMatch:
                    queryInfo.coreTokens.length > 0
                    && score >= queryInfo.coreTokens.length * 30 + (queryInfo.coreTokens.length >= 2 ? 40 : 0),
            });
        }
    }

    scored.sort((a, b) => b.score - a.score || a.title.length - b.title.length);

    const unique = [];
    const seenKeys = new Set();
    for (const entry of scored) {
        const dedupKey = entry.slug || entry.imageUrl;
        if (seenKeys.has(dedupKey) || seenKeys.has(entry.imageUrl)) continue;
        seenKeys.add(dedupKey);
        seenKeys.add(entry.imageUrl);
        unique.push(entry);
        if (unique.length >= limit) break;
    }

    return unique;
}

/**
 * Valida que una URL externa para el proxy de imágenes sea pública (HTTP/HTTPS)
 * y bloquea direcciones privadas, loopback o metadatos cloud (anti-SSRF).
 */
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
        const [, aStr, bStr] = ipv4;
        const a = Number(aStr);
        const b = Number(bStr);
        if (a === 10 || a === 127 || a === 0) return false;
        if (a === 169 && b === 254) return false;
        if (a === 192 && b === 168) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
    }
    return true;
}
