const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { actionSpec, dimensions, projectInfo, kitInfo, folderForFile, readState, writeState, knownToolDirectories, extendPath } = require('../electron/core.cjs');

test('ações DK preservam caminhos com espaços e metacaracteres como argumentos', () => {
  const project = { path: "/tmp/Projeto O'Connor; $(touch arquivo)", isDk: true };
  const kit = { cli: '/tmp/Meu kit/cli/dk' };
  const env = { PATH: '/usr/bin:/opt/homebrew/bin' };
  const result = actionSpec('audit', project, kit, env);
  assert.deepEqual(result.args, [kit.cli, 'audit', '--projeto', project.path, '--json']);
  assert.equal(result.args.includes('--apply'), false);
  assert.throws(() => actionSpec('audit; rm -rf', project, kit, env), /desconhecida/);
  assert.throws(() => actionSpec('__proto__', project, kit, env), /desconhecida/);
});
test('validação requer projeto reconhecido, kit e Python', () => {
  const project = { path: '/tmp', isDk: false };
  assert.throws(() => actionSpec('validate', project, {}, {}), /projeto DK/);
  assert.throws(() => actionSpec('doctor', project, null, {}), /plugin DK/);
  assert.throws(() => actionSpec('doctor', project, { cli: '/tmp/dk' }, { PATH: '' }), /Python/);
});
test('IPC recusa dimensões fora dos limites antes de tocar no PTY', () => {
  assert.deepEqual(dimensions({ cols: 120, rows: 40 }), { cols: 120, rows: 40 });
  for (const size of [null, { cols: -1, rows: 20 }, { cols: 10, rows: Infinity }, { cols: 10.5, rows: 20 }, { cols: 10000, rows: 20 }]) {
    assert.throws(() => dimensions(size));
  }
});
test('configuração tem recuperação de corrupção e escrita atômica', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-terminal-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'settings.json');
  fs.writeFileSync(target, '{quebrado');
  assert.deepEqual(readState(target), { projects: [], kitRoot: null, remoteProjects: [] });
  writeState(target, { projects: ['/a', '/a', 2, '/b'], kitRoot: '/kit' });
  assert.deepEqual(readState(target), { projects: ['/a', '/b'], kitRoot: '/kit', remoteProjects: [] });
  assert.equal(fs.readdirSync(root).length, 1);
});
test('inspeção distingue pastas comuns, projetos e raízes do kit', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-terminal-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(projectInfo(root).isDk, false);
  fs.writeFileSync(path.join(root, 'projeto.yml'), 'schema: 2\n');
  assert.equal(folderForFile(path.join(root, 'projeto.yml')), fs.realpathSync(root));
  assert.equal(folderForFile(root), fs.realpathSync(root));
  assert.equal(projectInfo(root).isDk, true);
  assert.throws(() => kitInfo(root), /cli\/dk/);
  fs.mkdirSync(path.join(root, 'cli'));
  fs.writeFileSync(path.join(root, 'cli', 'dk'), '#!/usr/bin/env python3\n');
  assert.equal(kitInfo(root).cli, path.join(fs.realpathSync(root), 'cli', 'dk'));
});
test('tooltip usa o nome declarado no YAML e recorre ao nome da pasta em manifesto ausente ou inválido', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-project-title-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'projeto.yml');
  assert.equal(projectInfo(root).title,path.basename(root));
  fs.writeFileSync(file,'schema: 2\nprojeto: "Credenciamento: Área do Cliente"\n');
  assert.equal(projectInfo(root).title,'Credenciamento: Área do Cliente');
  fs.writeFileSync(file,'projeto: >-\n  Nome do\n  projeto atualizado\n');
  assert.equal(projectInfo(root).title,'Nome do projeto atualizado');
  fs.writeFileSync(file,'projeto: [inválido');
  assert.equal(projectInfo(root).title,path.basename(root));
});

test('pastas conhecidas de CLIs entram só quando existem, com o nvm mais novo primeiro', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-home-'));
  for (const dir of ['.local/bin', '.claude/local', '.nvm/versions/node/v20.11.0/bin', '.nvm/versions/node/v22.3.1/bin', '.nvm/versions/node/lixo']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.writeFileSync(path.join(home, '.volta'), 'arquivo, não pasta');
  const dirs = knownToolDirectories(home, 'darwin');
  assert.deepEqual(dirs.filter(dir => dir.startsWith(home)), [
    path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'),
    path.join(home, '.nvm', 'versions', 'node', 'v22.3.1', 'bin'), path.join(home, '.nvm', 'versions', 'node', 'v20.11.0', 'bin'),
  ]);
  assert.ok(dirs.every(dir => fs.statSync(dir).isDirectory()));
  assert.deepEqual(knownToolDirectories(home, 'win32'), []);
});

test('o PATH do usuário fica na frente e as pastas extras não se repetem', () => {
  const env = { PATH: '/usr/bin:/opt/homebrew/bin', HOME: '/Users/x' };
  const result = extendPath(env, ['/opt/homebrew/bin', '/Users/x/.local/bin']);
  assert.equal(result.PATH, '/usr/bin:/opt/homebrew/bin:/Users/x/.local/bin');
  assert.equal(env.PATH, '/usr/bin:/opt/homebrew/bin');
  assert.equal(extendPath(env, ['/opt/homebrew/bin']), env);
  assert.equal(extendPath({}, ['/a']).PATH, '/a');
});
