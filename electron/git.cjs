const {execFile} = require('node:child_process');
const fs = require('node:fs');
const {executable} = require('./core.cjs');
const {remoteIdentity} = require('./local-repositories.cjs');
const {readProjectFile} = require('./files.cjs');
const {HOST} = require('./gitlab-errors.cjs');
const {remoteHost} = require('./gitlab-publish.cjs');

class Git {
  constructor(env) { this.env = {...env, GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'Never', GIT_PAGER:'cat', PAGER:'cat', NO_COLOR:'1'}; for (const key of Object.keys(this.env)) if (/^GIT_(TRACE|CURL_VERBOSE|DIR$|WORK_TREE$|INDEX_FILE$|CONFIG_COUNT$)/.test(key)) delete this.env[key]; this.busy = new Set(); }
  run(root,args, options={}) {
    const git=executable('git',this.env); if (!git) throw new Error('Git não encontrado. Instale o Git para usar esta guia.');
    return new Promise((resolve,reject)=>execFile(git,['-C',root,...args],{env:this.env,timeout:options.network?120000:15000,maxBuffer:2*1024*1024,windowsHide:true},(error,stdout,stderr)=>{
      if(error) { const e=new Error(options.network ? 'Não foi possível sincronizar. Confira a conexão, a autenticação e se há alterações remotas que precisam de integração.' : (String(stderr||'').trim().slice(0,800) || 'Não foi possível executar a operação Git.')); e.code=error.code; return reject(e); }
      resolve(stdout);
    }));
  }
  async root(root) {
    let top; try {top=(await this.run(root,['rev-parse','--show-toplevel'])).trim();} catch {return false;}
    try {return fs.realpathSync(top) === fs.realpathSync(root);} catch{return false;}
  }
  async requireRoot(root) { if (!await this.root(root)) throw new Error('Esta pasta não é a raiz de um repositório Git.'); }
  async status(root) {
    if (!await this.root(root)) return {repository:false};
    const [raw, branch, head, upstream, origin] = await Promise.all([
      this.run(root,['status','--porcelain=v1','-z','--untracked-files=all']),
      this.run(root,['symbolic-ref','--quiet','--short','HEAD']).catch(()=>'(HEAD destacado)'),
      this.run(root,['rev-parse','--verify','HEAD']).catch(()=>''),
      this.run(root,['rev-list','--left-right','--count','HEAD...@{upstream}']).catch(()=>''),
      this.run(root,['config','--local','--no-includes','--get','remote.origin.url']).catch(()=>''),
    ]);
    const parts=raw.split('\0'); const changes=[];
    for(let i=0;i<parts.length && parts[i];i++) {
      const line=parts[i], code=line.slice(0,2), name=line.slice(3); if (!name) continue;
      const previous=/[RC]/.test(code) ? parts[++i] : null;
      changes.push({path:name,code,previous});
    }
    const counts=upstream.trim().split(/\s+/).map(Number);
    return {repository:true,branch:branch.trim(),hasHead:!!head,changes, ahead:counts.length===2&&counts.every(Number.isFinite)?counts[0]:null,behind:counts.length===2&&counts.every(Number.isFinite)?counts[1]:null,hasOrigin:!!origin.trim(),gitlab:remoteIdentity(origin.trim()),gitlabHost:remoteHost(origin.trim())===HOST};
  }
  async history(root) {
    await this.requireRoot(root);
    const data=await this.run(root,['log','-50','--format=%H%x00%an%x00%aI%x00%s%x00']).catch(()=> '');
    const parts=data.split('\0'), items=[];
    for(let i=0;i+3<parts.length;i+=4) {const hash=parts[i].trim(); if(/^[a-f0-9]{40,64}$/.test(hash))items.push({hash,author:parts[i+1],date:parts[i+2],message:parts[i+3]});}
    return items;
  }
  async branches(root) {
    await this.requireRoot(root);
    const data=await this.run(root,['for-each-ref','--format=%(refname:short)%00%(HEAD)%00%(objectname)%00%(upstream:short)%00','refs/heads']);
    const parts=data.split('\0'),items=[];
    for(let i=0;i+3<parts.length;i+=4) {const name=parts[i].replace(/^\n/,'');if(name)items.push({name,current:parts[i+1].trim()==='*',hash:parts[i+2],upstream:parts[i+3]||null});}
    return items;
  }
  async graph(root) {
    await this.requireRoot(root);
    const state=await this.status(root);if(!state.hasHead)return [];
    const raw=await this.run(root,['log','--all','HEAD','--topo-order','-100','--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D%x00']);
    const parts=raw.split('\0'),items=[];
    for(let i=0;i+5<parts.length;i+=6){const hash=parts[i].trim();if(/^[a-f0-9]{40,64}$/.test(hash))items.push({hash,parents:parts[i+1]?parts[i+1].split(' ').filter(p=>/^[a-f0-9]{40,64}$/.test(p)):[],author:parts[i+2],date:parts[i+3],message:parts[i+4],refs:parts[i+5]});}
    return items;
  }
  async branchAction(root,action,name) {
    if(this.busy.has(root)) throw new Error('Já existe uma operação Git em andamento.');
    if(!['create','switch','delete'].includes(action)||typeof name!=='string'||!name||name.length>255||name.startsWith('-')||/[\r\n\0]/.test(name))throw new Error('Nome ou ação de branch inválidos.');
    this.busy.add(root);
    try {
      await this.requireRoot(root);
      if((await this.run(root,['check-ref-format','--branch',name])).trim()!==name) throw new Error('Informe o nome literal de uma branch.');
      const state=await this.status(root);
      if(!state.hasHead)throw new Error('Salve a primeira versão antes de gerenciar branches.');
      if(action!=='delete' && state.changes.length)throw new Error('Salve ou resolva todas as alterações locais antes de trocar de branch.');
      if(action==='delete') {
        if(state.branch===name)throw new Error('Troque de branch antes de excluir a branch atual.');
        const branches=await this.branches(root);if(!branches.some(branch=>branch.name===name))throw new Error('A branch local não existe mais.');
        try {await this.run(root,['merge-base','--is-ancestor',`refs/heads/${name}`,'HEAD']);} catch {throw new Error('Esta branch ainda não foi integrada à branch atual; ela não pode ser excluída aqui.');}
        await this.run(root,['branch','-d','--',name]);
      } else if(action==='create') await this.run(root,['switch','-c',name,'--']);
      else {const branches=await this.branches(root);if(!branches.some(branch=>branch.name===name))throw new Error('Selecione uma branch local existente.');await this.run(root,['switch','--',name]);}
      return true;
    } finally {this.busy.delete(root);}
  }
  async diff(root,name) {
    const state=await this.status(root); if(!state.repository) throw new Error('Esta pasta não é um repositório Git.');
    const item=state.changes.find(entry=>entry.path===name); if(!item) throw new Error('Arquivo não está mais na lista de alterações. Atualize a guia.');
    if(item.code==='??') { const file=readProjectFile(root,name); return file.kind==='text' ? `Arquivo novo\n\n${file.content}` : 'Arquivo novo binário ou grande demais para prévia.'; }
    const spec=[name,...(item.previous?[item.previous]:[])].map(p=>':(literal)'+p);
    return (await this.run(root,['-c','core.quotepath=false','diff','--no-ext-diff','--no-textconv',...(state.hasHead?['HEAD']:['--cached']),'--',...spec])) || 'Sem diferença de texto disponível para este arquivo.';
  }
  async commitDetail(root,hash) {
    await this.requireRoot(root);
    if(typeof hash!=='string'||!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error('Versão inválida.');
    return this.run(root,['show','--format=fuller','--stat','--no-ext-diff','--no-textconv',hash,'--']);
  }
  async commit(root, names, message) {
    if(this.busy.has(root)) throw new Error('Já existe uma operação Git em andamento.'); this.busy.add(root);
    try {
      if(!Array.isArray(names)||!names.length||names.length>1000||new Set(names).size!==names.length||names.some(n=>typeof n!=='string'||n.length>8192||n.includes('\0'))) throw new Error('Selecione os arquivos que deseja salvar.');
      if(typeof message!=='string'||!message.trim()||message.length>2000||message.includes('\0')) throw new Error('Informe uma mensagem para a versão.');
      const state=await this.status(root); if(!state.repository) throw new Error('Esta pasta não é um repositório Git.');
      const items=names.map(name=>state.changes.find(item=>item.path===name));
      if(items.some(item=>!item)) throw new Error('As alterações mudaram. Atualize a lista e selecione novamente.');
      if(items.some(item=>/U/.test(item.code)||['AA','DD'].includes(item.code))) throw new Error('Resolva os conflitos antes de salvar uma versão.');
      const specs=[...new Set(items.flatMap(item=>[item.path,...(item.previous?[item.previous]:[])]))].map(name=>':(literal)'+name);
      // The old side of a staged rename is already absent from the index;
      // stage its destination, then include both sides in the commit pathspec.
      const toStage=items.filter(item=>item.code!=='D ').map(item=>':(literal)'+item.path);
      if(toStage.length) await this.run(root,['add','-A','--',...toStage]);
      await this.run(root,['commit','--only','-m',message.trim(),'--',...specs]);
      return true;
    } finally {this.busy.delete(root);}
  }
  async sync(root,action) {
    if(this.busy.has(root)) throw new Error('Já existe uma operação Git em andamento.');
    if(!['fetch','pull','push'].includes(action)) throw new Error('Ação de sincronização inválida.');
    this.busy.add(root);
    try {await this.requireRoot(root); const s=await this.status(root);
      if(action==='pull' && s.changes.length)throw new Error('Salve suas alterações antes de atualizar o projeto.');
      if(action==='push' && s.ahead===null && (!s.hasOrigin || !s.hasHead || s.branch==='(HEAD destacado)')) throw new Error('Configure um remoto origin e uma branch antes de enviar as versões.');
      let args=action==='fetch'?['fetch']:action==='pull'?['pull','--ff-only']:['push','--set-upstream','--','origin','HEAD'];
      if(action==='push' && s.ahead!==null) {
        const remote=(await this.run(root,['config','--get',`branch.${s.branch}.remote`])).trim();
        const merge=(await this.run(root,['config','--get',`branch.${s.branch}.merge`])).trim();
        if(!remote || remote==='.' || !merge.startsWith('refs/heads/') || /[\r\n\0]/.test(remote+merge)) throw new Error('Não foi possível identificar a branch remota para envio.');
        await this.run(root,['check-ref-format',merge]);
        args=['push','--',remote,`HEAD:${merge}`];
      }
      await this.run(root,args,{network:true}); return true;
    } finally {this.busy.delete(root);}
  }
}
module.exports={Git};
