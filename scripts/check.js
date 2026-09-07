const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const failures = [];
const projectFiles = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'data'].includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else projectFiles.push(fullPath);
  }
}

walk(root);
for (const filePath of projectFiles.filter(file => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${path.relative(root, filePath)}: ${result.stderr.trim()}`);
}

const bannedNames = [/client_secret.*\.json$/i, /credentials.*\.json$/i, /^\.env(?:\.|$)/i, /token.*\.json$/i];
for (const filePath of projectFiles) {
  if (bannedNames.some(pattern => pattern.test(path.basename(filePath)))) failures.push(`Arquivo sensível presente: ${path.relative(root, filePath)}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!packageJson.private) failures.push('package.json deve conter private: true.');
const buildFiles = JSON.stringify(packageJson.build?.files || []);
if (/data|dist|node_modules/i.test(buildFiles)) failures.push('build.files não pode incluir dados locais, dist ou node_modules.');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
if (/webSecurity\s*:\s*false/.test(mainSource)) failures.push('webSecurity não pode ser desativado.');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Check concluído: ${projectFiles.length} arquivos, sem segredos conhecidos ou JavaScript inválido.`);
