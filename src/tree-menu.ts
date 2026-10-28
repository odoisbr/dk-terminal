type TreeMenuOptions={currentRoot:()=>string|null;openFile:(root:string,name:string)=>Promise<void>;notify:(message:unknown)=>void};
export class TreeMenu {
  private menu:HTMLDivElement; private trigger:HTMLElement|null=null;
  constructor(private options:TreeMenuOptions){
    this.menu=document.createElement('div');this.menu.className='tree-context-menu';this.menu.setAttribute('role','menu');this.menu.setAttribute('aria-label','Ações do item');this.menu.hidden=true;document.body.append(this.menu);
    document.addEventListener('pointerdown',event=>{if(!this.menu.hidden&&!this.menu.contains(event.target as Node))this.close();});
    document.addEventListener('keydown',event=>{if(this.menu.hidden)return;if(event.key==='Escape'){event.preventDefault();this.close(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const entries=[...this.menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const current=entries.indexOf(document.activeElement as HTMLButtonElement);const index=event.key==='Home'?0:event.key==='End'?entries.length-1:event.key==='ArrowDown'?(current+1)%entries.length:(current-1+entries.length)%entries.length;entries[index]?.focus();}});
  }
  private close(restore=false){this.menu.hidden=true;this.menu.replaceChildren();if(restore&&this.trigger?.isConnected)this.trigger.focus();this.trigger=null;}
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
    const bounds=this.menu.getBoundingClientRect();this.menu.style.left=`${Math.max(8,Math.min(x,window.innerWidth-bounds.width-8))}px`;this.menu.style.top=`${Math.max(8,Math.min(y,window.innerHeight-bounds.height-8))}px`;this.menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
}
