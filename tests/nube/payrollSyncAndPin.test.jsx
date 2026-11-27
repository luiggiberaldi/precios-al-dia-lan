// @vitest-environment jsdom
/**
 * T21 · Nómina multi-caja:
 *   1. C17: `verifyNubeAdminPin` valida el PIN real de dueño/admin contra servidor/pasaporte
 *      y SIEMPRE rechaza el legado `000000` en modo Nube/LAN.
 *   2. `employees` y `payroll_entries` sincronizan entre Caja A y Caja B por recordSync.
 *   3. `recoverPayroll` NO anula en Caja B los renglones de nómina creados en Caja A.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import { createRecordSync } from '../../src/nube/recordSync';
import { verifyNubeAdminPin } from '../../src/nube/nubeAdminPin';
import { recoverPayroll } from '../../src/services/payrollService';
import { setNubeLocalWriteHandler } from '../../src/nube/localWriteHook';

const cleanups = [];

afterEach(async () => {
    setNubeLocalWriteHandler(null);
    localStorage.clear();
    while (cleanups.length) {
        await cleanups.pop()().catch(() => {});
    }
});

function makeMemStore() {
    const map = new Map();
    return {
        getItem: async (k) => (map.has(k) ? map.get(k) : null),
        setItem: async (k, v) => { map.set(k, v); },
    };
}

describe('T21 · Nómina multi-caja y validación real de PIN admin', () => {
    it('1. C17: verifyNubeAdminPin rechaza 000000 y valida el PIN real contra el servidor LAN', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'nomina@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Abasto Nómina',
            sedeName: 'Principal',
            ownerName: 'Dueño',
            ownerPin: '852963',
        });

        const caja = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uid = await svc.ensureDeviceSession(caja);
        await svc.registerDevice(owner, { deviceUserId: uid, label: 'Caja A', role: 'caja' });
        const dueno = (await svc.listMembers(caja)).find((m) => m.role === 'dueno');
        const cajeroId = await svc.upsertMember(owner, { name: 'Cajero', role: 'cajero', pin: '1234' });

        // 1) Legado 000000 siempre rechazado
        const rLegacy = await verifyNubeAdminPin('000000', {
            nubeEnabled: true,
            client: caja,
            readSession: () => ({ memberId: dueno.id, role: 'dueno', name: 'Dueño' }),
        });
        expect(rLegacy.success).toBe(false);

        // 2) PIN incorrecto rechazado
        const rBad = await verifyNubeAdminPin('111111', {
            nubeEnabled: true,
            client: caja,
            readSession: () => ({ memberId: dueno.id, role: 'dueno', name: 'Dueño' }),
        });
        expect(rBad.success).toBe(false);

        // 3) Cajero rechazado aunque tenga sesión
        const rCajero = await verifyNubeAdminPin('852963', {
            nubeEnabled: true,
            client: caja,
            readSession: () => ({ memberId: cajeroId, role: 'cajero', name: 'Cajero' }),
        });
        expect(rCajero.success).toBe(false);

        // 4) PIN real del dueño aprobado
        const rOk = await verifyNubeAdminPin('852963', {
            nubeEnabled: true,
            client: caja,
            readSession: () => ({ memberId: dueno.id, role: 'dueno', name: 'Dueño' }),
        });
        expect(rOk.success).toBe(true);
        expect(rOk.user?.nombre).toBe('Dueño');
    }, 60_000);

    it('2. Empleados y renglones de nómina sincronizan entre Caja A y Caja B, y recoverPayroll en Caja B no anula renglones de Caja A', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'nom2@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Abasto Nómina 2',
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
        const dueno = (await svc.listMembers(cajaA)).find((m) => m.role === 'dueno');
        const sessA = await svc.loginWithPin(cajaA, dueno.id, '123456');
        const sessB = await svc.loginWithPin(cajaB, dueno.id, '123456');

        const localA = new Map();
        const localB = new Map();
        const recA = createRecordSync({
            client: cajaA,
            getSession: () => sessA.token,
            store: makeMemStore(),
            readLocal: async (k) => localA.get(k) ?? null,
            writeLocal: async (k, v) => { localA.set(k, v); },
        });
        const recB = createRecordSync({
            client: cajaB,
            getSession: () => sessB.token,
            store: makeMemStore(),
            readLocal: async (k) => localB.get(k) ?? null,
            writeLocal: async (k, v) => { localB.set(k, v); },
        });

        const emp = { id: 'emp-1', nombre: 'Carlos', sueldoUsd: 120, frecuencia: 'quincenal', activo: true };
        const entry = {
            id: 'nom-1',
            employeeId: 'emp-1',
            periodoId: '2026-11-Q2',
            tipo: 'ADELANTO',
            montoUsd: 25,
            movimientoCajaId: 'gasto_nom_caja_a',
            createdByDevice: 'DEVICE-A',
            status: 'ACTIVO',
        };
        localA.set('bodega_employees_v1', [emp]);
        localA.set('bodega_payroll_entries_v1', [entry]);
        await recA.onLocalWrite('bodega_employees_v1', [emp]);
        await recA.onLocalWrite('bodega_payroll_entries_v1', [entry]);
        await recA.flush();

        await recB.pull(['employees', 'payroll_entries']);
        expect(localB.get('bodega_employees_v1')).toHaveLength(1);
        expect(localB.get('bodega_payroll_entries_v1')).toHaveLength(1);

        // Caja B abre Nómina con sync activo y sin el gasto de Caja A en su bodega_sales_v1:
        // recoverPayroll NO debe anular el renglón creado en DEVICE-A.
        localStorage.setItem('pda_device_id', 'DEVICE-B');
        setNubeLocalWriteHandler(() => {});
        const memStorageB = {
            getItem: async (k, d) => (localB.has(k) ? localB.get(k) : d),
            setItem: async (k, v) => { localB.set(k, v); },
        };
        const rec = await recoverPayroll({ storage: memStorageB });
        expect(rec.renglonesAnulados).toBe(0);
        expect(localB.get('bodega_payroll_entries_v1')[0].status).toBe('ACTIVO');
    }, 60_000);
});
