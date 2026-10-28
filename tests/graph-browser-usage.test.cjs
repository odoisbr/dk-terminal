const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectGraph, Orchestration } = require('../electron/orchestration.cjs');
const { localURL } = require('../electron/browser.cjs');
const { Usage, codexSnapshot, claudeSnapshot } = require('../electron/usage.cjs');
const graph = () => ({ id:'flow', revision:3, status:'em_execucao', contrato: { objetivo:'Teste', tarefas:[{id:'a', objetivo:'Primeira', depende_de:[]},{id:'b', depende_de:['a']}] }, tarefas: {a:{estado:'concluido'},b:{estado:'em_execucao',tentativas:1}} });
test('grafo usa dependências e estados do registro, recusando ciclos e referências ausentes', () => {
  const g = projectGraph(graph(), 'flow.json');
  assert.deepEqual(g.nodes.map(n=>[n.depth,n.state]), [[0,'concluido'],[1,'em_execucao']]);
  const cycle = graph(); cycle.contrato.tarefas[0].depende_de = ['b']; assert.throws(()=>projectGraph(cycle,'cycle'), /ciclo/);
  const missing = graph(); missing.contrato.tarefas[1].depende_de=['missing']; assert.throws(()=>projectGraph(missing,'missing'), /Dependência/);
});
test('registros de orquestração não seguem links para fora do projeto', t => {
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dk-graph-'))); t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const root=path.join(temp,'project'), external=path.join(temp,'external'); fs.mkdirSync(root); fs.mkdirSync(external);
  fs.writeFileSync(path.join(external,'flow.json'),JSON.stringify(graph())); fs.symlinkSync(external,path.join(root,'.dk'));
  const reader = new Orchestration(()=>{}); assert.deepEqual(reader.list(root).graphs,[]);
  fs.unlinkSync(path.join(root,'.dk')); fs.mkdirSync(path.join(root,'.dk')); fs.symlinkSync(external,path.join(root,'.dk','coordenacoes'));
  assert.throws(()=>reader.list(root),/fora/);
});
test('browser aceita somente navegação local sem credenciais', () => {
  for(const url of ['http://localhost:5173/','http://127.0.0.1:8000','https://[::1]:443/test']) assert.ok(localURL(url));
  for(const url of ['https://example.com','file:///etc/passwd','dk-app://app/index.html','http://localhost.evil.test','http://user:pass@localhost','javascript:alert(1)']) assert.throws(()=>localURL(url));
});
test('consumo preserva ausência e duração reais, com mapa de limites preferido', () => {
  const result = codexSnapshot({account:{type:'chatgpt',email:'example@example.test',planType:'test'}},{rateLimitsByLimitId:{codex:{primary:{usedPercent:18,windowDurationMins:300,resetsAt:1800000000},secondary:{usedPercent:15,windowDurationMins:10080,resetsAt:null}}},rateLimits:{primary:{usedPercent:99}}});
  assert.deepEqual(result.windows.map(w=>w.usedPercent),[18,15]); assert.equal(result.windows[0].resetsAt,1800000000000);
  assert.match(result.windows[0].label,/5 horas/); assert.match(result.windows[1].label,/7 dias/);
  assert.equal(codexSnapshot({},{}).windows.length,0);
  assert.equal(codexSnapshot({}, {rateLimits:{primary:{usedPercent:null}}}).windows.length,0);
  assert.equal(codexSnapshot({}, {rateLimits:{primary:{usedPercent:0}}}).windows[0].usedPercent,0);
  assert.match(codexSnapshot({}, {rateLimits:{primary:{usedPercent:20,windowDurationMins:60}}}).windows[0].label,/1 horas/);
});
test('Claude só extrai percentuais quando a CLI identifica janela e direção do consumo', () => {
  const result=claudeSnapshot('Current session\n████ 18% used\nResets 2pm\nCurrent week (all models)\n85% left\nResets Nov 2');
  assert.deepEqual(result.windows.map(w=>w.usedPercent),[18,15]); assert.equal(result.windows[0].resetLabel,'Resets 2pm');
  assert.equal(claudeSnapshot('Sign in to continue\n50%').windows.length,0);
});
test('consulta de cotas usa apenas conta e limites, sem criar turnos ou trocar configuração', async t => {
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dk-usage-'))); t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const bin=path.join(temp,'bin'); fs.mkdirSync(bin); const log=path.join(temp,'calls.jsonl');
  fs.writeFileSync(path.join(bin,'codex'), `#!${process.execPath}\nconst fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');const result=r.id===1?{}:r.id===2?{account:{type:'chatgpt'}}:{rateLimits:{primary:{usedPercent:18,windowDurationMins:300}}};if(r.id)process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});`,{mode:0o755});
  const usage=new Usage({PATH:bin});t.after(()=>usage.close()); const result=await usage.read(temp,true);
  assert.equal(result.providers[0].windows[0].usedPercent,18); assert.equal(result.providers[1].windows.length,0);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c.method),['initialize','initialized','account/read','account/rateLimits/read']);
  assert.equal(calls[2].params.refreshToken,false);
  assert.deepEqual(await usage.read(temp,true),result);
});
