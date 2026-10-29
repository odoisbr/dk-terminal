const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {GitlabPublisher,slugify,validSlug,remoteHost}=require('../electron/gitlab-publish.cjs');
const {run}=require('../electron/integrations.cjs');
const {executable}=require('../electron/core.cjs');
const HOST='gitlab.seatecnologia.com.br';
const hasGit=!!executable('git');

const GROUPS=[
  {id:1712,full_path:'design',full_name:'design',project_creation_level:'developer',visibility:'internal'},
  {id:1772,full_path:'design/sesc-df',full_name:'design / Sesc DF',project_creation_level:'developer',visibility:'internal'},
  {id:1800,full_path:'design/restrito',full_name:'design / Restrito',project_creation_level:'maintainer',visibility:'private'},
  {id:900,full_path:'sea/infra',full_name:'sea / infra',project_creation_level:'developer',visibility:'private'},
  {id:901,full_path:'designer',full_name:'designer',project_creation_level:'developer',visibility:'private'},
];
const httpError=(status,body)=>Object.assign(new Error('Não foi possível consultar a ferramenta.'),{stdout:JSON.stringify(body),stderr:`glab: ${status} (HTTP ${status.split(' ')[0]})`});

function setup(t,{levels={30:[1712,1772,1800,900,901],40:[],50:[]},existing=[],post,push,glab=true}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dk-publish-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const bin=path.join(dir,'bin');fs.mkdirSync(bin);if(glab)fs.writeFileSync(path.join(bin,'glab'),'#!/bin/sh\nexit 1\n',{mode:0o755});
  const gitconfig=path.join(dir,'gitconfig');fs.writeFileSync(gitconfig,'[user]\n\tname = Pessoa Teste\n\temail = pessoa@example.invalid\n[init]\n\tdefaultBranch = master\n');
  const realGit=executable('git');if(realGit)fs.symlinkSync(realGit,path.join(bin,'git'));
  const env={...process.env,PATH:bin,GIT_CONFIG_GLOBAL:gitconfig,GIT_CONFIG_NOSYSTEM:'1',HOME:dir};
  const bare=path.join(dir,'remoto.git');if(hasGit)execFileSync('git',['init','-q','--bare',bare]);
  const calls=[];
  const execute=async(file,args,runEnv,options={})=>{
    const name=path.basename(file);calls.push({name,args:[...args],cwd:options.cwd,env:runEnv});
    if(name==='glab'){
      assert.equal(args.at(-2),'--hostname');assert.equal(args.at(-1),HOST);
      const endpoint=args[1];
      if(endpoint.startsWith('groups?')){const q=new URLSearchParams(endpoint.slice(7));const ids=levels[q.get('min_access_level')]||[];return JSON.stringify(q.get('page')==='1'?GROUPS.filter(g=>ids.includes(g.id)):[]);}
      if(endpoint.startsWith('projects/')){const full=decodeURIComponent(endpoint.slice(9));if(existing.includes(full))return JSON.stringify({id:5,path_with_namespace:full});throw httpError('404 Not Found',{message:'404 Project Not Found'});}
      if(endpoint==='projects'&&args.includes('POST')){
        const fields=Object.fromEntries(args.flatMap((a,i)=>args[i-1]==='-f'?[a.split(/=(.*)/s).slice(0,2)]:[]));
        if(post)return post(fields);
        const ns=GROUPS.find(g=>String(g.id)===fields.namespace_id),full=`${ns.full_path}/${fields.path}`;
        return JSON.stringify({id:77,path_with_namespace:full,web_url:`https://${HOST}/${full}`,ssh_url_to_repo:`git@${HOST}:${full}.git`});
      }
      throw new Error('glab inesperado '+args.join(' '));
    }
    // Git real, exceto o envio: vai para um repositório bare local, nunca para a rede.
    const i=args.indexOf('push');
    if(i>=0){if(push)return push(args);const copy=[...args];copy[copy.indexOf('origin')]=bare;return run(file,copy,runEnv,options);}
    return run(file,args,runEnv,options);
  };
  const busy=new Set();
  const publisher=new GitlabPublisher(()=>env,execute,busy);
  const folder=path.join(dir,'Meu Projeto');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'index.html'),'<h1>oi</h1>\n');
  return {dir,folder,bare,calls,publisher,env,busy,git:(...args)=>execFileSync('git',['-C',folder,...args],{env,encoding:'utf8'}).trim()};
}
const input=(extra={})=>({name:'Meu Projeto',path:'meu-projeto',namespaceId:1712,visibility:'private',description:'Protótipo do portal',...extra});
const posts=calls=>calls.filter(c=>c.name==='glab'&&c.args.includes('POST'));

test('caminho sugerido, validação e host de remoto',()=>{
  assert.equal(slugify('App Sesc — Versão 2'),'app-sesc-versao-2');assert.equal(slugify('  '),'projeto');assert.equal(slugify('a..b__c'),'a-b-c');
  for(const ok of ['meu-projeto','a','p1.v2','x_y'])assert.ok(validSlug(ok),ok);
  for(const bad of ['-a','a-','A','a b','a..b','x.git','','a/b','../x'])assert.ok(!validSlug(bad),bad);
  assert.equal(remoteHost('git@github.com:o/r.git'),'github.com');assert.equal(remoteHost(`https://u@${HOST}/design/x.git`),HOST);assert.equal(remoteHost(`ssh://git@${HOST}:2222/x.git`),HOST);assert.equal(remoteHost('/tmp/r.git'),null);
});

test('lista só grupos do Design onde a conta pode criar projetos',async t=>{
  const {publisher,calls}=setup(t);
  const groups=await publisher.namespaces();
  assert.deepEqual(groups.map(g=>g.fullPath),['design','design/sesc-df']);
  assert.ok(calls.every(c=>c.name==='glab'&&!c.args.join(' ').includes('token')));
  assert.ok(calls.every(c=>c.cwd==='/'),'glab roda a partir da raiz e não deduz host pela pasta');
});

test('pasta sem Git: plano mostra as etapas e nada é criado antes da confirmação',{skip:!hasGit},async t=>{
  const {folder,calls,publisher}=setup(t);
  const options=await publisher.options(folder);
  assert.equal(options.path,'meu-projeto');assert.equal(options.defaultNamespace,1712);assert.equal(options.local.repository,false);assert.deepEqual(options.visibilities,['private','internal']);
  const plan=await publisher.plan(folder,input({commit:true}));
  assert.equal(plan.fullPath,'design/meu-projeto');assert.equal(plan.webUrl,`https://${HOST}/design/meu-projeto`);
  assert.deepEqual(plan.steps,['Iniciar o Git nesta pasta (branch main).','Criar a primeira versão (“Primeira versão”) com os arquivos da pasta.','Criar o projeto privado “Meu Projeto” em design/meu-projeto.',`Ligar esta pasta ao novo projeto como “origin” (git@${HOST}:design/meu-projeto.git).`,'Enviar a branch main para o GitLab SEA.']);
  assert.equal(posts(calls).length,0);assert.ok(!fs.existsSync(path.join(folder,'.git')),'o plano não altera a pasta');
  await assert.rejects(publisher.publish(folder,'id-inventado'),/expirou/);assert.equal(posts(calls).length,0);
});

test('executa: init, primeira versão, cria pelo glab com argumentos separados, liga origin e envia',{skip:!hasGit},async t=>{
  const {folder,bare,calls,publisher,git}=setup(t);
  const plan=await publisher.plan(folder,input({commit:true}));
  const result=await publisher.publish(folder,plan.id);
  assert.deepEqual(result,{webUrl:`https://${HOST}/design/meu-projeto`,fullPath:'design/meu-projeto',branch:'main',pushed:true,renamed:null,notes:[],error:null});
  const [create]=posts(calls);
  assert.deepEqual(create.args,['api','projects','-X','POST','-f','name=Meu Projeto','-f','path=meu-projeto','-f','namespace_id=1712','-f','visibility=private','-f','description=Protótipo do portal','--hostname',HOST]);
  assert.equal(git('remote','get-url','origin'),`git@${HOST}:design/meu-projeto.git`);
  assert.equal(git('log','-1','--format=%s'),'Primeira versão');
  assert.equal(execFileSync('git',['--git-dir',bare,'log','-1','--format=%s','main'],{encoding:'utf8'}).trim(),'Primeira versão');
  const order=calls.filter(c=>c.name==='glab'?c.args.includes('POST'):['init','commit','remote','push'].includes(c.args[2])).map(c=>c.name==='glab'?'criar':c.args[2]);
  assert.deepEqual(order,['init','commit','criar','remote','push'],'etapas locais antes de criar no servidor');
  await assert.rejects(publisher.publish(folder,plan.id),/expirou/,'o plano é de uso único');
});

test('sem primeira versão pedida: cria e liga, mas não envia',{skip:!hasGit},async t=>{
  const {folder,calls,publisher,git}=setup(t);
  const plan=await publisher.plan(folder,input({description:''}));
  assert.match(plan.steps.at(-1),/Nada será enviado/);
  const result=await publisher.publish(folder,plan.id);
  assert.equal(result.pushed,false);assert.equal(git('remote','get-url','origin'),`git@${HOST}:design/meu-projeto.git`);
  assert.ok(!posts(calls)[0].args.some(a=>a.startsWith('description=')));assert.ok(!calls.some(c=>c.args.includes('push')));
});

test('origin de outro servidor só é trocado com autorização e vira "anterior"',{skip:!hasGit},async t=>{
  const {folder,publisher,git}=setup(t);
  git('init','-q','-b','trabalho');git('add','-A');git('commit','-q','-m','base');git('remote','add','origin','git@github.com:pessoa/projeto.git');git('remote','add','anterior','https://example.invalid/x.git');
  const options=await publisher.options(folder);assert.deepEqual(options.local.origin,{url:'git@github.com:pessoa/projeto.git',company:false});
  await assert.rejects(publisher.plan(folder,input()),/renomeá-lo/);
  const plan=await publisher.plan(folder,input({renameOrigin:true}));
  assert.ok(plan.steps.includes('Renomear o remoto atual “origin” para “anterior-2”.'));assert.equal(plan.branch,'trabalho');
  const result=await publisher.publish(folder,plan.id);
  assert.equal(result.pushed,true);assert.equal(result.renamed,'anterior-2');
  assert.equal(git('remote','get-url','anterior-2'),'git@github.com:pessoa/projeto.git');assert.equal(git('remote','get-url','origin'),`git@${HOST}:design/meu-projeto.git`);
});

test('pasta já ligada ao GitLab SEA, HEAD destacado ou subpasta de repositório são recusados',{skip:!hasGit},async t=>{
  const {folder,publisher,git,calls}=setup(t);
  git('init','-q','-b','main');git('add','-A');git('commit','-q','-m','base');
  git('remote','add','origin',`https://${HOST}/sea/outro.git`);
  await assert.rejects(publisher.plan(folder,input({renameOrigin:true})),/já está ligada ao GitLab SEA/);
  git('remote','remove','origin');git('checkout','-q','--detach');
  await assert.rejects(publisher.plan(folder,input()),/HEAD destacado/);
  const sub=path.join(folder,'sub');fs.mkdirSync(sub);
  await assert.rejects(publisher.plan(sub,input()),/dentro do repositório/);
  assert.equal(posts(calls).length,0);
});

test('node_modules ou .env fora do .gitignore bloqueiam a primeira versão',{skip:!hasGit},async t=>{
  const {folder,publisher}=setup(t);
  fs.mkdirSync(path.join(folder,'node_modules'));fs.writeFileSync(path.join(folder,'.env'),'SEGREDO=1\n');
  await assert.rejects(publisher.plan(folder,input({commit:true})),/node_modules e \.env entraria.*\.gitignore/);
  fs.writeFileSync(path.join(folder,'.gitignore'),'node_modules/\n.env\n');
  assert.equal((await publisher.plan(folder,input({commit:true}))).fullPath,'design/meu-projeto');
});

test('erros do GitLab viram orientação: glab ausente, sem login, caminho existente, sem permissão',{skip:!hasGit},async t=>{
  {const {folder,publisher}=setup(t,{glab:false});await assert.rejects(publisher.options(folder),/Instale o GitLab CLI.*glab auth login --hostname gitlab\.seatecnologia\.com\.br/);}
  {const {folder,publisher}=setup(t,{levels:{}});   const unauthorized=new GitlabPublisher(publisher.getEnv,async()=>{throw httpError('401 Unauthorized',{message:'401 Unauthorized'});});
   await assert.rejects(unauthorized.options(folder),/glab auth login --hostname gitlab\.seatecnologia\.com\.br/);}
  {const {folder,publisher,calls}=setup(t,{existing:['design/meu-projeto']});await assert.rejects(publisher.plan(folder,input()),/Já existe um projeto em design\/meu-projeto/);assert.equal(posts(calls).length,0);}
  {const {folder,publisher}=setup(t);await assert.rejects(publisher.plan(folder,input({namespaceId:1800})),/não pode criar projetos nesse grupo/);await assert.rejects(publisher.plan(folder,input({namespaceId:900})),/não pode criar/);}
  {const {folder,publisher}=setup(t);await assert.rejects(publisher.plan(folder,input({visibility:'public'})),/privado ou interno/);await assert.rejects(publisher.plan(folder,input({path:'Meu Projeto'})),/caminho/);}
  // Corrida: o caminho foi ocupado entre a revisão e a criação.
  {const {folder,publisher}=setup(t,{post:()=>{throw httpError('400 Bad Request',{message:{path:['has already been taken'],name:['has already been taken']}});}});
   const plan=await publisher.plan(folder,input());await assert.rejects(publisher.publish(folder,plan.id),/^Error: Nada foi criado no GitLab SEA \(o Git foi iniciado nesta pasta\)\. Já existe um projeto com esse caminho/);}
  {const {folder,publisher}=setup(t,{post:()=>{throw httpError('403 Forbidden',{message:'403 Forbidden'});}});
   const plan=await publisher.plan(folder,input());await assert.rejects(publisher.publish(folder,plan.id),/não tem permissão para criar projetos nesse grupo/);}
});

test('falha local antes de criar não deixa projeto vazio no servidor',{skip:!hasGit},async t=>{
  const {folder,publisher,calls,env}=setup(t);
  const plan=await publisher.plan(folder,input({commit:true}));
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL,'');// identidade some depois da revisão
  const noIdentity={...env,GIT_AUTHOR_NAME:'',GIT_COMMITTER_NAME:'',GIT_AUTHOR_EMAIL:'',GIT_COMMITTER_EMAIL:'',EMAIL:''};publisher.getEnv=()=>noIdentity;
  await assert.rejects(publisher.publish(folder,plan.id),/Nada foi criado no GitLab SEA.*salvar a primeira versão/);
  assert.equal(posts(calls).length,0);
});

test('envio recusado depois de criar mostra o link e o que fazer',{skip:!hasGit},async t=>{
  const {folder,publisher,busy}=setup(t,{push:()=>{throw Object.assign(new Error('x'),{stderr:'git@gitlab.seatecnologia.com.br: Permission denied (publickey).\nfatal: Could not read from remote repository.'});}});
  const plan=await publisher.plan(folder,input({commit:true}));
  const result=await publisher.publish(folder,plan.id);
  assert.equal(result.pushed,false);assert.match(result.error,/O projeto foi criado em https:\/\/gitlab\.seatecnologia\.com\.br\/design\/meu-projeto, mas o envio falhou/);assert.match(result.error,/ssh_keys/);
  assert.equal(busy.size,0);
});

test('o repositório que muda depois da revisão exige nova revisão',{skip:!hasGit},async t=>{
  const {folder,publisher,calls,git}=setup(t);
  const plan=await publisher.plan(folder,input());git('init','-q','-b','outra');
  await assert.rejects(publisher.publish(folder,plan.id),/mudou depois da revisão/);assert.equal(posts(calls).length,0);
});
