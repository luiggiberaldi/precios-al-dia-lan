import React, { useState, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { matchesSearch as matchesSearchFields } from '../../utils/searchMatch';
import {
    Search, TrendingUp, TrendingDown, Check, Package, X,
    AlertTriangle, Minus, Plus, Boxes, Edit3, Barcode,
} from 'lucide-react';
import { showToast } from '../Toast';
import { CATEGORY_COLORS } from '../../config/categories';
import { storageService } from '../../utils/storageService';
// Cierre FIX-VENTAS-STOCK-SUPERVISOR §4: escritos del catálogo bajo pos_write_lock.
import { mutateCatalogLocked } from '../../utils/catalogLock';
import {
    isGranelProduct,
    isLowStockProduct,
    granelStockUnitLabel,
    parseStockInput,
    adjustStockValue,
    formatStockDisplay,
    formatLowStockAlert,
} from '../../utils/granel'; // GRANEL-001
import {
    resolveProductPresentations,
    pluralizePresentationName,
    computeFactorToBase,
} from '../../utils/presentations';
import { findProductAndPresentationByCode } from '../../utils/barcodeAssign';

function resolveBatchOptions(p, tempPkgSize = 0) {
    if (!p || isGranelProduct(p)) return [];
    if (tempPkgSize > 1) {
        const levels = resolveProductPresentations(p);
        const packName = levels.length > 1 ? levels[levels.length - 1].name : 'Bulto';
        const baseName = levels[0]?.name || 'Ud';
        return [
            { id: 'lotes', shortLabel: packName, label: `${packName} (${tempPkgSize} uds)`, factor: tempPkgSize },
            { id: 'uds', shortLabel: baseName, label: baseName === 'Unidad' ? 'Uds' : baseName, factor: 1 },
        ];
    }
    const levels = resolveProductPresentations(p);
    if (levels.length > 1) {
        return [...levels].reverse().map((lvl) => ({
            id: lvl.id,
            shortLabel: lvl.name,
            label: lvl.factorToBase > 1 ? `${lvl.name} (${lvl.factorToBase} uds)` : lvl.name,
            factor: lvl.factorToBase,
        }));
    }
    const stored = p.unitsPerPackage ?? 1;
    if (stored > 1) {
        return [
            { id: 'lotes', shortLabel: 'Bulto', label: `Bultos (${stored} uds)`, factor: stored },
            { id: 'uds', shortLabel: 'Ud', label: 'Uds', factor: 1 },
        ];
    }
    return [];
}

function resolveBatchUnitMeta(p, adjUnit, tempPkgSize = 0) {
    const options = resolveBatchOptions(p, tempPkgSize);
    if (options.length === 0) {
        return { options: [], selected: { id: 'uds', shortLabel: 'Ud', label: 'Uds', factor: 1 } };
    }
    let selected = options.find((o) => o.id === adjUnit);
    if (!selected) {
        if (adjUnit === 'lotes') selected = options[0];
        else if (adjUnit === 'uds') selected = options[options.length - 1];
        else selected = options[0];
    }
    return { options, selected };
}

// ─── FILA DEL CATÁLOGO (PICKER TÁCTIL CON ESTADO VIVO) ───
function CatalogRow({ p, isSelected, selectedQty, direction, onToggle }) {
    const stock = p.stock ?? 0;
    const isLow = isLowStockProduct(p);
    const levels = !isGranelProduct(p) ? resolveProductPresentations(p) : [];
    const topLevel = levels.length > 1 ? levels[levels.length - 1] : null;
    const unitsPerPkg = topLevel?.factorToBase || (p.unitsPerPackage ?? 1);
    const bulkName = topLevel?.name || 'Bulto';
    const hasBulk = !isGranelProduct(p) && unitsPerPkg > 1;

    return (
        <div
            onClick={() => onToggle(p.id)}
            className={`flex items-center justify-between gap-3 px-3.5 py-2.5 cursor-pointer transition-colors border-b border-slate-100 dark:border-slate-800/50 select-none ${
                isSelected
                    ? direction === 'ingreso'
                        ? 'bg-emerald-50/75 dark:bg-emerald-950/30 border-l-4 border-l-emerald-500'
                        : 'bg-rose-50/75 dark:bg-rose-950/30 border-l-4 border-l-rose-500'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
            }`}
        >
            <div className="flex-1 min-w-0">
                <p className={`text-xs sm:text-sm truncate transition-colors ${
                    isSelected ? 'text-slate-900 dark:text-white font-black' : 'text-slate-800 dark:text-slate-200 font-bold'
                }`}>
                    {p.name}
                </p>
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    <span className={`text-[10px] font-mono tabular-nums font-black px-2 py-0.5 rounded-lg border ${
                        isLow
                            ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-900 dark:text-amber-200 border-amber-300 dark:border-amber-800/80'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200/70 dark:border-slate-700'
                    }`}>
                        Stock: {formatStockDisplay(stock, isGranelProduct(p))} · {formatLowStockAlert(p)}
                    </span>
                    {isGranelProduct(p) && (
                        <span className="text-[9px] font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-lg border border-amber-200/60 dark:border-amber-800/60">
                            Granel ({granelStockUnitLabel(p)})
                        </span>
                    )}
                    {hasBulk && (
                        <span className="text-[9px] font-bold text-brand bg-brand-light dark:bg-slate-800 dark:text-brand px-2 py-0.5 rounded-lg border border-brand/20 font-mono tabular-nums">
                            {unitsPerPkg} uds/{bulkName.toLowerCase()}
                        </span>
                    )}
                    {p.barcode && (
                        <span className="text-[9px] font-mono text-slate-400 dark:text-slate-500">
                            {p.barcode}
                        </span>
                    )}
                </div>
            </div>

            <div className="shrink-0 flex items-center gap-1.5">
                {isSelected && selectedQty > 0 && (
                    <span className={`text-[10px] font-mono tabular-nums font-black px-2 py-0.5 rounded-full ${
                        direction === 'ingreso'
                            ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300'
                            : 'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300'
                    }`}>
                        {direction === 'ingreso' ? '+' : '-'}{selectedQty}
                    </span>
                )}
                {isSelected ? (
                    <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center text-white shadow-sm transition-transform active:scale-90 ${
                            direction === 'ingreso' ? 'bg-emerald-600' : 'bg-rose-600'
                        }`}
                        title="Seleccionado (toca para quitar)"
                    >
                        <Check size={16} strokeWidth={3} />
                    </div>
                ) : (
                    <div
                        className="w-9 h-9 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:bg-brand-light hover:text-brand hover:border-brand/30 transition-all active:scale-90"
                        title="Toca para seleccionar"
                    >
                        <Plus size={16} strokeWidth={2.5} />
                    </div>
                )}
            </div>
        </div>
    );
}

const QUICK_REASONS = [
    'Merma / Dañado',
    'Vencimiento',
    'Consumo Interno',
    'Devolución',
    'Error de Conteo',
];

// ─── TARJETA EN BANDEJA DE AJUSTE ───
function AdjustRow({ p, qty, direction, adjUnit, tempPkgSize, onSetQty, onSetAdjUnit, onSetTempPkgSize, onRemove }) {
    const [isEditingQty, setIsEditingQty] = useState(false);
    const [draftQty, setDraftQty] = useState('');
    const prevQtyRef = useRef(qty);

    const handleFocusQty = () => {
        if (isEditingQty) return;
        prevQtyRef.current = qty;
        setIsEditingQty(true);
        setDraftQty('');
    };

    const isGranel = isGranelProduct(p);
    const unitLabel = isGranel ? granelStockUnitLabel(p) : 'ud';

    const handleChangeQty = (e) => {
        const val = e.target.value;
        setDraftQty(val);
        const parsed = parseStockInput(val, isGranel);
        if (parsed !== null && parsed >= 0) {
            onSetQty(p.id, parsed);
        }
    };

    const handleBlurQty = () => {
        setIsEditingQty(false);
        if (draftQty.trim() === '') {
            onSetQty(p.id, prevQtyRef.current);
        } else {
            const parsed = parseStockInput(draftQty, isGranel);
            if (parsed === null || parsed < 0) {
                onSetQty(p.id, prevQtyRef.current);
            } else {
                onSetQty(p.id, parsed);
            }
        }
    };

    const handleKeyDownQty = (e) => {
        if (e.key === 'Enter') e.target.blur();
    };

    const stock = p.stock ?? 0;
    const storedUpp = (p.unitsPerPackage ?? 1) > 1 ? (p.unitsPerPackage ?? 1) : 1;
    const { options: levelOptions, selected: selectedUnitMeta } = resolveBatchUnitMeta(p, adjUnit, tempPkgSize);
    const factor = selectedUnitMeta.factor || 1;
    const hasBulk = levelOptions.length > 0;

    const delta = hasBulk && factor > 1 ? qty * factor : qty;
    const allowNegative = typeof window !== 'undefined' && localStorage.getItem('allow_negative_stock') === 'true';
    const isExcessEgreso = direction === 'egreso' && delta > stock && !allowNegative;
    const newStock = direction === 'ingreso'
        ? adjustStockValue(stock, delta, isGranel)
        : (allowNegative ? adjustStockValue(stock, -delta, isGranel) : Math.max(0, adjustStockValue(stock, -delta, isGranel)));

    const signPrefix = direction === 'ingreso' ? '+' : '-';
    const deltaLabel = hasBulk && factor > 1
        ? `${signPrefix}${qty} ${pluralizePresentationName(selectedUnitMeta.shortLabel, qty)} de ${factor} uds`
        : isGranel
            ? `${signPrefix}${formatStockDisplay(delta, true)} ${unitLabel}`
            : `${signPrefix}${delta} ud${delta !== 1 ? 's' : ''}`;

    const topFactor = levelOptions[0]?.factor || storedUpp;
    const currentBultos = !isGranel && topFactor > 1 ? Math.floor(stock / topFactor) : null;
    const topNamePlural = levelOptions[0]?.shortLabel
        ? pluralizePresentationName(levelOptions[0].shortLabel, currentBultos ?? 0).toLowerCase()
        : 'bultos';

    const inputVal = tempPkgSize > 0 ? tempPkgSize : (storedUpp > 1 ? storedUpp : '');
    const isModifiedPkg = tempPkgSize > 1 && tempPkgSize !== storedUpp;

    return (
        <div className={`p-3.5 rounded-2xl border transition-colors space-y-2.5 ${
            isExcessEgreso
                ? 'bg-rose-50/70 dark:bg-rose-950/25 border-rose-300 dark:border-rose-800/70'
                : 'bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-800 shadow-2xs'
        }`}>
            {/* Cabecera de fila: nombre + stepper táctil + quitar */}
            <div className="flex items-start justify-between gap-2.5">
                <div className="flex-1 min-w-0">
                    <p className="text-xs sm:text-sm font-black text-slate-900 dark:text-white truncate">{p.name}</p>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap font-mono tabular-nums">
                        <span className="text-[11px] font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md">
                            {formatStockDisplay(stock, isGranel)}
                        </span>
                        <span className={`text-xs font-black ${
                            isExcessEgreso
                                ? 'text-rose-600 dark:text-rose-400'
                                : direction === 'ingreso'
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-rose-600 dark:text-rose-400'
                        }`}>
                            → {formatStockDisplay(newStock, isGranel)}
                        </span>
                        <span className={`text-[10px] font-black px-2 py-0.5 rounded-md border ${
                            direction === 'ingreso'
                                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                                : 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800'
                        }`}>
                            {deltaLabel}
                        </span>
                    </div>
                </div>

                {/* Stepper táctil + quitar */}
                <div className="flex items-center gap-1.5 shrink-0">
                    <div className="flex items-center bg-slate-100 dark:bg-slate-800 p-0.5 rounded-xl border border-slate-200/80 dark:border-slate-700">
                        <button
                            type="button"
                            aria-label={`Restar cantidad a ${p.name}`}
                            onClick={() => onSetQty(p.id, adjustStockValue(qty, -1, isGranel))}
                            disabled={qty <= 0}
                            className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 hover:text-rose-600 disabled:opacity-30 transition-colors cursor-pointer"
                        >
                            <Minus size={14} strokeWidth={2.5} />
                        </button>
                        <input
                            type="number"
                            min="0"
                            step={isGranel ? 'any' : '1'}
                            inputMode={isGranel ? 'decimal' : 'numeric'}
                            aria-label={`Cantidad para ${p.name}`}
                            value={isEditingQty ? draftQty : (qty || '')}
                            placeholder={String(prevQtyRef.current || qty || 0)}
                            onFocus={handleFocusQty}
                            onClick={handleFocusQty}
                            onChange={handleChangeQty}
                            onBlur={handleBlurQty}
                            onKeyDown={handleKeyDownQty}
                            className="w-12 h-9 text-center font-mono tabular-nums text-sm font-black bg-transparent border-none outline-none focus:ring-2 focus:ring-brand/40 rounded-lg text-slate-900 dark:text-white [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                            type="button"
                            aria-label={`Sumar cantidad a ${p.name}`}
                            onClick={() => onSetQty(p.id, adjustStockValue(qty, 1, isGranel))}
                            className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 hover:text-emerald-600 transition-colors cursor-pointer"
                        >
                            <Plus size={14} strokeWidth={2.5} />
                        </button>
                    </div>

                    <button
                        type="button"
                        aria-label={`Quitar ${p.name}`}
                        onClick={() => onRemove(p.id)}
                        className="w-9 h-9 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200/70 dark:border-rose-900/40 flex items-center justify-center text-rose-600 dark:text-rose-400 hover:bg-rose-100 transition-colors active:scale-95 cursor-pointer"
                        title="Quitar de la lista"
                    >
                        <X size={15} strokeWidth={2.5} />
                    </button>
                </div>
            </div>

            {/* Alertas o resumen de bultos actuales */}
            {(isExcessEgreso || currentBultos !== null) && (
                <div className="flex items-center gap-2 flex-wrap">
                    {isExcessEgreso && (
                        <span className="text-[10px] font-black text-rose-700 dark:text-rose-300 bg-rose-100 dark:bg-rose-950/70 px-2 py-0.5 rounded-lg border border-rose-300 dark:border-rose-800 flex items-center gap-1">
                            <AlertTriangle size={11} /> Stock insuficiente (disponible: {formatStockDisplay(stock, isGranel)})
                        </span>
                    )}
                    {currentBultos !== null && (
                        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">
                            Actualmente: <strong className="font-mono tabular-nums text-slate-700 dark:text-slate-200">{currentBultos} {topNamePlural}</strong>
                        </span>
                    )}
                </div>
            )}

            {/* Selector de presentación + configurador inline de bulto (no aplica a granel) */}
            {!isGranel && (
                <div className="flex items-center justify-between gap-2.5 pt-2 border-t border-slate-100 dark:border-slate-800/70 flex-wrap">
                    {hasBulk ? (
                        <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label={`Presentación para ${p.name}`}>
                            {levelOptions.map((opt) => {
                                const active = selectedUnitMeta.id === opt.id;
                                return (
                                    <button
                                        key={opt.id}
                                        type="button"
                                        onClick={() => onSetAdjUnit(p.id, opt.id)}
                                        className={`min-h-[34px] px-2.5 py-1 rounded-xl text-[11px] font-black transition-all border cursor-pointer ${
                                            active
                                                ? opt.factor > 1
                                                    ? 'bg-brand text-white border-brand shadow-xs'
                                                    : 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 dark:border-slate-100 shadow-xs'
                                                : 'bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-brand hover:text-brand'
                                        }`}
                                    >
                                        {opt.label}
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <span className="text-[10px] font-bold text-slate-400">Unidad individual</span>
                    )}

                    {/* Configurador rápido de Uds/bulto (se persiste en el artículo) */}
                    <div className="flex items-center gap-1.5 ml-auto">
                        <Edit3 size={11} className="text-slate-400 shrink-0" aria-hidden="true" />
                        <span className="text-[10px] text-slate-500 dark:text-slate-400 font-bold">Uds/bulto:</span>
                        <input
                            type="number"
                            min="1"
                            step="1"
                            aria-label={`Unidades por bulto de ${p.name}`}
                            value={inputVal}
                            placeholder="—"
                            onFocus={(e) => e.target.select()}
                            onChange={(e) => {
                                const val = parseInt(e.target.value, 10) || 0;
                                onSetTempPkgSize(p.id, val);
                                if (val > 1 && adjUnit !== 'lotes') {
                                    onSetAdjUnit(p.id, 'lotes');
                                }
                                if (val <= 1) {
                                    onSetAdjUnit(p.id, 'uds');
                                }
                            }}
                            className="w-14 h-8 text-center font-mono tabular-nums text-xs font-black bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand text-slate-900 dark:text-white [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        {isModifiedPkg && (
                            <span className="text-[9px] font-black text-brand bg-brand-light dark:bg-slate-800 px-1.5 py-0.5 rounded-md">
                                Se guarda
                            </span>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export default function StockBatchModal({
    isOpen,
    onClose,
    products,
    categories,
    adjustStock,
    setProducts,
    triggerHaptic,
}) {
    const [direction, setDirection] = useState('ingreso');
    const [search, setSearch] = useState('');
    const [selectedCategory, setSelectedCategory] = useState('todos');
    const [onlyLowStock, setOnlyLowStock] = useState(false);
    const [adjustments, setAdjustments] = useState({});
    const [adjustmentUnits, setAdjustmentUnits] = useState({});
    const [tempPackageSizes, setTempPackageSizes] = useState({});
    const [note, setNote] = useState('');
    const [activeTab, setActiveTab] = useState('catalog');
    const [isApplying, setIsApplying] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);

    const categoryScrollRef = useRef(null);

    const allProducts = useMemo(() =>
        (products || []).filter(p => !p.isCombo),
    [products]);

    const lowStockTotal = useMemo(() =>
        allProducts.filter(p => isLowStockProduct(p)).length,
    [allProducts]);

    const getCategoryProductCount = (catId) => {
        if (catId === 'todos') return allProducts.length;
        return allProducts.filter(p => p.category === catId).length;
    };

    const selectedProducts = useMemo(() =>
        allProducts.filter(p => p.id in adjustments)
            .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''))),
    [allProducts, adjustments]);

    const getEffectiveUpp = useCallback((p) => {
        const temp = tempPackageSizes[p.id] || 0;
        if (temp > 1) return temp;
        const levels = !isGranelProduct(p) ? resolveProductPresentations(p) : [];
        if (levels.length > 1) return levels[levels.length - 1].factorToBase || 1;
        const stored = p.unitsPerPackage ?? 1;
        return stored > 1 ? stored : 1;
    }, [tempPackageSizes]);

    const activeAdjustments = useMemo(() =>
        Object.entries(adjustments)
            .filter(([, qty]) => qty > 0)
            .map(([productId, qty]) => {
                const p = allProducts.find(x => x.id === productId);
                const tempSize = tempPackageSizes[productId] || 0;
                const { selected } = resolveBatchUnitMeta(p, adjustmentUnits[productId], tempSize);
                const factor = selected.factor || 1;
                const deltaUnits = factor > 1 ? qty * factor : qty;
                return {
                    productId,
                    qty,
                    adjUnit: selected.id,
                    unitName: selected.shortLabel,
                    unitsPerPkg: factor,
                    deltaUnits,
                    p,
                };
            }),
    [adjustments, adjustmentUnits, allProducts, tempPackageSizes]);

    const totalItems = activeAdjustments.reduce((sum, { deltaUnits }) => sum + deltaUnits, 0);
    const hasGranelInAdjust = activeAdjustments.some(({ p }) => isGranelProduct(p));

    const catalogProducts = useMemo(() => {
        return allProducts
            .filter(p => {
                if (onlyLowStock && !isLowStockProduct(p)) return false;
                const matchesCat = selectedCategory === 'todos' || p.category === selectedCategory;
                const matchesSearch = matchesSearchFields([p.name, p.barcode], search);
                return matchesCat && matchesSearch;
            })
            .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
    }, [allProducts, search, selectedCategory, onlyLowStock]);

    const setQty = (productId, val) => {
        const p = allProducts.find(x => x.id === productId);
        const parsed = parseStockInput(val, isGranelProduct(p));
        const num = Math.max(0, parsed ?? 0);
        setAdjustments(prev => ({ ...prev, [productId]: num }));
    };

    const setAdjUnit = useCallback((productId, unit) => {
        setAdjustmentUnits(prev => ({ ...prev, [productId]: unit }));
    }, []);

    const setTempPkgSize = useCallback((productId, size) => {
        setTempPackageSizes(prev => ({ ...prev, [productId]: size }));
    }, []);

    const removeProduct = useCallback((productId) => {
        triggerHaptic && triggerHaptic();
        setAdjustments(prev => {
            const next = { ...prev };
            delete next[productId];
            return next;
        });
    }, [triggerHaptic]);

    const toggleProduct = useCallback((productId) => {
        triggerHaptic && triggerHaptic();
        if (productId in adjustments) {
            setAdjustments(prev => {
                const next = { ...prev };
                delete next[productId];
                return next;
            });
        } else {
            const p = allProducts.find(x => x.id === productId);
            const effUpp = p ? getEffectiveUpp(p) : 1;
            if (effUpp > 1) {
                setAdjustmentUnits(prev => ({ ...prev, [productId]: 'lotes' }));
            }
            setAdjustments(prev => ({ ...prev, [productId]: 1 }));
        }
    }, [triggerHaptic, adjustments, allProducts, getEffectiveUpp]);

    // Escaneo directo o Enter en el buscador: selecciona y suma +1 automáticamente
    const handleSearchKeyDown = (e) => {
        if (e.key !== 'Enter') return;
        const term = search.trim();
        if (!term) return;
        e.preventDefault();
        const barcodeHit = findProductAndPresentationByCode(allProducts, term);
        const target = barcodeHit?.product || (catalogProducts.length === 1 ? catalogProducts[0] : null);
        if (!target) return;

        triggerHaptic && triggerHaptic();
        const targetLevelId = barcodeHit?.presentation?.id || (getEffectiveUpp(target) > 1 ? 'lotes' : 'uds');
        setAdjustmentUnits(prev => ({ ...prev, [target.id]: prev[target.id] || targetLevelId }));
        setAdjustments(prev => ({
            ...prev,
            [target.id]: adjustStockValue(prev[target.id] || 0, 1, isGranelProduct(target)),
        }));
        setSearch('');
        showToast(`+1 agregado: ${target.name}`, 'success');
    };

    const needsNote = direction === 'egreso' && !note.trim();

    const handleApply = async () => {
        if (activeAdjustments.length === 0) {
            showToast('Ingresa al menos 1 unidad para aplicar el ajuste', 'error');
            triggerHaptic && triggerHaptic();
            return;
        }
        if (needsNote) {
            showToast('Escribe un motivo para el egreso', 'error');
            triggerHaptic && triggerHaptic();
            return;
        }

        const allowNegativeStock = typeof window !== 'undefined' && localStorage.getItem('allow_negative_stock') === 'true';
        if (direction === 'egreso' && !allowNegativeStock) {
            const invalidItems = activeAdjustments.filter(({ deltaUnits, p }) => deltaUnits > (p?.stock ?? 0));
            if (invalidItems.length > 0) {
                const names = invalidItems.map(i => i.p?.name || 'Producto').slice(0, 2).join(', ');
                const extra = invalidItems.length > 2 ? ` y ${invalidItems.length - 2} más` : '';
                showToast(`Stock insuficiente en: ${names}${extra}`, 'error');
                triggerHaptic && triggerHaptic();
                return;
            }
        }

        if (!showConfirm) {
            setShowConfirm(true);
            return;
        }
        setIsApplying(true);
        triggerHaptic && triggerHaptic();

        try {
            for (const { productId, deltaUnits } of activeAdjustments) {
                const delta = direction === 'ingreso' ? deltaUnits : -deltaUnits;
                await adjustStock(productId, delta);
            }

            // Persistir tamaños de empaque editados inline (unitsPerPackage + presentations)
            const pkgEntries = Object.entries(tempPackageSizes).filter(([, size]) => size > 1);
            if (pkgEntries.length > 0 && setProducts) {
                const sizes = { ...tempPackageSizes };
                const applyPackageSizes = (list) => list.map(p => {
                    const newSize = sizes[p.id];
                    if (!newSize || newSize <= 1) return p;
                    const existingLevels = Array.isArray(p.presentations) && p.presentations.length > 0
                        ? p.presentations
                        : resolveProductPresentations(p);
                    let nextLevels;
                    if (existingLevels.length <= 1) {
                        const base = existingLevels[0] || { id: 'unit', level: 1, name: 'Unidad', containsQty: 1, factorToBase: 1, sellable: true };
                        nextLevels = computeFactorToBase([
                            base,
                            { id: 'pack', level: 2, name: 'Bulto', containsQty: newSize, sellable: false, priceUsd: 0, priceCop: null, costUsd: 0, barcode: '' },
                        ]);
                    } else if (existingLevels.length === 2) {
                        nextLevels = computeFactorToBase([
                            existingLevels[0],
                            { ...existingLevels[1], containsQty: newSize },
                        ]);
                    } else {
                        nextLevels = existingLevels;
                    }
                    return {
                        ...p,
                        unitsPerPackage: newSize,
                        presentations: nextLevels,
                    };
                });
                const written = await mutateCatalogLocked(
                    fresh => applyPackageSizes(fresh),
                    { storage: storageService }
                ).catch(err => {
                    console.error('Error al persistir unidades por bulto en storageService:', err);
                    return null;
                });
                if (written) setProducts(prev => applyPackageSizes(prev));
            }

            showToast(
                `${direction === 'ingreso' ? 'Ingreso' : 'Egreso'} masivo completado con éxito`,
                'success'
            );

            setAdjustments({});
            setAdjustmentUnits({});
            setTempPackageSizes({});
            setNote('');
            setSearch('');
            setSelectedCategory('todos');
            setOnlyLowStock(false);
            setActiveTab('catalog');
            setShowConfirm(false);
            onClose();
        } catch (e) {
            showToast('Error al aplicar ajuste: ' + e.message, 'error');
        } finally {
            setIsApplying(false);
        }
    };

    const handleClose = () => {
        setAdjustments({});
        setAdjustmentUnits({});
        setTempPackageSizes({});
        setSearch('');
        setNote('');
        setSelectedCategory('todos');
        setOnlyLowStock(false);
        setActiveTab('catalog');
        setShowConfirm(false);
        onClose();
    };

    if (!isOpen) return null;

    const isIngreso = direction === 'ingreso';

    const modalNode = (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={showConfirm ? 'Confirmar Ajuste' : 'Ajuste de Inventario'}
            className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/55 backdrop-blur-sm animate-in fade-in duration-200"
        >
            <div className="absolute inset-0" onClick={handleClose} />

            <div className="relative bg-white dark:bg-slate-900 w-full max-w-md md:max-w-2xl lg:max-w-5xl rounded-t-3xl sm:rounded-3xl shadow-2xl border border-slate-200/70 dark:border-slate-800 animate-in slide-in-from-bottom-10 sm:zoom-in-95 duration-200 flex flex-col max-h-[94vh] sm:max-h-[88vh] overflow-hidden">

                {/* Header */}
                <div className="px-4 py-3.5 sm:px-6 sm:py-4 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center gap-3 bg-slate-50/70 dark:bg-slate-800/50 shrink-0">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 transition-colors ${
                            isIngreso
                                ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400'
                                : 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-400'
                        }`}>
                            <Boxes size={19} strokeWidth={2.4} />
                        </div>
                        <div className="min-w-0">
                            <h3 className="text-base sm:text-lg font-black text-slate-900 dark:text-white tracking-tight truncate">
                                {showConfirm ? 'Confirmar Ajuste' : 'Ajuste de Inventario'}
                            </h3>
                            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 truncate">
                                {showConfirm
                                    ? 'Revisa los cambios antes de aplicar al stock'
                                    : 'Selecciona o escanea artículos para ingresar o egresar por bulto o unidad'}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        {activeAdjustments.length > 0 && !showConfirm && (
                            <span className={`hidden sm:inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono tabular-nums font-black ${
                                isIngreso
                                    ? 'bg-emerald-100 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-300'
                                    : 'bg-rose-100 dark:bg-rose-950/70 text-rose-800 dark:text-rose-300'
                            }`}>
                                {activeAdjustments.length} prod · {isIngreso ? '+' : '-'}{formatStockDisplay(totalItems, hasGranelInAdjust)} uds
                            </span>
                        )}
                        <button
                            type="button"
                            aria-label="Cerrar ajuste de inventario"
                            onClick={handleClose}
                            className="w-11 h-11 flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-800 rounded-xl transition-colors active:scale-95 cursor-pointer"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>

                {showConfirm ? (
                    <div className="p-5 sm:p-6 space-y-4 overflow-y-auto flex-1 scrollbar-hide">
                        <div className={`p-4 rounded-2xl border ${
                            isIngreso
                                ? 'bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/50'
                                : 'bg-rose-50/60 dark:bg-rose-950/20 border-rose-200 dark:border-rose-800/50'
                        }`}>
                            <p className={`text-xs font-black uppercase tracking-wider mb-3 font-mono tabular-nums ${
                                isIngreso ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
                            }`}>
                                {isIngreso ? 'Ingreso' : 'Egreso'} masivo · {activeAdjustments.length} prod · {isIngreso ? '+' : '-'}{formatStockDisplay(totalItems, hasGranelInAdjust)} uds totales
                            </p>
                            <div className="space-y-2 max-h-[45vh] overflow-y-auto scrollbar-hide pr-1">
                                {activeAdjustments.map(({ productId, qty, unitName, unitsPerPkg, deltaUnits, p }) => {
                                    const stock = p?.stock ?? 0;
                                    const allowNegative = typeof window !== 'undefined' && localStorage.getItem('allow_negative_stock') === 'true';
                                    const isExcess = !isIngreso && deltaUnits > stock && !allowNegative;
                                    const newStock = isIngreso
                                        ? stock + deltaUnits
                                        : (allowNegative ? stock - deltaUnits : Math.max(0, stock - deltaUnits));
                                    const isBulkMode = unitsPerPkg > 1;
                                    const hasInlineEdit = (tempPackageSizes[productId] || 0) > 1;
                                    const rowIsGranel = isGranelProduct(p);
                                    const rowUnitLabel = rowIsGranel ? granelStockUnitLabel(p) : 'ud';

                                    return (
                                        <div key={productId} className={`p-2.5 rounded-xl bg-white/80 dark:bg-slate-900/70 border ${isExcess ? 'border-rose-300 dark:border-rose-800' : 'border-slate-200/70 dark:border-slate-800'}`}>
                                            <div className="flex items-start justify-between gap-3">
                                                <span className="font-bold text-xs sm:text-sm text-slate-800 dark:text-slate-100 truncate flex-1">{p?.name || '?'}</span>
                                                <span className="font-mono tabular-nums font-black text-xs sm:text-sm shrink-0 text-slate-600 dark:text-slate-300">
                                                    {formatStockDisplay(stock, rowIsGranel)}{' '}
                                                    <span className={isIngreso ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                                                        → {formatStockDisplay(newStock, rowIsGranel)}
                                                    </span>
                                                </span>
                                            </div>
                                            <div className="flex items-center justify-between gap-2 mt-1 flex-wrap">
                                                <p className={`text-[11px] font-mono tabular-nums font-black ${isIngreso ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
                                                    {isBulkMode
                                                        ? `${isIngreso ? '+' : '-'}${qty} ${pluralizePresentationName(unitName || 'Bulto', qty)} × ${unitsPerPkg} uds = ${isIngreso ? '+' : '-'}${deltaUnits} uds`
                                                        : rowIsGranel
                                                            ? `${isIngreso ? '+' : '-'}${formatStockDisplay(deltaUnits, true)} ${rowUnitLabel}`
                                                            : `${isIngreso ? '+' : '-'}${deltaUnits} ud${deltaUnits !== 1 ? 's' : ''}`}
                                                </p>
                                                {isExcess && (
                                                    <span className="text-[10px] font-black text-rose-600 dark:text-rose-400 flex items-center gap-1">
                                                        <AlertTriangle size={11} /> Supera stock disponible ({stock})
                                                    </span>
                                                )}
                                            </div>
                                            {hasInlineEdit && (
                                                <p className="text-[10px] text-brand font-bold mt-1">
                                                    Tamaño de empaque guardado: {tempPackageSizes[productId]} uds/bulto
                                                </p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            {note.trim() && (
                                <div className="mt-3 pt-3 border-t border-slate-200/80 dark:border-slate-800">
                                    <p className="text-xs text-slate-600 dark:text-slate-300"><span className="font-black">Motivo:</span> {note}</p>
                                </div>
                            )}
                        </div>

                        <div className="flex gap-3 pt-1">
                            <button
                                type="button"
                                onClick={() => setShowConfirm(false)}
                                className="flex-1 min-h-[46px] py-3 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-white font-bold rounded-xl active:scale-[0.98] transition-all text-sm border border-slate-200 dark:border-slate-700 cursor-pointer"
                            >
                                Volver
                            </button>
                            <button
                                type="button"
                                onClick={handleApply}
                                disabled={isApplying}
                                className={`flex-[2] min-h-[46px] py-3 text-white font-black rounded-xl active:scale-[0.98] transition-all text-sm shadow-md disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${
                                    isIngreso
                                        ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/20'
                                        : 'bg-rose-600 hover:bg-rose-700 shadow-rose-600/20'
                                }`}
                            >
                                {isApplying ? 'Aplicando...' : `Confirmar ${isIngreso ? 'Ingreso' : 'Egreso'}`}
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        {/* Barra superior: Dirección (Ingreso / Egreso) + Tabs solo móvil */}
                        <div className="px-4 pt-3.5 pb-2 sm:px-6 space-y-3 border-b border-slate-100 dark:border-slate-800/80 shrink-0 bg-white dark:bg-slate-900">
                            <div className="grid grid-cols-2 bg-slate-100 dark:bg-slate-800/80 p-1 rounded-2xl gap-1">
                                <button
                                    type="button"
                                    onClick={() => setDirection('ingreso')}
                                    className={`min-h-[44px] flex items-center justify-center gap-2 py-2 text-xs sm:text-sm font-black rounded-xl transition-all cursor-pointer ${
                                        isIngreso
                                            ? 'bg-white dark:bg-slate-900 shadow-sm text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-200 dark:ring-emerald-900/50'
                                            : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                                    }`}
                                >
                                    <TrendingUp size={16} strokeWidth={2.5} /> Ingreso de mercancía
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setDirection('egreso')}
                                    className={`min-h-[44px] flex items-center justify-center gap-2 py-2 text-xs sm:text-sm font-black rounded-xl transition-all cursor-pointer ${
                                        !isIngreso
                                            ? 'bg-white dark:bg-slate-900 shadow-sm text-rose-600 dark:text-rose-400 ring-1 ring-rose-200 dark:ring-rose-900/50'
                                            : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                                    }`}
                                >
                                    <TrendingDown size={16} strokeWidth={2.5} /> Egreso · Merma
                                </button>
                            </div>

                            {/* Navegación por pestañas SOLO en pantallas < lg */}
                            <div className="flex lg:hidden border-b border-slate-100 dark:border-slate-800 -mx-4 px-4">
                                <button
                                    type="button"
                                    onClick={() => setActiveTab('catalog')}
                                    className={`flex-1 min-h-[40px] pb-2 text-xs font-bold transition-all border-b-2 text-center cursor-pointer ${
                                        activeTab === 'catalog'
                                            ? 'border-brand text-brand font-black'
                                            : 'border-transparent text-slate-400 dark:text-slate-500'
                                    }`}
                                >
                                    Catálogo ({catalogProducts.length})
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setActiveTab('adjusting')}
                                    className={`flex-1 min-h-[40px] pb-2 text-xs font-bold transition-all border-b-2 text-center flex items-center justify-center gap-1.5 cursor-pointer ${
                                        activeTab === 'adjusting'
                                            ? 'border-brand text-brand font-black'
                                            : 'border-transparent text-slate-400 dark:text-slate-500'
                                    }`}
                                >
                                    En ajuste
                                    {selectedProducts.length > 0 && (
                                        <span className={`px-1.5 py-0.5 text-[10px] font-mono tabular-nums font-black rounded-full ${
                                            isIngreso
                                                ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300'
                                                : 'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300'
                                        }`}>
                                            {selectedProducts.length}
                                        </span>
                                    )}
                                </button>
                            </div>
                        </div>

                        {/* Cuerpo principal: 2 columnas en PC (Catálogo | Bandeja viva), 1 columna con tabs en móvil */}
                        <div className="flex-1 min-h-0 overflow-hidden grid grid-cols-1 lg:grid-cols-12">
                            {/* COLUMNA IZQUIERDA: CATÁLOGO + ESCÁNER */}
                            <div className={`${activeTab === 'catalog' ? 'flex' : 'hidden lg:flex'} flex-col lg:col-span-6 p-4 sm:p-5 lg:border-r border-slate-100 dark:border-slate-800 min-h-0 gap-3`}>
                                {/* Buscador + Escáner */}
                                <div className="relative shrink-0">
                                    <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                                    <input
                                        type="text"
                                        placeholder="Buscar o escanear código (+Enter suma 1)..."
                                        value={search}
                                        onChange={(e) => setSearch(e.target.value)}
                                        onKeyDown={handleSearchKeyDown}
                                        className="w-full min-h-[44px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl py-2.5 pl-10 pr-10 text-xs sm:text-sm text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand transition-all"
                                    />
                                    {search ? (
                                        <button
                                            type="button"
                                            aria-label="Limpiar búsqueda"
                                            onClick={() => setSearch('')}
                                            className="absolute right-2.5 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-full cursor-pointer"
                                        >
                                            <X size={15} />
                                        </button>
                                    ) : (
                                        <Barcode size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-300 dark:text-slate-600 pointer-events-none" />
                                    )}
                                </div>

                                {/* Filtros: Bajo stock + Categorías */}
                                <div ref={categoryScrollRef} className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide shrink-0">
                                    {lowStockTotal > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => setOnlyLowStock(v => !v)}
                                            className={`shrink-0 min-h-[32px] px-2.5 py-1 rounded-xl text-[11px] font-black transition-all border flex items-center gap-1 cursor-pointer ${
                                                onlyLowStock
                                                    ? 'bg-amber-500 text-white border-amber-500 shadow-xs'
                                                    : 'bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800/60'
                                            }`}
                                        >
                                            <AlertTriangle size={11} /> Bajo stock ({lowStockTotal})
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => setSelectedCategory('todos')}
                                        className={`shrink-0 min-h-[32px] px-3 py-1 rounded-xl text-[11px] font-bold transition-all border cursor-pointer ${
                                            selectedCategory === 'todos'
                                                ? 'bg-brand text-white border-brand shadow-xs font-black'
                                                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800'
                                        }`}
                                    >
                                        Todos ({getCategoryProductCount('todos')})
                                    </button>
                                    {categories.filter(c => c.id !== 'todos').map(cat => {
                                        const count = getCategoryProductCount(cat.id);
                                        const isActive = selectedCategory === cat.id;
                                        const catColorClass = CATEGORY_COLORS[cat.color] || 'bg-brand text-white border-brand';
                                        return (
                                            <button
                                                key={cat.id}
                                                type="button"
                                                onClick={() => setSelectedCategory(cat.id)}
                                                className={`shrink-0 min-h-[32px] px-3 py-1 rounded-xl text-[11px] font-bold transition-all border cursor-pointer ${
                                                    isActive
                                                        ? `${catColorClass} shadow-xs border-transparent font-black`
                                                        : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800'
                                                }`}
                                            >
                                                {cat.label} ({count})
                                            </button>
                                        );
                                    })}
                                </div>

                                {/* Lista de Catálogo */}
                                <div className="flex-1 min-h-[220px] max-h-[48vh] lg:max-h-none overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 scrollbar-hide">
                                    {catalogProducts.length === 0 ? (
                                        <div className="py-14 text-center text-xs text-slate-400 font-medium">
                                            <Package size={24} className="mx-auto mb-2 opacity-40" />
                                            Sin productos que coincidan
                                        </div>
                                    ) : catalogProducts.map(p => (
                                        <CatalogRow
                                            key={p.id}
                                            p={p}
                                            isSelected={p.id in adjustments}
                                            selectedQty={adjustments[p.id] || 0}
                                            direction={direction}
                                            onToggle={toggleProduct}
                                        />
                                    ))}
                                </div>
                            </div>

                            {/* COLUMNA DERECHA: BANDEJA EN VIVO DE AJUSTE */}
                            <div className={`${activeTab === 'adjusting' ? 'flex' : 'hidden lg:flex'} flex-col lg:col-span-6 p-4 sm:p-5 bg-slate-50/50 dark:bg-slate-950/40 min-h-0 gap-3`}>
                                <div className="hidden lg:flex items-center justify-between shrink-0">
                                    <span className="text-xs font-black uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                        En ajuste ({selectedProducts.length})
                                    </span>
                                    {selectedProducts.length > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => setAdjustments({})}
                                            className="text-[11px] font-bold text-slate-400 hover:text-rose-500 transition-colors cursor-pointer"
                                        >
                                            Limpiar lista
                                        </button>
                                    )}
                                </div>

                                <div className="flex-1 min-h-[220px] max-h-[46vh] lg:max-h-none overflow-y-auto space-y-2.5 scrollbar-hide pr-0.5">
                                    {selectedProducts.length === 0 ? (
                                        <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center p-6 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800 text-slate-400">
                                            <Boxes size={28} className="mb-2.5 opacity-40" />
                                            <p className="text-xs font-black text-slate-500 dark:text-slate-400">
                                                Tu bandeja está vacía
                                            </p>
                                            <p className="text-[11px] mt-1 max-w-[240px]">
                                                Toca artículos en el catálogo o escanea un código para ajustar por bultos o unidades.
                                            </p>
                                        </div>
                                    ) : selectedProducts.map(p => {
                                        const effUpp = getEffectiveUpp(p);
                                        const defaultUnit = effUpp > 1 ? 'lotes' : 'uds';
                                        const adjUnit = adjustmentUnits[p.id] || defaultUnit;
                                        const tempPkgSize = tempPackageSizes[p.id] || 0;
                                        return (
                                            <AdjustRow
                                                key={p.id}
                                                p={p}
                                                qty={adjustments[p.id] || 0}
                                                direction={direction}
                                                adjUnit={adjUnit}
                                                tempPkgSize={tempPkgSize}
                                                onSetQty={setQty}
                                                onSetAdjUnit={setAdjUnit}
                                                onSetTempPkgSize={setTempPkgSize}
                                                onRemove={removeProduct}
                                            />
                                        );
                                    })}
                                </div>

                                {/* Motivo rápido / Nota siempre accesible en la bandeja */}
                                {selectedProducts.length > 0 && (
                                    <div className="space-y-2 pt-2 border-t border-slate-200/70 dark:border-slate-800 shrink-0">
                                        {!isIngreso && (
                                            <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-hide">
                                                {QUICK_REASONS.map(reason => (
                                                    <button
                                                        key={reason}
                                                        type="button"
                                                        onClick={() => setNote(reason)}
                                                        className={`shrink-0 min-h-[30px] text-[10px] font-bold px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
                                                            note === reason
                                                                ? 'bg-rose-600 text-white border-rose-600'
                                                                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-rose-300'
                                                        }`}
                                                    >
                                                        {reason}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                        <input
                                            type="text"
                                            value={note}
                                            onChange={(e) => setNote(e.target.value)}
                                            placeholder={!isIngreso ? 'Escribe o elige un motivo del egreso (obligatorio)' : 'Nota / proveedor / factura (opcional)'}
                                            className={`w-full min-h-[42px] bg-white dark:bg-slate-900 border rounded-xl py-2 px-3.5 text-xs text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-brand/40 transition-all ${
                                                !isIngreso && !note.trim() && activeAdjustments.length > 0
                                                    ? 'border-rose-300 dark:border-rose-800 focus:ring-rose-500/30'
                                                    : 'border-slate-200 dark:border-slate-700'
                                            }`}
                                        />
                                        {!isIngreso && !note.trim() && activeAdjustments.length > 0 && (
                                            <p className="text-[10px] text-rose-600 dark:text-rose-400 font-bold flex items-center gap-1">
                                                <AlertTriangle size={11} /> Motivo requerido para registrar la salida
                                            </p>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Footer fijo */}
                        <div className="px-4 py-3.5 sm:px-6 border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 shrink-0">
                            <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                                {activeAdjustments.length > 0 ? (
                                    <>
                                        <strong className="text-slate-800 dark:text-white">{activeAdjustments.length} artículo{activeAdjustments.length !== 1 ? 's' : ''}</strong>
                                        <span>·</span>
                                        <strong className={isIngreso ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                                            {isIngreso ? '+' : '-'}{formatStockDisplay(totalItems, hasGranelInAdjust)} uds totales
                                        </strong>
                                    </>
                                ) : (
                                    <span>Selecciona artículos del catálogo para comenzar</span>
                                )}
                            </div>

                            {/* En móvil desde Catálogo lleva a En ajuste; en PC o desde En ajuste aplica directo */}
                            <button
                                type="button"
                                onClick={handleApply}
                                disabled={activeAdjustments.length === 0}
                                className={`${activeTab === 'catalog' && selectedProducts.length > 0 ? 'hidden lg:flex' : 'flex'} w-full sm:w-auto sm:min-w-[260px] min-h-[46px] px-5 py-3 font-black rounded-xl active:scale-[0.98] transition-all text-sm justify-center items-center gap-2 cursor-pointer ${
                                    activeAdjustments.length === 0
                                        ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 cursor-not-allowed border border-slate-200/60 dark:border-slate-700'
                                        : isIngreso
                                            ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-600/20'
                                            : 'bg-rose-600 hover:bg-rose-700 text-white shadow-lg shadow-rose-600/20'
                                }`}
                            >
                                {activeAdjustments.length > 0 && <Check size={16} />}
                                {activeAdjustments.length === 0
                                    ? 'Toca productos para seleccionar'
                                    : `Aplicar ${isIngreso ? 'Ingreso' : 'Egreso'} (${formatStockDisplay(totalItems, hasGranelInAdjust)} uds)`}
                            </button>

                            {activeTab === 'catalog' && selectedProducts.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setActiveTab('adjusting')}
                                    className={`flex lg:hidden w-full min-h-[46px] px-5 py-3 font-black rounded-xl active:scale-[0.98] transition-all text-sm justify-center items-center gap-2 text-white shadow-lg cursor-pointer ${
                                        isIngreso
                                            ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/20'
                                            : 'bg-rose-600 hover:bg-rose-700 shadow-rose-600/20'
                                    }`}
                                >
                                    Configurar cantidades ({selectedProducts.length} producto{selectedProducts.length !== 1 ? 's' : ''}) →
                                </button>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );

    return typeof document !== 'undefined' ? createPortal(modalNode, document.body) : modalNode;
}
