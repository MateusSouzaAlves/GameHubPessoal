const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const qaRoot = path.join(root, 'data', 'qa');
if (path.dirname(qaRoot) !== path.join(root, 'data')) throw new Error('QA path validation failed.');
fs.rmSync(qaRoot, { recursive: true, force: true });
const gamesRoot = path.join(qaRoot, 'games');
const userData = path.join(qaRoot, 'user-data');
const dataDir = path.join(userData, 'data');
const coversDir = path.join(dataDir, 'covers');
fs.mkdirSync(coversDir, { recursive: true });

const games = ['Crimson Desert', 'crmison moon', 'Celestial Drift', 'Echoes of Aether', 'Neon Horizon'];
const availableCovers = fs.existsSync(path.join(root, 'data', 'covers'))
  ? fs.readdirSync(path.join(root, 'data', 'covers')).filter(name => /\.(png|jpe?g)$/i.test(name))
  : [];

games.forEach((name, index) => {
  const gamePath = path.join(gamesRoot, name);
  fs.mkdirSync(gamePath, { recursive: true });
  fs.writeFileSync(path.join(gamePath, `${name.replace(/\s/g, '')}.exe`), Buffer.alloc(2 * 1024 * 1024));
  if (availableCovers[index]) {
    const id = crypto.createHash('sha256').update(path.resolve(gamePath).toLowerCase()).digest('hex').slice(0, 16);
    const source = path.join(root, 'data', 'covers', availableCovers[index]);
    fs.copyFileSync(source, path.join(coversDir, `${id}${path.extname(source)}`));
  }
});

fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  scanPaths: [gamesRoot],
  scanDepth: 4,
  autoBackup: true,
  backupIntervalMinutes: 30,
  backupRetention: 10,
  maxBackupSizeMB: 2048,
  interfaceSounds: true,
  interfaceAnimations: true,
  cloud: { provider: 'googleDrive', enabled: false, autoSync: true, syncIntervalMinutes: 30 }
}, null, 2));

console.log(JSON.stringify({ qaRoot, userData, screenshot: path.join(qaRoot, 'nexus-qa.png') }));
