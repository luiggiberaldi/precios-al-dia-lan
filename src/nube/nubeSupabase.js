/**
 * Clientes de Supabase de Precios al Día Nube.
 *
 * · `getDeviceClient()`: la sesión PROPIA del equipo (anónima, persistente). Es la que
 *   usan las cajas todo el día. Nunca guarda la sesión del dueño.
 * · `createOwnerClient()`: sesión temporal del dueño (correo y clave) solo para crear la
 *   cuenta, registrar equipos o administrarlos. No se guarda en el equipo.
 *
 * Sin variables usa la dirección `.invalid` (baranda G3): nunca la base de Precios al Día.
 */
import { createClient } from '@supabase/supabase-js';
import { createLanClient } from '../lan/lanClient';
import { getLanServerUrl, isLanModeEnabled } from '../lan/lanConfig';

const SIN_CONFIGURAR = 'https://supabase-sin-configurar.invalid';

export function nubeSupabaseConfig(env = import.meta.env) {
    return {
        url: env?.VITE_SUPABASE_CLOUD_URL || env?.VITE_SUPABASE_URL || SIN_CONFIGURAR,
        key: env?.VITE_SUPABASE_CLOUD_KEY || env?.VITE_SUPABASE_ANON_KEY || 'sin-llave',
    };
}

/** ¿La puerta de cuentas de la nube está encendida? (VITE_NUBE_ACCOUNTS=true o VITE_LAN_MODE=true) */
export function isNubeAccountsEnabled(env = import.meta.env) {
    return env?.VITE_NUBE_ACCOUNTS === 'true' || env?.VITE_LAN_MODE === 'true';
}

export const DEVICE_AUTH_STORAGE_KEY = 'pdn-device-auth';

let deviceClient = null;

export function resetDeviceClient() {
    deviceClient = null;
}

export function getDeviceClient() {
    if (!deviceClient) {
        if (isLanModeEnabled()) {
            deviceClient = createLanClient({
                getBaseUrl: getLanServerUrl,
                storageKey: DEVICE_AUTH_STORAGE_KEY,
                persistSession: true,
            });
            return deviceClient;
        }
        const { url, key } = nubeSupabaseConfig();
        deviceClient = createClient(url, key, {
            auth: {
                storageKey: DEVICE_AUTH_STORAGE_KEY,
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: false,
            },
        });
    }
    return deviceClient;
}

export function createOwnerClient() {
    if (isLanModeEnabled()) {
        return createLanClient({
            getBaseUrl: getLanServerUrl,
            storageKey: 'pdn-owner-temporal',
            persistSession: false,
        });
    }
    const { url, key } = nubeSupabaseConfig();
    return createClient(url, key, {
        auth: {
            storageKey: 'pdn-owner-temporal',
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
        },
    });
}
