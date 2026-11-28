import { useEffect, useState } from 'react';
import { Wallet, Check } from 'lucide-react';
import { SectionCard } from '../SettingsShared';
import { showToast } from '../Toast';
import { GOODS_VALUATION_KEY, GOODS_VALUATIONS, GOODS_VALUATION_LABELS, readGoodsValuation } from '../../utils/payrollModel';
import { notifyBusinessConfigChanged } from '../../nube/businessConfigSync';

const DESCRIPTIONS = {
    costo: 'Se le descuenta lo que le costó a la bodega.',
    venta: 'Se le descuenta como si lo comprara un cliente.',
};

/**
 * Ajustes › Negocio › Nómina (P-012, F6): a qué precio se descuenta del sueldo
 * la mercancía que se lleva un empleado. Decisión del dueño (15-11-2026): que
 * sea una opción. Vive solo en este equipo y viaja en el respaldo (LS_KEYS).
 */
export default function PayrollSettingsCard({ triggerHaptic }) {
    const [valuation, setValuation] = useState(() => readGoodsValuation());

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const onUpdate = (e) => {
            if (e?.detail?.key === GOODS_VALUATION_KEY) {
                setValuation(readGoodsValuation());
            }
        };
        window.addEventListener('app_storage_update', onUpdate);
        return () => window.removeEventListener('app_storage_update', onUpdate);
    }, []);

    const choose = (v) => {
        setValuation(v);
        try { localStorage.setItem(GOODS_VALUATION_KEY, v); } catch { /* sin almacenamiento: queda en memoria */ }
        notifyBusinessConfigChanged();
        triggerHaptic?.();
        showToast(`Mercancía de empleados: ${GOODS_VALUATION_LABELS[v].toLowerCase()}`, 'success');
    };

    return (
        <SectionCard icon={Wallet} title="Nómina" subtitle="Mercancía que se lleva un empleado" iconColor="text-brand">
            <div className="space-y-3">
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    Cuando un empleado se lleva productos, se restan de su sueldo a este precio:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5" role="radiogroup" aria-label="Precio de la mercancía de empleados">
                    {GOODS_VALUATIONS.map(v => {
                        const selected = valuation === v;
                        return (
                            <button
                                key={v}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                data-testid={`payroll-valuation-${v}`}
                                onClick={() => choose(v)}
                                className={`p-3.5 text-left rounded transition-all border flex flex-col justify-between gap-1 cursor-pointer active:scale-[0.98] ${selected
                                    ? 'bg-brand-light dark:bg-brand/15 border-brand text-brand-dark dark:text-brand shadow-xs ring-1 ring-brand/25'
                                    : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                                }`}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-black text-slate-800 dark:text-white">{GOODS_VALUATION_LABELS[v]}</span>
                                    {selected && (
                                        <span className="w-4 h-4 rounded-full bg-brand text-white flex items-center justify-center shrink-0">
                                            <Check size={10} strokeWidth={3} />
                                        </span>
                                    )}
                                </div>
                                <span className="block text-[11px] leading-snug opacity-85">{DESCRIPTIONS[v]}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </SectionCard>
    );
}
