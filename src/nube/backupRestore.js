/**
 * Restaurar un respaldo en un equipo con la nube activa.
 *
 * La restauración heredada (Ajustes → Importar respaldo) escribe el respaldo en el equipo.
 * Con la nube eso dejaba a las otras cajas sin stock: los productos suben SIN stock (el
 * stock lo manda el libro del servidor) y nadie subía el stock del respaldo. Aquí se sube
 * todo con la sesión de PIN del equipo:
 *   · productos, clientes, proveedores, métodos de pago y categorías (push_records);
 *   · el stock como CONTEO (la nube queda igual al respaldo, también los productos en 0);
 *   · los saldos de clientes como SALDO_INICIAL_MIGRADO, solo si el respaldo NO trae el
 *     libro de clientes (si lo trae, el libro sube solo al arrancar y no se cuenta dos veces).
 *
 * Solo el dueño o un administrador (el servidor tampoco deja mover inventario a otros).
 */
import { importBackupToCloud, importInitialStock, importInitialBalances, backupHasLedger } from './importBackup';

const CAN_RESTORE = ['dueno', 'administrador'];

export function createBackupRestorer({ client, accountId, sedeId = null, getSession }) {
    /** ¿Puede restaurar este empleado? Se pregunta ANTES de borrar nada del equipo. */
    function check() {
        const session = getSession();
        if (!session?.token) return { ok: false, message: 'Tu sesión venció. Vuelve a entrar con tu PIN para restaurar el respaldo.' };
        if (!CAN_RESTORE.includes(session.role)) return { ok: false, message: 'Solo el dueño o un administrador pueden restaurar un respaldo.' };
        return { ok: true };
    }

    async function upload(json, { onProgress = () => {} } = {}) {
        const allowed = check();
        if (!allowed.ok) throw new Error(allowed.message);
        const token = getSession().token;
        onProgress('Subiendo el respaldo a la nube…');
        const records = await importBackupToCloud(client, json, {
            session: token,
            // La caja la sube el propio equipo al arrancar, con su id de caja (si no, quedaría dos veces).
            exclude: ['bodega_sales_v1'],
            onProgress: ({ collection, done, total }) => onProgress(`Subiendo ${collection}: ${done} de ${total}…`),
        });
        onProgress('Subiendo el stock del respaldo…');
        const stock = await importInitialStock(client, json, { accountId, sedeId, session: token });
        let saldos = 0;
        if (!backupHasLedger(json)) {
            onProgress('Subiendo deudas y saldos a favor…');
            saldos = await importInitialBalances(client, json, { accountId, session: token });
        }
        return { records, stock, saldos };
    }

    return { check, upload };
}
