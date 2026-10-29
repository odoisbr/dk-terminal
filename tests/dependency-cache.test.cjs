const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { dependencyPlan, detectPackageManager } = require('../electron/dependency-cache.cjs');

function fixture(t, pkg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-dependency-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  return root;
}
function file(root, name, content = '') { fs.writeFileSync(path.join(root, name), content); }

test('reconhece lockfiles e aplica cache sem trocar gerenciador', t => {
  for (const [lock, manager, args] of [
    ['package-lock.json', 'npm', ['install', '--prefer-offline', '--no-save']],
    ['pnpm-lock.yaml', 'pnpm', ['install', '--prefer-offline', '--frozen-lockfile']],
    ['yarn.lock', 'yarn', ['install', '--frozen-lockfile']],
    ['bun.lock', 'bun', ['install', '--frozen-lockfile']],
  ]) {
    const root = fixture(t); file(root, lock, 'conteúdo');
    const result = dependencyPlan(root);
    assert.equal(result.ok, true); assert.equal(result.manager, manager); assert.deepEqual(result.args, args);
    assert.equal(result.lockfile, lock); assert.match(result.revision, /^[a-f0-9]{64}$/);
    assert.match(result.notice, /executar scripts/);
  }
});

test('respeita declaração, não configura cache e informa instalação sem lock', t => {
  const root = fixture(t, { packageManager: 'pnpm@10.5.0' });
  file(root, '.npmrc', 'store-dir=/caminho/escolhido\n');
  const before = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
  const result = dependencyPlan(root);
  assert.equal(result.ok, true); assert.equal(result.manager, 'pnpm');
  assert.equal(result.source, 'packageManager'); assert.deepEqual(result.args, ['install', '--prefer-offline']);
  assert.match(result.notice, /pode criar/); assert.equal(fs.readFileSync(path.join(root, '.npmrc'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(root).sort(), ['.npmrc', 'package.json']);
});

test('detecta configuração específica quando não há lockfile nem declaração', t => {
  for (const [config, manager] of [['pnpm-workspace.yaml', 'pnpm'], ['.yarnrc.yml', 'yarn'], ['bunfig.toml', 'bun']]) {
    const root = fixture(t); file(root, config, '');
    const result = dependencyPlan(root);
    assert.equal(result.ok, true); assert.equal(result.manager, manager); assert.equal(result.source, 'configuration');
  }
  const root = fixture(t); file(root, '.yarnrc.yml'); file(root, 'pnpm-lock.yaml');
  assert.equal(dependencyPlan(root).manager, 'pnpm');
  fs.unlinkSync(path.join(root, 'pnpm-lock.yaml')); file(root, 'bunfig.toml');
  assert.match(dependencyPlan(root).error, /conflito/i);
});

test('recusa lockfiles conflitantes, declaração incompatível e gerenciador desconhecido', t => {
  const root = fixture(t, { packageManager: 'pnpm@10.0.0' });
  file(root, 'package-lock.json');
  assert.match(dependencyPlan(root).error, /conflito/i);
  file(root, 'pnpm-lock.yaml');
  assert.match(dependencyPlan(root).error, /conflito/i);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'custom@1' }));
  assert.match(dependencyPlan(root).error, /não é reconhecido/);
});

test('não converte o lockfile binário do Bun', t => {
  const root = fixture(t); file(root, 'bun.lockb', 'binário');
  assert.match(dependencyPlan(root).error, /convertê/);
  assert.equal(fs.readFileSync(path.join(root, 'bun.lockb'), 'utf8'), 'binário');
});

test('recusa preparar filho de workspace até que a raiz esteja aberta', t => {
  const root = fixture(t, { workspaces: ['packages/*'] });
  const child = path.join(root, 'packages', 'site'); fs.mkdirSync(child, { recursive: true });
  file(child, 'package.json', '{}'); file(root, 'pnpm-lock.yaml');
  assert.match(dependencyPlan(child).error, /raiz do workspace/);
  assert.equal(dependencyPlan(root).manager, 'pnpm');
});

test('revisão muda ao editar manifesto, lockfile ou configuração', t => {
  const root = fixture(t, { packageManager: 'npm@10' }); file(root, 'package-lock.json', '{}');
  const original = dependencyPlan(root); assert.equal(original.ok, true);
  file(root, 'package-lock.json', '{"changed":true}');
  const lockChanged = dependencyPlan(root); assert.notEqual(lockChanged.revision, original.revision);
  file(root, 'package.json', JSON.stringify({ packageManager: 'npm@11' }));
  const manifestChanged = dependencyPlan(root); assert.notEqual(manifestChanged.revision, lockChanged.revision);
  file(root, '.npmrc', 'prefer-offline=true');
  assert.notEqual(dependencyPlan(root).revision, manifestChanged.revision);
});

test('não segue manifesto ou lockfile por link para fora do projeto', t => {
  const root = fixture(t); const outside = fixture(t);
  fs.symlinkSync(path.join(outside, 'package.json'), path.join(root, 'pnpm-lock.yaml'));
  assert.equal(dependencyPlan(root).ok, false);
});

test('informa ausência de manifesto sem confundir com conflito ou erro', t => {
  const root = fixture(t); fs.unlinkSync(path.join(root, 'package.json'));
  const result = dependencyPlan(root);
  assert.equal(result.ok, false); assert.equal(result.reason, 'missing');
  assert.match(result.error, /package\.json/);
});

test('detector de serviços não lê integralmente lockfiles grandes nem bloqueia bun.lockb', t => {
  const root = fixture(t); const lock = path.join(root, 'pnpm-lock.yaml');
  const fd = fs.openSync(lock, 'w'); fs.ftruncateSync(fd, 17 * 1024 * 1024); fs.closeSync(fd);
  assert.equal(detectPackageManager(root).manager, 'pnpm');
  assert.match(dependencyPlan(root).error, /16 MB/);
  fs.unlinkSync(lock); file(root, 'bun.lockb', 'binário');
  assert.equal(detectPackageManager(root).manager, 'bun');
  assert.equal(detectPackageManager(root).binaryLock, true);
  assert.equal(dependencyPlan(root).ok, false);
});
