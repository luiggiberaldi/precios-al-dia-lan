/**
 * Acceso del dueño con correo y contraseña (Precios al Día Nube), con el mismo
 * lenguaje visual del modal de Listo POS Lite: tarjeta centrada con el logo,
 * pestañas Entrar / Crear cuenta, campos con ícono, botón con degradado y las
 * pantallas «Revisa tu correo», «Nueva contraseña» y «Este enlace ya no sirve».
 * Solo presentación: la lógica vive en NubeGate y accountService.
 */
import { useState } from 'react';
import {
    Mail, Key, Eye, EyeOff, ArrowRight, ArrowLeft, ShieldCheck, AlertTriangle, CheckCircle, LogIn, Loader2, QrCode,
} from 'lucide-react';
import NubeLogo from './NubeLogo';
import { isEmail, passwordStrength } from './teamRules';
import { NUBE_BRAND } from './brand';
import { isLanModeEnabled } from '../lan/lanConfig';

const FIELD = 'w-full pl-10 pr-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium text-slate-800 dark:text-white placeholder-slate-400 focus:ring-2 focus:ring-brand/30 focus:border-brand outline-none transition-all';
const CTA = 'w-full py-3.5 text-white text-sm font-black rounded-xl transition-all shadow-lg shadow-brand/25 active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-70 bg-gradient-to-br from-[#2b59c3] to-[#6ea8ff] hover:brightness-105';
const GHOST = 'w-full py-2 text-sm font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center justify-center gap-2';
const Spinner = () => <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />;

/** Fondo suave + tarjeta centrada con destellos del azul Nube. */
function AuthCard({ children, onBack, testId }) {
    return (
        <div className="relative min-h-[100dvh] flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 p-4 overflow-x-hidden">
            <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
                <div className="absolute -top-[30%] -left-[15%] w-[600px] h-[600px] bg-sky-500/10 rounded-full blur-[120px]" />
                <div className="absolute -bottom-[30%] -right-[15%] w-[600px] h-[600px] bg-brand/10 rounded-full blur-[120px]" />
            </div>
            <div className="relative w-full max-w-sm bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl border border-slate-100 dark:border-slate-800 overflow-hidden animate-in fade-in zoom-in-95 duration-300" data-testid={testId}>
                {/* Destellos dentro de un marco recortado: si sobresalen, el navegador desplaza la tarjeta al enfocar un campo. */}
                <div className="absolute inset-0 overflow-hidden rounded-[2rem] pointer-events-none" aria-hidden="true">
                    <div className="absolute top-0 right-0 -mr-12 -mt-12 w-40 h-40 rounded-full blur-3xl bg-sky-300/25" />
                    <div className="absolute bottom-0 left-0 -ml-12 -mb-12 w-40 h-40 rounded-full blur-3xl bg-brand/15" />
                </div>
                {onBack && (
                    <button type="button" onClick={onBack} aria-label="Volver"
                        className="absolute top-4 left-4 p-2 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 rounded-full text-slate-400 hover:text-slate-600 transition-colors z-20">
                        <ArrowLeft size={18} />
                    </button>
                )}
                <div className={`p-6 relative z-10 ${onBack ? 'pt-12' : ''}`}>{children}</div>
            </div>
            <p className="relative text-[10px] text-slate-400 mt-5 flex items-center gap-1.5 font-medium">
                <ShieldCheck size={11} /> Conexión segura · {NUBE_BRAND.name} v{import.meta.env.VITE_APP_VERSION}
            </p>
        </div>
    );
}

function Logo({ caption }) {
    return (
        <div className="flex flex-col items-center justify-center mt-2 mb-6">
            <NubeLogo className="h-auto max-h-20 sm:max-h-24 max-w-full" />
            {caption && <p className="text-slate-500 dark:text-slate-400 text-xs mt-3 font-bold text-center">{caption}</p>}
        </div>
    );
}

function Field({ icon: Icon, right, error, ...props }) {
    return (
        <div>
            <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none"><Icon size={16} className="text-slate-400" /></div>
                <input {...props} className={`${FIELD} ${right ? 'pr-10' : ''}`} />
                {right}
            </div>
            {error && <p className="text-[11px] text-red-500 font-bold mt-1 ml-1">{error}</p>}
        </div>
    );
}

function PasswordField({ value, onChange, placeholder, autoComplete, testId, error, tone }) {
    const [show, setShow] = useState(false);
    const border = tone === 'ok' ? '!border-emerald-400' : tone === 'bad' ? '!border-red-400' : '';
    return (
        <div>
            <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none"><Key size={16} className="text-slate-400" /></div>
                <input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
                    autoComplete={autoComplete} data-testid={testId} className={`${FIELD} pr-10 ${border}`} />
                <button type="button" tabIndex={-1} onClick={() => setShow((s) => !s)} aria-label={show ? 'Ocultar contraseña' : 'Ver contraseña'}
                    className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-brand transition-colors">
                    {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
            </div>
            {error && <p className="text-[11px] text-red-500 font-bold mt-1 ml-1">{error}</p>}
        </div>
    );
}

const STRENGTH_LABEL = ['', 'Débil', 'Regular', 'Fuerte', 'Muy fuerte'];
const STRENGTH_COLOR = ['', 'bg-red-500', 'bg-orange-400', 'bg-emerald-400', 'bg-emerald-500'];
const STRENGTH_TEXT = ['', 'text-red-500', 'text-orange-500', 'text-emerald-500', 'text-emerald-600'];

function StrengthMeter({ password }) {
    if (!password) return null;
    const score = password.length < 8 ? 1 : Math.max(1, passwordStrength(password));
    return (
        <div className="px-1 animate-in fade-in duration-200" aria-live="polite">
            <div className="flex gap-1">
                {[1, 2, 3, 4].map((i) => <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-300 ${i <= score ? STRENGTH_COLOR[score] : 'bg-slate-200 dark:bg-slate-700'}`} />)}
            </div>
            <p className={`text-[10px] font-bold mt-1.5 ${STRENGTH_TEXT[score]}`}>{password.length < 8 ? 'Muy corta (mínimo 8)' : STRENGTH_LABEL[score]}</p>
        </div>
    );
}

function Alert({ message }) {
    if (!message) return null;
    return <p role="alert" className="text-xs font-bold text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900/50 rounded-xl px-3 py-2">{message}</p>;
}

function Info({ message }) {
    if (!message) return null;
    return <p role="status" className="text-xs text-center font-bold text-brand bg-brand-light rounded-xl px-3 py-2">{message}</p>;
}

/** «Revisa tu correo»: tras crear la cuenta, al entrar sin confirmar o al pedir el enlace. */
function CheckEmail({ email, recovery, onResend, onBack, busy, info, error }) {
    return (
        <div className="text-center space-y-4" role="status" data-testid="nube-check-email">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-brand-light flex items-center justify-center"><Mail size={26} className="text-brand" /></div>
            <div>
                <h3 className="text-lg font-black text-slate-800 dark:text-white">Revisa tu correo</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                    {recovery ? 'Si es el correo del dueño, te enviamos un enlace para elegir una contraseña nueva a' : 'Te enviamos un enlace de confirmación a'}<br />
                    <strong className="text-slate-700 dark:text-slate-200 break-all">{email}</strong>
                </p>
                <p className="text-xs text-slate-400 mt-2">
                    {recovery ? 'Ábrelo en este equipo. Si no lo ves, revisa la carpeta de spam.' : 'Ábrelo para activar tu cuenta y luego entra aquí. Si no lo ves, revisa la carpeta de spam.'}
                </p>
            </div>
            <Alert message={error} />
            <Info message={info} />
            {onResend && (
                <button type="button" onClick={onResend} disabled={busy} className={CTA} data-testid="nube-resend">
                    {busy ? <Spinner /> : 'Reenviar correo'}
                </button>
            )}
            <button type="button" onClick={onBack} className={GHOST}>
                <LogIn size={15} />{recovery ? 'Volver a entrar' : 'Ya lo confirmé, entrar'}
            </button>
        </div>
    );
}

/**
 * Acceso del dueño. `pendingConfirmation` (correo) muestra «Revisa tu correo».
 * `onForgot(email)` devuelve true si se envió el enlace. `allowSignup=false` cuando
 * solo confirma que es el dueño (administrar).
 */
export function OwnerAuthScreen({
    onSubmit, onForgot, onResend, onClearMessages, onConfirmedBack, onClaimCode,
    isLocalMaster = false, onOwnerPinSubmit = null, onLocalPinReset = null, onChangeLanServer = null,
    busy, error, info,
    pendingConfirmation = null, initialEmail = '', initialMode = 'login',
    title = 'Entra con tu cuenta', subtitle, onBack, allowSignup = true,
}) {
    const lanMode = isLanModeEnabled();
    const [mode, setMode] = useState(() => (lanMode && !isLocalMaster && onClaimCode ? 'code' : initialMode)); // login | signup | forgot | code
    const [email, setEmail] = useState(initialEmail);
    const [password, setPassword] = useState('');
    const [password2, setPassword2] = useState('');
    const [pairingCode, setPairingCode] = useState('');
    const [ownerPin, setOwnerPin] = useState('');
    const [resettingPin, setResettingPin] = useState(false);
    const [newPin1, setNewPin1] = useState('');
    const [newPin2, setNewPin2] = useState('');
    const [errors, setErrors] = useState({});
    const [sentTo, setSentTo] = useState(null);

    const switchTo = (m) => { setMode(m); setErrors({}); setPassword(''); setPassword2(''); setSentTo(null); onClearMessages?.(); };

    const submit = async (e) => {
        e.preventDefault();
        const next = {};
        if (mode === 'code') {
            if (!/^\d{6}$/.test(pairingCode.trim())) next.code = 'Escribe el código de 6 dígitos de la Caja Principal.';
            setErrors(next);
            if (Object.keys(next).length) return;
            onClaimCode?.(pairingCode.trim());
            return;
        }
        if (!isEmail(email)) next.email = 'Escribe un correo válido (ej. nombre@correo.com).';
        if (mode === 'login' && !password) next.password = 'Escribe tu contraseña.';
        if (mode === 'signup') {
            if (password.length < 8) next.password = 'Mínimo 8 caracteres.';
            else if (password !== password2) next.password2 = 'Las contraseñas no coinciden.';
        }
        setErrors(next);
        if (Object.keys(next).length) return;
        if (mode === 'forgot') {
            if (await onForgot?.(email.trim())) setSentTo(email.trim());
            return;
        }
        onSubmit({ mode, email: email.trim(), password });
    };

    if (lanMode) {
        if (isLocalMaster) {
            const submitMasterPin = (e) => {
                e.preventDefault();
                const next = {};
                if (resettingPin) {
                    if (!/^[0-9]{6}$/.test(newPin1)) next.newPin1 = 'El PIN debe tener 6 números.';
                    else if (newPin1 === '000000') next.newPin1 = 'Elige un PIN distinto de 000000.';
                    if (newPin1 !== newPin2) next.newPin2 = 'Los PIN no coinciden.';
                    setErrors(next);
                    if (Object.keys(next).length) return;
                    onLocalPinReset?.(newPin1);
                    return;
                }
                if (!/^[0-9]{6}$/.test(ownerPin)) next.ownerPin = 'Escribe tu PIN de 6 números.';
                setErrors(next);
                if (Object.keys(next).length) return;
                onOwnerPinSubmit?.(ownerPin);
            };
            return (
                <AuthCard testId="nube-owner-auth" onBack={onBack}>
                    <Logo
                        caption={resettingPin
                            ? 'Solo desde esta PC Principal. Elige un PIN nuevo de 6 dígitos para entrar como dueño.'
                            : 'Acceso del dueño en esta Caja Principal.'}
                    />
                    <form onSubmit={submitMasterPin} className="space-y-3" noValidate>
                        {resettingPin ? (
                            <>
                                <Field
                                    icon={Key}
                                    type="password"
                                    inputMode="numeric"
                                    maxLength={6}
                                    placeholder="Nuevo PIN de dueño (6 dígitos)"
                                    value={newPin1}
                                    onChange={(e) => { setNewPin1(e.target.value.replace(/\D/g, '').slice(0, 6)); setErrors((x) => ({ ...x, newPin1: null })); }}
                                    error={errors.newPin1}
                                    data-testid="lan-reset-pin1"
                                />
                                <Field
                                    icon={Key}
                                    type="password"
                                    inputMode="numeric"
                                    maxLength={6}
                                    placeholder="Repite el nuevo PIN (6 dígitos)"
                                    value={newPin2}
                                    onChange={(e) => { setNewPin2(e.target.value.replace(/\D/g, '').slice(0, 6)); setErrors((x) => ({ ...x, newPin2: null })); }}
                                    error={errors.newPin2}
                                    data-testid="lan-reset-pin2"
                                />
                            </>
                        ) : (
                            <Field
                                icon={Key}
                                type="password"
                                inputMode="numeric"
                                maxLength={6}
                                placeholder="Tu PIN de dueño (6 dígitos)"
                                value={ownerPin}
                                onChange={(e) => { setOwnerPin(e.target.value.replace(/\D/g, '').slice(0, 6)); setErrors((x) => ({ ...x, ownerPin: null })); }}
                                error={errors.ownerPin}
                                data-testid="lan-owner-pin-input"
                            />
                        )}
                        <Alert message={error} />
                        <Info message={info} />
                        <button type="submit" disabled={busy} className={CTA} data-testid={resettingPin ? 'lan-reset-pin-submit' : 'lan-owner-pin-submit'}>
                            {busy ? <Spinner /> : (
                                <>
                                    {resettingPin ? 'Guardar nuevo PIN y entrar' : 'Entrar con PIN'}
                                    <ArrowRight size={16} strokeWidth={3} />
                                </>
                            )}
                        </button>
                        {onLocalPinReset && (
                            <button
                                type="button"
                                data-testid="lan-open-reset-pin"
                                onClick={() => { setResettingPin((v) => !v); setErrors({}); setNewPin1(''); setNewPin2(''); onClearMessages?.(); }}
                                className={GHOST}
                            >
                                {resettingPin ? 'Volver a entrar con PIN' : '¿Olvidaste tu PIN? Restablécelo en esta PC'}
                            </button>
                        )}
                        {onChangeLanServer && (
                            <button type="button" onClick={onChangeLanServer} className={GHOST}>
                                Cambiar rol o dirección LAN
                            </button>
                        )}
                    </form>
                </AuthCard>
            );
        }

        if (onClaimCode) {
            return (
                <AuthCard testId="nube-owner-auth" onBack={onBack}>
                    <Logo caption="Escribe el código de 6 dígitos que muestra la Caja Principal." />
                    <form onSubmit={submit} className="space-y-3" noValidate>
                        <Field
                            icon={QrCode}
                            type="text"
                            inputMode="numeric"
                            maxLength={6}
                            placeholder="Código de 6 dígitos"
                            value={pairingCode}
                            onChange={(e) => { setPairingCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setErrors((x) => ({ ...x, code: null })); }}
                            error={errors.code}
                            data-testid="lan-claim-code-input"
                        />
                        <Alert message={error} />
                        <Info message={info} />
                        <button type="submit" disabled={busy} className={CTA} data-testid="nube-owner-submit">
                            {busy ? <Spinner /> : (
                                <>
                                    Conectar esta caja
                                    <ArrowRight size={16} strokeWidth={3} />
                                </>
                            )}
                        </button>
                        {onChangeLanServer && (
                            <button type="button" onClick={onChangeLanServer} className={GHOST}>
                                Cambiar dirección de Caja Principal
                            </button>
                        )}
                    </form>
                </AuthCard>
            );
        }

        return (
            <AuthCard testId="nube-owner-auth" onBack={onBack}>
                <Logo caption="Para administrar o restablecer el PIN del dueño sin sesión activa, hazlo desde la Caja Principal." />
                {onBack && <button type="button" onClick={onBack} className={CTA}>Volver</button>}
            </AuthCard>
        );
    }

    if (pendingConfirmation) {
        return (
            <AuthCard testId="nube-owner-auth">
                <Logo />
                <CheckEmail email={pendingConfirmation} onResend={() => onResend?.(pendingConfirmation)} busy={busy} info={info} error={error}
                    onBack={() => { switchTo('login'); setEmail(pendingConfirmation); onConfirmedBack?.(); }} />
            </AuthCard>
        );
    }
    if (mode === 'forgot' && sentTo) {
        return (
            <AuthCard testId="nube-owner-auth">
                <Logo />
                <CheckEmail recovery email={sentTo} onBack={() => switchTo('login')} />
            </AuthCard>
        );
    }

    const caption = mode === 'forgot' ? null : mode === 'code'
        ? 'Escribe el código de 6 dígitos que muestra la Caja Principal.'
        : mode === 'signup'
            ? 'Crea el usuario del dueño. Tus empleados no lo necesitan: entran con su PIN.'
            : (subtitle ?? title);

    const tabs = allowSignup
        ? [
            ['login', 'Entrar'],
            ['signup', 'Crear cuenta'],
            ...(onClaimCode ? [['code', 'Código']] : []),
        ]
        : [];

    return (
        <AuthCard testId="nube-owner-auth" onBack={mode === 'forgot' ? () => switchTo('login') : onBack}>
            <Logo caption={caption} />

            {tabs.length > 0 && mode !== 'forgot' && (
                <div className="flex p-1 bg-slate-100 dark:bg-slate-800 rounded-xl mb-5" role="tablist">
                    {tabs.map(([m, label]) => (
                        <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => switchTo(m)}
                            className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${mode === m ? 'bg-white dark:bg-slate-900 text-brand shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                            {label}
                        </button>
                    ))}
                </div>
            )}

            <form onSubmit={submit} className="space-y-3" noValidate>
                {mode === 'forgot' && (
                    <div className="text-center -mt-2 mb-1">
                        <h2 className="text-lg font-black text-slate-800 dark:text-white">¿Olvidaste tu contraseña?</h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Te enviaremos un enlace para elegir una nueva.</p>
                    </div>
                )}
                {mode === 'code' ? (
                    <Field
                        icon={QrCode}
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="Código de 6 dígitos"
                        value={pairingCode}
                        onChange={(e) => { setPairingCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setErrors((x) => ({ ...x, code: null })); }}
                        error={errors.code}
                        data-testid="lan-claim-code-input"
                    />
                ) : (
                    <>
                        <Field icon={Mail} type="email" autoComplete="email" placeholder={mode === 'forgot' ? 'Correo del dueño' : 'Correo electrónico'}
                            value={email} onChange={(e) => { setEmail(e.target.value); setErrors((x) => ({ ...x, email: null })); }} error={errors.email} data-testid="nube-owner-email" />
                        {mode !== 'forgot' && (
                            <PasswordField value={password} onChange={(v) => { setPassword(v); setErrors((x) => ({ ...x, password: null })); }}
                                placeholder={mode === 'signup' ? 'Contraseña (mínimo 8 caracteres)' : 'Contraseña'} error={errors.password}
                                autoComplete={mode === 'login' ? 'current-password' : 'new-password'} testId="nube-owner-password" />
                        )}
                        {mode === 'signup' && (
                            <>
                                <StrengthMeter password={password} />
                                <PasswordField value={password2} onChange={(v) => { setPassword2(v); setErrors((x) => ({ ...x, password2: null })); }}
                                    placeholder="Confirmar contraseña" autoComplete="new-password" testId="nube-owner-password2" error={errors.password2}
                                    tone={password2 ? (password2 === password ? 'ok' : 'bad') : null} />
                            </>
                        )}
                        {mode === 'login' && onForgot && !lanMode && (
                            <div className="flex justify-end">
                                <button type="button" onClick={() => switchTo('forgot')} className="text-[11px] font-bold text-brand hover:underline" data-testid="nube-owner-forgot">
                                    ¿Olvidaste tu contraseña?
                                </button>
                            </div>
                        )}
                    </>
                )}
                <Alert message={error} />
                <Info message={info} />
                <button type="submit" disabled={busy} className={CTA} data-testid="nube-owner-submit">
                    {busy ? <Spinner /> : (
                        <>
                            {mode === 'code' ? 'Conectar esta caja' : mode === 'login' ? 'Entrar' : mode === 'signup' ? 'Crear mi cuenta' : 'Enviar correo de recuperación'}
                            <ArrowRight size={16} strokeWidth={3} />
                        </>
                    )}
                </button>
                {mode === 'forgot' && <button type="button" onClick={() => switchTo('login')} className={GHOST}>Volver a entrar</button>}
            </form>
        </AuthCard>
    );
}

/** Regreso del enlace de «¿Olvidaste tu contraseña?»: elegir la nueva. */
export function NewPasswordScreen({ onSubmit, onCancel, busy, error, done }) {
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [localError, setLocalError] = useState(null);
    const submit = (e) => {
        e.preventDefault();
        if (password.length < 8) { setLocalError('Mínimo 8 caracteres.'); return; }
        if (password !== confirm) { setLocalError('Las contraseñas no coinciden.'); return; }
        setLocalError(null);
        onSubmit(password);
    };
    return (
        <AuthCard testId="nube-new-password">
            <div className="w-16 h-16 bg-gradient-to-br from-[#2b59c3] to-[#6ea8ff] rounded-3xl flex items-center justify-center mx-auto mt-2 mb-5 shadow-xl shadow-brand/20">
                {done ? <CheckCircle size={30} className="text-white" /> : <ShieldCheck size={30} className="text-white" />}
            </div>
            <h1 className="text-2xl font-black text-slate-800 dark:text-white text-center mb-1">{done ? 'Contraseña cambiada' : 'Nueva contraseña'}</h1>
            <p className="text-slate-500 text-sm text-center mb-6">
                {done ? 'Listo. Entra con tu correo y tu contraseña nueva.' : 'Elige una contraseña segura para tu cuenta de dueño.'}
            </p>
            {done ? (
                <button type="button" className={CTA} onClick={onCancel}>Ir a entrar <ArrowRight size={16} strokeWidth={3} /></button>
            ) : (
                <form onSubmit={submit} className="space-y-3" noValidate>
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider ml-1">Nueva contraseña</label>
                    <PasswordField value={password} onChange={setPassword} placeholder="Mínimo 8 caracteres" autoComplete="new-password" testId="nube-new-password1" />
                    <StrengthMeter password={password} />
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider ml-1 block pt-1">Confirmar contraseña</label>
                    <PasswordField value={confirm} onChange={setConfirm} placeholder="Repite la contraseña" autoComplete="new-password" testId="nube-new-password2"
                        tone={confirm ? (confirm === password ? 'ok' : 'bad') : null} />
                    {confirm && confirm === password && (
                        <p className="text-[10px] text-emerald-500 font-bold ml-1 flex items-center gap-1"><CheckCircle size={10} /> Las contraseñas coinciden</p>
                    )}
                    <Alert message={localError || error} />
                    <button type="submit" disabled={busy} className={CTA}>{busy ? <Loader2 className="animate-spin" size={18} /> : 'Guardar contraseña'}</button>
                    <button type="button" className={GHOST} onClick={onCancel}>Cancelar</button>
                </form>
            )}
        </AuthCard>
    );
}

/** El enlace del correo venció o ya se usó. */
/** Regreso del enlace «Confirmar mi correo»: la cuenta del dueño quedó activa. */
export function EmailConfirmedScreen({ onLogin }) {
    return (
        <AuthCard testId="nube-email-confirmed">
            <div className="flex flex-col items-center text-center" role="status">
                <div className="w-16 h-16 bg-emerald-50 dark:bg-emerald-950/40 rounded-3xl flex items-center justify-center mt-2 mb-5">
                    <CheckCircle size={30} className="text-emerald-500" />
                </div>
                <h1 className="text-2xl font-black text-slate-800 dark:text-white mb-2">¡Correo confirmado!</h1>
                <p className="text-slate-500 text-sm leading-relaxed mb-6">
                    Tu cuenta de dueño ya está activa. Entra con tu correo y contraseña para crear tu negocio y registrar este equipo.
                </p>
                <button type="button" onClick={onLogin} className={CTA}><LogIn size={16} /> Entrar con mi cuenta</button>
            </div>
        </AuthCard>
    );
}

export function AuthLinkErrorScreen({ message, onRequestNew, onLogin }) {
    return (
        <AuthCard testId="nube-link-error">
            <div className="flex flex-col items-center text-center" role="alert">
                <div className="w-16 h-16 bg-amber-50 dark:bg-amber-950/40 rounded-3xl flex items-center justify-center mt-2 mb-5">
                    <AlertTriangle size={30} className="text-amber-500" />
                </div>
                <h1 className="text-2xl font-black text-slate-800 dark:text-white mb-2">Este enlace ya no sirve</h1>
                <p className="text-slate-500 text-sm leading-relaxed mb-4">{message || 'El enlace venció o ya se usó. Pide uno nuevo.'}</p>
                <p className="w-full text-left text-xs leading-relaxed text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-xl px-3.5 py-3 mb-6">
                    <strong>¿Ya habías confirmado tu correo?</strong> Entonces tu cuenta ya está activa: cada enlace sirve una sola vez. Entra con tu correo y contraseña.
                </p>
                <button type="button" onClick={onLogin} className={CTA}><LogIn size={16} /> Entrar con mi cuenta</button>
                <button type="button" onClick={onRequestNew} className={`${GHOST} mt-2`}><Mail size={15} /> Pedir un enlace nuevo</button>
            </div>
        </AuthCard>
    );
}
