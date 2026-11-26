import { NUBE_BRAND } from './brand';
import { isLanModeEnabled } from '../lan/lanConfig';

const LOGO_LIGHT = './logo.png';
const LOGO_DARK = './logodark.png';
const LOGO_LAN_MARK = './logo-lan-mark.png';
const LOGO_LAN_MARK_DARK = './logo-lan-mark-dark.png';

/**
 * Logo de Precios al Día. En modo LAN usa la marca sin el subtítulo «Nube · en línea»
 * y muestra «LAN · todas tus cajas en red local». En modo Nube conserva los PNG originales.
 */
export default function NubeLogo({ className = 'h-12', onDark = false }) {
    if (isLanModeEnabled()) {
        return (
            <div className="inline-flex flex-col items-center justify-center select-none">
                <img
                    src={onDark ? LOGO_LAN_MARK_DARK : LOGO_LAN_MARK}
                    alt={NUBE_BRAND.name}
                    className={`${className} max-h-14 sm:max-h-16 w-auto object-contain select-none`}
                    draggable={false}
                />
                <span className={`text-[11px] sm:text-xs font-extrabold tracking-wide mt-1 ${onDark ? 'text-white/85' : 'text-slate-700 dark:text-slate-200'}`}>
                    LAN · todas tus cajas en red local
                </span>
            </div>
        );
    }

    return (
        <img
            src={onDark ? LOGO_DARK : LOGO_LIGHT}
            alt={NUBE_BRAND.name}
            className={`${className} w-auto object-contain select-none`}
            draggable={false}
        />
    );
}
