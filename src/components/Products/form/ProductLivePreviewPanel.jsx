import React from 'react';
import { Package, AlertTriangle, CheckCircle2, Barcode, Eye } from 'lucide-react';
import {
    computeFactorToBase,
    validatePresentationCoherence,
    pluralizePresentationName,
    decomposeStockByLevels,
} from '../../../utils/presentations';
import { round2 } from '../../../utils/dinero';
import { resolveLanImageUrl } from '../../../utils/imageFallback';

const USD_UI = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUsd = (n) => USD_UI.format(round2(n));

export default function ProductLivePreviewPanel({
    name,
    barcode,
    image,
    packagingMode = 'simple',
    presentations = [],
    stock = '',
    stockByLevel = {},
    priceUsd = '',
    effectiveRate = 1,
    copEnabled = false,
    copPrimary = false,
    tasaCop = 0,
}) {
    const levels = computeFactorToBase(presentations);
    const sellables = [...levels].filter((l) => l.sellable).reverse();
    const isGranel = packagingMode === 'granel';

    const baseName = levels[0]?.name || 'Unidad';
    const numericStock = isGranel
        ? Number(stock) || 0
        : levels.length > 1 && Object.keys(stockByLevel || {}).length > 0
            ? levels.reduce((sum, l) => sum + Math.max(0, Math.round(Number(stockByLevel[l.id]) || 0)) * l.factorToBase, 0)
            : Math.max(0, Math.round(Number(stock) || 0));

    const decomp = !isGranel && levels.length > 1 ? decomposeStockByLevels(numericStock, levels) : null;
    const warnings = isGranel ? [] : validatePresentationCoherence(levels);

    const initials = (name || 'NP')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() || '')
        .join('') || 'NP';

    const formatMoney = (lvlUsd, lvlCop) => {
        if (copEnabled && copPrimary && tasaCop > 0) {
            const cop = lvlCop > 0 ? lvlCop : Math.round((lvlUsd || 0) * tasaCop);
            return `${cop.toLocaleString('es-CO')} COP`;
        }
        return `$${fmtUsd(lvlUsd || 0)}`;
    };

    const barcodesSummary = [
        ...(barcode ? [{ label: 'Base', code: barcode }] : []),
        ...levels.filter((l) => l.barcode).map((l) => ({ label: l.name, code: l.barcode })),
    ];

    return (
        <aside
            data-testid="product-live-preview"
            className="rounded-3xl border border-surface-200 dark:border-surface-700/70 bg-surface-50/80 dark:bg-surface-900/60 p-4 space-y-4"
            aria-label="Vista previa en Caja"
        >
            <div className="flex items-center justify-between">
                <span className="text-[11px] font-black text-surface-500 uppercase tracking-wider flex items-center gap-1.5">
                    <Eye size={13} aria-hidden="true" /> Vista previa en Caja
                </span>
                {!isGranel && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-brand-light text-brand-dark dark:bg-surface-800 dark:text-brand">
                        {sellables.length} {sellables.length === 1 ? 'opción de venta' : 'opciones de venta'}
                    </span>
                )}
            </div>

            {/* Simulación fiel de tarjeta en Vender */}
            <div className="rounded-3xl bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-800 p-3.5 shadow-sm space-y-3">
                <div className="flex items-start justify-between gap-2">
                    <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 font-mono tabular-nums">
                        {isGranel ? `${stock || 0} kg/L` : `${numericStock} ${pluralizePresentationName(baseName, numericStock)}`}
                    </span>
                    {!isGranel && levels.length > 1 && (
                        <span className="text-[10px] font-mono font-bold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-lg flex items-center gap-1">
                            <Package size={10} aria-hidden="true" /> ×{levels[levels.length - 1].factorToBase}
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-surface-50 dark:bg-surface-800 flex items-center justify-center overflow-hidden shrink-0 border border-surface-200 dark:border-surface-700">
                        {image ? (
                            <img src={resolveLanImageUrl(image)} alt={name || 'Vista previa'} className="w-full h-full object-contain p-1" />
                        ) : (
                            <span className="text-sm font-black text-surface-400">{initials}</span>
                        )}
                    </div>
                    <div className="min-w-0">
                        <p className="text-sm font-black text-surface-800 dark:text-white leading-snug line-clamp-2">
                            {name?.trim() || 'Nombre del artículo'}
                        </p>
                        {decomp && (
                            <p className="text-[10px] font-mono text-surface-500 mt-0.5 truncate">
                                {decomp.text}
                            </p>
                        )}
                    </div>
                </div>

                {isGranel ? (
                    <div className="w-full px-3 py-2 rounded-xl bg-[#006A71] text-white flex items-center justify-between font-mono tabular-nums">
                        <span className="text-[10px] font-black uppercase bg-white text-teal-950 px-1.5 py-0.5 rounded">Granel</span>
                        <span className="text-sm font-black">${fmtUsd(parseFloat(priceUsd) || 0)}</span>
                    </div>
                ) : (
                    <div className="space-y-1.5">
                        {sellables.map((lvl, idx) => (
                            <div
                                key={lvl.id}
                                className={`w-full px-3 py-2 rounded-xl flex items-center justify-between font-mono tabular-nums ${
                                    idx === 0
                                        ? 'bg-[#006A71] text-white'
                                        : 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800/60'
                                }`}
                            >
                                <span className="text-[11px] font-black uppercase flex items-center gap-1.5">
                                    <span>{lvl.name}</span>
                                    {lvl.factorToBase > 1 && (
                                        <span className={`text-[9px] px-1.5 py-0.5 rounded ${idx === 0 ? 'bg-white/20 text-white' : 'bg-emerald-200/70 text-emerald-900'}`}>
                                            ×{lvl.factorToBase}
                                        </span>
                                    )}
                                </span>
                                <span className="text-xs font-black">
                                    {formatMoney(lvl.priceUsd, lvl.priceCop)}
                                    {effectiveRate > 0 && lvl.priceUsd > 0 && (
                                        <span className="opacity-75 font-semibold text-[10px] ml-1.5">
                                            · {fmtUsd(lvl.priceUsd * effectiveRate)} Bs
                                        </span>
                                    )}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Códigos configurados */}
            {barcodesSummary.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {barcodesSummary.map((b, i) => (
                        <span
                            key={i}
                            className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-1 rounded-lg bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-300"
                        >
                            <Barcode size={11} aria-hidden="true" /> {b.label}: {b.code}
                        </span>
                    ))}
                </div>
            )}

            {/* Alertas comerciales en vivo */}
            {warnings.length > 0 ? (
                <div className="space-y-1.5">
                    {warnings.map((w, idx) => (
                        <div
                            key={idx}
                            role="status"
                            className={`p-2.5 rounded-xl border text-[11px] font-bold flex items-start gap-2 ${
                                w.severity === 'error'
                                    ? 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300'
                                    : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300'
                            }`}
                        >
                            <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                            <span>{w.message}</span>
                        </div>
                    ))}
                </div>
            ) : (
                !isGranel && sellables.some((l) => l.priceUsd > 0) && (
                    <div className="p-2.5 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/20 border border-emerald-200/70 dark:border-emerald-800/50 text-[11px] font-bold text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
                        <CheckCircle2 size={14} className="shrink-0" aria-hidden="true" />
                        <span>Presentaciones y precios coherentes para vender en Caja.</span>
                    </div>
                )
            )}
        </aside>
    );
}
