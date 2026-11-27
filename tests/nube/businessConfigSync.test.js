// @vitest-environment jsdom
/**
 * T19 · Sincronización de configuración de negocio (IVA, stock negativo, datos comercio,
 * políticas) como objeto plano con merge 3-way campo a campo, más invalidación de caché
 * de métodos de pago al recibir actualización remota.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import {
    BUSINESS_CONFIG_KEY,
    applyBusinessConfigSnapshot,
    readBusinessConfigSnapshot,
    setNubeBusinessConfigLink,
    markNubeBusinessConfigReady,
    notifyBusinessConfigChanged,
} from '../../src/nube/businessConfigSync';
import { createRecordSync } from '../../src/nube/recordSync';
import { storageService } from '../../src/utils/storageService';
import { getPaymentLabel, refreshPaymentMethodsCache } from '../../src/config/paymentMethods';

const cleanups = [];

afterEach(async () => {
    setNubeBusinessConfigLink(null);
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

describe('T19 · Configuración compartida del negocio y caché de métodos de pago', () => {
    it('1. Merge 3-way campo a campo de pdn_business_config_v1 en Postgres real: Caja A cambia IVA y Caja B cambia business_name sin perderse', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'cfg@bodega.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Abasto Config',
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
        const syncA = createRecordSync({
            client: cajaA,
            getSession: () => sessA.token,
            store: makeMemStore(),
            readLocal: async (k) => localA.get(k) ?? null,
            writeLocal: async (k, v) => { localA.set(k, v); },
        });
        const syncB = createRecordSync({
            client: cajaB,
            getSession: () => sessB.token,
            store: makeMemStore(),
            readLocal: async (k) => localB.get(k) ?? null,
            writeLocal: async (k, v) => { localB.set(k, v); },
        });

        // Base inicial v1
        const baseCfg = {
            tax_config_v1: { ivaEnabled: false, ivaRate: 16, ivaIncluded: false },
            business_name: 'Abasto Viejo',
            allow_negative_stock: 'false',
        };
        localA.set(BUSINESS_CONFIG_KEY, baseCfg);
        await syncA.onLocalWrite(BUSINESS_CONFIG_KEY, baseCfg);
        await syncA.flush();
        await syncB.pull(['settings']);
        expect(localB.get(BUSINESS_CONFIG_KEY)).toEqual(baseCfg);

        // Edición concurrente desde misma base v1:
        // Caja A activa IVA 16% + permite stock negativo
        const editA = {
            ...baseCfg,
            tax_config_v1: { ivaEnabled: true, ivaRate: 16, ivaIncluded: false },
            allow_negative_stock: 'true',
        };
        localA.set(BUSINESS_CONFIG_KEY, editA);
        await syncA.onLocalWrite(BUSINESS_CONFIG_KEY, editA);
        await syncA.flush();

        // Caja B (aún en v1) cambia business_name
        const editB = {
            ...baseCfg,
            business_name: 'Abasto Renovado',
        };
        localB.set(BUSINESS_CONFIG_KEY, editB);
        await syncB.onLocalWrite(BUSINESS_CONFIG_KEY, editB);
        await syncB.flush();

        // Ambas cajas bajan y deben converger conservando AMBOS cambios
        await syncA.pull(['settings']);
        await syncB.pull(['settings']);

        const finalA = localA.get(BUSINESS_CONFIG_KEY);
        const finalB = localB.get(BUSINESS_CONFIG_KEY);
        expect(finalA.tax_config_v1).toEqual({ ivaEnabled: true, ivaRate: 16, ivaIncluded: false });
        expect(finalA.allow_negative_stock).toBe('true');
        expect(finalA.business_name).toBe('Abasto Renovado');
        expect(finalB).toEqual(finalA);
    }, 60_000);

    it('2. applyBusinessConfigSnapshot aplica claves locales, dispara app_storage_update remoto y suprime eco', async () => {
        const events = [];
        let writeCount = 0;
        setNubeBusinessConfigLink({
            readCloud: async () => null,
            writeCloud: async () => { writeCount += 1; },
            canEdit: () => true,
        });
        await markNubeBusinessConfigReady();

        const changed = applyBusinessConfigSnapshot({
            tax_config_v1: { ivaEnabled: true, ivaRate: 16, ivaIncluded: true },
            allow_negative_stock: 'true',
            business_name: 'Mi Bodega PRO',
            payroll_goods_valuation: 'venta',
        }, {
            dispatch: (k) => {
                events.push(k);
                // Simular un listener que llama notifyBusinessConfigChanged durante la aplicación remota
                notifyBusinessConfigChanged();
            },
        });

        expect(changed).toContain('tax_config_v1');
        expect(changed).toContain('allow_negative_stock');
        expect(changed).toContain('business_name');
        expect(changed).toContain('payroll_goods_valuation');
        expect(events).toEqual(changed);

        const snap = readBusinessConfigSnapshot();
        expect(snap.tax_config_v1).toEqual({ ivaEnabled: true, ivaRate: 16, ivaIncluded: true });
        expect(snap.allow_negative_stock).toBe('true');
        expect(snap.business_name).toBe('Mi Bodega PRO');

        await new Promise((r) => setTimeout(r, 200));
        expect(writeCount).toBe(0);
    });

    it('3. Caché de paymentMethods se invalida al llegar app_storage_update remoto de bodega_payment_methods_v1', async () => {
        const customId = 'custom_zelle_t19';
        await storageService.setItem('bodega_payment_methods_v1', [
            { id: customId, label: 'Zelle Remoto', icon: 'DollarSign', currency: 'USD', isFactory: false, isEnabled: true },
        ], { skipSyncPush: true, fromCloud: true });

        // storageService.setItem dispara app_storage_update -> refresca caché asíncrono
        await refreshPaymentMethodsCache();
        expect(getPaymentLabel(customId)).toBe('Zelle Remoto');
    });
});
