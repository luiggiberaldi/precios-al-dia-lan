/**
 * presentations.js — Modelo puro y canónico de presentaciones (1, 2 o 3 niveles).
 *
 * REGLA DE ORO:
 *   - El inventario (`product.stock`) y las alertas (`lowStockAlert`) SIEMPRE se
 *     expresan en la unidad base indivisible (Nivel 1, factorToBase = 1), o en
 *     kg/L cuando el producto es a granel.
 *   - Las presentaciones superiores (Nivel 2 intermedio, Nivel 3 mayor) definen
 *     factores enteros acumulados contra esa base y controles independientes de
 *     venta (`sellable`), precio, costo derivado y código de barras propio.
 */

import { round0, round2, round4, round6, divR, mulR } from './dinero.js';
import { isGranelProduct } from './granel.js';

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});
const formatUsdText = (n) => USD_FORMATTER.format(round2(n));

/** Bajo este precio (USD) se guardan 6 decimales; desde aquí, 4. */
export const LOW_PRICE_EXTRA_DECIMALS_BELOW_USD = 0.1;

/** Limpia strings manteniendo null/vacío homogéneos. */
const cleanText = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** Convierte un valor numérico positivo opcional a number o null. */
function toPositiveNumberOrNull(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const cleaned = typeof raw === 'string' ? raw.trim().replace(/\s+/g, '').replace(/,/g, '.') : raw;
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Fuerza entero >= 1 para cantidades contenidas por nivel. */
function toIntAtLeast1(raw, fallback = 1) {
    const n = Math.trunc(Number(raw));
    return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Normaliza precio en USD conservando 6 decimales bajo $0.10 y 4 desde $0.10.
 */
export function normalizePriceUsd(rawPrice) {
    const value = Number(rawPrice);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value < LOW_PRICE_EXTRA_DECIMALS_BELOW_USD ? round6(value) : round4(value);
}

/** Plantillas rápidas listas para bodega, minimarket y estilo farmacia simplificado. */
export const PRESENTATION_PRESETS = Object.freeze({
    simple: Object.freeze({
        id: 'simple',
        label: 'Solo Unidad',
        levels: Object.freeze([
            Object.freeze({ id: 'unit', level: 1, name: 'Unidad', containsQty: 1, sellable: true }),
        ]),
    }),
    bulto_unidad: Object.freeze({
        id: 'bulto_unidad',
        label: 'Bulto + Unidad',
        levels: Object.freeze([
            Object.freeze({ id: 'unit', level: 1, name: 'Unidad', containsQty: 1, sellable: true }),
            Object.freeze({ id: 'pack', level: 2, name: 'Bulto', containsQty: 24, sellable: true }),
        ]),
    }),
    caja_unidad: Object.freeze({
        id: 'caja_unidad',
        label: 'Caja + Unidad',
        levels: Object.freeze([
            Object.freeze({ id: 'unit', level: 1, name: 'Unidad', containsQty: 1, sellable: true }),
            Object.freeze({ id: 'pack', level: 2, name: 'Caja', containsQty: 12, sellable: true }),
        ]),
    }),
    caja_paquete_unidad: Object.freeze({
        id: 'caja_paquete_unidad',
        label: 'Caja + Paquete + Unidad',
        levels: Object.freeze([
            Object.freeze({ id: 'unit', level: 1, name: 'Unidad', containsQty: 1, sellable: true }),
            Object.freeze({ id: 'mid', level: 2, name: 'Paquete', containsQty: 6, sellable: true }),
            Object.freeze({ id: 'pack', level: 3, name: 'Caja', containsQty: 4, sellable: true }),
        ]),
    }),
    caja_blister_tableta: Object.freeze({
        id: 'caja_blister_tableta',
        label: 'Caja + Blíster + Tableta',
        levels: Object.freeze([
            Object.freeze({ id: 'unit', level: 1, name: 'Tableta', containsQty: 1, sellable: true }),
            Object.freeze({ id: 'mid', level: 2, name: 'Blíster', containsQty: 10, sellable: true }),
            Object.freeze({ id: 'pack', level: 3, name: 'Caja', containsQty: 3, sellable: true }),
        ]),
    }),
});

const DEFAULT_NAMES_BY_ID = Object.freeze({
    unit: 'Unidad',
    mid: 'Paquete',
    pack: 'Caja',
});

function normalizeLevelFinancials(raw = {}) {
    const rawUsd = toPositiveNumberOrNull(raw.priceUsd);
    const rawCop = toPositiveNumberOrNull(raw.priceCop);
    const rawRef = toPositiveNumberOrNull(raw.priceBsUsdRef);
    const rawCost = toPositiveNumberOrNull(raw.costUsd);
    const barcode = cleanText(raw.barcode) || null;

    return {
        priceUsd: rawUsd !== null ? normalizePriceUsd(rawUsd) : null,
        priceCop: rawCop !== null ? round2(rawCop) : null,
        priceBsUsdRef: rawRef !== null ? round2(rawRef) : null,
        costUsd: rawCost !== null ? round4(rawCost) : null,
        barcode,
    };
}

/**
 * Normaliza 1 a 3 niveles, asigna IDs estables ('unit', 'mid', 'pack') y
 * recalcula `factorToBase` acumulado en cascada.
 */
export function computeFactorToBase(levels = []) {
    const list = Array.isArray(levels) ? levels.filter(Boolean).slice(0, 3) : [];
    if (list.length === 0) {
        return computeFactorToBase(PRESENTATION_PRESETS.simple.levels);
    }

    const total = list.length;
    const ids = total === 1
        ? ['unit']
        : total === 2
            ? ['unit', 'pack']
            : ['unit', 'mid', 'pack'];

    let runningFactor = 1;
    const normalized = list.map((raw, idx) => {
        const id = ids[idx];
        const level = idx + 1;
        const name = cleanText(raw.name) || DEFAULT_NAMES_BY_ID[id];

        let containsQty = 1;
        if (idx > 0) {
            const explicitQty = toPositiveNumberOrNull(raw.containsQty);
            if (explicitQty !== null) {
                containsQty = toIntAtLeast1(explicitQty, 1);
            } else {
                const rawFactor = toPositiveNumberOrNull(raw.factorToBase);
                containsQty = rawFactor !== null
                    ? toIntAtLeast1(round0(rawFactor / runningFactor), 1)
                    : 1;
            }
        }

        const factorToBase = idx === 0 ? 1 : runningFactor * containsQty;
        runningFactor = factorToBase;

        return {
            id,
            level,
            name,
            containsQty,
            factorToBase,
            sellable: raw.sellable === undefined ? true : Boolean(raw.sellable),
            ...normalizeLevelFinancials(raw),
        };
    });

    if (!normalized.some((l) => l.sellable)) {
        normalized[0].sellable = true;
    }

    return normalized;
}

/**
 * Crea una jerarquía de presentaciones desde un preset predefinido.
 */
export function buildPresetPresentations(presetId = 'simple') {
    const preset = PRESENTATION_PRESETS[presetId] || PRESENTATION_PRESETS.simple;
    return computeFactorToBase(preset.levels);
}

/**
 * Recalcula el costo USD proporcional de todos los niveles a partir del nivel
 * fuente en el que se recibe la factura del proveedor.
 */
export function reconcileCostCascade(levels = [], sourceLevelId, sourceCostUsd) {
    const normalized = computeFactorToBase(levels);
    const parsedCost = toPositiveNumberOrNull(sourceCostUsd);

    if (parsedCost === null) {
        return normalized.map((l) => ({ ...l, costUsd: null }));
    }

    const source = normalized.find((l) => l.id === sourceLevelId) || normalized[normalized.length - 1];
    const baseCost = parsedCost / (source.factorToBase || 1);

    return normalized.map((l) => ({
        ...l,
        costUsd: l.id === source.id ? round4(parsedCost) : round4(baseCost * l.factorToBase),
    }));
}

/**
 * Sugiere precio (USD y COP si aplica) para un nivel destino escalando desde
 * un nivel ancla y aplicando un descuento por volumen opcional.
 */
export function suggestLevelPrice(levels = [], targetLevelId, { anchorLevelId = 'unit', discountPct = 0 } = {}) {
    const normalized = computeFactorToBase(levels);
    const target = normalized.find((l) => l.id === targetLevelId);
    const anchor = normalized.find((l) => l.id === anchorLevelId && (l.priceUsd > 0 || l.priceCop > 0))
        || normalized.find((l) => l.priceUsd > 0 || l.priceCop > 0);

    if (!target || !anchor) return { priceUsd: null, priceCop: null };

    const ratio = target.factorToBase / (anchor.factorToBase || 1);
    const multiplier = Math.max(0, 1 - (Number(discountPct) || 0) / 100);

    const priceUsd = anchor.priceUsd > 0
        ? normalizePriceUsd(anchor.priceUsd * ratio * multiplier)
        : null;
    const priceCop = anchor.priceCop > 0
        ? round2(mulR(anchor.priceCop, ratio * multiplier))
        : null;

    return { priceUsd, priceCop };
}

/**
 * Obtiene las presentaciones de un producto nuevo o legacy sin mutar el original.
 * Productos a granel retornan `[]` (su lógica vive en `granel.js`).
 */
export function resolveProductPresentations(product) {
    if (!product || typeof product !== 'object') return [];
    if (isGranelProduct(product) && !Array.isArray(product.presentations)) return [];

    if (Array.isArray(product.presentations) && product.presentations.length > 0) {
        return computeFactorToBase(product.presentations);
    }

    const uPP = Math.max(1, parseInt(product.unitsPerPackage, 10) || 1);
    const isLote = product.packagingType === 'lote' || product.unit === 'paquete';
    const priceUsd = toPositiveNumberOrNull(product.priceUsd ?? product.priceUsdt);
    const priceCop = toPositiveNumberOrNull(product.priceCop);
    const priceBsUsdRef = product.pricingMode === 'dual_usd' ? toPositiveNumberOrNull(product.priceBsUsdRef) : null;
    const costUsd = toPositiveNumberOrNull(product.costUsd);
    const barcode = cleanText(product.barcode) || null;

    if (!isLote && uPP <= 1) {
        return computeFactorToBase([{
            id: 'unit',
            level: 1,
            name: 'Unidad',
            containsQty: 1,
            sellable: true,
            priceUsd,
            priceCop,
            priceBsUsdRef,
            costUsd,
            barcode,
        }]);
    }

    if (!isLote && uPP > 1) {
        // Producto suelto con factor solo para ajuste de inventario/compras (sellable: false).
        return computeFactorToBase([
            {
                id: 'unit',
                level: 1,
                name: 'Unidad',
                containsQty: 1,
                sellable: true,
                priceUsd,
                priceCop,
                priceBsUsdRef,
                costUsd,
                barcode,
            },
            {
                id: 'pack',
                level: 2,
                name: 'Bulto',
                containsQty: uPP,
                sellable: false,
                priceUsd: null,
                priceCop: null,
                priceBsUsdRef: null,
                costUsd: costUsd !== null ? round4(costUsd * uPP) : null,
                barcode: null,
            },
        ]);
    }

    if (isLote && uPP > 1) {
        const sellUnit = Boolean(product.sellByUnit);
        const unitPriceUsd = sellUnit
            ? (toPositiveNumberOrNull(product.unitPriceUsd) ?? (priceUsd !== null ? divR(priceUsd, uPP) : null))
            : null;
        const unitPriceCop = sellUnit
            ? (toPositiveNumberOrNull(product.unitPriceCop) ?? (priceCop !== null ? round2(divR(priceCop, uPP)) : null))
            : null;
        const unitCostUsd = costUsd !== null ? round4(costUsd / uPP) : null;

        return computeFactorToBase([
            {
                id: 'unit',
                level: 1,
                name: 'Unidad',
                containsQty: 1,
                sellable: sellUnit,
                priceUsd: unitPriceUsd,
                priceCop: unitPriceCop,
                priceBsUsdRef: null,
                costUsd: unitCostUsd,
                barcode: null,
            },
            {
                id: 'pack',
                level: 2,
                name: 'Bulto',
                containsQty: uPP,
                sellable: true,
                priceUsd,
                priceCop,
                priceBsUsdRef,
                costUsd,
                barcode,
            },
        ]);
    }

    return computeFactorToBase([{
        id: 'unit',
        level: 1,
        name: product.unit === 'paquete' ? 'Paquete' : 'Unidad',
        containsQty: 1,
        sellable: true,
        priceUsd,
        priceCop,
        priceBsUsdRef,
        costUsd,
        barcode,
    }]);
}

function resolveLevelsInput(productOrLevels) {
    return Array.isArray(productOrLevels)
        ? computeFactorToBase(productOrLevels)
        : resolveProductPresentations(productOrLevels);
}

/** Presentaciones habilitadas para la venta en Caja. */
export function getSellablePresentations(productOrLevels) {
    return resolveLevelsInput(productOrLevels).filter((l) => Boolean(l.sellable));
}

/** Presentación principal para mostrar por defecto (mayor factor vendible). */
export function getPrimarySellablePresentation(productOrLevels) {
    const sellables = getSellablePresentations(productOrLevels);
    if (sellables.length === 0) return null;
    return sellables.reduce((best, cur) => (cur.factorToBase >= best.factorToBase ? cur : best), sellables[0]);
}

/**
 * Si un código de barras pertenece de forma única a una presentación específica,
 * la retorna para agregar directo al carrito; si corresponde solo al código base
 * compartido del artículo, retorna `null` para abrir el selector cuando aplique.
 */
export function findPresentationByBarcode(product, rawCode) {
    const code = cleanText(rawCode);
    if (!product || !code) return null;
    const sellables = getSellablePresentations(product);
    if (sellables.length === 0) return null;

    const exactMatches = sellables.filter((l) => cleanText(l.barcode) === code);
    if (exactMatches.length === 1) return exactMatches[0];

    return null;
}

const PLURAL_OVERRIDES = Object.freeze({
    blíster: 'blísters',
    blister: 'blisters',
    cartón: 'cartones',
    carton: 'cartones',
    sachet: 'sachets',
    display: 'displays',
    pack: 'packs',
    'six-pack': 'six-packs',
});

/** Pluraliza de forma natural etiquetas de empaque en español. */
export function pluralizePresentationName(name, qty) {
    const clean = cleanText(name) || 'Unidad';
    if (qty === 1) return clean;
    const lower = clean.toLowerCase();
    if (PLURAL_OVERRIDES[lower]) {
        const mapped = PLURAL_OVERRIDES[lower];
        return clean[0] === clean[0].toUpperCase()
            ? mapped[0].toUpperCase() + mapped.slice(1)
            : mapped;
    }
    if (/s$/i.test(clean)) return clean;
    if (/z$/i.test(clean)) return `${clean.slice(0, -1)}ces`;
    if (/d$/i.test(clean)) return `${clean}es`;
    if (/[aeiouáéíóúy]$/i.test(clean)) return `${clean}s`;
    return `${clean}s`;
}

/**
 * Descompone un stock total en unidad base en cantidades por cada nivel (mayor → base).
 */
export function decomposeStockByLevels(baseStock, levels = []) {
    const normalized = computeFactorToBase(levels);
    const totalBase = Math.max(0, round0(Number(baseStock) || 0));
    const descLevels = [...normalized].sort((a, b) => b.factorToBase - a.factorToBase);

    let remaining = totalBase;
    const parts = descLevels.map((lvl) => {
        const factor = Math.max(1, lvl.factorToBase);
        const qty = (remaining - (remaining % factor)) / factor;
        remaining -= qty * factor;
        return {
            id: lvl.id,
            level: lvl.level,
            name: lvl.name,
            factorToBase: factor,
            qty,
        };
    });

    const nonZero = parts.filter((p) => p.qty > 0);
    const baseLevel = normalized[0];
    const text = nonZero.length > 0
        ? nonZero.map((p) => `${p.qty} ${pluralizePresentationName(p.name, p.qty)}`).join(' · ')
        : `0 ${pluralizePresentationName(baseLevel.name, 0)}`;

    return {
        totalBase,
        parts,
        text,
    };
}

/**
 * Convierte cantidades ingresadas por nivel en un total entero en unidad base.
 */
export function composeBaseStock(quantitiesByLevelId = {}, levels = []) {
    const normalized = computeFactorToBase(levels);
    let total = 0;
    for (const lvl of normalized) {
        const qty = Math.max(0, round0(Number(quantitiesByLevelId?.[lvl.id]) || 0));
        total += qty * lvl.factorToBase;
    }
    return total;
}

/**
 * Valida coherencia comercial entre presentaciones (margen negativo, inversión
 * de precio por volumen y códigos repetidos dentro del mismo producto).
 */
export function validatePresentationCoherence(levels = []) {
    const normalized = computeFactorToBase(levels);
    const warnings = [];
    const sellables = normalized.filter((l) => l.sellable);

    if (sellables.length === 0) {
        warnings.push({
            type: 'no_sellable_level',
            severity: 'error',
            levelId: normalized[0]?.id || 'unit',
            message: 'Activa al menos una presentación para poder vender en Caja.',
        });
    }

    for (const lvl of sellables) {
        if (lvl.priceUsd > 0 && lvl.costUsd > 0 && lvl.priceUsd + 1e-9 < lvl.costUsd) {
            warnings.push({
                type: 'negative_margin',
                severity: 'error',
                levelId: lvl.id,
                message: `En "${lvl.name}", el precio ($${formatUsdText(lvl.priceUsd)}) está por debajo del costo ($${formatUsdText(lvl.costUsd)}).`,
            });
        }
    }

    for (let i = 0; i < sellables.length; i++) {
        for (let j = i + 1; j < sellables.length; j++) {
            const lower = sellables[i];
            const higher = sellables[j];
            if (!(lower.priceUsd > 0 && higher.priceUsd > 0)) continue;
            const ratio = higher.factorToBase / (lower.factorToBase || 1);
            const equivalent = mulR(lower.priceUsd, ratio);
            if (higher.priceUsd > equivalent + 0.005) {
                warnings.push({
                    type: 'volume_price_inversion',
                    severity: 'warning',
                    levelId: higher.id,
                    relatedLevelId: lower.id,
                    message: `1 ${higher.name} ($${formatUsdText(higher.priceUsd)}) sale más cara que ${ratio} ${pluralizePresentationName(lower.name, ratio)} sueltas ($${formatUsdText(equivalent)}).`,
                });
            }
        }
    }

    const seenBarcodes = new Map();
    for (const lvl of normalized) {
        const code = cleanText(lvl.barcode);
        if (!code) continue;
        if (seenBarcodes.has(code)) {
            warnings.push({
                type: 'duplicate_level_barcode',
                severity: 'error',
                levelId: lvl.id,
                relatedLevelId: seenBarcodes.get(code),
                message: `El código "${code}" está repetido en "${lvl.name}". Cada presentación debe tener un código distinto o usar el código general.`,
            });
        } else {
            seenBarcodes.set(code, lvl.id);
        }
    }

    return warnings;
}

/**
 * Proyecta los campos legacy del catálogo a partir de la jerarquía multinivel,
 * garantizando compatibilidad con valorización, reportes, cesta y multi-caja.
 */
export function projectLegacyFieldsFromPresentations(levels = [], {
    packagingMode,
    costSourceLevel,
    baseBarcode,
} = {}) {
    const normalized = computeFactorToBase(levels);
    const unitLevel = normalized.find((l) => l.id === 'unit') || normalized[0];
    const midLevel = normalized.find((l) => l.id === 'mid') || null;
    const packLevel = normalized.find((l) => l.id === 'pack') || null;

    const sellables = normalized.filter((l) => l.sellable);
    const upperSellable = [...sellables].reverse().find((l) => l.factorToBase > 1) || null;
    const purchaseUpper = normalized.find((l) => l.factorToBase > 1) || null;

    const isMultilevelMode = normalized.length > 1 || packagingMode === 'multilevel';
    const resolvedMode = packagingMode || (isMultilevelMode ? 'multilevel' : 'simple');

    const baseCodeClean = cleanText(baseBarcode);
    const altSet = new Set();
    for (const lvl of normalized) {
        const code = cleanText(lvl.barcode);
        if (code && code !== baseCodeClean) {
            altSet.add(code);
        }
    }

    const midPack = midLevel && cleanText(midLevel.barcode)
        ? {
            barcode: cleanText(midLevel.barcode),
            units: midLevel.factorToBase,
            name: midLevel.name,
        }
        : undefined;

    if (!upperSellable) {
        // Solo se vende la unidad base (puede tener un bulto de compra con sellable: false).
        const primaryPriceUsd = unitLevel?.priceUsd ?? 0;
        return {
            packagingMode: resolvedMode,
            costSourceLevel: costSourceLevel || 'unit',
            presentations: normalized,
            packagingType: 'suelto',
            unit: 'unidad',
            unitsPerPackage: purchaseUpper ? purchaseUpper.factorToBase : 1,
            sellByUnit: false,
            unitPriceUsd: null,
            unitPriceCop: null,
            priceUsd: primaryPriceUsd,
            priceUsdt: primaryPriceUsd,
            priceCop: unitLevel?.priceCop ?? null,
            priceBsUsdRef: unitLevel?.priceBsUsdRef ?? null,
            costUsd: unitLevel?.costUsd ?? 0,
            stockInLotes: null,
            ...(midPack ? { midPack } : {}),
            ...(altSet.size > 0 ? { altBarcodes: [...altSet] } : {}),
        };
    }

    const sellByUnit = Boolean(unitLevel?.sellable && (unitLevel.priceUsd > 0 || unitLevel.priceCop > 0));
    const primaryPriceUsd = upperSellable.priceUsd ?? 0;

    return {
        packagingMode: resolvedMode,
        costSourceLevel: costSourceLevel || upperSellable.id,
        presentations: normalized,
        packagingType: 'lote',
        unit: 'paquete',
        unitsPerPackage: upperSellable.factorToBase,
        sellByUnit,
        unitPriceUsd: sellByUnit ? (unitLevel.priceUsd ?? divR(primaryPriceUsd, upperSellable.factorToBase)) : null,
        unitPriceCop: sellByUnit ? (unitLevel.priceCop ?? (upperSellable.priceCop ? round2(divR(upperSellable.priceCop, upperSellable.factorToBase)) : null)) : null,
        priceUsd: primaryPriceUsd,
        priceUsdt: primaryPriceUsd,
        priceCop: upperSellable.priceCop ?? null,
        priceBsUsdRef: upperSellable.priceBsUsdRef ?? null,
        costUsd: upperSellable.costUsd ?? 0,
        stockInLotes: null,
        ...(packLevel && !midPack ? {} : (midPack ? { midPack } : {})),
        ...(altSet.size > 0 ? { altBarcodes: [...altSet] } : {}),
    };
}
