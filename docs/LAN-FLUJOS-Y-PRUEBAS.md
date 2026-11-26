# Mapa de Flujos y Estado de Producción — Precios al Día LAN

> Verificación automatizada ejecutada con `bun run test:lan`, `bun run test:nube`, `bun run typecheck`, `bun run build` y `node scripts/nube/check-no-legacy-supabase.mjs dist`.

## Leyenda de estado

- **Verde (`PROBADO · PASA`):** Probado con ejecución real contra servidor HTTP + base Postgres local (`PGlite`) + eventos SSE en vivo. Listo a nivel de motor e integración para producción.
- **Amarillo (`PROBADO EN SIMULACIÓN`):** Probado en pantalla simulada (**JSDOM**) contra servidor HTTP/Postgres real o puente simulado; requiere validación visual o despliegue final en equipo físico.
- **Rojo (`PENDIENTE FISICO`):** Depende de hardware Windows real, dependencias de empaquetado Electron (`desktop/node_modules`), router Wi-Fi físico o despliegue SQL en Supabase para internet.

---

## Diagrama general de flujos

```mermaid
flowchart TD
    classDef pass fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2px
    classDef partial fill:#fef9c3,stroke:#ca8a04,color:#713f12,stroke-width:2px
    classDef pending fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:2px

    Start(["Inicio Caja PC Windows"]) --> RoleCheck{"Caja Principal encendida?"}
    RoleCheck -->|"Si (red local LAN)"| F02["F-02 Buscar Caja Principal UDP - PROBADO"]
    RoleCheck -->|"No (apagon / router apagado)"| F23["F-23 Arranque Offline-First Pasaporte PIN - PROBADO"]
    F02 --> F01["F-01 Salud, version y bloqueo 1 instancia - PROBADO"]
    F19["F-19 Electron Windows + Firewall - PENDIENTE FISICO"] --> F01

    F01 --> F18["F-18 Pantallas Setup, NubeGate y QR - SIMULACION"]
    F18 --> RegCheck{"Equipo registrado?"}

    RegCheck -->|"No (Caja Principal)"| F04["F-04 Crear dueno sin correo y negocio - PROBADO"]
    F04 --> F05["F-05 Registrar Caja A / B / Consulta - PROBADO"]

    RegCheck -->|"No (Caja adicional PC)"| F06["F-06 Vincular con QR o codigo 6 digitos - PROBADO"]
    F06 --> F05

    RegCheck -->|"Si"| F07["F-07 Entrar con PIN, equipo y expulsion - PROBADO"]
    F05 --> F07

    F07 --> F03["F-03 Bloqueo a desconocidos RLS - PROBADO"]
    F07 --> Pos(["Caja Windows operando POS"])
    F23 --> Pos

    Pos --> F08["F-08 Catalogo y fusion simultanea S2 - PROBADO"]
    Pos --> F09["F-09 Cobro concurrente y control stock - PROBADO"]
    Pos --> F11["F-11 Anulacion y retorno de stock - PROBADO"]
    Pos --> F12["F-12 Fiados, abonos y bloqueo borrado S4 - PROBADO"]
    Pos --> F13["F-13 Tasa compartida - PROBADO"]
    Pos --> F14["F-14 Turnos por caja y resumen del dia - PROBADO"]
    Pos --> F16["F-16 Fotos de producto en red local - PROBADO"]

    F08 --> F10["F-10 Avisos en vivo SSE a cajas - PROBADO"]
    F09 --> F10
    F11 --> F10
    F12 --> F10
    F13 --> F10

    Pos -->|"Se corta Wi-Fi durante venta"| F15["F-15 Cola sin red y discrepancia - PROBADO"]
    F15 -->|"Vuelve la red"| F10

    Start --> F24["F-24 Supervisor local editable Wi-Fi Android/iOS/PC - PROBADO"]
    Start --> F25["F-25 Supervisor por internet Android/iOS/Windows - PROBADO MOTOR"]
    F24 --> F10
    F25 --> F10

    F19 --> F17["F-17 Respaldo en disco y reinicio - PROBADO"]
    F17 --> F21["F-21 Exportar y restaurar respaldo JSON - PROBADO"]
    F05 --> F22["F-22 Licencia RSA offline 3+ cajas - PROBADO"]
    F02 --> F20["F-20 Prueba fisica 2 PCs Windows + Movil - PENDIENTE FISICO"]

    class F01,F02,F03,F04,F05,F06,F07,F08,F09,F10,F11,F12,F13,F14,F15,F16,F17,F21,F22,F23,F24 pass
    class F18,F25 partial
    class F19,F20 pending
```

---

## Tabla de control para producción

| ID | Flujo | Prueba ejecutada | Estado | ¿Pasa a producción? |
|---|---|---|---|---|
| **F-01** | Chequeo de salud, versión y bloqueo de instancia | `lanMulticaja.test.js`, `lanFlujosCompletos.test.js`, `desktop/main.js` | 🟢 **Probado** | **Sí (motor)** |
| **F-02** | Descubrimiento UDP automático en la red local | `lanFlujosCompletos.test.js` | 🟢 **Probado** | **Sí (motor)** · validar router físico (F-20) |
| **F-03** | Bloqueo de lecturas/RPC sin sesión (RLS) | `lanMulticaja.test.js`, `lanFlujosCompletos.test.js` | 🟢 **Probado** | **Sí** |
| **F-04** | Cuenta del dueño offline, clave y negocio | `lanFlujosCompletos.test.js`, `lanUiFlujos.test.jsx` | 🟢 **Probado** | **Sí** |
| **F-05** | Registro `#A`, `#B`, consulta y límite 2 cajas | `lanMulticaja.test.js`, `lanFlujosCompletos.test.js` | 🟢 **Probado** | **Sí** |
| **F-06** | QR y código temporal de 6 dígitos (1 solo uso) | `lanMulticaja.test.js`, `lanFlujosCompletos.test.js`, `lanUiFlujos.test.jsx` | 🟢 **Probado** | **Sí** |
| **F-07** | Gestión de cajeros, PIN y expulsión de caja | `lanFlujosCompletos.test.js` | 🟢 **Probado** | **Sí** |
| **F-08** | Catálogo y fusión por campo S2 | `lanFlujosCompletos.test.js` | 🟢 **Probado** | **Sí** |
| **F-09** | Ventas simultáneas y rechazo sin stock | `lanMulticaja.test.js`, `lanFlujosCompletos.test.js` | 🟢 **Probado** | **Sí** |
| **F-10** | Sincronización instantánea SSE entre cajas y Supervisor | `lanMulticaja.test.js`, `lanFlujosCompletos.test.js`, `lanCloudBridgeRelay.test.js` | 🟢 **Probado** | **Sí** |
| **F-11** | Anulación de venta y retorno de stock | `lanFlujosCompletos.test.js`, `lanSupervisorActions.test.jsx` | 🟢 **Probado** | **Sí** |
| **F-12** | Fiados/abonos entre cajas y bloqueo borrado S4 | `lanMulticaja.test.js`, `lanFlujosCompletos.test.js`, `lanSupervisorActions.test.jsx` | 🟢 **Probado** | **Sí** |
| **F-13** | Tasa compartida (`pdn_rate_v1`) con permiso | `lanFlujosCompletos.test.js`, `lanSupervisorActions.test.jsx` | 🟢 **Probado** | **Sí** |
| **F-14** | Turnos por caja y consolidado `cash_day_summary` | `lanFlujosCompletos.test.js` | 🟢 **Probado** | **Sí** |
| **F-15** | Corte de red LAN, cola y discrepancia | `lanFlujosCompletos.test.js` | 🟢 **Probado** | **Sí** |
| **F-16** | Subida y carga local de fotos (`/lan/images`) | `lanMulticaja.test.js` | 🟢 **Probado** | **Sí** |
| **F-17** | Respaldo JSON en disco y reinicio de servidor | `lanMulticaja.test.js` | 🟢 **Probado** | **Sí** |
| **F-18** | Flujo visual React (`LanSetupScreen`, `NubeGate`, QR, login web remoto) | `lanUiFlujos.test.jsx` (JSDOM + HTTP/PGlite real) | 🟡 **Simulación** | Validar visualmente en navegador real |
| **F-19** | Ventana Electron real Windows (`desktop:build`) y firewall | Script `scripts/lan/windows-firewall-rule.ps1` listo; falta `desktop/node_modules` y arranque Windows | 🔴 **Pendiente físico** | **Requerido antes de instalar en PCs** |
| **F-20** | Prueba física entre 2 PCs Windows + Android/iOS en router | *Sin prueba de hardware físico todavía* | 🔴 **Pendiente físico** | **Requerido en local** |
| **F-21** | Exportar y restaurar respaldo JSON + invariantes | `lanRestoreAndLicense.test.js` | 🟢 **Probado** | **Sí** |
| **F-22** | Activación de licencia RSA offline (>2 cajas) y rechazo de falsificación | `lanRestoreAndLicense.test.js` | 🟢 **Probado** | **Sí** |
| **F-23** | Arranque 100% Offline-First sin Caja Principal + Pasaporte PIN 72 h + bloqueo 5 fallos | `offlinePassport.test.js`, `lanOfflineBoot.test.jsx` | 🟢 **Probado** | **Sí** |
| **F-24** | Modo Supervisor editable dentro del local (web SPA en `dist/` + UUID HTTP + productos, stock multi-sede, tasa, anulación, abonos) | `lanStaticServe.test.js`, `safeUuid.test.js`, `lanSupervisorActions.test.jsx` | 🟢 **Probado** | **Sí** |
| **F-25** | Modo Supervisor por internet (Android, iOS, Windows ↔ Puente Supabase Relay + Caja Principal `cloudBridge.mjs`) | `lanCloudBridgeSql.test.js`, `lanCloudBridgeRelay.test.js` (PGlite + Relay SQL) | 🟡 **Probado en motor** | Desplegar `supabase/lan/001_puente_supervisor.sql` en Supabase y probar con 4G real |
