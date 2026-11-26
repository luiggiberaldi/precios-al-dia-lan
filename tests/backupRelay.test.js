/**
 * tests/backupRelay.test.js — Relay de respaldos vía Estación Maestra (RLS-RELAY).
 *
 * Cubre:
 *  - relayUploadBackup / relayFetchBackup: feliz, error HTTP, red caída.
 *  - isRlsBlockedError: 42501 y variantes de mensaje; no confunde 401/403.
 *  - describeCloudError(42501).hint menciona el relay como acción.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { relayUploadBackup, relayFetchBackup, getEstacionApiUrl } from '../src/utils/backupRelay';
import { describeCloudError, isRlsBlockedError } from '../src/utils/cloudError';

const BASE = 'https://estacion.example';

// Fijar la URL base ANTES de importar el cliente (env se lee por llamada,
// pero el valor por defecto apunta a producción).
beforeAll(() => {
    import.meta.env.VITE_ESTACION_API_URL = BASE;
});

describe('getEstacionApiUrl', () => {
    it('usa el valor configurado en VITE_ESTACION_API_URL', () => {
        expect(getEstacionApiUrl()).toBe(BASE);
    });
});

describe('getEstacionApiUrl — guardarraíl de entorno (E2E-AUDIT H-infra)', () => {
    const ENV = import.meta.env;
    const URL_ENV_KEY = 'VITE_ESTACION_API_URL';

    afterEach(() => {
        // Los demás tests de este archivo exigen el BASE configurado.
        ENV[URL_ENV_KEY] = BASE;
    });

    it('SIN env en un build de producción apunta a producción', () => {
        delete ENV[URL_ENV_KEY];
        ENV.PROD = true;
        expect(getEstacionApiUrl()).toBe('https://estacion-2026.vercel.app');
    });

    it('SIN env fuera de producción devuelve "" y el relay se salta (nunca toca producción)', () => {
        delete ENV[URL_ENV_KEY];
        ENV.PROD = false;
        expect(getEstacionApiUrl()).toBe('');
    });

    it('el flag PROD no puede falsear un env configurado', () => {
        ENV[URL_ENV_KEY] = 'https://staging.example';
        ENV.PROD = false;
        expect(getEstacionApiUrl()).toBe('https://staging.example');
    });

    it('relayUploadBackup con URL vacía NO llama a fetch', async () => {
        delete ENV[URL_ENV_KEY];
        ENV.PROD = false;
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        try {
            const res = await relayUploadBackup('PDA-TEST', { hola: 1 });
            expect(res.skipped).toBe(true);
            expect(res.ok).toBe(false);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('relay desactivado (plan de fixeo F3 de la Estación)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('relayUploadBackup no llama a la red y responde "no disponible"', async () => {
        const res = await relayUploadBackup('PDA-TEST', { compressed: true, data: 'abc' });
        expect(res).toMatchObject({ ok: false, relayed: false, skipped: true });
        expect(res.error).toMatch(/no disponible/);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('relayFetchBackup no llama a la red y no inventa datos', async () => {
        const res = await relayFetchBackup('PDA-TEST');
        expect(res).toMatchObject({ ok: false, backupData: null, updatedAt: null, skipped: true });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('el módulo ya no lee el secreto común (no puede acabar en el JS público)', () => {
        const src = readFileSync(resolve(__dirname, '../src/utils/backupRelay.js'), 'utf8');
        expect(src).not.toMatch(/import\.meta\.env\??\.VITE_ESTACION_BACKUP_SECRET/);
        expect(src).not.toMatch(/x-backup-secret/);
    });
});

describe('isRlsBlockedError', () => {
    it('detecta 42501 por code', () => {
        expect(isRlsBlockedError({ code: '42501', message: 'x' })).toBe(true);
    });

    it('detecta RLS por mensaje sin code', () => {
        expect(isRlsBlockedError(new Error('violates row-level security policy'))).toBe(true);
    });

    it('no confunde 401/403 (credenciales) con RLS', () => {
        expect(isRlsBlockedError({ status: 401, message: 'JWT expired' })).toBe(false);
        expect(isRlsBlockedError({ status: 403, message: 'Forbidden' })).toBe(false);
    });

    it('null/string no relacionadas devuelven false', () => {
        expect(isRlsBlockedError(null)).toBe(false);
        expect(isRlsBlockedError('otro error')).toBe(false);
    });
});

describe('describeCloudError(42501) menciona acción de relay/export', () => {
    it('el hint orienta al usuario cuando RLS bloquea', () => {
        const info = describeCloudError({ code: '42501', message: 'row-level security' });
        expect(info.hint).toMatch(/Exportar respaldo|relay/i);
        expect(info.technical).toContain('42501');
    });
});
