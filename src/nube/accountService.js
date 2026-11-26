/**
 * Servicio de cuentas de Precios al Día Nube (F1).
 *
 * Todas las funciones reciben el cliente de Supabase que corresponde (equipo o dueño)
 * para poder probarlas con un cliente simulado. Ninguna escribe directo en tablas:
 * solo llaman a las RPC de supabase/nube/migrations (baranda G8).
 *
 * Los errores se devuelven como `NubeError` con un mensaje listo para mostrar.
 */

export class NubeError extends Error {
    constructor(message, { code = null, cause = null } = {}) {
        super(message);
        this.name = 'NubeError';
        this.code = code;
        this.cause = cause;
    }
}

const FRIENDLY = [
    [/Anonymous sign-ins are disabled|anonymous_provider_disabled/i, 'El servidor todavía no permite registrar equipos (sesiones anónimas apagadas). Avísale al administrador.'],
    [/Invalid login credentials|invalid_credentials/i, 'Correo o contraseña incorrectos.'],
    [/Email not confirmed|email_not_confirmed/i, 'Todavía no confirmas tu correo. Revisa tu bandeja de entrada (y la carpeta de spam).'],
    [/User already registered|user_already_exists|email_exists/i, 'Ese correo ya tiene una cuenta. Usa «Entrar».'],
    [/over_request_rate_limit|too many requests/i, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.'],
    [/Failed to fetch|NetworkError|fetch failed/i, 'Sin conexión con el servidor. Revisa el internet.'],
    [/account_members_account_id_display_name_key/i, 'Ya hay alguien con ese nombre en el equipo. Usa otro nombre.'],
    [/Password should be at least|weak_password|password is too weak/i, 'La contraseña es muy débil. Usa al menos 8 caracteres, mezclando letras y números.'],
    [/New password should be different|same_password/i, 'La contraseña nueva debe ser distinta de la anterior.'],
    [/you can only request this after|over_email_send_rate_limit/i, 'Espera un minuto antes de pedir otro correo.'],
    [/email rate limit exceeded/i, 'Se enviaron demasiados correos. Intenta de nuevo en una hora.'],
    [/invalid format|Unable to validate email/i, 'Ese correo no es válido. Revísalo.'],
    [/Email address .* is invalid|email_address_invalid/i, 'Ese correo no puede recibir mensajes. Revisa que esté bien escrito.'],
    [/Email address not authorized|email_address_not_authorized/i, 'El servidor todavía no puede enviar correos a esa dirección. Avísale al administrador.'],
    [/Error sending (recovery|confirmation) email/i, 'No se pudo enviar el correo. Intenta de nuevo en unos minutos.'],
    [/Auth session missing|otp_expired|Email link is invalid or has expired|invalid JWT|token is expired/i, 'El enlace venció o ya se usó. Pide uno nuevo.'],
    [/Signups not allowed/i, 'Por ahora no se pueden crear usuarios nuevos. Avísale al administrador.'],
];

export function toNubeError(error, fallback = 'No se pudo completar la operación.') {
    if (error instanceof NubeError) return error;
    const raw = error?.message || String(error || '');
    // Supabase Auth trae un código estable (`email_not_confirmed`…) además del texto en inglés.
    const probe = `${error?.code || ''} ${raw}`;
    for (const [pattern, message] of FRIENDLY) {
        if (pattern.test(probe)) return new NubeError(message, { code: error?.code ?? null, cause: error });
    }
    // Los mensajes de nuestras RPC ya vienen en español y listos para mostrar.
    return new NubeError(raw || fallback, { code: error?.code ?? null, cause: error });
}

async function rpc(client, fn, args) {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw toNubeError(error);
    return data;
}

// ─── Sesión propia del equipo ────────────────────────────────────────────────

/** Asegura que el equipo tenga su sesión anónima. Devuelve el id de usuario del equipo. */
export async function ensureDeviceSession(deviceClient) {
    const { data } = await deviceClient.auth.getSession();
    const current = data?.session?.user;
    if (current?.id) return current.id;
    const { data: signed, error } = await deviceClient.auth.signInAnonymously();
    if (error) throw toNubeError(error);
    return signed.user.id;
}

/** Cierra la sesión local del equipo (sale de esta cuenta en este navegador/PC). */
export async function deviceSignOut(deviceClient) {
    try { await deviceClient?.auth?.signOut?.({ scope: 'local' }); } catch { /* limpiar aunque falle */ }
}

/**
 * Estado del equipo en la nube: `null` si no está registrado (o fue expulsado);
 * si no, `{ device, account, license, sedes }`.
 */
export async function getDeviceStatus(deviceClient, deviceUserId) {
    const { data: devices, error } = await deviceClient
        .from('account_devices')
        .select('id, account_id, sede_id, role, caja_letter, label, revoked_at, auth_user_id')
        .eq('auth_user_id', deviceUserId)
        .is('revoked_at', null)
        .limit(1);
    if (error) throw toNubeError(error);
    const device = devices?.[0];
    if (!device) return null;

    const [accounts, licenses, sedes] = await Promise.all([
        deviceClient.from('accounts').select('id, name').limit(1),
        deviceClient.from('account_licenses').select('status, max_cajas, max_sedes, expires_at').limit(1),
        deviceClient.from('sedes').select('id, name, archived_at').is('archived_at', null).order('created_at'),
    ]);
    for (const res of [accounts, licenses, sedes]) if (res.error) throw toNubeError(res.error);
    return {
        device,
        account: accounts.data?.[0] ?? null,
        license: licenses.data?.[0] ?? null,
        sedes: sedes.data ?? [],
    };
}

// ─── Dueño (correo y clave, sesión temporal) ─────────────────────────────────

export async function ownerSignIn(ownerClient, email, password) {
    const { data, error } = await ownerClient.auth.signInWithPassword({ email: String(email).trim(), password });
    if (error) throw toNubeError(error);
    return data.user;
}

export async function ownerSignUp(ownerClient, email, password, { redirectTo } = {}) {
    if (String(password || '').length < 8) throw new NubeError('La contraseña debe tener al menos 8 caracteres.');
    const { data, error } = await ownerClient.auth.signUp({
        email: String(email).trim(), password,
        options: redirectTo ? { emailRedirectTo: redirectTo } : undefined,
    });
    if (error) throw toNubeError(error);
    // Sin sesión = el proyecto exige confirmar el correo antes de entrar.
    return { user: data.user, needsConfirmation: !data.session };
}

/** ¿El error es «falta confirmar el correo»? (para mostrar «Revisa tu correo»). */
export function isEmailNotConfirmed(error) {
    const e = error?.cause || error;
    return /email_not_confirmed|Email not confirmed/i.test(`${e?.code || ''} ${e?.message || ''}`);
}

/** Reenvía el correo de confirmación de la cuenta del dueño. */
export async function resendConfirmation(ownerClient, email, redirectTo) {
    const { error } = await ownerClient.auth.resend({
        type: 'signup', email: String(email || '').trim(),
        options: redirectTo ? { emailRedirectTo: redirectTo } : undefined,
    });
    if (error) throw toNubeError(error);
}

/**
 * «¿Olvidaste tu contraseña?»: Supabase manda un enlace al correo que vuelve a `redirectTo`
 * con `#access_token=…&type=recovery`. No dice si el correo existe (respuesta igual).
 */
export async function requestPasswordReset(ownerClient, email, redirectTo) {
    const clean = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new NubeError('Escribe el correo del dueño para enviarte el enlace.');
    const { error } = await ownerClient.auth.resetPasswordForEmail(clean, { redirectTo });
    if (error) throw toNubeError(error);
}

/**
 * Lee el regreso de un enlace de correo en el hash de la URL.
 * Devuelve `{ accessToken, refreshToken }` (recuperar contraseña), `{ confirmed: true }`
 * (cuenta confirmada), `{ error }` si el enlace venció, o null.
 */
export function parseRecoveryHash(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    if (!raw) return null;
    const params = new URLSearchParams(raw);
    if (params.get('error') || params.get('error_code')) {
        return { error: toNubeError({ message: params.get('error_code') || params.get('error_description') || 'otp_expired' }).message };
    }
    if (['signup', 'email', 'email_change', 'invite'].includes(params.get('type'))) return { confirmed: true };
    if (params.get('type') !== 'recovery') return null;
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (!accessToken || !refreshToken) return null;
    return { accessToken, refreshToken };
}

/**
 * Guarda la contraseña nueva con la sesión del enlace y la cierra (el dueño vuelve a entrar).
 * Devuelve el correo de la cuenta para dejarlo escrito en «Entrar».
 */
export async function completePasswordReset(ownerClient, { accessToken, refreshToken }, newPassword) {
    if (String(newPassword || '').length < 8) throw new NubeError('La contraseña debe tener al menos 8 caracteres.');
    const { error: sessionError } = await ownerClient.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (sessionError) throw toNubeError(sessionError);
    const { data, error } = await ownerClient.auth.updateUser({ password: newPassword });
    if (error) throw toNubeError(error);
    await ownerSignOut(ownerClient);
    return data?.user?.email || null;
}

export async function ownerSignOut(ownerClient) {
    try { await ownerClient.auth.signOut(); } catch { /* sesión temporal: nada que limpiar */ }
}

/** Cuenta del dueño, o null si todavía no la creó. */
export async function getOwnerAccount(ownerClient) {
    const { data, error } = await ownerClient.from('accounts').select('id, name').limit(1);
    if (error) throw toNubeError(error);
    return data?.[0] ?? null;
}

export async function createAccount(ownerClient, { businessName, sedeName, ownerName, ownerPin }) {
    return rpc(ownerClient, 'create_account', {
        p_name: businessName, p_sede_name: sedeName, p_owner_name: ownerName, p_owner_pin: ownerPin,
    });
}

export async function registerDevice(ownerClient, { deviceUserId, label, role = 'caja', sedeId = null }) {
    return rpc(ownerClient, 'register_device', {
        p_device_user_id: deviceUserId, p_label: label, p_role: role, p_sede_id: sedeId,
    });
}

export async function listOwnerDevices(ownerClient) {
    const { data, error } = await ownerClient
        .from('account_devices')
        .select('id, label, role, caja_letter, sede_id, last_seen_at, revoked_at, created_at')
        .is('revoked_at', null)
        .order('created_at');
    if (error) throw toNubeError(error);
    return data ?? [];
}

export async function renameDevice(ownerClient, deviceId, { label = null, sedeId = null }) {
    return rpc(ownerClient, 'assign_device', { p_device_id: deviceId, p_label: label, p_sede_id: sedeId });
}

export async function revokeDevice(ownerClient, deviceId) {
    return rpc(ownerClient, 'revoke_device', { p_device_id: deviceId });
}

export async function upsertMember(ownerClient, { id = null, name, role, pin = null, active = true, sinPin = false }) {
    return rpc(ownerClient, 'upsert_member', {
        p_member_id: id, p_display_name: name, p_role: role, p_pin: sinPin ? null : pin, p_active: active,
        ...(sinPin ? { p_sin_pin: true } : {}),
    });
}

/** El dueño (correo y clave) repone su propio PIN. */
export async function ownerSetOwnPin(ownerClient, pin) {
    return rpc(ownerClient, 'owner_set_own_pin', { p_pin: pin });
}

// ─── Equipo desde la caja (sesión de PIN de dueño o administrador) ───────────

/**
 * Lee empleados con `pin_length` (cuántos dígitos pide su PIN; null = sin PIN). Si el
 * servidor aún no tiene la migración 012 (columna inexistente), repite sin ella.
 */
async function selectMembers(client, columns, refine) {
    let res = await refine(client.from('account_members').select(`${columns}, pin_length`));
    if (res.error && /pin_length/.test(`${res.error.message || ''}`)) {
        res = await refine(client.from('account_members').select(columns));
    }
    if (res.error) throw toNubeError(res.error);
    return res.data ?? [];
}

/** Todo el equipo, también los desactivados (para Ajustes → Usuarios). */
export async function listTeam(client) {
    return selectMembers(client, 'id, display_name, role, active, created_at', (q) => q.order('created_at'));
}

export async function teamUpsertMember(deviceClient, token, { id = null, name, role, pin = null, active = true, sinPin = false }) {
    if (!token) throw new NubeError('Tu sesión venció. Vuelve a entrar con tu PIN.');
    return rpc(deviceClient, 'team_upsert_member', {
        p_session: token, p_member_id: id, p_display_name: name, p_role: role, p_pin: sinPin ? null : (pin || null), p_active: active,
        ...(sinPin ? { p_sin_pin: true } : {}),
    });
}

/** El dueño, con su sesión de PIN, renombra un equipo. */
export async function teamRenameDevice(deviceClient, token, deviceId, { label = null, sedeId = null }) {
    if (!token) throw new NubeError('Tu sesión venció. Vuelve a entrar con tu PIN.');
    return rpc(deviceClient, 'team_rename_device', { p_session: token, p_device_id: deviceId, p_label: label, p_sede_id: sedeId });
}

/** El dueño, con su sesión de PIN, expulsa un equipo. */
export async function teamRevokeDevice(deviceClient, token, deviceId) {
    if (!token) throw new NubeError('Tu sesión venció. Vuelve a entrar con tu PIN.');
    return rpc(deviceClient, 'team_revoke_device', { p_session: token, p_device_id: deviceId });
}

export async function changeOwnPin(deviceClient, token, currentPin, newPin) {
    if (!token) throw new NubeError('Tu sesión venció. Vuelve a entrar con tu PIN.');
    return rpc(deviceClient, 'member_change_own_pin', { p_session: token, p_current_pin: currentPin, p_new_pin: newPin });
}

// ─── Empleados (PIN en el equipo) ────────────────────────────────────────────

export async function listMembers(client) {
    return selectMembers(client, 'id, display_name, role, active', (q) => q.eq('active', true).order('created_at'));
}

/** Entra con PIN. Devuelve la sesión `{ token, memberId, name, role, expiresAt }` o lanza. */
export async function loginWithPin(deviceClient, memberId, pin) {
    const rows = await rpc(deviceClient, 'member_login_pin', { p_member_id: memberId, p_pin: pin });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row?.session_token) throw new NubeError('PIN incorrecto.', { code: 'PIN_INCORRECTO' });
    return {
        token: row.session_token,
        memberId: row.member_id,
        name: row.display_name,
        role: row.role,
        expiresAt: row.expires_at,
    };
}

/** ¿La sesión de PIN sigue viva en este equipo? Devuelve el empleado o null. */
export async function checkMemberSession(deviceClient, token) {
    if (!token) return null;
    const rows = await rpc(deviceClient, 'current_member', { p_session: token });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return row?.member_id ? { memberId: row.member_id, name: row.display_name, role: row.role } : null;
}

export async function logoutMember(deviceClient, token) {
    if (!token) return;
    try { await rpc(deviceClient, 'member_logout', { p_session: token }); } catch { /* sin red: vence sola */ }
}

/** Rol de la nube → rol de la app heredada de Bodega. */
export function toAppRole(role) {
    return role === 'cajero' ? 'CAJERO' : 'ADMIN';
}
