const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/coordenacao-hashes.mjs');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-coord-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs/plano.md'), 'plano v1');
  fs.writeFileSync(path.join(root, 'alvo.txt'), 'alvo v1');
  const contract = { contexto: [{ arquivo: 'docs/plano.md', sha256: '0'.repeat(64) }],
    tarefas: [{ id: 't1', contrato_tarefa: { fontes: [{ arquivo: 'docs/plano.md', sha256: '0'.repeat(64) }], alvos: [{ arquivo: 'alvo.txt', sha256: '0'.repeat(64) }, { arquivo: 'novo.txt', ausente: true }] } }, { id: 't2', contrato_tarefa: null }] };
  fs.writeFileSync(path.join(root, 'contrato.json'), JSON.stringify(contract));
  return root;
}
const run = (root, ...args) => spawnSync(process.execPath, [script, 'contrato.json', ...args], { cwd: root, encoding: 'utf8' });
test('atualiza contexto, fontes e alvos existentes e preserva alvos ausentes', t => {
  const root = project(t);
  const check = run(root, '--check');
  assert.equal(check.status, 1); assert.match(check.stdout, /divergente: contexto: docs\/plano.md/);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /3 hash\(es\)/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'contrato.json'), 'utf8'));
  assert.equal(saved.contexto[0].sha256, sha('plano v1'));
  assert.equal(saved.tarefas[0].contrato_tarefa.alvos[0].sha256, sha('alvo v1'));
  assert.deepEqual(saved.tarefas[0].contrato_tarefa.alvos[1], { arquivo: 'novo.txt', ausente: true });
  assert.equal(run(root, '--check').status, 0);
});
test('avisa quando um alvo ausente passou a existir ou uma fonte sumiu, e recusa caminho fora do projeto', t => {
  const root = project(t);
  fs.writeFileSync(path.join(root, 'novo.txt'), 'criado');
  fs.rmSync(path.join(root, 'alvo.txt'));
  const result = run(root);
  assert.equal(result.status, 0); assert.match(result.stderr, /novo.txt já existe/); assert.match(result.stderr, /alvo.txt não existe/);
  assert.notEqual(run(root, '--check').status, 0, 'avisos de arquivo ausente impedem uma validação positiva');
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'contrato.json'), 'utf8'));
  contract.contexto.push({ arquivo: '../fora.md', sha256: '0'.repeat(64) });
  fs.writeFileSync(path.join(root, 'contrato.json'), JSON.stringify(contract));
  assert.notEqual(run(root).status, 0);
});
test('funciona quando o próprio script está em uma pasta com espaços', t => {
  const root = project(t), folder = path.join(root, 'scripts com espaços'); fs.mkdirSync(folder);
  const copy = path.join(folder, 'coordenacao-hashes.mjs'); fs.copyFileSync(script, copy);
  const result = spawnSync(process.execPath, [copy, 'contrato.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /3 hash\(es\)/);
});
test('recusa ler uma fonte por link simbólico para fora do projeto', { skip: process.platform === 'win32' }, t => {
  const root = project(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'fonte.md'), 'externo'); fs.symlinkSync(outside, path.join(root, 'link'));
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'contrato.json'), 'utf8'));
  contract.contexto.push({ arquivo: 'link/fonte.md', sha256: '0'.repeat(64) });
  fs.writeFileSync(path.join(root, 'contrato.json'), JSON.stringify(contract));
  const result = run(root); assert.notEqual(result.status, 0); assert.match(result.stderr, /fora do projeto/);
});
