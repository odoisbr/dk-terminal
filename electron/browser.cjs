const { WebContentsView, session } = require('electron');
const { createHash } = require('node:crypto');
function localURL(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Informe um endereço local válido.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) || url.username || url.password) throw new Error('A prévia aceita somente endereços http(s) de localhost ou 127.0.0.1.');
  return url.href;
}
class PreviewBrowser {
  constructor(changed) { this.changed = changed; this.view = null; this.window = null; this.root = null; this.partition = null; this.downloadGuard = (_event, item) => item.cancel(); }
  async open(window, root, value, bounds) {
    const url = localURL(value);
    if (!this.view || this.root !== root) {
      this.close(); this.window = window; this.root = root;
      this.partition = session.fromPartition('dk-preview-' + createHash('sha256').update(root).digest('hex').slice(0, 20));
      this.partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      this.partition.setPermissionCheckHandler(() => false);
      this.partition.on('will-download', this.downloadGuard);
      this.view = new WebContentsView({ webPreferences: { session: this.partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, backgroundThrottling: true } });
      const contents = this.view.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guard = (event, target) => { try { localURL(target); } catch { event.preventDefault(); } };
      contents.on('will-navigate', guard); contents.on('will-redirect', guard);
      contents.on('did-start-loading', () => this.changed({ path: root, loading: true }));
      contents.on('did-finish-load', () => this.changed({ path: root, loading: false, url: contents.getURL(), title: contents.getTitle().slice(0, 100) }));
      contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) this.changed({ path: root, loading: false, error: description }); });
      window.contentView.addChildView(this.view);
    }
    this.resize(bounds);
    await this.view.webContents.loadURL(url);
    return { url };
  }
  resize(bounds) {
    if (!this.view || !this.window || this.window.isDestroyed()) return;
    if (!bounds || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(bounds[key]) || bounds[key] < 0 || bounds[key] > 20000)) throw new Error('Dimensões da prévia inválidas.');
    const [width, height] = this.window.getContentSize();
    const x = Math.max(0, Math.min(width - 1, Math.round(bounds.x))), y = Math.max(0, Math.min(height - 1, Math.round(bounds.y)));
    this.view.setBounds({ x, y, width: Math.max(1, Math.min(width - x, Math.round(bounds.width))), height: Math.max(1, Math.min(height - y, Math.round(bounds.height))) });
  }
  close() {
    if (this.view) {
      if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(this.view);
      if (!this.view.webContents.isDestroyed()) this.view.webContents.close({ waitForBeforeUnload: false });
      this.partition?.removeListener('will-download', this.downloadGuard);
      this.partition?.clearStorageData().catch(() => {}); this.partition?.clearCache().catch(() => {});
    }
    this.view = null; this.window = null; this.root = null; this.partition = null;
  }
}
module.exports = { PreviewBrowser, localURL };
