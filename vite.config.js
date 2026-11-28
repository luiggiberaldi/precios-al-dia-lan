// vite.config.js — Configuración de Vite + PWA + Vitest
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fetchBcvRates } from './api/bcvRatesHelper.js';
import { searchProductImagesMultiTier, fetchExternalImageSafe } from './desktop/server/imageSearchEngine.mjs';
// Fuente única del system prompt — la misma que usa api/chat.js en Vercel.
import { RELEASE_NOTES } from './src/data/releaseNotes.js';
import { buildChatSystemMessage, CHAT_TEMPERATURE, CHAT_MAX_TOKENS } from './src/services/chatSystemPrompt.js';

// Versión del package.json (en build Electron se toma desktop/package.json para coincidir con el .exe).
import pkg from './package.json' with { type: 'json' };
import desktopPkg from './desktop/package.json' with { type: 'json' };
const APP_VERSION = process.env.ELECTRON_BUILD === 'true'
  ? (desktopPkg.version || pkg.version || '1.0.0')
  : (pkg.version || '1.0.0');

export default defineConfig(({ mode }) => {
  // Cargar TODAS las variables del .env (incluyendo las sin prefijo VITE_)
  const env = loadEnv(mode, process.cwd(), '');
  // Guard: el modo staging E2E anula credenciales de producción en el bundle.
  // Un build de producción con esta variable saldría sin backend; se bloquea.
  if (mode === 'production' && env.VITE_SUPERVISOR_E2E_STAGING === 'true') {
    throw new Error('VITE_SUPERVISOR_E2E_STAGING=true no se permite en un build de producción.');
  }
  return {
    base: process.env.ELECTRON_BUILD === 'true' ? './' : '/',
    plugins: [
      react(),
      // Publica las novedades como /release-notes.json (sin caché) para que la versión
      // ya instalada pueda mostrar qué trae la actualización ANTES de aplicarla.
      {
        name: 'pda-release-notes',
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'release-notes.json', source: JSON.stringify(RELEASE_NOTES) });
        },
      },
    VitePWA({
      disable: process.env.ELECTRON_BUILD === 'true',
      registerType: 'prompt', // SW prompt: no fuerza recargas abruptas durante operaciones POS (A-001/B-003).
      includeAssets: [
        'pwa-splash-transparent-512.png',
        'transparent-splash-icon.png',
        'favicon.ico',
        'apple-touch-icon.png',
        'pwa-144x144.png',
        'pwa-192x192.png',
        'pwa-512x512.png',
        'pwa-maskable-192.png',
        'pwa-maskable-512.png',
        // Logos de fábrica y avatar del asistente: sin esto no se ven sin internet.
        'logo.png',
        'logodark.png',
        'logo-lan-mark.png',
        'logo-lan-mark-dark.png',
        'bot-avatar.png',
      ],
      workbox: {
        cleanupOutdatedCaches: true,
        // Letras autoalojadas (@fontsource) en el precache: se ven sin internet desde la primera carga.
        globPatterns: ['**/*.{js,css,html,woff2}'],
        skipWaiting: false, // No forzar skipWaiting automático para evitar pérdida de datos en caja.
        clientsClaim: true,
        cacheId: `preciosaldia-bodega-v${APP_VERSION}`,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // Las letras ya no vienen de Google Fonts (van en el precache): no hacen falta reglas para ellas.
        runtimeCaching: [
          {
            urlPattern: /\/storage\/v1\/object\/public\/product-images\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'product-images-cache',
              // OFFLINE-IMG (F2): 500 desalojaba imágenes en inventarios grandes.
              // maxAge se mantiene en 90 días a propósito: la ruta en Storage es
              // determinística con upsert, así que sin la Fase 4 una imagen
              // re-subida solo se refresca al expirar.
              expiration: { maxEntries: 1200, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/images\/catalog\/catalog\.json/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'catalog-index-cache',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // OFFLINE-IMG (F1): catálogo base servido desde public/images/catalog/.
            // NO entra al precache: el globPatterns por defecto de vite-plugin-pwa
            // no incluye .webp, y precargar los 612 archivos (23MB) al instalar
            // bloquearía la activación del SW en equipos de gama baja. Con
            // CacheFirst de runtime solo se persisten las que el negocio abre.
            // Sin regex anclado con `$`: así también matchea si algún día llega
            // con querystring.
            urlPattern: /\/images\/catalog\/.*\.(?:webp|png|jpe?g)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'catalog-images-cache',
              // 1.143 archivos en el catálogo → 1.400 deja margen sin desalojar.
              // Son inmutables (el nombre es el slug del producto) → 1 año.
              expiration: { maxEntries: 1400, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Precios al Día LAN',
        short_name: 'PreciosAlDía LAN',
        description: 'Punto de venta multicaja en red local: varias cajas con el mismo inventario, clientes y ventas sin depender de internet',
        theme_color: '#FFFFFF',
        background_color: '#FFFFFF',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        categories: ['business', 'finance', 'shopping'],
        prefer_related_applications: false,
        icons: [
          { src: 'pwa-splash-transparent-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-144x144.png', sizes: '144x144', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Vender Rápido', short_name: 'Vender', description: 'Abrir directamente el Punto de Venta', url: '/?view=ventas', icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }] },
          { name: 'Revisar Inventario', short_name: 'Inventario', description: 'Abrir catálogo de productos', url: '/?view=catalogo', icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }] },
        ],
      },
    }),

    // ── Plugin: /api/chat dev proxy (Groq LLM — espeja api/chat.js de Vercel) ──
    // env.GROQ_KEYS viene de loadEnv() arriba — carga el .env completo en Node.
    {
      name: 'api-chat-dev',
      configureServer(server) {
        server.middlewares.use('/api/chat', (req, res) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PDA-Device-Id');

          if (req.method === 'OPTIONS') {
            res.statusCode = 200;
            res.end();
            return;
          }
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const { messages, context } = JSON.parse(body);
              if (!messages || !Array.isArray(messages)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "El cuerpo debe contener un arreglo 'messages'." }));
                return;
              }

              // ── Proveedor multi-tenant (OpenAI-compatible) ──
              // AI_BASE_URL  → endpoint base (default: Groq). Cualquier proveedor
              //                que hable /chat/completions estilo OpenAI sirve.
              // AI_MODEL     → modelo a usar (default: openai/gpt-oss-120b, igual que producción).
              // AI_API_KEYS  → claves separadas por coma (alias retrocompatible:
              //                GROQ_KEYS sigue funcionando).
              const aiBaseUrl = (env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
              const aiModel = env.AI_MODEL || 'openai/gpt-oss-120b'; // mismo default que api/chat.js
              const aiKeysStr = env.AI_API_KEYS || env.GROQ_KEYS || '';
              const allKeys = aiKeysStr.split(',').map(k => k.trim()).filter(Boolean);
              if (allKeys.length === 0) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'AI_API_KEYS (o GROQ_KEYS) no configuradas en .env' }));
                return;
              }

              // Blindaje de paridad con producción: se descarta cualquier "system"
              // del cliente y siempre se inyecta el prompt compartido primero.
              const safeMessages = [
                { role: 'system', content: buildChatSystemMessage(context) },
                ...messages.filter(m => m && m.role !== 'system').slice(-20),
              ];

              const requestBody = JSON.stringify({
                model: aiModel,
                messages: safeMessages,
                temperature: CHAT_TEMPERATURE,
                max_tokens: CHAT_MAX_TOKENS,
                reasoning_effort: 'low',
                stream: true,
              });

              const startIndex = Math.floor(Math.random() * allKeys.length);
              let lastError = null;
              const keyResults = [];

              for (let attempt = 0; attempt < allKeys.length; attempt++) {
                const apiKey = allKeys[(startIndex + attempt) % allKeys.length];
                let groqRes;
                try {
                  groqRes = await fetch(`${aiBaseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                      'Authorization': `Bearer ${apiKey}`,
                      'Content-Type': 'application/json',
                    },
                    body: requestBody,
                  });
                  keyResults.push({ key: `...${apiKey.slice(-4)}`, code: groqRes.status });
                } catch (fetchErr) {
                  keyResults.push({ key: `...${apiKey.slice(-4)}`, code: 'network' });
                  lastError = fetchErr.message;
                  continue;
                }

                if (groqRes.status === 429 || groqRes.status === 401 || groqRes.status === 403 || groqRes.status >= 500) {
                  lastError = `Key HTTP ${groqRes.status}`;
                  continue;
                }

                if (!groqRes.ok) {
                  const errText = await groqRes.text();
                  console.error(`[Chat dev] Error no recuperable del proveedor (HTTP ${groqRes.status}):`, errText.slice(0, 500));
                  res.statusCode = 502;
                  res.end(JSON.stringify({ error: 'El asistente no pudo procesar la consulta en este momento.' }));
                  return;
                }

                // ✅ Clave ok — stream SSE de vuelta al cliente
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                const reader = groqRes.body.getReader();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  res.write(value);
                }
                res.end();
                return;
              }

              const allBlocked403 = keyResults.length > 0 && keyResults.every(r => r.code === 403);
              res.statusCode = 503;
              res.end(JSON.stringify({
                error: allBlocked403
                  ? 'Todas las claves de IA fueron rechazadas (403). La organización del proveedor parece bloqueada o suspendida — revisa la consola del proveedor o cambia AI_BASE_URL/AI_API_KEYS en .env.'
                  : 'Servicio de IA no disponible. Intenta en unos segundos.',
                detail: lastError,
                keys: keyResults,
              }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: err.message }));
            }
          });
        });
      },
    },
    // ── Plugin: /api dev endpoints (rates, search-image, image-proxy, analyze, chat) ──
    {
      name: 'api-endpoints-dev',
      configureServer(server) {
        const apiMiddleware = (req, res, next) => {
          console.log('[Dev Middleware] Request received:', req.url);
          // Lista blanca de orígenes para el dev server.
          const allowedDevOrigins = ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://localhost:4174', 'http://127.0.0.1:5174'];
          const origin = req.headers.origin;
          const corsOrigin = origin && allowedDevOrigins.includes(origin) ? origin : allowedDevOrigins[0];

          // ── /api/rates ──
          if (req.url.startsWith('/api/rates')) {
            (async () => {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', corsOrigin);
              res.setHeader('Vary', 'Origin');
              try {
                const rates = await fetchBcvRates();
                res.end(JSON.stringify({
                  bcv: { price: rates.bcv, source: `${rates.source} (USD)`, change: 0 },
                  euro: { price: rates.euro, source: `${rates.source} (EUR)`, change: 0 },
                  usdt: { price: rates.usdt, source: 'USDT Binance', change: 0 },
                  lastUpdate: new Date().toISOString(),
                }));
              } catch (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'Failed to fetch rates: ' + err.message }));
              }
            })();
            return;
          }

          // ── /api/search-image (Offline + Supabase + Web Fallback unificado) ──
          if (req.url.startsWith('/api/search-image')) {
            (async () => {
              res.setHeader('Content-Type', 'application/json');
              res.setHeader('Access-Control-Allow-Origin', corsOrigin);
              res.setHeader('Vary', 'Origin');

              const urlObj = new URL(req.url, `http://${req.headers.host}`);
              const query = urlObj.searchParams.get('q');

              if (!query || query.trim().length < 3) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "Falta el parámetro 'q' de búsqueda (mínimo 3 caracteres)." }));
                return;
              }

              try {
                const supabaseUrl = env.VITE_SUPABASE_CLOUD_URL || env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_CLOUD_URL || process.env.VITE_SUPABASE_URL || '';
                const supabaseKey = env.VITE_SUPABASE_CLOUD_KEY || env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_CLOUD_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
                const matches = await searchProductImagesMultiTier(query, {
                  supabaseUrl,
                  supabaseKey,
                  enableWebFallback: true,
                });
                res.end(JSON.stringify({ success: true, matches }));
              } catch (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err.message }));
              }
            })();
            return;
          }

          // ── /api/image-proxy (seguro anti-SSRF + soporte ?format=json) ──
          if (req.url.startsWith('/api/image-proxy')) {
            (async () => {
              res.setHeader('Access-Control-Allow-Origin', corsOrigin);
              res.setHeader('Vary', 'Origin');

              const urlObj = new URL(req.url, `http://${req.headers.host}`);
              const targetUrl = urlObj.searchParams.get('url');
              const format = urlObj.searchParams.get('format');

              if (!targetUrl) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Falta el parámetro url.' }));
                return;
              }

              try {
                const { buffer, contentType, dataUri } = await fetchExternalImageSafe(targetUrl);
                if (format === 'json') {
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ success: true, contentType, dataUri }));
                  return;
                }
                res.setHeader('Content-Type', contentType);
                res.setHeader('Cache-Control', 'public, max-age=86400');
                res.end(buffer);
              } catch (err) {
                res.statusCode = err?.status || 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: err.message }));
              }
            })();
            return;
          }

          // ── /api/analyze (SEC-011: CORS restringido + token efímero) ──
          if (req.url.startsWith('/api/analyze')) {
            if (req.method === 'POST') {
              // Validar origen.
              if (origin && !allowedDevOrigins.includes(origin)) {
                res.statusCode = 403;
                res.end(JSON.stringify({ error: 'Origin not allowed' }));
                return;
              }
              // Token efímero simple para dev (no es seguridad real, solo disuasivo).
              const expectedToken = process.env.DEV_ANALYZE_TOKEN;
              if (expectedToken && req.headers['x-dev-token'] !== expectedToken) {
                res.statusCode = 401;
                res.end(JSON.stringify({ error: 'Dev token required' }));
                return;
              }
              let body = '';
              req.on('data', (chunk) => { body += chunk; });
              req.on('end', async () => {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', corsOrigin);
                res.setHeader('Vary', 'Origin');
                try {
                  const { prompt } = JSON.parse(body);
                  if (typeof prompt !== 'string' || prompt.length > 4000) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: 'prompt inválido o demasiado largo (máx 4000 chars)' }));
                    return;
                  }
                  const apiKey = process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_SECONDARY;
                  if (!apiKey) {
                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: 'Groq API Key not configured' }));
                    return;
                  }
                  const { default: Groq } = await import('groq-sdk');
                  const groq = new Groq({ apiKey });
                  const completion = await groq.chat.completions.create({
                    model: 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 300,
                    temperature: 0.3,
                  });
                  res.end(JSON.stringify({ analysis: completion.choices[0]?.message?.content || null }));
                } catch (err) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: err.message }));
                }
              });
              return;
            }
          }

          next();
        };

        server.middlewares.use(apiMiddleware);

        // Forzar a nuestro middleware a estar en el primer lugar de la pila
        setTimeout(() => {
          const stack = server.middlewares.stack;
          const apiIndex = stack.findIndex(m => m.handle === apiMiddleware);
          if (apiIndex > -1) {
            const [apiMiddlewareObj] = stack.splice(apiIndex, 1);
            stack.unshift(apiMiddlewareObj);
          }
        }, 100);
      },
    },
  ],

  // ── Test setup (Vitest) ──
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.{test,spec}.{js,jsx}'],
    // e2e-offline: Playwright contra el build (npm run test:e2e:offline), no Vitest.
    exclude: ['tests/e2e/**', 'tests/e2e-offline/**'],
    coverage: {
      reporter: ['text', 'html', 'lcov'],
      include: ['src/utils/**', 'src/core/**'],
      exclude: ['src/**/*.jsx', 'tests/**'],
    },
  },

  // Modo staging E2E: Vite inlinea en el bundle cualquier VITE_* del .env. Aquí se anulan
  // las credenciales de producción para que el build de staging no las contenga.
  // Versión visible en la app: package.json + commit corto (Vercel lo expone en el build).
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION),
    'import.meta.env.VITE_APP_BUILD': JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7)),
    'import.meta.env.VITE_NUBE_ACCOUNTS': JSON.stringify(env.VITE_NUBE_ACCOUNTS || (mode === 'test' ? 'false' : 'true')),
    'import.meta.env.VITE_LAN_MODE': JSON.stringify(env.VITE_LAN_MODE || (mode === 'test' ? 'false' : 'true')),
    ...(env.VITE_SUPERVISOR_E2E_STAGING === 'true'
      ? {
          'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
          'import.meta.env.VITE_SUPABASE_CLOUD_URL': JSON.stringify(''),
          'import.meta.env.VITE_SUPABASE_CLOUD_KEY': JSON.stringify(''),
          'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
        }
      : {}),
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          icons: ['lucide-react'],
          supabase: ['@supabase/supabase-js'],
          storage: ['localforage', 'zustand'],
          pdf: ['jspdf'],
          canvas: ['html2canvas'],
          // INFRA-008: separar groq-sdk y capacitor que antes se incluían en el chunk principal.
          groq: ['groq-sdk'],
        },
      },
    },
  },
  };
});
