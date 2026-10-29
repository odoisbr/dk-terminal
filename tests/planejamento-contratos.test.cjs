const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = ['M0-host-plugins.json', 'M1-catalogos-etapas.json', 'M2-runner-agente.json', 'M3-preview-bridge.json', 'M4-auditoria.json'];
const details = ['01-m0-m1.md', '01-m0-m1.md', '02-m2-m3.md', '02-m2-m3.md', '03-m4-qualidade.md'];
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

test('contratos incluem o panorama e o detalhe do marco com hashes atuais', () => {
  files.forEach((file, index) => {
    const contract = JSON.parse(fs.readFileSync(path.join(root, 'docs/coordenacoes', file)));
    const paths = contract.contexto.map(entry => entry.arquivo);
    assert.ok(paths.includes('docs/planejamento/README.md'), file);
    assert.ok(paths.includes(`docs/planejamento/${details[index]}`), file);
    for (const source of contract.contexto) assert.equal(source.sha256, sha(fs.readFileSync(path.join(root, source.arquivo))), `${file}: ${source.arquivo}`);
    for (const task of contract.tarefas) assert.deepEqual(task.fontes, paths, `${file}: ${task.id}`);
  });
});

test('contratos declaram a ordem aprovada entre M1, M2, M3 e M4', () => {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, 'docs/coordenacoes', file)));
  const predecessor = (contract, name) => contract.tarefas.find(task => task.id === name);
  const m2 = predecessor(read(files[2]), 'm2-anterior'), m3 = predecessor(read(files[3]), 'm3-anterior'), m4 = predecessor(read(files[4]), 'm4-anterior');
  assert.match(m2.objetivo, /COORD-PLUGINS-M1/);
  assert.match(m3.objetivo, /COORD-PLUGINS-M2/); assert.doesNotMatch(m3.objetivo, /COORD-PLUGINS-M1/);
  assert.match(m4.objetivo, /COORD-PLUGINS-M2/); assert.match(m4.objetivo, /COORD-PLUGINS-M3/);
  assert.ok(read(files[3]).restricoes.some(value => value.includes('estado e as evidências reais de M2')));
  assert.ok(read(files[4]).restricoes.some(value => value.includes('estado e as evidências reais de M2 e M3')));
  // A declaração do contrato não substitui um gate que leia o estado real.
});

test('gerador preserva a estrutura dos contratos e calcula alvos atuais em caminho com espaços', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dk plano com espaços '));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const inputs = new Set(['docs/coordenacoes/gerar.mjs']);
  for (const file of files) {
    const contract = JSON.parse(fs.readFileSync(path.join(root, 'docs/coordenacoes', file)));
    for (const source of contract.contexto) inputs.add(source.arquivo);
    for (const task of contract.tarefas) for (const target of task.contrato_tarefa?.alvos || []) inputs.add(target.arquivo);
  }
  for (const file of inputs) {
    const source = path.join(root, file); if (!fs.existsSync(source)) continue;
    const dest = path.join(temporary, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(source, dest);
  }
  const generate = () => spawnSync(process.execPath, [path.join(temporary, 'docs/coordenacoes/gerar.mjs')], { cwd: temporary, encoding: 'utf8' });
  const first = generate(); assert.equal(first.status, 0, first.stderr);
  const target = path.join(temporary, 'docs/coordenacoes/M3-preview-bridge.json'), one = fs.readFileSync(target);
  // Contracts are frozen planning snapshots. Targets may legitimately appear or
  // change while a milestone is being implemented, so compare their structure
  // and independently verify the freshly generated target hashes.
  const withoutTargetSnapshots = contract => {
    for (const task of contract.tarefas) if (task.contrato_tarefa) {
      task.contrato_tarefa.alvos = task.contrato_tarefa.alvos.map(({ arquivo }) => ({ arquivo }));
    }
    return contract;
  };
  for (const file of files) {
    const generated = JSON.parse(fs.readFileSync(path.join(temporary, 'docs/coordenacoes', file)));
    for (const task of generated.tarefas) for (const target of task.contrato_tarefa?.alvos || []) {
      const source = path.join(temporary, target.arquivo);
      if (fs.existsSync(source)) assert.equal(target.sha256, sha(fs.readFileSync(source)), `${file}: ${target.arquivo}`);
      else assert.equal(target.ausente, true, `${file}: ${target.arquivo}`);
    }
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'docs/coordenacoes', file)));
    assert.deepEqual(withoutTargetSnapshots(generated), withoutTargetSnapshots(saved), file);
  }
  assert.deepEqual(fs.readFileSync(path.join(temporary, 'docs/coordenacoes/host-claude-code.json')), fs.readFileSync(path.join(root, 'docs/coordenacoes/host-claude-code.json')));
  const next = generate(); assert.equal(next.status, 0, next.stderr); assert.deepEqual(fs.readFileSync(target), one);
  const contract = JSON.parse(one), earlier = contract.tarefas.find(task => task.id === 'm3-anterior');
  assert.match(earlier.objetivo, /COORD-PLUGINS-M2/);
});
