const { parentPort, workerData } = require('worker_threads');
const CoverManager = require('./coverManager');

const covers = new CoverManager(workerData.dataDir, { useWorker: false });
let queue = Promise.resolve();

parentPort.on('message', message => {
  queue = queue.then(async () => {
    try {
      const coverPath = await covers.findCoverDirect(message.game);
      parentPort.postMessage({ requestId: message.requestId, coverPath });
    } catch (error) {
      parentPort.postMessage({ requestId: message.requestId, error: error.message || 'Falha ao buscar a capa.' });
    }
  });
});
