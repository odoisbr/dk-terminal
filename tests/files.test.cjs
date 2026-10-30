const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { readProjectFile, saveProjectFile, saveProjectBytes, resolveFile, readBounded } = require('../electron/files.cjs');
function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-editor-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('edição preserva BOM, CRLF e modo e não deixa arquivo temporário', t => {
  const root = project(t), target = path.join(root, "O'Connor $ teste.ts");
  fs.writeFileSync(target, '\ufeffconst a = 1;\r\nconst b = 2;\r\n', { mode: 0o750 });
  const opened = readProjectFile(root, path.basename(target));
  assert.equal(opened.kind, 'text'); assert.equal(opened.bom, true); assert.equal(opened.newline, '\r\n');
  assert.equal(opened.content, 'const a = 1;\nconst b = 2;\n');
  const saved = saveProjectFile(root, path.basename(target), 'const a = 3;\n', opened.revision);
  assert.equal(fs.readFileSync(target, 'utf8'), '\ufeffconst a = 3;\r\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o750);
  assert.notEqual(saved.revision, opened.revision);
  assert.deepEqual(fs.readdirSync(root), [path.basename(target)]);
});
test('alteração externa é preservada quando a revisão do editor ficou antiga', t => {
  const root = project(t), target = path.join(root, 'app.ts');
  fs.writeFileSync(target, 'original\n');
  const opened = readProjectFile(root, 'app.ts');
  fs.writeFileSync(target, 'alteração de outro editor\n');
  assert.throws(() => saveProjectFile(root, 'app.ts', 'minha alteração\n', opened.revision), error => error.code === 'FILE_CONFLICT');
  assert.equal(fs.readFileSync(target, 'utf8'), 'alteração de outro editor\n');
  assert.deepEqual(fs.readdirSync(root), ['app.ts']);
});
test('recusa traversal, caminhos absolutos e links externos ao projeto', t => {
  const root = project(t), outside = project(t);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'não deve ser aberto');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'externo.txt'));
  assert.throws(() => readProjectFile(root, path.join(outside, 'secret.txt')), /inválido/);
  assert.throws(() => readProjectFile(root, '../secret.txt'), /fora do projeto/);
  assert.throws(() => readProjectFile(root, 'externo.txt'), /fora do projeto/);
  const revision = require('node:crypto').createHash('sha256').update('não deve ser aberto').digest('hex');
  assert.throws(() => saveProjectFile(root, 'externo.txt', 'não escrever', revision), /fora do projeto/);
  assert.throws(() => saveProjectFile(root, path.join(outside, 'secret.txt'), 'não escrever', revision), /inválido/);
  fs.symlinkSync(outside, path.join(root, 'pasta-externa'));
  assert.throws(() => readProjectFile(root, 'pasta-externa/secret.txt'), /fora do projeto/);
  assert.throws(() => saveProjectFile(root, 'pasta-externa/secret.txt', 'não escrever', revision), /fora do projeto/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'não deve ser aberto');
});
test('link interno salva o destino sem substituir o link', t => {
  const root = project(t);
  fs.writeFileSync(path.join(root, 'real.txt'), 'antes');
  fs.symlinkSync('real.txt', path.join(root, 'alias.txt'));
  const opened = readProjectFile(root, 'alias.txt');
  saveProjectFile(root, 'alias.txt', 'depois', opened.revision);
  assert.equal(fs.lstatSync(path.join(root, 'alias.txt')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(root, 'real.txt'), 'utf8'), 'depois');
});
test('binários e arquivos grandes não são editáveis', t => {
  const root = project(t);
  fs.writeFileSync(path.join(root, 'bytes.bin'), Buffer.from([1, 2, 0, 255]));
  fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  const binary = readProjectFile(root, 'bytes.bin');
  assert.equal(binary.kind, 'binary'); assert.equal(binary.readOnly, true); assert.equal(Object.hasOwn(binary, 'content'), false);
  const large = readProjectFile(root, 'large.txt');
  assert.equal(large.kind, 'binary'); assert.equal(large.revision, null);
  assert.equal(Object.hasOwn(large, 'content'), false);
  assert.throws(() => saveProjectFile(root, 'bytes.bin', 'texto', binary.revision), /somente para visualização/);
  fs.writeFileSync(path.join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  assert.equal(readProjectFile(root, 'invalid.txt').kind, 'binary');
});
test('imagem tem apenas prévia e arquivo somente leitura não é sobrescrito', t => {
  const root = project(t);
  fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const image = readProjectFile(root, 'logo.png');
  assert.equal(image.kind, 'image'); assert.ok(image.dataUrl.startsWith('data:image/png;base64,'));
  fs.writeFileSync(path.join(root, 'oversize.png'), Buffer.alloc(4 * 1024 * 1024 + 1));
  const oversize = readProjectFile(root, 'oversize.png');
  assert.equal(oversize.kind, 'binary'); assert.equal(Object.hasOwn(oversize, 'dataUrl'), false);
  fs.writeFileSync(path.join(root, 'readonly.txt'), 'preservado'); fs.chmodSync(path.join(root, 'readonly.txt'), 0o444);
  const readonly = readProjectFile(root, 'readonly.txt');
  assert.equal(readonly.readOnly, true);
  assert.throws(() => saveProjectFile(root, 'readonly.txt', 'novo', readonly.revision));
  assert.equal(fs.readFileSync(path.join(root, 'readonly.txt'), 'utf8'), 'preservado');
});

for (const [name, input, content, eol, loneCR, newline] of [
  ['LF', 'a\nb\n', 'a\nb\n', 'lf', false, '\n'],
  ['CRLF', 'a\r\nb\r\n', 'a\nb\n', 'crlf', false, '\r\n'],
  ['mistos', 'a\r\nb\nc\r\n', 'a\nb\nc\n', 'mixed', false, '\r\n'],
  ['sem finais', 'abc', 'abc', 'none', false, '\n'],
  ['vazio', '', '', 'none', false, '\n'],
  ['CR solitário', 'a\rb\r', 'a\rb\r', 'none', true, '\n'],
  ['LF com CR solitário', '\na\rb', '\na\rb', 'lf', true, '\n'],
  ['CRLF com CR solitário', '\r\na\r', '\na\r', 'crlf', true, '\r\n'],
  ['mistos com CR solitário', '\r\n\n\r', '\n\n\r', 'mixed', true, '\r\n'],
]) {
  test(`leitura descreve eol e loneCR: ${name}`, t => {
    const root = project(t);
    fs.writeFileSync(path.join(root, 'app.txt'), input);
    const opened = readProjectFile(root, 'app.txt');
    assert.equal(opened.kind, 'text');
    assert.equal(opened.content, content);
    assert.equal(opened.bom, false);
    assert.equal(opened.newline, newline);
    assert.equal(opened.eol, eol);
    assert.equal(opened.loneCR, loneCR);
  });
}

for (const [name, input, content, bom, eol, loneCR, newline] of [
  ['BOM e CRLF', '\ufeff<h1>novo</h1>\r\n', '<h1>novo</h1>\n', true, 'crlf', false, '\r\n'],
  ['LF sem herdar BOM ou CRLF', 'a\nb\n', 'a\nb\n', false, 'lf', false, '\n'],
  ['finais mistos', 'a\r\nb\nc\r\n', 'a\nb\nc\n', false, 'mixed', false, '\r\n'],
  ['CR solitário', 'a\rb\r', 'a\rb\r', false, 'none', true, '\n'],
  ['emoji', '<p>Olá 🌊😀</p>', '<p>Olá 🌊😀</p>', false, 'none', false, '\n'],
  ['vazio', '', '', false, 'none', false, '\n'],
]) {
  test(`grava bytes exatos e retorna a descrição do texto: ${name}`, t => {
    const root = project(t), target = path.join(root, 'app.html');
    fs.writeFileSync(target, '\ufefforiginal\r\n', { mode: 0o750 });
    const opened = readProjectFile(root, 'app.html'), bytes = Buffer.from(input);
    const saved = saveProjectBytes(root, 'app.html', bytes, opened.revision);
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.deepEqual(bytes, Buffer.from(input));
    assert.equal(fs.statSync(target).mode & 0o777, 0o750);
    assert.equal(saved.kind, 'text');
    assert.equal(saved.content, content);
    assert.equal(saved.bom, bom);
    assert.equal(saved.newline, newline);
    assert.equal(saved.eol, eol);
    assert.equal(saved.loneCR, loneCR);
    assert.equal(saved.size, bytes.length);
    assert.equal(saved.revision, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(saved, readProjectFile(root, 'app.html'));
    assert.deepEqual(fs.readdirSync(root), ['app.html']);
  });
}

test('gravação em bytes recusa conteúdo que não é Buffer e revisão malformada', t => {
  const root = project(t), target = path.join(root, 'app.html');
  fs.writeFileSync(target, 'original');
  const opened = readProjectFile(root, 'app.html');
  for (const bytes of ['texto', new Uint8Array([65]), new ArrayBuffer(1), [65], {}, null, undefined]) {
    assert.throws(() => saveProjectBytes(root, 'app.html', bytes, opened.revision), /inválida/);
  }
  for (const revision of [null, undefined, 123, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), opened.revision + '\n']) {
    assert.throws(() => saveProjectBytes(root, 'app.html', Buffer.from('novo'), revision), /inválida/);
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(root), ['app.html']);
});

test('gravação em bytes aceita 2 MiB e recusa 2 MiB + 1', t => {
  const root = project(t), target = path.join(root, 'app.html');
  fs.writeFileSync(target, 'original');
  const opened = readProjectFile(root, 'app.html'), bytes = Buffer.alloc(2 * 1024 * 1024, 65);
  const saved = saveProjectBytes(root, 'app.html', bytes, opened.revision);
  assert.equal(saved.size, bytes.length);
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.deepEqual(saved, readProjectFile(root, 'app.html'));
  assert.throws(() => saveProjectBytes(root, 'app.html', Buffer.alloc(bytes.length + 1, 65), saved.revision), /inválida/);
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.deepEqual(fs.readdirSync(root), ['app.html']);
});

test('gravação em bytes recusa original maior que 2 MiB', t => {
  const root = project(t), target = path.join(root, 'app.html');
  const original = Buffer.alloc(2 * 1024 * 1024 + 1, 65);
  fs.writeFileSync(target, original);
  const revision = createHash('sha256').update(original).digest('hex');
  assert.throws(() => saveProjectBytes(root, 'app.html', Buffer.from('novo'), revision), /limite/);
  assert.deepEqual(fs.readFileSync(target), original);
  assert.deepEqual(fs.readdirSync(root), ['app.html']);
});

for (const [name, bytes] of [['NUL', Buffer.from([65, 0, 66])], ['UTF-8 inválido', Buffer.from([0xc3, 0x28])]]) {
  test(`gravação em bytes recusa original com ${name}`, t => {
    const root = project(t), target = path.join(root, 'app.html');
    fs.writeFileSync(target, bytes);
    const opened = readProjectFile(root, 'app.html');
    assert.throws(() => saveProjectBytes(root, 'app.html', Buffer.from('novo'), opened.revision), /somente para visualização/);
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.deepEqual(fs.readdirSync(root), ['app.html']);
  });
  test(`gravação em bytes recusa novo conteúdo com ${name}`, t => {
    const root = project(t), target = path.join(root, 'app.html');
    fs.writeFileSync(target, 'original');
    const opened = readProjectFile(root, 'app.html');
    assert.throws(() => saveProjectBytes(root, 'app.html', bytes, opened.revision), /UTF-8/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(root), ['app.html']);
  });
}

test('gravação em bytes recusa imagem mesmo com conteúdo textual', t => {
  const root = project(t);
  for (const name of ['logo.png', 'logo.JPG', 'logo.jpeg', 'logo.gif', 'logo.webp']) {
    const target = path.join(root, name);
    fs.writeFileSync(target, 'texto UTF-8');
    const opened = readProjectFile(root, name);
    assert.throws(() => saveProjectBytes(root, name, Buffer.from('novo'), opened.revision), /somente para visualização/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'texto UTF-8');
  }
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
});

test('gravação em bytes recusa arquivo somente leitura', t => {
  const root = project(t), target = path.join(root, 'readonly.html');
  fs.writeFileSync(target, 'original');
  fs.chmodSync(target, 0o444);
  const opened = readProjectFile(root, 'readonly.html');
  assert.throws(() => saveProjectBytes(root, 'readonly.html', Buffer.from('novo'), opened.revision));
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.equal(fs.statSync(target).mode & 0o777, 0o444);
  assert.deepEqual(fs.readdirSync(root), ['readonly.html']);
});

test('gravação em bytes recusa links de arquivo e diretório externos', t => {
  const root = project(t), outside = project(t), target = path.join(outside, 'secret.html');
  fs.writeFileSync(target, 'original');
  fs.symlinkSync(target, path.join(root, 'externo.html'));
  fs.symlinkSync(outside, path.join(root, 'pasta-externa'));
  const opened = readProjectFile(outside, 'secret.html');
  for (const relative of ['externo.html', 'pasta-externa/secret.html']) {
    assert.throws(() => saveProjectBytes(root, relative, Buffer.from('novo'), opened.revision), /fora do projeto/);
  }
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(root).sort(), ['externo.html', 'pasta-externa']);
  assert.deepEqual(fs.readdirSync(outside), ['secret.html']);
});

test('gravação em bytes preserva links internos', t => {
  const root = project(t), target = path.join(root, 'real.html');
  fs.writeFileSync(target, 'original');
  fs.symlinkSync('real.html', path.join(root, 'alias.html'));
  const opened = readProjectFile(root, 'alias.html'), bytes = Buffer.from('\ufeffnovo\r\n');
  const saved = saveProjectBytes(root, 'alias.html', bytes, opened.revision);
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.equal(fs.lstatSync(path.join(root, 'alias.html')).isSymbolicLink(), true);
  assert.deepEqual(saved, readProjectFile(root, 'alias.html'));
  assert.deepEqual(fs.readdirSync(root).sort(), ['alias.html', 'real.html']);
});

test('gravação em bytes preserva alteração externa em conflito de revisão', t => {
  const root = project(t), target = path.join(root, 'app.html');
  fs.writeFileSync(target, 'original');
  const opened = readProjectFile(root, 'app.html'), external = Buffer.from('\ufeffoutro editor\r\n');
  fs.writeFileSync(target, external);
  assert.throws(() => saveProjectBytes(root, 'app.html', Buffer.from('meu texto'), opened.revision), { code: 'FILE_CONFLICT' });
  assert.deepEqual(fs.readFileSync(target), external);
  assert.deepEqual(fs.readdirSync(root), ['app.html']);
});

for (const [name, save, data] of [['bytes', saveProjectBytes, Buffer.from('novo')], ['texto', saveProjectFile, 'novo']]) {
  test(`escrita atômica em ${name} confere a revisão novamente antes do rename`, t => {
    const root = project(t), target = path.join(root, 'app.html');
    fs.writeFileSync(target, 'original');
    const opened = readProjectFile(root, 'app.html'), fsync = fs.fsyncSync;
    const syncMock = t.mock.method(fs, 'fsyncSync', descriptor => {
      fsync(descriptor);
      assert.equal(fs.readdirSync(root).filter(file => file.endsWith('.tmp')).length, 1);
      fs.writeFileSync(target, 'alteração durante o salvamento');
    });
    assert.throws(() => save(root, 'app.html', data, opened.revision), { code: 'FILE_CONFLICT' });
    assert.equal(syncMock.mock.callCount(), 1);
    assert.equal(fs.readFileSync(target, 'utf8'), 'alteração durante o salvamento');
    assert.deepEqual(fs.readdirSync(root), ['app.html']);
  });

  for (const operation of ['writeFileSync', 'fchmodSync', 'fsyncSync', 'renameSync']) {
    test(`escrita atômica em ${name} remove temporário após falha em ${operation}`, t => {
      const root = project(t), target = path.join(root, 'app.html');
      fs.writeFileSync(target, 'original');
      const opened = readProjectFile(root, 'app.html'), failure = new Error(`falha em ${operation}`);
      t.mock.method(fs, operation, () => { throw failure; });
      assert.throws(() => save(root, 'app.html', data, opened.revision), error => error === failure);
      assert.equal(fs.readFileSync(target, 'utf8'), 'original');
      assert.deepEqual(fs.readdirSync(root), ['app.html']);
    });
  }
}

test('escrita em bytes usa temporário exclusivo no mesmo diretório e fsync antes do rename', t => {
  const root = project(t), directory = path.join(root, 'pasta');
  fs.mkdirSync(directory);
  const target = path.join(directory, 'app.html');
  fs.writeFileSync(target, 'original', { mode: 0o750 });
  const opened = readProjectFile(root, 'pasta/app.html');
  const open = fs.openSync, fsync = fs.fsyncSync, rename = fs.renameSync;
  let temporary, temporaryDescriptor, synced = false;
  t.mock.method(fs, 'openSync', (file, flags, mode) => {
    const descriptor = open(file, flags, mode);
    if (typeof file === 'string' && file.endsWith('.tmp')) {
      temporary = file; temporaryDescriptor = descriptor;
      assert.equal(path.dirname(file), directory);
      assert.equal(flags, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      assert.equal(mode, 0o750);
    }
    return descriptor;
  });
  t.mock.method(fs, 'fsyncSync', descriptor => {
    assert.equal(descriptor, temporaryDescriptor);
    fsync(descriptor); synced = true;
  });
  t.mock.method(fs, 'renameSync', (from, to) => {
    assert.equal(synced, true);
    assert.equal(from, temporary);
    assert.equal(to, target);
    assert.equal(fs.statSync(from).mode & 0o777, 0o750);
    return rename(from, to);
  });
  saveProjectBytes(root, 'pasta/app.html', Buffer.from('novo'), opened.revision);
  assert.equal(synced, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'novo');
  assert.deepEqual(fs.readdirSync(directory), ['app.html']);
});

test('escrita em bytes remove temporário mesmo se o fechamento falhar na limpeza', t => {
  const root = project(t), target = path.join(root, 'app.html');
  fs.writeFileSync(target, 'original');
  const opened = readProjectFile(root, 'app.html'), close = fs.closeSync;
  let temporaryDescriptor;
  t.mock.method(fs, 'fsyncSync', descriptor => {
    temporaryDescriptor = descriptor;
    throw new Error('falha no fsync');
  });
  const closeMock = t.mock.method(fs, 'closeSync', descriptor => {
    close(descriptor);
    if (descriptor === temporaryDescriptor) throw new Error('falha no fechamento');
  });
  assert.throws(() => saveProjectBytes(root, 'app.html', Buffer.from('novo'), opened.revision), /falha no fechamento/);
  closeMock.mock.restore();
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(root), ['app.html']);
});

test('resolveFile e readBounded são reutilizáveis com limite de bytes', t => {
  const root = project(t), target = path.join(root, 'app.html'), bytes = Buffer.from('🌊\r\n');
  fs.writeFileSync(target, bytes);
  const file = resolveFile(root, 'app.html');
  assert.equal(file.base, root);
  assert.equal(file.absolute, target);
  assert.equal(file.relative, 'app.html');
  assert.deepEqual(readBounded(file, bytes.length), bytes);
  assert.equal(readBounded(file, bytes.length - 1), null);
});
