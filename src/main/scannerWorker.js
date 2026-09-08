const { parentPort, workerData } = require('worker_threads');
const GameScanner = require('./scanner');

const values = workerData?.config || {};
const lower = value => String(value || '').toLowerCase();
const config = {
  get(key) { return values[key]; },
  isExcludedExecutable(name) {
    return (values.excludedExecutables || []).some(item => lower(item) === lower(name));
  },
  isExcludedFolder(name) {
    return (values.excludedFolders || []).some(item => lower(item) === lower(name));
  },
  isUtility(name) {
    return (values.utilityPatterns || []).some(pattern => lower(name).includes(lower(pattern)));
  }
};
const persistence = { synchronizeScan: games => games };
const scanner = new GameScanner(config, persistence);
scanner.progressListeners.add(progress => parentPort.postMessage({ type: 'progress', progress }));

scanner.runFullScan()
  .then(games => parentPort.postMessage({ type: 'result', games }))
  .catch(error => parentPort.postMessage({ type: 'error', message: error.message }));
