type TreeMenuOptions={currentRoot:()=>string|null;openFile:(root:string,name:string)=>Promise<void>;notify:(message:unknown)=>void};
export class TreeMenu {
  private menu:HTMLDivElement; private trigger:HTMLElement|null=null;
  constructor(private options:TreeMenuOptions){
    this.menu=document.createElement('div');this.menu.className='tree-context-menu';this.menu.setAttribute('role','menu');this.menu.setAttribute('aria-label','Ações do item');this.menu.hidden=true;document.body.append(this.menu);
    document.addEventListener('pointerdown',event=>{if(!this.menu.hidden&&!this.menu.contains(event.target as Node))this.close();});
    document.addEventListener('keydown',event=>{if(this.menu.hidden)return;if(event.key==='Escape'){event.preventDefault();this.close(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const entries=[...this.menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const current=entries.indexOf(document.activeElement as HTMLButtonElement);const index=event.key==='Home'?0:event.key==='End'?entries.length-1:event.key==='ArrowDown'?(current+1)%entries.length:(current-1+entries.length)%entries.length;entries[index]?.focus();}});
    document.addEventListener('focusin',event=>{if(!this.menu.hidden&&!this.menu.contains(event.target as Node))this.close();});
    document.addEventListener('scroll',event=>{if(!this.menu.hidden&&(!(event.target instanceof Node)||!this.menu.contains(event.target)))this.close(true);},true);
    window.addEventListener('resize',()=>{if(!this.menu.hidden)this.close(true);});
  }
  private close(restore=false){this.menu.hidden=true;this.menu.replaceChildren();if(restore&&this.trigger?.isConnected&&this.trigger.getClientRects().length)this.trigger.focus({preventScroll:true});this.trigger=null;}
  open(event:MouseEvent|KeyboardEvent,trigger:HTMLElement,root:string,entry:DirectoryEntry){
    event.preventDefault();event.stopPropagation();if(this.options.currentRoot()!==root)return;this.close();this.trigger=trigger;
    const add=(label:string,fn:()=>Promise<unknown>,disabled=false,title='')=>{const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=label;button.disabled=disabled;if(title)button.title=title;button.onclick=()=>{this.close(true);if(this.options.currentRoot()!==root)return;void fn().catch(this.options.notify);};this.menu.append(button);};
    const system=(action:'reveal'|'open-system'|'copy-path'|'copy-name'|'share')=>window.dk.treeAction(root,entry.relative,action);
    if(entry.kind!=='directory')add('Abrir no editor',()=>this.options.openFile(root,entry.relative));
    add(entry.kind==='directory'?'Abrir pasta no sistema':'Abrir com aplicativo padrão',()=>system('open-system'));
    add(document.body.classList.contains('other-platform')?'Mostrar na pasta':'Mostrar no Finder',()=>system('reveal'));
    add('Copiar nome',async()=>{await system('copy-name');this.options.notify('Nome copiado.');});
    add('Copiar caminho',async()=>{await system('copy-path');this.options.notify('Caminho copiado.');});
    if(entry.kind!=='directory'){
      add('Compartilhar arquivo…',()=>system('share'),document.body.classList.contains('other-platform'),'Compartilha a versão salva do arquivo usando os aplicativos disponíveis no macOS.');
      const hint=document.createElement('small');hint.className='tree-context-hint';hint.textContent='Compartilha a versão salva no disco.';this.menu.append(hint);
    }
    this.menu.hidden=false;const rect=trigger.getBoundingClientRect();const x=event instanceof MouseEvent?event.clientX:rect.left;const y=event instanceof MouseEvent?event.clientY:rect.bottom;
    // The browser preview is a native view above HTML. Keep the menu within
    // the inspector so it stays usable when the preview is beside the tree.
    const inspector=trigger.closest<HTMLElement>('#project-inspector-panel');const area=inspector?.getBoundingClientRect();
    const left=Math.max(8,area ? area.left+4 : 8),right=Math.min(window.innerWidth-8,area ? area.right-4 : window.innerWidth-8);
    const top=Math.max(8,area ? area.top+4 : 8),bottom=Math.min(window.innerHeight-8,area ? area.bottom-4 : window.innerHeight-8);
    const available=Math.max(1,right-left);this.menu.style.minWidth=`${Math.min(210,available)}px`;this.menu.style.maxWidth=`${available}px`;
    this.menu.style.maxHeight=`${Math.max(1,bottom-top)}px`;this.menu.style.overflowY='auto';
    const bounds=this.menu.getBoundingClientRect();this.menu.style.left=`${Math.max(left,Math.min(x,right-bounds.width))}px`;this.menu.style.top=`${Math.max(top,Math.min(y,bottom-bounds.height))}px`;this.menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
}
