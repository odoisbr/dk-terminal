const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {Integrations,run}=require('../electron/integrations.cjs');
const {executable}=require('../electron/core.cjs');

const PROJECT={id:1555,name:'Minhas Corridas',path_with_namespace:'design/sesc-df/design-minhas-corridas',default_branch:'main'};
const SSH='git@gitlab.seatecnologia.com.br:design/sesc-df/design-minhas-corridas.git';
const HTTPS='https://gitlab.seatecnologia.com.br/design/sesc-df/design-minhas-corridas.git';
function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dk-gitlab-clone-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const bin=path.join(dir,'bin');fs.mkdirSync(bin);for(const name of ['glab','git'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\n',{mode:0o755});
  const base=path.join(dir,'destino');fs.mkdirSync(base);return {dir,bin,base};
}
const failure=(stderr,extra={})=>Object.assign(new Error('Não foi possível preparar a cópia.'),{stderr,stdout:'',...extra});

// Regressão: `glab repo clone <url>` fora de um repositório consultava gitlab.com
// (401) e o app só mostrava a mensagem genérica. A cópia agora usa o Git com
// SSH, sem depender de credencial HTTPS salva nem da pasta atual do app.
test('prepara cópia por SSH sem depender de credencial HTTPS nem do glab',async t=>{
  const {bin,base}=fixture(t);const calls=[];
  const client=new Integrations({PATH:bin},async(file,args,_env,options={})=>{
    calls.push({file:path.basename(file),args,cwd:options.cwd});
    if(args[0]==='api')return JSON.stringify(PROJECT);
    if(args[0]==='config')throw failure('');
    if(args[0]==='repo')throw failure('ERROR\n  Get https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}.');
    if(args[0]==='clone'&&args[2]===HTTPS)throw failure("Cloning into 'x'...\nfatal: could not read Username for 'https://gitlab.seatecnologia.com.br': terminal prompts disabled");
    if(args[0]==='clone'&&args[2]===SSH){fs.mkdirSync(args[3]);return '';}
    throw new Error('chamada inesperada '+args.join(' '));
  });
  await client.getProject(1555);
  const target=await client.materialize(1555,base);
  assert.equal(target,path.join(base,'design-minhas-corridas'));
  const clone=calls.find(call=>call.args[0]==='clone');
  assert.equal(clone.file,'git');assert.equal(clone.cwd,base);assert.deepEqual(clone.args,['clone','--',SSH,target]);
  assert.ok(!calls.some(call=>call.args[0]==='repo'),'não usa glab repo clone');
});

test('sem chave SSH tenta HTTPS e, sem credencial, explica o que fazer',async t=>{
  const {bin,base}=fixture(t);const clones=[];
  const client=new Integrations({PATH:bin},async(_file,args)=>{
    if(args[0]==='api')return JSON.stringify(PROJECT);if(args[0]==='config')throw failure('');
    clones.push(args[2]);
    if(args[2]===SSH)throw failure('git@gitlab.seatecnologia.com.br: Permission denied (publickey).\nfatal: Could not read from remote repository.');
    throw failure("fatal: could not read Username for 'https://gitlab.seatecnologia.com.br': terminal prompts disabled");
  });
  await client.getProject(1555);
  await assert.rejects(client.materialize(1555,base),error=>{
    assert.match(error.message,/glab auth login --hostname gitlab\.seatecnologia\.com\.br/);
    assert.match(error.message,/ssh_keys/);return true;
  });
  assert.deepEqual(clones,[SSH,HTTPS]);
});

test('HTTPS com credencial salva cobre quem não tem chave SSH',async t=>{
  const {bin,base}=fixture(t);
  const client=new Integrations({PATH:bin},async(_file,args)=>{
    if(args[0]==='api')return JSON.stringify(PROJECT);if(args[0]==='config')throw failure('');
    if(args[2]===SSH)throw failure('Host key verification failed.\nfatal: Could not read from remote repository.');
    fs.mkdirSync(args[3]);return '';
  });
  await client.getProject(1555);
  assert.equal(await client.materialize(1555,base),path.join(base,'design-minhas-corridas'));
});

test('falhas sem relação com credencial não repetem a cópia e trazem orientação',async t=>{
  const cases=[
    [failure('ERROR: The project you were looking for could not be found or you don\'t have permission to view it.\nfatal: Could not read from remote repository.'),/não tem acesso/],
    [failure('fatal: write error: No space left on device'),/espaço/],
    [failure('',{killed:true,signal:'SIGTERM'}),/demorou demais/],
    [failure('fatal: algo inesperado aconteceu'),/Detalhe do Git: fatal: algo inesperado aconteceu/],
  ];
  for(const [error,pattern] of cases){
    const {bin,base}=fixture(t);let clones=0;
    const client=new Integrations({PATH:bin},async(_file,args)=>{if(args[0]==='api')return JSON.stringify(PROJECT);if(args[0]==='config')throw failure('');clones++;throw error;});
    await client.getProject(1555);await assert.rejects(client.materialize(1555,base),pattern);assert.equal(clones,1);
  }
});

test('mantém core.sshCommand configurado e nunca espera senha do SSH',async t=>{
  const {bin,base}=fixture(t);const envs=[];let configured='';
  const client=new Integrations({PATH:bin,GIT_DIR:'/tmp/nao-usar'},async(_file,args,env)=>{
    if(args[0]==='api')return JSON.stringify(PROJECT);if(args[0]==='config'){if(!configured)throw failure('');return configured+'\n';}
    envs.push(env);fs.mkdirSync(args[3]);return '';
  });
  await client.getProject(1555);await client.materialize(1555,base);
  assert.equal(envs[0].GIT_SSH_COMMAND,'ssh -o BatchMode=yes -o ConnectTimeout=20');assert.equal(envs[0].GIT_DIR,undefined);
  fs.rmSync(path.join(base,'design-minhas-corridas'),{recursive:true});configured='ssh -i ~/.ssh/id_sea';
  await client.materialize(1555,base);assert.equal(envs[1].GIT_SSH_COMMAND,undefined);
});

// Ponta a ponta com Git real, a partir de "/" como um app aberto pelo Finder.
// O endereço remoto é trocado por um repositório bare local; nada vai à rede.
test('clona de verdade um repositório bare com o app rodando a partir de /',{skip:!executable('git')},async t=>{
  const {dir,base}=fixture(t);const bare=path.join(dir,'origem.git'),seed=path.join(dir,'seed');
  const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'T',GIT_AUTHOR_EMAIL:'t@example.invalid',GIT_COMMITTER_NAME:'T',GIT_COMMITTER_EMAIL:'t@example.invalid'}});
  fs.mkdirSync(seed);git(seed,'init','-q','-b','main');fs.writeFileSync(path.join(seed,'README.md'),'oi\n');git(seed,'add','README.md');git(seed,'commit','-q','-m','inicial');
  execFileSync('git',['clone','-q','--bare',seed,bare]);
  const realGit=executable('git');const urls=[];
  const client=new Integrations({...process.env,PATH:path.dirname(realGit)},async(file,args,env,options)=>{
    if(args[0]==='api')return JSON.stringify(PROJECT);
    if(args[0]==='clone'){urls.push(args[2]);if(args[2]!==SSH)throw failure('fatal: inesperado');return run(file,['clone','--',bare,args[3]],env,options);}
    return run(file,args,env,options);
  });
  const previous=process.cwd();process.chdir('/');t.after(()=>process.chdir(previous));
  await client.getProject(1555);
  const target=await client.materialize(1555,base);
  assert.equal(fs.readFileSync(path.join(target,'README.md'),'utf8'),'oi\n');assert.deepEqual(urls,[SSH]);
});
