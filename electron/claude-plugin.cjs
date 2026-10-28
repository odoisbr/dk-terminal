const { execFile } = require('node:child_process');
const { executable, kitInfo } = require('./core.cjs');
const source = 'https://gitlab.seatecnologia.com.br/design/dk.git';
function run(file, args, env, timeout = 12000) {
  return new Promise((resolve, reject) => execFile(file, args, { env, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error((stderr || error.message).trim().slice(0, 1000)));
    resolve(stdout);
  }));
}
async function checkClaudePlugin(env, root, execute = run) {
  const file = executable('claude', env);
  if (!file) return { status: 'no-claude', kit: null };
  let items;
  try { items = JSON.parse(await execute(file, ['plugin', 'list', '--json'], env)); }
  catch { return { status: 'unavailable', kit: null }; }
  if (!Array.isArray(items)) return { status: 'unavailable', kit: null };
  const candidates = items.filter(item => item && item.id === 'dk@dk' && item.enabled === true && (item.scope === 'user' || (root && item.projectPath === root)) && typeof item.installPath === 'string');
  candidates.sort((a, b) => Number(b.scope === 'user') - Number(a.scope === 'user'));
  for (const item of candidates) {
    try { const info = kitInfo(item.installPath); return { status: 'installed', kit: { path: info.path }, version: item.version || '' }; } catch {}
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
module.exports = { checkClaudePlugin, installClaudePlugin, ClaudePluginMonitor };
