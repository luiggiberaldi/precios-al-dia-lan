import { searchProductImagesMultiTier } from '../desktop/server/imageSearchEngine.mjs';

const supabaseUrl = process.env.VITE_SUPABASE_CLOUD_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.VITE_SUPABASE_CLOUD_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const query = req.query?.q || '';
        if (!query || query.trim().length < 3) {
            return res.status(400).json({ error: "Falta el parámetro 'q' de búsqueda (mínimo 3 caracteres)." });
        }

        const matches = await searchProductImagesMultiTier(query, {
            supabaseUrl,
            supabaseKey,
            enableWebFallback: true,
        });

        return res.status(200).json({ success: true, matches });
    } catch (error) {
        console.error('[CatalogSearch] Error:', error);
        return res.status(500).json({ error: error.message });
    }
}
