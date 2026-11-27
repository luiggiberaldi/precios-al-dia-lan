/**
 * Verificación de PIN de administrador para acciones sensibles (Nómina · T21 / C17).
 *
 * En modo Bodega sin cuentas usa `useAuthStore.verifyAdminPin`.
 * En modo Nube / LAN valida contra el servidor (`member_login_pin`) o el pasaporte
 * offline LAN para el dueño/administrador activo, y SIEMPRE rechaza el legado `000000`.
 */
import { isNubeAccountsEnabled, getDeviceClient } from './nubeSupabase';
import { readMemberSession } from './memberSession';
import * as svc from './accountService';
import { isNetworkError } from './stockService';
import { isLanModeEnabled } from '../lan/lanConfig';
import { isPassportValid, readOfflinePassport, verifyOfflinePin } from '../lan/offlinePassport';

export async function verifyNubeAdminPin(pin, deps = {}) {
    const cleanPin = String(pin ?? '').trim();
    const nubeEnabled = deps.nubeEnabled ?? isNubeAccountsEnabled();
    if (!nubeEnabled) {
        if (typeof deps.fallbackAuthorize === 'function') {
            return deps.fallbackAuthorize(cleanPin);
        }
        return { success: false, error: 'PIN de administrador incorrecto.' };
    }

    if (!cleanPin || cleanPin === '000000' || !/^[0-9]{6,32}$/.test(cleanPin)) {
        return { success: false, error: 'PIN de administrador inválido (mínimo 6 dígitos).' };
    }

    const session = deps.readSession ? deps.readSession() : readMemberSession();
    if (!session?.memberId || !['dueno', 'administrador'].includes(session.role)) {
        return { success: false, error: 'Solo el dueño o un administrador pueden autorizar esta operación.' };
    }

    const client = deps.client ?? getDeviceClient();
    const loginFn = deps.loginWithPin ?? ((mId, p) => svc.loginWithPin(client, mId, p));
    const logoutFn = deps.logoutMember ?? ((tok) => svc.logoutMember(client, tok));

    try {
        const res = await loginFn(session.memberId, cleanPin);
        if (res?.token) {
            await Promise.resolve(logoutFn(res.token)).catch(() => {});
        }
        return {
            success: true,
            user: { id: session.memberId, nombre: res?.name || session.name || 'Administrador', rol: 'ADMIN' },
        };
    } catch (err) {
        const lanMode = deps.lanMode ?? isLanModeEnabled();
        if (lanMode && (isNetworkError(err) || isNetworkError(err?.cause))) {
            const passport = deps.readPassport ? deps.readPassport() : readOfflinePassport();
            if (isPassportValid(passport)) {
                const off = verifyOfflinePin(passport, session.memberId, cleanPin);
                if (off.valid) {
                    return {
                        success: true,
                        user: { id: session.memberId, nombre: off.member?.display_name || session.name || 'Administrador', rol: 'ADMIN' },
                    };
                }
                return { success: false, error: off.error || 'PIN de administrador incorrecto.' };
            }
        }
        return { success: false, error: err?.message || 'PIN de administrador incorrecto.' };
    }
}
