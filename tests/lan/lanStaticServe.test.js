import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';

const cleanups = [];

afterEach(async () => {
    while (cleanups.length) {
        await cleanups.pop()().catch(() => {});
    }
});

describe('Servidor web local en Caja Principal (Supervisor móvil/PC sin internet)', () => {
    it('sirve archivos estáticos de dist/ con fallback SPA sin afectar endpoints /lan/*', async () => {
        const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdn-lan-static-'));
        cleanups.push(async () => fs.rmSync(staticDir, { recursive: true, force: true }));

        fs.mkdirSync(path.join(staticDir, 'assets'));
        fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><html><body>LAN-APP</body></html>');
        fs.writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'console.log("ok");');

        const srv = await createLanServer({ port: 0, host: '127.0.0.1', staticDir, enableDiscovery: false });
        cleanups.push(() => srv.close());

        const rootRes = await fetch(`${srv.baseUrl}/`);
        expect(rootRes.status).toBe(200);
        expect(rootRes.headers.get('content-type')).toContain('text/html');
        expect(await rootRes.text()).toContain('LAN-APP');

        const jsRes = await fetch(`${srv.baseUrl}/assets/app.js`);
        expect(jsRes.status).toBe(200);
        expect(jsRes.headers.get('content-type')).toContain('application/javascript');

        const spaRes = await fetch(`${srv.baseUrl}/supervisor`);
        expect(spaRes.status).toBe(200);
        expect(await spaRes.text()).toContain('LAN-APP');

        const healthRes = await fetch(`${srv.baseUrl}/lan/health`);
        expect(healthRes.status).toBe(200);
        expect((await healthRes.json()).ok).toBe(true);
    }, 60_000);
});
