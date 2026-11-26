// Resume la salida de simular-caja.mjs: totales por motivo y por minuto.
import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const m = j.minutosReales;
console.log(JSON.stringify(j.config), 'ventas', j.ventas, 'fiados', j.fiados, 'min', m.toFixed(2));
let tot = { req: 0, body: 0, gzip: 0, headers: 0, rtMsgs: 0, rtBytes: 0 };
for (const [k, v] of Object.entries(j.regimen).sort()) {
    for (const f of Object.keys(tot)) tot[f] += v[f];
    console.log(k.padEnd(58), `req ${v.req}`.padEnd(9), `crudo ${(v.body / 1024).toFixed(1)} KB`.padEnd(18), `gzip+cab ${((v.gzip + v.headers) / 1024).toFixed(1)} KB`.padEnd(20), v.rtMsgs ? `rt ${v.rtMsgs} msg ${(v.rtBytes / 1024).toFixed(1)} KB` : '');
}
const perCajaMin = (x) => x / m / j.config.cajas;
console.log('TOTAL', JSON.stringify(tot));
console.log('por caja y minuto: req', perCajaMin(tot.req).toFixed(1), '| crudo KB', (perCajaMin(tot.body + tot.rtBytes) / 1024).toFixed(1), '| cable KB', (perCajaMin(tot.gzip + tot.headers + tot.rtBytes) / 1024).toFixed(1), '| rt msgs', perCajaMin(tot.rtMsgs).toFixed(1));
