import { createClient } from '@supabase/supabase-js';

// DB Cloud/Sync P2P: proyecto "preciosaldia rebranding" (sodgzkablshladvbtnes).
// La URL/key reales vienen de VITE_SUPABASE_CLOUD_URL / _KEY en .env.
// (Refs viejos fgzwmwrugerptfqfrsjd / ewwszyzzvoweudholmbf quedaron obsoletos.)
// Precios al Día Nube (baranda G3): sin variables NUNCA se cae a la base de
// Precios al Día (producción ni staging). La dirección de respaldo es `.invalid`,
// que no existe en internet: la app arranca, pero no habla con ninguna base.
// La guardia scripts/nube/check-no-legacy-supabase.mjs falla el build si
// reaparece una referencia vieja.
const NUBE_SIN_CONFIGURAR_URL = 'https://supabase-sin-configurar.invalid';
const useSupervisorE2EStaging = import.meta.env.VITE_SUPERVISOR_E2E_STAGING === 'true';
const supabaseUrl = useSupervisorE2EStaging
    ? (import.meta.env.VITE_SUPABASE_STAGING_URL || NUBE_SIN_CONFIGURAR_URL)
    : (import.meta.env.VITE_SUPABASE_CLOUD_URL || import.meta.env.VITE_SUPABASE_URL || NUBE_SIN_CONFIGURAR_URL);
const supabaseKey = useSupervisorE2EStaging
    ? import.meta.env.VITE_SUPABASE_STAGING_KEY
    : (import.meta.env.VITE_SUPABASE_CLOUD_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || 'sin-llave');

// Compatibilidad con el cache de imágenes agregado en esta rama de trabajo.
export const supabaseCloudUrl = supabaseUrl;

if (useSupervisorE2EStaging && !supabaseKey) {
    throw new Error('Falta VITE_SUPABASE_STAGING_KEY para ejecutar E2E contra staging');
}

export const supabaseCloud = createClient(supabaseUrl, supabaseKey, {
    auth: {
        // La sesión identifica al dispositivo ante RLS; no contiene PINs del POS.
        // Debe persistir para que una recarga no pierda el vínculo del monitor.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
    },
});
