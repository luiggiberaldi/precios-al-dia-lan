/**
 * Puerta de Precios al Día Nube (F1). Envuelve la app heredada:
 *
 *   sin sesión del equipo  → la abre (anónima, propia del equipo)
 *   equipo sin registrar   → dueño entra con correo y clave → (crea su negocio) → «Este equipo es…»
 *   equipo registrado      → «¿Quién está operando?» → PIN → la app de siempre con ese empleado
 *   «Equipos y empleados»  → PIN del dueño en este equipo → panel del dueño
 *                            (si olvidó el PIN: correo y clave, que además lo deja reponerlo)
 *
 * La sesión del dueño es temporal: se cierra apenas termina el registro o la administración.
 * Se enciende con VITE_NUBE_ACCOUNTS=true (ver nubeSupabase.isNubeAccountsEnabled).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../hooks/store/useAuthStore';
import LoginPinModal from '../components/security/LoginPinModal';
import { getDeviceClient, createOwnerClient, resetDeviceClient } from './nubeSupabase';
import * as svc from './accountService';
import { readMemberSession, saveMemberSession, clearMemberSession, applyToAuthStore } from './memberSession';
import { useNubeSync } from './useNubeSync';
import { flushNubeBeforeLogout } from './localWriteHook';
import { checkAccountReset, takeResetNotice, wipeLocalData } from './accountReset';
import { setNubeLicense } from './nubeLicense';
import { memberPinLength } from './teamRules';
import NubeOwnerDashboard from './NubeOwnerDashboard';
import { previewImport, importBackupToCloud, importInitialStock, importInitialBalances } from './importBackup';
import {
    NubeLoading, NubeShell, NubeError, OwnerAuthScreen, CreateAccountScreen, RegisterDeviceScreen,
    MemberPickerScreen, ManagePanel, NewPasswordScreen, AuthLinkErrorScreen, EmailConfirmedScreen,
} from './NubeScreens';
import { MasterKeyAccessModal } from './NubeTeamUI';
import {
    clearLanServerUrl, getElectronLanApi, getLanServerUrl, getSavedLanRole, isLanModeEnabled, isLocalMasterUrl, setLanServerUrl,
} from '../lan/lanConfig';
import {
    clearOfflinePassport, isPassportValid, readOfflinePassport, saveOfflinePassport, verifyOfflinePin,
} from '../lan/offlinePassport';
import {
    createCloudSupervisorClient,
    getLanCloudBridgeConfig,
    readCloudSupervisorSession,
    saveCloudSupervisorSession,
} from '../lan/cloudSupervisorClient';
import { isNetworkError } from './stockService';
import { keepChannel } from './realtimeChannel';
import LanSetupScreen from '../lan/LanSetupScreen';
import LanPairingModal from '../lan/LanPairingModal';
import LanUpdateBanner from '../lan/LanUpdateBanner';
import { useBarcodeScanner } from '../hooks/useBarcodeScanner';
import { isBadgeCode } from '../security/badgeToken';
import { findMemberIdByBadge } from '../security/rbacConfig';

/**
 * Regreso de un enlace de correo (recuperar contraseña o confirmar cuenta): se lee una vez y se borra de la URL.
 * Lo leído se guarda aquí hasta que la puerta queda montada: si React descarta un primer render
 * (StrictMode, carga diferida), el segundo intento ya no encuentra el hash y el aviso se perdería.
 */
let pendingEmailLink;
function takeRecoveryFromUrl() {
    if (typeof window === 'undefined') return null;
    if (pendingEmailLink !== undefined) return pendingEmailLink;
    pendingEmailLink = svc.parseRecoveryHash(window.location.hash);
    if (pendingEmailLink) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return pendingEmailLink;
}

function NubeGateFlow({ children }) {
    const lanMode = isLanModeEnabled();
    const electronLan = getElectronLanApi();
    const [lanReady, setLanReady] = useState(() => !lanMode || Boolean(getLanServerUrl()));
    const [lanUrl, setLanUrl] = useState(() => (lanMode ? getLanServerUrl() : ''));
    const [localHasAccount, setLocalHasAccount] = useState(null);
    const isMasterDevice = lanMode && isLocalMasterUrl(lanUrl) && getSavedLanRole() !== 'client';
    const [cloudSup, setCloudSup] = useState(() => (lanMode ? readCloudSupervisorSession() : null));
    const [showLanPairing, setShowLanPairing] = useState(false);
    const [offlineMode, setOfflineMode] = useState(false);
    const offlinePinRef = useRef(null);
    // Cliente fijo durante la conexión actual (si cambia el servidor LAN, se recrea).
    const device = getDeviceClient();
    const usuarioActivo = useAuthStore((s) => s.usuarioActivo);
    const [phase, setPhase] = useState('cargando');
    const [error, setError] = useState(null);
    const [info, setInfo] = useState(null);
    const [busy, setBusy] = useState(false);
    const [deviceUserId, setDeviceUserId] = useState(null);
    const [status, setStatus] = useState(null);
    const [members, setMembers] = useState([]);
    const [picked, setPicked] = useState(null);
    const [manage, setManage] = useState(null); // { purpose: 'register' | 'manage', account, sedes, devices, members, license }
    const ownerRef = useRef(null);
    // Panel abierto con el PIN del dueño: { token, pin } de esa sesión (solo en memoria).
    const pinAdminRef = useRef(null);
    const [askOwnerPin, setAskOwnerPin] = useState(false);
    // 'login' (entrar al POS desde avatar del dueño) | 'manage' (entrar a Equipos y empleados) | null
    const [masterKeyTarget, setMasterKeyTarget] = useState(null);
    // { accessToken, refreshToken } | { error } | { confirmed } | { done } — enlaces de correo del dueño.
    const [recovery, setRecovery] = useState(takeRecoveryFromUrl);
    // Ya montada con el enlace en su estado: la próxima apertura vuelve a mirar la URL.
    useEffect(() => { pendingEmailLink = undefined; }, []);
    const [pendingConfirmation, setPendingConfirmation] = useState(null); // correo por confirmar
    const [authPrefill, setAuthPrefill] = useState({ email: '', mode: 'login', key: 0 });
    const appUrl = () => `${window.location.origin}${window.location.pathname}`;
    // F2: catálogo, clientes y ajustes sincronizados por registro mientras hay alguien dentro.
    // Reinicio de fábrica de la cuenta (accountReset.js): si el dueño lo hizo desde la última
    // vez, este equipo se vacía (copia local y colas) ANTES de dejar entrar a nadie y recarga.
    const guardReset = useCallback(async () => {
        const r = await checkAccountReset(device);
        if (!r.reset) return false;
        clearMemberSession();
        useAuthStore.setState({ usuarioActivo: null });
        window.location.reload();
        return true;
    }, [device]);
    const sync = useNubeSync({ client: device, accountId: status?.account?.id, sedeId: status?.device?.sede_id, deviceId: status?.device?.id, enabled: phase === 'listo', onAccountReset: guardReset });

    useEffect(() => {
        if (!lanMode || !electronLan?.getConfig) return;
        let cancelled = false;
        electronLan.getConfig()
            .then((cfg) => {
                if (cancelled) return;
                if (typeof window !== 'undefined') {
                    window.__PDN_LAN_LOCAL_SECRET__ = cfg?.localAdminSecret || null;
                }
                if (cfg?.serverUrl) {
                    const clean = setLanServerUrl(cfg.serverUrl, cfg.role || null);
                    setLanUrl(clean);
                    setLanReady(true);
                } else {
                    clearLanServerUrl();
                    setLanUrl('');
                    setLanReady(false);
                }
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [lanMode, electronLan]);

    const run = useCallback(async (fn) => {
        setBusy(true);
        setError(null);
        try { return await fn(); } catch (e) { setError(svc.toNubeError(e).message); return undefined; } finally { setBusy(false); }
    }, []);

    const refresh = useCallback(async () => {
        if (lanMode && !getLanServerUrl()) return;
        setError(null);
        try {
            const uid = await svc.ensureDeviceSession(device);
            setDeviceUserId(uid);
            const st = await svc.getDeviceStatus(device, uid);
            setStatus(st);
            setNubeLicense(st?.license ?? null);
            setOfflineMode(false);
            if (!st) {
                if (lanMode) {
                    clearOfflinePassport();
                    const health = await device.lan?.health?.().catch(() => null);
                    const hasAcc = Boolean(health?.hasAccount);
                    setLocalHasAccount(hasAcc);
                    if (!hasAcc && isLocalMasterUrl(getLanServerUrl()) && getSavedLanRole() !== 'client') {
                        setPhase('crear-cuenta');
                        return;
                    }
                }
                setPhase('sin-registrar');
                return;
            }
            if (lanMode) {
                device.lan?.fetchOfflinePassport?.()
                    .then((p) => { if (p) saveOfflinePassport(p); })
                    .catch(() => {});
            }
            if (await guardReset()) return;
            const saved = readMemberSession();
            if (saved) {
                if (saved.offline && offlinePinRef.current?.memberId === saved.memberId) {
                    const real = await svc.loginWithPin(device, saved.memberId, offlinePinRef.current.pin).catch(() => null);
                    if (real) {
                        offlinePinRef.current = null;
                        saveMemberSession(real);
                        if (st.device.role === 'consulta') { setPhase('consulta'); return; }
                        applyToAuthStore(useAuthStore, real);
                        setPhase('listo');
                        return;
                    }
                }
                const alive = saved.token ? await svc.checkMemberSession(device, saved.token).catch(() => null) : null;
                if (alive && st.device.role === 'consulta') { setPhase('consulta'); return; }
                if (alive) { applyToAuthStore(useAuthStore, saved); setPhase('listo'); return; }
                clearMemberSession();
            }
            setMembers(await svc.listMembers(device));
            const notice = takeResetNotice();
            if (notice) setError(notice);
            setPhase('elegir');
        } catch (e) {
            if (lanMode && (isNetworkError(e) || isNetworkError(e?.cause))) {
                const passport = readOfflinePassport();
                if (isPassportValid(passport)) {
                    setStatus({
                        device: passport.device,
                        account: passport.account,
                        license: passport.license,
                        sedes: passport.sedes,
                    });
                    setNubeLicense(passport.license ?? null);
                    setMembers(passport.members);
                    setOfflineMode(true);
                    const saved = readMemberSession();
                    if (saved && passport.members.some((m) => m.id === saved.memberId)) {
                        if (passport.device.role === 'consulta') { setPhase('consulta'); return; }
                        applyToAuthStore(useAuthStore, saved);
                        setPhase('listo');
                        return;
                    }
                    setPhase('elegir');
                    return;
                }
            }
            setError(svc.toNubeError(e).message);
            setPhase('error');
        }
    }, [device, guardReset, lanMode]);

    useEffect(() => {
        if (!lanMode || lanUrl) refresh();
    }, [refresh, lanMode, lanUrl]);

    // En modo offline LAN: intentar recuperar sesión real en cuanto la Caja Principal responda.
    useEffect(() => {
        if (!lanMode || !offlineMode || !['listo', 'elegir'].includes(phase)) return undefined;
        let active = true;
        const probeAndUpgrade = async () => {
            try {
                await runOfflineProbeUpgrade({
                    checkHealth: () => device.lan?.health?.(),
                    guardReset: async () => {
                        if (!active) return true;
                        return guardReset();
                    },
                    readSession: readMemberSession,
                    offlinePin: offlinePinRef.current,
                    loginWithPin: (memberId, pin) => svc.loginWithPin(device, memberId, pin),
                    saveSession: (real) => {
                        if (!active) return;
                        offlinePinRef.current = null;
                        saveMemberSession(real);
                    },
                    onUpgraded: () => {
                        if (!active) return;
                        setOfflineMode(false);
                        device.lan?.fetchOfflinePassport?.().then((p) => { if (p) saveOfflinePassport(p); }).catch(() => {});
                    },
                    onFallbackRefresh: () => (active ? refresh() : undefined),
                    phase,
                });
            } catch {
                /* sigue sin conexión con Caja Principal */
            }
        };
        const timer = setInterval(probeAndUpgrade, 15_000);
        window.addEventListener('online', probeAndUpgrade);
        return () => {
            active = false;
            clearInterval(timer);
            window.removeEventListener('online', probeAndUpgrade);
        };
    }, [lanMode, offlineMode, phase, device, refresh, guardReset]);

    // Si la app heredada cierra sesión, primero subimos cualquier venta/cierre en cola
    // mientras el token sigue vivo y luego cerramos la sesión de PIN en el servidor.
    const loggingOutRef = useRef(false);
    useEffect(() => {
        if (phase === 'listo' && !usuarioActivo && !loggingOutRef.current) {
            loggingOutRef.current = true;
            (async () => {
                try {
                    if (!offlineMode) {
                        await flushNubeBeforeLogout(2500);
                    }
                } finally {
                    const saved = readMemberSession();
                    offlinePinRef.current = null;
                    clearMemberSession();
                    if (saved?.token) svc.logoutMember(device, saved.token);
                    if (!offlineMode) svc.listMembers(device).then(setMembers).catch(() => {});
                    loggingOutRef.current = false;
                    setPhase('elegir');
                }
            })();
        }
    }, [phase, usuarioActivo, device, offlineMode]);

    // E10 + tiempo real: si el dueño expulsa este equipo, cambia licencia/sedes o edita
    // empleados (incluso mientras otra PC espera en el selector de PIN), actualiza al instante.
    useEffect(() => {
        if (!['elegir', 'listo', 'consulta'].includes(phase) || !deviceUserId) return undefined;
        const refreshMembers = () => {
            svc.listMembers(device).then(setMembers).catch(() => {});
            if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
                window.dispatchEvent(new CustomEvent('pdn_members_updated'));
            }
        };
        const refreshPassport = () => {
            if (lanMode && !offlineMode) {
                device.lan?.fetchOfflinePassport?.().then((p) => { if (p) saveOfflinePassport(p); }).catch(() => {});
            }
        };
        const check = async ({ reloadMembers = false } = {}) => {
            if (document.visibilityState !== 'visible') return;
            try {
                if (await guardReset()) return;
                const st = await svc.getDeviceStatus(device, deviceUserId);
                if (st) {
                    setStatus(st);
                    // La Estación pudo ampliar, suspender o vencer la licencia de la cuenta.
                    setNubeLicense(st.license ?? null);
                    if (reloadMembers || phase === 'elegir') refreshMembers();
                    // Desde otra caja desactivaron a este empleado o le cambiaron el PIN: su
                    // sesión ya no vale y todo lo que haga quedaría sin subir. Vuelve al selector.
                    const saved = phase === 'listo' ? readMemberSession() : null;
                    if (saved?.offline && offlinePinRef.current?.memberId === saved.memberId) {
                        const upgraded = await svc.loginWithPin(device, saved.memberId, offlinePinRef.current.pin).catch(() => null);
                        if (upgraded) {
                            offlinePinRef.current = null;
                            saveMemberSession(upgraded);
                            setOfflineMode(false);
                            return;
                        }
                    }
                    if (saved?.token && !(await svc.checkMemberSession(device, saved.token))) {
                        setError('Tu sesión se cerró desde otra caja (PIN nuevo o usuario desactivado). Vuelve a entrar.');
                        useAuthStore.setState({ usuarioActivo: null });
                    }
                    return;
                }
                clearOfflinePassport();
                clearMemberSession();
                useAuthStore.setState({ usuarioActivo: null });
                setStatus(null);
                setNubeLicense(null);
                setError('El dueño quitó este equipo de la cuenta. Para volver a usarlo debe registrarlo otra vez.');
                setPhase('sin-registrar');
            } catch { /* sin internet: sigue el permiso de 72 h */ }
        };
        const timer = setInterval(check, 5 * 60_000);
        const passportTimer = lanMode ? setInterval(refreshPassport, 30 * 60_000) : null;
        document.addEventListener('visibilitychange', check);
        const accountId = status?.account?.id;
        const currentDeviceId = status?.device?.id;
        const channelCtrl = (accountId && typeof device?.channel === 'function')
            ? keepChannel(
                device,
                `gate-guard-${accountId}`,
                (ch) => ch
                    .on(
                        'postgres_changes',
                        { event: '*', schema: 'public', table: 'account_devices', filter: `account_id=eq.${accountId}` },
                        (payload) => {
                            if (payload?.new?.id === currentDeviceId && payload?.new?.revoked_at) {
                                check();
                            }
                        },
                    )
                    .on(
                        'postgres_changes',
                        { event: '*', schema: 'public', table: 'account_members', filter: `account_id=eq.${accountId}` },
                        () => {
                            refreshPassport();
                            check({ reloadMembers: true });
                        },
                    )
                    .on(
                        'postgres_changes',
                        { event: '*', schema: 'public', table: 'account_licenses', filter: `account_id=eq.${accountId}` },
                        () => {
                            refreshPassport();
                            check();
                        },
                    )
                    .on(
                        'postgres_changes',
                        { event: '*', schema: 'public', table: 'sedes', filter: `account_id=eq.${accountId}` },
                        () => {
                            refreshPassport();
                            check();
                        },
                    ),
            )
            : null;
        return () => {
            clearInterval(timer);
            if (passportTimer) clearInterval(passportTimer);
            document.removeEventListener('visibilitychange', check);
            channelCtrl?.dispose?.();
        };
    }, [phase, deviceUserId, device, guardReset, lanMode, offlineMode, status?.account?.id, status?.device?.id]);

    const closeOwner = async () => {
        if (ownerRef.current) await svc.ownerSignOut(ownerRef.current);
        ownerRef.current = null;
        if (pinAdminRef.current) await svc.logoutMember(device, pinAdminRef.current.token);
        pinAdminRef.current = null;
        setManage(null);
    };

    // Cliente y sesión con que actúa el panel: la del PIN del dueño o la del correo.
    const adminClient = () => ownerRef.current || device;
    const adminSession = () => pinAdminRef.current?.token ?? null;

    // ─── Dueño ───────────────────────────────────────────────────────────────
    const handleOwnerAuth = ({ mode, email, password }) => run(async () => {
        setInfo(null);
        const owner = createOwnerClient();
        if (mode === 'signup') {
            const { needsConfirmation } = await svc.ownerSignUp(owner, email, password, { redirectTo: appUrl() });
            if (needsConfirmation) { setPendingConfirmation(email); return; }
        } else {
            try {
                await svc.ownerSignIn(owner, email, password);
            } catch (e) {
                if (svc.isEmailNotConfirmed(e)) { setPendingConfirmation(email); return; }
                throw e;
            }
        }
        ownerRef.current = owner;
        const account = await svc.getOwnerAccount(owner);
        if (phase === 'sin-registrar') {
            if (!account) { setPhase('crear-cuenta'); return; }
            await loadRegister(owner, account);
        } else {
            if (!account) throw new svc.NubeError('Ese usuario no es el dueño de este negocio.');
            await loadManage(owner);
        }
    });

    // «Este equipo es…»: además de las sedes, los equipos ya conectados y la licencia, para que el
    // dueño pueda desvincular uno (p. ej. si la licencia está llena) antes de registrar este.
    const loadRegister = async (owner, account) => {
        const [{ data: sedes }, devices, lic] = await Promise.all([
            owner.from('sedes').select('id, name').is('archived_at', null).order('created_at'),
            svc.listOwnerDevices(owner).catch(() => []),
            owner.from('account_licenses').select('status, max_cajas, max_sedes, expires_at').limit(1),
        ]);
        setManage({ purpose: 'register', account, sedes: sedes ?? [], devices, license: lic?.data?.[0] ?? null });
        setPhase('registrar');
    };

    // Desvincular desde «Este equipo es…»: el error se muestra en la confirmación (por eso lanza).
    const handleRegisterRevoke = async (deviceId) => {
        try {
            await svc.revokeDevice(ownerRef.current, deviceId);
        } catch (e) {
            throw svc.toNubeError(e, 'No se pudo desvincular el equipo.');
        }
        await loadRegister(ownerRef.current, manage.account);
    };

    const loadManage = async (client) => {
        const [devices, ownerMembers, lic, summary, masterKeyStatus] = await Promise.all([
            svc.listOwnerDevices(client),
            svc.listTeam(client),
            client.from('account_licenses').select('status, max_cajas, max_sedes, expires_at').limit(1),
            client.rpc('cash_day_summary', {}),
            lanMode ? client.lan?.getMasterKeyStatus?.().catch(() => null) : Promise.resolve(null),
        ]);
        setManage({
            purpose: 'manage',
            devices,
            members: ownerMembers,
            license: lic.data?.[0] ?? null,
            summary: summary?.data ?? [],
            masterKeyStatus: masterKeyStatus || null,
        });
        setPhase('administrar');
    };

    const handleCreateAccount = (form) => run(async () => {
        if (!ownerRef.current && isMasterDevice) {
            const owner = createOwnerClient();
            await owner.lan.bootstrapLocalOwner();
            ownerRef.current = owner;
        }
        await svc.createAccount(ownerRef.current, form);
        if (lanMode && form?.masterKey) {
            await ownerRef.current.lan?.setMasterKey?.({ newMasterKey: form.masterKey }).catch(() => {});
        }
        setLocalHasAccount(true);
        await loadRegister(ownerRef.current, await svc.getOwnerAccount(ownerRef.current));
    });

    const handleLanOwnerPin = (pin) => run(async () => {
        setInfo(null);
        const owner = createOwnerClient();
        await owner.lan.ownerPinSignIn(pin);
        ownerRef.current = owner;
        const account = await svc.getOwnerAccount(owner);
        if (phase === 'sin-registrar') {
            if (!account) { setPhase('crear-cuenta'); return; }
            await loadRegister(owner, account);
        } else {
            if (!account) throw new svc.NubeError('Primero crea el negocio en esta Caja Principal.');
            await loadManage(owner);
        }
    });

    const handleLanResetPin = (newPin, masterKey) => run(async () => {
        setInfo(null);
        const owner = createOwnerClient();
        if (isMasterDevice && newPin) {
            await owner.lan.resetLocalOwnerPin(newPin, masterKey);
        } else {
            await owner.lan.loginWithMasterKey({ masterKey, newPin: newPin || null, persistOwnerToken: true });
        }
        ownerRef.current = owner;
        const account = await svc.getOwnerAccount(owner);
        if (phase === 'sin-registrar') {
            if (!account) { setPhase('crear-cuenta'); return; }
            await loadRegister(owner, account);
        } else {
            if (!account) throw new svc.NubeError('Primero crea el negocio en esta Caja Principal.');
            await loadManage(owner);
        }
    });

    const handleMasterKeyModalSubmit = async ({ masterKey, newPin = null }) => {
        if (await guardReset()) throw new svc.NubeError('El dueño reinició la cuenta. Recargando…');
        const out = await device.lan.loginWithMasterKey({ masterKey, newPin });
        if (lanMode && !offlineMode) {
            device.lan?.fetchOfflinePassport?.().then((p) => { if (p) saveOfflinePassport(p); }).catch(() => {});
        }
        if (masterKeyTarget === 'manage') {
            const owner = createOwnerClient();
            await owner.lan.loginWithMasterKey({ masterKey, newPin: null, persistOwnerToken: true });
            ownerRef.current = owner;
            setMasterKeyTarget(null);
            await loadManage(owner);
            return;
        }
        if (!out?.memberSession?.token) {
            throw new svc.NubeError('No se pudo abrir la sesión del dueño en este equipo.');
        }
        offlinePinRef.current = null;
        setOfflineMode(false);
        saveMemberSession(out.memberSession);
        setMasterKeyTarget(null);
        setPicked(null);
        if (status?.device?.role === 'consulta') {
            setPhase('consulta');
            return;
        }
        applyToAuthStore(useAuthStore, out.memberSession);
        setPhase('listo');
    };

    const handleRegister = ({ label, role, sedeId }) => run(async () => {
        const uid = deviceUserId || await svc.ensureDeviceSession(device);
        if (!deviceUserId) setDeviceUserId(uid);
        await svc.registerDevice(ownerRef.current, { deviceUserId: uid, label, role, sedeId });
        await closeOwner();
        await refresh();
    });

    const handleRebind = (targetDeviceId) => run(async () => {
        const uid = deviceUserId || await svc.ensureDeviceSession(device);
        if (!deviceUserId) setDeviceUserId(uid);
        await ownerRef.current.lan.rebindDevice({ deviceId: targetDeviceId, deviceUserId: uid });
        await closeOwner();
        await refresh();
    });

    const handleSignOutAccount = async () => {
        offlinePinRef.current = null;
        clearOfflinePassport();
        clearMemberSession();
        useAuthStore.setState({ usuarioActivo: null });
        await wipeLocalData({}, { keepSettings: false }).catch(() => {});
        await svc.deviceSignOut(device);
        setDeviceUserId(null);
        setStatus(null);
        setNubeLicense(null);
        setMembers([]);
        setPicked(null);
        setManage(null);
        setError(null);
        setInfo(null);
        setAuthPrefill((p) => ({ email: '', mode: 'login', key: p.key + 1 }));
        setPhase('sin-registrar');
    };

    const reloadManage = async () => loadManage(adminClient());

    // «Equipos y empleados» desde el selector: basta el PIN del dueño en este equipo.
    const ownerMember = members.find((m) => m.role === 'dueno') || null;
    const openManage = () => {
        setError(null);
        if (ownerMember) setAskOwnerPin(true);
        else setPhase('dueno-administrar'); // sin dueño en la lista: queda el correo
    };
    const handleOwnerPin = async (pin) => {
        try {
            const session = await svc.loginWithPin(device, ownerMember.id, pin);
            pinAdminRef.current = { token: session.token, pin };
            if (session.role !== 'dueno') {
                await closeOwner();
                return { success: false, error: 'Solo el dueño administra equipos y empleados.' };
            }
            await loadManage(device);
            setAskOwnerPin(false);
            return { success: true };
        } catch (e) {
            if (pinAdminRef.current) await closeOwner();
            const msg = svc.toNubeError(e).message;
            if (/Demasiados intentos/.test(msg)) return { success: false, error: `Bloqueado. ${msg}` };
            if (/no está registrado|expulsado/.test(msg)) { setAskOwnerPin(false); refresh(); }
            return { success: false, error: msg };
        }
    };

    // ─── Contraseña del dueño olvidada / correo por confirmar ────────────────
    const handleClaimPairingCode = (code) => run(async () => {
        setInfo(null);
        const owner = createOwnerClient();
        await owner.lan.claimPairingCode(code);
        ownerRef.current = owner;
        const account = await svc.getOwnerAccount(owner);
        if (!account) { setPhase('crear-cuenta'); return; }
        await loadRegister(owner, account);
    });

    const changeLanServer = async () => {
        clearLanServerUrl();
        resetDeviceClient();
        if (electronLan?.resetRole) await electronLan.resetRole().catch(() => {});
        setLanUrl('');
        setLanReady(false);
        setError(null);
        setPhase('cargando');
    };

    const handleForgot = async (email) => Boolean(await run(async () => {
        setInfo(null);
        await svc.requestPasswordReset(createOwnerClient(), email, appUrl());
        return true;
    }));

    const handleResend = (email) => run(async () => {
        setInfo(null);
        await svc.resendConfirmation(createOwnerClient(), email, appUrl());
        setInfo('Listo, te reenviamos el correo.');
    });

    const handleNewPassword = (password) => run(async () => {
        const email = await svc.completePasswordReset(createOwnerClient(), recovery, password);
        if (email) setAuthPrefill((p) => ({ email, mode: 'login', key: p.key + 1 }));
        setRecovery({ done: true });
    });

    // Al terminar con un enlace, el dueño sigue en su pantalla de correo y contraseña.
    const goToOwnerAuth = (mode = 'login') => {
        setRecovery(null); setError(null); setInfo(null);
        setAuthPrefill((p) => ({ ...p, mode, key: p.key + 1 }));
        if (phase !== 'sin-registrar') setPhase('dueno-administrar');
    };

    // ─── Empleado ────────────────────────────────────────────────────────────
    const handlePin = async (pin, member = picked) => {
        const isConsulta = status?.device?.role === 'consulta';
        if (isConsulta && !['dueno', 'administrador'].includes(member.role)) {
            return { success: false, error: 'Este equipo es de consulta: solo entran el dueño o un administrador.' };
        }
        try {
            // Nadie entra con datos de antes de un reinicio de la cuenta (subirían como altas).
            if (await guardReset()) return { success: false, error: 'El dueño reinició la cuenta. Recargando…' };
            const session = await svc.loginWithPin(device, member.id, pin);
            offlinePinRef.current = null;
            setOfflineMode(false);
            saveMemberSession(session);
            setPicked(null);
            if (isConsulta) { setPhase('consulta'); return { success: true }; }
            applyToAuthStore(useAuthStore, session);
            setPhase('listo');
            return { success: true };
        } catch (e) {
            if (lanMode && (isNetworkError(e) || isNetworkError(e?.cause))) {
                const passport = readOfflinePassport();
                const check = verifyOfflinePin(passport, member.id, pin);
                if (!check.valid) return { success: false, error: check.error };
                const offlineSession = {
                    token: null,
                    offline: true,
                    memberId: check.member.id,
                    name: check.member.display_name,
                    role: check.member.role,
                    expiresAt: passport.expiresAt,
                };
                offlinePinRef.current = { memberId: check.member.id, pin };
                saveMemberSession(offlineSession);
                setPicked(null);
                setOfflineMode(true);
                if (isConsulta) { setPhase('consulta'); return { success: true }; }
                applyToAuthStore(useAuthStore, offlineSession);
                setPhase('listo');
                return { success: true };
            }
            const msg = svc.toNubeError(e).message;
            if (/Demasiados intentos/.test(msg)) return { success: false, error: `Bloqueado. ${msg}` };
            if (/no está registrado|expulsado/.test(msg)) { setPicked(null); refresh(); }
            return { success: false, error: msg };
        }
    };

    // Escaneo de Carnet (código de barras / QR) en la pantalla «¿Quién está operando?»
    useBarcodeScanner({
        enabled: phase === 'elegir' && !picked && !askOwnerPin,
        onScan: async (code) => {
            if (!isBadgeCode(code)) return;
            const matchedId = await findMemberIdByBadge(code);
            if (!matchedId) {
                setError('Carnet no reconocido o revocado.');
                return;
            }
            const target = (members || []).find((m) => String(m.id) === String(matchedId));
            if (!target) {
                setError('Este carnet no pertenece a un empleado activo en esta caja.');
                return;
            }
            setError(null);
            if (memberPinLength(target) === null) {
                await handlePin('', target);
            } else {
                setPicked(target);
            }
        },
    });

    if (recovery?.accessToken || recovery?.done) {
        return <NewPasswordScreen onSubmit={handleNewPassword} busy={busy} error={error} done={Boolean(recovery.done)}
            onCancel={() => (recovery.done ? goToOwnerAuth('login') : (setRecovery(null), setError(null)))} />;
    }
    if (recovery?.error && phase !== 'cargando') {
        return <AuthLinkErrorScreen message={recovery.error} onRequestNew={() => goToOwnerAuth('forgot')} onLogin={() => goToOwnerAuth('login')} />;
    }
    if (recovery?.confirmed && phase !== 'cargando') {
        return <EmailConfirmedScreen onLogin={() => { setPendingConfirmation(null); goToOwnerAuth('login'); }} />;
    }
    if (phase === 'listo') {
        return (
            <>
                {children}
                {offlineMode && (
                    <div
                        role="status"
                        data-testid="lan-offline-banner"
                        className="fixed top-2 left-1/2 -translate-x-1/2 z-[260] rounded-full bg-amber-600/95 text-white text-[11px] font-black px-3 py-1 shadow-lg"
                    >
                        Sin conexión con Caja Principal · guardando en este equipo
                    </div>
                )}
                <NubeSyncBadge sync={sync} />
            </>
        );
    }
    if (phase === 'consulta') {
        return (
            <NubeOwnerDashboard
                client={device}
                accountName={status?.account?.name}
                memberName={readMemberSession()?.name}
                memberRole={readMemberSession()?.role}
                sessionToken={readMemberSession()?.token ?? null}
                sedeId={status?.device?.sede_id ?? null}
                onLogout={async () => {
                    const saved = readMemberSession();
                    offlinePinRef.current = null;
                    clearMemberSession();
                    if (saved?.token) await svc.logoutMember(device, saved.token);
                    setMembers(await svc.listMembers(device).catch(() => []));
                    setPhase('elegir');
                }}
            />
        );
    }
    if (lanMode && cloudSup && !lanReady) {
        const envCfg = getLanCloudBridgeConfig();
        const remote = createCloudSupervisorClient({
            url: cloudSup.url || envCfg.url,
            key: cloudSup.key || envCfg.key,
            sessionToken: cloudSup.token,
        });
        return (
            <NubeOwnerDashboard
                client={remote.client}
                loaders={remote.loaders}
                accountName={cloudSup.accountName || 'Mi Negocio'}
                memberName="Dueño (Internet)"
                memberRole="dueno"
                sessionToken={cloudSup.token}
                onLogout={async () => {
                    await remote.logout();
                    saveCloudSupervisorSession(null);
                    setCloudSup(null);
                }}
            />
        );
    }
    if (lanMode && !lanReady) {
        return (
            <LanSetupScreen
                onConfigured={(cleanUrl) => {
                    resetDeviceClient();
                    setLanUrl(cleanUrl);
                    setLanReady(true);
                    setPhase('cargando');
                }}
                onCloudSupervisorLogin={(session) => {
                    saveCloudSupervisorSession(session);
                    setCloudSup(session);
                }}
            />
        );
    }
    if (phase === 'cargando') return <NubeLoading />;

    if (phase === 'error') {
        return (
            <NubeShell
                title="No pudimos conectar"
                subtitle={lanMode
                    ? 'Verifica que la Caja Principal esté encendida y conectada a la misma red del local.'
                    : 'Precios al Día Nube necesita internet para empezar en este equipo.'}
            >
                <NubeError message={error} />
                <div className="space-y-2">
                    <button type="button" onClick={() => { setPhase('cargando'); refresh(); }}
                        className="w-full rounded-xl bg-brand text-white font-black py-3">Reintentar</button>
                    {lanMode && (
                        <button type="button" onClick={changeLanServer} data-testid="lan-change-server"
                            className="w-full rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-200 font-bold py-2.5 text-sm">
                            Cambiar dirección de la Caja Principal
                        </button>
                    )}
                </div>
            </NubeShell>
        );
    }

    if (phase === 'sin-registrar' || phase === 'dueno-administrar') {
        return (
            <OwnerAuthScreen key={authPrefill.key}
                initialEmail={authPrefill.email} initialMode={authPrefill.mode}
                onSubmit={handleOwnerAuth} onForgot={handleForgot} onResend={handleResend}
                onClaimCode={lanMode && phase === 'sin-registrar' && !isMasterDevice ? handleClaimPairingCode : undefined}
                isLocalMaster={isMasterDevice}
                onOwnerPinSubmit={handleLanOwnerPin}
                onLocalPinReset={(isMasterDevice || (lanMode && phase === 'dueno-administrar')) ? handleLanResetPin : undefined}
                onChangeLanServer={lanMode && phase === 'sin-registrar' ? changeLanServer : undefined}
                busy={busy} error={error}
                info={info}
                pendingConfirmation={pendingConfirmation}
                onConfirmedBack={() => { setPendingConfirmation(null); setError(null); setInfo(null); }}
                onClearMessages={() => { setError(null); setInfo(null); setRecovery(null); }}
                allowSignup={phase === 'sin-registrar'}
                title={phase === 'sin-registrar' ? 'Registra este equipo con la cuenta del dueño' : 'Confirma que eres el dueño'}
                subtitle={phase === 'sin-registrar' ? undefined : 'Entra con tu correo y contraseña para administrar y reponer tu PIN de dueño.'}
                onBack={phase === 'dueno-administrar' ? () => { setError(null); setInfo(null); setPendingConfirmation(null); setPhase('elegir'); } : undefined}
            />
        );
    }
    if (phase === 'crear-cuenta') {
        return <CreateAccountScreen onSubmit={handleCreateAccount} busy={busy} error={error}
            onBack={async () => {
                await closeOwner();
                if (isMasterDevice && localHasAccount === false) {
                    await changeLanServer();
                } else {
                    setPhase('sin-registrar');
                }
            }} />;
    }
    if (phase === 'registrar' && manage) {
        return <RegisterDeviceScreen account={manage.account} sedes={manage.sedes} devices={manage.devices} license={manage.license}
            onRevoke={handleRegisterRevoke} onRebind={lanMode ? handleRebind : undefined} onSubmit={handleRegister} busy={busy} error={error}
            onBack={async () => { await closeOwner(); setPhase('sin-registrar'); }} />;
    }
    if (phase === 'administrar' && manage) {
        return (
            <>
                <ManagePanel
                    license={manage.license} devices={manage.devices} members={manage.members} summary={manage.summary}
                    currentDeviceId={status?.device?.id} busy={busy} error={error}
                    masterKeyStatus={manage.masterKeyStatus}
                    onSaveMasterKey={lanMode ? async ({ currentMasterKey, newMasterKey }) => {
                        await adminClient().lan.setMasterKey({
                            newMasterKey,
                            currentMasterKey,
                            memberSessionToken: adminSession(),
                        });
                        await reloadManage();
                    } : null}
                    onOpenLanPairing={lanMode ? () => setShowLanPairing(true) : undefined}
                    onRename={async (id, label) => {
                        if (adminSession()) await svc.teamRenameDevice(device, adminSession(), id, { label });
                        else await svc.renameDevice(ownerRef.current, id, { label });
                        await reloadManage();
                    }}
                    onRevoke={async (id) => {
                        if (adminSession()) await svc.teamRevokeDevice(device, adminSession(), id);
                        else await svc.revokeDevice(ownerRef.current, id);
                        await reloadManage();
                    }}
                    onSaveMember={async (m) => {
                        if (adminSession()) await svc.teamUpsertMember(device, adminSession(), m);
                        else await svc.upsertMember(ownerRef.current, m);
                        await reloadManage();
                    }}
                    onSetOwnerPin={async (pin) => {
                        if (!pinAdminRef.current) return svc.ownerSetOwnPin(ownerRef.current, pin);
                        // Entró con PIN: el que acaba de escribir es el actual.
                        await svc.changeOwnPin(device, pinAdminRef.current.token, pinAdminRef.current.pin, pin);
                        pinAdminRef.current = { ...pinAdminRef.current, pin };
                        return undefined;
                    }}
                    importInfo={info}
                    onImport={(file) => run(async () => {
                        setInfo(null);
                        const json = JSON.parse(await file.text());
                        const preview = previewImport(json).filter((p) => p.count > 0);
                        const resumen = preview.map((p) => `${p.count} ${IMPORT_LABELS[p.collection] || p.collection}`).join(', ');
                        if (!preview.length) throw new svc.NubeError('El respaldo no tiene productos ni clientes para importar.');
                        if (!window.confirm(`Se van a subir: ${resumen}. Los que ya existan se actualizan. ¿Continuar?`)) return;
                        const session = adminSession();
                        const result = await importBackupToCloud(adminClient(), json, {
                            session,
                            // Con el correo (sin caja) el servidor no acepta registros de caja: las
                            // ventas viejas las sube la caja que restaure el respaldo.
                            exclude: session ? [] : ['bodega_sales_v1'],
                            onProgress: ({ collection, done, total }) => setInfo(`Subiendo ${IMPORT_LABELS[collection] || collection}: ${done} de ${total}…`),
                        });
                        setInfo('Cargando el stock inicial…');
                        const accountId = session ? status?.account?.id : (await svc.getOwnerAccount(ownerRef.current))?.id;
                        const stock = await importInitialStock(adminClient(), json, { accountId, session });
                        setInfo('Cargando deudas y saldos a favor…');
                        const saldos = await importInitialBalances(adminClient(), json, { accountId, session });
                        setInfo(`Listo: ${Object.entries(result).map(([c, n]) => `${n} ${IMPORT_LABELS[c] || c}`).join(', ')}, stock inicial de ${stock} producto(s) y saldo de ${saldos} cliente(s). Las cajas los verán en segundos.`);
                    })}
                    onClose={async () => { setShowLanPairing(false); await closeOwner(); await refresh(); }}
                />
                {showLanPairing && (
                    <LanPairingModal
                        client={ownerRef.current || device}
                        accountId={status?.account?.id}
                        onClose={() => setShowLanPairing(false)}
                    />
                )}
            </>
        );
    }
    if (phase === 'registrar' || phase === 'administrar') {
        return <NubeLoading />;
    }

    return (
        <>
            <MemberPickerScreen status={status} error={error}
                members={status?.device?.role === 'consulta' ? members.filter((m) => ['dueno', 'administrador'].includes(m.role)) : members}
                onPick={async (m) => {
                    // Cajero sin PIN: entra con solo tocar su nombre.
                    if (memberPinLength(m) === null) {
                        const r = await handlePin(null, m);
                        if (!r.success) setError(r.error || 'No se pudo entrar.');
                        return;
                    }
                    setPicked(m);
                }}
                onManage={openManage}
                onSignOutAccount={lanMode ? undefined : handleSignOutAccount} />
            <LoginPinModal isOpen={askOwnerPin && Boolean(ownerMember)} onClose={() => setAskOwnerPin(false)}
                user={ownerMember ? { id: ownerMember.id, nombre: ownerMember.display_name, rol: svc.toAppRole('dueno') } : null}
                subtitle="PIN del dueño para administrar equipos y empleados"
                onSubmit={handleOwnerPin}
                footer={(
                    <button type="button" data-testid="nube-manage-email"
                        onClick={() => {
                            setAskOwnerPin(false);
                            setError(null);
                            if (lanMode) {
                                setMasterKeyTarget('manage');
                            } else {
                                setPhase('dueno-administrar');
                            }
                        }}
                        className="text-xs font-bold text-slate-400 hover:text-white underline underline-offset-2">
                        {lanMode ? '¿Olvidaste tu PIN? Entrar con Clave Maestra' : '¿Olvidaste tu PIN? Entra con tu correo'}
                    </button>
                )} />
            <LoginPinModal isOpen={Boolean(picked)} onClose={() => setPicked(null)}
                user={picked ? { id: picked.id, nombre: picked.display_name, rol: svc.toAppRole(picked.role) } : null}
                pinLength={memberPinLength(picked) ?? undefined}
                onSubmit={(pin) => handlePin(pin)}
                footer={picked?.role === 'dueno' ? (
                    <button
                        type="button"
                        data-testid={lanMode ? 'lan-picked-master-key' : 'nube-picked-forgot-pin'}
                        onClick={() => {
                            setPicked(null);
                            setError(null);
                            if (lanMode) {
                                setMasterKeyTarget('login');
                            } else {
                                setPhase('dueno-administrar');
                            }
                        }}
                        className="text-xs font-bold text-slate-400 hover:text-white underline underline-offset-2"
                    >
                        {lanMode ? '¿Olvidaste tu PIN? Iniciar con Clave Maestra' : '¿Olvidaste tu PIN? Reponer con tu correo'}
                    </button>
                ) : null} />
            {lanMode && masterKeyTarget && (
                <MasterKeyAccessModal
                    ownerName={ownerMember?.display_name || 'Dueño'}
                    purpose={masterKeyTarget}
                    onClose={() => setMasterKeyTarget(null)}
                    onSubmit={handleMasterKeyModalSubmit}
                />
            )}
        </>
    );
}

/**
 * Reconexión segura desde modo pasaporte offline (C15):
 * SIEMPRE verifica `guardReset()` (`reset_epoch`) ANTES de llamar `loginWithPin`
 * para que una caja desconectada no resucite datos previos a un `reset_account`.
 */
export async function runOfflineProbeUpgrade({
    checkHealth,
    guardReset,
    readSession,
    offlinePin,
    loginWithPin,
    saveSession,
    onUpgraded,
    onFallbackRefresh,
    phase,
}) {
    await checkHealth?.();
    if (await guardReset?.()) return 'reset';
    const saved = readSession?.();
    if (saved?.offline && offlinePin?.memberId === saved.memberId) {
        const real = await loginWithPin(saved.memberId, offlinePin.pin);
        saveSession?.(real);
        onUpgraded?.(real);
        return 'upgraded';
    }
    if (phase === 'elegir') {
        await onFallbackRefresh?.();
        return 'refreshed';
    }
    return 'noop';
}

export default function NubeGate(props) {
    return (
        <>
            <NubeGateFlow {...props} />
            <LanUpdateBanner />
        </>
    );
}

/** Aviso discreto: cambios por subir o error de sincronización (F2; F6 lo amplía). */
function NubeSyncBadge({ sync }) {
    const pending = (sync?.pending || 0) + (sync?.salesPending || 0) + (sync?.stockPending || 0) + (sync?.ledgerPending || 0);
    const lastError = sync?.lastError || sync?.stockError || sync?.ledgerError;
    // Ventas que el servidor rechazó para siempre: no bloquean la cola, pero el dueño debe verlas.
    if (sync?.salesRejected) {
        return (
            <button type="button" data-testid="nube-sales-rejected"
                title={`${sync.salesRejectedError || 'El servidor rechazó la venta'} · Toca para reintentar`}
                onClick={() => sync.retryRejectedSales?.()}
                className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[250] rounded-full bg-red-700/95 text-white text-xs font-bold px-3 py-1.5 shadow-lg">
                {sync.salesRejected} venta(s) con problema · reintentar
            </button>
        );
    }
    if (!pending && !lastError) return null;
    const text = sync.salesPending
        ? `Sin internet · ${sync.salesPending} venta(s) por subir`
        : lastError
            ? `Sin sincronizar${pending ? ` · ${pending} por subir` : ''}`
            : `${pending} cambio(s) por subir`;
    return (
        <div role="status" title={lastError || ''} data-testid="nube-sync-badge"
            className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[250] rounded-full bg-slate-900/90 text-white text-xs font-bold px-3 py-1.5 shadow-lg">
            {text}
        </div>
    );
}

const IMPORT_LABELS = {
    products: 'productos', customers: 'clientes', suppliers: 'proveedores',
    payment_methods: 'métodos de pago', settings: 'ajustes (categorías)',
};
