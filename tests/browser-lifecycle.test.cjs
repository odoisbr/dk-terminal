const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

function fixture() {
  const partitions = new Map(), views = [], changes = [];
  class Session extends EventEmitter {
    constructor() { super(); this.storage = {}; this.pending = []; }
    setPermissionRequestHandler() {} setPermissionCheckHandler() {}
    clearStorageData() { return new Promise(resolve => this.pending.push(() => { this.storage = {}; resolve(); })); }
    clearCache() { return Promise.resolve(); }
    release() { for (const finish of this.pending.splice(0)) finish(); }
  }
  class Contents extends EventEmitter {
    constructor(session) { super(); this.session = session; this.destroyed = false; this.url = ''; }
    setWindowOpenHandler() {} isDestroyed() { return this.destroyed; }
    getURL() { return this.url; } getTitle() { return 'Título'; }
    loadURL(url) {
      this.url = url;
      if (url.endsWith('/slow')) return new Promise((_resolve, reject) => { this.rejectLoad = reject; });
      return Promise.resolve();
    }
    close() { this.destroyed = true; if (this.rejectLoad) this.rejectLoad(new Error('ERR_ABORTED')); }
  }
  class View {
    constructor({ webPreferences }) { this.webContents = new Contents(webPreferences.session); views.push(this); }
    setBounds() {}
  }
  const electron = {
    WebContentsView: View,
    session: { fromPartition(name) { if (!partitions.has(name)) partitions.set(name, new Session()); return partitions.get(name); } },
  };
  const filename = require.resolve('../electron/browser.cjs'), original = Module._load;
  delete require.cache[filename];
  Module._load = function(request, parent, isMain) { return request === 'electron' ? electron : original.call(this, request, parent, isMain); };
  let PreviewBrowser; try { ({ PreviewBrowser } = require(filename)); } finally { Module._load = original; delete require.cache[filename]; }
  const window = { contentView: { children: [], addChildView(view) { this.children.push(view); }, removeChildView(view) { this.children = this.children.filter(item => item !== view); } }, isDestroyed: () => false, getContentSize: () => [800, 600] };
  const browser = new PreviewBrowser(event => changes.push(event));
  return { browser, window, views, partitions, changes, bounds: { x: 0, y: 0, width: 300, height: 200 } };
}

test('reabrir a mesma partição aguarda a limpeza anterior', async () => {
  const { browser, window, views, partitions, bounds } = fixture();
  await browser.open(window, '/project', 'http://localhost:3000/', bounds);
  const session = [...partitions.values()][0]; session.storage.marker = 'old';
  const closing = browser.close();
  const opening = browser.open(window, '/project', 'http://localhost:3000/', bounds);
  await new Promise(resolve => setImmediate(resolve));
  const reopenedBeforeCleanup = views.length > 1;
  session.release(); await Promise.allSettled([closing, opening]);
  assert.equal(reopenedBeforeCleanup, false, 'a limpeza anterior não pode apagar dados da nova prévia');
  session.storage.marker = 'new';
  assert.equal(session.storage.marker, 'new');
});

test('uma abertura cancelada não interfere na prévia do projeto seguinte', async () => {
  const { browser, window, views, changes, partitions, bounds } = fixture();
  const old = browser.open(window, '/old', 'http://localhost:3000/slow', bounds).then(() => 'resolved', () => 'rejected');
  await new Promise(resolve => setImmediate(resolve));
  await browser.open(window, '/new', 'http://localhost:3000/', bounds);
  assert.equal(await old, 'resolved');
  changes.length = 0; views[0].webContents.emit('did-finish-load');
  assert.deepEqual(changes, []);
  assert.equal(browser.root, '/new');
  for (const session of partitions.values()) session.release();
});

test('não reabre uma partição enquanto a limpeza continuar falhando', async () => {
  const { browser, window, views, partitions, bounds } = fixture();
  await browser.open(window, '/project', 'http://localhost:3000/', bounds);
  const session = [...partitions.values()][0];
  session.clearStorageData = () => Promise.reject(new Error('falha simulada'));
  await browser.close();
  await assert.rejects(browser.open(window, '/project', 'http://localhost:3000/', bounds), /limpar os dados temporários/);
  assert.equal(views.length, 1);
  session.clearStorageData = () => { session.storage = {}; return Promise.resolve(); };
  await browser.open(window, '/project', 'http://localhost:3000/', bounds);
  assert.equal(views.length, 2);
});
