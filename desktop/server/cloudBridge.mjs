/**
 * Puente de Internet en la Caja Principal (Windows) ↔ Supabase Relay.
 *
 * Permite que el dueño vea su negocio y haga cambios en vivo desde Android, iOS o Windows
 * con internet, mientras todas las cajas del local siguen operando 100% offline-first en LAN.
 *
 * No usa llaves de administración: se autentica en Supabase solo con `anonKey` + el
 * secreto del puente (`masterSecret`, validado por bcrypt en `001_puente_supervisor.sql`).
 */
import crypto from 'node:crypto';

export function generateBridgeCredentials() {
    const codeSuffix = String(crypto.randomInt(100000, 1000000));
    return {
        supervisorCode: `SUP-${codeSuffix}`,
        masterSecret: crypto.randomBytes(24).toString('hex'),
    };
}

export async function callSupabaseRpc(cloudUrl, cloudAnonKey, fn, args = {}, fetchImpl = globalThis.fetch, { timeoutMs = 15_000 } = {}) {
    const base = String(cloudUrl || '').replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetchImpl(`${base}/rest/v1/rpc/${fn}`, {
            method: 'POST',
            headers: {
                apikey: cloudAnonKey,
                Authorization: `Bearer ${cloudAnonKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(args),
            signal: controller.signal,
        });
    } catch (err) {
        if (err?.name === 'AbortError' || controller.signal.aborted) {
            throw new Error(`Tiempo de espera agotado en puente nube (${fn})`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }
    if (!res.ok) {
        throw new Error(data?.message || data?.error || `Error en puente nube (${res.status})`);
    }
    return data;
}

export function createCloudBridge({
    lanDb,
    cloudUrl = '',
    cloudAnonKey = '',
    pollIntervalMs = 4000,
    heartbeatMs = 60_000,
    requestTimeoutMs = 15_000,
    fetchImpl = globalThis.fetch,
    rpcCaller = null,
    onBroadcastEvents = null,
} = {}) {
    let config = {
        enabled: false,
        cloudUrl: String(cloudUrl || '').replace(/\/+$/, ''),
        cloudAnonKey: String(cloudAnonKey || ''),
        supervisorCode: '',
        masterSecret: '',
        accountId: null,
        lastSyncAt: null,
        lastError: null,
    };

    let pollTimer = null;
    let pushDebounce = null;
    let runningCycle = null;
    let stopped = false;
    let snapshotDirty = true;
    let lastSnapshotPushAt = 0;
    const pendingAcks = new Map(); // cmdId -> { status, error }
    const appliedCommandIds = new Set();

    const invokeRpc = (fn, args) => {
        if (typeof rpcCaller === 'function') return rpcCaller(fn, args, config);
        return callSupabaseRpc(config.cloudUrl, config.cloudAnonKey, fn, args, fetchImpl, { timeoutMs: requestTimeoutMs });
    };

    function rememberApplied(cmdId) {
        appliedCommandIds.add(cmdId);
        if (appliedCommandIds.size > 200) {
            const first = appliedCommandIds.values().next().value;
            if (first !== undefined) appliedCommandIds.delete(first);
        }
    }

    async function initFromDb() {
        const saved = await lanDb.getMeta?.('cloud_bridge');
        if (saved && typeof saved === 'object') {
            config = {
                ...config,
                ...saved,
                cloudUrl: saved.cloudUrl || config.cloudUrl,
                cloudAnonKey: saved.cloudAnonKey || config.cloudAnonKey,
            };
        }
        if (config.enabled && config.cloudUrl && config.cloudAnonKey && config.accountId && config.masterSecret) {
            startPolling();
        }
        return getPublicStatus();
    }

    function getPublicStatus() {
        return {
            configured: Boolean(config.cloudUrl && config.cloudAnonKey && config.supervisorCode && config.accountId),
            enabled: Boolean(config.enabled),
            cloudUrl: config.cloudUrl || '',
            supervisorCode: config.supervisorCode || '',
            accountId: config.accountId || null,
            lastSyncAt: config.lastSyncAt || null,
            lastError: config.lastError || null,
        };
    }

    async function setupBridge({
        cloudUrl: nextUrl = config.cloudUrl,
        cloudAnonKey: nextKey = config.cloudAnonKey,
        ownerPin,
        supervisorCode = '',
    }) {
        const cleanUrl = String(nextUrl || '').replace(/\/+$/, '');
        const cleanKey = String(nextKey || '').trim();
        if (!cleanUrl || !cleanKey) {
            throw new Error('Configura la URL y llave pública del puente en la nube.');
        }
        const snap = await lanDb.buildSupervisorSnapshot();
        if (!snap?.accountId) {
            throw new Error('Primero crea el negocio en la Caja Principal.');
        }

        const creds = generateBridgeCredentials();
        const finalCode = String(supervisorCode || config.supervisorCode || creds.supervisorCode).trim().toUpperCase();
        const finalSecret = config.masterSecret || creds.masterSecret;

        // T17: NO activar `config.enabled` ni persistir hasta que `lan_bridge_register` responda OK.
        const candidateConfig = {
            ...config,
            enabled: true,
            cloudUrl: cleanUrl,
            cloudAnonKey: cleanKey,
            accountId: snap.accountId,
            supervisorCode: finalCode,
            masterSecret: finalSecret,
            lastError: null,
        };

        if (typeof rpcCaller === 'function') {
            await rpcCaller('lan_bridge_register', {
                p_account_id: snap.accountId,
                p_account_name: snap.accountName,
                p_master_secret: finalSecret,
                p_supervisor_code: finalCode,
                p_pin: ownerPin || null,
            }, candidateConfig);
        } else {
            await callSupabaseRpc(cleanUrl, cleanKey, 'lan_bridge_register', {
                p_account_id: snap.accountId,
                p_account_name: snap.accountName,
                p_master_secret: finalSecret,
                p_supervisor_code: finalCode,
                p_pin: ownerPin || null,
            }, fetchImpl, { timeoutMs: requestTimeoutMs });
        }

        config = candidateConfig;
        snapshotDirty = true;

        await lanDb.setMeta('cloud_bridge', {
            enabled: true,
            cloudUrl: cleanUrl,
            cloudAnonKey: cleanKey,
            accountId: snap.accountId,
            supervisorCode: finalCode,
            masterSecret: finalSecret,
            lastSyncAt: null,
            lastError: null,
        });

        await pushSnapshotNow();
        startPolling();
        return getPublicStatus();
    }

    async function syncOwnerPin(newPin) {
        if (!config.enabled || !config.cloudUrl || !config.accountId || !config.masterSecret) return false;
        const cleanPin = String(newPin || '').trim();
        if (!/^[0-9]{6,32}$/.test(cleanPin)) return false;
        const snap = await lanDb.buildSupervisorSnapshot().catch(() => null);
        await invokeRpc('lan_bridge_register', {
            p_account_id: config.accountId,
            p_account_name: snap?.accountName || '',
            p_master_secret: config.masterSecret,
            p_supervisor_code: config.supervisorCode,
            p_pin: cleanPin,
        });
        return true;
    }

    async function disableBridge() {
        stopPolling();
        config.enabled = false;
        await lanDb.setMeta('cloud_bridge', {
            ...config,
            enabled: false,
        });
        return getPublicStatus();
    }

    async function pushSnapshotNow() {
        if (!config.enabled || !config.cloudUrl || !config.accountId || !config.masterSecret) return null;
        const snapshot = await lanDb.buildSupervisorSnapshot();
        if (!snapshot) return null;
        await invokeRpc('lan_bridge_push_snapshot', {
            p_account_id: config.accountId,
            p_master_secret: config.masterSecret,
            p_snapshot: snapshot,
        });
        snapshotDirty = false;
        lastSnapshotPushAt = Date.now();
        config.lastSyncAt = new Date().toISOString();
        config.lastError = null;
        return config.lastSyncAt;
    }

    async function flushPendingAcks() {
        for (const [cmdId, ack] of [...pendingAcks.entries()]) {
            try {
                await invokeRpc('lan_bridge_ack_command', {
                    p_account_id: config.accountId,
                    p_master_secret: config.masterSecret,
                    p_command_id: cmdId,
                    p_status: ack.status,
                    p_error: ack.error,
                });
                pendingAcks.delete(cmdId);
            } catch {
                // Reintentará en el próximo ciclo sin perder el estado aplicado
                break;
            }
        }
    }

    async function syncOnce({ forceSnapshot = false } = {}) {
        if (runningCycle) return runningCycle;
        if (!config.enabled || !config.cloudUrl || !config.accountId || !config.masterSecret) return { processed: 0 };

        runningCycle = (async () => {
            try {
                await flushPendingAcks();

                const commands = await invokeRpc('lan_bridge_claim_commands', {
                    p_account_id: config.accountId,
                    p_master_secret: config.masterSecret,
                    p_limit: 20,
                });
                const list = Array.isArray(commands) ? commands : [];
                let processed = 0;

                for (const cmd of list) {
                    let ackStatus = 'applied';
                    let ackError = null;

                    if (!appliedCommandIds.has(cmd.id)) {
                        try {
                            const result = await lanDb.executeSupervisorCommand(cmd.action, cmd.payload || {});
                            rememberApplied(cmd.id);
                            if (result?.events?.length && typeof onBroadcastEvents === 'function') {
                                onBroadcastEvents(result.events);
                            }
                            processed += 1;
                            snapshotDirty = true;
                        } catch (cmdErr) {
                            ackStatus = 'failed';
                            ackError = cmdErr?.message || 'Error ejecutando comando en Caja Principal';
                        }
                    }

                    // Separar el ACK de la ejecución: si falla el ACK por red, encolarlo
                    // en `pendingAcks` y NUNCA sobreescribir un comando ya aplicado como `failed`.
                    try {
                        await invokeRpc('lan_bridge_ack_command', {
                            p_account_id: config.accountId,
                            p_master_secret: config.masterSecret,
                            p_command_id: cmd.id,
                            p_status: ackStatus,
                            p_error: ackError,
                        });
                        pendingAcks.delete(cmd.id);
                    } catch {
                        pendingAcks.set(cmd.id, { status: ackStatus, error: ackError });
                    }
                }

                const heartbeatDue = (Date.now() - lastSnapshotPushAt) >= heartbeatMs;
                if (forceSnapshot || processed > 0 || snapshotDirty || heartbeatDue) {
                    await pushSnapshotNow();
                }
                return { processed };
            } catch (err) {
                config.lastError = err?.message || 'Error sincronizando puente con la nube';
                return { processed: 0, error: config.lastError };
            } finally {
                runningCycle = null;
            }
        })();

        return runningCycle;
    }

    function scheduleSnapshotPush(delayMs = 1200) {
        snapshotDirty = true;
        if (stopped || !config.enabled) return;
        if (pushDebounce) clearTimeout(pushDebounce);
        pushDebounce = setTimeout(() => {
            pushDebounce = null;
            if (runningCycle) return; // El ciclo activo o el siguiente verá snapshotDirty
            pushSnapshotNow().catch((err) => {
                config.lastError = err?.message || 'No se pudo subir el resumen';
            });
        }, delayMs);
        pushDebounce.unref?.();
    }

    function startPolling() {
        if (stopped || pollTimer) return;
        pollTimer = setInterval(() => {
            syncOnce().catch(() => {});
        }, Math.max(50, pollIntervalMs));
        pollTimer.unref?.();
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        if (pushDebounce) {
            clearTimeout(pushDebounce);
            pushDebounce = null;
        }
    }

    function stop() {
        stopped = true;
        stopPolling();
    }

    return {
        initFromDb,
        getPublicStatus,
        setupBridge,
        syncOwnerPin,
        disableBridge,
        pushSnapshotNow,
        syncOnce,
        scheduleSnapshotPush,
        stop,
    };
}
