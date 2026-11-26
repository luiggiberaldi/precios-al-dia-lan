const NETWORK_ERR_RE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|net::ERR_/i;

function normalizeUpdateError(err) {
  const msg = String(err?.message || err || '').trim();
  if (!msg) return 'No se pudo comprobar si hay actualizaciones.';
  const firstLine = msg.split(/\r?\n/)[0].trim();
  return firstLine.slice(0, 220);
}

function isNetworkUpdateError(err) {
  return NETWORK_ERR_RE.test(String(err?.message || err || ''));
}

function createAutoUpdaterController({
  app,
  autoUpdater = null,
  getMainWindow = () => null,
  beforeInstall = async () => {},
  checkDelayMs = 8_000,
  checkIntervalMs = 4 * 3600_000,
  logger = console,
} = {}) {
  const supported = Boolean(app?.isPackaged && autoUpdater);
  const currentVersion = String(app?.getVersion?.() || '1.0.0');

  let state = {
    supported,
    currentVersion,
    status: supported ? 'idle' : 'unsupported',
    availableVersion: null,
    progressPercent: 0,
    downloaded: false,
    error: null,
    lastCheckedAt: null,
    manualCheck: false,
  };

  let initialTimer = null;
  let intervalTimer = null;
  let installing = false;

  const snapshot = () => ({ ...state });

  const broadcast = () => {
    const win = getMainWindow?.();
    if (win && !win.isDestroyed?.() && win.webContents?.send) {
      win.webContents.send('app:updateState', snapshot());
    }
  };

  const patchState = (next) => {
    state = { ...state, ...next };
    broadcast();
    return snapshot();
  };

  if (supported) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () => {
      patchState({ status: 'checking', error: null });
    });

    autoUpdater.on('update-available', (info) => {
      patchState({
        status: 'available',
        availableVersion: info?.version ? String(info.version) : null,
        progressPercent: 0,
        downloaded: false,
        error: null,
        lastCheckedAt: new Date().toISOString(),
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      const pct = Math.max(0, Math.min(100, Math.round(Number(progress?.percent || 0))));
      patchState({
        status: 'downloading',
        progressPercent: pct,
        error: null,
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      patchState({
        status: 'downloaded',
        availableVersion: info?.version ? String(info.version) : state.availableVersion,
        progressPercent: 100,
        downloaded: true,
        error: null,
        lastCheckedAt: new Date().toISOString(),
      });
    });

    autoUpdater.on('update-not-available', () => {
      patchState({
        status: 'up-to-date',
        availableVersion: null,
        progressPercent: 0,
        downloaded: false,
        error: null,
        lastCheckedAt: new Date().toISOString(),
      });
    });

    autoUpdater.on('error', (err) => {
      const netErr = isNetworkUpdateError(err);
      if (!state.manualCheck && netErr) {
        patchState({ status: 'idle', error: null });
        return;
      }
      logger?.warn?.('[LAN Updater] Error verificando actualización:', err?.message || err);
      patchState({
        status: netErr ? 'offline' : 'error',
        error: netErr
          ? 'Sin conexión a internet para buscar actualizaciones. Tu caja sigue operando normal en red local.'
          : normalizeUpdateError(err),
        lastCheckedAt: new Date().toISOString(),
      });
    });
  }

  async function checkForUpdates({ manual = false } = {}) {
    if (!supported) {
      return {
        ok: false,
        state: patchState({
          status: 'unsupported',
          manualCheck: Boolean(manual),
          error: manual
            ? 'Las actualizaciones automáticas solo están disponibles en el programa instalado (.exe).'
            : null,
        }),
      };
    }

    if (state.status === 'checking' || state.status === 'downloading') {
      return { ok: true, state: patchState({ manualCheck: Boolean(manual) || state.manualCheck }) };
    }

    if (state.status === 'downloaded') {
      return { ok: true, state: snapshot() };
    }

    patchState({ manualCheck: Boolean(manual), error: null });
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true, state: snapshot() };
    } catch (err) {
      const netErr = isNetworkUpdateError(err);
      if (!manual && netErr) {
        return { ok: false, state: patchState({ status: 'idle', error: null }) };
      }
      return {
        ok: false,
        state: patchState({
          status: netErr ? 'offline' : 'error',
          error: netErr
            ? 'Sin conexión a internet para buscar actualizaciones. Tu caja sigue operando normal en red local.'
            : normalizeUpdateError(err),
        }),
      };
    }
  }

  async function installUpdateNow() {
    if (!supported || state.status !== 'downloaded' || installing) {
      return {
        ok: false,
        error: 'Todavía no hay una actualización descargada lista para instalar.',
      };
    }
    installing = true;
    try {
      await beforeInstall?.();
    } catch (err) {
      logger?.warn?.('[LAN Updater] Aviso cerrando servidor antes de reiniciar:', err?.message || err);
    }
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  }

  function startSchedule() {
    if (!supported) return;
    stopSchedule();
    initialTimer = setTimeout(() => {
      checkForUpdates({ manual: false }).catch(() => {});
    }, checkDelayMs);
    initialTimer.unref?.();

    intervalTimer = setInterval(() => {
      checkForUpdates({ manual: false }).catch(() => {});
    }, checkIntervalMs);
    intervalTimer.unref?.();
  }

  function stopSchedule() {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  return {
    getState: snapshot,
    checkForUpdates,
    installUpdateNow,
    startSchedule,
    stopSchedule,
  };
}

module.exports = {
  createAutoUpdaterController,
  isNetworkUpdateError,
  normalizeUpdateError,
};
