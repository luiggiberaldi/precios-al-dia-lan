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
import { runWithoutEco } from '../utils/syncFlags';
import { createRecordSync, SYNCED_KEYS } from './recordSync';
import { setNubeLocalWriteHandler, setNubeBackupRestorer, setNubeStockFlusher } from './localWriteHook';
import { createBackupRestorer } from './backupRestore';
import { readMemberSession } from './memberSession';
import { createSaleSubmitter, voidSale, isNetworkError } from './stockService';
import { createStockMirror } from './stockMirror';
import { setNubeSaleSubmitter, setNubeVoider } from './checkoutBridge';
import { createStockWatcher } from './stockWatcher';
import { createCustomerLedgerSync, LEDGER_KEY } from './customerLedgerSync';
import { RATE_KEY, applyRateSnapshot, setNubeRateLink, markNubeRateReady } from './rateSync';
import { keepChannel } from './realtimeChannel';

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
        const engine = createRecordSync({
            client,
            getSession: () => readMemberSession()?.token ?? null,
            store: getSyncStore(),
            cashIdSuffix: deviceId || null,
            // Misma regla que push_records: un cajero solo sube clientes y su caja.
            canPush: (collection) => collection === 'customers' || collection === 'cash'
                || ['dueno', 'administrador'].includes(readMemberSession()?.role),
            readLocal: (key) => storageService.getItem(key, null),
            writeLocal: async (key, value) => {
                await runWithoutEco(() => storageService.setItem(key, value));
                if (key === RATE_KEY) applyRateSnapshot(value); // la tasa de la cuenta llega a esta caja
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
        // F3 «vías olvidadas»: cambios de stock fuera del cobro → ajustes en el servidor.
        const watcher = createStockWatcher({
            client,
            getSession: () => readMemberSession()?.token ?? null,
            store: getSyncStore(),
            onStatus: (w) => { if (!disposed) setStatus((st) => ({ ...st, stockPending: w.pending, stockError: w.lastError })); },
        });
        // F4: fiados, abonos y billetera con saldo oficial del servidor.
        const ledger = createCustomerLedgerSync({
            client,
            getSession: () => readMemberSession()?.token ?? null,
            store: getSyncStore(),
            readLocal: (key) => storageService.getItem(key, null),
            writeLocal: (key, value) => runWithoutEco(() => storageService.setItem(key, value, { skipSyncPush: true })),
            onStatus: (l) => { if (!disposed) setStatus((st) => ({ ...st, ledgerPending: l.pending, ledgerError: l.lastError })); },
        });
        setNubeLocalWriteHandler(async (key, value) => {
            await engine.onLocalWrite(key, value);
            if (key === 'bodega_products_v1') await watcher.onProductsWrite(value);
            if (key === LEDGER_KEY) await ledger.onLedgerWrite(value);
        });
        // Inventario → «Confirmar» del − / +: el ajuste sube al momento; si el servidor
        // lo rechaza se avisa y se trae el stock real.
        setNubeStockFlusher(async () => {
            const res = await watcher.flushNow();
            if (!res.ok && !res.queued) refreshLevels();
            return res;
        });
        // Ajustes → Importar respaldo: con la nube activa sube también stock y saldos.
        setNubeBackupRestorer(createBackupRestorer({ client, accountId, sedeId, getSession: () => readMemberSession() }));
        setNubeVoider(async (saleId, reason) => {
            const session = readMemberSession()?.token;
            if (!session) return { ok: false, message: 'Tu sesión venció. Vuelve a entrar con tu PIN.' };
            try {
                await voidSale(client, session, saleId, reason);
                return { ok: true };
            } catch (e) {
                return { ok: false, message: isNetworkError(e) ? 'Anular necesita internet. Intenta de nuevo con conexión.' : (e?.message || 'No se pudo anular') };
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
        setStatus((s) => ({ ...s, retryRejectedSales: () => sales.retryRejected() }));

        // F3: el stock que se ve en la caja es el del servidor (sede de este equipo).
        // S5: solo lo cambiado, y el aviso en vivo se aplica sin releer (stockMirror.js).
        const stock = createStockMirror({
            client,
            sedeId,
            watcher,
            readProducts: () => storageService.getItem('bodega_products_v1', []),
            writeProducts: (products) => runWithoutEco(() => storageService.setItem('bodega_products_v1', products, { skipSyncPush: true })),
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

        (async () => {
            await engine.pull();
            if (!disposed) await markNubeRateReady();
            // Lo que se guardó mientras el enganche no estaba instalado.
            for (const key of Object.keys(SYNCED_KEYS)) {
                if (disposed) return;
                const value = await storageService.getItem(key, null);
                if (value !== null) await engine.onLocalWrite(key, value);
            }
            await engine.flush();
            await sales.replay();
            await refreshLevels();
            const localLedger = await storageService.getItem(LEDGER_KEY, null);
            if (localLedger) await ledger.onLedgerWrite(localLedger);
            await ledger.flush();
            await ledger.pull();
        })();

        // Canales en vivo que se reabren solos si Supabase los corta; al volver se baja
        // lo que pasó mientras estuvieron caídos.
        const channel = keepChannel(client, `pdn-sync-${accountId}`,
            (ch) => ch.on('postgres_changes', { event: '*', schema: 'public', table: 'account_sync_state', filter: `account_id=eq.${accountId}` },
                (payload) => {
                    const c = payload?.new?.collection;
                    if (c === 'reset') { onResetRef.current?.(); return; }
                    engine.pull(c ? [c] : undefined);
                }),
            { onUp: ({ reconnected }) => { if (reconnected) engine.pull(); } });
        const levelsChannel = keepChannel(client, `pdn-stock-${accountId}-${sedeId || 'todas'}`,
            (ch) => ch.on('postgres_changes', { event: '*', schema: 'public', table: 'stock_levels', ...(sedeId ? { filter: `sede_id=eq.${sedeId}` } : {}) },
                (payload) => { if (!disposed && !stock.applyRealtime(payload?.new)) refreshLevels(); }),
            { onUp: ({ reconnected }) => { if (reconnected) refreshLevels(); } });
        const balancesChannel = keepChannel(client, `pdn-cartera-${accountId}`,
            (ch) => ch.on('postgres_changes', { event: '*', schema: 'public', table: 'customer_balances', filter: `account_id=eq.${accountId}` },
                () => ledger.pull()),
            { onUp: ({ reconnected }) => { if (reconnected) ledger.pull(); } });

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
                return;
            }
            lastPull = Date.now();
            engine.pull();
            sales.replay().then(refreshLevels);
            ledger.flush().then(() => ledger.pull());
        };
        const timer = setInterval(tick, POLL_MS);
        const forceTick = () => tick({ force: true });
        document.addEventListener('visibilitychange', forceTick);
        window.addEventListener('online', forceTick);

        return () => {
            disposed = true;
            setNubeLocalWriteHandler(null);
            setNubeStockFlusher(null);
            setNubeSaleSubmitter(null);
            setNubeVoider(null);
            setNubeBackupRestorer(null);
            setNubeRateLink(null);
            clearInterval(timer);
            clearInterval(rateTimer);
            document.removeEventListener('visibilitychange', forceTick);
            window.removeEventListener('online', forceTick);
            channel.dispose();
            levelsChannel.dispose();
            balancesChannel.dispose();
            engineRef.current = null;
        };
    }, [client, accountId, sedeId, deviceId, enabled]);

    return status;
}
