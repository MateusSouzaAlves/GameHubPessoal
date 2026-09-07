// ============================================================
// Search Component — Handles search input and keyboard shortcut
// ============================================================

const Search = {
  init() {
    const searchInput = document.getElementById('searchInput');

    // Real-time search with debounce
    searchInput.addEventListener('input', Helpers.debounce((e) => {
      Library.filter(e.target.value);
    }, 200));

    // Clear on Escape
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        searchInput.blur();
        Library.filter('');
        // Re-show sections
        App.loadRecentSections();
      }
    });

    // Ctrl+K shortcut
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    });
  }
};
