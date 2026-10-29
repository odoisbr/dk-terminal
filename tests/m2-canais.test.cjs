const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { stripTypeScriptTypes } = require('node:module');
const { projectInfo, kitInfo } = require('../electron/core.cjs');
const { Extensions } = require('../electron/extensions.cjs');
const { Catalogs } = require('../electron/catalogs.cjs');
const { Stages } = require('../electron/stages.cjs');
const { AgentRun } = require('../electron/agent-run.cjs');
const { CodexChat } = require('../electron/codex-chat.cjs');
const { readGuide, agentGuideEnvironment } = require('../electron/agent-guide.cjs');

function sourceFunction(source, name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\)[^{\\n]*\\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `Função ${name} não encontrada`);
  return match[0];
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Real IPC wrappers, createWindow, M1 sources and runner composition in a VM.
// Probes and draining are replaced unless a test installs an isolated fake CLI.
// No Electron or official CLI is used.
async function mainHandlers(t) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-m2-ipc-')));
  const root = path.join(base, 'project'), other = path.join(base, 'other'), installedKit = path.join(base, 'kit');
  for (const dir of [root, other, path.join(base, 'app', 'extensions'), path.join(base, 'user', 'extensions')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'projeto.yml'), 'schema: 2\ncliente: Teste\nprojeto: Canais\nslug: canais\nentregaveis: []\nregistros: {}\npastas: {}\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Instruções do projeto.\n');
  fs.cpSync(path.join(__dirname, 'fixtures/stages/kit-minimo'), installedKit, { recursive: true });
  const plugin = path.join(root, '.dk', 'plugins', 'example');
  fs.mkdirSync(path.join(plugin, 'skills', 'hello'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills', 'hello', 'SKILL.md'), '---\nname: Hello\n---\nCorpo do plugin.\n');
  fs.writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({ schema: 2, id: 'example', name: 'Exemplo', version: '1.0.0',
    contributes: { catalogs: [{ id: 'skills', title: 'Skills', source: 'plugin', kind: 'skills', path: 'skills' }] } }));
  const handlers = new Map(), events = [], closedRoots = [], warnings = [], app = new EventEmitter();
  const windowClosed = deferred();
  class FakeWindow extends EventEmitter {
    constructor() {
      super(); this.webContents = new EventEmitter(); this.destroyed = false;
      Object.assign(this.webContents, {
        mainFrame: { url: 'dk-app://app/index.html' }, send: (channel, payload) => events.push({ channel, payload }),
        setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      });
    }
    isDestroyed() { return this.destroyed; }
    setEnabled() {}
    loadURL() {}
    close() { this.destroyed = true; this.emit('closed'); windowClosed.resolve(); }
  }
  class FakeChat {
    constructor(options) { Object.assign(this, options); this.closed = false; }
    async closeProject(root) { closedRoots.push(['chat', root]); return 1; }
    async cancelAll() { return { partial: false }; }
    async closeAll() { this.closed = true; return { partial: false }; }
    resourceRoots() { return []; }
  }
  const context = vm.createContext({
    fs, path, projectInfo, kitInfo, Catalogs, Stages, Extensions, AgentRun, CodexChat: FakeChat, app,
    BrowserWindow: FakeWindow, BrowserFullscreen: class { dispose() {} async set() {} }, windowIcon() {},
    ResourceMonitor: class { constructor(metrics, options) { this.options = options; } },
    __dirname: path.join(__dirname, '../electron'), process: { platform: process.platform },
    env: { PATH: path.join(base, 'decoy-bin') }, kit: kitInfo(installedKit),
    agentGuide: path.join(__dirname, '../dock-tools/agents/AGENTS.md'), readGuide, agentGuideEnvironment, codexConfigHasInstructions: () => false,
    config: { projects: [] }, startupProject: null, save() {}, window: null,
    windowClosing: false, windowCleanupDone: false, dirtyFiles: [], focusRequested: false, quitRequested: false,
    allowClose: false, closePrompt: false, pendingFiles: [],
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    debugLog: { write() {}, event() {}, error() {} },
    dialog: { async showMessageBox(_window, options) { warnings.push(options); return { response: 0 }; } },
    terminals: { async closeProject(root) { closedRoots.push(['terminal', root]); return { closed: 2, partial: false }; }, closeAll() {}, async closeAllAndWait() { return { partial: false }; }, resourceRoots() { return []; } },
    async closeProjectBrowser(root) { closedRoots.push(['browser', root]); return { partial: false }; },
    previewBridge: { revoke() {}, revokeAll() {}, close() {}, environment: root => ({ DK_PREVIEW: root }) },
    filePreviews: { closeAll() {} }, services: { closeAll() {} }, orchestration: { close() {} }, usage: { close() {} },
    preview: { async closeAll() { return { partial: false }; }, setVisible() {} },
    actions: { closeAll() {}, async closeAllAndWait() { return { partial: false }; } },
    integrations: {}, localRepositories: {}, environmentRefreshing: false, environmentRefreshAt: 0,
    detectedEnvironment: env => env, async loginEnvironment() { return { PATH: '/refreshed' }; },
  });
  Object.assign(app, { getAppPath: () => path.join(base, 'app'), getPath: () => path.join(base, 'user'), getVersion: () => 'test', getAppMetrics: () => [] });
  const state = source.slice(source.indexOf('const selected ='), source.indexOf('let kit ='));
  const names = ['send', 'authorize', 'handle', 'project', 'advancePluginGeneration', 'rememberPluginIdentity', 'remember', 'knownProject', 'pluginProject', 'bootstrap', 'applyEnvironment', 'refreshEnvironment', 'registerHandlers', 'createWindow'];
  const constructors = source.slice(source.indexOf('  agentRun = new AgentRun('), source.indexOf('  registerHandlers(); menu(); createWindow();'));
  const quitCleanup = source.match(/^app.on\('will-quit', \(\) => \{ filePreviews.*$/m);
  assert.ok(quitCleanup);
  vm.runInContext(`${state}\n${names.map(name => sourceFunction(source, name)).join('\n')}\n${constructors}\nregisterHandlers(); createWindow();\n${quitCleanup[0]}`, context);
  const hosts = vm.runInContext('({ catalogs, stages, extensions, agentRun, codexChat })', context);
  t.mock.method(hosts.agentRun, 'capabilities', async () => ({ claude: { disponivel: true, binario: '/fake/claude', aprovacao_host_provada: false }, codex: { disponivel: false, motivo: 'Use o painel Codex' } }));
  t.mock.method(hosts.agentRun, '_drain', () => {});
  await hosts.agentRun.ready;
  t.after(async () => {
    await hosts.agentRun.closeAll();
    for (const host of [hosts.catalogs, hosts.stages, hosts.extensions]) host.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const owner = context.window, event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame };
  const invoke = (event, channel, ...args) => {
    assert.ok(handlers.has(channel), `Canal ${channel} não registrado`);
    return handlers.get(channel)(event, ...args);
  };
  const call = (channel, ...args) => invoke(event, channel, ...args);
  return { base, root, other, installedKit, context, hosts, owner, event, events, closedRoots, warnings, windowClosed, call, invoke };
}
const options = { provider: 'claude', prompt: 'Teste de IPC.' };
const channels = root => [
  ['agent:capabilities', root], ['agent:list', root], ['agent:read', root, 'run'], ['agent:start', root, options],
  ['agent:cancel', root, 'run'], ['agent:approve', root, 'run', 'request', 'allow'], ['agent:prompt-preview', root, {}],
];
async function start(f, root = f.root) {
  f.context.remember(root);
  const result = await f.call('agent:start', root, options);
  assert.equal(result.ok, true, result.error);
  return result.value.runId;
}

test('M2 autoriza todos os canais somente para o frame principal da janela', async t => {
  const f = await mainHandlers(t);
  for (const event of [
    { sender: {}, senderFrame: f.event.senderFrame },
    { sender: f.event.sender, senderFrame: { url: 'dk-app://app/index.html' } },
  ]) for (const args of channels(f.root)) assert.match((await f.invoke(event, ...args)).error, /Origem não autorizada/);
  f.event.senderFrame.url = 'https://example.com/';
  for (const args of channels(f.root)) assert.match((await f.call(...args)).error, /Origem não autorizada/);
  assert.equal(f.hosts.agentRun.runs.size, 0);
  assert.equal(f.hosts.agentRun.capabilities.mock.callCount(), 0);
});

test('M2 recusa raiz não aberta e identidade dev/ino divergente em todos os canais', async t => {
  const f = await mainHandlers(t);
  for (const args of channels(f.root)) assert.match((await f.call(...args)).error, /seletor de projetos/);
  f.context.remember(f.root);
  fs.renameSync(f.root, `${f.root}-original`); fs.mkdirSync(f.root);
  for (const args of channels(f.root)) assert.match((await f.call(...args)).error, /pasta do projeto mudou/);
  assert.equal(f.hosts.agentRun.capabilities.mock.callCount(), 0);
  assert.equal(f.hosts.agentRun.runs.size, 0);
});

test('M2 recusa raiz canônica transformada em symlink até para o mesmo inode', async t => {
  const f = await mainHandlers(t); f.context.remember(f.root);
  const lstat = fs.promises.lstat;
  t.mock.method(fs.promises, 'lstat', async target => target === f.root ? { isDirectory: () => false } : lstat(target));
  for (const args of channels(f.root)) assert.match((await f.call(...args)).error, /pasta do projeto mudou/);
  assert.equal(f.hosts.agentRun.capabilities.mock.callCount(), 0);
});

test('inicialização e createWindow conectam stores privados, env, guia, fontes M1 e agent:event', async t => {
  const f = await mainHandlers(t), runner = f.hosts.agentRun;
  assert.equal(runner.storeFile, path.join(f.base, 'user', 'agent-runs.json'));
  assert.equal(runner.runsDir, path.join(f.base, 'user', 'agent-runs'));
  assert.equal(runner.env, f.hosts.codexChat.env);
  assert.deepEqual({ ...runner.previewEnvironment(f.root) }, { ...f.hosts.codexChat.previewEnvironment(f.root) });
  assert.equal(runner.sources.guide, f.context.agentGuide);
  f.context.remember(f.root);
  const plugins = t.mock.method(f.hosts.extensions, 'listPlugins'), catalog = t.mock.method(f.hosts.catalogs, 'list'), stages = t.mock.method(f.hosts.stages, 'read');
  const preview = await f.call('agent:prompt-preview', f.root, { skillId: 'plugin:example/skills/hello' });
  assert.equal(preview.ok, true, preview.error);
  assert.match(preview.value.text, /Corpo do plugin/);
  assert.match(preview.value.text, /Instruções do projeto/);
  assert.equal(plugins.mock.calls[0].arguments[1], vm.runInContext('pluginProjectIdentities', f.context).get(f.root));
  assert.equal(catalog.mock.calls[0].arguments[1].kit.path, f.installedKit);
  assert.equal(stages.mock.calls[0].arguments[1].kitPath, f.installedKit);
  assert.equal(runner.runs.size, 0, 'preview não inicia execução');
  const runId = await start(f);
  assert.ok(f.events.some(e => e.channel === 'agent:event' && e.payload.runId === runId && e.payload.root === f.root));
  assert.equal((await f.call('agent:list', f.root)).value[0].runId, runId);
  assert.equal((await f.call('agent:read', f.root, runId)).value.run.root, f.root);
  assert.equal((await f.call('agent:capabilities', f.root)).value.codex.motivo, 'Use o painel Codex');
  assert.equal(runner.capabilities.mock.calls.at(-1).arguments[0], f.root);
  await f.context.refreshEnvironment();
  assert.equal(runner.env, f.hosts.codexChat.env);
  assert.equal(runner.env.PATH, '/refreshed');
});

for (const symlink of [false, true]) test(`agent:capabilities recusa CLI do projeto sem executar (${symlink ? 'symlink externo' : 'PATH absoluto'})`, { skip: process.platform === 'win32' }, async t => {
  const f = await mainHandlers(t), runner = f.hosts.agentRun;
  const fixtures = path.join(__dirname, 'fixtures', 'agent-run'), binary = path.join(f.root, 'claude');
  const logFile = path.join(f.base, 'cli.jsonl');
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(binary, `#!${process.execPath}\n${fs.readFileSync(path.join(fixtures, 'fake-claude.cjs'), 'utf8')}`, { mode: 0o755 });
  fs.copyFileSync(path.join(fixtures, 'claude-help.txt'), path.join(f.root, 'claude-help.txt'));
  let bin = f.root;
  if (symlink) { bin = path.join(f.base, 'bin'); fs.mkdirSync(bin); fs.symlinkSync(binary, path.join(bin, 'claude')); }
  runner.env = { PATH: bin, DK_TEST_LOG: logFile };
  runner.capabilities.mock.restore();
  f.context.remember(f.root);
  const result = await f.call('agent:capabilities', f.root);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value.claude.disponivel, false);
  assert.match(result.value.claude.motivo, /Binário.*dentro do projeto recusado/);
  assert.equal(fs.readFileSync(logFile, 'utf8'), '', 'nem --version/--help podem executar código do projeto');
});

test('agent:approve confere run.root no main e preserva pedido ao trocar de projeto', async t => {
  const f = await mainHandlers(t), runId = await start(f);
  f.context.remember(f.other);
  await f.call('project:set-active', f.other);
  const runner = f.hosts.agentRun, run = runner.runs.get(runId);
  const worker = runner.queue.shift(); worker.pending.set('pedido', { approval: { requestId: 'pedido', kind: 'tool', status: 'pending' }, cliRequestId: 'cli', input: {} });
  runner.active.set(runId, worker);
  try {
    const response = t.mock.method(runner, '_response', () => {});
    const approve = t.mock.method(runner, 'approve');
    const read = t.mock.method(runner, 'read', () => ({ run, eventos: [] })); // deliberately permissive runner: main must enforce ownership
    assert.equal((await f.call('agent:approve', f.other, runId, 'pedido', 'allow')).error, 'Execução não encontrada neste projeto.');
    assert.equal(approve.mock.callCount(), 0);
    assert.equal(worker.pending.has('pedido'), true);
    read.mock.restore();
    await f.call('project:set-active', f.root);
    assert.equal((await f.call('agent:approve', f.root, runId, 'pedido', 'allow')).ok, true);
    assert.equal(response.mock.callCount(), 1);
    assert.equal((await f.call('agent:approve', f.root, runId, 'pedido', 'allow')).error, 'Esta solicitação já foi encerrada.');
  } finally {
    // Return synthetic work to the queue: cleanup requires no child process.
    runner.active.delete(runId); runner.queue.push(worker);
  }
});

for (const channel of ['project:close-sessions', 'project:forget']) test(`${channel} aguarda runner e encerra somente a raiz pedida`, async t => {
  const f = await mainHandlers(t), first = await start(f), second = await start(f, f.other);
  const runner = f.hosts.agentRun, gate = deferred(), entered = deferred(), original = runner.closeProject.bind(runner);
  const close = t.mock.method(runner, 'closeProject', async root => { entered.resolve(); await gate.promise; return original(root); });
  const pending = f.call(channel, f.root);
  await entered.promise;
  assert.equal(f.context.config.projects.includes(f.root), true, 'forget só remove após encerrar o runner');
  assert.match((await f.call('agent:start', f.root, options)).error, /Abra o projeto/);
  gate.resolve();
  const result = await pending;
  assert.equal(result.ok, true, result.error);
  assert.equal(close.mock.calls[0].arguments[0], f.root);
  assert.equal(runner.read(f.root, first).run.estado, 'interrompido');
  assert.equal(runner.read(f.other, second).run.estado, 'na_fila');
  if (channel === 'project:close-sessions') assert.deepEqual({ ...result.value }, { closed: 2, chats: 1, agents: 1, partial: false });
  else assert.equal(f.context.config.projects.includes(f.root), false);
  assert.ok(f.closedRoots.every(([, root]) => root === f.root));
  assert.match((await f.call('agent:start', f.root, options)).error, /Abra o projeto/);
});

for (const state of ['windowClosing = true', 'closingProjects.add(root)', 'closedPluginProjects.add(root)']) test(`agent:start recusa ${state}`, async t => {
  const f = await mainHandlers(t); f.context.remember(f.root); f.context.root = f.root;
  vm.runInContext(state, f.context);
  assert.match((await f.call('agent:start', f.root, options)).error, /encerrando|Abra o projeto/);
  assert.equal(f.hosts.agentRun.capabilities.mock.callCount(), 0);
});

for (const change of ['identity', 'reopen', 'window', 'closing', 'closed']) test(`agent:start revalida após composição assíncrona: ${change}`, async t => {
  const f = await mainHandlers(t); f.context.remember(f.root);
  const gate = deferred(), entered = deferred();
  f.hosts.agentRun.sources.guide = async () => { entered.resolve(); await gate.promise; return 'Guia'; };
  const pending = f.call('agent:start', f.root, options);
  await entered.promise;
  if (change === 'identity') { fs.renameSync(f.root, `${f.root}-original`); fs.mkdirSync(f.root); }
  else if (change === 'reopen') f.context.remember(f.root);
  else if (change === 'window') f.context.windowClosing = true;
  else { f.context.root = f.root; vm.runInContext(`${change === 'closing' ? 'closingProjects' : 'closedPluginProjects'}.add(root)`, f.context); }
  gate.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /pasta do projeto mudou|projeto ou a janela mudou|Abra o projeto/);
  assert.equal(f.hosts.agentRun.runs.size, 0, 'não enfileira antes de revalidar');
});

test('agent:start preserva geração desde o IPC, inclusive durante capabilities', async t => {
  const f = await mainHandlers(t); f.context.remember(f.root);
  const gate = deferred(), entered = deferred();
  t.mock.method(f.hosts.agentRun, 'capabilities', async () => { entered.resolve(); await gate.promise; return { claude: { disponivel: true } }; });
  const pending = f.call('agent:start', f.root, options);
  await entered.promise; f.context.remember(f.root); gate.resolve();
  assert.match((await pending).error, /projeto ou a janela mudou/);
  assert.equal(f.hosts.agentRun.runs.size, 0);
});

test('agent:prompt-preview não devolve composição após troca de identidade', async t => {
  const f = await mainHandlers(t); f.context.remember(f.root);
  const gate = deferred(), entered = deferred();
  f.hosts.agentRun.sources.guide = async () => { entered.resolve(); await gate.promise; return 'Guia'; };
  const pending = f.call('agent:prompt-preview', f.root);
  await entered.promise; fs.renameSync(f.root, `${f.root}-original`); fs.mkdirSync(f.root); gate.resolve();
  assert.match((await pending).error, /pasta do projeto mudou/);
});

test('render-process-gone chama cancelAll sem closeAll e permite outra execução', async t => {
  const f = await mainHandlers(t), id = await start(f), runner = f.hosts.agentRun;
  const cancels = [runner, f.hosts.codexChat].map(host => t.mock.method(host, 'cancelAll'));
  const closes = [runner, f.hosts.codexChat].map(host => t.mock.method(host, 'closeAll'));
  f.owner.webContents.emit('render-process-gone');
  for (const spy of cancels) { assert.equal(spy.mock.callCount(), 1); await spy.mock.calls[0].result; }
  for (const spy of closes) assert.equal(spy.mock.callCount(), 0);
  assert.equal(runner.closed, false); assert.equal(f.hosts.codexChat.closed, false);
  assert.equal(runner.read(f.root, id).run.estado, 'interrompido');
  await start(f);
});

for (const event of ['closed', 'will-quit']) test(`${event} ${event === 'closed' ? 'cancela' : 'fecha'} runner e fecha chat`, async t => {
  const f = await mainHandlers(t), closes = [f.hosts.agentRun, f.hosts.codexChat].map(host => t.mock.method(host, 'closeAll'));
  const cancels = t.mock.method(f.hosts.agentRun, 'cancelAll');
  (event === 'closed' ? f.owner : f.context.app).emit(event);
  assert.equal(closes[0].mock.callCount(), event === 'closed' ? 0 : 1);
  assert.equal(closes[1].mock.callCount(), 1);
  for (const spy of closes) await spy.mock.calls[0]?.result;
  assert.equal(cancels.mock.callCount(), 1); await cancels.mock.calls[0].result;
  assert.equal(f.hosts.agentRun.closed, event === 'will-quit'); assert.equal(f.hosts.codexChat.closed, true);
});

test('reabrir janela durante cancelAll reutiliza runner e aguarda a limpeza sem perder histórico', async t => {
  const f = await mainHandlers(t), runner = f.hosts.agentRun, id = await start(f);
  const compose = runner.preview, oldEmit = runner.emit, gate = deferred();
  const original = runner.cancel.bind(runner);
  const cancel = t.mock.method(runner, 'cancel', async (...args) => { await gate.promise; return original(...args); });
  const cancels = t.mock.method(runner, 'cancelAll'), closes = t.mock.method(runner, 'closeAll');
  let event, duplicateCleanup;
  try {
    f.owner.close();
    assert.equal(runner.canceling, true);
    f.context.env = { PATH: '/new-fake-bin' };
    f.context.createWindow();
    assert.equal(vm.runInContext('agentRun', f.context), runner);
    assert.equal(runner.preview, compose, 'não empilha wrappers de composição');
    assert.equal(runner.env, f.context.env);
    const count = f.events.length;
    oldEmit({ type: 'status' });
    assert.equal(f.events.length, count, 'emissor da janela antiga não publica na nova');
    const owner = f.context.window;
    event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame };
    assert.match((await f.invoke(event, 'agent:start', f.root, options)).error, /encerrado/);
    duplicateCleanup = runner.cancelAll();
    assert.equal(cancel.mock.callCount(), 1, 'limpezas simultâneas compartilham a mesma operação');
  } finally { gate.resolve(); await cancels.mock.calls[0]?.result; await duplicateCleanup; }
  assert.equal(closes.mock.callCount(), 0);
  assert.equal(runner.closed, false); assert.equal(runner.canceling, false);
  const next = await f.invoke(event, 'agent:start', f.root, options);
  assert.equal(next.ok, true, next.error);
  assert.equal(runner.read(f.root, id).run.estado, 'interrompido');
  assert.equal(runner.read(f.root, next.value.runId).run.estado, 'na_fila');
  assert.ok(f.events.some(e => e.channel === 'agent:event' && e.payload.runId === next.value.runId));
  const saved = JSON.parse(fs.readFileSync(runner.storeFile, 'utf8')).runs;
  assert.deepEqual(saved.map(run => run.runId), [id, next.value.runId]);
});

for (const rejection of [false, true]) test(`window close aguarda runner e avisa limpeza parcial (${rejection ? 'rejeição' : 'partial'})`, async t => {
  const f = await mainHandlers(t), gate = deferred(), entered = deferred();
  t.mock.method(f.hosts.agentRun, 'cancelAll', async () => { entered.resolve(); await gate.promise; if (rejection) throw new Error('cleanup'); return { partial: true }; });
  let prevented = false;
  f.owner.emit('close', { preventDefault() { prevented = true; } });
  await entered.promise;
  assert.equal(prevented, true); assert.equal(f.context.windowClosing, true); assert.equal(f.owner.destroyed, false);
  assert.match((await f.call('agent:start', f.root, options)).error, /encerrando/);
  gate.resolve(); await f.windowClosed.promise;
  assert.equal(f.warnings.length, 1); assert.equal(f.warnings[0].type, 'warning');
  // Restore before fixture cleanup, which awaits the real runner.
  f.hosts.agentRun.cancelAll.mock.restore();
});

test('ResourceMonitor recebe resourceRoots e IPC conserva kind claude-run sem aviso de ociosidade', async t => {
  const f = await mainHandlers(t);
  const root = { id: 'runner', pid: 123, root: f.root, kind: 'claude-run', lastActivity: 0 };
  t.mock.method(f.hosts.agentRun, 'resourceRoots', () => [root]);
  const resources = f.context.resources;
  assert.deepEqual([...resources.options.getTerminals()], [root]);
  resources.read = async () => ({ sessions: [{ ...root, kind: 'terminal', root: undefined, memoryKiB: 999999 }] });
  const result = await f.call('app:resources');
  assert.equal(result.value.sessions[0].kind, 'claude-run'); assert.equal(result.value.sessions[0].root, f.root);
  const ui = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8'), notice = { hidden: false };
  const uiContext = vm.createContext({ idleSnapshot: result.value, idleId: null, preferences: { idleAlerts: true, idleMemoryMiB: 1 },
    sessions: new Map(), idleSnoozed: new Map(), idleWarningMs: () => 0, $: () => notice });
  vm.runInContext(`${sourceFunction(ui, 'renderIdleNotice')}\nrenderIdleNotice();`, uiContext);
  assert.equal(notice.hidden, true);
});

for (const action of ['start', 'cancel', 'approve']) test(`AgentRunView.open na mesma raiz preserva ${action} em voo`, async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/agent-run.ts'), 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  const View = vm.runInNewContext(`${stripTypeScriptTypes(source)}\nAgentRunView;`);
  const gate = deferred(), capabilities = { claude: { disponivel: true } };
  const run = { root: '/project', runId: 'run', estado: 'executando' };
  let calls = 0;
  const view = Object.assign(Object.create(View.prototype), {
    root: '/project', request: 0, capRequest: 0, contextRequest: 0, previewRequest: 0, treeRequest: 0,
    starting: false, canceling: false, opening: false, destroyed: false, approving: new Set(),
    earlyEvents: new Map(), selectedRunByRoot: new Map(), rows: new Map(), dirty: new Set(), selectedFiles: [],
    capabilities, currentRun: action === 'start' ? null : run,
    input: { value: 'Pedido' }, stageInput: { value: '' }, skillSelect: { value: '' }, designSelect: { value: '' },
    resumeToggleBtn: { setAttribute() {} },
    api: { capabilities: async () => capabilities, list: async () => action === 'start' ? [] : [run],
      [action]: async () => { calls++; await gate.promise; return { runId: run.runId }; } },
    async loadContext() {}, async select() { this.currentRun = run; },
    saveDraft() {}, restoreDraft() {}, controls() {}, resetRows() {}, setPreviewOpen() {}, setFilesOpen() {},
    renderHeader() {}, renderPicker() {}, renderBanner() {}, renderMessages() {}, renderCatalogSelectors() {},
    fail(error) { throw error; },
  });
  const invoke = () => action === 'approve' ? view.approve('item', 'request', 'allow') : view[action]();
  const pending = invoke();
  let duplicate;
  try {
    assert.equal(calls, 1);
    await view.open('/project');
    if (action === 'approve') assert.equal(view.approving.has('request'), true);
    else assert.equal(view[action === 'start' ? 'starting' : 'canceling'], true);
    duplicate = invoke();
    assert.equal(calls, 1, 'reabrir não permite IPC duplicado');
  } finally { gate.resolve(); await pending; await duplicate; }
  assert.equal(view.starting, false); assert.equal(view.canceling, false); assert.equal(view.approving.size, 0);
  view.starting = true; view.canceling = true; view.approving.add('request');
  await view.open('/other');
  assert.equal(view.starting, false); assert.equal(view.canceling, false); assert.equal(view.approving.size, 0);
});

test('activate só reabre AgentRunView quando muda o projeto ou o agente está ativo', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  for (const [previous, mainView, expected] of [['/project', 'terminal', 0], ['/project', 'agent', 1], ['/other', 'terminal', 1]]) {
    const calls = [], info = { path: '/project', name: 'Project', isDk: false };
    const context = vm.createContext({
      api: { activateProject: async () => info, async setActiveProject() {} },
      current: { ...info, path: previous }, appliedProjectIntent: 0, activationGeneration: 0, opening: Promise.resolve(),
      closingProjects: new Set(), openedProjects: new Set(), projects: [], pluginsPanel: null, fileEditor: null,
      projectWorkspaceViews: new Map(), lastActive: new Map(), sessions: new Map(), activeId: null,
      mainView, workspaceView: 'terminal', selectedPanel: null,
      agentView: { async open(root) { calls.push(root); } }, chatView: null,
      rememberRecent() {}, syncTreeSelection() {}, renderProject() {}, selectMainView() {}, focusSession() {},
      async loadServices() {}, async refreshClaudePlugin() {}, notify(error) { throw error; },
    });
    vm.runInContext(stripTypeScriptTypes(sourceFunction(source, 'activate')), context);
    assert.equal(await context.activate(info, 1), true);
    assert.deepEqual(calls, expected ? [info.path] : []);
  }
});

test('preload expõe canais M2, erros e listeners independentes com unsubscribe', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8');
  const renderer = new EventEmitter(), calls = []; let api;
  renderer.invoke = async (...args) => { calls.push(args); return { ok: true, value: 'resultado' }; };
  vm.runInNewContext(source, { require: name => {
    assert.equal(name, 'electron');
    return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'dk'); api = value; } } };
  } });
  assert.equal(await api.capabilitiesAgent('/projeto'), 'resultado');
  await api.listAgentRuns('/projeto'); await api.readAgentRun('/projeto', 'run'); await api.startAgentRun('/projeto', options);
  await api.cancelAgentRun('/projeto', 'run'); await api.approveAgentRun('/projeto', 'run', 'request', 'allow');
  await api.previewAgentPrompt('/projeto', options); await api.previewAgentPrompt('/projeto');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [...channels('/projeto').slice(0, 6), ['agent:prompt-preview', '/projeto', options], ['agent:prompt-preview', '/projeto', {}]]);
  const received = [], second = [];
  const off = api.onAgentEvent(event => received.push(event)), offSecond = api.onAgentEvent(event => second.push(event));
  const event = { root: '/projeto', runId: 'run', seq: 1, at: 1, type: 'status', estado: 'executando' };
  renderer.emit('agent:event', { private: true }, event); off(); off(); renderer.emit('agent:event', {}, event);
  assert.deepEqual(received, [event]); assert.deepEqual(second, [event, event]);
  offSecond(); assert.equal(renderer.listenerCount('agent:event'), 0);
  renderer.invoke = async () => ({ ok: false, error: 'Execução não encontrada neste projeto.' });
  await assert.rejects(api.readAgentRun('/projeto', 'run'), /Execução não encontrada neste projeto/);
});

test('CodexChat.cancelAll cancela e aguarda todas as sessões sem marcar closed', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-m2-chat-')));
  const chat = new CodexChat({ storeFile: path.join(base, 'private', 'chat.json') });
  t.after(() => { clearTimeout(chat.saveTimer); fs.rmSync(base, { recursive: true, force: true }); });
  const gate = deferred(), calls = [], kills = [];
  const a = { session: { root: '/a', id: 'a' }, child: { exitCode: null, signalCode: null }, run: gate.promise };
  const b = { session: { root: '/b', id: 'b' }, run: Promise.resolve(), cleanupPartial: true };
  chat.active.set('a', a); chat.active.set('b', b);
  t.mock.method(chat, 'cancel', async (root, id) => { calls.push([root, id]); });
  t.mock.method(chat, '_kill', (worker, signal) => kills.push([worker.session.id, signal]));
  const save = t.mock.method(chat, '_save');
  let finished = false;
  const pending = chat.cancelAll().then(result => { finished = true; return result; });
  await Promise.resolve();
  assert.deepEqual(calls, [['/a', 'a'], ['/b', 'b']]); assert.equal(finished, false); assert.equal(chat.closed, false);
  gate.resolve(); assert.deepEqual(await pending, { partial: true });
  assert.deepEqual(kills, [['a', 'SIGTERM']]); assert.equal(save.mock.callCount(), 1);
  assert.equal(chat.closed, false);
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  assert.equal(chat.create(root).root, root, 'a mesma instância continua disponível');
});
