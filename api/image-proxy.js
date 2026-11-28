import { fetchExternalImageSafe } from '../desktop/server/imageSearchEngine.mjs';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const targetUrl = req.query?.url || '';
        const format = req.query?.format || '';
        if (!targetUrl) {
            return res.status(400).json({ error: 'Falta el parámetro url.' });
        }

        const { buffer, contentType, dataUri } = await fetchExternalImageSafe(targetUrl);

        if (format === 'json') {
            return res.status(200).json({ success: true, contentType, dataUri });
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.status(200).send(buffer);
    } catch (err) {
        console.error('[ImageProxy] Error:', err);
        return res.status(err?.status || 500).json({ error: err?.message || 'No se pudo descargar la imagen.' });
    }
}
