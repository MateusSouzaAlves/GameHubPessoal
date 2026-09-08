const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ConfigManager = require('../src/main/config');
const Persistence = require('../src/main/persistence');
const GameScanner = require('../src/main/scanner');
const GameLauncher = require('../src/main/launcher');
const SaveManager = require('../src/main/saveManager');
const GoogleDriveService = require('../src/main/googleDrive');
const { titleSimilarity, isSubPath } = require('../src/main/utils');
const CoverManager = require('../src/main/coverManager');
const { readImageDimensions, resolveKnownSteamAppId } = CoverManager;

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('normaliza títulos e impede falsa semelhança', () => {
  assert.ok(titleSimilarity('The Witcher 3 GOTY Edition', 'Witcher 3') > 0.9);
  assert.ok(titleSimilarity('CrashReportClient', 'Hades') < 0.35);
  assert.equal(isSubPath('C:\\Games', 'C:\\Games\\Hades'), true);
  assert.equal(isSubPath('C:\\Games', 'C:\\GamesBackup\\Hades'), false);
});

test('configuração é sanitizada e gravada atomicamente', t => {
  const directory = workspace(t);
  const config = new ConfigManager(directory);
  config.updateSettings({ scanDepth: 99, backupRetention: 0, interfaceSounds: false });
  assert.equal(config.get('scanDepth'), 8);
  assert.equal(config.get('backupRetention'), 1);
  assert.equal(config.get('interfaceSounds'), false);
  assert.ok(fs.existsSync(path.join(directory, 'config.json')));
});

test('scanner escolhe o executável do jogo e ignora ferramentas', async t => {
  const directory = workspace(t);
  const root = path.join(directory, 'games');
  const gamePath = path.join(root, 'Nebula Quest');
  fs.mkdirSync(path.join(gamePath, 'Binaries', 'Win64'), { recursive: true });
  fs.writeFileSync(path.join(gamePath, 'launcher.exe'), Buffer.alloc(2 * 1024 * 1024));
  fs.writeFileSync(path.join(gamePath, 'Binaries', 'Win64', 'NebulaQuest-Win64-Shipping.exe'), Buffer.alloc(12 * 1024 * 1024));
  const config = new ConfigManager(directory);
  config.addScanPath(root);
  const persistence = new Persistence(directory);
  const scanner = new GameScanner(config, persistence);
  const progress = [];
  const games = await scanner.fullScan({ onProgress: event => progress.push(event) });
  assert.equal(games.length, 1);
  assert.match(games[0].executablePath, /NebulaQuest-Win64-Shipping\.exe$/);
  assert.equal(progress.at(-1).phase, 'complete');
  assert.equal(progress.every(event => event.backgroundWorker === true), true);
});

test('persistência remove jogos quando a raiz deixa de ser configurada', t => {
  const directory = workspace(t);
  const root = path.join(directory, 'games');
  const gamePath = path.join(root, 'Game');
  fs.mkdirSync(gamePath, { recursive: true });
  const executablePath = path.join(gamePath, 'Game.exe');
  fs.writeFileSync(executablePath, 'exe');
  const persistence = new Persistence(directory);
  persistence.upsert({ name: 'Game', gamePath, executablePath });
  assert.equal(persistence.getAll().length, 1);
  persistence.synchronizeScan([], [], []);
  assert.equal(persistence.getAll().length, 0);
});

test('persistência ignora registros de jogos corrompidos sem interromper a inicialização', t => {
  const directory = workspace(t);
  fs.writeFileSync(path.join(directory, 'library.json'), JSON.stringify({
    invalid: { name: 'Sem executável', gamePath: path.join(directory, 'Game') },
    valid: { id: 'abcdef1234567890', name: 'Game', gamePath: path.join(directory, 'Game'), executablePath: path.join(directory, 'Game', 'Game.exe') }
  }));
  const persistence = new Persistence(directory);
  assert.deepEqual(persistence.getAll().map(game => game.id), ['abcdef1234567890']);
});

test('launcher marca executável ausente como falha sem derrubar o app', async t => {
  const directory = workspace(t);
  const gamePath = path.join(directory, 'Game');
  fs.mkdirSync(gamePath);
  const persistence = new Persistence(directory);
  const game = persistence.upsert({
    name: 'Game',
    gamePath,
    executablePath: path.join(gamePath, 'missing.exe')
  });
  const launcher = new GameLauncher(persistence);
  const result = await launcher.launch(game.id);
  assert.equal(result.success, false);
  assert.equal(persistence.getById(game.id).status, 'broken');
  assert.equal(persistence.getById(game.id).analytics.failedLaunches, 1);
});

test('backup incremental cria ZIP e restaura um save', async t => {
  const directory = workspace(t);
  const gamePath = path.join(directory, 'Game');
  const savePath = path.join(directory, 'Saves');
  fs.mkdirSync(gamePath);
  fs.mkdirSync(savePath);
  const executablePath = path.join(gamePath, 'Game.exe');
  const saveFile = path.join(savePath, 'slot1.sav');
  fs.writeFileSync(executablePath, 'exe');
  fs.writeFileSync(saveFile, 'version-one');
  const persistence = new Persistence(directory);
  const game = persistence.upsert({ name: 'Game', gamePath, executablePath });
  const config = new ConfigManager(directory);
  const saves = new SaveManager(directory, persistence, config);
  await saves.addManualLocation(game.id, savePath);
  const backup = await saves.backupGame(game.id, { force: true, reason: 'test' });
  assert.equal(backup.success, true);
  assert.ok(fs.existsSync(backup.backup.path));
  fs.writeFileSync(saveFile, 'version-two');
  const restored = await saves.restoreBackup(game.id, backup.backup.id);
  assert.equal(restored.restoredFiles, 1);
  assert.equal(fs.readFileSync(saveFile, 'utf8'), 'version-one');
});

test('backup interrompido remove o ZIP parcial', async t => {
  const directory = workspace(t);
  const gamePath = path.join(directory, 'Game');
  const savePath = path.join(directory, 'Saves');
  fs.mkdirSync(gamePath);
  fs.mkdirSync(savePath);
  const executablePath = path.join(gamePath, 'Game.exe');
  fs.writeFileSync(executablePath, 'exe');
  fs.writeFileSync(path.join(savePath, 'slot1.sav'), 'version-one');
  const persistence = new Persistence(directory);
  const game = persistence.upsert({ name: 'Game', gamePath, executablePath });
  const config = new ConfigManager(directory);
  const saves = new SaveManager(directory, persistence, config);
  await saves.addManualLocation(game.id, savePath);
  saves.createArchive = async destination => {
    fs.writeFileSync(destination, 'partial');
    throw new Error('falha simulada');
  };
  await assert.rejects(() => saves.backupGame(game.id, { force: true }), /falha simulada/);
  assert.equal(fs.readdirSync(path.join(directory, 'save-backups', game.id)).length, 0);
});

test('parser defensivo lê cabeçalho PNG', () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(600, 16);
  png.writeUInt32BE(900, 20);
  assert.deepEqual(readImageDimensions(png), { width: 600, height: 900 });
  assert.equal(readImageDimensions(Buffer.from('not-an-image')), null);
});

test('Google OAuth pertence ao aplicativo e os tokens ficam criptografados', t => {
  const directory = workspace(t);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value.split('').reverse().join('')),
    decryptString: value => value.toString().split('').reverse().join('')
  };
  const service = new GoogleDriveService(
    path.join(directory, 'private'),
    safeStorage,
    { openExternal() {} },
    { clientId: 'public-client-id', clientSecret: 'public-desktop-secret' }
  );
  assert.equal(service.getStatus().configured, true);
  service.auth = { tokens: { accessToken: 'token-value', refreshToken: 'refresh-value', expiresAt: Date.now() + 60_000 }, profile: null };
  service.save();
  const encrypted = fs.readFileSync(path.join(directory, 'private', 'google-drive.enc'), 'utf8');
  assert.equal(encrypted.includes('token-value'), false);
  assert.equal(encrypted.includes('public-client-id'), false);
});

test('capas conhecidas toleram pequenos erros no nome do jogo', () => {
  assert.equal(resolveKnownSteamAppId('Crimson Desert'), '3321460');
  assert.equal(resolveKnownSteamAppId('crmison moon'), '4317690');
  assert.equal(resolveKnownSteamAppId('outro jogo qualquer'), null);
});

test('cache de capas ignora arquivos incompletos', t => {
  const directory = workspace(t);
  const covers = new CoverManager(directory, { useWorker: false });
  fs.writeFileSync(path.join(directory, 'covers', 'game.jpg'), Buffer.alloc(20));
  assert.equal(covers.getCachedCover('game'), null);
  covers.dispose();
});

test('Google OAuth conclui o retorno local sem deixar o socket aberto', async t => {
  const directory = workspace(t);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString()
  };
  const shell = {
    async openExternal(authUrl) {
      const authorization = new URL(authUrl);
      const redirectUri = authorization.searchParams.get('redirect_uri');
      const state = authorization.searchParams.get('state');
      setImmediate(() => {
        const request = http.get(`${redirectUri}?state=${encodeURIComponent(state)}&code=test-code`, response => response.resume());
        request.on('error', () => {});
      });
    }
  };
  const service = new GoogleDriveService(path.join(directory, 'private'), safeStorage, shell, { clientId: 'public-client-id' });
  service.exchangeCode = async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
  service.fetchProfile = async () => ({ email: 'local-test@example.invalid' });
  t.after(() => service.dispose());
  const status = await service.connect();
  assert.equal(status.connected, true);
  assert.equal(service.pendingAuth, null);
});
