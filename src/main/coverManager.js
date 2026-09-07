const fs = require('fs');
const path = require('path');
const { titleSimilarity } = require('./utils');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const COVER_WORDS = ['cover', 'poster', 'keyart', 'boxart', 'capsule', 'library_600x900', 'portrait', 'front'];
const ART_WORDS = ['header', 'hero', 'background', 'banner', 'artwork', 'splash', 'logo', 'icon'];
const BAD_WORDS = ['normal', 'roughness', 'metallic', 'specular', 'mask', 'sprite', 'atlas', 'font', 'cursor', 'button', 'loading'];
const SEARCH_DIRS = ['.', 'images', 'art', 'artwork', 'media', 'resources', 'assets', 'launcher', 'launcherData/images', 'Content/Splash'];

function readImageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.subarray(0, 2).toString('ascii') === 'BM' && buffer.length >= 26) {
    return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    const kind = buffer.subarray(12, 16).toString('ascii');
    if (kind === 'VP8X' && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3)
      };
    }
    return null;
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset++];
      if (marker === 0xd8 || marker === 0x01) continue;
      if (marker === 0xd9 || marker === 0xda || offset + 1 >= buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if (startOfFrame.has(marker) && length >= 7) {
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  return null;
}

class CoverManager {
  constructor(dataDir) {
    this.cacheDir = path.join(dataDir, 'covers');
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  async findCover(game) {
    const cached = this.getCachedCover(game.id);
    if (cached) return cached;

    if (game.steamAppId) {
      const steamCover = await this.fetchSteamCover(game, game.steamAppId);
      if (steamCover) return steamCover;
    }

    const localCover = await this.searchGameFolder(game.gamePath);
    if (localCover) return this.cacheCover(game.id, localCover.path);

    const appId = await this.searchSteamAppId(game.name);
    if (appId) return this.fetchSteamCover(game, appId);
    return null;
  }

  getCoverKey(gameId) {
    const coverPath = this.getCachedCover(gameId);
    return coverPath ? path.basename(coverPath) : null;
  }

  async searchSteamAppId(gameName) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=english&cc=US`;
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) return null;
      const data = await response.json();
      const ranked = (data.items || []).map(item => ({ item, similarity: titleSimilarity(gameName, item.name) }))
        .sort((left, right) => right.similarity - left.similarity);
      return ranked[0]?.similarity >= 0.72 ? String(ranked[0].item.id) : null;
    } catch (error) {
      if (error.name !== 'AbortError') console.warn(`[CoverManager] Steam search failed for ${gameName}:`, error.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchSteamCover(game, appId) {
    const candidates = [
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900_2x.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_hero.jpg`,
      `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`
    ];
    for (const url of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || !contentType.startsWith('image/')) continue;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length < 10_000 || buffer.length > 20 * 1024 * 1024) continue;
        const dimensions = readImageDimensions(buffer);
        if (!dimensions) continue;
        if (!dimensions.width || !dimensions.height || dimensions.width < 300 || dimensions.height < 150) continue;
        const extension = contentType.includes('png') ? '.png' : '.jpg';
        const destination = path.join(this.cacheDir, `${game.id}${extension}`);
        fs.writeFileSync(destination, buffer);
        return destination;
      } catch (error) {
        if (error.name !== 'AbortError') console.warn(`[CoverManager] Cover download failed: ${error.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  async searchGameFolder(gamePath) {
    const candidates = [];
    const seen = new Set();
    for (const relativeDir of SEARCH_DIRS) {
      const directory = path.join(gamePath, relativeDir);
      if (!fs.existsSync(directory)) continue;
      let files;
      try { files = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of files.slice(0, 2500)) {
        if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const filePath = path.join(directory, entry.name);
        if (seen.has(filePath.toLowerCase())) continue;
        seen.add(filePath.toLowerCase());
        const result = await this.scoreImage(filePath, entry.name);
        if (result) candidates.push(result);
      }
    }
    return candidates.sort((left, right) => right.score - left.score)[0] || null;
  }

  async scoreImage(filePath, fileName) {
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.size < 10_000 || stats.size > 30 * 1024 * 1024) return null;
      const buffer = await fs.promises.readFile(filePath);
      const dimensions = readImageDimensions(buffer);
      if (!dimensions) return null;
      const width = dimensions.width || 0;
      const height = dimensions.height || 0;
      if (width < 200 || height < 120) return null;
      const lower = fileName.toLowerCase();
      let score = 0;
      if (COVER_WORDS.some(word => lower.includes(word))) score += 25;
      if (ART_WORDS.some(word => lower.includes(word))) score += 8;
      if (BAD_WORDS.some(word => lower.includes(word))) score -= 30;
      const ratio = width / height;
      if (ratio >= 0.55 && ratio <= 0.85) score += 20;
      else if (ratio >= 1.5 && ratio <= 2.0) score += 8;
      else if (ratio > 2.5 || ratio < 0.35) score -= 8;
      score += Math.min(12, Math.log2(Math.max(1, width * height / 150_000)) * 3);
      if (stats.size > 200_000) score += 3;
      return { path: filePath, score, width, height };
    } catch {
      return null;
    }
  }

  cacheCover(gameId, sourcePath) {
    try {
      this.removeCachedCover(gameId);
      const extension = path.extname(sourcePath).toLowerCase();
      const destination = path.join(this.cacheDir, `${gameId}${extension}`);
      fs.copyFileSync(sourcePath, destination);
      return destination;
    } catch (error) {
      console.warn(`[CoverManager] Failed to cache cover for ${gameId}:`, error.message);
      return null;
    }
  }

  getCachedCover(gameId) {
    for (const extension of IMAGE_EXTENSIONS) {
      const filePath = path.join(this.cacheDir, `${gameId}${extension}`);
      if (fs.existsSync(filePath)) return filePath;
    }
    return null;
  }

  removeCachedCover(gameId) {
    for (const extension of IMAGE_EXTENSIONS) {
      const filePath = path.join(this.cacheDir, `${gameId}${extension}`);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
  }

  generateDefaultCover(gameName) {
    const words = String(gameName || '').split(/[\s\-:]+/).filter(Boolean);
    const initials = (words.length === 1 ? words[0].slice(0, 2) : words.slice(0, 3).map(word => word[0]).join('')).toUpperCase() || '??';
    let hash = 0;
    for (const character of String(gameName)) hash = character.charCodeAt(0) + ((hash << 5) - hash);
    const palettes = [
      ['#10224a', '#081020'], ['#31105e', '#0b0b20'], ['#003d53', '#06111d'],
      ['#401122', '#10070c'], ['#173f36', '#071512'], ['#2e225f', '#0c0a1b']
    ];
    const [start, end] = palettes[Math.abs(hash) % palettes.length];
    const safeInitials = initials.replace(/[<>&"']/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient><radialGradient id="r"><stop stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-opacity="0"/></radialGradient></defs><rect width="600" height="900" fill="url(#g)"/><circle cx="150" cy="130" r="430" fill="url(#r)"/><path d="M-60 680 Q300 460 660 680" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="2"/><text x="300" y="470" text-anchor="middle" font-family="Segoe UI,sans-serif" font-size="150" font-weight="700" fill="#fff" fill-opacity=".92">${safeInitials}</text></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }
}

module.exports = CoverManager;
module.exports.readImageDimensions = readImageDimensions;
