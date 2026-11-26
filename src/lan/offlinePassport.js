/**
 * Pasaporte Offline para cajas PC en red local (LAN).
 *
 * Guarda una copia local del equipo, empleados y verificadores de PIN con sal
 * para que una caja pueda arrancar, validar el PIN del empleado y vender hasta 72 h
 * incluso si la Caja Principal o el router están apagados al encender la computadora.
 * Usa SHA-256 en JavaScript puro para funcionar también en HTTP local sin `crypto.subtle`.
 */

export const OFFLINE_PASSPORT_KEY = 'pdn_lan_offline_passport_v1';
export const OFFLINE_PASSPORT_ATTEMPTS_KEY = 'pdn_lan_offline_pin_attempts_v1';
const PASSPORT_ITERATIONS = 1000;

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

export function sha256Hex(str) {
    const bytes = new TextEncoder().encode(String(str ?? ''));
    const len = bytes.length;
    const bitLen = len * 8;
    const paddedLen = Math.ceil((len + 9) / 64) * 64;
    const buf = new Uint8Array(paddedLen);
    buf.set(bytes);
    buf[len] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
    view.setUint32(paddedLen - 4, bitLen >>> 0, false);

    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;

    const w = new Uint32Array(64);
    for (let offset = 0; offset < paddedLen; offset += 64) {
        for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
        for (let i = 16; i < 64; i += 1) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = h0; let b = h1; let c = h2; let d = h3;
        let e = h4; let f = h5; let g = h6; let h = h7;
        for (let i = 0; i < 64; i += 1) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e; e = (d + temp1) >>> 0;
            d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
}

export function deriveOfflinePinDigest(pin, salt, memberId, iterations = PASSPORT_ITERATIONS) {
    let hash = sha256Hex(`${salt}:${memberId}:${pin}`);
    for (let i = 1; i < iterations; i += 1) {
        hash = sha256Hex(`${hash}:${salt}`);
    }
    return hash;
}

function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export function saveOfflinePassport(passport, storage = globalThis.localStorage) {
    if (!passport?.device?.id) return;
    try {
        storage?.setItem(OFFLINE_PASSPORT_KEY, JSON.stringify(passport));
    } catch {
        /* sin almacenamiento */
    }
}

export function readOfflinePassport(storage = globalThis.localStorage) {
    try {
        const raw = storage?.getItem(OFFLINE_PASSPORT_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function clearOfflinePassport(storage = globalThis.localStorage) {
    try {
        storage?.removeItem(OFFLINE_PASSPORT_KEY);
        storage?.removeItem(OFFLINE_PASSPORT_ATTEMPTS_KEY);
    } catch {
        /* sin almacenamiento */
    }
}

export function isPassportValid(passport, now = Date.now()) {
    if (!passport?.device?.id || !Array.isArray(passport?.members)) return false;
    const exp = Date.parse(passport.expiresAt || '');
    return Number.isFinite(exp) && exp > now;
}

function readAttempts(storage) {
    try {
        return JSON.parse(storage?.getItem(OFFLINE_PASSPORT_ATTEMPTS_KEY) || '{}') || {};
    } catch {
        return {};
    }
}

function writeAttempts(map, storage) {
    try {
        storage?.setItem(OFFLINE_PASSPORT_ATTEMPTS_KEY, JSON.stringify(map));
    } catch {
        /* sin almacenamiento */
    }
}

/**
 * Valida el PIN de un empleado en modo sin conexión usando el Pasaporte Offline.
 * Aplica bloqueo progresivo tras 5 intentos fallidos (30s → 15 min) igual que el servidor.
 */
export function verifyOfflinePin(passport, memberId, pin, { now = Date.now(), storage = globalThis.localStorage } = {}) {
    if (!isPassportValid(passport, now)) {
        return { valid: false, error: 'Tu permiso sin conexión venció (72 h). Conéctate con la Caja Principal.' };
    }
    const member = passport.members.find((m) => m.id === memberId && m.active !== false);
    if (!member) {
        return { valid: false, error: 'Usuario no disponible en este pasaporte.' };
    }
    const attempts = readAttempts(storage);
    const rec = attempts[memberId] || { failed: 0, lockouts: 0, lockedUntil: 0 };
    if (rec.lockedUntil && rec.lockedUntil > now) {
        const secs = Math.ceil((rec.lockedUntil - now) / 1000);
        return { valid: false, error: `Bloqueado. Demasiados intentos. Espera ${secs} segundos.` };
    }

    const verifier = passport.verifiers?.[memberId];
    if (!verifier) {
        return { valid: false, error: 'Este usuario necesita iniciar sesión una vez conectado para habilitar el modo sin red.' };
    }

    let ok = false;
    if (verifier.noPin) {
        ok = pin === null || pin === undefined || pin === '';
    } else if (typeof pin === 'string' && pin.length > 0) {
        const candidate = deriveOfflinePinDigest(pin, verifier.salt, memberId, verifier.iterations || PASSPORT_ITERATIONS);
        ok = constantTimeEqual(candidate, verifier.hash);
    }

    if (!ok) {
        const failed = (rec.failed || 0) + 1;
        if (failed >= 5) {
            const lockouts = (rec.lockouts || 0) + 1;
            const waitMs = Math.min(30_000 * (2 ** (lockouts - 1)), 15 * 60_000);
            attempts[memberId] = { failed: 0, lockouts, lockedUntil: now + waitMs };
            writeAttempts(attempts, storage);
            return { valid: false, error: `Bloqueado. Demasiados intentos. Espera ${Math.ceil(waitMs / 1000)} segundos.` };
        }
        attempts[memberId] = { ...rec, failed };
        writeAttempts(attempts, storage);
        return { valid: false, error: 'PIN incorrecto.' };
    }

    if (attempts[memberId]) {
        delete attempts[memberId];
        writeAttempts(attempts, storage);
    }
    return { valid: true, member };
}
