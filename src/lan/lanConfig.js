/**
 * Configuración de red local (LAN) para Precios al Día LAN.
 */

export const LAN_PROTOCOL_VERSION = 1;
export const DEFAULT_LAN_PORT = 47800;
export const LAN_SERVER_URL_KEY = 'pdn_lan_server_url_v1';
export const LAN_ROLE_KEY = 'pdn_lan_device_role_v1';

export function isLanModeEnabled(env = import.meta.env) {
    return env?.VITE_LAN_MODE === 'true';
}

export function normalizeLanUrl(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    try {
        const parsed = new URL(withProtocol);
        if (!parsed.port && !/^https?:/i.test(trimmed)) {
            parsed.port = String(DEFAULT_LAN_PORT);
        }
        return `${parsed.protocol}//${parsed.host}`;
    } catch {
        return trimmed.replace(/\/+$/, '');
    }
}

export function getElectronLanApi() {
    if (typeof window === 'undefined') return null;
    return window.electronAPI?.lan || null;
}

export function getElectronUpdaterApi() {
    if (typeof window === 'undefined') return null;
    return window.electronAPI?.updater || null;
}

export const LAN_MANUAL_UPDATE_EVENT = 'pdn:manual-update-check';

export function triggerManualUpdateCheck() {
    const updater = getElectronUpdaterApi();
    if (!updater?.checkNow) return Promise.resolve(null);
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(LAN_MANUAL_UPDATE_EVENT));
    }
    return updater.checkNow();
}

export function getLanServerUrl() {
    try {
        const saved = globalThis.localStorage?.getItem(LAN_SERVER_URL_KEY);
        if (saved) return normalizeLanUrl(saved);
        // Si el dueño o una caja abre la app directamente desde el servidor LAN (ej. http://192.168.1.50:47800),
        // conectamos automáticamente a ese origen sin pedirle escribir la IP otra vez.
        if (typeof window !== 'undefined' && /^https?:$/i.test(window.location.protocol)) {
            const port = String(window.location.port || '');
            const host = window.location.hostname || '';
            const isDevOrTestPort = port === '5173' || port === '4173' || port === '3000';
            const isMasterLoopback = (host === '127.0.0.1' || host === 'localhost') && port === String(DEFAULT_LAN_PORT);
            const isLanIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host !== '127.0.0.1';
            const isLocalNetworkHost = isMasterLoopback || isLanIp || host.endsWith('.local');
            if (!isDevOrTestPort && isLocalNetworkHost && window.location.origin) {
                return normalizeLanUrl(window.location.origin);
            }
        }
        return '';
    } catch {
        return '';
    }
}

export function setLanServerUrl(url, role = null) {
    const normalized = normalizeLanUrl(url);
    try {
        if (normalized) {
            globalThis.localStorage?.setItem(LAN_SERVER_URL_KEY, normalized);
        } else {
            globalThis.localStorage?.removeItem(LAN_SERVER_URL_KEY);
        }
        if (role) {
            globalThis.localStorage?.setItem(LAN_ROLE_KEY, role);
        }
    } catch {
        /* entorno sin localStorage */
    }
    return normalized;
}

export function clearLanServerUrl() {
    try {
        globalThis.localStorage?.removeItem(LAN_SERVER_URL_KEY);
        globalThis.localStorage?.removeItem(LAN_ROLE_KEY);
    } catch {
        /* entorno sin localStorage */
    }
}

export function getSavedLanRole() {
    try {
        return globalThis.localStorage?.getItem(LAN_ROLE_KEY) || null;
    } catch {
        return null;
    }
}

export function isLocalMasterUrl(url = getLanServerUrl()) {
    if (!url) return false;
    try {
        const { hostname } = new URL(url);
        return hostname === '127.0.0.1' || hostname === 'localhost';
    } catch {
        return false;
    }
}
