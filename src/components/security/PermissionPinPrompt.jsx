/**
 * PermissionPinPrompt.jsx — Modal de autorización puntual (Fase 3).
 *
 * Permite que un cajero ejecute una acción restringida (ej. anular venta o aplicar descuento)
 * sin cerrar su sesión: un Dueño o Encargado autoriza ingresando su PIN O simplemente
 * pasando su Carnet por el lector de código de barras / QR.
 */
import React, { useState, useEffect, useRef } from 'react';
import { ShieldCheck, ScanBarcode, KeyRound, X, AlertCircle, Loader2 } from 'lucide-react';
import { useAuthStore } from '../../hooks/store/useAuthStore';
import { useBarcodeScanner } from '../../hooks/useBarcodeScanner';
import { isBadgeCode, normalizeBadgeScan } from '../../security/badgeToken';

export default function PermissionPinPrompt({
    isOpen,
    onClose,
    onAuthorized,
    requiredPermission,
    actionLabel = 'esta acción',
    description = 'Un Dueño o Encargado puede aprobar con su PIN o pasando su carnet por el lector.',
}) {
    const authorizeAction = useAuthStore((s) => s.authorizeActionWithPinOrBadge);
    const [credential, setCredential] = useState('');
    const [error, setError] = useState('');
    const [checking, setChecking] = useState(false);
    const inputRef = useRef(null);

    useEffect(() => {
        if (isOpen) {
            setCredential('');
            setError('');
            setChecking(false);
            setTimeout(() => inputRef.current?.focus(), 60);
        }
    }, [isOpen]);

    const verifyCredential = async (rawValue) => {
        const value = String(rawValue ?? '').trim();
        if (!value || checking) return;
        setChecking(true);
        setError('');
        try {
            const res = await authorizeAction(value, requiredPermission);
            if (res?.ok) {
                onAuthorized?.(res);
                onClose?.();
            } else {
                setError(res?.error || 'Autorización rechazada');
                setCredential('');
                setTimeout(() => inputRef.current?.focus(), 40);
            }
        } finally {
            setChecking(false);
        }
    };

    // Escáner USB/Bluetooth cuando el foco NO está en el input
    useBarcodeScanner({
        enabled: isOpen && !checking,
        onScan: (code) => {
            if (isBadgeCode(code)) {
                void verifyCredential(code);
            }
        },
    });

    if (!isOpen) return null;

    const handleSubmit = (e) => {
        e.preventDefault();
        void verifyCredential(credential);
    };

    const handleInputChange = (e) => {
        const val = e.target.value;
        setCredential(val);
        if (error) setError('');
        // Si el lector escaneó dentro del campo de texto, autorizar en cuanto complete el patrón PDA-XXXXXXXXXXXX
        if (isBadgeCode(normalizeBadgeScan(val))) {
            void verifyCredential(val);
        }
    };

    return (
        <div
            className="fixed inset-0 z-[260] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm animate-in fade-in duration-150"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Autorización de encargado"
        >
            <div
                className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-2xl p-5 space-y-4 animate-in zoom-in-95 duration-150"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <div className="w-11 h-11 rounded-2xl bg-brand/15 text-brand-dark dark:text-brand flex items-center justify-center shrink-0">
                            <ShieldCheck size={22} />
                        </div>
                        <div>
                            <h3 className="text-base font-black text-slate-800 dark:text-white leading-tight">
                                Autorizar {actionLabel}
                            </h3>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
                                {description}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        aria-label="Cerrar"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Indicador visual de escaneo por carnet */}
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-800/40 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
                    <ScanBarcode size={18} className="shrink-0" />
                    <span>Lector listo: muestra el carnet de barras/QR o escribe el PIN abajo.</span>
                </div>

                <form onSubmit={handleSubmit} className="space-y-3">
                    <div>
                        <label className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 block mb-1.5">
                            PIN de Encargado / Dueño (o código de carnet)
                        </label>
                        <div className="relative">
                            <KeyRound size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                ref={inputRef}
                                type="password"
                                autoComplete="off"
                                value={credential}
                                onChange={handleInputChange}
                                placeholder="Escribe el PIN o escanea..."
                                data-testid="permission-pin-input"
                                disabled={checking}
                                className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 focus:border-brand focus:ring-2 focus:ring-brand/25 outline-none text-sm font-bold tracking-widest text-slate-800 dark:text-white transition-all"
                            />
                        </div>
                    </div>

                    {error && (
                        <div className="flex items-center gap-2 text-xs font-bold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/40 rounded-xl px-3 py-2">
                            <AlertCircle size={15} className="shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}

                    <div className="flex gap-2 pt-1">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold text-xs uppercase tracking-wider hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                        >
                            Cancelar
                        </button>
                        <button
                            type="submit"
                            disabled={checking || !credential.trim()}
                            data-testid="permission-pin-submit"
                            className="flex-1 py-2.5 rounded-xl bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 shadow-md transition-all active:scale-[0.98]"
                        >
                            {checking ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                            Autorizar
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
