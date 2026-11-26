import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanText, scanDir, LEGACY_SUPABASE_REFS } from '../../scripts/nube/check-no-legacy-supabase.mjs';

describe('guardia nube: sin proyectos de Precios al Día en el build', () => {
    it('detecta cada referencia vieja de Supabase', () => {
        for (const ref of LEGACY_SUPABASE_REFS) {
            expect(scanText(`fetch("https://${ref}.supabase.co/rest/v1")`)).toEqual([
                { kind: 'supabase-legacy', match: ref },
            ]);
        }
    });

    it('detecta llaves de servidor', () => {
        expect(scanText('const k = "sb_secret_abcdefghijkl"').map((h) => h.kind)).toEqual(['server-key']);
        expect(scanText("role: 'service_role'").map((h) => h.kind)).toEqual(['server-key']);
    });

    it('acepta el proyecto de la nube y la dirección .invalid', () => {
        expect(scanText('https://hfuzyauiefhllohonvim.supabase.co https://supabase-sin-configurar.invalid')).toEqual([]);
    });

    it('revisa subcarpetas y reporta el archivo', () => {
        const dir = mkdtempSync(join(tmpdir(), 'nube-guard-'));
        mkdirSync(join(dir, 'assets'));
        writeFileSync(join(dir, 'assets', 'ok.js'), 'console.log(1)');
        writeFileSync(join(dir, 'assets', 'mal.js'), 'x="https://sodgzkablshladvbtnes.supabase.co"');
        writeFileSync(join(dir, 'imagen.png'), 'sodgzkablshladvbtnes');
        const hits = scanDir(dir);
        expect(hits).toHaveLength(1);
        expect(hits[0].file.split(String.fromCharCode(92)).join('/')).toBe('assets/mal.js');
    });
});
