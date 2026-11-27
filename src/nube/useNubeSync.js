/**
 * Arranca el sincronizador de registros (F2) mientras hay un empleado dentro.
 *
 *   1. instala el enganche de storageService (las escrituras locales suben por registro);
 *   2. baja lo que cambió y revisa la copia local por si quedó algo sin subir;
 *   3. escucha los avisos de otras cajas (account_sync_state por Realtime, ~100 bytes)
 *      y además revisa cada minuto y al volver a la pestaña (por si Realtime se cae).
 */
import { useEffect, useRef, useState } from 'react';
import localforage from 'localforage';
import { storageService } from '../utils/storageService';
import { withLock } from '../utils/withLock';
import { createRecordSync, SYNCED_KEYS } from './recordSync';
import {
    setNubeLocalWriteHandler,
    setNubeBackupRestorer,
    setNubeStockFlusher,
    setNubeStockBaselineAdjuster,
    setNubeStockCountSubmitter,
} from './localWriteHook';
import { createBackupRestorer } from './backupRestore';
import { readMemberSession } from './memberSession';
import { createSaleSubmitter, voidSale, isNetworkError } from './stockService';
import { createStockMirror } from './stockMirror';
import { setNubeSaleSubmitter, setNubeVoider } from './checkoutBridge';
import { createStockWatcher } from './stockWatcher';
import { seedMissingStock } from './stockSeed';
import { createCustomerLedgerSync, LEDGER_KEY } from './customerLedgerSync';
import { createSupplierLedgerSync, SUPPLIER_LEDGER_KEY } from './supplierLedgerSync';
import { RATE_KEY, applyRateSnapshot, setNubeRateLink, markNubeRateReady } from './rateSync';
import {
    BUSINESS_CONFIG_KEY,
    applyBusinessConfigSnapshot,
    setNubeBusinessConfigLink,
    markNubeBusinessConfigReady,
} from './businessConfigSync';
import { keepChannel } from './realtimeChannel';
import { CASHEA_LEDGER_KEY, applyCasheaBalances } from '../utils/casheaLedger';
import { isSharedCashDrawerMode } from '../utils/cashDrawerMode';
import { setSharedCashShiftBridge } from './sharedCashShiftBridge';

const POLL_MS = 60_000;
// Con los tres canales en vivo arriba, lo que cambia llega por aviso: releer de la nube
// cada 5 min alcanza como red de seguridad (S5). Las colas locales se suben cada 60 s.
const SLOW_POLL_MS = 5 * 60_000;
// Con el canal en vivo caído, la tasa (`settings`, un registro) se revisa así de seguido.
const RATE_FALLBACK_MS = 10_000;
let syncStore = null;
function getSyncStore() {
    if (!syncStore) syncStore = localforage.createInstance({ name: 'PreciosAlDiaNube', storeName: 'pdn_sync' });
    return syncStore;
}

export function useNubeSync({ client, accountId, sedeId, deviceId, enabled, onAccountReset }) {
    const [status, setStatus] = useState({ lastError: null, pending: 0, salesPending: 0, salesRejected: 0, salesRejectedError: null });
    const engineRef = useRef(null);
    // Aviso `reset` de account_sync_state: el dueño reinició la cuenta (accountReset.js).
    const onResetRef = useRef(onAccountReset);
    onResetRef.current = onAccountReset;

    useEffect(() => {
        if (!enabled || !client || !accountId) return undefined;
        let disposed = false;
        const withPosLock = (fn) => withLock('pos_write_lock', fn, { fallbackWarning: false });
        let rateReady = false;
        let stock = null;
        let ledger = null;
        let supplierLedger = null;
        const ensureRateReady = async () => {
            if (disposed || rateReady) return;
            if (engine.getLastError()) return;
            rateReady = true;
            await markNubeRateReady();
            await markNubeBusinessConfigReady();
        };

        const engine = createRecordSync({
            client,
            getSession: () => readMemberSession()?.token ?? null,
            store: getSyncStore(),
            cashIdSuffix: deviceId || null,
            withLocalLock: withPosLock,
            isSharedCashMode: () => isSharedCashDrawerMode(),
            // Misma regla que push_records: un cajero solo sube clientes, su caja, Cashea, esperas y bitácora.
            canPush: (collection) => ['customers', 'cash', 'cashea', 'holds', 'audit'].includes(collection)
                || ['dueno', 'administrador'].includes(readMemberSession()?.role),
            readLocal: (key) => storageService.getItem(key, null),
            writeLocal: async (key, value) => {
                await storageService.setItem(key, value, { skipSyncPush: true, fromCloud: true });
                if (key === RATE_KEY) applyRateSnapshot(value); // la tasa de la cuenta llega a esta caja
                if (key === BUSINESS_CONFIG_KEY) {
                    const changed = applyBusinessConfigSnapshot(value); // IVA, políticas y datos del negocio
                    if (changed.includes('cash_drawer_mode') && isSharedCashDrawerMode()) {
                        engine.pull(['cash']).catch(() => {});
                    }
                }
            },
            onPulled: async (collection) => {
                // A4: al llegar productos o clientes nuevos desde otra caja, aplicar inmediatamente
                // stock/saldos ya conocidos en memoria sin esperar 5 minutos.
                if (collection === 'products' && stock) await stock.applyKnown();
                if (collection === 'customers' && ledger) await ledger.applyKnownBalances();
                if (collection === 'suppliers' && supplierLedger) await supplierLedger.applyKnownBalances();
                if (collection === 'cashea' || collection === 'customers') {
                    await withPosLock(async () => {
                        const [curCustomers, curCashea] = await Promise.all([
                            storageService.getItem('bodega_customers_v1', []),
                            storageService.getItem(CASHEA_LEDGER_KEY, []),
                        ]);
                        const { customers: nextCustomers, changed } = applyCasheaBalances(curCustomers, curCashea);
                        if (changed) {
                            await storageService.setItem('bodega_customers_v1', nextCustomers, { skipSyncPush: true, fromCloud: true });
                        }
                    });
                }
                if (collection === 'settings') await ensureRateReady();
            },
            onStatus: async (s) => {
                if (disposed) return;
                const pending = await engine.pendingCount().catch(() => 0);
                setStatus((prev) => ({ ...prev, lastError: s.lastError, pending }));
            },
        });
        engineRef.current = engine;
        // Tasa única de la cuenta: la publica el dueño o un administrador (el servidor
        // rechaza `settings` a un cajero).
        setNubeRateLink({
            readCloud: () => storageService.getItem(RATE_KEY, null),
            writeCloud: (snap) => storageService.setItem(RATE_KEY, snap),
            canEdit: () => ['dueno', 'administrador'].includes(readMemberSession()?.role),
        });
        setNubeBusinessConfigLink({
            readCloud: () => storageService.getItem(BUSINESS_CONFIG_KEY, null),
            writeCloud: (snap) => storageService.setItem(BUSINESS_CONFIG_KEY, snap),
            canEdit: () => ['dueno', 'administrador'].includes(readMemberSession()?.role),
        });
        // F3 «vías olvidadas»: cambios de stock fuera del cobro → ajustes en el servidor.
        const watcher = createStockWatcher({
            client,
            getSession: () => readMemberSession()?.token ?? null,
            store: getSyncStore(),
            onStatus: (w) => { if (!disposed) setStatus((st) => ({ ...st, stockPending: w.pending, stockError: w.lastError })); },
        });
        // F4: fiados, abonos y billetera con saldo oficial del servidor.
        ledger = createCustomerLedgerSync({
            client,
            getSession: () => readMemberSession()?.token ?? null,
            store: getSyncStore(),
            readLocal: (key) => storageService.getItem(key, null),
            writeLocal: (key, value) => storageService.setItem(key, value, { skipSyncPush: true, fromCloud: true }),
            withLocalLock: withPosLock,
            onStatus: (l) => { if (!disposed) setStatus((st) => ({ ...st, ledgerPending: l.pending, ledgerError: l.lastError })); },
        });
        // T20: libro append-only de cuentas por pagar a proveedores.
        supplierLedger = createSupplierLedgerSync({
            client,
            getSession: () => readMemberSession()?.token ?? null,
            store: getSyncStore(),
            readLocal: (key) => storageService.getItem(key, null),
            writeLocal: (key, value) => storageService.setItem(key, value, { skipSyncPush: true, fromCloud: true }),
            withLocalLock: withPosLock,
            canPush: () => ['dueno', 'administrador'].includes(readMemberSession()?.role),
        });
        setNubeLocalWriteHandler(async (key, value) => {
            await engine.onLocalWrite(key, value);
            if (key === 'bodega_products_v1') await watcher.onProductsWrite(value);
            if (key === LEDGER_KEY) await ledger.onLedgerWrite(value);
            if (key === SUPPLIER_LEDGER_KEY) await supplierLedger.onLedgerWrite(value);
        });
        // Inventario → «Confirmar» del − / +: el ajuste sube al momento; si el servidor
        // lo rechaza se avisa y se trae el stock real.
        setNubeStockFlusher(async () => {
            const res = await watcher.flushNow();
            if (!res.ok && !res.queued) refreshLevels();
            return res;
        });
        setNubeStockBaselineAdjuster((deltas) => watcher.adjustBaseline(deltas));
        setNubeStockCountSubmitter((productId, targetQty, note) => watcher.submitStockCount(productId, targetQty, note));
        // Ajustes → Importar respaldo: con la nube activa sube también stock y saldos.
        setNubeBackupRestorer(createBackupRestorer({ client, accountId, sedeId, getSession: () => readMemberSession() }));
        setNubeVoider(async (saleId, reason) => {
            const session = readMemberSession()?.token;
            if (!session) return { ok: false, message: 'Tu sesión venció. Vuelve a entrar con tu PIN.' };
            try {
                await voidSale(client, session, saleId, reason);
                return { ok: true };
            } catch (e) {
                return {
                    ok: false,
                    code: e?.code,
                    message: isNetworkError(e) ? 'Anular necesita internet. Intenta de nuevo con conexión.' : (e?.message || 'No se pudo anular'),
                };
            }
        });

        // F3: cobro en el servidor con cola sin internet (F6).
        const sales = createSaleSubmitter({
            client,
            getSession: () => readMemberSession()?.token ?? null,
            store: getSyncStore(),
            allowNegative: () => localStorage.getItem('allow_negative_stock') === 'true',
            onQueueChange: (n) => { if (!disposed) setStatus((s) => ({ ...s, salesPending: n })); },
            onRejectedChange: () => { refreshRejected(); },
            onSaleConfirmed: async (saleId, number) => {
                // A2: limpiar `sale.nube.pending` y grabar el número asignado por el servidor.
                await withPosLock(async () => {
                    const localSales = await storageService.getItem('bodega_sales_v1', []);
                    if (!Array.isArray(localSales) || !localSales.length) return;
                    let changed = false;
                    const updated = localSales.map((s) => {
                        if (String(s?.nube?.saleId) !== String(saleId)) return s;
                        if (!s.nube.pending && s.nube.number === number) return s;
                        changed = true;
                        return { ...s, nube: { ...s.nube, pending: false, ...(number ? { number } : {}) } };
                    });
                    if (changed) {
                        await storageService.setItem('bodega_sales_v1', updated);
                    }
                });
            },
        });
        // Ventas que el servidor rechazó para siempre (S3): se avisan y se pueden reintentar.
        const refreshRejected = async () => {
            const list = await sales.rejected().catch(() => []);
            if (disposed) return;
            const last = list[list.length - 1];
            setStatus((s) => ({ ...s, salesRejected: list.length, salesRejectedError: last ? last.error : null }));
        };
        setNubeSaleSubmitter(sales);
        sales.pending().then((n) => { if (!disposed) setStatus((s) => ({ ...s, salesPending: n })); });
        refreshRejected();
        setStatus((s) => ({
            ...s,
            retryRejectedSales: () => sales.retryRejected(),
            discardRejectedSale: (saleId) => sales.discardRejected(saleId),
        }));

        // F3: el stock que se ve en la caja es el del servidor (sede de este equipo).
        // S5: solo lo cambiado, y el aviso en vivo se aplica sin releer (stockMirror.js).
        stock = createStockMirror({
            client,
            sedeId,
            watcher,
            readProducts: () => storageService.getItem('bodega_products_v1', []),
            writeProducts: (products) => storageService.setItem('bodega_products_v1', products, { skipSyncPush: true, fromCloud: true }),
            withLocalLock: withPosLock,
            onServerContact: () => sales.markOnline(), // D8: hablar con el servidor renueva el permiso sin internet
        });
        const refreshLevels = async () => {
            if (disposed) return;
            try {
                await stock.refresh();
            } catch (e) {
                console.warn('[nube] no se pudo leer el stock del servidor', e?.message || e);
            }
        };

        // C4: sincroniza anulaciones ejecutadas desde Supervisor hacia bodega_sales_v1 local.
        const syncRemoteCashVoids = async () => {
            if (disposed || !deviceId) return;
            try {
                const { data, error } = await client.from('sales')
                    .select('id, payload, voided_at, void_reason')
                    .eq('device_id', deviceId)
                    .eq('status', 'anulada')
                    .order('voided_at', { ascending: false })
                    .limit(100);
                if (error || !Array.isArray(data) || !data.length) return;
                const voidBySaleId = new Map();
                const voidByLocalId = new Map();
                for (const row of data) {
                    const info = { voidedAt: row.voided_at, voidReason: row.void_reason || '' };
                    if (row.id) voidBySaleId.set(String(row.id), info);
                    if (row.payload?.localId) voidByLocalId.set(String(row.payload.localId), info);
                }
                await withPosLock(async () => {
                    const localSales = await storageService.getItem('bodega_sales_v1', []);
                    if (!Array.isArray(localSales) || !localSales.length) return;
                    let changed = false;
                    const updated = localSales.map((s) => {
                        if (!s || s.status === 'ANULADA') return s;
                        const match = (s.nube?.saleId && voidBySaleId.get(String(s.nube.saleId)))
                            || (s.id && voidByLocalId.get(String(s.id)));
                        if (!match) return s;
                        changed = true;
                        return { ...s, status: 'ANULADA', voidedAt: match.voidedAt, voidReason: match.voidReason };
                    });
                    if (changed) {
                        await storageService.setItem('bodega_sales_v1', updated, { skipSyncPush: true, fromCloud: true });
                    }
                });
            } catch (e) {
                console.warn('[nube] no se pudo sincronizar anulaciones remotas de caja', e?.message || e);
            }
        };

        (async () => {
            await engine.pull();
            // C14: solo habilitar publicación de tasas si el pull inicial no falló por red.
            await ensureRateReady();
            // Lo que se guardó mientras el enganche no estaba instalado.
            for (const key of Object.keys(SYNCED_KEYS)) {
                if (disposed) return;
                const value = await storageService.getItem(key, null);
                if (value !== null) await engine.onLocalWrite(key, value);
            }
            await engine.flush();
            await sales.replay();
            // T22 (ALT-18): si un admin restauró/trajo catálogo local sin niveles en servidor,
            // sembrar stock inicial de forma determinista e idempotente antes de aplicar espejo.
            try {
                const mem = readMemberSession();
                if (mem?.token && ['dueno', 'administrador'].includes(mem.role)) {
                    const [localProds, srvLevelsRes] = await Promise.all([
                        storageService.getItem('bodega_products_v1', []),
                        sedeId
                            ? client.from('stock_levels').select('product_id, qty').eq('sede_id', sedeId)
                            : client.from('stock_levels').select('product_id, qty'),
                    ]);
                    if (!srvLevelsRes?.error && Array.isArray(localProds) && localProds.length) {
                        const levelsMap = Object.fromEntries(
                            (srvLevelsRes.data || []).map((r) => [String(r.product_id), Number(r.qty) || 0]),
                        );
                        await seedMissingStock(client, {
                            session: mem.token,
                            role: mem.role,
                            accountId,
                            sedeId,
                            products: localProds,
                            levels: levelsMap,
                        });
                    }
                }
            } catch (e) {
                console.warn('[nube] seedMissingStock omitido:', e?.message || e);
            }
            await refreshLevels();
            await syncRemoteCashVoids();
            const localLedger = await storageService.getItem(LEDGER_KEY, null);
            if (localLedger) await ledger.onLedgerWrite(localLedger);
            await ledger.flush();
            await ledger.pull();
            const localSupplierLedger = await storageService.getItem(SUPPLIER_LEDGER_KEY, null);
            if (localSupplierLedger) await supplierLedger.onLedgerWrite(localSupplierLedger);
            await supplierLedger.flush();
            await supplierLedger.pull();
        })();

        setSharedCashShiftBridge({
            openShift: async (shiftId, openingRecord) => {
                const session = readMemberSession()?.token ?? null;
                const { data, error } = await client.rpc('open_shared_cash_shift', {
                    p_session: session,
                    p_shift_id: shiftId,
                    p_opening_record: openingRecord,
                });
                if (error) throw error;
                await engine.pull(['cash']).catch(() => {});
                return data;
            },
            closeShift: async (shiftId, closeRecord) => {
                const session = readMemberSession()?.token ?? null;
                const { data, error } = await client.rpc('close_shared_cash_shift', {
                    p_session: session,
                    p_shift_id: shiftId,
                    p_close_record: closeRecord,
                });
                if (error) throw error;
                await engine.pull(['cash']).catch(() => {});
                return data;
            },
            getActiveShift: async () => {
                const session = readMemberSession()?.token ?? null;
                const { data, error } = await client.rpc('get_active_shared_shift', { p_session: session });
                if (error) throw error;
                return data;
            },
            pullCash: () => engine.pull(['cash']),
        });

        const emitRemoteCashUpdate = (collection) => {
            if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
                window.dispatchEvent(new CustomEvent('pdn_remote_cash_updated', { detail: { collection } }));
            }
        };

        // Canales en vivo que se reabren solos si Supabase los corta; al volver se baja
        // lo que pasó mientras estuvieron caídos.
        const channel = keepChannel(client, `pdn-sync-${accountId}`,
            (ch) => ch.on('postgres_changes', { event: '*', schema: 'public', table: 'account_sync_state', filter: `account_id=eq.${accountId}` },
                (payload) => {
                    const c = payload?.new?.collection;
                    if (c === 'reset') { onResetRef.current?.(); return; }
                    if (c === 'cash_voids') {
                        syncRemoteCashVoids();
                        ledger.pull();
                        refreshLevels();
                        emitRemoteCashUpdate('cash_voids');
                        return;
                    }
                    if (c === 'cash') {
                        if (isSharedCashDrawerMode()) {
                            engine.pull(['cash']).finally(() => emitRemoteCashUpdate('cash'));
                        } else {
                            emitRemoteCashUpdate('cash');
                        }
                        return;
                    }
                    engine.pull(c ? [c] : undefined);
                }),
            {
                onUp: ({ reconnected }) => {
                    if (reconnected) {
                        engine.pull().then(ensureRateReady);
                        syncRemoteCashVoids();
                        emitRemoteCashUpdate('reconnect');
                    }
                },
            });
        const levelsChannel = keepChannel(client, `pdn-stock-${accountId}-${sedeId || 'todas'}`,
            (ch) => ch.on('postgres_changes', { event: '*', schema: 'public', table: 'stock_levels', ...(sedeId ? { filter: `sede_id=eq.${sedeId}` } : {}) },
                (payload) => { if (!disposed && !stock.applyRealtime(payload?.new)) refreshLevels(); }),
            { onUp: ({ reconnected }) => { if (reconnected) refreshLevels(); } });
        const balancesChannel = keepChannel(client, `pdn-cartera-${accountId}`,
            (ch) => ch.on('postgres_changes', { event: '*', schema: 'public', table: 'customer_balances', filter: `account_id=eq.${accountId}` },
                () => ledger.pull()),
            { onUp: ({ reconnected }) => { if (reconnected) ledger.pull(); } });
        const supplierBalancesChannel = keepChannel(client, `pdn-proveedores-${accountId}`,
            (ch) => ch.on('postgres_changes', { event: '*', schema: 'public', table: 'supplier_balances', filter: `account_id=eq.${accountId}` },
                () => supplierLedger.pull()),
            { onUp: ({ reconnected }) => { if (reconnected) supplierLedger.pull(); } });

        // La tasa tiene que verse al momento en todas las cajas: si el canal en vivo está
        // caído, se revisa `settings` cada 10 s (un registro; sin cambios no baja nada).
        const rateTimer = setInterval(() => {
            if (document.visibilityState !== 'visible' || channel.isUp()) return;
            engine.pull(['settings']);
        }, RATE_FALLBACK_MS);

        // Las colas locales (registros, ventas, cartera) se suben en cada vuelta: sin nada
        // pendiente no cuestan nada. Releer de la nube, solo cada 5 min si los avisos en vivo
        // funcionan (S5); si alguno está caído, cada 60 s como antes.
        let lastPull = Date.now();
        const tick = ({ force = false } = {}) => {
            if (document.visibilityState !== 'visible') return;
            engine.flush();
            const live = channel.isUp() && levelsChannel.isUp() && balancesChannel.isUp();
            if (!force && live && Date.now() - lastPull < SLOW_POLL_MS) {
                sales.replay();
                ledger.flush();
                supplierLedger.flush();
                return;
            }
            lastPull = Date.now();
            engine.pull();
            sales.replay().then(refreshLevels);
            ledger.flush().then(() => ledger.pull());
            supplierLedger.flush().then(() => supplierLedger.pull());
        };
        const timer = setInterval(tick, POLL_MS);
        const forceTick = () => tick({ force: true });
        document.addEventListener('visibilitychange', forceTick);
        window.addEventListener('online', forceTick);

        return () => {
            disposed = true;
            setNubeLocalWriteHandler(null);
            setNubeStockFlusher(null);
            setNubeStockBaselineAdjuster(null);
            setNubeStockCountSubmitter(null);
            setNubeSaleSubmitter(null);
            setNubeVoider(null);
            setNubeBackupRestorer(null);
            setNubeRateLink(null);
            setNubeBusinessConfigLink(null);
            setSharedCashShiftBridge(null);
            clearInterval(timer);
            clearInterval(rateTimer);
            document.removeEventListener('visibilitychange', forceTick);
            window.removeEventListener('online', forceTick);
            channel.dispose();
            levelsChannel.dispose();
            balancesChannel.dispose();
            supplierBalancesChannel.dispose();
            engineRef.current = null;
        };
    }, [client, accountId, sedeId, deviceId, enabled]);

    return status;
}
