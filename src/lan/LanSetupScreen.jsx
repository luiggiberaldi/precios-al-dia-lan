/**
 * Pantalla de configuración de red local (LAN):
 *
 *   · En Electron sin rol elegido: permite escoger si esta PC será la Caja Principal
 *     (servidor del local) o una Caja adicional.
 *   · Para cajas adicionales (Electron, Android o navegador): busca servidores en la red
 *     o permite ingresar la dirección IP/puerto de la Caja Principal y probar la conexión.
 */
import { useEffect, useRef, useState } from 'react';
import { Monitor, Wifi, Server, Search, CheckCircle2, ArrowRight, Loader2, ArrowLeft, Globe } from 'lucide-react';
import { NubeShell, NubeError } from '../nube/NubeScreens';
import {
    DEFAULT_LAN_PORT,
    getElectronLanApi,
    getLanServerUrl,
    normalizeLanUrl,
    setLanServerId,
    setLanServerUrl,
} from './lanConfig';
import { probeLanServer } from './lanClient';
import { createCloudSupervisorClient, getLanCloudBridgeConfig } from './cloudSupervisorClient';

function readCloudQueryFlag() {
    try {
        return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('supervisor') === 'cloud';
    } catch {
        return false;
    }
}

export default function LanSetupScreen({ onConfigured, onCloudSupervisorLogin, initialError = null }) {
    const electronLan = getElectronLanApi();
    const envCloud = getLanCloudBridgeConfig();
    const [step, setStep] = useState(() => (electronLan ? 'role' : readCloudQueryFlag() ? 'cloud' : 'connect'));
    const [url, setUrl] = useState(() => getLanServerUrl() || '');
    const [discovered, setDiscovered] = useState([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(initialError);
    const [foundInfo, setFoundInfo] = useState(null);
    const [cloudForm, setCloudForm] = useState({
        url: envCloud.url || '',
        key: envCloud.key || '',
        code: '',
        pin: '',
    });

    const chooseMaster = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await electronLan.setMasterMode({ port: DEFAULT_LAN_PORT });
            if (!res?.ok || !res?.serverUrl) {
                throw new Error(res?.error || 'No se pudo iniciar el servidor local.');
            }
            if (typeof window !== 'undefined' && res.localAdminSecret) {
                window.__PDN_LAN_LOCAL_SECRET__ = res.localAdminSecret;
            }
            const clean = setLanServerUrl(res.serverUrl, 'master');
            onConfigured(clean, 'master');
        } catch (err) {
            setError(err?.message || 'No se pudo activar la Caja Principal.');
        } finally {
            setBusy(false);
        }
    };

    const discover = async () => {
        if (!electronLan?.discoverServers) return;
        setBusy(true);
        setError(null);
        try {
            const list = await electronLan.discoverServers();
            setDiscovered(Array.isArray(list) ? list : []);
            if (!list?.length) {
                setError('No encontramos ninguna Caja Principal automáticamente. Escribe su dirección IP abajo.');
            }
        } catch (err) {
            setError(err?.message || 'No se pudo buscar en la red.');
        } finally {
            setBusy(false);
        }
    };

    const autoDiscoveredRef = useRef(false);
    const discoverRef = useRef(null);
    discoverRef.current = discover;

    useEffect(() => {
        if (step !== 'connect') {
            autoDiscoveredRef.current = false;
            return;
        }
        if (autoDiscoveredRef.current || !electronLan?.discoverServers) return;
        autoDiscoveredRef.current = true;
        discoverRef.current?.();
    }, [step, electronLan]);

    const connectToUrl = async (rawTarget) => {
        setBusy(true);
        setError(null);
        setFoundInfo(null);
        try {
            const probe = await probeLanServer(rawTarget);
            setFoundInfo(probe);
            if (electronLan?.setClientMode) {
                await electronLan.setClientMode({ serverUrl: probe.baseUrl });
            }
            const clean = setLanServerUrl(probe.baseUrl, 'client');
            if (probe?.lanId) setLanServerId(probe.lanId);
            onConfigured(clean, 'client', probe);
        } catch (err) {
            setError(err?.message || 'No pudimos conectarnos a esa dirección.');
        } finally {
            setBusy(false);
        }
    };

    const connectCloudSupervisor = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const sup = createCloudSupervisorClient({ url: cloudForm.url, key: cloudForm.key });
            const session = await sup.login(cloudForm.code, cloudForm.pin);
            onCloudSupervisorLogin?.({ ...session, key: cloudForm.key });
        } catch (err) {
            setError(err?.message || 'No se pudo entrar al Modo Supervisor por internet.');
        } finally {
            setBusy(false);
        }
    };

    if (step === 'cloud') {
        return (
            <NubeShell
                title="Modo Supervisor (Internet)"
                subtitle="Entra desde tu celular (Android / iOS) o PC usando el código generado en la Caja Principal."
                onBack={() => { setError(null); setStep(electronLan ? 'role' : 'connect'); }}
            >
                <NubeError message={error} />
                <form onSubmit={connectCloudSupervisor} className="space-y-3" data-testid="lan-cloud-login-form">
                    {!envCloud.available && (
                        <>
                            <input
                                type="url"
                                required
                                value={cloudForm.url}
                                onChange={(e) => setCloudForm((f) => ({ ...f, url: e.target.value }))}
                                placeholder="URL de Supabase puente"
                                className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 text-xs font-mono"
                            />
                            <input
                                type="text"
                                required
                                value={cloudForm.key}
                                onChange={(e) => setCloudForm((f) => ({ ...f, key: e.target.value }))}
                                placeholder="Llave anon pública"
                                className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 text-xs font-mono"
                            />
                        </>
                    )}
                    <input
                        type="text"
                        required
                        value={cloudForm.code}
                        onChange={(e) => setCloudForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                        placeholder="Código del negocio (ej. SUP-482910)"
                        data-testid="lan-cloud-code-input"
                        className="w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-sm font-mono font-bold uppercase outline-none focus:border-brand"
                    />
                    <input
                        type="password"
                        inputMode="numeric"
                        required
                        value={cloudForm.pin}
                        onChange={(e) => setCloudForm((f) => ({ ...f, pin: e.target.value.replace(/\D/g, '') }))}
                        placeholder="PIN de dueño"
                        data-testid="lan-cloud-pin-input"
                        className="w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-sm font-bold outline-none focus:border-brand"
                    />
                    <button
                        type="submit"
                        disabled={busy || !cloudForm.url || !cloudForm.key || !cloudForm.code || !cloudForm.pin}
                        data-testid="lan-cloud-login-submit"
                        className="w-full rounded-xl bg-brand hover:bg-brand-dark disabled:opacity-60 text-white font-black py-3 flex items-center justify-center gap-2 shadow-lg shadow-brand/20"
                    >
                        {busy ? <Loader2 size={18} className="animate-spin" /> : (
                            <>
                                <Globe size={16} />
                                <span>Entrar como Supervisor</span>
                            </>
                        )}
                    </button>
                </form>
            </NubeShell>
        );
    }

    if (step === 'role' && electronLan) {
        return (
            <NubeShell
                title="Precios al Día en Red Local"
                subtitle="Elige qué papel cumple esta computadora dentro del negocio."
            >
                <NubeError message={error} />
                <div className="space-y-3" data-testid="lan-role-picker">
                    <button
                        type="button"
                        disabled={busy}
                        onClick={chooseMaster}
                        data-testid="lan-choose-master"
                        className="w-full text-left rounded-2xl border-2 border-brand/30 bg-brand-light/40 hover:border-brand p-4 transition-all flex items-start gap-3"
                    >
                        <div className="p-2.5 rounded-xl bg-brand text-white shrink-0">
                            {busy ? <Loader2 size={20} className="animate-spin" /> : <Server size={20} />}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="font-black text-slate-800 dark:text-white text-sm">
                                Esta PC es la Caja Principal (Servidor)
                            </p>
                            <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                                Guarda el inventario, las ventas y los fiados de todo el local. Debe permanecer encendida mientras otras cajas vendan.
                            </p>
                        </div>
                    </button>

                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => { setError(null); setStep('connect'); }}
                        data-testid="lan-choose-client"
                        className="w-full text-left rounded-2xl border-2 border-slate-200 dark:border-slate-700 hover:border-brand p-4 transition-all flex items-start gap-3"
                    >
                        <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-brand shrink-0">
                            <Monitor size={20} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="font-black text-slate-800 dark:text-white text-sm">
                                Esta PC es una Caja adicional
                            </p>
                            <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                                Se conecta por Wi-Fi o cable a la Caja Principal del local para compartir el mismo stock y clientes.
                            </p>
                        </div>
                    </button>
                </div>
            </NubeShell>
        );
    }

    return (
        <NubeShell
            title="Conectar a la Caja Principal"
            subtitle="Asegúrate de estar en el mismo Wi-Fi o cable de red que la Caja Principal."
            onBack={electronLan ? () => { setError(null); setStep('role'); } : undefined}
        >
            <NubeError message={error} />

            {electronLan?.discoverServers && (
                <div className="mb-4">
                    <button
                        type="button"
                        disabled={busy}
                        onClick={discover}
                        data-testid="lan-discover-btn"
                        className="w-full rounded-xl border-2 border-brand/30 bg-brand-light/40 hover:bg-brand-light text-brand font-black py-2.5 px-4 text-sm flex items-center justify-center gap-2 transition-colors"
                    >
                        {busy ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                        Buscar Caja Principal en la red
                    </button>

                    {discovered.length > 0 && (
                        <ul className="mt-3 space-y-2" data-testid="lan-discovered-list">
                            {discovered.map((srv) => (
                                <li key={srv.url}>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => connectToUrl(srv.url)}
                                        className="w-full rounded-xl border border-slate-200 dark:border-slate-700 hover:border-brand px-3 py-2.5 text-left flex items-center justify-between gap-2"
                                    >
                                        <div className="min-w-0">
                                            <p className="text-sm font-black text-slate-800 dark:text-white truncate">{srv.businessName}</p>
                                            <p className="text-xs text-slate-400 font-mono truncate">{srv.url}</p>
                                        </div>
                                        <Wifi size={16} className="text-brand shrink-0" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    connectToUrl(url);
                }}
                className="space-y-3"
                data-testid="lan-connect-form"
            >
                <label className="block text-xs font-bold text-slate-500">
                    Dirección de la Caja Principal (IP y puerto)
                </label>
                <input
                    type="text"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder={`Ej. 192.168.1.50:${DEFAULT_LAN_PORT}`}
                    data-testid="lan-server-url-input"
                    required
                    className="w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-sm font-mono text-slate-800 dark:text-white outline-none focus:border-brand"
                />

                {foundInfo && (
                    <div className="flex items-center gap-2 text-xs font-bold text-emerald-700 bg-emerald-50 rounded-xl px-3 py-2">
                        <CheckCircle2 size={15} />
                        <span>Conectado a {foundInfo.businessName || normalizeLanUrl(url)}</span>
                    </div>
                )}

                <button
                    type="submit"
                    disabled={busy || !url.trim()}
                    data-testid="lan-connect-submit"
                    className="w-full rounded-xl bg-brand hover:bg-brand-dark disabled:opacity-60 text-white font-black py-3 flex items-center justify-center gap-2 shadow-lg shadow-brand/20"
                >
                    {busy ? <Loader2 size={18} className="animate-spin" /> : (
                        <>
                            <span>Conectar</span>
                            <ArrowRight size={16} />
                        </>
                    )}
                </button>
            </form>

            {electronLan && (
                <button
                    type="button"
                    onClick={() => setStep('role')}
                    className="w-full mt-3 py-2 text-xs font-bold text-slate-400 hover:text-slate-600 flex items-center justify-center gap-1"
                >
                    <ArrowLeft size={13} /> Volver a elegir papel del equipo
                </button>
            )}
            {onCloudSupervisorLogin && !electronLan && (
                <button
                    type="button"
                    data-testid="lan-open-cloud-supervisor"
                    onClick={() => { setError(null); setStep('cloud'); }}
                    className="w-full mt-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-black text-brand hover:bg-brand-light/40 flex items-center justify-center gap-1.5"
                >
                    <Globe size={14} /> ¿Fuera del local? Entrar como Supervisor por internet
                </button>
            )}
        </NubeShell>
    );
}
