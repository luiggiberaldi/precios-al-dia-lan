import { useEffect, useState } from 'react';
import SplashScreenPlayer from '../remotion/SplashScreenPlayer';
import { getLocalISODate } from '../utils/dateHelpers';
import { NUBE_BRAND } from './brand';

import { isLanModeEnabled } from '../lan/lanConfig';

/** Colores y textos de la animación de inicio de la nube (la misma de Bodega, en azul). */
export const NUBE_SPLASH_BRAND = Object.freeze({
    primaryColor: NUBE_BRAND.themeColor, // #2b59c3
    secondaryColor: '#1d3d86',           // --color-primary-700
    title: 'PRECIOS AL DÍA',
    subtitle: isLanModeEnabled() ? 'PUNTO DE VENTA EN RED LOCAL' : 'PUNTO DE VENTA EN LA NUBE',
});

// En oscuro, el azul claro de la marca (brand.css .dark) para que no se apague sobre el fondo.
const NUBE_SPLASH_BRAND_DARK = Object.freeze({ ...NUBE_SPLASH_BRAND, primaryColor: '#6ea8ff', secondaryColor: '#2b59c3' });
const isDarkTheme = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

const LAST_SPLASH_KEY = 'pda_last_splash_date';

/**
 * Animación de inicio de Precios al Día Nube.
 * Sale al abrir la app, encima de la puerta de cuenta/PIN, que va cargando debajo.
 * Igual que Bodega: completa en la primera apertura del día, corta en las demás;
 * se salta con un toque o con Esc.
 */
export default function NubeSplash({ children }) {
    const [splash, setSplash] = useState(() => {
        try {
            return { show: true, mode: localStorage.getItem(LAST_SPLASH_KEY) !== getLocalISODate() ? 'full' : 'express' };
        } catch {
            return { show: true, mode: 'express' };
        }
    });
    const hide = () => setSplash((prev) => ({ ...prev, show: false }));

    useEffect(() => {
        if (splash.mode !== 'full') return;
        try { localStorage.setItem(LAST_SPLASH_KEY, getLocalISODate()); } catch { /* sin localStorage */ }
    }, [splash.mode]);

    useEffect(() => {
        if (!splash.show) return undefined;
        // Red de seguridad por si la animación no avisa al terminar.
        const timer = setTimeout(hide, splash.mode === 'express' ? 1400 : 2800);
        const onKey = (e) => { if (e.key === 'Escape') hide(); };
        window.addEventListener('keydown', onKey);
        return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey); };
    }, [splash.show, splash.mode]);

    return (
        <>
            {children}
            {splash.show && (
                <div
                    onClick={hide}
                    className="fixed inset-0 z-[9999] bg-white dark:bg-[#1a1917] flex flex-col items-center justify-center cursor-pointer animate-in fade-in"
                    role="status"
                    aria-label={`Cargando ${NUBE_BRAND.name}`}
                    title="Toca o presiona Esc para saltar"
                >
                    <div className="w-full h-full max-w-xl max-h-[720px] flex items-center justify-center p-4">
                        <SplashScreenPlayer {...(isDarkTheme() ? NUBE_SPLASH_BRAND_DARK : NUBE_SPLASH_BRAND)} loop={false} mode={splash.mode} onComplete={hide} />
                    </div>
                    <span className="absolute bottom-6 text-[11px] font-semibold tracking-wider text-slate-400 dark:text-slate-500 uppercase select-none pointer-events-none opacity-75">
                        Toca o presiona Esc para saltar
                    </span>
                </div>
            )}
        </>
    );
}
