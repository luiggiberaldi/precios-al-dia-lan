#!/usr/bin/env node
/**
 * Arranca el servidor LAN en consola (sin interfaz Electron) para pruebas o PC servidor dedicada.
 * Uso: node scripts/lan/start-server.mjs [--port 47800] [--data ./lan-data]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLanServer, DEFAULT_LAN_PORT } from '../../desktop/server/lanServer.mjs';

const args = process.argv.slice(2);
function readArg(flag, fallback) {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const port = Number(readArg('--port', process.env.LAN_PORT || DEFAULT_LAN_PORT));
const dataDir = path.resolve(readArg('--data', process.env.LAN_DATA_DIR || path.join(process.cwd(), '.lan-data', 'db')));
const distCandidate = path.resolve(process.cwd(), 'dist');
const staticDir = fs.existsSync(distCandidate) ? distCandidate : null;

const server = await createLanServer({ port, dataDir, staticDir });
console.info(`[Precios al Día LAN] Servidor listo en:`);
console.info(`  Local:   ${server.baseUrl}`);
for (const u of server.urls) {
    console.info(`  Red LAN: ${u}`);
}
console.info(`  Datos:   ${dataDir}`);

const shutdown = async () => {
    console.info('\n[Precios al Día LAN] Cerrando servidor...');
    await server.close();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
