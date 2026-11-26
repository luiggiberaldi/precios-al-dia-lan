/**
 * Cliente remoto de Modo Supervisor por Internet (Android, iOS y Windows fuera del local).
 *
 * Lee los resúmenes subidos por la Caja Principal (`lan_supervisor_get_snapshot`) y envía
 * cambios mediante `lan_supervisor_enqueue`. Expone la misma interfaz `loaders` de
 * `NubeOwnerDashboard` para reutilizar 100% la interfaz.
 */
import { safeUuid } from '../utils/safeUuid';
import { round2, round4 } from '../utils/dinero';
import { RATE_KEY } from '../nube/rateSync';

export const CLOUD_SUPERVISOR_SESSION_KEY = 'pdn_lan_cloud_supervisor_v1';

export function getLanCloudBridgeConfig(env = import.meta.env) {
    const url = String(env?.VITE_LAN_CLOUD_URL || env?.VITE_SUPABASE_CLOUD_URL || '').trim().replace(/\/+$/, '');
    const key = String(env?.VITE_LAN_CLOUD_KEY || env?.VITE_SUPABASE_CLOUD_ANON_KEY || '').trim();
    return { url, key, available: Boolean(url && key && !url.includes('.invalid')) };
}

export function readCloudSupervisorSession() {
    try {
        const raw = globalThis.localStorage?.getItem(CLOUD_SUPERVISOR_SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.token || !parsed?.accountId) return null;
        if (parsed.expiresAt && Date.parse(parsed.expiresAt) <= Date.now()) {
            globalThis.localStorage?.removeItem(CLOUD_SUPERVISOR_SESSION_KEY);
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function saveCloudSupervisorSession(session) {
    try {
        if (session) globalThis.localStorage?.setItem(CLOUD_SUPERVISOR_SESSION_KEY, JSON.stringify(session));
        else globalThis.localStorage?.removeItem(CLOUD_SUPERVISOR_SESSION_KEY);
    } catch {
        /* sin almacenamiento */
    }
}

export async function callCloudSupervisorRpc(url, key, fn, args = {}, fetchImpl = globalThis.fetch) {
    const cleanUrl = String(url || '').replace(/\/+$/, '');
    if (!cleanUrl || !key) throw new Error('El puente en la nube no está configurado.');
    const res = await fetchImpl(`${cleanUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
    });
    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }
    if (!res.ok) {
        throw new Error(data?.message || data?.error || 'No se pudo conectar con el puente de supervisor.');
    }
    return data;
}

export function createCloudSupervisorClient({
    url,
    key,
    sessionToken = null,
    fetchImpl = globalThis.fetch,
    rpcCaller = null,
} = {}) {
    let token = sessionToken || readCloudSupervisorSession()?.token || null;
    let latestState = null;

    const invoke = (fn, args) => {
        if (typeof rpcCaller === 'function') return rpcCaller(fn, args);
        return callCloudSupervisorRpc(url, key, fn, args, fetchImpl);
    };

    async function refreshSnapshot() {
        if (!token) throw new Error('Sesión de supervisor remoto requerida.');
        const rows = await invoke('lan_supervisor_get_snapshot', { p_session: token });
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (!row) throw new Error('No se encontró información del negocio en la nube.');
        latestState = {
            accountId: row.account_id,
            accountName: row.account_name,
            pushedAt: row.pushed_at,
            snapshot: row.snapshot || {},
            recentCommands: Array.isArray(row.recent_commands) ? row.recent_commands : [],
        };
        return latestState;
    }

    async function ensureSnapshot() {
        return refreshSnapshot();
    }

    async function login(supervisorCode, pin) {
        const rows = await invoke('lan_supervisor_login', {
            p_supervisor_code: String(supervisorCode || '').trim().toUpperCase(),
            p_pin: String(pin || '').trim(),
        });
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (!row?.session_token) throw new Error('Código de negocio o PIN incorrecto.');
        token = row.session_token;
        const sess = {
            token: row.session_token,
            accountId: row.account_id,
            accountName: row.account_name,
            supervisorCode: String(supervisorCode || '').trim().toUpperCase(),
            expiresAt: row.expires_at,
            url,
        };
        saveCloudSupervisorSession(sess);
        return sess;
    }

    async function logout() {
        const activeToken = token;
        token = null;
        latestState = null;
        saveCloudSupervisorSession(null);
        if (activeToken) {
            await invoke('lan_supervisor_logout', { p_session: activeToken }).catch(() => {});
        }
    }

    async function enqueue(action, payload) {
        if (!token) throw new Error('Sesión de supervisor remoto vencida.');
        const rows = await invoke('lan_supervisor_enqueue', {
            p_session: token,
            p_id: safeUuid(),
            p_action: action,
            p_payload: payload,
        });
        return Array.isArray(rows) ? rows[0] : rows;
    }

    const loaders = {
        async loadDaySummary() {
            const st = await ensureSnapshot();
            return st.snapshot?.daySummary || [];
        },
        async loadRecentSales() {
            const st = await ensureSnapshot();
            return st.snapshot?.sales || [];
        },
        async loadStock() {
            const st = await ensureSnapshot();
            const levels = st.snapshot?.stockLevels || [];
            const sedes = st.snapshot?.sedes || [];
            const prods = st.snapshot?.products || [];
            const names = Object.fromEntries(prods.map((p) => [p.id, p.data?.name || p.id]));
            const sedeName = Object.fromEntries(sedes.map((s) => [s.id, s.name]));
            const byProduct = new Map();
            for (const l of levels) {
                if (!byProduct.has(l.product_id)) {
                    byProduct.set(l.product_id, { productId: l.product_id, name: names[l.product_id] || l.product_id, total: 0, sedes: {} });
                }
                const entry = byProduct.get(l.product_id);
                entry.sedes[sedeName[l.sede_id] || l.sede_id] = Number(l.qty) || 0;
                entry.total += Number(l.qty) || 0;
            }
            return {
                products: [...byProduct.values()].sort((a, b) => a.name.localeCompare(b.name)),
                sedes: sedes.map((s) => s.name),
            };
        },
        async loadCustomers() {
            const st = await ensureSnapshot();
            const custs = st.snapshot?.customers || [];
            const balances = st.snapshot?.customerBalances || [];
            const balanceMap = new Map(balances.map((b) => [b.customer_id, Number(b.balance_usd) || 0]));
            return custs.map((c) => ({
                id: c.id,
                name: c.data?.name || c.id,
                phone: c.data?.phone || '',
                balance: balanceMap.get(c.id) ?? 0,
            })).sort((a, b) => a.balance - b.balance || a.name.localeCompare(b.name));
        },
        async loadSupervisorProducts() {
            const st = await ensureSnapshot();
            const prods = st.snapshot?.products || [];
            const levels = st.snapshot?.stockLevels || [];
            const sedes = st.snapshot?.sedes || [];
            const sedeMap = new Map(sedes.map((s) => [s.id, s.name]));
            const stockMap = new Map();
            for (const l of levels) {
                if (!stockMap.has(l.product_id)) stockMap.set(l.product_id, { total: 0, bySedeId: {}, bySedeName: {} });
                const entry = stockMap.get(l.product_id);
                const qty = Number(l.qty) || 0;
                entry.total += qty;
                entry.bySedeId[l.sede_id] = qty;
                entry.bySedeName[sedeMap.get(l.sede_id) || l.sede_id] = qty;
            }
            const products = prods.map((rec) => {
                const d = rec.data || {};
                const stockInfo = stockMap.get(rec.id) || { total: 0, bySedeId: {}, bySedeName: {} };
                return {
                    id: rec.id,
                    name: d.name || rec.id,
                    barcode: d.barcode || '',
                    priceUsd: Number(d.priceUsdt ?? d.priceUsd ?? 0) || 0,
                    costUsd: Number(d.costUsd ?? 0) || 0,
                    unit: d.unit || 'unidad',
                    category: d.category || 'otros',
                    version: rec.version,
                    raw: d,
                    totalStock: stockInfo.total,
                    stockBySedeId: stockInfo.bySedeId,
                    stockBySedeName: stockInfo.bySedeName,
                };
            }).sort((a, b) => a.name.localeCompare(b.name));
            return { products, sedes };
        },
        async loadCurrentRate() {
            const st = await ensureSnapshot();
            const rec = st.snapshot?.rateRecord || null;
            const d = rec?.data || {};
            return {
                rateMode: ['bcv', 'euro', 'usdt', 'manual'].includes(d.rateMode) ? d.rateMode : 'bcv',
                customRate: d.customRate ?? '',
                copEnabled: Boolean(d.copEnabled),
                autoCopEnabled: Boolean(d.autoCopEnabled),
                tasaCop: d.tasaCop ?? '',
                copPrimary: Boolean(d.copPrimary),
                version: rec?.version ?? null,
                updatedAt: rec?.updated_at ?? null,
                raw: d,
            };
        },
        async loadDiscrepancies() {
            const st = await ensureSnapshot();
            const prods = Object.fromEntries((st.snapshot?.products || []).map((p) => [p.id, p.data?.name || p.id]));
            return (st.snapshot?.discrepancies || []).map((d) => ({ ...d, name: prods[d.product_id] || d.product_id }));
        },
        async saveSupervisorProduct(_client, _session, input) {
            const st = await ensureSnapshot();
            const existing = input.id ? (st.snapshot?.products || []).find((p) => p.id === input.id) : null;
            const productId = input.id || safeUuid();
            const numPrice = round4(Number(input.priceUsd));
            if (!String(input.name || '').trim()) throw new Error('Escribe el nombre del producto.');
            if (!Number.isFinite(numPrice) || numPrice < 0) throw new Error('Precio USD inválido.');
            const nextData = {
                ...(existing?.data || {}),
                id: productId,
                name: String(input.name).trim(),
                barcode: String(input.barcode || '').trim(),
                priceUsdt: numPrice,
                priceUsd: numPrice,
                costUsd: round2(Number(input.costUsd) || 0),
                unit: String(input.unit || existing?.data?.unit || 'unidad'),
                category: String(input.category || existing?.data?.category || 'otros'),
                updatedAt: new Date().toISOString(),
            };
            return enqueue('save_product', {
                id: productId,
                data: nextData,
                base_version: existing?.version ?? null,
                initialStock: !input.id ? Number(input.initialStock) || 0 : 0,
                initialMovementId: !input.id && Number(input.initialStock) > 0 ? safeUuid() : null,
                sedeId: input.sedeId || null,
            });
        },
        async deleteSupervisorProduct(_client, _session, product) {
            return enqueue('delete_product', {
                id: product.id,
                data: product.raw || { id: product.id },
                base_version: product.version ?? null,
            });
        },
        async adjustSupervisorStock(_client, _session, input) {
            const numQty = round4(Number(input.qty));
            if (!Number.isFinite(numQty)) throw new Error('Cantidad inválida.');
            return enqueue('adjust_stock', {
                reason: input.reason || 'AJUSTE',
                movements: [{
                    id: safeUuid(),
                    product_id: input.productId,
                    qty: numQty,
                    note: String(input.note || '').trim() || 'Ajuste desde Supervisor remoto',
                }],
                sedeId: input.sedeId || null,
            });
        },
        async updateSupervisorRate(_client, _session, draft) {
            const current = await loaders.loadCurrentRate();
            if (draft.rateMode === 'manual' && !(Number(draft.customRate) > 0)) {
                throw new Error('Ingresa una tasa manual mayor a 0.');
            }
            const nextData = {
                ...current.raw,
                id: RATE_KEY,
                rateMode: draft.rateMode,
                customRate: draft.rateMode === 'manual' ? String(draft.customRate).trim() : String(draft.customRate || current.customRate || ''),
                copEnabled: Boolean(draft.copEnabled),
                tasaCop: draft.copEnabled ? String(draft.tasaCop || current.tasaCop || '').trim() : String(current.tasaCop || ''),
                updatedAt: new Date().toISOString(),
            };
            return enqueue('update_rate', {
                data: nextData,
                base_version: current.version ?? null,
            });
        },
        async voidSupervisorSale(_client, _session, { saleId, reason }) {
            if (!String(reason || '').trim()) throw new Error('Indica el motivo de la anulación.');
            return enqueue('void_sale', { saleId, reason: String(reason).trim() });
        },
        async recordSupervisorCustomerPayment(_client, _session, { customerId, amountUsd, note }) {
            const cleanAmount = round2(Number(amountUsd));
            if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) throw new Error('Monto inválido.');
            return enqueue('customer_payment', {
                movements: [{
                    id: safeUuid(),
                    customer_id: customerId,
                    type: 'ABONO_DEUDA',
                    direction: 'CREDIT',
                    amount_usd: cleanAmount,
                    reason: String(note || '').trim() || 'Abono desde Supervisor remoto',
                    device_at: new Date().toISOString(),
                }],
            });
        },
        async resolveSupervisorDiscrepancy(_client, _session, { discrepancyId, note }) {
            return enqueue('resolve_discrepancy', {
                discrepancyId,
                note: String(note || '').trim() || 'Revisado desde Supervisor remoto',
            });
        },
    };

    // Cliente ligero compatible con las comprobaciones `typeof client?.rpc === 'function'` de NubeOwnerDashboard
    const client = {
        isCloudSupervisor: true,
        async rpc() {
            return { data: null, error: null };
        },
    };

    return {
        client,
        loaders,
        login,
        logout,
        refreshSnapshot,
        enqueue,
        getSnapshotMeta: () => latestState,
    };
}
