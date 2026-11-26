import { defineConfig, devices } from '@playwright/test';

const vercelBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
    testDir: './tests/e2e',
    // Calienta Vite antes de las pruebas (evita el timeout intermitente de la primera carga).
    globalSetup: './tests/e2e/helpers/warmupVite.js',
    timeout: 60_000,
    expect: { timeout: 5_000 },
    fullyParallel: false,
    reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: process.env.SUPERVISOR_E2E_BASE_URL || 'http://127.0.0.1:4173',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        ...devices['Desktop Chrome'],
        ...(vercelBypassSecret
            ? {
                  extraHTTPHeaders: {
                      'x-vercel-protection-bypass': vercelBypassSecret,
                      'x-vercel-set-bypass-cookie': 'true',
                  },
              }
            : {}),
    },
    webServer: {
        command: 'bun run dev -- --host 127.0.0.1 --port 4173',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        // Ventas remotas (default apagado en producción): el e2e las prueba encendidas.
        env: { VITE_SUPERVISOR_REMOTE_SALES_ENABLED: 'true' },
    },
});
