// FIN-017: Reemplaza Math.round(raw/safeRate*100)/100 por divR + round2 de dinero.js.
// FIN-030: Mantiene `priceUsdt` (typo histórico) pero añade alias `priceUsd` (mismo valor)
//          para migración gradual hacia el nombre canónico.
import { round2, round3, round4, divR, mulR, round0 } from './dinero.js';
import { CurrencyService } from '../services/CurrencyService.js'; // FIN-017-pattern: safeParse en vez de parseFloat.
import {
    normalizePackagingType,
    isLiquidProduct,
    parseStockInput,
    getGranelUnitMode,
    GRANEL_MODE_GR_ML,
    parseWeightToCanonical,
    parseGranelThreshold,
} from './granel.js'; // GRANEL-001 / GRANEL-DUAL: decimales SOLO para productos a granel y conversión dual.

/**
 * Trío costo / precio / factor costo (factor = costo ÷ precio = 1 − margen).
 * El COSTO es el dato fijo (lo que se pagó); precio y margen son decisiones:
 *   - cambia el factor → recalcula el precio
 *   - cambia el precio → recalcula el factor
 *   - cambia el costo  → mantiene el margen y recalcula el precio
 *                        (sin factor, recalcula el factor con el precio)
 * Solo sin costo cargado se deriva el costo (precio × factor): no hay nada
 * que proteger. Sin estado: el resultado no depende del orden de edición.
 * @returns {{ field: 'cost'|'price'|'factor'|null, value: number|null }}
 */
export function derivePricingFromEdit(editedField, { cost, price, factor }) {
    const hasCost = cost > 0;
    const hasPrice = price > 0;
    const hasFactor = factor > 0;
    if (editedField === 'factor' && hasFactor) {
        if (hasCost) return { field: 'price', value: cost / factor };
        if (hasPrice) return { field: 'cost', value: price * factor };
    }
    if (editedField === 'price' && hasPrice) {
        if (hasCost) return { field: 'factor', value: cost / price };
        if (hasFactor) return { field: 'cost', value: price * factor };
    }
    if (editedField === 'cost' && hasCost) {
        if (hasFactor) return { field: 'price', value: cost / factor };
        if (hasPrice) return { field: 'factor', value: cost / price };
    }
    return { field: null, value: null };
}

import {
    LOW_PRICE_EXTRA_DECIMALS_BELOW_USD,
    normalizePriceUsd,
    computeFactorToBase,
    composeBaseStock,
    projectLegacyFieldsFromPresentations,
} from './presentations.js';

export { LOW_PRICE_EXTRA_DECIMALS_BELOW_USD, normalizePriceUsd };

/** Texto del campo de precio USD: 2 decimales, o los exactos si el precio los necesita. */
export function formatPriceUsdInput(rawPrice) {
    const price = normalizePriceUsd(rawPrice);
    if (price <= 0) return '';
    // eslint-disable-next-line no-restricted-syntax -- texto del input (no es un cálculo); el valor ya viene redondeado con round4/round2
    return price === round2(price) ? price.toFixed(2) : String(price);
}

/**
 * Precio vendible derivado de un margen (costo ÷ factor) y el factor que se debe mostrar.
 * El factor pedido se conserva si el redondeo apenas lo mueve (≤ 0.002 = 0.2 puntos de margen);
 * si lo mueve más, se muestra el factor REAL.
 * @returns {{ price: number, factor: number|null }}
 */
export function roundDerivedPrice(rawPrice, costUsd, requestedFactor) {
    const price = normalizePriceUsd(rawPrice);
    if (!(price > 0)) return { price: Number(rawPrice) || 0, factor: null };
    return { price, factor: resolveCostFactor(costUsd, price, requestedFactor) };
}

/** Diferencia de factor que se considera solo redondeo (0.002 = 0.2 puntos de margen). */
export const COST_FACTOR_ROUNDING_TOLERANCE = 0.002;

/**
 * Factor a guardar/mostrar: el elegido por el usuario si el precio real lo cumple salvo
 * redondeo (así 30% sigue siendo 30% y no 29.9%); si no, el factor REAL (costo ÷ precio).
 * null si falta costo o precio.
 */
export function resolveCostFactor(costUsd, priceUsd, preferredFactor) {
    const real = actualCostFactor(costUsd, priceUsd);
    if (real === null) return null;
    const preferred = Number(preferredFactor);
    return preferred > 0 && Math.abs(real - preferred) <= COST_FACTOR_ROUNDING_TOLERANCE ? preferred : real;
}

/** Factor real (costo ÷ precio, 3 decimales) o null si falta precio o costo. */
export function actualCostFactor(costUsd, priceUsd) {
    const cost = Number(costUsd);
    const price = Number(priceUsd);
    if (!(cost > 0) || !(price > 0)) return null;
    return round3(cost / price);
}

export function buildProductPayload(formData, effectiveRate) {
    const {
        name,
        barcode,
        priceUsd,
        priceBs,
        priceCop,
        costUsd,
        costBs,
        stock,
        stockInLotes,
        packagingType,
        unitsPerPackage,
        granelUnit,
        sellByUnit,
        unitPriceUsd,
        unitPriceCop,
        category,
        lowStockAlert
    } = formData;

    const formattedName = name.replace(/(^\w{1})|(\s+\w{1})/g, letter => letter.toUpperCase());
    // FIN-022-pattern: validar tasa antes de usarla (sin fallback silencioso a 1).
    const safeRate = effectiveRate > 0 ? effectiveRate : 1;

    // Ruta multinivel (1, 2 o 3 niveles): solo activa cuando vienen presentaciones explícitas
    // para el nuevo flujo o cuando no se están inyectando campos legacy planos sobre ellas.
    const hasMultilevelLevels = Array.isArray(formData.presentations) && formData.presentations.length > 0;
    const hasFlatLegacyPrice = priceUsd !== undefined || priceBs !== undefined || priceCop !== undefined || costUsd !== undefined;
    const usePresentationsPath = formData.packagingMode !== 'granel'
        && hasMultilevelLevels
        && (formData.usePresentations === true
            || formData.packagingMode === 'multilevel'
            || (formData.packagingMode === 'simple' && !hasFlatLegacyPrice));

    if (usePresentationsPath) {
        const normalizedLevels = computeFactorToBase(formData.presentations);
        const projected = projectLegacyFieldsFromPresentations(normalizedLevels, {
            packagingMode: formData.packagingMode,
            costSourceLevel: formData.costSourceLevel,
            baseBarcode: barcode,
        });

        const finalPriceUsd = projected.priceUsd;
        const finalCostUsd = projected.costUsd > 0
            ? (projected.costUsd >= LOW_PRICE_EXTRA_DECIMALS_BELOW_USD ? round2(projected.costUsd) : round4(projected.costUsd))
            : 0;
        const finalCostBs = costBs
            ? round2(CurrencyService.safeParse(costBs))
            : (finalCostUsd > 0 ? mulR(finalCostUsd, safeRate) : 0);

        let finalStock = 0;
        if (stock !== null && stock !== undefined && stock !== '') {
            finalStock = parseStockInput(stock, false) ?? 0;
        } else if (formData.stockByLevel && typeof formData.stockByLevel === 'object') {
            finalStock = composeBaseStock(formData.stockByLevel, normalizedLevels);
        }

        const finalLowStockAlert = lowStockAlert !== null && lowStockAlert !== undefined && lowStockAlert !== ''
            ? (parseStockInput(lowStockAlert, false) ?? 5)
            : 5;

        const rawRef = projected.priceBsUsdRef ?? formData.priceBsUsdRef;
        const parsedBsUsdRef = (rawRef && CurrencyService.safeParse(rawRef) > 0)
            ? round2(CurrencyService.safeParse(rawRef))
            : null;
        const rawPricingMode = formData.pricingMode || (parsedBsUsdRef !== null ? 'dual_usd' : 'tasa_dia');
        const pricingMode = (rawPricingMode === 'dual_usd' && parsedBsUsdRef !== null)
            ? 'dual_usd'
            : 'tasa_dia';

        return {
            name: formattedName,
            barcode: barcode ? barcode.trim() : null,
            ...projected,
            pricingMode,
            priceBsUsdRef: pricingMode === 'dual_usd' ? parsedBsUsdRef : null,
            costUsd: finalCostUsd,
            costBs: finalCostBs,
            ...(formData.costFactor !== undefined ? {
                costFactor: resolveCostFactor(finalCostUsd, finalPriceUsd, formData.costFactor)
                    ?? (formData.costFactor !== null && formData.costFactor !== '' && Number.isFinite(Number(formData.costFactor))
                        ? Number(formData.costFactor)
                        : null),
            } : {}),
            stock: finalStock,
            granelUnit: null,
            stockInLotes: null,
            category: category,
            lowStockAlert: finalLowStockAlert,
            ivaRate: formData.ivaMode === 'exento' ? 0 : undefined,
        };
    }

    // FIN-017: usar divR (división redondeada) en vez de Math.round(raw/safeRate*100)/100.
    // safeParse para normalizar input del usuario (maneja coma decimal y separadores de miles).
    const finalPriceUsd = priceUsd
        ? normalizePriceUsd(CurrencyService.safeParse(priceUsd))
        : (priceBs ? normalizePriceUsd(CurrencyService.safeParse(priceBs) / safeRate) : 0);
    const finalCostUsd = costUsd
        ? round2(CurrencyService.safeParse(costUsd))
        : (costBs ? divR(CurrencyService.safeParse(costBs), safeRate) : 0);
    const finalCostBs = costBs
        ? round2(CurrencyService.safeParse(costBs))
        : (costUsd ? mulR(CurrencyService.safeParse(costUsd), safeRate) : 0);

    // COP: guardar el valor exacto que escribió el usuario (sin redondeo de ida/vuelta).
    // COP es entero por convención; redondeamos a entero con round2 (no hay decimales).
    const finalPriceCop = priceCop && CurrencyService.safeParse(priceCop) > 0 ? round2(CurrencyService.safeParse(priceCop)) : null;

    // FIX-EMPAQUE-001: el empaque normalizado manda, sin adivinanzas. Valores ajenos
    // ('unidad', 'bulto'...) o vacíos se traducen a los 3 válidos ANTES de decidir nada,
    // y el campo granelUnit nunca cuenta como pista (viene 'kg' por defecto del formulario).
    const normalizedPackaging = normalizePackagingType({
        packagingType,
        unit: formData.unit,
        isWeight: formData.isWeight,
        soldByWeight: formData.soldByWeight,
    });

    // Map packagingType → unit legacy
    let legacyUnit = 'unidad';
    if (normalizedPackaging === 'lote') legacyUnit = 'paquete';
    else if (normalizedPackaging === 'granel') legacyUnit = isLiquidProduct(granelUnit) ? 'litro' : 'kg';

    const isLote = normalizedPackaging === 'lote';
    // Para productos de tipo Suelto o Granel, también guardamos unitsPerPackage si fue
    // configurado voluntariamente (permite ajuste por bulto en StockBatchModal).
    const parsedUnitsPerPkg = unitsPerPackage ? Math.max(1, parseInt(unitsPerPackage) || 1) : 1;
    const autoUnitPrice = parsedUnitsPerPkg > 1 ? divR(finalPriceUsd, parsedUnitsPerPkg) : finalPriceUsd;
    const finalUnitPrice = sellByUnit && unitPriceUsd ? round2(CurrencyService.safeParse(unitPriceUsd)) : autoUnitPrice;

    // Unit price in COP for lote products
    const finalUnitPriceCop = isLote && sellByUnit && unitPriceCop && CurrencyService.safeParse(unitPriceCop) > 0
        ? round2(CurrencyService.safeParse(unitPriceCop))
        : (isLote && sellByUnit && finalPriceCop && parsedUnitsPerPkg > 1
            ? divR(finalPriceCop, parsedUnitsPerPkg)
            : null);

    // GRANEL-001 / GRANEL-DUAL: Solo los productos a granel aceptan decimales en stock (hasta 3).
    // En modo gr_ml, las entradas en gramos o mililitros se convierten canónicamente a kg / Litros.
    // Todo lo demás (unidad, paquete, lote, suelto) permanece estrictamente entero.
    const isGranel = normalizedPackaging === 'granel';
    let finalStock = 0;
    if (isLote && stockInLotes && parsedUnitsPerPkg > 0) {
        finalStock = round0((Number(stockInLotes) || 0) * parsedUnitsPerPkg);
    } else if (stock !== null && stock !== undefined && stock !== '') {
        if (isGranel) {
            const activeGranelMode = formData.granelUnitMode || getGranelUnitMode();
            if (activeGranelMode === GRANEL_MODE_GR_ML) {
                const cleaned = String(stock).trim().replace(/\s/g, '').replace(/,/g, '.');
                const num = Number(cleaned);
                if (Number.isFinite(num) && num === 0) {
                    finalStock = 0;
                } else {
                    finalStock = parseWeightToCanonical(stock, GRANEL_MODE_GR_ML) ?? 0;
                }
            } else {
                finalStock = parseStockInput(stock, true) ?? 0;
            }
        } else {
            finalStock = parseStockInput(stock, false) ?? 0;
        }
    }

    // GRANEL-001: alerta de stock bajo con el mismo guardarraíl de tipado
    // (granel admite hasta 3 decimales; el resto cae a entero, con fallback a 5).
    const activeGranelMode = formData.granelUnitMode || getGranelUnitMode();
    const finalLowStockAlert = lowStockAlert !== null && lowStockAlert !== undefined && lowStockAlert !== ''
        ? (isGranel
            ? (formData.lowStockAlertCanonical === true
                ? (parseStockInput(lowStockAlert, true) ?? 5)
                : (parseGranelThreshold(lowStockAlert, activeGranelMode) ?? 5))
            : (parseStockInput(lowStockAlert, false) ?? 5))
        : 5;

    // Doble Precio y modalidad de precios (dual_usd / tasa_dia)
    const rawPricingMode = formData.pricingMode || 'tasa_dia';
    const rawBsUsdRef = formData.priceBsUsdRef;

    const parsedBsUsdRef = (rawBsUsdRef && CurrencyService.safeParse(rawBsUsdRef) > 0)
        ? round2(CurrencyService.safeParse(rawBsUsdRef))
        : null;

    const pricingMode = (rawPricingMode === 'dual_usd' && parsedBsUsdRef !== null)
        ? 'dual_usd'
        : 'tasa_dia';

    const priceBsUsdRef = pricingMode === 'dual_usd' ? parsedBsUsdRef : null;

    return {
        name: formattedName,
        barcode: barcode ? barcode.trim() : null,
        // FIN-030: mantener `priceUsdt` (typo histórico) + alias `priceUsd` para migración gradual.
        priceUsdt: finalPriceUsd,
        priceUsd: finalPriceUsd,
        pricingMode: pricingMode,
        priceBsUsdRef: priceBsUsdRef,
        priceCop: finalPriceCop,
        costUsd: finalCostUsd,
        costBs: finalCostBs,
        // Con costo y precio, el factor guardado es SIEMPRE el real: así el %
        // del formulario nunca contradice la insignia de margen de la ficha.
        ...(formData.costFactor !== undefined ? {
            costFactor: resolveCostFactor(finalCostUsd, finalPriceUsd, formData.costFactor)
                ?? (formData.costFactor !== null && formData.costFactor !== '' && Number.isFinite(Number(formData.costFactor))
                    ? Number(formData.costFactor)
                    : null),
        } : {}),
        stock: finalStock,
        unit: legacyUnit,
        packagingType: normalizedPackaging,
        granelUnit: isGranel ? (isLiquidProduct(granelUnit) ? 'litro' : 'kg') : null,
        unitsPerPackage: parsedUnitsPerPkg,
        sellByUnit: isLote ? sellByUnit : false,
        unitPriceUsd: isLote && sellByUnit ? finalUnitPrice : null,
        unitPriceCop: isLote && sellByUnit ? finalUnitPriceCop : null,
        // INV-16: stockInLotes ya no se persiste truncado; siempre se deriva desde stock.
        stockInLotes: null,
        category: category,
        lowStockAlert: finalLowStockAlert,
        // IVA por producto: exento guarda 0%. General escribe undefined para que la fusión
        // { ...producto, ...payload } borre un ivaRate anterior y el producto vuelva a la tasa general.
        ivaRate: formData.ivaMode === 'exento' ? 0 : undefined,
    };
}

/**
 * Aplica los cambios del formulario sobre un producto existente sin revertir
 * ventas concurrentes de otras cajas: si el usuario NO tocó el campo de stock
 * (`stockTouched === false`), se preservan `stock` y `stockInLotes` del producto
 * actual para que `mergeProduct3Way` conserve el stock fresco de IndexedDB (C2).
 */
export function applyProductFormEdit(existingProduct, productData, { stockTouched = true, finalImage } = {}) {
    const patch = { ...productData };
    if (!stockTouched) {
        delete patch.stock;
        delete patch.stockInLotes;
    }
    return {
        ...existingProduct,
        ...patch,
        image: finalImage !== undefined ? finalImage : existingProduct.image,
    };
}
