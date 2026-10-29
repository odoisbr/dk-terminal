const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compose, truncate, header } = require('../electron/prompt-compose.cjs');

const KiB = 1024, root = '/projetos/sea';
const ids = ['guia_dk', 'skill_ativa', 'design_system', 'craft', 'instrucoes_projeto', 'etapa_ativa', 'arquivos'];
const limits = [32, 24, 24, 0, 16, 4, 8].map(value => value * KiB);
const bytes = text => Buffer.byteLength(text, 'utf8');
const layer = (result, id) => result.camadas.find(item => item.id === id);
const body = (result, id) => result.text.split(`\n\n## ${id}\n\n`)[1]?.split('\n\n## ')[0];
const run = camadas => compose({ root, camadas });

function checkCounts(result) {
  assert.equal(result.totalBytes, bytes(result.text));
  assert.ok(result.totalBytes <= 96 * KiB);
  for (const [index, item] of result.camadas.entries()) {
    assert.ok(item.bytes <= limits[index], item.id);
    assert.equal(item.bytes, bytes(body(result, item.id) || ''), item.id);
    assert.equal(typeof item.truncado, 'boolean');
    assert.equal(typeof item.ausente, 'boolean');
  }
}

function checkMarker(text, id, original) {
  const match = /\n\[camada ([a-z_]+) truncada: (\d+) de (\d+) bytes\]$/.exec(text);
  assert.ok(match, text.slice(-120));
  assert.equal(match[1], id);
  const prefix = text.slice(0, match.index);
  assert.equal(Number(match[2]), bytes(prefix));
  assert.equal(Number(match[3]), original);
  return prefix;
}

test('ordem canônica, fontes delimitadas e craft sempre ausente em M2', () => {
  const camadas = [...ids].reverse().map(id => ({ id, fonte: `${id}/fonte.md`, text: `conteudo-${id}`, caminhos: ['src/main.ts'] }));
  const result = run(camadas);
  assert.deepEqual(result.camadas.map(item => item.id), ids);
  const sections = [...result.text.matchAll(/^## (\w+)$/gm)].map(match => match[1]);
  assert.deepEqual(sections, ids.filter(id => id !== 'craft'));
  for (const id of sections) {
    assert.equal(body(result, id), id === 'arquivos' ? 'src/main.ts' : `conteudo-${id}`);
    assert.equal(layer(result, id).fonte, `${id}/fonte.md`);
    assert.equal(layer(result, id).truncado, false);
  }
  assert.equal(layer(result, 'craft').ausente, true);
  assert.match(layer(result, 'craft').motivo, /M2/);
  assert.ok(!result.text.includes('conteudo-craft'));
  assert.equal(result.text.split('conteudo-guia_dk').length - 1, 1, 'D5: guia incluído uma única vez');
  assert.ok(result.text.startsWith(header(result.camadas)));
  checkCounts(result);
});

test('cada limite inclui seu marcador; bytesOriginais preserva o tamanho UTF-8 recebido', () => {
  for (const [index, id] of ids.entries()) {
    if (id === 'craft') continue;
    const input = id === 'arquivos' ? { caminhos: Array.from({ length: 150 }, (_, i) => `src/${i}-${'é'.repeat(100)}.ts`) } : 'á😀'.repeat(limits[index]);
    const original = typeof input === 'string' ? bytes(input) : bytes(input.caminhos.join('\n'));
    const result = run({ [id]: input }), metadata = layer(result, id);
    assert.equal(metadata.ausente, false);
    assert.equal(metadata.truncado, true);
    assert.equal(metadata.bytesOriginais, original);
    assert.ok(metadata.bytes <= limits[index]);
    const prefix = checkMarker(body(result, id), id, original);
    assert.ok(!prefix.includes('\ufffd'));
    if (id === 'arquivos') assert.ok(prefix.split('\n').every(file => input.caminhos.includes(file)));
    else assert.ok(metadata.bytes >= limits[index] - 6);
    checkCounts(result);
  }
});

test('texto exatamente no teto de uma camada é preservado sem marcador', () => {
  for (const [index, id] of ids.entries()) {
    if (id === 'craft' || id === 'arquivos') continue;
    const text = 'x'.repeat(limits[index]), result = run({ [id]: text });
    assert.equal(body(result, id), text);
    assert.equal(layer(result, id).truncado, false);
    assert.equal(layer(result, id).bytes, limits[index]);
    checkCounts(result);
  }
});

test('todas as camadas cheias preservam etapa e arquivos, cortando pela prioridade sem reordenar o texto', () => {
  const caminhos = Array.from({ length: 128 }, (_, n) => `src/${String(n).padStart(3, '0')}-${'a'.repeat(n === 127 ? 53 : 52)}.ts`);
  assert.equal(bytes(caminhos.join('\n')), 8 * KiB);
  const camadas = Object.fromEntries(ids.map((id, i) => [id, id === 'arquivos' ? { caminhos } : String(i).repeat(limits[i])]));
  const result = run(camadas);
  checkCounts(result);
  assert.ok(result.totalBytes > 95 * KiB);
  assert.deepEqual([...result.text.matchAll(/^## (\w+)$/gm)].map(match => match[1]), ids.filter(id => id !== 'craft'));
  for (const id of ['guia_dk', 'skill_ativa', 'instrucoes_projeto', 'etapa_ativa', 'arquivos']) {
    const metadata = layer(result, id);
    assert.equal(metadata.ausente, false);
    assert.equal(metadata.truncado, false);
    assert.equal(metadata.bytes, limits[ids.indexOf(id)]);
    assert.equal(body(result, id), id === 'arquivos' ? caminhos.join('\n') : camadas[id]);
  }
  assert.ok(layer(result, 'design_system').bytes < 24 * KiB);
  assert.equal(layer(result, 'design_system').truncado, true);
  checkMarker(body(result, 'design_system'), 'design_system', 24 * KiB);
});

test('truncate preserva fronteiras UTF-8 com emoji, acentos e CJK junto ao corte', () => {
  const text = 'abcé漢😀'.repeat(100), original = bytes(text);
  for (let limit = 64; limit <= 256; limit++) {
    const result = truncate(text, limit, 'teste'), prefix = checkMarker(result, 'teste', original);
    assert.ok(bytes(result) <= limit);
    assert.ok(!result.includes('\ufffd'));
    assert.ok(text.startsWith(prefix));
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(prefix)), prefix);
  }
  assert.equal(truncate('é😀', 6), 'é😀');
  assert.equal(truncate('', 0), '');
  assert.match(truncate('a'.repeat(100), 64), /\[camada texto truncada: \d+ de 100 bytes\]/);
});

test('truncate recusa limites inválidos ou incapazes de comportar o aviso completo', () => {
  for (const limit of [-1, NaN, Infinity, 1.5, '64']) assert.throws(() => truncate('abc', limit), RangeError);
  assert.throws(() => truncate('abc', 0), /marcador/);
  assert.throws(() => truncate('a'.repeat(100), 10), /marcador/);
  assert.throws(() => truncate(null, 64), TypeError);
  assert.throws(() => truncate('abc', 64, 'x\nforjado'), TypeError);
});

test('cabeçalho lista separadamente presentes, ausentes e truncadas', () => {
  assert.equal(header([
    { id: 'guia_dk', ausente: false, truncado: false },
    { id: 'skill_ativa', ausente: false, truncado: true },
    { id: 'craft', ausente: true, truncado: false },
  ]), '# System prompt — SEA Dock\nPresentes: guia_dk, skill_ativa\nAusentes: craft\nTruncadas: skill_ativa\n');
  assert.match(header([]), /Presentes: nenhuma\nAusentes: nenhuma\nTruncadas: nenhuma\n$/);
});

test('fontes ausentes, vazias, não autorizadas e motivos do chamador não emitem conteúdo', () => {
  const result = run({
    guia_dk: '',
    skill_ativa: { text: 'SEGREDO-NAO-AUTORIZADO', autorizado: false },
    design_system: { text: 'TEXTO-AUSENTE', ausente: true, motivo: 'Catálogo indisponível.' },
    arquivos: { caminhos: [] },
  });
  assert.ok(result.camadas.every(item => item.ausente && item.bytes === 0 && item.bytesOriginais === 0 && !item.truncado && item.motivo));
  assert.equal(layer(result, 'design_system').motivo, 'Catálogo indisponível.');
  assert.ok(!result.text.includes('SEGREDO'));
  assert.ok(!result.text.includes('TEXTO-AUSENTE'));
  assert.ok(!result.text.includes('## '));
  checkCounts(result);
  assert.deepEqual(compose({ root }), run({}));
});

const unsafe = ['/etc/passwd', `${root}/interno.ts`, '../externo.ts', 'src/../../externo.ts', 'src/../interno.ts', '..\\externo.ts', 'src\\..\\interno.ts', 'src/ruim\0.ts', 'C:\\externo.ts', 'C:/externo.ts', 'C:externo.ts', '\\\\servidor\\pasta\\arquivo', '\\externo.ts', 'src/ruim\nforjado.ts', ''];

test('arquivos absolutos, traversal e NUL recusam a camada com motivo, inclusive misturados a válidos', () => {
  for (const file of unsafe) {
    const result = run({ arquivos: { caminhos: ['src/valido.ts', file], text: 'CONTEUDO-IGNORADO' } });
    const metadata = layer(result, 'arquivos');
    assert.equal(metadata.ausente, true, JSON.stringify(file));
    assert.match(metadata.motivo, /recusada/);
    assert.equal(metadata.bytes, 0);
    assert.equal(body(result, 'arquivos'), undefined);
    assert.ok(!result.text.includes('CONTEUDO-IGNORADO'));
    assert.ok(!result.text.includes('src/valido.ts'));
    checkCounts(result);
  }
});

test('fonte inválida recusa o texto da camada e não reproduz o caminho recusado', () => {
  for (const fonte of unsafe) {
    const result = run({ skill_ativa: { fonte, text: 'CONTEUDO-RECUSADO' } });
    const metadata = layer(result, 'skill_ativa');
    assert.equal(metadata.ausente, true, JSON.stringify(fonte));
    assert.equal(metadata.fonte, null);
    assert.match(metadata.motivo, /recusado/);
    assert.ok(!result.text.includes('CONTEUDO-RECUSADO'));
    assert.equal(body(result, 'skill_ativa'), undefined);
  }
});

test('lista de arquivos contém somente caminhos relativos normalizados, sem conteúdo', () => {
  const result = run({ arquivos: { caminhos: ['./src/main.ts', 'docs/guia.md', 'src\\outro.ts', 'src/..nome.ts'], text: 'NAO-INCLUIR-CONTEUDO' } });
  assert.equal(body(result, 'arquivos'), 'src/main.ts\ndocs/guia.md\nsrc/outro.ts\nsrc/..nome.ts');
  assert.equal(layer(result, 'arquivos').truncado, false);
  assert.ok(!result.text.includes('NAO-INCLUIR-CONTEUDO'));
  assert.equal(layer(run({ arquivos: { text: 'conteúdo não é lista de caminhos' } }), 'arquivos').ausente, true);
  checkCounts(result);
});

test('lista de arquivos respeita 200 entradas e sinaliza o corte mesmo abaixo de 8 KiB', () => {
  const caminhos = Array.from({ length: 201 }, (_, i) => `src/arquivo-${i}.ts`);
  const result = run({ arquivos: caminhos });
  const prefix = checkMarker(body(result, 'arquivos'), 'arquivos', bytes(caminhos.join('\n')));
  assert.deepEqual(prefix.split('\n'), caminhos.slice(0, 200));
  assert.equal(layer(result, 'arquivos').truncado, true);
  assert.ok(!result.text.includes('src/arquivo-200.ts'));
  const exact = run({ arquivos: caminhos.slice(0, 200) });
  assert.equal(layer(exact, 'arquivos').truncado, false);
  checkCounts(result);
});

test('caminho maior que 8 KiB é omitido por inteiro com aviso', () => {
  const caminhos = [`src/${'é'.repeat(8 * KiB)}.ts`], result = run({ arquivos: caminhos });
  assert.equal(checkMarker(body(result, 'arquivos'), 'arquivos', bytes(caminhos[0])), '');
  assert.equal(layer(result, 'arquivos').ausente, false);
  checkCounts(result);
});

test('contenção lexical funciona com raiz POSIX ou Windows sem consultar o disco', () => {
  for (const root of ['/projetos/sea', 'C:\\projetos\\sea', '\\\\host\\share\\sea']) {
    const result = compose({ root, camadas: { instrucoes_projeto: { fonte: 'AGENTS.md', text: 'regras' }, arquivos: ['src/main.ts', 'src\\outro.ts'] } });
    assert.equal(layer(result, 'arquivos').ausente, false);
    assert.equal(body(result, 'instrucoes_projeto'), 'regras');
    const denied = compose({ root, camadas: { arquivos: ['../outro/arquivo.ts'] } });
    assert.equal(layer(denied, 'arquivos').ausente, true);
  }
  for (const root of ['', '.', 'relativo', '/raiz\0ruim', '\\raiz', '\\\\host', null]) assert.throws(() => compose({ root }), TypeError);
});

test('resultado determinístico, sem mutar fontes e ignorando camadas fora do contrato', () => {
  const camadas = Object.freeze({
    guia_dk: Object.freeze({ text: 'guia', fonte: 'dock-tools/agents/AGENTS.md' }),
    arquivos: Object.freeze({ caminhos: Object.freeze(['src/main.ts']) }),
    env: Object.freeze({ text: 'SEGREDO-IGNORADO' }),
  });
  const first = run(camadas), second = run(camadas);
  assert.deepEqual(first, second);
  assert.ok(!first.text.includes('SEGREDO-IGNORADO'));
  first.camadas[0].bytes = 999;
  assert.deepEqual(run(camadas), second);
  assert.throws(() => run([{ id: 'guia_dk', text: 'a' }, { id: 'guia_dk', text: 'b' }]), /duplicada/);
});

test('módulo carrega e executa com fs mockado para lançar em qualquer acesso e sem process', () => {
  const filename = path.join(__dirname, '../electron/prompt-compose.cjs');
  const source = fs.readFileSync(filename, 'utf8'), requests = [];
  const forbidden = new Proxy({}, { get() { assert.fail('I/O proibido: acesso a fs'); } });
  const context = vm.createContext({
    Buffer, module: { exports: {} },
    require(name) {
      requests.push(name);
      if (['fs', 'node:fs', 'fs/promises', 'node:fs/promises'].includes(name)) return forbidden;
      assert.equal(name, 'node:path', 'Dependência com possíveis efeitos colaterais');
      return path;
    },
  });
  vm.runInContext(source, context, { filename });
  const pure = context.module.exports;
  const camadas = { guia_dk: 'guia', skill_ativa: 's'.repeat(30 * KiB), arquivos: ['src/main.ts'] };
  assert.deepEqual(JSON.parse(JSON.stringify(pure.compose({ root, camadas }))), run(camadas));
  assert.equal(pure.truncate('á'.repeat(100), 64), truncate('á'.repeat(100), 64));
  assert.equal(pure.header([]), header([]));
  assert.deepEqual(requests, ['node:path']);
});
