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
  const leader=before?.find(row=>row.pid===pid);
  const known=leader ? descendants(before,pid) : null;
  if (!leader) partial=true;
  const recorded=new Map((leader ? [leader,...known] : []).map(row=>[row.pid,row]));
  const send=(record,value)=>{try { signal(record.pid,value); } catch(error) { if(error.code!=='ESRCH')partial=true; }};
  for(const child of known || []) send(child,'SIGTERM');
  try { stopLeader(); } catch { partial=true; }
  if (!leader) return {partial};
  let remaining=[];
  for (const delay of [100,900]) {
    await wait(delay); let rows; try { rows=await snapshot(); } catch { rows=null; }
    if(!rows)return {partial:true};
    const byPid=new Map(rows.map(row=>[row.pid,row]));
    // A surviving shell may have started another child during shutdown. Only
    // discover descendants of processes whose recorded identity still matches.
    for(const record of [...recorded.values()]) {
      if(byPid.get(record.pid)?.started!==record.started)continue;
      for(const child of descendants(rows,record.pid))if(!recorded.has(child.pid)){recorded.set(child.pid,child);send(child,'SIGTERM');}
    }
    remaining=[...recorded.values()].filter(record=>byPid.get(record.pid)?.started===record.started);
    if(!remaining.length)return {partial};
  }
  for(const record of remaining)send(record,'SIGKILL');
  await wait(150); let after; try { after=await snapshot(); } catch { after=null; }
  if(!after)partial=true;
  else {const byPid=new Map(after.map(row=>[row.pid,row]));if(remaining.some(record=>byPid.get(record.pid)?.started===record.started))partial=true;}
  return {partial};
}
// The leader may have exited after a graceful cancellation. Re-identify only
// descendants captured while it was alive before sending any later signal.
async function stopRecordedProcesses(records, options = {}) {
  const snapshot=options.snapshot || processSnapshot, signal=options.signal || ((id,value)=>process.kill(id,value));
  const wait=options.wait || (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  if(!Array.isArray(records))return {partial:true};
  if(!records.length)return {partial:false};
  let current;try{current=await snapshot();}catch{current=null;}
  if(!current)return {partial:true};
  const byPid=new Map(current.map(row=>[row.pid,row]));let partial=false;
  const alive=records.filter(record=>byPid.get(record.pid)?.started===record.started);
  for(const child of alive){try{signal(child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')partial=true;}}
  if(alive.length){
    await wait(1000);let after;try{after=await snapshot();}catch{after=null;}
    if(!after)partial=true;
    else {
      const byPid=new Map(after.map(row=>[row.pid,row]));const remaining=alive.filter(child=>byPid.get(child.pid)?.started===child.started);
      for(const child of remaining){try{signal(child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')partial=true;}}
      if(remaining.length){
        await wait(150);let confirmed;try{confirmed=await snapshot();}catch{confirmed=null;}
        if(!confirmed)partial=true;
        else {const byPid=new Map(confirmed.map(row=>[row.pid,row]));if(remaining.some(child=>byPid.get(child.pid)?.started===child.started))partial=true;}
      }
    }
  }
  return {partial};
}
module.exports={processSnapshot,descendants,stopTerminalTree,stopRecordedProcesses};
