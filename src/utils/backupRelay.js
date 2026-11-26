/**
 * backupRelay.js — Relay de respaldos vía Estación Maestra: DESACTIVADO en Precios al Día Nube.
 *
 * Desde 2026-11-16 (plan de fixeo F3 de la Estación) el relay exige una
 * credencial propia por equipo y solo atiende equipos de Bodega. En Precios al Día Nube
 * siempre respondía 403 (producto distinto), y este cliente además metía en el
 * JS público el secreto común VITE_ESTACION_BACKUP_SECRET.
 *
 * Ahora las funciones devuelven "no disponible" sin llamar a la red y el
 * secreto ya no se lee (Vite no lo incluye en el bundle). Quien las llama ya
 * manejaba este caso (ok: false). El respaldo directo en la nube no cambia.
 *
 * @module utils/backupRelay
 */

/**
 * true cuando el bundle corre en un build de producción (vite define PROD).
 * En dev y en pruebas el valor de import.meta.env.PROD es false.
 */
function isProdBuild() {
    return import.meta.env?.PROD === true;
}

/**
 * URL base de la API de Estación Maestra.
 *
 * Guardarraíl de entorno: el default a producción SOLO aplica en builds de
 * producción. En desarrollo/pruebas sin VITE_ESTACION_API_URL se devuelve ""
 * para que ningún entorno de prueba pueda tocar el backend real (hallazgo de
 * la auditoría E2E: el auto-backup llamaba a producción desde el test).
 * Lectura por llamada para testabilidad.
 */
export function getEstacionApiUrl() {
    return (
        import.meta.env?.VITE_ESTACION_API_URL ||
        (isProdBuild() ? 'https://estacion-2026.vercel.app' : '')
    );
}

const RELAY_UNAVAILABLE = 'relay de la Estación no disponible para Precios al Día Nube';

/**
 * Antes subía el backup vía relay. Ahora no hace nada (ver cabecera).
 * @returns {Promise<{ok: false, relayed: false, skipped: true, error: string}>}
 */
export async function relayUploadBackup(_deviceId, _backupData) {
    return { ok: false, relayed: false, skipped: true, error: RELAY_UNAVAILABLE };
}

/**
 * Antes leía el backup vía relay. Ahora no hace nada (ver cabecera).
 * @returns {Promise<{ok: false, backupData: null, updatedAt: null, skipped: true, error: string}>}
 */
export async function relayFetchBackup(_deviceId) {
    return { ok: false, backupData: null, updatedAt: null, skipped: true, error: RELAY_UNAVAILABLE };
}

export default { relayUploadBackup, relayFetchBackup, getEstacionApiUrl };
