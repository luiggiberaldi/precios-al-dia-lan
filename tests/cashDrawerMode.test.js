import { describe, expect, it } from 'vitest';
import {
    CASH_DRAWER_MODES,
    CASH_DRAWER_MODE_KEY,
    isSharedCashDrawerMode,
    normalizeCashDrawerMode,
    readCashDrawerMode,
    writeCashDrawerMode,
} from '../src/utils/cashDrawerMode';
import { findOpenCashShift, isRecordInOpenCashShift, isShiftCashMovement } from '../src/utils/cashShift';
import {
    SYNCED_BUSINESS_LS_KEYS,
    readBusinessConfigSnapshot,
    applyBusinessConfigSnapshot,
} from '../src/nube/businessConfigSync';

function makeMemoryStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
}

describe('Fase 1 — cashDrawerMode y turno compartido con shiftId', () => {
    it('usa cajas independientes ("separate") por defecto y normaliza valores inválidos', () => {
        const storage = makeMemoryStorage();
        expect(readCashDrawerMode(storage)).toBe(CASH_DRAWER_MODES.SEPARATE);
        expect(isSharedCashDrawerMode(storage)).toBe(false);
        expect(normalizeCashDrawerMode('otro')).toBe(CASH_DRAWER_MODES.SEPARATE);
        expect(normalizeCashDrawerMode('shared')).toBe(CASH_DRAWER_MODES.SHARED);
    });

    it('persiste "shared" en storage y viaja en pdn_business_config_v1', () => {
        expect(SYNCED_BUSINESS_LS_KEYS).toContain(CASH_DRAWER_MODE_KEY);
        const s1 = makeMemoryStorage();
        writeCashDrawerMode(CASH_DRAWER_MODES.SHARED, { storage: s1, notify: false });
        expect(isSharedCashDrawerMode(s1)).toBe(true);

        const snap = readBusinessConfigSnapshot(s1);
        expect(snap.cash_drawer_mode).toBe('shared');

        const s2 = makeMemoryStorage();
        const changed = applyBusinessConfigSnapshot(snap, { storage: s2, dispatch: () => {} });
        expect(changed).toContain('cash_drawer_mode');
        expect(isSharedCashDrawerMode(s2)).toBe(true);
    });

    it('isRecordInOpenCashShift usa shiftId cuando existe, incluso si los relojes de 2 PCs están desfasados', () => {
        const opening = {
            id: 'apertura_1',
            tipo: 'APERTURA_CAJA',
            shiftId: 'shift_abc',
            timestamp: '2026-11-27T12:00:00.000Z',
            cajaCerrada: false,
        };
        // Venta de PC 2 con reloj 3 minutos atrasado respecto a PC 1, pero mismo shiftId
        const saleSameShift = {
            id: 'v_pc2',
            tipo: 'VENTA',
            shiftId: 'shift_abc',
            timestamp: '2026-11-27T11:57:00.000Z',
            cajaCerrada: false,
        };
        // Venta de otro turno distinto aunque tenga timestamp posterior
        const saleOtherShift = {
            id: 'v_other',
            tipo: 'VENTA',
            shiftId: 'shift_old',
            timestamp: '2026-11-27T12:05:00.000Z',
            cajaCerrada: false,
        };

        expect(findOpenCashShift([opening, saleSameShift])).toEqual(opening);
        expect(isRecordInOpenCashShift(saleSameShift, opening)).toBe(true);
        expect(isShiftCashMovement(saleSameShift, opening)).toBe(true);
        expect(isRecordInOpenCashShift(saleOtherShift, opening)).toBe(false);
    });
});
