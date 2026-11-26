/**
 * Carga el historial de todas las cajas cuando se abre la pestaña (y al pedir «Actualizar»).
 * No se baja en segundo plano: solo cuando el dueño o el administrador lo mira (G12).
 */
import { useCallback, useEffect, useState } from 'react';
import { getDeviceClient } from './nubeSupabase';
import { loadAllCajasSales } from './allCajasSales';

export function useAllCajasSales(enabled, { client = null, load = loadAllCajasSales } = {}) {
    const [state, setState] = useState({ sales: [], loading: false, error: null, loadedAt: null });
    const [tick, setTick] = useState(0);
    const refresh = useCallback(() => setTick((t) => t + 1), []);

    useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        setState((s) => ({ ...s, loading: true, error: null }));
        load(client || getDeviceClient())
            .then((sales) => { if (!cancelled) setState({ sales, loading: false, error: null, loadedAt: Date.now() }); })
            .catch((e) => { if (!cancelled) setState((s) => ({ ...s, loading: false, error: e?.message || 'No se pudo leer el historial' })); });
        return () => { cancelled = true; };
    }, [enabled, tick, client, load]);

    return { ...state, refresh };
}
