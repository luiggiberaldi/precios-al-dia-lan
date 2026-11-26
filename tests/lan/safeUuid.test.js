import { describe, it, expect } from 'vitest';
import { safeUuid } from '../../src/utils/safeUuid';

describe('safeUuid', () => {
    it('genera UUID v4 válido aunque crypto.randomUUID no exista (HTTP local)', () => {
        const fakeCrypto = { getRandomValues: (arr) => arr.fill(7) };
        const id = safeUuid(fakeCrypto);
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('funciona incluso sin objeto crypto', () => {
        const id = safeUuid(null);
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});
