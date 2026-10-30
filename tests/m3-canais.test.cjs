const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { stripTypeScriptTypes, createRequire } = require('node:module');
const { projectInfo } = require('../electron/core.cjs');
const { VisualSessions } = require('../electron/visual-session.cjs');
const { PRIVILEGES, createHandler, frameNavigationAllowed, isPreviewUrl } = require('../electron/visual-protocol.cjs');

const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
function sourceFunction(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\)[^{\\n]*\\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, name); return match[0];
}
const operation = { type: 'text', node: 1, value: 'novo' };
const calls = root => [
  ['openVisual', 'visual:open', root, 'index.html', { codeEditorDirty: false }],
  ['inspectVisual', 'visual:inspect', root, 0, 1], ['applyVisual', 'visual:apply', root, 0, operation],
  ['undoVisual', 'visual:undo', root, 0], ['redoVisual', 'visual:redo', root, 0],
  ['saveVisual', 'visual:save', root, 0], ['reloadVisual', 'visual:reload', root],
  ['closeVisual', 'visual:close', root], ['visualState', 'visual:state', root],
];
const plain = value => JSON.parse(JSON.stringify(value));
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };

// Like M2: execute the actual main functions in a VM with fake Electron hosts.
// Session, patch worker, filesystem and protocol handler remain real.
function mainHandlers(t, { Sessions = VisualSessions } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-m3-ipc-')));
  const root = path.join(base, 'project'), other = path.join(base, 'other');
  for (const folder of [root, other]) { fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'index.html'), '<p>original</p>'); }
  const handlers = new Map(), protocols = new Map(), events = [], dialogs = [], schemes = [], logs = [];
  const defaultSession = Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} });
  class FakeWindow extends EventEmitter {
    constructor() {
      super(); this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url: 'dk-app://app/index.html' },
        session: defaultSession, setWindowOpenHandler() {}, send: (channel, payload) => events.push({ channel, payload }) });
    }
    isDestroyed() { return this.destroyed; }
    setDocumentEdited(value) { this.edited = value; }
    setEnabled() {}
    loadURL() {}
    close() { this.destroyed = true; this.emit('closed'); }
  }
  const clean = async () => ({ partial: false });
  const host = { close() {}, closeAll: clean, closeAllAndWait: clean, closeProject: clean, cancelAll: clean, setVisible() {} };
  const context = vm.createContext({
    fs, path, projectInfo, VisualSessions: Sessions, PRIVILEGES, createHandler, frameNavigationAllowed, isPreviewUrl,
    __dirname: path.join(__dirname, '../electron'), process: { platform: process.platform },
    session: { defaultSession }, protocol: { handle: (scheme, handler) => protocols.set(scheme, handler),
      registerSchemesAsPrivileged: entries => schemes.push(entries) },
    BrowserWindow: FakeWindow, BrowserFullscreen: class { dispose() {} async set() {} }, windowIcon() {},
    CodexChat: class { closeAll = clean; cancelAll = clean; async closeProject() { return 0; } }, app: { getPath: () => base, getAppPath: () => base },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    debugLog: { write() {}, event() {}, error: (...args) => logs.push(args) },
    dialog: { async showMessageBox(_owner, options) { dialogs.push(options); return { response: 0 }; } },
    window: null, config: { projects: [] }, env: {}, save() {},
    windowClosing: false, windowCleanupDone: false, dirtyFiles: [], allowClose: false, closePrompt: false,
    quitRequested: false, focusRequested: false, pendingFiles: [],
    terminals: host, services: host, actions: host, extensions: host, orchestration: host, preview: host, usage: host,
    filePreviews: host, previewBridge: { revokeAll() {}, revoke() {} },
    closeProjectBrowser: clean, bootstrap: () => ({}),
  });
  const state = source.slice(source.indexOf('const selected ='), source.indexOf('let kit ='));
  const names = ['send', 'authorize', 'handle', 'project', 'hasDirtyFilesInProject', 'advancePluginGeneration', 'rememberPluginIdentity', 'remember',
    'knownProject', 'pluginProject', 'registerHandlers', 'createWindow'];
  const initialization = source.slice(source.indexOf('  visualSessions = new VisualSessions('), source.indexOf('  stateFile = path.join('));
  const registration = source.match(/^protocol.registerSchemesAsPrivileged\(.*$/m)[0];
  vm.runInContext(`${state}\n${names.map(sourceFunction).join('\n')}\n${registration}\n${initialization}
    agentRun = { sources: {}, cancelAll: async () => ({partial: false}), closeProject: async () => 0 };
    catalogs = extensions; stages = extensions;
    registerHandlers(); createWindow();`, context);
  const sessions = vm.runInContext('visualSessions', context);
  const owner = context.window, event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame };
  const invoke = (event, channel, ...args) => { assert.ok(handlers.has(channel), channel); return handlers.get(channel)(event, ...args); };
  const raw = (channel, ...args) => invoke(event, channel, ...args);
  const call = async (channel, ...args) => ok(await raw(channel, ...args)).value;
  context.remember(root); context.remember(other);
  t.after(() => { sessions.closeAll(); fs.rmSync(base, { recursive: true, force: true }); });
  return { root, other, context, owner, event, sessions, events, dialogs, protocols, schemes, logs, defaultSession, invoke, raw, call };
}

test('todos os canais visual:* usam a mesma autorização do mainFrame dk-app', async t => {
  const f = mainHandlers(t);
  for (const event of [
    { sender: {}, senderFrame: f.event.senderFrame },
    { sender: f.event.sender, senderFrame: { url: 'dk-app://app/index.html' } },
  ]) for (const [, channel, ...args] of calls(f.root)) assert.match((await f.invoke(event, channel, ...args)).error, /Origem não autorizada/);
  for (const url of ['dk-preview://token/index.html', 'https://example.test', 'dk-app://app/other.html']) {
    f.event.senderFrame.url = url;
    for (const [, channel, ...args] of calls(f.root)) assert.match((await f.raw(channel, ...args)).error, /Origem não autorizada/);
  }
  assert.equal(f.sessions.windows.size, 0);
});

test('main conecta os argumentos e resultados do contrato ao worker real', async t => {
  const f = mainHandlers(t);
  assert.equal((await f.call('visual:open', f.root, 'index.html', { codeEditorDirty: false })).reason, 'project-changed');
  await f.call('project:set-active', f.root);
  const initial = ok(await f.call('visual:open', f.root, 'index.html', { codeEditorDirty: false }));
  assert.equal(ok(await f.call('visual:inspect', f.root, initial.doc.gen, 1)).inspect.text, 'original');
  const edited = ok(await f.call('visual:apply', f.root, initial.doc.gen, operation));
  assert.equal(f.owner.edited, true);
  const undone = ok(await f.call('visual:undo', f.root, edited.doc.gen));
  const redone = ok(await f.call('visual:redo', f.root, undone.doc.gen));
  ok(await f.call('visual:save', f.root, redone.doc.gen)); assert.equal(f.owner.edited, false);
  assert.equal(fs.readFileSync(path.join(f.root, 'index.html'), 'utf8'), '<p>novo</p>');
  const reloaded = ok(await f.call('visual:reload', f.root));
  assert.equal(reloaded.state.canUndo, false);
  assert.equal((await f.call('visual:state', f.root)).open, true);
  assert.deepEqual(plain(await f.call('visual:close', f.root)), { ok: true });
  assert.equal((await f.call('visual:state', f.root)).open, false);
  assert.equal(f.events.some(event => event.channel === 'visual:event'), false, 'reload e close são voluntários');
});

test('dk-preview está no mesmo array anterior a ready, com handler e privilégios exatos', async t => {
  const f = mainHandlers(t);
  assert.equal(f.schemes.length, 1);
  assert.deepEqual(plain(f.schemes[0]), [
    { scheme: 'dk-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'dk-preview', privileges: { standard: true, secure: true, corsEnabled: true } },
  ]);
  assert.ok(source.indexOf('protocol.registerSchemesAsPrivileged') < source.indexOf('app.whenReady()'));
  assert.equal((source.match(/registerSchemesAsPrivileged\(/g) || []).length, 1);
  await f.call('project:set-active', f.root);
  const result = ok(await f.call('visual:open', f.root, 'index.html', { codeEditorDirty: false }));
  assert.equal((await f.protocols.get('dk-preview')({ method: 'GET', url: result.doc.url, initiatorOrigin: 'dk-app://app' })).status, 200);
});

test('will-frame-navigate aceita apenas URL corrente e will-download cancela URL ou iframe', async t => {
  const f = mainHandlers(t); await f.call('project:set-active', f.root);
  const initial = ok(await f.call('visual:open', f.root, 'index.html', { codeEditorDirty: false }));
  const navigate = (url, isMainFrame = false) => {
    let blocked = false;
    f.owner.webContents.emit('will-frame-navigate', { url, isMainFrame, preventDefault() { blocked = true; } });
    return blocked;
  };
  assert.equal(navigate(initial.doc.url), false);
  for (const url of [initial.doc.url + '#x', 'https://example.test/', 'about:blank']) assert.equal(navigate(url), true);
  ok(await f.call('visual:apply', f.root, initial.doc.gen, operation));
  assert.equal(navigate(initial.doc.url), true);
  let mainBlocked = false;
  f.owner.webContents.emit('will-navigate', { preventDefault() { mainBlocked = true; } });
  assert.equal(mainBlocked, true);
  for (const [url, contents, frame, expected] of [
    [initial.doc.url, {}, null, true],
    ['https://example.test/a.zip', f.owner.webContents, { url: initial.doc.url }, true],
    ['https://example.test/a.zip', f.owner.webContents, { url: 'about:blank' }, true],
    ['https://example.test/a.zip', {}, { url: initial.doc.url }, true],
    ['https://example.test/a.zip', {}, { url: 'https://example.test/' }, false],
    ['https://example.test/a.zip', f.owner.webContents, f.owner.webContents.mainFrame, false],
  ]) {
    let blocked = false;
    f.defaultSession.emit('will-download', { preventDefault() { blocked = true; } }, { getURL: () => url }, contents, frame);
    assert.equal(blocked, expected);
  }
});

for (const lifecycle of ['project:set-active', 'project:close-sessions', 'project:forget', 'render-process-gone', 'closed']) {
  test(`main revoga sessão com evento apenas involuntário: ${lifecycle}`, async t => {
    const f = mainHandlers(t); await f.call('project:set-active', f.root);
    ok(await f.call('visual:open', f.root, 'index.html', { codeEditorDirty: false }));
    const token = f.sessions.byWindow(f.owner).token;
    if (lifecycle === 'project:set-active') await f.call(lifecycle, f.other);
    else if (lifecycle.startsWith('project:')) await f.call(lifecycle, f.root);
    else (lifecycle === 'closed' ? f.owner : f.owner.webContents).emit(lifecycle);
    assert.equal(f.sessions.byToken(token), null);
    const event = f.events.find(entry => entry.channel === 'visual:event');
    if (lifecycle === 'closed') assert.equal(event, undefined);
    else assert.deepEqual(plain(event.payload), { type: 'revoked', reason: lifecycle.startsWith('project:') ? 'project-changed' : 'renderer-gone' });
  });
}

test('close da janela considera visual dirty no mesmo diálogo e preserva sessão ao cancelar', async t => {
  const f = mainHandlers(t); await f.call('project:set-active', f.root);
  const initial = ok(await f.call('visual:open', f.root, 'index.html', { codeEditorDirty: false }));
  ok(await f.call('visual:apply', f.root, initial.doc.gen, operation));
  let blocked = false;
  f.owner.emit('close', { preventDefault() { blocked = true; } });
  assert.equal(blocked, true); assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].message, /alterações não salvas/);
  assert.match(f.dialogs[0].message, /editor visual/);
  assert.match(f.dialogs[0].detail, /editor visual/);
  assert.equal(f.dialogs[0].buttons[0], 'Voltar ao editor visual');
  await Promise.resolve();
  assert.deepEqual(plain(f.events.find(event => event.channel === 'app:menu')), { channel: 'app:menu', payload: 'visual' });
  assert.equal(f.sessions.dirty(f.owner), true);
  await f.call('file:dirty', []); assert.equal(f.owner.edited, true);
});

test('visual sujo bloqueia Git e publicação até salvar, sem bloquear outro projeto', async t => {
  const f = mainHandlers(t), invoked = [];
  f.context.git = Object.fromEntries(['branchAction', 'commit', 'sync'].map(name => [name, (...args) => { invoked.push([name, ...args]); return true; }]));
  f.context.gitlabPublisher = { plan() { invoked.push(['plan']); return true; }, publish() { invoked.push(['publish']); return true; } };
  await f.call('project:set-active', f.root);
  const initial = ok(await f.call('visual:open', f.root, 'index.html', { codeEditorDirty: false }));
  const edited = ok(await f.call('visual:apply', f.root, initial.doc.gen, operation));
  const operations = [
    ['git:branch-action', 'checkout', 'other'], ['git:branch-action', 'create', 'other'],
    ['git:commit', ['index.html'], 'mensagem'], ['git:sync', 'pull'],
    ['gitlab:publish-plan', { commit: true }], ['gitlab:publish', 'plano-revisado'],
  ];
  for (const [channel, ...args] of operations) assert.match((await f.raw(channel, f.root, ...args)).error, /Salve os arquivos/);
  assert.deepEqual(invoked, []);
  assert.equal(f.context.hasDirtyFilesInProject(f.root), true);
  assert.equal(f.context.hasDirtyFilesInProject(f.other), false);
  await f.call('git:commit', f.other, ['index.html'], 'outro projeto');
  await f.call('git:branch-action', f.root, 'delete', 'old');
  await f.call('git:sync', f.root, 'push');
  ok(await f.call('visual:save', f.root, edited.doc.gen));
  for (const [channel, ...args] of operations) await f.call(channel, f.root, ...args);
  assert.equal(invoked.length, operations.length + 3);
});

test('visual sujo impede troca, reabertura, remoção e fechamento de projeto sem perder a sessão', async t => {
  const f = mainHandlers(t); await f.call('project:set-active', f.root);
  const initial = ok(await f.call('visual:open', f.root, 'index.html', { codeEditorDirty: false }));
  const edited = ok(await f.call('visual:apply', f.root, initial.doc.gen, operation));
  const token = f.sessions.byWindow(f.owner).token;
  for (const [channel, root] of [['project:set-active', f.other], ['project:activate', f.root],
    ['project:forget', f.root], ['project:close-sessions', f.root]]) {
    assert.match((await f.raw(channel, root)).error, /Salve ou descarte.*editor visual/);
    assert.equal(f.sessions.byToken(token)?.gen, edited.doc.gen);
    assert.equal(f.sessions.dirty(f.owner), true);
  }
  await f.call('project:set-active', f.root);
  await f.call('project:forget', f.other);
  assert.equal(f.events.some(event => event.channel === 'visual:event'), false);
  ok(await f.call('visual:save', f.root, edited.doc.gen));
  await f.call('project:close-sessions', f.root);
  assert.equal(f.sessions.byToken(token), null);
});

test('byToken no main evita projectInfo/existsSync repetidos e invalida ao mudar projeto ou geração', async t => {
  const f = mainHandlers(t); await f.call('project:set-active', f.root);
  const initial = ok(await f.call('visual:open', f.root, 'index.html', { codeEditorDirty: false }));
  const token = f.sessions.byWindow(f.owner).token;
  const info = t.mock.method(f.context, 'projectInfo'), exists = t.mock.method(fs, 'existsSync');
  const stat = t.mock.method(fs, 'lstatSync');
  for (let i = 0; i < 10; i++) assert.ok(f.sessions.byToken(token));
  assert.equal(info.mock.callCount(), 0); assert.equal(exists.mock.callCount(), 0);
  assert.equal(stat.mock.callCount(), 10);
  ok(await f.call('visual:apply', f.root, initial.doc.gen, operation));
  assert.ok(info.mock.callCount() > 0); assert.ok(exists.mock.callCount() > 0);
  const count = info.mock.callCount();
  for (let i = 0; i < 10; i++) assert.ok(f.sessions.byToken(token));
  assert.equal(info.mock.callCount(), count);
  // Lifecycle state must invalidate the cache even before another IPC arrives.
  f.context.rootForTest = f.root;
  vm.runInContext('pluginProjectGenerations.set(rootForTest, pluginProjectGenerations.get(rootForTest) + 1)', f.context);
  assert.equal(f.sessions.byToken(token), null);
  ok(await f.call('visual:open', f.root, 'index.html', { codeEditorDirty: false }));
  const next = f.sessions.byWindow(f.owner).token;
  f.context.otherForTest = f.other;
  vm.runInContext('activeProjectRoot = otherForTest', f.context);
  assert.equal(f.sessions.byToken(next), null);
});

function sessionsWithBridgeFs(overrides) {
  const filename = require.resolve('../electron/visual-session.cjs'), localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, Buffer, console, setTimeout, clearTimeout,
    __dirname: path.dirname(filename), require: name => name === 'node:fs' ? { ...fs, ...overrides } : localRequire(name) });
  return module.exports.VisualSessions;
}

for (const fault of ['stat', 'read', 'size', 'growth']) test(`ponte indisponível (${fault}) não derruba inicialização e registra no log`, async t => {
  let reads = 0;
  const Sessions = sessionsWithBridgeFs({
    statSync(file) {
      if (!file.endsWith('visual-bridge.js')) return fs.statSync(file);
      if (fault === 'stat') throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return { isFile: () => true, size: fault === 'size' ? 64 * 1024 + 1 : 64 * 1024 };
    },
    readFileSync(file) {
      reads++;
      if (fault === 'read') throw Object.assign(new Error(`EACCES: ${file}`), { code: 'EACCES' });
      return Buffer.alloc(64 * 1024 + 1);
    },
    openSync() { assert.fail('ponte no asar não usa openSync'); },
  });
  const f = mainHandlers(t, { Sessions });
  assert.ok(f.owner); assert.ok(f.protocols.has('dk-preview'));
  assert.equal(reads, fault === 'stat' || fault === 'size' ? 0 : 1);
  await f.call('project:set-active', f.root);
  for (const [, channel, ...args] of calls(f.root).slice(0, 7)) {
    const result = await f.call(channel, ...args);
    assert.equal(result.ok, false); assert.equal(result.reason, 'unavailable');
    assert.equal(result.message.includes(f.root), false);
  }
  assert.equal(f.logs.length, 1); assert.equal(f.logs[0][0], 'visual');
  assert.match(f.logs[0][1], /não foi possível carregar a ponte/);
  assert.equal(f.sessions.windows.size, 0);
});

test('ponte de 64 KiB usa stat antes de readFileSync, uma vez, sem openSync ou flags', async t => {
  const accessed = [];
  const Sessions = sessionsWithBridgeFs({
    statSync(file) {
      if (!file.endsWith('visual-bridge.js')) return fs.statSync(file);
      accessed.push('stat'); return { isFile: () => true, size: 64 * 1024 };
    },
    readFileSync(...args) {
      assert.equal(args.length, 1); assert.deepEqual(accessed, ['stat']);
      accessed.push('read'); return Buffer.alloc(64 * 1024, 32);
    },
    openSync() { assert.fail('ponte no asar não usa openSync'); },
  });
  const f = mainHandlers(t, { Sessions });
  await f.call('project:set-active', f.root);
  ok(await f.call('visual:open', f.root, 'index.html', { codeEditorDirty: false }));
  ok(await f.call('visual:reload', f.root));
  const second = new Sessions({ context: () => null }); second.closeAll();
  assert.deepEqual(accessed, ['stat', 'read']); assert.deepEqual(f.logs, []);
});

test('preload expõe nomes, argumentos, resultados discriminados e listeners independentes', async () => {
  const renderer = new EventEmitter(), invoked = []; let api;
  let result = { ok: true, doc: { gen: 0 }, state: { open: true } };
  renderer.invoke = async (...args) => { invoked.push(args); return { ok: true, value: result }; };
  vm.runInNewContext(read('electron/preload.cjs'), { require: name => {
    assert.equal(name, 'electron');
    return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'dk'); api = value; } } };
  } });
  for (const [name, , ...args] of calls('/projeto')) assert.equal(await api[name](...args), result);
  assert.deepEqual(plain(invoked), calls('/projeto').map(([, ...args]) => args));
  result = { ok: false, reason: 'FILE_CONFLICT', message: 'conflito' };
  assert.equal(await api.saveVisual('/projeto', 2), result, 'recusas visuais não viram exceções');
  const received = [], second = [], event = { type: 'revoked', reason: 'project-changed' };
  const off = api.onVisualEvent(value => received.push(value)), off2 = api.onVisualEvent(value => second.push(value));
  renderer.emit('visual:event', { private: true }, event); off(); off(); renderer.emit('visual:event', {}, event);
  assert.deepEqual(received, [event]); assert.deepEqual(second, [event, event]); off2();
  assert.equal(renderer.listenerCount('visual:event'), 0);
  renderer.invoke = async () => ({ ok: false, error: 'Origem não autorizada.' });
  await assert.rejects(api.openVisual('/projeto', 'index.html', { codeEditorDirty: false }), /Origem não autorizada/);
});

test('api.d.ts declara exatamente os tipos e assinaturas congelados do renderer', () => {
  const file = read('src/api.d.ts');
  assert.doesNotThrow(() => stripTypeScriptTypes(file));
  const normalize = value => value.replace(/\s+/g, '');
  const declarations = new Map([...file.matchAll(/^(?:type|interface) (Visual\w+)[^\n]*$/gm)].map(m => [m[1], normalize(m[0])]));
  for (const definition of [
    'type VisualReason = string;',
    "interface VisualDocInfo { url: string; gen: number; chan: string; nodes: number; warnings: string[]; scripts: number; handlers: number; eol: 'lf'|'crlf'|'mixed'|'none'; loneCR: boolean }",
    'interface VisualState { open: boolean; relative: string | null; dirty: boolean; canUndo: boolean; canRedo: boolean; truncated: boolean; gen: number | null }',
    'type VisualResult<T> = ({ ok: true } & T) | { ok: false; reason: VisualReason; message: string };',
    'interface VisualInspect { tag: string; text: string | null; attrs: Record<string,string>; style: Record<string,string>; can: { text: boolean; attrs: string[]; css: boolean }; reasons: string[]; readonly: string | null }',
    "type VisualOp = { type: 'text'; node: number; value: string } | { type: 'attr'; node: number; name: string; value: string | null } | { type: 'css'; node: number; prop: string; value: string | null };",
  ]) assert.equal(declarations.get(definition.match(/(?:type|interface) (\w+)/)[1]), normalize(definition));
  const window = file.slice(file.indexOf('interface Window {'));
  const methods = new Map([...window.matchAll(/^    (\w+)\([^\n]*$/gm)].map(m => [m[1], normalize(m[0])]));
  for (const signature of [
    'openVisual(root: string, relative: string, options: { codeEditorDirty: boolean }): Promise<VisualResult<{ doc: VisualDocInfo; state: VisualState }>>;',
    'inspectVisual(root: string, gen: number, node: number): Promise<VisualResult<{ inspect: VisualInspect }>>;',
    'applyVisual(root: string, gen: number, op: VisualOp): Promise<VisualResult<{ doc: VisualDocInfo; state: VisualState }>>;',
    'undoVisual(root: string, gen: number): Promise<VisualResult<{ doc: VisualDocInfo; state: VisualState }>>;',
    'redoVisual(root: string, gen: number): Promise<VisualResult<{ doc: VisualDocInfo; state: VisualState }>>;',
    'saveVisual(root: string, gen: number): Promise<VisualResult<{ state: VisualState; revision: string }>>;',
    'reloadVisual(root: string): Promise<VisualResult<{ doc: VisualDocInfo; state: VisualState }>>;',
    'closeVisual(root: string): Promise<{ ok: true }>;', 'visualState(root: string): Promise<VisualState>;',
    "onVisualEvent(callback: (event: { type: 'revoked'; reason: string }) => void): () => void;",
  ]) assert.equal(methods.get(signature.slice(0, signature.indexOf('('))), normalize(signature));
});
