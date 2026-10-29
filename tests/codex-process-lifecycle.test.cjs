const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {execFile}=require('node:child_process');
test('interromper agente simulado encerra apenas seus descendentes identificados',{skip:process.platform==='win32'},async()=>{
  const output=await new Promise((resolve,reject)=>execFile(process.execPath,[path.join(__dirname,'codex-process-benchmark.cjs')],{timeout:15000,env:{...process.env,DK_CODEX_MODULE:'',DK_BENCH_OUTPUT:''}},(error,stdout)=>error?reject(error):resolve(stdout)));
  const result=JSON.parse(output);assert.equal(result.running.childAlive,true);assert.equal(result.after.serverAlive,false);assert.equal(result.after.childAlive,false);assert.equal(result.after.sessionRunning,false);
});
