/**
 * Prueba real con la app: al entrar con PIN de la nube, el arranque de la app heredada
 * (App.jsx «si requireLogin → logout») expulsaba al empleado y volvía a «¿Quién va a trabajar?».
 */
import { describe, it, expect } from 'vitest';
import { isNubeSession, toLegacySession } from '../../src/nube/memberSession.js';

describe('sesión de la nube frente al arranque de la app heredada', () => {
    it('reconoce la sesión que abrió la puerta de la nube', () => {
        const legacy = toLegacySession({ memberId: 'b1c2', name: 'Ana', role: 'cajero' });
        expect(isNubeSession(legacy)).toBe(true);
    });

    it('una sesión local de Bodega (o ninguna) no cuenta como de la nube', () => {
        expect(isNubeSession({ id: 1, nombre: 'Administrador', rol: 'ADMIN' })).toBe(false);
        expect(isNubeSession({ id: 1, nombre: 'X', rol: 'ADMIN', nube: 'true' })).toBe(false);
        expect(isNubeSession(null)).toBe(false);
    });
});
