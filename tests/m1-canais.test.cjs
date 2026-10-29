const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { projectInfo, kitInfo } = require('../electron/core.cjs');
const { Extensions } = require('../electron/extensions.cjs');
const { Catalogs } = require('../electron/catalogs.cjs');
const { Stages } = require('../electron/stages.cjs');

function sourceFunction(source, name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\)[^{\\n]*\\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `Função ${name} não encontrada`);
  return match[0];
}

// Same VM approach as plugins.test.cjs, also running the real handle/authorize
// wrapper, constructor wiring and cleanup callbacks. No Electron or processes.
function mainHandlers(t) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-m1-ipc-')));
  const root = path.join(base, 'project'), other = path.join(base, 'other'), installedKit = path.join(base, 'installed-kit');
  for (const dir of [root, other, path.join(base, 'app', 'extensions'), path.join(base, 'user', 'extensions')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'projeto.yml'), 'schema: 2\ncliente: Teste\nprojeto: Canais\nslug: canais\nentregaveis: []\nregistros: {}\npastas: {}\n');
  fs.cpSync(path.join(__dirname, 'fixtures/stages/kit-minimo'), installedKit, { recursive: true });
  const plugin = path.join(root, '.dk', 'plugins', 'example');
  fs.mkdirSync(path.join(plugin, 'skills', 'hello'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills', 'hello', 'SKILL.md'), '---\nname: Hello\n---\nCorpo do plugin.\n');
  fs.writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({ schema: 2, id: 'example', name: 'Exemplo', version: '1.0.0',
    contributes: { catalogs: [{ id: 'skills', title: 'Skills', source: 'plugin', kind: 'skills', path: 'skills' }] } }));
  const handlers = new Map(), events = [], webContents = new EventEmitter(), window = new EventEmitter(), app = new EventEmitter();
  Object.assign(webContents, { mainFrame: { url: 'dk-app://app/index.html' }, send: (channel, payload) => events.push({ channel, payload }) });
  Object.assign(window, { webContents, isDestroyed: () => false });
  Object.assign(app, { getAppPath: () => path.join(base, 'app'), getPath: () => path.join(base, 'user'), getVersion: () => 'test' });
  const context = vm.createContext({
    fs, path, projectInfo, kitInfo, Catalogs, Stages, Extensions, app, window, process: { platform: process.platform },
    env: { PATH: path.join(base, 'decoy-bin') }, kit: kitInfo(installedKit), agentGuide: null,
    config: { projects: [] }, startupProject: null, save() {},
    windowClosing: false, windowCleanupDone: false, dirtyFiles: [], focusRequested: false, quitRequested: false,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    debugLog: { write() {}, event() {} },
    terminals: { async closeProject() { return { closed: 1, partial: false }; }, closeAll() {}, async closeAllAndWait() {} },
    codexChat: { async closeProject() { return 0; }, async closeAll() {} },
    async closeProjectBrowser() { return { partial: false }; },
    previewBridge: { revoke() {}, revokeAll() {}, close() {} }, filePreviews: { closeAll() {} },
    services: { closeAll() {} }, orchestration: { close() {} }, usage: { close() {} },
    preview: { async closeAll() {}, setVisible() {} }, browserFullscreen: { dispose() {}, async set() {} },
    actions: { closeAll() {}, run: (action, info, kit) => ({ action, root: info.path, kit }) },
    pluginMonitor: { invalidate() {} },
    async installClaudePlugin() { return { status: 'installed', kit: { path: installedKit } }; },
    async updateClaudePlugin() { return { status: 'installed', kit: { path: installedKit } }; },
  });
  const state = source.slice(source.indexOf('const selected ='), source.indexOf('let kit ='));
  const names = ['send', 'authorize', 'handle', 'project', 'advancePluginGeneration', 'rememberPluginIdentity', 'remember', 'knownProject', 'pluginProject', 'bootstrap', 'registerHandlers'];
  const constructors = source.slice(source.indexOf('  catalogs = new Catalogs('), source.indexOf('  registerHandlers(); menu(); createWindow();'));
  assert.ok(constructors.includes('extensions = new Extensions('));
  vm.runInContext(`${state}\n${names.map(name => sourceFunction(source, name)).join('\n')}\n${constructors}\nregisterHandlers();`, context);
  const hosts = vm.runInContext('({ catalogs, stages, extensions })', context);
  const rendererCleanup = source.slice(source.indexOf("  window.webContents.on('render-process-gone', () => {"), source.indexOf("  window.webContents.on('render-process-gone', (_event, details)"));
  const windowCleanup = source.slice(source.indexOf("  window.on('closed', () => {"), source.indexOf("  window.loadURL('dk-app://app/index.html');"));
  const quitCleanup = source.match(/^app.on\('will-quit', \(\) => \{ filePreviews.*$/m);
  assert.ok(rendererCleanup && windowCleanup && quitCleanup);
  vm.runInContext(`${rendererCleanup}\n${windowCleanup}\n${quitCleanup[0]}`, context);
  t.after(() => { for (const host of Object.values(hosts)) host.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const invoke = (event, channel, ...args) => handlers.get(channel)(event, ...args);
  const call = (channel, ...args) => invoke(event, channel, ...args);
  return { base, root, other, installedKit, context, hosts, events, event, call, invoke };
}

const channels = root => [
  ['catalog:list', root], ['catalog:read', root, 'kit-skills', 'dk-entender'],
  ['stages:read', root], ['stages:stop-watching'],
];
async function prime(f) {
  f.context.remember(f.root);
  for (const channel of ['catalog:list', 'stages:read']) {
    const result = await f.call(channel, f.root);
    assert.equal(result.ok, true, result.error);
  }
}

test('barra de etapas rejeita projeto inativo e ação em andamento sem executar ações', async t => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const runDkAction = t.mock.fn(async () => 'executada'), directAction = t.mock.fn();
  const context = vm.createContext({
    $() {}, createStageBar: (_host, callbacks) => callbacks, notify() {},
    api: { runAction: directAction }, current: { path: '/ativo' }, runningActions: new Set(), runDkAction,
  });
  vm.runInContext(source.slice(source.indexOf('const stageBar ='), source.indexOf('\nconst catalogPanel =')), context);
  const { runAction } = vm.runInContext('stageBar', context);
  await assert.rejects(runAction('/outro', 'audit'), { message: 'O projeto não está ativo.' });
  context.current = null;
  await assert.rejects(runAction('/ativo', 'audit'), { message: 'O projeto não está ativo.' });
  context.current = { path: '/ativo' };
  context.runningActions.add('/ativo');
  await assert.rejects(runAction('/ativo', 'audit'), { message: 'Aguarde a ação em andamento.' });
  assert.equal(runDkAction.mock.callCount(), 0);
  assert.equal(directAction.mock.callCount(), 0);
  context.runningActions.clear();
  assert.equal(await runAction('/ativo', 'audit'), 'executada');
  assert.deepEqual([...runDkAction.mock.calls[0].arguments], ['audit']);
});

test('M1 autoriza todos os canais somente para o frame principal da janela', async t => {
  const f = mainHandlers(t);
  const list = t.mock.method(f.hosts.catalogs, 'list'), read = t.mock.method(f.hosts.stages, 'read');
  const close = t.mock.method(f.hosts.catalogs, 'close');
  for (const event of [
    { sender: {}, senderFrame: f.event.senderFrame },
    { sender: f.event.sender, senderFrame: { url: 'dk-app://app/index.html' } },
  ]) for (const args of channels(f.root)) {
    const result = await f.invoke(event, ...args);
    assert.equal(result.ok, false); assert.match(result.error, /Origem não autorizada/);
  }
  f.event.senderFrame.url = 'https://example.com/';
  for (const args of channels(f.root)) assert.match((await f.call(...args)).error, /Origem não autorizada/);
  assert.equal(list.mock.callCount(), 0); assert.equal(read.mock.callCount(), 0); assert.equal(close.mock.callCount(), 0);
});

test('M1 recusa raízes não abertas antes de chamar os módulos', async t => {
  const f = mainHandlers(t), plugins = t.mock.method(f.hosts.extensions, 'listPlugins');
  const stages = t.mock.method(f.hosts.stages, 'read'), catalog = t.mock.method(f.hosts.catalogs, 'read');
  for (const args of channels(f.other).slice(0, 3)) {
    const result = await f.call(...args);
    assert.equal(result.ok, false); assert.match(result.error, /seletor de projetos/);
  }
  assert.equal(plugins.mock.callCount(), 0); assert.equal(stages.mock.callCount(), 0); assert.equal(catalog.mock.callCount(), 0);
});

test('M1 recusa pasta substituída pela identidade dev/ino do M0', async t => {
  const f = mainHandlers(t); f.context.remember(f.root);
  fs.renameSync(f.root, `${f.root}-original`); fs.mkdirSync(f.root);
  for (const args of channels(f.root).slice(0, 3)) {
    const result = await f.call(...args);
    assert.equal(result.ok, false); assert.match(result.error, /pasta do projeto mudou/);
  }
  assert.equal(f.hosts.catalogs.cache, null); assert.equal(f.hosts.stages.cache, null);
});

test('catalog:read valida regex e limites dos IDs antes de qualquer acesso ao disco', async t => {
  const f = mainHandlers(t); f.context.remember(f.root);
  const spies = [];
  for (const [object, names] of [[fs, ['realpathSync', 'statSync', 'lstatSync', 'readFileSync']], [fs.promises, ['realpath', 'stat', 'lstat', 'open', 'opendir', 'readFile']]]) {
    for (const name of names) spies.push(t.mock.method(object, name, () => { throw new Error('Acesso ao disco proibido neste teste'); }));
  }
  const invalid = [null, 5, {}, '', '../escape', 'a/b', 'A', 'a\0b', 'a\nb', 'a\n', 'a'.repeat(65)];
  for (const catalogId of [...invalid, 'kit-skills\n', 'plugin:../skills', `plugin:${'a'.repeat(64)}/${'b'.repeat(64)}`]) {
    const result = await f.call('catalog:read', f.root, catalogId, 'dk-entender');
    assert.equal(result.ok, false); assert.equal(result.error, 'Catálogo não encontrado.');
  }
  for (const entryId of invalid) {
    const result = await f.call('catalog:read', f.root, 'kit-skills', entryId);
    assert.equal(result.ok, false); assert.equal(result.error, 'Item do catálogo não encontrado.');
  }
  for (const spy of spies) { assert.equal(spy.mock.callCount(), 0); spy.mock.restore(); }
});

test('canais usam o kit instalado, identidade autorizada e registros de Extensions', async t => {
  const f = mainHandlers(t); f.context.remember(f.root);
  const pluginList = t.mock.method(f.hosts.extensions, 'listPlugins');
  const catalogList = t.mock.method(f.hosts.catalogs, 'list'), stageRead = t.mock.method(f.hosts.stages, 'read');
  const listed = await f.call('catalog:list', f.root, true);
  assert.equal(listed.ok, true, listed.error);
  assert.equal(listed.value.kit.path, f.installedKit);
  assert.ok(listed.value.catalogs.some(item => item.id === 'plugin:example/skills'));
  assert.equal(pluginList.mock.calls[0].arguments[1], vm.runInContext('pluginProjectIdentities', f.context).get(f.root));
  assert.equal(catalogList.mock.calls[0].arguments[1].plugins, f.hosts.extensions.records);
  assert.equal(catalogList.mock.calls[0].arguments[1].kit.cli, path.join(f.installedKit, 'cli', 'dk'));
  assert.equal(catalogList.mock.calls[0].arguments[1].refresh, true);
  const read = await f.call('catalog:read', f.root, 'plugin:example/skills', 'hello');
  assert.equal(read.ok, true, read.error); assert.equal(read.value.text, 'Corpo do plugin.\n');
  const stages = await f.call('stages:read', f.root, true);
  assert.equal(stages.ok, true, stages.error); assert.equal(stages.value.kit.path, f.installedKit);
  assert.deepEqual({ ...stageRead.mock.calls[0].arguments[1] }, { kitPath: f.installedKit, refresh: true });
  const action = await f.call('action:run', f.root, 'entender');
  assert.equal(action.ok, true); assert.equal(action.value.action, 'entender');
  assert.equal(action.value.kit.cli, path.join(f.installedKit, 'cli', 'dk'));
});

for (const channel of ['catalog:list', 'catalog:read', 'stages:read']) test(`${channel} resolve projeto e kit uma vez por requisição`, async t => {
  const f = mainHandlers(t); f.context.remember(f.root);
  const project = t.mock.method(f.context, 'projectInfo'), kit = t.mock.method(f.context, 'kitInfo');
  const stat = t.mock.method(fs.promises, 'lstat');
  const result = await f.call(channel, f.root, ...(channel === 'catalog:read' ? ['kit-skills', 'dk-entender'] : []));
  assert.equal(result.ok, true, result.error);
  assert.equal(project.mock.callCount(), 1);
  assert.equal(kit.mock.callCount(), 1);
  assert.ok(stat.mock.calls.some(call => call.arguments[0] === f.root), 'revalida identidade de forma assíncrona');
});

test('refresh aceita somente booleano e kit ausente não usa dk do PATH', async t => {
  const f = mainHandlers(t); f.context.remember(f.root);
  for (const channel of ['catalog:list', 'stages:read']) for (const refresh of [null, 1, 'true', {}]) {
    const result = await f.call(channel, f.root, refresh);
    assert.equal(result.ok, false); assert.match(result.error, /atualização inválida/);
  }
  const bin = f.context.env.PATH; fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'dk'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  f.context.kit = null;
  for (const channel of ['catalog:list', 'stages:read']) {
    const result = await f.call(channel, f.root);
    assert.equal(result.ok, true, result.error); assert.equal(result.value.kit, null);
    const motivos = (result.value.stages || []).flatMap(stage => stage.criterios.map(c => c.motivo));
    if (channel === 'catalog:list') assert.match(result.value.errors.join(' '), /Plugin DK não instalado/);
    else assert.ok(!motivos.some(m => /dk do PATH|exit 99/.test(m)), 'etapas não podem usar dk do PATH');
  }
});

for (const removed of ['cli/dk', '.']) test(`kit com ${removed} removido preserva catálogos e critérios sem kit`, async t => {
  const f = mainHandlers(t);
  fs.cpSync(path.join(__dirname, 'fixtures/stages/v2'), f.root, { recursive: true });
  f.context.remember(f.root);
  const installed = f.context.kit;
  f.context.kit = null;
  const withoutKit = await f.call('stages:read', f.root);
  assert.equal(withoutKit.ok, true, withoutKit.error);
  f.context.kit = installed;
  fs.rmSync(path.join(f.installedKit, removed), { recursive: true });
  const catalogList = t.mock.method(f.hosts.catalogs, 'list'), stageRead = t.mock.method(f.hosts.stages, 'read');
  const reason = removed === '.' ? /ENOENT/ : /Não encontrei cli\/dk/;
  for (const channel of ['catalog:list', 'stages:read']) {
    const result = await f.call(channel, f.root);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.value.kit, null);
    assert.match(result.value.errors.join(' '), reason);
    assert.match(result.value.errors.join(' '), /Plugin DK não instalado/);
    if (channel === 'catalog:list') assert.ok(result.value.catalogs.some(c => c.id === 'plugin:example/skills'));
    else {
      assert.deepEqual(result.value.stages, withoutKit.value.stages);
      const criteria = Object.fromEntries(result.value.stages.flatMap(s => s.criterios.map(c => [c.id, c])));
      assert.equal(criteria.L1.estado, 'concluido');
      assert.equal(criteria.L2.estado, 'concluido');
      assert.equal(criteria.L4.estado, 'indisponivel');
    }
  }
  assert.equal(catalogList.mock.calls[0].arguments[1].kit, null);
  assert.equal(stageRead.mock.calls[0].arguments[1].kitPath, null);
  assert.ok(!withoutKit.value.errors.some(error => reason.test(error)), 'não altera snapshot em cache com diagnóstico da requisição');
});

test('eventos chegam à janela e plugin:changed invalida só o catálogo da raiz correspondente', async t => {
  const f = mainHandlers(t);
  // Exercise the callback/debounce wiring without delayed OS fixture events.
  t.mock.method(fs, 'watch', () => Object.assign(new EventEmitter(), { close() {} }));
  await prime(f);
  f.hosts.stages.onChange({ path: f.root });
  assert.equal(f.events.at(-1).channel, 'stages:changed'); assert.equal(f.events.at(-1).payload.path, f.root);
  f.hosts.extensions.onChange({ path: f.other });
  assert.equal(f.hosts.catalogs.dirty, false);
  f.hosts.extensions.onChange({ path: f.root }); f.hosts.extensions.onChange({ path: f.root });
  assert.equal(f.hosts.catalogs.dirty, true);
  assert.equal(f.events.at(-1).channel, 'plugin:changed');
  await delay(500);
  const changed = f.events.filter(event => event.channel === 'catalog:changed');
  assert.equal(changed.length, 1); assert.equal(changed[0].payload.path, f.root);
});

for (const channel of ['project:forget', 'project:close-sessions']) test(`${channel} fecha os dois módulos e revoga a leitura`, async t => {
  const f = mainHandlers(t); await prime(f);
  const closes = Object.values(f.hosts).map(host => t.mock.method(host, 'closeProject'));
  const result = await f.call(channel, f.root);
  assert.equal(result.ok, true, result.error);
  for (const spy of closes) assert.equal(spy.mock.calls[0].arguments[0], f.root);
  for (const host of Object.values(f.hosts)) { assert.equal(host.cache ?? null, null); assert.equal(host.watchers.length, 0); }
  for (const args of channels(f.root).slice(0, 3)) assert.match((await f.call(...args)).error, /Abra o projeto/);
});

for (const channel of ['kit:plugin-install', 'kit:plugin-update']) test(`${channel} invalida catálogos e etapas inclusive se falhar`, async t => {
  const f = mainHandlers(t); await prime(f);
  assert.equal((await f.call(channel, f.root)).ok, true);
  for (const host of [f.hosts.catalogs, f.hosts.stages]) { assert.equal(host.cache, null); assert.equal(host.watchers.length, 0); }
  await prime(f);
  f.context[channel === 'kit:plugin-install' ? 'installClaudePlugin' : 'updateClaudePlugin'] = async () => { throw new Error('Falha simulada'); };
  assert.match((await f.call(channel, f.root)).error, /Falha simulada/);
  for (const host of [f.hosts.catalogs, f.hosts.stages]) { assert.equal(host.cache, null); assert.equal(host.watchers.length, 0); }
});

test('stages:stop-watching limpa os dois módulos e impede reinício de leitura pendente', async t => {
  const f = mainHandlers(t); await prime(f);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(f.hosts.extensions, 'listPlugins', () => gate);
  const pending = f.call('catalog:list', f.root);
  assert.equal((await f.call('stages:stop-watching')).ok, true);
  release();
  assert.equal((await pending).ok, false);
  for (const host of [f.hosts.catalogs, f.hosts.stages]) { assert.equal(host.cache, null); assert.equal(host.watchers.length, 0); }
});

for (const channel of ['catalog:list', 'catalog:read', 'stages:read']) test(`${channel} revalida a identidade depois de uma leitura assíncrona`, async t => {
  const f = mainHandlers(t); f.context.remember(f.root);
  let release, started;
  const reading = new Promise(resolve => { started = resolve; });
  const host = channel === 'stages:read' ? f.hosts.stages : f.hosts.catalogs;
  t.mock.method(host, channel === 'catalog:list' ? 'list' : 'read', () => new Promise(resolve => { release = resolve; started(); }));
  const pending = f.call(channel, f.root, ...(channel === 'catalog:read' ? ['kit-skills', 'dk-entender'] : []));
  await reading;
  fs.renameSync(f.root, `${f.root}-original`); fs.mkdirSync(f.root);
  release({ root: f.root });
  assert.match((await pending).error, /pasta do projeto mudou/);
});

test('catalog:read revalida identidade após Extensions antes de iniciar o catálogo', async t => {
  const f = mainHandlers(t); f.context.remember(f.root);
  let release;
  t.mock.method(f.hosts.extensions, 'listPlugins', () => new Promise(resolve => { release = resolve; }));
  const list = t.mock.method(f.hosts.catalogs, 'list'), read = t.mock.method(f.hosts.catalogs, 'read');
  const pending = f.call('catalog:read', f.root, 'kit-skills', 'dk-entender');
  fs.renameSync(f.root, `${f.root}-original`); fs.mkdirSync(f.root);
  release();
  assert.match((await pending).error, /pasta do projeto mudou/);
  assert.equal(list.mock.callCount(), 0); assert.equal(read.mock.callCount(), 0);
});

for (const change of [
  'advancePluginGeneration(root)',
  'closingProjects.add(root)',
  'closedPluginProjects.add(root)',
  'windowClosing = true',
  'window = { isDestroyed: () => false }',
]) test(`revalida autorização também durante stat assíncrono: ${change}`, async t => {
  const f = mainHandlers(t); f.context.remember(f.root);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const checking = new Promise(resolve => { started = resolve; });
  const stat = fs.promises.lstat;
  t.mock.method(fs.promises, 'lstat', async (...args) => {
    const actual = await stat(...args);
    if (args[0] === f.root) { started(); await gate; }
    return actual;
  });
  t.mock.method(f.hosts.stages, 'read', async () => ({ root: f.root }));
  const pending = f.call('stages:read', f.root);
  await checking;
  f.context.root = f.root;
  vm.runInContext(change, f.context);
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /projeto ou a janela mudou|Abra o projeto/);
});

for (const event of ['closed', 'render-process-gone', 'will-quit']) test(`${event} encerra catálogos e etapas`, async t => {
  const f = mainHandlers(t); await prime(f);
  const closes = [f.hosts.catalogs, f.hosts.stages].map(host => t.mock.method(host, 'close'));
  const owner = event === 'closed' ? f.context.window : event === 'will-quit' ? f.context.app : f.context.window.webContents;
  owner.emit(event);
  for (const spy of closes) assert.equal(spy.mock.callCount(), 1);
  for (const host of [f.hosts.catalogs, f.hosts.stages]) { assert.equal(host.activeRoot, null); assert.equal(host.cache, null); assert.equal(host.watchers.length, 0); }
});

test('preload expõe canais, defaults, erros do envelope e unsubscribe dos eventos M1', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');
  const renderer = new EventEmitter(), calls = [];
  renderer.invoke = async (...args) => { calls.push(args); return { ok: true, value: 'resultado' }; };
  let api;
  vm.runInNewContext(source, { require: name => {
    assert.equal(name, 'electron');
    return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'dk'); api = value; } } };
  } });
  assert.equal(await api.listCatalog('/projeto'), 'resultado');
  await api.listCatalog('/projeto', true); await api.readCatalogEntry('/projeto', 'kit-skills', 'dk-entender');
  await api.readStages('/projeto'); await api.readStages('/projeto', true); await api.stopWatchingStages();
  assert.deepEqual(calls, [
    ['catalog:list', '/projeto', false], ['catalog:list', '/projeto', true], ['catalog:read', '/projeto', 'kit-skills', 'dk-entender'],
    ['stages:read', '/projeto', false], ['stages:read', '/projeto', true], ['stages:stop-watching'],
  ]);
  for (const [method, channel] of [['onCatalogChanged', 'catalog:changed'], ['onStagesChanged', 'stages:changed']]) {
    const received = [], payload = { path: '/projeto' }, stop = api[method](data => received.push(data));
    renderer.emit(channel, {}, payload); stop(); renderer.emit(channel, {}, payload);
    assert.deepEqual(received, [payload]); assert.equal(renderer.listenerCount(channel), 0);
  }
  renderer.invoke = async () => ({ ok: false, error: 'Origem não autorizada.' });
  await assert.rejects(api.readStages('/projeto'), /Origem não autorizada/);
});
