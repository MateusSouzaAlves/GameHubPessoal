const fs = require('fs');
const path = require('path');

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizePath(value) {
  if (!value || typeof value !== 'string') return '';
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function isSubPath(parentPath, candidatePath) {
  const parent = normalizePath(parentPath);
  const candidate = normalizePath(candidatePath);
  if (!parent || !candidate) return false;
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(the|a|an|edition|remastered|enhanced|goty|game|pc|win64|x64|shipping)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function titleSimilarity(left, right) {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aCompact = a.replace(/\s/g, '');
  const bCompact = b.replace(/\s/g, '');
  if (aCompact === bCompact) return 0.98;
  if (aCompact.includes(bCompact) || bCompact.includes(aCompact)) {
    return Math.min(aCompact.length, bCompact.length) / Math.max(aCompact.length, bCompact.length) * 0.9;
  }
  const aTokens = new Set(a.split(' ').filter(token => token.length > 1));
  const bTokens = new Set(b.split(' ').filter(token => token.length > 1));
  const intersection = [...aTokens].filter(token => bTokens.has(token)).length;
  const tokenScore = intersection / Math.max(aTokens.size, bTokens.size, 1);
  const pairs = value => {
    const compact = value.replace(/\s/g, '');
    const result = new Map();
    for (let index = 0; index < compact.length - 1; index += 1) {
      const pair = compact.slice(index, index + 2);
      result.set(pair, (result.get(pair) || 0) + 1);
    }
    return result;
  };
  const aPairs = pairs(a);
  const bPairs = pairs(b);
  let matches = 0;
  for (const [pair, count] of aPairs) matches += Math.min(count, bPairs.get(pair) || 0);
  const total = [...aPairs.values(), ...bPairs.values()].reduce((sum, value) => sum + value, 0);
  return Math.max(tokenScore, (2 * matches) / Math.max(1, total));
}

function sanitizeFileName(value) {
  return String(value || 'file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'file';
}

module.exports = { atomicWriteJson, readJson, normalizePath, isSubPath, clamp, normalizeTitle, titleSimilarity, sanitizeFileName };
