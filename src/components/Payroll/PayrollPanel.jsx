import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Wallet, Plus, Pencil, ChevronLeft, ChevronRight, Printer, FileDown, Ban,
    UserX, UserCheck, ArrowLeft, ShoppingBag, Banknote, HandCoins, Gift,
    MinusCircle, Clock, UserRound, Search, Users, CheckCircle2,
} from 'lucide-react';
import { showToast } from '../Toast';
import { Modal } from '../Modal';
import EmptyState from '../EmptyState';
import PinField from './PinField';
import EmployeeFormModal from './EmployeeFormModal';
import PayrollEntryModal from './PayrollEntryModal';
import PayrollGoodsModal from './PayrollGoodsModal';
import { useAuthStore } from '../../hooks/store/useAuthStore';
import { verifyNubeAdminPin } from '../../nube/nubeAdminPin';
import { useAudit } from '../../hooks/useAudit';
import { getActivePaymentMethods } from '../../config/paymentMethods';
import { formatBs, formatUsd } from '../../utils/calculatorUtils';
import { mulR } from '../../utils/dinero';
import {
    computePeriodBalance, periodIdFor, periodLabel, nextPeriodId, previousPeriodId,
    FRECUENCIA_LABELS, ENTRY_TYPE_LABELS, MONEY_OUT_TYPES, GOODS_TYPE,
} from '../../utils/payrollModel';
import {
    loadPayroll, saveEmployee, setEmployeeActive, registerEntry, registerGoods, voidEntry, recoverPayroll,
} from '../../services/payrollService';
import { buildPayrollReceiptData, printPayrollReceipt, downloadPayrollReceiptPdf } from '../../utils/payrollReceipt';

const ESTADO = {
    PAGADO: { label: 'Pagado', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300' },
    EN_CURSO: { label: 'En curso', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300' },
    SIN_MOVIMIENTOS: { label: 'Sin movimientos', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
};

const FILTER_TABS = [
    { id: 'ALL', label: 'Todos' },
    { id: GOODS_TYPE, label: 'Mercancía' },
    { id: 'ADELANTO', label: 'Adelantos' },
    { id: 'PAGO', label: 'Pagos' },
    { id: 'OTHER', label: 'Bonos / Desc.' },
];

function getInitials(name = '') {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'EM';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * Gestión › Nómina (plan 2026-11-14 + rediseño UI/UX 2026-11-27). Solo Administrador.
 * Toda escritura pasa por services/payrollService (candado, PIN, idempotencia).
 */
export default function PayrollPanel({ rate = 0, isActive = true, triggerHaptic }) {
    const legacyAuthorize = useAuthStore(s => s.verifyAdminPin);
    const authorize = useCallback((pinValue) => verifyNubeAdminPin(pinValue, { fallbackAuthorize: legacyAuthorize }), [legacyAuthorize]);
    const { log } = useAudit();
    const [employees, setEmployees] = useState([]);
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showInactive, setShowInactive] = useState(false);
    const [empSearch, setEmpSearch] = useState('');
    const [entryFilter, setEntryFilter] = useState('ALL');
    const [selectedId, setSelectedId] = useState(null);
    const [viewPeriod, setViewPeriod] = useState(null);
    const [employeeModal, setEmployeeModal] = useState({ open: false, employee: null });
    const [entryModal, setEntryModal] = useState({ open: false, tipo: null });
    const [goodsOpen, setGoodsOpen] = useState(false);
    const [pinAction, setPinAction] = useState(null);
    const [pin, setPin] = useState('');
    const [pinError, setPinError] = useState('');
    const [paymentMethods, setPaymentMethods] = useState([]);

    const ctxFor = useCallback((pinValue) => ({
        authorize, pin: pinValue, getRate: () => rate, audit: (cat, action, desc) => log(cat, action, desc),
    }), [authorize, rate, log]);

    const reload = useCallback(async () => {
        const data = await loadPayroll();
        setEmployees(data.employees);
        setEntries(data.entries);
    }, []);

    useEffect(() => {
        if (!isActive) return;
        let alive = true;
        (async () => {
            try {
                const rec = await recoverPayroll({ audit: (c, a, d) => log(c, a, d) });
                if (rec.movimientosAnulados || rec.renglonesAnulados) {
                    showToast('Se corrigió un movimiento de nómina que quedó a medias.', 'warning');
                }
            } catch (err) {
                console.warn('[Nómina] recuperación falló:', err?.message ?? err);
            }
            if (alive) { await reload(); setLoading(false); }
        })();
        const loadPaymentMethods = () => getActivePaymentMethods().then(ms => alive && setPaymentMethods(
            ms.filter(m => (m.currency === 'USD' || m.currency === 'BS') && !m.isVirtual && m.id !== 'cashea'),
        ));
        loadPaymentMethods();
        const onStorageUpdate = (e) => {
            const key = e?.detail?.key;
            if (!key || key === 'bodega_employees_v1' || key === 'bodega_payroll_entries_v1') {
                if (alive) reload();
            }
            if (!key || key === 'bodega_payment_methods_v1') {
                if (alive) loadPaymentMethods();
            }
        };
        window.addEventListener('app_storage_update', onStorageUpdate);
        return () => {
            alive = false;
            window.removeEventListener('app_storage_update', onStorageUpdate);
        };
    }, [isActive, reload, log]);

    const now = new Date();
    const rows = useMemo(() => employees
        .filter(e => showInactive || e.activo !== false)
        .map(e => ({ employee: e, balance: computePeriodBalance(entries, e, periodIdFor(now, e.frecuencia)) }))
        .sort((a, b) => a.employee.nombre.localeCompare(b.employee.nombre)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` cambia cada render a propósito
    [employees, entries, showInactive]);

    const activeRows = rows.filter(r => r.employee.activo !== false);
    const totalPorPagar = activeRows.reduce((s, r) => s + Math.max(0, r.balance.saldoUsd), 0);
    const paidCount = activeRows.filter(r => r.balance.estado === 'PAGADO').length;
    const filteredRows = useMemo(() => {
        const q = empSearch.trim().toLowerCase();
        if (!q) return rows;
        return rows.filter(({ employee: e }) =>
            String(e.nombre || '').toLowerCase().includes(q)
            || String(e.cargo || '').toLowerCase().includes(q),
        );
    }, [rows, empSearch]);

    const selected = employees.find(e => e.id === selectedId) || null;
    const currentPeriod = selected ? periodIdFor(now, selected.frecuencia) : null;
    const shownPeriod = viewPeriod || currentPeriod;
    const shownBalance = selected ? computePeriodBalance(entries, selected, shownPeriod) : null;
    const isCurrent = shownPeriod === currentPeriod;

    const openEmployee = (id) => {
        setSelectedId(id);
        setViewPeriod(null);
        setEntryFilter('ALL');
        triggerHaptic && triggerHaptic();
    };

    const handleSaveEmployee = async (input, pinValue) => {
        const saved = await saveEmployee(input, ctxFor(pinValue));
        await reload();
        showToast(input.id ? 'Empleado actualizado' : 'Empleado creado', 'success');
        return saved;
    };

    const handleSubmitEntry = async (input, pinValue) => {
        const res = await registerEntry(input, ctxFor(pinValue));
        await reload();
        if (!res.duplicate) showToast(`${ENTRY_TYPE_LABELS[input.tipo]} registrado`, 'success');
        return res;
    };

    const handleSubmitGoods = async (input, pinValue) => {
        const res = await registerGoods(input, ctxFor(pinValue));
        await reload();
        if (!res.duplicate) showToast('Mercancía registrada', 'success');
        return res;
    };

    const receipt = useCallback((entry, mode) => {
        const employee = employees.find(e => e.id === entry.employeeId);
        const bal = computePeriodBalance(entries, employee, entry.periodoId);
        const label = paymentMethods.find(m => m.id === entry.metodoId)?.label;
        const data = buildPayrollReceiptData({ entry, employee, saldoDespuesUsd: bal.saldoUsd, methodLabel: label });
        if (mode === 'pdf') downloadPayrollReceiptPdf(data).catch(err => showToast(err.message || 'No se pudo crear el PDF', 'error'));
        else printPayrollReceipt(data);
    }, [employees, entries, paymentMethods]);

    const askPin = (title, message, run) => { setPin(''); setPinError(''); setPinAction({ title, message, run }); };
    const runPinAction = async () => {
        try {
            await pinAction.run(pin);
            setPinAction(null);
        } catch (err) {
            setPinError(err.message);
        }
    };

    if (loading) {
        return <div className="p-6 text-center text-slate-500 font-bold">Cargando nómina…</div>;
    }

    // ─── Detalle del empleado ──────────────────────────────────────────────
    if (selected) {
        const b = shownBalance;
        const est = ESTADO[b.estado];
        const totalBase = Math.max(0.01, b.sueldoPeriodoUsd + b.bonosUsd);
        const consumedPct = Math.min(100, Math.max(0, Math.round(((totalBase - Math.max(0, b.saldoUsd)) / totalBase) * 100)));

        const filteredEntries = [...b.renglones].reverse().filter(e => {
            if (entryFilter === 'ALL') return true;
            if (entryFilter === 'OTHER') return e.tipo === 'BONO' || e.tipo === 'DESCUENTO';
            return e.tipo === entryFilter;
        });

        return (
            <div className="p-3 sm:p-6 pb-24 lg:pb-6 space-y-5 max-w-6xl mx-auto" data-testid="payroll-detail">
                {/* Cabecera superior */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <button
                            type="button"
                            onClick={() => setSelectedId(null)}
                            aria-label="Volver a la lista"
                            className="w-10 h-10 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-300 hover:border-brand hover:text-brand transition-colors cursor-pointer shrink-0"
                        >
                            <ArrowLeft size={18} />
                        </button>
                        <div className="w-11 h-11 rounded-2xl bg-brand-light dark:bg-brand/20 text-brand font-black text-sm flex items-center justify-center border border-brand/20 shrink-0">
                            {getInitials(selected.nombre)}
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white tracking-tight truncate">
                                {selected.nombre}
                            </h2>
                            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 truncate">
                                {[selected.cargo, FRECUENCIA_LABELS[selected.frecuencia], `Sueldo $${formatUsd(selected.sueldoUsd)}`].filter(Boolean).join(' · ')}
                                {selected.activo === false && ' · Desactivado'}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            title="Editar"
                            data-testid="employee-edit"
                            onClick={() => setEmployeeModal({ open: true, employee: selected })}
                            className="min-h-[40px] px-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 text-xs font-bold flex items-center gap-1.5 hover:border-brand hover:text-brand transition-colors cursor-pointer"
                        >
                            <Pencil size={14} /> Editar
                        </button>
                        <button
                            type="button"
                            title={selected.activo === false ? 'Activar' : 'Desactivar'}
                            onClick={() => askPin(
                                selected.activo === false ? 'Activar empleado' : 'Desactivar empleado',
                                selected.activo === false ? `${selected.nombre} vuelve a la lista.` : `${selected.nombre} sale de la lista. Su historial se conserva.`,
                                async (p) => { await setEmployeeActive(selected.id, selected.activo === false, ctxFor(p)); await reload(); },
                            )}
                            className="w-10 h-10 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-500 hover:text-rose-600 hover:border-rose-300 flex items-center justify-center transition-colors cursor-pointer"
                        >
                            {selected.activo === false ? <UserCheck size={16} /> : <UserX size={16} />}
                        </button>
                    </div>
                </div>

                {/* Cuerpo en 2 columnas equilibradas */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                    {/* Columna izquierda: Periodo + Resumen + Acciones */}
                    <div className="lg:col-span-5 space-y-4">
                        {/* Selector de periodo */}
                        <div className="flex items-center justify-between rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 p-2 shadow-2xs">
                            <button
                                type="button"
                                aria-label="Periodo anterior"
                                onClick={() => setViewPeriod(previousPeriodId(shownPeriod))}
                                className="w-10 h-10 rounded-xl flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer"
                            >
                                <ChevronLeft size={18} />
                            </button>
                            <div className="text-center px-2">
                                <p className="text-sm font-black text-slate-800 dark:text-white" data-testid="payroll-period-label">
                                    {periodLabel(shownPeriod)}
                                </p>
                                <span className={`inline-block mt-1 text-[10px] font-black px-2.5 py-0.5 rounded-full ${est.cls}`}>
                                    {isCurrent ? 'Periodo actual · ' : ''}{est.label}
                                </span>
                            </div>
                            <button
                                type="button"
                                aria-label="Periodo siguiente"
                                disabled={isCurrent}
                                onClick={() => setViewPeriod(nextPeriodId(shownPeriod))}
                                className="w-10 h-10 rounded-xl flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                            >
                                <ChevronRight size={18} />
                            </button>
                        </div>

                        {/* Tarjeta de balance del periodo */}
                        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 p-4 shadow-2xs space-y-3">
                            <div className="space-y-1.5 text-sm">
                                {[
                                    ['Sueldo del periodo', b.sueldoPeriodoUsd, '+'],
                                    ['Bonos', b.bonosUsd, '+'],
                                    ['Descuentos', b.descuentosUsd, '−'],
                                    ['Mercancía con sueldo', b.mercanciaUsd, '−'],
                                    ['Deuda del periodo anterior', b.arrastreRecibidoUsd, '−'],
                                    ['Adelantos', b.adelantosUsd, '−'],
                                    ['Pagos', b.pagosUsd, '−'],
                                    ['Pasa como deuda al siguiente', b.arrastreEnviadoUsd, '+'],
                                ].filter(([, v], i) => i === 0 || v > 0).map(([k, v, sign]) => (
                                    <div key={k} className="flex justify-between items-center">
                                        <span className="text-slate-500 dark:text-slate-400">{k}</span>
                                        <span className="font-sans tabular-nums font-bold text-slate-800 dark:text-slate-200">
                                            {sign} ${formatUsd(v)}
                                        </span>
                                    </div>
                                ))}
                            </div>

                            {/* Barra visual de avance */}
                            <div className="space-y-1 pt-1">
                                <div className="flex justify-between text-[10px] font-bold text-slate-400">
                                    <span>Consumido / Pagado</span>
                                    <span className="font-sans tabular-nums">{consumedPct}%</span>
                                </div>
                                <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                                    <div
                                        className={`h-full rounded-full transition-all duration-300 ${
                                            b.estado === 'PAGADO' ? 'bg-emerald-500' : 'bg-brand'
                                        }`}
                                        style={{ width: `${consumedPct}%` }}
                                    />
                                </div>
                            </div>

                            <div className="flex justify-between items-baseline border-t border-slate-100 dark:border-slate-800 pt-3">
                                <span className="text-sm font-black text-slate-700 dark:text-slate-200">Por pagar</span>
                                <span className="font-sans tabular-nums text-lg font-black text-brand" data-testid="payroll-detail-saldo">
                                    ${formatUsd(Math.max(0, b.saldoUsd))} · Bs {formatBs(mulR(Math.max(0, b.saldoUsd), rate))}
                                </span>
                            </div>
                            {b.saldoUsd < 0 && (
                                <p className="text-xs font-bold text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 rounded-xl px-3 py-2 border border-amber-200 dark:border-amber-800">
                                    ⚠ El periodo quedó en −${formatUsd(-b.saldoUsd)} (se pagó de más tras anular un bono).
                                </p>
                            )}
                        </div>

                        {/* Acciones rápidas con jerarquía semántica */}
                        {isCurrent && selected.activo !== false && (
                            <div className="space-y-2">
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        type="button"
                                        data-testid="payroll-action-PAGO"
                                        onClick={() => setEntryModal({ open: true, tipo: 'PAGO' })}
                                        className="min-h-[46px] px-3 py-2.5 rounded-xl font-black text-sm bg-brand hover:bg-brand-dark text-white shadow-sm flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-[0.98]"
                                    >
                                        <Banknote size={16} /> Pagar periodo
                                    </button>
                                    <button
                                        type="button"
                                        data-testid={`payroll-action-${GOODS_TYPE}`}
                                        onClick={() => setGoodsOpen(true)}
                                        className="min-h-[46px] px-3 py-2.5 rounded-xl font-black text-sm bg-amber-500 hover:bg-amber-600 text-white shadow-sm flex items-center justify-center gap-2 cursor-pointer transition-all active:scale-[0.98]"
                                    >
                                        <ShoppingBag size={16} /> Se lleva mercancía
                                    </button>
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                    <button
                                        type="button"
                                        data-testid="payroll-action-ADELANTO"
                                        onClick={() => setEntryModal({ open: true, tipo: 'ADELANTO' })}
                                        className="min-h-[44px] px-2.5 py-2 rounded-xl font-bold text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-blue-400 hover:text-blue-600 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                                    >
                                        <HandCoins size={14} className="text-blue-500" /> Dar adelanto
                                    </button>
                                    <button
                                        type="button"
                                        data-testid="payroll-action-BONO"
                                        onClick={() => setEntryModal({ open: true, tipo: 'BONO' })}
                                        className="min-h-[44px] px-2.5 py-2 rounded-xl font-bold text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-emerald-400 hover:text-emerald-600 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                                    >
                                        <Gift size={14} className="text-emerald-500" /> Bono
                                    </button>
                                    <button
                                        type="button"
                                        data-testid="payroll-action-DESCUENTO"
                                        onClick={() => setEntryModal({ open: true, tipo: 'DESCUENTO' })}
                                        className="min-h-[44px] px-2.5 py-2 rounded-xl font-bold text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:border-rose-400 hover:text-rose-600 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                                    >
                                        <MinusCircle size={14} className="text-rose-500" /> Descuento
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Columna derecha: Historial completo y auditable dentro de tarjeta */}
                    <div className="lg:col-span-7 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-2xs overflow-hidden">
                        <div className="px-4 py-3.5 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-slate-50/60 dark:bg-slate-800/40">
                            <h3 className="text-sm font-black text-slate-800 dark:text-white flex items-center gap-2">
                                <Clock size={15} className="text-brand" />
                                Historial del periodo ({b.renglones.length})
                            </h3>
                            <div className="flex gap-1 overflow-x-auto scrollbar-hide">
                                {FILTER_TABS.map(tab => (
                                    <button
                                        key={tab.id}
                                        type="button"
                                        onClick={() => setEntryFilter(tab.id)}
                                        className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors cursor-pointer shrink-0 ${
                                            entryFilter === tab.id
                                                ? 'bg-brand text-white'
                                                : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:text-slate-800'
                                        }`}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="p-4 space-y-2.5" data-testid="payroll-entries">
                            {filteredEntries.length === 0 ? (
                                <div className="py-12 text-center space-y-2">
                                    <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-400 mx-auto flex items-center justify-center">
                                        <Wallet size={22} />
                                    </div>
                                    <p className="text-sm font-bold text-slate-600 dark:text-slate-300">
                                        {b.renglones.length === 0 ? 'Sin movimientos en este periodo.' : 'No hay movimientos en este filtro.'}
                                    </p>
                                    <p className="text-xs text-slate-400 max-w-xs mx-auto">
                                        Los adelantos, pagos, bonos y consumos de mercancía con sueldo aparecerán aquí con fecha, hora y responsable.
                                    </p>
                                </div>
                            ) : filteredEntries.map(e => {
                                const voided = e.status !== 'ACTIVO';
                                const isGoods = e.tipo === GOODS_TYPE;
                                const isBono = e.tipo === 'BONO';
                                const fechaHora = new Date(e.timestamp).toLocaleString('es-VE', {
                                    timeZone: 'America/Caracas',
                                    dateStyle: 'short',
                                    timeStyle: 'short',
                                });
                                return (
                                    <div
                                        key={e.id}
                                        data-testid="payroll-entry-row"
                                        className={`rounded-2xl border p-3.5 space-y-2 transition-colors ${
                                            voided
                                                ? 'border-slate-200/60 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 opacity-55'
                                                : 'border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900'
                                        }`}
                                    >
                                        <div className="flex justify-between items-start gap-3">
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <span className="font-black text-sm text-slate-900 dark:text-white">
                                                        {e.origen === 'ARRASTRE' ? 'Deuda del periodo anterior' : ENTRY_TYPE_LABELS[e.tipo]}
                                                    </span>
                                                    {e.source === 'CAJA' && (
                                                        <span className="text-[10px] font-black px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                                                            Desde Caja
                                                        </span>
                                                    )}
                                                    {voided && (
                                                        <span className="text-[10px] font-black bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 px-1.5 py-0.5 rounded-md">
                                                            ANULADO
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                                                    <span className="font-sans tabular-nums">{fechaHora}</span>
                                                    {e.actor && (
                                                        <>
                                                            <span>·</span>
                                                            <span className="inline-flex items-center gap-1 font-semibold text-slate-600 dark:text-slate-300">
                                                                <UserRound size={11} /> {e.actor}
                                                            </span>
                                                        </>
                                                    )}
                                                    {e.metodoId && (
                                                        <>
                                                            <span>·</span>
                                                            <span>{paymentMethods.find(m => m.id === e.metodoId)?.label || e.metodoId}</span>
                                                        </>
                                                    )}
                                                </p>
                                            </div>

                                            <div className="flex items-center gap-1 shrink-0">
                                                <div className="text-right mr-1 font-sans tabular-nums">
                                                    <span className={`font-black text-sm ${isBono ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                                                        {isBono ? '+' : '−'}${formatUsd(e.montoUsd)}
                                                    </span>
                                                    {e.moneda === 'BS' && (
                                                        <span className="block text-[10px] text-slate-500">Bs {formatBs(e.montoBs)}</span>
                                                    )}
                                                </div>
                                                {e.origen !== 'ARRASTRE' && (
                                                    <>
                                                        <button
                                                            type="button"
                                                            title="Imprimir ticket"
                                                            onClick={() => receipt(e, 'print')}
                                                            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                                                        >
                                                            <Printer size={14} />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            title="Bajar PDF"
                                                            onClick={() => receipt(e, 'pdf')}
                                                            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                                                        >
                                                            <FileDown size={14} />
                                                        </button>
                                                    </>
                                                )}
                                                {!voided && e.origen !== 'ARRASTRE' && (
                                                    <button
                                                        type="button"
                                                        title="Anular"
                                                        data-testid="payroll-entry-void"
                                                        onClick={() => askPin(
                                                            'Anular movimiento',
                                                            MONEY_OUT_TYPES.has(e.tipo)
                                                                ? `El ${ENTRY_TYPE_LABELS[e.tipo].toLowerCase()} de $${formatUsd(e.montoUsd)} se tacha y su salida de caja también.`
                                                                : isGoods
                                                                    ? `La mercancía de $${formatUsd(e.montoUsd)} se tacha y los productos vuelven al inventario.`
                                                                    : `El ${ENTRY_TYPE_LABELS[e.tipo].toLowerCase()} de $${formatUsd(e.montoUsd)} se tacha.`,
                                                            async (p) => { await voidEntry(e.id, ctxFor(p)); await reload(); showToast('Movimiento anulado', 'success'); },
                                                        )}
                                                        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer"
                                                    >
                                                        <Ban size={14} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>

                                        {/* Desglose completo 100% auditable de productos cuando es mercancía */}
                                        {isGoods && Array.isArray(e.items) && e.items.length > 0 && (
                                            <div className="rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 px-3 py-2 space-y-1">
                                                {e.items.map((item, idx) => (
                                                    <div key={`${item.id}-${idx}`} className="flex items-center justify-between gap-2 text-xs">
                                                        <span className="text-slate-700 dark:text-slate-200 font-semibold">
                                                            <b className="font-sans tabular-nums">{item.qty}×</b> {item.name}
                                                            {item.presentationName && item.factorToBase > 1 ? ` (${item.presentationName})` : ''}
                                                        </span>
                                                        <span className="font-sans tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                                                            ${formatUsd(item.unitUsd)} c/u · <b className="text-slate-800 dark:text-white">${formatUsd(item.subtotalUsd)}</b>
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}

                                        {e.nota && (
                                            <p className="text-xs text-slate-500 dark:text-slate-400 italic">
                                                Nota: {e.nota}
                                            </p>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

                <EmployeeFormModal isOpen={employeeModal.open} employee={employeeModal.employee}
                    onClose={() => setEmployeeModal({ open: false, employee: null })} onSave={handleSaveEmployee} />
                <PayrollEntryModal isOpen={entryModal.open} tipo={entryModal.tipo} employee={selected} balance={shownBalance}
                    rate={rate} paymentMethods={paymentMethods} onClose={() => setEntryModal({ open: false, tipo: null })}
                    onSubmit={handleSubmitEntry} onReceipt={receipt} />
                <PayrollGoodsModal isOpen={goodsOpen} employee={selected} balance={shownBalance} rate={rate}
                    onClose={() => setGoodsOpen(false)} onSubmit={handleSubmitGoods} onReceipt={receipt} />
                {renderPinModal()}
            </div>
        );
    }

    function renderPinModal() {
        return (
            <Modal isOpen={!!pinAction} onClose={() => setPinAction(null)} title={pinAction?.title || ''}>
                <div className="space-y-3">
                    {pinAction?.message && <p className="text-sm text-slate-600 dark:text-slate-300">{pinAction.message}</p>}
                    <PinField value={pin} onChange={setPin} autoFocus />
                    {pinError && <p role="alert" data-testid="payroll-pin-error" className="text-sm font-bold text-red-600">{pinError}</p>}
                    <button onClick={runPinAction} data-testid="payroll-pin-confirm" className="w-full min-h-[44px] py-3 rounded-xl font-black text-white bg-brand cursor-pointer">
                        Confirmar
                    </button>
                </div>
            </Modal>
        );
    }

    // ─── Lista de empleados ──────────────────────────────────────────────────
    return (
        <div className="p-3 sm:p-6 pb-24 lg:pb-6 space-y-5 max-w-6xl mx-auto" data-testid="payroll-panel">
            <div className="flex flex-wrap justify-between items-center gap-3">
                <div>
                    <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
                        <Wallet size={24} className="text-brand" aria-hidden="true" /> Nómina
                    </h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 font-sans tabular-nums" data-testid="payroll-total">
                        Por pagar este periodo: <b className="text-slate-800 dark:text-white">${formatUsd(totalPorPagar)}</b> · Bs {formatBs(mulR(totalPorPagar, rate))}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => setEmployeeModal({ open: true, employee: null })}
                    data-testid="employee-new"
                    className="min-h-[44px] flex items-center gap-1.5 px-4 py-2.5 rounded-xl font-black text-sm text-white bg-brand hover:bg-brand-dark shadow-sm cursor-pointer transition-all active:scale-[0.98]"
                >
                    <Plus size={16} /> Nuevo empleado
                </button>
            </div>

            {/* KPI Strip compacto */}
            {activeRows.length > 0 && (
                <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
                    <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 p-3.5">
                        <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 flex items-center gap-1">
                            <Users size={11} /> Personal activo
                        </span>
                        <p className="text-lg sm:text-xl font-black font-sans tabular-nums text-slate-900 dark:text-white mt-1">
                            {activeRows.length}
                        </p>
                    </div>
                    <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 p-3.5">
                        <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 flex items-center gap-1">
                            <Wallet size={11} /> Pendiente ($)
                        </span>
                        <p className="text-lg sm:text-xl font-black font-sans tabular-nums text-brand mt-1">
                            ${formatUsd(totalPorPagar)}
                        </p>
                    </div>
                    <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 p-3.5">
                        <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 flex items-center gap-1">
                            <CheckCircle2 size={11} /> Pagados
                        </span>
                        <p className="text-lg sm:text-xl font-black font-sans tabular-nums text-emerald-600 dark:text-emerald-400 mt-1">
                            {paidCount}/{activeRows.length}
                        </p>
                    </div>
                </div>
            )}

            {/* Buscador + toggle inactivos */}
            {(rows.length > 3 || employees.some(e => e.activo === false)) && (
                <div className="flex flex-wrap items-center justify-between gap-3">
                    {rows.length > 3 && (
                        <div className="relative flex-1 min-w-[220px] max-w-sm">
                            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                type="text"
                                value={empSearch}
                                onChange={e => setEmpSearch(e.target.value)}
                                placeholder="Buscar empleado por nombre o cargo..."
                                className="w-full min-h-[42px] pl-10 pr-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs sm:text-sm text-slate-800 dark:text-white outline-none focus:ring-2 focus:ring-brand/40"
                            />
                        </div>
                    )}
                    {employees.some(e => e.activo === false) && (
                        <label className="flex items-center gap-2 text-xs font-bold text-slate-500 cursor-pointer">
                            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> Mostrar desactivados
                        </label>
                    )}
                </div>
            )}

            {filteredRows.length === 0 ? (
                <EmptyState icon={Wallet} title="Aún no hay empleados" description="Agrega a tu personal para llevar sus adelantos, consumos con sueldo y pagos, y que cuadren en el cierre de caja." />
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {filteredRows.map(({ employee: e, balance: b }) => {
                        const est = ESTADO[b.estado];
                        const totalBase = Math.max(0.01, b.sueldoPeriodoUsd + b.bonosUsd);
                        const pct = Math.min(100, Math.max(0, Math.round(((totalBase - Math.max(0, b.saldoUsd)) / totalBase) * 100)));
                        return (
                            <button
                                key={e.id}
                                type="button"
                                data-testid="payroll-employee-row"
                                onClick={() => openEmployee(e.id)}
                                className={`w-full text-left rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3 hover:border-brand/50 hover:shadow-md transition-all cursor-pointer ${e.activo === false ? 'opacity-60' : ''}`}
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <span className="w-10 h-10 rounded-xl bg-brand-light dark:bg-brand/20 text-brand font-black text-xs flex items-center justify-center shrink-0">
                                            {getInitials(e.nombre)}
                                        </span>
                                        <div className="min-w-0">
                                            <p className="font-black text-sm sm:text-base text-slate-900 dark:text-white truncate">{e.nombre}</p>
                                            <p className="text-xs text-slate-500 truncate">
                                                {[e.cargo, FRECUENCIA_LABELS[e.frecuencia], periodLabel(b.periodoId)].filter(Boolean).join(' · ')}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <p className="font-sans tabular-nums font-black text-base text-brand">${formatUsd(Math.max(0, b.saldoUsd))}</p>
                                        <span className={`inline-block text-[10px] font-black px-2 py-0.5 rounded-full ${est.cls}`}>{est.label}</span>
                                    </div>
                                </div>
                                <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                                    <div
                                        className={`h-full rounded-full ${b.estado === 'PAGADO' ? 'bg-emerald-500' : 'bg-brand'}`}
                                        style={{ width: `${pct}%` }}
                                    />
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}

            <EmployeeFormModal isOpen={employeeModal.open} employee={employeeModal.employee}
                onClose={() => setEmployeeModal({ open: false, employee: null })} onSave={handleSaveEmployee} />
            {renderPinModal()}
        </div>
    );
}
