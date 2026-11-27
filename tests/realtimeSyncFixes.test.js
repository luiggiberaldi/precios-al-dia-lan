// @vitest-environment jsdom
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../desktop/server/lanServer.mjs';
import { createLanClient } from '../src/lan/lanClient';
import * as svc from '../src/nube/accountService';
import { createRecordSync, SYNCED_KEYS } from '../src/nube/recordSync';
import { applyBusinessConfigSnapshot, readBusinessConfigSnapshot, SYNCED_BUSINESS_LS_KEYS } from '../src/nube/businessConfigSync';
import { keepChannel } from '../src/nube/realtimeChannel';
import { mergeSupplierPayments } from '../src/utils/supplierLedger';

const cleanups = [];

afterEach(async () => {
    localStorage.clear();
    while (cleanups.length) {
        await Promise.resolve(cleanups.pop()()).catch(() => {});
    }
});

function makeMemStore() {
    const map = new Map();
    return {
        getItem: async (k) => (map.has(k) ? structuredClone(map.get(k)) : null),
        setItem: async (k, v) => { map.set(k, structuredClone(v)); },
    };
}

describe('Sincronización completa multi-caja (v1.1.4 fixes)', () => {
    it('1. recordSync sincroniza cuentas (bodega_accounts_v2), ventas en espera (holds) y bitácora (audit) incluso desde un cajero', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'fullsync@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Bodega Completa',
            sedeName: 'Principal',
            ownerName: 'Dueño',
            ownerPin: '123456',
        });

        const cajaA = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const cajaB = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uidA = await svc.ensureDeviceSession(cajaA);
        const uidB = await svc.ensureDeviceSession(cajaB);
        await svc.registerDevice(owner, { deviceUserId: uidA, label: 'Caja A', role: 'caja' });
        await svc.registerDevice(owner, { deviceUserId: uidB, label: 'Caja B', role: 'caja' });
        const cajeroId = await svc.upsertMember(owner, { name: 'Ana Cajera', role: 'cajero', pin: '1357' });
        const dueno = (await svc.listMembers(cajaA)).find((m) => m.role === 'dueno');
        const sessAdminA = await svc.loginWithPin(cajaA, dueno.id, '123456');
        const sessCajeroB = await svc.loginWithPin(cajaB, cajeroId, '1357');

        const localA = new Map();
        const localB = new Map();
        const syncA = createRecordSync({
            client: cajaA,
            getSession: () => sessAdminA.token,
            store: makeMemStore(),
            readLocal: async (k) => structuredClone(localA.get(k) ?? null),
            writeLocal: async (k, v) => { localA.set(k, structuredClone(v)); },
        });
        const syncB = createRecordSync({
            client: cajaB,
            getSession: () => sessCajeroB.token,
            store: makeMemStore(),
            canPush: (col) => ['customers', 'cash', 'cashea', 'holds', 'audit'].includes(col),
            readLocal: async (k) => structuredClone(localB.get(k) ?? null),
            writeLocal: async (k, v) => { localB.set(k, structuredClone(v)); },
        });

        // Admin guarda cuentas bancarias -> llega a Caja B
        const accounts = [{ id: 'acc-1', type: 'pago_movil', alias: 'Banesco', phone: '04141234567' }];
        localA.set('bodega_accounts_v2', accounts);
        await syncA.onLocalWrite('bodega_accounts_v2', accounts);
        await syncA.flush();

        // Cajero en Caja B pone venta en espera y registra entrada en bitácora -> llega a Caja A
        const holds = [{ id: 'hold-b1', nota: 'Cliente Juan', items: [{ id: 'p1', name: 'Café', qty: 1 }] }];
        localB.set('bodega_pending_holds_v1', holds);
        await syncB.onLocalWrite('bodega_pending_holds_v1', holds);
        const auditB = [{ id: 'aud-b1', ts: 2000, cat: 'VENTA', action: 'VENTA_COMPLETADA', desc: 'Venta $5' }];
        localB.set('abasto_audit_log_v1', auditB);
        await syncB.onLocalWrite('abasto_audit_log_v1', auditB);
        await syncB.flush();

        localA.set('abasto_audit_log_v1', [{ id: 'aud-a1', ts: 1000, cat: 'AUTH', action: 'LOGIN', desc: 'Inicio' }]);
        await syncB.pull(['settings']);
        await syncA.pull(['holds', 'audit']);

        expect(localB.get('bodega_accounts_v2')).toEqual(accounts);
        expect(localA.get('bodega_pending_holds_v1')).toEqual(holds);
        expect(localA.get('abasto_audit_log_v1').map((e) => e.id)).toEqual(['aud-b1', 'aud-a1']);
    }, 60_000);

    it('2. LAN SSE emite evento account_licenses al aplicar licencia offline y sedes al crear sede', async () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const pubJwk = publicKey.export({ format: 'jwk' });
        const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' });

        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'licsse@bodega.local', 'ClaveSegura123');
        const accountId = await svc.createAccount(owner, {
            businessName: 'Bodega Licencia SSE',
            sedeName: 'Centro',
            ownerName: 'Dueño',
            ownerPin: '123456',
        });

        const cajaB = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uidB = await svc.ensureDeviceSession(cajaB);
        await svc.registerDevice(owner, { deviceUserId: uidB, label: 'Caja B', role: 'caja' });

        const seen = [];
        let ready = false;
        const ch = keepChannel(
            cajaB,
            'sse-lic-sedes',
            (c) => c
                .on('postgres_changes', { event: '*', schema: 'public', table: 'account_licenses' }, (p) => seen.push({ t: 'lic', p }))
                .on('postgres_changes', { event: '*', schema: 'public', table: 'sedes' }, (p) => seen.push({ t: 'sede', p })),
            { onUp: () => { ready = true; } },
        );
        cleanups.push(() => ch.dispose());
        const waitReady = Date.now() + 3000;
        while (Date.now() < waitReady && !ready) {
            await new Promise((r) => setTimeout(r, 30));
        }
        expect(ready).toBe(true);

        const sinceRes = await srv.lanDb.applyOfflineLicenseToken(
            { id: (await owner.auth.getSession()).data.session.user.id, anonymous: false },
            (() => {
                const payloadStr = JSON.stringify({ status: 'active', maxCajas: 8, maxSedes: 4 });
                const sign = crypto.createSign('RSA-SHA256').update(payloadStr, 'utf8');
                return `${Buffer.from(payloadStr, 'utf8').toString('base64')}.${sign.sign(privPem, 'base64')}`;
            })(),
            pubJwk,
        );
        expect(sinceRes.max_cajas).toBe(8);
        expect(sinceRes.account_id).toBe(accountId);

        const sedeRes = await owner.rpc('create_sede', { p_name: 'Sucursal Norte' });
        expect(sedeRes.error).toBeNull();

        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && !seen.some((x) => x.t === 'sede')) {
            await new Promise((r) => setTimeout(r, 40));
        }
        expect(seen.some((x) => x.t === 'sede' && x.p?.new?.name === 'Sucursal Norte')).toBe(true);
        const { data: licB } = await cajaB.from('account_licenses').select('status, max_cajas, max_sedes');
        expect(licB[0]).toMatchObject({ status: 'active', max_cajas: 8, max_sedes: 4 });
    }, 60_000);

    it('3. businessConfigSync incluye granel_unit_mode, admin_auto_lock_minutes y logos hasta 85k chars', () => {
        expect(SYNCED_BUSINESS_LS_KEYS).toContain('granel_unit_mode');
        expect(SYNCED_BUSINESS_LS_KEYS).toContain('admin_auto_lock_minutes');
        const mediumLogo = `data:image/png;base64,${'A'.repeat(70_000)}`;
        localStorage.setItem('business_logo', mediumLogo);
        localStorage.setItem('granel_unit_mode', 'gr_ml');
        localStorage.setItem('admin_auto_lock_minutes', '5');
        const snap = readBusinessConfigSnapshot(localStorage);
        expect(snap.business_logo).toBe(mediumLogo);
        expect(snap.granel_unit_mode).toBe('gr_ml');
        expect(snap.admin_auto_lock_minutes).toBe('5');

        localStorage.clear();
        const changed = applyBusinessConfigSnapshot(snap, { storage: localStorage });
        expect(changed).toEqual(expect.arrayContaining(['business_logo', 'granel_unit_mode', 'admin_auto_lock_minutes']));
    });

    it('4. mergeSupplierPayments une pagos locales y pagos remotos de otras cajas sin duplicar y respetando anulaciones', () => {
        const localSales = [
            { id: 'loc-1', tipo: 'PAGO_PROVEEDOR', supplierId: 'sup-1', invoiceId: 'inv-1', totalUsd: -25, timestamp: '2026-11-26T10:00:00Z' },
            { id: 'loc-void', tipo: 'PAGO_PROVEEDOR', supplierId: 'sup-1', invoiceId: 'inv-2', totalUsd: -15, timestamp: '2026-11-26T11:00:00Z' },
        ];
        const supplierLedger = [
            // Pago local duplicado por sourceId
            { id: 'mov-1', supplierId: 'sup-1', type: 'PAGO', amountUsd: 25, invoiceId: 'inv-1', sourceId: 'loc-1', timestamp: '2026-11-26T10:00:00Z' },
            // Pago registrado desde otra PC
            { id: 'mov-remote', supplierId: 'sup-1', type: 'PAGO', amountUsd: 40, invoiceId: 'inv-3', sourceId: 'rem-pay-1', reason: 'Pago desde Caja B', timestamp: '2026-11-26T12:00:00Z' },
            // Pago de otra PC que luego fue anulado
            { id: 'mov-rem-void', supplierId: 'sup-1', type: 'PAGO', amountUsd: 10, sourceId: 'rem-pay-void', timestamp: '2026-11-26T12:30:00Z' },
            { id: 'mov-annul-rem', supplierId: 'sup-1', type: 'ANULACION_PAGO', amountUsd: 10, sourceId: 'rem-pay-void', timestamp: '2026-11-26T12:40:00Z' },
            // Anulación del pago local loc-void
            { id: 'mov-annul-loc', supplierId: 'sup-1', type: 'ANULACION_PAGO', amountUsd: 15, sourceId: 'loc-void', timestamp: '2026-11-26T13:00:00Z' },
        ];

        const merged = mergeSupplierPayments(localSales, supplierLedger, 'sup-1');
        const active = merged.filter((p) => p.status !== 'ANULADA');
        expect(active.map((p) => p.id)).toEqual(['loc-1', 'rem-pay-1']);
        expect(active[1].totalUsd).toBe(-40);
        expect(active[1]._remoteLedger).toBe(true);
    });

    it('5. optional collections degrada limpiamente ante servidores sin migración 022', async () => {
        const client = {
            rpc: async (_fn, { p_collection }) => {
                if (p_collection === 'holds' || p_collection === 'audit') {
                    return { data: null, error: { code: '22023', message: 'Colección inválida' } };
                }
                return { data: [], error: null };
            },
            from: () => ({
                select: () => ({
                    eq: () => ({
                        gt: () => ({ order: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
                        order: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
                    }),
                }),
            }),
        };
        const sync = createRecordSync({
            client,
            getSession: () => 'sess-1',
            store: makeMemStore(),
            readLocal: async () => [],
            writeLocal: async () => {},
        });
        expect(Boolean(SYNCED_KEYS.bodega_pending_holds_v1.optional)).toBe(true);
        await sync.onLocalWrite('bodega_pending_holds_v1', [{ id: 'h1', items: [] }]);
        await sync.flush();
        expect(sync.getLastError()).toBeNull();
    });
});
