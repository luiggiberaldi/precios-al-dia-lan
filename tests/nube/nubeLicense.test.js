import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isAccountLicenseValid, setNubeLicense, getNubeLicense, subscribeNubeLicense } from '../../src/nube/nubeLicense';

const NOW = Date.parse('2026-11-16T12:00:00Z');

describe('licencia por cuenta (nube)', () => {
    beforeEach(() => setNubeLicense(null));

    it('prueba vigente abre premium', () => {
        expect(isAccountLicenseValid({ status: 'trial', expires_at: '2026-12-01T00:00:00Z' }, NOW)).toBe(true);
    });
    it('activa sin vencimiento abre premium', () => {
        expect(isAccountLicenseValid({ status: 'active', expires_at: null }, NOW)).toBe(true);
    });
    it('vencida, suspendida o ausente no abre', () => {
        expect(isAccountLicenseValid({ status: 'trial', expires_at: '2026-11-01T00:00:00Z' }, NOW)).toBe(false);
        expect(isAccountLicenseValid({ status: 'suspended', expires_at: null }, NOW)).toBe(false);
        expect(isAccountLicenseValid(null, NOW)).toBe(false);
    });
    it('publica, avisa y guarda para sin red', () => {
        const fn = vi.fn();
        const off = subscribeNubeLicense(fn);
        setNubeLicense({ status: 'trial', max_cajas: 2, max_sedes: 1, expires_at: '2026-12-01T00:00:00Z' });
        expect(fn).toHaveBeenCalledWith(expect.objectContaining({ status: 'trial' }));
        expect(getNubeLicense().max_cajas).toBe(2);
        expect(JSON.parse(localStorage.getItem('pdn_account_license')).status).toBe('trial');
        off();
    });
});
