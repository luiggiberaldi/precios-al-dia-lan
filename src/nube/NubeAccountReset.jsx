/**
 * Ajustes → Sistema (solo en Precios al Día Nube y solo para el dueño):
 * «Reiniciar la cuenta», el reinicio de fábrica de TODAS las cajas (accountReset.js).
 * Pide el correo y la contraseña del dueño: el servidor solo lo acepta con esa sesión.
 */
import { useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { SectionCard } from '../components/SettingsShared';
import { getDeviceClient, createOwnerClient } from './nubeSupabase';
import { ownerResetAccount, ownerPinResetAccount } from './accountReset';
import { readMemberSession, clearMemberSession } from './memberSession';
import { isLanModeEnabled } from '../lan/lanConfig';

const BORRA = ['Productos, categorías y stock de todas las sedes', 'Clientes con sus deudas y saldos a favor', 'Proveedores',
    'Ventas, cierres y movimientos de caja de todas las cajas', 'Diferencias de stock pendientes', 'La numeración de ventas (vuelve a #A-00001)'];
const QUEDA = ['La cuenta y la licencia', 'Las sedes y los equipos registrados', 'Los empleados con sus PIN', 'Los métodos de pago y la tasa del día'];

export function isOwnerHere(session = readMemberSession()) {
    return session?.role === 'dueno';
}

export default function NubeAccountReset({ deps = {} }) {
    const {
        deviceClient = getDeviceClient(),
        makeOwnerClient = createOwnerClient,
        reset = ownerResetAccount,
        resetWithPin = ownerPinResetAccount,
        lanMode = isLanModeEnabled(),
        reload = () => window.location.reload(),
    } = deps;
    const [open, setOpen] = useState(false);
    const [authMode, setAuthMode] = useState(() => (lanMode ? 'pin' : 'password'));
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [ownerPin, setOwnerPin] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const close = () => { setOpen(false); setPassword(''); setOwnerPin(''); setError(null); };

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            if (lanMode && authMode === 'pin') {
                await resetWithPin({ deviceClient, ownerClient: makeOwnerClient(), pin: ownerPin });
            } else {
                await reset({ deviceClient, ownerClient: makeOwnerClient(), email, password });
            }
            clearMemberSession();
            reload();
        } catch (err) {
            setError(err?.message || 'No se pudo reiniciar la cuenta.');
            setBusy(false);
        }
    };

    return (
        <div className="col-span-full" data-testid="nube-account-reset">
            <SectionCard icon={AlertTriangle} title="Reiniciar la cuenta" subtitle="Deja vacías TODAS las cajas del negocio" iconColor="text-red-500">
                {!open ? (
                    <button type="button" onClick={() => setOpen(true)} data-testid="nube-reset-open"
                        className="w-full flex items-center gap-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-xl hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-[0.98]">
                        <div className="p-2 bg-red-100 dark:bg-red-900/40 rounded-lg"><RotateCcw size={18} className="text-red-600 dark:text-red-400" /></div>
                        <div className="text-left flex-1">
                            <p className="text-sm font-bold text-red-700 dark:text-red-400">Reiniciar la cuenta (todas las cajas)</p>
                            <p className="text-xs text-red-500/80 dark:text-red-400/80">Como recién instalada. No se puede deshacer desde la app.</p>
                        </div>
                    </button>
                ) : (
                    <form onSubmit={submit} className="space-y-3" data-testid="nube-reset-form">
                        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-xl space-y-2" role="alert">
                            <p className="text-sm font-black text-red-700 dark:text-red-300">Esto afecta a TODAS las cajas y sedes, no solo a esta.</p>
                            <div>
                                <p className="text-xs font-bold text-red-700 dark:text-red-300">Se borra:</p>
                                <ul className="text-xs text-red-700/90 dark:text-red-300/90 list-disc pl-4">{BORRA.map((t) => <li key={t}>{t}</li>)}</ul>
                            </div>
                            <div>
                                <p className="text-xs font-bold text-slate-700 dark:text-slate-200">Se conserva:</p>
                                <ul className="text-xs text-slate-600 dark:text-slate-300 list-disc pl-4">{QUEDA.map((t) => <li key={t}>{t}</li>)}</ul>
                            </div>
                            <p className="text-xs text-red-700/90 dark:text-red-300/90">
                                Cada caja se vacía al recibir el aviso o al volver a tener internet. Lo que una caja tenga sin subir se descarta.
                                Todos deberán volver a entrar con su PIN. Si quieres una copia, descarga antes un respaldo.
                            </p>
                        </div>
                        {lanMode && (
                            <div className="flex gap-2 text-xs font-bold">
                                <button type="button" onClick={() => setAuthMode('pin')}
                                    className={`flex-1 py-1.5 rounded-lg border ${authMode === 'pin' ? 'bg-red-50 border-red-300 text-red-700' : 'border-slate-200 text-slate-500'}`}>
                                    PIN de dueño (LAN local)
                                </button>
                                <button type="button" onClick={() => setAuthMode('password')}
                                    className={`flex-1 py-1.5 rounded-lg border ${authMode === 'password' ? 'bg-red-50 border-red-300 text-red-700' : 'border-slate-200 text-slate-500'}`}>
                                    Correo y contraseña
                                </button>
                            </div>
                        )}
                        {lanMode && authMode === 'pin' ? (
                            <>
                                <p className="text-xs font-bold text-slate-600 dark:text-slate-300">Confirma con tu PIN de dueño (Caja Principal):</p>
                                <input type="password" inputMode="numeric" autoComplete="off" placeholder="PIN de dueño (6 dígitos)" value={ownerPin} onChange={(e) => setOwnerPin(e.target.value)}
                                    data-testid="nube-reset-pin" disabled={busy}
                                    className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 text-sm" />
                            </>
                        ) : (
                            <>
                                <p className="text-xs font-bold text-slate-600 dark:text-slate-300">Confirma con tu correo y contraseña de dueño:</p>
                                <input type="email" autoComplete="username" placeholder="Correo del dueño" value={email} onChange={(e) => setEmail(e.target.value)}
                                    data-testid="nube-reset-email" disabled={busy}
                                    className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 text-sm" />
                                <input type="password" autoComplete="current-password" placeholder="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)}
                                    data-testid="nube-reset-password" disabled={busy}
                                    className="w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 text-sm" />
                            </>
                        )}
                        {error && <p className="text-xs font-bold text-red-600 dark:text-red-400" role="alert" data-testid="nube-reset-error">{error}</p>}
                        <div className="flex gap-2">
                            <button type="button" onClick={close} disabled={busy}
                                className="flex-1 rounded-xl border border-slate-200 dark:border-slate-700 py-2.5 text-sm font-bold text-slate-600 dark:text-slate-300">Cancelar</button>
                            <button type="submit" disabled={busy || (lanMode && authMode === 'pin' ? !ownerPin.trim() : (!email.trim() || !password))} data-testid="nube-reset-submit"
                                className="flex-1 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 py-2.5 text-sm font-black text-white">
                                {busy ? 'Reiniciando…' : 'Reiniciar todas las cajas'}
                            </button>
                        </div>
                    </form>
                )}
            </SectionCard>
        </div>
    );
}
