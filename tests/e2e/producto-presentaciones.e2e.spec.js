/**
 * producto-presentaciones.e2e.spec.js — Fase 5: Verificación E2E de presentaciones
 * multinivel (1, 2 y 3 niveles) en Inventario, Caja (Vender), Cobro y Anulación,
 * más auditoría de responsive/táctil en desktop (1366x768) y móvil (375x812).
 *
 * Ejecutar: npx playwright test tests/e2e/producto-presentaciones.e2e.spec.js
 */
import { test, expect } from '@playwright/test';
import { seedAudit, readIdb } from './helpers/auditHarness';

test.setTimeout(120_000);

const buscador = (page) => page.locator('input[placeholder="Buscar producto..."]:visible').first();

async function openTab(page, tabName) {
    const cmdPalette = page.getByPlaceholder('Buscar acciones, productos o clientes...');
    if (await cmdPalette.isVisible().catch(() => false)) {
        await page.keyboard.press('Escape');
        await expect(cmdPalette).toHaveCount(0, { timeout: 5_000 });
    }
    const tab = page.locator(`[data-tour="tab-${tabName}"]:visible`).first();
    await expect(tab).toBeVisible({ timeout: 30_000 });
    await tab.click();
}

async function openInventario(page) {
    for (let intento = 1; intento <= 4; intento++) {
        await openTab(page, 'catalogo');
        try {
            await page.getByRole('button', { name: 'Nuevo' }).first().waitFor({ state: 'visible', timeout: 15_000 });
            return;
        } catch (err) {
            if (intento === 4) throw err;
        }
    }
}

async function openVentas(page) {
    await openTab(page, 'ventas');
    await expect(page.getByRole('heading', { name: 'Caja Cerrada' })).toHaveCount(0, { timeout: 15_000 });
    await expect(buscador(page)).toBeVisible({ timeout: 15_000 });
}

async function seedPos(page, viewport) {
    await page.setViewportSize(viewport);
    await seedAudit(page, {
        extraInitScripts: [
            `try {
                localStorage.setItem('checkout_mode', 'pos');
                localStorage.removeItem('checkout_shell_v2');
                localStorage.setItem('checkout_smallest_usd_bill', '1');
                localStorage.setItem('checkout_bs_round_step', '0');
            } catch (_) {}`,
        ],
    });
    await page.goto('/');
    await expect(page.locator('[data-tour="tab-ventas"]:visible').first()).toBeVisible({ timeout: 30_000 });
}

async function cobrarExactoUsd(page, montoStr) {
    await page.keyboard.press('F9');
    await expect(page.getByText('Procesar Pago').first()).toBeVisible({ timeout: 20_000 });
    const usd = page.getByPlaceholder('0.00').first();
    await usd.fill(montoStr);
    const pagar = page.getByRole('button', { name: /PAGAR|COBRAR \$/ }).last();
    await expect(pagar).toBeEnabled({ timeout: 10_000 });
    await pagar.click();
    const confirmar = page.getByRole('button', { name: /Confirmar venta|Confirmar igual|Vuelto entregado/ });
    if (await confirmar.count()) await confirmar.first().click();
    await expect(page.getByText('Tasa BCV Aplicada')).toBeVisible({ timeout: 15_000 });
    const closeReceipt = page.getByRole('button', { name: /Nueva Venta|Listo|Cerrar/i }).first();
    if (await closeReceipt.isVisible().catch(() => false)) {
        await closeReceipt.click();
    } else {
        await page.keyboard.press('Escape');
    }
    await expect(page.getByText('Tasa BCV Aplicada')).toHaveCount(0, { timeout: 10_000 });
}

test.describe('Fase 5 — Presentaciones multinivel (1, 2 y 3 niveles)', () => {
    test('Flujo A (1 nivel): Unidad simple oculta campos de bulto y vende 1:1 en Caja', async ({ page }) => {
        await seedPos(page, { width: 1366, height: 768 });
        await openInventario(page);
        await page.getByRole('button', { name: 'Nuevo' }).first().click();

        // Divulgación progresiva: en Unidad simple no hay campos de bulto visibles
        await expect(page.getByText('Unidad simple')).toBeVisible();
        await expect(page.getByText('Uds. por Bulto / Caja')).toHaveCount(0);
        await expect(page.getByTestId('product-live-preview')).toBeVisible();

        await page.getByPlaceholder('Ej: Harina PAN 1kg').fill('Agua Mineral E2E');
        await page.getByLabel('Costo en USD').fill('0.80');
        await page.getByLabel('Precio USD de Unidad').fill('1.50');
        await page.locator('#product-stock-single').fill('10');

        await page.getByRole('button', { name: /Guardar Producto/ }).first().click();

        await expect.poll(async () => {
            const products = await readIdb(page, 'bodega_products_v1');
            const saved = products?.find((p) => p.name === 'Agua Mineral E2E');
            return saved ? { mode: saved.packagingMode, stock: saved.stock, price: saved.priceUsdt } : null;
        }, { timeout: 15_000 }).toEqual({ mode: 'simple', stock: 10, price: 1.5 });

        // Vender 1 unidad directo (sin abrir selector de presentaciones)
        await openVentas(page);
        const search = buscador(page);
        await search.fill('Agua Mineral E2E');
        await page.waitForTimeout(350);
        await search.press('Enter');
        await expect(search).toHaveValue('', { timeout: 8_000 });
        await expect(page.getByTestId('hierarchy-option-unit')).toHaveCount(0);

        await cobrarExactoUsd(page, '1.50');

        await expect.poll(async () => {
            const products = await readIdb(page, 'bodega_products_v1');
            return products?.find((p) => p.name === 'Agua Mineral E2E')?.stock;
        }, { timeout: 15_000 }).toBe(9);
    });

    test('Flujo B (3 niveles farmacia): crear, vender 1 Caja + 2 Blísters + 1 Tableta (=51) y anular restaurando a 74', async ({ page }) => {
        await seedPos(page, { width: 1366, height: 768 });
        await openInventario(page);
        await page.getByRole('button', { name: 'Nuevo' }).first().click();

        await page.getByPlaceholder('Ej: Harina PAN 1kg').fill('Acetaminofén 500mg');
        await page.getByRole('radio', { name: /Presentaciones/ }).click();
        await page.getByRole('button', { name: /Caja \+ Blíster \+ Tableta/ }).click();

        await expect(page.getByTestId('equivalence-chain')).toContainText('1 Caja = 3 Blísters = 30 Tabletas');

        // Costo por Caja = $6.00 → $2.00 / Blíster y $0.20 / Tableta
        await page.getByTestId('cost-source-pack').click();
        await page.getByLabel('Costo en USD').fill('6');
        await expect(page.getByText('$2.00 / Blíster')).toBeVisible();
        await expect(page.getByText('$0.20 / Tableta')).toBeVisible();

        // Precios vendibles para los 3 niveles
        await page.getByLabel('Precio USD de Caja').fill('9');
        await page.getByLabel('Precio USD de Blíster').fill('3.20');
        await page.getByLabel('Precio USD de Tableta').fill('0.40');

        // Stock desglosado: 2 Cajas + 1 Blíster + 4 Tabletas = 74
        await page.getByLabel('Stock en Caja').fill('2');
        await page.getByLabel('Stock en Blíster').fill('1');
        await page.getByLabel('Stock en Tableta').fill('4');
        await expect(page.getByTestId('stock-total-base')).toContainText('74');

        // Vista previa viva en desktop
        const preview = page.getByTestId('product-live-preview');
        await expect(preview).toBeVisible();
        await expect(preview).toContainText('Acetaminofén 500mg');
        await expect(preview).toContainText('74 Tabletas');

        await page.getByRole('button', { name: /Guardar Producto/ }).first().click();

        // Verificar persistencia en IndexedDB
        await expect.poll(async () => {
            const products = await readIdb(page, 'bodega_products_v1');
            const saved = products?.find((p) => p.name === 'Acetaminofén 500mg');
            return saved ? { stock: saved.stock, levels: saved.presentations?.length } : null;
        }, { timeout: 15_000 }).toEqual({ stock: 74, levels: 3 });

        // Verificar tarjeta en Inventario muestra desglose
        const invSearch = buscador(page);
        await invSearch.fill('Acetaminofén 500mg');
        await expect(page.getByText(/2 Cajas/).first()).toBeVisible({ timeout: 10_000 });

        // Vender en Caja: 1 Caja (30) + 2 Blísters (20) + 1 Tableta (1) = 51 tabletas ($15.80)
        await openVentas(page);
        const selectLevel = async (levelId) => {
            const s = buscador(page);
            await s.fill('Acetaminofén 500mg');
            await page.waitForTimeout(350);
            await s.press('Enter');
            const opt = page.getByTestId(`hierarchy-option-${levelId}`);
            await expect(opt).toBeVisible({ timeout: 8_000 });
            await opt.click();
        };

        await selectLevel('pack'); // 1 Caja ($9.00)
        await selectLevel('mid');  // 1 Blíster ($3.20)
        await selectLevel('mid');  // 2do Blíster ($3.20)
        await selectLevel('unit'); // 1 Tableta ($0.40)

        await cobrarExactoUsd(page, '15.80');

        // Stock final = 74 - 51 = 23 Tabletas (2 Blísters + 3 Tabletas)
        await expect.poll(async () => {
            const products = await readIdb(page, 'bodega_products_v1');
            return products?.find((p) => p.name === 'Acetaminofén 500mg')?.stock;
        }, { timeout: 15_000 }).toBe(23);

        // Verificar desglose actualizado en Inventario (2 Blísters · 3 Tabletas)
        await openInventario(page);
        await buscador(page).fill('Acetaminofén 500mg');
        await expect(page.getByText(/2 Blísters/).first()).toBeVisible({ timeout: 10_000 });

        // Anular la venta desde Reportes → Ventas y confirmar reposición a 74
        await openTab(page, 'reportes');
        await page.getByRole('button', { name: 'Ventas', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Historial de Ventas' })).toBeVisible({ timeout: 15_000 });
        await page.getByText('Consumidor Final').last().click();
        await page.getByRole('button', { name: /Anular/ }).first().click();
        await page.getByRole('button', { name: /S[ií], anular/ }).click();
        await expect(page.getByRole('heading', { name: 'Venta Anulada' })).toBeVisible({ timeout: 15_000 });

        await expect.poll(async () => {
            const products = await readIdb(page, 'bodega_products_v1');
            return products?.find((p) => p.name === 'Acetaminofén 500mg')?.stock;
        }, { timeout: 15_000 }).toBe(74);
    });

    test('Flujo C (UI/UX & A11y): móvil 375x812 sin desborde horizontal y áreas táctiles >= 44px', async ({ page }) => {
        await seedPos(page, { width: 375, height: 812 });
        await openInventario(page);
        await page.getByRole('button', { name: 'Nuevo' }).first().click();

        await page.getByRole('radio', { name: /Presentaciones/ }).click();
        await page.getByRole('button', { name: /Caja \+ Blíster \+ Tableta/ }).click();

        const layoutAudit = await page.evaluate(() => {
            const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
            const saveButtons = Array.from(document.querySelectorAll('button')).filter((b) =>
                /Guardar Producto/.test(b.textContent || '') && b.offsetParent !== null
            );
            const minSaveHeight = saveButtons.length
                ? Math.min(...saveButtons.map((b) => b.getBoundingClientRect().height))
                : 0;
            const modeButtons = Array.from(document.querySelectorAll('[role="radio"], button')).filter((b) =>
                /Unidad simple|Presentaciones|A granel/.test(b.textContent || '') && b.offsetParent !== null
            );
            const minModeHeight = modeButtons.length
                ? Math.min(...modeButtons.map((b) => b.getBoundingClientRect().height))
                : 0;
            return { docOverflow, minSaveHeight, minModeHeight };
        });

        expect(layoutAudit.docOverflow).toBeLessThanOrEqual(2);
        expect(layoutAudit.minSaveHeight).toBeGreaterThanOrEqual(44);
        expect(layoutAudit.minModeHeight).toBeGreaterThanOrEqual(44);
    });
});
