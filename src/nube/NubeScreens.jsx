/**
 * Pantallas de cuenta de Precios al Día Nube: acceso del dueño (entrar, crear cuenta,
 * recuperar la contraseña), crear el negocio, «Este equipo es…», «¿Quién está operando?»
 * y el panel del dueño. Solo presentación: la lógica vive en NubeGate y accountService.
 */
import { useEffect, useState } from 'react';
import {
    Loader2, UserPlus, Monitor, Smartphone, Trash2, KeyRound, ArrowLeft, Upload,
    Store, MapPin, Cloud, ShieldCheck, RotateCw, ChevronRight, Pencil, UserX, UserCheck, Crown, CheckCircle2, Download, LogOut, QrCode,
} from 'lucide-react';
import { NUBE_BRAND } from './brand';
import { isLanModeEnabled, getElectronUpdaterApi, triggerManualUpdateCheck } from '../lan/lanConfig';
import LoginAvatar from '../components/security/LoginAvatar';
import { CardBody, CardContainer, CardItem } from '../components/ui/3d-card';
import { toAppRole } from './accountService';
import { describeDeviceLocation, roleLabel } from './teamRules';
import NubeLogo from './NubeLogo';
import { MemberFormModal, PinChangeModal, ConfirmModal, TextPromptModal, NubeModal } from './NubeTeamUI';

export { NubeLogo };
export { OwnerAuthScreen, NewPasswordScreen, AuthLinkErrorScreen, EmailConfirmedScreen } from './NubeOwnerAuth';

const INPUT = 'w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 min-h-[48px] text-slate-800 dark:text-white outline-none focus:border-brand focus:ring-2 focus:ring-brand/25 transition-colors placeholder:text-slate-400';
const BTN = 'w-full rounded-xl bg-brand hover:bg-brand-dark disabled:opacity-60 text-white font-black py-3 min-h-[48px] flex items-center justify-center gap-2 transition-colors shadow-lg shadow-brand/20 active:scale-[0.99]';

function Glow() {
    return (
        <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
            <div className="absolute -top-[30%] -left-[15%] w-[600px] h-[600px] bg-brand/10 rounded-full blur-[120px]" />
            <div className="absolute -bottom-[30%] -right-[15%] w-[600px] h-[600px] bg-sky-400/10 rounded-full blur-[120px]" />
        </div>
    );
}

function Footer() {
    return (
        <p className="relative z-10 text-center text-[11px] text-slate-400 dark:text-slate-500 font-medium pt-6 flex items-center justify-center gap-1.5">
            <ShieldCheck size={12} /> Conexión cifrada · {NUBE_BRAND.name} v{import.meta.env.VITE_APP_VERSION}
        </p>
    );
}

/** Marco común: fondo, logo arriba y tarjeta con título. */
export function NubeShell({ title, subtitle, children, onBack, wide = false }) {
    return (
        <div className="relative min-h-[100dvh] flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 px-4 py-8 overflow-x-hidden">
            <Glow />
            <div className="relative z-10 mb-6"><NubeLogo className="h-12 sm:h-14" /></div>
            <div className={`relative z-10 w-full ${wide ? 'max-w-2xl' : 'max-w-md'} bg-white/95 dark:bg-slate-900/95 backdrop-blur rounded-3xl shadow-xl shadow-slate-900/5 border border-slate-200/70 dark:border-slate-800 p-6 sm:p-8`}>
                <div className="flex items-center gap-3 mb-2">
                    {onBack && (
                        <button type="button" onClick={onBack} aria-label="Volver" className="p-2 -ml-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500">
                            <ArrowLeft size={20} />
                        </button>
                    )}
                    <h1 className="text-xl font-black text-slate-800 dark:text-white leading-tight">{title}</h1>
                </div>
                {subtitle ? <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">{subtitle}</p> : <div className="mb-4" />}
                {children}
            </div>
            <Footer />
        </div>
    );
}

export function NubeError({ message }) {
    if (!message) return null;
    return <p role="alert" className="text-sm font-bold text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900/50 rounded-xl px-3 py-2 mb-4">{message}</p>;
}

export function NubeLoading({ text = 'Conectando con tu cuenta…' }) {
    return (
        <div className="relative min-h-[100dvh] flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 gap-6">
            <Glow />
            <div className="relative z-10"><NubeLogo className="h-12 sm:h-14" /></div>
            <div className="relative z-10 flex items-center gap-2 text-sm font-bold text-slate-500"><Loader2 className="animate-spin text-brand" size={20} />{text}</div>
        </div>
    );
}

function IconInput({ icon: Icon, right, ...props }) {
    return (
        <div className="relative">
            <Icon size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input {...props} className={`${INPUT} pl-11 ${right ? 'pr-12' : ''}`} />
            {right}
        </div>
    );
}

/** Dueño sin cuenta: crear el negocio, la primera sede y su PIN. */
export function CreateAccountScreen({ onSubmit, busy, error, onBack }) {
    const [form, setForm] = useState({ businessName: '', sedeName: 'Principal', ownerName: '', ownerPin: '', ownerPin2: '' });
    const [localError, setLocalError] = useState(null);
    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: k.startsWith('ownerPin') ? e.target.value.replace(/\D/g, '').slice(0, 32) : e.target.value }));
    const submit = (e) => {
        e.preventDefault();
        if (!/^[0-9]{6,32}$/.test(form.ownerPin)) { setLocalError('Tu PIN debe tener al menos 6 números.'); return; }
        if (form.ownerPin === '000000') { setLocalError('Elige un PIN distinto de 000000.'); return; }
        if (form.ownerPin !== form.ownerPin2) { setLocalError('Los PIN no coinciden'); return; }
        setLocalError(null);
        onSubmit(form);
    };
    return (
        <NubeShell title="Crea tu negocio" onBack={onBack} subtitle="Esto se hace una sola vez. Luego podrás sumar cajas, sedes y empleados.">
            <NubeError message={localError || error} />
            <form onSubmit={submit} className="space-y-3">
                <IconInput icon={Store} placeholder="Nombre del negocio" value={form.businessName} onChange={set('businessName')} required minLength={2} maxLength={80} />
                <IconInput icon={MapPin} placeholder="Nombre de la sede (ej. Centro)" value={form.sedeName} onChange={set('sedeName')} required maxLength={60} />
                <IconInput icon={Crown} placeholder="Tu nombre (así te verán en la caja)" value={form.ownerName} onChange={set('ownerName')} required maxLength={40} />
                <IconInput icon={KeyRound} inputMode="numeric" type="password" placeholder="Tu PIN (6 números o más)" value={form.ownerPin} onChange={set('ownerPin')} required />
                <IconInput icon={KeyRound} inputMode="numeric" type="password" placeholder="Repite tu PIN" value={form.ownerPin2} onChange={set('ownerPin2')} required />
                <button className={BTN} disabled={busy} type="submit">{busy && <Loader2 className="animate-spin" size={18} />}Crear negocio</button>
            </form>
        </NubeShell>
    );
}

/** «Este equipo es…»: nombre, si es caja o solo consulta, y sede. */
const lastSeen = (iso) => {
    if (!iso) return 'Sin conexión registrada';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `Última conexión: ${d.toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' })}`;
};

export function RegisterDeviceScreen({ account, sedes, devices = [], license = null, onRevoke, onSubmit, busy, error, onBack }) {
    const [label, setLabel] = useState('Caja');
    const [role, setRole] = useState('caja');
    const [sedeId, setSedeId] = useState(sedes?.[0]?.id ?? '');
    const [revoking, setRevoking] = useState(null);
    const submit = (e) => { e.preventDefault(); onSubmit({ label, role, sedeId: sedeId || null }); };
    const cajas = devices.filter((d) => d.role === 'caja').length;
    const cajasFull = Boolean(license?.max_cajas) && cajas >= license.max_cajas;
    const option = (value, Icon, title, text) => (
        <button type="button" onClick={() => setRole(value)}
            className={`flex-1 rounded-2xl border-2 p-3 text-left transition-colors ${role === value ? 'border-brand bg-brand-light' : 'border-slate-200 dark:border-slate-700'}`}>
            <Icon size={20} className="text-brand mb-1" />
            <p className="font-black text-sm text-slate-800 dark:text-white">{title}</p>
            <p className="text-xs text-slate-500">{text}</p>
        </button>
    );
    return (
        <NubeShell title="Este equipo es…" onBack={onBack} subtitle={account ? `Lo vas a sumar a «${account.name}».` : undefined}>
            <NubeError message={error} />
            <form onSubmit={submit} className="space-y-4">
                <div className="flex gap-3">
                    {option('caja', Monitor, 'Una caja', 'Vende y cobra. Cuenta para tu licencia.')}
                    {option('consulta', Smartphone, 'Solo consulta', 'Para el dueño. No ocupa caja.')}
                </div>
                <input className={INPUT} placeholder="Nombre (ej. Caja del frente)" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={40} />
                {sedes?.length > 1 && (
                    <select className={INPUT} value={sedeId} onChange={(e) => setSedeId(e.target.value)}>
                        {sedes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                )}
                {role === 'caja' && cajasFull && (
                    <p className="text-xs font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 rounded-xl px-3 py-2" role="status" data-testid="nube-register-full">
                        Tu licencia permite {license.max_cajas} caja(s) y ya están en uso. Desvincula una de abajo para registrar esta.
                    </p>
                )}
                <button className={BTN} disabled={busy} type="submit">{busy && <Loader2 className="animate-spin" size={18} />}Registrar este equipo</button>
            </form>

            {devices.length > 0 && (
                <div className="mt-6 border-t border-slate-100 dark:border-slate-800 pt-4" data-testid="nube-register-devices">
                    <h2 className="text-xs font-black uppercase tracking-widest text-slate-400 mb-2">
                        Equipos ya conectados{license?.max_cajas ? ` · ${cajas} de ${license.max_cajas} caja(s)` : ''}
                    </h2>
                    <ul className="space-y-2">
                        {devices.map((d) => (
                            <li key={d.id} className="flex items-center gap-3 rounded-xl border border-slate-100 dark:border-slate-800 px-3 py-2">
                                {d.role === 'caja' ? <Monitor size={18} className="text-brand shrink-0" /> : <Smartphone size={18} className="text-brand shrink-0" />}
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-black text-slate-800 dark:text-white truncate">{describeDeviceLocation({ device: d }).device}</p>
                                    <p className="text-[10px] text-slate-400 truncate">{d.role === 'caja' ? 'Caja' : 'Solo consulta'} · {lastSeen(d.last_seen_at)}</p>
                                </div>
                                {onRevoke && (
                                    <button type="button" disabled={busy} onClick={() => setRevoking(d)}
                                        className="text-xs font-bold text-red-500 hover:text-red-600 flex items-center gap-1 px-2 py-2 min-h-[40px]"
                                        aria-label={`Desvincular ${d.label}`}>
                                        <Trash2 size={14} />Desvincular
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {revoking && (
                <ConfirmModal danger title={`¿Desvincular «${revoking.label}»?`} confirmLabel="Desvincular" onClose={() => setRevoking(null)}
                    message="Ese equipo deja de sincronizar y de vender con esta cuenta, y se cierra la sesión abierta en él. Libera su caja. Para volver a usarlo habrá que registrarlo otra vez."
                    onConfirm={async () => { await onRevoke(revoking.id); setRevoking(null); }} />
            )}
        </NubeShell>
    );
}

// ─── «¿Quién está operando?» ─────────────────────────────────────────────────

// Borde animado del dueño y del administrador: el mismo de Bodega, en los azules de la nube.
const RING_ANIMATED = 'linear-gradient(180deg, rgb(110, 168, 255), rgb(43, 89, 195), rgb(140, 92, 255))';

const CARD_STYLE = {
    dueno: { animated: true, depth: 'bg-brand/20', glow: 'shadow-[0_0_20px_rgba(43,89,195,0.45)]', label: 'text-brand' },
    administrador: { animated: true, depth: 'bg-brand/20', glow: 'shadow-[0_0_20px_rgba(43,89,195,0.35)]', label: 'text-brand' },
    cajero: { animated: false, depth: 'bg-emerald-500/20', ring: 'bg-gradient-to-br from-emerald-500 to-teal-500 shadow-lg shadow-emerald-500/30', label: 'text-emerald-600' },
};

const titleCase = (s) => String(s || '').toLowerCase().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** Tarjeta 3D de empleado: la de Bodega/Farmacia, con la corona para el dueño. */
export function NubeMemberCard({ member, onClick }) {
    const style = CARD_STYLE[member.role] || CARD_STYLE.cajero;
    const avatar = <LoginAvatar user={{ nombre: member.display_name, rol: toAppRole(member.role) }} />;
    return (
        <button type="button" onClick={onClick} data-testid={`nube-member-${member.id}`} aria-label={`${member.display_name}, ${roleLabel(member.role)}`}
            className="cursor-pointer outline-none focus-visible:ring-4 focus-visible:ring-brand/30 rounded-3xl active:scale-95 transition-transform duration-200">
            <CardContainer className="inter-var py-0">
                <CardBody className="relative group/card w-auto h-auto rounded-xl p-0 border-transparent bg-transparent">
                    <CardItem translateZ="100" rotateX={10} rotateZ={-5} className="w-full flex justify-center">
                        <div className="relative">
                            <style>{'@keyframes nubeRingSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
                            <div className="absolute inset-0 bg-black/40 rounded-3xl translate-y-4 translate-x-4 blur-xl" />
                            <div className={`absolute inset-0 rounded-3xl translate-y-2 translate-x-1 ${style.depth}`} />
                            {member.role === 'dueno' && (
                                <div className="absolute -top-3 -left-3 z-50 animate-bounce duration-1000">
                                    <div className="bg-gradient-to-br from-yellow-300 to-amber-500 p-1.5 rounded-full shadow-[0_0_15px_rgba(251,191,36,0.6)] border border-yellow-100/50">
                                        <Crown size={20} className="text-yellow-900 fill-yellow-100" strokeWidth={2.5} />
                                    </div>
                                </div>
                            )}
                            {style.animated ? (
                                <div className={`relative z-10 p-[4px] rounded-2xl overflow-hidden flex justify-center items-center ${style.glow}`}>
                                    <div style={{ position: 'absolute', width: '200%', height: '200%', backgroundImage: RING_ANIMATED, animation: 'nubeRingSpin 3s linear infinite' }} />
                                    <div className="relative z-20 bg-slate-900 rounded-2xl">{avatar}</div>
                                </div>
                            ) : (
                                <div className={`relative z-10 p-[4px] rounded-2xl overflow-hidden flex justify-center items-center ${style.ring}`}>
                                    <div className="relative z-20 bg-slate-900 rounded-2xl">{avatar}</div>
                                </div>
                            )}
                        </div>
                    </CardItem>
                    <CardItem translateZ="60" className="text-center w-full mt-8 space-y-1">
                        <h3 className="text-lg font-bold text-slate-800 dark:text-white drop-shadow-sm max-w-[9rem] truncate mx-auto">{titleCase(member.display_name)}</h3>
                        <span className={`block text-[9px] font-black uppercase tracking-[0.2em] ${style.label}`}>{roleLabel(member.role)}</span>
                    </CardItem>
                </CardBody>
            </CardContainer>
        </button>
    );
}

function useNow(intervalMs = 15_000) {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), intervalMs);
        return () => clearInterval(t);
    }, [intervalMs]);
    return now;
}

/** Hora y fecha discretas, en la misma píldora que la versión. */
function Clock() {
    const now = useNow();
    const time = now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
    const date = now.toLocaleDateString('es-VE', { weekday: 'short', day: 'numeric', month: 'short' });
    return (
        <span className="hidden sm:inline text-[11px] font-black text-slate-500 dark:text-slate-400 tracking-wider tabular-nums" data-testid="nube-clock">
            <span className="opacity-40 mr-2">|</span>{time} · <span className="capitalize">{date}</span>
        </span>
    );
}

const isStandaloneApp = () => typeof window !== 'undefined'
    && Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator?.standalone === true);
const isIOSDevice = () => typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent || '');

/** Instalar como app (PWA): usa el aviso que guarda index.html en window.deferredInstallPrompt. */
function useInstallApp() {
    const [prompt, setPrompt] = useState(() => (typeof window !== 'undefined' ? window.deferredInstallPrompt : null) || null);
    const [standalone] = useState(isStandaloneApp);
    useEffect(() => {
        const handler = (e) => { e.preventDefault(); window.deferredInstallPrompt = e; setPrompt(e); };
        window.addEventListener('beforeinstallprompt', handler);
        return () => window.removeEventListener('beforeinstallprompt', handler);
    }, []);
    const install = async () => {
        const ev = prompt || window.deferredInstallPrompt;
        if (!ev) return 'help';
        try {
            ev.prompt();
            const { outcome } = await ev.userChoice;
            if (outcome === 'accepted') { window.deferredInstallPrompt = null; setPrompt(null); }
        } catch { /* el navegador ya no lo permite */ }
        return 'done';
    };
    return { standalone, install };
}

/** Elegir quién va a trabajar en este equipo: la pantalla de Bodega y Farmacia, en azul Nube. */
export function MemberPickerScreen({ status, members, onPick, onManage, onSignOutAccount, error }) {
    const loc = describeDeviceLocation(status);
    const { standalone, install } = useInstallApp();
    const [installHelp, setInstallHelp] = useState(false);
    const [confirmSignOut, setConfirmSignOut] = useState(false);
    const chips = [
        loc.business && { icon: Store, text: loc.business, testId: 'nube-loc-business' },
        loc.sede && { icon: MapPin, text: loc.sede, testId: 'nube-loc-sede' },
        loc.device && { icon: status?.device?.role === 'consulta' ? Smartphone : Monitor, text: loc.device, testId: 'nube-loc-device' },
    ].filter(Boolean);

    return (
        <div className="fixed inset-0 z-[250] bg-slate-50 dark:bg-slate-950 text-slate-800 font-sans overflow-y-auto overflow-x-hidden flex min-h-full flex-col" data-testid="nube-member-picker">
            <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
                <div className="absolute -top-[30%] -left-[15%] w-[600px] h-[600px] bg-sky-500/10 rounded-full blur-[120px]" />
                <div className="absolute -bottom-[30%] -right-[15%] w-[600px] h-[600px] bg-brand/10 rounded-full blur-[120px]" />
            </div>

            <header className="w-full px-4 sm:px-6 pt-[max(0.875rem,env(safe-area-inset-top))] pb-2 flex items-center justify-between gap-2 z-30 shrink-0">
                <div className="flex items-center gap-2 px-2.5 py-1 bg-slate-900/5 dark:bg-slate-100/10 border border-slate-900/10 dark:border-slate-100/10 rounded-xl backdrop-blur-md">
                    <Cloud size={12} className="text-brand" strokeWidth={2.5} />
                    <span className="text-[11px] font-black text-slate-500 dark:text-slate-400 tracking-wider">v{import.meta.env.VITE_APP_VERSION}</span>
                    <Clock />
                </div>
                <div className="flex items-center gap-2">
                    {onSignOutAccount && (
                        <button type="button" data-testid="nube-signout-account"
                            onClick={() => setConfirmSignOut(true)}
                            className="flex items-center gap-1.5 px-3 py-1.5 sm:px-3.5 sm:py-2 bg-white/85 dark:bg-slate-900/85 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-600 hover:border-rose-200 dark:hover:border-rose-900/50 border border-slate-200/80 dark:border-slate-800 text-slate-600 dark:text-slate-300 text-xs font-bold rounded-2xl shadow-xs backdrop-blur-md active:scale-95 transition-all cursor-pointer"
                            title="Cerrar sesión de la nube y volver al login con correo y contraseña">
                            <LogOut size={14} strokeWidth={2.2} />
                            <span className="sm:hidden">Salir</span>
                            <span className="hidden sm:inline">Cerrar sesión</span>
                        </button>
                    )}
                    {standalone ? (
                        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-brand/10 border border-brand/20 text-brand text-[10px] font-extrabold uppercase tracking-wider rounded-xl shadow-sm">
                            <CheckCircle2 size={13} />
                            <span>App Instalada</span>
                        </div>
                    ) : (
                        <button type="button" data-testid="nube-install"
                            onClick={async () => { if ((await install()) === 'help') setInstallHelp(true); }}
                            className="flex items-center gap-2 px-3.5 py-1.5 sm:px-4 sm:py-2 bg-brand hover:bg-brand-dark active:scale-95 text-white text-xs font-bold rounded-2xl shadow-lg shadow-brand/20 transition-all cursor-pointer"
                            title="Instalar como aplicación en este dispositivo">
                            <Download size={14} strokeWidth={2.5} />
                            <span>Instalar App</span>
                        </button>
                    )}
                </div>
            </header>

            <div className="relative z-10 flex flex-col items-center justify-center flex-1 px-4 sm:px-6 py-2 sm:py-6">
                <div className="text-center mb-8 sm:mb-14">
                    <div className="flex justify-center mb-4 sm:mb-6">
                        <NubeLogo className="h-16 sm:h-28 md:h-32 max-w-[270px] sm:max-w-none drop-shadow-md" />
                    </div>
                    <h1 className="text-xl sm:text-3xl font-light tracking-[0.15em] text-slate-600 dark:text-slate-300">
                        ¿Quién está{' '}
                        <strong className="text-slate-900 dark:text-white font-bold">operando</strong>?
                    </h1>
                    {chips.length > 0 && (
                        <div className="mt-3 sm:mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] sm:text-xs font-bold text-slate-500 dark:text-slate-400">
                            {chips.map(({ icon: Icon, text, testId }, i) => (
                                <span key={testId} className="inline-flex items-center gap-1.5">
                                    {i > 0 && <span className="opacity-40 mr-1.5">•</span>}
                                    <Icon size={13} className="text-brand" />
                                    <span data-testid={testId}>{text}</span>
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                {error && <div className="w-full max-w-md"><NubeError message={error} /></div>}

                {members.length ? (
                    <div className="w-full grid grid-cols-2 md:flex md:flex-row md:flex-wrap md:justify-center gap-8 sm:gap-14 max-w-[320px] md:max-w-5xl mx-auto">
                        {members.map((m) => <NubeMemberCard key={m.id} member={m} onClick={() => onPick(m)} />)}
                    </div>
                ) : (
                    <p className="text-sm text-slate-500">Todavía no hay empleados. El dueño los agrega abajo, en «Equipos y empleados».</p>
                )}
            </div>

            <footer className="relative z-10 shrink-0 pb-8 px-4 w-full flex flex-col items-center">
                <section aria-label="Administración de la cuenta"
                    className="max-w-md w-full bg-white/90 dark:bg-slate-900/90 rounded-3xl border border-slate-200/80 dark:border-slate-800 p-3.5 sm:p-4 shadow-sm backdrop-blur-md transition-all">
                    <button type="button" onClick={onManage} data-testid="nube-manage" className="w-full flex items-center justify-between gap-2 text-left group">
                        <div className="flex items-center gap-2 min-w-0">
                            <div className="p-1.5 rounded-xl bg-brand-light text-brand border border-brand/15 shadow-xs">
                                <KeyRound size={14} strokeWidth={2.5} />
                            </div>
                            <div className="min-w-0">
                                <h2 className="text-xs font-black tracking-wider text-slate-800 dark:text-slate-200 uppercase">Equipos y empleados</h2>
                                <p className="text-[10px] text-slate-400 font-medium">Administrar equipos y empleados · solo el dueño</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-brand-light text-brand border border-brand/20">
                                <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse" />{isLanModeEnabled() ? 'En red local' : 'En la nube'}
                            </span>
                            <ChevronRight size={15} className="text-slate-400 group-hover:translate-x-0.5 transition-transform" />
                        </div>
                    </button>
                </section>
                <div className="flex items-center justify-center gap-3 pt-3 text-[10px] text-slate-400 dark:text-slate-500 font-medium tracking-wide">
                    <span>Acceso con PIN</span>
                    <span className="opacity-40">•</span>
                    <button type="button" onClick={() => window.location.reload()} className="hover:text-slate-600 dark:hover:text-slate-300 transition-colors inline-flex items-center gap-1 font-semibold cursor-pointer">
                        <RotateCw size={10} strokeWidth={2.5} />Recargar
                    </button>
                    {getElectronUpdaterApi() && (
                        <>
                            <span className="opacity-40">•</span>
                            <button
                                type="button"
                                data-testid="lan-check-updates-btn"
                                onClick={() => triggerManualUpdateCheck()}
                                className="hover:text-slate-600 dark:hover:text-slate-300 transition-colors inline-flex items-center gap-1 font-semibold cursor-pointer"
                            >
                                <Download size={10} strokeWidth={2.5} />Buscar actualización
                            </button>
                        </>
                    )}
                </div>
            </footer>

            {confirmSignOut && (
                <ConfirmModal danger title="¿Cerrar sesión de la nube?" confirmLabel="Cerrar sesión" onClose={() => setConfirmSignOut(false)}
                    message={`Se cerrará la sesión de «${loc.business || 'esta cuenta'}» en este equipo para salir al inicio con correo y contraseña. Tus datos en la nube no se pierden; la copia local de este equipo se limpiará para no mezclar cuentas.`}
                    onConfirm={async () => { await onSignOutAccount(); setConfirmSignOut(false); }} />
            )}
            {installHelp && (
                <NubeModal title="Instalar la app en este equipo" onClose={() => setInstallHelp(false)} testId="nube-install-help">
                    {isIOSDevice() ? (
                        <ol className="text-sm text-slate-600 dark:text-slate-300 space-y-2 list-decimal pl-5">
                            <li>Toca el botón <strong>Compartir</strong> de Safari (el cuadro con la flecha hacia arriba).</li>
                            <li>Elige <strong>Agregar a inicio</strong>.</li>
                            <li>Toca <strong>Agregar</strong>. La app quedará en tu pantalla de inicio.</li>
                        </ol>
                    ) : (
                        <ol className="text-sm text-slate-600 dark:text-slate-300 space-y-2 list-decimal pl-5">
                            <li>Abre el menú del navegador (<strong>⋮</strong> arriba a la derecha en Chrome o Edge).</li>
                            <li>Elige <strong>Instalar Precios al Día Nube</strong> o <strong>Instalar app</strong>.</li>
                            <li>Si no aparece, busca el ícono de instalar en la barra de direcciones.</li>
                        </ol>
                    )}
                </NubeModal>
            )}
        </div>
    );
}

// ─── Panel del dueño ─────────────────────────────────────────────────────────

/**
 * Panel del dueño: equipos (renombrar, expulsar), empleados (agregar, editar, cambiar PIN,
 * desactivar) y su propio PIN. Las acciones de los modales lanzan si fallan (el modal muestra el error).
 */
export function ManagePanel({
    license, devices, members, summary, currentDeviceId, onRename, onRevoke, onSaveMember, onSetOwnerPin,
    onImport, importInfo, onOpenLanPairing, onClose, busy, error,
}) {
    const [modal, setModal] = useState(null);
    const close = () => setModal(null);
    const done = (fn) => async (...args) => { await fn(...args); close(); };
    const cajas = devices.filter((d) => d.role === 'caja').length;
    const activeMembers = members.filter((m) => m.active !== false);
    const inactiveMembers = members.filter((m) => m.active === false);

    const memberRow = (m) => (
        <li key={m.id} className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${m.active === false ? 'border-dashed border-slate-200 dark:border-slate-700 opacity-70' : 'border-slate-100 dark:border-slate-800'}`}>
            <LoginAvatar user={{ nombre: m.display_name, rol: toAppRole(m.role) }} size="sm" />
            <div className="flex-1 min-w-0">
                <p className="text-sm font-black text-slate-800 dark:text-white truncate">{m.display_name}</p>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{roleLabel(m.role)}{m.active === false ? ' · desactivado' : ''}</p>
            </div>
            {m.role === 'dueno' ? (
                onSetOwnerPin && (
                    <button type="button" disabled={busy} className="text-xs font-bold text-brand flex items-center gap-1" onClick={() => setModal({ kind: 'ownerpin' })} data-testid="nube-owner-pin">
                        <KeyRound size={14} />Mi PIN
                    </button>
                )
            ) : (
                <div className="flex items-center gap-1">
                    {m.active !== false && (
                        <>
                            <button type="button" disabled={busy} className="p-2 text-slate-500 hover:text-brand" title="Cambiar PIN" aria-label={`Cambiar PIN de ${m.display_name}`}
                                onClick={() => setModal({ kind: 'pin', member: m })}><KeyRound size={16} /></button>
                            <button type="button" disabled={busy} className="p-2 text-slate-500 hover:text-brand" title="Editar" aria-label={`Editar a ${m.display_name}`}
                                onClick={() => setModal({ kind: 'edit', member: m })}><Pencil size={16} /></button>
                        </>
                    )}
                    <button type="button" disabled={busy} className={`p-2 ${m.active === false ? 'text-emerald-600' : 'text-rose-500'}`}
                        title={m.active === false ? 'Reactivar' : 'Desactivar'} aria-label={`${m.active === false ? 'Reactivar' : 'Desactivar'} a ${m.display_name}`}
                        onClick={() => setModal({ kind: 'toggle', member: m })}>{m.active === false ? <UserCheck size={16} /> : <UserX size={16} />}</button>
                </div>
            )}
        </li>
    );

    return (
        <NubeShell title="Equipos y empleados" onBack={onClose} wide
            subtitle={license ? `Licencia: ${cajas} de ${license.max_cajas} caja(s) en uso · ${license.status === 'trial' ? 'prueba' : license.status}` : undefined}>
            <NubeError message={error} />
            <DaySummary rows={summary} />
            <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-black uppercase tracking-widest text-slate-400">Equipos</h2>
                {onOpenLanPairing && (
                    <button type="button" disabled={busy} onClick={onOpenLanPairing} data-testid="lan-open-pairing"
                        className="text-xs font-black text-brand flex items-center gap-1">
                        <QrCode size={14} />Conectar caja / Respaldo
                    </button>
                )}
            </div>
            <ul className="space-y-2 mb-6">
                {devices.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 rounded-xl border border-slate-100 dark:border-slate-800 px-3 py-2">
                        {d.role === 'caja' ? <Monitor size={18} className="text-brand" /> : <Smartphone size={18} className="text-brand" />}
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-black text-slate-800 dark:text-white truncate">
                                {describeDeviceLocation({ device: d }).device}{d.id === currentDeviceId ? ' (este)' : ''}
                            </p>
                            <p className="text-[10px] text-slate-400 font-mono truncate">{d.id}</p>
                        </div>
                        <button type="button" disabled={busy} className="text-xs font-bold text-brand" onClick={() => setModal({ kind: 'rename', device: d })}>Renombrar</button>
                        <button type="button" disabled={busy} aria-label="Expulsar" className="p-1 text-red-500" onClick={() => setModal({ kind: 'revoke', device: d })}><Trash2 size={16} /></button>
                    </li>
                ))}
            </ul>
            <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-black uppercase tracking-widest text-slate-400">Empleados</h2>
                <button type="button" disabled={busy} onClick={() => setModal({ kind: 'create' })} data-testid="nube-manage-add"
                    className="text-xs font-black text-brand flex items-center gap-1"><UserPlus size={14} />Agregar</button>
            </div>
            <ul className="space-y-2 mb-2">{activeMembers.map(memberRow)}</ul>
            {inactiveMembers.length > 0 && (
                <>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-4 mb-2">Desactivados</p>
                    <ul className="space-y-2">{inactiveMembers.map(memberRow)}</ul>
                </>
            )}
            {onImport && (
                <div className="mt-6 border-t border-slate-100 dark:border-slate-800 pt-4">
                    <h2 className="text-xs font-black uppercase tracking-widest text-slate-400 mb-2">Traer datos de Precios al Día</h2>
                    <p className="text-xs text-slate-500 mb-2">Sube el archivo de «Exportar respaldo» de tu Precios al Día actual: productos (con su stock), clientes (con su deuda o saldo a favor), proveedores, métodos de pago y categorías.</p>
                    {importInfo && <p className="text-sm font-bold text-brand bg-brand-light rounded-xl px-3 py-2 mb-2" role="status">{importInfo}</p>}
                    <label className={`${BTN} cursor-pointer`}>
                        <Upload size={18} />Elegir archivo de respaldo
                        <input type="file" accept=".json,application/json" className="hidden" disabled={busy}
                            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImport(f); }} />
                    </label>
                </div>
            )}

            {modal?.kind === 'create' && (
                <MemberFormModal roles={['cajero', 'administrador']} onClose={close} onSubmit={done(onSaveMember)} />
            )}
            {modal?.kind === 'edit' && (
                <MemberFormModal member={modal.member} roles={['cajero', 'administrador']} onClose={close} onSubmit={done(onSaveMember)} />
            )}
            {modal?.kind === 'pin' && (
                <PinChangeModal title={`PIN de ${modal.member.display_name}`} role={modal.member.role} onClose={close}
                    subtitle="Dale el PIN nuevo en persona. Vale en todas las cajas."
                    onSubmit={done(({ pin }) => onSaveMember({ id: modal.member.id, name: modal.member.display_name, role: modal.member.role, pin }))} />
            )}
            {modal?.kind === 'ownerpin' && (
                <PinChangeModal title="Tu PIN de dueño" role="dueno" onClose={close}
                    subtitle="Úsalo si olvidaste tu PIN o quieres cambiarlo. También te desbloquea."
                    onSubmit={done(({ pin }) => onSetOwnerPin(pin))} />
            )}
            {modal?.kind === 'toggle' && (
                <ConfirmModal danger={modal.member.active !== false}
                    title={modal.member.active === false ? `¿Reactivar a ${modal.member.display_name}?` : `¿Desactivar a ${modal.member.display_name}?`}
                    message={modal.member.active === false
                        ? 'Podrá volver a entrar con su PIN de antes.'
                        : 'Ya no podrá entrar en ninguna caja y se cierra su sesión si está abierta. Sus ventas quedan en el historial.'}
                    confirmLabel={modal.member.active === false ? 'Reactivar' : 'Desactivar'} onClose={close}
                    onConfirm={done(() => onSaveMember({ id: modal.member.id, name: modal.member.display_name, role: modal.member.role, active: modal.member.active === false }))} />
            )}
            {modal?.kind === 'rename' && (
                <TextPromptModal title="Renombrar equipo" label="Nombre del equipo" initial={modal.device.label} onClose={close}
                    onSubmit={done((label) => onRename(modal.device.id, label))} />
            )}
            {modal?.kind === 'revoke' && (
                <ConfirmModal danger title={`¿Expulsar «${modal.device.label}»?`} confirmLabel="Expulsar" onClose={close}
                    message="Dejará de poder vender y liberará su caja. Para volver a usarlo habrá que registrarlo otra vez."
                    onConfirm={done(() => onRevoke(modal.device.id))} />
            )}
        </NubeShell>
    );
}

const usd = (n) => `$${(Number(n) || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** F5: hoy en todas las cajas, por sede y en total (lo calcula el servidor). */
export function DaySummary({ rows }) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const total = rows.reduce((t, r) => ({
        ventas: t.ventas + (r.ventas || 0), ventas_usd: t.ventas_usd + Number(r.ventas_usd || 0),
        cobros_usd: t.cobros_usd + Number(r.cobros_usd || 0), egresos_usd: t.egresos_usd + Number(r.egresos_usd || 0),
    }), { ventas: 0, ventas_usd: 0, cobros_usd: 0, egresos_usd: 0 });
    const abiertas = rows.filter((r) => r.caja_abierta).map((r) => `Caja ${r.caja_letter}`);
    return (
        <div className="mb-6" data-testid="nube-day-summary">
            <h2 className="text-xs font-black uppercase tracking-widest text-slate-400 mb-2">Hoy en todas las cajas</h2>
            {abiertas.length > 0 && (
                <p className="text-xs font-bold text-amber-700 bg-amber-50 dark:bg-amber-950/40 rounded-lg px-2 py-1 mb-2">Siguen abiertas: {abiertas.join(', ')}</p>
            )}
            <table className="w-full text-xs">
                <thead><tr className="text-slate-400 text-left"><th className="py-1">Caja</th><th>Ventas</th><th className="text-right">Vendido</th><th className="text-right">Cobros</th><th className="text-right">Egresos</th></tr></thead>
                <tbody>
                    {rows.map((r) => (
                        <tr key={r.device_id} className="border-t border-slate-100 dark:border-slate-800 text-slate-700 dark:text-slate-200">
                            <td className="py-1 font-bold">{r.caja_letter} <span className="text-slate-400 font-normal">· {r.sede_name}</span></td>
                            <td>{r.ventas}</td>
                            <td className="text-right">{usd(r.ventas_usd)}</td>
                            <td className="text-right">{usd(r.cobros_usd)}</td>
                            <td className="text-right">{usd(r.egresos_usd)}</td>
                        </tr>
                    ))}
                    <tr className="border-t-2 border-slate-200 dark:border-slate-700 font-black text-slate-800 dark:text-white">
                        <td className="py-1">Total</td><td>{total.ventas}</td>
                        <td className="text-right">{usd(total.ventas_usd)}</td><td className="text-right">{usd(total.cobros_usd)}</td><td className="text-right">{usd(total.egresos_usd)}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}
