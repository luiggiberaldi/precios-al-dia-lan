/**
 * Guardado seguro de listas que una pantalla tiene en memoria (clientes, …).
 *
 * Con varias cajas, la copia local cambia por debajo de la pantalla: otra caja crea
 * un cliente, el sincronizador lo baja, pero la pantalla abierta sigue con su lista
 * vieja. Si guarda esa lista completa, el sincronizador ve que «falta» el cliente
 * nuevo y lo BORRA en la nube para todas las cajas (y revierte lo que otra caja editó).
 *
 * Aquí se funde lo que la pantalla cambió (de `base` a `next`) sobre la lista fresca
 * guardada en el equipo, por campo (mismo merge 3-way del catálogo). Lo que la
 * pantalla no tocó se toma fresco.
 */
import { mergeCatalog3Way } from '../utils/catalogLock.js';

/**
 * @param {object} p
 * @param {Array} p.base   la lista que la pantalla tenía cuando el usuario empezó a editar
 * @param {Array} p.next   la lista que la pantalla quiere guardar
 * @param {Array} p.fresh  la lista guardada ahora mismo en el equipo
 */
export function mergeScreenList({ base, next, fresh }) {
    return mergeCatalog3Way({
        local: Array.isArray(next) ? next : [],
        base: Array.isArray(base) ? base : [],
        remote: Array.isArray(fresh) ? fresh : [],
    });
}
