const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

function fixture({ escape, immediateCleanup = false } = {}) {
  const partitions = new Map(), views = [], changes = [], attachedVisibility = [];
  class Session extends EventEmitter {
    constructor() { super(); this.storage = {}; this.pending = []; }
    setPermissionRequestHandler(handler) { this.permissionRequest = handler; }
    setPermissionCheckHandler(handler) { this.permissionCheck = handler; }
    clearStorageData() { if (immediateCleanup) { this.storage = {}; return Promise.resolve(); } return new Promise(resolve => this.pending.push(() => { this.storage = {}; resolve(); })); }
    clearCache() { return Promise.resolve(); }
    release() { for (const finish of this.pending.splice(0)) finish(); }
  }
  class Contents extends EventEmitter {
    constructor(session) { super(); this.session = session; this.destroyed = false; this.url = ''; this.loads = []; }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; } isDestroyed() { return this.destroyed; }
    getURL() { return this.url; } getTitle() { return 'Título'; }
    loadURL(url) {
      this.url = url; this.loads.push(url);
      if (url.endsWith('/slow')) return new Promise((resolve, reject) => { this.resolveLoad = resolve; this.rejectLoad = reject; });
      return Promise.resolve();
    }
    close() { this.destroyed = true; if (this.rejectLoad) this.rejectLoad(new Error('ERR_ABORTED')); }
  }
  class View {
    constructor({ webPreferences }) { this.preferences = webPreferences; this.webContents = new Contents(webPreferences.session); this.visible = true; views.push(this); }
    setBounds(bounds) { this.bounds = bounds; }
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
  const makeWindow = () => ({ contentView: { children: [], addChildView(view) { attachedVisibility.push(view.getVisible()); this.children.push(view); }, removeChildView(view) { this.children = this.children.filter(item => item !== view); } }, isDestroyed: () => false, getContentSize: () => [800, 600] });
  const window = makeWindow(), backend = new PreviewBrowser(event => changes.push(event), escape), ids = new Map();
  // Exercise the lifecycle through one tab per root; dedicated tests below use
  // the backend directly to cover concurrent identities for the same project.
  const idFor = root => { if (!ids.has(root)) ids.set(root, backend.create(root)); return ids.get(root); };
  const browser = {
    select(root) { return root === null || typeof root !== 'string' || !root ? backend.select(root) : backend.select(root, idFor(root)); },
    async open(owner, root, url, bounds) { return backend.open(owner, root, url, bounds, idFor(root)); },
    close(root) { const id = ids.get(root); ids.delete(root); return backend.close(root, id); },
    closeAll() { ids.clear(); return backend.closeAll(); },
    setVisible(value) { return backend.setVisible(value); },
    resize(bounds) { return backend.resize(bounds); },
    get selectedRoot() { return backend.tabs.get(backend.selectedId)?.root || null; },
  };
  return { browser, backend, ids, window, makeWindow, views, partitions, changes, attachedVisibility, bounds: { x: 0, y: 0, width: 300, height: 200 } };
}

test('uma guia reaberta aguarda a limpeza da partição estável do projeto', async () => {
  const { browser, window, views, partitions, bounds } = fixture();
  browser.select('/project');
  await browser.open(window, '/project', 'http://localhost:3000/', bounds);
  const session = [...partitions.values()][0]; session.storage.marker = 'old';
  const closing = browser.close('/project');
  browser.select('/project');
  const opening = browser.open(window, '/project', 'http://localhost:3000/', bounds);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(views.length, 1, 'a próxima guia deve esperar o fim da limpeza');
  session.release(); await closing; await opening;
  const replacement = views[1].webContents.session;
  assert.equal(replacement, session); assert.equal(replacement.storage.marker, undefined);
  replacement.storage.marker = 'new'; assert.equal(session.storage.marker, 'new');
});

test('uma abertura cancelada não interfere na prévia do projeto seguinte', async () => {
  const { browser, window, views, changes, partitions, bounds } = fixture();
  browser.select('/old');
  const old = browser.open(window, '/old', 'http://localhost:3000/slow', bounds).then(() => 'resolved', () => 'rejected');
  await new Promise(resolve => setImmediate(resolve));
  const closing = browser.close('/old');
  browser.select('/new');
  await browser.open(window, '/new', 'http://localhost:3000/', bounds);
  assert.equal(await old, 'resolved');
  changes.length = 0; views[0].webContents.emit('did-finish-load');
  assert.deepEqual(changes, []);
  assert.equal(browser.selectedRoot, '/new');
  for (const session of partitions.values()) session.release();
  await closing;
});

test('não reutiliza a partição da mesma guia quando a limpeza falha', async () => {
  const { browser, window, makeWindow, views, partitions, bounds } = fixture();
  browser.select('/project');
  await browser.open(window, '/project', 'http://localhost:3000/', bounds);
  const session = [...partitions.values()][0];
  session.clearStorageData = () => Promise.reject(new Error('falha simulada'));
  const nextWindow = makeWindow();
  await assert.rejects(browser.open(nextWindow, '/project', 'http://localhost:3000/', bounds), /limpar os dados temporários/);
  assert.equal(views.length, 1);
  session.clearStorageData = () => { session.storage = {}; return Promise.resolve(); };
  await browser.open(nextWindow, '/project', 'http://localhost:3000/', bounds);
  assert.equal(views.length, 2);
});

test('ocultar e exibir preserva a mesma prévia, URL e dados da sessão', async () => {
  const { browser, window, views, partitions, bounds } = fixture();
  browser.select('/project');
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
  browser.select('/project');
  await browser.open(window, '/project', 'http://localhost:3000/', bounds);
  assert.deepEqual(attachedVisibility, [false], 'a prévia não pode aparecer antes de ser ocultada');
  assert.equal(views[0].getVisible(), false);
  browser.setVisible(true);
  assert.equal(views[0].getVisible(), true);
  assert.equal(views[0].webContents.getURL(), 'http://localhost:3000/');
});

test('a reabertura após limpeza respeita a visibilidade solicitada', async () => {
  const { browser, window, views, partitions, attachedVisibility, bounds } = fixture();
  browser.select('/project');
  await browser.open(window, '/project', 'http://localhost:3000/', bounds);
  const session = [...partitions.values()][0];
  const closing = browser.close('/project');
  browser.setVisible(false);
  browser.select('/project');
  const opening = browser.open(window, '/project', 'http://localhost:3000/novo', bounds);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(views.length, 1, 'a próxima guia deve esperar a limpeza anterior');
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
  browser.select('/project');
  await browser.open(window, '/project', 'http://localhost:3000/', bounds);
  assert.equal(views[0].getVisible(), true);
  browser.setVisible(false);
  for (const value of invalid) assert.throws(() => browser.setVisible(value), /Visibilidade da prévia inválida/);
  assert.equal(views[0].getVisible(), false);
});

test('Escape só é capturado para tecla válida quando o callback autoriza', async () => {
  let allowed = false, calls = 0;
  const { browser, window, views, partitions, bounds } = fixture({ escape: () => { calls++; return allowed; } });
  browser.select('/project');
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

  browser.select('/outro-projeto');
  await browser.open(window, '/outro-projeto', 'http://localhost:3000/', bounds);
  assert.equal(send(old, keyDown), false, 'uma prévia não selecionada não pode interceptar eventos');
  assert.equal(calls, 2);
  assert.equal(send(views[1], keyDown), true);
  assert.equal(calls, 3);
  for (const session of partitions.values()) session.release();
});

test('alternar projetos preserva as views, navegações e armazenamento de cada um', async () => {
  const { browser, window, views, partitions, bounds } = fixture();
  browser.select('/a');
  await browser.open(window, '/a', 'http://localhost:3000/a', bounds);
  const a = views[0], aSession = a.webContents.session;
  aSession.storage.marker = 'dados A';
  browser.select('/b');
  assert.equal(a.getVisible(), false);
  await browser.open(window, '/b', 'http://localhost:3000/b', bounds);
  const b = views[1], bSession = b.webContents.session;
  bSession.storage.marker = 'dados B';
  assert.notEqual(aSession, bSession);
  assert.equal(a.getVisible(), false); assert.equal(b.getVisible(), true);

  browser.select('/a');
  assert.equal(a.getVisible(), true); assert.equal(b.getVisible(), false);
  assert.equal(a.webContents.isDestroyed(), false); assert.equal(b.webContents.isDestroyed(), false);
  assert.deepEqual(a.webContents.loads, ['http://localhost:3000/a']);
  assert.deepEqual(b.webContents.loads, ['http://localhost:3000/b']);
  assert.equal(aSession.storage.marker, 'dados A'); assert.equal(bSession.storage.marker, 'dados B');
  assert.equal(aSession.pending.length, 0); assert.equal(bSession.pending.length, 0);
  assert.equal(partitions.size, 2); assert.equal(window.contentView.children.length, 2);

  browser.select(null);
  assert.equal(a.getVisible(), false); assert.equal(b.getVisible(), false);
  browser.select('/b'); browser.setVisible(false);
  assert.equal(a.getVisible(), false); assert.equal(b.getVisible(), false);
  browser.setVisible(true);
  assert.equal(a.getVisible(), false); assert.equal(b.getVisible(), true);
});

test('abertura lenta de outro projeto não troca a guia selecionada nem mostra view oculta', async () => {
  const { browser, window, views, bounds } = fixture();
  browser.select('/a');
  const opening = browser.open(window, '/a', 'http://localhost:3000/slow', bounds);
  assert.equal(views[0].getVisible(), true);
  browser.select('/b');
  await browser.open(window, '/b', 'http://localhost:3000/b', bounds);
  assert.equal(views[0].getVisible(), false); assert.equal(views[1].getVisible(), true);
  views[0].webContents.resolveLoad();
  assert.deepEqual(await opening, { url: 'http://localhost:3000/slow' });
  assert.equal(browser.selectedRoot, '/b');
  assert.equal(views[0].getVisible(), false); assert.equal(views[1].getVisible(), true);
});

test('fechar enquanto uma abertura aguarda limpeza impede ressurreição da view', async () => {
  const { browser, window, makeWindow, views, bounds } = fixture();
  browser.select('/a');
  await browser.open(window, '/a', 'http://localhost:3000/a', bounds);
  const partition = views[0].webContents.session;
  const pendingOpen = browser.open(makeWindow(), '/a', 'http://localhost:3000/novo', bounds);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(views.length, 1);
  const closing = browser.close('/a');
  partition.release();
  await closing;
  assert.deepEqual(await pendingOpen, { url: 'http://localhost:3000/novo', cancelled: true });
  assert.equal(views.length, 1); assert.equal(window.contentView.children.length, 0);
});

test('fechar um projeto não afeta outra prévia; fechar todas cancela carregamento', async () => {
  const { browser, window, views, partitions, bounds } = fixture();
  browser.select('/a'); await browser.open(window, '/a', 'http://localhost:3000/a', bounds);
  browser.select('/b'); const bOpen = browser.open(window, '/b', 'http://localhost:3000/slow', bounds);
  const closeA = browser.close('/a');
  assert.equal(views[0].webContents.isDestroyed(), true);
  assert.equal(views[1].webContents.isDestroyed(), false); assert.equal(views[1].getVisible(), true);
  assert.equal(browser.selectedRoot, '/b');
  await new Promise(resolve => setImmediate(resolve));
  for (const partition of partitions.values()) partition.release();
  await closeA;
  const closeAll = browser.closeAll();
  assert.equal(views[1].webContents.isDestroyed(), true);
  assert.equal(window.contentView.children.length, 0); assert.equal(browser.selectedRoot, null);
  await new Promise(resolve => setImmediate(resolve));
  for (const partition of partitions.values()) partition.release();
  await closeAll;
  assert.deepEqual(await bOpen, { url: 'http://localhost:3000/slow', cancelled: true });
});

test('seleção e redimensionamento só atuam na prévia escolhida', async () => {
  const { browser, window, views, bounds } = fixture();
  browser.select('/a'); await browser.open(window, '/a', 'http://localhost:3000/a', bounds);
  browser.select('/b'); await browser.open(window, '/b', 'http://localhost:3000/b', bounds);
  browser.select('/a'); browser.resize({ x: 40, y: 50, width: 160, height: 120 });
  assert.deepEqual(views[0].bounds, { x: 40, y: 50, width: 160, height: 120 });
  assert.deepEqual(views[1].bounds, bounds);
  for (const invalid of [undefined, '', 0, {}, []]) assert.throws(() => browser.select(invalid), /Projeto da prévia inválido/);
  assert.equal(browser.selectedRoot, '/a'); assert.equal(views[0].getVisible(), true);
});

test('cada prévia mantém as proteções de execução e navegação', async () => {
  const { browser, window, views, bounds } = fixture();
  browser.select('/a'); await browser.open(window, '/a', 'http://localhost:3000/', bounds);
  const view = views[0], contents = view.webContents, partition = contents.session;
  assert.equal(view.preferences.sandbox, true); assert.equal(view.preferences.contextIsolation, true);
  assert.equal(view.preferences.nodeIntegration, false); assert.equal(view.preferences.webSecurity, true);
  assert.equal(view.preferences.webviewTag, false); assert.equal(view.preferences.backgroundThrottling, true);
  assert.deepEqual(contents.windowOpenHandler(), { action: 'deny' });
  let result; partition.permissionRequest(null, 'camera', value => { result = value; }); assert.equal(result, false);
  assert.equal(partition.permissionCheck(), false);
  let blocked = false; contents.emit('will-navigate', { preventDefault() { blocked = true; } }, 'https://example.com/');
  assert.equal(blocked, true);
  blocked = false; contents.emit('will-redirect', { preventDefault() { blocked = true; } }, 'file:///tmp/arquivo');
  assert.equal(blocked, true);
  blocked = false; contents.emit('will-navigate', { preventDefault() { blocked = true; } }, 'http://localhost:3000/ok');
  assert.equal(blocked, false);
  let cancelled = false; partition.emit('will-download', {}, { cancel() { cancelled = true; } }); assert.equal(cancelled, true);
});

test('limite de prévias recusa a próxima sem fechar as já abertas', async () => {
  const { browser, window, views, bounds } = fixture();
  for (let i = 0; i < 12; i++) await browser.open(window, `/p${i}`, `http://localhost:3000/${i}`, bounds);
  await assert.rejects(browser.open(window, '/p12', 'http://localhost:3000/12', bounds), /limite é 12/);
  assert.equal(views.length, 12); assert.ok(views.every(view => !view.webContents.isDestroyed()));
  const closing = browser.close('/p0'); await new Promise(resolve => setImmediate(resolve)); views[0].webContents.session.release(); await closing;
  await browser.open(window, '/p12', 'http://localhost:3000/12', bounds);
  assert.equal(views.length, 13);
});

test('identidade antiga atrasada não reabre nem altera nova guia do mesmo projeto', async () => {
  const { backend, window, views, changes, bounds } = fixture();
  const oldId = backend.create('/a'), newId = backend.create('/a');
  assert.notEqual(oldId, newId);
  assert.equal(backend.select('/a', oldId), true);
  await backend.open(window, '/a', 'http://localhost:3000/old', bounds, oldId);
  const partition = views[0].webContents.session;
  partition.storage.marker = 'anterior';
  assert.equal(backend.select('/a', newId), true);
  const reopening = backend.open(window, '/a', 'http://localhost:3000/new', bounds, newId);
  const closing = backend.close('/a', oldId);
  const late = backend.open(window, '/a', 'http://localhost:3000/late', bounds, oldId);
  assert.deepEqual(await late, { url: 'http://localhost:3000/late', cancelled: true });
  assert.equal(backend.select('/a', oldId), false);
  assert.equal(await backend.close('/a', oldId), false);
  assert.equal(views.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  partition.release(); await closing; await reopening;
  assert.equal(views.length, 2); assert.equal(views[1].webContents.session, partition);
  assert.equal(partition.storage.marker, undefined); partition.storage.marker = 'novo';
  assert.equal(views[1].getVisible(), true); assert.equal(backend.selectedId, newId);
  assert.equal(await backend.close('/a', oldId), false);
  assert.equal(views[1].webContents.isDestroyed(), false); assert.equal(partition.storage.marker, 'novo');
  changes.length = 0;
  views[0].webContents.emit('did-finish-load');
  views[1].webContents.emit('did-finish-load');
  assert.deepEqual(changes.map(event => [event.path, event.id]), [['/a', newId]]);
  assert.equal(backend.select('/outro', newId), false);
  assert.equal(await backend.close('/outro', newId), false);
});

test('cancelar guia que aguarda outro id não espera nem interfere na guia existente', async () => {
  const { backend, window, views, bounds } = fixture();
  const owner = backend.create('/a'), waiting = backend.create('/a');
  backend.select('/a', owner); await backend.open(window, '/a', 'http://localhost:3000/owner', bounds, owner);
  const pending = backend.open(window, '/a', 'http://localhost:3000/waiting', bounds, waiting);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(views.length, 1);
  assert.equal(await backend.close('/a', waiting), true);
  assert.deepEqual(await pending, { url: 'http://localhost:3000/waiting', cancelled: true });
  assert.equal(views[0].getVisible(), true); assert.equal(views[0].webContents.isDestroyed(), false);
});

test('falhas de limpeza são comunicadas e não acumulam marcadores por guia', async () => {
  const { backend, window, views, bounds } = fixture({ immediateCleanup: true });
  for (let i = 0; i < 5; i++) {
    const root = `/project-${i}`, id = backend.create(root);
    await backend.open(window, root, 'http://localhost:3000/', bounds, id);
    const partition = views.at(-1).webContents.session;
    partition.clearStorageData = () => Promise.reject(new Error('falha simulada'));
    await assert.rejects(backend.close(root, id), /dados temporários não puderam ser limpos/);
    assert.equal(backend.cleanupFailures.size, 0);
  }
  assert.equal(backend.recheckCleanup, true);
});

test('após falha na limpeza, uma nova guia limpa novamente antes de usar a partição', async () => {
  const { backend, window, views, bounds } = fixture();
  const oldId = backend.create('/a');
  await backend.open(window, '/a', 'http://localhost:3000/old', bounds, oldId);
  const partition = views[0].webContents.session;
  partition.storage.marker = 'segredo antigo';
  partition.clearStorageData = () => Promise.reject(new Error('falha simulada'));
  await assert.rejects(backend.close('/a', oldId), /dados temporários não puderam ser limpos/);
  assert.equal(backend.cleanupFailures.size, 0);
  partition.clearStorageData = () => { partition.storage = {}; return Promise.resolve(); };
  const newId = backend.create('/a'); backend.select('/a', newId);
  await backend.open(window, '/a', 'http://localhost:3000/new', bounds, newId);
  assert.equal(views[1].webContents.session, partition);
  assert.equal(partition.storage.marker, undefined);
});

test('fechar projeto informa falha parcial e conserva prévia de outro projeto', async () => {
  const { backend, window, views, bounds } = fixture();
  const a = backend.create('/a'), b = backend.create('/b');
  backend.select('/a', a); await backend.open(window, '/a', 'http://localhost:3000/a', bounds, a);
  backend.select('/b', b); await backend.open(window, '/b', 'http://localhost:3000/b', bounds, b);
  views[0].webContents.session.clearStorageData = () => Promise.reject(new Error('falha simulada'));
  assert.deepEqual(await backend.closeProject('/a'), { partial: true });
  assert.equal(backend.cleanupFailures.size, 0);
  assert.equal(backend.selectedId, b); assert.equal(views[1].webContents.isDestroyed(), false);
  assert.equal(views[1].getVisible(), true);
});
