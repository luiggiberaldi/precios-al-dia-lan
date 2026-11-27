/**
 * Inicio del dueño y del administrador en la nube: lo de HOY sumado de todas las cajas,
 * con lo que lleva cada una («Por caja»). El cajero no pasa por aquí: ve solo su turno.
 *
 * Fuente: el historial de todas las cajas (`loadAllCajasSales`, colección `cash`). Lo de
 * esta caja se toma de la copia local (es más fresco que lo subido); de la nube se
 * descartan los registros de esta caja para no contarlos dos veces.
 *
 * Cada caja se cuenta con las mismas reglas de turno que su propio Inicio
 * (`findOpenCashShift` / `isShiftCashMovement`), así el total cuadra con la suma de lo
 * que ve cada caja. Funciones puras salvo `loadDashboardCajas`.
 */
import { FinancialEngine } from '../core/FinancialEngine';
import { sumR, mulR } from '../utils/dinero';
import { getLocalISODate } from '../utils/dateHelpers';
import { findOpenCashShift, isRecordInOpenCashShift, isShiftCashMovement } from '../utils/cashShift';
import { calcularEfectivoEsperado } from '../utils/cajaEsperada';
import { computeReceivablesMovements } from '../utils/receivablesReport';
import { loadAllCajasSales, onlySalesHistory } from './allCajasSales';

const SALE_TYPES = new Set(['VENTA', 'VENTA_FIADA', 'VENTA_CASHEA']);
export const LOCAL_CAJA_KEY = 'local';
const NO_DEVICE_KEY = 'sin-caja';

/** ¿El dueño o el administrador? (rol de la sesión de PIN de la nube). */
export function isNubeManagerRole(role) {
    return role === 'dueno' || role === 'administrador';
}

/**
 * Qué caja es esta: la que subió los registros que también están en la copia local.
 * Sin coincidencias (nada subido aún) no se sabe, y la caja local va aparte.
 */
export function inferLocalDeviceId(remoteSales = [], localSales = []) {
    const localIds = new Set(localSales.filter(Boolean).map((s) => String(s.id)));
    const votes = new Map();
    for (const s of remoteSales) {
        if (!s?._deviceId || !localIds.has(String(s.id))) continue;
        votes.set(s._deviceId, (votes.get(s._deviceId) || 0) + 1);
    }
    let best = null;
    for (const [id, n] of votes) if (!best || n > best[1]) best = [id, n];
    return best ? best[0] : null;
}

const withLocalDate = (records, today) => records.map((s) => ({
    ...s,
    localDate: s.timestamp ? getLocalISODate(new Date(s.timestamp)) : today,
}));

/** Lo de hoy (turno abierto) de UNA caja, con las reglas de su Inicio. */
export function summarizeCajaRecords(records = [], { today = getLocalISODate(), bcvRate = 1, products = [] } = {}) {
    const dated = withLocalDate(records.filter(Boolean), today);
    const opening = findOpenCashShift(dated);
    const inShift = (r) => (opening ? isRecordInOpenCashShift(r, opening) : r.localDate === today && r.cajaCerrada !== true);

    const todaySales = dated.filter((s) => s.status !== 'ANULADA' && SALE_TYPES.has(s.tipo) && inShift(s));
    const cashFlow = dated.filter((s) => isShiftCashMovement(s, opening, today));
    const expenses = dated.filter((s) => s.status !== 'ANULADA'
        && (s.tipo === 'PAGO_PROVEEDOR' || s.tipo === 'GASTO_INTERNO')
        && s.afectaCaja !== false && inShift(s));
    const gastos = dated.filter((s) => s.status !== 'ANULADA' && s.tipo === 'GASTO_INTERNO' && inShift(s));
    const paymentBreakdown = FinancialEngine.calculatePaymentBreakdown(cashFlow);
    const { expectedUsd, expectedBs, expectedCop } = calcularEfectivoEsperado(paymentBreakdown);

    return {
        todaySales,
        cashFlow,
        expenses,
        opening,
        salesCount: todaySales.length,
        totalUsd: sumR(todaySales.map((s) => s.totalUsd || 0)),
        totalBs: sumR(todaySales.map((s) => s.totalBs || 0)),
        totalCop: sumR(todaySales.map((s) => s.totalCop || 0)),
        itemsSold: todaySales.reduce((n, s) => n + (Array.isArray(s.items) ? s.items.reduce((m, i) => m + (Number(i?.qty) || 0), 0) : 0), 0),
        expensesUsd: sumR(expenses.map((s) => Math.abs(s.totalUsd || 0))),
        gastosUsd: sumR(gastos.map((s) => Math.abs(s.totalUsd || 0))),
        profit: FinancialEngine.calculateAggregateProfit(todaySales, bcvRate, products),
        paymentBreakdown,
        expectedUsd,
        expectedBs,
        expectedCop,
    };
}

/**
 * Suma de todas las cajas + desglose por caja.
 *
 * @param {object} p
 * @param {Array} p.remoteSales  historial de todas las cajas (con `_deviceId`, `_cajaLabel`).
 * @param {Array} p.localSales   `bodega_sales_v1` de esta caja.
 * @param {string|null} [p.localDeviceId] id de esta caja; si falta se deduce.
 * @param {Object} [p.labels]    { deviceId: nombre } (account_devices.label).
 */
export function buildAllCajasSummary({
    remoteSales = [], localSales = [], localDeviceId = null, labels = {},
    revokedDeviceIds = [],
    today = getLocalISODate(), bcvRate = 1, products = [],
} = {}) {
    const localId = localDeviceId || inferLocalDeviceId(remoteSales, localSales);
    const localIds = new Set(localSales.filter(Boolean).map((s) => String(s.id)));
    const revokedSet = new Set([
        ...(revokedDeviceIds ? [...revokedDeviceIds] : []),
        ...remoteSales.filter((s) => s?._deviceId && s._deviceRevoked).map((s) => s._deviceId),
    ]);

    const groups = new Map();
    const push = (key, rec) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(rec); };
    for (const s of localSales) if (s) push(LOCAL_CAJA_KEY, s);
    for (const s of remoteSales) {
        if (!s) continue;
        if (localId && s._deviceId === localId) continue; // esta caja: manda la copia local
        if (!s._deviceId && localIds.has(String(s.id))) continue; // importación ya presente aquí
        push(s._deviceId || NO_DEVICE_KEY, s);
    }

    const nameOf = (key, records) => {
        if (key === LOCAL_CAJA_KEY) return (localId && labels[localId]) || 'Esta caja';
        if (key === NO_DEVICE_KEY) return 'Sin caja';
        return labels[key] || records.find((r) => r._cajaLabel)?._cajaLabel
            || (records.find((r) => r._caja)?._caja ? `Caja ${records.find((r) => r._caja)._caja}` : 'Caja');
    };

    const cajas = [...groups.entries()].map(([key, records]) => {
        const m = summarizeCajaRecords(records, { today, bcvRate, products });
        const deviceId = key === LOCAL_CAJA_KEY ? localId : (key === NO_DEVICE_KEY ? null : key);
        const isLocal = key === LOCAL_CAJA_KEY;
        return {
            key,
            deviceId,
            isLocal,
            revoked: !isLocal && deviceId != null && revokedSet.has(deviceId),
            name: nameOf(key, records),
            ...m,
        };
    })
        // Solo cajas con algo hoy (o la propia, aunque esté en cero).
        // Si un equipo ya fue desconectado (revoked) y tiene 0 ventas y $0.00 en caja, no se muestra.
        .filter((c) => {
            if (c.isLocal) return true;
            if (c.revoked && c.salesCount === 0 && c.totalUsd === 0 && c.expectedUsd === 0 && c.expectedBs === 0 && c.expectedCop === 0 && c.expensesUsd === 0) {
                return false;
            }
            return c.cashFlow.length > 0 || c.todaySales.length > 0;
        })
        .sort((a, b) => (a.isLocal === b.isLocal ? b.totalUsd - a.totalUsd : a.isLocal ? -1 : 1));

    const todaySales = cajas.flatMap((c) => c.todaySales.map((s) => ({ ...s, _cajaName: c.name })));
    const cashFlow = cajas.flatMap((c) => c.cashFlow);
    const expenses = cajas.flatMap((c) => c.expenses);
    const paymentBreakdown = FinancialEngine.calculatePaymentBreakdown(cashFlow);
    const fondoBreakdown = FinancialEngine.calculatePaymentBreakdown(
        cashFlow.filter((s) => s.tipo === 'APERTURA_CAJA' || s.tipo === 'APORTE_CAJA'),
    );

    return {
        cajas,
        localDeviceId: localId,
        totals: {
            todaySales,
            todayCashFlow: cashFlow,
            todayExpenses: expenses,
            todayTotalUsd: sumR(cajas.map((c) => c.totalUsd)),
            todayTotalBs: sumR(cajas.map((c) => c.totalBs)),
            todayTotalCop: sumR(cajas.map((c) => c.totalCop)),
            todayItemsSold: cajas.reduce((n, c) => n + c.itemsSold, 0),
            todayExpensesUsd: sumR(cajas.map((c) => c.expensesUsd)),
            todayGastosUsd: sumR(cajas.map((c) => c.gastosUsd)),
            todayProfit: sumR(cajas.map((c) => c.profit)),
            paymentBreakdown,
            fondoBreakdown,
            todayReceivables: computeReceivablesMovements(cashFlow),
        },
    };
}

/**
 * T23 (ALT-17): unión deduplicada de todos los registros de esta caja (copia local fresca)
 * más los registros de las demás cajas de la nube/LAN. Sirve tanto para los Reportes
 * consolidados («Todas las cajas») como para `weekData` y `topProducts` del Inicio.
 */
export function mergeAllCajasRecords({ remoteSales = [], localSales = [], localDeviceId = null, labels = {} } = {}) {
    const localId = localDeviceId || inferLocalDeviceId(remoteSales, localSales);
    const localIds = new Set(localSales.filter(Boolean).map((s) => String(s.id)));
    const localName = (localId && labels[localId]) || 'Esta caja';
    const localTagged = localSales.filter(Boolean).map((s) => ({
        ...s,
        _cajaName: s._cajaName || localName,
    }));
    const remoteTagged = remoteSales
        .filter((s) => {
            if (!s) return false;
            if (localId && s._deviceId === localId) return false;
            if (!s._deviceId && localIds.has(String(s.id))) return false;
            return true;
        })
        .map((s) => ({
            ...s,
            _cajaName: (s._deviceId && labels[s._deviceId]) || s._cajaLabel || (s._caja ? `Caja ${s._caja}` : 'Otra caja'),
        }));
    return [...localTagged, ...remoteTagged].sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
}

/**
 * T23 (ALT-17): actividad semanal (7 días) y top productos consolidados de TODAS las cajas,
 * incluyendo ventas de turnos ya cerrados hoy.
 */
export function computeConsolidatedDashboardCharts(records = [], { today = getLocalISODate() } = {}) {
    const dated = withLocalDate(records.filter(Boolean), today);
    const validSales = dated.filter((s) => s.status !== 'ANULADA' && SALE_TYPES.has(s.tipo));

    const [y, m, d] = String(today).split('-').map(Number);
    const baseDate = Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)
        ? new Date(y, m - 1, d)
        : new Date();

    const weekData = Array.from({ length: 7 }, (_, i) => {
        const dt = new Date(baseDate);
        dt.setDate(dt.getDate() - (6 - i));
        const dateStr = getLocalISODate(dt);
        const daySales = validSales.filter((s) => s.localDate === dateStr);
        return { date: dateStr, total: sumR(daySales.map((s) => s.totalUsd || 0)), count: daySales.length };
    });

    const buildTop = (list) => {
        const map = {};
        for (const s of list) {
            if (!Array.isArray(s.items)) continue;
            for (const item of s.items) {
                if (!item || item.isCustom || item.isCashAdvance) continue;
                const key = item.name || item.id;
                if (!key) continue;
                if (!map[key]) map[key] = { name: item.name || key, qty: 0, revenue: 0 };
                map[key].qty += Number(item.qty) || 0;
                map[key].revenue = sumR(map[key].revenue, mulR(item.priceUsd || 0, item.qty || 0));
            }
        }
        return Object.values(map).sort((a, b) => b.qty - a.qty).slice(0, 5);
    };

    const todayCalendarSales = validSales.filter((s) => s.localDate === today);
    return {
        weekData,
        topProducts: buildTop(validSales),
        todayTopProducts: buildTop(todayCalendarSales),
        todayCalendarTotalUsd: sumR(todayCalendarSales.map((s) => s.totalUsd || 0)),
        todayCalendarCount: todayCalendarSales.length,
    };
}

/**
 * «Ventas del día» del historial: lo de HOY (fecha de calendario) de todas las cajas,
 * con lo de esta caja tomado de la copia local. Más reciente primero.
 */
export function salesOfDayAllCajas({ remoteSales = [], localSales = [], localDeviceId = null, labels = {}, today = getLocalISODate() } = {}) {
    const localId = localDeviceId || inferLocalDeviceId(remoteSales, localSales);
    const localIds = new Set(localSales.filter(Boolean).map((s) => String(s.id)));
    const isToday = (s) => s?.timestamp && getLocalISODate(new Date(s.timestamp)) === today;
    const localName = (localId && labels[localId]) || 'Esta caja';
    // La copia local de una venta vieja no dice quién cobró; la subida a la nube sí.
    const remoteSeller = new Map(remoteSales.filter((s) => s?._vendedor).map((s) => [String(s.id), s._vendedor]));
    const local = localSales.filter(isToday).map((s) => ({
        ...s,
        _cajaName: localName,
        ...(!s.vendedor && remoteSeller.has(String(s.id)) ? { _vendedor: remoteSeller.get(String(s.id)) } : {}),
    }));
    const remote = remoteSales.filter((s) => isToday(s)
        && !(localId && s._deviceId === localId)
        && !(!s._deviceId && localIds.has(String(s.id))))
        .map((s) => ({ ...s, _cajaName: (s._deviceId && labels[s._deviceId]) || s._cajaLabel || null }));
    return onlySalesHistory([...local, ...remote]).sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
}

/** Nombres de las cajas (account_devices.label), revocación e id oficial de esta caja. */
export async function readDeviceMeta(client) {
    const [{ data, error }, sessionRes] = await Promise.all([
        client.from('account_devices').select('id, label, revoked_at, auth_user_id'),
        client.auth?.getSession?.().catch(() => null) ?? Promise.resolve(null),
    ]);
    if (error) return { labels: {}, revokedIds: new Set(), currentDeviceId: null };
    const rows = data || [];
    const labels = Object.fromEntries(rows.filter((d) => d.label).map((d) => [d.id, d.label]));
    const revokedIds = new Set(rows.filter((d) => d.revoked_at).map((d) => d.id));
    const authUid = sessionRes?.data?.session?.user?.id || null;
    const ownRow = authUid
        ? (rows.find((d) => d.auth_user_id === authUid && !d.revoked_at) || rows.find((d) => d.auth_user_id === authUid))
        : null;
    return { labels, revokedIds, currentDeviceId: ownRow?.id || null };
}

/** Nombres de las cajas (account_devices.label). */
export async function readDeviceLabels(client) {
    const { labels } = await readDeviceMeta(client);
    return labels;
}

/** Para `useAllCajasSales(..., { load })`: el historial con el nombre de cada caja. */
export async function loadDashboardCajas(client) {
    const [sales, { labels, revokedIds, currentDeviceId }] = await Promise.all([loadAllCajasSales(client), readDeviceMeta(client)]);
    const out = sales.map((s) => {
        if (!s._deviceId) return s;
        return {
            ...s,
            ...(labels[s._deviceId] ? { _cajaLabel: labels[s._deviceId] } : {}),
            ...(revokedIds.has(s._deviceId) ? { _deviceRevoked: true } : {}),
        };
    });
    // Adjuntamos el id oficial de esta caja y el mapa completo de nombres sin romper
    // el contrato de Array que esperan callers y tests.
    Object.defineProperties(out, {
        _currentDeviceId: { value: currentDeviceId, enumerable: false },
        _deviceLabels: { value: labels, enumerable: false },
    });
    return out;
}
