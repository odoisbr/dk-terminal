const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Catalogs, parseFrontmatter, stageGate, inside } = require('../electron/catalogs.cjs');

const fixtures = path.join(__dirname, 'fixtures', 'catalogs');
async function fixture(t, changed) {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dk-catalogs-'));
  const root = path.join(base, 'project'), kit = { path: path.join(base, 'kit'), version: '1.7.0-rc.14' };
  await fs.promises.mkdir(root);
  await fs.promises.cp(path.join(fixtures, 'kit-minimo'), kit.path, { recursive: true });
  const host = new Catalogs(changed);
  t.after(async () => { host.close(); await fs.promises.rm(base, { recursive: true, force: true }); });
  return { base, root, kit, host };
}
async function write(root, relative, text) {
  const file = path.join(root, relative);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, typeof text === 'string' ? text : JSON.stringify(text));
  return file;
}
function cat(snapshot, id = 'kit-skills') { return snapshot.catalogs.find(item => item.id === id); }
function plugin(base, id = 'example', contributions) {
  return { file: path.join(base, 'plugin.json'), boundary: base, item: { id, name: `Nome ${id}`, contributes: { catalogs: contributions || [
    { id: 'skills', kind: 'skills', source: 'plugin', path: 'skills' },
  ] } } };
}
async function until(condition) {
  const deadline = Date.now() + 8000;
  while (!condition() && Date.now() < deadline) await delay(25);
  assert.ok(condition(), 'O evento esperado não chegou dentro do prazo.');
}
function pauseNextOpen(t) {
  const original = fs.promises.open;
  let entered, resume, blocked = false;
  const opened = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { resume = resolve; });
  t.mock.method(fs.promises, 'open', async function (...args) {
    if (!blocked) { blocked = true; entered(); await barrier; }
    return original.apply(this, args);
  });
  return { opened, resume };
}

test('list+list e list+read concorrentes na mesma raiz completam sem se invalidar', async t => {
  for (const operation of ['list', 'read']) await t.test(operation, async t => {
    const f = await fixture(t), pause = pauseNextOpen(t);
    const first = f.host.list(f.root, { kit: f.kit });
    await pause.opened;
    const second = operation === 'list' ? f.host.list(f.root, { kit: f.kit }) : f.host.read(f.root, 'kit-skills', 'dk-entender');
    const settled = Promise.allSettled([first, second]);
    pause.resume();
    const results = await settled;
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
    assert.equal(cat(results[0].value).entries.length, 3);
    if (operation === 'list') {
      assert.deepEqual(results[0].value, results[1].value);
      assert.notEqual(results[0].value, results[1].value);
    } else assert.equal(results[1].value.text, 'Porta de entendimento.\n');
  });
});

test('read em andamento sobrevive a list com refresh da mesma raiz', async t => {
  const f = await fixture(t);
  await f.host.list(f.root, { kit: f.kit });
  const pause = pauseNextOpen(t), reading = f.host.read(f.root, 'kit-skills', 'dk-entender');
  await pause.opened;
  const listing = f.host.list(f.root, { kit: f.kit, refresh: true });
  const settled = Promise.allSettled([reading, listing]);
  pause.resume();
  const results = await settled;
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.equal(results[0].value.text, 'Porta de entendimento.\n');
  assert.equal(cat(results[1].value).entries.length, 3);
});

test('troca A/B/A cancela operações antigas e enfileiradas, preservando o novo cache', async t => {
  const f = await fixture(t), second = path.join(f.base, 'B');
  await fs.promises.mkdir(second);
  const pause = pauseNextOpen(t), first = f.host.list(f.root, { kit: f.kit });
  await pause.opened;
  const queued = f.host.list(f.root, { kit: f.kit });
  const settled = Promise.allSettled([first, queued]);
  const b = await f.host.list(second);
  assert.deepEqual(cat(b, 'project-design').entries, []);
  const latest = await f.host.list(f.root);
  const latestCache = f.host.cache, latestWatchers = [...f.host.watchers];
  pause.resume();
  for (const result of await settled) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /Projeto alterado durante a leitura/);
  }
  assert.equal(cat(latest), undefined);
  assert.equal(f.host.cache, latestCache); assert.deepEqual(f.host.watchers, latestWatchers);
});

test('recálculo por refresh ou read entrega catalog:changed pendente uma única vez', async t => {
  for (const operation of ['refresh', 'read']) await t.test(operation, async t => {
    const events = [], f = await fixture(t, event => events.push(event));
    t.mock.method(fs, 'watch', () => {
      const watcher = new EventEmitter(); watcher.close = () => {}; return watcher;
    });
    await f.host.list(f.root, { kit: f.kit });
    f.host.invalidate(f.root); f.host.invalidate(f.root);
    if (operation === 'refresh') await f.host.list(f.root, { kit: f.kit, refresh: true });
    else await f.host.read(f.root, 'kit-skills', 'dk-entender');
    assert.deepEqual(events, [{ path: f.root }]);
    await delay(500);
    assert.deepEqual(events, [{ path: f.root }]);
    await f.host.list(f.root, { kit: f.kit });
    assert.deepEqual(events, [{ path: f.root }]);
  });
});

test('caminhos da base aceitam barra final e ponto como no kit, normalizando a leitura', async t => {
  const f = await fixture(t);
  await fs.promises.cp(path.join(fixtures, 'project-design'), f.root, { recursive: true });
  const file = path.join(f.root, '.dk', 'projeto.json');
  const value = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  value.prototipo.pasta = 'prototipo/';
  value.prototipo.design_system.caminho = './design-system';
  value.prototipo.design_system.carga = ['./base.css'];
  await write(f.root, '.dk/projeto.json', value);
  const declared = cat(await f.host.list(f.root), 'project-design').entries[0];
  assert.deepEqual(declared.errors, []);
  assert.equal(declared.path, 'design-system/DESIGN.md');
  assert.equal((await f.host.read(f.root, 'project-design', 'declarado')).text, 'Corpo do design system.\n');
  for (const invalid of ['', '   ', '/design-system', '../design-system', 'design-system/../design-system', 'design-system\\..\\fora', 'design-system\u0001']) {
    value.prototipo.design_system.caminho = invalid;
    await write(f.root, '.dk/projeto.json', value);
    const entry = cat(await f.host.list(f.root), 'project-design').entries[0];
    assert.ok(entry.errors.some(error => error.startsWith('design_system.caminho:')), JSON.stringify(invalid));
    await assert.rejects(f.host.read(f.root, 'project-design', 'declarado'), /design_system.caminho/);
  }
});

test('20 skills usam só watchers das origens e mudanças internas são revalidadas por stamps', async t => {
  const events = [], f = await fixture(t, event => events.push(event)), pluginRoot = path.join(f.base, 'plugin');
  for (let i = 0; i < 20; i++) await write(pluginRoot, `skills/item-${i}/SKILL.md`, 'inicial');
  const watched = [];
  t.mock.method(fs, 'watch', (dir, options, callback) => {
    watched.push({ dir, options, callback });
    const watcher = new EventEmitter(); watcher.close = () => {}; return watcher;
  });
  const result = await f.host.list(f.root, { plugins: [plugin(pluginRoot)] });
  assert.equal(result.watching, true);
  assert.equal(cat(result, 'plugin:example/skills').entries.length, 20);
  assert.deepEqual(watched.map(watch => watch.dir).sort(), [f.root, path.join(pluginRoot, 'skills')].sort());
  assert.equal(watched.find(watch => watch.dir === f.root).options.recursive, false);
  assert.equal(watched.find(watch => watch.dir === path.join(pluginRoot, 'skills')).options.recursive, true);
  await write(pluginRoot, 'skills/item-0/SKILL.md', '---\ndescription: alterado\n---\ncorpo novo');
  // Nenhum evento: a leitura ainda precisa perceber a mudança no arquivo.
  assert.equal((await f.host.read(f.root, 'plugin:example/skills', 'item-0')).text, 'corpo novo');
  assert.equal(cat(await f.host.list(f.root, { plugins: [plugin(pluginRoot)] }), 'plugin:example/skills').entries[0].description, 'alterado');
  const sourceWatch = watched.findLast(watch => watch.dir === path.join(pluginRoot, 'skills'));
  sourceWatch.callback('change', 'item-0/SKILL.md');
  await until(() => events.length === 1);
  assert.deepEqual(events, [{ path: f.root }]);
});

test('watcher nativo de uma origem com 20 skills detecta alteração interna', async t => {
  const events = [], f = await fixture(t, event => events.push(event)), pluginRoot = path.join(f.base, 'plugin');
  for (let i = 0; i < 20; i++) await write(pluginRoot, `skills/item-${i}/SKILL.md`, 'inicial');
  const result = await f.host.list(f.root, { plugins: [plugin(pluginRoot)] });
  assert.equal(result.watching, true); assert.equal(f.host.watchers.length, 2);
  await write(pluginRoot, 'skills/item-0/SKILL.md', 'alterado');
  await until(() => events.length > 0);
  assert.equal((await f.host.read(f.root, 'plugin:example/skills', 'item-0')).text, 'alterado');
});

test('watchers ignoram código e metadados; referências emitem uma vez por alteração', async t => {
  const events = [], f = await fixture(t, event => events.push(event));
  const watched = new Map();
  t.mock.method(fs, 'watch', (dir, options, callback) => {
    watched.set(dir, { options, callback });
    const watcher = new EventEmitter(); watcher.close = () => {}; return watcher;
  });
  const changed = file => {
    const dir = [...watched.keys()].filter(dir => inside(dir, file)).sort((a, b) => b.length - a.length)[0];
    watched.get(dir).callback('change', path.relative(dir, file));
  };
  await fs.promises.cp(path.join(fixtures, 'project-design'), f.root, { recursive: true });
  const pluginRoot = path.join(f.base, 'plugin');
  const plugins = [plugin(pluginRoot), plugin(f.root, 'local', [
    { id: 'skills', kind: 'skills', source: 'project', path: 'referencias' },
  ])];
  const ignored = ['src/deep/app.js', '.git/index', 'node_modules/deep/index.js'].map(file => path.join(f.root, file));
  for (const source of [path.join(f.root, 'design-system'), path.join(f.root, 'referencias'), path.join(pluginRoot, 'skills')]) {
    for (const segment of ['.git', 'node_modules']) {
      ignored.push(path.join(source, 'nested', segment, 'deep', 'index'));
    }
  }
  for (const file of ignored) await write(path.dirname(file), path.basename(file), 'inicial');
  await write(pluginRoot, 'skills/item/SKILL.md', 'inicial');
  const skill = await write(f.root, 'referencias/item/SKILL.md', 'inicial');
  await f.host.list(f.root, { plugins });
  assert.deepEqual([...watched.keys()].sort(), [f.root, path.join(f.root, '.dk'), path.join(f.root, 'design-system'),
    path.join(f.root, 'referencias'), path.join(pluginRoot, 'skills')].sort());
  for (const [dir, { options }] of watched) {
    assert.equal(options.recursive, dir !== f.root && dir !== path.join(f.root, '.dk'), dir);
  }
  const cache = f.host.cache;
  for (const file of ignored) { await fs.promises.writeFile(file, 'alterado'); changed(file); }
  for (const name of ['src', '.git', 'node_modules', null]) watched.get(f.root).callback('rename', name);
  await delay(500);
  assert.deepEqual(events, []); assert.equal(f.host.dirty, false);
  await f.host.list(f.root, { plugins }); assert.equal(f.host.cache, cache);
  for (const file of ['DESIGN.md', '.dk/projeto.json', 'design-system/DESIGN.md', skill, path.join(pluginRoot, 'skills/item/SKILL.md')]) {
    const target = path.resolve(f.root, file);
    await fs.promises.appendFile(target, '\n');
    changed(target); changed(target);
    await until(() => events.length > 0); await delay(500);
    assert.deepEqual(events, [{ path: f.root }], file);
    events.length = 0;
    await f.host.list(f.root, { plugins });
  }
});

test('watchers antigos da mesma raiz não afetam a geração atual', async t => {
  const events = [], f = await fixture(t, event => events.push(event)), watched = [];
  t.mock.method(fs, 'watch', (_dir, _options, callback) => {
    const watcher = new EventEmitter(); watcher.close = () => {}; watched.push({ watcher, callback }); return watcher;
  });
  await f.host.list(f.root, { kit: f.kit });
  const previous = watched[0];
  await f.host.list(f.root, { kit: f.kit, refresh: true });
  const currentWatchers = [...f.host.watchers];
  previous.callback('change', 'DESIGN.md');
  previous.watcher.emit('error', new Error('evento atrasado'));
  await delay(500);
  assert.deepEqual(events, []); assert.deepEqual(f.host.watchers, currentWatchers);
  assert.equal((await f.host.list(f.root, { kit: f.kit })).watching, true);
});

test('sem suporte recursivo mantém watcher da origem e revalida arquivos por stamps', async t => {
  const f = await fixture(t, () => {}), watched = [];
  t.mock.method(fs, 'watch', (dir, options) => {
    watched.push({ dir, options });
    if (options.recursive) throw Object.assign(new Error('sem suporte'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
    const watcher = new EventEmitter(); watcher.close = () => {}; return watcher;
  });
  await fs.promises.cp(path.join(fixtures, 'project-design'), f.root, { recursive: true });
  assert.equal((await f.host.list(f.root)).watching, true);
  assert.deepEqual(watched, [
    { dir: f.root, options: { persistent: false, recursive: false } },
    { dir: path.join(f.root, '.dk'), options: { persistent: false, recursive: false } },
    { dir: path.join(f.root, 'design-system'), options: { persistent: false, recursive: true } },
    { dir: path.join(f.root, 'design-system'), options: { persistent: false } },
  ]);
  await write(f.root, 'DESIGN.md', 'alterado');
  assert.equal((await f.host.read(f.root, 'project-design', 'raiz')).text, 'alterado');
});

test('kit-minimo listado com stage/gate e ordem; read retorna somente o corpo', async t => {
  const f = await fixture(t);
  const result = await f.host.list(f.root, { kit: f.kit });
  assert.deepEqual(result.kit, f.kit);
  assert.deepEqual(result.catalogs.map(item => item.id), ['kit-skills', 'project-design']);
  const skills = cat(result);
  assert.deepEqual(skills.origin, { type: 'kit', label: 'Kit' });
  assert.deepEqual(skills.entries.map(entry => entry.name), ['dk-entender', 'dk-entender-lacunas', 'dk-levantar']);
  assert.equal(skills.entries[0].gate, false);
  const entry = skills.entries[1];
  assert.equal(entry.id, 'kit-skills/dk-entender-lacunas');
  assert.equal(entry.path, 'dk-entender-lacunas/SKILL.md');
  assert.equal(entry.stage, 'entender'); assert.equal(entry.gate, true);
  assert.deepEqual(entry.errors, []);
  assert.ok(entry.bytes > 0); assert.ok(entry.mtimeMs > 0);
  assert.equal(entry.frontmatter.parser, 'yaml'); assert.equal(entry.frontmatter.ignored, undefined);
  const read = await f.host.read(f.root, 'kit-skills', entry.name);
  assert.equal(read.text, 'Corpo da skill de lacunas.\n');
  assert.equal(read.bytes, entry.bytes); assert.equal(read.frontmatter.name, entry.name);
  assert.deepEqual(skills.entries[0].frontmatter['allowed-tools'], ['Read', 'Glob']);
});

test('alias bomb → erro na entrada sem travar', async t => {
  const f = await fixture(t);
  await write(f.kit.path, 'skills/bomb/SKILL.md', await fs.promises.readFile(path.join(fixtures, 'alias-bomb.md'), 'utf8'));
  const start = performance.now(), result = await f.host.list(f.root, { kit: f.kit });
  const entry = cat(result).entries.find(item => item.name === 'bomb');
  assert.ok(performance.now() - start < 3000);
  assert.equal(entry.frontmatter.parser, 'regex'); assert.match(entry.errors.join(), /YAML inválido/);
  assert.equal(cat(result).entries.length, 4);
});

test('YAML inválido → parser regex com campos multilinha e corpo preservados', async t => {
  const f = await fixture(t);
  await write(f.kit.path, 'skills/quebrado/SKILL.md', await fs.promises.readFile(path.join(fixtures, 'yaml-invalido.md'), 'utf8'));
  const entry = cat(await f.host.list(f.root, { kit: f.kit })).entries.find(item => item.name === 'quebrado');
  assert.equal(entry.frontmatter.parser, 'regex');
  assert.equal(entry.description, '[sem fechamento');
  assert.equal(entry.frontmatter['argument-hint'], '>\n  projeto\n  raiz');
  assert.match(entry.errors.join(), /YAML inválido/);
  assert.equal((await f.host.read(f.root, 'kit-skills', 'quebrado')).text, 'Corpo preservado.\n');
});

test('65 KiB → erro e read recusado antes de abrir o arquivo', async t => {
  const f = await fixture(t), file = await write(f.kit.path, 'skills/grande/SKILL.md', 'x'.repeat(65 * 1024));
  const original = fs.promises.open; let opens = 0;
  t.mock.method(fs.promises, 'open', async function (target, ...args) { if (target === file) opens++; return original.call(this, target, ...args); });
  const entry = cat(await f.host.list(f.root, { kit: f.kit })).entries.find(item => item.name === 'grande');
  assert.deepEqual(entry.errors, ['Arquivo do catálogo excede 64 KiB.']);
  assert.equal(entry.bytes, 65 * 1024);
  await assert.rejects(f.host.read(f.root, 'kit-skills', 'grande'), { message: 'Arquivo do catálogo excede 64 KiB.' });
  assert.equal(opens, 0);
});

test('symlink para fora → recusado no arquivo, na pasta e na origem', async t => {
  const f = await fixture(t), external = path.join(f.base, 'external');
  await write(external, 'SKILL.md', 'segredo');
  await fs.promises.symlink(external, path.join(f.kit.path, 'skills', 'link'), 'dir');
  await fs.promises.mkdir(path.join(f.kit.path, 'skills', 'arquivo'));
  await fs.promises.symlink(path.join(external, 'SKILL.md'), path.join(f.kit.path, 'skills', 'arquivo', 'SKILL.md'));
  const result = await f.host.list(f.root, { kit: f.kit });
  assert.deepEqual(cat(result).entries.find(item => item.name === 'link').errors, ['Link simbólico recusado: link.']);
  assert.deepEqual(cat(result).entries.find(item => item.name === 'arquivo').errors, ['Link simbólico recusado: SKILL.md.']);
  await assert.rejects(f.host.read(f.root, 'kit-skills', 'link'), /Link simbólico recusado/);
  await assert.rejects(f.host.read(f.root, 'kit-skills', 'arquivo'), /Link simbólico recusado/);
  const record = plugin(f.root);
  await fs.promises.symlink(external, path.join(f.root, 'skills'), 'dir');
  const source = cat(await f.host.list(f.root, { plugins: [record] }), 'plugin:example/skills');
  assert.deepEqual(source.entries, []); assert.match(source.errors.join(), /Link simbólico recusado: skills/);
});

test('65 pastas → 64 + truncated, em ordem alfabética', async t => {
  const f = await fixture(t);
  await fs.promises.rm(path.join(f.kit.path, 'skills'), { recursive: true });
  for (let index = 64; index >= 0; index--) await write(f.kit.path, `skills/item-${String(index).padStart(2, '0')}/SKILL.md`, 'corpo');
  const source = cat(await f.host.list(f.root, { kit: f.kit }));
  assert.equal(source.entries.length, 64); assert.equal(source.truncated, true);
  assert.equal(source.entries[0].name, 'item-00'); assert.equal(source.entries.at(-1).name, 'item-63');
  assert.ok(source.errors.includes('mais de 64 itens; os demais não foram carregados'));
});

test('A não vaza em B; closeProject zera cache e watchers', async t => {
  const f = await fixture(t, () => {}), second = path.join(f.base, 'B');
  await fs.promises.mkdir(second);
  await write(f.root, 'DESIGN.md', 'somente A');
  const a = await f.host.list(f.root, { kit: f.kit });
  assert.equal(cat(a, 'project-design').entries.length, 1); assert.ok(f.host.watchers.length);
  const oldWatchers = [...f.host.watchers];
  const b = await f.host.list(second);
  assert.deepEqual(cat(b, 'project-design').entries, []); assert.equal(cat(b), undefined);
  await assert.rejects(f.host.read(f.root, 'project-design', 'raiz'), /Catálogo não encontrado/);
  assert.ok(oldWatchers.every(watcher => !f.host.watchers.includes(watcher)));
  f.host.closeProject(f.root); assert.equal(f.host.activeRoot, second);
  f.host.closeProject(second);
  assert.equal(f.host.cache, null); assert.equal(f.host.options, null); assert.equal(f.host.activeRoot, null); assert.equal(f.host.watchers.length, 0);
  await assert.rejects(f.host.read(second, 'project-design', 'raiz'), /Catálogo não encontrado/);
});

test('mudança emite um único catalog:changed; closeProject cancela eventos', async t => {
  const events = [], f = await fixture(t, event => events.push(event));
  const file = await write(f.root, 'DESIGN.md', 'inicial');
  const first = await f.host.list(f.root, { kit: f.kit });
  assert.equal(first.watching, true);
  for (let i = 0; i < 3; i++) { await fs.promises.writeFile(file, `corpo ${i}`); await delay(25); }
  await until(() => events.length > 0); await delay(500);
  assert.deepEqual(events, [{ path: f.root }]);
  assert.equal((await f.host.read(f.root, 'project-design', 'raiz')).text, 'corpo 2');
  f.host.closeProject(f.root);
  await fs.promises.writeFile(file, 'fechado'); await delay(550);
  assert.equal(events.length, 1);
});

test('kit ausente → erro, sem catálogo kit', async t => {
  const f = await fixture(t);
  for (const kit of [null, { path: path.join(f.base, 'ausente') }]) {
    const result = await f.host.list(f.root, { kit });
    assert.equal(result.kit, null); assert.equal(cat(result), undefined);
    assert.ok(result.errors.includes('Plugin DK não instalado; catálogo do kit indisponível.'));
    assert.ok(cat(result, 'project-design'));
  }
});

test('project-design válido/inválido/JSON corrompido; referências independentes', async t => {
  const f = await fixture(t);
  await fs.promises.cp(path.join(fixtures, 'project-design'), f.root, { recursive: true });
  const source = cat(await f.host.list(f.root), 'project-design');
  assert.deepEqual(source.origin, { type: 'project', label: 'Projeto' });
  assert.deepEqual(source.entries.map(entry => entry.name), ['declarado', 'raiz']);
  assert.deepEqual(source.errors, []); assert.deepEqual(source.entries[0].errors, []);
  assert.equal(source.entries[0].path, 'design-system/DESIGN.md');
  assert.equal((await f.host.read(f.root, 'project-design', 'declarado')).text, 'Corpo do design system.\n');
  const file = path.join(f.root, '.dk', 'projeto.json');
  const valid = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  await fs.promises.rm(path.join(f.root, 'design-system', 'DESIGN.md'));
  const declaredOnly = cat(await f.host.list(f.root), 'project-design').entries[0];
  assert.deepEqual(declaredOnly.errors, []); assert.equal(declaredOnly.bytes, 0);
  assert.equal((await f.host.read(f.root, 'project-design', 'declarado')).text, '');
  await write(f.root, '.dk/projeto.json', { prototipo: { pasta: 'prototipo', design_system: { caminho: '../fora' } } });
  const invalid = cat(await f.host.list(f.root), 'project-design');
  assert.match(invalid.entries[0].errors.join(), /design_system.caminho/);
  await assert.rejects(f.host.read(f.root, 'project-design', 'declarado'), /design_system/);
  await write(f.root, '.dk/projeto.json', '{ inválido');
  const corrupt = cat(await f.host.list(f.root), 'project-design');
  assert.deepEqual(corrupt.errors, ['JSON do projeto inválido.']); assert.equal(corrupt.entries[0].name, 'raiz');
  await write(f.root, '.dk/projeto.json', valid);
  await fs.promises.rm(path.join(f.root, 'design-system', 'base.css'));
  const missingLoad = cat(await f.host.list(f.root), 'project-design').entries[0];
  assert.match(missingLoad.errors.join(), /carga: arquivo ausente/);
});

test('<img onerror> na description fica string intacta', async t => {
  const f = await fixture(t), payload = '<img onerror="window.__injected=true" src=x>';
  await write(f.root, 'DESIGN.md', `---\ndescription: '${payload}'\n---\n${payload}`);
  const entry = cat(await f.host.list(f.root), 'project-design').entries[0];
  assert.equal(entry.description, payload); assert.equal(entry.frontmatter.description, payload);
  assert.equal((await f.host.read(f.root, 'project-design', 'raiz')).text, payload);
});

test('plugins do cache M0: origens explícitas, ordem e ids sem substituição', async t => {
  const f = await fixture(t), alpha = path.join(f.base, 'alpha'), zeta = path.join(f.base, 'zeta');
  await write(alpha, 'skills/dk-entender/SKILL.md', 'corpo do plugin alpha');
  await write(zeta, 'systems/base/DESIGN.md', 'referência do plugin zeta');
  await write(f.root, 'referencias/local/SKILL.md', 'skill explícita do projeto');
  await write(f.root, '.dk/skills-ativas/ignorada/SKILL.md', 'não carregar');
  const contributions = [
    { id: 'systems', kind: 'design-systems', source: 'plugin', path: 'systems' },
    { id: 'project', kind: 'skills', source: 'project', path: 'referencias' },
  ];
  const records = new Map([['zeta', plugin(zeta, 'zeta', contributions)], ['alpha', plugin(alpha, 'alpha')]]);
  const result = await f.host.list(f.root, { kit: f.kit, plugins: records });
  assert.deepEqual(result.catalogs.map(item => item.id), ['kit-skills', 'project-design', 'plugin:alpha/skills', 'plugin:zeta/project', 'plugin:zeta/systems']);
  assert.deepEqual(cat(result, 'plugin:alpha/skills').origin, { type: 'plugin', label: 'Plugin Nome alpha', pluginId: 'alpha' });
  assert.equal(cat(result).entries.find(entry => entry.name === 'dk-entender').id, 'kit-skills/dk-entender');
  assert.equal(cat(result, 'plugin:alpha/skills').entries[0].id, 'plugin:alpha/skills/dk-entender');
  assert.equal((await f.host.read(f.root, 'plugin:alpha/skills', 'dk-entender')).text, 'corpo do plugin alpha');
  assert.equal((await f.host.read(f.root, 'plugin:zeta/project', 'local')).text, 'skill explícita do projeto');
  assert.equal((await f.host.read(f.root, 'plugin:zeta/systems', 'base')).text, 'referência do plugin zeta');
  assert.ok(result.catalogs.every(source => source.entries.every(entry => entry.name !== 'ignorada')));
});

test('ids e caminhos inválidos são recusados antes do disco', async t => {
  const f = await fixture(t);
  await f.host.list(f.root, { kit: f.kit });
  const spy = t.mock.method(fs.promises, 'lstat', () => { throw new Error('Não deve acessar o disco'); });
  for (const catalogId of ['../kit-skills', 'kit-skills/../fora', 'x'.repeat(129), null]) await assert.rejects(f.host.read(f.root, catalogId, 'dk-entender'), /Catálogo não encontrado/);
  for (const entryId of ['../fora', 'x'.repeat(65), 'Nome', '', null]) await assert.rejects(f.host.read(f.root, 'kit-skills', entryId), /Item do catálogo não encontrado/);
  assert.equal(spy.mock.callCount(), 0); spy.mock.restore();
  const record = plugin(f.root, 'escape', [{ id: 'bad', kind: 'skills', source: 'plugin', path: '../fora' }]);
  const source = cat(await f.host.list(f.root, { plugins: [record] }), 'plugin:escape/bad');
  assert.deepEqual(source.errors, ['Caminho fora da origem do catálogo.']); assert.deepEqual(source.entries, []);
  await assert.rejects(f.host.read(f.root, 'kit-skills', 'dk-entender'), /Catálogo não encontrado/);
  await assert.rejects(f.host.read(f.root, 'project-design', 'ausente'), /Item do catálogo não encontrado/);
});

test('frontmatter: teto de 8 KiB, chaves únicas, whitelist e finais CRLF', () => {
  const big = parseFrontmatter(`---\ndescription: ${'á'.repeat(4096)}\n---\ncorpo`);
  assert.equal(big.error, 'Frontmatter excede 8 KiB.'); assert.deepEqual(big.data, {}); assert.equal(big.body, 'corpo');
  const repeated = parseFrontmatter('---\nname: a\nname: b\n---\ncorpo');
  assert.equal(repeated.parser, 'regex'); assert.ok(repeated.error);
  const valid = parseFrontmatter('---\r\nname: exemplo\r\nscript: perigo\r\n---\r\ncorpo');
  assert.deepEqual(valid.data, { name: 'exemplo' }); assert.equal(valid.body, 'corpo'); assert.equal(valid.error, null);
  assert.equal(parseFrontmatter('sem frontmatter').body, 'sem frontmatter');
  assert.ok(parseFrontmatter('---\nname: sem-fim').error);
});

test('stageGate e inside espelham portão do kit e contenção por segmento', () => {
  assert.deepEqual(stageGate('USE QUANDO A ETAPA\nENTENDER DO DK ESTIVER ATIVA'), { stage: 'entender', gate: true });
  assert.deepEqual(stageGate('Use quando a etapa audit do DK estiver ativa.'), { stage: 'audit', gate: true });
  assert.deepEqual(stageGate('Use quando a etapa futura do DK estiver ativa.'), { stage: '', gate: true });
  assert.deepEqual(stageGate('Porta geral.'), { stage: '', gate: false });
  assert.equal(inside('/raiz', '/raiz'), true); assert.equal(inside('/raiz', '/raiz/a'), true);
  assert.equal(inside('/raiz', '/raiz-externa/a'), false); assert.equal(inside('/raiz', '/fora'), false);
});

test('cache valida stamps; refresh e invalidate recalculam; kit não é observado', async t => {
  const events = [], f = await fixture(t, event => events.push(event));
  const watchedDirs = [];
  t.mock.method(fs, 'watch', dir => { watchedDirs.push(dir); const watcher = new EventEmitter(); watcher.close = () => {}; return watcher; });
  await f.host.list(f.root, { kit: f.kit });
  const firstCache = f.host.cache;
  const result = await f.host.list(f.root, { kit: f.kit });
  assert.equal(f.host.cache, firstCache);
  result.catalogs.length = 0;
  assert.equal((await f.host.list(f.root, { kit: f.kit })).catalogs.length, 2);
  await f.host.list(f.root, { kit: f.kit, refresh: true }); assert.notEqual(f.host.cache, firstCache);
  const file = path.join(f.kit.path, 'skills', 'dk-entender', 'SKILL.md');
  await fs.promises.writeFile(file, '---\ndescription: mudou\n---\nnovo corpo');
  await delay(550); assert.deepEqual(events, []);
  assert.ok(watchedDirs.every(dir => !inside(f.kit.path, dir)));
  const updated = await f.host.list(f.root, { kit: f.kit });
  assert.equal(cat(updated).entries[0].description, 'mudou');
  f.host.invalidate(path.join(f.base, 'outro')); await delay(450); assert.deepEqual(events, []);
  f.host.invalidate(f.root); f.host.invalidate(f.root);
  await until(() => events.length === 1); assert.deepEqual(events, [{ path: f.root }]);
  const beforeInvalidationRead = f.host.cache;
  await f.host.list(f.root, { kit: f.kit }); assert.notEqual(f.host.cache, beforeInvalidationRead);
});

test('limite de 512 entradas e nomes inválidos não expandem varredura', async t => {
  const f = await fixture(t), pluginRoot = path.join(f.base, 'plugin');
  await write(pluginRoot, 'skills/INVALID/SKILL.md', 'ignorar');
  for (let i = 0; i < 513; i++) await write(pluginRoot, `skills/file-${i}.txt`, 'x');
  const source = cat(await f.host.list(f.root, { plugins: [plugin(pluginRoot)] }), 'plugin:example/skills');
  assert.equal(source.truncated, true); assert.ok(source.errors.includes('Limite de 512 entradas do diretório atingido.'));
  assert.deepEqual(source.entries, []);
});

test('mais de 16 origens observadas e erro de fs.watch oferecem Recarregar', async t => {
  const f = await fixture(t, () => {}), plugins = [];
  for (let i = 0; i < 16; i++) {
    const pluginRoot = path.join(f.base, `plugin-${i}`);
    await write(pluginRoot, 'skills/item/SKILL.md', 'x');
    plugins.push(plugin(pluginRoot, `plugin-${i}`));
  }
  const limited = await f.host.list(f.root, { plugins });
  assert.equal(limited.watching, false); assert.equal(f.host.watchers.length, 0);
  assert.ok(limited.errors.includes('Monitoramento de catálogos indisponível; use Recarregar.'));
  const emitter = new EventEmitter(); let closed = 0;
  emitter.close = () => { closed++; };
  const mockWatch = t.mock.method(fs, 'watch', () => emitter);
  const watched = await f.host.list(f.root, { refresh: true });
  assert.equal(watched.watching, true);
  emitter.emit('error', new Error('indisponível'));
  const failed = await f.host.list(f.root);
  assert.equal(failed.watching, false); assert.ok(closed > 0);
  assert.ok(failed.errors.includes('Monitoramento de catálogos indisponível; use Recarregar.'));
  mockWatch.mock.restore();
});

test('close durante leitura impede publicar cache e reinstalar watchers', async t => {
  const f = await fixture(t, () => {}), original = fs.promises.open;
  let entered, resume;
  const opened = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { resume = resolve; });
  let blocked = false;
  t.mock.method(fs.promises, 'open', async function (...args) {
    if (!blocked) { blocked = true; entered(); await barrier; }
    return original.apply(this, args);
  });
  const loading = f.host.list(f.root, { kit: f.kit });
  await opened; f.host.closeProject(f.root); resume();
  await assert.rejects(loading, /Projeto alterado durante a leitura/);
  assert.equal(f.host.cache, null); assert.equal(f.host.watchers.length, 0);
});

test('realpath fora da origem é recusado antes da leitura do item', async t => {
  const f = await fixture(t), original = fs.promises.realpath;
  const file = path.join(f.kit.path, 'skills', 'dk-entender', 'SKILL.md');
  t.mock.method(fs.promises, 'realpath', async function (target, ...args) {
    return target === file ? path.join(f.base, 'fora', 'SKILL.md') : original.call(this, target, ...args);
  });
  const entry = cat(await f.host.list(f.root, { kit: f.kit })).entries[0];
  assert.deepEqual(entry.errors, ['Caminho fora da origem do catálogo.']);
  await assert.rejects(f.host.read(f.root, 'kit-skills', 'dk-entender'), { message: 'Caminho fora da origem do catálogo.' });
});

test('JSON do projeto tem limites de 4 MiB e 5000 itens; erro não oculta DESIGN.md', async t => {
  const f = await fixture(t);
  await write(f.root, 'DESIGN.md', 'raiz');
  const file = await write(f.root, '.dk/projeto.json', ' '.repeat(4 * 1024 * 1024 + 1));
  const original = fs.promises.open; let opens = 0;
  const spy = t.mock.method(fs.promises, 'open', async function (target, ...args) { if (target === file) opens++; return original.call(this, target, ...args); });
  let source = cat(await f.host.list(f.root), 'project-design');
  assert.deepEqual(source.errors, ['Registro do projeto excede 4 MiB.']); assert.equal(opens, 0);
  assert.equal(source.entries[0].name, 'raiz'); spy.mock.restore();
  await write(f.root, '.dk/projeto.json', { itens: Array(5001).fill(0) });
  source = cat(await f.host.list(f.root), 'project-design');
  assert.deepEqual(source.errors, ['Registro do projeto excede 5000 itens.']); assert.equal(source.entries[0].name, 'raiz');
});

test('profundidade fixa e fronteiras inclusivas de tamanho e nome', async t => {
  const f = await fixture(t), name = 'a'.repeat(64);
  await write(f.kit.path, `skills/${name}/SKILL.md`, 'x'.repeat(64 * 1024));
  await write(f.kit.path, 'skills/pai/filho/SKILL.md', 'não descobrir');
  await write(f.kit.path, `skills/${'a'.repeat(65)}/SKILL.md`, 'nome longo');
  const source = cat(await f.host.list(f.root, { kit: f.kit }));
  const entry = source.entries.find(item => item.name === name);
  assert.equal(entry.bytes, 64 * 1024); assert.deepEqual(entry.errors, []);
  assert.equal((await f.host.read(f.root, 'kit-skills', name)).bytes, 64 * 1024);
  assert.ok(!source.entries.some(item => item.name === 'filho' || item.name.length > 64));
  assert.ok(source.errors.some(error => error.startsWith('Nome de item inválido:')));
  await write(f.root, 'DESIGN.md', `---\ndescription: ${'x'.repeat(310)} Use quando a etapa entregar do DK estiver ativa.\n---\ncorpo`);
  const projectEntry = cat(await f.host.list(f.root), 'project-design').entries[0];
  assert.equal(projectEntry.description.length, 300); assert.equal(projectEntry.stage, 'entregar'); assert.equal(projectEntry.gate, true);
});

test('declaração submodule valida metadados e existência sem consultar Git', async t => {
  const f = await fixture(t);
  const base = { pasta: 'prototipo', design_system: { pacote: 'base', versao: '1', caminho: 'base', carga: ['base.css'], modo: 'submodule' } };
  await write(f.root, 'base/base.css', 'css');
  await write(f.root, '.dk/projeto.json', { prototipo: base });
  let entry = cat(await f.host.list(f.root), 'project-design').entries[0];
  assert.match(entry.errors.join(), /design_system.repositorio/); assert.match(entry.errors.join(), /design_system.commit/);
  Object.assign(base.design_system, { repositorio: 'https://example.invalid/base.git', commit: 'a'.repeat(40) });
  await write(f.root, '.dk/projeto.json', { prototipo: base });
  entry = cat(await f.host.list(f.root), 'project-design').entries[0];
  assert.deepEqual(entry.errors, []); assert.equal(entry.bytes, 0);
});
