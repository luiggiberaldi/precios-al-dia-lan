# Precios al Día LAN — Guía Rápida

Esta edición está diseñada para operar **multicaja en PCs Windows dentro del local (100% offline-first en LAN)** e incluye un **Modo Supervisor editable** que funciona tanto dentro del local por Wi-Fi como **fuera del local por internet en Android, iOS y Windows**.

---

## 1. Requisitos previos en Windows (Caja Principal y Cajas adicionales)

En la PC Principal (y en las PCs que usen Electron):
```powershell
cd "c:\Users\luigg\Desktop\precios al dia suite\precios al dia lan"
bun run build
cd desktop; npm install; cd ..
```

En la **Caja Principal** (para que otras PCs y teléfonos en el mismo router se conecten sin bloqueos), abre **PowerShell como Administrador** y ejecuta una sola vez:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\lan\windows-firewall-rule.ps1
```

---

## 2. Arranque en las PCs Windows del local

1. Abre la app de escritorio (`bun run desktop:start` en desarrollo o el instalador generado con `bun run desktop:build`).
2. En la primera PC elige **"Esta PC es la Caja Principal (Servidor)"** y crea tu cuenta de dueño y sede (sin correo requerido).
3. En las demás PCs Windows del local elige **"Esta PC es una Caja adicional"** → **"Buscar Caja Principal en la red"** (o escribe su IP, ej. `192.168.1.50:47800`) y vincula con el código temporal de 6 dígitos o QR.
4. Si un día falla la red al abrir una caja adicional, la caja arranca igual en **modo Offline-First** durante hasta **72 horas** con el pasaporte de PIN cifrado y sincroniza automáticamente al volver la Caja Principal.

---

## 3. Modo Supervisor (Android, iOS y Windows)

El dueño o un administrador puede **ver ventas/stock/fiados y también editar** (productos, precios, stock por sede, tasa del día, anular ventas y registrar abonos):

- **Dentro del local sin internet:** abre `http://IP-CAJA-PRINCIPAL:47800` desde Chrome/Safari en cualquier celular o PC (o escanea el **QR Supervisor móvil (Wi-Fi)** en *Equipos y empleados → Conectar*).
- **Desde cualquier lugar con internet (Android / iOS / Windows):**
  1. Despliega el archivo [001_puente_supervisor.sql](file:///c:/Users/luigg/Desktop/precios%20al%20dia%20suite/precios%20al%20dia%20lan/supabase/lan/001_puente_supervisor.sql) en el **SQL Editor** de tu proyecto Supabase ligero.
  2. En la Caja Principal entra a *Equipos y empleados → Conectar caja / Respaldo → pestaña Internet*, pega la URL/llave pública de tu Supabase (o configúrala en `.env.lan.local` con `VITE_LAN_CLOUD_URL` y `VITE_LAN_CLOUD_KEY`) y define tu PIN remoto para recibir tu **código de negocio** (`SUP-XXXXXX`).
  3. En el teléfono o PC fuera del local abre la web app de Supervisor y toca **"¿Fuera del local? Entrar como Supervisor por internet"** con ese código y tu PIN.

---

## 4. Respaldos y pruebas automatizadas

```powershell
bun run test:lan      # Suite completa de motor, offline-first, UI JSDOM y puente Supervisor
bun run test:nube     # Pruebas de compatibilidad de reglas SQL/sync de Precios al Día
bun run typecheck     # Verificación de tipos
```
