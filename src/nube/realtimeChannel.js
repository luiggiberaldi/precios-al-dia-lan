/**
 * Canal de Realtime que no se queda muerto.
 *
 * Si Supabase corta el canal (error, tiempo agotado, cierre; p. ej. al pasar el límite
 * de mensajes por segundo), la caja dejaba de enterarse de los cambios de las otras
 * hasta la revisión de cada minuto. Aquí se vuelve a abrir solo, con espera creciente
 * (2 s → 30 s), y al volver se avisa para ponerse al día con lo que se perdió.
 */
const DOWN = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']);

/**
 * @param {object} client  cliente de Supabase (sin `channel` no hace nada)
 * @param {string} name    nombre del canal
 * @param {(ch) => ch} setup  agrega los `.on(...)` al canal recién creado
 * @param {object} [opts]
 * @param {(info: { reconnected: boolean }) => void} [opts.onUp]  canal listo
 * @param {() => void} [opts.onDown]  se cayó (se reintentará)
 */
export function keepChannel(client, name, setup, { onUp, onDown, minDelayMs = 2000, maxDelayMs = 30_000 } = {}) {
    if (!client || typeof client.channel !== 'function') {
        return { isUp: () => false, dispose: () => {} };
    }
    let channel = null;
    let up = false;
    let everUp = false;
    let disposed = false;
    let retry = null;
    let delay = minDelayMs;

    const drop = (ch) => { try { client.removeChannel?.(ch); } catch { /* ya cerrado */ } };

    function scheduleReopen() {
        if (disposed || retry) return;
        const old = channel;
        channel = null;
        if (old) drop(old);
        retry = setTimeout(() => { retry = null; open(); }, delay);
        delay = Math.min(delay * 2, maxDelayMs);
    }

    function open() {
        if (disposed) return;
        const ch = setup(client.channel(name));
        channel = ch;
        ch.subscribe((status) => {
            if (disposed || ch !== channel) return; // aviso de un canal viejo
            if (status === 'SUBSCRIBED') {
                const reconnected = everUp;
                up = true;
                everUp = true;
                delay = minDelayMs;
                onUp?.({ reconnected });
            } else if (DOWN.has(status)) {
                if (up) onDown?.();
                up = false;
                scheduleReopen();
            }
        });
    }

    open();

    return {
        isUp: () => up,
        dispose() {
            disposed = true;
            clearTimeout(retry);
            retry = null;
            if (channel) drop(channel);
            channel = null;
            up = false;
        },
    };
}
