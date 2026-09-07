const fs = require('fs');
const path = require('path');
const { normalizeTitle, titleSimilarity } = require('./utils');

const PENALTIES = [
  'launcher', 'crash', 'report', 'installer', 'setup', 'redist', 'update',
  'patch', 'config', 'editor', 'server', 'dedicated', 'tool', 'benchmark',
  'anticheat', 'easyanticheat', 'unrealcefsubprocess', 'unitycrashhandler',
  'bugreport', 'bootstrapper', 'prereq', 'helper'
];

const PREFERRED_DIRS = new Set(['bin', 'bin64', 'binaries', 'win64', 'win32', 'x64', 'game']);

class GameScanner {
  constructor(configManager, persistence) {
    this.config = configManager;
    this.persistence = persistence;
  }

  async fullScan() {
    const configuredRoots = this.config.get('scanPaths') || [];
    const availableRoots = configuredRoots.filter(root => fs.existsSync(root));
    const discovered = [];
    console.log(`[Scanner] Scanning ${availableRoots.length}/${configuredRoots.length} configured path(s)`);

    for (const root of availableRoots) {
      discovered.push(...await this.scanDirectory(root));
    }

    const unique = new Map();
    for (const game of discovered) unique.set(game.gamePath.toLowerCase(), game);
    const library = this.persistence.synchronizeScan([...unique.values()], configuredRoots, availableRoots);
    console.log(`[Scanner] Scan complete. ${library.length} game(s) in library.`);
    return library;
  }

  async scanDirectory(rootPath) {
    const games = [];
    try {
      const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
      const directories = entries.filter(entry => entry.isDirectory());
      for (const entry of directories) {
        if (this.config.isExcludedFolder(entry.name) || this.config.isUtility(entry.name)) continue;
        const game = await this.analyzeGameFolder(path.join(rootPath, entry.name), entry.name);
        if (game) games.push(game);
      }
    } catch (error) {
      console.error(`[Scanner] Failed to scan ${rootPath}:`, error.message);
    }
    return games;
  }

  async analyzeGameFolder(gamePath, folderName) {
    const maxDepth = this.config.get('scanDepth') || 4;
    const candidates = await this.findExecutables(gamePath, maxDepth);
    if (!candidates.length) return null;
    const scored = candidates.map(candidate => ({ ...candidate, score: this.scoreExecutable(candidate, folderName) }))
      .sort((left, right) => right.score - left.score || right.size - left.size);
    const best = scored[0];
    if (!best || best.score < 4) return null;
    return {
      name: this.formatGameName(folderName),
      gamePath,
      executablePath: best.fullPath,
      executableSize: best.size,
      folderName,
      steamAppId: await this.detectSteamAppId(gamePath, folderName),
      detection: { confidence: Math.min(1, Math.max(0.25, best.score / 35)), candidateCount: candidates.length },
      status: 'ready'
    };
  }

  async findExecutables(gamePath, maxDepth = 4) {
    const executables = [];
    const queue = [{ directory: gamePath, depth: 0 }];
    let visitedEntries = 0;
    while (queue.length && visitedEntries < 20000) {
      const current = queue.shift();
      let entries;
      try {
        entries = await fs.promises.readdir(current.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      visitedEntries += entries.length;
      for (const entry of entries) {
        const fullPath = path.join(current.directory, entry.name);
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe') && !this.config.isExcludedExecutable(entry.name)) {
          try {
            const stats = await fs.promises.stat(fullPath);
            executables.push({
              name: entry.name,
              fullPath,
              size: stats.size,
              depth: current.depth,
              relativePath: path.relative(gamePath, fullPath)
            });
          } catch {}
        } else if (entry.isDirectory() && current.depth < maxDepth && !this.shouldSkipDirectory(entry.name)) {
          queue.push({ directory: fullPath, depth: current.depth + 1 });
        }
      }
    }
    return executables;
  }

  shouldSkipDirectory(name) {
    const lower = name.toLowerCase();
    return this.config.isExcludedFolder(name) || [
      'assets', 'content', 'movies', 'videos', 'soundtrack', 'ost', 'screenshots',
      'mods', 'workshop', 'documentation', 'docs', 'support', 'redistributables'
    ].includes(lower);
  }

  scoreExecutable(candidate, folderName) {
    const exeBase = candidate.name.replace(/\.exe$/i, '')
      .replace(/[-_ ]?(win(32|64)|x64|shipping|release|dx(9|11|12))$/i, '');
    const similarity = titleSimilarity(exeBase, folderName);
    let score = Math.round(similarity * 24);
    const lower = candidate.name.toLowerCase();
    const relativeParts = candidate.relativePath.toLowerCase().split(path.sep);
    if (candidate.depth === 0) score += 6;
    if (relativeParts.some(part => PREFERRED_DIRS.has(part))) score += 3;
    if (/shipping/i.test(candidate.name)) score += 2;
    if (candidate.size > 100 * 1024 * 1024) score += 5;
    else if (candidate.size > 10 * 1024 * 1024) score += 3;
    else if (candidate.size > 1024 * 1024) score += 1;
    if (candidate.size < 100 * 1024) score -= 3;
    if (PENALTIES.some(word => lower.includes(word))) score -= 16;
    if (normalizeTitle(exeBase).length < 3) score -= 3;
    return score;
  }

  formatGameName(folderName) {
    return folderName
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/\s*\((x64|pc|gog|steam|portable)\)\s*$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async detectSteamAppId(gamePath, folderName) {
    const commonPath = path.dirname(gamePath);
    if (path.basename(commonPath).toLowerCase() !== 'common') return null;
    const steamAppsPath = path.dirname(commonPath);
    if (path.basename(steamAppsPath).toLowerCase() !== 'steamapps') return null;
    try {
      const manifests = (await fs.promises.readdir(steamAppsPath)).filter(name => /^appmanifest_\d+\.acf$/i.test(name));
      for (const manifest of manifests) {
        const raw = await fs.promises.readFile(path.join(steamAppsPath, manifest), 'utf8');
        const installDir = raw.match(/"installdir"\s+"([^"]+)"/i)?.[1];
        if (installDir && installDir.toLowerCase() === folderName.toLowerCase()) {
          return raw.match(/"appid"\s+"(\d+)"/i)?.[1] || manifest.match(/\d+/)?.[0] || null;
        }
      }
    } catch {}
    return null;
  }

  async scanSingleFolder(gamePath) {
    const folderName = path.basename(gamePath);
    if (this.config.isExcludedFolder(folderName) || this.config.isUtility(folderName)) return null;
    const result = await this.analyzeGameFolder(gamePath, folderName);
    return result ? this.persistence.upsert(result) : null;
  }

  removeGameByPath(gamePath) {
    const game = this.persistence.getByPath(gamePath);
    if (!game) return false;
    delete this.persistence.library[game.id];
    this.persistence.save();
    return true;
  }
}

module.exports = GameScanner;
