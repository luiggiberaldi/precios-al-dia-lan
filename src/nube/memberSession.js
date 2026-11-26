/**
 * Sesión de PIN de la nube guardada en el equipo y su puente con el almacén de
 * usuarios heredado de Bodega (useAuthStore), que el resto de la app ya entiende.
 */
import { toAppRole } from './accountService';

export const MEMBER_SESSION_KEY = 'pdn-member-session';
// Misma clave que usa useAuthStore para la sesión activa (SESSION_KEY).
const LEGACY_SESSION_KEY = 'abasto-device-session';

export function readMemberSession(storage = globalThis.localStorage) {
    try {
        const raw = storage?.getItem(MEMBER_SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if ((!parsed?.token && !parsed?.offline) || !parsed?.memberId) return null;
        if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now()) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function saveMemberSession(session, storage = globalThis.localStorage) {
    storage?.setItem(MEMBER_SESSION_KEY, JSON.stringify(session));
}

export function clearMemberSession(storage = globalThis.localStorage) {
    storage?.removeItem(MEMBER_SESSION_KEY);
}

/** Sesión con la forma que espera la app heredada: solo { id, nombre, rol } (SEC-013). */
export function toLegacySession(session) {
    return { id: session.memberId, nombre: session.name, rol: toAppRole(session.role), nube: true };
}

/**
 * ¿La sesión activa la abrió la puerta de la nube (PIN validado por el servidor)?
 * La app heredada cierra sesión al arrancar si el login está activo; con la nube
 * eso expulsaría al empleado que acaba de entrar, así que no debe hacerlo.
 */
export function isNubeSession(usuarioActivo) {
    return Boolean(usuarioActivo && usuarioActivo.nube === true);
}

/** Abre la app heredada con el empleado de la nube. */
export function applyToAuthStore(authStore, session, storage = globalThis.localStorage) {
    const legacy = toLegacySession(session);
    authStore.setState({
        usuarioActivo: legacy,
        requireLogin: true,
        failedAttempts: 0,
        lockUntil: null,
        consecutiveLockouts: 0,
        lastFailedAttemptTs: 0,
    });
    storage?.setItem(LEGACY_SESSION_KEY, JSON.stringify(legacy));
    return legacy;
}
