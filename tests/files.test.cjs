const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readProjectFile, saveProjectFile } = require('../electron/files.cjs');
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
