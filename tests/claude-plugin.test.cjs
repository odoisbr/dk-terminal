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
