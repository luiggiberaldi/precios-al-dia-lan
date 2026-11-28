/**
 * EmployeeBadgeModal.jsx — Carnet imprimible de empleado con QR + Código de Barras 1D (Code 39).
 *
 * Permite al Dueño generar, imprimir/descargar o revocar un carnet físico para que el
 * empleado (Dueño, Encargado, Inventario o Cajero) pueda iniciar sesión o autorizar acciones
 * simplemente mostrando su carnet al lector de barras o QR.
 */
import React, { useState, useEffect, useMemo } from 'react';
import QRCode from 'qrcode';
import { X, Printer, RefreshCw, ShieldOff, BadgeCheck, AlertTriangle } from 'lucide-react';
import { encodeCode39Bars } from '../../security/badgeToken';
import { getRoleLabel } from '../../security/permissions';

export default function EmployeeBadgeModal({
    isOpen,
    user,
    badgeCode,
    onClose,
    onGenerate,
    onRevoke,
}) {
    const [qrDataUrl, setQrDataUrl] = useState('');
    const [busy, setBusy] = useState(false);

    const businessName = useMemo(() => {
        try { return localStorage.getItem('business_name') || 'Precios al Día'; } catch { return 'Precios al Día'; }
    }, []);

    useEffect(() => {
        let cancelled = false;
        if (!badgeCode) {
            setQrDataUrl('');
            return undefined;
        }
        QRCode.toDataURL(badgeCode, {
            width: 220,
            margin: 1,
            color: { dark: '#0f172a', light: '#ffffff' },
        })
            .then((url) => { if (!cancelled) setQrDataUrl(url); })
            .catch(() => { if (!cancelled) setQrDataUrl(''); });
        return () => { cancelled = true; };
    }, [badgeCode]);

    const code39 = useMemo(() => (badgeCode ? encodeCode39Bars(badgeCode) : null), [badgeCode]);

    if (!isOpen || !user) return null;

    const hasExistingBadge = Boolean(user.badgeHash || badgeCode);

    const handleGenerate = async () => {
        setBusy(true);
        try { await onGenerate?.(user.id); } finally { setBusy(false); }
    };

    const handleRevoke = () => {
        onRevoke?.(user.id);
    };

    const handlePrint = () => {
        if (!badgeCode || !code39) return;
        const barsSvg = code39.bars
            .map((b) => `<rect x="${b.x}" y="0" width="${b.w}" height="52" fill="#0f172a" />`)
            .join('');
        const win = window.open('', '_blank', 'width=420,height=620');
        if (!win) return;
        win.document.write(`<!doctype html>
<html lang="es"><head><meta charset="utf-8" /><title>Carnet - ${user.nombre}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; padding: 24px; background: #f8fafc; }
  .card { width: 300px; background: #fff; border: 2px solid #0f172a; border-radius: 18px; padding: 20px; text-align: center; box-sizing: border-box; }
  .biz { font-size: 11px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: #01696f; margin-bottom: 4px; }
  .name { font-size: 20px; font-weight: 900; color: #0f172a; margin: 4px 0 2px; }
  .role { display: inline-block; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; background: #e6f4f1; color: #01696f; padding: 3px 10px; border-radius: 999px; margin-bottom: 14px; }
  .qr { width: 150px; height: 150px; margin: 0 auto 12px; display: block; }
  .barcode { width: 100%; height: 52px; margin: 8px 0 4px; }
  .code { font-family: monospace; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; color: #475569; }
  .foot { font-size: 10px; color: #64748b; margin-top: 10px; }
  @media print { body { background: #fff; padding: 0; } }
</style></head><body>
  <div class="card">
    <div class="biz">${businessName}</div>
    <div class="name">${user.nombre}</div>
    <div class="role">${getRoleLabel(user)}</div>
    ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="QR Carnet" />` : ''}
    <svg class="barcode" viewBox="0 0 ${code39.width} 52" preserveAspectRatio="none">${barsSvg}</svg>
    <div class="code">${badgeCode}</div>
    <div class="foot">Muestra este carnet al lector para entrar o autorizar.</div>
  </div>
  <script>window.onload = () => { window.print(); };</script>
</body></html>`);
        win.document.close();
    };

    return (
        <div
            className="fixed inset-0 z-[250] flex items-center justify-center p-4 bg-black/65 backdrop-blur-sm animate-in fade-in duration-150"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Carnet de acceso"
        >
            <div
                className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-2xl p-5 space-y-4 animate-in zoom-in-95 duration-150"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                        <div className="w-9 h-9 rounded-xl bg-brand/15 text-brand-dark dark:text-brand flex items-center justify-center">
                            <BadgeCheck size={20} />
                        </div>
                        <div>
                            <h3 className="text-base font-black text-slate-800 dark:text-white leading-tight">
                                Carnet de Acceso
                            </h3>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                {user.nombre} · {getRoleLabel(user)}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
                        aria-label="Cerrar"
                    >
                        <X size={18} />
                    </button>
                </div>

                {badgeCode && code39 ? (
                    <>
                        {/* Vista previa del Carnet imprimible */}
                        <div className="bg-white text-slate-900 border-2 border-slate-900 rounded-2xl p-4 text-center space-y-2 shadow-sm">
                            <p className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-teal-700">
                                {businessName}
                            </p>
                            <p className="text-lg font-black leading-tight">{user.nombre}</p>
                            <span className="inline-block text-[10px] font-black uppercase tracking-wider bg-teal-50 text-teal-800 px-2.5 py-0.5 rounded-full">
                                {getRoleLabel(user)}
                            </span>
                            {qrDataUrl && (
                                <img
                                    src={qrDataUrl}
                                    alt="Código QR del carnet"
                                    className="w-36 h-36 mx-auto my-1 rounded-lg"
                                />
                            )}
                            <svg
                                viewBox={`0 0 ${code39.width} 48`}
                                className="w-full h-12 mx-auto"
                                preserveAspectRatio="none"
                                aria-label="Código de barras del carnet"
                            >
                                {code39.bars.map((b, idx) => (
                                    <rect key={idx} x={b.x} y={0} width={b.w} height={48} fill="#0f172a" />
                                ))}
                            </svg>
                            <p className="font-mono text-[11px] font-bold tracking-widest text-slate-600">
                                {badgeCode}
                            </p>
                        </div>

                        <div className="flex items-start gap-2 text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40 rounded-xl px-3 py-2">
                            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                            <span>Imprime o guarda este carnet ahora. Por seguridad, el código no se vuelve a mostrar al cerrar (si se pierde, genera uno nuevo).</span>
                        </div>

                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={handlePrint}
                                className="flex-1 py-2.5 rounded-xl bg-brand hover:bg-brand-dark text-white font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 shadow-md"
                            >
                                <Printer size={15} /> Imprimir / PDF
                            </button>
                            <button
                                type="button"
                                onClick={handleGenerate}
                                disabled={busy}
                                className="px-3 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-bold text-xs flex items-center gap-1.5 hover:bg-slate-200 dark:hover:bg-slate-700"
                                title="Generar código nuevo (invalida el anterior)"
                            >
                                <RefreshCw size={14} /> Nuevo
                            </button>
                        </div>
                    </>
                ) : (
                    <div className="space-y-3 text-center py-2">
                        <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                            {hasExistingBadge
                                ? 'Este empleado ya tiene un carnet activo. Puedes generar uno nuevo (el anterior dejará de funcionar) o revocarlo si se perdió.'
                                : 'Crea un carnet con código de barras y QR para que este empleado pueda entrar o autorizar acciones mostrándolo al lector.'}
                        </p>
                        <div className="flex flex-col gap-2">
                            <button
                                type="button"
                                onClick={handleGenerate}
                                disabled={busy}
                                className="w-full py-3 rounded-xl bg-brand hover:bg-brand-dark text-white font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 shadow-md"
                            >
                                <BadgeCheck size={16} />
                                {hasExistingBadge ? 'Regenerar Carnet (invalida el anterior)' : 'Generar Carnet de Barras / QR'}
                            </button>
                            {hasExistingBadge && (
                                <button
                                    type="button"
                                    onClick={handleRevoke}
                                    className="w-full py-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800/40 font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-1.5"
                                >
                                    <ShieldOff size={14} /> Revocar Carnet Perdido
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
