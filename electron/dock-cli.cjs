const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER = '# SEA Dock command v1 ';
const MAX_SCRIPT_BYTES = 32 * 1024;
const defaultTemporaryRoots = () => ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/private/var/folders', os.tmpdir()];
const quoted = value => `'${value.replace(/'/g, `'\\''`)}'`;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

function applicationFor(executable, temporaryRoots = defaultTemporaryRoots()) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.includes('\0')) throw new Error('Aplicativo inválido.');
  let real;
  try { real = fs.realpathSync(executable); } catch { throw new Error('O executável do SEA Dock não foi encontrado.'); }
  const macOS = path.dirname(real), contents = path.dirname(macOS), bundle = path.dirname(contents);
  if (path.basename(macOS) !== 'MacOS' || path.basename(contents) !== 'Contents' || !bundle.toLowerCase().endsWith('.app')) {
    throw new Error('Instale o comando a partir de uma cópia empacotada do SEA Dock.');
  }
  if (!fs.statSync(real).isFile()) throw new Error('O executável do SEA Dock não é um arquivo comum.');
  try { fs.accessSync(real, fs.constants.X_OK); } catch { throw new Error('O executável do SEA Dock não pode ser iniciado.'); }
  for (const item of temporaryRoots) {
    if (!item || !path.isAbsolute(item)) continue;
    let temporary = path.resolve(item);
    try { temporary = fs.realpathSync(temporary); } catch {}
    if (inside(temporary, bundle)) throw new Error('Mova o SEA Dock para uma pasta permanente, como Aplicativos, antes de instalar o comando.');
  }
  return { bundle, executable: path.relative(bundle, real) };
}

// The only interpolated values are single-quoted shell literals. Every user
// argument remains a separate positional argument through /usr/bin/open.
function scriptFor(application, launcher = '/usr/bin/open') {
  const meta = { bundle: application.bundle, executable: application.executable, launcher };
  const metadata = Buffer.from(JSON.stringify(meta)).toString('base64');
  return `#!/bin/sh\n${MARKER}${metadata}\n` +
    `_dock_app=${quoted(meta.bundle)}\n_dock_exe=${quoted(meta.executable)}\n` +
    `if [ "\${1-}" = '--help' ] && [ "$#" -eq 1 ]; then\n  printf '%s\\n' 'Uso: dock [caminho ...]' 'Abre pastas ou as pastas que contêm os arquivos no SEA Dock.'\n  exit 0\nfi\n` +
    `if [ ! -x "$_dock_app/$_dock_exe" ]; then\n  printf '%s\\n' 'SEA Dock não foi encontrado no local instalado. Abra a cópia atual do aplicativo e instale novamente o comando.' >&2\n  exit 1\nfi\n` +
    `if [ "\${1-}" = '--' ]; then shift; fi\n[ "$#" -gt 0 ] || set -- .\n` +
    `if [ "$#" -gt 32 ]; then printf '%s\\n' 'Informe no máximo 32 caminhos.' >&2; exit 1; fi\n` +
    // The sentinel retains a newline at the end of a valid directory name.
    `_dock_cwd=$(pwd -P && printf '.') || exit 1\n_dock_cwd=\${_dock_cwd%.}\n_dock_cwd=\${_dock_cwd%?}\n` +
    `_dock_remaining=$#\nwhile [ "$_dock_remaining" -gt 0 ]; do\n` +
    `  case "$1" in '') printf '%s\\n' 'Caminho vazio.' >&2; exit 1;; /*) _dock_path=$1;; *) _dock_path="$_dock_cwd/$1";; esac\n  shift\n` +
    `  if [ ! -d "$_dock_path" ] && [ ! -f "$_dock_path" ]; then printf 'Caminho não encontrado: %s\\n' "$_dock_path" >&2; exit 1; fi\n` +
    `  set -- "$@" "$_dock_path"\n  _dock_remaining=$((_dock_remaining - 1))\ndone\n` +
    `exec ${quoted(launcher)} -a "$_dock_app" -- "$@"\n`;
}

function decodeManagedScript(contents, launcher = '/usr/bin/open') {
  if (typeof contents !== 'string' || Buffer.byteLength(contents) > MAX_SCRIPT_BYTES) return null;
  const line = contents.split('\n', 3)[1] || '';
  if (!line.startsWith(MARKER)) return null;
  try {
    const encoded = line.slice(MARKER.length);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return null;
    const meta = JSON.parse(bytes.toString('utf8'));
    if (!meta || typeof meta.bundle !== 'string' || !path.isAbsolute(meta.bundle) || meta.bundle.includes('\0') ||
        typeof meta.executable !== 'string' || !meta.executable.startsWith('Contents/MacOS/') || meta.executable.includes('\0') ||
        meta.executable.split('/').includes('..') || meta.launcher !== launcher) return null;
    return scriptFor(meta, launcher) === contents ? meta : null;
  } catch { return null; }
}

function destination(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home) || home.includes('\0')) throw new Error('Pasta pessoal inválida.');
  return path.join(home, '.local', 'bin', 'dock');
}

function pathContains(directory, envPath) {
  return String(envPath || '').split(path.delimiter).filter(Boolean).some(entry => {
    if (!path.isAbsolute(entry)) return false;
    try { return fs.realpathSync(entry) === fs.realpathSync(directory); } catch { return path.resolve(entry) === path.resolve(directory); }
  });
}

function findCollision(target, envPath) {
  for (const dir of String(envPath || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'dock');
    if (path.resolve(candidate) === path.resolve(target)) continue;
    try { if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } } catch {}
  }
  return null;
}

function readExisting(file, launcher) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.size > MAX_SCRIPT_BYTES) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened) || (typeof process.getuid === 'function' && opened.uid !== process.getuid())) return null;
    const buffer = Buffer.alloc(MAX_SCRIPT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!bytes) break;
      offset += bytes;
    }
    if (offset > MAX_SCRIPT_BYTES) return null;
    const contents = buffer.subarray(0, offset).toString('utf8');
    const after = fs.fstatSync(fd);
    const meta = decodeManagedScript(contents, launcher);
    if (!meta || !sameFile(opened, after)) return null;
    return { meta, contents, stat: after };
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function install({ home, executable, envPath, platform = process.platform, temporaryRoots = defaultTemporaryRoots(), launcher = '/usr/bin/open' }) {
  if (platform !== 'darwin') throw new Error('O comando dock está disponível apenas no macOS nesta versão.');
  const application = applicationFor(executable, temporaryRoots), file = destination(home);
  const contents = scriptFor(application, launcher);
  if (Buffer.byteLength(contents) > MAX_SCRIPT_BYTES) throw new Error('O caminho do aplicativo é longo demais para instalar o comando.');
  const availableInPath = pathContains(path.dirname(file), envPath);
  const collision = findCollision(file, envPath);
  if (collision) throw new Error(`Outro comando dock já está disponível em ${collision}; ele foi preservado.`);
  const existing = readExisting(file, launcher);
  if (existing?.contents === contents) return { file, bundle: application.bundle, alreadyInstalled: true, availableInPath };
  try { fs.lstatSync(file); throw new Error(`Já existe um arquivo em ${file}; ele foi preservado. Remova o comando anterior antes de instalar outro.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  let fd, created;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o700);
    created = fs.fstatSync(fd);
    fs.fchmodSync(fd, 0o700);
    fs.writeFileSync(fd, contents, 'utf8');
    fs.closeSync(fd); fd = undefined;
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (created) try { const current = fs.lstatSync(file); if (current.isFile() && current.dev === created.dev && current.ino === created.ino) fs.unlinkSync(file); } catch {}
    if (error.code === 'EEXIST') throw new Error(`Já existe um arquivo em ${file}; ele foi preservado.`);
    throw error;
  }
  return { file, bundle: application.bundle, alreadyInstalled: false, availableInPath };
}

function uninstall({ home, platform = process.platform, launcher = '/usr/bin/open' }) {
  if (platform !== 'darwin') throw new Error('O comando dock está disponível apenas no macOS nesta versão.');
  const file = destination(home), existing = readExisting(file, launcher);
  if (!existing) {
    try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { file, removed: false }; throw error; }
    throw new Error(`O arquivo em ${file} não é um comando íntegro instalado pelo SEA Dock; ele foi preservado.`);
  }
  const now = fs.lstatSync(file);
  if (!now.isFile() || !sameFile(existing.stat, now)) throw new Error('O comando mudou durante a verificação e foi preservado.');
  fs.unlinkSync(file);
  return { file, removed: true };
}

module.exports = { applicationFor, destination, scriptFor, decodeManagedScript, install, uninstall };
