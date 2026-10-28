const { WebContentsView, session } = require('electron');
const { createHash } = require('node:crypto');
function localURL(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Informe um endereço local válido.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) || url.username || url.password) throw new Error('A prévia aceita somente endereços http(s) de localhost ou 127.0.0.1.');
  return url.href;
}
class PreviewBrowser {
  constructor(changed) { this.changed = changed; this.view = null; this.window = null; this.root = null; this.partition = null; this.partitionKey = null; this.generation = 0; this.cleaning = new Map(); this.cleanupFailures = new Set(); this.downloadGuard = (_event, item) => item.cancel(); }
  async open(window, root, value, bounds) {
    const url = localURL(value);
    const generation = ++this.generation;
    if (!this.view || this.root !== root || this.window !== window) {
      this.retireView();
      const key = 'dk-preview-' + createHash('sha256').update(root).digest('hex').slice(0, 20);
      // A closed view's session is reused by Electron. Do not let its delayed
      // cleanup erase storage or cache belonging to a newly opened view.
      const pending = this.cleaning.get(key); if (pending) await pending;
      if (generation !== this.generation || !window || window.isDestroyed()) return { url, cancelled: true };
      if (this.cleanupFailures.has(key)) {
        await (this.cleaning.get(key) || this.cleanPartition(session.fromPartition(key), key));
        if (generation !== this.generation || window.isDestroyed()) return { url, cancelled: true };
        if (this.cleanupFailures.has(key)) throw new Error('Não foi possível limpar os dados temporários da prévia. Tente novamente.');
      }
      this.window = window; this.root = root; this.partitionKey = key;
      this.partition = session.fromPartition(key);
      this.partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.partition.setPermissionCheckHandler(() => false);
      this.partition.on('will-download', this.downloadGuard);
      this.view = new WebContentsView({ webPreferences: { session: this.partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, backgroundThrottling: true } });
      const view = this.view, contents = view.webContents;
      const current = () => this.view === view && !contents.isDestroyed();
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guard = (event, target) => { try { localURL(target); } catch { event.preventDefault(); } };
      contents.on('will-navigate', guard); contents.on('will-redirect', guard);
      contents.on('did-start-loading', () => { if (current()) this.changed({ path: root, loading: true }); });
      contents.on('did-finish-load', () => { if (current()) this.changed({ path: root, loading: false, url: contents.getURL(), title: contents.getTitle().slice(0, 100) }); });
      contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (current() && mainFrame && code !== -3) this.changed({ path: root, loading: false, error: description }); });
      window.contentView.addChildView(view);
    }
    const view = this.view;
    if (!view || generation !== this.generation) return { url, cancelled: true };
    this.resize(bounds);
    try { await view.webContents.loadURL(url); }
    catch (error) { if (generation !== this.generation || this.view !== view) return { url, cancelled: true }; throw error; }
    if (generation !== this.generation || this.view !== view) return { url, cancelled: true };
    return { url };
  }
  resize(bounds) {
    if (!this.view || !this.window || this.window.isDestroyed()) return;
    if (!bounds || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(bounds[key]) || bounds[key] < 0 || bounds[key] > 20000)) throw new Error('Dimensões da prévia inválidas.');
    const [width, height] = this.window.getContentSize();
    const x = Math.max(0, Math.min(width - 1, Math.round(bounds.x))), y = Math.max(0, Math.min(height - 1, Math.round(bounds.y)));
    this.view.setBounds({ x, y, width: Math.max(1, Math.min(width - x, Math.round(bounds.width))), height: Math.max(1, Math.min(height - y, Math.round(bounds.height))) });
  }
  close() { this.generation++; return this.retireView(); }
  retireView() {
    const view = this.view, window = this.window, partition = this.partition, key = this.partitionKey;
    this.view = null; this.window = null; this.root = null; this.partition = null; this.partitionKey = null;
    if (!view) return Promise.all([...this.cleaning.values()]).then(() => {});
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    partition?.removeListener('will-download', this.downloadGuard);
    if (!partition || !key) return Promise.resolve();
    return this.cleanPartition(partition, key).then(() => {});
  }
  cleanPartition(partition, key) {
    const cleanup = Promise.allSettled([
      Promise.resolve().then(() => partition.clearStorageData()),
      Promise.resolve().then(() => partition.clearCache()),
    ]).then(results => {
      if (results.some(result => result.status === 'rejected')) this.cleanupFailures.add(key);
      else this.cleanupFailures.delete(key);
      if (this.cleaning.get(key) === cleanup) this.cleaning.delete(key);
    });
    this.cleaning.set(key, cleanup);
    return cleanup;
  }
}
module.exports = { PreviewBrowser, localURL };
