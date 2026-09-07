const Library = {
  games: [],
  filteredGames: [],
  currentSort: 'name',
  currentView: 'grid',

  init(games) {
    this.games = Array.isArray(games) ? games : [];
    this.filteredGames = [...this.games];
    this.sort(this.currentSort);
  },

  update(games) {
    this.games = Array.isArray(games) ? games : [];
    this.applyCurrentFilter();
  },

  find(gameId) { return this.games.find(game => game.id === gameId) || null; },

  sort(criteria) {
    this.currentSort = ['name', 'recent', 'played'].includes(criteria) ? criteria : 'name';
    if (this.currentSort === 'name') this.filteredGames.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    if (this.currentSort === 'recent') this.filteredGames.sort((a, b) => new Date(b.detectedAt || 0) - new Date(a.detectedAt || 0));
    if (this.currentSort === 'played') this.filteredGames.sort((a, b) => new Date(b.lastPlayed || 0) - new Date(a.lastPlayed || 0));
    this.render();
    document.querySelectorAll('.sort-btn').forEach(button => button.classList.toggle('active', button.dataset.sort === this.currentSort));
  },

  filter(query) {
    const normalized = String(query || '').trim().toLocaleLowerCase('pt-BR');
    this.filteredGames = normalized ? this.games.filter(game => [game.name, game.folderName].some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(normalized))) : [...this.games];
    this.sort(this.currentSort);
    const searching = Boolean(normalized);
    document.getElementById('recentlyAddedSection').hidden = searching || !App.recentState.added;
    document.getElementById('recentlyPlayedSection').hidden = searching || !App.recentState.played;
    document.getElementById('sectionDivider').hidden = searching || !(App.recentState.added || App.recentState.played);
    const noResults = document.getElementById('noResultsState');
    noResults.hidden = !(searching && this.filteredGames.length === 0);
    document.getElementById('gameGrid').hidden = searching && this.filteredGames.length === 0;
    if (!noResults.hidden) document.getElementById('noResultsText').textContent = `Nenhum jogo encontrado para “${String(query).slice(0, 100)}”.`;
  },

  applyCurrentFilter() { this.filter(document.getElementById('searchInput').value); },

  render() {
    const grid = document.getElementById('gameGrid');
    grid.replaceChildren();
    grid.classList.toggle('list-view', this.currentView === 'list');
    this.filteredGames.forEach((game, index) => grid.appendChild(GameCard.create(game, { index })));
    document.getElementById('statsCount').textContent = `${this.games.length} jogo${this.games.length === 1 ? '' : 's'}`;
  },

  renderRecentlyAdded(games) {
    const section = document.getElementById('recentlyAddedSection');
    const grid = document.getElementById('recentlyAddedGrid');
    grid.replaceChildren();
    App.recentState.added = Boolean(games?.length);
    section.hidden = !App.recentState.added;
    (games || []).forEach((game, index) => grid.appendChild(GameCard.create(game, { horizontal: true, index })));
  },

  renderRecentlyPlayed(games) {
    const section = document.getElementById('recentlyPlayedSection');
    const grid = document.getElementById('recentlyPlayedGrid');
    grid.replaceChildren();
    App.recentState.played = Boolean(games?.length);
    section.hidden = !App.recentState.played;
    (games || []).forEach((game, index) => grid.appendChild(GameCard.create(game, { horizontal: true, index })));
  },

  showSections() {
    document.getElementById('sectionDivider').hidden = !(App.recentState.added || App.recentState.played);
  },

  setView(view) {
    this.currentView = view === 'list' ? 'list' : 'grid';
    document.getElementById('viewGrid').classList.toggle('active', this.currentView === 'grid');
    document.getElementById('viewList').classList.toggle('active', this.currentView === 'list');
    this.render();
  }
};
