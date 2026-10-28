const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clearMachineFileCache, runPurge } = require('../electron/machine-cache.cjs');

test('não executa limpeza sem confirmação ou em outra plataforma', async () => {
  let calls=0;const run=async()=>{calls++;};
  assert.deepEqual(await clearMachineFileCache({platform:'darwin',confirm:async()=>false,run}),{status:'cancelled'});assert.equal(calls,0);
  await assert.rejects(clearMachineFileCache({platform:'linux',confirm:async()=>true,run}),/macOS/);assert.equal(calls,0);
});
test('executa somente após confirmação e informa sucesso sem prometer memória liberada', async () => {
  let calls=0;assert.deepEqual(await clearMachineFileCache({platform:'darwin',confirm:async()=>true,run:async()=>{calls++;}}),{status:'completed'});assert.equal(calls,1);
  await assert.rejects(clearMachineFileCache({platform:'darwin',confirm:async()=>true,run:async()=>{throw Error('falhou');}}),/falhou/);
});
test('solicita autorização do macOS com comando fixo e sem shell', async () => {
  let request;
  await runPurge((file,args,opts,callback)=>{request={file,args,opts};callback(null);});
  assert.equal(request.file,'/usr/bin/osascript');assert.deepEqual(request.args,['-e','do shell script "/usr/sbin/purge" with administrator privileges']);assert.equal(request.opts.shell,undefined);
  await assert.rejects(runPurge((_file,_args,_opts,callback)=>callback(Error('detalhe sensível'))),/cancelada ou não pôde/);
});
