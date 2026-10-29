const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { executable, kitInfo } = require('./core.cjs');
const source = 'https://gitlab.seatecnologia.com.br/design/dk.git';
const marketplace = 'dk', pluginId = 'dk@dk';
function run(file, args, env, timeout = 12000, cwd) {
  return new Promise((resolve, reject) => execFile(file, args, { env, timeout, maxBuffer: 1024 * 1024, ...(cwd ? { cwd } : {}) }, (error, stdout, stderr) => {
    if (error) return reject(new Error((stderr || error.message).trim().slice(0, 1000)));
    resolve(stdout);
  }));
}
// Versões semânticas (1.7.0, 1.7.0-rc.14, v1.7.0): retorna -1, 0, 1 ou null quando alguma não é semver.
function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || '').trim());
  return match ? { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split('.') : [] } : null;
}
function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; }
    else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
// Versão disponível = a que o catálogo local do marketplace "dk" anuncia; é o mesmo catálogo que
// `claude plugin update` usa. Lê só o marketplace.json do clone que o Claude Code já mantém.
async function availableVersion(file, env, execute = run, read = target => fs.readFileSync(target, 'utf8')) {
  try {
    const list = JSON.parse(await execute(file, ['plugin', 'marketplace', 'list', '--json'], env));
    const entry = Array.isArray(list) ? list.find(item => item && item.name === marketplace && typeof item.installLocation === 'string') : null;
    if (!entry) return '';
    const catalog = JSON.parse(read(path.join(entry.installLocation, '.claude-plugin', 'marketplace.json')));
    const plugin = Array.isArray(catalog?.plugins) ? catalog.plugins.find(item => item && item.name === 'dk') : null;
    return plugin && typeof plugin.version === 'string' && parseVersion(plugin.version) ? plugin.version : '';
  } catch { return ''; }
}
// Mesmo processo filho da instalação; sem `--yes`: um comando declarado pelo marketplace exige confirmação humana.
function updateCommand(scope, root) {
  const target = scope === 'project' ? 'project' : 'user';
  return { args: ['plugin', 'update', pluginId, '--scope', target], cwd: target === 'project' && root ? root : undefined };
}
async function checkClaudePlugin(env, root, execute = run, read) {
  const file = executable('claude', env);
  if (!file) return { status: 'no-claude', kit: null };
  let items;
  try { items = JSON.parse(await execute(file, ['plugin', 'list', '--json'], env)); }
  catch { return { status: 'unavailable', kit: null }; }
  if (!Array.isArray(items)) return { status: 'unavailable', kit: null };
  const candidates = items.filter(item => item && item.id === 'dk@dk' && item.enabled === true && (item.scope === 'user' || (root && item.projectPath === root)) && typeof item.installPath === 'string');
  candidates.sort((a, b) => Number(b.scope === 'user') - Number(a.scope === 'user'));
  for (const item of candidates) {
    let info;
    try { info = kitInfo(item.installPath); } catch { continue; }
    const version = typeof item.version === 'string' ? item.version : '';
    const latestVersion = await availableVersion(file, env, execute, read);
    return { status: 'installed', kit: { path: info.path }, version, latestVersion, updateAvailable: compareVersions(version, latestVersion) === -1, scope: item.scope };
  }
  const disabled = items.some(item => item && item.id === 'dk@dk' && item.enabled === false && item.scope === 'user');
  return { status: disabled ? 'disabled' : 'missing', kit: null };
}
async function installClaudePlugin(env, root, execute = run) {
  const file = executable('claude', env);
  if (!file) throw new Error('Instale o Claude Code para adicionar o plugin DK.');
  const before = await checkClaudePlugin(env, root, execute);
  if (before.status === 'unavailable') throw new Error('Não foi possível verificar os plugins do Claude.');
  if (before.status === 'installed') return before;
  const args = before.status === 'disabled' ? ['plugin', 'enable', 'dk@dk', '--scope', 'user'] : ['plugin', 'install', 'dk', '--marketplace', source, '--scope', 'user'];
  await execute(file, args, env, 120000);
  const result = await checkClaudePlugin(env, root, execute);
  if (result.status !== 'installed') throw new Error('O Claude não confirmou o plugin DK ativo. Confira a instalação no Claude Code.');
  return result;
}
async function updateClaudePlugin(env, root, execute = run, read) {
  const file = executable('claude', env);
  if (!file) throw new Error('Instale o Claude Code para atualizar o plugin DK.');
  const before = await checkClaudePlugin(env, root, execute, read);
  if (before.status === 'unavailable') throw new Error('Não foi possível verificar os plugins do Claude.');
  if (before.status !== 'installed') throw new Error('O plugin DK não está ativo no Claude. Instale ou ative antes de atualizar.');
  if (!before.updateAvailable) return before;
  const command = updateCommand(before.scope, root);
  await execute(file, command.args, env, 120000, command.cwd);
  const result = await checkClaudePlugin(env, root, execute, read);
  if (result.status !== 'installed' || compareVersions(result.version, before.latestVersion) === -1) throw new Error('O Claude não confirmou a atualização do plugin DK. Confira no Claude Code.');
  return result;
}
class ClaudePluginMonitor {
  constructor(check = checkClaudePlugin, now = Date.now) { this.checkPlugin = check; this.now = now; this.cache = new Map(); this.generation = 0; }
  check(env, root) {
    const key = root || '', current = this.cache.get(key), now = this.now();
    if (current && (current.pending || now < current.expires)) return current.promise;
    const generation = this.generation;
    const entry = { pending: true, expires: 0, promise: null };
    entry.promise = Promise.resolve().then(() => this.checkPlugin(env, root)).then(result => {
      entry.pending = false; entry.expires = this.now() + (result.status === 'unavailable' ? 5000 : 30000);
      if (generation !== this.generation && this.cache.get(key) === entry) this.cache.delete(key);
      return result;
    }, error => { if (this.cache.get(key) === entry) this.cache.delete(key); throw error; });
    if (!this.cache.has(key) && this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, entry); return entry.promise;
  }
  invalidate() { this.generation++; this.cache.clear(); }
}
module.exports = { checkClaudePlugin, installClaudePlugin, updateClaudePlugin, updateCommand, compareVersions, availableVersion, ClaudePluginMonitor };
