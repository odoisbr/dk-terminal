const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkClaudePlugin, installClaudePlugin } = require('../electron/claude-plugin.cjs');
test('reconhece somente plugin DK habilitado e com pacote utilizável', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-plugin-test-'));
  try {
    fs.writeFileSync(path.join(dir,'claude'), '#!/bin/sh\n', {mode:0o755});
    fs.mkdirSync(path.join(dir,'kit','cli'),{recursive:true}); fs.writeFileSync(path.join(dir,'kit','cli','dk'),'');
    const env={PATH:dir}; const kit=path.join(dir,'kit');
    const entries=[{id:'dk@dk-rc2',enabled:true,scope:'user',installPath:kit},{id:'dk@dk',enabled:false,scope:'user',installPath:kit}];
    const fake=async()=>JSON.stringify(entries);
    assert.equal((await checkClaudePlugin(env,null,fake)).status,'disabled');
    entries.push({id:'dk@dk',enabled:true,scope:'user',installPath:kit,version:'1.0.0'});
    assert.equal((await checkClaudePlugin(env,null,fake)).kit.path,fs.realpathSync(kit));
    entries.pop(); entries.pop();
    const calls=[]; await installClaudePlugin(env,null,async(file,args)=>{calls.push(args); if (args.includes('install')) { entries.push({id:'dk@dk',enabled:true,scope:'user',installPath:kit}); return ''; } return JSON.stringify(entries);});
    assert.deepEqual(calls[1].slice(0,3),['plugin','install','dk']);
    assert.ok(!calls[1].includes('--yes'));
    assert.equal((await checkClaudePlugin(env,null,async()=>{throw new Error('fail')})).status,'unavailable');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('consultas repetidas ao Claude compartilham resultado e instalação invalida o cache', async () => {
  const { ClaudePluginMonitor } = require('../electron/claude-plugin.cjs');
  let calls = 0, now = 0, release;
  const monitor = new ClaudePluginMonitor(() => { calls++; return new Promise(resolve => { release = resolve; }); }, () => now);
  const a = monitor.check({}, '/project'), b = monitor.check({}, '/project');
  await Promise.resolve(); assert.equal(calls, 1); release({status:'installed'}); await Promise.all([a,b]);
  await monitor.check({}, '/project'); assert.equal(calls, 1);
  now = 30001; const c = monitor.check({}, '/project'); await Promise.resolve(); assert.equal(calls, 2); release({status:'missing'}); await c;
  monitor.invalidate(); const d = monitor.check({}, '/project'); await Promise.resolve(); assert.equal(calls, 3); release({status:'installed'}); await d;
});

test('compara versões semânticas, inclusive pré-lançamentos numéricos', () => {
  const { compareVersions } = require('../electron/claude-plugin.cjs');
  assert.equal(compareVersions('1.7.0-rc.2', '1.7.0-rc.14'), -1);
  assert.equal(compareVersions('1.7.0-rc.14', '1.7.0'), -1);
  assert.equal(compareVersions('1.7.0', '1.7.0-rc.14'), 1);
  assert.equal(compareVersions('v1.7.0', '1.7.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0);
  assert.equal(compareVersions('', '1.0.0'), null);
  assert.equal(compareVersions('1.0', '1.0.0'), null);
  assert.equal(compareVersions('latest', '1.0.0'), null);
});

test('monta o comando de atualização no escopo instalado, sem aceitar comandos sozinho', () => {
  const { updateCommand } = require('../electron/claude-plugin.cjs');
  assert.deepEqual(updateCommand('user', '/proj'), { args: ['plugin', 'update', 'dk@dk', '--scope', 'user'], cwd: undefined });
  assert.deepEqual(updateCommand('project', '/proj'), { args: ['plugin', 'update', 'dk@dk', '--scope', 'project'], cwd: '/proj' });
  assert.deepEqual(updateCommand(undefined, null).args.slice(-1), ['user']);
  for (const scope of ['user', 'project']) assert.ok(!updateCommand(scope, '/proj').args.some(arg => ['-y', '--yes', '--accept-command'].includes(arg)));
});

test('detecta versão disponível pelo catálogo do marketplace e atualiza pelo Claude', async () => {
  const { checkClaudePlugin, updateClaudePlugin } = require('../electron/claude-plugin.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-plugin-update-'));
  try {
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    const kitAt = version => { const kit = path.join(dir, 'cache', version); fs.mkdirSync(path.join(kit, 'cli'), { recursive: true }); fs.writeFileSync(path.join(kit, 'cli', 'dk'), ''); return kit; };
    const market = path.join(dir, 'market'); fs.mkdirSync(path.join(market, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'dk', plugins: [{ name: 'dk', version: '1.7.0' }] }));
    const env = { PATH: dir };
    let installed = { id: 'dk@dk', enabled: true, scope: 'user', installPath: kitAt('1.6.0'), version: '1.6.0' };
    const calls = [];
    const fake = async (file, args, _env, _timeout, cwd) => {
      calls.push({ args, cwd });
      if (args[1] === 'marketplace') return JSON.stringify([{ name: 'outro', installLocation: '/nada' }, { name: 'dk', installLocation: market }]);
      if (args[1] === 'update') { installed = { ...installed, installPath: kitAt('1.7.0'), version: '1.7.0' }; return ''; }
      return JSON.stringify([installed]);
    };
    const before = await checkClaudePlugin(env, null, fake);
    assert.equal(before.status, 'installed'); assert.equal(before.version, '1.6.0'); assert.equal(before.latestVersion, '1.7.0'); assert.equal(before.updateAvailable, true);
    const after = await updateClaudePlugin(env, null, fake);
    assert.equal(after.version, '1.7.0'); assert.equal(after.updateAvailable, false);
    assert.equal(after.kit.path, fs.realpathSync(path.join(dir, 'cache', '1.7.0')));
    const update = calls.find(call => call.args[1] === 'update');
    assert.deepEqual(update.args, ['plugin', 'update', 'dk@dk', '--scope', 'user']);
    // Já atualizado: não roda o Claude de novo.
    calls.length = 0; await updateClaudePlugin(env, null, fake);
    assert.ok(!calls.some(call => call.args[1] === 'update'));
    // Catálogo ilegível não inventa atualização.
    const broken = await checkClaudePlugin(env, null, async (file, args) => args[1] === 'marketplace' ? 'não é json' : JSON.stringify([installed]));
    assert.equal(broken.status, 'installed'); assert.equal(broken.latestVersion, ''); assert.equal(broken.updateAvailable, false);
    // O Claude terminou sem trocar a versão: erro claro.
    installed = { ...installed, version: '1.6.0' };
    await assert.rejects(updateClaudePlugin(env, null, async (file, args) => args[1] === 'marketplace' ? JSON.stringify([{ name: 'dk', installLocation: market }]) : args[1] === 'update' ? '' : JSON.stringify([installed])), /não confirmou a atualização/);
    // Sem plugin instalado, atualizar orienta a instalar.
    await assert.rejects(updateClaudePlugin(env, null, async () => '[]'), /Instale ou ative/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
