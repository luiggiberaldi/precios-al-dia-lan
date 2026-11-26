# Precios al Día Nube — estado y pendientes

Plan: [2026-11-15-plan-definitivo-precios-al-dia-nube.md](../plans/2026-11-15-plan-definitivo-precios-al-dia-nube.md).
Archivo propio de la nube (no existe en Precios al Día) para que las uniones con upstream no choquen.
Última actualización: 2026-11-16.

## Dónde vive cada cosa

| Pieza | Valor |
|---|---|
| Repo | `luiggiberaldi/preciosaldia-nube` (privado). `upstream` = `preciosaldia2026` (solo lectura) |
| Supabase de pruebas | `nube-pruebas` · ref `hfuzyauiefhllohonvim` · us-east-1 · organización `preciosaldiacloud` · plan gratis |
| Supabase de producción | `nube-prod` — **no existe todavía** (F8, con aprobación del costo) |
| Vercel | proyecto `preciosaldia-nube` · producción = `main` · apunta a `nube-pruebas` · el build corre la guardia de Supabase |
| Migraciones | `supabase/nube/migrations/001…008` — todas aplicadas en `nube-pruebas` (las de `supabase/migrations/` son de Precios al Día y **no** se aplican aquí) |
| Código nuevo | `src/nube/` · pruebas en `tests/nube/` · scripts en `scripts/nube/` |
| Identidad | azul nube `#2b59c3`, «Precios al Día Nube», `com.preciosaldia.nube`, equipos `PDN-…`, licencia `nube` |
| Encender la nube en la app | `VITE_NUBE_ACCOUNTS=true` (en local: `bun run dev -- --mode nube`, lee `.env.nube.local`) |

## Fases

| Fase | Estado | Qué hay |
|---|---|---|
| Prerrequisito | ✅ | Lo pulido de Bodega en `main` |
| F0 Montaje | ✅ | Repo privado, upstream, `nube-pruebas`, Vercel, identidad propia, guardia «sin Supabase de Precios al Día», gitleaks. Falta: protección de `main` (exige GitHub Pro) |
| F1 Cuentas | ✅ | Cuenta del dueño (correo), sedes, empleados con PIN (bcrypt, bloqueo como Bodega), equipos `PDN-` con letra de caja y límite de licencia, puerta `NubeGate` |
| F2 Catálogo | ✅ | Productos, clientes, proveedores, métodos de pago y categorías por registro; avisos baratos por Realtime; importar respaldo de Bodega (D10) |
| F3 Stock y cobro | ✅ | Libro de stock de solo agregar, cobro en el servidor (#A-00001, «sin stock» con internet, diferencias sin internet), anular, compras/ajustes/conteo, vigilante de «vías olvidadas», stock inicial al importar |
| F4 Fiados | ✅ | Libro de clientes con saldo oficial del servidor (E5), saldos iniciales al importar |
| F5 Turnos y cierres | ✅ | Cada caja sube su turno; consolidado del día por caja y sede para el dueño |
| F6 Sin internet | ✅ | Colas que nunca se vacían solas (ventas, registros, ajustes, cartera); permiso de 72 h (D8); equipo expulsado (E10) |
| F7 Dueño | ✅ código · ⏳ semana simulada | Panel del dueño en equipo de consulta (hoy, ventas, inventario, clientes, diferencias). Revisor de cuadres A7 (`nube_private.verify_invariants()`) |
| F8 Producción | ⏳ | Necesita tu aprobación del costo de `nube-prod` |

## Escenarios del banco multicaja (sección 7 del plan)

| # | Cubierto por pruebas | Dónde |
|---|---|---|
| E1, E2, E4, E7, E8, E11 | ✅ SQL real (PGlite) | `tests/nube/sql/f3Stock.test.js` |
| E2, E3 (con corte a mitad) | ✅ desde la caja | `tests/nube/stockService.test.js` |
| E5 | ✅ SQL y dos cajas | `f4Clientes.test.js`, `customerLedgerSync.test.js` |
| E6 | ✅ | `f5Caja.test.js` |
| E10 | ✅ puerta | `nubeGate.test.jsx` |
| E13 | por diseño: el precio viaja en la venta; el cambio llega por F2 | — |
| E14 | ✅ en cada fase (aislamiento entre cuentas) | todas las `sql/*.test.js` |
| E9, E12 | ⏳ necesitan navegador real | A4 (Playwright con dos navegadores) |

## Supuestos tomados (cámbialos si no te sirven)

- **D5** Dueño con correo y clave; empleados con PIN de 6+ dígitos (reglas de Bodega).
- **D6** Stock por sede; el dueño ve el total.
- **D7** Licencia de prueba al crear la cuenta: 2 cajas (antes 1; migración 011, 2026-11-16), 1 sede, 15 días. La amplía la Estación (service_role).
- **D8** 72 horas vendiendo sin internet.
- **D9** Un turno por caja; varios empleados entran con su PIN y cada venta guarda quién la hizo.
- Con internet una venta sin stock se rechaza, salvo que la caja tenga activado «permitir stock negativo» (como Bodega).
- Anular necesita internet (no se encola).
- Un cajero no puede cambiar el stock desde el formulario: se avisa y vuelve el stock del servidor.

## Pendientes del dueño (para seguir probando y pasar a F8)

1. **Activar «Anonymous sign-ins»** en `nube-pruebas` → Authentication → Sign In / Providers. Sin eso ningún equipo se registra (la puerta lo dice).
2. Confirmación del correo del dueño: hoy Supabase la exige; en pruebas se puede apagar.
3. **Rotar** la llave de ExchangeRate y el token de Google Script que estaban en claro en `ISSUES.md` (también en el repo público `preciosaldia2026`).
4. Decidir GitHub Pro (~4 US$/mes) para proteger `main`.
5. Kilo Code Review sin créditos (check en rojo, no bloquea).
6. Poner `VITE_NUBE_ACCOUNTS=true` en Vercel cuando quieras ver la puerta en la vista previa.
7. Estación Maestra: reconocer IDs `PDN-` y administrar `account_licenses` del Supabase de la nube (otro repo).
8. Aprobar el costo de `nube-prod` para F8.

## Notas técnicas

- Arnés A2: `tests/nube/sql/harness.js` levanta Postgres real (PGlite) con un shim de auth y roles de Supabase; corre en el CI sin Docker. `tests/nube/sql/fakeSupabase.js` imita al cliente de Supabase para probar `src/nube` contra el SQL real.
- A6 (50 cobros simultáneos) y A4 (dos navegadores) necesitan Postgres con conexiones paralelas y sesiones anónimas: quedan para cuando se active el punto 1.
- Revisor de cuadres: `select * from nube_private.verify_invariants();` (vacío = todo cuadra). En `nube-pruebas` dio 0 problemas el 2026-11-16.
- Con la nube encendida, partes heredadas (Supervisor, respaldos viejos) todavía llaman tablas de Bodega que no existen en la nube: 404 esperados en la consola.
