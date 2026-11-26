/**
 * Precios al Día Nube no usa modo oscuro: las pantallas de acceso y la app
 * están pensadas en claro. Si el equipo guardó `theme=dark` (de Bodega o de una
 * prueba), se borra y se vuelve a claro antes de pintar nada.
 */
export function forceLightTheme(doc = globalThis.document, storage = globalThis.localStorage) {
    try { storage?.setItem('theme', 'light'); } catch { /* almacenamiento bloqueado */ }
    const root = doc?.documentElement;
    if (!root) return;
    root.classList.remove('dark');
    root.setAttribute('data-theme', 'light');
    const meta = doc.querySelector?.('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#2b59c3');
}
