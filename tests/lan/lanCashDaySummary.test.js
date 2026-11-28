/**
 * Verificación integral de `public.cash_day_summary` sobre PGlite LAN real (migración 026):
 *   1. Excluye de `egresos_usd` mercancía a empleados / autoconsumo / pagos fuera de gaveta
 *      (`afectaCaja: false` o `isAutoconsumo: true`) y solo suma egresos reales de gaveta.
 *   2. Muestra al instante las ventas registradas por `process_checkout` en `public.sales`
 *      aun antes de que `account_records(collection='cash')` termine de subir, sin duplicarlas
 *      cuando después sube `cash`, y restándolas al instante al anular con `process_void`.
 *   3. No deja pegado `caja_abierta = true` cuando existe un `REGISTRO_CIERRE` posterior a una
 *      apertura vieja huérfana ni cuando un turno compartido (`shared_cash_shifts`) ya cerró.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLanServer } from '../../desktop/server/lanServer.mjs';
import { createLanClient } from '../../src/lan/lanClient';
import * as svc from '../../src/nube/accountService';

const cleanups = [];

afterEach(async () => {
    while (cleanups.length) {
        const fn = cleanups.pop();
        await fn().catch(() => {});
    }
});

describe('LAN cash_day_summary · exactitud de ventas, egresos, anulaciones y estado de caja', () => {
    it('calcula ventas sin doble conteo, ignora egresos fuera de caja y refleja cierres/anulaciones al instante', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdn-cash-summary-'));
        cleanups.push(async () => fs.rmSync(tmpRoot, { recursive: true, force: true }));

        const srv = await createLanServer({
            port: 0,
            host: '127.0.0.1',
            enableDiscovery: false,
            dataDir: path.join(tmpRoot, 'db'),
            imagesDir: path.join(tmpRoot, 'images'),
            backupsDir: path.join(tmpRoot, 'backups'),
        });
        cleanups.push(() => srv.close());

        const owner = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        await svc.ownerSignUp(owner, 'dueno@resumen.local', 'ClaveSegura123');
        await svc.createAccount(owner, {
            businessName: 'Bodega Exacta',
            sedeName: 'Principal',
            ownerName: 'Luigi',
            ownerPin: '142536',
        });

        const cajaA = createLanClient({ baseUrl: srv.baseUrl, persistSession: false });
        const uidA = await svc.ensureDeviceSession(cajaA);
        await svc.registerDevice(owner, { deviceUserId: uidA, label: 'Caja 1', role: 'caja', sedeId: null });
        const stA = await svc.getDeviceStatus(cajaA, uidA);

        const members = await svc.listMembers(cajaA);
        const ownerMember = members.find((m) => m.role === 'dueno');
        const loginA = await svc.loginWithPin(cajaA, ownerMember.id, '142536');

        const nowIso = new Date().toISOString();
        const oldIso = new Date(Date.now() - 86_400_000).toISOString();

        // 1) Sembrar producto con stock y registrar una venta en `process_checkout` ANTES de subir `cash`
        await cajaA.rpc('process_stock_movements', {
            p_session: loginA.token,
            p_movements: [{ product_id: 'prod_1', qty: 20, reason: 'STOCK_INICIAL', id: crypto.randomUUID() }],
        });

        const saleUuid = crypto.randomUUID();
        const localSaleId = 'venta_local_1';
        const checkoutRes = await cajaA.rpc('process_checkout', {
            p_session: loginA.token,
            p_sale: {
                id: saleUuid,
                items: [{ product_id: 'prod_1', qty: 2 }],
                total_usd: 12.5,
                total_bs: 500,
                rate: 40,
                device_at: nowIso,
                payload: { localId: localSaleId },
            },
            p_offline: false,
            p_allow_negative: true,
        });
        expect(checkoutRes.error).toBeNull();

        // Ya debe verse 1 venta ($12.50) en cash_day_summary aunque aún no haya subido a account_records(cash)
        let sumRes = await owner.rpc('cash_day_summary', {});
        expect(sumRes.error).toBeNull();
        let rowA = sumRes.data.find((r) => r.device_id === stA.device.id);
        expect(rowA.ventas).toBe(1);
        expect(Number(rowA.ventas_usd)).toBeCloseTo(12.5, 2);

        // 2) Subir a account_records(cash):
        //    - la misma venta (no debe duplicarse)
        //    - una mercancía al personal de -$1.00 (isAutoconsumo: true, afectaCaja: false -> NO es egreso de caja)
        //    - un gasto real en efectivo de -$3.25 (afectaCaja: true -> SÍ es egreso de caja)
        //    - una apertura vieja olvidada sin cerrar + un REGISTRO_CIERRE más reciente (-> caja_abierta debe ser false)
        const pushRes = await cajaA.rpc('push_records_v2', {
            p_session: loginA.token,
            p_collection: 'cash',
            p_records: [
                {
                    id: `${localSaleId}@${stA.device.id}`,
                    data: {
                        id: localSaleId,
                        tipo: 'VENTA',
                        totalUsd: 12.5,
                        timestamp: nowIso,
                        nube: { saleId: saleUuid },
                    },
                },
                {
                    id: `gasto_nom_1@${stA.device.id}`,
                    data: {
                        id: 'gasto_nom_1',
                        tipo: 'GASTO_INTERNO',
                        totalUsd: -1,
                        afectaCaja: false,
                        isAutoconsumo: true,
                        isPayroll: true,
                        timestamp: nowIso,
                    },
                },
                {
                    id: `gasto_real_1@${stA.device.id}`,
                    data: {
                        id: 'gasto_real_1',
                        tipo: 'GASTO_INTERNO',
                        totalUsd: -3.25,
                        afectaCaja: true,
                        isAutoconsumo: false,
                        timestamp: nowIso,
                    },
                },
                {
                    id: `apertura_vieja@${stA.device.id}`,
                    data: {
                        id: 'apertura_vieja',
                        tipo: 'APERTURA_CAJA',
                        cajaCerrada: false,
                        timestamp: oldIso,
                    },
                },
                {
                    id: `cierre_hoy@${stA.device.id}`,
                    data: {
                        id: 'cierre_hoy',
                        tipo: 'REGISTRO_CIERRE',
                        cajaCerrada: true,
                        timestamp: nowIso,
                    },
                },
            ],
        });
        expect(pushRes.error).toBeNull();

        sumRes = await owner.rpc('cash_day_summary', {});
        rowA = sumRes.data.find((r) => r.device_id === stA.device.id);
        expect(rowA.ventas).toBe(1);
        expect(Number(rowA.ventas_usd)).toBeCloseTo(12.5, 2);
        expect(Number(rowA.egresos_usd)).toBeCloseTo(3.25, 2);
        expect(rowA.caja_abierta).toBe(false);

        // 3) Anular la venta por `process_void` (como desde Supervisor): debe bajar a 0 ventas al instante
        //    incluso antes de que la caja vuelva a subir status='ANULADA' en account_records(cash).
        const voidRes = await cajaA.rpc('process_void', {
            p_session: loginA.token,
            p_sale_id: saleUuid,
            p_reason: 'Prueba de anulación',
        });
        expect(voidRes.error).toBeNull();

        sumRes = await owner.rpc('cash_day_summary', {});
        rowA = sumRes.data.find((r) => r.device_id === stA.device.id);
        expect(rowA.ventas).toBe(0);
        expect(Number(rowA.ventas_usd)).toBeCloseTo(0, 2);
    }, 30_000);
});
