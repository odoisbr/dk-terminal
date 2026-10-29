// Produce an explicit install plan; this module never starts a process or
// changes a project's package manager, configuration, lockfile, or cache.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const LOCKFILES = [
  ['npm-shrinkwrap.json', 'npm'], ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
];

function regularFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile()) throw new Error(`${path.basename(file)} precisa ser um arquivo comum.`);
  return true;
}

function manifest(file) {
  if (!regularFile(file)) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd), limit = 256 * 1024;
    if (!stat.isFile() || stat.size > limit) throw new Error('package.json inválido ou maior que 256 KB.');
    const data = Buffer.alloc(limit + 1); let length = 0;
    while (length < data.length) { const size = fs.readSync(fd, data, length, data.length - length, null); if (!size) break; length += size; }
    if (length > limit) throw new Error('package.json maior que 256 KB.');
    let value; try { value = JSON.parse(data.subarray(0, length).toString('utf8')); } catch { throw new Error('package.json não contém JSON válido.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('package.json precisa conter um objeto.');
    return value;
  } finally { fs.closeSync(fd); }
}

function workspaceAbove(root) {
  let current = path.dirname(root);
  while (current !== path.dirname(current)) {
    const file = path.join(current, 'package.json');
    // A workspace owner may contain the actual lockfile/configuration. Do not
    // accidentally prepare a child as an independent project.
    let pkg = null;
    try { pkg = manifest(file); } catch { return current; }
    if (pkg && (Array.isArray(pkg.workspaces) || (pkg.workspaces && Array.isArray(pkg.workspaces.packages)))) return current;
    if (regularFile(path.join(current, 'pnpm-workspace.yaml'))) return current;
    current = path.dirname(current);
  }
  return null;
}

// The revision never contains file contents. The lockfiles are bounded and
// hashed; config files may contain credentials, so only their metadata is read.
function fingerprint(root) {
  const hash = createHash('sha256');
  const directory = fs.statSync(root);
  hash.update([root, directory.dev, directory.ino].join(':') + '\0');
  const files = ['package.json', ...LOCKFILES.map(([name]) => name), 'pnpm-workspace.yaml'];
  const configs = ['.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml'];
  for (const name of [...files, ...configs]) {
    const file = path.join(root, name);
    hash.update(name + '\0');
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') { hash.update('missing\0'); continue; } throw error; }
    hash.update([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':') + '\0');
    if (configs.includes(name)) {
      if (stat.isSymbolicLink()) {
        try { const target = fs.statSync(file); hash.update([target.dev, target.ino, target.size, target.mtimeMs, target.ctimeMs].join(':') + '\0'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; hash.update('broken\0'); }
      }
      continue;
    }
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error(`${name} precisa ser um arquivo comum de até 16 MB.`);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error(`${name} mudou durante a análise.`);
      const buffer = Buffer.allocUnsafe(64 * 1024); let offset = 0;
      for (;;) { const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break; offset += n; if (offset > 16 * 1024 * 1024) throw new Error(`${name} excede 16 MB.`); hash.update(buffer.subarray(0, n)); }
      const after = fs.fstatSync(fd);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error(`${name} mudou durante a análise.`);
    } finally { fs.closeSync(fd); }
  }
  return hash.digest('hex');
}

function detectPackageManager(root) {
  try {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw new Error('Pasta de projeto inválida.');
    const realRoot = fs.realpathSync(root);
    if (!fs.statSync(realRoot).isDirectory()) throw new Error('Pasta de projeto inválida.');
    const pkg = manifest(path.join(realRoot, 'package.json'));
    if (!pkg) return { ok: false, reason: 'missing', error: 'Este projeto não contém package.json.' };
    const workspace = workspaceAbove(realRoot);
    if (workspace) return { ok: false, error: 'Este projeto pode pertencer a um workspace. Abra a pasta raiz do workspace para preparar suas dependências.', workspace };
    let declared = null;
    if (pkg.packageManager !== undefined) {
      if (typeof pkg.packageManager !== 'string' || !/^(npm|pnpm|yarn|bun)@[^\s/\\]+$/.test(pkg.packageManager)) {
        return { ok: false, error: 'O gerenciador declarado em packageManager não é reconhecido. Prepare este projeto pelo terminal.' };
      }
      declared = pkg.packageManager.slice(0, pkg.packageManager.indexOf('@'));
    }
    const found = LOCKFILES.filter(([name]) => regularFile(path.join(realRoot, name)));
    // npmrc is shared by several managers and is deliberately not used as a
    // manager signal. The other files identify their respective tools.
    const markers = [['pnpm-workspace.yaml', 'pnpm'], ['.yarnrc.yml', 'yarn'], ['.yarnrc', 'yarn'], ['bunfig.toml', 'bun']]
      .filter(([name]) => { try { return fs.statSync(path.join(realRoot, name)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } });
    // A project may use Bun or Yarn as a runtime/tool while another manager
    // owns its lockfile. Config markers are hints only without stronger proof.
    const families = [...new Set((found.length || declared ? found : markers).map(([, manager]) => manager))];
    if (families.length > 1 || (declared && families.length && !families.includes(declared))) {
      return { ok: false, error: 'Há conflito entre os gerenciadores ou arquivos de bloqueio. Resolva o conflito antes de preparar o projeto.', lockfiles: found.map(([name]) => name) };
    }
    const manager = declared || families[0] || 'npm';
    const lockfile = found.find(([, kind]) => kind === manager)?.[0] || null;
    return { ok: true, manager, lockfile, source: declared ? 'packageManager' : lockfile ? 'lockfile' : markers.length ? 'configuration' : 'default', binaryLock: found.some(([name]) => name === 'bun.lockb') };
  } catch (error) { return { ok: false, error: error?.message || 'Não foi possível analisar o projeto.' }; }
}

function dependencyPlan(root) {
  try {
    const detected = detectPackageManager(root);
    if (!detected.ok) return detected;
    const { manager, lockfile, source, binaryLock } = detected;
    if (binaryLock) return { ok: false, error: 'Este projeto usa bun.lockb; versões recentes do Bun podem convertê-lo. Prepare o projeto pelo terminal para manter o arquivo sob seu controle.' };
    const realRoot = fs.realpathSync(root);
    const revision = fingerprint(realRoot);
    let args;
    if (manager === 'npm') args = ['install', '--prefer-offline', '--no-save'];
    else if (manager === 'pnpm') args = ['install', '--prefer-offline', ...(lockfile ? ['--frozen-lockfile'] : [])];
    else if (manager === 'yarn') args = ['install', ...(lockfile ? ['--frozen-lockfile'] : [])];
    else args = ['install', ...(lockfile ? ['--frozen-lockfile'] : [])];
    if (fingerprint(realRoot) !== revision || JSON.stringify(detectPackageManager(realRoot)) !== JSON.stringify(detected)) throw new Error('O projeto mudou durante a análise. Tente novamente.');
    return {
      ok: true, manager, args, lockfile, revision, source,
      notice: 'Usa o cache configurado do gerenciador e pode baixar pacotes ausentes. A instalação pode executar scripts do projeto e alterar dependências instaladas.' +
        (lockfile ? '' : ' Como não há lockfile, o gerenciador pode criar um.') +
        (manager === 'npm' ? ' Se package.json e lockfile divergirem, confira a resolução das versões.' : ''),
    };
  } catch (error) { return { ok: false, error: error?.message || 'Não foi possível analisar o projeto.' }; }
}

module.exports = { dependencyPlan, detectPackageManager };
