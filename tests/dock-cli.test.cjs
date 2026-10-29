const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { applicationFor, destination, decodeManagedScript, install, uninstall } = require('../electron/dock-cli.cjs');

function fixture(t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-dock-cli-test-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'Conta'), bundle = path.join(tmp, "SEA Dock 'e $ teste.app");
  const executable = path.join(bundle, 'Contents', 'MacOS', 'SEA Dock');
  const work = path.join(tmp, 'Projeto com espaços\n');
  const launcher = path.join(tmp, 'open falso'), capture = path.join(tmp, 'argumentos');
  fs.mkdirSync(home); fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.mkdirSync(work);
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(launcher, '#!/bin/sh\nprintf "%s\\0" "$@" > "$CAPTURE"\n', { mode: 0o700 });
  const bin = path.join(home, '.local', 'bin');
  const options = { home, executable, envPath: bin, platform: 'darwin', temporaryRoots: [], launcher };
  const invoke = args => spawnSync(destination(home), args, { cwd: work, env: { ...process.env, CAPTURE: capture }, encoding: 'utf8' });
  return { tmp, home, bundle, executable, work, launcher, capture, bin, options, invoke };
}

test('instala sob demanda e encaminha caminhos separados sem interpretar shell', t => {
  const f = fixture(t);
  const folder = "pasta O'Connor $; exemplo", file = '-arquivo com espaço.txt';
  fs.mkdirSync(path.join(f.work, folder)); fs.writeFileSync(path.join(f.work, file), 'texto');
  const result = install(f.options);
  assert.equal(result.alreadyInstalled, false); assert.equal(result.availableInPath, true);
  assert.equal(fs.statSync(result.file).mode & 0o777, 0o700);
  const script = fs.readFileSync(result.file, 'utf8');
  assert.equal(decodeManagedScript(script, f.launcher).bundle, f.bundle);
  const child = f.invoke(['.', folder, file]);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(fs.readFileSync(f.capture, 'utf8').split('\0').slice(0, -1), [
    '-a', f.bundle, '--', path.join(f.work, '.'), path.join(f.work, folder), path.join(f.work, file),
  ].map((value, i) => i === 3 ? `${f.work}/.` : value));
  assert.equal(install(f.options).alreadyInstalled, true);
  assert.equal(uninstall({ home: f.home, platform: 'darwin', launcher: f.launcher }).removed, true);
  assert.equal(uninstall({ home: f.home, platform: 'darwin', launcher: f.launcher }).removed, false);
});

test('sem argumento usa a pasta atual; inválidos não acionam o aplicativo', t => {
  const f = fixture(t); install(f.options);
  let child = f.invoke([]); assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(fs.readFileSync(f.capture, 'utf8').split('\0').slice(0, -1), ['-a', f.bundle, '--', `${f.work}/.`]);
  fs.unlinkSync(f.capture);
  child = f.invoke(['.','não existe']); assert.notEqual(child.status, 0); assert.match(child.stderr, /não encontrado/);
  assert.equal(fs.existsSync(f.capture), false);
  child = f.invoke(Array(33).fill('.')); assert.notEqual(child.status, 0); assert.match(child.stderr, /32 caminhos/);
  assert.equal(fs.existsSync(f.capture), false);
  child = f.invoke(['']); assert.notEqual(child.status, 0); assert.match(child.stderr, /Caminho vazio/);
  assert.equal(fs.existsSync(f.capture), false);
});

test('avisa quando o aplicativo é movido, sem buscar outra cópia silenciosamente', t => {
  const f = fixture(t); install(f.options); fs.renameSync(f.bundle, f.bundle + '.old');
  const child = f.invoke(['.']);
  assert.notEqual(child.status, 0); assert.match(child.stderr, /não foi encontrado no local instalado/);
  assert.equal(fs.existsSync(f.capture), false);
  assert.equal(f.invoke(['--help']).status, 0);
});

test('preserva comando existente, links e arquivo editado', t => {
  const f = fixture(t); fs.mkdirSync(f.bin, { recursive: true });
  const dest = destination(f.home), other = path.join(f.tmp, 'outro');
  fs.writeFileSync(other, 'terceiro'); fs.symlinkSync(other, dest);
  assert.throws(() => install(f.options), /preservado/);
  assert.throws(() => uninstall({ home: f.home, platform: 'darwin', launcher: f.launcher }), /preservado/);
  assert.equal(fs.readFileSync(other, 'utf8'), 'terceiro');
  fs.unlinkSync(dest); fs.writeFileSync(dest, 'meu próprio comando');
  assert.throws(() => install(f.options), /preservado/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'meu próprio comando');
  fs.unlinkSync(dest); install(f.options);
  fs.appendFileSync(dest, '# alteração do usuário\n');
  const modified = fs.readFileSync(dest, 'utf8');
  assert.throws(() => uninstall({ home: f.home, platform: 'darwin', launcher: f.launcher }), /preservado/);
  assert.equal(fs.readFileSync(dest, 'utf8'), modified);
});

test('recusa colisão no PATH e caminhos temporários para o aplicativo', t => {
  const f = fixture(t), otherBin = path.join(f.tmp, 'outro-bin'); fs.mkdirSync(otherBin);
  fs.writeFileSync(path.join(otherBin, 'dock'), '#!/bin/sh\n', { mode: 0o700 });
  assert.throws(() => install({ ...f.options, envPath: `${f.bin}${path.delimiter}${otherBin}` }), /Outro comando dock/);
  assert.equal(fs.existsSync(destination(f.home)), false);
  assert.throws(() => applicationFor(f.executable, [f.tmp]), /pasta permanente/);
  assert.throws(() => install({ ...f.options, platform: 'linux' }), /apenas no macOS/);
  assert.throws(() => install({ ...f.options, platform: 'win32' }), /apenas no macOS/);
});

test('não sobrescreve arquivo criado entre a verificação e a instalação', t => {
  const f = fixture(t), dest = destination(f.home), open = fs.openSync;
  let inserted = false;
  fs.openSync = function (file, flags, mode) {
    if (!inserted && file === dest && typeof flags === 'number' && (flags & fs.constants.O_EXCL)) {
      inserted = true;
      fs.writeFileSync(dest, 'comando concorrente');
    }
    return open.call(this, file, flags, mode);
  };
  t.after(() => { fs.openSync = open; });
  assert.throws(() => install(f.options), /preservado/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'comando concorrente');
});
