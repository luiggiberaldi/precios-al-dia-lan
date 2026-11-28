/**
 * Piezas de pantalla del equipo de Precios al Día Nube: modal propio (en lugar de
 * window.prompt), formulario de empleado, cambio de PIN y confirmación.
 * Las usan Ajustes → Usuarios (NubeTeamSettings) y el panel del dueño (ManagePanel).
 */
import { useEffect, useState } from 'react';
import { X, Loader2, KeyRound, UserPlus, Save, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { validatePin, validateMemberName, onlyPinDigits, roleLabel, roleDescription, pinHint } from './teamRules';
import { isLanModeEnabled } from '../lan/lanConfig';

const FIELD = 'w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-4 py-3 min-h-[48px] text-slate-800 dark:text-white outline-none focus:border-brand focus:ring-2 focus:ring-brand/30 transition-colors';
const PIN_FIELD = `${FIELD} text-center text-lg font-black tracking-[0.4em] placeholder:tracking-normal placeholder:font-medium placeholder:text-sm`;
const LABEL = 'text-[11px] uppercase tracking-wider font-extrabold text-slate-500 dark:text-slate-400 block mb-1.5';
const BTN_PRIMARY = 'flex-1 py-3 min-h-[48px] rounded-xl bg-brand hover:bg-brand-dark text-white font-bold text-sm active:scale-[0.98] disabled:opacity-60 flex items-center justify-center gap-2 transition-colors';
const BTN_SECONDARY = 'flex-1 py-3 min-h-[48px] rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold text-sm active:scale-[0.98]';

export function NubeModal({ title, subtitle, onClose, children, testId }) {
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div className="fixed inset-0 z-[400] flex items-center justify-center p-3 sm:p-4" data-testid={testId}>
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
            <div role="dialog" aria-modal="true" aria-label={title}
                className="relative w-full max-w-sm bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 fade-in duration-150">
                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between gap-3 bg-slate-50/60 dark:bg-slate-800/40">
                    <div className="min-w-0">
                        <h3 className="font-black text-slate-800 dark:text-white text-base tracking-tight">{title}</h3>
                        {subtitle && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>}
                    </div>
                    <button type="button" onClick={onClose} aria-label="Cerrar" className="p-1.5 -mr-1 rounded-full text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-700">
                        <X size={18} />
                    </button>
                </div>
                <div className="p-5 max-h-[80vh] overflow-y-auto">{children}</div>
            </div>
        </div>
    );
}

function FormError({ message }) {
    if (!message) return null;
    return <p role="alert" className="text-xs font-bold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 rounded-lg px-3 py-2">{message}</p>;
}

export function PinInput({ value, onChange, placeholder, autoFocus, testId, onEnter, maxLength = undefined }) {
    const [show, setShow] = useState(false);
    return (
        <div className="relative">
            <input type={show ? 'text' : 'password'} inputMode="numeric" autoComplete="new-password" autoFocus={autoFocus}
                placeholder={placeholder} value={value} maxLength={maxLength} data-testid={testId}
                onChange={(e) => {
                    const digits = onlyPinDigits(e.target.value);
                    onChange(maxLength ? digits.slice(0, maxLength) : digits);
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }}
                className={`${PIN_FIELD} pr-12`} />
            <button type="button" tabIndex={-1} onClick={() => setShow((s) => !s)} aria-label={show ? 'Ocultar PIN' : 'Ver PIN'}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600">
                {show ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
        </div>
    );
}

/**
 * Crear o editar un empleado. Al crear, el PIN es obligatorio; al editar, solo si se
 * escribe uno nuevo. `onSubmit({ id, name, role, pin })` puede lanzar: el error se muestra aquí.
 */
export function MemberFormModal({ member = null, roles, onSubmit, onClose }) {
    const editing = Boolean(member);
    const [name, setName] = useState(member?.display_name ?? '');
    const [role, setRole] = useState(member?.role ?? roles[0] ?? 'cajero');
    const [pin, setPin] = useState('');
    const [confirm, setConfirm] = useState('');
    // Cajero sin PIN: entra tocando su nombre. Al editar, arranca como esté hoy.
    const hadNoPin = editing && member?.pin_length === null;
    const [sinPin, setSinPin] = useState(hadNoPin);
    const noPin = role === 'cajero' && sinPin;
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);

    const submit = async (e) => {
        e?.preventDefault?.();
        // Pasar a administrador a alguien sin PIN o con PIN corto exige uno nuevo de 6+.
        // Quitarle «sin PIN» a un cajero también exige escribirle uno.
        const needsNewPin = !editing || hadNoPin
            || (role === 'administrador' && !((member?.pin_length ?? 0) >= 6));
        const err = validateMemberName(name)
            || (noPin ? null : ((needsNewPin || pin || confirm) ? validatePin(pin, confirm, role) : null));
        if (err) { setError(err); return; }
        setSaving(true);
        setError(null);
        try {
            await onSubmit({
                id: member?.id ?? null, name: name.trim(), role, active: member?.active ?? true,
                pin: noPin ? null : (pin || null),
                sinPin: noPin && !hadNoPin,
            });
        } catch (ex) {
            setError(ex?.message || 'No se pudo guardar.');
            setSaving(false);
        }
    };

    return (
        <NubeModal title={editing ? `Editar a ${member.display_name}` : 'Agregar empleado'}
            subtitle={editing ? 'Deja el PIN en blanco para no cambiarlo.' : 'Entrará en cualquier caja de tu negocio.'}
            onClose={onClose} testId="nube-member-form">
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <label className={LABEL} htmlFor="nube-member-name">Nombre</label>
                    <input id="nube-member-name" className={FIELD} value={name} maxLength={40} autoFocus={!editing}
                        placeholder="Ej. María" onChange={(e) => { setName(e.target.value); setError(null); }} data-testid="nube-member-name" />
                </div>
                {roles.length > 1 ? (
                    <div>
                        <span className={LABEL}>Rol</span>
                        <div className="grid grid-cols-2 gap-2">
                            {roles.map((r) => (
                                <button key={r} type="button" onClick={() => setRole(r)} data-testid={`nube-member-role-${r}`}
                                    className={`rounded-xl border-2 px-3 py-2.5 text-left transition-colors ${role === r ? 'border-brand bg-brand-light' : 'border-slate-200 dark:border-slate-700'}`}>
                                    <p className="text-sm font-black text-slate-800 dark:text-white">{roleLabel(r)}</p>
                                    <p className="text-[11px] text-slate-500 leading-snug">{roleDescription(r)}</p>
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <p className="text-xs text-slate-500 dark:text-slate-400">Rol: <strong>{roleLabel(role)}</strong></p>
                )}
                {role === 'cajero' && (
                    <label className="flex items-center justify-between gap-3 rounded-xl border-2 border-slate-200 dark:border-slate-700 px-4 py-3 cursor-pointer">
                        <span>
                            <span className="block text-sm font-black text-slate-800 dark:text-white">Entrar sin PIN</span>
                            <span className="block text-[11px] text-slate-500 leading-snug">Entra con solo tocar su nombre</span>
                        </span>
                        <input type="checkbox" checked={sinPin} data-testid="nube-member-sin-pin"
                            onChange={(e) => { setSinPin(e.target.checked); setError(null); }}
                            className="w-5 h-5 accent-[#2b59c3]" />
                    </label>
                )}
                {!noPin && (
                    <div className="space-y-2">
                        <span className={LABEL}>{editing && !hadNoPin ? 'PIN nuevo (opcional)' : 'PIN'}</span>
                        <PinInput maxLength={role === 'cajero' ? 4 : (isLanModeEnabled() ? 6 : 32)} value={pin} onChange={(v) => { setPin(v.slice(0, role === 'cajero' ? 4 : (isLanModeEnabled() ? 6 : 32))); setError(null); }} placeholder={pinHint(role)} testId="nube-member-pin" />
                        <PinInput maxLength={role === 'cajero' ? 4 : (isLanModeEnabled() ? 6 : 32)} value={confirm} onChange={(v) => { setConfirm(v.slice(0, role === 'cajero' ? 4 : (isLanModeEnabled() ? 6 : 32))); setError(null); }} placeholder="Repite el PIN" testId="nube-member-pin2" onEnter={submit} />
                    </div>
                )}
                <FormError message={error} />
                <div className="flex gap-2 pt-1">
                    <button type="button" onClick={onClose} className={BTN_SECONDARY}>Cancelar</button>
                    <button type="submit" disabled={saving} className={BTN_PRIMARY} data-testid="nube-member-save">
                        {saving ? <Loader2 size={16} className="animate-spin" /> : editing ? <Save size={16} /> : <UserPlus size={16} />}
                        {saving ? 'Guardando…' : editing ? 'Guardar' : 'Agregar'}
                    </button>
                </div>
            </form>
        </NubeModal>
    );
}

/**
 * Cambiar un PIN. Con `needsCurrent` pide el actual (cambiar el mío).
 * `onSubmit({ currentPin, pin })` puede lanzar: el error se muestra aquí.
 */
export function PinChangeModal({ title, subtitle, role = 'cajero', needsCurrent = false, onSubmit, onClose }) {
    const [current, setCurrent] = useState('');
    const [pin, setPin] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);

    const submit = async (e) => {
        e?.preventDefault?.();
        if (needsCurrent && !current) { setError('Escribe tu PIN actual.'); return; }
        const err = validatePin(pin, confirm, role);
        if (err) { setError(err); return; }
        if (needsCurrent && current === pin) { setError('El PIN nuevo debe ser distinto del actual.'); return; }
        setSaving(true);
        setError(null);
        try {
            await onSubmit({ currentPin: current, pin });
        } catch (ex) {
            setError(ex?.message || 'No se pudo cambiar el PIN.');
            setSaving(false);
        }
    };

    return (
        <NubeModal title={title} subtitle={subtitle} onClose={onClose} testId="nube-pin-change">
            <form onSubmit={submit} className="space-y-3">
                {needsCurrent && (
                    <div>
                        <span className={LABEL}>PIN actual</span>
                        <PinInput maxLength={role === 'cajero' ? 4 : (isLanModeEnabled() ? 6 : 32)} value={current} onChange={(v) => { setCurrent(v); setError(null); }} placeholder="Tu PIN de hoy" autoFocus testId="nube-pin-current" />
                    </div>
                )}
                <div className="space-y-2">
                    <span className={LABEL}>PIN nuevo</span>
                    <PinInput maxLength={role === 'cajero' ? 4 : (isLanModeEnabled() ? 6 : 32)} value={pin} onChange={(v) => { setPin(v); setError(null); }} placeholder={pinHint(role)} autoFocus={!needsCurrent} testId="nube-pin-new" />
                    <PinInput maxLength={role === 'cajero' ? 4 : (isLanModeEnabled() ? 6 : 32)} value={confirm} onChange={(v) => { setConfirm(v); setError(null); }} placeholder="Repite el PIN nuevo" testId="nube-pin-confirm" onEnter={submit} />
                </div>
                <FormError message={error} />
                <div className="flex gap-2 pt-1">
                    <button type="button" onClick={onClose} className={BTN_SECONDARY}>Cancelar</button>
                    <button type="submit" disabled={saving} className={BTN_PRIMARY} data-testid="nube-pin-save">
                        {saving ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
                        {saving ? 'Guardando…' : 'Cambiar PIN'}
                    </button>
                </div>
            </form>
        </NubeModal>
    );
}

/** Confirmación con botón de peligro opcional. `onConfirm` puede lanzar. */
export function ConfirmModal({ title, message, confirmLabel = 'Confirmar', danger = false, onConfirm, onClose }) {
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);
    const go = async () => {
        setSaving(true);
        setError(null);
        try { await onConfirm(); } catch (ex) { setError(ex?.message || 'No se pudo completar.'); setSaving(false); }
    };
    return (
        <NubeModal title={title} onClose={onClose} testId="nube-confirm">
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-4">{message}</p>
            <FormError message={error} />
            <div className="flex gap-2 mt-4">
                <button type="button" onClick={onClose} className={BTN_SECONDARY}>Cancelar</button>
                <button type="button" onClick={go} disabled={saving} data-testid="nube-confirm-ok"
                    className={`${BTN_PRIMARY} ${danger ? '!bg-rose-600 hover:!bg-rose-700' : ''}`}>
                    {saving && <Loader2 size={16} className="animate-spin" />}{confirmLabel}
                </button>
            </div>
        </NubeModal>
    );
}

/** Texto simple en un modal (p. ej. renombrar equipo). `onSubmit(value)` puede lanzar. */
export function TextPromptModal({ title, label, initial = '', maxLength = 40, onSubmit, onClose }) {
    const [value, setValue] = useState(initial);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);
    const submit = async (e) => {
        e?.preventDefault?.();
        if (!value.trim()) { setError('Escribe un nombre.'); return; }
        setSaving(true);
        setError(null);
        try { await onSubmit(value.trim()); } catch (ex) { setError(ex?.message || 'No se pudo guardar.'); setSaving(false); }
    };
    return (
        <NubeModal title={title} onClose={onClose} testId="nube-text-prompt">
            <form onSubmit={submit} className="space-y-3">
                <label className={LABEL}>{label}</label>
                <input className={FIELD} value={value} maxLength={maxLength} autoFocus onChange={(e) => { setValue(e.target.value); setError(null); }} />
                <FormError message={error} />
                <div className="flex gap-2 pt-1">
                    <button type="button" onClick={onClose} className={BTN_SECONDARY}>Cancelar</button>
                    <button type="submit" disabled={saving} className={BTN_PRIMARY}>
                        {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}Guardar
                    </button>
                </div>
            </form>
        </NubeModal>
    );
}

function SecretTextInput({ value, onChange, placeholder, autoFocus = false, testId, maxLength = 32 }) {
    const [show, setShow] = useState(false);
    return (
        <div className="relative">
            <input
                type={show ? 'text' : 'password'}
                autoComplete="off"
                autoFocus={autoFocus}
                placeholder={placeholder}
                value={value}
                maxLength={maxLength}
                data-testid={testId}
                onChange={(e) => onChange(e.target.value)}
                className={`${FIELD} pr-12 font-bold tracking-wider placeholder:tracking-normal placeholder:font-normal`}
            />
            <button
                type="button"
                tabIndex={-1}
                onClick={() => setShow((s) => !s)}
                aria-label={show ? 'Ocultar Clave Maestra' : 'Ver Clave Maestra'}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
            >
                {show ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
        </div>
    );
}

/**
 * Modal de acceso o recuperación inmediata del dueño usando Clave Maestra (Modo LAN).
 * Permite entrar directo sin cambiar el PIN o dejar guardado un PIN nuevo en el mismo paso.
 */
export function MasterKeyAccessModal({ ownerName = 'Dueño', purpose = 'login', onSubmit, onClose }) {
    const [masterKey, setMasterKey] = useState('');
    const [changePin, setChangePin] = useState(false);
    const [pin, setPin] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);

    const submit = async (e) => {
        e?.preventDefault?.();
        if (!masterKey.trim()) {
            setError('Escribe tu Clave Maestra.');
            return;
        }
        if (changePin) {
            const err = validatePin(pin, confirm, 'dueno');
            if (err) {
                setError(err);
                return;
            }
        }
        setSaving(true);
        setError(null);
        try {
            await onSubmit({
                masterKey: masterKey.trim(),
                newPin: changePin ? pin : null,
            });
        } catch (ex) {
            setError(ex?.message || 'Clave Maestra incorrecta.');
            setSaving(false);
        }
    };

    return (
        <NubeModal
            title={`Acceso con Clave Maestra · ${ownerName}`}
            subtitle={purpose === 'manage'
                ? 'Entra a administrar equipos y empleados o cambia tu PIN de dueño.'
                : 'Inicia sesión como dueño aunque hayas olvidado tu PIN.'}
            onClose={onClose}
            testId="lan-master-key-modal"
        >
            <form onSubmit={submit} className="space-y-3.5">
                <div>
                    <span className={LABEL}>Clave Maestra</span>
                    <SecretTextInput
                        value={masterKey}
                        onChange={(v) => { setMasterKey(v); setError(null); }}
                        placeholder="Escribe tu Clave Maestra"
                        autoFocus
                        testId="master-key-login-input"
                    />
                </div>

                <label className="flex items-center justify-between gap-3 rounded-xl border-2 border-slate-200 dark:border-slate-700 px-3.5 py-2.5 cursor-pointer">
                    <span>
                        <span className="block text-xs font-black text-slate-800 dark:text-white">Cambiar mi PIN de dueño ahora</span>
                        <span className="block text-[11px] text-slate-500 leading-snug">Opcional: si no lo marcas, solo entras con la Clave Maestra</span>
                    </span>
                    <input
                        type="checkbox"
                        checked={changePin}
                        data-testid="master-key-change-pin-toggle"
                        onChange={(e) => { setChangePin(e.target.checked); setError(null); }}
                        className="w-5 h-5 accent-[#2b59c3]"
                    />
                </label>

                {changePin && (
                    <div className="space-y-2">
                        <span className={LABEL}>Nuevo PIN de dueño (6 números)</span>
                        <PinInput
                            maxLength={6}
                            value={pin}
                            onChange={(v) => { setPin(v.slice(0, 6)); setError(null); }}
                            placeholder="Nuevo PIN (6 números)"
                            testId="master-key-new-pin"
                        />
                        <PinInput
                            maxLength={6}
                            value={confirm}
                            onChange={(v) => { setConfirm(v.slice(0, 6)); setError(null); }}
                            placeholder="Repite el PIN nuevo"
                            testId="master-key-confirm-pin"
                            onEnter={submit}
                        />
                    </div>
                )}

                <FormError message={error} />

                <div className="flex gap-2 pt-1">
                    <button type="button" onClick={onClose} className={BTN_SECONDARY}>Cancelar</button>
                    <button type="submit" disabled={saving} className={BTN_PRIMARY} data-testid="master-key-login-submit">
                        {saving ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                        {saving ? 'Verificando…' : (changePin ? 'Guardar PIN y entrar' : 'Entrar ahora')}
                    </button>
                </div>
            </form>
        </NubeModal>
    );
}

/**
 * Modal para que el dueño configure o cambie la Clave Maestra personalizada del negocio (Modo LAN).
 */
export function MasterKeyConfigModal({ isCustom = false, onSubmit, onClose }) {
    const [currentKey, setCurrentKey] = useState('');
    const [newKey, setNewKey] = useState('');
    const [confirmKey, setConfirmKey] = useState('');
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);

    const submit = async (e) => {
        e?.preventDefault?.();
        const cleanNew = newKey.trim();
        const cleanConfirm = confirmKey.trim();
        if (isCustom && !currentKey.trim()) {
            setError('Escribe tu Clave Maestra actual para cambiarla.');
            return;
        }
        if (cleanNew.length < 6 || cleanNew.length > 32) {
            setError('La nueva Clave Maestra debe tener entre 6 y 32 caracteres.');
            return;
        }
        if (/^0+$/.test(cleanNew)) {
            setError('Elige una Clave Maestra distinta de puros ceros.');
            return;
        }
        if (cleanNew !== cleanConfirm) {
            setError('Las Claves Maestras no coinciden.');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await onSubmit({
                currentMasterKey: isCustom ? currentKey.trim() : null,
                newMasterKey: cleanNew,
            });
        } catch (ex) {
            setError(ex?.message || 'No se pudo guardar la Clave Maestra.');
            setSaving(false);
        }
    };

    return (
        <NubeModal
            title={isCustom ? 'Cambiar Clave Maestra' : 'Configurar Clave Maestra'}
            subtitle="Guárdala en un lugar seguro. Te permitirá entrar como dueño o reponer tu PIN si algún día lo olvidas."
            onClose={onClose}
            testId="lan-master-key-config-modal"
        >
            <form onSubmit={submit} className="space-y-3">
                {isCustom && (
                    <div>
                        <span className={LABEL}>Clave Maestra actual</span>
                        <SecretTextInput
                            value={currentKey}
                            onChange={(v) => { setCurrentKey(v); setError(null); }}
                            placeholder="Tu Clave Maestra actual"
                            autoFocus
                            testId="master-key-config-current"
                        />
                    </div>
                )}
                <div className="space-y-2">
                    <span className={LABEL}>Nueva Clave Maestra (mínimo 6 caracteres)</span>
                    <SecretTextInput
                        value={newKey}
                        onChange={(v) => { setNewKey(v); setError(null); }}
                        placeholder="Ej. MiClaveSegura2026"
                        autoFocus={!isCustom}
                        testId="master-key-config-new"
                    />
                    <SecretTextInput
                        value={confirmKey}
                        onChange={(v) => { setConfirmKey(v); setError(null); }}
                        placeholder="Repite la Clave Maestra"
                        testId="master-key-config-confirm"
                    />
                </div>
                <FormError message={error} />
                <div className="flex gap-2 pt-1">
                    <button type="button" onClick={onClose} className={BTN_SECONDARY}>Cancelar</button>
                    <button type="submit" disabled={saving} className={BTN_PRIMARY} data-testid="master-key-config-save">
                        {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                        {saving ? 'Guardando…' : 'Guardar Clave Maestra'}
                    </button>
                </div>
            </form>
        </NubeModal>
    );
}
