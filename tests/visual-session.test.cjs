const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Worker } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { VisualSessions } = require('../electron/visual-session.cjs');
const { createHandler } = require('../electron/visual-protocol.cjs');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
const op = value => ({ type: 'text', node: 1, value });
function fixture(t, bytes = Buffer.from('<p>original</p>'), options = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-visual-')));
  const root = path.join(base, 'Project'), other = path.join(base, 'Other');
  fs.mkdirSync(root); fs.mkdirSync(other);
  const file = path.join(root, 'index.html'); fs.writeFileSync(file, bytes);
  const owner = { isDestroyed: () => false }, events = [];
  const active = { root, generation: 1 };
  const sessions = new VisualSessions({ context: window => window === owner ? active : null,
    emit: (window, event) => events.push({ window, event }), ...options });
  t.after(() => { sessions.closeAll(); fs.rmSync(base, { recursive: true, force: true }); });
  const open = (relative = 'index.html', flags = { codeEditorDirty: false }, alias = root) => sessions.open(owner, alias, relative, flags);
  const gen = () => sessions.state(owner, active.root).gen;
  const apply = value => sessions.apply(owner, root, gen(), op(value));
  const undo = () => sessions.undo(owner, root, gen());
  const redo = () => sessions.redo(owner, root, gen());
  const save = () => sessions.save(owner, root, gen());
  const handler = createHandler(sessions);
  const request = (url, initiatorOrigin = 'dk-app://app') => handler({ method: 'GET', url, initiatorOrigin });
  return { base, root, other, file, owner, active, sessions, events, open, gen, apply, undo, redo, save, request };
}

for (const [name, source, expected] of [
  ['BOM+CRLF', '\uFEFF<p>um\r\ndois</p>\r\n<!-- fim -->', '\uFEFF<p>três &amp;\r\nquatro</p>\r\n<!-- fim -->'],
  ['mistos', '<p>um\r\ndois\ntrês</p>\n<!-- fim -->\r\n', '<p>três &amp;\r\nquatro</p>\n<!-- fim -->\r\n'],
  ['CR solitário', '<p>um</p>\r<!-- fim -->', '<p>três &amp;\rquatro</p>\r<!-- fim -->'],
]) test(`open/inspect/apply/undo/redo/save preservam bytes: ${name}`, async t => {
  const original = Buffer.from(source), f = fixture(t, original);
  let result = ok(await f.open());
  assert.equal(result.state.dirty, false); assert.equal(result.state.canUndo, false);
  assert.equal(result.doc.eol, name === 'BOM+CRLF' ? 'crlf' : name === 'mistos' ? 'mixed' : 'none');
  assert.equal(result.doc.loneCR, name === 'CR solitário');
  const inspect = ok(await f.sessions.inspect(f.owner, f.root, result.doc.gen, 1)).inspect;
  assert.equal(inspect.tag, 'p'); assert.equal(inspect.readonly, null); assert.equal(inspect.can.text, true);
  assert.equal((await f.sessions.inspect(f.owner, f.root, result.doc.gen, 999)).reason, 'no-target');
  assert.equal(ok(await f.save()).revision, sha(original));
  assert.deepEqual(fs.readFileSync(f.file), original);
  result = ok(await f.apply('três &\nquatro'));
  assert.equal(result.state.dirty, true); assert.equal(result.state.canUndo, true);
  assert.deepEqual(fs.readFileSync(f.file), original, 'apply não escreve');
  result = ok(await f.undo());
  assert.equal(result.state.dirty, false); assert.equal(result.state.canRedo, true);
  assert.deepEqual(fs.readFileSync(f.file), original, 'undo não escreve');
  ok(await f.redo());
  result = ok(await f.save());
  assert.equal(result.revision, sha(Buffer.from(expected))); assert.equal(result.state.dirty, false);
  assert.deepEqual(fs.readFileSync(f.file), Buffer.from(expected));
  assert.equal(ok(await f.undo()).state.dirty, true, 'histórico continua após salvar');
  ok(await f.save()); assert.deepEqual(fs.readFileSync(f.file), original);
});

test('dirty usa sha256 dos bytes, não tamanho, contador de alterações ou tamanho do histórico', async t => {
  const f = fixture(t); ok(await f.open());
  assert.equal(ok(await f.apply('original')).state.dirty, false);
  assert.equal(ok(await f.apply('modifica')).state.dirty, true);
  const result = ok(await f.apply('original'));
  assert.equal(result.state.dirty, false); assert.equal(result.state.canUndo, true);
  ok(await f.undo()); ok(await f.apply('nova'));
  assert.equal(f.sessions.state(f.owner, f.root).canRedo, false);
});

test('FILE_CONFLICT preserva cópia, geração e histórico; reload descarta e revoga token antigo', async t => {
  const f = fixture(t); ok(await f.open()); const edited = ok(await f.apply('local'));
  fs.writeFileSync(f.file, '<p>externo</p>');
  const conflict = await f.save();
  assert.equal(conflict.reason, 'FILE_CONFLICT');
  assert.equal(conflict.message, 'O arquivo foi alterado fora do DK. Suas alterações foram mantidas no editor; recarregue o arquivo antes de tentar salvar novamente.');
  assert.equal(conflict.message.includes(f.root), false);
  assert.equal(f.gen(), edited.doc.gen); assert.equal(f.sessions.state(f.owner, f.root).dirty, true);
  assert.equal(ok(await f.sessions.inspect(f.owner, f.root, f.gen(), 1)).inspect.text, 'local');
  assert.equal(ok(await f.undo()).state.canRedo, true); ok(await f.redo());
  assert.equal((await f.request(edited.doc.url)).status, 410);
  const beforeReload = f.sessions.byWindow(f.owner).token;
  const reloaded = ok(await f.sessions.reload(f.owner, f.root));
  assert.equal(reloaded.state.dirty, false); assert.equal(reloaded.state.canUndo, false);
  assert.equal(f.sessions.byToken(beforeReload), null);
  assert.equal(ok(await f.sessions.inspect(f.owner, f.root, f.gen(), 1)).inspect.text, 'externo');
  assert.deepEqual(fs.readdirSync(f.root), ['index.html']);
});

test('protocolo real usa cache, nonce/chan por geração, 410 antigo e 404 após close', async t => {
  const f = fixture(t); const initial = ok(await f.open()), s = f.sessions.byWindow(f.owner);
  assert.match(s.token, /^[a-f0-9]{32}$/); assert.match(s.nonce, /^[a-f0-9]{32}$/);
  assert.match(initial.doc.chan, /^[a-f0-9]{32}$/);
  const nonce = s.nonce, document = s.document();
  assert.ok(Buffer.isBuffer(document)); assert.equal(s.document(), document);
  assert.equal(typeof s.dev, 'number'); assert.equal(typeof s.ino, 'number');
  const first = await f.request(initial.doc.url), second = await f.request(initial.doc.url);
  assert.equal(first.status, 200); assert.equal(await first.text(), await second.text());
  assert.match(first.headers.get('content-security-policy'), new RegExp(`nonce-${nonce}`));
  assert.ok(document.includes(`const chan = '${initial.doc.chan}'`));
  assert.ok(document.includes(`const gen = ${initial.doc.gen}`));
  assert.ok(!document.includes('__DK_'));
  let previous = initial;
  for (const mutate of [() => f.apply('edit'), f.undo, f.redo]) {
    const current = ok(await mutate());
    assert.equal(current.doc.gen, previous.doc.gen + 1); assert.notEqual(current.doc.chan, previous.doc.chan);
    assert.notEqual(s.nonce, nonce); assert.equal((await f.request(previous.doc.url)).status, 410);
    assert.equal((await f.request(current.doc.url)).status, 200); previous = current;
  }
  assert.deepEqual(f.sessions.close(f.owner, f.root), { ok: true });
  assert.equal((await f.request(previous.doc.url)).status, 404);
  assert.equal(f.sessions.byToken(s.token), null);
});

test('orçamento por geração: 2000 pedidos e 64 MiB, inclusive recusas; reset após apply', async t => {
  const f = fixture(t); const initial = ok(await f.open()), s = f.sessions.byWindow(f.owner);
  const missing = initial.doc.url.replace('index.html', 'missing.css');
  for (let i = 0; i < 2000; i++) assert.equal((await f.request(missing, 'null')).status, 404);
  assert.equal((await f.request(initial.doc.url)).status, 429);
  const next = ok(await f.apply('edit')); assert.equal((await f.request(next.doc.url)).status, 200);
  ok(await f.undo()); assert.equal(s.countRequest(64 * 1024 * 1024), true);
  assert.equal(s.countRequest(1), false); assert.equal(s.countRequest(0), false);
  ok(await f.redo()); assert.equal(s.countRequest(0), true);
});

test('recusa dirty-code-editor, documentos acima de 2 MiB e paths que o protocolo não serve', async t => {
  const f = fixture(t);
  assert.equal((await f.open('index.html', { codeEditorDirty: true })).reason, 'dirty-code-editor');
  assert.equal(f.sessions.byWindow(f.owner), null);
  fs.writeFileSync(path.join(f.root, 'large.html'), Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  assert.equal((await f.open('large.html')).reason, 'too-large');
  for (const relative of ['../index.html', '.hidden.html', 'a//b.html', 'a%20b.html']) assert.equal((await f.open(relative)).ok, false);
  fs.writeFileSync(path.join(f.root, 'a.txt'), '<p>x</p>');
  assert.equal((await f.open('a.txt')).reason, 'value-invalid');
});

test('gera canonical root por symlink e relative POSIX; alias de arquivo não contorna extensão', async t => {
  const f = fixture(t), alias = path.join(f.base, 'alias'); fs.symlinkSync(f.root, alias);
  ok(await f.open('index.html', { codeEditorDirty: false }, alias));
  const s = f.sessions.byWindow(f.owner);
  assert.equal(s.root, fs.realpathSync.native(f.root)); assert.equal(s.relative, 'index.html');
  assert.equal(ok(await f.sessions.inspect(f.owner, alias, f.gen(), 1)).inspect.tag, 'p');
  fs.writeFileSync(path.join(f.root, 'data.txt'), '<p>x</p>'); fs.symlinkSync('data.txt', path.join(f.root, 'alias.html'));
  assert.equal((await f.open('alias.html')).reason, 'value-invalid');
});

test('realpath.native aceita outra caixa no filesystem que oferece esse alias', async t => {
  const f = fixture(t), alias = path.join(f.base, 'pROJECT');
  if (!fs.existsSync(alias)) { t.skip('filesystem sensível a caixa'); return; }
  const native = fs.realpathSync.native, calls = [];
  t.mock.method(fs.realpathSync, 'native', (...args) => { calls.push(args[0]); return native(...args); });
  f.active.root = alias;
  ok(await f.open('index.html', { codeEditorDirty: false }, alias));
  assert.equal(f.sessions.byWindow(f.owner).root, native(f.root));
  assert.ok(calls.includes(alias)); assert.equal(ok(await f.apply('caixa')).state.dirty, true);
});

for (const change of ['project', 'epoch', 'inode', 'root-symlink', 'window']) test(`revalida e revoga: ${change}`, async t => {
  const f = fixture(t), first = ok(await f.open()), token = f.sessions.byWindow(f.owner).token;
  if (change === 'project') f.active.root = f.other;
  if (change === 'epoch') f.active.generation++;
  if (change === 'inode' || change === 'root-symlink') {
    fs.renameSync(f.root, `${f.root}-old`);
    if (change === 'inode') fs.mkdirSync(f.root); else fs.symlinkSync(`${f.root}-old`, f.root);
  }
  if (change === 'window') f.owner.isDestroyed = () => true;
  assert.equal((await f.sessions.inspect(f.owner, f.root, first.doc.gen, 1)).ok, false);
  assert.equal(f.sessions.byToken(token), null); assert.equal((await f.request(first.doc.url)).status, 404);
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.events[0].event, { type: 'revoked', reason: change === 'window' ? 'renderer-gone' : 'project-changed' });
});

test('janela alheia e raiz inativa não podem consultar, editar nem fechar a sessão atual', async t => {
  const f = fixture(t); ok(await f.open());
  assert.equal((await f.sessions.apply({}, f.root, f.gen(), op('x'))).reason, 'project-changed');
  assert.equal((await f.sessions.apply(f.owner, f.other, f.gen(), op('x'))).reason, 'project-changed');
  f.sessions.close(f.owner, f.other);
  assert.equal(f.sessions.state(f.owner, f.root).open, true);
});

test('serialização rejeita geração velha concorrente e nenhum patch externo entra no histórico', async t => {
  const f = fixture(t); ok(await f.open()); const gen = f.gen();
  const results = await Promise.all([f.sessions.apply(f.owner, f.root, gen, op('primeiro')), f.sessions.apply(f.owner, f.root, gen, op('segundo'))]);
  ok(results[0]); assert.equal(results[1].reason, 'stale-gen');
  for (const value of [gen, undefined, null, '1', NaN]) assert.equal((await f.sessions.apply(f.owner, f.root, value, op('invasor'))).reason, 'stale-gen');
  assert.equal((await f.sessions.apply(f.owner, f.root, f.gen(), { ...op('x'), edit: { start: 0, end: 0, oldText: '', newText: '<script>' } })).reason, 'value-invalid');
  assert.equal(ok(await f.sessions.inspect(f.owner, f.root, f.gen(), 1)).inspect.text, 'primeiro');
  ok(await f.undo()); assert.equal(ok(await f.sessions.inspect(f.owner, f.root, f.gen(), 1)).inspect.text, 'original');
});

test('histórico limita a 200 entradas somando undo/redo e sinaliza truncated', async t => {
  const f = fixture(t); ok(await f.open());
  for (let i = 1; i <= 201; i++) {
    const result = ok(await f.apply(String(i))); assert.equal(result.state.truncated, i > 200);
  }
  for (let i = 0; i < 200; i++) ok(await f.undo());
  assert.equal((await f.undo()).reason, 'no-target');
  assert.equal(ok(await f.sessions.inspect(f.owner, f.root, f.gen(), 1)).inspect.text, '1');
  assert.equal(f.sessions.state(f.owner, f.root).truncated, true);
  for (let i = 0; i < 200; i++) ok(await f.redo());
  assert.equal((await f.redo()).reason, 'no-target');
  assert.equal(ok(await f.sessions.reload(f.owner, f.root)).state.truncated, false);
});

test('histórico limita a 8 MiB de patches inversos, incluindo oldText e newText', async t => {
  const value = '&'.repeat(64 * 1024 - 1), source = `<p>${'&amp;'.repeat(value.length)}a</p>`;
  const f = fixture(t, Buffer.from(source)); ok(await f.open());
  // Both sides contain escaped text: ~640 KiB per inverse, below text input's 64 KiB.
  const entryBytes = 16 + 2 * (value.length * 5 + 1);
  const capacity = Math.floor(8 * 1024 * 1024 / entryBytes);
  assert.ok(capacity < 200);
  for (let i = 0; i <= capacity; i++) {
    const result = ok(await f.apply(value + (i % 2 ? 'a' : 'b')));
    assert.equal(result.state.truncated, i === capacity);
  }
  for (let i = 0; i < capacity; i++) ok(await f.undo());
  assert.equal((await f.undo()).reason, 'no-target');
  for (let i = 0; i < capacity; i++) ok(await f.redo());
  assert.equal((await f.redo()).reason, 'no-target');
});

test('worker que nunca responde é terminado e sessão pendente é revogada', async t => {
  let worker;
  const f = fixture(t, undefined, { timeoutMs: 100, workerFactory: () => {
    worker = new Worker('require("node:worker_threads").parentPort.on("message", () => {});', { eval: true });
    return worker;
  } });
  assert.equal((await f.open()).reason, 'too-complex');
  assert.equal(f.sessions.windows.size, 0); assert.equal(f.sessions.tokens.size, 0);
  assert.equal(f.events[0].event.reason, 'too-complex');
  await worker.terminate();
});

test('prazo padrão de 5 s revoga token já servido quando o worker trava', { timeout: 10000 }, async t => {
  const workerPath = require.resolve('../electron/visual-patch-worker.cjs');
  const f = fixture(t, undefined, { workerFactory: options => new Worker(`
    require(${JSON.stringify(workerPath)});
    require('node:worker_threads').parentPort.on('message', m => {
      if (m.command === 'freeze') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });`, { ...options, eval: true }) });
  const first = ok(await f.open()), s = f.sessions.byWindow(f.owner);
  const exited = new Promise(resolve => s.worker.once('exit', resolve));
  s.worker.postMessage({ command: 'freeze' });
  const start = Date.now();
  assert.equal((await f.sessions.inspect(f.owner, f.root, f.gen(), 1)).reason, 'too-complex');
  assert.ok(Date.now() - start >= 4900);
  assert.equal(f.sessions.byToken(s.token), null); assert.equal((await f.request(first.doc.url)).status, 404);
  assert.deepEqual(f.events.at(-1).event, { type: 'revoked', reason: 'too-complex' });
  await exited;
});

test('troca de projeto durante prepare nunca publica token ou resposta antiga', async t => {
  const f = fixture(t);
  const pending = f.open(); f.active.root = f.other;
  assert.equal((await pending).reason, 'project-changed');
  assert.equal(f.sessions.tokens.size, 0); assert.equal(f.sessions.windows.size, 0);
});

test('assetExists no worker verifica imagens locais e undo restaura valor original inseguro', async t => {
  const f = fixture(t, Buffer.from('<img src="https://example.test/original.png">'));
  fs.writeFileSync(path.join(f.root, 'image.png'), 'image'); ok(await f.open());
  const apply = value => f.sessions.apply(f.owner, f.root, f.gen(), { type: 'attr', node: 1, name: 'src', value });
  assert.equal((await apply('missing.png')).reason, 'image-missing'); ok(await apply('image.png'));
  ok(await f.undo()); ok(await f.save());
  assert.equal(fs.readFileSync(f.file, 'utf8'), '<img src="https://example.test/original.png">');
  ok(await f.redo()); ok(await f.save());
  assert.equal(fs.readFileSync(f.file, 'utf8'), '<img src="image.png">');
});

test('open de outro arquivo, reload e close revogam sem emitir visual:event', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'other.html'), '<p>outro</p>');
  ok(await f.open());
  for (const transition of [() => f.open('other.html'), () => f.sessions.reload(f.owner, f.root),
    () => f.sessions.close(f.owner, f.root)]) {
    const token = f.sessions.byWindow(f.owner).token;
    ok(await transition());
    assert.equal(f.sessions.byToken(token), null);
    assert.deepEqual(f.events, []);
  }
  // A refusal while preparing a new document is not a lifecycle event either.
  fs.writeFileSync(f.file, '<textarea>aberto');
  assert.equal((await f.open()).ok, false);
  assert.deepEqual(f.events, []);
});

test('recusas e erros de arquivo nunca devolvem mensagens com a raiz absoluta', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'large.html'), Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  const results = [await f.open('missing.html'), await f.open('large.html'), await f.open('a.txt'),
    await f.open(f.file), await f.open('../index.html'), await f.open('index.html', { codeEditorDirty: true })];
  assert.deepEqual(results.map(result => result.reason),
    ['file-unavailable', 'too-large', 'value-invalid', 'value-invalid', 'value-invalid', 'dirty-code-editor']);
  assert.equal(results[0].message, 'Não foi possível acessar o arquivo do editor visual.');
  ok(await f.open());
  results.push(await f.sessions.apply(f.owner, f.root, -1, op('x')),
    await f.sessions.inspect(f.owner, f.root, f.gen(), 999), await f.apply('\0'));
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal(typeof result.message, 'string');
    assert.equal(result.message.includes(f.root), false, JSON.stringify(result));
  }
});

for (const code of ['ENOENT', 'EACCES', 'EIO']) test(`erros ${code} em open/reload/save são opacos e preservam a sessão`, async t => {
  const f = fixture(t); ok(await f.open()); ok(await f.apply('local'));
  const before = f.sessions.state(f.owner, f.root), token = f.sessions.byWindow(f.owner).token;
  const original = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === f.file) throw Object.assign(new Error(`${code}: detalhe privado ${f.root}`), { code });
    return original(file, ...args);
  });
  for (const invoke of [f.open, () => f.sessions.reload(f.owner, f.root), f.save]) {
    const result = await invoke();
    assert.deepEqual(result, { ok: false, reason: 'file-unavailable', message: 'Não foi possível acessar o arquivo do editor visual.' });
    assert.equal(result.message.includes(f.root), false);
    assert.deepEqual(f.sessions.state(f.owner, f.root), before);
    assert.equal(f.sessions.byWindow(f.owner).token, token);
  }
  assert.deepEqual(f.events, []);
});

for (const crash of ['error', 'exit']) test(`worker ${crash} revoga com worker-failed e tem limite de 256 MiB`, async t => {
  const workerPath = require.resolve('../electron/visual-patch-worker.cjs');
  const f = fixture(t, undefined, { workerFactory: options => {
    assert.deepEqual(options.resourceLimits, { maxOldGenerationSizeMb: 256 });
    return new Worker(`
      const port = require('node:worker_threads').parentPort, on = port.on;
      port.on = function (event, handler) {
        return on.call(this, event, m => {
          if (m.command === 'inspect') ${crash === 'error' ? 'throw new Error("falha privada")' : 'process.exit(0)'};
          handler(m);
        });
      };
      require(${JSON.stringify(workerPath)});`, { ...options, eval: true });
  } });
  const first = ok(await f.open()), s = f.sessions.byWindow(f.owner);
  assert.equal(s.worker.resourceLimits.maxOldGenerationSizeMb, 256);
  assert.equal((await f.sessions.inspect(f.owner, f.root, first.doc.gen, 1)).reason, 'worker-failed');
  assert.equal(f.sessions.byToken(s.token), null);
  assert.equal((await f.request(first.doc.url)).status, 404);
  assert.deepEqual(f.events.map(({ event }) => event), [{ type: 'revoked', reason: 'worker-failed' }]);
});

test('byToken reutiliza revalidação por geração, mas confere dev/ino e ciclo de projeto a cada pedido', async t => {
  let validations = 0;
  const f = fixture(t, undefined, { validateProject: () => { validations++; } });
  ok(await f.open());
  const s = f.sessions.byWindow(f.owner), previous = validations;
  const stat = t.mock.method(fs, 'lstatSync');
  const realpath = t.mock.method(fs.realpathSync, 'native');
  for (let i = 0; i < 20; i++) assert.equal(f.sessions.byToken(s.token), s);
  assert.equal(validations, previous);
  assert.equal(stat.mock.callCount(), 20);
  assert.equal(realpath.mock.callCount(), 0);
  ok(await f.apply('nova geração'));
  const afterApply = validations;
  assert.equal(f.sessions.byToken(s.token), s);
  assert.equal(validations, afterApply + 1, 'primeiro pedido após publish refaz validação');
  assert.equal(f.sessions.byToken(s.token), s);
  assert.equal(validations, afterApply + 1);
  f.active.generation++;
  assert.equal(f.sessions.byToken(s.token), null);
  ok(await f.open());
  const next = f.sessions.byWindow(f.owner);
  assert.equal(f.sessions.byToken(next.token), next);
  fs.renameSync(f.root, `${f.root}-old`); fs.mkdirSync(f.root);
  assert.equal(f.sessions.byToken(next.token), null, 'cache não oculta substituição da raiz');
  assert.deepEqual(f.events.map(({ event }) => event.reason), ['project-changed', 'project-changed']);
});

for (const fault of ['size', 'inverse', 'serve']) test(`worker preserva documento e histórico se ${fault} falha antes de confirmar`, () => {
  const workerPath = require.resolve('../electron/visual-patch-worker.cjs'), localRequire = createRequire(workerPath);
  const patch = localRequire('./html-patch.cjs');
  let armed = false, receive, reply;
  const fail = () => { throw new Error('falha injetada'); };
  const context = vm.createContext({
    Buffer: { from: Buffer.from, byteLength: (...args) => armed && fault === 'size' ? fail() : Buffer.byteLength(...args) },
    require: name => name === 'node:worker_threads' ? {
      workerData: {}, parentPort: { on: (_event, handler) => { receive = handler; }, postMessage: value => { reply = value.result; } },
    } : name === './html-patch.cjs' ? { ...patch,
      invert: (...args) => armed && fault === 'inverse' ? fail() : patch.invert(...args),
      serve: (...args) => armed && fault === 'serve' ? fail() : patch.serve(...args),
    } : localRequire(name),
  });
  vm.runInContext(fs.readFileSync(workerPath, 'utf8'), context);
  const serving = { nonce: 'abc', chan: 'def', gen: 0, bridgeSource: '' };
  const call = (command, args = {}) => { receive({ id: 1, command, serving, ...args }); return reply; };
  ok(call('prepare', { bytes: Buffer.from('<p>original</p>'), relative: 'index.html' }));
  ok(call('apply', { op: op('primeiro') }));
  for (const command of ['apply', 'undo', 'redo']) {
    const before = ok(call('serve'));
    armed = true;
    assert.equal(call(command, { op: op('segundo') }).ok, false);
    armed = false;
    const after = ok(call('serve'));
    assert.deepEqual(after, before, 'nenhuma falha pode confirmar documento ou histórico parcial');
    if (command === 'undo') ok(call('undo'));
  }
  ok(call('redo'));
  assert.equal(ok(call('inspect', { node: 1 })).inspect.text, 'primeiro');
  ok(call('undo'));
  assert.equal(ok(call('inspect', { node: 1 })).inspect.text, 'original');
});
