const fs = require('fs');
const path = require('path');
const { atomicWriteJson, clamp, normalizePath } = require('./utils');

const DEFAULT_CONFIG = Object.freeze({
  scanPaths: [],
  excludedExecutables: [
    'unins000.exe', 'uninstall.exe', 'uninst.exe', 'crashreport.exe',
    'crashpad_handler.exe', 'crashhandler.exe', 'installermessage.exe',
    'updater.exe', 'setup.exe', 'bugsplathd64.exe', 'bssndrpt64.exe',
    'vc_redist.x64.exe', 'vc_redist.x86.exe', 'dxsetup.exe',
    'dotnetfx35setup.exe', 'easyanticheat.exe', 'eac_launcher.exe'
  ],
  excludedFolders: [
    '_Redist', 'Redist', '_CommonRedist', 'DirectX', '__Installer',
    'DotNetFX', 'node_modules', '.git', 'CrashReportClient'
  ],
  utilityPatterns: [
    'xoutput', 'pcsx2', 'desmume', 'retroarch', 'rpcs3', 'yuzu',
    'cemu', 'dolphin', 'ppsspp', 'mame'
  ],
  scanDepth: 4,
  theme: 'dark',
  windowWidth: 1400,
  windowHeight: 900,
  autoBackup: true,
  backupIntervalMinutes: 30,
  backupRetention: 10,
  maxBackupSizeMB: 2048,
  interfaceSounds: true,
  interfaceAnimations: true,
  cloud: {
    provider: 'googleDrive',
    enabled: false,
    autoSync: true,
    syncIntervalMinutes: 30
  }
});

const clone = value => JSON.parse(JSON.stringify(value));

class ConfigManager {
  constructor(dataDir) {
    this.configPath = path.join(dataDir, 'config.json');
    this.config = clone(DEFAULT_CONFIG);
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.configPath)) return;
      const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      this.config = {
        ...clone(DEFAULT_CONFIG),
        ...saved,
        cloud: { ...clone(DEFAULT_CONFIG.cloud), ...(saved.cloud || {}) }
      };
      this.sanitize();
    } catch (error) {
      console.error('[Config] Failed to load config:', error.message);
      this.config = clone(DEFAULT_CONFIG);
    }
  }

  sanitize() {
    const uniquePaths = new Map();
    for (const scanPath of Array.isArray(this.config.scanPaths) ? this.config.scanPaths : []) {
      if (typeof scanPath !== 'string' || !scanPath.trim()) continue;
      uniquePaths.set(normalizePath(scanPath), path.resolve(scanPath));
    }
    this.config.scanPaths = [...uniquePaths.values()];
    this.config.scanDepth = clamp(this.config.scanDepth, 1, 8, DEFAULT_CONFIG.scanDepth);
    this.config.windowWidth = clamp(this.config.windowWidth, 900, 7680, DEFAULT_CONFIG.windowWidth);
    this.config.windowHeight = clamp(this.config.windowHeight, 600, 4320, DEFAULT_CONFIG.windowHeight);
    this.config.backupIntervalMinutes = clamp(this.config.backupIntervalMinutes, 5, 1440, DEFAULT_CONFIG.backupIntervalMinutes);
    this.config.backupRetention = clamp(this.config.backupRetention, 1, 100, DEFAULT_CONFIG.backupRetention);
    this.config.maxBackupSizeMB = clamp(this.config.maxBackupSizeMB, 10, 10240, DEFAULT_CONFIG.maxBackupSizeMB);
    this.config.cloud.syncIntervalMinutes = clamp(this.config.cloud.syncIntervalMinutes, 5, 1440, DEFAULT_CONFIG.cloud.syncIntervalMinutes);
    this.config.autoBackup = Boolean(this.config.autoBackup);
    this.config.interfaceSounds = Boolean(this.config.interfaceSounds);
    this.config.interfaceAnimations = Boolean(this.config.interfaceAnimations);
    this.config.cloud.enabled = Boolean(this.config.cloud.enabled);
    this.config.cloud.autoSync = Boolean(this.config.cloud.autoSync);
  }

  save() {
    this.sanitize();
    atomicWriteJson(this.configPath, this.config);
  }

  get(key) { return this.config[key]; }

  set(key, value) {
    this.config[key] = value;
    this.save();
  }

  updateSettings(settings = {}) {
    const allowed = [
      'scanDepth', 'autoBackup', 'backupIntervalMinutes', 'backupRetention',
      'maxBackupSizeMB', 'interfaceSounds', 'interfaceAnimations'
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(settings, key)) this.config[key] = settings[key];
    }
    if (settings.cloud && typeof settings.cloud === 'object') {
      for (const key of ['autoSync', 'syncIntervalMinutes']) {
        if (Object.prototype.hasOwnProperty.call(settings.cloud, key)) this.config.cloud[key] = settings.cloud[key];
      }
    }
    this.save();
    return this.getAll();
  }

  getAll() { return clone(this.config); }

  addScanPath(scanPath) {
    const resolved = path.resolve(scanPath);
    const normalized = normalizePath(resolved);
    if (this.config.scanPaths.some(item => normalizePath(item) === normalized)) return false;
    this.config.scanPaths.push(resolved);
    this.save();
    return true;
  }

  removeScanPath(scanPath) {
    const normalized = normalizePath(scanPath);
    const index = this.config.scanPaths.findIndex(item => normalizePath(item) === normalized);
    if (index < 0) return false;
    this.config.scanPaths.splice(index, 1);
    this.save();
    return true;
  }

  isExcludedExecutable(exeName) {
    return this.config.excludedExecutables.some(item => item.toLowerCase() === String(exeName).toLowerCase());
  }

  isExcludedFolder(folderName) {
    const lower = String(folderName).toLowerCase();
    return this.config.excludedFolders.some(item => lower === item.toLowerCase());
  }

  isUtility(folderName) {
    const lower = String(folderName).toLowerCase();
    return this.config.utilityPatterns.some(pattern => lower.includes(pattern));
  }
}

ConfigManager.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports = ConfigManager;
