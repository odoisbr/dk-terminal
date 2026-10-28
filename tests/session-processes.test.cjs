const {test}=require('node:test'),assert=require('node:assert/strict');
const {descendants,stopTerminalTree}=require('../electron/session-processes.cjs');

test('encerra apenas descendentes identificados e não sinaliza PID reutilizado',async()=>{
 const rows=[{pid:10,ppid:1,started:'shell'},{pid:20,ppid:10,started:'child'},{pid:30,ppid:20,started:'grandchild'},{pid:40,ppid:1,started:'other'}];
 assert.deepEqual(descendants(rows,10).map(x=>x.pid).sort(),[20,30]);
 const after=[{pid:20,ppid:1,started:'child'},{pid:30,ppid:1,started:'different'},{pid:40,ppid:1,started:'other'}];let calls=0,stopped=0;const signals=[];
 const result=await stopTerminalTree(10,()=>{stopped++;},{snapshot:async()=>calls++?after:rows,signal:(pid,sig)=>signals.push([pid,sig]),wait:async()=>{}});
 assert.equal(stopped,1);assert.equal(result.partial,false);assert.deepEqual(signals,[[20,'SIGTERM'],[30,'SIGTERM'],[20,'SIGKILL']]);
});
test('informa encerramento parcial quando não é possível consultar processos',async()=>{
 let stopped=0;const result=await stopTerminalTree(10,()=>stopped++,{snapshot:async()=>null});assert.equal(stopped,1);assert.equal(result.partial,true);
});
