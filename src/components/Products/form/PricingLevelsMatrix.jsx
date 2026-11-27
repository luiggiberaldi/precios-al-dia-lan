import React, { useState } from 'react';
import { Banknote, AlertTriangle, TrendingUp } from 'lucide-react';
import ProductCostFactorControl from '../ProductCostFactorControl';
import PricingModeSelector from '../PricingModeSelector';
import {
    computeFactorToBase,
    reconcileCostCascade,
    suggestLevelPrice,
    pluralizePresentationName,
} from '../../../utils/presentations';
import { round2, round4 } from '../../../utils/dinero';
import { roundDerivedPrice, formatPriceUsdInput } from '../../../utils/productProcessor';
import { loadTaxConfig } from '../../../config/taxConfig';
import { isLiquidProduct } from '../../../utils/granel';

const USD_UI = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUsd = (n) => USD_UI.format(round2(n));

export default function PricingLevelsMatrix({
    packagingMode = 'simple',
    presentations = [],
    onChangePresentations,
    costSourceLevel = 'unit',
    onChangeCostSourceLevel,
    priceUsd, handlePriceUsdChange,
    priceBs, handlePriceBsChange,
    priceCop, handlePriceCopChange,
    pricingMode, setPricingMode,
    priceBsUsdRef, setPriceBsUsdRef,
    costUsd, handleCostUsdChange,
    costBs, handleCostBsChange,
    costCop, handleCostCopChange,
    costFactor, handleCostFactorChange,
    effectiveRate = 1,
    bcvRate,
    copEnabled = false,
    copPrimary = false,
    tasaCop = 0,
    ivaMode = '',
    granelUnit = 'kg',
}) {
    const [costBsDraft, setCostBsDraft] = useState(null);
    const [costUsdDraft, setCostUsdDraft] = useState(null);
    const [priceBsDrafts, setPriceBsDrafts] = useState({});
    const [priceUsdDrafts, setPriceUsdDrafts] = useState({});

    const safeRate = effectiveRate > 0 ? effectiveRate : 1;
    const taxCfg = loadTaxConfig();
    const includedIvaRate = taxCfg.ivaEnabled && taxCfg.ivaIncluded && ivaMode !== 'exento' ? taxCfg.ivaRate : 0;

    // ─── MODO GRANEL (flujo 1:1 existente) ────────────────────────────────
    if (packagingMode === 'granel') {
        const parsedPrice = parseFloat(priceUsd) || 0;
        const parsedCost = parseFloat(costUsd) || 0;
        const marginPct = parsedPrice > 0 && parsedCost > 0 ? ((parsedPrice - parsedCost) / parsedPrice) * 100 : null;
        const unitLabel = isLiquidProduct(granelUnit) ? 'Litro' : 'Kilo';

        return (
            <section className="space-y-3" aria-label="Costos y precios a granel">
                <div className="bg-surface-50 dark:bg-surface-800/30 p-3.5 rounded-2xl border border-surface-200 dark:border-surface-700/60 space-y-2.5">
                    <span className="text-[10px] font-black text-surface-500 uppercase tracking-wider block">
                        Costo por {unitLabel}
                    </span>
                    <div className="grid grid-cols-2 gap-2.5">
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-surface-400">
                                {copEnabled && copPrimary && tasaCop > 0 ? 'COP' : '$'}
                            </span>
                            {copEnabled && copPrimary && tasaCop > 0 ? (
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    aria-label="Costo en COP"
                                    value={costCop}
                                    onChange={(e) => handleCostCopChange?.(e.target.value)}
                                    placeholder="4100"
                                    className="w-full min-h-[44px] bg-white dark:bg-surface-900 px-3 pl-11 rounded-xl font-mono font-bold text-sm text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                                />
                            ) : (
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    aria-label="Costo en USD"
                                    value={costUsd}
                                    onChange={(e) => handleCostUsdChange?.(e.target.value)}
                                    placeholder="0.00"
                                    className="w-full min-h-[44px] bg-white dark:bg-surface-900 px-3 pl-7 rounded-xl font-mono font-bold text-sm text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                                />
                            )}
                        </div>
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-surface-400">Bs</span>
                            <input
                                type="number"
                                inputMode="decimal"
                                aria-label="Costo en Bs"
                                value={costBs}
                                onChange={(e) => handleCostBsChange?.(e.target.value)}
                                placeholder="0.00"
                                className="w-full min-h-[44px] bg-white dark:bg-surface-900 px-3 pl-8 rounded-xl font-mono font-bold text-sm text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                            />
                        </div>
                    </div>
                    {handleCostFactorChange && (
                        <ProductCostFactorControl costFactor={costFactor} onChange={handleCostFactorChange} />
                    )}
                </div>

                <div className="bg-white dark:bg-surface-900 p-3.5 rounded-2xl border border-surface-200 dark:border-surface-700 space-y-2.5">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] font-black text-brand uppercase tracking-wider">
                            Precio de Venta / {unitLabel}
                        </span>
                        {marginPct !== null && (
                            <span className={`text-[11px] font-mono font-black px-2 py-0.5 rounded-lg ${
                                marginPct < 0 ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'
                            }`}>
                                Margen {marginPct.toFixed(1)}%
                            </span>
                        )}
                    </div>
                    {copEnabled && (
                        <input
                            type="number"
                            inputMode="decimal"
                            aria-label="Precio COP por granel"
                            value={priceCop}
                            onChange={(e) => handlePriceCopChange?.(e.target.value)}
                            placeholder="COP"
                            className="w-full min-h-[44px] bg-amber-50/70 dark:bg-amber-900/20 px-3 rounded-xl font-mono font-bold text-sm text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800 outline-none"
                        />
                    )}
                    <div className="grid grid-cols-2 gap-2.5">
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-emerald-600">$</span>
                            <input
                                type="number"
                                inputMode="decimal"
                                aria-label="Precio USD por granel"
                                value={priceUsd}
                                onChange={(e) => handlePriceUsdChange?.(e.target.value)}
                                placeholder="0.00"
                                className="w-full min-h-[44px] bg-emerald-50/50 dark:bg-emerald-950/20 px-3 pl-7 rounded-xl font-mono font-black text-sm text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 outline-none"
                            />
                        </div>
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-brand">Bs</span>
                            <input
                                type="number"
                                inputMode="decimal"
                                aria-label="Precio Bs por granel"
                                value={priceBs}
                                onChange={(e) => handlePriceBsChange?.(e.target.value)}
                                placeholder="0.00"
                                className="w-full min-h-[44px] bg-brand-light/40 dark:bg-surface-800 px-3 pl-8 rounded-xl font-mono font-black text-sm text-brand-dark dark:text-brand border border-surface-200 dark:border-surface-700 outline-none"
                            />
                        </div>
                    </div>
                    {setPricingMode && (
                        <PricingModeSelector
                            compact
                            value={pricingMode}
                            onChange={setPricingMode}
                            effectiveRate={effectiveRate}
                            bcvRate={bcvRate}
                        />
                    )}
                    {pricingMode === 'dual_usd' && (
                        <input
                            type="number"
                            inputMode="decimal"
                            aria-label="Referencia USD para Bs"
                            value={priceBsUsdRef}
                            onChange={(e) => setPriceBsUsdRef?.(e.target.value)}
                            placeholder={`Ref $ para Bs (ej: ${priceUsd || '0.00'})`}
                            className="w-full min-h-[40px] bg-emerald-50/40 dark:bg-surface-950 px-3 rounded-xl font-mono font-bold text-xs border border-emerald-300 dark:border-emerald-800 outline-none"
                        />
                    )}
                </div>
            </section>
        );
    }

    // ─── MODO SIMPLE / MULTINIVEL (1, 2 o 3 niveles) ──────────────────────
    const levels = computeFactorToBase(presentations);
    const activeCostLevel = levels.find((l) => l.id === costSourceLevel) || levels[levels.length - 1] || levels[0];
    const sellableDesc = [...levels].filter((l) => l.sellable).reverse();
    const anchorLevel = levels.find((l) => l.sellable && l.priceUsd > 0) || sellableDesc[0];

    const displayedCostUsd = costUsdDraft !== null
        ? costUsdDraft
        : activeCostLevel?.costUsd > 0
            ? String(activeCostLevel.costUsd)
            : (levels.length === 1 && costUsd ? String(costUsd) : '');
    const displayedCostBs = costBsDraft !== null
        ? costBsDraft
        : (activeCostLevel?.costUsd > 0 && effectiveRate > 0
            ? fmtUsd(activeCostLevel.costUsd * effectiveRate)
            : (levels.length === 1 ? costBs : ''));

    const updateCostFromSourceUsd = (rawVal) => {
        setCostUsdDraft(rawVal);
        setCostBsDraft(null);
        const parsed = parseFloat(String(rawVal).replace(/,/g, '.'));
        const nextCost = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        const cascaded = reconcileCostCascade(levels, activeCostLevel.id, nextCost);
        onChangePresentations(cascaded);

        const factorNum = parseFloat(costFactor) || 0;
        if (factorNum > 0 && nextCost > 0 && activeCostLevel.sellable) {
            const { price: derivedSell } = roundDerivedPrice(nextCost / factorNum, nextCost, factorNum);
            const pricedLevels = cascaded.map((l) => (
                l.id === activeCostLevel.id
                    ? { ...l, priceUsd: derivedSell, priceCop: copEnabled && tasaCop > 0 ? Math.round(derivedSell * tasaCop) : l.priceCop }
                    : l
            ));
            onChangePresentations(pricedLevels);
        }

        if (nextCost !== null) {
            handleCostUsdChange?.(String(nextCost));
        } else {
            handleCostUsdChange?.('');
        }
    };

    const handleCostFactorWithLevels = (nextFactorStr) => {
        handleCostFactorChange?.(nextFactorStr);
        const factor = parseFloat(nextFactorStr);
        const targetLvl = activeCostLevel.sellable ? activeCostLevel : (sellableDesc[0] || levels[0]);
        if (!(factor > 0) || !(targetLvl?.costUsd > 0)) return;
        const { price: sellPrice } = roundDerivedPrice(targetLvl.costUsd / factor, targetLvl.costUsd, factor);
        const next = levels.map((l) => (
            l.id === targetLvl.id
                ? {
                    ...l,
                    priceUsd: sellPrice,
                    priceCop: copEnabled && tasaCop > 0 ? round2(sellPrice * tasaCop) : l.priceCop,
                }
                : l
        ));
        onChangePresentations(next);
    };

    const handleLevelUsdChange = (lvlId, rawVal) => {
        setPriceUsdDrafts((prev) => ({ ...prev, [lvlId]: rawVal }));
        setPriceBsDrafts((prev) => ({ ...prev, [lvlId]: undefined }));
        const cleaned = String(rawVal).replace(/,/g, '.');
        const parsed = cleaned === '' ? null : Number(cleaned);
        const nextUsd = parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : null;

        const next = levels.map((l) => (
            l.id === lvlId
                ? {
                    ...l,
                    priceUsd: nextUsd,
                    priceCop: copEnabled && tasaCop > 0 && nextUsd !== null ? Math.round(nextUsd * tasaCop) : (nextUsd === null ? null : l.priceCop),
                }
                : l
        ));
        onChangePresentations(next);
    };

    const handleLevelBsChange = (lvlId, rawBs) => {
        setPriceBsDrafts((prev) => ({ ...prev, [lvlId]: rawBs }));
        const amountBs = Number(String(rawBs).replace(/,/g, '.'));
        const nextUsd = Number.isFinite(amountBs) && amountBs > 0 && safeRate > 0
            ? round4(amountBs / safeRate)
            : null;
        const next = levels.map((l) => (
            l.id === lvlId
                ? {
                    ...l,
                    priceUsd: nextUsd,
                    priceCop: copEnabled && tasaCop > 0 && nextUsd !== null ? Math.round(nextUsd * tasaCop) : (nextUsd === null ? null : l.priceCop),
                }
                : l
        ));
        onChangePresentations(next);
    };

    const handleLevelCopChange = (lvlId, rawCop) => {
        const amountCop = Number(String(rawCop).replace(/,/g, '.'));
        const validCop = Number.isFinite(amountCop) && amountCop > 0 ? Math.round(amountCop) : null;
        const nextUsd = validCop && tasaCop > 0 ? round4(validCop / tasaCop) : null;
        const next = levels.map((l) => (
            l.id === lvlId ? { ...l, priceCop: validCop, priceUsd: nextUsd } : l
        ));
        onChangePresentations(next);
    };

    const applyQuickSuggestion = (lvlId, discountPct) => {
        if (!anchorLevel || anchorLevel.id === lvlId) return;
        const suggestion = suggestLevelPrice(levels, lvlId, {
            anchorLevelId: anchorLevel.id,
            discountPct,
        });
        if (!suggestion.priceUsd) return;
        setPriceBsDrafts((prev) => ({ ...prev, [lvlId]: undefined }));
        const next = levels.map((l) => (
            l.id === lvlId
                ? {
                    ...l,
                    priceUsd: suggestion.priceUsd,
                    priceCop: suggestion.priceCop ?? (copEnabled && tasaCop > 0 ? Math.round(suggestion.priceUsd * tasaCop) : l.priceCop),
                }
                : l
        ));
        onChangePresentations(next);
    };

    return (
        <section className="space-y-3.5" aria-label="Costos y precios por presentación">
            {/* BLOQUE 1: COSTO SEGÚN FACTURA */}
            <div className="bg-surface-50 dark:bg-surface-800/30 p-3.5 rounded-2xl border border-surface-200 dark:border-surface-700/60 space-y-2.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs font-bold text-surface-600 dark:text-surface-300 uppercase tracking-wide">
                        Costo de compra {levels.length > 1 ? `(${activeCostLevel.name})` : ''}
                    </span>

                    {levels.length > 1 && (
                        <div className="flex items-center gap-1 bg-surface-200/70 dark:bg-surface-800 p-1 rounded-xl">
                            {levels.map((lvl) => {
                                const selected = activeCostLevel.id === lvl.id;
                                return (
                                    <button
                                        key={lvl.id}
                                        type="button"
                                        data-testid={`cost-source-${lvl.id}`}
                                        onClick={() => onChangeCostSourceLevel?.(lvl.id)}
                                        className={`min-h-[32px] px-2.5 py-1 rounded-lg text-[10px] font-black uppercase transition-colors cursor-pointer ${
                                            selected
                                                ? 'bg-white dark:bg-surface-900 text-brand-dark dark:text-brand shadow-2xs'
                                                : 'text-surface-500 hover:text-surface-700'
                                        }`}
                                    >
                                        {lvl.name}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-2.5 items-center">
                    <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-surface-400">
                            {copEnabled && copPrimary && tasaCop > 0 ? 'COP' : '$'}
                        </span>
                        {copEnabled && copPrimary && tasaCop > 0 ? (
                            <input
                                type="number"
                                inputMode="decimal"
                                aria-label="Costo en COP"
                                value={activeCostLevel.costUsd > 0 ? Math.round(activeCostLevel.costUsd * tasaCop) : costCop}
                                onChange={(e) => {
                                    const val = parseFloat(e.target.value) || 0;
                                    updateCostFromSourceUsd(tasaCop > 0 ? val / tasaCop : 0);
                                }}
                                placeholder="4100"
                                className="w-full min-h-[44px] bg-white dark:bg-surface-900 px-3 pl-11 rounded-xl font-mono font-bold text-sm text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                            />
                        ) : (
                            <input
                                type="number"
                                inputMode="decimal"
                                aria-label="Costo en USD"
                                value={displayedCostUsd}
                                onChange={(e) => updateCostFromSourceUsd(e.target.value)}
                                onBlur={() => setCostUsdDraft(null)}
                                placeholder="0.00"
                                className="w-full min-h-[44px] bg-white dark:bg-surface-900 px-3 pl-7 rounded-xl font-mono font-bold text-sm text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50 tabular-nums"
                            />
                        )}
                    </div>

                    <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-surface-400">Bs</span>
                        <input
                            type="number"
                            inputMode="decimal"
                            aria-label="Costo en Bs"
                            value={displayedCostBs}
                            onChange={(e) => {
                                const raw = e.target.value;
                                setCostBsDraft(raw);
                                const bsNum = parseFloat(raw.replace(/,/g, '.'));
                                const nextUsd = Number.isFinite(bsNum) && bsNum > 0 && safeRate > 0 ? bsNum / safeRate : null;
                                const cascaded = reconcileCostCascade(levels, activeCostLevel.id, nextUsd);
                                onChangePresentations(cascaded);
                                handleCostBsChange?.(raw);
                            }}
                            onBlur={() => setCostBsDraft(null)}
                            placeholder="0.00"
                            className="w-full min-h-[44px] bg-white dark:bg-surface-900 px-3 pl-8 rounded-xl font-mono font-bold text-sm text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50 tabular-nums"
                        />
                    </div>
                </div>

                {/* Desglose automático del costo entre niveles */}
                {levels.length > 1 && levels.some((l) => l.costUsd > 0) && (
                    <div className="flex items-center gap-2 flex-wrap pt-0.5 text-[11px] font-mono tabular-nums text-surface-600 dark:text-surface-300">
                        {levels.map((lvl) => (
                            <span key={lvl.id} className="px-2 py-0.5 rounded-lg bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 font-bold">
                                ${fmtUsd(lvl.costUsd || 0)} / {lvl.name}
                            </span>
                        ))}
                    </div>
                )}

                {handleCostFactorChange && (
                    <ProductCostFactorControl costFactor={costFactor} onChange={handleCostFactorWithLevels} />
                )}
            </div>

            {/* BLOQUE 2: PRECIOS DE VENTA POR CADA PRESENTACIÓN ACTIVA */}
            <div className="space-y-2.5">
                <div className="flex items-center justify-between px-1">
                    <span className="text-xs font-bold text-surface-500 dark:text-surface-400 uppercase tracking-wide flex items-center gap-1.5">
                        <Banknote size={13} aria-hidden="true" /> Precios de venta en Caja
                    </span>
                    {setPricingMode && (
                        <button
                            type="button"
                            onClick={() => setPricingMode(pricingMode === 'dual_usd' ? 'tasa_dia' : 'dual_usd')}
                            className={`text-[10px] font-black px-2.5 py-1 rounded-lg border cursor-pointer transition-colors ${
                                pricingMode === 'dual_usd'
                                    ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                    : 'border-surface-200 bg-surface-50 text-surface-500 hover:border-surface-300'
                            }`}
                        >
                            {pricingMode === 'dual_usd' ? 'Dual $ Ref activo' : '+ Dual $ para Bs'}
                        </button>
                    )}
                </div>

                {sellableDesc.map((lvl) => {
                    const priceVal = lvl.priceUsd > 0 ? lvl.priceUsd : 0;
                    const costVal = lvl.costUsd > 0 ? lvl.costUsd : 0;
                    const netPrice = includedIvaRate > 0 && priceVal > 0 ? round2(priceVal / (1 + includedIvaRate / 100)) : priceVal;
                    const marginPct = netPrice > 0 && costVal > 0 ? ((netPrice - costVal) / netPrice) * 100 : null;
                    const canSuggestFromOther = Boolean(anchorLevel && anchorLevel.id !== lvl.id && anchorLevel.priceUsd > 0);
                    const bsShown = priceBsDrafts[lvl.id] !== undefined
                        ? priceBsDrafts[lvl.id]
                        : (priceVal > 0 && effectiveRate > 0 ? fmtUsd(priceVal * effectiveRate) : '');

                    return (
                        <div
                            key={lvl.id}
                            data-testid={`price-row-${lvl.id}`}
                            className="bg-white dark:bg-surface-900 p-3.5 rounded-2xl border border-surface-200 dark:border-surface-700 space-y-2.5 shadow-2xs"
                        >
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-black text-surface-800 dark:text-white uppercase">
                                        {lvl.name}
                                    </span>
                                    {lvl.factorToBase > 1 && (
                                        <span className="text-[10px] font-mono tabular-nums font-bold px-2 py-0.5 rounded-md bg-brand-light text-brand-dark dark:bg-surface-800 dark:text-brand">
                                            ×{lvl.factorToBase} {pluralizePresentationName(levels[0].name, lvl.factorToBase)}
                                        </span>
                                    )}
                                    {costVal > 0 && (
                                        <span className="text-[10px] font-mono tabular-nums text-surface-500">
                                            Costo: ${fmtUsd(costVal)}
                                        </span>
                                    )}
                                </div>

                                <div className="flex items-center gap-1.5">
                                    {canSuggestFromOther && (
                                        <div className="flex items-center gap-1">
                                            {[0, 5, 10].map((disc) => (
                                                <button
                                                    key={disc}
                                                    type="button"
                                                    onClick={() => applyQuickSuggestion(lvl.id, disc)}
                                                    className="min-h-[28px] px-2 rounded-lg bg-surface-100 hover:bg-brand-light dark:bg-surface-800 text-[10px] font-bold text-surface-600 hover:text-brand-dark cursor-pointer transition-colors"
                                                    title={disc === 0 ? 'Proporcional exacto' : `Con ${disc}% de descuento por volumen`}
                                                >
                                                    {disc === 0 ? 'Auto' : `-${disc}%`}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    {marginPct !== null && (
                                        <span className={`text-[10px] font-mono tabular-nums font-black px-2 py-0.5 rounded-lg flex items-center gap-1 ${
                                            marginPct < 0
                                                ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300'
                                                : marginPct < 15
                                                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
                                                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                                        }`}>
                                            <TrendingUp size={10} aria-hidden="true" />
                                            {marginPct.toFixed(1)}%
                                        </span>
                                    )}
                                </div>
                            </div>

                            {copEnabled && (
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-black text-amber-600">COP</span>
                                    <input
                                        type="number"
                                        inputMode="decimal"
                                        aria-label={`Precio COP de ${lvl.name}`}
                                        value={lvl.priceCop || ''}
                                        onChange={(e) => handleLevelCopChange(lvl.id, e.target.value)}
                                        placeholder="0"
                                        className="w-full min-h-[44px] bg-amber-50/60 dark:bg-amber-900/20 px-3 pl-11 rounded-xl font-mono font-bold text-sm text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800 outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
                                    />
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-2.5">
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-emerald-600">$</span>
                                    <input
                                        type="number"
                                        inputMode="decimal"
                                        aria-label={`Precio USD de ${lvl.name}`}
                                        value={priceUsdDrafts[lvl.id] !== undefined ? priceUsdDrafts[lvl.id] : (lvl.priceUsd > 0 ? formatPriceUsdInput(lvl.priceUsd) : '')}
                                        onChange={(e) => handleLevelUsdChange(lvl.id, e.target.value)}
                                        onBlur={() => setPriceUsdDrafts((prev) => ({ ...prev, [lvl.id]: undefined }))}
                                        placeholder="0.00"
                                        className="w-full min-h-[44px] bg-emerald-50/40 dark:bg-emerald-950/20 px-3 pl-7 rounded-xl font-mono font-black text-sm text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 tabular-nums"
                                    />
                                </div>

                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-brand">Bs</span>
                                    <input
                                        type="number"
                                        inputMode="decimal"
                                        aria-label={`Precio Bs de ${lvl.name}`}
                                        value={bsShown}
                                        onChange={(e) => handleLevelBsChange(lvl.id, e.target.value)}
                                        onBlur={() => setPriceBsDrafts((prev) => ({ ...prev, [lvl.id]: undefined }))}
                                        placeholder="0.00"
                                        className="w-full min-h-[44px] bg-brand-light/30 dark:bg-surface-800 px-3 pl-8 rounded-xl font-mono font-black text-sm text-brand-dark dark:text-brand border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50 tabular-nums"
                                    />
                                </div>
                            </div>

                            {pricingMode === 'dual_usd' && lvl.id === sellableDesc[0]?.id && (
                                <div className="pt-1">
                                    <label className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 block mb-1">
                                        Referencia $ si pagan en Bolívares
                                    </label>
                                    <input
                                        type="number"
                                        inputMode="decimal"
                                        aria-label={`Ref USD Bs de ${lvl.name}`}
                                        value={priceBsUsdRef || ''}
                                        onChange={(e) => setPriceBsUsdRef?.(e.target.value)}
                                        placeholder={priceVal > 0 ? fmtUsd(priceVal) : '0.00'}
                                        className="w-full min-h-[40px] bg-emerald-50/40 dark:bg-surface-950 px-3 rounded-xl font-mono font-bold text-xs text-emerald-800 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-800 outline-none"
                                    />
                                </div>
                            )}

                            {priceVal > 0 && costVal === 0 && (
                                <p className="text-[10px] font-semibold text-amber-600 flex items-center gap-1">
                                    <AlertTriangle size={11} aria-hidden="true" /> Sin costo asignado: no verás tu ganancia real.
                                </p>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
