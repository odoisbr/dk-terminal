const { execFile } = require('node:child_process');
const fs = require('node:fs');

function processSnapshot(platform = process.platform) {
  if (!['darwin','linux'].includes(platform)) return Promise.resolve(null);
  const ps = fs.existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
  return new Promise(resolve => {
    execFile(ps, ['-axo','pid=,ppid=,lstart='], {timeout:2500,maxBuffer:2*1024*1024,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}}, (error, output) => {
      if (error) return resolve(null);
      const rows = [];
      for (const line of output.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (match) rows.push({pid:Number(match[1]),ppid:Number(match[2]),started:match[3]});
      }
      resolve(rows.length ? rows : null);
    });
  });
}
function descendants(rows, root) {
  const children = new Map();
  for (const row of rows) { const group = children.get(row.ppid) || []; group.push(row); children.set(row.ppid,group); }
  const found=[], pending=[root], visited=new Set([root]);
  while(pending.length) for(const child of children.get(pending.pop()) || []) {
    if(visited.has(child.pid))continue;visited.add(child.pid);found.push(child);pending.push(child.pid);
  }
  return found;
}
async function stopTerminalTree(pid, stopLeader, options = {}) {
  const snapshot=options.snapshot || processSnapshot, signal=options.signal || ((id, value)=>process.kill(id,value));
  const wait=options.wait || (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  let partial=false, before; try { before=await snapshot(); } catch { before=null; }
  const known=before?.some(row=>row.pid===pid) ? descendants(before,pid) : null;
  if (!known) partial=true;
  for(const child of known || []) { try { signal(child.pid,'SIGTERM'); } catch(error) { if(error.code!=='ESRCH')partial=true; } }
  try { stopLeader(); } catch { partial=true; }
  if (known?.length) {
    await wait(1000); let after; try { after=await snapshot(); } catch { after=null; }
    if (!after) partial=true;
    else {
      const byPid=new Map(after.map(row=>[row.pid,row]));
      for(const child of known) {
        const remaining=byPid.get(child.pid);
        if(remaining && remaining.started===child.started) { try { signal(child.pid,'SIGKILL'); } catch(error) { if(error.code!=='ESRCH')partial=true; } }
      }
    }
  }
  return {partial};
}
module.exports={processSnapshot,descendants,stopTerminalTree};
