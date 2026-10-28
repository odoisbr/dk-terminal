const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Extensions, manifest } = require('../electron/extensions.cjs');
test('extensões incluídas usam CLIs sem trocar autenticação, modelo ou permissões', () => {
  const host = new Extensions([path.resolve(__dirname, '../extensions')], process.env);
  assert.deepEqual(host.errors, []);
  assert.deepEqual(host.list().map(x => x.id).sort(), ['antigravity', 'browser', 'claude', 'codex', 'dk', 'gemini']);
  for (const item of host.items.values()) if (item.id !== 'browser') assert.deepEqual(item.args, []);
});
test('manifestos executáveis e comandos inválidos são recusados', () => {
  const base = { schema: 1, id: 'teste', name: 'Teste', version: '0.1.0', permission: 'terminal', command: 'node', args: [] };
  assert.deepEqual(manifest(base).args, []);
  for (const change of [{ main: 'extension.js' }, { permission: 'filesystem' }, { command: 'node;touch' }, { args: ['\0'] }]) {
    assert.throws(() => manifest({ ...base, ...change }), /inválido/);
  }
});
test('extensão declarativa produz programa e argumentos separados', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-ext-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'hello'));
  fs.writeFileSync(path.join(root, 'hello', 'extension.json'), JSON.stringify({ schema: 1, id: 'hello', name: 'Hello', version: '0.1.0', permission: 'terminal', command: 'node', args: ['--version'] }));
  const host = new Extensions([root], { PATH: path.dirname(process.execPath) });
  const spec = host.spec('hello');
  assert.deepEqual(spec.args, ['--version']); assert.equal(spec.kind, 'extension');
  assert.throws(() => host.spec('../segredo'), /não encontrada/);
});


test('as ferramentas opcionais usam comandos fixos e não alteram parâmetros', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dk-agents-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const name of ['agy','gemini','dk']) fs.writeFileSync(path.join(dir,name),'#!/bin/sh\n',{mode:0o755});
  const host=new Extensions([path.resolve(__dirname,'../extensions')],{PATH:dir});
  for(const [id,cmd] of [['antigravity','agy'],['gemini','gemini'],['dk','dk']]) {assert.equal(host.list().find(x=>x.id===id).available,true);const spec=host.spec(id);assert.equal(spec.file,path.join(dir,cmd));assert.deepEqual(spec.args,[]);}
});
