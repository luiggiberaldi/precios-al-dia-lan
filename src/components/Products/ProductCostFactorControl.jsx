import React, { useState } from 'react';
import {
    costFactorFromMarginPercent,
    formatCostFactorAsMarginPercent,
} from '../../utils/productCostFactor';

export default function ProductCostFactorControl({ costFactor, onChange }) {
    const [inputValue, setInputValue] = useState(null);
    const displayValue = inputValue !== null
        ? inputValue
        : formatCostFactorAsMarginPercent(costFactor);

    return (
        <div className="mt-2.5 pt-2.5 border-t border-slate-200/60 dark:border-slate-700/40">
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Margen de ganancia (%)</span>
            </div>
            <div className="relative">
                <input
                    autoComplete="off"
                    type="number"
                    inputMode="decimal"
                    step="any"
                    aria-label="Factor costo"
                    value={displayValue}
                    onChange={event => {
                        const value = event.target.value;
                        setInputValue(value);
                        if (value === '') {
                            onChange('');
                            return;
                        }
                        if (value === '.' || value === '-') return;
                        const factor = costFactorFromMarginPercent(value);
                        if (factor !== '') onChange(factor);
                    }}
                    onBlur={() => setInputValue(null)}
                    placeholder="30"
                    className="w-full bg-white dark:bg-slate-900 p-2.5 pr-10 rounded-xl font-bold text-slate-700 dark:text-white outline-none border border-slate-200/60 dark:border-slate-800/40 focus:ring-2 focus:ring-slate-500/40 transition-all text-xs"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-black text-slate-400">
                    %
                </span>
            </div>
            <p className="text-[9px] text-slate-400 mt-1 ml-1">
                Margen de ganancia en % • El costo se respeta: el % recalcula el precio y el precio recalcula el %
            </p>
        </div>
    );
}
