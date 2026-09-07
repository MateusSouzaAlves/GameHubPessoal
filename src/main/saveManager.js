const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { normalizeTitle, sanitizeFileName, isSubPath } = require('./utils');

const SAVE_DIR_NAMES = new Set([
  'save', 'saves', 'saved', 'savegame', 'savegames', 'savedata', 'profiles',
  'profile', 'userdata', 'user_data', 'persistentdata'
]);
const IGNORED_DIRS = new Set(['cache', 'shadercache', 'logs', 'log', 'temp', 'tmp', 'crashes', 'screenshots', 'movies']);
const IGNORED_EXTENSIONS = new Set(['.log', '.tmp', '.dmp', '.bak~']);

class SaveManager {
  constructor(dataDir, persistence, configManager, onBackup = null) {
    this.persistence = persistence;
    this.config = configManager;
    this.backupRoot = path.join(dataDir, 'save-backups');
    this.onBackup = onBackup;
    this.running = false;
    this.timer = null;
    fs.mkdirSync(this.backupRoot, { recursive: true });
  }

  start() {
    this.stop();
    if (!this.config.get('autoBackup')) return;
    const interval = (this.config.get('backupIntervalMinutes') || 30) * 60_000;
    this.timer = setInterval(() => this.backupAll({ reason: 'scheduled' }).catch(error => {
      console.error('[Saves] Scheduled backup failed:', error.message);
    }), interval);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async discoverAll() {
    const games = this.persistence.getAll();
    const results = [];
    for (const game of games) results.push(await this.discoverForGame(game.id));
    return results;
  }

  async discoverForGame(gameId) {
    const game = this.persistence.getById(gameId);
    if (!game) throw new Error('Jogo não encontrado.');
    const manual = (game.saveInfo?.locations || []).filter(location => location.manual && fs.existsSync(location.path));
    const candidates = await this.buildCandidates(game);
    const detected = [];
    const seen = new Set(manual.map(location => path.resolve(location.path).toLowerCase()));
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate.path);
      const key = resolved.toLowerCase();
      if (seen.has(key) || !fs.existsSync(resolved)) continue;
      let stats;
      try { stats = await fs.promises.stat(resolved); } catch { continue; }
      if (!stats.isDirectory()) continue;
      const summary = await this.inspectLocation(resolved);
      if (!summary.fileCount) continue;
      seen.add(key);
      detected.push({ path: resolved, source: candidate.source, manual: false, confidence: candidate.confidence, ...summary });
    }
    const locations = [...manual, ...detected].sort((left, right) => (right.confidence || 0) - (left.confidence || 0));
    this.persistence.updateSaveInfo(gameId, { locations, lastDetectedAt: new Date().toISOString() });
    return { gameId, locations };
  }

  async buildCandidates(game) {
    const result = [];
    const add = (candidatePath, source, confidence) => {
      if (candidatePath) result.push({ path: candidatePath, source, confidence });
    };
    const names = this.nameVariants(game);
    const documents = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents') : path.join(os.homedir(), 'Documents');
    const roots = [
      { path: path.join(documents, 'My Games'), source: 'documents', confidence: 0.92 },
      { path: path.join(os.homedir(), 'Saved Games'), source: 'saved-games', confidence: 0.92 },
      { path: process.env.APPDATA, source: 'appdata-roaming', confidence: 0.78 },
      { path: process.env.LOCALAPPDATA, source: 'appdata-local', confidence: 0.78 },
      { path: process.env.LOCALAPPDATA ? path.join(path.dirname(process.env.LOCALAPPDATA), 'LocalLow') : null, source: 'appdata-locallow', confidence: 0.78 }
    ];
    for (const root of roots) {
      if (!root.path || !fs.existsSync(root.path)) continue;
      for (const name of names) add(path.join(root.path, name), root.source, root.confidence);
      try {
        const children = await fs.promises.readdir(root.path, { withFileTypes: true });
        for (const child of children.slice(0, 2000)) {
          if (!child.isDirectory()) continue;
          const similarity = this.nameSimilarity(child.name, game.name);
          if (similarity >= 0.8) add(path.join(root.path, child.name), root.source, Math.min(0.96, similarity));
        }
      } catch {}
    }

    try {
      const children = await fs.promises.readdir(game.gamePath, { withFileTypes: true });
      for (const child of children) {
        if (child.isDirectory() && SAVE_DIR_NAMES.has(child.name.toLowerCase())) {
          add(path.join(game.gamePath, child.name), 'game-folder', 0.98);
        }
      }
    } catch {}

    if (game.steamAppId) {
      for (const steamRoot of this.findSteamRoots(game.gamePath)) {
        const userdataRoot = path.join(steamRoot, 'userdata');
        try {
          const users = await fs.promises.readdir(userdataRoot, { withFileTypes: true });
          for (const user of users) {
            if (!user.isDirectory()) continue;
            add(path.join(userdataRoot, user.name, String(game.steamAppId)), 'steam-cloud', 1);
          }
        } catch {}
      }
    }
    return result;
  }

  nameVariants(game) {
    const values = new Set([game.name, game.folderName]);
    for (const value of [...values]) {
      if (!value) continue;
      values.add(value.replace(/[-_]+/g, ' '));
      values.add(value.replace(/[^a-z0-9]/gi, ''));
      values.add(value.replace(/\s+(remastered|enhanced|edition|goty)$/i, ''));
    }
    return [...values].filter(Boolean);
  }

  nameSimilarity(left, right) {
    const a = normalizeTitle(left);
    const b = normalizeTitle(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.replace(/ /g, '') === b.replace(/ /g, '')) return 0.98;
    const aTokens = new Set(a.split(' '));
    const bTokens = new Set(b.split(' '));
    const matches = [...aTokens].filter(token => bTokens.has(token)).length;
    return matches / Math.max(aTokens.size, bTokens.size);
  }

  findSteamRoots(gamePath) {
    const roots = new Set();
    const lowerParts = path.resolve(gamePath).split(path.sep);
    const steamAppsIndex = lowerParts.findIndex(part => part.toLowerCase() === 'steamapps');
    if (steamAppsIndex > 0) roots.add(lowerParts.slice(0, steamAppsIndex).join(path.sep));
    const conventional = [
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Steam'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Steam')
    ];
    for (const root of conventional) if (root && fs.existsSync(root)) roots.add(root);
    return [...roots];
  }

  async inspectLocation(locationPath) {
    let fileCount = 0;
    let totalBytes = 0;
    let newestModifiedAt = 0;
    const queue = [{ directory: locationPath, depth: 0 }];
    while (queue.length && fileCount < 50_000) {
      const current = queue.shift();
      let entries;
      try { entries = await fs.promises.readdir(current.directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isSymbolicLink?.()) continue;
        const fullPath = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < 8 && !IGNORED_DIRS.has(entry.name.toLowerCase())) queue.push({ directory: fullPath, depth: current.depth + 1 });
        } else if (entry.isFile() && !IGNORED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          try {
            const stats = await fs.promises.stat(fullPath);
            fileCount += 1;
            totalBytes += stats.size;
            newestModifiedAt = Math.max(newestModifiedAt, stats.mtimeMs);
          } catch {}
        }
      }
    }
    return { fileCount, totalBytes, newestModifiedAt: newestModifiedAt ? new Date(newestModifiedAt).toISOString() : null };
  }

  async addManualLocation(gameId, locationPath) {
    const game = this.persistence.getById(gameId);
    if (!game) throw new Error('Jogo não encontrado.');
    if (!fs.existsSync(locationPath) || !(await fs.promises.stat(locationPath)).isDirectory()) throw new Error('A pasta de saves não existe.');
    const summary = await this.inspectLocation(locationPath);
    const existing = game.saveInfo?.locations || [];
    const resolved = path.resolve(locationPath);
    const locations = existing.filter(location => path.resolve(location.path).toLowerCase() !== resolved.toLowerCase());
    locations.unshift({ path: resolved, source: 'manual', manual: true, confidence: 1, ...summary });
    this.persistence.updateSaveInfo(gameId, { locations, lastDetectedAt: new Date().toISOString() });
    return locations;
  }

  async fingerprint(locations) {
    const hash = crypto.createHash('sha256');
    let totalBytes = 0;
    let fileCount = 0;
    for (let index = 0; index < locations.length; index += 1) {
      const root = locations[index].path;
      const queue = [''];
      while (queue.length && fileCount < 50_000) {
        const relativeDir = queue.shift();
        const directory = path.join(root, relativeDir);
        let entries;
        try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (entry.isSymbolicLink?.()) continue;
          const relativePath = path.join(relativeDir, entry.name);
          if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name.toLowerCase()) && relativePath.split(path.sep).length <= 8) queue.push(relativePath);
          } else if (entry.isFile() && !IGNORED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            try {
              const stats = await fs.promises.stat(path.join(root, relativePath));
              hash.update(`${index}|${relativePath.toLowerCase()}|${stats.size}|${Math.round(stats.mtimeMs)}\n`);
              totalBytes += stats.size;
              fileCount += 1;
            } catch {}
          }
        }
      }
    }
    return { fingerprint: hash.digest('hex'), totalBytes, fileCount };
  }

  async backupGame(gameId, options = {}) {
    const game = this.persistence.getById(gameId);
    if (!game) throw new Error('Jogo não encontrado.');
    let locations = (game.saveInfo?.locations || []).filter(location => fs.existsSync(location.path));
    if (!locations.length) locations = (await this.discoverForGame(gameId)).locations;
    if (!locations.length) return { success: false, skipped: true, message: 'Nenhuma pasta de saves foi detectada.' };
    const metadata = await this.fingerprint(locations);
    if (!metadata.fileCount) return { success: false, skipped: true, message: 'Nenhum arquivo de save foi encontrado.' };
    const maxBytes = (this.config.get('maxBackupSizeMB') || 2048) * 1024 * 1024;
    if (metadata.totalBytes > maxBytes) {
      return { success: false, skipped: true, message: `Saves excedem o limite de ${this.config.get('maxBackupSizeMB')} MB.` };
    }
    if (!options.force && game.saveInfo?.lastFingerprint === metadata.fingerprint) {
      return { success: true, skipped: true, unchanged: true, message: 'Nenhuma alteração nos saves.' };
    }

    const createdAt = new Date();
    const backupId = createdAt.toISOString().replace(/[:.]/g, '-');
    const gameBackupDir = path.join(this.backupRoot, game.id);
    fs.mkdirSync(gameBackupDir, { recursive: true });
    const destination = path.join(gameBackupDir, `${backupId}.zip`);
    await this.createArchive(destination, game, locations, metadata);
    const stats = await fs.promises.stat(destination);
    const backup = {
      id: backupId,
      createdAt: createdAt.toISOString(),
      reason: options.reason || 'manual',
      path: destination,
      size: stats.size,
      sourceBytes: metadata.totalBytes,
      fileCount: metadata.fileCount,
      fingerprint: metadata.fingerprint,
      cloud: { synced: false }
    };
    this.persistence.recordBackup(gameId, backup);
    await this.enforceRetention(gameId);
    if (this.onBackup) await this.onBackup(gameId, backup).catch(error => console.warn('[Saves] Cloud sync deferred:', error.message));
    return { success: true, skipped: false, backup };
  }

  createArchive(destination, game, locations, metadata) {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('warning', error => error.code === 'ENOENT' ? console.warn('[Saves]', error.message) : reject(error));
      archive.on('error', reject);
      archive.pipe(output);
      archive.append(JSON.stringify({
        formatVersion: 1,
        game: { id: game.id, name: game.name, steamAppId: game.steamAppId || null },
        createdAt: new Date().toISOString(),
        fingerprint: metadata.fingerprint,
        locations: locations.map((location, index) => ({ index, originalPath: location.path, source: location.source }))
      }, null, 2), { name: 'nexus-backup.json' });
      locations.forEach((location, index) => {
        archive.directory(location.path, `saves/${index}`, entry => {
          const parts = entry.name.split('/').map(part => part.toLowerCase());
          if (parts.some(part => IGNORED_DIRS.has(part))) return false;
          if (IGNORED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return false;
          return entry;
        });
      });
      archive.finalize();
    });
  }

  async enforceRetention(gameId) {
    const retention = this.config.get('backupRetention') || 10;
    const directory = path.join(this.backupRoot, gameId);
    let files;
    try { files = await fs.promises.readdir(directory); } catch { return; }
    const backups = [];
    for (const fileName of files.filter(name => name.endsWith('.zip'))) {
      const filePath = path.join(directory, fileName);
      try { backups.push({ path: filePath, mtime: (await fs.promises.stat(filePath)).mtimeMs }); } catch {}
    }
    backups.sort((left, right) => right.mtime - left.mtime);
    for (const oldBackup of backups.slice(retention)) {
      if (isSubPath(this.backupRoot, oldBackup.path)) await fs.promises.unlink(oldBackup.path).catch(() => {});
    }
  }

  async backupAll(options = {}) {
    if (this.running) return { success: false, busy: true, results: [] };
    this.running = true;
    const results = [];
    try {
      for (const game of this.persistence.getAll()) {
        try { results.push({ gameId: game.id, ...(await this.backupGame(game.id, options)) }); }
        catch (error) { results.push({ gameId: game.id, success: false, error: error.message }); }
      }
      return { success: true, results };
    } finally {
      this.running = false;
    }
  }

  getBackups(gameId) {
    const game = this.persistence.getById(gameId);
    return game?.backupHistory || [];
  }

  async restoreBackup(gameId, backupId) {
    const game = this.persistence.getById(gameId);
    if (!game) throw new Error('Jogo não encontrado.');
    const backup = (game.backupHistory || []).find(item => item.id === backupId);
    if (!backup || !fs.existsSync(backup.path) || !isSubPath(this.backupRoot, backup.path)) {
      throw new Error('Backup local não encontrado.');
    }
    const archive = await unzipper.Open.file(backup.path);
    const metadataEntry = archive.files.find(entry => entry.path === 'nexus-backup.json');
    if (!metadataEntry) throw new Error('Este arquivo não é um backup válido do Nexus.');
    if ((metadataEntry.vars?.uncompressedSize || 0) > 1024 * 1024) throw new Error('Metadados do backup excedem o limite permitido.');
    const metadata = JSON.parse((await metadataEntry.buffer()).toString('utf8'));
    if (metadata.formatVersion !== 1 || metadata.game?.id !== gameId || !Array.isArray(metadata.locations)) {
      throw new Error('Os metadados do backup não correspondem a este jogo.');
    }
    const maxBytes = (this.config.get('maxBackupSizeMB') || 2048) * 1024 * 1024;
    const restorePlan = [];
    const destinations = new Set();
    let declaredBytes = 0;
    for (const entry of archive.files) {
      if (entry.type === 'Directory' || entry.path === 'nexus-backup.json') continue;
      const normalizedEntry = entry.path.replace(/\\/g, '/');
      const match = normalizedEntry.match(/^saves\/(\d+)\/(.+)$/);
      if (!match) throw new Error('O backup contém uma entrada inesperada.');
      const index = Number(match[1]);
      const location = metadata.locations[index];
      if (!location?.originalPath || !path.isAbsolute(location.originalPath)) throw new Error('Destino de restauração inválido.');
      const relativePath = match[2];
      if (relativePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Caminho inseguro detectado no backup.');
      const destination = path.resolve(location.originalPath, ...relativePath.split('/'));
      if (!isSubPath(location.originalPath, destination)) throw new Error('O backup tentou gravar fora da pasta de saves.');
      const destinationKey = destination.toLowerCase();
      if (destinations.has(destinationKey)) throw new Error('O backup contém arquivos duplicados.');
      destinations.add(destinationKey);
      const entryBytes = Number(entry.vars?.uncompressedSize || 0);
      if (!Number.isSafeInteger(entryBytes) || entryBytes < 0 || entryBytes > maxBytes) throw new Error('O backup contém um arquivo grande demais.');
      declaredBytes += entryBytes;
      if (declaredBytes > maxBytes || restorePlan.length >= 50_000) throw new Error('O conteúdo do backup excede o limite permitido.');
      restorePlan.push({ entry, destination });
    }
    let restoredBytes = 0;
    for (const item of restorePlan) {
      await fs.promises.mkdir(path.dirname(item.destination), { recursive: true });
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          restoredBytes += chunk.length;
          if (restoredBytes > maxBytes) return callback(new Error('O conteúdo descompactado excede o limite permitido.'));
          callback(null, chunk);
        }
      });
      await pipeline(item.entry.stream(), limiter, fs.createWriteStream(item.destination));
    }
    return { success: true, restoredFiles: restorePlan.length, backupId };
  }

  getBackupRoot() { return this.backupRoot; }
}

module.exports = SaveManager;
