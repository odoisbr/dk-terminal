const ns='http://www.w3.org/2000/svg';
type Route={from:number;to:number;color:number};
export type GraphRow={commit:GitGraphCommit;lane:number;width:number;incoming:number[];routes:Route[]};
// Keep one lane per outstanding parent; a merge adds lanes until its parents
// are reached. The displayed graph is bounded to the commits returned by Git.
export function layoutGraph(commits:GitGraphCommit[]):GraphRow[]{
  let lanes:string[]=[];
  return commits.map(commit=>{
    let lane=lanes.indexOf(commit.hash);if(lane<0){lane=lanes.length;lanes.push(commit.hash);}
    const before=[...lanes];let next=before.filter((_,i)=>i!==lane);
    const first=commit.parents[0];if(first&&!next.includes(first))next.splice(Math.min(lane,next.length),0,first);
    for(const parent of commit.parents.slice(1))if(!next.includes(parent))next.push(parent);
    const routes:Route[]=[];
    before.forEach((hash,index)=>{if(index!==lane){const target=next.indexOf(hash);if(target>=0)routes.push({from:index,to:target,color:index});}});
    for(const parent of commit.parents){const target=next.indexOf(parent);if(target>=0)routes.push({from:lane,to:target,color:target});}
    lanes=next;return {commit,lane,width:Math.max(before.length,next.length,1),incoming:before.map((_,i)=>i),routes};
  });
}
export function renderGitGraph(host:HTMLElement,commits:GitGraphCommit[],root:string,isCurrent:()=>boolean=()=>true){
  const rows=layoutGraph(commits);host.replaceChildren();
  if(!rows.length){const empty=document.createElement('p');empty.className='git-muted';empty.textContent='Nenhuma versão salva ainda.';host.append(empty);return;}
  const width=Math.max(...rows.map(row=>row.width))*16;
  for(const row of rows){
    const item=document.createElement('details');item.className='git-graph-row';const summary=document.createElement('summary');
    const svg=document.createElementNS(ns,'svg');svg.setAttribute('width',String(width));svg.setAttribute('height','40');svg.setAttribute('aria-hidden','true');svg.classList.add('git-graph-lines');
    const makePath=(d:string,color:number)=>{const p=document.createElementNS(ns,'path');p.setAttribute('d',d);p.setAttribute('class',`git-line git-line-${color%6}`);svg.append(p);};
    row.incoming.forEach(index=>{const x=index*16+8;makePath(`M ${x} 0 L ${x} 20`,index);});
    row.routes.forEach(route=>{const x=route.from*16+8,to=route.to*16+8;makePath(`M ${x} 20 C ${x} 30 ${to} 30 ${to} 40`,route.color);});
    const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',String(row.lane*16+8));dot.setAttribute('cy','20');dot.setAttribute('r','4');dot.setAttribute('class',`git-node git-line-${row.lane%6}`);svg.append(dot);
    const text=document.createElement('span');text.className='git-graph-copy';const message=document.createElement('strong');message.textContent=row.commit.message;const metadata=document.createElement('small');const date=new Date(row.commit.date);metadata.textContent=`${row.commit.author} · ${Number.isNaN(date.getTime())?'':date.toLocaleDateString('pt-BR')} · ${row.commit.hash.slice(0,7)}`;text.append(message,metadata);
    if(row.commit.refs){const refs=document.createElement('span');refs.className='git-graph-refs';refs.textContent=row.commit.refs;text.append(refs);}
    summary.append(svg,text);const detail=document.createElement('div');detail.className='git-diff';detail.textContent='Carregando versão…';let loading=false;
    item.ontoggle=async()=>{
      if(!item.open||detail.dataset.loaded||loading||!isCurrent())return;
      loading=true;detail.textContent='Carregando versão…';
      try{const value=await window.dk.gitCommitDetail(root,row.commit.hash);if(item.isConnected&&isCurrent()){detail.textContent=value;detail.dataset.loaded='true';}}
      catch(error){if(item.isConnected&&isCurrent())detail.textContent=error instanceof Error?error.message:String(error);}
      finally{loading=false;}
    };item.append(summary,detail);host.append(item);
  }
}
