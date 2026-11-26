// Precios al Día Nube · Licencia por CUENTA (D7).
//
// En la nube la licencia no es por equipo (tabla `licenses` + RPC de Bodega), sino
// una fila de `account_licenses` por negocio. NubeGate la lee al abrir y cada pocos
// minutos y la publica aquí; useSecurity (modo nube) se suscribe para decidir si las
// funciones premium están abiertas. Se guarda la última conocida para operar sin red.

const CACHE_KEY = 'pdn_account_license';
const listeners = new Set();
let current = readCache();

function readCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

/** Fecha de vencimiento en ms, o null si no vence. */
export function licenseExpiresAtMs(license) {
    if (!license?.expires_at) return null;
    const ms = new Date(license.expires_at).getTime();
    return Number.isFinite(ms) ? ms : null;
}

/** ¿La licencia de la cuenta abre las funciones premium ahora mismo? */
export function isAccountLicenseValid(license, now = Date.now()) {
    if (!license || !['trial', 'active'].includes(license.status)) return false;
    const exp = licenseExpiresAtMs(license);
    return exp === null || exp > now;
}

export function getNubeLicense() {
    return current;
}

/** NubeGate publica la licencia leída del servidor (null = equipo sin cuenta). */
export function setNubeLicense(license) {
    current = license ? {
        status: license.status,
        max_cajas: license.max_cajas,
        max_sedes: license.max_sedes,
        expires_at: license.expires_at ?? null,
    } : null;
    try {
        if (current) localStorage.setItem(CACHE_KEY, JSON.stringify(current));
        else localStorage.removeItem(CACHE_KEY);
    } catch { /* almacenamiento no disponible */ }
    listeners.forEach((fn) => fn(current));
}

export function subscribeNubeLicense(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
