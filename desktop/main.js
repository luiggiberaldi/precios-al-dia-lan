const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createAutoUpdaterController } = require('./updater');

let mainWindow = null;
let lanServerHandle = null;
let backupTimer = null;
let updaterCtrl = null;

function getElectronAutoUpdater() {
  try {
    return require('electron-updater').autoUpdater;
  } catch {
    return null;
  }
}

function getConfigPath() {
  return path.join(app.getPath('userData'), 'lan-desktop-config.json');
}

function readDesktopConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { role: null, serverUrl: null, port: 47800 };
  }
}

function writeDesktopConfig(cfg) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

async function loadLanServerModule() {
  const modPath = path.join(__dirname, 'server', 'lanServer.mjs');
  return import(pathToFileURL(modPath).href);
}

async function stopMasterServer() {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
  if (lanServerHandle) {
    const handle = lanServerHandle;
    lanServerHandle = null;
    await handle.close().catch(() => {});
  }
}

function resolveStaticDistDir() {
  const candidates = app.isPackaged
    ? [path.join(__dirname, 'dist-web'), path.join(process.resourcesPath, 'dist')]
    : [path.join(__dirname, '../dist'), path.join(__dirname, 'dist-web')];
  return candidates.find((dir) => fs.existsSync(dir)) || null;
}

async function startMasterServer(port = 47800) {
  if (lanServerHandle) return lanServerHandle;
  const { createLanServer } = await loadLanServerModule();
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'pdn-lan-db');
  const imagesDir = path.join(userData, 'pdn-lan-images');
  const backupsDir = path.join(userData, 'pdn-lan-backups');
  const staticDir = resolveStaticDistDir();
  lanServerHandle = await createLanServer({
    port,
    dataDir,
    imagesDir,
    backupsDir,
    staticDir,
    cloudUrl: process.env.PDN_CLOUD_BRIDGE_URL || process.env.VITE_LAN_CLOUD_URL || '',
    cloudAnonKey: process.env.PDN_CLOUD_BRIDGE_KEY || process.env.VITE_LAN_CLOUD_KEY || '',
  });
  // Respaldo automático cada 12 horas mientras la Caja Principal está abierta.
  backupTimer = setInterval(() => {
    lanServerHandle?.saveDiskBackupNow?.().catch(() => {});
  }, 12 * 3600_000);
  backupTimer.unref?.();
  return lanServerHandle;
}

function registerLanIpc() {
  ipcMain.handle('lan:getConfig', async () => {
    const cfg = readDesktopConfig();
    if (cfg.role === 'master') {
      const srv = await startMasterServer(cfg.port || 47800);
      return { ...cfg, serverUrl: srv.baseUrl, urls: srv.urls, running: true };
    }
    return { ...cfg, running: false };
  });

  ipcMain.handle('lan:setMasterMode', async (_event, { port = 47800 } = {}) => {
    try {
      const srv = await startMasterServer(port);
      const cfg = writeDesktopConfig({ role: 'master', serverUrl: srv.baseUrl, port: srv.port });
      return { ok: true, ...cfg, urls: srv.urls };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('lan:setClientMode', async (_event, { serverUrl }) => {
    await stopMasterServer();
    const cfg = writeDesktopConfig({ role: 'client', serverUrl, port: 47800 });
    return { ok: true, ...cfg };
  });

  ipcMain.handle('lan:resetRole', async () => {
    await stopMasterServer();
    const cfg = writeDesktopConfig({ role: null, serverUrl: null, port: 47800 });
    return { ok: true, ...cfg };
  });

  ipcMain.handle('lan:discoverServers', async () => {
    const { discoverLanServers } = await loadLanServerModule();
    return discoverLanServers({ timeoutMs: 1600 });
  });

  ipcMain.handle('lan:getServerStatus', async () => {
    if (!lanServerHandle) return { running: false, urls: [] };
    return { running: true, baseUrl: lanServerHandle.baseUrl, urls: lanServerHandle.urls, port: lanServerHandle.port };
  });

function buildFirewallScript(exePath) {
  const safeExe = String(exePath || '').replace(/'/g, "''");
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "Remove-NetFirewallRule -DisplayName 'PreciosAlDiaLAN-HTTP-TCP' -ErrorAction SilentlyContinue",
    "New-NetFirewallRule -DisplayName 'PreciosAlDiaLAN-HTTP-TCP' -Description 'Precios al Dia LAN HTTP y SSE (solo red local)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47800 -RemoteAddress LocalSubnet -Profile Any | Out-Null",
    "Remove-NetFirewallRule -DisplayName 'PreciosAlDiaLAN-Discovery-UDP' -ErrorAction SilentlyContinue",
    "New-NetFirewallRule -DisplayName 'PreciosAlDiaLAN-Discovery-UDP' -Description 'Precios al Dia LAN descubrimiento UDP (solo red local)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 47801 -RemoteAddress LocalSubnet -Profile Any | Out-Null",
  ];
  if (safeExe && !/electron\.exe$/i.test(safeExe)) {
    lines.push(
      `$appPath = '${safeExe}'`,
      "Remove-NetFirewallRule -DisplayName 'PreciosAlDiaLAN-App' -ErrorAction SilentlyContinue",
      "New-NetFirewallRule -DisplayName 'PreciosAlDiaLAN-App' -Description 'Precios al Dia LAN aplicacion (solo red local)' -Direction Inbound -Action Allow -Program $appPath -RemoteAddress LocalSubnet -Profile Any | Out-Null",
    );
  }
  return Buffer.from(lines.join('; '), 'utf16le').toString('base64');
}

function repairWindowsFirewallRules() {
  if (process.platform !== 'win32') {
    return Promise.resolve({
      ok: false,
      error: 'El permiso automático de Firewall solo aplica en Windows.',
    });
  }
  const innerEncoded = buildFirewallScript(process.execPath);
  const outerScript = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand','${innerEncoded}') -Verb RunAs -Wait -PassThru`,
    '  if ($p.ExitCode -ne 0) { exit $p.ExitCode }',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1223',
    '}',
  ].join('; ');
  const outerEncoded = Buffer.from(outerScript, 'utf16le').toString('base64');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', outerEncoded],
      { timeout: 60000 },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve({ ok: true });
          return;
        }
        const code = Number(err.code);
        const rawErr = String(stderr || err.message || '').trim();
        if (code === 1223 || /cancel/i.test(rawErr)) {
          resolve({
            ok: false,
            error: 'Se canceló el permiso de administrador. Pulsa de nuevo y elige "Sí" en la ventana de Windows.',
          });
          return;
        }
        resolve({
          ok: false,
          error: rawErr || 'No se pudo configurar el Firewall de Windows.',
        });
      },
    );
  });
}

  ipcMain.handle('lan:exportBackupNow', async () => {
    if (!lanServerHandle) return { ok: false, error: 'Esta PC no es la Caja Principal.' };
    const filePath = await lanServerHandle.saveDiskBackupNow();
    return { ok: true, filePath };
  });

  ipcMain.handle('lan:repairFirewall', async () => {
    return repairWindowsFirewallRules();
  });

  ipcMain.handle('app:getUpdateState', async () => {
    return updaterCtrl?.getState() || {
      supported: false,
      currentVersion: app.getVersion(),
      status: 'unsupported',
      availableVersion: null,
      progressPercent: 0,
      downloaded: false,
      error: null,
      lastCheckedAt: null,
    };
  });

  ipcMain.handle('app:checkForUpdates', async () => {
    if (!updaterCtrl) return { ok: false, state: { supported: false, status: 'unsupported' } };
    return updaterCtrl.checkForUpdates({ manual: true });
  });

  ipcMain.handle('app:installUpdateNow', async () => {
    if (!updaterCtrl) return { ok: false, error: 'Actualizador no disponible.' };
    return updaterCtrl.installUpdateNow();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    show: true,
    title: 'Precios al Día LAN',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  const indexPath = app.isPackaged
    ? (fs.existsSync(path.join(__dirname, 'dist-web/index.html'))
        ? path.join(__dirname, 'dist-web/index.html')
        : path.join(process.resourcesPath, 'dist/index.html'))
    : path.join(__dirname, '../dist/index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.maximize();
    mainWindow.focus();
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[LAN] Error cargando interfaz:', code, desc);
  });

  mainWindow.loadFile(indexPath);
  mainWindow.maximize();
  mainWindow.show();

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (
      (input.control && input.shift && input.key.toLowerCase() === 'i') ||
      input.key === 'F12'
    ) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
    if (
      (input.control && input.key.toLowerCase() === 'r') ||
      input.key === 'F5'
    ) {
      mainWindow.reload();
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotInstanceLock = app.requestSingleInstanceLock();

if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    updaterCtrl = createAutoUpdaterController({
      app,
      autoUpdater: getElectronAutoUpdater(),
      getMainWindow: () => mainWindow,
      beforeInstall: stopMasterServer,
    });
    registerLanIpc();
    const cfg = readDesktopConfig();
    if (cfg.role === 'master') {
      await startMasterServer(cfg.port || 47800).catch((err) => {
        console.error('[LAN] Error iniciando servidor maestro:', err);
      });
    }
    createWindow();
    updaterCtrl.startSchedule();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('before-quit', async (event) => {
  updaterCtrl?.stopSchedule?.();
  if (lanServerHandle) {
    event.preventDefault();
    await stopMasterServer();
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
