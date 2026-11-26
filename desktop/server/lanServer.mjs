/**
 * Servidor HTTP + SSE + descubrimiento UDP de Precios al Día LAN.
 *
 * Corre dentro de la PC Principal (Electron o standalone Node) y expone la base
 * local (lanDb.mjs) para que todas las cajas de la red local trabajen en tiempo real
 * sin necesitar internet.
 */
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createLanDb } from './lanDb.mjs';
import { createCloudBridge } from './cloudBridge.mjs';

export const LAN_PROTOCOL_VERSION = 1;
export const DEFAULT_LAN_PORT = 47800;
export const DEFAULT_DISCOVERY_PORT = 47801;
const DISCOVER_MAGIC = 'PDN_LAN_DISCOVER_V1';
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function getLanIpv4Addresses() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const list of Object.values(interfaces)) {
        for (const info of list || []) {
            if (info && info.family === 'IPv4' && !info.internal) {
                ips.push(info.address);
            }
        }
    }
    return ips;
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function readBody(req, limitBytes = MAX_JSON_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > limitBytes) {
                reject(Object.assign(new Error('Petición demasiado grande'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function readJsonBody(req) {
    const raw = await readBody(req);
    if (!raw.trim()) return {};
    try {
        return JSON.parse(raw);
    } catch {
        throw Object.assign(new Error('JSON inválido'), { status: 400 });
    }
}

function isLocalhostRequest(req) {
    const addr = req.socket?.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function bearerToken(req, urlObj) {
    const auth = req.headers.authorization || '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return urlObj?.searchParams.get('token') || null;
}

export async function createLanServer({
    port = DEFAULT_LAN_PORT,
    host = '0.0.0.0',
    dataDir = null,
    imagesDir = null,
    backupsDir = null,
    staticDir = null,
    migrationsDir = undefined,
    enableDiscovery = true,
    discoveryPort = DEFAULT_DISCOVERY_PORT,
    cloudUrl = process.env.PDN_CLOUD_BRIDGE_URL || '',
    cloudAnonKey = process.env.PDN_CLOUD_BRIDGE_KEY || '',
    cloudPollMs = 4000,
    cloudRpcCaller = null,
} = {}) {
    const lanDb = await createLanDb({ dataDir, migrationsDir });
    const resolvedImagesDir = imagesDir || (dataDir ? path.join(path.dirname(dataDir), 'pdn-lan-images') : null);
    const resolvedBackupsDir = backupsDir || (dataDir ? path.join(path.dirname(dataDir), 'pdn-lan-backups') : null);
    if (resolvedImagesDir) fs.mkdirSync(resolvedImagesDir, { recursive: true });
    if (resolvedBackupsDir) fs.mkdirSync(resolvedBackupsDir, { recursive: true });

    const memoryImages = new Map();
    const sseClients = new Set();
    let cloudBridge = null;

    function broadcastEvents(events) {
        if (Array.isArray(events) && events.length) {
            cloudBridge?.scheduleSnapshotPush?.();
        }
        if (!Array.isArray(events) || !events.length || !sseClients.size) return;
        for (const ev of events) {
            const payload = `event: db_change\ndata: ${JSON.stringify(ev)}\n\n`;
            for (const client of sseClients) {
                try {
                    client.res.write(payload);
                } catch {
                    sseClients.delete(client);
                }
            }
        }
    }

    cloudBridge = createCloudBridge({
        lanDb,
        cloudUrl,
        cloudAnonKey,
        pollIntervalMs: cloudPollMs,
        rpcCaller: cloudRpcCaller,
        onBroadcastEvents: broadcastEvents,
    });
    await cloudBridge.initFromDb();

    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Vary', 'Origin');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
        const pathname = urlObj.pathname;

        try {
            if (req.method === 'GET' && pathname === '/lan/health') {
                const summary = await lanDb.getServerSummary();
                const addr = server.address();
                const activePort = typeof addr === 'object' && addr ? addr.port : port;
                const ips = getLanIpv4Addresses();
                sendJson(res, 200, {
                    ok: true,
                    edition: 'lan',
                    protocolVersion: LAN_PROTOCOL_VERSION,
                    serverTime: new Date().toISOString(),
                    port: activePort,
                    urls: ips.map((ip) => `http://${ip}:${activePort}`),
                    ...summary,
                });
                return;
            }

            // ── Auth ────────────────────────────────────────────────────────
            if (req.method === 'POST' && pathname === '/lan/auth/device') {
                const session = await lanDb.createDeviceSession();
                sendJson(res, 200, session);
                return;
            }

            if (req.method === 'POST' && pathname === '/lan/auth/owner/signup') {
                const { email, password } = await readJsonBody(req);
                const session = await lanDb.signUpOwner(email, password);
                sendJson(res, 200, session);
                return;
            }

            if (req.method === 'POST' && pathname === '/lan/auth/owner/signin') {
                const { email, password } = await readJsonBody(req);
                const session = await lanDb.signInOwner(email, password);
                sendJson(res, 200, session);
                return;
            }

            if (req.method === 'POST' && pathname === '/lan/auth/owner/signout') {
                const token = bearerToken(req, urlObj);
                await lanDb.signOutToken(token);
                sendJson(res, 200, { ok: true });
                return;
            }

            if (req.method === 'POST' && pathname === '/lan/auth/owner/password') {
                const token = bearerToken(req, urlObj);
                const session = await lanDb.getSessionByToken(token);
                if (!session) {
                    sendJson(res, 401, { error: 'Sesión no válida' });
                    return;
                }
                const { password } = await readJsonBody(req);
                const out = await lanDb.updateOwnerPassword(session.user, password);
                sendJson(res, 200, out);
                return;
            }

            if (req.method === 'POST' && pathname === '/lan/auth/local-owner') {
                if (!isLocalhostRequest(req)) {
                    sendJson(res, 403, { error: 'Solo disponible desde la Caja Principal.' });
                    return;
                }
                const session = await lanDb.bootstrapLocalOwner();
                sendJson(res, 200, session);
                return;
            }

            if (req.method === 'POST' && pathname === '/lan/auth/owner-pin') {
                if (!isLocalhostRequest(req)) {
                    sendJson(res, 403, { error: 'Solo disponible desde la Caja Principal.' });
                    return;
                }
                const { pin } = await readJsonBody(req);
                const session = await lanDb.signInLocalOwnerByPin(pin);
                sendJson(res, 200, session);
                return;
            }

            if (req.method === 'POST' && pathname === '/lan/auth/local-reset-pin') {
                if (!isLocalhostRequest(req)) {
                    sendJson(res, 403, { error: 'Solo disponible desde la Caja Principal.' });
                    return;
                }
                const { pin } = await readJsonBody(req);
                const session = await lanDb.resetLocalOwnerPin(pin);
                sendJson(res, 200, session);
                return;
            }

            if (req.method === 'GET' && pathname === '/lan/auth/session') {
                const token = bearerToken(req, urlObj);
                const session = await lanDb.getSessionByToken(token);
                sendJson(res, 200, { session });
                return;
            }

            // ── Vinculación por QR / Código de 6 dígitos ────────────────────
            if (req.method === 'POST' && pathname === '/lan/pairing/code') {
                const token = bearerToken(req, urlObj);
                const session = await lanDb.getSessionByToken(token);
                if (!isLocalhostRequest(req) && (!session || session.user.anonymous)) {
                    sendJson(res, 401, { error: 'Solo la Caja Principal o el dueño pueden generar códigos.' });
                    return;
                }
                const { accountId } = await readJsonBody(req);
                const pairing = await lanDb.createPairingCode({ accountId });
                const addr = server.address();
                const activePort = typeof addr === 'object' && addr ? addr.port : port;
                const urls = getLanIpv4Addresses().map((ip) => `http://${ip}:${activePort}`);
                sendJson(res, 200, { ...pairing, urls, primaryUrl: urls[0] || `http://127.0.0.1:${activePort}` });
                return;
            }

            if (req.method === 'POST' && pathname === '/lan/pairing/claim') {
                const { code } = await readJsonBody(req);
                const claimed = await lanDb.claimPairingCode(code);
                sendJson(res, 200, claimed);
                return;
            }

            // ── Consultas y RPCs compatibles con src/nube ───────────────────
            if (req.method === 'POST' && pathname === '/lan/query') {
                const token = bearerToken(req, urlObj);
                const session = await lanDb.getSessionByToken(token);
                const spec = await readJsonBody(req);
                const result = await lanDb.runSelectQuery(session?.user || null, spec);
                sendJson(res, 200, result);
                return;
            }

            if (req.method === 'POST' && pathname.startsWith('/lan/rpc/')) {
                const fn = decodeURIComponent(pathname.slice('/lan/rpc/'.length));
                const token = bearerToken(req, urlObj);
                const session = await lanDb.getSessionByToken(token);
                const args = await readJsonBody(req);
                const { data, error, events } = await lanDb.runRpc(session?.user || null, fn, args);
                if (!error && events?.length) {
                    broadcastEvents(events);
                }
                sendJson(res, 200, { data, error });
                return;
            }

            // ── Stream en vivo (SSE) ────────────────────────────────────────
            if (req.method === 'GET' && pathname === '/lan/events') {
                const token = bearerToken(req, urlObj);
                const session = await lanDb.getSessionByToken(token);
                if (!session) {
                    sendJson(res, 401, { error: 'Token requerido para escuchar eventos' });
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache, no-transform',
                    Connection: 'keep-alive',
                });
                res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, userId: session.user.id })}\n\n`);
                const entry = { res, userId: session.user.id };
                sseClients.add(entry);
                req.on('close', () => {
                    sseClients.delete(entry);
                });
                return;
            }

            // ── Imágenes de productos locales ───────────────────────────────
            if (req.method === 'POST' && pathname === '/lan/images') {
                const token = bearerToken(req, urlObj);
                const session = await lanDb.getSessionByToken(token);
                if (!session) {
                    sendJson(res, 401, { error: 'Sesión requerida' });
                    return;
                }
                const { dataUri, id } = await readJsonBody(req);
                const match = String(dataUri || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i);
                if (!match) {
                    sendJson(res, 400, { error: 'Formato de imagen inválido' });
                    return;
                }
                const buf = Buffer.from(match[2], 'base64');
                if (!buf.length || buf.length > MAX_IMAGE_BYTES) {
                    sendJson(res, 400, { error: 'La imagen excede el tamaño máximo permitido (2 MB)' });
                    return;
                }
                const mime = match[1].toLowerCase();
                const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
                const safeId = String(id || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
                const fileName = `${safeId}.${ext}`;
                if (resolvedImagesDir) {
                    fs.writeFileSync(path.join(resolvedImagesDir, fileName), buf);
                } else {
                    memoryImages.set(fileName, { mime, buf });
                }
                sendJson(res, 200, { ok: true, path: `/lan/images/${fileName}` });
                return;
            }

            if (req.method === 'GET' && pathname.startsWith('/lan/images/')) {
                const fileName = path.basename(pathname.slice('/lan/images/'.length));
                const ext = path.extname(fileName).toLowerCase();
                const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
                if (resolvedImagesDir) {
                    const target = path.join(resolvedImagesDir, fileName);
                    if (!fs.existsSync(target)) {
                        sendJson(res, 404, { error: 'Imagen no encontrada' });
                        return;
                    }
                    const buf = fs.readFileSync(target);
                    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
                    res.end(buf);
                    return;
                }
                const mem = memoryImages.get(fileName);
                if (!mem) {
                    sendJson(res, 404, { error: 'Imagen no encontrada' });
                    return;
                }
                res.writeHead(200, { 'Content-Type': mem.mime, 'Cache-Control': 'public, max-age=86400' });
                res.end(mem.buf);
                return;
            }

            // ── Pasaporte Offline, Licencia RSA y Restaurar respaldo ────────
            if (req.method === 'GET' && pathname === '/lan/device/offline-passport') {
                const token = bearerToken(req, urlObj);
                const session = await lanDb.getSessionByToken(token);
                if (!session) {
                    sendJson(res, 401, { error: 'Sesión requerida' });
                    return;
                }
                const passport = await lanDb.buildOfflinePassport(session.user);
                sendJson(res, 200, passport);
                return;
            }

            if (req.method === 'POST' && pathname === '/lan/license/apply') {
                const token = bearerToken(req, urlObj);
                const session = await lanDb.getSessionByToken(token);
                if (!session) {
                    sendJson(res, 401, { error: 'Sesión del dueño requerida' });
                    return;
                }
                const { licenseToken } = await readJsonBody(req);
                const license = await lanDb.applyOfflineLicenseToken(session.user, licenseToken);
                sendJson(res, 200, { ok: true, license });
                return;
            }

            if (req.method === 'GET' && pathname === '/lan/backup/snapshot') {
                const token = bearerToken(req, urlObj);
                const session = await lanDb.getSessionByToken(token);
                if (!isLocalhostRequest(req) && (!session || session.user.anonymous)) {
                    sendJson(res, 401, { error: 'Solo el dueño o la Caja Principal pueden exportar respaldos.' });
                    return;
                }
                const snapshot = await lanDb.exportJsonSnapshot();
                sendJson(res, 200, snapshot);
                return;
            }

            if (req.method === 'POST' && pathname === '/lan/backup/restore') {
                const token = bearerToken(req, urlObj);
                const session = await lanDb.getSessionByToken(token);
                if (!isLocalhostRequest(req) && (!session || session.user.anonymous)) {
                    sendJson(res, 401, { error: 'Solo el dueño o la Caja Principal pueden restaurar respaldos.' });
                    return;
                }
                const snapshot = await readJsonBody(req);
                const summary = await lanDb.restoreJsonSnapshot(snapshot);
                sendJson(res, 200, { ok: true, summary });
                return;
            }

            // ── Puente de internet para Modo Supervisor remoto ──────────────
            if (pathname.startsWith('/lan/bridge/')) {
                const token = bearerToken(req, urlObj);
                const session = await lanDb.getSessionByToken(token);
                if (!isLocalhostRequest(req) && (!session || session.user.anonymous)) {
                    sendJson(res, 401, { error: 'Solo la Caja Principal o el dueño administran el puente de internet.' });
                    return;
                }
                if (req.method === 'GET' && pathname === '/lan/bridge/status') {
                    sendJson(res, 200, cloudBridge.getPublicStatus());
                    return;
                }
                if (req.method === 'POST' && pathname === '/lan/bridge/setup') {
                    const body = await readJsonBody(req);
                    const status = await cloudBridge.setupBridge(body);
                    sendJson(res, 200, { ok: true, status });
                    return;
                }
                if (req.method === 'POST' && pathname === '/lan/bridge/disable') {
                    const status = await cloudBridge.disableBridge();
                    sendJson(res, 200, { ok: true, status });
                    return;
                }
                if (req.method === 'POST' && pathname === '/lan/bridge/sync') {
                    const resSync = await cloudBridge.syncOnce();
                    sendJson(res, 200, { ok: true, ...resSync, status: cloudBridge.getPublicStatus() });
                    return;
                }
            }

            // ── Servir web estática en red local (para Supervisor móvil/PC) ─
            if (req.method === 'GET' && staticDir && !pathname.startsWith('/lan/') && !pathname.startsWith('/api/')) {
                const resolvedRoot = path.resolve(staticDir);
                const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
                let target = path.resolve(resolvedRoot, rel);
                if (!target.startsWith(resolvedRoot)) {
                    sendJson(res, 403, { error: 'Ruta prohibida' });
                    return;
                }
                if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
                    target = path.join(resolvedRoot, 'index.html');
                }
                if (fs.existsSync(target) && fs.statSync(target).isFile()) {
                    const ext = path.extname(target).toLowerCase();
                    const mimeMap = {
                        '.html': 'text/html; charset=utf-8',
                        '.js': 'application/javascript; charset=utf-8',
                        '.mjs': 'application/javascript; charset=utf-8',
                        '.css': 'text/css; charset=utf-8',
                        '.json': 'application/json; charset=utf-8',
                        '.webmanifest': 'application/manifest+json; charset=utf-8',
                        '.png': 'image/png',
                        '.jpg': 'image/jpeg',
                        '.jpeg': 'image/jpeg',
                        '.webp': 'image/webp',
                        '.svg': 'image/svg+xml',
                        '.ico': 'image/x-icon',
                        '.woff2': 'font/woff2',
                        '.woff': 'font/woff',
                    };
                    const contentType = mimeMap[ext] || 'application/octet-stream';
                    if (target.includes(`.asar${path.sep}`) || target.includes('.asar/')) {
                        const buf = fs.readFileSync(target);
                        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': buf.length });
                        res.end(buf);
                    } else {
                        res.writeHead(200, { 'Content-Type': contentType });
                        fs.createReadStream(target).pipe(res);
                    }
                    return;
                }
            }

            sendJson(res, 404, { error: 'Ruta LAN no encontrada' });
        } catch (err) {
            sendJson(res, err?.status || 500, { error: err?.message || 'Error interno del servidor LAN' });
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;

    const keepaliveTimer = setInterval(() => {
        for (const client of sseClients) {
            try {
                client.res.write(': keepalive\n\n');
            } catch {
                sseClients.delete(client);
            }
        }
    }, 20_000);
    keepaliveTimer.unref?.();

    let discoverySocket = null;
    if (enableDiscovery) {
        try {
            discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            discoverySocket.on('message', async (msg, rinfo) => {
                if (msg.toString('utf8').trim() !== DISCOVER_MAGIC) return;
                const summary = await lanDb.getServerSummary().catch(() => ({}));
                const ips = getLanIpv4Addresses();
                const reply = JSON.stringify({
                    magic: 'PDN_LAN_HERE_V1',
                    protocolVersion: LAN_PROTOCOL_VERSION,
                    port: boundPort,
                    urls: ips.map((ip) => `http://${ip}:${boundPort}`),
                    ...summary,
                });
                discoverySocket.send(Buffer.from(reply), rinfo.port, rinfo.address);
            });
            discoverySocket.on('error', () => {
                // Si el puerto UDP ya está ocupado en esta máquina, seguimos sin discovery UDP.
            });
            discoverySocket.bind(discoveryPort);
        } catch {
            discoverySocket = null;
        }
    }

    async function saveDiskBackupNow() {
        if (!resolvedBackupsDir) return null;
        const snapshot = await lanDb.exportJsonSnapshot();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filePath = path.join(resolvedBackupsDir, `respaldo-lan-${stamp}.json`);
        fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
        const files = fs
            .readdirSync(resolvedBackupsDir)
            .filter((f) => f.startsWith('respaldo-lan-') && f.endsWith('.json'))
            .sort();
        while (files.length > 14) {
            const oldest = files.shift();
            fs.unlinkSync(path.join(resolvedBackupsDir, oldest));
        }
        return filePath;
    }

    async function close() {
        cloudBridge?.stop?.();
        clearInterval(keepaliveTimer);
        for (const client of sseClients) {
            try {
                client.res.end();
            } catch {
                // ignorar al cerrar
            }
        }
        sseClients.clear();
        if (discoverySocket) {
            try {
                discoverySocket.close();
            } catch {
                // ignorar
            }
        }
        await new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
        });
        await lanDb.close();
    }

    return {
        port: boundPort,
        baseUrl: `http://127.0.0.1:${boundPort}`,
        urls: getLanIpv4Addresses().map((ip) => `http://${ip}:${boundPort}`),
        lanDb,
        cloudBridge,
        saveDiskBackupNow,
        close,
    };
}

export function discoverLanServers({ timeoutMs = 1500, discoveryPort = DEFAULT_DISCOVERY_PORT } = {}) {
    return new Promise((resolve) => {
        const found = new Map();
        const socket = dgram.createSocket('udp4');
        const finish = () => {
            try {
                socket.close();
            } catch {
                // ignorar
            }
            resolve([...found.values()]);
        };
        const timer = setTimeout(finish, timeoutMs);
        socket.on('error', () => {
            clearTimeout(timer);
            finish();
        });
        socket.on('message', (msg, rinfo) => {
            try {
                const parsed = JSON.parse(msg.toString('utf8'));
                if (parsed?.magic !== 'PDN_LAN_HERE_V1') return;
                const preferredUrl = `http://${rinfo.address}:${parsed.port}`;
                found.set(parsed.lanId || preferredUrl, {
                    lanId: parsed.lanId || null,
                    businessName: parsed.businessName || 'Caja Principal',
                    hasAccount: Boolean(parsed.hasAccount),
                    protocolVersion: parsed.protocolVersion || 1,
                    url: preferredUrl,
                    urls: parsed.urls || [preferredUrl],
                });
            } catch {
                // ignorar paquetes ajenos
            }
        });
        socket.bind(0, () => {
            try {
                socket.setBroadcast(true);
                const buf = Buffer.from(DISCOVER_MAGIC);
                socket.send(buf, discoveryPort, '255.255.255.255');
                socket.send(buf, discoveryPort, '127.0.0.1');
            } catch {
                // ignorar si la interfaz no permite broadcast
            }
        });
    });
}
