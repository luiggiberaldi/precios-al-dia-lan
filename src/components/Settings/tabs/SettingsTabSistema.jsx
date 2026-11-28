import { useState, useEffect, useRef } from 'react';
import {
    Palette, Fingerprint, Upload, Download, Share2, Cloud, HardDrive,
    Check, ChevronRight, Trash2, AlertTriangle, ZoomIn, ZoomOut, RotateCcw, QrCode, RefreshCw, Rocket, Clock
} from 'lucide-react';
import { SectionCard } from '../../SettingsShared';
import { showToast } from '../../Toast';
import PairingManager from '../PairingManager';
import { isNubeAccountsEnabled } from '../../../nube/nubeSupabase';
import NubeAccountReset, { isOwnerHere } from '../../../nube/NubeAccountReset';
import SystemHealthPanel from '../SystemHealthPanel';
import ConfirmModal from '../../ConfirmModal';
import QRCode from 'qrcode';
import { resetPOSDataToEmpty } from '../../../hooks/useCloudSync';
import { useSecurity } from '../../../hooks/useSecurity';
import { applyUiScale } from '../../../utils/uiScale';
import { getLastBackupAt, describeBackupAge, isBackupStale } from '../../../utils/backupReminder';
import { getElectronUpdaterApi, triggerManualUpdateCheck } from '../../../lan/lanConfig';

const DESKTOP_UPDATE_BADGES = {
    downloaded: { label: 'Lista para instalar', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/50' },
    downloading: { label: 'Descargando', cls: 'bg-brand-light text-brand border-brand/20' },
    available: { label: 'Disponible', cls: 'bg-brand-light text-brand border-brand/20' },
    checking: { label: 'Buscando…', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700' },
    'up-to-date': { label: 'Al día', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300 border-emerald-200/70 dark:border-emerald-800/40' },
    offline: { label: 'Sin conexión', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 border-amber-200 dark:border-amber-800/40' },
    error: { label: 'No disponible', cls: 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300 border-rose-200 dark:border-rose-800/40' },
    unsupported: { label: 'Modo desarrollo', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700' },
};

function formatCheckTime(iso) {
    if (!iso) return null;
    try {
        return new Date(iso).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return null;
    }
}

// Ajustes > Sistema, ordenado como en Farmacia (CASO-021): respaldo local y nube por separado,
// aviso de «último respaldo», versión con «Buscar actualización» y lo irreversible solo en la
// Zona de Peligro. Se quitaron «Diagnóstico de Empaque» y «Deshacer corrección de empaque»
// (herramientas de una migración vieja); el código de apoyo sigue en utils/granel y
// utils/packagingFixMigration por si hace falta.

export default function SettingsTabSistema({
    deviceId, idCopied, setIdCopied,
    isAdmin,
    importStatus, statusMessage,
    handleExport, handleImportClick,
    handleSyncCloud,
    isLicensedCloud = true,
    dataConflictPending, handleDataConflictChoice,
    lastError, onDismissError,
    setIsShareOpen,
    setShowDeleteConfirm,
    triggerHaptic,
}) {
    const [uiScale, setUiScale] = useState(() => {
        const saved = parseInt(localStorage.getItem('ui_scale'));
        return saved >= 60 && saved <= 140 ? saved : 100;
    });
    const [fixingId, setFixingId] = useState(false);
    const [showIdFixConfirm, setShowIdFixConfirm] = useState(false);
    const { fixDuplicateDeviceId } = useSecurity();
    
    const qrCanvasRef = useRef(null);

    const [showResetConfirm, setShowResetConfirm] = useState(false);

    // Fecha del último respaldo exportado (se vuelve a leer al terminar una exportación).
    const [lastBackupAt, setLastBackupAt] = useState(null);
    useEffect(() => {
        let alive = true;
        getLastBackupAt().then(v => { if (alive) setLastBackupAt(v); }).catch(() => {});
        return () => { alive = false; };
    }, [importStatus]);
    const backupStale = isBackupStale(lastBackupAt);

    const electronUpdater = getElectronUpdaterApi();

    // Buscar actualización: en Electron usa el auto-updater; en web usa el Service Worker.
    const [checkingUpdate, setCheckingUpdate] = useState(false);
    const [updateReady, setUpdateReady] = useState(() => !!window.__pdaSwUpdateAvailable);
    const [desktopUpdateState, setDesktopUpdateState] = useState(null);
    const [installingDesktopUpdate, setInstallingDesktopUpdate] = useState(false);
    const [desktopUpdatePostponed, setDesktopUpdatePostponed] = useState(false);

    useEffect(() => {
        if (!electronUpdater) {
            const onUpdate = () => setUpdateReady(true);
            window.addEventListener('sw-update-available', onUpdate);
            return () => window.removeEventListener('sw-update-available', onUpdate);
        }
        let cancelled = false;
        electronUpdater.getState?.().then((state) => {
            if (!cancelled && state) setDesktopUpdateState(state);
        }).catch(() => {});
        const unsubscribe = electronUpdater.onStateChange?.((state) => {
            if (cancelled || !state) return;
            setDesktopUpdateState(state);
            if (state.status !== 'downloaded') setDesktopUpdatePostponed(false);
        });
        return () => {
            cancelled = true;
            if (typeof unsubscribe === 'function') unsubscribe();
        };
    }, [electronUpdater]);

    const handleInstallDesktopUpdate = async () => {
        if (!electronUpdater?.installNow || installingDesktopUpdate) return;
        triggerHaptic?.();
        setInstallingDesktopUpdate(true);
        try {
            const res = await electronUpdater.installNow();
            if (!res?.ok) {
                showToast(res?.error || 'No se pudo iniciar la instalación', 'error');
                setInstallingDesktopUpdate(false);
            }
        } catch (err) {
            showToast(err?.message || 'Error al instalar la actualización', 'error');
            setInstallingDesktopUpdate(false);
        }
    };

    const handleCheckUpdate = async () => {
        triggerHaptic?.();
        if (electronUpdater) {
            if (checkingUpdate) return;
            setCheckingUpdate(true);
            try {
                const res = await electronUpdater.checkNow?.();
                const nextState = res?.state;
                if (nextState) setDesktopUpdateState(nextState);
                if (nextState?.status === 'downloaded') {
                    setDesktopUpdatePostponed(false);
                    showToast(`Actualización v${nextState.availableVersion} lista para instalar`, 'success');
                } else if (nextState?.status === 'available' || nextState?.status === 'downloading') {
                    showToast(`Descargando versión v${nextState.availableVersion}…`, 'info');
                } else if (nextState?.status === 'up-to-date') {
                    showToast('Ya tienes la última versión instalada', 'success');
                } else if (nextState?.status === 'offline' || nextState?.status === 'unsupported') {
                    showToast(nextState.error || 'No se pudo buscar actualización ahora', 'info');
                } else if (nextState?.status === 'error') {
                    showToast(nextState.error || 'No se pudo buscar actualización', 'error');
                }
            } catch (err) {
                showToast(err?.message || 'No se pudo buscar actualización', 'error');
            } finally {
                setCheckingUpdate(false);
            }
            return;
        }
        if (updateReady && typeof window.__pdaUpdateSW === 'function') {
            await window.__pdaUpdateSW(true);
            return;
        }
        if (checkingUpdate) return;
        setCheckingUpdate(true);
        try {
            const reg = await navigator.serviceWorker?.getRegistration?.();
            if (!reg) {
                showToast('Las actualizaciones no están disponibles en este modo', 'info');
                return;
            }
            await reg.update();
            await new Promise(r => setTimeout(r, 2500));
            if (window.__pdaSwUpdateAvailable) setUpdateReady(true);
            else showToast('Ya tienes la última versión', 'success');
        } catch (err) {
            console.warn('[SettingsTabSistema] No se pudo buscar actualización:', err);
            showToast('No se pudo buscar actualización. Revisa tu conexión', 'error');
        } finally {
            setCheckingUpdate(false);
        }
    };

    // Vacía este equipo y publica el estado vacío en la nube (antes con window.confirm, ahora con confirmación propia).
    const handleResetFromZero = async () => {
        try {
            const result = await resetPOSDataToEmpty();
            showToast(
                result.ok
                    ? 'Equipo reiniciado: la nube quedó con estado vacío'
                    : `No se pudo publicar el estado vacío: ${result.result?.error || 'error desconocido'}`,
                result.ok ? 'success' : 'error',
            );
        } catch (error) {
            showToast(error?.message || 'No se pudieron reiniciar los datos', 'error');
        }
    };

    // Corrige dos equipos que comparten el mismo ID: esta estación obtiene uno
    // propio y único, conserva sus datos y registra la licencia desde el ID nuevo.
    const handleFixDuplicateId = async () => {
        if (fixingId) return;
        triggerHaptic?.();
        setFixingId(true);
        try {
            const newId = await fixDuplicateDeviceId();
            showToast(`ID único generado para esta estación: ${newId}`, 'success');
        } catch (err) {
            console.warn('[SettingsTabSistema] No se pudo generar ID único:', err);
            showToast('No se pudo generar un ID único para esta estación', 'error');
        } finally {
            setFixingId(false);
        }
    };

    useEffect(() => {
        if (deviceId && qrCanvasRef.current) {
            QRCode.toCanvas(
                qrCanvasRef.current,
                deviceId,
                {
                    width: 112,
                    margin: 1,
                    color: {
                        dark: '#1e293b', // slate-800
                        light: '#ffffff'
                    }
                },
                (err) => {
                    if (err) console.error('[SettingsTabSistema] Error dibujando QR de instalación:', err);
                }
            );
        }
    }, [deviceId]);

    useEffect(() => {
        applyUiScale(uiScale);
        localStorage.setItem('ui_scale', uiScale.toString());
    }, [uiScale]);

    const adjustScale = (delta) => {
        setUiScale(prev => {
            const next = Math.max(60, Math.min(140, prev + delta));
            triggerHaptic?.();
            return next;
        });
    };

    return (
        <div className="cq-grid cq-3 items-start">
            {/* COLUMNA 1: Respaldo local + Nube (si aplica) + Reinicio de cuenta (solo dueño) */}
            <div className="space-y-4 min-w-0">
                <SectionCard icon={HardDrive} title="Respaldo local" subtitle="Exportar, importar y compartir" iconColor="text-cyan-500">
                    <div
                        data-testid="backup-age"
                        className={`p-3 rounded flex gap-2.5 border ${backupStale ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/40' : 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-800/30'}`}
                    >
                        {backupStale
                            ? <AlertTriangle size={18} className="text-amber-600 dark:text-amber-500 shrink-0 mt-0.5" />
                            : <Check size={18} className="text-emerald-600 dark:text-emerald-500 shrink-0 mt-0.5" />}
                        <div className="min-w-0">
                            <p className={`text-xs font-bold ${backupStale ? 'text-amber-800 dark:text-amber-400' : 'text-emerald-800 dark:text-emerald-400'}`}>
                                {describeBackupAge(lastBackupAt)}
                            </p>
                            {backupStale && (
                                <p className="text-[11px] text-amber-700 dark:text-amber-500/90 leading-relaxed mt-0.5">
                                    Exporta un respaldo al menos una vez por semana para no perder tus datos.
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Exportar, importar (reemplaza todo) y compartir son del Administrador. */}
                    {!isAdmin && (
                        <p className="text-xs font-bold text-slate-500 dark:text-slate-400">Solo el Administrador puede exportar, importar o compartir datos.</p>
                    )}
                    {isAdmin && <div className="space-y-2">
                        <button onClick={handleExport} className="w-full flex items-center gap-3 p-3.5 min-h-[54px] bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors group active:scale-[0.98]">
                            <div className="p-2 bg-brand-light dark:bg-surface-800/30 rounded-sm shrink-0"><Download size={18} className="text-brand" /></div>
                            <div className="text-left flex-1 min-w-0">
                                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Exportar respaldo</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Descargar archivo .json</p>
                            </div>
                            <ChevronRight size={16} className="text-slate-300 shrink-0" />
                        </button>

                        <button onClick={handleImportClick} className="w-full flex items-center gap-3 p-3.5 min-h-[54px] bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors group active:scale-[0.98]">
                            <div className="p-2 bg-emerald-50 dark:bg-emerald-900/30 rounded-sm shrink-0"><Upload size={18} className="text-emerald-500" /></div>
                            <div className="text-left flex-1 min-w-0">
                                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Importar respaldo</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Restaurar desde archivo (reemplaza todo)</p>
                            </div>
                            <ChevronRight size={16} className="text-slate-300 shrink-0" />
                        </button>

                        <button onClick={() => setIsShareOpen(true)} className="w-full flex items-center gap-3 p-3.5 min-h-[54px] bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors group active:scale-[0.98]">
                            <div className="p-2 bg-brand-light dark:bg-surface-800/30 rounded-sm shrink-0"><Share2 size={18} className="text-brand" /></div>
                            <div className="text-left flex-1 min-w-0">
                                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Compartir inventario</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Código de 6 dígitos, válido 24 h</p>
                            </div>
                            <ChevronRight size={16} className="text-slate-300 shrink-0" />
                        </button>
                    </div>}

                    <p className="text-[11px] text-amber-800 dark:text-amber-400 leading-relaxed font-bold">
                        PRECAUCIÓN: al restaurar un respaldo se sobrescribirá por completo todo el historial de ventas, inventario, deudores y configuraciones de este dispositivo.
                    </p>

                    {importStatus && (
                        <div className={`p-2.5 rounded text-xs font-bold text-center flex items-center justify-center gap-2 ${importStatus === 'success' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>
                            {importStatus === 'success' ? <Check size={14} /> : <AlertTriangle size={14} />}
                            {statusMessage}
                        </div>
                    )}
                </SectionCard>

                {/* Nube (respaldo de Bodega). En Precios al Día Nube los datos ya viven en el servidor. */}
                {!isNubeAccountsEnabled() && (
                <SectionCard icon={Cloud} title="Nube" subtitle="Copia en línea de tus datos" iconColor="text-sky-500">
                    <button
                        onClick={() => {
                            if (!isLicensedCloud) {
                                showToast('La sincronización con la nube requiere licencia completa', 'error');
                                return;
                            }
                            handleSyncCloud?.();
                        }}
                        aria-disabled={!isLicensedCloud}
                        title={!isLicensedCloud ? 'Disponible con licencia permanente activa' : undefined}
                        className={`w-full flex items-center gap-3 p-3.5 min-h-[54px] bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700 rounded transition-colors group active:scale-[0.98] ${isLicensedCloud ? 'hover:bg-slate-100 dark:hover:bg-slate-800' : 'opacity-50 cursor-not-allowed'}`}
                    >
                        <div className="p-2 bg-sky-50 dark:bg-sky-900/30 rounded-sm shrink-0"><Cloud size={18} className="text-sky-500" /></div>
                        <div className="text-left flex-1 min-w-0">
                            <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Sincronizar con la Nube</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">Disponible solo con licencia permanente activa</p>
                            {!isLicensedCloud && (
                                <span className="inline-block mt-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 uppercase tracking-wide">Solo permanente</span>
                            )}
                        </div>
                        <ChevronRight size={16} className="text-slate-300 shrink-0" />
                    </button>

                    {lastError && (
                        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded space-y-1.5" role="alert">
                            <div className="flex items-start justify-between gap-2">
                                <p className="text-xs font-bold text-red-700 dark:text-red-400 flex items-center gap-1.5">
                                    <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {lastError.title}
                                </p>
                                <button
                                    onClick={onDismissError}
                                    className="text-red-400 hover:text-red-600 dark:hover:text-red-300 text-xs font-bold px-1"
                                    aria-label="Descartar error"
                                >
                                    ✕
                                </button>
                            </div>
                            <p className="text-[11px] text-red-600 dark:text-red-500/90 leading-relaxed">{lastError.detail}</p>
                            <p className="text-[11px] text-red-700 dark:text-red-400 font-medium leading-relaxed">💡 {lastError.hint}</p>
                            {lastError.technical && (
                                <p className="text-[9px] text-red-400/70 font-mono break-all pt-1 border-t border-red-100 dark:border-red-800/30">
                                    {lastError.technical}
                                </p>
                            )}
                        </div>
                    )}

                    {dataConflictPending && (
                        <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded space-y-2">
                            <p className="text-xs font-bold text-amber-800 dark:text-amber-400 flex items-center gap-1.5">
                                <AlertTriangle size={14} /> Conflicto de datos detectado
                            </p>
                            <p className="text-[11px] text-amber-700 dark:text-amber-500/90 leading-relaxed">
                                Hay datos tanto en este dispositivo como en la nube. Elige qué versión conservar:
                            </p>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => handleDataConflictChoice('cloud')}
                                    className="flex-1 py-2.5 px-3 text-xs font-bold text-white bg-sky-500 hover:bg-sky-600 rounded active:scale-95 transition-all"
                                >
                                    Usar los de la Nube
                                </button>
                                <button
                                    onClick={() => handleDataConflictChoice('local')}
                                    className="flex-1 py-2.5 px-3 text-xs font-bold text-white bg-emerald-500 hover:bg-emerald-600 rounded active:scale-95 transition-all"
                                >
                                    Subir los de este Equipo
                                </button>
                            </div>
                        </div>
                    )}
                </SectionCard>
                )}

                {/* Nube/LAN: reinicio de fábrica de TODA la cuenta, solo el dueño (apilado en Columna 1 sin dejar huecos). */}
                {isNubeAccountsEnabled() && isOwnerHere() && <NubeAccountReset fullSpan={false} />}
            </div>

            {/* COLUMNA 2: Apariencia + Salud del sistema (apiladas para eliminar el hueco central) */}
            <div className="space-y-4 min-w-0">
                <SectionCard icon={Palette} title="Apariencia" subtitle="Estilo visual de la app" iconColor="text-pink-500">
                    <div>
                        <div className="flex items-center gap-3 mb-3">
                            <ZoomIn size={18} className="text-brand shrink-0" />
                            <div>
                                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Tamaño de Pantalla</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Ajusta si la interfaz se ve muy grande o muy pequeña</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => adjustScale(-5)}
                                disabled={uiScale <= 60}
                                className="w-10 h-10 flex items-center justify-center rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-brand-light hover:text-brand-dark dark:hover:bg-surface-800/20 dark:hover:text-brand transition-all active:scale-90 disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                            >
                                <ZoomOut size={16} />
                            </button>
                            <div className="flex-1 relative">
                                <input
                                    type="range"
                                    min="60"
                                    max="140"
                                    step="5"
                                    value={uiScale}
                                    onChange={e => { setUiScale(parseInt(e.target.value)); triggerHaptic?.(); }}
                                    className="w-full h-2 rounded-full appearance-none cursor-pointer bg-slate-200 dark:bg-slate-700 accent-brand"
                                />
                                <div className="flex justify-between mt-1 px-0.5">
                                    <span className="text-[10px] text-slate-500 dark:text-slate-400 font-medium">60%</span>
                                    <span className="text-[10px] text-slate-500 dark:text-slate-400 font-medium">100%</span>
                                    <span className="text-[10px] text-slate-500 dark:text-slate-400 font-medium">140%</span>
                                </div>
                            </div>
                            <button
                                onClick={() => adjustScale(5)}
                                disabled={uiScale >= 140}
                                className="w-10 h-10 flex items-center justify-center rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-brand-light hover:text-brand-dark dark:hover:bg-surface-800/20 dark:hover:text-brand transition-all active:scale-90 disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                            >
                                <ZoomIn size={16} />
                            </button>
                        </div>
                        <div className="flex items-center justify-between mt-2">
                            <span className="text-xs font-black text-brand-dark dark:text-brand bg-brand-light dark:bg-surface-800/20 px-2.5 py-1 rounded-sm">{uiScale}%</span>
                            {uiScale !== 100 && (
                                <button
                                    onClick={() => { setUiScale(100); triggerHaptic?.(); }}
                                    className="text-xs font-bold text-slate-550 hover:text-brand flex items-center gap-1 transition-colors"
                                >
                                    <RotateCcw size={12} /> Restablecer
                                </button>
                            )}
                        </div>
                    </div>
                </SectionCard>

                {/* Salud del sistema (Fase 3): reloj vs servidor, último comando y última sincronización */}
                <SystemHealthPanel triggerHaptic={triggerHaptic} />
            </div>

            {/* COLUMNA 3: Dispositivo */}
            <div className="space-y-4 min-w-0">
                <SectionCard icon={Fingerprint} title="Dispositivo" subtitle="Información técnica" iconColor="text-slate-500">
                    <div className="flex flex-col sm:flex-row items-center gap-3.5 p-3 bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800 rounded">
                        <div className="p-2 bg-white dark:bg-slate-950 rounded-sm border border-slate-200/60 dark:border-slate-800 shadow-xs shrink-0">
                            <canvas ref={qrCanvasRef} className="w-[112px] h-[112px] block rounded-xs" />
                        </div>
                        <div className="min-w-0 flex-1 w-full">
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                    <p className="text-[11px] uppercase tracking-wider font-extrabold text-slate-500 dark:text-slate-400 mb-1">ID de instalación</p>
                                    <p className="font-mono text-xs font-black text-slate-700 dark:text-slate-200 select-all break-all leading-relaxed">{deviceId || '...'}</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (!deviceId) return;
                                        navigator.clipboard.writeText(deviceId).then(() => {
                                            setIdCopied(true);
                                            setTimeout(() => setIdCopied(false), 2000);
                                        });
                                    }}
                                    className="shrink-0 p-2 min-h-[38px] min-w-[38px] flex items-center justify-center rounded-sm text-slate-400 hover:text-teal-500 hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-all"
                                    title={idCopied ? '¡Copiado!' : 'Copiar ID completo'}
                                    aria-label="Copiar ID de instalación"
                                >
                                    {idCopied ? <Check size={14} className="text-emerald-500" /> : <Fingerprint size={14} />}
                                </button>
                            </div>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2 leading-snug">
                                Comparte este ID o escanea su código QR para soporte técnico o activación de licencia.
                            </p>
                        </div>
                    </div>

                    {electronUpdater ? (() => {
                        const st = desktopUpdateState;
                        const displayVersion = st?.currentVersion || import.meta.env.VITE_APP_VERSION;
                        const isBusy = checkingUpdate || st?.status === 'checking';
                        const isDownloading = st?.status === 'downloading' || st?.status === 'available';
                        const isDownloaded = st?.status === 'downloaded' && st?.downloaded;
                        const badge = DESKTOP_UPDATE_BADGES[st?.status] || null;
                        const lastCheckLabel = formatCheckTime(st?.lastCheckedAt);
                        const pct = Math.min(100, Math.max(0, Number(st?.progressPercent || 0)));

                        return (
                            <div
                                data-testid="lan-settings-updates"
                                className="mt-3 rounded border border-slate-200/80 dark:border-slate-700/70 bg-slate-50/90 dark:bg-slate-800/50 p-3.5 space-y-3"
                            >
                                <div className="flex flex-wrap items-center justify-between gap-2.5">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <p className="text-[11px] uppercase tracking-wider font-extrabold text-slate-500 dark:text-slate-400">
                                                Actualizaciones del sistema
                                            </p>
                                            {badge && (
                                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-black uppercase tracking-wider ${badge.cls}`}>
                                                    {isDownloading ? `Descargando ${pct}%` : badge.label}
                                                </span>
                                            )}
                                        </div>
                                        <div className="mt-1 flex flex-wrap items-center gap-2">
                                            <p data-testid="app-version" className="font-mono text-xs font-black text-slate-800 dark:text-slate-100">
                                                v{displayVersion}
                                            </p>
                                            {lastCheckLabel && (
                                                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-400">
                                                    <Clock size={10} /> Revisado {lastCheckLabel}
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    <div className="flex flex-wrap items-center gap-2">
                                        <button
                                            type="button"
                                            data-testid="lan-settings-open-center"
                                            onClick={() => triggerManualUpdateCheck()}
                                            className="px-3 py-2 min-h-[38px] rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-bold text-slate-600 dark:text-slate-300 transition-colors cursor-pointer whitespace-nowrap"
                                        >
                                            Ver detalles
                                        </button>
                                        <button
                                            type="button"
                                            data-testid="check-update"
                                            onClick={handleCheckUpdate}
                                            disabled={isBusy}
                                            className="flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded bg-brand hover:bg-brand-dark disabled:opacity-60 text-white text-[11px] font-black uppercase tracking-wider transition-all active:scale-95 cursor-pointer shadow-xs whitespace-nowrap"
                                        >
                                            <RefreshCw size={13} className={`shrink-0 ${isBusy ? 'animate-spin' : ''}`} />
                                            <span>{isBusy ? 'Buscando…' : 'Buscar actualizaciones'}</span>
                                        </button>
                                    </div>
                                </div>

                                {isDownloading && (
                                    <div className="space-y-1.5">
                                        <div className="flex items-center justify-between text-[11px] font-bold text-slate-600 dark:text-slate-300">
                                            <span>Descargando versión v{st?.availableVersion || 'nueva'}…</span>
                                            <span>{pct}%</span>
                                        </div>
                                        <div className="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                                            <div className="h-full bg-brand rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
                                        </div>
                                    </div>
                                )}

                                {isDownloaded && (
                                    <div className="rounded border border-emerald-300/80 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-950/30 p-3 space-y-2.5">
                                        <div className="flex items-start gap-2.5">
                                            <div className="p-1.5 rounded-sm bg-emerald-500 text-white shrink-0">
                                                <Rocket size={14} />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="text-xs font-black text-emerald-900 dark:text-emerald-200">
                                                    Nueva actualización lista: v{st?.availableVersion}
                                                </p>
                                                <p className="text-[11px] font-medium text-emerald-800/80 dark:text-emerald-300/80">
                                                    {desktopUpdatePostponed
                                                        ? 'La dejaste para más tarde. Se instalará al cerrar la app o cuando pulses Instalar ahorita.'
                                                        : 'Ya se descargó completa. Elige si quieres reiniciar ahorita o continuar trabajando.'}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap items-center justify-end gap-2">
                                            {!desktopUpdatePostponed && (
                                                <button
                                                    type="button"
                                                    data-testid="lan-settings-later-btn"
                                                    onClick={() => {
                                                        setDesktopUpdatePostponed(true);
                                                        showToast(`v${st?.availableVersion} se instalará más tarde`, 'info');
                                                    }}
                                                    className="px-3 py-1.5 min-h-[34px] rounded-sm border border-emerald-300 dark:border-emerald-700 bg-white/80 dark:bg-slate-900/80 hover:bg-white text-[11px] font-bold text-emerald-800 dark:text-emerald-200 cursor-pointer"
                                                >
                                                    Más tarde
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                data-testid="lan-settings-install-btn"
                                                onClick={handleInstallDesktopUpdate}
                                                disabled={installingDesktopUpdate}
                                                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 min-h-[34px] rounded-sm bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-[11px] font-black uppercase tracking-wider shadow-xs cursor-pointer"
                                            >
                                                <Download size={12} className="shrink-0" />
                                                {installingDesktopUpdate ? 'Reiniciando…' : 'Instalar ahorita (reiniciar)'}
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {!isDownloaded && st?.status === 'up-to-date' && (
                                    <p className="text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
                                        Ya tienes instalada la última versión disponible (v{displayVersion}).
                                    </p>
                                )}

                                {(st?.status === 'error' || st?.status === 'offline' || st?.status === 'unsupported') && st?.error && (
                                    <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                                        {st.error}
                                    </p>
                                )}
                            </div>
                        );
                    })() : (
                        <div className="mt-3 flex items-center justify-between gap-3 p-3 bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800 rounded">
                            <div className="min-w-0">
                                <p className="text-[11px] uppercase tracking-wider font-extrabold text-slate-500 dark:text-slate-400">Versión de la app</p>
                                <p data-testid="app-version" className="font-mono text-xs font-black text-slate-700 dark:text-slate-200">v{import.meta.env.VITE_APP_VERSION}</p>
                            </div>
                            <button
                                type="button"
                                data-testid="check-update"
                                onClick={handleCheckUpdate}
                                disabled={checkingUpdate}
                                className={`shrink-0 flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] rounded text-[11px] font-black uppercase tracking-wider transition-all active:scale-95 disabled:opacity-60 whitespace-nowrap ${updateReady ? 'bg-emerald-500 hover:bg-emerald-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-600'}`}
                            >
                                <RefreshCw size={13} className={`shrink-0 ${checkingUpdate ? 'animate-spin' : ''}`} />
                                {updateReady ? 'Actualizar ahora' : checkingUpdate ? 'Buscando…' : 'Buscar actualización'}
                            </button>
                        </div>
                    )}

                    {/* Dos equipos con el mismo ID: separar esta estación */}
                    <div className="mt-3 p-3.5 rounded border border-amber-200/70 dark:border-amber-800/40 bg-amber-50/50 dark:bg-amber-950/20">
                        <p className="text-[11px] font-bold text-amber-700 dark:text-amber-300 leading-snug">
                            ¿Dos equipos muestran el mismo ID? Genera uno propio y único para esta estación.
                        </p>
                        <button
                            onClick={() => { triggerHaptic?.(); setShowIdFixConfirm(true); }}
                            disabled={fixingId}
                            className="mt-2.5 w-full flex items-center justify-center gap-1.5 px-3.5 py-2.5 min-h-[44px] rounded bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white text-[11px] font-black uppercase tracking-wider transition-all"
                        >
                            <Fingerprint size={13} className="shrink-0" />
                            <span>{fixingId ? 'Generando ID único…' : 'Generar ID único para esta estación'}</span>
                        </button>
                        <p className="mt-1.5 text-[10px] text-amber-700/80 dark:text-amber-300/80">
                            No borra ventas, inventario ni la licencia actual; solo cambia el ID de esta estación.
                        </p>
                    </div>
                </SectionCard>
            </div>

            {/* Confirmación antes de cambiar el ID de la estación */}
            <ConfirmModal
                isOpen={showIdFixConfirm}
                onClose={() => setShowIdFixConfirm(false)}
                onConfirm={handleFixDuplicateId}
                variant="warning"
                title="¿Generar un ID nuevo para esta estación?"
                message={'Esta estación dejará de usar el ID actual y obtendrá uno propio y único.\n\nTus ventas, inventario y licencia no se borran: solo cambia el ID de esta estación.\n\nSi otra estación muestra el mismo ID, esa conserva el ID actual.'}
                confirmText="Sí, generar ID único"
                cancelText="Cancelar"
            />

            {/* Celular del Supervisor (QR Monitoreo). Nube: no existe; el dueño ve todo en su panel. */}
            {isAdmin && !isNubeAccountsEnabled() && (
                <div className="col-span-full">
                    <SectionCard icon={QrCode} title="Celular del Supervisor" subtitle="Monitoreo remoto en tiempo real" iconColor="text-emerald-500">
                        <PairingManager deviceId={deviceId} triggerHaptic={triggerHaptic} />
                    </SectionCard>
                </div>
            )}

            {/* Zona de Peligro — Habilitado para Administradores. Nube: no aparece. Los dos
                botones son de Bodega: «Borrar historial» borraba en el servidor el turno de esta
                caja (el libro de ventas lo conservaba) y «Empezar desde cero» borraba el
                catálogo y los clientes de toda la cuenta. */}
            {isAdmin && !isNubeAccountsEnabled() && (
                <div className="col-span-full">
                    <SectionCard icon={AlertTriangle} title="Zona de Peligro" subtitle="Acciones irreversibles" iconColor="text-red-500">
                        <div className="p-2.5 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800/30 rounded-xl mb-3">
                            <p className="text-xs text-red-750 dark:text-red-400 leading-relaxed font-bold">
                                Esta acción eliminará todo el historial de ventas y los reportes estadísticos. El inventario NO se verá afectado.
                            </p>
                        </div>
                        <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="w-full flex items-center gap-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors group active:scale-[0.98]"
                        >
                            <div className="p-2 bg-red-100 dark:bg-red-900/40 rounded-lg"><Trash2 size={18} className="text-red-600 dark:text-red-400" /></div>
                            <div className="text-left flex-1">
                                <p className="text-sm font-bold text-red-700 dark:text-red-400">Borrar historial de ventas</p>
                                <p className="text-xs text-red-500/80 dark:text-red-400/80">El inventario no se borra</p>
                            </div>
                        </button>
                        <button
                            onClick={() => { triggerHaptic?.(); setShowResetConfirm(true); }}
                            className="mt-2 w-full flex items-center gap-3 p-3 min-h-[56px] bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors group active:scale-[0.98]"
                        >
                            <div className="p-2 bg-red-100 dark:bg-red-900/40 rounded-lg"><AlertTriangle size={18} className="text-red-600 dark:text-red-400" /></div>
                            <div className="text-left flex-1">
                                <p className="text-sm font-bold text-red-700 dark:text-red-400">Empezar desde cero</p>
                                <p className="text-xs text-red-500/80 dark:text-red-400/80">Vacía este equipo y publica el vacío en la nube</p>
                            </div>
                        </button>
                    </SectionCard>
                </div>
            )}

            <ConfirmModal
                isOpen={showResetConfirm}
                onClose={() => setShowResetConfirm(false)}
                onConfirm={handleResetFromZero}
                variant="danger"
                title="¿Empezar desde cero?"
                message={'Se descartarán productos, ventas y clientes de ESTE equipo y se publicará un respaldo vacío en la nube.\n\nEsta acción no se puede deshacer.'}
                confirmText="Sí, vaciar todo"
                cancelText="Cancelar"
            />
        </div>
    );
}
