import { afterEach, describe, expect, it, vi } from 'vitest';

describe('supabaseClient en modo LAN sin variables heredadas', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('no lanza error en boot cuando VITE_LAN_MODE=true y DEV=false aunque falten VITE_SUPABASE_URL/ANON_KEY', async () => {
        vi.resetModules();
        vi.stubEnv('DEV', false);
        vi.stubEnv('VITE_LAN_MODE', 'true');
        vi.stubEnv('VITE_SUPABASE_URL', '');
        vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

        const mod = await import('../../src/core/supabaseClient.js');
        expect(mod.supabase).toBeTruthy();
        await expect(mod.supabase.rpc('get_license_status')).rejects.toThrow(/SEC-021/);
    });
});
