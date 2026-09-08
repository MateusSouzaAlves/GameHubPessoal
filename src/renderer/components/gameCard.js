const GameCard = {
  create(game, options = {}) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `game-card${options.horizontal ? ' game-card-horizontal' : ''}`;
    card.dataset.gameId = game.id;
    card.dataset.gamepad = '';
    card.setAttribute('aria-label', `${game.name}, ${this.statusLabel(game)}`);
    card.style.setProperty('--card-index', String(Math.min(options.index || 0, 20)));

    const coverWrap = document.createElement('span');
    coverWrap.className = 'card-cover-wrap';
    const image = document.createElement('img');
    image.className = 'card-cover';
    image.src = game.coverUrl;
    image.alt = `Capa de ${game.name}`;
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      if (image.dataset.fallback) return;
      image.dataset.fallback = 'true';
      image.src = Helpers.fallbackCover(game.name);
    });
    coverWrap.appendChild(image);

    const overlay = document.createElement('span');
    overlay.className = 'card-overlay';
    const info = document.createElement('span');
    info.className = 'card-info';
    const name = document.createElement('strong');
    name.className = 'card-name';
    name.textContent = game.name;
    const status = document.createElement('span');
    const statusClass = game.isRunning ? 'running' : ['ready', 'running', 'broken', 'offline'].includes(game.status) ? game.status : 'ready';
    status.className = `card-status status-${statusClass}`;
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    status.append(dot, document.createTextNode(this.statusLabel(game)));
    info.append(name, status);

    const play = document.createElement('span');
    play.className = 'card-play';
    play.setAttribute('aria-hidden', 'true');
    play.textContent = '▶';
    card.append(coverWrap, overlay, info, play);

    if (game.isRunning || game.status === 'running') this.addBadge(card, 'Rodando', 'badge-running');
    if (game.status === 'broken') this.addBadge(card, 'Indisponível', 'badge-broken');
    if (game.status === 'offline') this.addBadge(card, 'Disco offline', 'badge-broken');
    if (game.saveInfo?.locations?.length) this.addSaveBadge(card);

    card.addEventListener('click', () => {
      if (['broken', 'offline'].includes(game.status)) {
        Helpers.toast(game.status === 'offline' ? 'A unidade do jogo não está conectada.' : 'O executável não foi encontrado.', 'error');
        AudioUI.error();
        return;
      }
      App.launchGame(game.id, game.name);
    });
    card.addEventListener('focus', () => App.queuePreview(game));
    card.addEventListener('pointerenter', () => App.queuePreview(game));
    card.addEventListener('contextmenu', event => {
      event.preventDefault();
      this.showContextMenu(event, game);
    });
    return card;
  },

  statusLabel(game) {
    if (game.isRunning || game.status === 'running') return 'Em execução';
    return { ready: 'Pronto para jogar', broken: 'Executável ausente', offline: 'Unidade offline' }[game.status] || 'Pronto para jogar';
  },

  addBadge(card, text, className) {
    const badge = document.createElement('span');
    badge.className = `card-badge ${className}`;
    badge.textContent = text;
    card.prepend(badge);
  },

  addSaveBadge(card) {
    const badge = document.createElement('span');
    badge.className = 'card-save-badge';
    badge.title = 'Saves protegidos';
    badge.textContent = '☁';
    card.appendChild(badge);
  },

  showContextMenu(event, game) {
    document.querySelector('.context-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    const actions = [
      ['play', 'Jogar'],
      ['details', 'Saves e detalhes'],
      ['backup', 'Criar backup agora'],
      ['divider', ''],
      ['xoutput', 'Abrir XOutput'],
      ['folder', 'Abrir pasta do jogo'],
      ['executable', 'Abrir pasta do executável']
    ];
    for (const [action, label] of actions) {
      if (action === 'divider') {
        const divider = document.createElement('div');
        divider.className = 'context-divider';
        menu.appendChild(divider);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'context-item';
      button.dataset.action = action;
      button.dataset.gamepad = '';
      button.textContent = label;
      menu.appendChild(button);
    }
    menu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - 230))}px`;
    menu.style.top = `${Math.max(50, Math.min(event.clientY, innerHeight - 290))}px`;
    document.body.appendChild(menu);
    menu.querySelector('button')?.focus();
    menu.addEventListener('click', async clickEvent => {
      const button = clickEvent.target.closest('button');
      if (!button) return;
      menu.remove();
      try {
        if (button.dataset.action === 'play') App.launchGame(game.id, game.name);
        if (button.dataset.action === 'details') App.openGameDetails(game.id);
        if (button.dataset.action === 'backup') App.backupGame(game.id);
        if (button.dataset.action === 'xoutput') App.launchXOutput();
        if (button.dataset.action === 'folder') await window.api.game.openFolder(game.id, 'game');
        if (button.dataset.action === 'executable') await window.api.game.openFolder(game.id, 'executable');
      } catch (error) { Helpers.toast(error.message, 'error'); }
    });
    const close = pointerEvent => {
      if (!menu.contains(pointerEvent.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', close);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close), 0);
  }
};
