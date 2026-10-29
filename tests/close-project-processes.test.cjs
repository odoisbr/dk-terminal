const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Terminals}=require('../electron/terminals.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+8000;while(!check()){if(Date.now()>end)throw Error('Tempo excedido');await delay(30);}}
test('fecha processos descendentes apenas das sessões do projeto', {skip:process.platform==='win32'}, async t=>{
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dk-close-processes-'))),a=path.join(temp,'a'),b=path.join(temp,'b');fs.mkdirSync(a);fs.mkdirSync(b);
 const script=path.join(temp,'worker.cjs');fs.writeFileSync(script,"process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[2]+'.pid',String(process.pid));setInterval(()=>{},1000);");
 const manager=new Terminals(()=>{}, {...process.env,SHELL:'/bin/zsh'});const pids=[];
 t.after(()=>{manager.closeAll();for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{}fs.rmSync(temp,{recursive:true,force:true});});
 const a1=manager.create({path:a}),a2=manager.create({path:a}),b1=manager.create({path:b});
 for(const session of [a1,a2,b1]){manager.start(session.id,{cols:80,rows:24});manager.write(session.id,`${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${session.id}\r`);}
 await until(()=>[a1,a2,b1].every(session=>fs.existsSync(path.join(session.cwd,session.id+'.pid'))));
 const [pidA,pidA2,pidB]=[a1,a2,b1].map(session=>Number(fs.readFileSync(path.join(session.cwd,session.id+'.pid'),'utf8')));pids.push(pidA,pidA2,pidB);
 const result=await manager.closeProject(a);assert.equal(result.closed,2);assert.equal(result.partial,false);assert.equal(manager.sessions.has(a1.id),false);assert.equal(manager.sessions.has(a2.id),false);assert.equal(manager.sessions.has(b1.id),true);
 for(const pid of [pidA,pidA2])await until(()=>{try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}});assert.doesNotThrow(()=>process.kill(pidB,0));
});
test('fechar uma sessão encerra seus filhos sem interromper outra sessão', {skip:process.platform==='win32'}, async t=>{
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dk-close-tab-')));
 const script=path.join(temp,'worker.cjs');fs.writeFileSync(script,"process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);");
 const manager=new Terminals(()=>{}, {...process.env,SHELL:'/bin/sh'}), pids=[];
 t.after(()=>{manager.closeAll();for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{}fs.rmSync(temp,{recursive:true,force:true});});
 const a=manager.create({path:temp}),b=manager.create({path:temp});
 for(const session of [a,b]){manager.start(session.id,{cols:80,rows:24});manager.write(session.id,`${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${session.id}.pid\r`);}
 await until(()=>[a,b].every(s=>fs.existsSync(path.join(temp,s.id+'.pid'))));
 for(const session of [a,b])pids.push(Number(fs.readFileSync(path.join(temp,session.id+'.pid'),'utf8')));
 const result=await manager.close(a.id);assert.equal(result.partial,false);assert.equal(manager.sessions.has(a.id),false);assert.equal(manager.sessions.has(b.id),true);
 await until(()=>{try{process.kill(pids[0],0);return false;}catch(e){return e.code==='ESRCH';}});assert.doesNotThrow(()=>process.kill(pids[1],0));
});
test('fechar uma sessão também encerra o shell que ignora sinais de saída', {skip:process.platform==='win32'}, async t=>{
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dk-close-shell-')));
 const manager=new Terminals(()=>{}, {...process.env,SHELL:'/bin/sh'});let pid;
 t.after(()=>{manager.closeAll();if(pid)try{process.kill(pid,'SIGKILL');}catch{}fs.rmSync(temp,{recursive:true,force:true});});
 const session=manager.create({path:temp});manager.start(session.id,{cols:80,rows:24});pid=manager.sessions.get(session.id).pty.pid;
 manager.write(session.id,"trap '' HUP TERM; printf ready > shell.ready; while :; do sleep 5; done\r");
 await until(()=>fs.existsSync(path.join(temp,'shell.ready')));
 const result=await manager.close(session.id);assert.equal(result.partial,false);
 await until(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
});
