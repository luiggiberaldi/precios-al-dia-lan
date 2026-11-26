# Plan de Implementación: Precios al Día LAN (100 % Offline-First + Modo Supervisor PC/Móvil + Producción)

> **Para el ejecutor:** Usar ejecución tarea por tarea con TDD (prueba que falla → código mínimo → prueba que pasa → commit).

**Meta:** Completar **Precios al Día LAN** para que todas las cajas PC del local arranquen y vendan 100 % offline-first (incluso si la PC Principal está apagada), permitir restaurar respaldos ante fallos de equipo, habilitar licencia RSA offline para 3+ cajas y entregar un **Modo Supervisor con capacidad de edición** usable desde PC y celular (dentro del local sin internet y fuera del local mediante puente liviano en la nube).

**Arquitectura:**
1. **Local (Solo PCs con Electron):** La PC Principal corre `desktop/server/lanServer.mjs` + Postgres local (`lanDb.mjs` con PGlite y las 17 migraciones SQL). Las cajas adicionales guardan un **Pasaporte Offline** firmado localmente para poder arrancar y validar PINs aunque la PC Principal esté apagada.
2. **Supervisor PC + Móvil dentro del local (0 % internet):** `lanServer.mjs` sirve el build estático `dist/` sobre HTTP local (`http://IP:47800`) y reemplaza llamadas dependientes de HTTPS (`crypto.randomUUID()`) por generadores compatibles con HTTP local, mientras `NubeOwnerDashboard.jsx` gana acciones directas de edición (productos, precios, stock, tasa, anulaciones, abonos, equipo).
3. **Supervisor PC + Móvil fuera del local (puente híbrido opcional):** Un módulo en `desktop/server/cloudBridge.mjs` (solo en la PC Principal) publica resúmenes incrementales y escucha una cola de órdenes remotas (`lan_supervisor_commands`) en Supabase cuando el local tiene internet, ejecutándolas localmente en `lanDb.mjs` sin detener jamás a las cajas del mostrador.

**Stack:** Vite + React 19, Electron 33, Node.js ESM (`desktop/server/`), PGlite (`@electric-sql/pglite`), Vitest + JSDOM, Tailwind CSS.

---

## Guía rápida para el dueño (en español sencillo)

- **Pasaporte Offline:** Es una «cédula temporal» guardada dentro de cada caja PC. Si la computadora principal se apaga o se daña el router, las demás cajas pueden encender igual, pedir el PIN del cajero y seguir vendiendo hasta 72 horas sin trancarse.
- **Restaurar respaldo:** El botón para recuperar en una PC nueva todo el inventario, ventas y fiados desde el archivo de respaldo guardado el día anterior.
- **Supervisor en red local (sin internet):** El dueño abre la dirección de la Caja Principal desde su teléfono o laptop dentro de la tienda para cambiar precios, sumar mercancía, cambiar la tasa o anular ventas sin gastar datos ni internet.
- **Puente nube (desde la calle):** Un «buzón de recados» en internet que solo revisa la Caja Principal: el dueño manda un cambio desde su casa y la PC Principal lo aplica en el local apenas tenga señal.

---

## Fase 1 — Cajas PC 100 % Offline-First (Arranque sin red + Restauración)

### Tarea 1: Generador UUID seguro para HTTP local (`safeUuid.js`)
**Por qué:** En navegador móvil sobre `http://192.168.x.x:47800` (sin candado HTTPS), `crypto.randomUUID()` puede no existir (`stockService.js:289`), rompiendo movimientos de stock del Supervisor desde el celular en Wi-Fi local.

**Archivos:**
- Crear: `src/utils/safeUuid.js`
- Modificar: `src/nube/stockService.js:287-295`
- Test: `tests/lan/safeUuid.test.js`

**Paso 1: Escribir la prueba que falla**
```js
import { describe, it, expect } from 'vitest';
import { safeUuid } from '../../src/utils/safeUuid';

describe('safeUuid', () => {
    it('genera UUID v4 válido aunque crypto.randomUUID no exista (HTTP local)', () => {
        const fakeCrypto = { getRandomValues: (arr) => arr.fill(7) };
        const id = safeUuid(fakeCrypto);
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});
```

**Paso 2: Verificar que falla**
- Ejecutar: `bun run test tests/lan/safeUuid.test.js`
- Esperado: FAIL (`Cannot find module '../../src/utils/safeUuid'`).

**Paso 3: Implementación mínima**
- En `src/utils/safeUuid.js`: usar `cryptoObj.randomUUID()` si existe; si no, `cryptoObj.getRandomValues(new Uint8Array(16))` formateando bits v4 (`0x40` y `0x80`); fallback final con `Math.random` si no hay WebCrypto.
- En `src/nube/stockService.js:289`: reemplazar `crypto.randomUUID()` por `safeUuid()`.

**Paso 4: Verificar que pasa y commit**
- Ejecutar: `bun run test tests/lan/safeUuid.test.js && bun run test:nube`
- Commit: `fix(lan): safeUuid compatible con HTTP en red local`

---

### Tarea 2: Pasaporte Offline en el servidor y cliente (`offlinePassport.js`)
**Por qué:** Permitir que cualquier Caja PC arranque, muestre empleados y valide PINs aunque la Caja Principal o el Wi-Fi estén apagados al encender Windows.

**Archivos:**
- Modificar: `desktop/server/lanDb.mjs` (nuevo método `buildOfflinePassport(user)`)
- Modificar: `desktop/server/lanServer.mjs` (nueva ruta `GET /lan/device/offline-passport`)
- Crear: `src/lan/offlinePassport.js` (`saveOfflinePassport`, `readOfflinePassport`, `verifyOfflinePin`, `isPassportValid`)
- Modificar: `src/lan/lanClient.js` (método `client.lan.fetchOfflinePassport()`)
- Test: `tests/lan/offlinePassport.test.js`

**Paso 1: Escribir la prueba que falla**
- Probar contra `createLanServer`:
  1. Caja A autenticada llama `client.lan.fetchOfflinePassport()` → devuelve `{ device, account, license, sedes, members, verifiers, issuedAt, expiresAt }` (sin exponer `pin_hash` real de Postgres: usa un verificador `scrypt`/`sha256` con salt por miembro).
  2. `saveOfflinePassport` guarda en almacenamiento local y `verifyOfflinePin(passport, memberId, '142536')` devuelve `{ valid: true, member }`, mientras un PIN incorrecto devuelve `{ valid: false }`.
  3. Un pasaporte vencido (`expiresAt` pasado de 72 h) hace que `isPassportValid(passport)` devuelva `false`.

**Paso 2: Verificar que falla**
- Ejecutar: `bun run test tests/lan/offlinePassport.test.js` → FAIL.

**Paso 3: Implementación mínima**
- En `lanDb.mjs`: `buildOfflinePassport(user)` valida `account_devices` activo por `auth_user_id = user.id`, consulta `account_members` con `service_role` interno y genera un verificador derivado por miembro (`salt + sha256(salt + ':' + memberId + ':' + ...)` o verificador PBKDF2/scrypt compatible con `crypto.subtle` / JS puro para funcionar tanto en Electron como en HTTP).
- Nota de seguridad: usar JS puro `sha256` o `scrypt` para que no dependa de `crypto.subtle` y limitar intentos fallidos en el pasaporte local igual que `LOGIN_RATE_LIMIT`.

**Paso 4: Verificar que pasa y commit**
- Ejecutar: `bun run test tests/lan/offlinePassport.test.js` → PASS.
- Commit: `feat(lan): pasaporte offline firmado por dispositivo para arranque sin red`

---

### Tarea 3: Arranque Offline en `NubeGate.jsx` + re-autenticación automática al volver la red
**Archivos:**
- Modificar: `src/nube/NubeGate.jsx`
- Test: `tests/lan/lanOfflineBoot.test.jsx`

**Paso 1: Escribir la prueba que falla**
- Simular Caja B previamente conectada (pasaporte guardado en `localStorage`), luego apagar el servidor LAN (`await srv.close()`), montar `<NubeGate><div data-testid="pos-open" /></NubeGate>`, verificar que:
  1. No cae a pantalla de error *"No pudimos conectar"*.
  2. Muestra `MemberPickerScreen` con el aviso discreto *"Modo sin conexión con Caja Principal"*.
  3. Al ingresar el PIN correcto abre `<div data-testid="pos-open" />`.
  4. Al volver a encender el servidor LAN, intercambia la sesión en segundo plano y obtiene token real de servidor sin pedir el PIN otra vez.

**Paso 2: Verificar que falla**
- Ejecutar: `bun run test tests/lan/lanOfflineBoot.test.jsx` → FAIL (muestra *"No pudimos conectar"*).

**Paso 3: Implementación mínima**
- En `NubeGate.jsx`:
  - Tras `refresh()` exitoso en modo LAN, llamar en segundo plano a `device.lan.fetchOfflinePassport()` y guardar con `saveOfflinePassport()`.
  - Si `refresh()` falla por error de red (`isNetworkError`) en modo LAN y existe pasaporte vigente (`isPassportValid`), cargar `status`, `license` y `members` del pasaporte y pasar a `elegir` (o `listo` si `readMemberSession()` sigue vigente).
  - En `handlePin`, si falla por red y hay pasaporte válido, validar con `verifyOfflinePin()`, guardar `offlinePinRef.current = pin` en memoria (nunca en disco) y abrir `phase = 'listo'`.
  - Cuando `useNubeSync` o el timer periódico detecten que la Caja Principal volvió y la sesión actual tiene `offline: true`, llamar `svc.loginWithPin(device, memberId, offlinePinRef.current)` para obtener token real y limpiar `offlinePinRef`.

**Paso 4: Verificar que pasa y commit**
- Ejecutar: `bun run test tests/lan/lanOfflineBoot.test.jsx && bun run test:lan` → PASS.
- Commit: `feat(lan): arranque 100% offline-first en NubeGate con intercambio automático al reconectar`

---

### Tarea 4: Restauración completa de respaldo en Caja Principal (`F-21`) + Licencia RSA Offline (`F-22`)
**Archivos:**
- Modificar: `desktop/server/lanDb.mjs` (`restoreJsonSnapshot(snapshot)` y `applyOfflineLicenseToken(ownerUser, token)`)
- Modificar: `desktop/server/lanServer.mjs` (`POST /lan/backup/restore` y `POST /lan/license/apply`)
- Modificar: `src/lan/lanClient.js` (`restoreSnapshot(json)` y `applyLicense(token)`)
- Modificar: `src/lan/LanPairingModal.jsx` (botón **"Restaurar respaldo"**, input de token RSA y estado actual de licencia)
- Test: `tests/lan/lanRestoreAndLicense.test.js`

**Paso 1: Escribir la prueba que falla**
- Probar:
  1. Exportar snapshot de Servidor 1 (`accounts`, `sedes`, `account_members`, `account_devices`, `account_records`, `stock_movements`, `stock_levels`, `sales`, `customer_movements`, `customer_balances`), levantar Servidor 2 vacío, llamar `restoreSnapshot(snap)` → Servidor 2 queda idéntico (mismo stock, fiados, empleados y cajas).
  2. Aplicar token firmado RSA con clave privada de prueba (`product: 'lan'`, `maxCajas: 6`, `status: 'active'`) → `account_licenses.max_cajas` sube de `2` a `6` y permite registrar Caja C; un token manipulado o sin firma falla.

**Paso 2: Verificar que falla**
- Ejecutar: `bun run test tests/lan/lanRestoreAndLicense.test.js` → FAIL.

**Paso 3: Implementación mínima**
- `restoreJsonSnapshot(snapshot)`: valida estructura `preciosaldia-lan-snapshot-v1`, inserta dentro de una sola transacción `service_role` deshabilitando temporalmente triggers de solo-agregar o restaurando en orden referencial (`auth.users` sintéticos si faltan, `accounts`, `sedes`, `account_licenses`, `account_members`, `account_devices`, `account_records`, `stock_movements`, `stock_levels`, `device_counters`, `sales`, `stock_discrepancies`, `customer_movements`, `customer_balances`, `cash_shifts`), y ejecuta `nube_private.verify_invariants()` al final para garantizar cuadre exacto.
- `applyOfflineLicenseToken`: verifica firma `RSASSA-PKCS1-v1_5` SHA-256 con `node:crypto.verify` contra `PUBLIC_KEY_JWK` (misma llave pública de `src/security/tokenCrypto.js`), valida expiración y actualiza `account_licenses`.

**Paso 4: Verificar que pasa y commit**
- Ejecutar: `bun run test tests/lan/lanRestoreAndLicense.test.js && bun run test:lan` → PASS.
- Commit: `feat(lan): restauración completa de respaldo y licencia RSA offline`

---

## Fase 2 — Modo Supervisor con Cambios dentro del Local (PC + Móvil sin internet)

### Tarea 5: Servir la app web desde la Caja Principal (`lanServer.mjs`) + acceso móvil en Wi-Fi
**Por qué:** Para que el dueño abra `http://IP-CAJA-PRINCIPAL:47800` desde cualquier celular (Android/iPhone) o PC dentro de la tienda sin internet y sin instalar nada, apuntando automáticamente a esa misma Caja Principal.

**Archivos:**
- Modificar: `desktop/server/lanServer.mjs` (servir archivos estáticos de `dist/` para rutas que no empiecen con `/lan/` ni `/api/`, con fallback a `index.html`)
- Modificar: `src/lan/lanConfig.js` (auto-detectar `window.location.origin` cuando se abre desde `http://IP:47800` y no hay URL guardada)
- Modificar: `src/lan/LanPairingModal.jsx` (mostrar botón/QR específico **"Abrir Supervisor en móvil"** apuntando a `http://IP:47800/?supervisor=1`)
- Test: `tests/lan/lanStaticServe.test.js`

**Paso 1: Escribir la prueba que falla**
- Iniciar `createLanServer({ staticDir })` apuntando a una carpeta con `index.html` de prueba → `GET /` devuelve `200 OK` (`text/html`), `GET /assets/app.js` devuelve `200 OK` (`application/javascript`), y `GET /lan/health` sigue devolviendo JSON.
- En JSDOM con `window.location` apuntando a `http://192.168.1.50:47800`, `getLanServerUrl()` devuelve automáticamente `http://192.168.1.50:47800` sin obligar al dueño a teclear la IP.

**Paso 2: Verificar que falla**
- Ejecutar: `bun run test tests/lan/lanStaticServe.test.js` → FAIL (`404`).

**Paso 3: Implementación mínima**
- En `lanServer.mjs`: resolver ruta segura dentro de `staticDir` (evitando path traversal `..`), mapear MIME (`.html`, `.js`, `.css`, `.png`, `.webp`, `.woff2`, `.svg`, `.json`) y devolver `index.html` en rutas SPA.

**Paso 4: Verificar que pasa y commit**
- Ejecutar: `bun run test tests/lan/lanStaticServe.test.js` → PASS.
- Commit: `feat(lan): servir interfaz web desde Caja Principal para Supervisor móvil en LAN`

---

### Tarea 6: Supervisor con edición real en `NubeOwnerDashboard.jsx` (Productos, Precios, Stock, Tasa, Anulación y Clientes)
**Por qué:** Convertir `NubeOwnerDashboard.jsx` (actualmente solo lectura) en un centro de control móvil y PC para que el dueño o administrador haga cambios reales sin tocar cajas registradoras.

**Archivos:**
- Modificar: `src/nube/ownerDashboard.js` (funciones puras `saveSupervisorProduct`, `adjustSupervisorStock`, `updateSupervisorRate`, `voidSupervisorSale`, `recordSupervisorCustomerPayment` usando las RPC reales `push_records_v2`, `process_stock_movements`, `process_void`, `push_customer_movements` y la sesión PIN del dueño/admin)
- Modificar: `src/nube/NubeOwnerDashboard.jsx` (pestañas/modales limpios responsive móvil+PC: editar precio/nombre/crear producto, botón +/− compra/ajuste de stock, modal cambiar tasa, botón anular venta con confirmación, botón abonar deuda de cliente, y pestaña rápida **Tasa**)
- Modificar: `src/nube/NubeGate.jsx:356-366` (pasar `sessionToken` y `memberRole` a `NubeOwnerDashboard` + suscribir refresco automático por SSE cuando cambian stock/registros/saldos)
- Test: `tests/lan/lanSupervisorActions.test.jsx`

**Paso 1: Escribir las pruebas que fallan**
- Contra `createLanServer` real:
  1. Dueño entra en equipo `consulta` (Supervisor) → crea o edita precio de `Harina PAN` → `account_records` sube versión y Caja A recibe evento SSE.
  2. Dueño suma `+10` unidades en Inventario (`COMPRA`) → `stock_levels` sube exactamente `+10` y Caja A recibe SSE.
  3. Dueño cambia tasa manual a `45.50` → `pdn_rate_v1` se actualiza en `account_records` y baja a las cajas.
  4. Dueño anula venta `#A-00001` desde Supervisor → estado pasa a `anulada` y el stock regresa a `stock_levels`.
  5. Dueño registra abono `$5.00` a cliente → `customer_balances` refleja la reducción de deuda.

**Paso 2: Verificar que falla**
- Ejecutar: `bun run test tests/lan/lanSupervisorActions.test.jsx` → FAIL.

**Paso 3: Implementación mínima**
- Implementar helpers en `src/nube/ownerDashboard.js` reutilizando `dinero.js` (`round2`, `round3`, `round4`) y pasar sesión PIN (`readMemberSession()?.token`) para que cada cambio pase por la validación de rol en Postgres.
- Conectar UI táctil móvil + escritorio en `NubeOwnerDashboard.jsx` y mantener recarga automática por SSE (`keepChannel`).

**Paso 4: Verificar que pasa y commit**
- Ejecutar: `bun run test tests/lan/lanSupervisorActions.test.jsx && bun run test:nube && bun run test:lan` → PASS.
- Commit: `feat(supervisor): acciones de edición en vivo para dueño/admin desde móvil y PC`

---

## Fase 3 — Puente en la Nube para Supervisor desde fuera del local (Móvil con datos / PC remota)

### Tarea 7: Esquema mínimo de buzón de comandos y espejo en Supabase (`supabase/lan/001_puente_supervisor.sql`)
**Por qué:** Cuando el dueño sale del local con su teléfono, el celular no puede alcanzar `192.168.x.x` directamente. Este buzón guarda solo un espejo liviano del estado del local y una cola de órdenes firmadas/autenticadas para la Caja Principal.

**Archivos:**
- Crear: `supabase/lan/001_puente_supervisor.sql` (`lan_cloud_accounts`, `lan_cloud_snapshots`, `lan_supervisor_commands` con RLS por dueño)
- Test: `tests/lan/lanCloudBridgeSql.test.js` (contra PGlite aplicando `001_puente_supervisor.sql`)

**Paso 1: Escribir la prueba que falla**
- Probar en PGlite que solo el dueño dueño de la cuenta lee `lan_cloud_snapshots` y crea `lan_supervisor_commands` (`UPDATE_PRODUCT`, `ADJUST_STOCK`, `UPDATE_RATE`, `VOID_SALE`, `CUSTOMER_PAYMENT`), y que la Caja Principal (con su clave de enlace del local) marca comandos como `applied` / `rejected`.

**Paso 2-4: Verificar fallo → crear SQL con RLS estricto → verificar PASS → commit.**

---

### Tarea 8: Servicio silencioso de puente en la Caja Principal (`desktop/server/cloudBridge.mjs`) + Selector automático en Supervisor
**Archivos:**
- Crear: `desktop/server/cloudBridge.mjs` (cuando hay internet: sube snapshot liviano cada 60 s o tras venta/cierre; escucha `lan_supervisor_commands` y los ejecuta contra `lanDb.runRpc` emitiendo SSE a todas las cajas PC del local)
- Modificar: `desktop/main.js` (arranca `cloudBridge` solo en rol `master` si el dueño vinculó su cuenta puente en la nube; si no hay internet, reintenta suavemente sin afectar jamás el POS local)
- Modificar: `src/nube/NubeOwnerDashboard.jsx` / cliente Supervisor remoto (detecta si está en LAN o en puente nube; muestra indicador claro *"Conectado en red local"* vs *"Vía puente nube · última actualización hace X min"*).
- Test: `tests/lan/lanCloudBridgeRelay.test.js`

**Paso 1: Escribir la prueba que falla**
- Simular móvil enviando comando `UPDATE_RATE` al puente mock/PGlite mientras Caja Principal procesa la cola → el puente ejecuta `push_records_v2` en `lanDb`, marca el comando `applied` con `applied_at`, y Caja A en LAN recibe el cambio por SSE.
- Simular corte de internet en Caja Principal → las cajas PC siguen vendiendo normal y el comando remoto queda `pending` sin perderse hasta que vuelve la red.

**Paso 2-4: Verificar fallo → implementar → verificar PASS → commit.**

---

## Fase 4 — Validación de Escritorio Electron y Entorno Real (`F-19`, `F-20`)

### Tarea 9: Empaquetado Electron, script de regla Firewall Windows y verificación final
**Archivos:**
- Crear: `scripts/lan/windows-firewall-rule.ps1` (abre puerto TCP `47800` y UDP `47801` en perfil privado de Windows en la PC Principal)
- Modificar: `desktop/main.js` (verificación de instancia única `app.requestSingleInstanceLock()` para que no abran dos servidores en el mismo puerto)
- Modificar: `docs/LAN-FLUJOS-Y-PRUEBAS.md` (actualizar semáforo tras correr pruebas)

**Verificación global obligatoria antes de declarar listo para producción:**
1. `cd desktop && bun install`
2. `bun run desktop:start` (probar en PC Principal + una segunda PC o laptop en el mismo router Wi-Fi/cable).
3. Probar celular Android y iPhone abriendo el Supervisor dentro del Wi-Fi del local (`http://IP:47800`) y desde datos móviles vía puente nube.
4. Probar apagar la PC Principal mientras Caja B está apagada → encender Caja B → entrar con PIN offline → vender → encender PC Principal y verificar sincronización completa sin pérdidas.
5. Probar exportar respaldo, borrar base de prueba y restaurar en limpio (`F-21`).
6. Ejecutar: `bun run test:lan && bun run test:nube && bun run typecheck && bun run build`.
