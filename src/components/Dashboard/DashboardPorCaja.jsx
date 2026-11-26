import React from 'react';
import { Store, RefreshCw } from 'lucide-react';
import { formatBs } from '../../utils/calculatorUtils';

/**
 * Nube (dueño / administrador): lo que lleva hoy cada caja de la cuenta.
 * Solo lectura; cerrar caja se hace en cada caja.
 */
export default function DashboardPorCaja({ cajas = [], loading = false, error = null, onRefresh }) {
    return (
        <section data-testid="dashboard-por-caja" className="mb-5 bg-white dark:bg-slate-900 rounded-2xl p-4 border border-slate-100 dark:border-slate-800 shadow-sm">
            <div className="flex items-center justify-between gap-2 mb-3">
                <h3 className="text-xs font-bold text-slate-400 uppercase flex items-center gap-1.5">
                    <Store size={13} className="text-brand" /> Por caja · hoy
                </h3>
                {onRefresh && (
                    <button type="button" onClick={onRefresh} disabled={loading}
                        className="flex items-center gap-1 text-[11px] text-brand font-bold hover:underline disabled:opacity-50">
                        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Actualizar
                    </button>
                )}
            </div>
            {error && <p className="text-[11px] text-red-500 mb-2">No se pudo leer las otras cajas: {error}</p>}
            {loading && cajas.length <= 1 && <p className="text-[11px] text-slate-400 mb-2">Leyendo las ventas de todas las cajas…</p>}
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {cajas.map((c) => (
                    <div key={c.key} data-testid="por-caja-fila" className="py-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                        <div className="min-w-0">
                            <p className="text-sm font-bold text-slate-800 dark:text-white truncate">
                                {c.name}
                                {c.isLocal && <span className="ml-1.5 text-[10px] font-bold text-brand">(esta caja)</span>}
                                {c.revoked && !c.isLocal && <span className="ml-1.5 text-[10px] font-bold text-slate-400">(desconectada)</span>}
                            </p>
                            <p className="text-[11px] text-slate-400">
                                {c.salesCount} {c.salesCount === 1 ? 'venta' : 'ventas'}
                                {' · '}efectivo esperado USD {c.expectedUsd.toFixed(2)} / {formatBs(c.expectedBs)} Bs
                            </p>
                        </div>
                        <div className="text-right">
                            <p className="text-sm font-black text-slate-800 dark:text-white">${c.totalUsd.toFixed(2)}</p>
                            <p className="text-[11px] text-slate-400">{formatBs(c.totalBs)} Bs</p>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
