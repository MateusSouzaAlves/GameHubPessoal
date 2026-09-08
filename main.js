const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, safeStorage, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ConfigManager = require('./src/main/config');
const Persistence = require('./src/main/persistence');
const GameScanner = require('./src/main/scanner');
const CoverManager = require('./src/main/coverManager');
const GameLauncher = require('./src/main/launcher');
const FolderWatcher = require('./src/main/watcher');
const SaveManager = require('./src/main/saveManager');
const GoogleDriveService = require('./src/main/googleDrive');
const XOutputManager = require('./src/main/xoutputManager');
const { isSubPath } = require('./src/main/utils');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
} else {
  app.quit();
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'nexus-cover',
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false }
}]);

let mainWindow = null;
let watcher = null;
let cloudTimer = null;
let resizeTimer = null;
let watcherStartTimer = null;
let appIsQuitting = false;
let dataDir = null;
let configManager = null;
let persistence = null;
let scanner = null;
let coverManager = null;
let launcher = null;
let saveManager = null;
let googleDrive = null;
let xoutput = null;
const coverQueue = [];
const queuedCoverIds = new Set();
const coverAttemptedAt = new Map();
let activeCoverWorkers = 0;

function loadGoogleOAuthClient() {
  const environmentClientId = String(process.env.NEXUS_GOOGLE_CLIENT_ID || '').trim();
  const environmentClientSecret = String(process.env.NEXUS_GOOGLE_CLIENT_SECRET || '').trim();
  if (environmentClientId) return { clientId: environmentClientId, clientSecret: environmentClientSecret || null };
  try {
    const configPath = path.join(__dirname, 'assets', 'google-oauth-client.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const desktopClient = parsed.installed || parsed;
    return {
      clientId: String(desktopClient.clientId || desktopClient.client_id || '').trim(),
      clientSecret: String(desktopClient.clientSecret || desktopClient.client_secret || '').trim() || null
    };
  } catch (error) {
    console.warn('[GoogleDrive] Application OAuth configuration unavailable:', error.message);
    return { clientId: '', clientSecret: null };
  }
}

function migrateDevelopmentData(destination) {
  if (app.isPackaged) return;
  const legacy = path.join(__dirname, 'data');
  if (!fs.existsSync(legacy) || path.resolve(legacy) === path.resolve(destination)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const fileName of ['config.json', 'library.json']) {
    const source = path.join(legacy, fileName);
    const target = path.join(destination, fileName);
    if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target);
  }
  const sourceCovers = path.join(legacy, 'covers');
  const targetCovers = path.join(destination, 'covers');
  if (fs.existsSync(sourceCovers) && !fs.existsSync(targetCovers)) {
    fs.cpSync(sourceCovers, targetCovers, { recursive: true });
  }
}

function initializeServices() {
  dataDir = path.join(app.getPath('userData'), 'data');
  migrateDevelopmentData(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  configManager = new ConfigManager(dataDir);
  persistence = new Persistence(dataDir);
  scanner = new GameScanner(configManager, persistence);
  coverManager = new CoverManager(dataDir);
  googleDrive = new GoogleDriveService(path.join(dataDir, 'private'), safeStorage, shell, loadGoogleOAuthClient());
  launcher = new GameLauncher(persistence, (gameId, status, details) => {
    sendToRenderer('game:statusChanged', { gameId, status });
    sendToRenderer('library:updated');
    if (details?.ended && configManager.get('autoBackup')) {
      saveManager.backupGame(gameId, { reason: 'game-exit' }).then(result => {
        if (result.success && !result.skipped) sendToRenderer('backup:created', { gameId, backup: result.backup });
      }).catch(error => console.warn('[Saves] Post-game backup failed:', error.message));
    }
  });
  saveManager = new SaveManager(dataDir, persistence, configManager, async (gameId, backup) => {
    const cloud = configManager.get('cloud');
    if (!cloud?.enabled || !cloud.autoSync || !googleDrive.getStatus().connected) return;
    const remote = await googleDrive.uploadFile(backup.path, `save-${gameId}-${backup.id}.zip`, {
      appProperties: { nexusType: 'save-backup', gameId, backupId: backup.id }
    });
    persistence.markBackupCloudSynced(gameId, backup.id, { fileId: remote.id });
    sendToRenderer('cloud:statusChanged', googleDrive.getStatus());
  });
  saveManager.start();
  scheduleCloudSync();
}

function getXOutputManager() {
  if (!xoutput) {
    xoutput = new XOutputManager(dataDir, process.resourcesPath, __dirname, running => {
      sendToRenderer('xoutput:statusChanged', { ...xoutput.getStatus(), running });
    });
  }
  return xoutput;
}

function registerCoverProtocol() {
  protocol.handle('nexus-cover', request => {
    try {
      const url = new URL(request.url);
      const requestedName = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const safeName = path.basename(requestedName);
      if (!safeName || safeName !== requestedName || !/^[a-f0-9]{12,64}\.(png|jpe?g|webp|bmp|gif)$/i.test(safeName)) {
        return new Response('Not found', { status: 404 });
      }
      const filePath = path.join(coverManager.cacheDir, safeName);
      if (!isSubPath(coverManager.cacheDir, filePath) || !fs.existsSync(filePath)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: configManager.get('windowWidth'),
    height: configManager.get('windowHeight'),
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#050812',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  mainWindow.removeMenu();
  const loadOptions = process.env.NEXUS_QA_VIEW ? { query: { qa: process.env.NEXUS_QA_VIEW } } : undefined;
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'), loadOptions);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  if (process.env.NEXUS_QA_SCREENSHOT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow.capturePage();
          fs.writeFileSync(path.resolve(process.env.NEXUS_QA_SCREENSHOT), image.toPNG());
        } catch (error) {
          console.error('[QA] Screenshot failed:', error.message);
          process.exitCode = 1;
        } finally {
          app.quit();
        }
      }, 5000);
    });
  }
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const [width, height] = mainWindow.getSize();
      configManager.set('windowWidth', width);
      configManager.set('windowHeight', height);
    }, 500);
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function assertGameId(gameId) {
  if (typeof gameId !== 'string' || !/^[a-f0-9]{12,64}$/i.test(gameId) || !persistence.getById(gameId)) {
    throw new Error('Identificador de jogo inválido.');
  }
  return gameId;
}

function resolveStoredCover(game) {
  if (!game?.coverCache) return null;
  const coverPath = path.resolve(game.coverCache);
  return isSubPath(coverManager.cacheDir, coverPath) && fs.existsSync(coverPath) ? coverPath : null;
}

function serializeGame(game, knownCoverPath = undefined) {
  const coverPath = knownCoverPath === undefined ? resolveStoredCover(game) : knownCoverPath;
  const coverKey = coverPath ? path.basename(coverPath) : null;
  return {
    ...game,
    coverUrl: coverKey ? `nexus-cover://asset/${encodeURIComponent(coverKey)}` : coverManager.generateDefaultCover(game.name),
    isRunning: launcher.isRunning(game.id)
  };
}

function publicGames(games, options = {}) {
  const missingCovers = [];
  const snapshot = games.map(game => {
    const coverPath = resolveStoredCover(game);
    if (!coverPath) missingCovers.push(game);
    return serializeGame(game, coverPath);
  });
  queueMissingCovers(missingCovers, options);
  return snapshot;
}

function queueMissingCovers(games, options = {}) {
  if (appIsQuitting) return;
  const now = Date.now();
  for (const game of games) {
    if (queuedCoverIds.has(game.id)) continue;
    const lastAttempt = coverAttemptedAt.get(game.id) || 0;
    if (!options.force && now - lastAttempt < 30 * 60_000) continue;
    queuedCoverIds.add(game.id);
    coverQueue.push(game);
  }
  setImmediate(runCoverQueue);
}

function runCoverQueue() {
  if (appIsQuitting) return;
  while (activeCoverWorkers < 1 && coverQueue.length) {
    const game = coverQueue.shift();
    activeCoverWorkers += 1;
    coverAttemptedAt.set(game.id, Date.now());
    coverManager.findCover(game).then(coverPath => {
      if (!coverPath) return;
      const updated = persistence.updateCover(game.id, coverPath);
      if (updated) sendToRenderer('library:coverChanged', serializeGame(updated));
    }).catch(error => {
      if (!appIsQuitting) console.warn(`[CoverManager] Background cover lookup failed for ${game.name}:`, error.message);
    }).finally(() => {
      queuedCoverIds.delete(game.id);
      activeCoverWorkers -= 1;
      if (!appIsQuitting) runCoverQueue();
    });
  }
}

function publicCloudSnapshot() {
  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      scanDepth: configManager.get('scanDepth'),
      autoBackup: configManager.get('autoBackup'),
      backupRetention: configManager.get('backupRetention'),
      interfaceSounds: configManager.get('interfaceSounds'),
      interfaceAnimations: configManager.get('interfaceAnimations')
    },
    analytics: persistence.getAnalyticsSummary(),
    games: persistence.getAll().map(game => ({
      id: game.id,
      name: game.name,
      steamAppId: game.steamAppId,
      detectedAt: game.detectedAt,
      lastPlayed: game.lastPlayed,
      playCount: game.playCount,
      analytics: game.analytics,
      cover: game.cloud?.cover || null,
      backups: (game.backupHistory || []).map(backup => ({
        id: backup.id,
        createdAt: backup.createdAt,
        reason: backup.reason,
        size: backup.size,
        sourceBytes: backup.sourceBytes,
        fileCount: backup.fileCount,
        fingerprint: backup.fingerprint,
        cloud: backup.cloud
      }))
    }))
  };
}

async function performCloudSync() {
  const status = googleDrive.getStatus();
  const cloud = configManager.get('cloud');
  if (!status.connected || !cloud?.enabled) throw new Error('Google Drive não está conectado.');
  let uploaded = 0;
  for (const game of persistence.getAll()) {
    for (const backup of game.backupHistory || []) {
      if (backup.cloud?.synced || !fs.existsSync(backup.path)) continue;
      const remote = await googleDrive.uploadFile(backup.path, `save-${game.id}-${backup.id}.zip`, {
        appProperties: { nexusType: 'save-backup', gameId: game.id, backupId: backup.id }
      });
      persistence.markBackupCloudSynced(game.id, backup.id, { fileId: remote.id });
      uploaded += 1;
    }
    if (game.coverCache && fs.existsSync(game.coverCache)) {
      const stats = fs.statSync(game.coverCache);
      const fingerprint = `${stats.size}-${Math.round(stats.mtimeMs)}`;
      if (game.cloud?.cover?.fingerprint !== fingerprint) {
        const extension = path.extname(game.coverCache).toLowerCase();
        const mimeType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
        const remote = await googleDrive.uploadFile(game.coverCache, `cover-${game.id}${extension}`, {
          appProperties: { nexusType: 'cover', gameId: game.id }
        }, mimeType);
        persistence.markCoverCloudSynced(game.id, { fingerprint, fileId: remote.id, syncedAt: new Date().toISOString() });
        uploaded += 1;
      }
    }
  }
  await googleDrive.uploadJson('nexus-state.json', publicCloudSnapshot());
  sendToRenderer('cloud:statusChanged', googleDrive.getStatus());
  return { success: true, uploaded, status: googleDrive.getStatus() };
}

function scheduleCloudSync() {
  if (cloudTimer) clearInterval(cloudTimer);
  cloudTimer = null;
  const cloud = configManager?.get('cloud');
  if (!cloud?.enabled || !cloud.autoSync) return;
  cloudTimer = setInterval(() => performCloudSync().catch(error => {
    console.warn('[GoogleDrive] Automatic sync deferred:', error.message);
  }), (cloud.syncIntervalMinutes || 30) * 60_000);
  cloudTimer.unref?.();
}

function registerIpcHandlers() {
  ipcMain.handle('library:scan', async () => {
    const games = await scanner.fullScan({ onProgress: progress => sendToRenderer('library:scanProgress', progress) });
    return publicGames(games, { force: true });
  });
  ipcMain.handle('library:getAll', () => publicGames(persistence.getAll()));
  ipcMain.handle('library:getRecentlyAdded', (_, limit) => publicGames(persistence.getRecentlyAdded(Math.min(20, Math.max(1, Number(limit) || 5)))));
  ipcMain.handle('library:getRecentlyPlayed', (_, limit) => publicGames(persistence.getRecentlyPlayed(Math.min(20, Math.max(1, Number(limit) || 5)))));

  ipcMain.handle('game:launch', async (_, gameId) => launcher.launch(assertGameId(gameId)));
  ipcMain.handle('game:getStatus', (_, gameId) => launcher.getGameStatus(assertGameId(gameId)));
  ipcMain.handle('game:openFolder', async (_, gameId, kind) => {
    const game = persistence.getById(assertGameId(gameId));
    const target = kind === 'executable' ? path.dirname(game.executablePath) : game.gamePath;
    if (!fs.existsSync(target)) throw new Error('A pasta não existe mais.');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('config:get', () => configManager.getAll());
  ipcMain.handle('config:update', async (_, settings) => {
    const result = configManager.updateSettings(settings);
    saveManager.start();
    scheduleCloudSync();
    return result;
  });
  ipcMain.handle('config:addScanPath', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Selecionar pasta de jogos', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true };
    if (!configManager.addScanPath(result.filePaths[0])) return { success: false, message: 'Pasta já configurada.' };
    await watcher?.restart();
    return { success: true, path: result.filePaths[0] };
  });
  ipcMain.handle('config:removeScanPath', async (_, scanPath) => {
    if (typeof scanPath !== 'string') throw new Error('Pasta inválida.');
    const removed = configManager.removeScanPath(scanPath);
    if (removed) {
      await watcher?.restart();
    }
    return removed;
  });

  ipcMain.handle('saves:discover', (_, gameId) => saveManager.discoverForGame(assertGameId(gameId)));
  ipcMain.handle('saves:addLocation', async (_, gameId) => {
    assertGameId(gameId);
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Selecionar pasta de saves', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true };
    return { success: true, locations: await saveManager.addManualLocation(gameId, result.filePaths[0]) };
  });
  ipcMain.handle('saves:backupGame', (_, gameId) => saveManager.backupGame(assertGameId(gameId), { reason: 'manual', force: true }));
  ipcMain.handle('saves:backupAll', () => saveManager.backupAll({ reason: 'manual', force: true }));
  ipcMain.handle('saves:getBackups', (_, gameId) => saveManager.getBackups(assertGameId(gameId)));
  ipcMain.handle('saves:restoreBackup', (_, gameId, backupId) => {
    assertGameId(gameId);
    if (typeof backupId !== 'string' || !/^[0-9TZ-]+$/.test(backupId)) throw new Error('Identificador de backup inválido.');
    return saveManager.restoreBackup(gameId, backupId);
  });
  ipcMain.handle('saves:openBackupFolder', async () => {
    const error = await shell.openPath(saveManager.getBackupRoot());
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('analytics:getSummary', () => persistence.getAnalyticsSummary());

  ipcMain.handle('cloud:getStatus', () => googleDrive.getStatus());
  ipcMain.handle('cloud:connect', async () => {
    const status = await googleDrive.connect();
    const cloud = configManager.get('cloud');
    configManager.set('cloud', { ...cloud, enabled: true });
    scheduleCloudSync();
    sendToRenderer('cloud:statusChanged', status);
    return status;
  });
  ipcMain.handle('cloud:syncNow', () => performCloudSync());
  ipcMain.handle('cloud:disconnect', async () => {
    const status = await googleDrive.disconnect();
    configManager.set('cloud', { ...configManager.get('cloud'), enabled: false });
    scheduleCloudSync();
    return status;
  });
  ipcMain.handle('xoutput:launch', () => getXOutputManager().launch());
  ipcMain.handle('xoutput:status', () => getXOutputManager().getStatus());
  ipcMain.handle('xoutput:openFolder', async () => {
    const error = await shell.openPath(getXOutputManager().getFolder());
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
  ipcMain.handle('window:close', () => mainWindow?.close());
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  app.setAppUserModelId('com.nexus.gamelauncher');
  initializeServices();
  registerCoverProtocol();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  registerIpcHandlers();
  createWindow();
  watcher = new FolderWatcher(configManager, scanner, () => sendToRenderer('library:updated'));
  watcherStartTimer = setTimeout(() => watcher?.start(), 2500);
  watcherStartTimer.unref?.();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  appIsQuitting = true;
  coverQueue.length = 0;
  queuedCoverIds.clear();
  saveManager?.stop();
  scanner?.dispose();
  coverManager?.dispose();
  googleDrive?.dispose();
  if (cloudTimer) clearInterval(cloudTimer);
  if (watcherStartTimer) clearTimeout(watcherStartTimer);
  watcher?.stop().catch(() => {});
});
