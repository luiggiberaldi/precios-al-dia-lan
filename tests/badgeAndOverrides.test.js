import { describe, it, expect, beforeEach } from 'vitest';
import {
    generateBadgeCode,
    isBadgeCode,
    normalizeBadgeScan,
    hashBadgeCode,
    verifyBadgeCode,
    findUserByBadge,
    encodeCode39Bars,
} from '../src/security/badgeToken';
import { useAuthStore } from '../src/hooks/store/useAuthStore';
import { PERMISSIONS, can } from '../src/security/permissions';
import { sanitizeUserCatalog } from '../src/utils/userCatalog';
import { hashPin } from '../src/utils/crypto';

describe('Phase 3: Employee Badge (Carnet) & Per-User Overrides', () => {
    it('generates valid PDA-XXXXXXXXXXXX badge codes and encodes Code 39 SVG bars', () => {
        const code = generateBadgeCode();
        expect(isBadgeCode(code)).toBe(true);
        expect(normalizeBadgeScan(`  ${code.toLowerCase().replace('-', "'")}  `)).toBe(code);

        const bars = encodeCode39Bars(code);
        expect(bars.width).toBeGreaterThan(100);
        expect(bars.bars.length).toBeGreaterThan(20);
    });

    it('hashes and verifies badge codes securely and strips badgeHash on cloud sanitize', async () => {
        const code = generateBadgeCode();
        const badgeHash = await hashBadgeCode(code);
        expect(badgeHash).not.toContain(code);
        expect(await verifyBadgeCode(code, badgeHash)).toBe(true);
        expect(await verifyBadgeCode('PDA-000000000000', badgeHash)).toBe(false);

        const users = [
            { id: 1, nombre: 'Dueño', rol: 'DUENO', badgeHash },
            { id: 2, nombre: 'Cajero', rol: 'CAJERO' },
        ];
        const found = await findUserByBadge(code, users);
        expect(found?.id).toBe(1);

        const sanitized = sanitizeUserCatalog(users);
        expect(sanitized[0]).not.toHaveProperty('badgeHash');
    });

    describe('useAuthStore Phase 3 actions', () => {
        beforeEach(async () => {
            const ownerPin = await hashPin('482913');
            const cajeroPin = await hashPin('123456');
            useAuthStore.setState({
                usuarios: [
                    { id: 1, nombre: 'Dueño', rol: 'DUENO', pin: ownerPin, requirePin: true },
                    { id: 2, nombre: 'María', rol: 'CAJERO', pin: cajeroPin, requirePin: false },
                ],
                usuarioActivo: { id: 2, nombre: 'María', rol: 'CAJERO' },
                requireLogin: true,
                failedAttempts: 0,
                lockUntil: null,
                consecutiveLockouts: 0,
                lastFailedAttemptTs: 0,
            });
        });

        it('generates a badge, logs in with badge, and invalidates after revoke', async () => {
            const gen = await useAuthStore.getState().generarCarnetUsuario(1);
            expect(gen.ok).toBe(true);
            expect(isBadgeCode(gen.code)).toBe(true);

            const loginRes = await useAuthStore.getState().loginWithBadge(gen.code);
            expect(loginRes.success).toBe(true);
            expect(useAuthStore.getState().usuarioActivo?.id).toBe(1);

            useAuthStore.getState().revocarCarnetUsuario(1);
            const afterRevoke = await useAuthStore.getState().loginWithBadge(gen.code);
            expect(afterRevoke.success).toBe(false);
        });

        it('authorizes a restricted action with manager PIN or manager Badge without logging out cashier', async () => {
            const gen = await useAuthStore.getState().generarCarnetUsuario(1);
            // Cajero tries to authorize with own PIN -> rejected (no SALES_VOID permission)
            const denied = await useAuthStore.getState().authorizeActionWithPinOrBadge('123456', PERMISSIONS.SALES_VOID);
            expect(denied.ok).toBe(false);

            // Manager authorizes with PIN
            const okPin = await useAuthStore.getState().authorizeActionWithPinOrBadge('482913', PERMISSIONS.SALES_VOID);
            expect(okPin.ok).toBe(true);
            expect(okPin.method).toBe('pin');
            expect(okPin.authorizer?.id).toBe(1);

            // Manager authorizes with Badge
            const okBadge = await useAuthStore.getState().authorizeActionWithPinOrBadge(gen.code, PERMISSIONS.SALES_VOID);
            expect(okBadge.ok).toBe(true);
            expect(okBadge.method).toBe('badge');
            expect(okBadge.authorizer?.id).toBe(1);

            // Cashier is still the active session!
            expect(useAuthStore.getState().usuarioActivo?.id).toBe(2);
        });

        it('grants per-user override permissions and reflects immediately in active session', () => {
            expect(can(useAuthStore.getState().usuarioActivo, PERMISSIONS.SALES_DISCOUNT)).toBe(false);
            useAuthStore.getState().actualizarPermisosUsuario(2, { allow: [PERMISSIONS.SALES_DISCOUNT], deny: [] });
            expect(can(useAuthStore.getState().usuarioActivo, PERMISSIONS.SALES_DISCOUNT)).toBe(true);
        });
    });
});
