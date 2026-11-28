import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    extractSearchTokens,
    isSafePublicHttpUrl,
    normalizeSearchText,
    rankImageCandidates,
    scoreProductCandidate,
} from '../../src/utils/productImageMatcher';
import {
    buildMatchPreviewUrl,
    searchProductImages,
} from '../../src/services/productImageSearchService';
import { createLanServer } from '../../desktop/server/lanServer.mjs';

describe('Motor de coincidencias para fotos de productos (productImageMatcher)', () => {
    it('normaliza tildes, ñ, siglas con puntos y unidades separadas sin romper palabras', () => {
        expect(normalizeSearchText('Azúcar Doña Belén 1 kg')).toBe('azucar dona belen 1kg');
        expect(normalizeSearchText('Harina P.A.N. 500 gr')).toBe('harina pan 500g');
        expect(normalizeSearchText('Refresco 2 Lt')).toBe('refresco 2l');
    });

    it('protege palabras cortas (pan, sal) contra falsos positivos como empanada o pantene', () => {
        const q = extractSearchTokens('pan');
        expect(scoreProductCandidate(q, { name: 'Empanada de Queso Congelada' })).toBe(0);
        expect(scoreProductCandidate(q, { name: 'Shampoo Pantene Brillo 400ml' })).toBe(0);
        expect(scoreProductCandidate(q, { name: 'Harina Maiz Blanco Pan 1kg' })).toBeGreaterThan(0);
    });

    it('corrige errores de tipeo frecuentes en bodegas y prioriza coincidencia completa + peso', () => {
        const ranked = rankImageCandidates('Mayonesamavesa 500g', [
            { name: 'Mayonesa Kraft 445g', slug: 'mayonesa-kraft-445g', image_path: '/images/catalog/kraft.webp' },
            { name: 'Mayonesa Mavesa 175g', slug: 'mayonesa-mavesa-175g', image_path: '/images/catalog/mavesa-175.webp' },
            { name: 'Mayonesa Mavesa 500g', slug: 'mayonesa-mavesa-500g', image_path: '/images/catalog/mavesa-500.webp' },
        ]);
        expect(ranked[0].slug).toBe('mayonesa-mavesa-500g');
        expect(ranked[1].slug).toBe('mayonesa-mavesa-175g');
    });

    it('bloquea direcciones privadas, loopback y protocolos inseguros en isSafePublicHttpUrl (anti-SSRF)', () => {
        expect(isSafePublicHttpUrl('http://127.0.0.1:47800/lan/health')).toBe(false);
        expect(isSafePublicHttpUrl('http://localhost:3000/secret')).toBe(false);
        expect(isSafePublicHttpUrl('http://192.168.1.25/admin')).toBe(false);
        expect(isSafePublicHttpUrl('http://10.0.0.5/internal')).toBe(false);
        expect(isSafePublicHttpUrl('http://172.16.5.4/internal')).toBe(false);
        expect(isSafePublicHttpUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
        expect(isSafePublicHttpUrl('file:///etc/passwd')).toBe(false);
        expect(isSafePublicHttpUrl('https://instamarketca.com/wp-content/uploads/harina-pan.webp')).toBe(true);
    });
});

describe('Endpoints /api/search-image y /api/image-proxy en lanServer.mjs', () => {
    let srv;
    let mockExternalFetch;

    beforeAll(async () => {
        mockExternalFetch = vi.fn(async (url) => {
            const urlStr = String(url);
            if (urlStr.includes('instamarketca.com/wp-json/wc/store/v1/products')) {
                return new Response(
                    JSON.stringify([
                        {
                            name: 'Ponqué Chocoramo Tradicional 65g',
                            slug: 'ponque-chocoramo-tradicional-65g',
                            images: [{ src: 'https://instamarketca.com/uploads/chocoramo-65g.jpg' }],
                        },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            if (urlStr.includes('openfoodfacts.org') || urlStr.includes('bing.com')) {
                return new Response(JSON.stringify({ products: [] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (urlStr === 'https://instamarketca.com/uploads/chocoramo-65g.jpg') {
                const fakeWebp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
                return new Response(fakeWebp, {
                    status: 200,
                    headers: { 'content-type': 'image/webp' },
                });
            }
            throw new Error('Sin internet simulado');
        });

        srv = await createLanServer({
            port: 0,
            host: '127.0.0.1',
            enableDiscovery: false,
            enableWebImageFallback: true,
            imageSearchFetch: mockExternalFetch,
        });
    }, 60000);

    afterAll(async () => {
        await srv?.close();
    });

    it('responde instantáneamente desde el catálogo local (1.143 fotos) sin usar internet', async () => {
        mockExternalFetch.mockClear();
        const res = await fetch(`${srv.baseUrl}/api/search-image?q=${encodeURIComponent('7up 2L')}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.matches.length).toBeGreaterThan(0);
        expect(body.matches[0].dataUri).toMatch(/\/images\/catalog\/(?:.+\/)?7up-2l\.webp$/);
        expect(body.matches[0].source).toBe('local');
    });

    it('encuentra productos clásicos venezolanos como Harina PAN con tildes o puntos', async () => {
        const res = await fetch(`${srv.baseUrl}/api/search-image?q=${encodeURIComponent('Harina P.A.N. 1 kg')}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.matches.length).toBeGreaterThan(0);
        expect(body.matches[0].title.toLowerCase()).toContain('harina');
    });

    it('activa el fallback web ligero cuando un producto nuevo no existe en el catálogo local', async () => {
        const res = await fetch(`${srv.baseUrl}/api/search-image?q=${encodeURIComponent('Chocoramo 65g')}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.matches.some((m) => m.source === 'web' && m.title.includes('Chocoramo'))).toBe(true);
    });

    it('sirve archivos del catálogo local desde /images/catalog/ y bloquea SSRF en /api/image-proxy', async () => {
        const catRes = await fetch(`${srv.baseUrl}/images/catalog/7up-2l.webp`);
        expect(catRes.status).toBe(200);
        expect(catRes.headers.get('content-type')).toContain('image/webp');

        const ssrfRes = await fetch(`${srv.baseUrl}/api/image-proxy?url=${encodeURIComponent('http://127.0.0.1:47800/lan/health')}`);
        expect(ssrfRes.status).toBe(400);

        const okProxy = await fetch(
            `${srv.baseUrl}/api/image-proxy?url=${encodeURIComponent('https://instamarketca.com/uploads/chocoramo-65g.jpg')}&format=json`,
        );
        expect(okProxy.status).toBe(200);
        const proxyJson = await okProxy.json();
        expect(proxyJson.success).toBe(true);
        expect(proxyJson.dataUri).toMatch(/^data:image\/webp;base64,/);
    });

    it('en cliente cae al catálogo local offline si el endpoint de red no responde', async () => {
        const offlineFetch = vi.fn(async (url) => {
            if (String(url).includes('/api/search-image')) {
                throw new Error('Network offline');
            }
            if (String(url).endsWith('/images/catalog/catalog.json')) {
                return new Response(
                    JSON.stringify([
                        {
                            name: 'Aceite de Maiz Mazeite 1 Lt',
                            slug: 'aceite-de-maiz-mazeite-1-lt',
                            image_path: '/images/catalog/aceite-de-maiz-mazeite-1-lt.webp',
                        },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            return new Response('', { status: 404 });
        });

        const matches = await searchProductImages('Mazeite 1L', { fetchImpl: offlineFetch });
        expect(matches).toHaveLength(1);
        expect(matches[0].dataUri).toBe('/images/catalog/aceite-de-maiz-mazeite-1-lt.webp');
        expect(buildMatchPreviewUrl('https://instamarketca.com/foto.jpg')).toContain('/api/image-proxy?url=');
    });
});
