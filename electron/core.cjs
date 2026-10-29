const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parse: parseYaml } = require('yaml');
const projectTitles = new Map();

function projectTitle(root) {
  try {
    const target = fs.realpathSync(path.join(root, 'projeto.yml'));
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return path.basename(root);
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > 256 * 1024) return path.basename(root);
    const key = `${target}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    if (projectTitles.has(key)) return projectTitles.get(key);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let content;
    try {
      const buffer = Buffer.alloc(256 * 1024 + 1);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (count > 256 * 1024) return path.basename(root);
      content = buffer.subarray(0, count).toString('utf8');
    } finally { fs.closeSync(fd); }
    const data = parseYaml(content, { maxAliasCount: 50 });
    const title = typeof data?.projeto === 'string' && data.projeto.trim() ? data.projeto.replace(/\s+/g, ' ').trim().slice(0, 500) : path.basename(root);
    if (projectTitles.size >= 128) projectTitles.clear();
    projectTitles.set(key, title);
    return title;
  } catch { return path.basename(root); }
}

const ACTIONS = Object.freeze({
  audit: { label: 'Auditoria', args: root => ['audit', '--projeto', root, '--json'] },
  validate: { label: 'Validação', args: root => ['projeto', 'validar', '--projeto', root, '--json'] },
  doctor: { label: 'Diagnóstico', args: () => ['doctor', '--json'] },
});

function directory(value) {
  if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw new Error('Pasta inválida.');
  const real = fs.realpathSync(value);
  if (!fs.statSync(real).isDirectory()) throw new Error('Selecione uma pasta.');
  return real;
}

function boundedInteger(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Dimensão de terminal inválida.');
  return value;
}

function dimensions(size) {
  if (!size || typeof size !== 'object') throw new Error('Dimensões ausentes.');
  return { cols: boundedInteger(size.cols, 2, 500), rows: boundedInteger(size.rows, 1, 300) };
}

function projectInfo(value) {
  const root = directory(value);
  const exists = rel => fs.existsSync(path.join(root, rel));
  const markers = ['projeto.yml', '.dk/projeto.json'];
  return {
    path: root, name: path.basename(root), title: projectTitle(root), isDk: markers.some(exists),
    files: [
      ...markers.map(name => ({ name, present: exists(name) })),
      { name: '.git', present: exists('.git') },
    ],
  };
}

function kitInfo(value) {
  const root = directory(value);
  const cli = path.join(root, 'cli', 'dk');
  if (!fs.existsSync(cli) || !fs.statSync(cli).isFile()) throw new Error('Não encontrei cli/dk nesta pasta. Selecione a raiz do kit.');
  return { path: root, cli };
}

function executable(name, env = process.env) {
  for (const entry of (env.PATH || '').split(path.delimiter)) {
    if (!entry) continue;
    const target = path.join(entry, process.platform === 'win32' ? `${name}.exe` : name);
    try { fs.accessSync(target, fs.constants.X_OK); return target; } catch {}
  }
  return null;
}

function shellSpec(env = process.env) {
  if (process.platform === 'win32') return { file: env.ComSpec || 'powershell.exe', args: [] };
  let file = env.SHELL;
  try { if (!file || !path.isAbsolute(file)) throw new Error(); fs.accessSync(file, fs.constants.X_OK); }
  catch { file = '/bin/zsh'; if (!fs.existsSync(file)) file = '/bin/bash'; }
  return { file, args: ['-l'] };
}

// Pastas onde instaladores conhecidos colocam CLIs (Claude Code, Codex, Gemini,
// Antigravity, npm global, gerenciadores de Node). Muitos instaladores só
// acrescentam a pasta ao ~/.zshrc, que o shell de login não interativo não lê;
// por isso elas entram depois do PATH do usuário, só quando existem.
function knownToolDirectories(home = os.homedir(), platform = process.platform) {
  if (platform === 'win32') return [];
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  let nvmBins = [];
  try {
    nvmBins = fs.readdirSync(nvm).filter(name => /^v\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => { const [x, y] = [a, b].map(v => v.slice(1).split('.').map(Number)); return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]); })
      .map(name => path.join(nvm, name, 'bin'));
  } catch {}
  const candidates = [
    path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.claude', 'local', 'node_modules', '.bin'),
    path.join(home, '.codex', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.bun', 'bin'),
    path.join(home, '.asdf', 'shims'), ...nvmBins, '/opt/homebrew/bin', '/usr/local/bin',
  ];
  return candidates.filter(dir => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } });
}

// Acrescenta pastas ao fim do PATH sem repetir; o PATH do usuário tem prioridade.
function extendPath(env, dirs) {
  const entries = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const extra = dirs.filter(dir => !entries.includes(dir));
  if (!extra.length) return env;
  return { ...env, PATH: [...entries, ...extra].join(path.delimiter) };
}

// Finder starts apps with a minimal PATH; read only PATH from the user's login shell.
function loginEnvironment() {
  const env = { ...process.env };
  if (process.platform === 'win32') return Promise.resolve(env);
  return new Promise(resolve => {
    const { file } = shellSpec(env);
    const child = spawn(file, ['-lc', 'printf "\\0%s\\0" "$PATH"'], { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', finished = false;
    const finish = kill => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (kill && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      child.stdout.destroy();
      const parts = output.split('\0');
      if (parts.length >= 3 && parts[parts.length - 2]) env.PATH = parts[parts.length - 2];
      resolve(env);
    };
    const timer = setTimeout(() => finish(true), 4000);
    child.stdout.on('data', data => { output += data.toString('utf8'); if (output.length > 128 * 1024) finish(true); });
    child.once('error', () => finish(false)); child.once('close', () => finish(false));
  });
}

function folderForFile(value) {
  const absolute = fs.realpathSync(value);
  return directory(fs.statSync(absolute).isDirectory() ? absolute : path.dirname(absolute));
}

function actionSpec(action, project, kit, env = process.env) {
  const entry = ACTIONS[action];
  if (!Object.hasOwn(ACTIONS, action)) throw new Error('Ação desconhecida.');
  if (action === 'validate' && !project.isDk) throw new Error('Esta pasta ainda não contém um projeto DK.');
  if (!kit) throw new Error('Instale ou ative o plugin DK antes de usar as ações.');
  const python = executable('python3', env);
  if (!python) throw new Error('Python 3 não foi encontrado. Instale-o para executar o DK.');
  return { label: entry.label, file: python, args: [kit.cli, ...entry.args(project.path)] };
}

function readState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      projects: Array.isArray(data.projects) ? [...new Set(data.projects.filter(x => typeof x === 'string'))].slice(0, 12) : [],
      kitRoot: typeof data.kitRoot === 'string' ? data.kitRoot : null,
      remoteProjects: Array.isArray(data.remoteProjects) ? data.remoteProjects.filter(x=>x && Number.isSafeInteger(x.id) && x.id > 0 && typeof x.name === 'string' && typeof x.path === 'string').slice(0, 12).map(x=>({id:x.id,name:x.name.slice(0,200),path:x.path.slice(0,500)})) : [],
    };
  } catch { return { projects: [], kitRoot: null, remoteProjects: [] }; }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

module.exports = { ACTIONS, actionSpec, dimensions, directory, projectInfo, kitInfo, executable, shellSpec, loginEnvironment, knownToolDirectories, extendPath, folderForFile, readState, writeState };
