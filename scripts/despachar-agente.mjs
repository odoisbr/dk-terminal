#!/usr/bin/env node
// Despacha um pacote de trabalho para Antigravity (agy) ou Codex com o modelo e o
// esforço do perfil em docs/coordenacoes/atribuicoes.json, e confere o escopo pelo git.
//
// Uso:
//   node scripts/despachar-agente.mjs --perfil implementador --tarefa m0-parser \
//     --prompt arquivo.md --cwd /caminho/da/worktree --registro pasta-de-registros \
//     [--alvo electron/extensions.cjs --alvo tests/extensions.test.cjs] [--somente-leitura]
//
// Perfis com host "claude" não são despachados aqui: a sessão orquestradora os
// executa pela ferramenta Agent com o mesmo modelo e esforço.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function lerArgumentos(argv) {
  const opcoes = { alvo: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const chave = argv[i];
    if (!chave.startsWith('--')) throw new Error(`argumento inesperado: ${chave}`);
    const nome = chave.slice(2);
    if (nome === 'somente-leitura') { opcoes.somenteLeitura = true; continue; }
    const valor = argv[i + 1];
    if (valor === undefined) throw new Error(`falta valor para ${chave}`);
    i += 1;
    if (nome === 'alvo') opcoes.alvo.push(valor);
    else opcoes[nome] = valor;
  }
  for (const obrigatoria of ['perfil', 'tarefa', 'prompt', 'cwd', 'registro']) {
    if (!opcoes[obrigatoria]) throw new Error(`falta --${obrigatoria}`);
  }
  return opcoes;
}

// Arquivos alterados ou novos, respeitando .gitignore.
export function retrato(cwd) {
  const saida = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  const caminhos = new Map();
  const partes = saida.split('\0').filter(Boolean);
  for (let i = 0; i < partes.length; i += 1) {
    const linha = partes[i];
    const estado = linha.slice(0, 2);
    const caminho = linha.slice(3);
    if (estado[0] === 'R' || estado[0] === 'C') i += 1;
    caminhos.set(caminho, hashDe(path.join(cwd, caminho)));
  }
  return caminhos;
}

function hashDe(arquivo) {
  try {
    return execFileSync('git', ['hash-object', '--', arquivo], { encoding: 'utf8' }).trim();
  } catch {
    return 'ausente';
  }
}

export function foraDoEscopo(antes, depois, alvos, somenteLeitura) {
  const mudados = [];
  for (const [caminho, hash] of depois) if (antes.get(caminho) !== hash) mudados.push(caminho);
  for (const caminho of antes.keys()) if (!depois.has(caminho)) mudados.push(caminho);
  if (somenteLeitura) return { mudados, fora: mudados };
  const permitido = (c) => alvos.some((a) => (a.endsWith('/') ? c.startsWith(a) : c === a));
  return { mudados, fora: mudados.filter((c) => !permitido(c)) };
}

const COMANDOS_AGY = (perfis) => perfis.comandos_permitidos_antigravity.map((c) => `command(${c})`);

function montarComando(perfil, atribuicoes, opcoes, prompt) {
  const { host, modelo, esforco } = perfil;
  if (host === 'codex') {
    const sandbox = opcoes.somenteLeitura ? 'read-only' : 'workspace-write';
    return {
      cli: 'codex',
      argv: ['exec', '-C', opcoes.cwd, '-s', sandbox, '-m', modelo, '-c', `model_reasoning_effort=${esforco}`,
        '--skip-git-repo-check', '-o', path.join(opcoes.registro, `${opcoes.tarefa}.resposta.md`), '-'],
      entrada: prompt,
    };
  }
  if (host === 'antigravity') {
    const settings = { permissions: { allow: COMANDOS_AGY(atribuicoes) } };
    return {
      cli: 'agy',
      argv: ['-p', prompt, '--model', modelo, '--mode', opcoes.somenteLeitura ? 'plan' : 'accept-edits', '--sandbox',
        '--add-dir', opcoes.cwd, '--output-format', 'json', '--print-timeout', '0', '--settings', JSON.stringify(settings)],
      entrada: null,
    };
  }
  throw new Error(`perfil ${opcoes.perfil} é do host ${host}: execute pela ferramenta Agent`);
}

async function principal() {
  const opcoes = lerArgumentos(process.argv.slice(2));
  const atribuicoes = JSON.parse(fs.readFileSync(path.join(raiz, 'docs/coordenacoes/atribuicoes.json'), 'utf8'));
  const perfil = atribuicoes.perfis[opcoes.perfil];
  if (!perfil) throw new Error(`perfil desconhecido: ${opcoes.perfil}`);
  fs.mkdirSync(opcoes.registro, { recursive: true });
  const prompt = fs.readFileSync(opcoes.prompt, 'utf8');
  const comando = montarComando(perfil, atribuicoes, opcoes, prompt);
  const antes = retrato(opcoes.cwd);
  const inicio = new Date();
  const log = fs.openSync(path.join(opcoes.registro, `${opcoes.tarefa}.log`), 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const filho = spawn(comando.cli, comando.argv, { cwd: opcoes.cwd, env, stdio: [comando.entrada ? 'pipe' : 'ignore', log, log] });
  if (comando.entrada) filho.stdin.end(comando.entrada);
  const codigo = await new Promise((resolve) => filho.on('close', resolve));
  fs.closeSync(log);
  if (perfil.host === 'antigravity') {
    const bruto = fs.readFileSync(path.join(opcoes.registro, `${opcoes.tarefa}.log`), 'utf8');
    const json = bruto.slice(bruto.indexOf('{"conversation_id"'));
    try {
      const resposta = JSON.parse(json);
      fs.writeFileSync(path.join(opcoes.registro, `${opcoes.tarefa}.resposta.md`), resposta.response || '');
      if (resposta.denied_actions?.length) console.error(`negadas: ${JSON.stringify(resposta.denied_actions)}`);
    } catch { /* o log bruto fica como evidência */ }
  }
  const escopo = foraDoEscopo(antes, retrato(opcoes.cwd), opcoes.alvo, opcoes.somenteLeitura);
  const registro = {
    tarefa: opcoes.tarefa, perfil: opcoes.perfil, host: perfil.host, modelo: perfil.modelo, esforco: perfil.esforco,
    inicio: inicio.toISOString(), duracao_s: Math.round((Date.now() - inicio) / 1000), codigo,
    alvos: opcoes.alvo, mudados: escopo.mudados, fora_do_escopo: escopo.fora,
    gate: codigo === 0 && escopo.fora.length === 0 ? 'aprovado' : 'reprovado',
  };
  fs.appendFileSync(path.join(opcoes.registro, 'execucoes.jsonl'), `${JSON.stringify(registro)}\n`);
  console.log(JSON.stringify(registro, null, 2));
  process.exitCode = registro.gate === 'aprovado' ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  principal().catch((erro) => { console.error(erro.message); process.exitCode = 2; });
}
