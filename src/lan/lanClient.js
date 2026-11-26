/**
 * Cliente LAN compatible con la interfaz de Supabase que consume `src/nube/`.
 *
 * Traduce `.auth`, `.from()`, `.rpc()` y `.channel()` a peticiones HTTP + SSE
 * contra el servidor de la Caja Principal en la red del negocio.
 */
import { LAN_PROTOCOL_VERSION, normalizeLanUrl } from './lanConfig';

function createTokenStore(storageKey, persistSession) {
    let mem = null;
    return {
        read() {
            if (!persistSession) return mem;
            try {
                const raw = globalThis.localStorage?.getItem(storageKey);
                return raw ? JSON.parse(raw) : mem;
            } catch {
                return mem;
            }
        },
        write(session) {
            mem = session || null;
            if (!persistSession) return;
            try {
                if (session) globalThis.localStorage?.setItem(storageKey, JSON.stringify(session));
                else globalThis.localStorage?.removeItem(storageKey);
            } catch {
                /* sin localStorage */
            }
        },
    };
}

function matchesFilter(filter, row) {
    if (!filter || !row) return true;
    const eqIdx = filter.indexOf('=eq.');
    if (eqIdx <= 0) return true;
    const col = filter.slice(0, eqIdx);
    const val = filter.slice(eqIdx + 4);
    return String(row[col] ?? '') === String(val);
}

class LanQueryBuilder {
    constructor(client, table) {
        this.client = client;
        this.spec = {
            table,
            select: '*',
            filters: [],
            orders: [],
            limit: null,
            range: null,
        };
    }

    select(cols = '*') {
        this.spec.select = cols;
        return this;
    }
    eq(col, val) {
        this.spec.filters.push({ op: 'eq', col, val });
        return this;
    }
    neq(col, val) {
        this.spec.filters.push({ op: 'neq', col, val });
        return this;
    }
    gt(col, val) {
        this.spec.filters.push({ op: 'gt', col, val });
        return this;
    }
    gte(col, val) {
        this.spec.filters.push({ op: 'gte', col, val });
        return this;
    }
    lt(col, val) {
        this.spec.filters.push({ op: 'lt', col, val });
        return this;
    }
    lte(col, val) {
        this.spec.filters.push({ op: 'lte', col, val });
        return this;
    }
    is(col, val) {
        this.spec.filters.push({ op: 'is', col, val });
        return this;
    }
    in(col, val) {
        this.spec.filters.push({ op: 'in', col, val });
        return this;
    }
    order(col, { ascending = true } = {}) {
        this.spec.orders.push({ col, ascending });
        return this;
    }
    limit(n) {
        this.spec.limit = Number(n);
        return this;
    }
    range(from, to) {
        this.spec.range = { from: Number(from), to: Number(to) };
        return this;
    }
    then(resolve, reject) {
        return this.client._query(this.spec).then(resolve, reject);
    }
}

export async function probeLanServer(rawUrl, fetchImpl = globalThis.fetch) {
    const baseUrl = normalizeLanUrl(rawUrl);
    if (!baseUrl) throw new Error('Escribe la dirección de la Caja Principal.');
    const res = await fetchImpl(`${baseUrl}/lan/health`, { method: 'GET' });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'No respondió una Caja Principal de Precios al Día LAN.');
    }
    if (data.protocolVersion !== LAN_PROTOCOL_VERSION) {
        throw new Error(`Versión incompatible (servidor v${data.protocolVersion}, caja v${LAN_PROTOCOL_VERSION}). Actualiza los equipos.`);
    }
    return { ...data, baseUrl };
}

export function createLanClient({
    baseUrl,
    getBaseUrl = null,
    storageKey = 'pdn-lan-auth',
    persistSession = true,
    fetchImpl = globalThis.fetch,
} = {}) {
    const store = createTokenStore(storageKey, persistSession);
    const activeChannels = new Set();
    let streamAbort = null;
    let streamRunning = false;
    let streamConnected = false;

    const resolveUrl = () => normalizeLanUrl(typeof getBaseUrl === 'function' ? getBaseUrl() : baseUrl);

    async function requestJson(path, { method = 'POST', body = undefined, useAuth = true } = {}) {
        const root = resolveUrl();
        if (!root) {
            return { ok: false, status: 0, data: null, error: { message: 'Failed to fetch: servidor LAN no configurado', status: 0 } };
        }
        const session = useAuth ? store.read() : null;
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (session?.token) headers.Authorization = `Bearer ${session.token}`;
        try {
            const res = await fetchImpl(`${root}${path}`, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                return {
                    ok: false,
                    status: res.status,
                    data: null,
                    error: { message: json?.error || `HTTP ${res.status}`, status: res.status, code: json?.code || null },
                };
            }
            return { ok: true, status: res.status, data: json, error: null };
        } catch (err) {
            return {
                ok: false,
                status: 0,
                data: null,
                error: { message: `Failed to fetch: ${err?.message || 'sin conexión LAN'}`, status: 0 },
            };
        }
    }

    function notifyAllChannels(status) {
        for (const ch of activeChannels) {
            ch._notifyStatus(status);
        }
    }

    function dispatchDbEvent(ev) {
        for (const ch of activeChannels) {
            ch._dispatch(ev);
        }
    }

    function stopStream() {
        if (streamAbort) {
            streamAbort.abort();
            streamAbort = null;
        }
        streamRunning = false;
        streamConnected = false;
    }

    async function ensureStream() {
        if (streamRunning || !activeChannels.size) return;
        const root = resolveUrl();
        const session = store.read();
        if (!root || !session?.token) {
            queueMicrotask(() => notifyAllChannels('CHANNEL_ERROR'));
            return;
        }
        streamRunning = true;
        streamConnected = false;
        const controller = new AbortController();
        streamAbort = controller;

        try {
            const res = await fetchImpl(`${root}/lan/events`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${session.token}` },
                signal: controller.signal,
            });
            if (!res.ok || !res.body) {
                throw new Error(`HTTP ${res.status}`);
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const block = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    const lines = block.split('\n');
                    let eventName = 'message';
                    const dataLines = [];
                    for (const rawLine of lines) {
                        const line = rawLine.replace(/\r$/, '');
                        if (!line || line.startsWith(':')) continue;
                        if (line.startsWith('event:')) eventName = line.slice(6).trim();
                        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                    }
                    if (!dataLines.length) continue;
                    const payloadStr = dataLines.join('\n');
                    if (eventName === 'connected') {
                        streamConnected = true;
                        notifyAllChannels('SUBSCRIBED');
                    } else if (eventName === 'db_change') {
                        try {
                            dispatchDbEvent(JSON.parse(payloadStr));
                        } catch {
                            /* ignorar evento mal formado */
                        }
                    }
                }
            }
            if (!controller.signal.aborted) {
                streamRunning = false;
                streamConnected = false;
                notifyAllChannels('CLOSED');
            }
        } catch {
            if (!controller.signal.aborted) {
                streamRunning = false;
                streamConnected = false;
                notifyAllChannels('CHANNEL_ERROR');
            }
        }
    }

    const client = {
        auth: {
            async getSession() {
                const cached = store.read();
                if (!cached?.token || !cached?.user?.id) {
                    return { data: { session: null }, error: null };
                }
                // Verificación best-effort: si la red LAN está caída momentáneamente,
                // devolvemos la sesión en caché para no romper el arranque offline.
                const res = await requestJson('/lan/auth/session', { method: 'GET' });
                if (res.ok && res.data) {
                    if (!res.data.session) {
                        store.write(null);
                        return { data: { session: null }, error: null };
                    }
                    store.write(res.data.session);
                    return { data: { session: { user: res.data.session.user } }, error: null };
                }
                return { data: { session: { user: cached.user } }, error: null };
            },

            async signInAnonymously() {
                const res = await requestJson('/lan/auth/device', { method: 'POST', body: {}, useAuth: false });
                if (!res.ok) return { data: {}, error: res.error };
                store.write({ token: res.data.token, user: res.data.user });
                return { data: { user: res.data.user, session: { user: res.data.user } }, error: null };
            },

            async signUp({ email, password }) {
                const res = await requestJson('/lan/auth/owner/signup', {
                    method: 'POST',
                    body: { email, password },
                    useAuth: false,
                });
                if (!res.ok) return { data: {}, error: res.error };
                store.write({ token: res.data.token, user: res.data.user });
                return { data: { user: res.data.user, session: { user: res.data.user } }, error: null };
            },

            async signInWithPassword({ email, password }) {
                const res = await requestJson('/lan/auth/owner/signin', {
                    method: 'POST',
                    body: { email, password },
                    useAuth: false,
                });
                if (!res.ok) return { data: {}, error: res.error };
                store.write({ token: res.data.token, user: res.data.user });
                return { data: { user: res.data.user, session: { user: res.data.user } }, error: null };
            },

            async updateUser({ password }) {
                const res = await requestJson('/lan/auth/owner/password', {
                    method: 'POST',
                    body: { password },
                });
                if (!res.ok) return { data: {}, error: res.error };
                const cached = store.read();
                return { data: { user: cached?.user || { email: res.data.email } }, error: null };
            },

            async signOut() {
                stopStream();
                await requestJson('/lan/auth/owner/signout', { method: 'POST', body: {} });
                store.write(null);
                return { error: null };
            },
        },

        from(table) {
            return new LanQueryBuilder(client, table);
        },

        async _query(spec) {
            const res = await requestJson('/lan/query', { method: 'POST', body: spec });
            if (!res.ok) return { data: null, error: res.error };
            return { data: res.data?.data ?? null, error: res.data?.error ?? null };
        },

        async rpc(fn, args = {}) {
            const res = await requestJson(`/lan/rpc/${encodeURIComponent(fn)}`, {
                method: 'POST',
                body: args || {},
            });
            if (!res.ok) return { data: null, error: res.error };
            return { data: res.data?.data ?? null, error: res.data?.error ?? null };
        },

        channel(name) {
            const listeners = [];
            let statusCb = null;
            let unsubscribed = false;
            const ch = {
                name,
                on(type, opts, cb) {
                    if (type === 'postgres_changes' && typeof cb === 'function') {
                        listeners.push({ opts: opts || {}, cb });
                    }
                    return ch;
                },
                subscribe(cb) {
                    statusCb = typeof cb === 'function' ? cb : null;
                    unsubscribed = false;
                    activeChannels.add(ch);
                    if (streamConnected) {
                        queueMicrotask(() => {
                            if (!unsubscribed) statusCb?.('SUBSCRIBED');
                        });
                    } else {
                        ensureStream();
                    }
                    return ch;
                },
                _notifyStatus(status) {
                    if (!unsubscribed) statusCb?.(status);
                },
                _dispatch(ev) {
                    if (unsubscribed || !ev) return;
                    for (const { opts, cb } of listeners) {
                        if (opts.table && opts.table !== ev.table) continue;
                        if (opts.filter && !matchesFilter(opts.filter, ev.new)) continue;
                        cb({
                            eventType: 'UPDATE',
                            schema: 'public',
                            table: ev.table,
                            new: ev.new,
                            old: {},
                        });
                    }
                },
                _dispose() {
                    unsubscribed = true;
                    activeChannels.delete(ch);
                    if (!activeChannels.size) stopStream();
                },
            };
            return ch;
        },

        async removeChannel(ch) {
            ch?._dispose?.();
        },

        lan: {
            getBaseUrl: resolveUrl,
            getToken: () => store.read()?.token || null,
            async health() {
                return probeLanServer(resolveUrl(), fetchImpl);
            },
            async generatePairingCode(accountId = null) {
                const res = await requestJson('/lan/pairing/code', { method: 'POST', body: { accountId } });
                if (!res.ok) throw new Error(res.error?.message || 'No se pudo crear el código');
                return res.data;
            },
            async claimPairingCode(code) {
                const res = await requestJson('/lan/pairing/claim', { method: 'POST', body: { code }, useAuth: false });
                if (!res.ok) throw new Error(res.error?.message || 'Código inválido');
                store.write({ token: res.data.token, user: res.data.user });
                return res.data;
            },
            async bootstrapLocalOwner() {
                const res = await requestJson('/lan/auth/local-owner', { method: 'POST', body: {}, useAuth: false });
                if (!res.ok) throw new Error(res.error?.message || 'No se pudo iniciar la configuración local.');
                store.write({ token: res.data.token, user: res.data.user });
                return res.data;
            },
            async ownerPinSignIn(pin) {
                const res = await requestJson('/lan/auth/owner-pin', { method: 'POST', body: { pin }, useAuth: false });
                if (!res.ok) throw new Error(res.error?.message || 'PIN incorrecto.');
                store.write({ token: res.data.token, user: res.data.user });
                return res.data;
            },
            async resetLocalOwnerPin(pin) {
                const res = await requestJson('/lan/auth/local-reset-pin', { method: 'POST', body: { pin }, useAuth: false });
                if (!res.ok) throw new Error(res.error?.message || 'No se pudo restablecer el PIN.');
                store.write({ token: res.data.token, user: res.data.user });
                return res.data;
            },
            async rebindDevice({ deviceId, deviceUserId }) {
                const res = await requestJson('/lan/devices/rebind', {
                    method: 'POST',
                    body: { deviceId, deviceUserId },
                });
                if (!res.ok) throw new Error(res.error?.message || 'No se pudo reconectar este equipo.');
                return res.data?.device ?? null;
            },
            async uploadImage(dataUri, id) {
                const res = await requestJson('/lan/images', { method: 'POST', body: { dataUri, id } });
                if (!res.ok || !res.data?.path) return null;
                return `${resolveUrl()}${res.data.path}`;
            },
            async exportSnapshot() {
                const res = await requestJson('/lan/backup/snapshot', { method: 'GET' });
                if (!res.ok) throw new Error(res.error?.message || 'No se pudo exportar el respaldo');
                return res.data;
            },
            async restoreSnapshot(snapshot) {
                const res = await requestJson('/lan/backup/restore', { method: 'POST', body: snapshot });
                if (!res.ok) throw new Error(res.error?.message || 'No se pudo restaurar el respaldo');
                return res.data;
            },
            async fetchOfflinePassport() {
                const res = await requestJson('/lan/device/offline-passport', { method: 'GET' });
                if (!res.ok) throw new Error(res.error?.message || 'No se pudo obtener el pasaporte offline');
                return res.data;
            },
            async applyLicense(licenseToken) {
                const res = await requestJson('/lan/license/apply', { method: 'POST', body: { licenseToken } });
                if (!res.ok) throw new Error(res.error?.message || 'No se pudo activar la licencia');
                return res.data;
            },
            async getBridgeStatus() {
                const res = await requestJson('/lan/bridge/status', { method: 'GET' });
                if (!res.ok) throw new Error(res.error?.message || 'No se pudo consultar el puente');
                return res.data;
            },
            async setupBridge(opts) {
                const res = await requestJson('/lan/bridge/setup', { method: 'POST', body: opts });
                if (!res.ok) throw new Error(res.error?.message || 'No se pudo activar el puente');
                return res.data;
            },
            async disableBridge() {
                const res = await requestJson('/lan/bridge/disable', { method: 'POST', body: {} });
                if (!res.ok) throw new Error(res.error?.message || 'No se pudo apagar el puente');
                return res.data;
            },
            async syncBridgeNow() {
                const res = await requestJson('/lan/bridge/sync', { method: 'POST', body: {} });
                if (!res.ok) throw new Error(res.error?.message || 'No se pudo sincronizar ahora');
                return res.data;
            },
        },
    };

    return client;
}
