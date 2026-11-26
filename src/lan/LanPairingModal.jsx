/**
 * Modal de la Caja Principal para:
 *   · conectar otra caja PC o abrir Supervisor móvil/PC (QR + IP + código 6 dígitos),
 *   · exportar o restaurar un respaldo completo (F-21),
 *   · activar licencia offline RSA para 3+ cajas (F-22).
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { QrCode, RefreshCw, Download, Upload, Wifi, Loader2, CheckCircle2, KeyRound, Smartphone, Globe } from 'lucide-react';
import { NubeModal } from '../nube/NubeTeamUI';
import { NubeError } from '../nube/NubeScreens';
import { getLanCloudBridgeConfig } from './cloudSupervisorClient';
import { getElectronLanApi } from './lanConfig';

export default function LanPairingModal({ client, accountId, onRestored, onLicenseApplied, onClose }) {
    const [tab, setTab] = useState('conectar'); // conectar | respaldo | licencia
    const [info, setInfo] = useState(null);
    const [qrDataUrl, setQrDataUrl] = useState('');
    const [supervisorQrUrl, setSupervisorQrUrl] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [statusMsg, setStatusMsg] = useState(null);
    const [licenseToken, setLicenseToken] = useState('');
    const envCloud = getLanCloudBridgeConfig();
    const [bridgeStatus, setBridgeStatus] = useState(null);
    const [bridgeForm, setBridgeForm] = useState({
        cloudUrl: envCloud.url || '',
        cloudAnonKey: envCloud.key || '',
        ownerPin: '',
        supervisorCode: '',
    });

    const refreshBridge = async () => {
        if (!client?.lan?.getBridgeStatus) return;
        try {
            const st = await client.lan.getBridgeStatus();
            setBridgeStatus(st);
            setBridgeForm((f) => ({
                ...f,
                cloudUrl: st.cloudUrl || f.cloudUrl,
                supervisorCode: st.supervisorCode || f.supervisorCode,
            }));
        } catch {
            /* opcional */
        }
    };

    const generate = async () => {
        if (!client?.lan?.generatePairingCode) return;
        setBusy(true);
        setError(null);
        try {
            const data = await client.lan.generatePairingCode(accountId);
            setInfo(data);
            const qrPayload = JSON.stringify({ url: data.primaryUrl, code: data.code });
            const [img, supImg] = await Promise.all([
                QRCode.toDataURL(qrPayload, { width: 200, margin: 1 }),
                QRCode.toDataURL(`${data.primaryUrl}/?supervisor=1`, { width: 170, margin: 1 }),
            ]);
            setQrDataUrl(img);
            setSupervisorQrUrl(supImg);
        } catch (err) {
            setError(err?.message || 'No se pudo generar el código de conexión.');
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        generate();
        refreshBridge();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const downloadBackup = async () => {
        setBusy(true);
        setError(null);
        setStatusMsg(null);
        try {
            const snap = await client.lan.exportSnapshot();
            const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const stamp = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = `respaldo-lan-${stamp}.json`;
            a.click();
            URL.revokeObjectURL(url);
            setStatusMsg('Respaldo descargado correctamente.');
        } catch (err) {
            setError(err?.message || 'No se pudo descargar el respaldo.');
        } finally {
            setBusy(false);
        }
    };

    const handleRestoreFile = async (file) => {
        if (!file) return;
        if (!window.confirm('Esto reemplazará la base local de esta Caja Principal con el archivo elegido. ¿Continuar?')) return;
        setBusy(true);
        setError(null);
        setStatusMsg(null);
        try {
            const snap = JSON.parse(await file.text());
            await client.lan.restoreSnapshot(snap);
            setStatusMsg('Respaldo restaurado y verificado. Todas las cajas verán los datos al reconectar.');
            onRestored?.();
        } catch (err) {
            setError(err?.message || 'No se pudo restaurar el respaldo.');
        } finally {
            setBusy(false);
        }
    };

    const handleActivateLicense = async (e) => {
        e.preventDefault();
        if (!licenseToken.trim()) return;
        setBusy(true);
        setError(null);
        setStatusMsg(null);
        try {
            const res = await client.lan.applyLicense(licenseToken.trim());
            const max = res?.license?.max_cajas || '';
            setStatusMsg(`Licencia activada${max ? ` (${max} cajas permitidas)` : ''}.`);
            setLicenseToken('');
            onLicenseApplied?.(res?.license);
        } catch (err) {
            setError(err?.message || 'No se pudo activar ese código de licencia.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <NubeModal title="Caja Principal · Red Local" onClose={onClose} testId="lan-pairing-modal">
            <div className="flex p-1 bg-slate-100 dark:bg-slate-800 rounded-xl mb-4" role="tablist">
                {[
                    ['conectar', 'Conectar'],
                    ['internet', 'Internet'],
                    ['respaldo', 'Respaldos'],
                    ['licencia', 'Licencia'],
                ].map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={tab === id}
                        onClick={() => { setTab(id); setError(null); setStatusMsg(null); }}
                        className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all ${tab === id ? 'bg-white dark:bg-slate-900 text-brand shadow-sm' : 'text-slate-500'}`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            <NubeError message={error} />
            {statusMsg && (
                <p role="status" className="text-xs font-bold text-emerald-700 bg-emerald-50 rounded-xl px-3 py-2 mb-3 flex items-center gap-1.5">
                    <CheckCircle2 size={14} /> {statusMsg}
                </p>
            )}

            {tab === 'conectar' && (
                busy && !info ? (
                    <div className="flex justify-center py-8 text-brand">
                        <Loader2 size={24} className="animate-spin" />
                    </div>
                ) : info ? (
                    <div className="space-y-3">
                        <p className="text-xs text-slate-500 leading-relaxed">
                            Para conectar otra <strong>Caja PC</strong>, usa la dirección de red y este código de 6 dígitos (dura 10 minutos):
                        </p>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
                            {qrDataUrl && (
                                <div className="flex flex-col items-center gap-1">
                                    <img src={qrDataUrl} alt="QR de conexión LAN" className="rounded-2xl border border-slate-200 p-2 bg-white w-36 h-36" />
                                    <span className="text-[10px] font-bold text-slate-400">QR Caja PC</span>
                                </div>
                            )}
                            {supervisorQrUrl && (
                                <div className="flex flex-col items-center gap-1">
                                    <img src={supervisorQrUrl} alt="QR Supervisor móvil" className="rounded-2xl border border-slate-200 p-2 bg-white w-36 h-36" />
                                    <span className="text-[10px] font-bold text-brand flex items-center gap-1">
                                        <Smartphone size={11} /> Supervisor móvil (Wi-Fi)
                                    </span>
                                </div>
                            )}
                        </div>

                        <div className="rounded-2xl bg-slate-50 dark:bg-slate-800 p-3 text-center space-y-1">
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Código temporal</p>
                            <p className="text-3xl font-black tracking-[0.25em] text-brand font-mono" data-testid="lan-pairing-code">
                                {info.code}
                            </p>
                        </div>

                        <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-1">
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1">
                                <Wifi size={12} className="text-brand" /> Direcciones de esta Caja Principal
                            </p>
                            {(info.urls?.length ? info.urls : [info.primaryUrl]).map((u) => (
                                <p key={u} className="text-xs font-mono font-bold text-slate-700 dark:text-slate-200 select-all">
                                    {u}
                                </p>
                            ))}
                        </div>

                        <button
                            type="button"
                            disabled={busy}
                            onClick={generate}
                            className="w-full rounded-xl border border-slate-200 dark:border-slate-700 py-2.5 text-xs font-bold text-slate-600 dark:text-slate-200 flex items-center justify-center gap-1.5"
                        >
                            <RefreshCw size={14} /> Generar código nuevo
                        </button>

                        {getElectronLanApi()?.repairFirewall && (
                            <button
                                type="button"
                                data-testid="lan-repair-firewall-btn"
                                disabled={busy}
                                onClick={async () => {
                                    setBusy(true);
                                    setError(null);
                                    setStatusMsg(null);
                                    try {
                                        const res = await getElectronLanApi().repairFirewall();
                                        if (res?.ok) {
                                            setStatusMsg('Permiso de red local listo. Ya puedes conectar otras cajas y celulares.');
                                        } else {
                                            setError(res?.error || 'No se pudo aplicar el permiso de red en Windows.');
                                        }
                                    } catch (err) {
                                        setError(err?.message || 'Error al configurar el Firewall de Windows.');
                                    } finally {
                                        setBusy(false);
                                    }
                                }}
                                className="w-full rounded-xl border border-emerald-200 dark:border-emerald-800/70 bg-emerald-50/70 dark:bg-emerald-950/30 py-2.5 text-xs font-bold text-emerald-700 dark:text-emerald-300 flex items-center justify-center gap-1.5"
                            >
                                <svg
                                    viewBox="0 0 24 24"
                                    width="14"
                                    height="14"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                >
                                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                                    <path d="m9 12 2 2 4-4" />
                                </svg>
                                Reparar permiso de red (Firewall)
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="text-center py-6 text-xs text-slate-400 flex flex-col items-center gap-2">
                        <QrCode size={28} />
                        <span>No hay datos de vinculación disponibles.</span>
                    </div>
                )
            )}

            {tab === 'internet' && (
                <div className="space-y-3" data-testid="lan-bridge-tab">
                    <p className="text-xs text-slate-500 leading-relaxed">
                        Activa el puente para ver ventas y editar precios, stock o tasa desde <strong>Android, iOS o Windows</strong> fuera del local con internet.
                    </p>
                    {bridgeStatus?.enabled ? (
                        <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 p-3 space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-black text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
                                    <Globe size={14} /> Puente activo
                                </span>
                                {bridgeStatus.lastSyncAt && (
                                    <span className="text-[10px] text-emerald-600">
                                        Último envío: {new Date(bridgeStatus.lastSyncAt).toLocaleTimeString('es-VE')}
                                    </span>
                                )}
                            </div>
                            <div className="text-center py-1">
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Código del negocio</p>
                                <p className="text-2xl font-black tracking-widest text-brand font-mono" data-testid="lan-bridge-code">
                                    {bridgeStatus.supervisorCode}
                                </p>
                            </div>
                            {bridgeStatus.lastError && <p className="text-xs text-red-600 font-bold">{bridgeStatus.lastError}</p>}
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={async () => {
                                        setBusy(true); setError(null); setStatusMsg(null);
                                        try {
                                            const r = await client.lan.syncBridgeNow();
                                            setBridgeStatus(r.status);
                                            setStatusMsg('Sincronizado con internet.');
                                        } catch (e) { setError(e?.message); } finally { setBusy(false); }
                                    }}
                                    className="flex-1 rounded-xl bg-brand text-white py-2 text-xs font-black"
                                >
                                    Sincronizar ahora
                                </button>
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={async () => {
                                        setBusy(true); setError(null);
                                        try {
                                            const r = await client.lan.disableBridge();
                                            setBridgeStatus(r.status);
                                            setStatusMsg('Puente pausado.');
                                        } catch (e) { setError(e?.message); } finally { setBusy(false); }
                                    }}
                                    className="rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-bold text-slate-600 dark:text-slate-300"
                                >
                                    Pausar
                                </button>
                            </div>
                        </div>
                    ) : (
                        <form
                            onSubmit={async (e) => {
                                e.preventDefault();
                                setBusy(true); setError(null); setStatusMsg(null);
                                try {
                                    const r = await client.lan.setupBridge(bridgeForm);
                                    setBridgeStatus(r.status);
                                    setBridgeForm((f) => ({ ...f, ownerPin: '', supervisorCode: r.status?.supervisorCode || f.supervisorCode }));
                                    setStatusMsg(`Puente activado. Usa el código ${r.status?.supervisorCode} desde tu celular o PC.`);
                                } catch (err) {
                                    setError(err?.message || 'No se pudo activar el puente.');
                                } finally {
                                    setBusy(false);
                                }
                            }}
                            className="space-y-2.5"
                        >
                            {!envCloud.available && (
                                <>
                                    <input
                                        type="url"
                                        required
                                        value={bridgeForm.cloudUrl}
                                        onChange={(e) => setBridgeForm((f) => ({ ...f, cloudUrl: e.target.value }))}
                                        placeholder="URL de Supabase puente (https://....supabase.co)"
                                        className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-mono"
                                    />
                                    <input
                                        type="text"
                                        required
                                        value={bridgeForm.cloudAnonKey}
                                        onChange={(e) => setBridgeForm((f) => ({ ...f, cloudAnonKey: e.target.value }))}
                                        placeholder="Llave anon pública de Supabase"
                                        className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-mono"
                                    />
                                </>
                            )}
                            <input
                                type="password"
                                inputMode="numeric"
                                required
                                minLength={6}
                                value={bridgeForm.ownerPin}
                                onChange={(e) => setBridgeForm((f) => ({ ...f, ownerPin: e.target.value.replace(/\D/g, '') }))}
                                placeholder="PIN de supervisor remoto (6+ números)"
                                className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-bold"
                            />
                            <button
                                type="submit"
                                disabled={busy || !bridgeForm.cloudUrl || !bridgeForm.cloudAnonKey || bridgeForm.ownerPin.length < 6}
                                className="w-full rounded-xl bg-brand text-white py-2.5 text-xs font-black flex items-center justify-center gap-1.5 disabled:opacity-50"
                            >
                                <Globe size={14} /> Activar Modo Supervisor por internet
                            </button>
                        </form>
                    )}
                </div>
            )}

            {tab === 'respaldo' && (
                <div className="space-y-3">
                    <p className="text-xs text-slate-500 leading-relaxed">
                        Guarda una copia completa en un pendrive o recupera el negocio desde un respaldo anterior si cambiaste de computadora.
                    </p>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={downloadBackup}
                        data-testid="lan-download-backup"
                        className="w-full rounded-xl bg-slate-900 text-white py-3 text-xs font-black flex items-center justify-center gap-2"
                    >
                        <Download size={15} /> Descargar respaldo completo (.json)
                    </button>

                    <label className="w-full rounded-xl border-2 border-dashed border-brand/40 bg-brand-light/20 hover:bg-brand-light/40 text-brand py-3 text-xs font-black flex items-center justify-center gap-2 cursor-pointer">
                        <Upload size={15} /> Restaurar respaldo desde archivo
                        <input
                            type="file"
                            accept=".json,application/json"
                            className="hidden"
                            disabled={busy}
                            data-testid="lan-restore-input"
                            onChange={(e) => {
                                const f = e.target.files?.[0];
                                e.target.value = '';
                                handleRestoreFile(f);
                            }}
                        />
                    </label>
                </div>
            )}

            {tab === 'licencia' && (
                <form onSubmit={handleActivateLicense} className="space-y-3">
                    <p className="text-xs text-slate-500 leading-relaxed">
                        Pega aquí el token firmado de tu licencia para ampliar la cantidad de cajas LAN sin necesitar internet.
                    </p>
                    <textarea
                        rows={4}
                        value={licenseToken}
                        onChange={(e) => setLicenseToken(e.target.value)}
                        placeholder="Pega el código de licencia firmado (base64.firma)"
                        data-testid="lan-license-input"
                        className="w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-xs font-mono outline-none focus:border-brand"
                    />
                    <button
                        type="submit"
                        disabled={busy || !licenseToken.trim()}
                        data-testid="lan-license-submit"
                        className="w-full rounded-xl bg-brand text-white py-3 text-xs font-black flex items-center justify-center gap-2"
                    >
                        <KeyRound size={15} /> Activar licencia offline
                    </button>
                </form>
            )}
        </NubeModal>
    );
}
