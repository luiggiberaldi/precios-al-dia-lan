/**
 * globalSetup de Playwright: calienta el servidor de desarrollo de Vite.
 *
 * Por qué: Vite transforma cada módulo la primera vez que se pide. En frío, la
 * primera prueba de cada corrida cargaba SalesView y todas sus dependencias a la
 * vez; a veces tardaba más de los 60 s de la prueba y se quedaba en el esqueleto
 * gris ("locator.fill: Test timeout… Buscar producto..."), un fallo intermitente
 * que bloqueaba el pre-push sin que el código tuviera error.
 *
 * Qué hace: recorre el grafo de módulos (estáticos y dinámicos) partiendo de
 * index.html y los pide por HTTP, sin navegador, hasta que Vite los tenga
 * transformados. Con un servidor ya caliente las pruebas arrancan en segundos.
 * Si se apunta a otra URL (SUPERVISOR_E2E_BASE_URL) no hace nada.
 */
const CONCURRENCIA = 8;
const LIMITE_MS = 180_000;
const RE_MODULO = /["'`](\/(?:src|node_modules\/\.vite|@vite|@react-refresh)[^"'`\s)]*)["'`]/g;

export default async function globalSetup(config) {
    if (process.env.SUPERVISOR_E2E_BASE_URL) return;
    const base = config.projects[0]?.use?.baseURL || 'http://127.0.0.1:4173';
    const inicio = Date.now();
    const vistos = new Set();
    const cola = [];

    const encolar = (ruta) => {
        if (vistos.has(ruta)) return;
        vistos.add(ruta);
        cola.push(ruta);
    };

    const html = await (await fetch(`${base}/`)).text();
    for (const m of html.matchAll(RE_MODULO)) encolar(m[1]);
    for (const m of html.matchAll(/src="(\/[^"]+)"/g)) encolar(m[1]);

    const trabajador = async () => {
        while (cola.length && Date.now() - inicio < LIMITE_MS) {
            const ruta = cola.shift();
            try {
                const res = await fetch(`${base}${ruta}`);
                const tipo = res.headers.get('content-type') || '';
                if (!res.ok || !/javascript/.test(tipo)) { await res.arrayBuffer().catch(() => {}); continue; }
                const texto = await res.text();
                for (const m of texto.matchAll(RE_MODULO)) encolar(m[1]);
            } catch {
                /* un módulo que falle aquí no debe tumbar la corrida: la prueba lo reportará */
            }
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));
    console.log(`[warmup] ${vistos.size} módulos calentados en ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
}
