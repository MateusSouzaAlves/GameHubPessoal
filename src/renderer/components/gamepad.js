const GamepadNavigation = {
  gamepadIndex: null,
  previousButtons: [],
  axisState: { horizontal: 0, vertical: 0 },
  lastMoveAt: 0,

  init() {
    window.addEventListener('gamepadconnected', event => this.connect(event.gamepad));
    window.addEventListener('gamepaddisconnected', event => this.disconnect(event.gamepad));
    const existing = [...(navigator.getGamepads?.() || [])].find(Boolean);
    if (existing) this.connect(existing);
    requestAnimationFrame(() => this.poll());
  },

  connect(gamepad) {
    this.gamepadIndex = gamepad.index;
    this.previousButtons = [];
    document.body.classList.add('gamepad-active');
    document.getElementById('controllerHints').hidden = false;
    document.getElementById('controllerName').textContent = String(gamepad.id || 'Controle conectado').slice(0, 60);
    Helpers.toast('Controle conectado — navegação ativada', 'success', 2500);
    this.ensureFocus();
  },

  disconnect(gamepad) {
    if (this.gamepadIndex !== gamepad.index) return;
    this.gamepadIndex = null;
    document.body.classList.remove('gamepad-active');
    document.getElementById('controllerHints').hidden = true;
  },

  poll() {
    if (this.gamepadIndex !== null) {
      const gamepad = navigator.getGamepads?.()[this.gamepadIndex];
      if (gamepad) this.process(gamepad);
    }
    requestAnimationFrame(() => this.poll());
  },

  process(gamepad) {
    const pressed = index => Boolean(gamepad.buttons[index]?.pressed);
    const justPressed = index => pressed(index) && !this.previousButtons[index];
    const horizontal = this.axisDirection(gamepad.axes[0], pressed(14), pressed(15));
    const vertical = this.axisDirection(gamepad.axes[1], pressed(12), pressed(13));
    const now = performance.now();
    if (horizontal && (horizontal !== this.axisState.horizontal || now - this.lastMoveAt > 230)) {
      this.moveFocus(horizontal, 0);
      this.lastMoveAt = now;
    }
    if (vertical && (vertical !== this.axisState.vertical || now - this.lastMoveAt > 230)) {
      this.moveFocus(0, vertical);
      this.lastMoveAt = now;
    }
    this.axisState = { horizontal, vertical };
    if (justPressed(0)) { this.ensureFocus()?.click(); AudioUI.select(); }
    if (justPressed(1)) { App.closeTopModal(); AudioUI.back(); }
    if (justPressed(9)) Settings.open();
    if (justPressed(2)) {
      const card = document.activeElement?.closest?.('.game-card');
      if (card) App.openGameDetails(card.dataset.gameId);
    }
    this.previousButtons = gamepad.buttons.map(button => button.pressed);
  },

  axisDirection(axis = 0, negativeButton, positiveButton) {
    if (negativeButton) return -1;
    if (positiveButton) return 1;
    if (axis < -0.55) return -1;
    if (axis > 0.55) return 1;
    return 0;
  },

  candidates() {
    return [...document.querySelectorAll('[data-gamepad]:not(:disabled), .game-card')]
      .filter(element => element.offsetParent !== null && !element.closest('[hidden]'));
  },

  ensureFocus() {
    const candidates = this.candidates();
    if (!candidates.length) return null;
    if (!candidates.includes(document.activeElement)) candidates[0].focus({ preventScroll: false });
    return document.activeElement;
  },

  moveFocus(x, y) {
    const candidates = this.candidates();
    if (!candidates.length) return;
    const current = candidates.includes(document.activeElement) ? document.activeElement : candidates[0];
    const source = current.getBoundingClientRect();
    const sx = source.left + source.width / 2;
    const sy = source.top + source.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const candidate of candidates) {
      if (candidate === current) continue;
      const rect = candidate.getBoundingClientRect();
      const dx = rect.left + rect.width / 2 - sx;
      const dy = rect.top + rect.height / 2 - sy;
      if ((x < 0 && dx >= -2) || (x > 0 && dx <= 2) || (y < 0 && dy >= -2) || (y > 0 && dy <= 2)) continue;
      const primary = x ? Math.abs(dx) : Math.abs(dy);
      const secondary = x ? Math.abs(dy) : Math.abs(dx);
      const score = primary + secondary * 2.25;
      if (score < bestScore) { bestScore = score; best = candidate; }
    }
    if (best) {
      best.focus({ preventScroll: false });
      best.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      AudioUI.move();
    }
  }
};
