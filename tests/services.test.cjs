const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Services, definitions } = require('../electron/services.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Tempo excedido ao aguardar serviço'); await delay(30); }
}
test('scripts disponíveis não executam código durante a descoberta', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-services-def-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10', scripts: { dev: 'touch nunca-executado', 'dev:api': 'node api.js', build: 'node build.js' } }));
  assert.deepEqual(definitions(root).map(s => [s.id, s.command]), [['script:dev', 'pnpm'], ['script:dev:api', 'pnpm']]);
  assert.equal(fs.existsSync(path.join(root, 'nunca-executado')), false);
  const manager = new Services(() => {}, process.env);
  assert.throws(() => manager.stop(root, 'estranho'), /não está rodando/);
  assert.throws(() => manager.start(root, 'script:build'), /não existe/);
});
test('serviço HTTP inicia, produz logs e encerra junto com o processo filho', { skip: process.platform === 'win32' }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-services-life-')));
  const events = [];
  const manager = new Services(event => events.push(event), process.env);
  t.after(() => { manager.closeAll(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'server.cjs'), `
    const http = require('node:http');
    const fs = require('node:fs');
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    fs.writeFileSync('child.pid', String(child.pid));
    const server = http.createServer((req, res) => res.end('DK_SERVICE_OK'));
    server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
  `);
  fs.writeFileSync(path.join(root, 'dk-terminal.services.json'), JSON.stringify({ services: [{ name: 'web', command: process.execPath, args: ['server.cjs'] }] }));
  manager.start(root, 'custom:web');
  assert.throws(() => manager.start(root, 'custom:web'), /já está ativo/);
  await until(() => manager.list(root)[0].url || manager.list(root)[0].status === 'failed');
  const service = manager.list(root)[0];
  assert.equal(service.status, 'running', service.log);
  assert.equal(await (await fetch(service.url)).text(), 'DK_SERVICE_OK');
  const childPid = Number(fs.readFileSync(path.join(root, 'child.pid'), 'utf8'));
  manager.stop(root, service.id);
  await until(() => manager.list(root)[0].status === 'stopped');
  await assert.rejects(fetch(service.url));
  await until(() => { try { process.kill(childPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
  assert.ok(events.some(event => event.service.log.includes('http://127.0.0.1:')));
});

test('serviços personalizados podem declarar explicitamente front-end ou back-end', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dk-services-roles-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'dk-terminal.services.json');
  fs.writeFileSync(file,JSON.stringify({services:[{name:'start',role:'backend',command:'node',args:[]},{name:'app',role:'frontend',command:'node',args:[]}]}));
  assert.deepEqual(definitions(root).map(item=>item.role),['backend','frontend']);
  const list=new Services(()=>{},process.env).list(root); assert.deepEqual(list.map(item=>item.role),['backend','frontend']);
  fs.writeFileSync(file,JSON.stringify({services:[{name:'app',role:'unknown',command:'node',args:[]}]}));
  assert.throws(()=>definitions(root),/Serviço inválido/);
});

test('encerra filho que ignora SIGTERM após o processo principal sair', { skip: process.platform === 'win32' }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-service-child-')));
  const manager = new Services(() => {}, process.env); let pid;
  t.after(() => { manager.closeAll(); if (pid) try { process.kill(pid, 'SIGKILL'); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'child.cjs'), `process.on('SIGTERM', () => {}); require('fs').writeFileSync('ready', String(process.pid)); setInterval(() => {}, 1000);`);
  fs.writeFileSync(path.join(root, 'parent.cjs'), `require('node:child_process').spawn(process.execPath, ['child.cjs'], {stdio:'ignore'}); setInterval(() => {}, 1000);`);
  fs.writeFileSync(path.join(root, 'dk-terminal.services.json'), JSON.stringify({services:[{name:'worker',command:process.execPath,args:['parent.cjs']}]}));
  manager.start(root, 'custom:worker'); await until(() => fs.existsSync(path.join(root, 'ready')));
  pid = Number(fs.readFileSync(path.join(root, 'ready'), 'utf8'));
  manager.stop(root, 'custom:worker');
  await until(() => manager.list(root)[0].status === 'stopped');
  await until(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
});


test('recusa definição que não é um arquivo comum', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-services-special-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'package.json'));
  assert.throws(() => definitions(root), /arquivo comum/);
});


test('recusa definição apontando para arquivo fora do projeto', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-services-link-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-services-other-'));
  t.after(() => { fs.rmSync(root, {recursive:true,force:true}); fs.rmSync(other, {recursive:true,force:true}); });
  fs.writeFileSync(path.join(other, 'package.json'), '{"scripts":{"dev":"echo test"}}');
  fs.symlinkSync(path.join(other, 'package.json'), path.join(root, 'package.json'));
  assert.throws(() => definitions(root), /fora do projeto/);
});

test('recusa FIFO sem bloquear a descoberta de serviços', { skip: process.platform === 'win32', timeout: 2000 }, t => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-services-fifo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('mkfifo', [path.join(root, 'package.json')]);
  const script = `const assert = require('node:assert/strict'); const { definitions } = require(process.argv[1]); assert.throws(() => definitions(process.argv[2]), /arquivo comum/);`;
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('../electron/services.cjs'), root], { timeout: 1500, encoding: 'utf8' });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
});
