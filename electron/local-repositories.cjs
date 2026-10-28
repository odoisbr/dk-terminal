const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { executable } = require('./core.cjs');
const { HOST } = require('./integrations.cjs');

// Match repository identity, never the folder name or a similarly named project.
function remoteIdentity(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/.test(value)) return null;
  let host, pathname;
  const scp = /^git@([^/:]+):([^?#]+)$/.exec(value.trim());
  if (scp) { host = scp[1]; pathname = scp[2]; }
  else {
    try {
      const url = new URL(value.trim());
      if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash || url.port || (url.username && (url.protocol !== 'ssh:' || url.username !== 'git'))) return null;
      host = url.hostname; pathname = url.pathname.replace(/^\//, '');
    } catch { return null; }
  }
  if (host.toLowerCase() !== HOST) return null;
  pathname = pathname.replace(/\.git$/, '');
  if (!/^design\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..')) return null;
  return pathname;
}
function gitOrigin(root, env) {
  const git = executable('git', env);
  if (!git) return Promise.resolve(null);
  const clean = {...env};
  for (const key of Object.keys(clean)) if (key.startsWith('GIT_')) delete clean[key];
  Object.assign(clean, {GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT:'0', GIT_OPTIONAL_LOCKS:'0'});
  return new Promise(resolve => execFile(git, ['-C',root,'config','--local','--no-includes','--get','remote.origin.url'], {env:clean, timeout:2000, maxBuffer:8192, windowsHide:true}, (error, stdout) => resolve(error ? null : remoteIdentity(stdout.trim()))));
}
const SKIP = new Set(['node_modules','vendor','dist','build','release','target','coverage','__pycache__']);
class LocalRepositories {
  constructor(root = '/Volumes/SEA', env = process.env, options = {}) { this.root=root; this.env=env; this.cache=null; this.pending=null; this.progress=null; this.maxDirectories=options.maxDirectories || 20000; this.maxMs=options.maxMs || 12000; }
  async index() {
    if (this.cache && Date.now()-this.cache.at < 30000) return this.cache.value;
    if (this.pending) return this.pending;
    this.pending=this.scan().then(value => { this.cache={at:Date.now(),value}; return value; }).finally(()=>{this.pending=null;});
    return this.pending;
  }
  async scan() {
    let base;
    try { base=await fs.promises.realpath(this.root); if (!(await fs.promises.stat(base)).isDirectory()) throw new Error(); }
    catch { return {available:false,incomplete:false,repositories:[]}; }
    if (!executable('git', this.env)) return {available:false,incomplete:false,repositories:[]};
    const previous=this.progress?.base===base ? this.progress : null;
    const queue=previous?.queue || [base], repositories=previous?.repositories || [];
    let count=0, index=0, incomplete=previous?.incomplete || false; const until=Date.now()+this.maxMs;
    while(index < queue.length) {
      if (count >= this.maxDirectories || Date.now()>until) break;
      const batch=queue.slice(index, index+Math.min(4, this.maxDirectories-count)); index+=batch.length; count+=batch.length;
      const results=await Promise.all(batch.map(async folder => {
        let timer;
        try {
          const entries=await Promise.race([
            fs.promises.readdir(folder,{withFileTypes:true}),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),1500);}),
          ]);
          const identity=entries.some(entry=>entry.name==='.git' && (entry.isDirectory() || entry.isFile())) ? await gitOrigin(folder,this.env) : null;
          return {folder,entries,identity};
        } catch { return null; }
        finally { clearTimeout(timer); }
      }));
      for(const item of results) {
        if (!item) {incomplete=true;continue;}
        if (item.identity) repositories.push({path:item.folder,identity:item.identity});
        for(const entry of item.entries) if(entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) {
          if (queue.length-index >= 30000) { incomplete=true; break; }
          queue.push(path.join(item.folder,entry.name));
        }
      }
    }
    const remaining=queue.slice(index);
    this.progress=remaining.length ? {base,queue:remaining,repositories,incomplete} : null;
    return {available:true,incomplete:incomplete || remaining.length>0,repositories:[...repositories]};
  }
  async matches(projectPath) {
    const result=await this.index();
    return {available:result.available,incomplete:result.incomplete,paths:result.repositories.filter(repo=>repo.identity===projectPath).map(repo=>repo.path).sort((a,b)=>a.localeCompare(b))};
  }
  async matchingProjects(projects) {
    const result=await this.index(), paths=new Set(result.repositories.map(repo=>repo.identity));
    return {available:result.available,incomplete:result.incomplete,ids:projects.filter(project=>paths.has(project.path)).map(project=>project.id)};
  }
  async verify(projectPath, candidate) {
    if(typeof candidate!=='string'||!path.isAbsolute(candidate)||candidate.length>8192||candidate.includes('\0')) throw new Error('Pasta local inválida.');
    const found=await this.matches(projectPath);
    if (!found.paths.includes(candidate)) throw new Error('A cópia local não foi identificada no volume SEA.');
    const base=await fs.promises.realpath(this.root), target=await fs.promises.realpath(candidate), relative=path.relative(base,target);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||target!==candidate || await gitOrigin(target,this.env)!==projectPath) throw new Error('A pasta não corresponde mais ao projeto do GitLab.');
    return target;
  }
}
module.exports={LocalRepositories,remoteIdentity};
