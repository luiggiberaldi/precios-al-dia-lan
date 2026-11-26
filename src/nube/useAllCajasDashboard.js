/**
 * Inicio del dueño / administrador en la nube: suma de todas las cajas de hoy y «Por caja».
 * Baja el historial de las cajas al abrir el Inicio y al pedir «Actualizar» (no en
 * segundo plano, G12). Lo de esta caja sale de la copia local, así que se ve al instante.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useAllCajasSales } from './useAllCajasSales';
import { buildAllCajasSummary, loadDashboardCajas, salesOfDayAllCajas } from './allCajasToday';
import { getLocalISODate } from '../utils/dateHelpers';

export function useAllCajasDashboard(enabled, { localSales = [], bcvRate = 1, products = [], client = null, load = loadDashboardCajas, isActive = true } = {}) {
    const remote = useAllCajasSales(enabled, { client, load });
    const today = getLocalISODate();

    // Al volver a la pestaña Inicio (tras vender, cerrar turno o restaurar un respaldo),
    // refrescamos las demás cajas para que los totales no queden con datos viejos.
    const wasActiveRef = useRef(isActive);
    useEffect(() => {
        const becameActive = isActive && !wasActiveRef.current;
        wasActiveRef.current = isActive;
        if (enabled && becameActive) {
            remote.refresh();
        }
    }, [enabled, isActive, remote.refresh]);

    const labels = useMemo(() => ({
        ...(remote.sales?._deviceLabels || {}),
        ...Object.fromEntries(
            remote.sales.filter((s) => s._deviceId && s._cajaLabel).map((s) => [s._deviceId, s._cajaLabel]),
        ),
    }), [remote.sales]);

    const revokedDeviceIds = useMemo(() => new Set(
        remote.sales.filter((s) => s._deviceId && s._deviceRevoked).map((s) => s._deviceId),
    ), [remote.sales]);

    const explicitLocalDeviceId = remote.sales?._currentDeviceId || null;

    const summary = useMemo(() => (enabled
        ? buildAllCajasSummary({
            remoteSales: remote.sales,
            localSales,
            localDeviceId: explicitLocalDeviceId,
            labels,
            revokedDeviceIds,
            today,
            bcvRate,
            products,
        })
        : null), [enabled, remote.sales, localSales, explicitLocalDeviceId, labels, revokedDeviceIds, today, bcvRate, products]);

    const daySales = useMemo(() => (enabled
        ? salesOfDayAllCajas({ remoteSales: remote.sales, localSales, localDeviceId: summary?.localDeviceId, labels, today })
        : null), [enabled, remote.sales, localSales, summary, labels, today]);

    return {
        summary,
        daySales,
        loading: remote.loading,
        error: remote.error,
        loadedAt: remote.loadedAt,
        refresh: remote.refresh,
    };
}
