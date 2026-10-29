const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Integrations,HOST}=require('../electron/integrations.cjs');
test('acesso remoto é limitado a projetos selecionados e usa glab sem credenciais nos argumentos',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dk-integrations-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); fs.writeFileSync(path.join(dir,'glab'),'#!/bin/sh\n',{mode:0o755});
 const calls=[], execute=async(file,args)=>{calls.push(args);const e=args[1];if(e.startsWith('groups/design/projects?'))return JSON.stringify([{id:42,name:'Projeto',path_with_namespace:'design/cliente/projeto',default_branch:'main'}]);if(e==='projects/42')return JSON.stringify({id:42,name:'Projeto',path_with_namespace:'design/cliente/projeto',default_branch:'main'});if(e.includes('/repository/tree'))return JSON.stringify([{name:'arquivo.md',path:'arquivo.md',type:'blob'}]);if(e.includes('/repository/files'))return Buffer.from('conteúdo');throw Error('unexpected');};
 const client=new Integrations({PATH:dir},execute);await assert.rejects(client.tree(999),/Selecione/);const result=await client.listProjects('Projeto');assert.equal(result.items[0].id,42);assert.equal((await client.tree(42)).entries[0].name,'arquivo.md');assert.equal((await client.file(42,'arquivo.md')).content,'conteúdo');await assert.rejects(client.file(42,'../segredo'),/inválido/);assert.ok(calls.every(args=>args.includes(HOST)));assert.ok(calls.every(args=>!args.some(a=>a.includes('token'))));
});
test('somente escolha explícita prepara cópia e pasta existente nunca é sobrescrita',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dk-gitlab-copy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));for(const name of ['glab','git'])fs.writeFileSync(path.join(dir,name),'#!/bin/sh\n',{mode:0o755});
 const calls=[], execute=async(_file,args)=>{calls.push(args);if(args[0]==='api')return JSON.stringify({id:3,name:'Alpha',path_with_namespace:'design/area/alpha',default_branch:'main'});return '';};
 const client=new Integrations({PATH:dir},execute);await client.getProject(3);assert.equal(calls.length,1);
 const target=await client.materialize(3,dir);assert.equal(target,path.join(dir,'alpha'));const clone=calls.find(args=>args[0]==='clone');assert.deepEqual(clone,['clone','--','git@gitlab.seatecnologia.com.br:design/area/alpha.git',target]);assert.ok(!calls.some(args=>args.join(' ').includes('token')));
 const before=calls.length;fs.mkdirSync(target);await assert.rejects(client.materialize(3,dir),/Já existe/);assert.equal(calls.length,before+1);
});
test('login e diagnóstico usam comandos fixos, sem aceitar provedores arbitrários',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dk-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));for(const name of ['sea','glab','node'])fs.writeFileSync(path.join(dir,name),'#!/bin/sh\n',{mode:0o755});
 let checks=0;const client=new Integrations({PATH:dir},async(_file,args)=>{checks++;if(args[0]==='auth')return JSON.stringify({data:{name:'Pessoa',email:'privado@example.invalid',token:'não retornar'}});return '1.0.0\n';});
 assert.deepEqual(client.authSpec('sea').args,['auth','login']);assert.deepEqual(client.authSpec('gitlab').args,['auth','login','--hostname',HOST]);assert.throws(()=>client.authSpec('shell'),/desconhecida/);
 const account=await client.account('sea');assert.deepEqual(account,{status:'connected',name:'Pessoa'});
 const tools=await client.tools();const n=checks;await client.tools();assert.equal(checks,n);assert.equal(tools.find(item=>item.id==='codex').required,false);assert.equal(tools.find(item=>item.id==='codex').available,false);
});

test('visualiza imagens remotas reconhecidas sem executar conteúdo',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dk-remote-image-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'glab'),'#!/bin/sh\n',{mode:0o755});
 const client=new Integrations({PATH:dir},async(_file,args)=>args[1].startsWith('groups/design/projects?')?JSON.stringify([{id:1,name:'P',path_with_namespace:'design/p',default_branch:'main'}]):args[1]==='projects/1'?JSON.stringify({id:1,name:'P',path_with_namespace:'design/p',default_branch:'main'}):Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
 await client.listProjects();const image=await client.file(1,'imagem.png');assert.equal(image.kind,'image');assert.match(image.dataUrl,/^data:image\/png;base64,/);
});


test('busca inclui somente design e subgrupos, excluindo compartilhados e prefixos semelhantes',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dk-group-scope-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'glab'),'#!/bin/sh\n',{mode:0o755});
 const paths=['design/root','design/cliente/projeto','design/sub/outro/projeto','engineering/projeto','designer/projeto','design-other/projeto','outro/design/projeto','Design/projeto','design/../projeto','design//projeto','design/%2e%2e/projeto'];
 const calls=[];const client=new Integrations({PATH:dir},async(_file,args)=>{calls.push(args);return JSON.stringify(paths.map((p,i)=>({id:i+1,name:'Projeto',path_with_namespace:p,default_branch:'main'})));});
 const result=await client.listProjects('nome & teste',2);
 assert.deepEqual(result.items.map(p=>p.path),paths.slice(0,3));
 const endpoint=calls[0][1];assert.ok(endpoint.startsWith('groups/design/projects?'));
 const query=new URLSearchParams(endpoint.split('?')[1]);assert.equal(query.get('include_subgroups'),'true');assert.equal(query.get('with_shared'),'false');assert.equal(query.get('search'),'nome & teste');assert.equal(query.get('page'),'2');
 for(let id=4;id<=paths.length;id++)assert.throws(()=>client.project(id),/design/);
});

test('seleção direta e recentes recusam namespaces externos e respostas inválidas',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dk-direct-scope-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'glab'),'#!/bin/sh\n',{mode:0o755});
 let response={id:7,name:'Projeto',path_with_namespace:'design/projeto',default_branch:'main'};
 const client=new Integrations({PATH:dir},async()=>JSON.stringify(response));
 assert.equal((await client.getProject(7)).path,'design/projeto');
 for(const value of ['engineering/projeto','design-other/projeto','pessoa/design/projeto','design/../projeto','design/'+ 'x'.repeat(501)]){
   response={id:7,name:'Projeto',path_with_namespace:value,default_branch:'main'};
   await assert.rejects(client.getProject(7),/grupo design/);assert.throws(()=>client.project(7),/Selecione/);
 }
 response={id:8,name:'Outro',path_with_namespace:'design/projeto',default_branch:'main'};await assert.rejects(client.getProject(7),/grupo design/);
});

test('transferência após seleção invalida árvore, arquivo e cópia antes de acessar conteúdo',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dk-transfer-scope-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'glab'),'#!/bin/sh\n',{mode:0o755});
 for(const operation of ['tree','file','materialize']){
   let namespace='design/projeto';const calls=[];
   const client=new Integrations({PATH:dir},async(_file,args)=>{calls.push(args);assert.deepEqual(args.slice(0,2),['api','projects/9']);return JSON.stringify({id:9,name:'Projeto',path_with_namespace:namespace,default_branch:'main'});});
   await client.getProject(9);namespace='outro/projeto';
   await assert.rejects(operation==='tree'?client.tree(9):operation==='file'?client.file(9,'README.md'):client.materialize(9,dir),/grupo design/);
   assert.equal(calls.length,2);assert.throws(()=>client.project(9),/Selecione/);
 }
});

test('falha de revalidação remove cache e não inicia clone',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dk-scope-offline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'glab'),'#!/bin/sh\n',{mode:0o755});
 let offline=false;const calls=[];const client=new Integrations({PATH:dir},async(_file,args)=>{calls.push(args);if(offline)throw new Error('GitLab indisponível');return JSON.stringify({id:10,name:'P',path_with_namespace:'design/p',default_branch:'main'});});
 await client.getProject(10);offline=true;await assert.rejects(client.materialize(10,dir),/indisponível/);assert.equal(calls.length,2);assert.throws(()=>client.project(10),/Selecione/);
 client.projects.set(10,{id:10,name:'P',path:'outro/p',branch:'main'});await assert.rejects(client.tree(10),/design/);assert.equal(calls.length,2);
});
