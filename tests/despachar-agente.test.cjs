const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulo = () => import(path.join(__dirname, '..', 'scripts', 'despachar-agente.mjs'));

test('despachante exige perfil, tarefa, prompt, cwd e registro', async () => {
  const { lerArgumentos } = await modulo();
  assert.throws(() => lerArgumentos(['--perfil', 'leitor']), /falta --tarefa/);
  const opcoes = lerArgumentos(['--perfil', 'leitor', '--tarefa', 't', '--prompt', 'p', '--cwd', '.', '--registro', 'r',
    '--alvo', 'a.cjs', '--alvo', 'pasta/', '--somente-leitura']);
  assert.deepEqual(opcoes.alvo, ['a.cjs', 'pasta/']);
  assert.equal(opcoes.somenteLeitura, true);
});

test('gate de escopo aceita alvos e pastas declaradas e reprova o resto', async () => {
  const { foraDoEscopo } = await modulo();
  const antes = new Map([['ja-sujo.txt', 'h1']]);
  const depois = new Map([['ja-sujo.txt', 'h1'], ['a.cjs', 'h2'], ['pasta/b.cjs', 'h3'], ['outro.cjs', 'h4']]);
  const resultado = foraDoEscopo(antes, depois, ['a.cjs', 'pasta/'], false);
  assert.deepEqual(resultado.mudados.sort(), ['a.cjs', 'outro.cjs', 'pasta/b.cjs']);
  assert.deepEqual(resultado.fora, ['outro.cjs']);
});

test('pacote somente leitura reprova qualquer mudança, inclusive remoção', async () => {
  const { foraDoEscopo } = await modulo();
  const resultado = foraDoEscopo(new Map([['x', 'h']]), new Map(), [], true);
  assert.deepEqual(resultado.fora, ['x']);
});
