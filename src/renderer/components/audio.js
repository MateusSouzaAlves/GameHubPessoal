const AudioUI = {
  enabled: true,
  context: null,
  initialized: false,
  startupPlayed: false,

  setEnabled(enabled) { this.enabled = Boolean(enabled); },

  init() {
    if (this.initialized) return;
    this.initialized = true;
    const unlock = async () => {
      try {
        if (!this.context) this.context = new AudioContext();
        if (this.context.state === 'suspended') await this.context.resume().catch(() => {});
        if (!this.startupPlayed && this.context.state === 'running') {
          this.startupPlayed = true;
          this.startup();
        }
      } catch {}
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    window.addEventListener('gamepadconnected', unlock, { passive: true });
  },

  tone(frequency, duration = 0.06, volume = 0.025, type = 'sine', delay = 0) {
    if (!this.enabled || !this.context || this.context.state !== 'running') return;
    const start = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  },

  move() { this.tone(540, 0.045, 0.018); },
  select() { this.tone(680, 0.06, 0.025); this.tone(980, 0.09, 0.015, 'sine', 0.035); },
  back() { this.tone(360, 0.075, 0.02); },
  success() { this.tone(520, 0.08, 0.02); this.tone(780, 0.13, 0.02, 'sine', 0.06); },
  error() { this.tone(180, 0.12, 0.025, 'triangle'); },
  startup() { this.tone(260, 0.28, 0.018); this.tone(520, 0.4, 0.018, 'sine', 0.1); this.tone(780, 0.5, 0.012, 'sine', 0.2); }
};
