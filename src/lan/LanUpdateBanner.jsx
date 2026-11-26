import { useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2, RefreshCw, WifiOff, X } from 'lucide-react';
import { getElectronUpdaterApi, LAN_MANUAL_UPDATE_EVENT } from './lanConfig';

export default function LanUpdateBanner() {
    const updater = getElectronUpdaterApi();
    const [state, setState] = useState(null);
    const [manualVisible, setManualVisible] = useState(false);
    const [dismissedReady, setDismissedReady] = useState(false);
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
            if (next.status === 'downloaded') setDismissedReady(false);
        });

        const onManual = () => {
            setDismissedReady(false);
            setManualVisible(true);
        };
        window.addEventListener(LAN_MANUAL_UPDATE_EVENT, onManual);

        return () => {
            mounted = false;
            unsub?.();
            window.removeEventListener(LAN_MANUAL_UPDATE_EVENT, onManual);
        };
    }, [updater]);

    useEffect(() => {
        if (!manualVisible) return undefined;
        if (state?.status !== 'up-to-date') return undefined;
        const timer = setTimeout(() => setManualVisible(false), 6000);
        return () => clearTimeout(timer);
    }, [manualVisible, state?.status]);

    if (!updater || !state) return null;

    if (state.status === 'downloaded' && !dismissedReady) {
        return (
            <div
                role="status"
                data-testid="lan-update-ready-banner"
                className="fixed bottom-4 right-4 z-[280] max-w-sm rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-white dark:bg-slate-900 shadow-2xl p-3.5 flex items-start gap-3"
            >
                <div className="p-2 rounded-xl bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 shrink-0">
                    <Download size={18} />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-xs font-black text-slate-800 dark:text-white">
                        Nueva versión v{state.availableVersion || 'lista'} disponible
                    </p>
                    <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                        Ya se descargó en segundo plano. Puedes instalarla ahora o al cerrar el programa.
                    </p>
                    <div className="flex items-center gap-2 mt-2.5">
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
                            className="rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-xs font-black px-3 py-1.5 flex items-center gap-1.5"
                        >
                            {installing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                            Instalar y reiniciar
                        </button>
                        <button
                            type="button"
                            onClick={() => setDismissedReady(true)}
                            className="rounded-xl px-2.5 py-1.5 text-xs font-bold text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
                        >
                            Más tarde
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (state.status === 'downloading' || state.status === 'available') {
        return (
            <div
                role="status"
                data-testid="lan-update-progress-banner"
                className="fixed bottom-4 right-4 z-[280] rounded-2xl border border-brand/25 bg-white dark:bg-slate-900 shadow-xl px-3.5 py-2.5 flex items-center gap-2.5 text-xs font-bold text-slate-700 dark:text-slate-100"
            >
                <Loader2 size={15} className="animate-spin text-brand shrink-0" />
                <span>
                    Descargando v{state.availableVersion || 'nueva'} ({Number(state.progressPercent || 0)}%)…
                </span>
            </div>
        );
    }

    if (!manualVisible) return null;

    const isOk = state.status === 'up-to-date';
    const isOffline = state.status === 'offline';
    const isChecking = state.status === 'checking';

    let message = state.error || '';
    if (isChecking) message = 'Buscando actualizaciones en GitHub…';
    else if (isOk) message = `Ya tienes la última versión (v${state.currentVersion}).`;

    if (!message) return null;

    return (
        <div
            role="status"
            data-testid="lan-update-status-banner"
            className="fixed bottom-4 right-4 z-[280] max-w-sm rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl px-3.5 py-2.5 flex items-center gap-2.5 text-xs font-bold text-slate-700 dark:text-slate-100"
        >
            {isChecking && <Loader2 size={15} className="animate-spin text-brand shrink-0" />}
            {isOk && <CheckCircle2 size={15} className="text-emerald-600 shrink-0" />}
            {isOffline && <WifiOff size={15} className="text-amber-600 shrink-0" />}
            {!isChecking && !isOk && !isOffline && <RefreshCw size={15} className="text-amber-600 shrink-0" />}
            <span className="flex-1 min-w-0 leading-snug">{message}</span>
            <button
                type="button"
                aria-label="Cerrar aviso de actualización"
                onClick={() => setManualVisible(false)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
                <X size={14} />
            </button>
        </div>
    );
}
