const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Actions } = require('../electron/actions.cjs');

function fixture(t, source, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dk actions ' $-")));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const python = path.join(bin, 'python3');
  fs.writeFileSync(python, `#!${process.execPath}\nrequire(process.argv[2]);\n`, { mode: 0o700 });
  const cli = path.join(root, 'mock-dk.cjs'); fs.writeFileSync(cli, source);
  const actions = new Actions({ env: { ...process.env, PATH: bin, DK_TERMINAL_INTERNAL: 'omitir', ELECTRON_RUN_AS_NODE: '1' }, ...options });
  t.after(() => { actions.closeAll(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, actions, project: { path: root, isDk: true }, kit: { cli }, python };
}

test('executa fora do shell do usuário, captura JSON real e preserva os argumentos', async t => {
  const { root, actions, project, kit } = fixture(t, `process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(3),env:{internal:process.env.DK_TERMINAL_INTERNAL,electron:process.env.ELECTRON_RUN_AS_NODE,python:process.env.PYTHONDONTWRITEBYTECODE}}));`);
  const result = await actions.run('audit', project, kit);
  assert.equal(result.code, 0); assert.equal(result.status, 'completed'); assert.equal(result.jsonParsed, true);
  assert.equal(result.root, root); assert.equal(result.data.cwd, root);
  assert.deepEqual(result.data.args, ['audit', '--projeto', root, '--json']);
  assert.deepEqual(result.data.env, { python: '1' });
  assert.deepEqual(JSON.parse(result.output), result.data);
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
});

test('falha mantém código de saída, diagnóstico e JSON retornado sem assumir sucesso', async t => {
  const { actions, project, kit } = fixture(t, `process.stdout.write(JSON.stringify({ok:false,erros:[{codigo:'E01',mensagem:'arquivo ausente'}]}));process.stderr.write('Não foi possível validar.\\n');process.exitCode=7;`);
  const result = await actions.run('validate', project, kit);
  assert.equal(result.code, 7); assert.equal(result.status, 'failed'); assert.equal(result.data.ok, false);
  assert.match(result.stderr, /Não foi possível validar/); assert.equal(result.cancelled, false);
});

test('saída textual e JSON inválido continuam disponíveis como texto', async t => {
  const { actions, project, kit } = fixture(t, `process.stdout.write('Diagnóstico local\\n{JSON incompleto');`);
  const result = await actions.run('doctor', project, kit);
  assert.equal(result.code, 0); assert.equal(result.data, null); assert.equal(result.jsonParsed, false);
  assert.equal(result.output, 'Diagnóstico local\n{JSON incompleto');
});

test('limita stdout e stderr combinados a 2 MiB e interrompe a ação excedente', async t => {
  const { actions, project, kit } = fixture(t, `process.stdout.write(Buffer.alloc(2*1024*1024+100,65));setInterval(()=>{},1000);`);
  const result = await actions.run('doctor', project, kit);
  assert.equal(result.truncated, true); assert.equal(result.status, 'truncated'); assert.equal(result.data, null);
  assert.equal(Buffer.byteLength(result.output) + Buffer.byteLength(result.stderr), 2 * 1024 * 1024);
  assert.equal(actions.running.size, 0);
});

test('mantém o limite de saída e informa limpeza parcial quando a lista de processos está indisponível', async t => {
  const { actions, project, kit } = fixture(t, `process.stdout.write(Buffer.alloc(2*1024*1024+100,65));setInterval(()=>{},1000);`, { snapshot: async () => null });
  const result = await actions.run('doctor', project, kit);
  assert.equal(result.truncated, true); assert.equal(result.cleanupPartial, true);
  assert.equal(Buffer.byteLength(result.output) + Buffer.byteLength(result.stderr), 2 * 1024 * 1024);
});

test('prazo encerra o processo sem anunciar conclusão', async t => {
  const { actions, project, kit } = fixture(t, `process.stdout.write('iniciado\\n');setInterval(()=>{},1000);`, { timeoutMs: 150 });
  const result = await actions.run('doctor', project, kit);
  assert.equal(result.timedOut, true); assert.equal(result.status, 'timed_out');
  assert.equal(result.cancelled, false); assert.notEqual(result.code, 0); assert.equal(actions.running.size, 0);
});

test('cancel e closeAll encerram somente os processos próprios da execução', async t => {
  const { actions, project, kit } = fixture(t, `process.stdout.write('rodando\\n');setInterval(()=>{},1000);`);
  const first = actions.run('doctor', project, kit), second = actions.run('audit', project, kit);
  await delay(50);
  assert.equal(actions.cancel(project.path, 'doctor'), 1);
  const firstResult = await first; assert.equal(firstResult.cancelled, true); assert.equal(firstResult.status, 'cancelled');
  assert.equal(actions.running.size, 1);
  actions.closeAll();
  const secondResult = await second; assert.equal(secondResult.cancelled, true); assert.equal(secondResult.status, 'cancelled');
  assert.equal(actions.running.size, 0); assert.equal(actions.cancel(project.path), 0);
});

test('erro ao iniciar retorna código nulo e a causa real', async t => {
  const { actions, project, kit, python } = fixture(t, '');
  fs.writeFileSync(python, '#!/caminho/que-nao-existe/node\n');
  const result = await actions.run('doctor', project, kit);
  assert.equal(result.code, null); assert.equal(result.status, 'failed'); assert.equal(result.data, null);
  assert.match(result.stderr, /ENOENT/); assert.equal(actions.running.size, 0);
});

test('cancelamento encerra descendente que mantém execução após o processo principal sair', {skip:process.platform==='win32'}, async t=>{
  const source=`const {spawn}=require('node:child_process');spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('fs').writeFileSync('action-child.pid',String(process.pid));setInterval(()=>{},1000)"],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const {root,actions,project,kit}=fixture(t,source);let childPid;
  t.after(()=>{if(childPid)try{process.kill(childPid,'SIGKILL');}catch{}});
  const task=actions.run('doctor',project,kit);for(let i=0;i<100&&!fs.existsSync(path.join(root,'action-child.pid'));i++)await delay(30);
  assert.ok(fs.existsSync(path.join(root,'action-child.pid')));childPid=+fs.readFileSync(path.join(root,'action-child.pid'),'utf8');
  assert.equal(actions.cancel(root,'doctor'),1);assert.equal((await task).status,'cancelled');await actions.closeAllAndWait();
  let running=true;for(let i=0;i<40 && running;i++){try{process.kill(childPid,0);}catch(e){if(e.code==='ESRCH')running=false;else throw e;}if(running)await delay(50);}assert.equal(running,false);
});
