const {test}=require('node:test'),assert=require('node:assert/strict');
const {descendants,stopTerminalTree}=require('../electron/session-processes.cjs');

test('encerra apenas descendentes identificados e não sinaliza PID reutilizado',async()=>{
 const rows=[{pid:10,ppid:1,started:'shell'},{pid:20,ppid:10,started:'child'},{pid:30,ppid:20,started:'grandchild'},{pid:40,ppid:1,started:'other'}];
 assert.deepEqual(descendants(rows,10).map(x=>x.pid).sort(),[20,30]);
 const after=[{pid:20,ppid:1,started:'child'},{pid:30,ppid:1,started:'different'},{pid:40,ppid:1,started:'other'}];let calls=0,stopped=0;const signals=[];
 const result=await stopTerminalTree(10,()=>{stopped++;},{snapshot:async()=>{calls++;return calls===1?rows:calls<4?after:after.filter(row=>row.pid!==20);},signal:(pid,sig)=>signals.push([pid,sig]),wait:async()=>{}});
 assert.equal(stopped,1);assert.equal(result.partial,false);assert.deepEqual(signals,[[20,'SIGTERM'],[30,'SIGTERM'],[20,'SIGKILL']]);
});
test('informa encerramento parcial quando não é possível consultar processos',async()=>{
 let stopped=0;const result=await stopTerminalTree(10,()=>stopped++,{snapshot:async()=>null});assert.equal(stopped,1);assert.equal(result.partial,true);
});
test('inclui filhos criados por um shell ainda identificado durante o encerramento',async()=>{
 const root={pid:10,ppid:1,started:'shell'},first={pid:20,ppid:10,started:'first'},later={pid:21,ppid:10,started:'later'};
 const snapshots=[[root,first],[root,later],[root,later],[]];let index=0;const sent=[];
 const result=await stopTerminalTree(10,()=>{},{snapshot:async()=>snapshots[index++],signal:(pid,value)=>sent.push([pid,value]),wait:async()=>{}});
 assert.deepEqual(sent,[[20,'SIGTERM'],[21,'SIGTERM'],[10,'SIGKILL'],[21,'SIGKILL']]);assert.equal(result.partial,false);
});
test('descendentes de cancelamento são reidentificados antes de cada sinal',async()=>{
 const {stopRecordedProcesses}=require('../electron/session-processes.cjs');const original=[{pid:20,started:'original'},{pid:30,started:'original'}];let calls=0;const sent=[];
 const result=await stopRecordedProcesses(original,{snapshot:async()=>{calls++;return calls===1?[{pid:20,started:'original'},{pid:30,started:'original'}]:calls===2?[{pid:20,started:'original'},{pid:30,started:'reutilizado'}]:[{pid:30,started:'reutilizado'}];},signal:(pid,signal)=>sent.push([pid,signal]),wait:async()=>{}});
 assert.deepEqual(sent,[[20,'SIGTERM'],[30,'SIGTERM'],[20,'SIGKILL']]);assert.equal(result.partial,false);
 assert.equal((await stopRecordedProcesses(null)).partial,true);
});
test('avisa quando o processo ainda não foi confirmado após o sinal forçado',async()=>{
 const {stopRecordedProcesses}=require('../electron/session-processes.cjs');const original=[{pid:20,started:'original'}];
 const result=await stopRecordedProcesses(original,{snapshot:async()=>original,signal:()=>{},wait:async()=>{}});
 assert.equal(result.partial,true);
});
