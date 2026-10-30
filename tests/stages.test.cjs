const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Stages, resolveRegistry, readRegistry, lacunas, deliverableText, prototypeFolder, evaluate } = require('../electron/stages.cjs');
const fixtures = path.join(__dirname, 'fixtures', 'stages');
const kitPath = path.join(fixtures, 'kit-minimo');
const options = { kitPath };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const criteria = snapshot => Object.fromEntries(snapshot.stages.flatMap(s => s.criterios.map(c => [c.id, c])));
async function fixture(t, name) {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sea-stages-'));
  const root = path.join(parent, name);
  await fs.promises.cp(path.join(fixtures, name), root, { recursive: true });
  t.after(() => fs.promises.rm(parent, { recursive: true, force: true }));
  return fs.promises.realpath(root);
}
async function put(root, file, value) {
  const target = path.join(root, file);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
}
async function json(root, file) { return JSON.parse(await fs.promises.readFile(path.join(root, file), 'utf8')); }
async function changeManifest(root, change) {
  const YAML = require('yaml');
  const data = YAML.parse(await fs.promises.readFile(path.join(root, 'projeto.yml'), 'utf8'));
  change(data);
  await put(root, 'projeto.yml', YAML.stringify(data));
}
// Eventos determinísticos exercitam o fs.watch real da classe (filtros, geração e debounce).
// O backend nativo é conferido separadamente: o sandbox pode recusá-lo com EMFILE.
function controlledWatch(t) {
  const original = fs.watch, subscriptions = new Set();
  fs.watch = (dir, options, callback) => {
    const watcher = new EventEmitter(), sub = { dir, callback, watcher, options };
    watcher.close = () => subscriptions.delete(sub);
    subscriptions.add(sub);
    return watcher;
  };
  t.after(() => { fs.watch = original; });
  const emit = (file, event = 'rename') => {
    for (const sub of subscriptions) {
      const rel = path.relative(sub.dir, file);
      if (sub.dir === path.dirname(file) || sub.options.recursive && rel && !rel.startsWith('..') && !path.isAbsolute(rel)) sub.callback(event, rel);
    }
  };
  emit.subscriptions = subscriptions;
  return emit;
}

test('nao-dk → isDk=false; quatro etapas pendentes sem inferir aprovação', async () => {
  const snapshot = await evaluate(path.join(fixtures, 'nao-dk'), options);
  assert.equal(snapshot.isDk, false);
  assert.equal(snapshot.formato, 'ausente');
  assert.deepEqual(snapshot.stages.map(s => s.id), ['levantar', 'entender', 'entregar', 'prototipar']);
  assert.ok(snapshot.stages.every(s => s.estado === 'pendente'));
});

test('vazio v2 registros:{} → L1/L2 pendente não declarado; pastas sem fallback', async () => {
  const snapshot = await evaluate(path.join(fixtures, 'vazio'), options), cs = criteria(snapshot);
  assert.equal(snapshot.formato, 'v2');
  assert.equal(snapshot.esquema, 'canonico');
  for (const id of ['L1', 'L2']) { assert.equal(cs[id].estado, 'pendente'); assert.match(cs[id].motivo, /não declarado/); }
  assert.match(cs.L3.motivo, /registros.regras não declarado no v2/);
  assert.match(cs.D1.motivo, /Declare pastas.levantamento/);
  assert.match(cs.P1.motivo, /Declare pastas.design/);
  assert.ok(snapshot.stages.every(s => s.estado !== 'concluido'));
});

test('canonico → L1/L2 concluido, L3 lista RF-003, E1 refs quebradas, E2 por implementa_regra', async t => {
  const root = await fixture(t, 'canonico');
  // A fixture mínima oficial já possui RF-003 sem fonte; acrescentamos uma referência quebrada.
  const requirements = await json(root, 'registry/requirements.json');
  requirements[0].sources.push('SRC-INEXISTENTE');
  await put(root, 'registry/requirements.json', requirements);
  // O canônico deve vencer os registros DK concorrentes.
  await put(root, 'registry/regras.json', [{ id: 'IGNORAR' }]);
  await put(root, 'registry/requisitos.json', [{ id: 'IGNORAR' }]);
  const snapshot = await evaluate(root, options), cs = criteria(snapshot);
  assert.equal(snapshot.esquema, 'canonico');
  assert.equal(cs.L1.estado, 'concluido');
  assert.equal(cs.L2.estado, 'concluido');
  assert.deepEqual(cs.L3.detalhes, ['RF-003']);
  assert.deepEqual(cs.E1.detalhes, ['RF-001→SRC-INEXISTENTE']);
  assert.deepEqual(cs.E2.detalhes, ['RF-003']);
  assert.ok(!cs.E2.detalhes.includes('RNF-001'));
  assert.deepEqual(cs.E1.fix, { kind: 'action', action: 'entender' });
  assert.match(cs.L1.fonte.arquivo, /business-rules.json/);
  const edges = await json(root, 'registry/traceability.json');
  await put(root, 'registry/traceability.json', edges.filter(e => !(e.from === 'RF-002' && e.relation === 'implementa_regra')));
  assert.deepEqual(criteria(await evaluate(root, options)).E2.detalhes, ['BR-002', 'RF-002', 'RF-003']);
});

test('sem traceability ou implementa_regra → pendente, nunca aprovação por lista vazia', async t => {
  const root = await fixture(t, 'canonico');
  const edges = await json(root, 'registry/traceability.json');
  await put(root, 'registry/traceability.json', edges.filter(e => e.relation !== 'implementa_regra'));
  let cs = criteria(await evaluate(root, options));
  assert.equal(cs.E2.estado, 'pendente');
  assert.match(cs.E2.motivo, /não oferece requisito↔regra/);
  await fs.promises.rm(path.join(root, 'registry/traceability.json'));
  cs = criteria(await evaluate(root, options));
  assert.equal(cs.E2.estado, 'pendente');
  assert.match(cs.E2.motivo, /não oferece/);
});

test('dk-esquema → E1 pendente, E2 por deriva_de e L3 por fonte estruturada', async t => {
  const root = await fixture(t, 'dk-esquema');
  let snapshot = await evaluate(root, options), cs = criteria(snapshot);
  assert.equal(snapshot.esquema, 'dk');
  assert.equal(cs.L3.estado, 'concluido');
  assert.equal(cs.E1.estado, 'pendente');
  assert.match(cs.E1.motivo, /não oferece procedência/);
  assert.equal(cs.E2.estado, 'concluido');
  await put(root, 'registry/requisitos.json', [{ id: 'RF-002', fonte: 'Ata', deriva_de: 'RN-INEXISTENTE' }]);
  cs = criteria(await evaluate(root, options));
  assert.equal(cs.E2.estado, 'pendente');
  assert.deepEqual(cs.E2.detalhes, ['RN-001', 'RF-002']);
});

test('v2 declarado usa caminhos e relacoes; .. e absoluto → indisponivel', async t => {
  const root = await fixture(t, 'v2');
  await put(root, 'registry/requirements.json', 'JSON quebrado que não deve ser lido');
  let snapshot = await evaluate(root, options), cs = criteria(snapshot);
  assert.equal(cs.L2.estado, 'concluido');
  assert.equal(cs.E2.estado, 'concluido');
  assert.equal(cs.L2.fonte.arquivo, path.join('dados', 'requisitos.json'));
  const resolved = await resolveRegistry(root, { schema: 2, cliente: 'Teste', projeto: 'Teste', slug: 'teste', entregaveis: [], registros: { relacoes: 'dados/relacoes.json' } });
  assert.equal(resolved.registros.rastreabilidade.arquivo, path.join(root, 'dados/relacoes.json'));
  for (const value of ['../fora.json', '/tmp/fora.json', 'C:\\fora.json', 'dados/../fora.json']) {
    await changeManifest(root, d => { d.registros.requisitos = value; });
    snapshot = await evaluate(root, options);
    const cs = criteria(snapshot);
    for (const id of ['L1', 'L2', 'L3', 'L4', 'E1', 'E2', 'E3', 'D1', 'D2', 'D3']) assert.equal(cs[id].estado, 'indisponivel', value);
    assert.match(cs.L2.motivo, /caminho/);
    // A base explícita em projeto.json não consome pastas/registros do manifesto.
    assert.equal(cs.P2.estado, 'pendente');
  }
});

test('JSON quebrado → L2 indisponivel; alias bomb e YAML duplicado → tudo indisponivel', async t => {
  const root = await fixture(t, 'invalido');
  let snapshot = await evaluate(root, options);
  assert.equal(criteria(snapshot).L2.estado, 'indisponivel');
  assert.match(criteria(snapshot).L2.motivo, /JSON inválido/);
  const bomb = 'a: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\n';
  for (const source of [bomb, 'projeto: A\nprojeto: B\n', 'projeto: [quebrado', 'fases_concluidas: &ciclo [*ciclo]\n', 'fase_atual: .inf\n']) {
    await put(root, 'projeto.yml', source);
    snapshot = await evaluate(root, options);
    assert.equal(snapshot.isDk, true);
    assert.ok(snapshot.stages.every(s => s.estado === 'indisponivel'));
  }
});

test('>4 MiB gerado em runtime → indisponivel sem abrir o arquivo; >5000 itens recusado', async t => {
  const root = await fixture(t, 'completo'), target = path.join(root, 'dados/requisitos.json');
  const handle = await fs.promises.open(target, 'w');
  await handle.truncate(4 * 1024 * 1024 + 1);
  await handle.close();
  const original = fs.promises.open;
  let opened = false;
  fs.promises.open = async function(file, ...args) { if (String(file) === target) opened = true; return original.call(this, file, ...args); };
  let snapshot;
  try { snapshot = await evaluate(root, options); } finally { fs.promises.open = original; }
  assert.equal(opened, false);
  assert.equal(criteria(snapshot).L2.estado, 'indisponivel');
  assert.match(criteria(snapshot).L2.motivo, /limite de 4194304 bytes/);
  await put(root, 'dados/requisitos.json', Array.from({ length: 5001 }, (_, i) => ({ id: `RF-${i}` })));
  assert.match(criteria(await evaluate(root, options)).L2.motivo, /5000 itens/);
});

test('kit ausente → só L4 indisponivel; checklist inválido e maior que 256 KiB recusados', async t => {
  const root = await fixture(t, 'completo');
  for (const opts of [{}, { kitPath: path.join(root, 'kit-ausente') }]) {
    const cs = criteria(await evaluate(root, opts));
    assert.deepEqual(Object.values(cs).filter(c => c.estado === 'indisponivel').map(c => c.id), ['L4']);
  }
  const kit = await fixture(t, 'kit-minimo');
  for (const body of ['{}', '{', ' '.repeat(256 * 1024 + 1)]) {
    await put(kit, 'templates/checklist-discovery.json', body);
    assert.equal(criteria(await evaluate(root, { kitPath: kit })).L4.estado, 'indisponivel');
  }
});

test('completo → quatro concluido/liberada; remover visao bloqueia prototipar com critérios calculados', async t => {
  const root = await fixture(t, 'completo');
  let snapshot = await evaluate(root, options), cs = criteria(snapshot);
  assert.ok(snapshot.stages.every(s => s.estado === 'concluido' && s.liberada));
  assert.deepEqual(snapshot.declarado, { fase_atual: 1, fases_concluidas: [] });
  assert.equal(cs.D4, undefined);
  assert.ok(Object.values(cs).every(c => c.aplica_se && c.fonte.regra && c.descricao && c.fix));
  assert.equal(cs.L4.detalhes.length, 0);
  await fs.promises.rm(path.join(root, 'descoberta/visao/visao.md'));
  snapshot = await evaluate(root, options); cs = criteria(snapshot);
  assert.equal(snapshot.stages[2].estado, 'pendente');
  assert.equal(snapshot.stages[3].liberada, false);
  assert.equal(snapshot.stages[3].estado, 'concluido');
  assert.match(snapshot.stages[3].bloqueio, /Entregar/);
  assert.equal(cs.P1.estado, 'concluido');
  assert.equal(cs.P2.estado, 'concluido');
  // Um gate anterior bloqueia toda a cascata, mesmo que o imediatamente anterior esteja concluído.
  const req = await json(root, 'dados/requisitos.json'); req.items[0].sources = [];
  await put(root, 'dados/requisitos.json', req);
  assert.deepEqual((await evaluate(root, options)).stages.map(s => s.liberada), [true, false, false, false]);
});

test('indisponivel nunca vira concluido; procedência e detalhes limitados a oito itens', async t => {
  const root = await fixture(t, 'completo');
  await put(root, 'dados/requisitos.json', Array.from({ length: 12 }, (_, i) => ({ id: `RF-${i}`, sources: [] })));
  let cs = criteria(await evaluate(root, options));
  assert.equal(cs.L3.estado, 'pendente');
  assert.equal(cs.L3.detalhes.length, 8);
  await put(root, 'dados/requisitos.json', { itens: [], items: [] });
  const snapshot = await evaluate(root, options); cs = criteria(snapshot);
  assert.equal(cs.L2.estado, 'indisponivel');
  assert.equal(snapshot.stages[0].estado, 'indisponivel');
  assert.notEqual(cs.D3.estado, 'concluido');
});

test('readRegistry aceita envelope, recusa lote, sources, fonte e id inválidos', async t => {
  const root = await fixture(t, 'v2'), file = path.join(root, 'dados/requisitos.json');
  await put(root, 'dados/requisitos.json', { itens: [{ id: 'RF-001', fonte: { arquivo: 'ata.md', citacao: 'Fala' } }], versao: 1 });
  assert.equal((await readRegistry(file))[0].id, 'RF-001');
  for (const invalid of [false, null, {}, [1], { itens: [], items: [] }, [{ id: 'RF', sources: [1] }], [{ id: 'RF', fonte: {} }]]) {
    await put(root, 'dados/requisitos.json', invalid);
    await assert.rejects(readRegistry(file));
  }
  await put(root, 'dados/requisitos.json', [{ id: 42 }]);
  assert.equal(criteria(await evaluate(root, options)).L2.estado, 'indisponivel');
  await put(root, 'dados/relacoes.json', [{ from: 42, relation: 'implementa_regra' }]);
  assert.equal(criteria(await evaluate(root, options)).E2.estado, 'indisponivel');
  assert.deepEqual(await readRegistry(path.join(root, 'nao-existe/ausente.json')), []);
});

test('lacunas porta radicais Unicode e estados AUSENTE/PENDENTE/PARCIAL/COBERTO', () => {
  const checklist = [{ id: 'CL-1', tema: 'Dados', pergunta: 'Quais dados?', prioridade: 'CRITICA', sinais: ['dado', 'api', 'restri'] }];
  const part = (id, texto, estado = 'resposta', validada = true) => ({ id, texto, estado, validada });
  const status = corpus => lacunas(corpus, checklist)[0].status;
  assert.equal(status([part('X', 'metadados capilar édado ２api _api')]), 'AUSENTE');
  assert.equal(status([part('P', 'Dados da integração', 'pendente')]), 'PENDENTE');
  assert.equal(status([part('R', 'restrições', 'resposta', false)]), 'PARCIAL');
  assert.equal(status([part('R1', 'DADOS'), part('R2', 'API')]), 'COBERTO');
  assert.equal(status([part('R1', 'dados'), part('R2', 'api'), part('P', 'dados', 'pendente')]), 'PARCIAL');
  assert.equal(lacunas({ pendencias: [{ id: 'P', enunciado: 'Pergunta', resposta_decidida: 'dados', status: 'aberta' }] }, checklist)[0].status, 'AUSENTE');
  assert.equal(lacunas({ pendencias: [{ id: 'P', enunciado: 'Pergunta', resposta_decidida: 'dados', status: 'decidida', fonte: 'Ata' }] }, checklist)[0].status, 'PARCIAL');
  assert.equal(lacunas({ decisoes: [{ id: 'D', title: 'dados', citacao: 'api', status: 'aprovada', fonte: 'Ata' }] }, checklist)[0].status, 'AUSENTE');
  assert.equal(lacunas({ requisitos: [{ id: 'R1', titulo: 'dados', fonte: [], status: 'aprovado' }, { id: 'R2', titulo: 'dados', fonte: [], status: 'aprovado' }] }, checklist)[0].status, 'PARCIAL');
  assert.throws(() => lacunas([], {}), /Checklist/);
});

test('E1 aceita evidências e sources em texto; ausência de fontes/evidências fica pendente', async t => {
  const root = await fixture(t, 'completo');
  const requirements = await json(root, 'dados/requisitos.json'); requirements.items[0].sources = 'EVD-001';
  await put(root, 'dados/requisitos.json', requirements);
  assert.equal(criteria(await evaluate(root, options)).E1.estado, 'concluido');
  await put(root, 'dados/fontes.json', []);
  await put(root, 'dados/evidencias.json', []);
  const cs = criteria(await evaluate(root, options));
  assert.equal(cs.E1.estado, 'pendente');
  assert.match(cs.E1.motivo, /não oferece procedência/);
});

test('E3 prova documental por relato pendente; ausência de pendências com registros concluída', async t => {
  const root = await fixture(t, 'completo');
  let cs = criteria(await evaluate(root, options));
  assert.equal(cs.E3.estado, 'concluido');
  assert.match(cs.E3.motivo, /Sem pendências/);
  await put(root, 'dados/pendencias.json', [{ id: 'P-001', status: 'resolvida_por_relato', pendencia_de_prova: true, enunciado: 'Exige confirmação ESCRITA.' }]);
  cs = criteria(await evaluate(root, options));
  assert.equal(cs.E3.estado, 'pendente');
  assert.deepEqual(cs.E3.detalhes, ['P-001']);
  assert.equal(cs.E3.fix.skill, 'dk:dk-entender');
  await put(root, 'dados/pendencias.json', '[');
  assert.equal(criteria(await evaluate(root, options)).E3.estado, 'indisponivel');
});

test('documentos adotados: hash válido/divergente, status pendente e tamanho de hash ≤16 MiB', async t => {
  const root = await fixture(t, 'completo');
  await fs.promises.rm(path.join(root, 'descoberta/visao'), { recursive: true });
  await put(root, 'externos/visao.pdf', 'Arquivo binário sintético');
  const sha256 = createHash('sha256').update('Arquivo binário sintético').digest('hex');
  const adoption = [{ tipo: 'visao', caminho: 'externos/visao.pdf', status: 'adotado', sha256 }];
  await put(root, '.dk/adocoes.json', { adocoes: adoption });
  assert.equal(criteria(await evaluate(root, options)).D2.estado, 'concluido');
  adoption[0].caminho = path.join(root, 'externos/visao.pdf');
  await put(root, '.dk/adocoes.json', adoption);
  assert.equal(criteria(await evaluate(root, options)).D2.estado, 'concluido');
  adoption[0].sha256 = '0'.repeat(64);
  await put(root, '.dk/adocoes.json', adoption);
  let cs = criteria(await evaluate(root, options));
  assert.equal(cs.D2.estado, 'indisponivel');
  assert.match(cs.D2.motivo, /SHA-256 divergente/);
  assert.equal(cs.D3.estado, 'indisponivel');
  adoption[0].sha256 = sha256; adoption[0].status = 'pendente';
  await put(root, '.dk/adocoes.json', adoption);
  assert.equal(criteria(await evaluate(root, options)).D2.estado, 'pendente');
  const handle = await fs.promises.open(path.join(root, 'externos/visao.pdf'), 'w');
  await handle.truncate(16 * 1024 * 1024 + 1); await handle.close();
  assert.match(criteria(await evaluate(root, options)).D2.motivo, /limite de 16777216 bytes/);
});

test('D3 limites literais de ID; PDF/DOCX não lidos e nenhum texto deixa pendente', async t => {
  const root = await fixture(t, 'completo');
  await put(root, 'dados/requisitos.json', [{ id: 'NF-001', sources: ['SRC-001'] }, { id: '#RF-001', sources: ['SRC-001'] }]);
  await put(root, 'descoberta/requisitos/requisitos.md', 'RNF-001; #RF-001');
  let cs = criteria(await evaluate(root, options));
  assert.deepEqual(cs.D3.detalhes, ['NF-001']);
  await put(root, 'descoberta/requisitos/requisitos.md', 'NF-001; #RF-001.');
  assert.equal(criteria(await evaluate(root, options)).D3.estado, 'concluido');
  for (const dir of ['descoberta/requisitos', 'descoberta/visao']) await fs.promises.rm(path.join(root, dir), { recursive: true });
  await put(root, 'descoberta/requisitos/requisitos.pdf', 'NF-001 #RF-001');
  await put(root, 'descoberta/visao/visao.docx', 'NF-001 #RF-001');
  cs = criteria(await evaluate(root, options));
  assert.equal(cs.D1.estado, 'concluido');
  assert.equal(cs.D2.estado, 'concluido');
  assert.equal(cs.D3.estado, 'pendente');
  assert.match(cs.D3.motivo, /Sem texto legível/);
});

test('documentos: ≤2 MiB/arquivo, ≤8 MiB total, ≤32/pasta e UTF-8 legível', async t => {
  const root = await fixture(t, 'completo');
  await put(root, 'descoberta/requisitos/requisitos.md', 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.match(criteria(await evaluate(root, options)).D3.motivo, /limite de 2097152 bytes/);
  await put(root, 'descoberta/requisitos/requisitos.md', 'x'.repeat(2 * 1024 * 1024));
  for (let i = 0; i < 4; i++) await put(root, `descoberta/requisitos/d${i}.txt`, 'x'.repeat(2 * 1024 * 1024));
  assert.match(criteria(await evaluate(root, options)).D3.motivo, /8 MiB/);
  await fs.promises.rm(path.join(root, 'descoberta/requisitos'), { recursive: true });
  for (let i = 0; i < 33; i++) await put(root, `descoberta/requisitos/d${i}.md`, 'RF-001');
  let cs = criteria(await evaluate(root, options));
  assert.equal(cs.D1.estado, 'indisponivel');
  assert.match(cs.D1.motivo, /32 documentos/);
  await fs.promises.rm(path.join(root, 'descoberta/requisitos'), { recursive: true });
  await put(root, 'descoberta/requisitos/requisitos.md', 'RF-001');
  await fs.promises.writeFile(path.join(root, 'descoberta/requisitos/requisitos.md'), Buffer.from([0xff, 0xfe]));
  assert.equal(criteria(await evaluate(root, options)).D3.estado, 'indisponivel');
  const adopted = [];
  for (let i = 0; i < 33; i++) {
    await put(root, `fora/d${i}.pdf`, 'Documento sintético');
    adopted.push({ tipo: 'visao', caminho: `fora/d${i}.pdf`, status: 'validado' });
  }
  await put(root, '.dk/adocoes.json', adopted);
  assert.match(criteria(await evaluate(root, options)).D2.motivo, /32 documentos/);
});

test('portal exige D4 em pastas.entregaveis; demanda omite D4; projeto.json inválido falha', async t => {
  const root = await fixture(t, 'completo');
  const config = await json(root, '.dk/projeto.json'); config.contexto = 'portal';
  await put(root, '.dk/projeto.json', config);
  let cs = criteria(await evaluate(root, options));
  assert.equal(cs.D4.estado, 'pendente');
  await put(root, 'entrega/checklist-dod.md', '# DoD sintético');
  assert.equal(criteria(await evaluate(root, options)).D4.estado, 'concluido');
  await put(root, '.dk/projeto.json', '{');
  cs = criteria(await evaluate(root, options));
  for (const id of ['D4', 'P1', 'P2']) assert.equal(cs[id].estado, 'indisponivel');
  await put(root, '.dk/projeto.json', null);
  assert.equal(criteria(await evaluate(root, options)).P2.estado, 'indisponivel');
});

test('achado 6: symlinks internos são aceitos; externos declarados invalidam o contrato v2', async t => {
  for (const target of ['dados/requisitos.json', 'dados', 'descoberta/visao/visao.md', 'interface/design-system']) {
    const root = await fixture(t, 'completo');
    const file = path.join(root, target), outside = file + '-original';
    await fs.promises.rename(file, outside);
    await fs.promises.symlink(outside, file);
    let snapshot = await evaluate(root, options), cs = criteria(snapshot);
    const id = target.startsWith('dados') ? 'L2' : target.startsWith('descoberta') ? 'D2' : 'P2';
    assert.equal(cs[id].estado, 'concluido');
    await fs.promises.rm(file);
    const external = path.join(path.dirname(root), 'externo');
    await fs.promises.rename(outside, external);
    await fs.promises.symlink(external, file);
    snapshot = await evaluate(root, options); cs = criteria(snapshot);
    assert.equal(cs[id].estado, 'indisponivel');
    assert.match(cs[id].motivo, /fora do projeto/);
    if (target.startsWith('dados')) {
      for (const dependent of ['L1', 'L2', 'L3', 'L4', 'E1', 'E2', 'E3', 'D1', 'D2', 'D3']) {
        assert.equal(cs[dependent].estado, 'indisponivel', dependent);
        assert.match(cs[dependent].motivo, /^projeto.yml v2 inválido: symlink\/caminho fora do projeto: dados\//);
      }
    } else assert.equal(cs.L2.estado, 'concluido');
  }
  const root = await fixture(t, 'completo');
  await put(root, '.dk/adocoes.json', [{ tipo: 'visao', caminho: '../externo.md', status: 'adotado' }]);
  assert.equal(criteria(await evaluate(root, options)).D2.estado, 'indisponivel');
});

test('P1 profundidade ≤4, ≤2000 entradas; ignora node_modules/.git/design-system', async t => {
  const root = await fixture(t, 'completo');
  for (const name of ['node_modules', '.git', 'design-system']) await put(root, `interface/prototipo/${name}/a/b/c/d/e/invalido.html`, '<html>');
  await put(root, 'interface/prototipo/a/b/c/d/tela.htm', '<html>');
  let cs = criteria(await evaluate(root, options));
  assert.equal(cs.P1.estado, 'concluido');
  assert.equal(cs.P1.detalhes.length, 2);
  await put(root, 'interface/prototipo/a/b/c/d/e/tela.html', '<html>');
  assert.match(criteria(await evaluate(root, options)).P1.motivo, /profundidade de 4/);
  await fs.promises.rm(path.join(root, 'interface/prototipo/a'), { recursive: true });
  for (let i = 0; i < 2001; i++) await put(root, `interface/prototipo/f${i}`, '');
  assert.match(criteria(await evaluate(root, options)).P1.motivo, /2000 entradas/);
});

test('P2 valida a base e cargas; submodule verifica existência sem executar Git', async t => {
  const root = await fixture(t, 'completo');
  const config = await json(root, '.dk/projeto.json');
  config.prototipo.design_system.modo = 'submodule';
  config.prototipo.design_system.repositorio = 'https://example.invalid/ds.git';
  config.prototipo.design_system.commit = 'a'.repeat(40);
  await put(root, '.dk/projeto.json', config);
  let cs = criteria(await evaluate(root, options));
  assert.equal(cs.P2.estado, 'concluido');
  assert.match(cs.P2.detalhes[0], /somente existência/);
  config.prototipo.design_system.commit = 'SHA-curto';
  await put(root, '.dk/projeto.json', config);
  assert.match(criteria(await evaluate(root, options)).P2.motivo, /design_system.commit/);
  config.prototipo.design_system.commit = 'a'.repeat(40);
  config.prototipo.design_system.carga = ['ausente.css'];
  await put(root, '.dk/projeto.json', config);
  assert.match(criteria(await evaluate(root, options)).P2.motivo, /carga: arquivo não encontrado/);
  assert.equal(prototypeFolder(root, { schema: 2, pastas: { design: 'layout' } }), path.join(root, 'layout/prototipo'));
  assert.equal(prototypeFolder(root, {}), path.join(root, '2-design/prototipo'));
});

test('formatos v1-pt e legacyEN; fase declarada nunca conclui etapa; YAML merge limitado', async t => {
  const root = await fixture(t, 'vazio');
  await put(root, 'projeto.yml', 'project:\n  name: Legado\n  current_phase: 8\n  completed_phases: [1, 2, 3, 4, 5, 6, 7, 8]\n');
  let snapshot = await evaluate(root, options);
  assert.equal(snapshot.formato, 'legacyEN');
  assert.equal(snapshot.declarado.fase_atual, 8);
  assert.ok(snapshot.stages.every(s => s.estado !== 'concluido'));
  await put(root, 'projeto.yml', 'base: &base\n  projeto: Exemplo\n<<: *base\nfase_atual: 8\n');
  snapshot = await evaluate(root, options);
  assert.equal(snapshot.formato, 'v1-pt');
  assert.equal(snapshot.declarado.fase_atual, 8);
  assert.equal(criteria(snapshot).L1.estado, 'pendente');
});

test('watch emite um stages:changed coalescido; criação de documento novo; closeProject não emite', async t => {
  const emit = controlledWatch(t);
  const root = await fixture(t, 'completo'), events = [], stages = new Stages(event => events.push(event));
  t.after(() => stages.close());
  const snapshot = await stages.read(root, options);
  assert.equal(snapshot.watching, true);
  assert.ok(stages.watchers.length <= 16);
  await put(root, 'descoberta/visao/nova.md', '# Visão nova');
  emit(path.join(root, 'descoberta/visao/nova.md'));
  await put(root, 'descoberta/visao/nova.md', '# Visão editada');
  emit(path.join(root, 'descoberta/visao/nova.md'));
  await put(root, 'descoberta/visao/nova.md', '# Visão final');
  emit(path.join(root, 'descoberta/visao/nova.md'));
  await sleep(800);
  assert.deepEqual(events, [{ path: root }]);
  const updated = await stages.read(root, options);
  assert.notStrictEqual(updated, snapshot);
  stages.closeProject(root);
  assert.equal(stages.cache, null);
  assert.equal(stages.watchers.length, 0);
  await put(root, 'descoberta/visao/nova.md', '# Não observado');
  emit(path.join(root, 'descoberta/visao/nova.md'));
  await sleep(600);
  assert.equal(events.length, 1);
});

test('releitura sem mudança devolve cache; refresh recalcula; stamps invalidam sem watcher', async t => {
  const root = await fixture(t, 'completo'), stages = new Stages();
  t.after(() => stages.close());
  const first = await stages.read(root, options);
  assert.strictEqual(await stages.read(root, options), first);
  const refreshed = await stages.read(root, { ...options, refresh: true });
  assert.notStrictEqual(refreshed, first);
  assert.equal(refreshed.watching, false);
  await fs.promises.rm(path.join(root, 'descoberta/visao/visao.md'));
  const changed = await stages.read(root, options);
  assert.notStrictEqual(changed, refreshed);
  assert.equal(criteria(changed).D2.estado, 'pendente');
  await put(root, 'descoberta/visao/nova.md', '# Visão');
  assert.equal(criteria(await stages.read(root, options)).D2.estado, 'concluido');
  const kit = await fixture(t, 'kit-minimo');
  const beforeKit = await stages.read(root, { kitPath: kit });
  await put(kit, 'templates/checklist-discovery.json', '{');
  const afterKit = await stages.read(root, { kitPath: kit });
  assert.notStrictEqual(afterKit, beforeKit);
  assert.equal(criteria(afterKit).L4.estado, 'indisponivel');
});

test('A não vaza em B; troca/close durante leitura não ressuscita cache ou watchers', async t => {
  const emit = controlledWatch(t);
  const a = await fixture(t, 'completo'), b = await fixture(t, 'vazio'), events = [];
  const stages = new Stages(event => events.push(event));
  t.after(() => stages.close());
  await stages.read(a, options);
  const snapshot = await stages.read(b, options);
  assert.equal(snapshot.root, b);
  assert.equal(criteria(snapshot).L1.estado, 'pendente');
  await put(a, 'descoberta/visao/visao.md', '# Mudança em A');
  emit(path.join(a, 'descoberta/visao/visao.md'));
  await sleep(600);
  assert.equal(events.length, 0);
  stages.closeProject(b);
  assert.equal(stages.activeRoot, null);
  const old = stages.read(a, options);
  const current = stages.read(b, options);
  await assert.rejects(old, /Projeto alterado/);
  assert.equal((await current).root, b);
  const pending = stages.read(a, options);
  stages.closeProject(a);
  await assert.rejects(pending, /Projeto alterado/);
  assert.equal(stages.cache, null);
  assert.equal(stages.watchers.length, 0);
});

test('fs.watch nativo: evento ou fallback explícito se o sistema recusar monitoramento', async t => {
  const root = await fixture(t, 'completo'), events = [];
  const stages = new Stages(event => events.push(event));
  t.after(() => stages.close());
  const original = fs.watch;
  let installationError = null, installing = true;
  fs.watch = function(...args) {
    try {
      const watcher = original.apply(this, args);
      watcher.on('error', e => { if (installing) installationError = e; });
      return watcher;
    } catch (e) { installationError = e; throw e; }
  };
  let snapshot;
  try { snapshot = await stages.read(root, options); } finally { installing = false; fs.watch = original; }
  if (!snapshot.watching) {
    assert.ok(installationError, 'Fallback exige erro de fs.watch durante a instalação (throw ou evento error inicial).');
    assert.ok(snapshot.errors.some(e => /Monitoramento.*Recarregar/.test(e)));
    t.diagnostic(`Monitoramento nativo: erro de instalação ${installationError.code || installationError.message}; fallback verificado.`);
    return;
  }
  assert.equal(installationError, null);
  await sleep(100);
  await put(root, 'descoberta/visao/visao.md', '# Visão nativa');
  for (let i = 0; i < 30 && !events.length && snapshot.watching; i++) await sleep(100);
  assert.deepEqual(events, [{ path: root }], 'watching=true na instalação exige evento nativo.');
});

test('achado 11: o teste nativo reprova fallback posterior à instalação sem evento', async () => {
  const execFile = require('node:util').promisify(require('node:child_process').execFile);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(execFile(process.execPath, ['--require', path.join(fixtures, 'watch-late-error.cjs'), '--test', '--test-name-pattern=^fs.watch nativo:', __filename], { timeout: 10000, env }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout + error.stderr, /watching=true na instalação exige evento nativo/);
    return true;
  });
});

test('monitoramento limitado a 16 watchers; falha de fs.watch oferece Recarregar', async t => {
  controlledWatch(t);
  const root = await fixture(t, 'completo'), stages = new Stages(() => {});
  t.after(() => stages.close());
  for (let i = 0; i < 17; i++) await put(root, `interface/prototipo/p${i}/tela.html`, '<html>');
  let snapshot = await stages.read(root, options);
  assert.equal(snapshot.watching, true);
  assert.ok(stages.watchers.length <= 16);
  assert.equal(criteria(snapshot).P1.estado, 'concluido');
  await fs.promises.rm(path.join(root, 'interface/prototipo'), { recursive: true });
  await put(root, 'interface/prototipo/index.html', '<html>');
  const original = fs.watch;
  fs.watch = () => { throw new Error('Falha sintética'); };
  try { snapshot = await stages.read(root, { ...options, refresh: true }); } finally { fs.watch = original; }
  assert.equal(snapshot.watching, false);
  assert.ok(snapshot.errors.some(e => /Recarregar/.test(e)));
});

test('limites de projeto.yml e diretórios; deliverableText exportado mantém só os textos', async t => {
  const root = await fixture(t, 'completo');
  const text = await deliverableText(root, { requisitos: 'descoberta/requisitos', visao: 'descoberta/visao', ata: 'descoberta/atas' });
  assert.match(text, /RF-001/);
  await put(root, 'projeto.yml', ' '.repeat(256 * 1024 + 1));
  assert.ok((await evaluate(root, options)).stages.every(s => s.estado === 'indisponivel'));
  await put(root, 'projeto.yml', 'projeto: Limites\n');
  for (let i = 0; i < 513; i++) await put(root, `1-levantamento/requisitos/f${i}`, '');
  assert.match(criteria(await evaluate(root, options)).D1.motivo, /512 entradas/);
});

// Regressões da revisão independente do pacote M1 b.
test('achado 1: contrato v2 rejeita identidade, seleção, fases e conflito operacional', async t => {
  const cases = [
    [d => { delete d.slug; delete d.entregaveis; }, /slug é obrigatório; entregaveis deve ser lista explícita; \[\] significa nenhum/],
    [d => { d.cliente = ''; d.projeto = 7; }, /cliente é obrigatório; projeto é obrigatório/],
    [d => { d.fase_atual = true; d.fases_concluidas = [1, 1]; }, /fase_atual deve ser inteiro de 1 a 8; fases_concluidas exige lista não repetida/],
    [d => { d.entregaveis = [{ id: 'x' }]; }, /seleção exige id e revisao explícitos; artefato exige formatos explícitos não repetidos/],
    [d => { d.entregaveis = [{ grupo: 'fluxos' }]; }, /grupo fluxos exige itens explícitos/],
    [d => { d.entregaveis = [{ id: 'x', revisao: '1', formatos: ['html'] }, { id: 'x', revisao: '1', formatos: ['html'] }]; }, /ID selecionado duas vezes: x/],
  ];
  for (const [change, message] of cases) {
    const root = await fixture(t, 'completo');
    await changeManifest(root, change);
    const cs = criteria(await evaluate(root, options));
    for (const id of ['L1', 'L2', 'L3', 'L4', 'E1', 'E2', 'E3', 'D1', 'D2', 'D3']) {
      assert.equal(cs[id].estado, 'indisponivel', id);
      assert.match(cs[id].motivo, message);
    }
  }
  const root = await fixture(t, 'completo');
  const config = await json(root, '.dk/projeto.json');
  config.registros = { regras: 'outro/regras.json' };
  await put(root, '.dk/projeto.json', config);
  const cs = criteria(await evaluate(root, options));
  assert.equal(cs.L1.estado, 'indisponivel');
  assert.match(cs.L1.motivo, /projeto.yml v2 inválido: registros.regras diverge de projeto.yml/);
  assert.equal(cs.D1.estado, 'indisponivel');
});

test('achado 2: registro não declarado em v2 fica pendente em todos os consumidores', async t => {
  for (const [key, consumers] of [['pendencias', ['L4', 'E3']], ['decisoes', ['L4']], ['fontes', ['E1']], ['evidencias', ['E1']], ['relacoes', ['E2']]]) {
    const root = await fixture(t, 'completo');
    await changeManifest(root, d => { delete d.registros[key]; });
    const cs = criteria(await evaluate(root, options));
    for (const id of consumers) {
      assert.equal(cs[id].estado, 'pendente', `${key}: ${id}`);
      assert.match(cs[id].motivo, new RegExp(`registros.${key} não declarado no v2`));
    }
  }
});

test('achado 3: D3 indexa 5000 IDs em 2 MiB com event loop responsivo', async t => {
  const root = await fixture(t, 'completo');
  const ids = Array.from({ length: 5000 }, (_, i) => `RF-${String(i).padStart(5, '0')}`);
  await put(root, 'dados/requisitos.json', ids.map(id => ({ id })));
  // IDs ausentes obrigavam a implementação antiga a varrer todo o corpus 5000 vezes.
  await put(root, 'descoberta/requisitos/requisitos.md', 'x'.repeat(2 * 1024 * 1024));
  let last = performance.now(), longest = 0;
  const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 5);
  const start = performance.now();
  let cs;
  try { cs = criteria(await evaluate(root, options)); } finally { clearInterval(timer); }
  const elapsed = performance.now() - start;
  assert.equal(cs.D3.estado, 'pendente');
  assert.deepEqual(cs.D3.detalhes, ids.slice(0, 8));
  assert.ok(elapsed < 500, `5000 IDs/2 MiB: ${elapsed.toFixed(1)} ms`);
  assert.ok(Math.max(longest, performance.now() - last) < 150, `event loop: ${longest.toFixed(1)} ms`);
  t.diagnostic(`D3 (incluindo avaliação): ${elapsed.toFixed(1)} ms; intervalo máximo: ${longest.toFixed(1)} ms`);
});

test('achado 3: fronteiras ASCII, sobreposição, pontuação e IDs Unicode são literais', async t => {
  const root = await fixture(t, 'completo');
  const ids = ['RF-01', 'RF-010', '#RF', 'A+B', 'éX', '.+', 'R F', 'RF_2'];
  await put(root, 'dados/requisitos.json', ids.map(id => ({ id })));
  for (const body of ['xRF-01 RF-010z _#RF A+Bx éX_ .+x R Fx RF_20', 'éRF-01 RF-010. #RF A+B éX .+ R F RF_2']) {
    await put(root, 'descoberta/requisitos/requisitos.md', body);
    const cs = criteria(await evaluate(root, options));
    const expected = ids.filter(id => !new RegExp(`(?<![A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`).test(body));
    assert.deepEqual(cs.D3.detalhes, expected);
  }
});

test('achado 4: padrões Python da base são texto; compilação pertence ao kit', async t => {
  const root = await fixture(t, 'completo'), config = await json(root, '.dk/projeto.json');
  config.prototipo.regras = { proibido: [{ padrao: '(?i)bootstrap' }, { padrao: '(?P<nome>foo)' }] };
  await put(root, '.dk/projeto.json', config);
  let cs = criteria(await evaluate(root, options));
  assert.equal(cs.P1.estado, 'concluido');
  assert.equal(cs.P2.estado, 'concluido');
  config.prototipo.regras.proibido[0].padrao = '';
  await put(root, '.dk/projeto.json', config);
  cs = criteria(await evaluate(root, options));
  assert.equal(cs.P2.estado, 'indisponivel');
  assert.match(cs.P2.motivo, /padrao: obrigatório, texto/);
});

test('achado 5: um watcher recursivo cobre subpastas e novas telas sem esgotar orçamento', async t => {
  const emit = controlledWatch(t), root = await fixture(t, 'completo'), events = [];
  for (let i = 0; i < 20; i++) await put(root, `interface/prototipo/p${i}/tela.html`, '<html>');
  const stages = new Stages(e => events.push(e));
  t.after(() => stages.close());
  const snapshot = await stages.read(root, options);
  assert.equal(snapshot.watching, true);
  assert.ok(stages.watchers.length <= 16);
  const prototype = path.join(root, 'interface/prototipo');
  const subs = [...emit.subscriptions].filter(s => s.dir.startsWith(prototype));
  assert.equal(subs.length, 1);
  assert.equal(subs[0].dir, prototype);
  assert.equal(subs[0].options.recursive, true);
  await put(root, 'interface/prototipo/nova/interna/tela.html', '<html>');
  emit(path.join(root, 'interface/prototipo/nova/interna/tela.html'));
  await sleep(550);
  assert.deepEqual(events, [{ path: root }]);
});

test('achado 6: v1 ignora pastas e registros declarados', async t => {
  const legacy = await fixture(t, 'dk-esquema');
  await changeManifest(legacy, d => { d.pastas = 'ignorado'; d.registros = { requisitos: '../fora.json' }; });
  const cs = criteria(await evaluate(legacy, options));
  assert.equal(cs.L2.estado, 'concluido');
  assert.equal(cs.E2.estado, 'concluido');
});

test('achado 7: v2 sem pastas usa padrões; objeto vazio continua sem fallback', async t => {
  const root = await fixture(t, 'vazio');
  await put(root, '1-levantamento/requisitos/r.md', 'RF-1');
  await put(root, '1-levantamento/visao/v.md', 'Visão');
  await put(root, '2-design/prototipo/index.html', '<html>');
  let cs = criteria(await evaluate(root, options));
  assert.equal(cs.D1.estado, 'pendente');
  assert.equal(cs.P1.estado, 'pendente');
  await changeManifest(root, d => { delete d.pastas; });
  cs = criteria(await evaluate(root, options));
  for (const id of ['D1', 'D2', 'P1']) assert.equal(cs[id].estado, 'concluido', id);
  assert.equal(prototypeFolder(root, { schema: 2 }), path.join(root, '2-design/prototipo'));
});

test('achado 8: somente regras/requisitos exigem id em texto; demais usam String(id || nome)', async t => {
  const root = await fixture(t, 'completo');
  await put(root, 'dados/fontes.json', [{ id: 42 }]);
  await put(root, 'dados/evidencias.json', [{}]);
  const req = await json(root, 'dados/requisitos.json'); req.items[0].sources = ['42'];
  const rules = await json(root, 'dados/regras.json'); rules[0].sources = ['42'];
  await put(root, 'dados/requisitos.json', req);
  await put(root, 'dados/regras.json', rules);
  await put(root, 'dados/decisoes.json', [{ nome: 'Decisão', decisao: 'Decisão sintética' }]);
  await put(root, 'dados/pendencias.json', [7, null].map(id => ({ id, status: 'resolvida_por_relato', pendencia_de_prova: true, enunciado: 'Prova escrita' })));
  const cs = criteria(await evaluate(root, options));
  assert.equal(cs.E1.estado, 'concluido');
  assert.equal(cs.E3.estado, 'pendente');
  assert.deepEqual(cs.E3.detalhes, ['7', 'pendencias']);
  assert.notEqual(cs.L4.estado, 'indisponivel');
});

test('achado 9: L3 no esquema DK normaliza sources apenas quando fonte está ausente', async t => {
  const root = await fixture(t, 'dk-esquema');
  await put(root, 'registry/regras.json', [{ id: 'RN-001', sources: ['SRC-1'] }]);
  await put(root, 'registry/requisitos.json', [{ id: 'RF-001', sources: 'SRC-1', deriva_de: 'RN-001' }]);
  assert.equal(criteria(await evaluate(root, options)).L3.estado, 'concluido');
  await put(root, 'registry/requisitos.json', [{ id: 'RF-001', fonte: '', sources: 'SRC-1', deriva_de: 'RN-001' }]);
  assert.deepEqual(criteria(await evaluate(root, options)).L3.detalhes, ['RF-001']);
});

test('achado 10: adoções duplicadas por caminho real são hasheadas uma única vez', async t => {
  const root = await fixture(t, 'completo'), body = 'Documento';
  await put(root, 'fora/v.pdf', body);
  await fs.promises.symlink('v.pdf', path.join(root, 'fora/alias.pdf'));
  const sha256 = createHash('sha256').update(body).digest('hex');
  await put(root, '.dk/adocoes.json', ['fora/v.pdf', 'fora/alias.pdf', path.join(root, 'fora/v.pdf')].map(caminho => ({ tipo: 'visao', caminho, status: 'adotado', sha256 })));
  const open = fs.promises.open;
  let opens = 0;
  fs.promises.open = async function(file, ...args) { if (String(file).startsWith(path.join(root, 'fora'))) opens++; return open.call(this, file, ...args); };
  let cs;
  try { cs = criteria(await evaluate(root, options)); } finally { fs.promises.open = open; }
  assert.equal(cs.D2.estado, 'concluido');
  assert.equal(opens, 1);
});

test('achado 10: teto de 32 por pasta é aplicado antes de qualquer hash', async t => {
  const root = await fixture(t, 'completo'), adopted = [];
  for (let i = 0; i < 33; i++) {
    await put(root, `fora/v${i}.pdf`, 'Documento');
    adopted.push({ tipo: 'visao', caminho: `fora/v${i}.pdf`, status: 'adotado', sha256: '0'.repeat(64) });
  }
  await put(root, '.dk/adocoes.json', adopted);
  const open = fs.promises.open;
  let opens = 0;
  fs.promises.open = async function(file, ...args) { if (String(file).startsWith(path.join(root, 'fora'))) opens++; return open.call(this, file, ...args); };
  let cs;
  try { cs = criteria(await evaluate(root, options)); } finally { fs.promises.open = open; }
  assert.match(cs.D2.motivo, /32 documentos/);
  assert.equal(opens, 0);
});

test('achado 10: hashes limitados a 64 MiB por avaliação antes de abrir excedente', async t => {
  const root = await fixture(t, 'completo'), adopted = [], size = 16 * 1024 * 1024;
  const sha256 = createHash('sha256').update(Buffer.alloc(size)).digest('hex');
  for (let i = 0; i < 5; i++) {
    const file = `fora/v${i}.pdf`;
    await put(root, file, '');
    await fs.promises.truncate(path.join(root, file), size);
    adopted.push({ tipo: 'visao', caminho: file, status: 'adotado', sha256 });
  }
  await put(root, '.dk/adocoes.json', adopted);
  const open = fs.promises.open;
  let bytes = 0;
  fs.promises.open = async function(file, ...args) { if (String(file).startsWith(path.join(root, 'fora'))) bytes += size; return open.call(this, file, ...args); };
  let cs;
  try { cs = criteria(await evaluate(root, options)); } finally { fs.promises.open = open; }
  assert.equal(cs.D2.estado, 'indisponivel');
  assert.match(cs.D2.motivo, /64 MiB/);
  assert.ok(bytes <= 64 * 1024 * 1024, `${bytes} bytes abertos para hash`);
});

test('symlink trocado entre verificação e open mantém O_NOFOLLOW e fechamento dos handles', async t => {
  const root = await fixture(t, 'completo'), target = path.join(root, 'dados/requisitos.json');
  const outside = path.join(path.dirname(root), 'externo.json');
  await fs.promises.writeFile(outside, '[{"id":"FORA"}]');
  const open = fs.promises.open;
  let replaced = false, opened = 0, closed = 0;
  fs.promises.open = async function(file, flags, ...args) {
    if (fs.constants.O_NOFOLLOW) assert.ok(flags & fs.constants.O_NOFOLLOW, 'Toda leitura abre com O_NOFOLLOW');
    if (String(file) === target && !replaced) {
      replaced = true;
      await fs.promises.rename(target, target + '.original');
      await fs.promises.symlink(outside, target);
    }
    const handle = await open.call(this, file, flags, ...args), close = handle.close.bind(handle);
    opened++;
    handle.close = async () => { closed++; return close(); };
    return handle;
  };
  let cs;
  try { cs = criteria(await evaluate(root, options)); } finally { fs.promises.open = open; }
  assert.equal(replaced, true);
  assert.equal(cs.L2.estado, 'indisponivel');
  assert.equal(cs.L1.estado, 'concluido');
  assert.equal(closed, opened);
});

test('M1b restante 1: todo caminho v2 declarado ou padrão participa do contrato', async t => {
  const cases = [
    ['0-apoio', '0-apoio', d => { d.pastas.apoio = './0-apoio/'; }],
    ['ext', 'ext/d.json', d => { d.registros.decisoes = './ext//d.json'; }],
    ['ext', 'ext/h.json', d => { d.registros.historias = 'ext/h.json'; }],
    ...['0-apoio', '1-levantamento', '2-design', '3-entregaveis'].map(rel => [rel, rel, d => { delete d.pastas; }]),
  ];
  for (const [link, rel, change] of cases) {
    await t.test(rel, async t => {
      const root = await fixture(t, 'completo');
      // O alvo externo nem precisa existir para invalidar o contrato.
      await fs.promises.symlink('../fora', path.join(root, link));
      await changeManifest(root, change);
      await put(root, '.dk/projeto.json', { contexto: 'portal' });
      const message = `projeto.yml v2 inválido: symlink/caminho fora do projeto: ${rel}`;
      const cs = criteria(await evaluate(root, options));
      for (const id of ['L1', 'L2', 'L3', 'L4', 'E1', 'E2', 'E3', 'D1', 'D2', 'D3', 'D4', 'P1']) {
        assert.equal(cs[id].estado, 'indisponivel', id);
        assert.equal(cs[id].motivo, message, id);
      }
      const manifest = require('yaml').parse(await fs.promises.readFile(path.join(root, 'projeto.yml'), 'utf8'));
      await assert.rejects(resolveRegistry(root, manifest), { message });
    });
  }
});

test('M1b restante 1: caminhos ausentes e symlinks internos continuam válidos', async t => {
  const root = await fixture(t, 'completo');
  await fs.promises.symlink('dados', path.join(root, 'apoio'));
  await fs.promises.symlink('ausente', path.join(root, 'interno-ausente'));
  await changeManifest(root, d => {
    d.pastas.apoio = './apoio/';
    d.pastas.extra = 'interno-ausente';
    d.registros.decisoes = './apoio//decisoes.json';
    d.registros.historias = 'interno-ausente/h.json';
  });
  assert.ok(Object.values(criteria(await evaluate(root, options))).every(c => c.estado === 'concluido'));
  const empty = await fixture(t, 'vazio');
  await changeManifest(empty, d => { delete d.pastas; });
  assert.deepEqual((await evaluate(empty, options)).errors, []);
});

test('M1b restante 2: D3 aceita 256 caracteres e recusa 257 com motivo', async t => {
  const root = await fixture(t, 'completo');
  for (const length of [256, 257]) {
    const id = '-'.repeat(length - 1) + 'X';
    await put(root, 'dados/requisitos.json', [{ id }]);
    await put(root, 'descoberta/requisitos/requisitos.md', id);
    const cs = criteria(await evaluate(root, options));
    assert.equal(cs.L2.estado, 'concluido');
    assert.equal(cs.D3.estado, length === 256 ? 'concluido' : 'indisponivel');
    if (length > 256) assert.match(cs.D3.motivo, /ID.*256 caracteres/);
  }
});

test('M1b restante 2: ID de 1.000.000 caracteres termina rápido e não bloqueia o event loop', async t => {
  const root = await fixture(t, 'completo');
  await put(root, 'dados/requisitos.json', [{ id: '-'.repeat(999999) + 'X' }]);
  await put(root, 'descoberta/requisitos/requisitos.md', '-'.repeat(2 * 1024 * 1024));
  const execFile = require('node:util').promisify(require('node:child_process').execFile);
  const { stdout } = await execFile(process.execPath, [path.join(fixtures, 'long-id.cjs'), root, kitPath], { timeout: 3000 });
  const { d3, elapsed, longest } = JSON.parse(stdout);
  assert.equal(d3.estado, 'indisponivel');
  assert.match(d3.motivo, /ID.*256 caracteres/);
  assert.ok(elapsed < 500, `ID longo: ${elapsed.toFixed(1)} ms`);
  assert.ok(longest < 150, `event loop: ${longest.toFixed(1)} ms`);
  t.diagnostic(`ID longo: ${elapsed.toFixed(1)} ms; intervalo máximo: ${longest.toFixed(1)} ms`);
});

test('M1b restante 2: fuzz determinístico mantém equivalência com fronteiras da regex ASCII', async t => {
  const root = await fixture(t, 'completo');
  let seed = 0x5ea;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const alphabet = ['A', 'a', '0', '_', '.', '+', '?', '[', ']', '\\', 'é', '😀', '-', ':', '!'];
  const literal = n => Array.from({ length: n }, () => alphabet[random(alphabet.length)]).join('');
  const boundaries = ['', ' ', '\n', 'A', '_', '0', 'é', '😀', '.', '-'];
  for (let run = 0; run < 32; run++) {
    const prefix = literal(1 + random(12));
    const ids = [prefix, prefix + 'A', prefix + '.', ...Array.from({ length: 5 }, () => literal(1 + random(100)))];
    const body = literal(1024) + ids.map(id => boundaries[random(boundaries.length)] + id + boundaries[random(boundaries.length)]).join('');
    await put(root, 'dados/requisitos.json', ids.map(id => ({ id })));
    await put(root, 'descoberta/requisitos/requisitos.md', body);
    await put(root, 'descoberta/visao/visao.md', '');
    const expected = ids.filter(id => !new RegExp(`(?<![A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`).test(body));
    const d3 = criteria(await evaluate(root, options)).D3;
    assert.equal(d3.estado, expected.length ? 'pendente' : 'concluido', `run ${run}`);
    assert.deepEqual(d3.detalhes, expected, `run ${run}`);
  }
});

test('M1b restante 3: watcher filtra primeiro segmento ignorado e arquivos sem HTML', async t => {
  const emit = controlledWatch(t), root = await fixture(t, 'completo'), events = [];
  const prototype = path.join(root, 'interface/prototipo');
  await fs.promises.mkdir(path.join(prototype, 'antiga.pasta'));
  const stages = new Stages(e => events.push(e));
  t.after(() => stages.close());
  await stages.read(root, options);
  const cache = stages.cache;
  for (const dir of ['node_modules', '.git', 'design-system']) {
    const file = `interface/prototipo/${dir}/sub/tela.html`;
    await put(root, file, '<html>');
    emit(path.join(root, file), 'change');
    emit(path.join(prototype, dir));
  }
  for (const name of ['estilo.css', 'script.js', 'leia.md']) {
    await put(prototype, name, 'texto');
    emit(path.join(prototype, name), 'change');
    emit(path.join(prototype, name));
  }
  await sleep(500);
  assert.deepEqual(events, []);
  assert.strictEqual(stages.cache, cache);
  const accepted = ['sub/tela.html', 'sub/outra.HTM', 'node_modules-extra/tela.html', 'nova.pasta', 'antiga.pasta'];
  for (const [index, rel] of accepted.entries()) {
    if (rel === 'nova.pasta') await fs.promises.mkdir(path.join(prototype, rel));
    else if (rel === 'antiga.pasta') await fs.promises.rmdir(path.join(prototype, rel));
    else await put(prototype, rel, '<html>');
    emit(path.join(prototype, rel));
    await sleep(500);
    assert.equal(events.length, index + 1, rel);
    assert.deepEqual(events.at(-1), { path: root });
  }
});
