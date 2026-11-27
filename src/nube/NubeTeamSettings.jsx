/**
 * Ajustes → Usuarios con la nube encendida. Reemplaza a los usuarios LOCALES de
 * Bodega: los empleados viven en el servidor (account_members) y valen en todas
 * las cajas. Dueño y administrador gestionan el equipo; cualquiera cambia su PIN.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Users, Lock, KeyRound, UserPlus, Pencil, UserX, UserCheck, Cloud, Info, Loader2, RotateCw } from 'lucide-react';
import { SectionCard } from '../components/SettingsShared';
import LoginAvatar from '../components/security/LoginAvatar';
import { getDeviceClient } from './nubeSupabase';
import * as svc from './accountService';
import { readMemberSession } from './memberSession';
import { roleLabel, canManageTeam, canEditMember, assignableRoles } from './teamRules';
import { MemberFormModal, PinChangeModal, ConfirmModal } from './NubeTeamUI';
import { notifyBusinessConfigChanged } from './businessConfigSync';

const ROLE_BADGE = {
    dueno: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/60',
    administrador: 'bg-brand-light text-brand border-brand/20',
    cajero: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/60',
};

export default function NubeTeamSettings({ autoLockMinutes, setAutoLockMinutes, showToast, triggerHaptic, client: clientProp, session: sessionProp }) {
    const client = useMemo(() => clientProp || getDeviceClient(), [clientProp]);
    const session = sessionProp || readMemberSession();
    const me = session ? { memberId: session.memberId, role: session.role, name: session.name } : null;
    const manage = canManageTeam(me?.role);

    const [members, setMembers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [modal, setModal] = useState(null); // { kind: 'create' | 'edit' | 'pin' | 'mypin' | 'toggle', member? }

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try { setMembers(await svc.listTeam(client)); } catch (e) { setError(svc.toNubeError(e).message); } finally { setLoading(false); }
    }, [client]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        window.addEventListener('pdn_members_updated', load);
        return () => window.removeEventListener('pdn_members_updated', load);
    }, [load]);

    const toast = (msg) => showToast?.(msg, 'success');
    const close = () => setModal(null);
    const saveMember = async (data, okMsg) => {
        await svc.teamUpsertMember(client, session?.token, data);
        close();
        toast(okMsg);
        await load();
    };

    const visible = manage ? members : members.filter((m) => m.id === me?.memberId);
    const active = visible.filter((m) => m.active);
    const inactive = visible.filter((m) => !m.active);

    const row = (m) => {
        const isMe = m.id === me?.memberId;
        const editable = canEditMember(me, m);
        return (
            <li key={m.id} data-testid={`nube-team-${m.display_name}`}
                className={`flex items-center gap-3 rounded-2xl border px-3 py-2.5 ${m.active ? 'border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900' : 'border-dashed border-slate-200 dark:border-slate-700 opacity-70'}`}>
                <LoginAvatar user={{ nombre: m.display_name, rol: svc.toAppRole(m.role) }} size="sm" />
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-black text-slate-800 dark:text-white truncate">
                        {m.display_name}{isMe && <span className="ml-1.5 text-[10px] font-bold text-slate-400">(tú)</span>}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-md border ${ROLE_BADGE[m.role] || ROLE_BADGE.cajero}`}>{roleLabel(m.role)}</span>
                        {!m.active && <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Desactivado</span>}
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    {isMe && (
                        <button type="button" onClick={() => { triggerHaptic?.(); setModal({ kind: 'mypin' }); }} data-testid="nube-my-pin"
                            className="px-3 py-2 min-h-[40px] rounded-xl text-xs font-bold text-brand bg-brand-light hover:opacity-90 flex items-center gap-1.5">
                            <KeyRound size={14} />Cambiar mi PIN
                        </button>
                    )}
                    {editable && m.active && (
                        <>
                            <button type="button" title="Cambiar PIN" aria-label={`Cambiar PIN de ${m.display_name}`} onClick={() => setModal({ kind: 'pin', member: m })}
                                className="p-2 min-h-[40px] rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><KeyRound size={16} /></button>
                            <button type="button" title="Editar" aria-label={`Editar a ${m.display_name}`} onClick={() => setModal({ kind: 'edit', member: m })}
                                className="p-2 min-h-[40px] rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><Pencil size={16} /></button>
                        </>
                    )}
                    {editable && (
                        <button type="button" title={m.active ? 'Desactivar' : 'Reactivar'} aria-label={`${m.active ? 'Desactivar' : 'Reactivar'} a ${m.display_name}`}
                            onClick={() => setModal({ kind: 'toggle', member: m })}
                            className={`p-2 min-h-[40px] rounded-xl ${m.active ? 'text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40' : 'text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40'}`}>
                            {m.active ? <UserX size={16} /> : <UserCheck size={16} />}
                        </button>
                    )}
                </div>
            </li>
        );
    };

    return (
        <div className="cq-grid items-start" data-testid="nube-team-settings">
            <div className="col-span-full flex items-start gap-3 p-4 rounded-2xl border border-brand/20 bg-brand-light/60">
                <Cloud size={20} className="text-brand shrink-0 mt-0.5" />
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    <strong className="text-slate-800 dark:text-white">El equipo vive en la nube.</strong>{' '}
                    Lo que cambies aquí vale al instante en todas las cajas de tu negocio.
                    {!manage && ' Solo el dueño o un administrador agregan o cambian empleados.'}
                </p>
            </div>

            <div>
                <SectionCard icon={Users} title="Usuarios y Roles" iconColor="text-brand"
                    subtitle={manage ? 'Agrega empleados, cambia su PIN o desactívalos' : 'Tu acceso en esta caja'}>
                    {error && (
                        <div role="alert" className="flex items-center justify-between gap-2 text-xs font-bold text-rose-600 bg-rose-50 dark:bg-rose-950/40 rounded-xl px-3 py-2 mb-3">
                            <span>{error}</span>
                            <button type="button" onClick={load} className="flex items-center gap-1 underline"><RotateCw size={12} />Reintentar</button>
                        </div>
                    )}
                    {loading && !members.length ? (
                        <div className="flex justify-center py-6 text-brand"><Loader2 className="animate-spin" size={24} /></div>
                    ) : (
                        <ul className="space-y-2">{active.map(row)}</ul>
                    )}
                    {manage && inactive.length > 0 && (
                        <>
                            <p className="text-[11px] uppercase tracking-wider font-extrabold text-slate-400 mt-5 mb-2">Desactivados</p>
                            <ul className="space-y-2">{inactive.map(row)}</ul>
                        </>
                    )}
                    {manage && (
                        <button type="button" onClick={() => { triggerHaptic?.(); setModal({ kind: 'create' }); }} data-testid="nube-team-add"
                            className="mt-4 w-full py-3 min-h-[48px] rounded-xl border-2 border-dashed border-brand/40 text-brand font-black text-sm hover:bg-brand-light flex items-center justify-center gap-2">
                            <UserPlus size={18} />Agregar empleado
                        </button>
                    )}
                </SectionCard>
            </div>

            <div>
                <SectionCard icon={Lock} title="Seguridad" subtitle="Cómo se entra a esta caja" iconColor="text-rose-500">
                    <div className="flex items-start gap-2 mb-4 border-b border-slate-100 dark:border-slate-800 pb-4">
                        <Info size={16} className="text-slate-400 shrink-0 mt-0.5" />
                        <div className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed space-y-1">
                            <p>Con la nube <strong>siempre se entra con PIN</strong>: la pantalla «¿Quién está operando?» no se puede apagar.</p>
                            <p>No hay Clave Maestra de Emergencia. Si alguien olvida su PIN, el dueño o un administrador se lo cambia aquí. Si el dueño olvida el suyo, lo repone en «Administrar equipos y empleados» entrando con su correo y clave.</p>
                        </div>
                    </div>
                    <label className="text-[11px] uppercase tracking-wider font-extrabold text-slate-500 dark:text-slate-400 block mb-1.5">Bloqueo Automático</label>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">La caja vuelve a «¿Quién está operando?» tras estos minutos sin uso.</p>
                    <div className="grid grid-cols-4 gap-2 max-w-sm">
                        {['1', '3', '5', '10'].map((val) => (
                            <button key={val} type="button"
                                onClick={() => { setAutoLockMinutes?.(val); localStorage.setItem('admin_auto_lock_minutes', val); notifyBusinessConfigChanged(); triggerHaptic?.(); }}
                                className={`py-2.5 min-h-[44px] text-xs font-bold rounded-xl transition-all border ${autoLockMinutes === val
                                    ? 'bg-rose-50 dark:bg-rose-900/20 border-rose-400 text-rose-700 dark:text-rose-300 shadow-sm'
                                    : 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                                {val} min
                            </button>
                        ))}
                    </div>
                </SectionCard>
            </div>

            {modal?.kind === 'create' && (
                <MemberFormModal roles={assignableRoles(me?.role)} onClose={close}
                    onSubmit={(d) => saveMember(d, `${d.name} ya puede entrar con su PIN`)} />
            )}
            {modal?.kind === 'edit' && (
                <MemberFormModal member={modal.member} roles={assignableRoles(me?.role)} onClose={close}
                    onSubmit={(d) => saveMember(d, 'Cambios guardados')} />
            )}
            {modal?.kind === 'pin' && (
                <PinChangeModal title={`PIN de ${modal.member.display_name}`} role={modal.member.role}
                    subtitle="Dale el PIN nuevo en persona. Si tenía la sesión abierta en otra caja, se cierra."
                    onClose={close}
                    onSubmit={({ pin }) => saveMember({ id: modal.member.id, name: modal.member.display_name, role: modal.member.role, pin }, `PIN de ${modal.member.display_name} cambiado`)} />
            )}
            {modal?.kind === 'mypin' && (
                <PinChangeModal title="Cambiar mi PIN" role={me?.role} needsCurrent onClose={close}
                    subtitle="Vale en todas las cajas desde ya."
                    onSubmit={async ({ currentPin, pin }) => {
                        await svc.changeOwnPin(client, session?.token, currentPin, pin);
                        close();
                        toast('Tu PIN cambió');
                    }} />
            )}
            {modal?.kind === 'toggle' && (
                <ConfirmModal danger={modal.member.active}
                    title={modal.member.active ? `¿Desactivar a ${modal.member.display_name}?` : `¿Reactivar a ${modal.member.display_name}?`}
                    message={modal.member.active
                        ? 'Ya no podrá entrar en ninguna caja y se cierra su sesión si está abierta. Sus ventas quedan en el historial. Puedes reactivarlo cuando quieras.'
                        : 'Podrá volver a entrar con su PIN de antes.'}
                    confirmLabel={modal.member.active ? 'Desactivar' : 'Reactivar'}
                    onClose={close}
                    onConfirm={() => saveMember(
                        { id: modal.member.id, name: modal.member.display_name, role: modal.member.role, active: !modal.member.active },
                        modal.member.active ? `${modal.member.display_name} desactivado` : `${modal.member.display_name} reactivado`,
                    )} />
            )}
        </div>
    );
}
