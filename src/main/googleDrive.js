const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const OAUTH_SCOPES = `${DRIVE_SCOPE} openid email`;

class GoogleDriveService {
  constructor(privateDir, safeStorage, shell, applicationCredentials = {}) {
    this.privateDir = privateDir;
    this.safeStorage = safeStorage;
    this.shell = shell;
    this.credentials = {
      clientId: String(applicationCredentials.clientId || '').trim(),
      clientSecret: String(applicationCredentials.clientSecret || '').trim() || null,
      authUri: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUri: 'https://oauth2.googleapis.com/token'
    };
    this.authPath = path.join(privateDir, 'google-drive.enc');
    this.auth = null;
    this.pendingAuth = null;
    fs.mkdirSync(privateDir, { recursive: true });
    this.load();
  }

  encryptionAvailable() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.());
  }

  load() {
    if (!this.encryptionAvailable() || !fs.existsSync(this.authPath)) return;
    try {
      const encrypted = fs.readFileSync(this.authPath);
      this.auth = JSON.parse(this.safeStorage.decryptString(encrypted));
      const hasApplicationCredentials = Boolean(this.credentials.clientId);
      if (!hasApplicationCredentials && this.auth?.credentials?.clientId) {
        this.credentials = { ...this.credentials, ...this.auth.credentials };
      }
      if (hasApplicationCredentials && this.auth?.credentials) delete this.auth.credentials;
    } catch (error) {
      console.warn('[GoogleDrive] Could not read local credentials:', error.message);
      this.auth = null;
    }
  }

  save() {
    if (!this.encryptionAvailable()) throw new Error('O armazenamento seguro do sistema não está disponível.');
    const encrypted = this.safeStorage.encryptString(JSON.stringify(this.auth));
    fs.writeFileSync(this.authPath, encrypted, { mode: 0o600 });
  }

  getStatus() {
    return {
      available: this.encryptionAvailable(),
      configured: Boolean(this.credentials.clientId),
      connected: Boolean(this.auth?.tokens?.refreshToken || (this.auth?.tokens?.accessToken && this.auth.tokens.expiresAt > Date.now())),
      email: this.auth?.profile?.email || null,
      lastSyncAt: this.auth?.lastSyncAt || null,
      lastError: this.auth?.lastError || null
    };
  }

  async connect() {
    if (!this.encryptionAvailable()) throw new Error('O armazenamento seguro do Windows não está disponível.');
    if (!this.credentials.clientId) throw new Error('O login com Google ainda não foi habilitado nesta versão do Nexus.');
    if (this.pendingAuth) throw new Error('Já existe um login com Google em andamento. Conclua-o no navegador.');
    this.auth ||= { tokens: null, profile: null };
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(24).toString('hex');
    const server = http.createServer();
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    try {
      await new Promise((resolve, reject) => {
        const onError = error => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
      });
    } catch (error) {
      server.close();
      throw new Error(`Não foi possível abrir o retorno local do login (${error.code || 'socket'}). Verifique o firewall e tente novamente.`);
    }
    server.unref();
    const address = server.address();
    const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
    const params = new URLSearchParams({
      client_id: this.credentials.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: OAUTH_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state
    });
    const authUrl = `${this.credentials.authUri}?${params}`;

    const codePromise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, code = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.pendingAuth = null;
        server.close(() => {});
        const forceCloseTimer = setTimeout(() => server.closeAllConnections?.(), 250);
        forceCloseTimer.unref?.();
        if (error) reject(error);
        else resolve(code);
      };
      const timeout = setTimeout(() => {
        finish(new Error('O login expirou. Tente novamente.'));
      }, 180_000);
      server.on('request', (request, response) => {
        response.on('error', () => {});
        try {
          const url = new URL(request.url, redirectUri);
          if (url.pathname !== '/oauth/callback') {
            response.writeHead(204, { Connection: 'close' });
            response.end();
            return;
          }
          if (url.searchParams.get('state') !== state) throw new Error('Resposta OAuth inválida.');
          const error = url.searchParams.get('error');
          if (error) throw new Error(error === 'access_denied' ? 'Login cancelado.' : `Google OAuth: ${error}`);
          const code = url.searchParams.get('code');
          if (!code) throw new Error('Código OAuth não recebido.');
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end('<!doctype html><meta charset="utf-8"><title>Nexus conectado</title><style>body{font:16px system-ui;background:#07111f;color:#fff;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center}b{color:#65d6ff}</style><main><h1>Google Drive conectado</h1><p>Você pode fechar esta janela e voltar ao <b>Nexus</b>.</p></main>');
          finish(null, code);
        } catch (error) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end(error.message);
          finish(error);
        }
      });
      server.once('error', error => finish(new Error(`O retorno do login foi interrompido (${error.code || 'socket'}). Tente novamente.`)));
      this.pendingAuth = { server, cancel: () => finish(new Error('Login cancelado porque o Nexus foi fechado.')) };
    });

    try {
      await this.shell.openExternal(authUrl);
      const code = await codePromise;
      const tokens = await this.exchangeCode(code, verifier, redirectUri);
      this.auth.tokens = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || this.auth.tokens?.refreshToken || null,
        expiresAt: Date.now() + ((tokens.expires_in || 3600) * 1000) - 60_000
      };
      this.auth.profile = await this.fetchProfile(this.auth.tokens.accessToken);
      this.auth.lastError = null;
      this.save();
      return this.getStatus();
    } catch (error) {
      this.pendingAuth?.cancel();
      await codePromise.catch(() => {});
      throw error;
    } finally {
      this.pendingAuth = null;
    }
  }

  dispose() {
    this.pendingAuth?.cancel();
    this.pendingAuth = null;
  }

  async exchangeCode(code, verifier, redirectUri) {
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });
    if (this.credentials.clientSecret) body.set('client_secret', this.credentials.clientSecret);
    const response = await fetch(this.credentials.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error_description || data.error || 'Falha ao trocar o código OAuth.');
    return data;
  }

  async fetchProfile(accessToken) {
    try {
      const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  async getAccessToken() {
    if (!this.auth?.tokens) throw new Error('Google Drive não conectado.');
    if (this.auth.tokens.accessToken && this.auth.tokens.expiresAt > Date.now()) return this.auth.tokens.accessToken;
    if (!this.auth.tokens.refreshToken) throw new Error('Sessão do Google Drive expirada. Faça login novamente.');
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      refresh_token: this.auth.tokens.refreshToken,
      grant_type: 'refresh_token'
    });
    if (this.credentials.clientSecret) body.set('client_secret', this.credentials.clientSecret);
    const response = await fetch(this.credentials.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error_description || data.error || 'Não foi possível renovar o acesso ao Google Drive.');
    this.auth.tokens.accessToken = data.access_token;
    this.auth.tokens.expiresAt = Date.now() + ((data.expires_in || 3600) * 1000) - 60_000;
    this.save();
    return this.auth.tokens.accessToken;
  }

  async findRemoteFile(fileName, accessToken) {
    const escaped = fileName.replace(/['\\]/g, character => `\\${character}`);
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name = '${escaped}' and trashed = false`,
      fields: 'files(id,name,modifiedTime,size)',
      pageSize: '10'
    });
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Falha ao consultar o Google Drive.');
    return data.files?.[0] || null;
  }

  async uploadFile(filePath, remoteName, extraMetadata = {}, mimeType = 'application/zip') {
    if (!fs.existsSync(filePath)) throw new Error('Arquivo local não encontrado para sincronização.');
    const accessToken = await this.getAccessToken();
    const existing = await this.findRemoteFile(remoteName, accessToken);
    const metadata = { name: remoteName, ...extraMetadata };
    if (!existing) metadata.parents = ['appDataFolder'];
    const method = existing ? 'PATCH' : 'POST';
    const resource = existing ? `/files/${existing.id}` : '/files';
    const initResponse = await fetch(`https://www.googleapis.com/upload/drive/v3${resource}?uploadType=resumable&fields=id,name,modifiedTime,size`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType
      },
      body: JSON.stringify(metadata)
    });
    if (!initResponse.ok) {
      const data = await initResponse.json().catch(() => ({}));
      throw new Error(data.error?.message || 'Não foi possível iniciar o upload ao Google Drive.');
    }
    const uploadUrl = initResponse.headers.get('location');
    if (!uploadUrl) throw new Error('O Google Drive não retornou uma URL de upload.');
    const stats = await fs.promises.stat(filePath);
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Length': String(stats.size), 'Content-Type': mimeType },
      body: fs.createReadStream(filePath),
      duplex: 'half'
    });
    const uploaded = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok) throw new Error(uploaded.error?.message || 'Falha no upload ao Google Drive.');
    this.auth.lastSyncAt = new Date().toISOString();
    this.auth.lastError = null;
    this.save();
    return uploaded;
  }

  async uploadJson(remoteName, value) {
    const accessToken = await this.getAccessToken();
    const existing = await this.findRemoteFile(remoteName, accessToken);
    const boundary = `nexus_${crypto.randomBytes(12).toString('hex')}`;
    const metadata = { name: remoteName, ...(existing ? {} : { parents: ['appDataFolder'] }) };
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(JSON.stringify(value, null, 2)),
      Buffer.from(`\r\n--${boundary}--`)
    ]);
    const resource = existing ? `/files/${existing.id}` : '/files';
    const response = await fetch(`https://www.googleapis.com/upload/drive/v3${resource}?uploadType=multipart&fields=id,name,modifiedTime,size`, {
      method: existing ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'Falha ao sincronizar dados do Nexus.');
    this.auth.lastSyncAt = new Date().toISOString();
    this.auth.lastError = null;
    this.save();
    return data;
  }

  async disconnect() {
    const token = this.auth?.tokens?.refreshToken || this.auth?.tokens?.accessToken;
    if (token) {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token })
      }).catch(() => {});
    }
    if (this.auth) {
      this.auth.tokens = null;
      this.auth.profile = null;
      this.save();
    }
    return this.getStatus();
  }

  forget() {
    this.auth = null;
    if (fs.existsSync(this.authPath)) fs.unlinkSync(this.authPath);
    return this.getStatus();
  }
}

module.exports = GoogleDriveService;
