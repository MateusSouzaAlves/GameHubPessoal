const Helpers = {
  toast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${['success', 'error', 'warning', 'info'].includes(type) ? type : 'info'}`;
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = { success: '✓', error: '!', warning: '△', info: 'i' }[type] || 'i';
    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = String(message || '');
    toast.append(icon, text);
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  formatSize(bytes) {
    const value = Number(bytes) || 0;
    if (!value) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  },

  formatDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    if (value < 60) return `${Math.round(value)}s`;
    if (value < 3600) return `${Math.round(value / 60)}min`;
    return `${(value / 3600).toFixed(value < 36_000 ? 1 : 0)}h`;
  },

  formatRelativeTime(dateString) {
    if (!dateString) return 'nunca';
    const difference = Date.now() - new Date(dateString).getTime();
    if (!Number.isFinite(difference)) return 'data desconhecida';
    const minutes = Math.floor(difference / 60_000);
    const hours = Math.floor(difference / 3_600_000);
    const days = Math.floor(difference / 86_400_000);
    if (minutes < 1) return 'agora';
    if (minutes < 60) return `há ${minutes} min`;
    if (hours < 24) return `há ${hours} h`;
    if (days < 30) return `há ${days} d`;
    return new Date(dateString).toLocaleDateString('pt-BR');
  },

  debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  },

  xmlEscape(value) {
    return String(value || '').replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character]));
  },

  fallbackCover(gameName) {
    const initials = String(gameName || '').split(/[\s\-:]+/).filter(Boolean).slice(0, 3).map(word => word[0]).join('').toUpperCase() || '??';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#173866"/><stop offset="1" stop-color="#080b1b"/></linearGradient></defs><rect width="600" height="900" fill="url(#g)"/><circle cx="120" cy="120" r="400" fill="#fff" opacity=".05"/><text x="300" y="470" text-anchor="middle" font-family="Segoe UI,sans-serif" font-size="145" font-weight="700" fill="#fff">${this.xmlEscape(initials)}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
};
