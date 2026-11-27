import React from 'react';
import { AlertTriangle, Boxes } from 'lucide-react';
import {
    computeFactorToBase,
    decomposeStockByLevels,
    pluralizePresentationName,
} from '../../../utils/presentations';
import {
    GRANEL_MODE_GR_ML,
    formatGranelInputValue,
    parseGranelThreshold,
    parseWeightInput,
    isLiquidProduct,
} from '../../../utils/granel';

export default function StockBreakdownInput({
    packagingMode = 'simple',
    presentations = [],
    stock = '',
    setStock,
    stockByLevel = {},
    setStockByLevel,
    lowStockAlert = '5',
    setLowStockAlert,
    granelUnit = 'kg',
    granelMode = 'kg_lt',
}) {
    const isGranel = packagingMode === 'granel';
    const levels = computeFactorToBase(presentations);
    const hasMultipleLevels = !isGranel && levels.length > 1;
    const baseLevel = levels[0] || { id: 'unit', name: 'Unidad' };

    const alertLabel = isGranel
        ? (granelMode === GRANEL_MODE_GR_ML
            ? (isLiquidProduct(granelUnit) ? 'ml' : 'g')
            : (isLiquidProduct(granelUnit) ? 'L' : 'kg'))
        : pluralizePresentationName(baseLevel.name, Number(lowStockAlert) || 0);

    const displayedAlert = isGranel
        ? formatGranelInputValue(lowStockAlert, granelMode)
        : lowStockAlert;

    const handleAlertChange = (value) => {
        if (value === '') {
            setLowStockAlert('');
            return;
        }
        if (!isGranel) {
            setLowStockAlert(value);
            return;
        }
        const canonical = parseGranelThreshold(value, granelMode);
        if (canonical !== null) setLowStockAlert(String(canonical));
    };

    if (!hasMultipleLevels) {
        const stockLabel = isGranel
            ? (granelMode === GRANEL_MODE_GR_ML
                ? (isLiquidProduct(granelUnit) ? 'Stock Inicial (ml)' : 'Stock Inicial (gramos)')
                : (isLiquidProduct(granelUnit) ? 'Stock Inicial (Litro)' : 'Stock Inicial (Kg)'))
            : `Stock (${pluralizePresentationName(baseLevel.name, 2)})`;

        return (
            <section className="grid grid-cols-2 gap-3" aria-label="Inventario y alerta">
                <div>
                    <label htmlFor="product-stock-single" className="text-xs font-bold text-surface-500 ml-1 mb-1 block uppercase">
                        {stockLabel}
                    </label>
                    <input
                        id="product-stock-single"
                        type="number"
                        step={isGranel ? 'any' : '1'}
                        inputMode={isGranel ? (granelMode === GRANEL_MODE_GR_ML ? 'numeric' : 'decimal') : 'numeric'}
                        value={stock}
                        onChange={(e) => setStock(e.target.value)}
                        placeholder={isGranel ? (granelMode === GRANEL_MODE_GR_ML ? '1000' : '0.000') : '0'}
                        className="w-full min-h-[44px] bg-surface-50 dark:bg-surface-800 px-3.5 py-2.5 rounded-xl font-mono font-bold text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50 text-sm tabular-nums"
                    />
                    {isGranel && granelMode === GRANEL_MODE_GR_ML && stock !== '' && (() => {
                        const pWeight = parseWeightInput(stock, GRANEL_MODE_GR_ML);
                        const cUnit = isLiquidProduct(granelUnit) ? 'L' : 'kg';
                        if (!pWeight) return null;
                        return (
                            <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-mono font-bold mt-1 ml-1">
                                = {pWeight.canonicalKg.toFixed(3)} {cUnit} en inventario
                            </p>
                        );
                    })()}
                </div>

                <div>
                    <label htmlFor="product-alert-single" className="text-xs font-bold text-amber-600 dark:text-amber-400 ml-1 mb-1 flex items-center gap-1 uppercase">
                        <AlertTriangle size={11} aria-hidden="true" /> Alerta mín. ({alertLabel})
                    </label>
                    <input
                        id="product-alert-single"
                        type="number"
                        step={isGranel ? 'any' : '1'}
                        inputMode={isGranel ? 'decimal' : 'numeric'}
                        value={displayedAlert}
                        onChange={(e) => handleAlertChange(e.target.value)}
                        placeholder={isGranel ? (granelMode === GRANEL_MODE_GR_ML ? '5000' : '5') : '5'}
                        className="w-full min-h-[44px] bg-amber-50/70 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800/40 px-3.5 py-2.5 rounded-xl font-mono font-bold text-amber-800 dark:text-amber-300 outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 text-sm tabular-nums"
                    />
                </div>
            </section>
        );
    }

    // ─── MULTINIVEL (desglose por Caja / Blíster / Unidad sumado a base) ────
    const descLevels = [...levels].reverse();
    const numericStock = Math.max(0, Math.round(Number(stock) || 0));
    const derivedDecomp = decomposeStockByLevels(numericStock, levels);
    const activeMap = Object.keys(stockByLevel || {}).length > 0
        ? stockByLevel
        : Object.fromEntries(derivedDecomp.parts.map((pt) => [pt.id, pt.qty]));

    const totalUnits = descLevels.reduce(
        (acc, lvl) => acc + Math.max(0, Math.round(Number(activeMap[lvl.id]) || 0)) * lvl.factorToBase,
        0,
    );

    const upperFactor = descLevels[0]?.factorToBase || 1;
    const alertNum = Number(lowStockAlert) || 0;

    return (
        <section className="space-y-3 bg-surface-50/70 dark:bg-surface-800/30 p-3.5 rounded-2xl border border-surface-200 dark:border-surface-700/60" aria-label="Existencia desglosada">
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-bold text-surface-600 dark:text-surface-300 uppercase tracking-wide flex items-center gap-1.5">
                    <Boxes size={13} aria-hidden="true" /> Existencia actual
                </span>
                <span
                    data-testid="stock-total-base"
                    className="px-2.5 py-1 rounded-lg bg-white dark:bg-surface-900 border border-brand/25 font-mono tabular-nums text-xs font-black text-brand-dark dark:text-brand"
                >
                    Total: {totalUnits} {pluralizePresentationName(baseLevel.name, totalUnits)}
                </span>
            </div>

            <div className={`grid gap-2.5 ${descLevels.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                {descLevels.map((lvl) => (
                    <div key={lvl.id}>
                        <label
                            htmlFor={`stock-lvl-${lvl.id}`}
                            className="text-[10px] font-black text-surface-500 ml-1 mb-1 block uppercase truncate"
                        >
                            {pluralizePresentationName(lvl.name, 2)}
                        </label>
                        <input
                            id={`stock-lvl-${lvl.id}`}
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            aria-label={`Stock en ${lvl.name}`}
                            value={activeMap[lvl.id] === 0 ? '' : (activeMap[lvl.id] ?? '')}
                            onChange={(e) => {
                                const raw = e.target.value;
                                const nextQty = raw === '' ? 0 : Math.max(0, Math.trunc(Number(raw) || 0));
                                const nextMap = { ...activeMap, [lvl.id]: nextQty };
                                setStockByLevel?.(nextMap, levels);
                            }}
                            placeholder="0"
                            className="w-full min-h-[44px] bg-white dark:bg-surface-900 px-3 py-2 rounded-xl font-mono font-bold text-sm text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50 tabular-nums"
                        />
                    </div>
                ))}
            </div>

            <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                    <label htmlFor="product-alert-multi" className="text-[10px] font-black text-amber-600 dark:text-amber-400 ml-1 flex items-center gap-1 uppercase">
                        <AlertTriangle size={11} aria-hidden="true" /> Alerta stock bajo ({pluralizePresentationName(baseLevel.name, 2)})
                    </label>
                    {alertNum > 0 && upperFactor > 1 && (
                        <span className="text-[10px] font-mono tabular-nums font-bold text-amber-600/80">
                            = {(alertNum / upperFactor).toFixed(1)} {pluralizePresentationName(descLevels[0].name, 2)}
                        </span>
                    )}
                </div>
                <input
                    id="product-alert-multi"
                    type="number"
                    min="0"
                    step="1"
                    inputMode="numeric"
                    value={lowStockAlert}
                    onChange={(e) => setLowStockAlert(e.target.value)}
                    placeholder="5"
                    className="w-full min-h-[44px] bg-amber-50/70 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800/40 px-3.5 py-2 rounded-xl font-mono font-bold text-amber-800 dark:text-amber-300 outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 text-sm tabular-nums"
                />
            </div>
        </section>
    );
}
