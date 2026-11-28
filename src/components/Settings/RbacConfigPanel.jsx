/**
 * RbacConfigPanel.jsx — Panel 100% configurable de Roles y Permisos (RBAC).
 *
 * Permite al Dueño (tanto en modo LAN/Nube como Local):
 *   - Elegir un rol (Encargado, Inventario, Cajero) y activar/desactivar CUALQUIER permiso.
 *   - Activar/desactivar la autorización rápida con PIN o Carnet en caja.
 *   - Restaurar la matriz recomendada de fábrica en 1 clic.
 * Todos los cambios se guardan en `pda_rbac_config_v1` y se sincronizan en todas las cajas LAN.
 */
import { useState, useEffect } from 'react';
import { ShieldCheck, RotateCcw, ScanBarcode, ChevronDown, ChevronUp } from 'lucide-react';
import { SectionCard } from '../SettingsShared';
import {
    ROLES,
    ROLE_META,
    ROLE_PERMISSIONS,
    PERMISSION_GROUPS,
} from '../../security/permissions';
import {
    readRbacConfig,
    setRolePermission,
    resetRolePermissions,
    setAllowQuickAuth,
    RBAC_UPDATED_EVENT,
} from '../../security/rbacConfig';

const EDITABLE_ROLES = [ROLES.ENCARGADO, ROLES.INVENTARIO, ROLES.CAJERO];

export default function RbacConfigPanel({ showToast, triggerHaptic }) {
    const [selectedRole, setSelectedRole] = useState(ROLES.CAJERO);
    const [expanded, setExpanded] = useState(true);
    const [cfg, setCfg] = useState(() => readRbacConfig());

    useEffect(() => {
        const sync = () => setCfg(readRbacConfig());
        window.addEventListener(RBAC_UPDATED_EVENT, sync);
        window.addEventListener('app_storage_update', sync);
        return () => {
            window.removeEventListener(RBAC_UPDATED_EVENT, sync);
            window.removeEventListener('app_storage_update', sync);
        };
    }, []);

    const isRolePermEnabled = (role, permKey) => {
        const custom = cfg.rolePermissions?.[role];
        if (Array.isArray(custom)) return custom.includes(permKey);
        return Boolean(ROLE_PERMISSIONS[role]?.has(permKey));
    };

    const handleToggle = (permKey) => {
        const current = isRolePermEnabled(selectedRole, permKey);
        setRolePermission(selectedRole, permKey, !current, ROLE_PERMISSIONS[selectedRole]);
        triggerHaptic?.();
    };

    const handleReset = () => {
        resetRolePermissions();
        triggerHaptic?.();
        showToast?.('Permisos de roles restaurados a los valores recomendados', 'success');
    };

    const handleToggleQuickAuth = () => {
        const next = !cfg.allowQuickAuth;
        setAllowQuickAuth(next);
        triggerHaptic?.();
        showToast?.(
            next
                ? 'Autorización rápida con PIN o Carnet activada'
                : 'Autorización rápida desactivada',
            'info',
        );
    };

    const hasCustomMatrix = Object.keys(cfg.rolePermissions || {}).length > 0;

    return (
        <div className="col-span-full">
            <SectionCard
                icon={ShieldCheck}
                title="Control de Permisos (RBAC) y Carnets"
                subtitle="Configura exactamente qué puede ver y hacer cada puesto. El Dueño siempre tiene acceso total."
                iconColor="text-indigo-600 dark:text-indigo-400"
            >
                {/* Interruptor global de autorización rápida con PIN o Carnet */}
                <div className="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/20 border border-emerald-200/80 dark:border-emerald-800/40 mb-4">
                    <div className="flex items-start gap-2.5 min-w-0">
                        <ScanBarcode size={18} className="text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                            <p className="text-xs font-black text-slate-800 dark:text-white">
                                Autorización rápida con PIN o Carnet en caja
                            </p>
                            <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-snug">
                                Permite que un cajero solicite aprobación (ej. anular venta) pasando el carnet de barras/QR o escribiendo el PIN de un encargado, sin cerrar su sesión.
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={handleToggleQuickAuth}
                        data-testid="rbac-quick-auth-toggle"
                        className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase tracking-wider shrink-0 transition-all ${cfg.allowQuickAuth
                            ? 'bg-emerald-600 text-white shadow-sm'
                            : 'bg-slate-200 dark:bg-slate-800 text-slate-500'
                        }`}
                    >
                        {cfg.allowQuickAuth ? 'Activo' : 'Apagado'}
                    </button>
                </div>

                {/* Cabecera colapsable de la matriz de roles */}
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div className="flex flex-wrap gap-1.5">
                        {EDITABLE_ROLES.map((roleKey) => {
                            const active = selectedRole === roleKey;
                            return (
                                <button
                                    key={roleKey}
                                    type="button"
                                    onClick={() => { setSelectedRole(roleKey); setExpanded(true); triggerHaptic?.(); }}
                                    data-testid={`rbac-role-tab-${roleKey}`}
                                    className={`px-3.5 py-2 rounded-xl text-xs font-black transition-all border ${active
                                        ? 'bg-brand text-white border-brand shadow-sm'
                                        : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'
                                    }`}
                                >
                                    {ROLE_META[roleKey].label}
                                </button>
                            );
                        })}
                    </div>

                    <div className="flex items-center gap-1.5">
                        {hasCustomMatrix && (
                            <button
                                type="button"
                                onClick={handleReset}
                                className="px-2.5 py-1.5 rounded-xl text-[11px] font-bold text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 flex items-center gap-1 transition-colors"
                            >
                                <RotateCcw size={13} /> Restaurar recomendados
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setExpanded((v) => !v)}
                            className="px-2.5 py-1.5 rounded-xl text-[11px] font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1"
                        >
                            {expanded ? <><ChevronUp size={14} /> Ocultar</> : <><ChevronDown size={14} /> Editar permisos</>}
                        </button>
                    </div>
                </div>

                {expanded && (
                    <div className="space-y-4 pt-1">
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                            Editando permisos base del puesto <strong className="text-slate-700 dark:text-slate-200">{ROLE_META[selectedRole].label}</strong>. También puedes dar excepciones individuales con el botón de ajustes en cada empleado.
                        </p>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {PERMISSION_GROUPS.map((group) => (
                                <div key={group.id} className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 p-3 space-y-2">
                                    <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 px-1">
                                        {group.title}
                                    </h4>
                                    <div className="space-y-1.5">
                                        {group.items.map((item) => {
                                            const active = isRolePermEnabled(selectedRole, item.key);
                                            return (
                                                <button
                                                    key={item.key}
                                                    type="button"
                                                    onClick={() => handleToggle(item.key)}
                                                    data-testid={`rbac-perm-${selectedRole}-${item.key}`}
                                                    className={`w-full flex items-center justify-between gap-2.5 px-3 py-2 rounded-xl border text-left transition-all ${active
                                                        ? 'bg-white dark:bg-slate-900 border-emerald-200 dark:border-emerald-800/50 shadow-2xs'
                                                        : 'bg-slate-100/60 dark:bg-slate-900/40 border-transparent opacity-75 hover:opacity-100'
                                                    }`}
                                                >
                                                    <div className="min-w-0">
                                                        <p className="text-xs font-bold text-slate-800 dark:text-white leading-tight">{item.label}</p>
                                                        <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">{item.description}</p>
                                                    </div>
                                                    <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black uppercase shrink-0 ${active
                                                        ? 'bg-emerald-600 text-white'
                                                        : 'bg-slate-200 dark:bg-slate-800 text-slate-500'
                                                    }`}>
                                                        {active ? 'Sí' : 'No'}
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </SectionCard>
        </div>
    );
}
