/**
 * Panel del dueño / Modo Supervisor (F7 + Edición en vivo).
 * Funciona tanto en PC (Windows) como en navegador móvil (Android / iOS), en red local
 * o conectado vía puente de internet. Compatible con las pruebas de solo lectura de F7.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Cloud, RefreshCw, LogOut, Loader2, Plus, Pencil, PackagePlus,
    Ban, Wallet, DollarSign, Wifi, CheckCircle2, Search, Trash2, X,
} from 'lucide-react';
import { NUBE_BRAND } from './brand';
import { DaySummary } from './NubeScreens';
import { keepChannel } from './realtimeChannel';
import {
    loadDaySummary,
    loadRecentSales,
    loadStock,
    loadCustomers,
    loadDiscrepancies,
    loadSupervisorProducts,
    loadSupervisorCustomers,
    loadCurrentRate,
    saveSupervisorProduct,
    deleteSupervisorProduct,
    adjustSupervisorStock,
    updateSupervisorRate,
    voidSupervisorSale,
    recordSupervisorCustomerPayment,
    resolveSupervisorDiscrepancy,
} from './ownerDashboard';

const BASE_TABS = [
    ['hoy', 'Hoy'],
    ['ventas', 'Ventas'],
    ['productos', 'Productos'],
    ['inventario', 'Inventario'],
    ['clientes', 'Clientes'],
    ['tasa', 'Tasa'],
    ['diferencias', 'Diferencias'],
];

const usd = (n) => `$${(Number(n) || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hora = (iso) => (iso ? new Date(iso).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' }) : '');

function ModalFrame({ title, onClose, children }) {
    return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 p-0 sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
            <div className="w-full sm:max-w-md bg-white dark:bg-slate-900 rounded-t-3xl sm:rounded-3xl p-5 shadow-2xl border border-slate-100 dark:border-slate-800 max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between gap-2 mb-4">
                    <h2 className="text-base font-black text-slate-800 dark:text-white">{title}</h2>
                    <button type="button" onClick={onClose} aria-label="Cerrar" className="p-2 rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                        <X size={18} />
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}

const INPUT = 'w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2.5 text-sm font-semibold text-slate-800 dark:text-white outline-none focus:border-brand';
const BTN_PRIMARY = 'w-full rounded-xl bg-brand hover:bg-brand-dark text-white font-black py-3 text-sm disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer';

const EMPTY_LOADERS = {};

export default function NubeOwnerDashboard({
    client,
    accountName,
    memberName,
    memberRole = null,
    sessionToken = null,
    sedeId = null,
    onLogout,
    loaders = EMPTY_LOADERS,
}) {
    const L = useMemo(() => ({
        loadDaySummary,
        loadRecentSales,
        loadStock,
        loadCustomers,
        loadDiscrepancies,
        loadSupervisorProducts,
        loadSupervisorCustomers,
        loadCurrentRate,
        saveSupervisorProduct,
        deleteSupervisorProduct,
        adjustSupervisorStock,
        updateSupervisorRate,
        voidSupervisorSale,
        recordSupervisorCustomerPayment,
        resolveSupervisorDiscrepancy,
        ...loaders,
    }), [loaders]);

    const canEdit = memberRole ? ['dueno', 'administrador'].includes(memberRole) : true;
    const hasCustomLoaders = Boolean(loaders.loadCustomers);
    const [tab, setTab] = useState('hoy');
    const [data, setData] = useState({});
    const [busy, setBusy] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [liveUp, setLiveUp] = useState(false);
    const [search, setSearch] = useState('');
    const [modal, setModal] = useState(null);
    const [rateDraft, setRateDraft] = useState({ rateMode: 'bcv', customRate: '', copEnabled: false, tasaCop: '' });
    const rateDirtyRef = useRef(false);

    const load = useCallback(async (which, { forceRateReset = false } = {}) => {
        setBusy(true);
        setError(null);
        try {
            const fnMap = {
                hoy: () => L.loadDaySummary(client),
                ventas: () => L.loadRecentSales(client),
                productos: () => L.loadSupervisorProducts(client),
                inventario: () => L.loadStock(client),
                clientes: () => (hasCustomLoaders || typeof client?.rpc !== 'function' ? L.loadCustomers(client) : L.loadSupervisorCustomers(client)),
                tasa: async () => {
                    const r = await L.loadCurrentRate(client);
                    if (forceRateReset || !rateDirtyRef.current) {
                        rateDirtyRef.current = false;
                        setRateDraft({
                            rateMode: r.rateMode || 'bcv',
                            customRate: r.customRate || '',
                            copEnabled: Boolean(r.copEnabled),
                            tasaCop: r.tasaCop || '',
                        });
                    }
                    return r;
                },
                diferencias: () => L.loadDiscrepancies(client),
            };
            const fn = fnMap[which];
            if (fn) {
                const value = await fn();
                setData((d) => ({ ...d, [which]: value }));
            }
        } catch (e) {
            setError(e?.message || 'No se pudieron cargar los datos.');
        } finally {
            setBusy(false);
        }
    }, [L, client, hasCustomLoaders]);

    useEffect(() => {
        load(tab);
    }, [load, tab]);

    const tabRef = useRef(tab);
    const loadRef = useRef(load);
    tabRef.current = tab;
    loadRef.current = load;

    // Actualización en vivo por SSE / Realtime cuando alguna caja registra cambios.
    useEffect(() => {
        if (typeof client?.channel !== 'function') return undefined;
        let timer = null;
        const scheduleReload = (table) => {
            if (tabRef.current === 'tasa' && table !== 'account_sync_state') return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { loadRef.current?.(tabRef.current); }, 250);
        };
        const channelCtrl = keepChannel(
            client,
            'supervisor-dashboard-live',
            (ch) => ch
                .on('postgres_changes', { event: '*', schema: 'public', table: 'account_sync_state' }, () => scheduleReload('account_sync_state'))
                .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_levels' }, () => scheduleReload('stock_levels'))
                .on('postgres_changes', { event: '*', schema: 'public', table: 'customer_balances' }, () => scheduleReload('customer_balances')),
            {
                onUp: () => setLiveUp(true),
                onDown: () => setLiveUp(false),
            },
        );
        return () => {
            if (timer) clearTimeout(timer);
            channelCtrl?.dispose?.();
        };
    }, [client]);

    const runAction = async (fn, successMsg, refreshTabs = [tab]) => {
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            await fn();
            setModal(null);
            if (successMsg) setNotice(successMsg);
            for (const t of refreshTabs) {
                await load(t);
            }
        } catch (e) {
            setError(e?.message || 'No se pudo completar la operación.');
        } finally {
            setSaving(false);
        }
    };

    const current = data[tab];

    const filteredProducts = useMemo(() => {
        if (tab !== 'productos' || !current?.products) return [];
        const q = search.trim().toLowerCase();
        if (!q) return current.products;
        return current.products.filter((p) =>
            p.name.toLowerCase().includes(q) || String(p.barcode || '').toLowerCase().includes(q),
        );
    }, [tab, current, search]);

    const filteredCustomers = useMemo(() => {
        if (tab !== 'clientes' || !Array.isArray(current)) return [];
        const q = search.trim().toLowerCase();
        if (!q) return current;
        return current.filter((c) => c.name.toLowerCase().includes(q));
    }, [tab, current, search]);

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 pb-10">
            <header className="sticky top-0 z-20 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-100 dark:border-slate-800 px-4 py-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-brand text-white flex items-center justify-center shrink-0">
                    <Cloud size={18} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <p className="text-[10px] font-black uppercase tracking-widest text-brand">{NUBE_BRAND.name}</p>
                        {liveUp && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-[10px] font-black px-2 py-0.5" data-testid="supervisor-live-badge">
                                <Wifi size={10} />En vivo
                            </span>
                        )}
                    </div>
                    <p className="text-sm font-black text-slate-800 dark:text-white truncate">{accountName} · {memberName}</p>
                </div>
                <button type="button" aria-label="Actualizar" onClick={() => { rateDirtyRef.current = false; load(tab, { forceRateReset: true }); }} className="p-2.5 rounded-full text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                    {busy ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
                </button>
                <button type="button" aria-label="Salir" onClick={onLogout} className="p-2.5 rounded-full text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                    <LogOut size={18} />
                </button>
            </header>

            <nav className="flex gap-1.5 overflow-x-auto px-3 py-2 bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800">
                {BASE_TABS.map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        onClick={() => { rateDirtyRef.current = false; setTab(id); setSearch(''); setNotice(null); }}
                        data-testid={`owner-tab-${id}`}
                        className={`px-3.5 py-2 rounded-full text-xs font-black whitespace-nowrap min-h-[36px] cursor-pointer ${tab === id ? 'bg-brand text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                    >
                        {label}
                    </button>
                ))}
            </nav>

            <main className="p-4 max-w-4xl mx-auto">
                {error && <p role="alert" className="text-sm font-bold text-red-600 bg-red-50 dark:bg-red-950/30 rounded-xl px-3 py-2 mb-3">{error}</p>}
                {notice && (
                    <p role="status" className="text-sm font-bold text-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl px-3 py-2 mb-3 flex items-center gap-2">
                        <CheckCircle2 size={16} />{notice}
                    </p>
                )}

                {!current && busy && <div className="flex justify-center py-10 text-brand"><Loader2 className="animate-spin" /></div>}

                {tab === 'hoy' && current && (
                    current.length ? <DaySummary rows={current} /> : <Empty text="Todavía no hay cajas registradas." />
                )}

                {tab === 'ventas' && current && (current.length ? (
                    <ul className="divide-y divide-slate-100 dark:divide-slate-800 bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800">
                        {current.map((s) => (
                            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                                <div>
                                    <span className="font-black text-slate-800 dark:text-white">{s.number}{s.offline ? ' · sin internet' : ''}</span>
                                    <span className="block text-slate-400 text-xs">{hora(s.server_at)}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className={`font-bold ${s.status === 'anulada' ? 'line-through text-slate-400' : 'text-slate-700 dark:text-slate-200'}`}>
                                        {usd(s.total_usd)}
                                    </span>
                                    {s.status === 'anulada' ? (
                                        <span className="text-[10px] font-black uppercase bg-slate-100 dark:bg-slate-800 text-slate-500 px-2 py-1 rounded-full">Anulada</span>
                                    ) : canEdit && typeof client?.rpc === 'function' && (
                                        <button
                                            type="button"
                                            data-testid={`supervisor-void-${s.id}`}
                                            onClick={() => setModal({ kind: 'void', sale: s, reason: '' })}
                                            className="px-2.5 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 text-xs font-black flex items-center gap-1 cursor-pointer"
                                        >
                                            <Ban size={13} />Anular
                                        </button>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : <Empty text="Todavía no hay ventas registradas." />)}

                {tab === 'productos' && current && (
                    <div className="space-y-3" data-testid="supervisor-products-panel">
                        <div className="flex flex-col sm:flex-row gap-2">
                            <div className="relative flex-1">
                                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    type="search"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    placeholder="Buscar producto o código de barras…"
                                    className={`${INPUT} pl-9`}
                                    data-testid="supervisor-product-search"
                                />
                            </div>
                            {canEdit && (
                                <button
                                    type="button"
                                    data-testid="supervisor-add-product"
                                    onClick={() => setModal({
                                        kind: 'product',
                                        product: null,
                                        name: '',
                                        priceUsd: '',
                                        costUsd: '',
                                        barcode: '',
                                        initialStock: '',
                                        sedeId: current.sedes?.[0]?.id || sedeId || '',
                                    })}
                                    className="rounded-xl bg-brand hover:bg-brand-dark text-white font-black px-4 py-2.5 text-xs flex items-center justify-center gap-1.5 cursor-pointer shrink-0"
                                >
                                    <Plus size={16} />Nuevo producto
                                </button>
                            )}
                        </div>

                        {filteredProducts.length ? (
                            <ul className="divide-y divide-slate-100 dark:divide-slate-800 bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800">
                                {filteredProducts.map((p) => (
                                    <li key={p.id} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="font-black text-sm text-slate-800 dark:text-white truncate">{p.name}</p>
                                            <p className="text-xs text-slate-500">
                                                Precio: <strong className="text-brand">{usd(p.priceUsd)}</strong>
                                                {p.costUsd > 0 ? ` · Costo: ${usd(p.costUsd)}` : ''}
                                                {' · '}Stock total: <strong className={p.totalStock <= 0 ? 'text-rose-600' : 'text-slate-700 dark:text-slate-200'}>{p.totalStock}</strong>
                                                {current.sedes?.length > 1 && ` (${current.sedes.map((s) => `${s.name}: ${p.stockBySedeId[s.id] ?? 0}`).join(', ')})`}
                                            </p>
                                        </div>
                                        {canEdit && (
                                            <div className="flex flex-wrap gap-1.5 shrink-0">
                                                <button
                                                    type="button"
                                                    data-testid={`supervisor-stock-${p.id}`}
                                                    onClick={() => setModal({
                                                        kind: 'stock',
                                                        product: p,
                                                        reason: 'COMPRA',
                                                        qty: '',
                                                        note: '',
                                                        sedeId: current.sedes?.[0]?.id || sedeId || '',
                                                    })}
                                                    className="px-2.5 py-2 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs font-black flex items-center gap-1 cursor-pointer"
                                                >
                                                    <PackagePlus size={14} />Stock
                                                </button>
                                                <button
                                                    type="button"
                                                    data-testid={`supervisor-edit-${p.id}`}
                                                    onClick={() => setModal({
                                                        kind: 'product',
                                                        product: p,
                                                        name: p.name,
                                                        priceUsd: String(p.priceUsd),
                                                        costUsd: p.costUsd ? String(p.costUsd) : '',
                                                        barcode: p.barcode || '',
                                                        initialStock: '',
                                                        sedeId: current.sedes?.[0]?.id || sedeId || '',
                                                    })}
                                                    className="px-2.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-black flex items-center gap-1 cursor-pointer"
                                                >
                                                    <Pencil size={14} />Editar
                                                </button>
                                                <button
                                                    type="button"
                                                    aria-label={`Eliminar ${p.name}`}
                                                    data-testid={`supervisor-delete-${p.id}`}
                                                    onClick={() => setModal({ kind: 'deleteProduct', product: p })}
                                                    className="p-2 rounded-xl text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        ) : <Empty text="No hay productos cargados todavía." />}
                    </div>
                )}

                {tab === 'inventario' && current && (current.products.length ? (
                    <div className="overflow-x-auto bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800">
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="text-slate-400 text-left">
                                    <th className="p-2.5">Producto</th>
                                    {current.sedes.map((s) => <th key={s} className="text-right p-2.5">{s}</th>)}
                                    <th className="text-right p-2.5">Total</th>
                                </tr>
                            </thead>
                            <tbody>
                                {current.products.map((p) => (
                                    <tr key={p.productId} className="border-t border-slate-100 dark:border-slate-800">
                                        <td className="p-2.5 font-bold text-slate-700 dark:text-slate-200">{p.name}</td>
                                        {current.sedes.map((s) => <td key={s} className={`text-right p-2.5 ${p.sedes[s] < 0 ? 'text-red-600 font-black' : ''}`}>{p.sedes[s] ?? 0}</td>)}
                                        <td className="text-right p-2.5 font-black">{p.total}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : <Empty text="Todavía no hay stock cargado. Importa tu respaldo o haz un conteo." />)}

                {tab === 'clientes' && current && (
                    <div className="space-y-3">
                        {!hasCustomLoaders && (
                            <div className="relative">
                                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    type="search"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    placeholder="Buscar cliente…"
                                    className={`${INPUT} pl-9`}
                                />
                            </div>
                        )}
                        {filteredCustomers.length ? (
                            <ul className="divide-y divide-slate-100 dark:divide-slate-800 bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800">
                                {filteredCustomers.map((c) => (
                                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                                        <div>
                                            <span className="font-bold text-slate-700 dark:text-slate-200">{c.name}</span>
                                            {c.phone && <span className="block text-xs text-slate-400">{c.phone}</span>}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className={`font-black ${c.balance < 0 ? 'text-red-600' : c.balance > 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                                                {c.balance < 0 ? `Debe ${usd(-c.balance)}` : c.balance > 0 ? `A favor ${usd(c.balance)}` : 'Sin saldo'}
                                            </span>
                                            {canEdit && typeof client?.rpc === 'function' && (
                                                <button
                                                    type="button"
                                                    data-testid={`supervisor-abono-${c.id}`}
                                                    onClick={() => setModal({
                                                        kind: 'abono',
                                                        customer: c,
                                                        amountUsd: c.balance < 0 ? String(-c.balance) : '',
                                                        note: '',
                                                    })}
                                                    className="px-2.5 py-1.5 rounded-xl bg-brand/10 hover:bg-brand/20 text-brand text-xs font-black flex items-center gap-1 cursor-pointer"
                                                >
                                                    <Wallet size={13} />Abono
                                                </button>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        ) : <Empty text="Ningún cliente debe ni tiene saldo a favor." />}
                    </div>
                )}

                {tab === 'tasa' && current && (
                    <form
                        data-testid="supervisor-rate-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            runAction(async () => {
                                await L.updateSupervisorRate(client, sessionToken, rateDraft);
                                rateDirtyRef.current = false;
                            }, 'Tasa actualizada en todas las cajas.');
                        }}
                        className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5 space-y-4 max-w-md"
                    >
                        <div className="flex items-center gap-2">
                            <DollarSign size={18} className="text-brand" />
                            <h2 className="text-sm font-black text-slate-800 dark:text-white">Tasa compartida del negocio</h2>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            {[
                                ['bcv', 'BCV Dólar'],
                                ['euro', 'BCV Euro'],
                                ['usdt', 'USDT / Paralela'],
                                ['manual', 'Tasa Manual'],
                            ].map(([mode, label]) => (
                                <button
                                    key={mode}
                                    type="button"
                                    data-testid={`supervisor-rate-mode-${mode}`}
                                    onClick={() => { rateDirtyRef.current = true; setRateDraft((d) => ({ ...d, rateMode: mode })); }}
                                    className={`rounded-xl border-2 px-3 py-2.5 text-xs font-black text-left cursor-pointer ${rateDraft.rateMode === mode ? 'border-brand bg-brand-light text-brand' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        {rateDraft.rateMode === 'manual' && (
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1">Valor en Bs por $1</label>
                                <input
                                    type="number"
                                    step="any"
                                    min="0.01"
                                    required
                                    data-testid="supervisor-custom-rate"
                                    value={rateDraft.customRate}
                                    onChange={(e) => { rateDirtyRef.current = true; setRateDraft((d) => ({ ...d, customRate: e.target.value })); }}
                                    placeholder="Ej. 95.50"
                                    className={INPUT}
                                />
                            </div>
                        )}
                        <div className="pt-1">
                            <label className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-300 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={rateDraft.copEnabled}
                                    onChange={(e) => { rateDirtyRef.current = true; setRateDraft((d) => ({ ...d, copEnabled: e.target.checked })); }}
                                />
                                Habilitar Peso Colombiano (COP)
                            </label>
                            {rateDraft.copEnabled && (
                                <input
                                    type="number"
                                    step="any"
                                    min="1"
                                    value={rateDraft.tasaCop}
                                    onChange={(e) => { rateDirtyRef.current = true; setRateDraft((d) => ({ ...d, tasaCop: e.target.value })); }}
                                    placeholder="COP por $1 (ej. 4100)"
                                    className={`${INPUT} mt-2`}
                                />
                            )}
                        </div>
                        {canEdit && (
                            <button type="submit" disabled={saving} data-testid="supervisor-rate-save" className={BTN_PRIMARY}>
                                {saving && <Loader2 size={16} className="animate-spin" />}
                                Guardar tasa en todas las cajas
                            </button>
                        )}
                    </form>
                )}

                {tab === 'diferencias' && current && (current.length ? (
                    <ul className="space-y-2">
                        {current.map((d) => (
                            <li key={d.id} className="bg-white dark:bg-slate-900 rounded-2xl px-4 py-3 text-sm flex items-center justify-between gap-3 border border-slate-100 dark:border-slate-800">
                                <div>
                                    <p className="font-black text-slate-800 dark:text-white">{d.name}</p>
                                    <p className="text-xs text-slate-500">Se vendieron {Number(d.sold_qty)} sin internet cuando había {Number(d.expected_qty)} · {hora(d.created_at)}</p>
                                </div>
                                {canEdit && typeof client?.rpc === 'function' && (
                                    <button
                                        type="button"
                                        data-testid={`supervisor-resolve-${d.id}`}
                                        onClick={() => setModal({ kind: 'discrepancy', discrepancy: d, note: '' })}
                                        className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-black shrink-0 cursor-pointer"
                                    >
                                        Resolver
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                ) : <Empty text="No hay diferencias pendientes. Todo cuadra." />)}
            </main>

            {modal?.kind === 'product' && (
                <ModalFrame title={modal.product ? `Editar «${modal.product.name}»` : 'Nuevo producto'} onClose={() => setModal(null)}>
                    <form
                        data-testid="supervisor-product-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            runAction(
                                () => L.saveSupervisorProduct(client, sessionToken, {
                                    id: modal.product?.id || null,
                                    name: modal.name,
                                    priceUsd: modal.priceUsd,
                                    costUsd: modal.costUsd,
                                    barcode: modal.barcode,
                                    initialStock: modal.product ? 0 : modal.initialStock,
                                    sedeId: modal.sedeId || sedeId || null,
                                }),
                                modal.product ? 'Producto actualizado.' : 'Producto creado.',
                                ['productos'],
                            );
                        }}
                        className="space-y-3"
                    >
                        <input
                            required
                            placeholder="Nombre del producto"
                            value={modal.name}
                            onChange={(e) => setModal((m) => ({ ...m, name: e.target.value }))}
                            className={INPUT}
                            data-testid="supervisor-prod-name"
                        />
                        <div className="grid grid-cols-2 gap-2">
                            <input
                                required
                                type="number"
                                step="any"
                                min="0"
                                placeholder="Precio USD ($)"
                                value={modal.priceUsd}
                                onChange={(e) => setModal((m) => ({ ...m, priceUsd: e.target.value }))}
                                className={INPUT}
                                data-testid="supervisor-prod-price"
                            />
                            <input
                                type="number"
                                step="any"
                                min="0"
                                placeholder="Costo USD ($)"
                                value={modal.costUsd}
                                onChange={(e) => setModal((m) => ({ ...m, costUsd: e.target.value }))}
                                className={INPUT}
                                data-testid="supervisor-prod-cost"
                            />
                        </div>
                        <input
                            placeholder="Código de barras (opcional)"
                            value={modal.barcode}
                            onChange={(e) => setModal((m) => ({ ...m, barcode: e.target.value }))}
                            className={INPUT}
                        />
                        {!modal.product && (
                            <div className="grid grid-cols-2 gap-2">
                                <input
                                    type="number"
                                    step="any"
                                    min="0"
                                    placeholder="Stock inicial (opcional)"
                                    value={modal.initialStock}
                                    onChange={(e) => setModal((m) => ({ ...m, initialStock: e.target.value }))}
                                    className={INPUT}
                                    data-testid="supervisor-prod-stock"
                                />
                                {data.productos?.sedes?.length > 1 && (
                                    <select
                                        value={modal.sedeId}
                                        onChange={(e) => setModal((m) => ({ ...m, sedeId: e.target.value }))}
                                        className={INPUT}
                                    >
                                        {data.productos.sedes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                )}
                            </div>
                        )}
                        <button type="submit" disabled={saving} data-testid="supervisor-prod-save" className={BTN_PRIMARY}>
                            {saving && <Loader2 size={16} className="animate-spin" />}
                            {modal.product ? 'Guardar cambios' : 'Crear producto'}
                        </button>
                    </form>
                </ModalFrame>
            )}

            {modal?.kind === 'stock' && (
                <ModalFrame title={`Mover stock · ${modal.product.name}`} onClose={() => setModal(null)}>
                    <form
                        data-testid="supervisor-stock-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            runAction(
                                () => L.adjustSupervisorStock(client, sessionToken, {
                                    productId: modal.product.id,
                                    reason: modal.reason,
                                    qty: modal.qty,
                                    note: modal.note,
                                    sedeId: modal.sedeId || sedeId || null,
                                }),
                                'Inventario actualizado.',
                                ['productos'],
                            );
                        }}
                        className="space-y-3"
                    >
                        <select
                            value={modal.reason}
                            onChange={(e) => setModal((m) => ({ ...m, reason: e.target.value }))}
                            className={INPUT}
                            data-testid="supervisor-stock-reason"
                        >
                            <option value="COMPRA">Compra (sumar entrada)</option>
                            <option value="AJUSTE">Ajuste manual (+ o -)</option>
                            <option value="CONTEO">Conteo físico (cantidad real)</option>
                        </select>
                        {data.productos?.sedes?.length > 1 && (
                            <select
                                value={modal.sedeId}
                                onChange={(e) => setModal((m) => ({ ...m, sedeId: e.target.value }))}
                                className={INPUT}
                                data-testid="supervisor-stock-sede"
                            >
                                {data.productos.sedes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                        )}
                        <input
                            required
                            type="number"
                            step="any"
                            placeholder={modal.reason === 'AJUSTE' ? 'Cantidad (+ suma, - resta)' : 'Cantidad'}
                            value={modal.qty}
                            onChange={(e) => setModal((m) => ({ ...m, qty: e.target.value }))}
                            className={INPUT}
                            data-testid="supervisor-stock-qty"
                        />
                        <input
                            placeholder="Nota (ej. Factura proveedor)"
                            value={modal.note}
                            onChange={(e) => setModal((m) => ({ ...m, note: e.target.value }))}
                            className={INPUT}
                        />
                        <button type="submit" disabled={saving} data-testid="supervisor-stock-save" className={BTN_PRIMARY}>
                            {saving && <Loader2 size={16} className="animate-spin" />}
                            Aplicar movimiento
                        </button>
                    </form>
                </ModalFrame>
            )}

            {modal?.kind === 'deleteProduct' && (
                <ModalFrame title={`¿Eliminar «${modal.product.name}»?`} onClose={() => setModal(null)}>
                    <p className="text-xs text-slate-500 mb-4">Desaparecerá del catálogo en todas las cajas. Su historial de ventas y stock queda guardado.</p>
                    <button
                        type="button"
                        disabled={saving}
                        data-testid="supervisor-delete-confirm"
                        onClick={() => runAction(() => L.deleteSupervisorProduct(client, sessionToken, modal.product), 'Producto eliminado.', ['productos'])}
                        className="w-full rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-black py-3 text-sm cursor-pointer"
                    >
                        Eliminar producto
                    </button>
                </ModalFrame>
            )}

            {modal?.kind === 'void' && (
                <ModalFrame title={`Anular venta ${modal.sale.number}`} onClose={() => setModal(null)}>
                    <form
                        data-testid="supervisor-void-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            runAction(() => L.voidSupervisorSale(client, sessionToken, {
                                saleId: modal.sale.id,
                                reason: modal.reason,
                            }), `Venta ${modal.sale.number} anulada y stock devuelto.`, ['ventas']);
                        }}
                        className="space-y-3"
                    >
                        <p className="text-xs text-slate-500">Se devolverá el inventario a su sede y la venta quedará marcada como anulada ({usd(modal.sale.total_usd)}).</p>
                        <input
                            required
                            placeholder="Motivo de la anulación"
                            value={modal.reason}
                            onChange={(e) => setModal((m) => ({ ...m, reason: e.target.value }))}
                            className={INPUT}
                            data-testid="supervisor-void-reason"
                        />
                        <button type="submit" disabled={saving} data-testid="supervisor-void-confirm" className="w-full rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-black py-3 text-sm cursor-pointer">
                            Confirmar anulación
                        </button>
                    </form>
                </ModalFrame>
            )}

            {modal?.kind === 'abono' && (
                <ModalFrame title={`Registrar abono · ${modal.customer.name}`} onClose={() => setModal(null)}>
                    <form
                        data-testid="supervisor-abono-form"
                        onSubmit={(e) => {
                            e.preventDefault();
                            runAction(() => L.recordSupervisorCustomerPayment(client, sessionToken, {
                                customerId: modal.customer.id,
                                amountUsd: modal.amountUsd,
                                note: modal.note,
                            }), 'Abono registrado.', ['clientes']);
                        }}
                        className="space-y-3"
                    >
                        <input
                            required
                            type="number"
                            step="any"
                            min="0.01"
                            placeholder="Monto del abono ($ USD)"
                            value={modal.amountUsd}
                            onChange={(e) => setModal((m) => ({ ...m, amountUsd: e.target.value }))}
                            className={INPUT}
                            data-testid="supervisor-abono-amount"
                        />
                        <input
                            placeholder="Nota (ej. Pago Móvil recibido)"
                            value={modal.note}
                            onChange={(e) => setModal((m) => ({ ...m, note: e.target.value }))}
                            className={INPUT}
                        />
                        <button type="submit" disabled={saving} data-testid="supervisor-abono-save" className={BTN_PRIMARY}>
                            {saving && <Loader2 size={16} className="animate-spin" />}
                            Registrar abono
                        </button>
                    </form>
                </ModalFrame>
            )}

            {modal?.kind === 'discrepancy' && (
                <ModalFrame title={`Resolver diferencia · ${modal.discrepancy.name}`} onClose={() => setModal(null)}>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            runAction(() => L.resolveSupervisorDiscrepancy(client, sessionToken, {
                                discrepancyId: modal.discrepancy.id,
                                note: modal.note,
                            }), 'Diferencia marcada como resuelta.', ['diferencias']);
                        }}
                        className="space-y-3"
                    >
                        <input
                            required
                            placeholder="Nota de cierre (ej. Conteo verificado)"
                            value={modal.note}
                            onChange={(e) => setModal((m) => ({ ...m, note: e.target.value }))}
                            className={INPUT}
                        />
                        <button type="submit" disabled={saving} className={BTN_PRIMARY}>
                            Marcar como resuelta
                        </button>
                    </form>
                </ModalFrame>
            )}
        </div>
    );
}

function Empty({ text }) {
    return <p className="text-sm text-slate-500 text-center py-10">{text}</p>;
}
