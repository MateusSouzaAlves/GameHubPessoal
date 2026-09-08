const App = {
  isRefreshing: false,
  recentState: { added: false, played: false },
  selectedGameId: null,

  async init() {
    let shouldScanInBackground = false;
    AudioUI.init();
    Search.init();
    Settings.init();
    GamepadNavigation.init();
    this.bindEvents();
    EmptyState.showLoading();
    try {
      const config = await window.api.config.get();
      this.applyExperienceSettings(config);
      shouldScanInBackground = Boolean(config.scanPaths?.length);
      this.finishBoot();
      await this.waitForFirstPaint();
      await this.loadLibrary();
      const qaView = new URLSearchParams(location.search).get('qa');
      if (qaView === 'settings') await Settings.open();
      if (qaView === 'game' && Library.games[0]) await this.openGameDetails(Library.games[0].id);
      this.scheduleSecondaryContent();
    } catch (error) {
      console.error('[App] Initialization failed:', error);
      EmptyState.show();
      Helpers.toast('Não foi possível iniciar a biblioteca.', 'error');
      this.finishBoot();
    }

    window.api.library.onUpdated(() => this.reloadLibrary({ quiet: true }));
    window.api.library.onScanProgress(progress => this.updateScanProgress(progress));
    window.api.library.onCoverChanged(game => this.updateGameCover(game));
    window.api.game.onStatusChanged(() => this.reloadLibrary({ quiet: true }));
    window.api.saves.onBackupCreated(event => {
      Helpers.toast(`Backup automático criado para ${Library.find(event.gameId)?.name || 'o jogo'}.`, 'success');
      this.loadDashboard();
    });
    window.api.cloud.onStatusChanged(status => this.updateCloudIndicator(status));
    window.api.xoutput.onStatusChanged(status => this.updateXOutputIndicator(status));
    if (shouldScanInBackground) this.scheduleBackgroundScan();
  },

  bindEvents() {
    document.getElementById('btnMinimize').addEventListener('click', () => window.api.window.minimize());
    document.getElementById('btnMaximize').addEventListener('click', () => window.api.window.maximize());
    document.getElementById('btnClose').addEventListener('click', () => window.api.window.close());
    document.getElementById('btnRefresh').addEventListener('click', () => this.refreshLibrary());
    document.getElementById('btnXOutput').addEventListener('click', () => this.launchXOutput());
    document.querySelectorAll('.sort-btn').forEach(button => button.addEventListener('click', () => { Library.sort(button.dataset.sort); AudioUI.move(); }));
    document.getElementById('viewGrid').addEventListener('click', () => Library.setView('grid'));
    document.getElementById('viewList').addEventListener('click', () => Library.setView('list'));
    document.getElementById('statCloud').addEventListener('click', () => Settings.open('cloud'));
    document.getElementById('statBackups').addEventListener('click', () => Settings.open());
    document.getElementById('statGames').addEventListener('click', () => document.getElementById('gameGrid').scrollIntoView({ behavior: 'smooth' }));
    document.getElementById('btnCloseGameModal').addEventListener('click', () => this.closeGameDetails());
    document.getElementById('gameModal').addEventListener('pointerdown', event => { if (event.target === event.currentTarget) this.closeGameDetails(); });
    document.getElementById('btnPlayDetail').addEventListener('click', () => {
      const game = Library.find(this.selectedGameId);
      if (game) { this.closeGameDetails(); this.launchGame(game.id, game.name); }
    });
    document.getElementById('btnBackupGame').addEventListener('click', event => this.backupGame(this.selectedGameId, event.currentTarget));
    document.getElementById('btnDetectSaves').addEventListener('click', event => this.detectSaves(this.selectedGameId, event.currentTarget));
    document.getElementById('btnAddSaveLocation').addEventListener('click', event => this.addSaveLocation(this.selectedGameId, event.currentTarget));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.closeTopModal();
      if (event.key === 'Enter' && document.activeElement?.classList.contains('game-card')) AudioUI.select();
    });
    document.addEventListener('pointerdown', event => {
      if (event.target.closest('button, .game-card')) AudioUI.select();
    }, { passive: true });
  },

  finishBoot() {
    requestAnimationFrame(() => {
      document.getElementById('bootExperience').classList.add('boot-exit');
      document.body.classList.remove('booting');
      setTimeout(() => { document.getElementById('bootExperience').hidden = true; }, 260);
    });
  },

  waitForFirstPaint() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  },

  runWhenIdle(task, timeout = 1200) {
    if ('requestIdleCallback' in window) window.requestIdleCallback(() => task(), { timeout });
    else setTimeout(task, 0);
  },

  scheduleSecondaryContent() {
    setTimeout(() => this.runWhenIdle(async () => {
      const tasks = [this.loadDashboard()];
      if (Library.games.length) tasks.push(this.loadRecentSections());
      await Promise.allSettled(tasks);
    }), 120);
  },

  applyExperienceSettings(config) {
    document.body.classList.toggle('reduce-motion', !config.interfaceAnimations);
    AudioUI.setEnabled(config.interfaceSounds);
  },

  async loadLibrary() {
    const games = await window.api.library.getAll();
    this.renderLibrary(games);
  },

  async reloadLibrary({ quiet = false } = {}) {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      const games = await window.api.library.getAll();
      this.renderLibrary(games, true);
      if (games.length) await this.loadRecentSections();
      await this.loadDashboard();
    } catch (error) {
      if (!quiet) Helpers.toast(`Falha ao atualizar a biblioteca: ${error.message}`, 'error');
    } finally { this.isRefreshing = false; }
  },

  renderLibrary(games, update = false) {
    if (!games?.length) {
      Library.init([]);
      EmptyState.show();
      return;
    }
    if (update) Library.update(games); else Library.init(games);
    EmptyState.showLibrary();
    if (!this.selectedGameId || !Library.find(this.selectedGameId)) this.previewGame(games[0]);
  },

  async loadRecentSections() {
    const [added, played] = await Promise.all([
      window.api.library.getRecentlyAdded(8),
      window.api.library.getRecentlyPlayed(8)
    ]);
    Library.renderRecentlyAdded(added);
    Library.renderRecentlyPlayed(played);
    Library.showSections();
  },

  async refreshLibrary({ quiet = false } = {}) {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    const button = document.getElementById('btnRefresh');
    button.classList.add('spinning');
    button.disabled = true;
    this.showScanStatus('Procurando jogos...', 0, 0);
    try {
      const games = await window.api.library.scan();
      this.renderLibrary(games, true);
      if (games.length) await this.loadRecentSections();
      await this.loadDashboard();
      if (!quiet) Helpers.toast(`${games.length} jogo${games.length === 1 ? '' : 's'} encontrado${games.length === 1 ? '' : 's'}.`, 'success');
    } catch (error) {
      Helpers.toast(`Falha na varredura: ${error.message}`, 'error');
      AudioUI.error();
    } finally {
      this.isRefreshing = false;
      button.classList.remove('spinning');
      button.disabled = false;
      setTimeout(() => this.hideScanStatus(), 650);
    }
  },

  scheduleBackgroundScan() {
    setTimeout(() => {
      const start = () => this.refreshLibrary({ quiet: true });
      this.runWhenIdle(start, 1800);
    }, document.body.classList.contains('reduce-motion') ? 350 : 900);
  },

  updateScanProgress(progress = {}) {
    if (progress.phase === 'complete') {
      this.showScanStatus(progress.message || 'Biblioteca atualizada', progress.total || 1, progress.total || 1);
      return;
    }
    this.showScanStatus(progress.message || 'Procurando jogos...', progress.current || 0, progress.total || 0);
  },

  showScanStatus(message, current, total) {
    const banner = document.getElementById('scanBanner');
    const bar = document.getElementById('scanProgressBar');
    document.getElementById('scanStatusText').textContent = message;
    banner.hidden = false;
    if (total > 0) {
      bar.max = total;
      bar.value = Math.min(current, total);
      bar.removeAttribute('data-indeterminate');
    } else {
      bar.removeAttribute('value');
      bar.setAttribute('data-indeterminate', 'true');
    }
  },

  hideScanStatus() {
    if (!this.isRefreshing) document.getElementById('scanBanner').hidden = true;
  },

  updateGameCover(game) {
    if (!game?.id || !game.coverUrl) return;
    const libraryGame = Library.find(game.id);
    if (libraryGame) libraryGame.coverUrl = game.coverUrl;
    document.querySelectorAll(`[data-game-id="${game.id}"] .card-cover`).forEach(image => {
      image.removeAttribute('data-fallback');
      image.src = game.coverUrl;
    });
    if (this.selectedGameId === game.id) {
      document.getElementById('consoleHero').style.setProperty('--hero-cover', `url("${String(game.coverUrl).replace(/"/g, '%22')}")`);
      const detailCover = document.getElementById('gameModalCover');
      if (!document.getElementById('gameModal').hidden) detailCover.src = game.coverUrl;
    }
  },

  async loadDashboard() {
    try {
      const [summary, cloud] = await Promise.all([window.api.analytics.getSummary(), window.api.cloud.getStatus()]);
      document.getElementById('summaryGames').textContent = summary.gameCount;
      document.getElementById('summaryHours').textContent = Helpers.formatDuration(summary.totalPlaySeconds);
      document.getElementById('summaryBackups').textContent = summary.backupCount;
      document.getElementById('summaryCloud').textContent = cloud.connected ? 'Drive' : 'Local';
      this.updateCloudIndicator(cloud);
    } catch (error) { console.warn('[Dashboard]', error); }
  },

  updateCloudIndicator(status) {
    document.body.classList.toggle('cloud-connected', Boolean(status.connected));
    document.getElementById('summaryCloud').textContent = status.connected ? 'Drive' : 'Local';
    const button = document.getElementById('btnCloud');
    button.classList.toggle('cloud-online', Boolean(status.connected));
    button.title = status.connected ? `Google Drive conectado${status.email ? ` — ${status.email}` : ''}` : 'Configurar Google Drive';
  },

  updateXOutputIndicator(status) {
    document.getElementById('btnXOutput').classList.toggle('xoutput-running', Boolean(status.running));
    if (!document.getElementById('settingsModal').hidden) Settings.renderXOutputStatus(status);
  },

  previewGame(game) {
    if (!game) return;
    this.selectedGameId = game.id;
    document.getElementById('heroEyebrow').textContent = game.isRunning ? 'EM EXECUÇÃO' : game.lastPlayed ? `JOGADO ${Helpers.formatRelativeTime(game.lastPlayed).toUpperCase()}` : 'PRONTO PARA JOGAR';
    document.getElementById('heroTitle').textContent = game.name;
    const total = game.analytics?.totalPlaySeconds || 0;
    const saves = game.saveInfo?.locations?.length || 0;
    document.getElementById('heroSubtitle').textContent = `${game.playCount || 0} inicializações · ${Helpers.formatDuration(total)} registradas · ${saves ? `${saves} local(is) de save protegido(s)` : 'saves ainda não detectados'}`;
    document.getElementById('consoleHero').style.setProperty('--hero-cover', `url("${String(game.coverUrl).replace(/"/g, '%22')}")`);
  },

  async launchGame(gameId, gameName) {
    const notification = document.getElementById('launchNotification');
    document.getElementById('launchText').textContent = `Iniciando ${gameName}...`;
    notification.hidden = false;
    try {
      const result = await window.api.game.launch(gameId);
      if (!result.success) throw new Error(result.message);
      Helpers.toast(result.message, 'success');
      AudioUI.success();
      await this.reloadLibrary({ quiet: true });
    } catch (error) {
      Helpers.toast(error.message, 'error');
      AudioUI.error();
      await this.reloadLibrary({ quiet: true });
    } finally {
      setTimeout(() => { notification.hidden = true; }, 1200);
    }
  },

  async launchXOutput() {
    try {
      const result = await window.api.xoutput.launch();
      Helpers.toast(result.message, result.success ? 'success' : result.alreadyRunning ? 'warning' : 'error');
      this.updateXOutputIndicator(await window.api.xoutput.status());
    } catch (error) { Helpers.toast(error.message, 'error'); }
  },

  async openGameDetails(gameId) {
    const game = Library.find(gameId);
    if (!game) return;
    this.selectedGameId = gameId;
    document.getElementById('gameModalTitle').textContent = game.name;
    const cover = document.getElementById('gameModalCover');
    cover.src = game.coverUrl;
    cover.alt = `Capa de ${game.name}`;
    cover.onerror = () => { cover.onerror = null; cover.src = Helpers.fallbackCover(game.name); };
    document.getElementById('detailPlayCount').textContent = game.playCount || 0;
    document.getElementById('detailPlayTime').textContent = Helpers.formatDuration(game.analytics?.totalPlaySeconds || 0);
    document.getElementById('detailBackupCount').textContent = game.backupHistory?.length || 0;
    this.renderSaveLocations(game.saveInfo?.locations || []);
    this.renderBackupVersions(game.backupHistory || []);
    document.getElementById('gameModal').hidden = false;
    document.body.classList.add('modal-open');
    setTimeout(() => document.getElementById('btnPlayDetail').focus(), 40);
  },

  closeGameDetails() {
    document.getElementById('gameModal').hidden = true;
    if (document.getElementById('settingsModal').hidden) document.body.classList.remove('modal-open');
  },

  renderSaveLocations(locations) {
    const container = document.getElementById('saveLocations');
    container.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = 'Locais de save';
    container.appendChild(heading);
    if (!locations.length) {
      const empty = document.createElement('p');
      empty.className = 'save-empty';
      empty.textContent = 'Nenhuma pasta detectada. Use “Detectar saves” ou adicione uma pasta manualmente.';
      container.appendChild(empty);
      return;
    }
    locations.forEach(location => {
      const item = document.createElement('div');
      item.className = 'save-location-item';
      const copy = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = location.source === 'manual' ? 'Pasta manual' : location.source;
      const pathText = document.createElement('span');
      pathText.textContent = location.path;
      copy.append(name, pathText);
      const size = document.createElement('small');
      size.textContent = `${location.fileCount || 0} arquivos · ${Helpers.formatSize(location.totalBytes || 0)}`;
      item.append(copy, size);
      container.appendChild(item);
    });
  },

  renderBackupVersions(backups) {
    const container = document.getElementById('backupVersions');
    container.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = 'Versões locais';
    container.appendChild(heading);
    if (!backups.length) {
      const empty = document.createElement('p');
      empty.className = 'save-empty';
      empty.textContent = 'Ainda não há versões de backup para este jogo.';
      container.appendChild(empty);
      return;
    }
    backups.slice(0, 10).forEach(backup => {
      const item = document.createElement('div');
      item.className = 'backup-version-item';
      const description = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = Helpers.formatRelativeTime(backup.createdAt);
      const detail = document.createElement('span');
      detail.textContent = `${Helpers.formatSize(backup.size)} · ${backup.fileCount || 0} arquivos · ${backup.cloud?.synced ? 'Google Drive' : 'somente local'}`;
      description.append(title, detail);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'btn-secondary restore-button';
      restore.dataset.gamepad = '';
      restore.textContent = 'Restaurar';
      restore.addEventListener('click', () => this.restoreBackup(this.selectedGameId, backup.id, restore));
      item.append(description, restore);
      container.appendChild(item);
    });
  },

  async restoreBackup(gameId, backupId, button) {
    if (!window.confirm('Restaurar esta versão sobre os saves atuais? Os arquivos correspondentes serão substituídos.')) return;
    Settings.setBusy(button, true, 'Restaurando...');
    try {
      const result = await window.api.saves.restoreBackup(gameId, backupId);
      Helpers.toast(`${result.restoredFiles} arquivo(s) restaurado(s).`, 'success');
      AudioUI.success();
      await this.reloadLibrary({ quiet: true });
    } catch (error) { Helpers.toast(error.message, 'error'); AudioUI.error(); }
    finally { Settings.setBusy(button, false); }
  },

  async detectSaves(gameId, button) {
    if (!gameId) return;
    Settings.setBusy(button, true, 'Detectando...');
    try {
      const result = await window.api.saves.discover(gameId);
      this.renderSaveLocations(result.locations);
      Helpers.toast(`${result.locations.length} local(is) de save detectado(s).`, result.locations.length ? 'success' : 'warning');
      await this.reloadLibrary({ quiet: true });
    } catch (error) { Helpers.toast(error.message, 'error'); }
    finally { Settings.setBusy(button, false); }
  },

  async addSaveLocation(gameId, button) {
    if (!gameId) return;
    Settings.setBusy(button, true, 'Selecionando...');
    try {
      const result = await window.api.saves.addLocation(gameId);
      if (result.success) { this.renderSaveLocations(result.locations); Helpers.toast('Pasta de saves adicionada.', 'success'); await this.reloadLibrary({ quiet: true }); }
    } catch (error) { Helpers.toast(error.message, 'error'); }
    finally { Settings.setBusy(button, false); }
  },

  async backupGame(gameId, button = null) {
    if (!gameId) return;
    if (button) Settings.setBusy(button, true, 'Criando backup...');
    try {
      const result = await window.api.saves.backupGame(gameId);
      if (!result.success) throw new Error(result.message);
      Helpers.toast(result.skipped ? result.message : `Backup criado: ${Helpers.formatSize(result.backup.size)}.`, result.skipped ? 'info' : 'success');
      await this.reloadLibrary({ quiet: true });
      if (!document.getElementById('gameModal').hidden) this.openGameDetails(gameId);
      AudioUI.success();
    } catch (error) { Helpers.toast(error.message, 'error'); AudioUI.error(); }
    finally { if (button) Settings.setBusy(button, false); }
  },

  closeTopModal() {
    const contextMenu = document.querySelector('.context-menu');
    if (contextMenu) { contextMenu.remove(); return; }
    if (!document.getElementById('gameModal').hidden) { this.closeGameDetails(); return; }
    if (!document.getElementById('settingsModal').hidden) Settings.close();
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
