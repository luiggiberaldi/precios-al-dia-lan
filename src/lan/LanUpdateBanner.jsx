import { useEffect, useState } from 'react';
import {
    CheckCircle2,
    Clock,
    Download,
    Loader2,
    RefreshCw,
    Rocket,
    ShieldCheck,
    WifiOff,
    X,
} from 'lucide-react';
import { getElectronUpdaterApi, LAN_MANUAL_UPDATE_EVENT } from './lanConfig';

function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (!n) return '';
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.round(n / 1024)} KB`;
}

function formatCheckedAt(iso) {
    if (!iso) return 'Al iniciar el programa';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Recién comprobado';
    return d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
}

export default function LanUpdateBanner() {
    const updater = getElectronUpdaterApi();
    const [state, setState] = useState(null);
    const [manualModalOpen, setManualModalOpen] = useState(false);
    const [laterMinimized, setLaterMinimized] = useState(false);
    const [progressMinimized, setProgressMinimized] = useState(false);
    const [installing, setInstalling] = useState(false);

    useEffect(() => {
        if (!updater) return undefined;
        let mounted = true;
        updater.getState?.().then((initial) => {
            if (mounted && initial) setState(initial);
        }).catch(() => {});

        const unsub = updater.onStateChange?.((next) => {
            if (!mounted || !next) return;
            setState(next);
            if (next.status === 'downloaded') {
                setLaterMinimized(false);
                setManualModalOpen(false);
            } else if (next.status === 'available' || next.status === 'downloading') {
                setProgressMinimized(false);
            }
        });

        const onManual = () => {
            setLaterMinimized(false);
            setProgressMinimized(false);
            setManualModalOpen(true);
        };
        window.addEventListener(LAN_MANUAL_UPDATE_EVENT, onManual);

        return () => {
            mounted = false;
            unsub?.();
            window.removeEventListener(LAN_MANUAL_UPDATE_EVENT, onManual);
        };
    }, [updater]);

    if (!updater || !state) return null;

    const currentVersion = state.currentVersion || import.meta.env.VITE_APP_VERSION || '1.0.0';

    // 1. Interfaz modal principal cuando hay una actualización descargada y lista para instalar
    if (state.status === 'downloaded' && !laterMinimized) {
        const notesLines = String(state.releaseNotes || '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);

        return (
            <div
                className="fixed inset-0 z-[390] flex items-center justify-center p-4"
                data-testid="lan-update-ready-modal"
            >
                <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" />
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Nueva actualización lista"
                    className="relative w-full max-w-md bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 fade-in duration-150"
                >
                    <div className="px-6 py-5 bg-gradient-to-br from-[#2b59c3] to-[#4f86f7] text-white flex items-start gap-3.5">
                        <div className="p-2.5 rounded-2xl bg-white/15 shrink-0">
                            <Rocket size={22} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/20 text-[10px] font-black uppercase tracking-wider">
                                Nueva versión v{state.availableVersion || 'lista'}
                            </span>
                            <h3 className="text-lg font-black tracking-tight mt-1">
                                Actualización lista para instalar
                            </h3>
                            <p className="text-xs text-white/85 mt-0.5">
                                Tienes v{currentVersion} · Ya descargamos la v{state.availableVersion || 'nueva'} completa.
                            </p>
                        </div>
                    </div>

                    <div className="p-6 space-y-4">
                        <div className="rounded-2xl bg-slate-50 dark:bg-slate-800/70 border border-slate-100 dark:border-slate-800 p-3.5 space-y-1.5">
                            <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                                Qué incluye esta versión
                            </p>
                            {notesLines.length > 0 ? (
                                <ul className="text-xs text-slate-600 dark:text-slate-300 space-y-1 max-h-36 overflow-y-auto leading-relaxed">
                                    {notesLines.map((line, idx) => (
                                        <li key={idx}>{line}</li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                                    Mejoras de estabilidad, interfaz más clara y sincronización optimizada para todas tus cajas en red local.
                                </p>
                            )}
                        </div>

                        <p className="text-[11px] text-slate-500 dark:text-slate-400 flex items-start gap-1.5 leading-snug">
                            <ShieldCheck size={14} className="text-emerald-600 shrink-0 mt-0.5" />
                            <span>
                                Al instalar ahora se reiniciará la app un momento. Tus ventas, inventario y clientes no se pierden; si prefieres, puedes seguir cobrando y aplicarla más tarde o al cerrar el programa.
                            </span>
                        </p>

                        <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
                            <button
                                type="button"
                                disabled={installing}
                                data-testid="lan-update-install-btn"
                                onClick={async () => {
                                    setInstalling(true);
                                    try {
                                        await updater.installNow?.();
                                    } finally {
                                        setInstalling(false);
                                    }
                                }}
                                className="flex-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-xs font-black py-3 px-4 flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20"
                            >
                                {installing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                                Instalar ahorita (reiniciar)
                            </button>
                            <button
                                type="button"
                                disabled={installing}
                                data-testid="lan-update-later-btn"
                                onClick={() => setLaterMinimized(true)}
                                className="rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-200 text-xs font-bold py-3 px-4 flex items-center justify-center gap-1.5"
                            >
                                <Clock size={14} /> Más tarde
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // 2. Píldora discreta si eligió "Más tarde"
    if (state.status === 'downloaded' && laterMinimized) {
        return (
            <div
                role="status"
                data-testid="lan-update-ready-pill"
                className="fixed bottom-4 right-4 z-[340] rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-white dark:bg-slate-900 shadow-2xl px-3.5 py-2.5 flex items-center gap-3"
            >
                <Download size={16} className="text-emerald-600 shrink-0" />
                <div className="text-xs">
                    <p className="font-black text-slate-800 dark:text-white">v{state.availableVersion} lista</p>
                    <p className="text-[10px] text-slate-400">Se instalará al cerrar o cuando elijas</p>
                </div>
                <button
                    type="button"
                    data-testid="lan-update-pill-open-btn"
                    onClick={() => setLaterMinimized(false)}
                    className="rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-black px-3 py-1.5 cursor-pointer"
                >
                    Instalar / Ver
                </button>
            </div>
        );
    }

    // 3. Tarjeta de progreso mientras descarga una actualización entrante
    if ((state.status === 'downloading' || state.status === 'available') && !progressMinimized) {
        const pct = Math.max(0, Math.min(100, Number(state.progressPercent || 0)));
        const speedText = state.bytesPerSecond > 0 ? `${formatBytes(state.bytesPerSecond)}/s` : '';
        const transferredText = state.totalBytes > 0
            ? `${formatBytes(state.transferredBytes)} / ${formatBytes(state.totalBytes)}`
            : '';

        return (
            <div
                role="status"
                data-testid="lan-update-progress-banner"
                className="fixed bottom-4 right-4 z-[340] w-80 rounded-2xl border border-brand/25 bg-white dark:bg-slate-900 shadow-2xl p-3.5 space-y-2"
            >
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                        <Loader2 size={16} className="animate-spin text-brand shrink-0" />
                        <div className="min-w-0">
                            <p className="text-xs font-black text-slate-800 dark:text-white truncate">
                                Descargando v{state.availableVersion || 'nueva'}
                            </p>
                            <p className="text-[10px] text-slate-400">
                                {transferredText || 'En segundo plano, puedes seguir cobrando'}
                                {speedText ? ` · ${speedText}` : ''}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        aria-label="Minimizar descarga"
                        onClick={() => setProgressMinimized(true)}
                        className="p-1 text-slate-400 hover:text-slate-600"
                    >
                        <X size={14} />
                    </button>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                        className="h-full rounded-full bg-brand transition-all duration-300"
                        style={{ width: `${pct}%` }}
                    />
                </div>
                <p className="text-right text-[10px] font-black text-brand tabular-nums">{pct}%</p>
            </div>
        );
    }

    // 4. Centro manual al tocar "Buscar actualización"
    if (!manualModalOpen) return null;

    const isChecking = state.status === 'checking';
    const isOk = state.status === 'up-to-date';
    const isOffline = state.status === 'offline';

    return (
        <div
            className="fixed inset-0 z-[390] flex items-center justify-center p-4"
            data-testid="lan-update-center-modal"
        >
            <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setManualModalOpen(false)} />
            <div
                role="dialog"
                aria-modal="true"
                aria-label="Centro de actualizaciones"
                className="relative w-full max-w-sm bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl border border-slate-100 dark:border-slate-800 p-5 space-y-4 animate-in zoom-in-95 fade-in duration-150"
            >
                <div className="flex items-start justify-between gap-2">
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-brand">Precios al Día LAN</p>
                        <h3 className="text-base font-black text-slate-800 dark:text-white">
                            Actualizaciones del sistema
                        </h3>
                        <p className="text-xs text-slate-400 mt-0.5 font-mono">
                            Versión instalada: v{currentVersion}
                        </p>
                    </div>
                    <button
                        type="button"
                        aria-label="Cerrar centro de actualizaciones"
                        onClick={() => setManualModalOpen(false)}
                        className="p-1.5 rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-3.5 flex items-start gap-2.5 text-xs">
                    {isChecking && <Loader2 size={17} className="animate-spin text-brand shrink-0 mt-0.5" />}
                    {isOk && <CheckCircle2 size={17} className="text-emerald-600 shrink-0 mt-0.5" />}
                    {isOffline && <WifiOff size={17} className="text-amber-600 shrink-0 mt-0.5" />}
                    {!isChecking && !isOk && !isOffline && <RefreshCw size={17} className="text-amber-600 shrink-0 mt-0.5" />}
                    <div className="flex-1 min-w-0">
                        <p className="font-bold text-slate-700 dark:text-slate-100 leading-snug">
                            {isChecking
                                ? 'Buscando nueva versión en GitHub…'
                                : isOk
                                    ? `Ya tienes la última versión disponible (v${currentVersion}).`
                                    : (state.error || 'Listo para comprobar actualizaciones.')}
                        </p>
                        <p className="text-[10px] text-slate-400 mt-1">
                            Última revisión: {formatCheckedAt(state.lastCheckedAt)}
                        </p>
                    </div>
                </div>

                <div className="flex gap-2">
                    <button
                        type="button"
                        disabled={isChecking}
                        data-testid="lan-update-recheck-btn"
                        onClick={() => updater.checkNow?.()}
                        className="flex-1 rounded-xl bg-brand hover:bg-brand-dark disabled:opacity-60 text-white text-xs font-black py-2.5 px-3 flex items-center justify-center gap-1.5"
                    >
                        <RefreshCw size={14} className={isChecking ? 'animate-spin' : ''} />
                        {isChecking ? 'Buscando…' : 'Buscar de nuevo'}
                    </button>
                    <button
                        type="button"
                        onClick={() => setManualModalOpen(false)}
                        className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2.5 text-xs font-bold text-slate-600 dark:text-slate-300"
                    >
                        Cerrar
                    </button>
                </div>
            </div>
        </div>
    );
}
