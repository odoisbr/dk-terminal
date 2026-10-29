const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { execFile } = require('node:child_process');

const MAX_FILES = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_LINE = 8 * 1024;
const FILE_PATTERN = /^sea-dock-\d{4}-\d{2}-\d{2}(?:-\d+)?\.log$/;

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Redação aplicada a toda linha antes de ir para o disco. Prefere apagar demais
// a deixar passar um segredo: o arquivo é enviado ao suporte.
function redact(value, options = {}) {
  let text = typeof value === 'string' ? value : String(value);
  for (const secret of options.secrets || []) {
    if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[REDACTED]');
  }
  const sensitiveName = '[A-Za-z0-9_.-]*(?:token|secret|password|passwd|key|credential|auth)[A-Za-z0-9_.-]*';
  text = text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 [REDACTED]')
    // NOME=valor, NOME: valor, "nome":"valor" e ?nome=valor quando o nome indica segredo.
    .replace(new RegExp(`(${sensitiveName})(["']?\\s*[:=]\\s*)(["'])(.*?)\\3`, 'gi'),
      (match, name, separator, quote, secret) => secret.startsWith('[REDACTED') ? match : `${name}${separator}${quote}[REDACTED]${quote}`)
    .replace(new RegExp(`(${sensitiveName})(["']?\\s*[:=]\\s*)(?!["'])([^\\s"'&,;}\\]]+)`, 'gi'),
      (match, name, separator, secret) => secret.startsWith('[REDACTED') ? match : `${name}${separator}[REDACTED]`)
    .replace(/\bsea_pat_[A-Za-z0-9_-]+/g, 'sea_pat_[REDACTED]')
    .replace(/\bglpat-[A-Za-z0-9_-]+/g, 'glpat-[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]+/g, match => `${match.slice(0, 4)}[REDACTED]`)
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, 'github_pat_[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[REDACTED]')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]+/g, 'xox-[REDACTED]')
    // Credenciais em URL: https://usuario:senha@host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1$2:[REDACTED]@');
  const homes = [...new Set((options.homes || []).filter(home => typeof home === 'string' && home.length > 1))].sort((a, b) => b.length - a.length);
  for (const home of homes) text = text.replace(new RegExp(`${escapeRegExp(home)}(?=$|[/\\s"':;,)\\]])`, 'g'), '~');
  return text;
}

function formatArgs(args) {
  return args.map(item => {
    if (item instanceof Error) return item.stack || `${item.name}: ${item.message}`;
    if (typeof item === 'string') return item;
    return util.inspect(item, { depth: 3, breakLength: Infinity, maxArrayLength: 20, maxStringLength: 2000 });
  }).join(' ');
}

function dateStamp(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

class DebugLog {
  constructor(options) {
    this.directory = options.directory;
    this.settingsFile = options.settingsFile;
    this.maxFiles = options.maxFiles || MAX_FILES;
    this.maxBytes = options.maxBytes || MAX_BYTES;
    this.now = options.now || (() => new Date());
    this.homes = options.homes || [];
    this.secrets = options.secrets || (() => []);
    this.header = options.header || (() => ({}));
    this.forced = options.forced === true;
    this.saved = false;
    try { this.saved = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')).enabled === true; } catch {}
    this.enabled = this.forced || this.saved;
    this.file = null;
    this.headerWritten = false;
    this.failed = false;
  }
  state() {
    return { enabled: this.enabled, forced: this.forced, directory: this.redact(this.directory), file: this.file ? this.redact(this.file) : null };
  }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Estado do modo debug inválido.');
    this.saved = enabled;
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    const temp = `${this.settingsFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ enabled }) + '\n', { mode: 0o600 });
    fs.renameSync(temp, this.settingsFile);
    const next = this.forced || enabled;
    if (next && !this.enabled) { this.enabled = true; this.headerWritten = false; this.write('info', 'debug', 'Modo debug ligado nas configurações.'); }
    else if (!next && this.enabled) { this.write('info', 'debug', 'Modo debug desligado nas configurações.'); this.enabled = false; this.file = null; }
    return this.state();
  }
  redact(text) {
    let secrets = [];
    try { secrets = this.secrets() || []; } catch {}
    return redact(text, { homes: this.homes, secrets });
  }
  // Escolhe o arquivo do dia; ao passar do limite abre sea-dock-<data>-2.log e
  // remove os mais antigos, mantendo no máximo maxFiles arquivos.
  target(size) {
    const base = `sea-dock-${dateStamp(this.now())}`;
    if (this.file && path.basename(this.file).startsWith(base)) {
      let current = 0; try { current = fs.statSync(this.file).size; } catch {}
      if (current + size <= this.maxBytes) return this.file;
    }
    // Continua no maior índice do dia; nunca reaproveita um índice já removido.
    let highest = 0;
    try {
      for (const name of fs.readdirSync(this.directory)) {
        if (name === `${base}.log`) highest = Math.max(highest, 1);
        const match = name.startsWith(`${base}-`) && /^-(\d+)\.log$/.exec(name.slice(base.length));
        if (match) highest = Math.max(highest, Number(match[1]));
      }
    } catch {}
    const nameFor = index => path.join(this.directory, index <= 1 ? `${base}.log` : `${base}-${index}.log`);
    let index = Math.max(highest, 1), current = 0;
    try { current = fs.statSync(nameFor(index)).size; } catch {}
    if (current > 0 && current + size > this.maxBytes) index++;
    const candidate = nameFor(index);
    if (candidate !== this.file) { this.file = candidate; this.headerWritten = false; }
    return candidate;
  }
  prune() {
    let names;
    try { names = fs.readdirSync(this.directory).filter(name => FILE_PATTERN.test(name)); } catch { return; }
    // Ordem pelo nome: data e índice crescem com o tempo.
    const order = name => { const match = /^sea-dock-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.log$/.exec(name); return [match[1], Number(match[2] || 1)]; };
    const files = names.map(name => ({ file: path.join(this.directory, name), key: order(name) }))
      .sort((a, b) => b.key[0].localeCompare(a.key[0]) || b.key[1] - a.key[1]);
    const keep = new Set(files.slice(0, this.maxFiles).map(item => item.file));
    if (this.file) keep.add(this.file);
    for (const item of files) if (!keep.has(item.file)) { try { fs.unlinkSync(item.file); } catch {} }
  }
  headerText() {
    let info = {};
    try { info = this.header() || {}; } catch {}
    const fields = Object.entries(info).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([name, value]) => `${name}=${value}`);
    return `=== SEA Dock · log de diagnóstico · ${this.now().toISOString()} · ${fields.join(' · ')} ===`;
  }
  write(level, source, message) {
    if (!this.enabled || this.failed) return false;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      let line = `${this.now().toISOString()} [${String(level).toUpperCase()}] [${source}] ${String(message)}`;
      line = this.redact(line);
      if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)} …[truncado]`;
      line = line.replace(/\r?\n(?!$)/g, '\n    ') + '\n';
      const before = this.file;
      let file = this.target(Buffer.byteLength(line) + 512);
      let output = line;
      if (!this.headerWritten) { output = this.redact(this.headerText()) + '\n' + line; this.headerWritten = true; }
      fs.appendFileSync(file, output, { mode: 0o600 });
      if (before !== file) this.prune();
      return true;
    } catch {
      // Uma falha de disco não pode derrubar o aplicativo nem gerar recursão de log.
      this.failed = true;
      return false;
    }
  }
  event(source, message) { return this.write('info', source, message); }
  error(source, message) { return this.write('error', source, message); }
  files() {
    try { return fs.readdirSync(this.directory).filter(name => FILE_PATTERN.test(name)).sort().map(name => path.join(this.directory, name)); }
    catch { return []; }
  }
  // Empacota só os arquivos de log, já redigidos. No macOS usa ditto, que já vem
  // com o sistema; em outras plataformas gera um único .txt.
  async exportTo(destinationDir, platform = process.platform) {
    const files = this.files();
    if (!files.length) throw new Error('Ainda não há logs. Ligue o modo debug e repita o problema.');
    fs.mkdirSync(destinationDir, { recursive: true });
    const stamp = this.now().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    if (platform === 'darwin' && fs.existsSync('/usr/bin/ditto')) {
      const target = path.join(destinationDir, `sea-dock-logs-${stamp}.zip`);
      await new Promise((resolve, reject) => {
        execFile('/usr/bin/ditto', ['-c', '-k', '--keepParent', this.directory, target], { timeout: 30000, env: { PATH: '/usr/bin:/bin' } }, error => error ? reject(new Error('Não foi possível compactar os logs.')) : resolve());
      });
      return target;
    }
    const target = path.join(destinationDir, `sea-dock-logs-${stamp}.txt`);
    const parts = files.map(file => `##### ${path.basename(file)}\n${fs.readFileSync(file, 'utf8')}`);
    fs.writeFileSync(target, parts.join('\n'), { mode: 0o600 });
    return target;
  }
}

// Duplica console.* do processo principal para o log, sem alterar a saída original.
function captureConsole(log, target = console) {
  const original = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    original[level] = target[level].bind(target);
    target[level] = (...args) => {
      original[level](...args);
      if (log.enabled) log.write(level === 'log' ? 'info' : level, 'main', formatArgs(args));
    };
  }
  return original;
}

module.exports = { DebugLog, redact, formatArgs, captureConsole, FILE_PATTERN };
