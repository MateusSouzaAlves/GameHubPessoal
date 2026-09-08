const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

class GameLauncher {
  constructor(persistence, onStatusChange = null) {
    this.persistence = persistence;
    this.onStatusChange = onStatusChange;
    this.runningProcesses = new Map();
  }

  async launch(gameId) {
    const game = this.persistence.getById(gameId);
    if (!game) return { success: false, message: 'Jogo não encontrado na biblioteca.', gameId };
    if (this.runningProcesses.has(gameId)) return { success: false, message: 'Este jogo já está em execução.', gameId };
    if (!fs.existsSync(game.executablePath)) {
      this.persistence.updateStatus(gameId, 'broken');
      this.persistence.recordFailedLaunch(gameId);
      this.onStatusChange?.(gameId, 'broken');
      return { success: false, message: `Executável não encontrado: ${path.basename(game.executablePath)}`, gameId, broken: true };
    }

    try {
      const startedAt = new Date();
      const child = execFile(game.executablePath, [], {
        cwd: path.dirname(game.executablePath),
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();
      this.runningProcesses.set(gameId, { pid: child.pid, startedAt: startedAt.toISOString(), process: child });
      this.persistence.recordLaunch(gameId);
      this.onStatusChange?.(gameId, 'running');

      const finish = (exitCode, error = null) => {
        if (!this.runningProcesses.has(gameId)) return;
        this.runningProcesses.delete(gameId);
        if (error) this.persistence.recordFailedLaunch(gameId);
        const endedAt = new Date();
        this.persistence.recordSession(gameId, {
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationSeconds: Math.round((endedAt - startedAt) / 1000),
          exitCode,
          error: error?.message || null
        });
        this.onStatusChange?.(gameId, 'ready', { ended: true });
      };
      child.once('exit', code => finish(code));
      child.once('error', error => finish(null, error));
      return { success: true, message: `${game.name} iniciado com sucesso!`, gameId, pid: child.pid };
    } catch (error) {
      this.persistence.recordFailedLaunch(gameId);
      return { success: false, message: `Erro ao iniciar: ${error.message}`, gameId };
    }
  }

  isRunning(gameId) { return this.runningProcesses.has(gameId); }

  getGameStatus(gameId) {
    if (this.isRunning(gameId)) return 'running';
    const game = this.persistence.getById(gameId);
    if (!game) return 'unknown';
    if (!fs.existsSync(game.gamePath)) return 'offline';
    if (!fs.existsSync(game.executablePath)) return 'broken';
    return game.status === 'running' ? 'ready' : (game.status || 'ready');
  }
}

module.exports = GameLauncher;
