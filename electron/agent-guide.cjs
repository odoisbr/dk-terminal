const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Guia do SEA Dock para agentes de IA (dock-tools/agents/AGENTS.md). Fonte única:
// entregue às CLIs que o app lança (sem gravar no projeto), impresso por
// `dock-agents` e, só por ação explícita, gravado num bloco do AGENTS.md do projeto.
const GUIDE_START = '<!-- sea-dock:inicio -->';
const GUIDE_END = '<!-- sea-dock:fim -->';
const GUIDE_LIMIT = 32 * 1024;
const PROJECT_FILE_LIMIT = 1024 * 1024;

function agentGuidePath({ isPackaged, resourcesPath, appPath }) {
  const file = isPackaged ? path.join(resourcesPath, 'dock-tools', 'agents', 'AGENTS.md') : path.join(appPath, 'dock-tools', 'agents', 'AGENTS.md');
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

function readGuide(file) {
  if (!file) return '';
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > GUIDE_LIMIT) return '';
    return fs.readFileSync(file, 'utf8');
  } catch { return ''; }
}

function agentGuideEnvironment(file) { return file ? { SEA_DOCK_AGENTS_MD: file } : {}; }

// TOML aceita as mesmas sequências de escape que JSON.stringify produz; DEL
// precisa de escape explícito.
function tomlString(text) { return JSON.stringify(String(text)).replace(/\u007f/g, '\\u007f'); }

// Opção já presente, na forma `--opcao valor` ou `--opcao=valor`.
function hasOption(args, names) { return args.some(arg => names.some(name => arg === name || arg.startsWith(`${name}=`))); }
function hasCodexInstructions(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value = null;
    if (arg === '-c' || arg === '--config') value = args[i + 1] || '';
    else if (arg.startsWith('--config=')) value = arg.slice(9);
    else if (arg.startsWith('-c') && arg.length > 2) value = arg.slice(arg[2] === '=' ? 3 : 2);
    if (value !== null && /^\s*developer_instructions\s*=/.test(value)) return true;
  }
  return false;
}

// `developer_instructions` no nível raiz do config.toml do Codex (antes da
// primeira tabela). Só lê; quando existe, o app não sobrepõe o que a pessoa definiu.
function codexConfigHasInstructions(env = process.env) {
  const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
  let text;
  try {
    const file = path.join(home, 'config.toml');
    if (fs.statSync(file).size > PROJECT_FILE_LIMIT) return false;
    text = fs.readFileSync(file, 'utf8');
  } catch { return false; }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    if (/^\s*developer_instructions\s*=/.test(line)) return true;
  }
  return false;
}

// Argumentos da CLI com o guia. Só acrescenta opções no começo e preserva as
// da pessoa; se ela já definiu a mesma coisa, nada muda.
function agentLaunchArgs(command, args, { guideFile = null, guideText = '', codexHasInstructions = false } = {}) {
  const original = Array.isArray(args) ? [...args] : [];
  if (!guideFile) return original;
  const name = path.basename(String(command || '')).toLowerCase();
  if (name === 'claude') {
    if (hasOption(original, ['--append-system-prompt', '--append-system-prompt-file', '--system-prompt', '--system-prompt-file'])) return original;
    return ['--append-system-prompt-file', guideFile, ...original];
  }
  if (name === 'codex') {
    if (!guideText.trim() || codexHasInstructions || hasCodexInstructions(original)) return original;
    return ['-c', `developer_instructions=${tomlString(guideText)}`, ...original];
  }
  if (name === 'agy') {
    // O Antigravity lê AGENTS.md das pastas adicionadas ao espaço de trabalho.
    const directory = path.dirname(guideFile);
    for (let i = 0; i < original.length; i++) {
      if ((original[i] === '--add-dir' && original[i + 1] === directory) || original[i] === `--add-dir=${directory}`) return original;
    }
    return ['--add-dir', directory, ...original];
  }
  return original;
}

function guideBlock(guideText) { return `${GUIDE_START}\n${String(guideText).trim()}\n${GUIDE_END}\n`; }

// Cria ou atualiza o bloco delimitado no AGENTS.md, preservando o resto.
function upsertGuideBlock(existing, guideText) {
  const block = guideBlock(guideText);
  if (existing == null) return { content: block, action: 'create', changed: true, block };
  const start = existing.indexOf(GUIDE_START), end = existing.indexOf(GUIDE_END);
  const startCount = existing.split(GUIDE_START).length - 1, endCount = existing.split(GUIDE_END).length - 1;
  if (startCount === 0 && endCount === 0) {
    const separator = existing === '' ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return { content: existing + separator + block, action: 'append', changed: true, block };
  }
  if (startCount !== 1 || endCount !== 1 || end < start) throw new Error(`O AGENTS.md tem marcadores ${GUIDE_START} e ${GUIDE_END} incompletos ou repetidos. Corrija o arquivo manualmente e tente de novo.`);
  let after = end + GUIDE_END.length;
  if (existing[after] === '\n') after += 1;
  const content = existing.slice(0, start) + block + existing.slice(after);
  return { content, action: 'update', changed: content !== existing, block };
}

// Lê o AGENTS.md da raiz do projeto: arquivo comum, sem link simbólico.
function readProjectAgents(root) {
  const file = path.join(root, 'AGENTS.md');
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { file, text: null }; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('O AGENTS.md do projeto não é um arquivo comum (link simbólico ou pasta). Ajuste-o manualmente.');
  if (stat.size > PROJECT_FILE_LIMIT) throw new Error('O AGENTS.md do projeto passa de 1 MiB. Ajuste-o manualmente.');
  return { file, text: fs.readFileSync(file, 'utf8'), mode: stat.mode & 0o777 };
}

// Gravação atômica na mesma pasta; mantém as permissões do arquivo existente.
function writeProjectAgents(root, content, mode = 0o644) {
  const file = path.join(root, 'AGENTS.md');
  const temporary = path.join(root, `.AGENTS.md.sea-dock-${process.pid}-${Date.now()}`);
  const handle = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode);
  try { fs.writeFileSync(handle, content, 'utf8'); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  try { fs.chmodSync(temporary, mode); fs.renameSync(temporary, file); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
  return file;
}

module.exports = {
  GUIDE_START, GUIDE_END, agentGuidePath, readGuide, agentGuideEnvironment, agentLaunchArgs, codexConfigHasInstructions,
  tomlString, guideBlock, upsertGuideBlock, readProjectAgents, writeProjectAgents,
};
