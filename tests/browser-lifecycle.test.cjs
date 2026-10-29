const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

function fixture({ escape } = {}) {
  const partitions = new Map(), views = [], changes = [], attachedVisibility = [];
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
    constructor({ webPreferences }) { this.webContents = new Contents(webPreferences.session); this.visible = true; views.push(this); }
    setBounds() {}
    setVisible(visible) { this.visible = visible; }
    getVisible() { return this.visible; }
  }
  const electron = {
    WebContentsView: View,
    session: { fromPartition(name) { if (!partitions.has(name)) partitions.set(name, new Session()); return partitions.get(name); } },
  };
  const filename = require.resolve('../electron/browser.cjs'), original = Module._load;
  delete require.cache[filename];
  Module._load = function(request, parent, isMain) { return request === 'electron' ? electron : original.call(this, request, parent, isMain); };
  let PreviewBrowser; try { ({ PreviewBrowser } = require(filename)); } finally { Module._load = original; delete require.cache[filename]; }
  const window = { contentView: { children: [], addChildView(view) { attachedVisibility.push(view.getVisible()); this.children.push(view); }, removeChildView(view) { this.children = this.children.filter(item => item !== view); } }, isDestroyed: () => false, getContentSize: () => [800, 600] };
  const browser = new PreviewBrowser(event => changes.push(event), escape);
  return { browser, window, views, partitions, changes, attachedVisibility, bounds: { x: 0, y: 0, width: 300, height: 200 } };
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

test('ocultar e exibir preserva a mesma prévia, URL e dados da sessão', async () => {
  const { browser, window, views, partitions, bounds } = fixture();
  await browser.open(window, '/project', 'http://localhost:3000/a?estado=1', bounds);
  const view = views[0], session = [...partitions.values()][0];
  session.storage.marker = 'preservado';
  assert.equal(view.getVisible(), true);

  browser.setVisible(false);
  assert.equal(view.getVisible(), false);
  assert.equal(view.webContents.isDestroyed(), false);
  assert.equal(window.contentView.children[0], view);
  assert.equal(view.webContents.getURL(), 'http://localhost:3000/a?estado=1');
  assert.equal(session.storage.marker, 'preservado');
  assert.equal(session.pending.length, 0, 'ocultar não deve limpar a sessão');

  browser.setVisible(true);
  assert.equal(view.getVisible(), true);
  assert.equal(views.length, 1);
  assert.equal(window.contentView.children[0], view);
  assert.equal(view.webContents.getURL(), 'http://localhost:3000/a?estado=1');
  assert.equal(session.storage.marker, 'preservado');
});

test('uma prévia aberta já oculta é anexada oculta e pode ser exibida depois', async () => {
  const { browser, window, views, attachedVisibility, bounds } = fixture();
  browser.setVisible(false);
  await browser.open(window, '/project', 'http://localhost:3000/', bounds);
  assert.deepEqual(attachedVisibility, [false], 'a prévia não pode aparecer antes de ser ocultada');
  assert.equal(views[0].getVisible(), false);
  browser.setVisible(true);
  assert.equal(views[0].getVisible(), true);
  assert.equal(views[0].webContents.getURL(), 'http://localhost:3000/');
});

test('a abertura após limpeza assíncrona respeita a última visibilidade solicitada', async () => {
  const { browser, window, views, partitions, attachedVisibility, bounds } = fixture();
  await browser.open(window, '/project', 'http://localhost:3000/', bounds);
  const session = [...partitions.values()][0];
  const closing = browser.close();
  const opening = browser.open(window, '/project', 'http://localhost:3000/novo', bounds);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(views.length, 1, 'a nova prévia deve aguardar a limpeza anterior');

  browser.setVisible(false);
  session.release();
  await closing;
  await opening;
  assert.equal(views.length, 2);
  assert.deepEqual(attachedVisibility, [true, false]);
  assert.equal(views[1].getVisible(), false);
  assert.equal(views[1].webContents.getURL(), 'http://localhost:3000/novo');
  browser.setVisible(true);
  assert.equal(window.contentView.children[0], views[1]);
  assert.equal(views[1].getVisible(), true);
});

test('valores inválidos de visibilidade são rejeitados sem alterar o estado', async () => {
  const { browser, window, views, bounds } = fixture();
  const invalid = [undefined, null, 0, 1, 'true', {}, [], new Boolean(true), NaN];
  for (const value of invalid) assert.throws(() => browser.setVisible(value), /Visibilidade da prévia inválida/);
  await browser.open(window, '/project', 'http://localhost:3000/', bounds);
  assert.equal(views[0].getVisible(), true);
  browser.setVisible(false);
  for (const value of invalid) assert.throws(() => browser.setVisible(value), /Visibilidade da prévia inválida/);
  assert.equal(views[0].getVisible(), false);
});

test('Escape só é capturado para tecla válida quando o callback autoriza', async () => {
  let allowed = false, calls = 0;
  const { browser, window, views, partitions, bounds } = fixture({ escape: () => { calls++; return allowed; } });
  await browser.open(window, '/project', 'http://localhost:3000/', bounds);
  const old = views[0];
  const send = (view, input) => {
    let prevented = false;
    view.webContents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, input);
    return prevented;
  };
  const keyDown = { type: 'keyDown', key: 'Escape', isAutoRepeat: false };
  assert.equal(send(old, { ...keyDown, key: 'Enter' }), false);
  assert.equal(send(old, { ...keyDown, type: 'keyUp' }), false);
  assert.equal(send(old, { ...keyDown, isAutoRepeat: true }), false);
  assert.equal(calls, 0);
  assert.equal(send(old, keyDown), false);
  assert.equal(calls, 1);
  allowed = true;
  assert.equal(send(old, keyDown), true);
  assert.equal(calls, 2);

  await browser.open(window, '/outro-projeto', 'http://localhost:3000/', bounds);
  assert.equal(send(old, keyDown), false, 'uma prévia encerrada não pode interceptar eventos');
  assert.equal(calls, 2);
  assert.equal(send(views[1], keyDown), true);
  assert.equal(calls, 3);
  for (const session of partitions.values()) session.release();
});
