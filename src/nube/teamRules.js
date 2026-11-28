/**
 * Reglas del equipo de Precios al Día Nube que la pantalla revisa ANTES de llamar
 * al servidor (el servidor las vuelve a revisar: supabase/nube/migrations/009).
 * Funciones puras, sin React, para poder probarlas.
 */

export const ROLE_LABELS = Object.freeze({
    dueno: 'Dueño',
    administrador: 'Encargado',
    inventario: 'Inventario',
    cajero: 'Cajero',
});

export const ROLE_DESCRIPTIONS = Object.freeze({
    dueno: 'Control total: finanzas, nómina, encargados y ajustes críticos.',
    administrador: 'Operación diaria: ventas, anulaciones, caja, inventario y cajeros.',
    inventario: 'Catálogo, precios, stock, compras y proveedores. Sin acceso a caja.',
    cajero: 'Vender, ver su turno, consultar productos y clientes.',
});

export function roleLabel(role) {
    return ROLE_LABELS[role] || 'Empleado';
}

export function roleDescription(role) {
    return ROLE_DESCRIPTIONS[role] || '';
}

/** ¿Este rol puede gestionar el equipo? (dueño o administrador/encargado). */
export function canManageTeam(role) {
    return role === 'dueno' || role === 'administrador';
}

/** Roles que `myRole` puede asignar al crear o editar. */
export function assignableRoles(myRole) {
    if (myRole === 'dueno') return ['cajero', 'inventario', 'administrador'];
    if (myRole === 'administrador') return ['cajero', 'inventario'];
    return [];
}

/** ¿`me` puede editar a `target`? Nadie edita al dueño; a sí mismo solo vía «Cambiar mi PIN». */
export function canEditMember(me, target) {
    if (!me || !target || target.role === 'dueno' || target.id === me.memberId) return false;
    return assignableRoles(me.role).includes(target.role);
}

/**
 * Valida un PIN nuevo. Devuelve el mensaje de error en español o null si está bien.
 * Mismas reglas que nube_validate_pin (migración 012): cajero 4 dígitos exactos;
 * dueño y administrador 6 a 32 dígitos, sin 000000.
 */
export function validatePin(pin, confirm, role = 'cajero') {
    const value = String(pin ?? '');
    if (!value) return 'Escribe el PIN.';
    if (!/^[0-9]+$/.test(value)) return 'El PIN solo lleva números.';
    if (role === 'cajero') {
        if (value.length !== 4) return 'El PIN del cajero debe tener 4 números.';
        if (confirm !== undefined && value !== String(confirm ?? '')) return 'Los PIN no coinciden. Escríbelos otra vez.';
        return null;
    }
    if (value.length < 6) return 'El PIN debe tener al menos 6 números.';
    if (value.length > 32) return 'El PIN no puede pasar de 32 números.';
    if ((role === 'dueno' || role === 'administrador' || role === 'inventario') && value === '000000') {
        return 'Elige un PIN distinto de 000000 (es el de fábrica).';
    }
    if (confirm !== undefined && value !== String(confirm ?? '')) return 'Los PIN no coinciden. Escríbelos otra vez.';
    return null;
}

/** Cuántos dígitos pide el campo de PIN para este rol. */
export function pinHint(role) {
    return role === 'cajero' ? '4 números' : '6 números o más';
}

/** Dígitos del PIN de un empleado para el teclado de entrada (null = entra sin PIN). */
export function memberPinLength(member) {
    if (!member) return 6;
    if (!('pin_length' in member)) return 6; // servidor sin migración 012
    return member.pin_length ?? null;
}

export function validateMemberName(name) {
    const value = String(name ?? '').trim();
    if (!value) return 'Escribe el nombre.';
    if (value.length > 40) return 'El nombre no puede pasar de 40 caracteres.';
    return null;
}

/** Solo números, como máximo 32 (para los campos de PIN). */
export function onlyPinDigits(value) {
    return String(value ?? '').replace(/\D/g, '').slice(0, 32);
}

/**
 * Dónde está este equipo, sin repetir: «Caja A» y el nombre del equipo solo si dice
 * algo más (si se llama «Caja A» no se repite). `{ business, sede, device }`.
 */
export function describeDeviceLocation(status) {
    const device = status?.device;
    const sede = (status?.sedes || []).find((s) => s.id === device?.sede_id)?.name || null;
    const box = device?.caja_letter ? `Caja ${device.caja_letter}` : device ? 'Consulta' : null;
    const label = String(device?.label || '').trim();
    const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const sameAsBox = !label || (box && (norm(label) === norm(box) || norm(label) === norm(device?.caja_letter || '')));
    return {
        business: status?.account?.name || null,
        sede,
        device: box ? (sameAsBox ? box : `${box} · ${label}`) : label || null,
    };
}

/** Correo con forma válida (lo demás lo valida Supabase). */
export function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

/** Fuerza de la clave del dueño: 0 (vacía) a 4. Solo orientativa. */
export function passwordStrength(password) {
    const p = String(password || '');
    if (!p) return 0;
    let score = 0;
    if (p.length >= 8) score += 1;
    if (p.length >= 12) score += 1;
    if (/[a-zA-Z]/.test(p) && /[0-9]/.test(p)) score += 1;
    if (/[^a-zA-Z0-9]/.test(p) || (/[a-z]/.test(p) && /[A-Z]/.test(p))) score += 1;
    return Math.min(score, 4);
}
