// A evidência é autodeclarada; a garantia vem do orquestrador rodar o gate
// e de agentes não gravarem aprovações. Um arquivo pode ser forjado à mão por quem tem acesso ao disco.
// Registra evidências locais; não executa CLIs nem lê credenciais.
// registrar COORD --projeto RAIZ --entrada registro.json [--alvo caminho ...]
//   [--pacote id=arquivo1,arquivo2 ...]
// entrada.pacotes informa id, arquivos e implementado_por:{host,modelo,esforco}.
// registrar preserva revisões somente para os mesmos arquivos e hashes; novos pacotes ficam pendentes.
// Novos pacotes via CLI usam --host, --modelo e --esforco; revisões CLI recebem a data atual.
// registro.json: {alvos:["arquivo"], ambiente:{electron,claude_versao,codex_versao},
//   testes:{unitarios:{comando,status:"passou",passou:1,falhou:0,saida:"unitarios.log"},desktop:{...}}}
// `saida` é um arquivo explícito (relativo à raiz ou absoluto); só seu hash é persistido.
// Alternativa: --testes testes.json --alvo arquivo ... [--ambiente ambiente.json].
// cli-oficial COORD --autorizado-por email [--versao versão] [--passo P1=ok ...] [--limitacao texto]
// decisao-escopo COORD --autor nome --motivo texto
// revisar COORD --pacote id --veredito aprovado|reprovado --revisor nome
// Todas as formas aceitam --projeto RAIZ, --perfil nome e --host nome.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

export const LIMIT = 4 * 1024 * 1024;
const text = value => typeof value === 'string' && value.trim().length > 0;
export const hashValido = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function semCredenciais(file) {
  if (String(file).split(/[\\/]/).some(part => /^(?:\.env(?:\..*)?|\.aws|\.ssh|\.gnupg|\.credentials(?:\.json)?|credentials(?:\.json)?|auth\.json|id_rsa|id_ed25519)$/i.test(part))) {
    throw new Error(`Arquivo de credenciais não permitido: ${file}`);
  }
}
export function identidade(root) {
  const realpath = fs.realpathSync(root), stat = fs.statSync(realpath);
  if (!stat.isDirectory()) throw new Error('Projeto deve ser uma pasta.');
  return { realpath, dev: stat.dev, ino: stat.ino };
}
export function contido(root, rel) {
  if (!text(rel) || path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').some(p => p === '..' || p === '.git') || rel.includes('\0')) throw new Error(`Caminho inválido: ${rel}`);
  semCredenciais(rel);
  const target = path.resolve(root, rel);
  let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const resolved = path.relative(root, fs.realpathSync(existing));
  if (resolved === '..' || resolved.startsWith('..' + path.sep) || path.isAbsolute(resolved)) throw new Error(`Caminho fora do projeto: ${rel}`);
  return target;
}
export function caminhoNormalizado(root, rel) {
  contido(root, rel);
  const normalized = path.posix.normalize(rel);
  if (normalized === '.' || normalized.startsWith('.dk/')) throw new Error(`Caminho de alvo inválido: ${rel}`);
  return normalized;
}
function abrirRegular(file) {
  semCredenciais(file);
  if (!fs.lstatSync(file).isFile()) throw new Error(`Não é arquivo regular: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`Não é arquivo regular: ${file}`);
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}
export function lerJson(file) {
  const fd = abrirRegular(file);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('JSON deve ser arquivo regular.');
    if (stat.size > LIMIT) throw new Error('JSON acima do limite de 4 MiB.');
    const buffer = Buffer.alloc(LIMIT + 1);
    let size = 0, bytes;
    while (size < buffer.length && (bytes = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += bytes;
    if (size > LIMIT) throw new Error('JSON acima do limite de 4 MiB.');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally { fs.closeSync(fd); }
}
export function shaArquivo(file) {
  const fd = abrirRegular(file);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`Não é arquivo regular: ${file}`);
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: LIMIT, stdio: ['ignore', 'pipe', 'pipe'] });
}
export function revisaoAtual(root) {
  if (fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']).trimEnd()) !== root) throw new Error('A raiz deve ser a raiz do repositório Git.');
  const commit = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  const ocultos = git(root, ['ls-files', '-v', '-z']).split('\0')
    .filter(entry => entry[0] === 'S' || /^[a-z]/.test(entry)).map(entry => entry.slice(2));
  if (ocultos.length) throw new Error(`Flags skip-worktree/assume-unchanged impedem verificar a revisão: ${ocultos.join(', ')}`);
  const entries = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']).split('\0');
  const files = new Set();
  const add = file => { if (file && file !== '.dk' && !file.startsWith('.dk/')) files.add(file); };
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    add(entries[i].slice(3));
    // Em -z, rename/copy traz destino e origem em registros separados.
    if (/[RC]/.test(entries[i].slice(0, 2))) add(entries[++i]);
  }
  const dirty = [...files].sort().map(arquivo => {
    const file = contido(root, arquivo);
    try { fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') return { arquivo, sha256: null };
      throw error;
    }
    return { arquivo, sha256: shaArquivo(file) };
  });
  return { commit, dirty };
}
export function arquivoEvidencia(root, coord) {
  if (!/^[A-Z0-9][A-Z0-9_-]{0,79}$/.test(coord || '')) throw new Error('Coordenação inválida.');
  return contido(root, `.dk/coordenacoes/evidencias/${coord}.verificacao.json`);
}
function gravar(root, coord, data) {
  const buffer = Buffer.from(JSON.stringify(data, null, 2) + '\n');
  if (buffer.length > LIMIT) throw new Error('JSON acima do limite de 4 MiB.');
  const file = arquivoEvidencia(root, coord), folder = path.dirname(file);
  fs.mkdirSync(folder, { recursive: true });
  arquivoEvidencia(root, coord); // Revalidar os ancestrais após criar a pasta.
  const temp = path.join(folder, `.${coord}-${crypto.randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return file;
}
export function provaCli(cli) {
  return cli?.executada === true && text(cli.autorizado_por) && text(cli.data) &&
    Array.isArray(cli.passos) && ['P2', 'P3', 'P4', 'P5'].every(id => {
      const steps = cli.passos.filter(p => p?.id === id);
      return steps.length === 1 && steps[0].resultado === 'ok';
    });
}
function opcoes(args) {
  const options = {}, many = new Set(['alvo', 'passo', 'pacote']);
  const allowed = new Set(['projeto', 'entrada', 'testes', 'ambiente', 'perfil', 'host', 'modelo', 'esforco', 'alvo', 'passo', 'pacote', 'veredito', 'revisor', 'autorizado-por', 'versao', 'limitacao', 'autor', 'motivo']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2), value = args[i + 1];
    if (!args[i].startsWith('--') || !allowed.has(key) || !text(value) || value.startsWith('--')) throw new Error(`Opção inválida ou sem valor: ${args[i]}`);
    if (many.has(key)) (options[key] ||= []).push(value);
    else { if (key in options) throw new Error(`Opção repetida: ${args[i]}`); options[key] = value; }
  }
  return options;
}
function testesRegistro(root, tests) {
  const result = {};
  for (const kind of ['unitarios', 'desktop']) {
    const test = tests?.[kind];
    if (!test || !text(test.comando) || !['passou', 'falhou'].includes(test.status) ||
      !Number.isSafeInteger(test.passou) || test.passou < 0 || !Number.isSafeInteger(test.falhou) || test.falhou < 0 || !text(test.saida)) {
      throw new Error(`Teste ${kind}: informe comando, status, passou, falhou e arquivo de saída.`);
    }
    const output = path.resolve(root, test.saida);
    result[kind] = { comando: test.comando, status: test.status, passou: test.passou, falhou: test.falhou, saida_sha256: shaArquivo(output) };
  }
  return result;
}
export function pacotesVersionados(root, coord) {
  arquivoEvidencia(root, coord); // Validar coord antes de construir a referência Git.
  const file = `docs/coordenacoes/pacotes-${coord.replace(/^COORD-PLUGINS-/, '')}.json`;
  const manifest = JSON.parse(git(root, ['show', `HEAD:${file}`]));
  if (manifest.schema_version !== 1 || manifest.coordenacao !== coord) throw new Error(`Manifesto ${file} incompatível.`);
  validarArquivosPacotes(root, manifest.pacotes);
  return manifest.pacotes;
}
function validarArquivosPacotes(root, pacotes) {
  if (!Array.isArray(pacotes) || !pacotes.length) throw new Error('Informe ao menos um pacote.');
  const ids = new Set(), arquivos = new Set();
  for (const p of pacotes) {
    if (!text(p?.id) || ids.has(p.id)) throw new Error('Pacote com id inválido ou duplicado.');
    ids.add(p.id);
    if (!Array.isArray(p.arquivos) || !p.arquivos.length) throw new Error(`Pacote ${p.id} sem arquivos.`);
    const seen = new Set();
    for (const file of p.arquivos) {
      if (caminhoNormalizado(root, file) !== file) throw new Error(`Pacote ${p.id}: caminho não normalizado: ${file}`);
      if (seen.has(file)) throw new Error(`Pacote ${p.id}: arquivo duplicado: ${file}`);
      seen.add(file); arquivos.add(file);
    }
  }
  return arquivos;
}
export function validarPacotes(root, pacotes, permitirPendentes = false) {
  const arquivos = validarArquivosPacotes(root, pacotes);
  for (const p of pacotes) {
    if (!['host', 'modelo', 'esforco'].every(key => text(p.implementado_por?.[key]))) throw new Error(`Pacote ${p.id}: implementado_por incompleto.`);
    if (permitirPendentes && p.revisao === null) continue;
    if (!text(p.revisao?.revisor) || !text(p.revisao?.data) || !Number.isFinite(Date.parse(p.revisao.data)) ||
      !['aprovado', 'reprovado'].includes(p.revisao?.veredito)) throw new Error(`Pacote ${p.id}: revisão inválida ou pendente.`);
  }
  return arquivos;
}
export function revisaoPacoteConfere(pacote, alvos) {
  const snapshot = pacote.revisao?.alvos;
  const hashes = new Map(alvos.map(a => [a.arquivo, a.sha256]));
  return Array.isArray(snapshot) && snapshot.length === pacote.arquivos.length &&
    snapshot.every((alvo, index) => alvo?.arquivo === pacote.arquivos[index] &&
      hashValido(alvo.sha256) && alvo.sha256 === hashes.get(alvo.arquivo));
}
function pacotesRegistro(root, input, options, anteriores = []) {
  const source = input.pacotes ?? anteriores;
  if (!Array.isArray(source)) throw new Error('Pacotes deve ser uma lista.');
  const ids = new Set();
  let pacotes = source.map(p => {
    if (!text(p?.id) || ids.has(p.id)) throw new Error('Pacote com id inválido ou duplicado.');
    ids.add(p.id);
    const previous = anteriores.find(old => old.id === p.id);
    if (!previous && p.revisao != null) throw new Error(`Pacote ${p.id}: use revisar para gravar um veredito.`);
    return { ...p, revisao: previous?.revisao ?? null };
  });
  for (const p of anteriores) if (!ids.has(p.id)) throw new Error(`Não é permitido remover pacote existente: ${p.id}`);
  const updates = new Set();
  for (const value of options.pacote || []) {
    const match = /^([^=]+)=(.+)$/.exec(value);
    if (!match || updates.has(match[1])) throw new Error(`Pacote inválido ou duplicado: ${value}`);
    const id = match[1]; updates.add(id);
    const previous = pacotes.find(p => p.id === id);
    const updated = { id, arquivos: match[2].split(','),
      implementado_por: previous?.implementado_por || { host: options.host, modelo: options.modelo, esforco: options.esforco },
      revisao: previous?.revisao ?? null };
    if (previous) pacotes[pacotes.indexOf(previous)] = updated;
    else pacotes.push(updated);
  }
  pacotes = pacotes.map(p => ({ ...p, arquivos: p.arquivos?.map(file => caminhoNormalizado(root, file)) }));
  validarPacotes(root, pacotes, true);
  return pacotes;
}
async function confirmar(coord) {
  if (Object.keys(process.env).some(key => ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'ANTIGRAVITY_AGENT'].includes(key) || key.startsWith('CLAUDE_CODE_'))) {
    throw new Error('Aprovação recusada em ambiente de agente. Execute fora do agente, em terminal interativo.');
  }
  if (!process.stdin.isTTY) throw new Error('Aprovação exige TTY interativo e confirmação digitada da coordenação.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`Confirme digitando ${coord}: `);
    if (answer !== coord) throw new Error('Confirmação da coordenação incorreta.');
  } finally { terminal.close(); }
}
export async function executar(args) {
  const [command, coord, ...rest] = args, options = opcoes(rest);
  if (!['registrar', 'cli-oficial', 'decisao-escopo', 'revisar'].includes(command)) throw new Error('Use registrar, cli-oficial, decisao-escopo ou revisar COORD [--projeto RAIZ].');
  if (command !== 'revisar' && (options.veredito !== undefined || options.revisor !== undefined)) throw new Error('Use revisar para gravar um veredito.');
  const projeto = identidade(options.projeto || process.cwd()), root = projeto.realpath;
  const file = arquivoEvidencia(root, coord), now = new Date().toISOString();
  const previous = fs.existsSync(file) ? lerJson(file) : null;
  let evidence;
  if (previous && (previous.schema_version !== 1 || previous.coordenacao !== coord ||
    previous.projeto?.realpath !== projeto.realpath || previous.projeto?.dev !== projeto.dev || previous.projeto?.ino !== projeto.ino)) throw new Error('Evidência existente inválida ou de outro projeto.');
  if (command === 'registrar') {
    const input = options.entrada ? lerJson(path.resolve(root, options.entrada)) : {};
    const targets = options.alvo || input.alvos;
    if (!Array.isArray(targets) || !targets.length) throw new Error('Informe ao menos um alvo (--alvo ou entrada.alvos).');
    const alvos = targets.map(target => {
      const arquivo = caminhoNormalizado(root, typeof target === 'string' ? target : target?.arquivo);
      return { arquivo, sha256: shaArquivo(contido(root, arquivo)) };
    });
    if (new Set(alvos.map(a => a.arquivo)).size !== alvos.length) throw new Error('Alvo duplicado.');
    const pacotes = pacotesRegistro(root, input, options, previous?.pacotes);
    for (const arquivo of validarPacotes(root, pacotes, true)) {
      if (!alvos.some(a => a.arquivo === arquivo)) throw new Error(`Pacote sem alvo coberto: ${arquivo}`);
    }
    for (const pacote of pacotes) if (!revisaoPacoteConfere(pacote, alvos)) pacote.revisao = null;
    const revisao = revisaoAtual(root);
    const ambiente = options.ambiente ? lerJson(path.resolve(root, options.ambiente)) : input.ambiente;
    // Só estas informações são copiadas; valores de process.env não são persistidos.
    evidence = { schema_version: 1, coordenacao: coord, projeto, revisao, alvos, pacotes,
      ambiente: { platform: process.platform, arch: process.arch, node: process.version,
        electron: ambiente?.electron ?? null, claude_versao: ambiente?.claude_versao ?? null, codex_versao: ambiente?.codex_versao ?? null },
      testes: testesRegistro(root, options.testes ? lerJson(path.resolve(root, options.testes)) : input.testes),
      cli_oficial: { executada: false, autorizado_por: null, data: null, versao: null, passos: [], limitacao: 'Rodada manual não registrada.' },
      aprovacao_host_provada: false, decisao_escopo: null };
    if (previous && JSON.stringify([previous.revisao, previous.alvos, previous.pacotes]) === JSON.stringify([revisao, alvos, pacotes])) {
      evidence.cli_oficial = previous.cli_oficial;
      evidence.aprovacao_host_provada = provaCli(previous.cli_oficial);
      evidence.decisao_escopo = previous.decisao_escopo;
    }
  } else {
    if (!previous) throw new Error('Evidência ausente: execute registrar primeiro.');
    await confirmar(coord);
    evidence = previous;
    if (command === 'cli-oficial') {
      if (!/^[^\s@]+@[^\s@]+$/.test(options['autorizado-por'] || '')) throw new Error('Informe --autorizado-por <email>.');
      const passos = (options.passo || []).map(step => {
        const match = /^(P[0-9])=(ok|falhou|nao_executado)$/.exec(step);
        if (!match) throw new Error(`Passo inválido: ${step}`);
        return { id: match[1], resultado: match[2], observacao: '' };
      });
      if (new Set(passos.map(p => p.id)).size !== passos.length) throw new Error('Passo duplicado.');
      const executada = passos.some(p => p.resultado !== 'nao_executado');
      if (!executada && !text(options.limitacao)) throw new Error('Informe passos executados ou --limitacao.');
      evidence.cli_oficial = { executada, autorizado_por: options['autorizado-por'], data: now, versao: options.versao || null, passos, limitacao: options.limitacao || '' };
      evidence.aprovacao_host_provada = provaCli(evidence.cli_oficial);
    } else if (command === 'revisar') {
      if (options.pacote?.length !== 1 || !['aprovado', 'reprovado'].includes(options.veredito) || !text(options.revisor)) throw new Error('Informe --pacote <id> --veredito aprovado|reprovado --revisor <nome>.');
      validarPacotes(root, evidence.pacotes, true);
      const pacote = evidence.pacotes.find(p => p.id === options.pacote[0]);
      if (!pacote) throw new Error(`Pacote desconhecido: ${options.pacote[0]}`);
      const alvos = pacote.arquivos.map(arquivo => ({ arquivo, sha256: shaArquivo(contido(root, arquivo)) }));
      pacote.revisao = { revisor: options.revisor, veredito: options.veredito, data: now, alvos };
    } else {
      if (!text(options.autor) || !text(options.motivo)) throw new Error('Informe --autor e --motivo.');
      evidence.decisao_escopo = { autor: options.autor, data: now, motivo: options.motivo };
    }
  }
  evidence.gravado_por = { perfil: options.perfil || 'testador', host: options.host || 'local', data: now };
  return gravar(root, coord, evidence);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ arquivo: await executar(process.argv.slice(2)) })); }
  catch (error) { console.error(JSON.stringify({ motivos: [error.message] })); process.exitCode = 1; }
}
