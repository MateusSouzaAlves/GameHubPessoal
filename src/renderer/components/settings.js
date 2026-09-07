const Settings = {
  config: null,

  init() {
    document.getElementById('btnSettings').addEventListener('click', () => this.open());
    document.getElementById('btnCloud').addEventListener('click', () => this.open('cloud'));
    document.getElementById('btnEmptySettings').addEventListener('click', event => this.addPath(event.currentTarget));
    document.getElementById('btnCloseSettings').addEventListener('click', () => this.close());
    document.getElementById('settingsModal').addEventListener('pointerdown', event => {
      if (event.target === event.currentTarget) this.close();
    });
    document.getElementById('btnAddPath').addEventListener('click', event => this.addPath(event.currentTarget));
    document.getElementById('btnBackupAll').addEventListener('click', event => this.backupAll(event.currentTarget));
    document.getElementById('btnOpenBackups').addEventListener('click', () => window.api.saves.openBackupFolder());
    document.getElementById('btnConnectGoogle').addEventListener('click', event => this.connectGoogle(event.currentTarget));
    document.getElementById('btnSyncGoogle').addEventListener('click', event => this.syncGoogle(event.currentTarget));
    document.getElementById('btnDisconnectGoogle').addEventListener('click', event => this.disconnectGoogle(event.currentTarget));
    document.getElementById('btnLaunchXOutputSettings').addEventListener('click', () => App.launchXOutput());
    ['autoBackup', 'interfaceSounds', 'interfaceAnimations', 'cloudAutoSync'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => this.save());
    });
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
      document.getElementById('autoBackup').checked = config.autoBackup;
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
            await App.refreshLibrary();
          }
        } catch (error) { Helpers.toast(error.message, 'error'); }
        finally { remove.disabled = false; }
      });
      item.append(text, remove);
      list.appendChild(item);
    });
  },

  async addPath(button = null) {
    if (button) this.setBusy(button, true, 'Escolhendo...');
    try {
      const result = await window.api.config.addScanPath();
      if (result.success) {
        if (button) this.setBusy(button, true, 'Procurando...');
        if (!document.getElementById('settingsModal').hidden) await this.load();
        await App.refreshLibrary();
      } else if (!result.canceled) Helpers.toast(result.message || 'Não foi possível adicionar a pasta.', 'warning');
    } catch (error) { Helpers.toast(error.message, 'error'); }
    finally { if (button) this.setBusy(button, false); }
  },

  async save() {
    try {
      const config = await window.api.config.update({
        autoBackup: document.getElementById('autoBackup').checked,
        interfaceSounds: document.getElementById('interfaceSounds').checked,
        interfaceAnimations: document.getElementById('interfaceAnimations').checked,
        cloud: { autoSync: document.getElementById('cloudAutoSync').checked }
      });
      this.config = config;
      App.applyExperienceSettings(config);
    } catch (error) { Helpers.toast(error.message, 'error'); AudioUI.error(); }
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
    const help = document.getElementById('cloudStatusHelp');
    const connect = document.getElementById('btnConnectGoogle');
    const sync = document.getElementById('btnSyncGoogle');
    const disconnect = document.getElementById('btnDisconnectGoogle');
    pill.className = `status-pill${status.connected ? ' success' : status.configured ? ' warning' : ''}`;
    pill.textContent = status.connected ? 'Conectado' : status.configured ? 'Desconectado' : status.available ? 'Indisponível nesta versão' : 'Indisponível';
    help.textContent = status.connected
      ? 'Seus backups novos podem ser enviados automaticamente.'
      : status.configured
        ? 'Clique em conectar; o login será concluído com segurança no navegador.'
        : 'O responsável pela versão precisa habilitar o login Google antes de publicá-la.';
    identity.hidden = !status.connected;
    document.getElementById('cloudEmail').textContent = status.email || 'Conta Google conectada';
    document.getElementById('cloudLastSync').textContent = status.lastSyncAt ? `Sincronizado ${Helpers.formatRelativeTime(status.lastSyncAt)}` : 'Ainda não sincronizado';
    connect.hidden = status.connected;
    connect.disabled = !status.available || !status.configured;
    sync.hidden = !status.connected;
    disconnect.hidden = !status.connected;
    App.updateCloudIndicator(status);
  },

  renderXOutputStatus(status) {
    const pill = document.getElementById('xoutputStatusPill');
    pill.className = `status-pill${status.running ? ' success' : status.available ? '' : ' warning'}`;
    pill.textContent = status.running ? 'Em execução' : status.available ? (status.hasLocalSettings ? 'Configurado localmente' : 'Disponível') : 'Não incluído';
    document.getElementById('btnLaunchXOutputSettings').disabled = !status.available;
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

  async finishCloudAction(button) {
    this.setBusy(button, false);
    try { this.renderCloudStatus(await window.api.cloud.getStatus()); } catch {}
  },

  setBusy(button, busy, label = null) {
    if (busy) {
      if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
      button.textContent = label || 'Aguarde...';
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalLabel || button.textContent;
      delete button.dataset.originalLabel;
      button.disabled = false;
    }
  }
};
