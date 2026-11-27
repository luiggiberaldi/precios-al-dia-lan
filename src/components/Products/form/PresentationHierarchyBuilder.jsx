import React, { useState } from 'react';
import { Tag, Layers, Scale, Droplets, Plus, Trash2, Barcode, Check, AlertCircle } from 'lucide-react';
import {
    PRESENTATION_PRESETS,
    buildPresetPresentations,
    computeFactorToBase,
    pluralizePresentationName,
} from '../../../utils/presentations';
import { GRANEL_MODE_GR_ML, isLiquidProduct } from '../../../utils/granel';
import BarcodeDuplicateHint from '../BarcodeDuplicateHint';

const MODE_OPTIONS = [
    { id: 'simple', label: 'Unidad simple', desc: '1 presentación', Icon: Tag },
    { id: 'multilevel', label: 'Presentaciones', desc: '2 o 3 niveles', Icon: Layers },
    { id: 'granel', label: 'A granel', desc: 'Peso o volumen', Icon: Scale },
];

const QUICK_MULTILEVEL_PRESETS = [
    PRESENTATION_PRESETS.bulto_unidad,
    PRESENTATION_PRESETS.caja_unidad,
    PRESENTATION_PRESETS.caja_paquete_unidad,
    PRESENTATION_PRESETS.caja_blister_tableta,
];

export default function PresentationHierarchyBuilder({
    editingId = null,
    packagingMode = 'simple',
    onSelectMode,
    presentations = [],
    onChangePresentations,
    granelUnit = 'kg',
    setGranelUnit,
    granelMode = 'kg_lt',
}) {
    const [openBarcodes, setOpenBarcodes] = useState({});

    const normalized = computeFactorToBase(presentations);
    const hasPurchaseOnlyBulk = packagingMode === 'simple' && normalized.length > 1;
    const sellableCount = normalized.filter((l) => l.sellable).length;

    const handleNameChange = (idx, nextName) => {
        const next = normalized.map((lvl, i) => (i === idx ? { ...lvl, name: nextName } : lvl));
        onChangePresentations(next, { skipCompute: true });
    };

    const handleNameBlur = () => {
        onChangePresentations(computeFactorToBase(presentations));
    };

    const handleQtyChange = (idx, nextVal) => {
        const parsed = Math.max(2, Math.trunc(Number(nextVal) || 2));
        const next = normalized.map((lvl, i) => (i === idx ? { ...lvl, containsQty: parsed } : lvl));
        onChangePresentations(computeFactorToBase(next));
    };

    const handleToggleSellable = (idx) => {
        const target = normalized[idx];
        if (!target) return;
        if (target.sellable && sellableCount <= 1) return;
        const next = normalized.map((lvl, i) => (i === idx ? { ...lvl, sellable: !lvl.sellable } : lvl));
        onChangePresentations(computeFactorToBase(next));
    };

    const handleLevelBarcodeChange = (idx, val) => {
        const next = normalized.map((lvl, i) => (i === idx ? { ...lvl, barcode: val } : lvl));
        onChangePresentations(next, { skipCompute: true });
    };

    const handleApplyPreset = (presetId) => {
        const presetLevels = buildPresetPresentations(presetId);
        // Preservar precio/costo unitario si ya existían
        const oldUnit = normalized[0];
        if (oldUnit && (oldUnit.priceUsd > 0 || oldUnit.costUsd > 0)) {
            presetLevels[0] = {
                ...presetLevels[0],
                priceUsd: oldUnit.priceUsd,
                priceCop: oldUnit.priceCop,
                costUsd: oldUnit.costUsd,
            };
        }
        onChangePresentations(computeFactorToBase(presetLevels));
    };

    const handleAddThirdLevel = () => {
        if (normalized.length >= 3) return;
        const base = normalized[0] || { id: 'unit', level: 1, name: 'Unidad', containsQty: 1, sellable: true };
        const currentSecond = normalized[1] || { name: 'Paquete', containsQty: 6, sellable: true };
        const next = [
            base,
            { ...currentSecond, id: 'mid', level: 2, name: currentSecond.name === 'Caja' ? 'Paquete' : currentSecond.name },
            { id: 'pack', level: 3, name: 'Caja', containsQty: 4, sellable: true },
        ];
        onChangePresentations(computeFactorToBase(next));
    };

    const handleRemoveThirdLevel = () => {
        if (normalized.length <= 2) return;
        const next = [normalized[0], { ...normalized[1], id: 'pack', level: 2 }];
        onChangePresentations(computeFactorToBase(next));
    };

    const handleTogglePurchaseBulkInSimple = () => {
        if (hasPurchaseOnlyBulk) {
            onChangePresentations(computeFactorToBase([normalized[0]]));
        } else {
            const next = [
                normalized[0],
                { id: 'pack', level: 2, name: 'Bulto', containsQty: 24, sellable: false },
            ];
            onChangePresentations(computeFactorToBase(next));
        }
    };

    // Cadena de equivalencias legible: "1 Caja = 3 Blísters = 30 Tabletas"
    const chainText = (() => {
        if (normalized.length <= 1) return '';
        const desc = [...normalized].reverse();
        const segments = [`1 ${desc[0].name}`];
        for (let i = 1; i < desc.length; i++) {
            const ratio = Math.round(desc[0].factorToBase / (desc[i].factorToBase || 1));
            segments.push(`${ratio} ${pluralizePresentationName(desc[i].name, ratio)}`);
        }
        return segments.join(' = ');
    })();

    const descIndices = normalized.map((_, idx) => idx).reverse();

    return (
        <section className="space-y-3" aria-label="Presentaciones del artículo">
            <div>
                <span id="packaging-mode-label" className="text-xs font-bold text-surface-500 dark:text-surface-400 ml-1 mb-1.5 block uppercase tracking-wide">
                    ¿Cómo manejas este artículo?
                </span>
                <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-labelledby="packaging-mode-label">
                    {MODE_OPTIONS.map((opt) => {
                        const selected = packagingMode === opt.id;
                        const Icon = opt.Icon;
                        return (
                            <button
                                key={opt.id}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                onClick={() => onSelectMode(opt.id)}
                                className={`min-h-[60px] flex flex-col items-center justify-center gap-0.5 p-2.5 rounded-2xl border-2 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
                                    selected
                                        ? 'border-brand bg-brand-light/70 dark:bg-surface-800 text-brand-dark dark:text-brand'
                                        : 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 text-surface-600 dark:text-surface-300 hover:border-surface-300'
                                }`}
                            >
                                <Icon size={18} strokeWidth={2.2} aria-hidden="true" />
                                <span className="text-[11px] font-black uppercase leading-tight">{opt.label}</span>
                                <span className="text-[9px] font-semibold opacity-75 leading-tight text-center">{opt.desc}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* MODO 1: UNIDAD SIMPLE (sin campos de bulto molestos por defecto) */}
            {packagingMode === 'simple' && (
                <div className="rounded-2xl border border-surface-200 dark:border-surface-700/70 bg-surface-50/70 dark:bg-surface-800/30 p-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-xs font-bold text-surface-600 dark:text-surface-300 flex items-center gap-1.5">
                            <Check size={14} className="text-emerald-600 shrink-0" aria-hidden="true" />
                            Se vende por unidad individual (1:1).
                        </p>
                        <button
                            type="button"
                            onClick={handleTogglePurchaseBulkInSimple}
                            className="min-h-[36px] text-[11px] font-bold text-brand hover:underline cursor-pointer"
                        >
                            {hasPurchaseOnlyBulk ? 'Quitar bulto de compra' : '+ ¿Lo compras en bultos solo para inventario?'}
                        </button>
                    </div>

                    {hasPurchaseOnlyBulk && normalized[1] && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2 border-t border-surface-200 dark:border-surface-700/60">
                            <div>
                                <label htmlFor="simple-bulk-name" className="text-[10px] font-bold text-surface-500 uppercase ml-1 block mb-1">
                                    Nombre empaque compra
                                </label>
                                <input
                                    id="simple-bulk-name"
                                    value={normalized[1].name}
                                    onChange={(e) => handleNameChange(1, e.target.value)}
                                    onBlur={handleNameBlur}
                                    className="w-full min-h-[44px] bg-white dark:bg-surface-900 px-3 rounded-xl font-bold text-sm text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                                />
                            </div>
                            <div>
                                <label htmlFor="simple-bulk-qty" className="text-[10px] font-bold text-surface-500 uppercase ml-1 block mb-1">
                                    Unidades por {normalized[1].name || 'Bulto'} (solo stock)
                                </label>
                                <input
                                    id="simple-bulk-qty"
                                    type="number"
                                    min="2"
                                    step="1"
                                    inputMode="numeric"
                                    aria-label="Cantidad en Bulto"
                                    value={normalized[1].containsQty}
                                    onChange={(e) => handleQtyChange(1, e.target.value)}
                                    className="w-full min-h-[44px] bg-white dark:bg-surface-900 px-3 rounded-xl font-mono font-bold text-sm text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50 tabular-nums"
                                />
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* MODO 2: PRESENTACIONES (2 o 3 niveles estilo farmacia simplificado) */}
            {packagingMode === 'multilevel' && (
                <div className="space-y-3 rounded-2xl border border-brand/25 dark:border-brand/30 bg-brand-light/25 dark:bg-surface-800/40 p-3.5">
                    {/* Plantillas de 1 toque */}
                    <div>
                        <span className="text-[10px] font-black text-brand-dark dark:text-brand uppercase tracking-wider block mb-1.5">
                            Plantillas rápidas (puedes editar los nombres)
                        </span>
                        <div className="flex flex-wrap gap-2">
                            {QUICK_MULTILEVEL_PRESETS.map((preset) => (
                                <button
                                    key={preset.id}
                                    type="button"
                                    onClick={() => handleApplyPreset(preset.id)}
                                    className="min-h-[38px] px-3 py-1.5 rounded-xl bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 hover:border-brand text-xs font-bold text-surface-700 dark:text-surface-200 cursor-pointer transition-colors"
                                >
                                    {preset.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Escalera de niveles (Mayor → Medio → Base) */}
                    <div className="space-y-2.5 pl-2 border-l-2 border-brand/30">
                        {descIndices.map((idx) => {
                            const lvl = normalized[idx];
                            const child = idx > 0 ? normalized[idx - 1] : null;
                            const isBase = idx === 0;
                            const isTopThird = normalized.length === 3 && idx === 2;
                            const isLockedOnlySellable = lvl.sellable && sellableCount <= 1;
                            const showOwnBarcode = Boolean(openBarcodes[lvl.id] || lvl.barcode);

                            return (
                                <div
                                    key={lvl.id}
                                    data-testid={`presentation-card-${lvl.id}`}
                                    className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 p-3 space-y-2.5 shadow-2xs"
                                >
                                    <div className="flex items-center justify-between gap-2 flex-wrap">
                                        <div className="flex items-center gap-2">
                                            <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-md ${
                                                isBase
                                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                                                    : 'bg-brand-light text-brand-dark dark:bg-surface-800 dark:text-brand'
                                            }`}>
                                                Nivel {lvl.level} {isBase ? '· Base' : idx === normalized.length - 1 ? '· Mayor' : '· Medio'}
                                            </span>
                                            {lvl.factorToBase > 1 && (
                                                <span className="text-[11px] font-mono tabular-nums font-bold text-surface-500">
                                                    = {lvl.factorToBase} {pluralizePresentationName(normalized[0].name, lvl.factorToBase)}
                                                </span>
                                            )}
                                        </div>

                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setOpenBarcodes((prev) => ({ ...prev, [lvl.id]: !prev[lvl.id] }))}
                                                className="min-h-[34px] px-2.5 rounded-lg border border-surface-200 dark:border-surface-700 text-[10px] font-bold text-surface-600 dark:text-surface-300 hover:border-brand flex items-center gap-1 cursor-pointer"
                                            >
                                                <Barcode size={12} aria-hidden="true" />
                                                <span>{lvl.barcode ? 'Cód. asignado' : 'Cód. propio'}</span>
                                            </button>
                                            {isTopThird && (
                                                <button
                                                    type="button"
                                                    onClick={handleRemoveThirdLevel}
                                                    aria-label="Quitar nivel superior"
                                                    className="min-h-[34px] min-w-[34px] px-2 rounded-lg text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 flex items-center justify-center cursor-pointer"
                                                    title="Quitar nivel 3"
                                                >
                                                    <Trash2 size={14} aria-hidden="true" />
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
                                        {/* Nombre editable */}
                                        <div className={isBase ? 'sm:col-span-6' : 'sm:col-span-4'}>
                                            <label className="text-[10px] font-bold text-surface-400 uppercase block mb-0.5">
                                                Nombre
                                            </label>
                                            <input
                                                value={lvl.name}
                                                aria-label={`Nombre nivel ${lvl.level}`}
                                                onChange={(e) => handleNameChange(idx, e.target.value)}
                                                onBlur={handleNameBlur}
                                                className="w-full min-h-[44px] bg-surface-50 dark:bg-surface-800 px-3 rounded-xl font-bold text-sm text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                                            />
                                        </div>

                                        {/* Factor contra nivel inmediato inferior */}
                                        {!isBase && child ? (
                                            <div className="sm:col-span-5">
                                                <label className="text-[10px] font-bold text-surface-400 uppercase block mb-0.5">
                                                    Cada {lvl.name || 'empaque'} trae
                                                </label>
                                                <div className="flex items-center gap-2">
                                                    <input
                                                        type="number"
                                                        min="2"
                                                        step="1"
                                                        inputMode="numeric"
                                                        aria-label={`Cantidad en ${lvl.name}`}
                                                        value={lvl.containsQty}
                                                        onChange={(e) => handleQtyChange(idx, e.target.value)}
                                                        className="w-20 min-h-[44px] text-center bg-surface-50 dark:bg-surface-800 px-2 rounded-xl font-mono font-black text-sm text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50 tabular-nums"
                                                    />
                                                    <span className="text-xs font-bold text-surface-600 dark:text-surface-300 truncate">
                                                        {pluralizePresentationName(child.name, lvl.containsQty)}
                                                    </span>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="sm:col-span-3 flex items-center text-[11px] font-semibold text-surface-500 pt-3">
                                                Unidad mínima del stock
                                            </div>
                                        )}

                                        {/* Switch Vender en Caja */}
                                        <div className={isBase ? 'sm:col-span-3 flex sm:justify-end pt-2 sm:pt-4' : 'sm:col-span-3 flex sm:justify-end pt-2 sm:pt-4'}>
                                            <button
                                                type="button"
                                                role="switch"
                                                aria-checked={lvl.sellable}
                                                disabled={isLockedOnlySellable}
                                                onClick={() => handleToggleSellable(idx)}
                                                title={isLockedOnlySellable ? 'Debe quedar al menos 1 presentación activa para vender' : 'Activar o desactivar venta en Caja'}
                                                className={`min-h-[44px] px-3 rounded-xl flex items-center gap-2 border transition-colors cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed ${
                                                    lvl.sellable
                                                        ? 'border-emerald-300 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
                                                        : 'border-surface-200 bg-surface-50 dark:bg-surface-800 text-surface-500'
                                                }`}
                                            >
                                                <span className={`w-8 h-5 rounded-full relative transition-colors ${lvl.sellable ? 'bg-emerald-600' : 'bg-surface-300 dark:bg-surface-600'}`}>
                                                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${lvl.sellable ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                                                </span>
                                                <span className="text-[11px] font-black uppercase">Vender</span>
                                            </button>
                                        </div>
                                    </div>

                                    {isLockedOnlySellable && (
                                        <p className="text-[10px] font-semibold text-surface-400 flex items-center gap-1">
                                            <AlertCircle size={11} aria-hidden="true" /> Al menos una presentación debe venderse en Caja.
                                        </p>
                                    )}

                                    {showOwnBarcode && (
                                        <div className="pt-1.5 border-t border-surface-100 dark:border-surface-800">
                                            <div className="relative">
                                                <input
                                                    value={lvl.barcode || ''}
                                                    aria-label={`Código de ${lvl.name}`}
                                                    onChange={(e) => handleLevelBarcodeChange(idx, e.target.value)}
                                                    onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                                                    placeholder={`Código exclusivo para ${lvl.name}...`}
                                                    className="w-full min-h-[40px] bg-surface-50 dark:bg-surface-800 px-3 pl-9 rounded-xl font-mono text-xs font-bold text-surface-800 dark:text-white border border-surface-200 dark:border-surface-700 outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                                                />
                                                <Barcode size={14} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                                            </div>
                                            {lvl.barcode && <BarcodeDuplicateHint barcode={lvl.barcode} exceptId={editingId} />}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
                        {normalized.length === 2 && (
                            <button
                                type="button"
                                onClick={handleAddThirdLevel}
                                className="min-h-[44px] px-3.5 rounded-xl border-2 border-dashed border-brand/40 text-brand font-bold text-xs flex items-center gap-1.5 hover:bg-brand-light/40 cursor-pointer transition-colors"
                            >
                                <Plus size={15} aria-hidden="true" /> Agregar Nivel 3 (ej. Caja o Bulto)
                            </button>
                        )}

                        {chainText && (
                            <div
                                data-testid="equivalence-chain"
                                className="ml-auto px-3 py-2 rounded-xl bg-white dark:bg-surface-900 border border-brand/25 font-mono tabular-nums text-xs font-black text-brand-dark dark:text-brand"
                            >
                                {chainText}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* MODO 3: GRANEL */}
            {packagingMode === 'granel' && (
                <div className="flex gap-2">
                    {['kg', 'litro'].map((u) => {
                        const isLiquidBtn = u === 'litro';
                        const isSelected = (isLiquidBtn && isLiquidProduct(granelUnit)) || (!isLiquidBtn && !isLiquidProduct(granelUnit));
                        const label = granelMode === GRANEL_MODE_GR_ML
                            ? (isLiquidBtn ? 'Mililitros (ml)' : 'Gramos (g)')
                            : (isLiquidBtn ? 'Litro (L)' : 'Kilogramo (kg)');
                        const Icon = isLiquidBtn ? Droplets : Scale;
                        return (
                            <button
                                key={u}
                                type="button"
                                onClick={() => setGranelUnit(u)}
                                className={`flex-1 min-h-[44px] py-2.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                                    isSelected
                                        ? 'bg-amber-500 text-white shadow-sm'
                                        : 'bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300 hover:bg-surface-200'
                                }`}
                            >
                                <Icon size={15} aria-hidden="true" /> {label}
                            </button>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
