/**
 * El canal en vivo (por donde llega la tasa y los avisos de otras cajas) se reabre solo
 * si Supabase lo corta, y al volver avisa para ponerse al día.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { keepChannel } from '../../src/nube/realtimeChannel.js';

function fakeClient() {
    const channels = [];
    const removed = [];
    return {
        channels,
        removed,
        channel(name) {
            const ch = {
                name,
                handlers: [],
                cb: null,
                on(...args) { this.handlers.push(args); return this; },
                subscribe(cb) { this.cb = cb; return this; },
                emit(status) { this.cb?.(status); },
            };
            channels.push(ch);
            return ch;
        },
        removeChannel(ch) { removed.push(ch); ch.emit('CLOSED'); },
    };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('canal en vivo que no se queda muerto', () => {
    it('abre el canal con sus escuchas y avisa cuando está listo', () => {
        const client = fakeClient();
        const onUp = vi.fn();
        const live = keepChannel(client, 'pdn-sync-x', (ch) => ch.on('postgres_changes', {}, () => {}), { onUp });
        expect(client.channels).toHaveLength(1);
        expect(client.channels[0].handlers).toHaveLength(1);
        expect(live.isUp()).toBe(false);
        client.channels[0].emit('SUBSCRIBED');
        expect(live.isUp()).toBe(true);
        expect(onUp).toHaveBeenCalledWith({ reconnected: false });
    });

    it('si Supabase lo corta, lo reabre solo y avisa que volvió', () => {
        const client = fakeClient();
        const onUp = vi.fn();
        const onDown = vi.fn();
        const live = keepChannel(client, 'c', (ch) => ch, { onUp, onDown, minDelayMs: 2000 });
        client.channels[0].emit('SUBSCRIBED');
        client.channels[0].emit('CHANNEL_ERROR');
        expect(live.isUp()).toBe(false);
        expect(onDown).toHaveBeenCalledTimes(1);
        expect(client.removed).toContain(client.channels[0]);
        expect(client.channels).toHaveLength(1); // aún esperando
        vi.advanceTimersByTime(2000);
        expect(client.channels).toHaveLength(2);
        client.channels[1].emit('SUBSCRIBED');
        expect(live.isUp()).toBe(true);
        expect(onUp).toHaveBeenLastCalledWith({ reconnected: true });
    });

    it('la espera crece si sigue fallando y no abre canales de más', () => {
        const client = fakeClient();
        keepChannel(client, 'c', (ch) => ch, { minDelayMs: 1000, maxDelayMs: 4000 });
        client.channels[0].emit('TIMED_OUT');
        client.channels[0].emit('CLOSED'); // aviso repetido del canal viejo: se ignora
        vi.advanceTimersByTime(1000);
        expect(client.channels).toHaveLength(2);
        client.channels[1].emit('CHANNEL_ERROR');
        vi.advanceTimersByTime(1999);
        expect(client.channels).toHaveLength(2);
        vi.advanceTimersByTime(1);
        expect(client.channels).toHaveLength(3);
    });

    it('al salir lo cierra y no vuelve a abrir', () => {
        const client = fakeClient();
        const live = keepChannel(client, 'c', (ch) => ch);
        client.channels[0].emit('SUBSCRIBED');
        live.dispose();
        expect(client.removed).toContain(client.channels[0]);
        vi.advanceTimersByTime(60_000);
        expect(client.channels).toHaveLength(1);
        expect(live.isUp()).toBe(false);
    });

    it('sin Realtime (pruebas, cliente simple) no rompe', () => {
        const live = keepChannel({}, 'c', (ch) => ch);
        expect(live.isUp()).toBe(false);
        expect(() => live.dispose()).not.toThrow();
    });
});
