'use strict';
// dock-preview: abre um protótipo, tela ou documento do projeto no navegador do
// SEA Dock. Roda com o Node embutido no próprio app (ELECTRON_RUN_AS_NODE=1),
// sem depender de Python ou Node do usuário. Toda saída é uma linha só, começando
// com OK: ou ERRO:, para ser lida por pessoas e por agentes de IA.
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const USAGE = 'Uso: dock-preview <alvo> [--titulo "Texto"]. <alvo> é um endereço local (http://localhost:5173) ou um arquivo/pasta do projeto (prototipo/index.html, telas/, tela.png, docs/visao.md).';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

class Failure extends Error { constructor(message, code = 1) { super(message); this.code = code; } }

function parseArgs(argv) {
  let target, title;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help' || arg === 'ajuda') return { help: true };
    if (arg === '--titulo' || arg === '--title') {
      if (i + 1 >= argv.length) throw new Failure(`ERRO: --titulo precisa de um texto. ${USAGE}`, 2);
      title = argv[++i];
    } else if (arg.startsWith('--titulo=') || arg.startsWith('--title=')) title = arg.slice(arg.indexOf('=') + 1);
    else if (arg === '--') { if (i + 1 < argv.length) { if (target !== undefined || i + 2 < argv.length) throw new Failure(`ERRO: informe um único alvo. ${USAGE}`, 2); target = argv[i + 1]; } break; }
    else if (arg.startsWith('-') && arg !== '-') throw new Failure(`ERRO: opção desconhecida ${arg}. ${USAGE}`, 2);
    else if (target !== undefined) throw new Failure(`ERRO: informe um único alvo por vez. ${USAGE}`, 2);
    else target = arg;
  }
  if (target === undefined || target === '') throw new Failure(`ERRO: informe o que abrir. ${USAGE}`, 2);
  if (title !== undefined && (title.length > 120 || /[\u0000-\u001f\u007f]/.test(title))) throw new Failure('ERRO: o título precisa ter até 120 caracteres, sem quebras de linha.', 2);
  return { target, title };
}

// Endereço (com esquema, ou localhost:porta sem esquema) ou caminho de arquivo.
function classify(target, cwd) {
  const bare = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(target);
  if (bare || /^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    let url;
    try { url = new URL(bare ? `http://${target}` : target); } catch { throw new Failure(`ERRO: endereço inválido: ${target}.`, 2); }
    if (!['http:', 'https:'].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname) || url.username || url.password) {
      throw new Failure(`ERRO: o navegador do SEA Dock só abre endereços locais (localhost ou 127.0.0.1); ${target} foi recusado. Para apresentar algo, rode um servidor local ou aponte um arquivo do projeto.`, 2);
    }
    return { url: url.href };
  }
  return { path: path.resolve(cwd, target) };
}

function inside(root, target) { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }

// Conferência antecipada só para mensagens melhores; o app revalida tudo.
function checkPath(file, root) {
  let real, base;
  try { real = fs.realpathSync(file); } catch { throw new Failure(`ERRO: arquivo ou pasta não encontrado: ${file}. Confira o caminho a partir da pasta atual (${process.cwd()}).`); }
  try { base = fs.realpathSync(root); } catch { throw new Failure(`ERRO: a pasta do projeto desta sessão (${root}) não está acessível.`); }
  if (!inside(base, real)) throw new Failure(`ERRO: ${file} fica fora do projeto desta sessão (${base}). Só arquivos dentro do projeto podem ser apresentados; gere ou salve o arquivo dentro do projeto e repita.`);
  return path.relative(base, real) || '.';
}

function reachable(url, timeout = 1500) {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function post(port, token, payload, timeout = 15000) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/preview', method: 'POST', agent: false, timeout,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; if (data.length > 65536) response.destroy(); });
      response.on('end', () => { let json = {}; try { json = JSON.parse(data); } catch {} resolve({ status: response.statusCode, json }); });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
    request.end(body);
  });
}

function bridgeError(status, json) {
  const message = typeof json.error === 'string' && json.error ? json.error.replace(/\s+/g, ' ').trim() : '';
  if (status === 403 && /Sessão não autorizada/.test(message)) return 'ERRO: esta sessão não é mais reconhecida pelo SEA Dock (o projeto foi fechado ou o app reiniciou). Abra um novo terminal no projeto pelo SEA Dock e repita.';
  if (status === 400 && /Endereço de prévia inválido/.test(message)) return 'ERRO: o SEA Dock recusou o alvo. Use um endereço local (localhost/127.0.0.1) ou um arquivo do projeto.';
  return `ERRO: ${message || `o SEA Dock recusou a prévia (HTTP ${status}).`}`;
}

async function run(argv, { env = process.env, cwd = process.cwd(), probe = reachable, send = post } = {}) {
  const args = parseArgs(argv);
  if (args.help) return { code: 0, line: USAGE };
  const port = env.DK_TERMINAL_PREVIEW_PORT, token = env.DK_TERMINAL_PREVIEW_TOKEN, root = env.DK_TERMINAL_PROJECT;
  if (!port || !token || !root) {
    throw new Failure(env.DK_TERMINAL_PREVIEW_UNAVAILABLE === '1'
      ? 'ERRO: a prévia integrada do SEA Dock não iniciou nesta execução do app. Reinicie o SEA Dock, abra um novo terminal no projeto e repita.'
      : 'ERRO: dock-preview só funciona dentro de uma sessão do SEA Dock (terminal, Claude Code, Codex ou Gemini abertos pelo app). Abra o projeto no SEA Dock, inicie uma sessão e rode o comando lá.', 3);
  }
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^[0-9a-f]{64}$/.test(token)) throw new Failure('ERRO: configuração da sessão do SEA Dock inválida. Abra um novo terminal no projeto e repita.', 3);
  const target = classify(args.target, cwd);
  const relative = target.path ? checkPath(target.path, root) : null;
  if (!target.path && !await probe(target.url)) throw new Failure(`ERRO: nada responde em ${target.url}. Inicie o servidor local do projeto (por exemplo npm run dev) e repita, ou aponte um arquivo do projeto.`);
  const payload = { ...target, ...(args.title ? { title: args.title } : {}) };
  let response;
  try { response = await send(Number(port), token, payload); }
  catch (error) {
    if (error?.code === 'ETIMEDOUT') throw new Failure('ERRO: o SEA Dock não respondeu a tempo. Confira se a janela do app está aberta e repita.');
    throw new Failure('ERRO: o SEA Dock não está respondendo nesta sessão. Confirme que o app está aberto; se ele foi reiniciado, abra um novo terminal no projeto e repita.');
  }
  if (response.status === 200 && response.json.opened === true) {
    const shown = typeof response.json.url === 'string' ? response.json.url : target.url || target.path;
    return { code: 0, line: `OK: prévia aberta no navegador do SEA Dock${args.title ? ` (${args.title})` : ''}: ${relative ?? target.url} -> ${shown}` };
  }
  throw new Failure(bridgeError(response.status, response.json));
}

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, line }) => { process.stdout.write(line + '\n'); process.exitCode = code; },
    error => { const failure = error instanceof Failure ? error : new Failure(`ERRO: falha inesperada no dock-preview: ${error?.message || error}`); process.stderr.write(failure.message + '\n'); process.exitCode = failure.code; });
}

module.exports = { run, parseArgs, classify, Failure, USAGE };
