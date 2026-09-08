const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson, isSubPath } = require('./utils');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const createLibrary = () => Object.create(null);

function isGameRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.name === 'string' && value.name.trim()
    && typeof value.gamePath === 'string' && value.gamePath.trim()
    && typeof value.executablePath === 'string' && value.executablePath.trim();
}

class Persistence {
  constructor(dataDir) {
    this.dbPath = path.join(dataDir, 'library.json');
    this.library = createLibrary();
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.dbPath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      this.library = createLibrary();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [key, game] of Object.entries(parsed)) {
        if (!isGameRecord(game)) continue;
        const id = typeof game.id === 'string' && game.id.trim() ? game.id : key;
        if (!/^[a-f0-9]{12,64}$/i.test(id)) continue;
        this.library[id] = { ...game, id };
      }
    } catch (error) {
      console.error('[Persistence] Failed to load library:', error.message);
      this.library = createLibrary();
    }
  }

  save() { atomicWriteJson(this.dbPath, this.library); }

  generateId(gamePath) {
    return crypto.createHash('sha256').update(path.resolve(gamePath).toLowerCase()).digest('hex').slice(0, 16);
  }

  getAll() { return clone(Object.values(this.library)); }
  getById(id) { return clone(this.library[id] || null); }

  getByPath(gamePath) {
    const target = path.resolve(gamePath).toLowerCase();
    return clone(Object.values(this.library).find(game => typeof game.gamePath === 'string' && path.resolve(game.gamePath).toLowerCase() === target) || null);
  }

  buildGame(gameData, existing = null) {
    const now = new Date().toISOString();
    const id = gameData.id || this.generateId(gameData.gamePath);
    return {
      ...(existing || {}),
      id,
      name: gameData.name,
      gamePath: gameData.gamePath,
      executablePath: gameData.executablePath,
      executableSize: gameData.executableSize || 0,
      folderName: gameData.folderName || path.basename(gameData.gamePath),
      steamAppId: gameData.steamAppId || existing?.steamAppId || null,
      status: gameData.status || 'ready',
      coverCache: gameData.coverCache || existing?.coverCache || null,
      detectedAt: existing?.detectedAt || now,
      lastUpdated: now,
      lastPlayed: existing?.lastPlayed || null,
      playCount: existing?.playCount || 0,
      analytics: existing?.analytics || { totalPlaySeconds: 0, sessions: [], failedLaunches: 0 },
      saveInfo: existing?.saveInfo || { locations: [], lastDetectedAt: null, lastFingerprint: null },
      backupHistory: existing?.backupHistory || []
    };
  }

  upsert(gameData, options = {}) {
    const id = gameData.id || this.generateId(gameData.gamePath);
    this.library[id] = this.buildGame({ ...gameData, id }, this.library[id]);
    if (options.save !== false) this.save();
    return clone(this.library[id]);
  }

  synchronizeScan(discoveredGames, configuredRoots, availableRoots) {
    const discoveredIds = new Set();
    for (const game of discoveredGames) {
      const existingByPath = Object.values(this.library).find(item => typeof item.gamePath === 'string' && path.resolve(item.gamePath).toLowerCase() === path.resolve(game.gamePath).toLowerCase());
      const id = game.id || existingByPath?.id || this.generateId(game.gamePath);
      discoveredIds.add(id);
      this.library[id] = this.buildGame({ ...game, id, status: 'ready' }, this.library[id]);
    }

    for (const [id, game] of Object.entries(this.library)) {
      if (discoveredIds.has(id)) continue;
      const configuredRoot = typeof game.gamePath === 'string' ? configuredRoots.find(root => isSubPath(root, game.gamePath)) : null;
      if (!configuredRoot) {
        delete this.library[id];
      } else if (typeof game.gamePath !== 'string' || !availableRoots.some(root => isSubPath(root, game.gamePath))) {
        game.status = 'offline';
      } else if (!fs.existsSync(game.gamePath)) {
        delete this.library[id];
      } else {
        game.status = 'broken';
        game.lastUpdated = new Date().toISOString();
      }
    }
    this.save();
    return this.getAll();
  }

  updateCover(id, coverCache) {
    const game = this.library[id];
    if (!game || game.coverCache === coverCache) return clone(game || null);
    game.coverCache = coverCache;
    this.save();
    return clone(game);
  }

  updateStatus(id, status) {
    const game = this.library[id];
    if (!game || game.status === status) return clone(game || null);
    game.status = status;
    game.lastUpdated = new Date().toISOString();
    this.save();
    return clone(game);
  }

  recordLaunch(id) {
    const game = this.library[id];
    if (!game) return null;
    game.lastPlayed = new Date().toISOString();
    game.playCount = (game.playCount || 0) + 1;
    game.status = 'running';
    this.save();
    return clone(game);
  }

  recordFailedLaunch(id) {
    const game = this.library[id];
    if (!game) return;
    game.analytics ||= { totalPlaySeconds: 0, sessions: [], failedLaunches: 0 };
    game.analytics.failedLaunches = (game.analytics.failedLaunches || 0) + 1;
    this.save();
  }

  recordSession(id, session) {
    const game = this.library[id];
    if (!game) return null;
    game.analytics ||= { totalPlaySeconds: 0, sessions: [], failedLaunches: 0 };
    game.analytics.totalPlaySeconds = (game.analytics.totalPlaySeconds || 0) + Math.max(0, session.durationSeconds || 0);
    game.analytics.sessions = [session, ...(game.analytics.sessions || [])].slice(0, 100);
    game.status = 'ready';
    game.lastUpdated = new Date().toISOString();
    this.save();
    return clone(game);
  }

  updateSaveInfo(id, saveInfo) {
    const game = this.library[id];
    if (!game) return null;
    game.saveInfo = { ...(game.saveInfo || {}), ...clone(saveInfo) };
    this.save();
    return clone(game);
  }

  recordBackup(id, backup) {
    const game = this.library[id];
    if (!game) return null;
    game.saveInfo ||= { locations: [], lastDetectedAt: null, lastFingerprint: null };
    game.saveInfo.lastFingerprint = backup.fingerprint;
    game.saveInfo.lastBackupAt = backup.createdAt;
    game.backupHistory = [backup, ...(game.backupHistory || []).filter(item => item.id !== backup.id)].slice(0, 100);
    this.save();
    return clone(game);
  }

  markBackupCloudSynced(id, backupId, cloudData) {
    const game = this.library[id];
    if (!game) return null;
    const backup = (game.backupHistory || []).find(item => item.id === backupId);
    if (!backup) return null;
    backup.cloud = { synced: true, syncedAt: new Date().toISOString(), ...clone(cloudData) };
    this.save();
    return clone(backup);
  }

  markCoverCloudSynced(id, coverData) {
    const game = this.library[id];
    if (!game) return null;
    game.cloud = { ...(game.cloud || {}), cover: clone(coverData) };
    this.save();
    return clone(game.cloud.cover);
  }

  getRecentlyAdded(limit = 5) {
    return this.getAll().filter(game => !['broken', 'offline'].includes(game.status))
      .sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt)).slice(0, limit);
  }

  getRecentlyPlayed(limit = 5) {
    return this.getAll().filter(game => game.lastPlayed && !['broken', 'offline'].includes(game.status))
      .sort((a, b) => new Date(b.lastPlayed) - new Date(a.lastPlayed)).slice(0, limit);
  }

  getAnalyticsSummary() {
    const games = Object.values(this.library);
    return {
      gameCount: games.length,
      totalLaunches: games.reduce((sum, game) => sum + (game.playCount || 0), 0),
      totalPlaySeconds: games.reduce((sum, game) => sum + (game.analytics?.totalPlaySeconds || 0), 0),
      backupCount: games.reduce((sum, game) => sum + (game.backupHistory?.length || 0), 0),
      gamesWithSaves: games.filter(game => game.saveInfo?.locations?.length).length
    };
  }
}

module.exports = Persistence;
