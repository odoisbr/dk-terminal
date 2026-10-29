const { WebContentsView, session } = require('electron');
const { createHash, randomUUID } = require('node:crypto');

function localURL(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Informe um endereço local válido.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) || url.username || url.password) throw new Error('A prévia aceita somente endereços http(s) de localhost ou 127.0.0.1.');
  return url.href;
}

class PreviewBrowser {
  constructor(changed, escape = () => false) {
    this.changed = changed;
    this.escape = escape;
    this.visible = true;
    this.selectedId = null;
    this.tabs = new Map();
    this.owners = new Map();
    this.cleaning = new Map();
    this.closing = new Map();
    this.cleanupFailures = new Set();
    this.recheckCleanup = false;
    this.downloadGuard = (_event, item) => item.cancel();
  }

  partitionKey(root) {
    return 'dk-preview-' + createHash('sha256').update(root).digest('hex').slice(0, 20);
  }

  create(root) {
    if (typeof root !== 'string' || !root || root.includes('\0')) throw new Error('Projeto da prévia inválido.');
    if (this.tabs.size >= 12) throw new Error('Feche uma prévia antes de abrir outra. O limite é 12.');
    const id = randomUUID();
    let finishClosed;
    const closed = new Promise(resolve => { finishClosed = resolve; });
    this.tabs.set(id, { id, root, key: this.partitionKey(root), view: null, window: null, partition: null, opening: null, closed, finishClosed });
    return id;
  }

  syncVisibility() {
    // Hide other native views before showing the selected one.
    for (const [id, tab] of this.tabs) {
      if (tab.view && (!this.visible || id !== this.selectedId)) tab.view.setVisible(false);
    }
    const selected = this.visible && this.selectedId ? this.tabs.get(this.selectedId) : null;
    if (selected?.view) selected.view.setVisible(true);
  }

  select(root, id) {
    if (root === null) { this.selectedId = null; this.syncVisibility(); return true; }
    if (typeof root !== 'string' || !root || root.includes('\0')) throw new Error('Projeto da prévia inválido.');
    const tab = this.tabs.get(id);
    if (!tab || tab.root !== root) return false;
    this.selectedId = id;
    this.syncVisibility();
    return true;
  }

  async open(window, root, value, bounds, id) {
    const url = localURL(value);
    const tab = this.tabs.get(id);
    if (!tab || tab.root !== root) return { url, cancelled: true };
    tab.opening?.cancel();
    let cancel;
    const cancelled = new Promise(resolve => { cancel = resolve; });
    const token = { cancel, cancelled };
    tab.opening = token;
    const current = () => this.tabs.get(id) === tab && tab.opening === token && window && !window.isDestroyed();
    try {
      // Only one live view may use a project's temporary partition at a time.
      // New tab ids wait for the previous owner and its cleanup, but can be
      // cancelled immediately without waiting for that owner to close.
      while (current()) {
        const owner = this.owners.get(root);
        if (!owner || owner === tab) { this.owners.set(root, tab); break; }
        await Promise.race([owner.closed, token.cancelled]);
      }
      if (!current()) return { url, cancelled: true };
      if (tab.view && tab.window !== window) this.retireView(tab);
      if (!tab.view) {
        // An old view for this same tab may still be cleaning its temporary
        // partition after a window change. Never reuse it before cleanup ends.
        const pending = this.cleaning.get(tab.key); if (pending) await Promise.race([pending, token.cancelled]);
        if (!current()) return { url, cancelled: true };
        if (this.cleanupFailures.has(tab.key) || this.recheckCleanup) {
          const cleanup = this.cleaning.get(tab.key) || this.cleanPartition(session.fromPartition(tab.key), tab.key);
          await Promise.race([cleanup, token.cancelled]);
          if (!current()) return { url, cancelled: true };
          if (this.cleanupFailures.has(tab.key)) throw new Error('Não foi possível limpar os dados temporários da prévia. Tente novamente.');
        }
        const partition = session.fromPartition(tab.key);
        partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        partition.setPermissionCheckHandler(() => false);
        partition.on('will-download', this.downloadGuard);
        let view;
        try {
          view = new WebContentsView({ webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, backgroundThrottling: true } });
        } catch (error) {
          partition.removeListener('will-download', this.downloadGuard);
          throw error;
        }
        tab.view = view; tab.window = window; tab.partition = partition;
        const contents = view.webContents;
        const live = () => this.tabs.get(id) === tab && tab.view === view && !contents.isDestroyed();
        // Native child views have independent focus; only the selected view can
        // consume Escape for the window's fullscreen controller.
        contents.on('before-input-event', (event, input) => {
          if (live() && this.visible && this.selectedId === id && input.type === 'keyDown' && input.key === 'Escape' && !input.isAutoRepeat && this.escape()) event.preventDefault();
        });
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const guard = (event, target) => { try { localURL(target); } catch { event.preventDefault(); } };
        contents.on('will-navigate', guard); contents.on('will-redirect', guard);
        contents.on('did-start-loading', () => { if (live()) this.changed({ path: root, id, loading: true }); });
        contents.on('did-finish-load', () => { if (live()) this.changed({ path: root, id, loading: false, url: contents.getURL(), title: contents.getTitle().slice(0, 100) }); });
        contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (live() && mainFrame && code !== -3) this.changed({ path: root, id, loading: false, error: description }); });
        // A pending, unselected preview must never flash over another tab.
        view.setVisible(this.visible && this.selectedId === id);
        try { window.contentView.addChildView(view); }
        catch (error) { this.retireView(tab); throw error; }
      }
      if (!current() || !tab.view) return { url, cancelled: true };
      const view = tab.view;
      this.resizeView(tab, bounds);
      try { await view.webContents.loadURL(url); }
      catch (error) { if (!current() || tab.view !== view) return { url, cancelled: true }; throw error; }
      if (!current() || tab.view !== view) return { url, cancelled: true };
      return { url };
    } finally { if (tab.opening === token) tab.opening = null; }
  }

  resize(bounds) {
    const tab = this.selectedId && this.tabs.get(this.selectedId);
    if (tab?.view) this.resizeView(tab, bounds);
  }

  resizeView(tab, bounds) {
    if (!tab.view || !tab.window || tab.window.isDestroyed()) return;
    if (!bounds || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(bounds[key]) || bounds[key] < 0 || bounds[key] > 20000)) throw new Error('Dimensões da prévia inválidas.');
    const [width, height] = tab.window.getContentSize();
    const x = Math.max(0, Math.min(width - 1, Math.round(bounds.x))), y = Math.max(0, Math.min(height - 1, Math.round(bounds.y)));
    tab.view.setBounds({ x, y, width: Math.max(1, Math.min(width - x, Math.round(bounds.width))), height: Math.max(1, Math.min(height - y, Math.round(bounds.height))) });
  }

  setVisible(visible) {
    if (typeof visible !== 'boolean') throw new Error('Visibilidade da prévia inválida.');
    this.visible = visible;
    this.syncVisibility();
  }

  close(root, id) {
    const tab = this.tabs.get(id);
    if (!tab || tab.root !== root) return Promise.resolve(false);
    this.tabs.delete(id);
    tab.opening?.cancel();
    tab.opening = null;
    if (this.selectedId === id) this.selectedId = null;
    const ownsPartition = this.owners.get(root) === tab;
    const closing = this.retireView(tab).then(() => {
      // This id cannot be reused. Report a failed cleanup without retaining a
      // permanent failure marker for every closed tab.
      if (ownsPartition && this.cleanupFailures.delete(tab.key)) {
        // After any failed cleanup, verify a clean partition before each new
        // view. A single flag avoids retaining every closed project's id.
        this.recheckCleanup = true;
        throw new Error('A prévia foi fechada, mas seus dados temporários não puderam ser limpos.');
      }
      return true;
    }).finally(() => {
      if (this.owners.get(root) === tab) this.owners.delete(root);
      tab.finishClosed();
      if (this.closing.get(id)?.promise === closing) this.closing.delete(id);
    });
    this.closing.set(id, { root, promise: closing });
    return closing;
  }

  closeProject(root) {
    const pending = [...this.closing.values()].filter(item => item.root === root).map(item => item.promise);
    const closing = [...this.tabs.values()].filter(tab => tab.root === root).map(tab => this.close(root, tab.id));
    return Promise.allSettled([...pending, ...closing]).then(results => ({ partial: results.some(result => result.status === 'rejected') }));
  }

  closeAll() {
    const pending = [...this.closing.values()].map(item => item.promise);
    const closing = [...this.tabs.values()].map(tab => this.close(tab.root, tab.id));
    this.selectedId = null;
    return Promise.allSettled([...pending, ...closing]).then(results => ({ partial: results.some(result => result.status === 'rejected') }));
  }

  retireView(tab) {
    const { view, window, partition, key } = tab;
    tab.view = null; tab.window = null; tab.partition = null;
    if (!view) return this.owners.get(tab.root) === tab ? this.cleaning.get(key) || Promise.resolve() : Promise.resolve();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    partition.removeListener('will-download', this.downloadGuard);
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
