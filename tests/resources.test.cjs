const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProcessTable, aggregateResources, ResourceMonitor, systemResources, parseSwapUsage, sessionResources } = require('../electron/resources.cjs');
const metrics = [
  {pid:100, cpu:{percentCPUUsage:5}, memory:{workingSetSize:120000}},
  {pid:200, cpu:{percentCPUUsage:2.5}, memory:{workingSetSize:220000}},
];
const table = parseProcessTable('100 1 5.0 120000\n200 100 2.5 220000\n300 100 1.5 30000\n400 300 3.0 40000\n999 100 99 99000\n500 1 25 50000\n');
test('contabiliza o DK e seus processos filhos sem duplicar processos Electron ou o coletor', () => {
  const sample = aggregateResources(metrics, table, 100, 999, true, 123);
  assert.deepEqual(sample.app, {cpuPercent:7.5, memoryKiB:340000, processCount:2});
  assert.deepEqual(sample.children, {cpuPercent:4.5, memoryKiB:70000, processCount:2});
  assert.deepEqual(sample.total, {cpuPercent:12, memoryKiB:410000});
  assert.equal(sample.sampledAt,123);
  assert.equal(aggregateResources(metrics, table, 100, [999, 400], true).children.processCount, 1);
});
test('primeira leitura não inventa CPU e mantém ausência de dados separada de zero', () => {
  const first = aggregateResources(metrics,table,100,999,false);
  assert.equal(first.total.cpuPercent,null); assert.equal(first.total.memoryKiB,410000);
  const noTable=aggregateResources(metrics,null,100,999,true);
  assert.equal(noTable.children,null);assert.deepEqual(noTable.total,{cpuPercent:7.5,memoryKiB:340000});
  const incomplete=aggregateResources([{pid:100,cpu:{percentCPUUsage:0},memory:{}}],table,100,999,true);
  assert.equal(incomplete.app.cpuPercent,0); assert.equal(incomplete.total.memoryKiB,null);
  assert.equal(aggregateResources(metrics,table,123456,999,true).children,null);
});
test('reutiliza uma leitura em andamento e limita consultas repetidas', async () => {
  let now=10000, reads=0, sampleCount=0;
  const monitor=new ResourceMonitor(()=>{sampleCount++;return metrics;},{rootPid:100,clock:()=>now,getTable:async()=>{reads++;await new Promise(r=>setTimeout(r,10));return {rows:table,collectorPid:999};}});
  const [a,b]=await Promise.all([monitor.read(),monitor.read()]);
  assert.strictEqual(a,b);assert.equal(reads,1);assert.equal(a.total.cpuPercent,null);
  now+=500;assert.strictEqual(await monitor.read(),a);assert.equal(reads,1);
  now+=2000;const next=await monitor.read();assert.equal(reads,2);assert.equal(sampleCount,2);assert.equal(next.total.cpuPercent,12);
});

test('consumo da máquina calcula CPU entre amostras e mantém memória e indisponibilidade distintos', () => {
  const first={total:1000,idle:400,cores:2,totalBytes:16000,freeBytes:4000};
  assert.deepEqual(systemResources(first,null),{cpuPercent:null,memoryUsedKiB:12000/1024,memoryTotalKiB:16000/1024});
  const next={...first,total:1200,idle:450};
  assert.equal(systemResources(next,first).cpuPercent,75);
  assert.equal(systemResources({...next,cores:4},first).cpuPercent,null);
  assert.equal(systemResources({...next,freeBytes:17000},first).memoryUsedKiB,null);
});

test('interpreta swap do macOS e do Linux sem inventar valores indisponíveis', () => {
  assert.deepEqual(parseSwapUsage('total = 5120.00M  used = 3780.50M  free = 1339.50M (encrypted)', 'darwin'), {totalKiB:5120*1024, usedKiB:3780.5*1024});
  assert.deepEqual(parseSwapUsage('SwapTotal:  2048 kB\nSwapFree:  1024 kB\n', 'linux'), {totalKiB:2048, usedKiB:1024});
  assert.equal(parseSwapUsage('não disponível', 'darwin'), null);
  assert.equal(parseSwapUsage('SwapTotal:  5 kB\nSwapFree:  6 kB', 'linux'), null);
});

test('mede apenas processos identificados de cada terminal e nunca atribui os coletores', () => {
  const rows=parseProcessTable('100 1 0 5000\n300 100 0 60000\n400 300 0 9000\n999 300 0 80000\n500 1 0 1000\n');
  assert.deepEqual(sessionResources(rows,[{id:'sessao',pid:300,lastActivity:123},{id:'sem-pid',pid:1234,lastActivity:3}],[999]),[{id:'sessao',kind:'terminal',root:undefined,memoryKiB:69000,lastActivity:123}]);
  assert.deepEqual(sessionResources(null,[{id:'x',pid:1,lastActivity:1}]),[]);
});
