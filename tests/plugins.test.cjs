const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
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
  const notifications = [], host = f.host(event => notifications.push(event));
  await host.listPlugins(f.project);
  assert.ok(host.watchers.length >= 2); assert.ok(host.watchers.length <= 33);
  fs.writeFileSync(file, JSON.stringify(v2('example', { description: 'primeira' })));
  await delay(60);
  fs.writeFileSync(file, JSON.stringify(v2('example', { description: 'segunda' })));
  await until(() => notifications.length > 0);
  await delay(400); assert.equal(notifications.length, 1); assert.equal(notifications[0].path, await fs.promises.realpath(f.project));
  fs.writeFileSync(file, JSON.stringify(v2('example', { description: 'terceira' })));
  await delay(40); host.closeProject(f.project);
  assert.equal(host.watchers.length, 0); assert.equal(host.timer, null);
  await delay(400); assert.equal(notifications.length, 1);
});

test('fechar projeto cancela leitura pendente sem recriar observadores', async t => {
  const f = fixture(t); projectPlugins(f.project);
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
  const host = f.host(() => {}), lstat = fs.promises.lstat;
  let release, started, visits = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { started = resolve; });
  const spy = mock.method(fs.promises, 'lstat', async (...args) => {
    if (args[0] === canonical && ++visits === 3) { started(); await waiting; }
    return lstat(...args);
  });
  t.after(() => spy.mock.restore());
  const pending = host.listPlugins(f.project); await seen; host.closeProject(f.project); release();
  await assert.rejects(pending, /Projeto alterado/);
  assert.equal(host.watchers.length, 0); assert.equal(host.activeRoot, null);
});

test('erro do sistema de observação libera recursos e informa recarga manual', async t => {
  const f = fixture(t); projectPlugins(f.project);
  const watchers = [], notifications = [];
  const spy = mock.method(fs, 'watch', () => {
    const watcher = new EventEmitter(); watcher.closed = false; watcher.close = () => { watcher.closed = true; }; watchers.push(watcher); return watcher;
  });
  t.after(() => spy.mock.restore());
  const host = f.host(event => notifications.push(event));
  await host.listPlugins(f.project); assert.ok(watchers.length);
  watchers[0].emit('error', new Error('watch indisponível'));
  assert.ok(watchers.every(watcher => watcher.closed)); assert.equal(notifications.length, 1);
  const result = await host.reloadPlugins(f.project);
  assert.ok(result.errors.some(error => /recarga|Recarregar/.test(error))); assert.equal(host.watchers.length, 0);
});

test('erro ao montar observadores impede criação dos restantes', async t => {
  const f = fixture(t), plugins = projectPlugins(f.project);
  write(plugins, 'example', v2());
  const folder = await fs.promises.realpath(path.join(plugins, 'example'));
  const stat = fs.promises.lstat, watchers = [];
  let release, started, visits = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { started = resolve; });
  const statSpy = mock.method(fs.promises, 'lstat', async (...args) => {
    if (args[0] === folder && ++visits === 4) { started(); await waiting; }
    return stat(...args);
  });
  const watchSpy = mock.method(fs, 'watch', () => {
    const watcher = new EventEmitter(); watcher.closed = false; watcher.close = () => { watcher.closed = true; }; watchers.push(watcher); return watcher;
  });
  t.after(() => { statSpy.mock.restore(); watchSpy.mock.restore(); });
  const host = f.host(() => {}), pending = host.listPlugins(f.project);
  await seen; assert.equal(watchers.length, 1);
  watchers[0].emit('error', new Error('watch indisponível'));
  release();
  const result = await pending;
  assert.equal(watchers.length, 1); assert.equal(watchers[0].closed, true); assert.equal(host.watchers.length, 0);
  assert.ok(result.errors.some(error => /Recarregar/.test(error)));
});
