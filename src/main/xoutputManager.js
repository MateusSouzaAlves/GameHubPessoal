const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

class XOutputManager {
  constructor(dataDir, resourcesPath, appRoot, onStatusChange = null) {
    this.toolDir = path.join(dataDir, 'tools', 'XOutput');
    this.resourcesPath = resourcesPath;
    this.appRoot = appRoot;
    this.onStatusChange = onStatusChange;
    this.process = null;
    this.prepare();
  }

  get packagedSourceDir() { return path.join(this.resourcesPath, 'vendor', 'XOutput'); }
  get developmentSourceDir() { return path.join(this.appRoot, 'vendor', 'XOutput'); }
  get executablePath() { return path.join(this.toolDir, 'XOutput.exe'); }
  get licensePath() { return path.join(this.toolDir, 'LICENSE.txt'); }
  get settingsPath() { return path.join(this.toolDir, 'settings.json'); }

  prepare() {
    fs.mkdirSync(this.toolDir, { recursive: true });
    const sourceDir = fs.existsSync(path.join(this.packagedSourceDir, 'XOutput.exe')) ? this.packagedSourceDir : this.developmentSourceDir;
    const sourceExecutable = path.join(sourceDir, 'XOutput.exe');
    if (fs.existsSync(sourceExecutable)) {
      let shouldCopy = !fs.existsSync(this.executablePath);
      if (!shouldCopy) {
        try { shouldCopy = fs.statSync(sourceExecutable).size !== fs.statSync(this.executablePath).size; } catch { shouldCopy = true; }
      }
      if (shouldCopy) fs.copyFileSync(sourceExecutable, this.executablePath);
    }
    const sourceLicense = path.join(sourceDir, 'LICENSE.txt');
    if (fs.existsSync(sourceLicense) && !fs.existsSync(this.licensePath)) fs.copyFileSync(sourceLicense, this.licensePath);
    const legacySettings = path.join(this.developmentSourceDir, 'settings.json');
    if (!fs.existsSync(this.settingsPath) && fs.existsSync(legacySettings)) {
      fs.copyFileSync(legacySettings, this.settingsPath);
    }
  }

  launch() {
    if (this.process && !this.process.killed) {
      return { success: false, alreadyRunning: true, message: 'XOutput já está em execução.' };
    }
    this.prepare();
    if (!fs.existsSync(this.executablePath)) {
      return { success: false, message: 'XOutput não foi encontrado no pacote do Nexus.' };
    }
    try {
      const child = execFile(this.executablePath, [], {
        cwd: this.toolDir,
        detached: false,
        windowsHide: false,
        stdio: 'ignore'
      });
      this.process = child;
      child.once('spawn', () => this.onStatusChange?.(true));
      child.once('exit', () => {
        if (this.process === child) this.process = null;
        this.onStatusChange?.(false);
      });
      child.once('error', error => {
        console.error('[XOutput]', error.message);
        if (this.process === child) this.process = null;
        this.onStatusChange?.(false);
      });
      return { success: true, message: 'XOutput iniciado com a configuração local preservada.' };
    } catch (error) {
      this.process = null;
      return { success: false, message: `Erro ao iniciar XOutput: ${error.message}` };
    }
  }

  getStatus() {
    return {
      available: fs.existsSync(this.executablePath),
      running: Boolean(this.process && !this.process.killed),
      hasLocalSettings: fs.existsSync(this.settingsPath)
    };
  }

  getFolder() { return this.toolDir; }
}

module.exports = XOutputManager;
