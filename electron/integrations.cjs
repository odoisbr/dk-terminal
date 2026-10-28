const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { executable } = require('./core.cjs');
const HOST = 'gitlab.seatecnologia.com.br';
const GROUP = 'design';
function allowedProject(p) {
  if (!p || !Number.isSafeInteger(p.id) || p.id <= 0 || typeof p.name !== 'string' || typeof p.path_with_namespace !== 'string' || p.path_with_namespace.length > 500 || typeof p.default_branch !== 'string' || !p.default_branch || p.default_branch.length > 255) return null;
  const parts = p.path_with_namespace.split('/');
  if (parts[0] !== GROUP || parts.length < 2 || parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')) return null;
  return { id:p.id, name:p.name.slice(0,200), path:p.path_with_namespace, branch:p.default_branch };
}
const TOOLS = [
  { id:'sea', name:'SEA CLI', args:['version'], required:true, purpose:'Login e serviços SEA' },
  { id:'claude', name:'Claude Code', args:['--version'], required:true, purpose:'Assistente Claude' },
  { id:'codex', name:'Codex', args:['--version'], required:false, purpose:'Assistente Codex' },
  { id:'python3', name:'Python', args:['--version'], required:true, purpose:'Ações do DK' },
  { id:'pnpm', name:'pnpm', args:['--version'], required:true, purpose:'Projetos JavaScript' },
  { id:'node', name:'Node.js', args:['--version'], required:true, purpose:'Projetos JavaScript' },
  { id:'git', name:'Git', args:['--version'], required:true, purpose:'Cópias locais de projetos' },
  { id:'glab', name:'GitLab CLI', args:['--version'], required:false, purpose:'Acesso ao GitLab SEA' },
];
function run(file, args, env, options = {}) {
  const safeEnv = { ...env, GIT_TERMINAL_PROMPT:'0', NO_COLOR:'1' };
  delete safeEnv.GLAB_DEBUG_HTTP;
  delete safeEnv.DEBUG; delete safeEnv.GIT_TRACE; delete safeEnv.GIT_CURL_VERBOSE;
  return new Promise((resolve,reject)=>execFile(file,args,{env:safeEnv,timeout:options.timeout||12000,maxBuffer:options.maxBuffer||2*1024*1024,encoding:options.encoding||'utf8',cwd:options.cwd},(error,stdout)=>{
    if(error) return reject(new Error(options.message || 'Não foi possível consultar a ferramenta. Verifique a conexão e a autenticação.'));
    resolve(stdout);
  }));
}
class Integrations {
  constructor(env, execute=run) { this.env=env; this.execute=execute; this.projects=new Map(); this.toolCache=null; this.toolPending=null; }
  async tools(refresh=false) {
    if (this.toolPending) return this.toolPending;
    if (!refresh && this.toolCache && Date.now()-this.toolCache.at<60000) return this.toolCache.value;
    this.toolPending=Promise.all(TOOLS.map(async item=>{
      const file=executable(item.id,this.env);
      if (!file) return { ...item, args:undefined, available:false, installed:false, version:null };
      try { const output=await this.execute(file,item.args,this.env,{timeout:6000,maxBuffer:64*1024}); return {...item,args:undefined,available:true,installed:true,version:String(output).trim().split('\n')[0].slice(0,120)}; }
      catch { return {...item,args:undefined,available:false,installed:true,version:null}; }
    })).then(value=>{this.toolCache={at:Date.now(),value};return value;}).finally(()=>{this.toolPending=null;});
    return this.toolPending;
  }
  authSpec(provider) {
    if (!['sea','gitlab'].includes(provider)) throw new Error('Autenticação desconhecida.');
    const name=provider==='sea'?'sea':'glab', file=executable(name,this.env);
    if (!file) throw new Error(`${name} não encontrado. Instale a ferramenta antes de entrar.`);
    return { file, args:provider==='sea'?['auth','login']:['auth','login','--hostname',HOST], kind:'auth',label:provider==='sea'?'Login SEA':'Login GitLab' };
  }
  async account(provider) {
    const name=provider==='sea'?'sea':provider==='gitlab'?'glab':null;
    if(!name) throw new Error('Conta desconhecida.');
    const file=executable(name,this.env); if(!file) return {status:'missing',name:null};
    try {
      const args=provider==='sea'?['auth','me','--json']:['api','user','--hostname',HOST];
      const data=JSON.parse(await this.execute(file,args,this.env,{timeout:8000,maxBuffer:256*1024}));
      const user=data.data || data; return {status:'connected',name:typeof user.name==='string'?user.name.slice(0,150):typeof user.username==='string'?user.username.slice(0,150):'Conta conectada'};
    } catch { return {status:'unavailable',name:null}; }
  }
  async gitlab(endpoint, options={}) {
    const file=executable('glab',this.env); if(!file) throw new Error('Instale o GitLab CLI para acessar os projetos remotos.');
    return this.execute(file,['api',endpoint,'--hostname',HOST],this.env,{...options,message:'Não foi possível acessar o GitLab SEA. Verifique a conexão e faça login no GitLab.'});
  }
  async listProjects(query='', page=1) {
    if(typeof query!=='string'||query.length>120||!Number.isInteger(page)||page<1||page>100) throw new Error('Busca inválida.');
    const q=new URLSearchParams({simple:'true',archived:'false',per_page:'30',page:String(page),order_by:'last_activity_at',sort:'desc',include_subgroups:'true',with_shared:'false'});if(query.trim())q.set('search',query.trim());
    const values=JSON.parse(await this.gitlab(`groups/${GROUP}/projects?${q}`)); if(!Array.isArray(values)) throw new Error('Resposta inválida do GitLab.');
    const items=values.flatMap(p=>{
      const project=allowedProject(p);
      if (!project) return [];
      this.projects.set(project.id,project); return [project];
    });
    return {items,hasMore:values.length===30};
  }
  async getProject(id) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Projeto inválido.');
    try {
      const item=allowedProject(JSON.parse(await this.gitlab(`projects/${id}`)));
      if (!item || item.id !== id) throw new Error('Projeto indisponível no grupo design do GitLab SEA.');
      this.projects.set(id,item); return item;
    } catch (error) {
      // An old selection must never survive a failed refresh or namespace transfer.
      this.projects.delete(id); throw error;
    }
  }
  async materialize(id, base) {
    this.project(id);
    const project=await this.getProject(id), destination=path.join(base,project.path.split('/').at(-1));
    if(fs.existsSync(destination)) throw new Error('Já existe uma pasta com esse nome no destino escolhido.');
    const file=executable('glab',this.env); if(!file) throw new Error('Instale o GitLab CLI para preparar a cópia.');
    await this.execute(file,['repo','clone',`https://${HOST}/${project.path}.git`,destination],this.env,{timeout:300000,maxBuffer:1024*1024,message:'Não foi possível preparar a cópia. Confira o acesso ao GitLab e a pasta de destino.'});
    return destination;
  }
  project(id) {
    const cached=this.projects.get(id);
    if(!Number.isSafeInteger(id)||!cached||!allowedProject({id:cached.id,name:cached.name,path_with_namespace:cached.path,default_branch:cached.branch})||cached.id!==id) { this.projects.delete(id); throw new Error('Selecione um projeto do grupo design na lista do GitLab.'); }
    return cached;
  }
  async tree(id, folder='', page=1) {
    this.project(id); if(typeof folder!=='string'||folder.length>4096||folder.includes('\0')||folder.startsWith('/')||folder.split('/').some(s=>s==='..')||!Number.isInteger(page)||page<1||page>100) throw new Error('Pasta inválida.');
    const project=await this.getProject(id);
    const q=new URLSearchParams({ref:project.branch,per_page:'100',page:String(page)});if(folder)q.set('path',folder);
    const values=JSON.parse(await this.gitlab(`projects/${id}/repository/tree?${q}`)); if(!Array.isArray(values)) throw new Error('Resposta inválida do GitLab.');
    const entries=values.flatMap(item=>typeof item.name==='string'&&typeof item.path==='string'&&['tree','blob'].includes(item.type)?[{name:item.name.slice(0,255),path:item.path.slice(0,4096),kind:item.type==='tree'?'directory':'file'}]:[]);
    return {entries,hasMore:values.length===100};
  }
  async file(id, name) {
    this.project(id);if(typeof name!=='string'||!name||name.length>4096||name.includes('\0')||name.startsWith('/')||name.split('/').some(s=>s==='..')) throw new Error('Arquivo inválido.');
    const project=await this.getProject(id);
    const raw=await this.gitlab(`projects/${id}/repository/files/${encodeURIComponent(name)}/raw?${new URLSearchParams({ref:project.branch})}`,{encoding:'buffer',maxBuffer:4*1024*1024});
    const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw);
    let mime=null;
    if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime='image/png';
    else if (bytes.length>=3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff) mime='image/jpeg';
    else if (bytes.subarray(0,6).toString('ascii')==='GIF87a' || bytes.subarray(0,6).toString('ascii')==='GIF89a') mime='image/gif';
    else if (bytes.subarray(0,4).toString('ascii')==='RIFF' && bytes.subarray(8,12).toString('ascii')==='WEBP') mime='image/webp';
    if (mime) return {name,kind:'image',dataUrl:`data:${mime};base64,${bytes.toString('base64')}`,readOnly:true};
    if(bytes.length>2*1024*1024) throw new Error('Este arquivo excede o limite de visualização de texto de 2 MB.');
    if(bytes.includes(0)) throw new Error('Este arquivo binário não pode ser exibido como texto.');
    try { return {name,kind:'text',content:new TextDecoder('utf-8',{fatal:true}).decode(bytes),readOnly:true}; } catch { throw new Error('Este arquivo não é texto UTF-8.'); }
  }
}
module.exports={Integrations,TOOLS,HOST};
