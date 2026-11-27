import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { pushLocalSync } from '../hooks/useCloudSync';
import { resolveEffectiveRate, resolveTasaCop } from '../utils/effectiveRate';
import { notifyRateChanged } from '../nube/rateSync';

const RateContext = createContext();

export function RateProvider({ children, rates = {}, rateDiscrepancyWarning = null, updateData = null, ratesLoading = false }) {
    // ── MARKET LOGIC - Street Rate ──
    const [streetRate, setStreetRate] = useState(() => {
        const saved = localStorage.getItem('street_rate_bs');
        return saved ? parseFloat(saved) : 0;
    });

    // ── GLOBAL RATE LOGIC — rateMode: 'bcv' | 'euro' | 'usdt' | 'manual' ──
    const [rateMode, setRateMode] = useState(() => {
        const saved = localStorage.getItem('bodega_rate_mode');
        if (saved && ['bcv', 'euro', 'usdt', 'manual'].includes(saved)) return saved;
        const oldAuto = localStorage.getItem('bodega_use_auto_rate');
        return (oldAuto === 'false') ? 'manual' : 'bcv';
    });

    const [customRate, setCustomRate] = useState(() => {
        const saved = localStorage.getItem('bodega_custom_rate');
        return saved && parseFloat(saved) > 0 ? saved : '';
    });

    const useAutoRate = rateMode !== 'manual';
    const setUseAutoRate = useCallback((val) => {
        if (val) {
            setRateMode(prev => ['bcv', 'euro', 'usdt'].includes(prev) ? prev : 'bcv');
        } else {
            setRateMode('manual');
        }
    }, []);

    // ── AUTO COP LOGIC ──
    const [copEnabled, setCopEnabled] = useState(() => {
        return localStorage.getItem('cop_enabled') === 'true';
    });
    const [autoCopEnabled, setAutoCopEnabled] = useState(() => {
        return localStorage.getItem('auto_cop_enabled') === 'true';
    });
    const [tasaCopManual, setTasaCopManual] = useState(() => {
        return localStorage.getItem('tasa_cop') || '';
    });
    const [copPrimary, setCopPrimary] = useState(() => {
        return localStorage.getItem('cop_primary') === 'true';
    });

    // Sync con localStorage
    useEffect(() => {
        localStorage.setItem('bodega_rate_mode', rateMode);
        localStorage.setItem('bodega_use_auto_rate', (rateMode !== 'manual').toString());
        pushLocalSync('bodega_rate_mode', rateMode);
        pushLocalSync('bodega_use_auto_rate', (rateMode !== 'manual').toString());
        notifyRateChanged(); // Nube: una sola tasa para todas las cajas (sin nube no hace nada)
    }, [rateMode]);

    const didMountCustomRef = useRef(false);
    useEffect(() => {
        if (!didMountCustomRef.current) {
            didMountCustomRef.current = true;
            if (customRate) {
                localStorage.setItem('bodega_custom_rate', customRate.toString());
                pushLocalSync('bodega_custom_rate', customRate.toString());
                notifyRateChanged();
            }
            return;
        }
        if (customRate) {
            localStorage.setItem('bodega_custom_rate', customRate.toString());
            pushLocalSync('bodega_custom_rate', customRate.toString());
        } else {
            localStorage.removeItem('bodega_custom_rate');
            pushLocalSync('bodega_custom_rate', '');
        }
        notifyRateChanged();
    }, [customRate]);

    useEffect(() => {
        if (streetRate > 0) localStorage.setItem('street_rate_bs', streetRate.toString());
    }, [streetRate]);

    const didMountCopRef = useRef(false);
    useEffect(() => {
        localStorage.setItem('cop_enabled', copEnabled.toString());
        localStorage.setItem('auto_cop_enabled', autoCopEnabled.toString());
        localStorage.setItem('cop_primary', copPrimary.toString());
        if (tasaCopManual) {
            localStorage.setItem('tasa_cop', tasaCopManual.toString());
        } else if (didMountCopRef.current) {
            localStorage.removeItem('tasa_cop');
        }
        didMountCopRef.current = true;

        pushLocalSync('cop_enabled', copEnabled.toString());
        pushLocalSync('auto_cop_enabled', autoCopEnabled.toString());
        pushLocalSync('cop_primary', copPrimary.toString());
        pushLocalSync('tasa_cop', tasaCopManual ? tasaCopManual.toString() : '');
        notifyRateChanged();
    }, [copEnabled, autoCopEnabled, copPrimary, tasaCopManual]);

    // Listener multi-tab para tasas de cambio
    useEffect(() => {
        const handleStorageChange = (e) => {
            if (e.key === 'bodega_custom_rate' && e.newValue && parseFloat(e.newValue) > 0) setCustomRate(e.newValue);
            if (e.key === 'bodega_rate_mode' && e.newValue) setRateMode(e.newValue);
            if (e.key === 'cop_enabled') setCopEnabled(e.newValue === 'true');
            if (e.key === 'auto_cop_enabled') setAutoCopEnabled(e.newValue === 'true');
            if (e.key === 'tasa_cop') setTasaCopManual(e.newValue || '');
            if (e.key === 'cop_primary') setCopPrimary(e.newValue === 'true');
        };

        const handleAppStorageUpdate = (e) => {
            const key = e.detail?.key;
            if (!key) return;
            if (key === 'bodega_rate_mode') {
                const val = localStorage.getItem('bodega_rate_mode');
                if (val) setRateMode(val);
            }
            if (key === 'bodega_custom_rate') {
                const val = localStorage.getItem('bodega_custom_rate');
                setCustomRate(val && parseFloat(val) > 0 ? val : '');
            }
            if (key === 'cop_enabled') setCopEnabled(localStorage.getItem('cop_enabled') === 'true');
            if (key === 'auto_cop_enabled') setAutoCopEnabled(localStorage.getItem('auto_cop_enabled') === 'true');
            if (key === 'tasa_cop') setTasaCopManual(localStorage.getItem('tasa_cop') || '');
            if (key === 'cop_primary') setCopPrimary(localStorage.getItem('cop_primary') === 'true');
        };

        window.addEventListener('storage', handleStorageChange);
        window.addEventListener('app_storage_update', handleAppStorageUpdate);
        return () => {
            window.removeEventListener('storage', handleStorageChange);
            window.removeEventListener('app_storage_update', handleAppStorageUpdate);
        };
    }, []);

    // ── CÁLCULO DE TASA EFECTIVA EN BS Y COP ──
    // Fuente única (utils/effectiveRate): el receptor de ventas remotas usa la misma fórmula.
    const effectiveRate = useMemo(
        () => resolveEffectiveRate({ rateMode, customRate, rates }),
        [rateMode, customRate, rates],
    );

    const tasaCop = useMemo(
        () => resolveTasaCop({ copEnabled, autoCopEnabled, tasaCopManual, rates }),
        [copEnabled, autoCopEnabled, tasaCopManual, rates],
    );

    const value = useMemo(() => ({
        streetRate,
        setStreetRate,
        rateMode,
        setRateMode,
        useAutoRate,
        setUseAutoRate,
        customRate,
        setCustomRate,
        effectiveRate,
        rates,
        rateDiscrepancyWarning,
        updateData,
        ratesLoading,
        copEnabled,
        setCopEnabled,
        autoCopEnabled,
        setAutoCopEnabled,
        tasaCopManual,
        setTasaCopManual,
        copPrimary,
        setCopPrimary,
        tasaCop
    }), [
        streetRate,
        rateMode,
        useAutoRate,
        setUseAutoRate,
        customRate,
        effectiveRate,
        rates,
        rateDiscrepancyWarning,
        updateData,
        ratesLoading,
        copEnabled,
        autoCopEnabled,
        tasaCopManual,
        copPrimary,
        tasaCop
    ]);

    return (
        <RateContext.Provider value={value}>
            {children}
        </RateContext.Provider>
    );
}

export const useRateContext = () => {
    const context = useContext(RateContext);
    if (!context) {
        throw new Error("useRateContext debe usarse dentro de un RateProvider");
    }
    return context;
};
