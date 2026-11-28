import { Users, Truck, Wallet } from 'lucide-react';
import { can, PERMISSIONS } from '../../security/permissions';
import { usePermissions } from '../../hooks/usePermissions';

/**
 * Sub-pestañas de «Gestión» (antes «Clientes»): Clientes · Proveedores · Nómina.
 * RBAC:
 *   - Clientes: DUENO, ENCARGADO, CAJERO (tab.customers)
 *   - Proveedores: DUENO, ENCARGADO, INVENTARIO (tab.suppliers)
 *   - Nómina: solo DUENO (tab.payroll)
 */
export const GESTION_TABS = [
    { id: 'clientes', label: 'Clientes', icon: Users, adminOnly: false, permission: PERMISSIONS.TAB_CUSTOMERS },
    { id: 'proveedores', label: 'Proveedores', icon: Truck, adminOnly: true, permission: PERMISSIONS.TAB_SUPPLIERS },
    { id: 'nomina', label: 'Nómina', icon: Wallet, adminOnly: true, permission: PERMISSIONS.TAB_PAYROLL },
];

/**
 * ¿Puede este rol abrir la sub-pestaña?
 * Acepta tanto booleano legacy `isCajero` como un objeto usuario RBAC.
 */
export function canOpenGestionTab(tab, userOrIsCajero, options = {}) {
    const def = GESTION_TABS.find(t => t.id === tab);
    if (!def) return false;
    if (typeof userOrIsCajero === 'boolean') {
        return !(userOrIsCajero && def.adminOnly);
    }
    return can(userOrIsCajero, def.permission, options);
}

export default function GestionTabs({ activeTab, onChange, isCajero, triggerHaptic }) {
    const { usuarioActivo, requireLogin } = usePermissions();
    const visible = GESTION_TABS.filter(t =>
        typeof isCajero === 'boolean' && !usuarioActivo
            ? canOpenGestionTab(t.id, isCajero)
            : canOpenGestionTab(t.id, usuarioActivo, { requireLogin })
    );
    return (
        <div className="px-3 sm:px-6 pt-3 sm:pt-6 shrink-0 z-10 bg-surface-50/80 dark:bg-surface-950/80 backdrop-blur-xl">
            <div role="tablist" aria-label="Secciones de Gestión" className="flex bg-surface-200/50 dark:bg-surface-800/80 p-1.5 rounded-2xl shadow-inner">
                {visible.map(({ id, label, icon: Icon }) => {
                    const active = activeTab === id;
                    return (
                        <button
                            key={id}
                            role="tab"
                            aria-selected={active}
                            data-testid={`gestion-tab-${id}`}
                            onClick={() => { onChange(id); triggerHaptic && triggerHaptic(); }}
                            className={`flex flex-1 items-center justify-center gap-2 py-2.5 min-h-[40px] text-sm font-bold rounded-xl transition-all duration-300 ${active ? 'bg-surface dark:bg-surface-900 shadow-tone-sm text-brand-dark dark:text-brand scale-100 ring-1 ring-surface-900/5 dark:ring-white/10' : 'text-surface-500 hover:text-surface-700 dark:hover:text-surface-300 scale-95 hover:scale-100'}`}
                        >
                            <Icon size={18} aria-hidden="true" /> {label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
