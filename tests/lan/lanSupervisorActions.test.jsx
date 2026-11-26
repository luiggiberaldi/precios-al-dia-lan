// @vitest-environment jsdom
/**
 * Modo Supervisor editable contra servidor LAN real + Postgres (PGlite):
 *   - Crear y editar producto/precio desde UI móvil/PC
 *   - Compra / ajuste de stock (incluso eligiendo sede en multi-sede · migración 018)
 *   - Cambio de tasa compartida (`pdn_rate_v1`)
 *   - Anular venta (`process_void`) devolviendo stock
 *   - Registrar abono de cliente (`ABONO_DEUDA`)
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';
import NubeOwnerDashboard from '../../src/nube/NubeOwnerDashboard';
import { safeUuid } from '../../src/utils/safeUuid';

const cleanups = [];

async function flush(ms = 40) {
    await act(async () => {
        await new Promise((r) => setTimeout(r, ms));
    });
}

async function waitForSelector(rootEl, selector, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const found = rootEl.querySelector(selector);
        if (found) return found;
        await flush(30);
    }
    return rootEl.querySelector(selector);
}

async function setFieldValue(el, value) {
    const proto = el.tagName === 'SELECT'
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    await act(async () => {
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

describe('Modo Supervisor editable (LAN)', () => {
    let container;
    let root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        act(() => root.unmount());
        container.remove();
        while (cleanups.length) {
            const fn = cleanups.pop();
            await fn().catch(() => {});
        }
    });

    it('permite crear/editar producto, mover stock multi-sede, cambiar tasa, anular venta y abonar deuda', async () => {
        const srv = await createLanServer({ port: 0, host: '127.0.0.1', enableDiscovery: false });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'sup@bodega.local', 'ClaveSegura123');
        const accId = await svc.createAccount(owner, {
            businessName: 'Abasto Supervisor',
            sedeName: 'Centro',
            ownerName: 'Luigi',
            ownerPin: '753951',
        });
        await srv.lanDb.setAccountLicense(accId, { status: 'active', maxCajas: 5, maxSedes: 3 });

        // Crear segunda sede para validar migración 018 (consulta multi-sede)
        const { data: sedeNorteId, error: sedeErr } = await owner.rpc('create_sede', { p_name: 'Norte' });
        expect(sedeErr).toBeNull();
        expect(sedeNorteId).toBeTruthy();

        const cajaA = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const cajaAUid = await svc.ensureDeviceSession(cajaA);
        await svc.registerDevice(owner, { deviceUserId: cajaAUid, label: 'Caja 1', role: 'caja' });

        const supervisorDev = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const supUid = await svc.ensureDeviceSession(supervisorDev);
        await svc.registerDevice(owner, { deviceUserId: supUid, label: 'Teléfono Dueño', role: 'consulta' });

        const members = await svc.listMembers(supervisorDev);
        const dueno = members.find((m) => m.role === 'dueno');
        const supSession = await svc.loginWithPin(supervisorDev, dueno.id, '753951');
        const cajaSession = await svc.loginWithPin(cajaA, dueno.id, '753951');

        // Subir un cliente de prueba desde Caja 1
        await cajaA.rpc('push_records_v2', {
            p_session: cajaSession.token,
            p_collection: 'customers',
            p_records: [{ id: 'cust-1', data: { id: 'cust-1', name: 'Carlos Pérez', phone: '0414-000' } }],
        });
        // Verificar que Caja 1 NO puede mover stock de Sede Norte (sigue bloqueado)
        const cajaForeign = await cajaA.rpc('process_stock_movements', {
            p_session: cajaSession.token,
            p_reason: 'COMPRA',
            p_movements: [{ id: safeUuid(), product_id: 'harina-test', qty: 1 }],
            p_sede_id: sedeNorteId,
        });
        expect(cajaForeign.error?.message).toMatch(/sede/i);

        // Renderizar NubeOwnerDashboard con sesión de Supervisor
        await act(async () => {
            root.render(
                <NubeOwnerDashboard
                    client={supervisorDev}
                    accountName="Abasto Supervisor"
                    memberName={supSession.name}
                    memberRole={supSession.role}
                    sessionToken={supSession.token}
                    onLogout={() => {}}
                />,
            );
        });

        // 1. Tab Productos → crear producto con stock inicial 5 en Centro
        await act(async () => {
            container.querySelector('[data-testid="owner-tab-productos"]').click();
        });
        const addBtn = await waitForSelector(container, '[data-testid="supervisor-add-product"]');
        expect(addBtn).not.toBeNull();
        await act(async () => { addBtn.click(); });

        await setFieldValue(await waitForSelector(container, '[data-testid="supervisor-prod-name"]'), 'Harina PAN');
        await setFieldValue(container.querySelector('[data-testid="supervisor-prod-price"]'), '1.5');
        await setFieldValue(container.querySelector('[data-testid="supervisor-prod-cost"]'), '1.1');
        await setFieldValue(container.querySelector('[data-testid="supervisor-prod-stock"]'), '5');
        await act(async () => {
            container.querySelector('[data-testid="supervisor-product-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await flush(150);

        const prodRow = await waitForSelector(container, '[data-testid^="supervisor-edit-"]');
        expect(prodRow).not.toBeNull();
        expect(container.textContent).toContain('Harina PAN');
        const productId = prodRow.getAttribute('data-testid').replace('supervisor-edit-', '');

        // 2. Editar precio a $1.65
        await act(async () => { prodRow.click(); });
        await setFieldValue(await waitForSelector(container, '[data-testid="supervisor-prod-price"]'), '1.65');
        await act(async () => {
            container.querySelector('[data-testid="supervisor-product-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await flush(150);
        expect(container.textContent).toContain('1,65');

        // 3. Mover stock en Sede Centro (+10 compra) y luego en Sede Norte (+4 compra)
        await act(async () => {
            container.querySelector(`[data-testid="supervisor-stock-${productId}"]`).click();
        });
        await setFieldValue(await waitForSelector(container, '[data-testid="supervisor-stock-qty"]'), '10');
        await act(async () => {
            container.querySelector('[data-testid="supervisor-stock-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await flush(150);

        await act(async () => {
            container.querySelector(`[data-testid="supervisor-stock-${productId}"]`).click();
        });
        const sedeSelect = await waitForSelector(container, '[data-testid="supervisor-stock-sede"]');
        await setFieldValue(sedeSelect, sedeNorteId);
        await setFieldValue(container.querySelector('[data-testid="supervisor-stock-qty"]'), '4');
        await act(async () => {
            container.querySelector('[data-testid="supervisor-stock-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await flush(150);

        const { data: levelsAfterAdd } = await supervisorDev.from('stock_levels').select('sede_id, qty').eq('product_id', productId);
        const totalQty = levelsAfterAdd.reduce((s, l) => s + Number(l.qty), 0);
        expect(totalQty).toBe(19);
        expect(Number(levelsAfterAdd.find((l) => l.sede_id === sedeNorteId)?.qty)).toBe(4);

        // 4. Cambiar tasa compartida a manual 95.50
        await act(async () => {
            container.querySelector('[data-testid="owner-tab-tasa"]').click();
        });
        const manualBtn = await waitForSelector(container, '[data-testid="supervisor-rate-mode-manual"]');
        await act(async () => { manualBtn.click(); });
        await setFieldValue(await waitForSelector(container, '[data-testid="supervisor-custom-rate"]'), '95.50');
        await act(async () => {
            container.querySelector('[data-testid="supervisor-rate-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await flush(150);

        const { data: rateRows } = await cajaA.from('account_records').select('data').eq('collection', 'settings').eq('id', 'pdn_rate_v1');
        expect(rateRows[0]?.data?.rateMode).toBe('manual');
        expect(rateRows[0]?.data?.customRate).toBe('95.50');

        // 5. Caja A registra venta de 2 Harina PAN y fía $10 a Carlos Pérez
        const saleId = safeUuid();
        const { error: saleErr } = await cajaA.rpc('process_checkout', {
            p_session: cajaSession.token,
            p_sale: {
                id: saleId,
                items: [{ product_id: productId, qty: 2 }],
                total_usd: 3.3,
                total_bs: 315.15,
                rate: 95.5,
                device_at: new Date().toISOString(),
                payload: { method: 'Efectivo' },
            },
            p_offline: false,
            p_allow_negative: false,
        });
        expect(saleErr).toBeNull();

        await cajaA.rpc('push_customer_movements', {
            p_session: cajaSession.token,
            p_movements: [{
                id: safeUuid(),
                customer_id: 'cust-1',
                type: 'VENTA_FIADA',
                direction: 'DEBIT',
                amount_usd: 10,
                device_at: new Date().toISOString(),
            }],
        });

        // 6. Supervisor ve la venta en Ventas y la ANULA → devuelve 2 unidades
        await act(async () => {
            container.querySelector('[data-testid="owner-tab-ventas"]').click();
        });
        const voidBtn = await waitForSelector(container, `[data-testid="supervisor-void-${saleId}"]`);
        expect(voidBtn).not.toBeNull();
        expect(container.textContent).toContain('#A-00001');
        await act(async () => { voidBtn.click(); });
        await setFieldValue(await waitForSelector(container, '[data-testid="supervisor-void-reason"]'), 'Error del cajero');
        await act(async () => {
            container.querySelector('[data-testid="supervisor-void-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await flush(150);
        expect(container.textContent).toContain('Anulada');

        const { data: levelsAfterVoid } = await supervisorDev.from('stock_levels').select('qty').eq('product_id', productId);
        expect(levelsAfterVoid.reduce((s, l) => s + Number(l.qty), 0)).toBe(19);

        // 7. Supervisor va a Clientes y registra abono de $4 para Carlos Pérez → deuda pasa de $10 a $6
        await act(async () => {
            container.querySelector('[data-testid="owner-tab-clientes"]').click();
        });
        const abonoBtn = await waitForSelector(container, '[data-testid="supervisor-abono-cust-1"]');
        expect(abonoBtn).not.toBeNull();
        expect(container.textContent).toContain('Carlos Pérez');
        expect(container.textContent).toContain('Debe');
        await act(async () => { abonoBtn.click(); });
        await setFieldValue(await waitForSelector(container, '[data-testid="supervisor-abono-amount"]'), '4');
        await act(async () => {
            container.querySelector('[data-testid="supervisor-abono-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
        await flush(150);
        expect(container.textContent).toContain('6,00');

        const { data: balRows } = await supervisorDev.from('customer_balances').select('balance_usd').eq('customer_id', 'cust-1');
        expect(Number(balRows[0]?.balance_usd)).toBe(-6);
    }, 60_000);
});
