const Settings = {
  config: null,

  init() {
    document.getElementById('btnSettings').addEventListener('click', () => this.open());
    document.getElementById('btnCloud').addEventListener('click', () => this.open('cloud'));
    document.getElementById('btnEmptySettings').addEventListener('click', () => this.open());
    document.getElementById('btnCloseSettings').addEventListener('click', () => this.close());
    document.getElementById('settingsModal').addEventListener('pointerdown', event => {
      if (event.target === event.currentTarget) this.close();
    });
    document.getElementById('btnAddPath').addEventListener('click', () => this.addPath());
    document.getElementById('btnSaveSettings').addEventListener('click', () => this.save());
    document.getElementById('btnBackupAll').addEventListener('click', event => this.backupAll(event.currentTarget));
    document.getElementById('btnOpenBackups').addEventListener('click', () => window.api.saves.openBackupFolder());
    document.getElementById('btnImportGoogle').addEventListener('click', event => this.importGoogle(event.currentTarget));
    document.getElementById('btnConnectGoogle').addEventListener('click', event => this.connectGoogle(event.currentTarget));
    document.getElementById('btnSyncGoogle').addEventListener('click', event => this.syncGoogle(event.currentTarget));
    document.getElementById('btnDisconnectGoogle').addEventListener('click', event => this.disconnectGoogle(event.currentTarget));
    document.getElementById('btnForgetGoogle').addEventListener('click', event => this.forgetGoogle(event.currentTarget));
    document.getElementById('btnLaunchXOutputSettings').addEventListener('click', () => App.launchXOutput());
    document.getElementById('btnOpenXOutputFolder').addEventListener('click', () => window.api.xoutput.openFolder());
  },

  async open(section = null) {
    const modal = document.getElementById('settingsModal');
    modal.hidden = false;
    document.body.classList.add('modal-open');
    await this.load();
    if (section === 'cloud') document.querySelector('.cloud-settings')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => document.getElementById('btnCloseSettings').focus(), 50);
    AudioUI.select();
  },

  close() {
    document.getElementById('settingsModal').hidden = true;
    if (document.getElementById('gameModal').hidden) document.body.classList.remove('modal-open');
  },

  async load() {
    try {
      const [config, cloudStatus, xoutputStatus] = await Promise.all([
        window.api.config.get(), window.api.cloud.getStatus(), window.api.xoutput.status()
      ]);
      this.config = config;
      document.getElementById('scanDepth').value = config.scanDepth;
      document.getElementById('autoBackup').checked = config.autoBackup;
      document.getElementById('backupInterval').value = config.backupIntervalMinutes;
      document.getElementById('backupRetention').value = config.backupRetention;
      document.getElementById('interfaceSounds').checked = config.interfaceSounds;
      document.getElementById('interfaceAnimations').checked = config.interfaceAnimations;
      document.getElementById('cloudAutoSync').checked = config.cloud?.autoSync;
      this.renderPaths(config.scanPaths || []);
      this.renderCloudStatus(cloudStatus);
      this.renderXOutputStatus(xoutputStatus);
    } catch (error) {
      Helpers.toast(`Não foi possível carregar as configurações: ${error.message}`, 'error');
    }
  },

  renderPaths(paths) {
    const list = document.getElementById('scanPathsList');
    list.replaceChildren();
    if (!paths.length) {
      const empty = document.createElement('p');
      empty.className = 'path-empty';
      empty.textContent = 'Nenhuma pasta configurada.';
      list.appendChild(empty);
      return;
    }
    paths.forEach(scanPath => {
      const item = document.createElement('div');
      item.className = 'scan-path-item';
      const text = document.createElement('span');
      text.className = 'scan-path-text';
      text.title = scanPath;
      text.textContent = scanPath;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'path-action-btn danger';
      remove.dataset.gamepad = '';
      remove.setAttribute('aria-label', `Remover ${scanPath}`);
      remove.textContent = 'Remover';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          if (await window.api.config.removeScanPath(scanPath)) {
            Helpers.toast('Pasta removida da biblioteca.', 'info');
            await this.load();
            await App.refreshLibrary({ quiet: true });
          }
        } catch (error) { Helpers.toast(error.message, 'error'); }
        finally { remove.disabled = false; }
      });
      item.append(text, remove);
      list.appendChild(item);
    });
  },

  async addPath() {
    try {
      const result = await window.api.config.addScanPath();
      if (result.success) {
        Helpers.toast('Pasta adicionada. Procurando jogos...', 'success');
        await this.load();
        await App.refreshLibrary();
      } else if (!result.canceled) Helpers.toast(result.message || 'Não foi possível adicionar a pasta.', 'warning');
    } catch (error) { Helpers.toast(error.message, 'error'); }
  },

  async save() {
    const button = document.getElementById('btnSaveSettings');
    this.setBusy(button, true, 'Salvando...');
    try {
      const config = await window.api.config.update({
        scanDepth: Number(document.getElementById('scanDepth').value),
        autoBackup: document.getElementById('autoBackup').checked,
        backupIntervalMinutes: Number(document.getElementById('backupInterval').value),
        backupRetention: Number(document.getElementById('backupRetention').value),
        interfaceSounds: document.getElementById('interfaceSounds').checked,
        interfaceAnimations: document.getElementById('interfaceAnimations').checked,
        cloud: { autoSync: document.getElementById('cloudAutoSync').checked }
      });
      this.config = config;
      App.applyExperienceSettings(config);
      document.getElementById('settingsSaveStatus').textContent = 'Preferências salvas';
      Helpers.toast('Preferências salvas.', 'success');
      AudioUI.success();
    } catch (error) { Helpers.toast(error.message, 'error'); AudioUI.error(); }
    finally { this.setBusy(button, false); }
  },

  async backupAll(button) {
    this.setBusy(button, true, 'Protegendo saves...');
    try {
      const result = await window.api.saves.backupAll();
      const created = result.results.filter(item => item.success && !item.skipped).length;
      const unchanged = result.results.filter(item => item.unchanged).length;
      Helpers.toast(`${created} backup(s) criado(s)${unchanged ? `, ${unchanged} sem alterações` : ''}.`, 'success');
      await App.loadDashboard();
      AudioUI.success();
    } catch (error) { Helpers.toast(error.message, 'error'); AudioUI.error(); }
    finally { this.setBusy(button, false); }
  },

  renderCloudStatus(status) {
    const pill = document.getElementById('cloudStatusPill');
    const identity = document.getElementById('cloudIdentity');
    pill.className = `status-pill${status.connected ? ' success' : status.configured ? ' warning' : ''}`;
    pill.textContent = status.connected ? 'Conectado' : status.configured ? 'Pronto para login' : status.available ? 'Configuração necessária' : 'Criptografia indisponível';
    identity.hidden = !status.connected;
    document.getElementById('cloudEmail').textContent = status.email || 'Conta Google conectada';
    document.getElementById('cloudLastSync').textContent = status.lastSyncAt ? `Sincronizado ${Helpers.formatRelativeTime(status.lastSyncAt)}` : 'Ainda não sincronizado';
    document.getElementById('btnConnectGoogle').disabled = !status.configured || status.connected;
    document.getElementById('btnSyncGoogle').disabled = !status.connected;
    document.getElementById('btnDisconnectGoogle').disabled = !status.connected;
    document.getElementById('btnForgetGoogle').disabled = !status.configured;
    App.updateCloudIndicator(status);
  },

  renderXOutputStatus(status) {
    const pill = document.getElementById('xoutputStatusPill');
    pill.className = `status-pill${status.running ? ' success' : status.available ? '' : ' warning'}`;
    pill.textContent = status.running ? 'Em execução' : status.available ? (status.hasLocalSettings ? 'Configurado localmente' : 'Disponível') : 'Não incluído';
    document.getElementById('btnLaunchXOutputSettings').disabled = !status.available;
  },

  async importGoogle(button) {
    this.setBusy(button, true, 'Importando...');
    try {
      const status = await window.api.cloud.importCredentials();
      this.renderCloudStatus(status);
      if (!status.canceled) Helpers.toast('Credenciais armazenadas localmente com criptografia.', 'success');
    } catch (error) { Helpers.toast(error.message, 'error'); }
    finally { await this.finishCloudAction(button); }
  },

  async connectGoogle(button) {
    this.setBusy(button, true, 'Aguardando login...');
    try {
      const status = await window.api.cloud.connect();
      this.renderCloudStatus(status);
      Helpers.toast(`Google Drive conectado${status.email ? `: ${status.email}` : ''}.`, 'success');
      AudioUI.success();
    } catch (error) { Helpers.toast(error.message, 'error'); AudioUI.error(); }
    finally { await this.finishCloudAction(button); }
  },

  async syncGoogle(button) {
    this.setBusy(button, true, 'Sincronizando...');
    try {
      const result = await window.api.cloud.syncNow();
      this.renderCloudStatus(result.status);
      Helpers.toast(`Google Drive atualizado. ${result.uploaded} novo(s) backup(s).`, 'success');
      AudioUI.success();
    } catch (error) { Helpers.toast(error.message, 'error'); AudioUI.error(); }
    finally { await this.finishCloudAction(button); }
  },

  async disconnectGoogle(button) {
    this.setBusy(button, true, 'Desconectando...');
    try { this.renderCloudStatus(await window.api.cloud.disconnect()); Helpers.toast('Google Drive desconectado.', 'info'); }
    catch (error) { Helpers.toast(error.message, 'error'); }
    finally { await this.finishCloudAction(button); }
  },

  async forgetGoogle(button) {
    if (!window.confirm('Remover deste computador as credenciais OAuth e os tokens do Google Drive? Os backups já enviados não serão apagados.')) return;
    this.setBusy(button, true, 'Removendo...');
    try { this.renderCloudStatus(await window.api.cloud.forget()); Helpers.toast('Credenciais locais removidas.', 'info'); }
    catch (error) { Helpers.toast(error.message, 'error'); }
    finally { await this.finishCloudAction(button); }
  },

  async finishCloudAction(button) {
    this.setBusy(button, false);
    try { this.renderCloudStatus(await window.api.cloud.getStatus()); } catch {}
  },

  setBusy(button, busy, label = null) {
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = label || 'Aguarde...';
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalLabel || button.textContent;
      button.disabled = false;
    }
  }
};
