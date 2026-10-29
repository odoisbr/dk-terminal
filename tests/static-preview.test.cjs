const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Services, definitions } = require('../electron/services.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const deadline = Date.now() + 5000; while (!fn()) { if (Date.now() > deadline) throw new Error('Tempo excedido.'); await pause(20); } }
function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, ...options }, res => { const chunks=[]; res.on('data', data => chunks.push(data)); res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks).toString() })); });
    req.on('error', reject); req.end();
  });
}

test('prévia estática serve somente arquivos permitidos no projeto e é encerrada explicitamente', async t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sea-static-'))), other=fs.mkdtempSync(path.join(os.tmpdir(),'sea-private-'));
  const manager = new Services(() => {}, process.env);
  t.after(() => { manager.closeAll(); fs.rmSync(root,{recursive:true,force:true}); fs.rmSync(other,{recursive:true,force:true}); });
  fs.writeFileSync(path.join(root,'index.html'), '<h1>Olá SEA</h1>');
  fs.writeFileSync(path.join(root,'.env'), 'SEGREDO');
  fs.writeFileSync(path.join(other,'private.txt'), 'FORA');
  fs.symlinkSync(path.join(other,'private.txt'), path.join(root,'escape.txt'));
  fs.symlinkSync(path.join(root,'.env'), path.join(root,'alias.txt'));
  fs.mkdirSync(path.join(root,'pasta'));
  fs.writeFileSync(path.join(root,'pasta','index.html'), 'Página interna');
  assert.deepEqual(definitions(root).map(item => item.id), ['static:preview']);
  assert.equal(manager.start(root,'static:preview').status,'starting');
  await until(() => manager.list(root)[0].status === 'running');
  const service = manager.list(root)[0], port = Number(new URL(service.url).port);
  assert.equal((await request(port,'/')).body,'<h1>Olá SEA</h1>');
  assert.equal((await request(port,'/pasta/')).body,'Página interna');
  assert.match((await request(port,'/')).headers['content-type'], /^text\/html/);
  assert.equal((await request(port,'/',{method:'HEAD'})).body,'');
  assert.equal((await request(port,'/',{method:'POST'})).status,405);
  assert.equal((await request(port,'/',{headers:{host:'evil.example'}})).status,403);
  for (const value of ['/.env','/%2eenv','/alias.txt','/escape.txt','/%2e%2e/private.txt']) assert.notEqual((await request(port,value)).status,200,value);
  assert.equal((await request(port,'/missing')).status,404);
  assert.equal((await request(port,'/pasta')).status,200);
  manager.stop(root,'static:preview'); await until(() => manager.list(root)[0].status === 'stopped');
  await assert.rejects(request(port,'/'));
});

test('oferece prévia estática separada dos scripts do framework', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sea-static-framework-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'index.html'),'<!doctype html>');
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{dev:'vite'}}));
  assert.deepEqual(definitions(root).map(item => item.id),['script:dev','static:preview']);
});

test('cancelamento durante a inicialização libera a porta e permite reabrir', async t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'sea-static-cancel-'))), manager=new Services(()=>{},process.env);
  t.after(()=>{ manager.closeAll(); fs.rmSync(root,{recursive:true,force:true}); });
  fs.writeFileSync(path.join(root,'index.html'),'prévia');
  manager.start(root,'static:preview');
  manager.stop(root,'static:preview');
  manager.closeAll();
  await until(()=>manager.list(root)[0].status === 'stopped');
  manager.start(root,'static:preview');
  await until(()=>manager.list(root)[0].status === 'running');
  const url=manager.list(root)[0].url;
  assert.equal(await (await fetch(url)).text(),'prévia');
  manager.closeAll();
});
