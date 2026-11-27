// @vitest-environment jsdom
//
// T13 · Timeouts HTTP, Watchdog SSE de 45s, manejo de 401 y backpressure SSE (C20, A12, MED-10).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLanClient, probeLanServer } from '../../src/lan/lanClient.js';
import { createLanServer } from '../../desktop/server/lanServer.mjs';

describe('T13 · Resiliencia de transporte LAN (timeouts HTTP, watchdog SSE, 401 y backpressure)', () => {
    const serversToClose = [];
    afterEach(async () => {
        while (serversToClose.length) {
            const s = serversToClose.pop();
            await s.close().catch(() => {});
        }
    });

    it('1. C20 requestJson y probeLanServer abortan con timeout cuando el servidor no responde', async () => {
        const hangingFetch = (_url, opts = {}) => new Promise((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                reject(err);
            });
        });

        const client = createLanClient({
            baseUrl: 'http://127.0.0.1:47999',
            persistSession: false,
            fetchImpl: hangingFetch,
            requestTimeoutMs: 60,
        });

        const start = Date.now();
        const res = await client.rpc('ping', {});
        const elapsed = Date.now() - start;

        expect(res.error).toBeTruthy();
        expect(res.error.status).toBe(0);
        expect(res.error.message).toMatch(/timeout|Failed to fetch|aborted/i);
        expect(elapsed).toBeLessThan(1000);

        await expect(probeLanServer('http://127.0.0.1:47999', hangingFetch, { timeoutMs: 60 }))
            .rejects.toThrow(/timeout|aborted|tardó/i);
    });

    it('2. C20 watchdog SSE aborta un stream silencioso tras sseIdleTimeoutMs y emite CHANNEL_ERROR', async () => {
        const encoder = new TextEncoder();
        let streamAborted = false;

        const fakeFetch = async (url, opts = {}) => {
            if (url.endsWith('/lan/events')) {
                const stream = new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode('event: connected\ndata: {"ok":true}\n\n'));
                        opts.signal?.addEventListener('abort', () => {
                            streamAborted = true;
                            try { controller.error(new Error('Aborted by watchdog')); } catch { /* ok */ }
                        });
                    },
                });
                return { ok: true, status: 200, body: stream };
            }
            if (url.endsWith('/lan/auth/device')) {
                return { ok: true, status: 200, json: async () => ({ token: 'tok-1', user: { id: 'u1', anonymous: true } }) };
            }
            return { ok: true, status: 200, json: async () => ({}) };
        };

        const client = createLanClient({
            baseUrl: 'http://127.0.0.1:47998',
            persistSession: false,
            fetchImpl: fakeFetch,
            sseIdleTimeoutMs: 120,
        });
        await client.auth.signInAnonymously();

        const statuses = [];
        const ch = client.channel('test-watchdog').subscribe((st) => statuses.push(st));

        await new Promise((r) => setTimeout(r, 260));
        await client.removeChannel(ch);

        expect(statuses).toContain('SUBSCRIBED');
        expect(statuses).toContain('CHANNEL_ERROR');
        expect(streamAborted).toBe(true);
    });

    it('3. MED-10 /lan/query con Bearer inválido devuelve 401 y lanClient emite pdn_lan_session_expired', async () => {
        const srv = await createLanServer({ port: 0, enableDiscovery: false });
        serversToClose.push(srv);

        // Petición directa con token inexistente -> debe devolver 401 (no correr como anon!)
        const rawRes = await fetch(`${srv.baseUrl}/lan/query`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer token-inexistente-revocado',
            },
            body: JSON.stringify({ table: 'account_records', select: 'id' }),
        });
        expect(rawRes.status).toBe(401);

        // lanClient debe emitir evento pdn_lan_session_expired al recibir 401
        let expiredEvents = 0;
        const onExpired = () => { expiredEvents += 1; };
        window.addEventListener('pdn_lan_session_expired', onExpired);
        try {
            const client = createLanClient({
                baseUrl: srv.baseUrl,
                persistSession: false,
                fetchImpl: async () => ({
                    ok: false,
                    status: 401,
                    json: async () => ({ error: 'Sesión inválida' }),
                }),
            });
            const res = await client.rpc('member_login_pin', {});
            expect(res.error?.status).toBe(401);
            expect(expiredEvents).toBeGreaterThanOrEqual(1);
        } finally {
            window.removeEventListener('pdn_lan_session_expired', onExpired);
        }
    }, 60_000);
});
