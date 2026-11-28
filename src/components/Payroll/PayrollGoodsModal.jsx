import { useEffect, useMemo, useState } from 'react';
import { Search, Trash2, Minus, Plus, ShoppingBag, UserRound, Barcode, AlertTriangle, CheckCircle2, Printer, FileDown } from 'lucide-react';
import { Modal } from '../Modal';
import PinField from './PinField';
import { storageService } from '../../utils/storageService';
import { PRODUCTS_KEY } from '../../services/gastosInternosService';
import {
    GOODS_VALUATION_LABELS,
    goodsUnitPriceUsd,
    readGoodsValuation,
    computePeriodBalance,
    periodIdFor,
} from '../../utils/payrollModel';
import { loadPayroll } from '../../services/payrollService';
import { resolveProductPresentations } from '../../utils/presentations';
import { findProductAndPresentationByCode } from '../../utils/barcodeAssign';
import { formatBs, formatUsd } from '../../utils/calculatorUtils';
import { mulR, round2, sumR } from '../../utils/dinero';

const newKey = () => globalThis.crypto?.randomUUID?.() ?? `k_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const inputCls = 'w-full min-h-[44px] px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-white font-semibold text-sm outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand transition-all';
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function getInitials(name = '') {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'EM';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * Consumo de mercancía de empleado con cargo a su sueldo.
 * Reutilizable desde Gestión › Nómina (employee fijo + PIN) y desde Vender / Caja
 * (selector de empleado + cajero sin PIN mientras no exceda el saldo del periodo).
 */
export default function PayrollGoodsModal({
    isOpen,
    employee: fixedEmployee = null,
    balance: fixedBalance = null,
    rate = 0,
    onClose,
    onSubmit,
    onReceipt,
    allowCashierWithinBalance = false,
}) {
    const [products, setProducts] = useState([]);
    const [employees, setEmployees] = useState([]);
    const [entries, setEntries] = useState([]);
    const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
    const [query, setQuery] = useState('');
    const [items, setItems] = useState([]); // [{ key, id, qty, presentationId }]
    const [nota, setNota] = useState('');
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');
    const [exceso, setExceso] = useState(null);
    const [saving, setSaving] = useState(false);
    const [done, setDone] = useState(null);
    const [idempotencyKey, setKey] = useState(newKey);
    const valuation = useMemo(() => (isOpen ? readGoodsValuation() : 'costo'), [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        setQuery('');
        setItems([]);
        setNota('');
        setPin('');
        setError('');
        setExceso(null);
        setDone(null);
        setKey(newKey());
        setSelectedEmployeeId(fixedEmployee?.id || '');
        let alive = true;
        storageService.getItem(PRODUCTS_KEY, []).then(list => {
            if (alive) setProducts(Array.isArray(list) ? list : []);
        });
        if (!fixedEmployee) {
            loadPayroll().then(data => {
                if (!alive) return;
                const activos = (data.employees || []).filter(e => e.activo !== false);
                setEmployees(activos);
                setEntries(data.entries || []);
                if (activos.length === 1) setSelectedEmployeeId(activos[0].id);
            }).catch(() => {});
        }
        return () => { alive = false; };
    }, [isOpen, fixedEmployee]);

    const employee = fixedEmployee || employees.find(e => e.id === selectedEmployeeId) || null;
    const balance = useMemo(() => {
        if (fixedEmployee) return fixedBalance;
        if (!employee) return null;
        return computePeriodBalance(entries, employee, periodIdFor(new Date(), employee.frecuencia));
    }, [fixedEmployee, fixedBalance, employee, entries]);

    const byId = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
    const results = useMemo(() => {
        const q = norm(query.trim());
        if (!q) return [];
        return products
            .filter(p => norm(p.name).includes(q) || String(p.barcode ?? '').includes(q))
            .slice(0, 8);
    }, [products, query]);

    const lines = items.map(i => {
        const p = byId.get(i.id);
        const levels = p ? resolveProductPresentations(p) : [];
        const unit = goodsUnitPriceUsd(p, valuation, i.presentationId || null);
        return { ...i, product: p, levels, unit, subtotal: mulR(unit, Number(i.qty) || 0) };
    });
    const totalUsd = sumR(...lines.map(l => l.subtotal));
    const saldoUsd = Math.max(0, balance?.saldoUsd || 0);
    const saldoDespuesUsd = round2(saldoUsd - totalUsd);
    const needsPin = !allowCashierWithinBalance || Boolean(exceso);

    const add = (p, presentationId = null) => {
        if (!p) return;
        const levels = resolveProductPresentations(p);
        const resolvedPresId = presentationId || (levels.length > 1 ? levels[0].id : null);
        const lineKey = `${p.id}::${resolvedPresId || ''}`;
        setItems(list => {
            const exists = list.find(i => i.key === lineKey);
            if (exists) {
                return list.map(i => (i.key === lineKey ? { ...i, qty: Number(i.qty || 0) + 1 } : i));
            }
            return [...list, { key: lineKey, id: p.id, qty: 1, presentationId: resolvedPresId }];
        });
        setQuery('');
        setExceso(null);
    };

    const handleSearchKeyDown = (e) => {
        if (e.key !== 'Enter') return;
        const term = query.trim();
        if (!term) return;
        e.preventDefault();
        const hit = findProductAndPresentationByCode(products, term);
        if (hit?.product) {
            add(hit.product, hit.presentation?.id || null);
            return;
        }
        if (results.length > 0) add(results[0]);
    };

    const setQty = (lineKey, qty) => {
        setItems(list => list.map(i => (i.key === lineKey ? { ...i, qty } : i)));
        setExceso(null);
    };

    const setLinePresentation = (lineKey, nextPresId) => {
        setItems(list => list.map(i => (
            i.key === lineKey ? { ...i, presentationId: nextPresId, key: `${i.id}::${nextPresId || ''}` } : i
        )));
        setExceso(null);
    };

    const remove = (lineKey) => {
        setItems(list => list.filter(i => i.key !== lineKey));
        setExceso(null);
    };

    const submit = async (e) => {
        e?.preventDefault();
        if (!employee) {
            setError('Selecciona un empleado primero.');
            return;
        }
        setSaving(true);
        setError('');
        try {
            const res = await onSubmit({
                employeeId: employee.id,
                tipo: 'MERCANCIA',
                items: items.map(i => ({
                    id: i.id,
                    qty: Number(i.qty),
                    ...(i.presentationId ? { presentationId: i.presentationId } : {}),
                })),
                nota,
                idempotencyKey,
                confirmarExceso: !!exceso,
            }, pin, employee);
            setDone({ ...res, employee });
        } catch (err) {
            if (err.code === 'EXCEDE_SALDO') setExceso({ excedenteUsd: err.excedenteUsd });
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    if (!isOpen) return null;
    if (fixedEmployee && !employee) return null;

    const title = employee ? `Consumo con sueldo · ${employee.nombre}` : 'Consumo de empleado (con sueldo)';

    if (done) {
        return (
            <Modal isOpen={isOpen} onClose={onClose} title={title} size="max-w-md">
                <div className="space-y-4 text-center py-2" data-testid="payroll-goods-done">
                    <div className="w-12 h-12 rounded-2xl bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 mx-auto flex items-center justify-center">
                        <CheckCircle2 size={26} />
                    </div>
                    <div>
                        <p className="text-lg font-black text-emerald-600">{done.duplicate ? 'Ya estaba registrado' : 'Consumo registrado'}</p>
                        <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">
                            Se descuentan <b className="font-mono tabular-nums">${formatUsd(done.entry.montoUsd)}</b> del sueldo de <b>{done.employee?.nombre || employee?.nombre}</b> y salió del inventario.
                        </p>
                        <p className="text-[11px] text-slate-400 mt-1">
                            Registrado por: <b className="text-slate-600 dark:text-slate-300">{done.entry.actor || 'Usuario'}</b>
                        </p>
                    </div>
                    {done.arrastre && (
                        <p className="text-xs font-bold rounded-xl px-3 py-2 bg-amber-50 text-amber-900 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800">
                            ⚠ Queda debiendo ${formatUsd(done.arrastre.montoUsd)} para el próximo periodo.
                        </p>
                    )}
                    {onReceipt && (
                        <div className="flex gap-2">
                            <button type="button" onClick={() => onReceipt(done.entry, 'print', done.employee)}
                                className="flex-1 min-h-[44px] py-2.5 rounded-xl font-bold text-sm bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 flex items-center justify-center gap-1.5 cursor-pointer">
                                <Printer size={15} /> Imprimir ticket
                            </button>
                            <button type="button" onClick={() => onReceipt(done.entry, 'pdf', done.employee)}
                                className="flex-1 min-h-[44px] py-2.5 rounded-xl font-bold text-sm bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 flex items-center justify-center gap-1.5 cursor-pointer">
                                <FileDown size={15} /> Bajar PDF
                            </button>
                        </div>
                    )}
                    <button type="button" onClick={onClose} className="w-full min-h-[46px] py-3 rounded-xl font-black text-white bg-brand hover:bg-brand-dark cursor-pointer">
                        Listo
                    </button>
                </div>
            </Modal>
        );
    }

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={title} size="max-w-2xl">
            <form onSubmit={submit} className="space-y-4" data-testid="payroll-goods-form">
                {/* Selector de empleado (solo cuando se abre desde Vender / Caja) */}
                {!fixedEmployee && (
                    <div className="space-y-2">
                        <span className="text-xs font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                            <UserRound size={13} /> ¿Qué empleado se lleva la mercancía?
                        </span>
                        {employees.length === 0 ? (
                            <p className="text-xs font-bold text-amber-800 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-200 border border-amber-200 dark:border-amber-800 rounded-xl px-3.5 py-2.5">
                                Aún no hay empleados activos en Nómina. Agrégalos en Gestión → Nómina.
                            </p>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-40 overflow-y-auto pr-0.5">
                                {employees.map(emp => {
                                    const empBal = computePeriodBalance(entries, emp, periodIdFor(new Date(), emp.frecuencia));
                                    const selected = emp.id === selectedEmployeeId;
                                    return (
                                        <button
                                            key={emp.id}
                                            type="button"
                                            data-testid={`payroll-pick-emp-${emp.id}`}
                                            onClick={() => { setSelectedEmployeeId(emp.id); setExceso(null); setError(''); }}
                                            className={`min-h-[48px] p-2.5 rounded-xl border text-left flex items-center gap-2.5 transition-all cursor-pointer ${
                                                selected
                                                    ? 'border-brand bg-brand-light/40 dark:bg-brand/15 ring-2 ring-brand/25'
                                                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-brand/40'
                                            }`}
                                        >
                                            <span className={`w-8 h-8 rounded-xl text-xs font-black flex items-center justify-center shrink-0 ${
                                                selected ? 'bg-brand text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                                            }`}>
                                                {getInitials(emp.nombre)}
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <p className="text-xs font-black text-slate-800 dark:text-white truncate">{emp.nombre}</p>
                                                <p className="text-[10px] text-slate-500 font-mono tabular-nums truncate">
                                                    Disponible: ${formatUsd(Math.max(0, empBal.saldoUsd))}
                                                </p>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                {/* Tira de saldo disponible antes → después */}
                {employee && (
                    <div className="rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/70 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                        <div>
                            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 block">
                                Sueldo disponible en el periodo
                            </span>
                            <div className="flex items-center gap-2 mt-0.5 font-mono tabular-nums">
                                <b className="text-base font-black text-slate-800 dark:text-white">${formatUsd(saldoUsd)}</b>
                                {totalUsd > 0 && (
                                    <span className={`text-sm font-black ${saldoDespuesUsd < 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                        → ${formatUsd(Math.max(0, saldoDespuesUsd))}
                                        {saldoDespuesUsd < 0 ? ` (debe $${formatUsd(-saldoDespuesUsd)})` : ''}
                                    </span>
                                )}
                            </div>
                        </div>
                        <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-900 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700" data-testid="payroll-goods-valuation">
                            Valorado a <b className="text-slate-700 dark:text-slate-200">{GOODS_VALUATION_LABELS[valuation].toLowerCase()}</b>
                        </span>
                    </div>
                )}

                {/* Buscador + escáner */}
                <div className="relative">
                    <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                    <input
                        className={`${inputCls} pl-10 pr-10`}
                        placeholder="Buscar o escanear producto (+Enter agrega)..."
                        value={query}
                        data-testid="payroll-goods-search"
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        autoFocus={Boolean(fixedEmployee)}
                    />
                    <Barcode size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-300 dark:text-slate-600 pointer-events-none" aria-hidden="true" />
                    {results.length > 0 && (
                        <ul className="absolute z-20 mt-1 w-full max-h-56 overflow-auto rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl divide-y divide-slate-100 dark:divide-slate-800">
                            {results.map(p => (
                                <li key={p.id}>
                                    <button type="button" data-testid="payroll-goods-result" onClick={() => add(p)}
                                        className="w-full text-left px-3.5 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-between gap-3 cursor-pointer">
                                        <div className="min-w-0">
                                            <span className="block text-sm font-bold text-slate-800 dark:text-white truncate">{p.name}</span>
                                            <span className="block text-[11px] font-mono tabular-nums text-slate-500">
                                                Stock {p.stock ?? 0} · ${formatUsd(goodsUnitPriceUsd(p, valuation))} c/u
                                            </span>
                                        </div>
                                        <span className="w-7 h-7 rounded-lg bg-brand-light text-brand flex items-center justify-center shrink-0">
                                            <Plus size={14} strokeWidth={2.5} />
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {/* Lista de productos seleccionados */}
                <div className="space-y-2 max-h-60 overflow-y-auto pr-0.5" data-testid="payroll-goods-lines">
                    {lines.length === 0 && (
                        <div className="rounded-2xl border border-dashed border-slate-200 dark:border-slate-800 py-6 text-center text-xs text-slate-400">
                            <ShoppingBag size={22} className="mx-auto mb-1.5 opacity-40" />
                            Busca o escanea los productos que se lleva el empleado.
                        </div>
                    )}
                    {lines.map(l => (
                        <div key={l.key} data-testid="payroll-goods-line" className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-2">
                            <div className="flex items-center gap-2.5">
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-black text-slate-800 dark:text-white truncate">{l.product?.name || '—'}</p>
                                    <p className="text-[11px] font-mono tabular-nums text-slate-500">
                                        ${formatUsd(l.unit)} c/u · stock {l.product?.stock ?? 0}
                                    </p>
                                </div>
                                <div className="flex items-center bg-slate-100 dark:bg-slate-800 rounded-xl p-0.5 border border-slate-200 dark:border-slate-700">
                                    <button
                                        type="button"
                                        aria-label={`Restar ${l.product?.name}`}
                                        onClick={() => setQty(l.key, Math.max(0, Number(l.qty || 0) - 1))}
                                        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 cursor-pointer"
                                    >
                                        <Minus size={13} strokeWidth={2.5} />
                                    </button>
                                    <input
                                        type="number"
                                        inputMode="decimal"
                                        min="0"
                                        step="any"
                                        aria-label={`Cantidad de ${l.product?.name}`}
                                        className="w-14 h-8 bg-transparent text-center font-mono tabular-nums font-black text-sm text-slate-900 dark:text-white outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                        value={l.qty}
                                        onChange={e => setQty(l.key, e.target.value)}
                                    />
                                    <button
                                        type="button"
                                        aria-label={`Sumar ${l.product?.name}`}
                                        onClick={() => setQty(l.key, Number(l.qty || 0) + 1)}
                                        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 cursor-pointer"
                                    >
                                        <Plus size={13} strokeWidth={2.5} />
                                    </button>
                                </div>
                                <span className="w-16 text-right font-mono tabular-nums text-sm font-black text-slate-900 dark:text-white">
                                    ${formatUsd(l.subtotal)}
                                </span>
                                <button
                                    type="button"
                                    aria-label={`Quitar ${l.product?.name}`}
                                    onClick={() => remove(l.key)}
                                    className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>

                            {l.levels.length > 1 && (
                                <div className="flex items-center gap-1.5 flex-wrap pt-1.5 border-t border-slate-100 dark:border-slate-800">
                                    {l.levels.map(lvl => {
                                        const active = l.presentationId === lvl.id;
                                        return (
                                            <button
                                                key={lvl.id}
                                                type="button"
                                                onClick={() => setLinePresentation(l.key, lvl.id)}
                                                className={`px-2.5 py-1 rounded-lg text-[10px] font-black border cursor-pointer transition-colors ${
                                                    active
                                                        ? 'bg-brand text-white border-brand'
                                                        : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                                                }`}
                                            >
                                                {lvl.name}{lvl.factorToBase > 1 ? ` ×${lvl.factorToBase}` : ''}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {lines.length > 0 && (
                    <div className="flex justify-between items-center text-sm font-black bg-slate-50 dark:bg-slate-800/50 rounded-xl px-4 py-2.5 font-mono tabular-nums" data-testid="payroll-goods-total">
                        <span className="font-sans text-slate-600 dark:text-slate-300">Total a descontar del sueldo</span>
                        <span className="text-base text-brand">${formatUsd(totalUsd)} · Bs {formatBs(mulR(totalUsd, rate))}</span>
                    </div>
                )}

                <label className="block">
                    <span className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1">Nota (opcional)</span>
                    <input className={inputCls} value={nota} onChange={e => setNota(e.target.value)} maxLength={200} placeholder="Ej. Almuerzo, merienda, compra personal…" />
                </label>

                {needsPin && <PinField value={pin} onChange={setPin} />}

                {error && (
                    <p role="alert" data-testid="payroll-goods-error"
                        className={`text-sm font-bold rounded-xl px-3.5 py-2.5 flex items-center gap-2 ${
                            exceso
                                ? 'bg-amber-50 text-amber-900 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800'
                                : 'bg-rose-50 text-rose-700 border border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
                        }`}>
                        <AlertTriangle size={16} className="shrink-0" />
                        <span>{error}</span>
                    </p>
                )}

                <button
                    type="submit"
                    disabled={saving || !employee || lines.length === 0 || !(totalUsd > 0)}
                    data-testid="payroll-goods-submit"
                    className={`w-full min-h-[46px] py-3 rounded-xl font-black text-white disabled:opacity-50 cursor-pointer transition-all ${
                        exceso ? 'bg-amber-500 hover:bg-amber-600' : 'bg-brand hover:bg-brand-dark'
                    }`}
                >
                    {saving
                        ? 'Guardando…'
                        : exceso
                            ? `Autorizar y registrar (queda debiendo $${formatUsd(exceso.excedenteUsd)})`
                            : 'Registrar consumo con sueldo'}
                </button>
            </form>
        </Modal>
    );
}
