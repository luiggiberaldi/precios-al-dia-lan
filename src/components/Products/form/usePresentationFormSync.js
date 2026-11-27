import { useCallback, useMemo, useState } from 'react';
import {
    buildPresetPresentations,
    computeFactorToBase,
    decomposeStockByLevels,
    projectLegacyFieldsFromPresentations,
    reconcileCostCascade,
    resolveProductPresentations,
} from '../../../utils/presentations';
import { formatPriceUsdInput } from '../../../utils/productProcessor';

/**
 * Conecta los subcomponentes modulares con el estado del formulario (ya sea el
 * hook completo `useProductForm` o callers legacy como tests aislados).
 */
export function usePresentationFormSync(props) {
    const {
        barcode,
        priceUsd, handlePriceUsdChange,
        handlePriceBsChange,
        handlePriceCopChange,
        priceCop,
        costUsd, handleCostUsdChange,
        handleCostBsChange,
        handleCostCopChange,
        handleCostFactorChange,
        stock, setStock,
        packagingType, setPackagingType,
        unitsPerPackage, setUnitsPerPackage,
        sellByUnit, setSellByUnit,
        unitPriceUsd, setUnitPriceUsd,
        unitPriceCop, setUnitPriceCop,
        packagingMode: propMode, setPackagingMode: propSetMode,
        presentations: propPresentations, setPresentations: propSetPresentations,
        costSourceLevel: propCostSourceLevel, setCostSourceLevel: propSetCostSourceLevel,
        stockByLevel: propStockByLevel, setStockByLevel: propSetStockByLevel,
        effectiveRate = 0,
        tasaCop = 0,
        copEnabled = false,
    } = props;

    const inferredMode = packagingType === 'granel'
        ? 'granel'
        : packagingType === 'lote'
            ? 'multilevel'
            : 'simple';

    const [fallbackMode, setFallbackMode] = useState(inferredMode);
    const [fallbackPresentations, setFallbackPresentations] = useState(() => resolveProductPresentations({
        packagingType,
        unitsPerPackage,
        sellByUnit,
        priceUsd,
        priceCop,
        unitPriceUsd,
        unitPriceCop,
        costUsd,
        barcode,
    }));
    const [fallbackCostSource, setFallbackCostSource] = useState('unit');
    const [fallbackStockByLevel, setFallbackStockByLevel] = useState({});

    const packagingMode = propMode || fallbackMode;
    const setPackagingMode = propSetMode || setFallbackMode;
    const presentations = useMemo(() => {
        if (Array.isArray(propPresentations) && propPresentations.length > 0) return propPresentations;
        return fallbackPresentations;
    }, [propPresentations, fallbackPresentations]);
    const setPresentations = propSetPresentations || setFallbackPresentations;
    const costSourceLevel = propCostSourceLevel || fallbackCostSource;
    const setCostSourceLevel = propSetCostSourceLevel || setFallbackCostSource;
    const stockByLevel = propStockByLevel || fallbackStockByLevel;

    const setStockByLevel = useCallback((nextMap, levels) => {
        if (propSetStockByLevel) {
            propSetStockByLevel(nextMap, levels);
            return;
        }
        setFallbackStockByLevel(nextMap);
    }, [propSetStockByLevel]);

    const syncLegacyProjections = useCallback((nextLevels, modeOverride, sourceOverride) => {
        const activeMode = modeOverride || packagingMode;
        const activeSource = sourceOverride || costSourceLevel;
        if (activeMode === 'granel') {
            setPackagingType?.('granel');
            return;
        }

        const projected = projectLegacyFieldsFromPresentations(nextLevels, {
            packagingMode: activeMode,
            costSourceLevel: activeSource,
            baseBarcode: barcode,
        });

        setPackagingType?.(projected.packagingType);
        setUnitsPerPackage?.(String(projected.unitsPerPackage || 1));
        setSellByUnit?.(Boolean(projected.sellByUnit));
        setUnitPriceUsd?.(projected.unitPriceUsd != null ? String(projected.unitPriceUsd) : '');
        setUnitPriceCop?.(projected.unitPriceCop != null ? String(projected.unitPriceCop) : '');

        if (projected.priceUsd > 0) {
            const usdText = formatPriceUsdInput(projected.priceUsd);
            handlePriceUsdChange?.(usdText);
            if (effectiveRate > 0) {
                handlePriceBsChange?.((projected.priceUsd * effectiveRate).toFixed(2));
            }
        } else if (nextLevels.every((l) => !(l.priceUsd > 0))) {
            handlePriceUsdChange?.('');
            handlePriceBsChange?.('');
        }
        if (projected.priceCop > 0) {
            handlePriceCopChange?.(String(projected.priceCop));
        }

        const srcLevel = nextLevels.find((l) => l.id === activeSource) || nextLevels[0];
        const primaryCost = projected.costUsd > 0 ? projected.costUsd : (srcLevel?.costUsd || 0);
        if (primaryCost > 0) {
            handleCostUsdChange?.(String(primaryCost));
            if (effectiveRate > 0) {
                handleCostBsChange?.((primaryCost * effectiveRate).toFixed(2));
            }
            if (copEnabled && tasaCop > 0) {
                handleCostCopChange?.(String(Math.round(primaryCost * tasaCop)));
            }
            if (projected.priceUsd > 0) {
                handleCostFactorChange?.((primaryCost / projected.priceUsd).toFixed(3));
            }
        }
    }, [
        packagingMode,
        costSourceLevel,
        barcode,
        setPackagingType,
        setUnitsPerPackage,
        setSellByUnit,
        setUnitPriceUsd,
        setUnitPriceCop,
        handlePriceUsdChange,
        handlePriceBsChange,
        handlePriceCopChange,
        handleCostUsdChange,
        handleCostBsChange,
        handleCostCopChange,
        handleCostFactorChange,
        effectiveRate,
        copEnabled,
        tasaCop,
    ]);

    const handleChangePresentations = useCallback((nextLevels, options = {}) => {
        const finalLevels = options.skipCompute ? nextLevels : computeFactorToBase(nextLevels);
        setPresentations(finalLevels);
        if (!options.skipCompute) {
            syncLegacyProjections(finalLevels);
            const numericStock = Math.max(0, Math.round(Number(stock) || 0));
            const decomp = decomposeStockByLevels(numericStock, finalLevels);
            setStockByLevel(Object.fromEntries(decomp.parts.map((pt) => [pt.id, pt.qty])), finalLevels);
        }
    }, [setPresentations, syncLegacyProjections, stock, setStockByLevel]);

    const handleSelectMode = useCallback((nextMode) => {
        setPackagingMode(nextMode);
        if (nextMode === 'granel') {
            setPackagingType?.('granel');
            return;
        }

        const currentBase = presentations[0] || {
            id: 'unit',
            level: 1,
            name: 'Unidad',
            containsQty: 1,
            factorToBase: 1,
            sellable: true,
            priceUsd: parseFloat(priceUsd) || null,
            priceCop: parseFloat(priceCop) || null,
            costUsd: parseFloat(costUsd) || null,
        };

        if (nextMode === 'simple') {
            const simpleLevels = computeFactorToBase([{ ...currentBase, id: 'unit', level: 1, containsQty: 1, sellable: true }]);
            setPresentations(simpleLevels);
            setCostSourceLevel('unit');
            syncLegacyProjections(simpleLevels, 'simple', 'unit');
            if (stock !== undefined) setStock?.(stock);
            return;
        }

        // nextMode === 'multilevel'
        let multiLevels;
        if (presentations.length > 1) {
            multiLevels = computeFactorToBase(presentations.map((l) => ({ ...l, sellable: true })));
        } else {
            const preset = buildPresetPresentations('bulto_unidad');
            preset[0] = { ...preset[0], priceUsd: currentBase.priceUsd, priceCop: currentBase.priceCop, costUsd: currentBase.costUsd };
            multiLevels = computeFactorToBase(
                currentBase.costUsd > 0 ? reconcileCostCascade(preset, 'unit', currentBase.costUsd) : preset,
            );
        }
        const topId = multiLevels[multiLevels.length - 1]?.id || 'pack';
        setPresentations(multiLevels);
        setCostSourceLevel(topId);
        syncLegacyProjections(multiLevels, 'multilevel', topId);
        const numericStock = Math.max(0, Math.round(Number(stock) || 0));
        const decomp = decomposeStockByLevels(numericStock, multiLevels);
        setStockByLevel(Object.fromEntries(decomp.parts.map((pt) => [pt.id, pt.qty])), multiLevels);
    }, [
        setPackagingMode,
        setPackagingType,
        presentations,
        priceUsd,
        priceCop,
        costUsd,
        setPresentations,
        setCostSourceLevel,
        syncLegacyProjections,
        stock,
        setStock,
        setStockByLevel,
    ]);

    const handleChangeCostSourceLevel = useCallback((nextSourceId) => {
        setCostSourceLevel(nextSourceId);
        const normalized = computeFactorToBase(presentations);
        const activeSrc = normalized.find((l) => l.id === nextSourceId);
        if (activeSrc?.costUsd > 0) {
            const updated = reconcileCostCascade(normalized, nextSourceId, activeSrc.costUsd);
            setPresentations(updated);
            syncLegacyProjections(updated, packagingMode, nextSourceId);
        }
    }, [setCostSourceLevel, presentations, setPresentations, syncLegacyProjections, packagingMode]);

    return {
        packagingMode,
        presentations,
        costSourceLevel,
        stockByLevel,
        setStockByLevel,
        handleSelectMode,
        handleChangePresentations,
        handleChangeCostSourceLevel,
    };
}
