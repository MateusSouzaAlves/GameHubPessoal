// ============================================================
// Folder Watcher — Monitors game directories for changes
// ============================================================
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

class FolderWatcher {
  constructor(configManager, scanner, onUpdate) {
    this.config = configManager;
    this.scanner = scanner;
    this.onUpdate = onUpdate; // Callback when library changes
    this.watchers = [];
    this.debounceTimers = new Map();
    this.started = false;
  }

  /**
   * Start watching all configured scan paths.
   */
  start() {
    if (this.started) return;
    this.started = true;
    const scanPaths = this.config.get('scanPaths') || [];

    for (const scanPath of scanPaths) {
      this.watchPath(scanPath);
    }

    console.log(`[Watcher] Watching ${scanPaths.length} path(s)`);
  }

  /**
   * Watch a single directory for changes.
   */
  watchPath(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    try {
      const watcher = chokidar.watch(dirPath, {
        // A varredura profunda acontece na worker. O watcher acompanha somente
        // a raiz e as pastas de cada jogo para não indexar milhares de assets.
        depth: 1,
        ignoreInitial: true,     // Don't trigger events for existing files
        persistent: true,
        awaitWriteFinish: {
          stabilityThreshold: 2000,
          pollInterval: 500
        },
        ignorePermissionErrors: true
      });

      watcher.on('addDir', (addedPath) => {
        const folderName = path.basename(addedPath);
        const gameFolder = this.getGameFolder(dirPath, addedPath);
        if (!gameFolder) return;
        console.log(`[Watcher] New folder detected: ${folderName}`);
        this.debouncedScan(gameFolder, 'added');
      });

      watcher.on('unlinkDir', (removedPath) => {
        // A folder was removed — game might have been uninstalled
        const folderName = path.basename(removedPath);
        const parentDir = path.dirname(removedPath);

        if (parentDir.toLowerCase() !== dirPath.toLowerCase()) return;

        console.log(`[Watcher] Folder removed: ${folderName}`);
        this.debouncedScan(removedPath, 'removed');
      });

      const handleExecutableChange = changedPath => {
        if (!changedPath.toLowerCase().endsWith('.exe')) return;
        const gameFolder = this.getGameFolder(dirPath, changedPath);
        if (gameFolder) this.debouncedScan(gameFolder, 'changed');
      };
      watcher.on('add', handleExecutableChange);
      watcher.on('unlink', handleExecutableChange);

      watcher.on('error', (err) => {
        console.error(`[Watcher] Error watching ${dirPath}:`, err.message);
      });

      this.watchers.push(watcher);
    } catch (err) {
      console.error(`[Watcher] Failed to start watching ${dirPath}:`, err.message);
    }
  }

  getGameFolder(scanRoot, changedPath) {
    const relative = path.relative(scanRoot, changedPath);
    const firstPart = relative.split(path.sep)[0];
    if (!firstPart || firstPart === '.' || firstPart === '..' || path.isAbsolute(relative)) return null;
    return path.join(scanRoot, firstPart);
  }

  /**
   * Debounced scan to avoid rapid-fire events.
   */
  debouncedScan(changedPath, action) {
    const key = changedPath.toLowerCase();

    if (this.debounceTimers.has(key)) {
      clearTimeout(this.debounceTimers.get(key));
    }

    this.debounceTimers.set(key, setTimeout(async () => {
      this.debounceTimers.delete(key);

      try {
        if (action === 'added' || action === 'changed') {
          const game = await this.scanner.scanSingleFolder(changedPath);
          if (game) {
            console.log(`[Watcher] Game refreshed: ${game.name}`);
          }
        } else if (action === 'removed') {
          this.scanner.removeGameByPath(changedPath);
          console.log(`[Watcher] Game removed from library`);
        }

        // Notify the renderer
        if (this.onUpdate) {
          this.onUpdate();
        }
      } catch (err) {
        console.error(`[Watcher] Error processing change:`, err.message);
      }
    }, 3000)); // Wait 3 seconds for filesystem to settle
  }

  /**
   * Stop all watchers.
   */
  async stop() {
    this.started = false;
    for (const watcher of this.watchers) {
      await watcher.close();
    }
    this.watchers = [];

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    console.log('[Watcher] All watchers stopped');
  }

  /**
   * Restart watchers (e.g., after config change).
   */
  async restart() {
    await this.stop();
    this.start();
  }
}

module.exports = FolderWatcher;
