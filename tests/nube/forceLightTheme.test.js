// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { forceLightTheme } from '../../src/nube/forceLightTheme.js';

describe('Nube sin modo oscuro', () => {
    it('borra el tema oscuro guardado y deja la página en claro', () => {
        localStorage.setItem('theme', 'dark');
        document.documentElement.classList.add('dark');
        document.documentElement.setAttribute('data-theme', 'dark');
        forceLightTheme();
        expect(localStorage.getItem('theme')).toBe('light');
        expect(document.documentElement.classList.contains('dark')).toBe(false);
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
});
