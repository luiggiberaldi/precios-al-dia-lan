/**
 * badgeToken.js — Generación, verificación y codificación 1D (Code 39) de carnets de empleado.
 *
 * Formato del código: `PDA-<12 HEX MAYÚSCULAS>` (48 bits de entropía).
 *   - 100% compatible con lectores láser 1D (Code 39), lectores 2D (QR) y emulación teclado USB.
 *   - Sin caracteres especiales con Shift (evita desajustes de distribución de teclado ES/US).
 *   - El código en claro se muestra SOLO al crear/regenerar el carnet; en disco se guarda
 *     únicamente su hash PBKDF2 (`badgeHash`).
 *
 * @module security/badgeToken
 */
import { hashPin, verifyPin } from '../utils/crypto';

export const BADGE_PREFIX = 'PDA-';
const BADGE_PATTERN = /^PDA-[0-9A-F]{12}$/;

/** Normaliza una lectura del escáner (quita espacios, convierte a mayúsculas, corrige guiones). */
export function normalizeBadgeScan(raw) {
    if (typeof raw !== 'string') return '';
    // Algunos lectores con teclado ES convierten '-' en "'" o '/'; normalizamos al guión estándar.
    return raw.trim().toUpperCase().replace(/['/?_]/g, '-');
}

/** ¿La cadena escaneada tiene forma de carnet de empleado? */
export function isBadgeCode(raw) {
    return BADGE_PATTERN.test(normalizeBadgeScan(raw));
}

/** Genera un código de carnet aleatorio seguro (`PDA-XXXXXXXXXXXX`). */
export function generateBadgeCode() {
    const bytes = new Uint8Array(6);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i += 1) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `${BADGE_PREFIX}${hex}`;
}

/** Hashea un código de carnet con PBKDF2 para guardarlo en `user.badgeHash`. */
export async function hashBadgeCode(code) {
    const normalized = normalizeBadgeScan(code);
    if (!isBadgeCode(normalized)) {
        throw new Error('Código de carnet inválido');
    }
    return hashPin(normalized);
}

/** Verifica un código escaneado contra el `badgeHash` guardado de un usuario. */
export async function verifyBadgeCode(scannedCode, badgeHash) {
    if (!badgeHash || typeof badgeHash !== 'string') return false;
    const normalized = normalizeBadgeScan(scannedCode);
    if (!isBadgeCode(normalized)) return false;
    try {
        const res = await verifyPin(normalized, badgeHash);
        return Boolean(res?.valid);
    } catch {
        return false;
    }
}

/**
 * Busca en `usuarios` al propietario de un carnet escaneado.
 * Devuelve el usuario o `null` si ningún carnet coincide.
 */
export async function findUserByBadge(scannedCode, usuarios) {
    const normalized = normalizeBadgeScan(scannedCode);
    if (!isBadgeCode(normalized) || !Array.isArray(usuarios)) return null;
    for (const user of usuarios) {
        if (!user?.badgeHash) continue;
        const ok = await verifyBadgeCode(normalized, user.badgeHash);
        if (ok) return user;
    }
    return null;
}

// ── Codificador Code 39 puro a SVG (cero dependencias, compatible con todo lector láser 1D) ──

const CODE39_TABLE = Object.freeze({
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn',
    '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw',
    '8': 'wnnwnnwnn', '9': 'nnwwnnwnn', 'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw',
    'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn', 'F': 'nnwnwwnnn',
    'P': 'nnwnwnwnn', '-': 'nwnnnnwnw', '*': 'nwnnwnwnn',
});

/**
 * Genera los rectángulos SVG de un código de barras Code 39 (incluye delimitadores `*`).
 * @param {string} value - ej. `PDA-A7F3C91E4B02`
 * @returns {{ width: number, bars: Array<{ x: number, w: number }> }}
 */
export function encodeCode39Bars(value) {
    const text = `*${normalizeBadgeScan(value)}*`;
    const narrow = 2;
    const wide = 5;
    const gap = 2;
    let x = 10; // quiet zone izquierda
    const bars = [];

    for (let c = 0; c < text.length; c += 1) {
        const pattern = CODE39_TABLE[text[c]];
        if (!pattern) continue;
        for (let i = 0; i < pattern.length; i += 1) {
            const w = pattern[i] === 'w' ? wide : narrow;
            if (i % 2 === 0) {
                bars.push({ x, w });
            }
            x += w;
        }
        x += gap;
    }

    return { width: x + 10, bars };
}
