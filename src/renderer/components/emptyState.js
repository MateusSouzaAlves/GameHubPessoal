const EmptyState = {
  show() {
    document.getElementById('emptyState').hidden = false;
    document.getElementById('libraryContent').hidden = true;
    document.getElementById('loadingState').hidden = true;
  },
  hide() { document.getElementById('emptyState').hidden = true; },
  showLoading() {
    document.getElementById('loadingState').hidden = false;
    document.getElementById('libraryContent').hidden = true;
    document.getElementById('emptyState').hidden = true;
  },
  showLibrary() {
    document.getElementById('libraryContent').hidden = false;
    document.getElementById('loadingState').hidden = true;
    document.getElementById('emptyState').hidden = true;
  }
};
