const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const { Extensions, pluginManifest, resolveExecutable } = require('../electron/extensions.cjs');

const v2 = (id = 'example', changes = {}) => ({ schema: 2, id, name: 'Exemplo', version: '1.0.0', permissions: ['process:spawn'],
  contributes: { actions: [{ id: 'hello', title: 'Versão', description: 'Exibir versão', command: 'node', args: ['--version'] }] }, ...changes });
const v1 = (id = 'legacy') => ({ schema: 1, id, name: 'Legado', version: '1.0.0', permission: 'terminal', command: 'node', args: ['--version'] });
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-plugins-'));
  const app = path.join(base, 'app'), user = path.join(base, 'user'), project = path.join(base, 'project');
  for (const root of [app, user, project]) fs.mkdirSync(root);
  const hosts = [];
  t.after(() => { for (const host of hosts) host.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, app, user, project, host(onChange) { const host = new Extensions([app, user], { PATH: path.dirname(process.execPath) }, onChange); hosts.push(host); return host; } };
}
function write(root, folder, value, filename = 'plugin.json') {
  const directory = path.join(root, folder); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, filename); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file;
}
function projectPlugins(project) { const root = path.join(project, '.dk', 'plugins'); fs.mkdirSync(root, { recursive: true }); return root; }
function projectIdentity(root) {
  const stat = fs.statSync(root);
  return { realpath: fs.realpathSync.native(root), dev: stat.dev, ino: stat.ino };
}
function watchHarness(t) {
  const watchers = [];
  const spy = mock.method(fs, 'watch', (dir, options, callback) => {
    assert.equal(options.recursive, undefined);
    const watcher = new EventEmitter();
    Object.assign(watcher, { dir, closed: false, change: callback, close() { this.closed = true; } });
    watchers.push(watcher);
    assert.ok(watchers.filter(item => !item.closed).length <= 35);
    return watcher;
  });
  t.after(() => spy.mock.restore());
  return watchers;
}
function sourceFunction(source, name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\)[^{\\n]*\\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `Função ${name} não encontrada`);
  return match[0];
}
// Exercise the real IPC callbacks and verification functions in Node, without
// loading Electron, creating a window, or spawning terminals.
function mainHandlers(t, f) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const handlers = new Map(), sessions = new Map(), prompts = [];
  const context = vm.createContext({
    fs, path, env: { PATH: path.dirname(process.execPath) }, config: { projects: [] },
    projectInfo: require('../electron/core.cjs').projectInfo,
    extensions: f.host(), save() {}, debugLog: { event() {} },
    window: { isDestroyed: () => false }, windowClosing: false,
    handle: (name, handler) => handlers.set(name, handler),
    dialog: { async showMessageBox(_window, options) { prompts.push(options); return { response: 1 }; } },
    terminals: {
      create(info, spec) {
        const session = { id: String(sessions.size + 1), cwd: info.path, spec, state: 'pending' };
        sessions.set(session.id, session); return session;
      },
      get: id => sessions.get(id),
      start(id) { const session = sessions.get(id); session.state = 'running'; return session; },
      async closeProject() { return { closed: 0, partial: false }; },
    },
    codexChat: { async closeProject() { return 0; } },
    async closeProjectBrowser() { return { partial: false }; }, previewBridge: { revoke() {} },
  });
  const state = source.slice(source.indexOf('const selected ='), source.indexOf('let kit ='));
  const names = ['project', 'advancePluginGeneration', 'rememberPluginIdentity', 'remember', 'knownProject', 'pluginProject',
    'displayPluginValue', 'confirmPlugin', 'startTerminal', 'registerHandlers'];
  vm.runInContext(`${state}\n${names.map(name => sourceFunction(source, name)).join('\n')}\nregisterHandlers();`, context);
  t.after(() => context.extensions.close());
  return { context, sessions, prompts, call: (name, ...args) => Promise.resolve().then(() => handlers.get(name)(...args)) };
}
function rendererActivation(call) {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const context = vm.createContext({
    api: { activateProject: root => call('project:activate', root), setActiveProject: root => call('project:set-active', root) },
    current: null, projectIntent: 0, appliedProjectIntent: 0, activationGeneration: 0, opening: Promise.resolve(),
    closingProjects: new Set(), openedProjects: new Set(), projects: [], pluginsPanel: null, fileEditor: null,
    projectWorkspaceViews: new Map(), lastActive: new Map(), sessions: new Map(), activeId: null,
    mainView: 'terminal', workspaceView: 'terminal', selectedPanel: null,
    rememberRecent() {}, syncTreeSelection() {}, renderProject() {}, selectMainView() {}, visualView: null, async leaveVisual() { return true; }, focusSession() {},
    async loadServices() {}, async refreshClaudePlugin() {}, notify(error) { throw error; },
  });
  vm.runInContext(stripTypeScriptTypes(`${source.match(/^function beginProjectIntent.*$/m)[0]}\n${sourceFunction(source, 'activate')}`), context);
  return context;
}
// Minimal DOM for the real panel's empty/error/manual-refresh flow.
function rendererPlugins(host, root) {
  const nodes = [];
  const document = { createElement() {
    const node = { dataset: {}, children: [], events: {}, textContent: '',
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute() {}, addEventListener(name, callback) { this.events[name] = callback; }, remove() {},
    };
    nodes.push(node); return node;
  } };
  const source = fs.readFileSync(path.join(__dirname, '../src/plugins.ts'), 'utf8');
  const context = vm.createContext({ document, setIconButton() {} });
  vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\n/m, '').replace(/^export /gm, '')), context);
  const panel = context.createPluginsPanel(document.createElement(), {
    list: root => host.listPlugins(root), reload: root => host.reloadPlugins(root),
  });
  let changed, pending;
  const main = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const handler = main.match(/^api\.onPluginsChanged\(.*$/m);
  assert.ok(handler, 'Callback do renderer não encontrado');
  vm.runInNewContext(handler[0], { api: { onPluginsChanged(callback) { changed = callback; } },
    pluginsPanel: panel, current: { path: root }, run: task => { pending = task(); },
  });
  return { panel, changed: event => changed(event), settled: () => pending,
    refresh: nodes.find(node => node.dataset.testid === 'plugins-reload'),
    errorText: () => nodes.find(node => node.dataset.testid === 'plugins-errors').children.flatMap(node => node.children).map(node => node.textContent).join('\n'),
  };
}
async function until(condition, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await delay(20);
  assert.ok(condition(), 'O evento esperado não chegou dentro do prazo.');
}
function fakeAsar(archive, header, contents) {
  const json = Buffer.from(JSON.stringify(header));
  const headerSize = 8 + Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(8), packed = Buffer.alloc(headerSize);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(headerSize, 4);
  packed.writeUInt32LE(headerSize - 4, 0); packed.writeInt32LE(json.length, 4); json.copy(packed, 8);
  fs.writeFileSync(archive, Buffer.concat([prefix, packed, contents]));
}
function asarHeader(contents) {
  const integrity = { algorithm: 'SHA256', hash: createHash('sha256').update(contents).digest('hex') };
  return { files: { extensions: { files: { example: { files: { 'plugin.json': { size: contents.length, offset: '0', integrity } } } } } } };
}

test('plugin v2 por projeto é listado e executável sem shell; contribuições futuras ficam inativas', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project);
  write(plugins, 'example', v2('example', { contributes: {
    actions: [{ id: 'hello', title: 'Versão', description: 'Exibir versão', command: 'node', args: ['--version'] }],
    views: [{ id: 'view', title: 'Visão', content: { action: 'hello' } }],
    panels: [{ id: 'panel', title: 'Painel', location: 'sidebar', content: { action: 'hello' } }],
    stages: [{ id: 'stage', title: 'Etapa', order: 1, criteria: [{ id: 'ready', label: 'Pronto' }] }],
    catalogs: [{ id: 'catalog', title: 'Catálogo', source: 'plugin', kind: 'skills', path: 'skills' }],
  } }));
  const host = f.host(), result = await host.listPlugins(f.project);
  assert.deepEqual(result.errors, []);
  assert.equal(result.plugins.length, 1);
  const plugin = result.plugins[0];
  assert.equal(plugin.origin, 'project'); assert.equal(plugin.schema, 2); assert.match(plugin.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(plugin.permissions, ['process:spawn']);
  assert.equal(plugin.contributes.actions[0].available, true);
  assert.equal(plugin.contributes.actions[0].commandPreview, 'node "--version"');
  for (const key of ['views', 'panels', 'stages', 'catalogs']) assert.equal(plugin.contributes[key][0].active, false);
  const spec = await host.pluginSpec(f.project, 'example', 'hello', plugin.revision);
  assert.equal(spec.kind, 'extension'); assert.equal(spec.file, path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'node.exe' : 'node'));
  assert.deepEqual(spec.args, ['--version']); assert.equal(spec.revision, plugin.revision);
  assert.equal(spec.executableIdentity.realpath, await fs.promises.realpath(spec.file));
  for (const name of ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs']) assert.match(spec.executableIdentity[name], /^\d+$/);
  await assert.rejects(host.pluginSpec(f.project, 'example', 'absent', plugin.revision), /Ação não encontrada/);
  await assert.rejects(host.pluginSpec(f.project, '../secret', 'hello', plugin.revision), /inválida/);
});

test('identifica o alvo real de um executável por link e detecta sua substituição', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project), bin = path.join(f.base, 'bin'); fs.mkdirSync(bin);
  const first = path.join(bin, 'first'), second = path.join(bin, 'second');
  fs.writeFileSync(first, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(second, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const alias = path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node');
  try { fs.symlinkSync(first, alias, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Links simbólicos indisponíveis neste ambiente.'); throw error; }
  write(plugins, 'example', v2());
  const host = new Extensions([f.app, f.user], { PATH: bin }); t.after(() => host.close());
  const plugin = (await host.listPlugins(f.project)).plugins[0];
  const before = await host.pluginSpec(f.project, 'example', 'hello', plugin.revision);
  assert.equal(before.file, alias);
  assert.equal(before.executableIdentity.realpath, await fs.promises.realpath(first));
  fs.unlinkSync(alias); fs.symlinkSync(second, alias, 'file');
  const after = await host.pluginSpec(f.project, 'example', 'hello', plugin.revision);
  assert.equal(after.file, alias);
  assert.equal(after.executableIdentity.realpath, await fs.promises.realpath(second));
  assert.notDeepEqual(before.executableIdentity, after.executableIdentity);
  fs.writeFileSync(second, '#!/bin/sh\nexit 99\n');
  const changed = await host.pluginSpec(f.project, 'example', 'hello', plugin.revision);
  assert.notDeepEqual(after.executableIdentity, changed.executableIdentity);
});

test('recusa executável cujo link muda durante a coleta da identidade', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project), bin = path.join(f.base, 'bin'); fs.mkdirSync(bin);
  const first = path.join(bin, 'first'), second = path.join(bin, 'second');
  fs.writeFileSync(first, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(second, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const alias = path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node');
  try { fs.symlinkSync(first, alias, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Links simbólicos indisponíveis neste ambiente.'); throw error; }
  write(plugins, 'example', v2());
  const host = new Extensions([f.app, f.user], { PATH: bin }); t.after(() => host.close());
  const plugin = (await host.listPlugins(f.project)).plugins[0];
  const original = fs.promises.realpath; let visits = 0;
  const spy = mock.method(fs.promises, 'realpath', async (...args) => {
    if (args[0] === alias && ++visits === 2) { fs.unlinkSync(alias); fs.symlinkSync(second, alias, 'file'); }
    return original(...args);
  });
  t.after(() => spy.mock.restore());
  await assert.rejects(host.pluginSpec(f.project, 'example', 'hello', plugin.revision), /Executável mudou/);
  assert.equal(visits, 2);
});

test('v1 mantém API, precedência e contexto; v1 de projeto é ignorado', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project);
  write(f.app, 'legacy', v1(), 'extension.json');
  write(plugins, 'other', v1('other'), 'extension.json');
  write(plugins, 'duplicate', v2('legacy'));
  const host = f.host();
  assert.equal(host.list()[0].id, 'legacy');
  assert.deepEqual(host.spec('legacy').args, ['--version']);
  const result = await host.listPlugins(f.project);
  assert.deepEqual(result.plugins.map(plugin => plugin.id), ['legacy']);
  assert.equal(result.plugins[0].origin, 'app'); assert.equal(result.plugins[0].contributes.actions[0].id, 'open');
  assert.ok(result.errors.some(error => /ID já instalado/.test(error)));
  assert.deepEqual((await host.pluginSpec(f.project, 'legacy', 'open', result.plugins[0].revision)).args, ['--version']);
  write(f.app, 'legacy', { ...v1(), args: ['--help'] }, 'extension.json');
  assert.deepEqual(host.spec('legacy').args, ['--version']);
  await assert.rejects(host.pluginSpec(f.project, 'legacy', 'open', result.plugins[0].revision), /mudou/);
});

test('v1 com argumentos longos mantém o fluxo antigo e não pode executar pelo painel de plugins', async t => {
  const f = fixture(t); projectPlugins(f.project);
  const args = ['é'.repeat(3000), 'é'.repeat(3000)];
  write(f.app, 'legacy', { ...v1(), args }, 'extension.json');
  const host = f.host();
  assert.deepEqual(host.spec('legacy').args, args);
  const result = await host.listPlugins(f.project), plugin = result.plugins.find(item => item.id === 'legacy');
  assert.equal(plugin.contributes.actions[0].available, false);
  assert.ok(plugin.errors.some(error => /limite de confirmação/.test(error)));
  await assert.rejects(host.pluginSpec(f.project, 'legacy', 'open', plugin.revision), /limite de confirmação/);
  assert.deepEqual(host.spec('legacy').args, args);
});

test('leitor efêmero usa snapshot imutável sem varredura síncrona e não interfere nos observadores do host', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project);
  write(f.app, 'legacy', v1(), 'extension.json');
  const file = write(plugins, 'example', v2());
  const watchSpy = mock.method(fs, 'watch', () => {
    const watcher = new EventEmitter(); watcher.close = () => {}; return watcher;
  });
  t.after(() => watchSpy.mock.restore());
  const host = f.host(() => {}), original = await host.listPlugins(f.project);
  const expected = original.plugins.find(item => item.id === 'example');
  const oldEpoch = host.epoch, activeWatchers = [...host.watchers];
  assert.ok(activeWatchers.length > 0);
  const spies = ['readdirSync', 'readFileSync', 'statSync', 'existsSync'].map(name =>
    mock.method(fs, name, () => { throw new Error(`Leitura síncrona inesperada: ${name}`); }));
  let verification;
  try {
    verification = host.forVerification({ PATH: path.dirname(process.execPath) });
    assert.notEqual(verification, host);
    assert.notEqual(verification.items, host.items);
    assert.equal(verification.onChange, null);
    assert.throws(() => verification.items.set('other', {}), /somente para leitura/);
    assert.throws(() => verification.legacyFolders.clear(), /somente para leitura/);
    assert.throws(() => verification.items.get('legacy').args.push('--help'), TypeError);
    assert.throws(() => verification.errors.push('erro'), TypeError);
    const listed = await verification.listPlugins(f.project);
    assert.equal(listed.plugins.find(item => item.id === 'example').revision, expected.revision);
    assert.equal(verification.watchers.length, 0);
    assert.deepEqual((await verification.pluginSpec(f.project, 'example', 'hello', expected.revision)).args, ['--version']);
    fs.writeFileSync(file, JSON.stringify(v2('example', { description: 'alterado' })));
    await assert.rejects(verification.pluginSpec(f.project, 'example', 'hello', expected.revision), /mudou/);
    verification.close();
    assert.equal(verification.watchers.length, 0);
    assert.equal(host.epoch, oldEpoch);
    assert.deepEqual(host.watchers, activeWatchers);
    assert.equal(host.activeRoot, await fs.promises.realpath(f.project));
    host.items.get('legacy').args.push('--help');
    assert.deepEqual(verification.items.get('legacy').args, ['--version']);
  } finally {
    verification?.close();
    for (const spy of spies) spy.mock.restore();
  }
});

test('origem do app prevalece sobre usuário e projeto e pastas com dois manifestos são rejeitadas', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project);
  write(f.app, 'one', v2('same')); write(f.user, 'two', v2('same')); write(plugins, 'three', v2('same'));
  write(plugins, 'both', v2('both')); write(plugins, 'both', v1('both'), 'extension.json');
  const host = f.host(), result = await host.listPlugins(f.project);
  assert.deepEqual(result.plugins.map(plugin => [plugin.id, plugin.origin]), [['same', 'app']]);
  assert.equal(result.errors.filter(error => /ID já instalado/.test(error)).length, 2);
  assert.ok(result.errors.some(error => /dois manifestos/.test(error)));
});

test('manifestos inválidos são isolados e não podem habilitar comandos ou campos executáveis', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project);
  write(plugins, 'good', v2('good'));
  write(plugins, 'permission', v2('permission', { permissions: ['net:any'] }));
  write(plugins, 'repeat', v2('repeat', { permissions: ['process:spawn', 'process:spawn'] }));
  write(plugins, 'script', v2('script', { contributes: { actions: [{ id: 'hello', title: 'Teste', command: 'node', args: [], script: 'x' }] } }));
  write(plugins, 'extra', v2('extra', { sneaky: true }));
  write(plugins, 'wrong-version', { ...v1('wrong-version') });
  write(plugins, 'oversized', 'x'.repeat(16 * 1024 + 1));
  fs.mkdirSync(path.join(plugins, 'directory', 'plugin.json'), { recursive: true });
  const host = f.host(), result = await host.listPlugins(f.project);
  assert.deepEqual(result.plugins.map(plugin => plugin.id), ['good']);
  for (const name of ['permission', 'repeat', 'script', 'extra', 'wrong-version', 'oversized', 'directory']) assert.ok(result.errors.some(error => error.includes(`/${name}:`)), name);
  assert.ok(result.errors.some(error => /Permissão desconhecida/.test(error)));
  assert.ok(result.errors.some(error => /muito grande/.test(error)));
});

test('contribuições inseguras não invalidam as demais e não se tornam executáveis', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project);
  write(plugins, 'bad', v2('bad', { permissions: [], contributes: {
    actions: [{ id: 'unsafe', title: 'Unsafe', command: 'node;touch', args: [] }],
    views: [{ id: 'broken', title: 'Quebrada', content: { action: 'unsafe' } }, { id: 'icon', title: 'Ícone', icon: 'unknown', content: { action: 'unsafe' } }],
    catalogs: [{ id: 'escape', title: 'Fora', kind: 'skills', source: 'project', path: '../other' }],
  } }));
  const result = await f.host().listPlugins(f.project);
  assert.equal(result.plugins.length, 1); assert.deepEqual(result.plugins[0].contributes.actions, []);
  assert.deepEqual(result.plugins[0].contributes.views, []); assert.deepEqual(result.plugins[0].contributes.catalogs, []);
  assert.ok(result.errors.some(error => /process:spawn/.test(error)));
  assert.ok(result.errors.some(error => /referência inexistente/.test(error)));
  assert.ok(result.errors.some(error => /Ícone inválido/.test(error)));
  assert.throws(() => pluginManifest(v2('example', { contributes: { actions: [{ id: 'hello', title: 'Teste', command: 'node', args: [], module: 'x' }] } })), /Campo executável/);
});

test('limita diretórios, argumentos e resolve executáveis apenas em entradas absolutas do PATH', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project);
  for (let i = 0; i < 33; i++) write(plugins, `dir-${i}`, v2(`item-${i}`));
  const host = new Extensions([f.app, f.user], { PATH: '.' }); t.after(() => host.close());
  const result = await host.listPlugins(f.project);
  assert.equal(result.plugins.length, 32); assert.ok(result.errors.some(error => /mais de 32 pastas/.test(error)));
  assert.ok(result.plugins.every(plugin => !plugin.contributes.actions[0].available));
  await assert.rejects(host.pluginSpec(f.project, result.plugins[0].id, 'hello', result.plugins[0].revision), /PATH/);
  const bad = pluginManifest(v2('badargs', { contributes: { actions: [{ id: 'hello', title: 'Teste', command: 'node', args: Array(33).fill('a') }] } }));
  assert.equal(bad.contributes.actions.length, 0); assert.ok(bad.errors.some(error => /argumentos inválidos/.test(error)));
  const aggregate = pluginManifest(v2('largeargs', { contributes: { actions: [{ id: 'hello', title: 'Teste', command: 'node', args: ['é'.repeat(2000), 'é'.repeat(2000), 'é'.repeat(2000)] }] } }));
  assert.equal(aggregate.contributes.actions.length, 0); assert.ok(aggregate.errors.some(error => /argumentos inválidos/.test(error)));
});

test('resolução Windows aceita nome com e sem sufixo exe sem introduzir shell', async t => {
  const f = fixture(t), bin = path.join(f.base, 'bin'); fs.mkdirSync(bin);
  const exe = path.join(bin, 'tool.exe'); fs.writeFileSync(exe, '', { mode: 0o755 });
  assert.equal(await resolveExecutable('tool', { PATH: bin }, 'win32'), exe);
  assert.equal(await resolveExecutable('tool.exe', { PATH: bin }, 'win32'), exe);
  assert.equal(await resolveExecutable('tool.cmd', { PATH: bin }, 'win32'), null);
});

test('a revisão apresentada impede execução após edição e mesmo após recarga', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project), file = write(plugins, 'example', v2());
  const host = f.host(), first = (await host.listPlugins(f.project)).plugins[0];
  fs.writeFileSync(file, JSON.stringify(v2('example', { contributes: { actions: [{ id: 'hello', title: 'Versão', command: 'node', args: ['--help'] }] } })));
  await assert.rejects(host.pluginSpec(f.project, 'example', 'hello', first.revision), /mudou/);
  const second = (await host.reloadPlugins(f.project)).plugins[0];
  assert.notEqual(first.revision, second.revision);
  await assert.rejects(host.pluginSpec(f.project, 'example', 'hello', first.revision), /mudou/);
  assert.deepEqual((await host.pluginSpec(f.project, 'example', 'hello', second.revision)).args, ['--help']);
});

test('links simbólicos em .dk/plugins, pastas e manifesto não alcançam arquivos externos', async t => {
  const f = fixture(t), outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
  write(outside, 'external', v2('external'));
  const dk = path.join(f.project, '.dk'); fs.mkdirSync(dk);
  try { fs.symlinkSync(outside, path.join(dk, 'plugins'), 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Links simbólicos indisponíveis neste ambiente.'); throw error; }
  const host = f.host(); let result = await host.listPlugins(f.project);
  assert.deepEqual(result.plugins, []); assert.ok(result.errors.some(error => /link simbólico/.test(error)));
  fs.unlinkSync(path.join(dk, 'plugins')); const plugins = projectPlugins(f.project);
  fs.symlinkSync(path.join(outside, 'external'), path.join(plugins, 'linked'), 'dir');
  fs.mkdirSync(path.join(plugins, 'manifest')); fs.symlinkSync(path.join(outside, 'external', 'plugin.json'), path.join(plugins, 'manifest', 'plugin.json'));
  result = await host.reloadPlugins(f.project);
  assert.deepEqual(result.plugins, []); assert.ok(result.errors.some(error => error.includes('/linked:'))); assert.ok(result.errors.some(error => error.includes('/manifest:')));
});

test('ASAR lê apenas manifesto interno coerente pelo FS virtual, limitado e com integridade', async t => {
  const f = fixture(t), archive = path.join(f.base, 'app.asar'), file = path.join(archive, 'extensions', 'example', 'plugin.json');
  const contents = Buffer.from(JSON.stringify(v2())), header = asarHeader(contents);
  const host = f.host(), trusted = () => ({ archive, originalFs: fs, cache: null });
  let virtualBytes = contents, virtualRead = null;
  const origOpen = fs.promises.open, origLstat = fs.promises.lstat, origRealpath = fs.promises.realpath;
  const lstatSpy = mock.method(fs.promises, 'lstat', async (...args) => args[0] === file ? { isFile: () => true, isSymbolicLink: () => false, size: virtualBytes.length } : origLstat(...args));
  const realSpy = mock.method(fs.promises, 'realpath', async (...args) => args[0] === file ? file : origRealpath(...args));
  const openSpy = mock.method(fs.promises, 'open', async (...args) => {
    if (args[0] !== file) return origOpen(...args);
    return {
      async stat() { return { isFile: () => true, size: virtualBytes.length }; },
      async read(buffer, offset, length, position) {
        if (virtualRead) { const callback = virtualRead; virtualRead = null; callback(); }
        const count = Math.min(length, Math.max(0, virtualBytes.length - position));
        virtualBytes.copy(buffer, offset, position, position + count); return { bytesRead: count, buffer };
      },
      async close() {},
    };
  });
  t.after(() => { lstatSpy.mock.restore(); realSpy.mock.restore(); openSpy.mock.restore(); });
  fakeAsar(archive, header, contents);
  const result = await host._readPackedManifest(trusted(), file);
  assert.equal(result.value.id, 'example'); assert.equal(result.revision, header.files.extensions.files.example.files['plugin.json'].integrity.hash);
  await assert.rejects(host._readPackedManifest(trusted(), path.join(f.base, 'other', 'plugin.json')), /fora da raiz/);

  const withoutIntegrity = structuredClone(header);
  delete withoutIntegrity.files.extensions.files.example.files['plugin.json'].integrity;
  fakeAsar(archive, withoutIntegrity, contents);
  assert.equal((await host._readPackedManifest(trusted(), file)).value.id, 'example');
  virtualBytes = Buffer.from(contents);
  const nameOffset = virtualBytes.indexOf('Exemplo'); assert.ok(nameOffset >= 0);
  virtualBytes[nameOffset] = 'Y'.charCodeAt(0);
  await assert.rejects(host._readPackedManifest(trusted(), file), /Conteúdo do manifesto ASAR divergente/);
  virtualBytes = contents;

  const variants = [
    { name: 'link na raiz', change: value => { value.link = 'other'; } },
    { name: 'pasta unpacked', change: value => { value.files.extensions.unpacked = true; } },
    { name: 'pasta com link', change: value => { value.files.extensions.files.example.link = 'outside'; } },
    { name: 'manifesto unpacked', change: value => { value.files.extensions.files.example.files['plugin.json'].unpacked = true; } },
    { name: 'manifesto com link', change: value => { value.files.extensions.files.example.files['plugin.json'].link = 'outside'; } },
    { name: 'formas contraditórias', change: value => { value.files.extensions.files.example.files['plugin.json'].files = {}; } },
    { name: 'offset textual', change: value => { value.files.extensions.files.example.files['plugin.json'].offset = 'x'; } },
    { name: 'offset sem precisão', change: value => { value.files.extensions.files.example.files['plugin.json'].offset = '9007199254740992'; } },
    { name: 'offset fora do arquivo', change: value => { value.files.extensions.files.example.files['plugin.json'].offset = '99999999'; } },
    { name: 'manifesto maior que limite', change: value => { value.files.extensions.files.example.files['plugin.json'].size = 16385; } },
    { name: 'hash divergente', change: value => { value.files.extensions.files.example.files['plugin.json'].integrity.hash = '0'.repeat(64); } },
  ];
  for (const variant of variants) {
    const value = structuredClone(header); variant.change(value); fakeAsar(archive, value, contents);
    await assert.rejects(host._readPackedManifest(trusted(), file), undefined, variant.name);
  }
  virtualBytes = Buffer.from([255]);
  const invalidUtf8 = asarHeader(virtualBytes); delete invalidUtf8.files.extensions.files.example.files['plugin.json'].integrity;
  fakeAsar(archive, invalidUtf8, virtualBytes);
  await assert.rejects(host._readPackedManifest(trusted(), file), /encoded data|UTF-8/i);
  virtualBytes = contents;
  fs.writeFileSync(archive, Buffer.alloc(16));
  await assert.rejects(host._readPackedManifest(trusted(), file), /Cabeçalho ASAR inválido/);
  const largeHeader = Buffer.alloc(16); largeHeader.writeUInt32LE(4, 0); largeHeader.writeUInt32LE(4 * 1024 * 1024 + 4, 4);
  fs.writeFileSync(archive, largeHeader);
  await assert.rejects(host._readPackedManifest(trusted(), file), /Cabeçalho ASAR inválido/);

  fakeAsar(archive, header, contents);
  virtualRead = () => fs.appendFileSync(archive, 'alterado');
  await assert.rejects(host._readPackedManifest(trusted(), file), /Pacote ASAR mudou/);
});

test('nome .asar em projeto externo não concede exceção a links fora do projeto', async t => {
  const f = fixture(t), project = path.join(f.base, 'project.asar'), outside = path.join(f.base, 'outside');
  fs.mkdirSync(project); fs.mkdirSync(outside);
  const external = path.join(outside, 'plugin.json'); fs.writeFileSync(external, JSON.stringify(v2()));
  const folder = path.join(projectPlugins(project), 'example'); fs.mkdirSync(folder);
  try { fs.symlinkSync(external, path.join(folder, 'plugin.json'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Links simbólicos indisponíveis neste ambiente.'); throw error; }
  const result = await f.host().listPlugins(project);
  assert.deepEqual(result.plugins, []); assert.ok(result.errors.some(error => /link simbólico/.test(error)));
});

test('watch de projeto agrupa eventos e closeProject cancela observadores e temporizador', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project), file = write(plugins, 'example', v2());
  const watchers = watchHarness(t);
  const notifications = [], host = f.host(event => notifications.push(event));
  await host.listPlugins(f.project);
  assert.equal(host.watchers.length, 4);
  const watcher = watchers.find(item => item.dir === fs.realpathSync(path.dirname(file)));
  fs.writeFileSync(file, JSON.stringify(v2('example', { description: 'primeira' })));
  watcher.change('change', 'plugin.json');
  await delay(60);
  fs.writeFileSync(file, JSON.stringify(v2('example', { description: 'segunda' })));
  watcher.change('change', 'plugin.json');
  await until(() => notifications.length > 0);
  await delay(400); assert.equal(notifications.length, 1); assert.equal(notifications[0].path, path.resolve(f.project));
  fs.writeFileSync(file, JSON.stringify(v2('example', { description: 'terceira' })));
  watcher.change('change', 'plugin.json');
  await delay(40); host.closeProject(f.project);
  assert.equal(host.watchers.length, 0); assert.equal(host.timer, null);
  assert.ok(watchers.every(item => item.closed));
  watcher.change('change', 'plugin.json');
  await delay(400); assert.equal(notifications.length, 1);
});

test('fechar projeto cancela leitura pendente sem recriar observadores', async t => {
  const f = fixture(t); projectPlugins(f.project);
  watchHarness(t);
  const host = f.host(() => {}), realpath = fs.promises.realpath;
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { started = resolve; });
  const spy = mock.method(fs.promises, 'realpath', async (...args) => {
    if (args[0] === f.project) { started(); await waiting; }
    return realpath(...args);
  });
  t.after(() => spy.mock.restore());
  const pending = host.listPlugins(f.project); await seen; host.closeProject(f.project); release();
  await assert.rejects(pending, /Projeto alterado/);
  assert.equal(host.watchers.length, 0); assert.equal(host.activeRoot, null);
});

test('troca de projeto invalida leitura pendente e não observa o anterior', async t => {
  const f = fixture(t), other = path.join(f.base, 'other'); fs.mkdirSync(other);
  watchHarness(t);
  const dir = projectPlugins(f.project); projectPlugins(other); write(dir, 'example', v2());
  const canonicalDir = await fs.promises.realpath(dir);
  const host = f.host(() => {}), opendir = fs.promises.opendir;
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { started = resolve; });
  const spy = mock.method(fs.promises, 'opendir', async (...args) => { if (args[0] === canonicalDir) { started(); await waiting; } return opendir(...args); });
  t.after(() => spy.mock.restore());
  const pending = host.listPlugins(f.project); await seen;
  const second = await host.listPlugins(other); release();
  await assert.rejects(pending, /Projeto alterado/);
  assert.deepEqual(second.plugins, []); assert.equal(host.activeRoot, await fs.promises.realpath(other));
  await assert.rejects(host.pluginSpec(f.project, 'example', 'hello'), /selecionado/);
});

test('fechar enquanto os observadores são criados não os reativa', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project), canonical = await fs.promises.realpath(plugins);
  watchHarness(t);
  const host = f.host(() => {}), watch = host._watch.bind(host);
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { started = resolve; });
  const spy = mock.method(host, '_watch', async (...args) => {
    if (args[2].some(entry => entry.dir === canonical)) { started(); await waiting; }
    return watch(...args);
  });
  t.after(() => spy.mock.restore());
  const pending = host.listPlugins(f.project); await seen; host.closeProject(f.project); release();
  await assert.rejects(pending, /Projeto alterado/);
  assert.equal(host.watchers.length, 0); assert.equal(host.activeRoot, null);
});

test('erro do sistema de observação libera recursos e informa recarga manual', async t => {
  const f = fixture(t); projectPlugins(f.project);
  const watchers = watchHarness(t), notifications = [];
  const host = f.host(event => { notifications.push(event); renderer.changed(event); });
  const renderer = rendererPlugins(host, f.project);
  t.after(() => renderer.panel.destroy());
  await renderer.panel.setProject(f.project); assert.equal(watchers.length, 3);
  watchers[0].emit('error', new Error('watch indisponível'));
  assert.ok(watchers.every(watcher => watcher.closed)); assert.equal(notifications.length, 1);
  await renderer.settled();
  assert.match(renderer.errorText(), /Recarregar/);
  assert.equal(host.watchers.length, 0); assert.equal(watchers.length, 3);
  watchers[0].emit('error', new Error('erro tardio'));
  await delay(400);
  assert.equal(notifications.length, 1); assert.match(renderer.errorText(), /Recarregar/);
  renderer.refresh.events.click();
  await until(() => !renderer.refresh.disabled);
  assert.equal(renderer.errorText(), ''); assert.equal(host.watchers.length, 3); assert.equal(host.watchFailure, null);
  watchers[3].emit('error', new Error('watch ainda indisponível'));
  await renderer.settled();
  await delay(400);
  assert.equal(notifications.length, 2); assert.equal(watchers.length, 6);
  assert.equal(host.watchers.length, 0); assert.match(renderer.errorText(), /Recarregar/);
});

test('erro ao montar observadores impede criação dos restantes', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project);
  write(plugins, 'example', v2());
  const folder = await fs.promises.realpath(path.join(plugins, 'example'));
  const host = f.host(() => {}), watch = host._watch.bind(host), watchers = [];
  let release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { started = resolve; });
  const statSpy = mock.method(host, '_watch', async (...args) => {
    if (args[2].some(entry => entry.dir === folder)) { started(); await waiting; }
    return watch(...args);
  });
  const watchSpy = mock.method(fs, 'watch', () => {
    const watcher = new EventEmitter(); watcher.closed = false; watcher.close = () => { watcher.closed = true; }; watchers.push(watcher); return watcher;
  });
  t.after(() => { statSpy.mock.restore(); watchSpy.mock.restore(); });
  const pending = host.listPlugins(f.project);
  await seen; assert.equal(watchers.length, 3);
  watchers[0].emit('error', new Error('watch indisponível'));
  release();
  const result = await pending;
  assert.equal(watchers.length, 3); assert.ok(watchers.every(watcher => watcher.closed)); assert.equal(host.watchers.length, 0);
  assert.ok(result.errors.some(error => /Recarregar/.test(error)));
});

test('identidade autorizada recusa troca por link antes do realpath, sem plugins de B', async t => {
  const f = fixture(t), other = path.join(f.base, 'other'); fs.mkdirSync(other);
  write(projectPlugins(other), 'foreign', v2('foreign'));
  const identity = projectIdentity(f.project), realpath = fs.promises.realpath;
  const host = f.host(() => {});
  let swapped = false;
  const spy = mock.method(fs.promises, 'realpath', async (...args) => {
    if (args[0] === f.project && !swapped) {
      swapped = true;
      fs.renameSync(f.project, `${f.project}-original`);
      fs.symlinkSync(other, f.project, 'dir');
    }
    return realpath(...args);
  });
  t.after(() => spy.mock.restore());
  await assert.rejects(host.listPlugins(f.project, identity), /O projeto mudou durante a leitura/);
  assert.equal(swapped, true); assert.equal(host.records.size, 0); assert.equal(host.watchers.length, 0);
  assert.equal(host.activeRoot, null);
});

test('identidade autorizada é conferida novamente antes de devolver a lista', async t => {
  const f = fixture(t), identity = projectIdentity(f.project);
  const watchers = watchHarness(t);
  write(projectPlugins(f.project), 'example', v2());
  const host = f.host(() => {}), read = host._readRoot.bind(host);
  mock.method(host, '_readRoot', async (...args) => {
    await read(...args);
    if (args[0].origin === 'project') {
      fs.renameSync(f.project, `${f.project}-original`);
      fs.mkdirSync(f.project); // Same real path, different dev/ino.
    }
  });
  await assert.rejects(host.listPlugins(f.project, identity), /O projeto mudou durante a leitura/);
  assert.equal(host.records.size, 0); assert.equal(host.watchers.length, 0); assert.equal(host.activeRoot, null);
  assert.ok(watchers.length > 0 && watchers.every(watcher => watcher.closed));
});

test('list e reload sobrepostos compartilham uma varredura por raiz autorizada', async t => {
  const f = fixture(t), identity = projectIdentity(f.project);
  write(projectPlugins(f.project), 'example', v2());
  const host = f.host(), read = host._readRoot.bind(host);
  let release, started, scans = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { started = resolve; });
  mock.method(host, '_readRoot', async (...args) => {
    if (args[0].origin === 'project') { scans++; started(); await waiting; }
    return read(...args);
  });
  const first = host.listPlugins(f.project, identity); await seen;
  const others = [host.listPlugins(f.project, { ...identity }), host.reloadPlugins(f.project, identity)];
  release();
  const results = await Promise.all([first, ...others]);
  assert.equal(scans, 1);
  for (const result of results) { assert.equal(result, results[0]); assert.equal(result.plugins[0].id, 'example'); }
});

test('edição durante a recarga é observada e relida uma vez para todos os solicitantes', async t => {
  const f = fixture(t), file = write(projectPlugins(f.project), 'example', v2());
  const watchers = watchHarness(t), host = f.host(() => {});
  await host.listPlugins(f.project);
  const watcher = watchers.find(item => item.dir === fs.realpathSync(path.dirname(file)));
  const read = host._readRoot.bind(host);
  let release, started, scans = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { started = resolve; });
  mock.method(host, '_readRoot', async (...args) => {
    await read(...args);
    if (args[0].origin === 'project' && ++scans === 1) { started(); await waiting; }
  });
  const first = host.reloadPlugins(f.project); await seen;
  assert.equal(watcher.closed, false);
  fs.writeFileSync(file, JSON.stringify(v2('example', { description: 'editado durante a leitura' })));
  watcher.change('change', 'plugin.json');
  const second = host.listPlugins(f.project);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(scans, 2); assert.equal(a, b);
  assert.equal(a.plugins[0].description, 'editado durante a leitura');
  assert.equal(watchers.length, 4); assert.equal(watcher.closed, false);
});

for (const ancestor of ['.dk', 'plugins']) test(`renomear ${ancestor} notifica e passa a observar o novo ancestral`, async t => {
  const f = fixture(t), plugins = projectPlugins(f.project);
  write(plugins, 'example', v2());
  const watchers = watchHarness(t);
  const events = [], host = f.host(event => events.push(event));
  await host.listPlugins(f.project);
  const dir = ancestor === '.dk' ? path.join(f.project, '.dk') : plugins;
  const parent = watchers.find(item => item.dir === fs.realpathSync(path.dirname(dir)));
  const original = [...watchers];
  fs.renameSync(dir, path.join(f.base, 'old-ancestor'));
  const file = write(projectPlugins(f.project), 'replacement', v2('replacement'));
  parent.change('rename', ancestor);
  await until(() => events.length === 1);
  const result = await host.listPlugins(f.project);
  assert.deepEqual(result.plugins.map(plugin => plugin.id), ['replacement']);
  assert.equal(host.watchers.length, 4);
  const replaced = fs.realpathSync(dir);
  assert.ok(original.filter(item => item.dir === replaced || item.dir.startsWith(replaced + path.sep)).every(item => item.closed));
  fs.writeFileSync(file, JSON.stringify(v2('replacement', { description: 'novo ancestral observado' })));
  watchers.find(item => !item.closed && item.dir === fs.realpathSync(path.dirname(file))).change('change', 'plugin.json');
  await until(() => events.length === 2);
  assert.equal((await host.listPlugins(f.project)).plugins[0].description, 'novo ancestral observado');
});

test('ancestrais filtram nomes irrelevantes e respeitam 35 watchers ao substituir as 32 pastas', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project), events = [];
  for (let i = 0; i < 32; i++) write(plugins, `dir-${i}`, v2(`item-${i}`));
  const watchers = watchHarness(t), host = f.host(event => events.push(event));
  await host.listPlugins(f.project);
  assert.equal(host.watchers.length, 35);
  const rootWatcher = watchers.find(item => item.dir === fs.realpathSync(f.project));
  const dkWatcher = watchers.find(item => item.dir === fs.realpathSync(path.join(f.project, '.dk')));
  rootWatcher.change('change', 'README.md'); dkWatcher.change('change', 'projeto.json');
  assert.equal(host.timer, null);
  rootWatcher.change('rename', '.dk'); dkWatcher.change('rename', 'plugins');
  await until(() => events.length === 1);
  for (let i = 0; i < 32; i++) {
    fs.rmSync(path.join(plugins, `dir-${i}`), { recursive: true });
    write(plugins, `new-${i}`, v2(`new-${i}`));
  }
  const result = await host.reloadPlugins(f.project);
  assert.equal(host.watchers.length, 35); assert.equal(result.plugins.length, 32); assert.deepEqual(result.errors, []);
  assert.ok(watchers.filter(item => item.dir.includes(`${path.sep}dir-`)).every(item => item.closed));
});

test('Recarregar tenta observar novamente após falha na criação e mantém fallback se falhar', async t => {
  const f = fixture(t); projectPlugins(f.project);
  let attempts = 0, failing = true;
  const spy = mock.method(fs, 'watch', () => {
    attempts++;
    if (failing) throw new Error('indisponível');
    const watcher = new EventEmitter(); watcher.close = () => {}; return watcher;
  });
  t.after(() => spy.mock.restore());
  const host = f.host(() => {});
  assert.match((await host.listPlugins(f.project)).errors.join(), /Recarregar/);
  assert.equal(attempts, 1);
  assert.match((await host.reloadPlugins(f.project)).errors.join(), /Recarregar/);
  assert.equal(attempts, 2);
  failing = false;
  assert.deepEqual((await host.reloadPlugins(f.project)).errors, []);
  assert.equal(host.watchers.length, 3); assert.equal(attempts, 5);
});

test('IPC exige projeto ativo para executar e mantém list/reload, split e terminal:start', async t => {
  const f = fixture(t), other = path.join(f.base, 'other'); fs.mkdirSync(other);
  write(projectPlugins(f.project), 'example', v2());
  write(projectPlugins(other), 'foreign', v2('foreign'));
  const a = fs.realpathSync(f.project), b = fs.realpathSync(other);
  const { context, sessions, prompts, call } = mainHandlers(t, f);
  context.remember(a); context.remember(b);
  const listed = await call('plugin:list', a), revision = listed.plugins[0].revision;
  await assert.rejects(call('plugin:execute', a, 'example', 'hello', revision), /Selecione o projeto/);
  await call('project:activate', b);
  await call('project:set-active', b);
  assert.equal((await call('plugin:reload', a)).plugins[0].id, 'example');
  await assert.rejects(call('plugin:execute', a, 'example', 'hello', revision), /Selecione o projeto/);
  assert.equal(prompts.length, 0); assert.equal(sessions.size, 0);
  await call('project:activate', a);
  await call('project:set-active', a);
  const original = await call('plugin:execute', a, 'example', 'hello', revision);
  assert.equal(original.cwd, a); assert.equal(prompts.length, 1);
  await call('project:activate', b);
  await call('project:set-active', b);
  assert.equal((await call('terminal:start', original.id, { cols: 80, rows: 24 })).state, 'running');
  const split = await call('terminal:split', a, original.id);
  assert.equal(split.cwd, a); assert.equal(prompts.length, 2);
  assert.equal((await call('terminal:start', split.id, { cols: 80, rows: 24 })).state, 'running');
  await call('project:activate', a);
  await call('project:set-active', a);
  await call('project:close-sessions', a);
  await assert.rejects(call('plugin:execute', a, 'example', 'hello', revision), /Selecione o projeto/);
});

test('IPC recusa execução se o projeto ativo mudar durante a confirmação', async t => {
  const f = fixture(t), other = path.join(f.base, 'other'); fs.mkdirSync(other);
  write(projectPlugins(f.project), 'example', v2());
  const a = fs.realpathSync(f.project), b = fs.realpathSync(other);
  const { context, sessions, call } = mainHandlers(t, f);
  context.remember(a); context.remember(b);
  await call('project:activate', a);
  await call('project:set-active', a);
  const revision = (await call('plugin:list', a)).plugins[0].revision;
  context.dialog.showMessageBox = async () => { await call('project:activate', b); await call('project:set-active', b); return { response: 1 }; };
  await assert.rejects(call('plugin:execute', a, 'example', 'hello', revision), /O projeto selecionado mudou/);
  assert.equal(sessions.size, 0);
});

for (const [label, disk, input] of [
  ['caixa diferente', 'CaseProj', 'caseproj'],
  ['entrada NFD e disco NFC', 'Projeção'.normalize('NFC'), 'Projeção'.normalize('NFD')],
  ['entrada NFC e disco NFD', 'Projeção'.normalize('NFD'), 'Projeção'.normalize('NFC')],
]) test(`IPC aceita identidade do mesmo diretório com ${label}`, async t => {
  const f = fixture(t), directory = path.join(f.base, disk), requested = path.join(f.base, input);
  fs.mkdirSync(directory);
  if (!fs.existsSync(requested)) return t.skip(`O sistema de arquivos distingue ${label}.`);
  assert.equal(fs.statSync(directory).ino, fs.statSync(requested).ino);
  write(projectPlugins(directory), 'example', v2());
  const { context, prompts, call } = mainHandlers(t, f), info = context.remember(requested);
  const identity = vm.runInContext('pluginProjectIdentities', context).get(info.path);
  const canonical = fs.realpathSync.native(requested);
  assert.equal(identity.realpath, canonical);
  await call('project:activate', info.path);
  await call('project:set-active', info.path);
  const listed = await call('plugin:list', info.path);
  assert.deepEqual(listed.errors, []); assert.equal(listed.plugins[0].id, 'example');
  assert.equal(context.extensions.activeRoot, canonical);
  assert.deepEqual((await call('plugin:reload', info.path)).errors, []);
  const session = await call('plugin:execute', info.path, 'example', 'hello', listed.plugins[0].revision);
  assert.equal(prompts.length, 1); assert.equal(session.cwd, info.path);
  assert.equal((await call('terminal:start', session.id, { cols: 80, rows: 24 })).state, 'running');
  // Older callers may still carry the input spelling; dev/ino is the identity.
  const host = f.host(), legacyIdentity = { ...identity, realpath: info.path };
  assert.deepEqual((await host.listPlugins(info.path, legacyIdentity)).errors, []);
  assert.equal(host.activeRoot, canonical);
  const watchers = watchHarness(t), notifications = [];
  const watched = f.host(event => notifications.push(event));
  await watched.listPlugins(info.path, identity);
  watchers.find(watcher => watcher.dir === canonical).change('rename', '.dk');
  await until(() => notifications.length === 1);
  assert.equal(notifications[0].path, info.path);
});

test('identidade usa dev/ino mesmo quando o realpath registrado tem outra grafia', async t => {
  const f = fixture(t), identity = projectIdentity(f.project), host = f.host();
  write(projectPlugins(f.project), 'example', v2());
  identity.realpath = path.join(f.base, 'PROJECT');
  const listed = await host.listPlugins(f.project, identity);
  assert.deepEqual(listed.errors, []); assert.equal(listed.plugins[0].id, 'example');
  assert.equal(host.activeRoot, fs.realpathSync.native(f.project));
});

test('Esc no launcher abandona a preparação sem trocar o projeto ativo', async t => {
  const f = fixture(t), other = path.join(f.base, 'other'); fs.mkdirSync(other);
  write(projectPlugins(f.project), 'example', v2());
  const { context, call } = mainHandlers(t, f);
  const a = context.remember(f.project), b = context.remember(other), renderer = rendererActivation(call);
  await renderer.activate(a);
  let release, prepared;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { prepared = resolve; });
  const source = fs.readFileSync(path.join(__dirname, '../src/launcher.ts'), 'utf8');
  const method = source.match(/^  private async openAndActivate\([^\n]*[\s\S]*?^  }/m);
  assert.ok(method);
  const open = vm.runInNewContext(stripTypeScriptTypes(`(${method[0].trim().replace('private async ', 'async function ')})`));
  let revision = 0, activations = 0;
  const launcher = { captureState: () => revision, isCurrent: value => value === revision,
    completeOpen() { assert.fail('A abertura abandonada não pode concluir'); },
    options: { beginProjectIntent: () => renderer.beginProjectIntent(), rememberProject() {}, notify() {},
      async activateProject(info, intent) { activations++; return renderer.activate(info, intent); },
    },
  };
  const pending = open.call(launcher, async () => { const info = await call('project:activate', b.path); prepared(); await gate; return info; });
  await seen; revision++; release(); await pending;
  assert.equal(activations, 0); assert.equal(renderer.current.path, a.path);
  const listed = await call('plugin:list', a.path);
  assert.equal((await call('plugin:execute', a.path, 'example', 'hello', listed.plugins[0].revision)).cwd, a.path);
});

for (const reason of ['intent superada', 'projeto encerrando']) test(`activate abandonada por ${reason} preserva o ativo`, async t => {
  const f = fixture(t), other = path.join(f.base, 'other'); fs.mkdirSync(other);
  write(projectPlugins(f.project), 'example', v2());
  const { context, call } = mainHandlers(t, f);
  const a = context.remember(f.project), b = context.remember(other), renderer = rendererActivation(call);
  await renderer.activate(a);
  let release, prepared;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { prepared = resolve; });
  renderer.api.activateProject = async root => {
    const info = await call('project:activate', root);
    if (root === b.path) { prepared(); await gate; }
    return info;
  };
  const pending = renderer.activate(b); await seen;
  if (reason === 'intent superada') await renderer.activate(a);
  else renderer.closingProjects.add(b.path);
  release();
  if (reason === 'intent superada') assert.equal(await pending, false);
  else await assert.rejects(pending, /encerramento/);
  assert.equal(renderer.current.path, a.path);
  const listed = await call('plugin:list', a.path);
  assert.equal((await call('plugin:execute', a.path, 'example', 'hello', listed.plugins[0].revision)).cwd, a.path);
});

for (const switchProject of [false, true]) test(`falha ao fechar sessões preserva ${switchProject ? 'nova seleção' : 'projeto ativo'}`, async t => {
  const f = fixture(t), other = path.join(f.base, 'other'); fs.mkdirSync(other);
  write(projectPlugins(f.project), 'example', v2()); write(projectPlugins(other), 'example', v2());
  const { context, call } = mainHandlers(t, f);
  const a = context.remember(f.project), b = context.remember(other), renderer = rendererActivation(call);
  await renderer.activate(a);
  let reject, started;
  const gate = new Promise((_, fail) => { reject = fail; });
  const seen = new Promise(resolve => { started = resolve; });
  context.terminals.closeProject = () => { started(); return gate; };
  const closing = call('project:close-sessions', a.path); await seen;
  await assert.rejects(call('project:set-active', a.path), /Abra o projeto/);
  if (switchProject) await renderer.activate(b);
  reject(new Error('Falha simulada no fechamento'));
  await assert.rejects(closing, /Falha simulada/);
  const active = switchProject ? b : a;
  assert.equal(renderer.current.path, active.path);
  const listed = await call('plugin:list', active.path);
  assert.equal((await call('plugin:execute', active.path, 'example', 'hello', listed.plugins[0].revision)).cwd, active.path);
});

for (const channel of ['plugin:list', 'plugin:reload']) test(`${channel} passa ao host a identidade autorizada antes da troca por link`, async t => {
  const f = fixture(t), other = path.join(f.base, 'other'); fs.mkdirSync(other);
  write(projectPlugins(other), 'foreign', v2('foreign'));
  const a = fs.realpathSync(f.project), { context, call } = mainHandlers(t, f);
  context.remember(a);
  const realpath = fs.promises.realpath;
  let swapped = false;
  const spy = mock.method(fs.promises, 'realpath', async (...args) => {
    if (args[0] === a && !swapped) {
      swapped = true; fs.renameSync(a, `${a}-original`); fs.symlinkSync(other, a, 'dir');
    }
    return realpath(...args);
  });
  t.after(() => spy.mock.restore());
  await assert.rejects(call(channel, a), /O projeto mudou durante a leitura/);
  assert.equal(swapped, true); assert.equal(context.extensions.records.size, 0);
});
