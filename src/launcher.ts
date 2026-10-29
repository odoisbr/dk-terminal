import type { Terminal } from '@xterm/xterm';
import { mountDebugSettings } from './debug';

type Preferences = { fontSize:number; scrollback:number; cursorBlink:boolean; idleMinutes:number; idleMemoryMiB:number; idleAlerts:boolean };
type LauncherSnapshot = { revision:number; hidden:boolean };
type Options = {
  beginProjectIntent(): number;
  isCurrentIntent(intent:number): boolean;
  activateProject(project: Project, intent:number): Promise<boolean>;
  rememberProject(project: Project): void;
  getProjects(): Project[];
  hasProject(): boolean;
  getRemoteProjects(): {id:number;name:string;path:string}[];
  rememberRemote(item:RemoteProject):void;
  preferences: Preferences;
  applyPreferences():void;
  theme(enabled:boolean):void;
  glass(enabled:boolean):void;
  glassAmount(value:number):void;
  getGlassAmount():number;
  sidebar(collapsed:boolean):void;
  notify(error:unknown):void;
  mountPlugins(host:HTMLElement):()=>void;
};
const element = <K extends keyof HTMLElementTagNameMap>(tag:K, className='', text='') => { const item=document.createElement(tag);item.className=className;item.textContent=text;return item; };
const option = (text:string,value:string) => { const item=document.createElement('option');item.textContent=text;item.value=value;return item; };
const glyphs:Record<string,string> = {
  plus:'<path d="M12 5v14M5 12h14"/>', folder:'<path d="M3 6h7l2 2h9v11H3z"/>', git:'<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m2-6h4a6 6 0 0 0 6-2"/>',
  settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
  activity:'<path d="M3 12h5l2-6 4 12 3-6h4"/>', user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', tool:'<path d="M14 4a5 5 0 0 0-6 6L3 15l6 6 5-5a5 5 0 0 0 6-6l-3 3-3-3 3-3z"/>', arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>'
};
function mark(name:string,className='launcher-glyph') { const item=element('span',className);item.setAttribute('aria-hidden','true');item.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${glyphs[name]||glyphs.folder}</svg>`;return item; }

export class Launcher {
  private readonly host: HTMLElement;
  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  private readonly accountDialog: HTMLElement;
  private selected: RemoteProject|null=null;
  private page=1;
  private query='';
  private loadId=0;
  private activeLogin: { id:string; terminal:Terminal; cleanup:()=>void } | null=null;
  private loginGeneration=0;
  private pluginsCleanup:(()=>void)|null=null;
  constructor(private readonly options:Options) {
    this.host=element('section','launcher');this.host.id='launcher';this.host.setAttribute('aria-label','Início e configurações');this.host.hidden=true;
    this.host.innerHTML=`<div class="launcher-shell"><header class="launcher-header"><div><span class="launcher-kicker">SEA DOCK</span><h1 id="launcher-title">Seu espaço de trabalho</h1></div><button id="launcher-close" class="icon-button" aria-label="Fechar início">×</button></header><nav class="launcher-nav" aria-label="Navegação inicial"><button data-route="home">Início</button><button data-route="gitlab">GitLab SEA</button><button data-route="settings">Perfil e configurações</button></nav><div id="launcher-body" class="launcher-body"></div></div><section id="account-dialog" class="account-dialog" aria-label="Autenticação" hidden><div class="account-card"><header><strong id="account-title">Entrar</strong><button id="account-close" class="icon-button" aria-label="Fechar autenticação">×</button></header><p>A ferramenta oficial gerencia suas credenciais. O SEA Dock não as armazena.</p><div id="account-terminal" class="account-terminal"></div><div id="account-status" role="status"></div></div></section>`;
    document.getElementById('app')!.append(this.host);
    this.body=this.host.querySelector('#launcher-body')!;this.title=this.host.querySelector('#launcher-title')!;this.accountDialog=this.host.querySelector('#account-dialog')!;
    this.host.querySelectorAll<HTMLButtonElement>('[data-route]').forEach(button=>{button.onclick=()=>this.route(button.dataset.route as 'home'|'gitlab'|'settings');});
    this.host.querySelector<HTMLButtonElement>('#launcher-close')!.onclick=()=>this.hide();
    this.host.querySelector<HTMLButtonElement>('#account-close')!.onclick=()=>{ void this.closeLogin(); };
    this.host.addEventListener('keydown', event=>{if(event.key==='Escape'){event.preventDefault();if(!this.accountDialog.hidden)void this.closeLogin();else this.hide();}});
  }
  private syncProjectState() {const hasProject=this.options.hasProject();this.host.classList.toggle('launcher-workspace', !hasProject);this.host.querySelector<HTMLButtonElement>('#launcher-close')!.hidden=!hasProject;}
  captureState():LauncherSnapshot {return {revision:this.loadId,hidden:this.host.hasAttribute('hidden')};}
  isCurrent(snapshot:LauncherSnapshot):boolean {return snapshot.revision===this.loadId && snapshot.hidden===this.host.hasAttribute('hidden');}
  completeOpen(snapshot:LauncherSnapshot, mayClose=true) {if(this.host.hidden)return;this.syncProjectState();if(mayClose && this.isCurrent(snapshot))this.hide();}
  show(route:'home'|'gitlab'|'settings'='home') { this.host.hidden=false;this.syncProjectState();this.route(route); }
  hide() { if (!this.options.hasProject()) { this.route('home'); return; } this.loadId++;this.selected=null;this.unmountPlugins();this.host.hidden=true;this.host.classList.remove('launcher-workspace');void this.closeLogin(); }
  private route(route:'home'|'gitlab'|'settings') {
    this.unmountPlugins();this.loadId++;this.selected=null;
    this.host.querySelectorAll<HTMLButtonElement>('[data-route]').forEach(item=>{const active=item.dataset.route===route;item.classList.toggle('selected',active);if(active)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');});
    if(route==='home')this.home();else if(route==='gitlab')void this.gitlab();else void this.settings();
  }
  private unmountPlugins() {
    const cleanup=this.pluginsCleanup;this.pluginsCleanup=null;
    if(cleanup)try{cleanup();}catch(error){this.options.notify(error);}
  }
  private replaceBody(...nodes:(Node|string)[]) {
    this.unmountPlugins();this.body.replaceChildren(...nodes);
  }
  private button(label:string, action:()=>void, className='launcher-button') {const b=element('button',className,label);b.type='button';b.onclick=action;return b;}
  private async openAndActivate(open:()=>Promise<Project|null>):Promise<boolean> {
    const snapshot=this.captureState(),intent=this.options.beginProjectIntent();
    const project=await open();if(!project)return false;
    this.options.rememberProject(project);
    if(!this.isCurrent(snapshot)){this.options.notify('Projeto disponível nos recentes.');return true;}
    if(await this.options.activateProject(project,intent))this.completeOpen(snapshot,this.options.isCurrentIntent(intent));
    return true;
  }
  private renderLocalRecents(list:HTMLElement) {
    const focused=document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-recent-path]')?.dataset.recentPath : undefined;
    const projects=this.options.getProjects();list.replaceChildren();
    if(!projects.length)list.append(element('p','launcher-muted','Nenhum projeto local recente.'));
    for(const project of projects){const row=this.button('',()=>{void this.openAndActivate(()=>window.dk.activateProject(project.path)).catch(this.options.notify);},'launcher-recent');row.dataset.recentPath=project.path;const name=element('strong','',project.title||project.name),detail=element('small','',project.path);row.append(name,detail);list.append(row);}
    if(focused)[...list.querySelectorAll<HTMLButtonElement>('[data-recent-path]')].find(row=>row.dataset.recentPath===focused)?.focus();
  }
  refreshRecents() {const list=this.body.querySelector<HTMLElement>('#launcher-local-recents');if(list)this.renderLocalRecents(list);}
  private actionCard(label:string,description:string,symbol:string,action:()=>void,id:string) {
    const card=this.button('',action,'launcher-card');card.id=id;card.setAttribute('aria-label',label);
    const text=element('span','launcher-card-copy');text.append(element('strong','',label),element('small','',description));
    card.append(mark(symbol),text,mark('arrow','launcher-card-arrow'));return card;
  }
  private home() {
    this.title.textContent='Seu espaço de trabalho';this.replaceBody();
    const intro=element('p','launcher-intro','Seus projetos, terminais e ferramentas em um só lugar.');
    const layout=element('div','welcome-layout');
    const start=element('section','welcome-start');
    start.append(element('h2','welcome-heading','Começar'));
    const actions=element('div','launcher-cards');
    const create=this.actionCard('Criar projeto do zero','Comece com uma pasta vazia','plus',()=>this.newProject(),'launcher-create-project');
    const local=this.actionCard('Abrir projeto local','Continue em uma pasta existente','folder',()=>{void this.openAndActivate(()=>window.dk.selectProject()).catch(this.options.notify);},'launcher-open-local');
    const remote=this.actionCard('Abrir projeto GitLab SEA','Projetos do grupo Design','git',()=>this.route('gitlab'),'launcher-open-gitlab');
    actions.append(create,local,remote);start.append(actions,element('h2','launcher-section','Projetos recentes'));
    const list=element('div','launcher-recents');list.id='launcher-recents';const remotes=this.options.getRemoteProjects();
    list.append(element('h3','launcher-recent-heading','Locais'));
    const locals=element('div','launcher-local-recents');locals.id='launcher-local-recents';this.renderLocalRecents(locals);list.append(locals);
    list.append(element('h3','launcher-recent-heading','GitLab SEA'));
    if(!remotes.length)list.append(element('p','launcher-muted','Nenhum projeto remoto recente.'));
    for(const project of remotes){const row=this.button('',()=>{void this.openRemote(project.id);},'launcher-recent');row.append(element('strong','',project.name),element('small','',`GitLab · ${project.path}`));list.append(row);}
    start.append(list);
    const setup=element('section','welcome-setup');setup.append(element('h2','welcome-heading','Seu ambiente'));
    const settings=this.actionCard('Perfil e configurações','Contas, aparência e ferramentas','settings',()=>this.route('settings'),'welcome-settings');settings.classList.add('welcome-settings');
    setup.append(settings);
    const hint=element('p','launcher-muted launcher-environment','Verificando ferramentas instaladas…');setup.append(hint);const token=this.loadId;
    layout.append(start,setup);this.body.append(intro,layout);
    void window.dk.checkTools().then(tools=>{if(token!==this.loadId)return;const missing=tools.filter(item=>!item.available);hint.textContent=missing.length?`${missing.length} ferramenta(s) precisam de atenção. Confira em Perfil e configurações.`:'Ferramentas disponíveis. Confira os detalhes em Perfil e configurações.';}).catch(()=>{if(token===this.loadId)hint.textContent='Não foi possível verificar as ferramentas.';});
  }
  private newProject() {
    this.loadId++;this.selected=null;this.title.textContent='Criar projeto';this.replaceBody();
    this.host.querySelectorAll<HTMLButtonElement>('[data-route]').forEach(item=>item.classList.remove('selected'));
    this.body.append(element('p','launcher-intro','Crie uma pasta vazia para começar. Escolha o local na próxima etapa.'));
    const form=element('form','new-project-form');
    const label=element('label','', 'Nome do projeto');label.htmlFor='new-project-name';
    const name=document.createElement('input');name.id='new-project-name';name.placeholder='Ex.: meu-projeto';name.maxLength=120;name.required=true;name.autocomplete='off';
    const actions=element('div','launcher-remote-actions');const back=this.button('Voltar',()=>this.route('home'));
    const create=element('button','launcher-button primary','Escolher pasta e criar');create.type='submit';actions.append(back,create);
    const status=element('p','launcher-muted');status.setAttribute('role','status');
    form.append(label,name,actions,status);this.body.append(form);
    form.onsubmit=event=>{event.preventDefault();const value=name.value.trim();if(!value){name.focus();return;}create.disabled=true;status.textContent='Escolha o local para a nova pasta.';
      void this.openAndActivate(()=>window.dk.createProject(value)).then(opened=>{if(!opened && status.isConnected)status.textContent='Nenhuma pasta foi criada.';}).catch(error=>{status.textContent=error instanceof Error?error.message:String(error);this.options.notify(error);}).finally(()=>{create.disabled=false;});};
    name.focus();
  }
  private async gitlab(query='',page=1) {
    const token=++this.loadId;this.title.textContent='Projetos GitLab · Design';this.query=query;this.page=page;this.replaceBody();
    this.body.append(element('p','launcher-intro','Projetos do grupo Design e seus subgrupos. Uma cópia local só é criada quando você solicitar.'));
    const form=element('form','launcher-search');const field=document.createElement('input');field.placeholder='Buscar projetos';field.setAttribute('aria-label','Buscar projetos no GitLab');field.value=query;
    const search=element('button','launcher-button','Buscar');search.type='submit';form.append(field,search);form.onsubmit=e=>{e.preventDefault();void this.gitlab(field.value,1);};this.body.append(form);
    const status=element('p','launcher-muted','Consultando projetos…');const list=element('div','launcher-recents');list.id='gitlab-projects';this.body.append(status,list);
    try {const result=await window.dk.gitlabProjects(query,page);if(token!==this.loadId)return;status.textContent=result.items.length?'Escolha um projeto.':'Nenhum projeto encontrado.';
      const rows=new Map<number,HTMLElement>();
      for(const item of result.items){const row=this.button('',()=>{void this.openRemote(item.id);},'launcher-recent gitlab-project');const copy=element('span','gitlab-project-copy');copy.append(element('strong','',item.name),element('small','',item.path));row.append(mark('git'),copy,mark('arrow','launcher-card-arrow'));rows.set(item.id,copy);list.append(row);}
      if(result.items.length){
        const localStatus=element('div','gitlab-local-status');localStatus.setAttribute('role','status');this.body.append(localStatus);
        const check=async(refresh=false)=>{localStatus.replaceChildren(element('span','','Buscando cópias no volume SEA…'));
          try {const found=await window.dk.gitlabLocalProjects(result.items.map(item=>item.id),refresh);if(token!==this.loadId||!localStatus.isConnected)return;
            for(const [id,row] of rows){row.querySelector('.gitlab-local-badge')?.remove();if(found.ids.includes(id))row.append(element('span','gitlab-local-badge','Cópia local'));}
            localStatus.replaceChildren(element('span','',!found.available?'Volume SEA ou Git indisponível.':found.incomplete?'Busca local parcial.':'Busca local concluída.'));
            if(found.available&&found.incomplete)localStatus.append(this.button('Continuar busca',()=>{void check(true);},'remote-more'));
          }catch{if(token===this.loadId&&localStatus.isConnected)localStatus.textContent='Não foi possível verificar as cópias locais.';}
        };void check();
      }
      const controls=element('div','launcher-pagination');if(page>1)controls.append(this.button('Página anterior',()=>{void this.gitlab(query,page-1);}));if(result.hasMore)controls.append(this.button('Próxima página',()=>{void this.gitlab(query,page+1);}));this.body.append(controls);
    }catch{if(token!==this.loadId)return;status.textContent='Não foi possível consultar o GitLab SEA. Verifique a conexão e entre com sua conta nas configurações.';this.body.append(this.button('Conectar GitLab',()=>this.route('settings')));}
  }
  private async openRemote(id:number) {
    const token=++this.loadId;this.title.textContent='Abrindo projeto';this.replaceBody(element('p','launcher-muted','Consultando o GitLab…'));
    try {const project=await window.dk.gitlabProject(id);if(token!==this.loadId)return;this.selected=project;this.options.rememberRemote(project);this.remoteProject(project);}
    catch(error){if(token===this.loadId){this.replaceBody(element('p','launcher-error','Não foi possível abrir o projeto. Verifique a conexão e a conta do GitLab.'));this.body.append(this.button('Voltar aos projetos',()=>this.route('gitlab')));}this.options.notify(error);}
  }
  private remoteProject(project:RemoteProject) {
    this.title.textContent=project.name;this.replaceBody();
    const info=element('p','launcher-intro',`${project.path} · ${project.branch} · Somente leitura`);
    const tools=element('div','launcher-remote-actions');tools.append(this.button('Voltar aos projetos',()=>this.route('gitlab')));
    const prepare=this.button('Preparar cópia local',()=>{prepare.disabled=true;prepare.textContent='Preparando cópia…';void this.openAndActivate(()=>window.dk.gitlabLocal(project.id)).catch(this.options.notify).finally(()=>{prepare.disabled=false;prepare.textContent='Preparar cópia local';});},'launcher-button primary');prepare.id='remote-prepare';tools.append(prepare);
    const work=element('div','remote-work');const tree=element('div','remote-tree');tree.setAttribute('aria-label','Arquivos no GitLab');const viewer=element('div','remote-viewer');viewer.append(element('p','launcher-muted','Selecione um arquivo para visualizar.'));
    const local=element('section','remote-local');local.setAttribute('aria-label','Cópias no volume SEA');prepare.disabled=true;
    work.append(tree,viewer);this.body.append(info,local,tools,work);void this.findLocal(project,local).finally(()=>{if(this.selected===project)prepare.disabled=false;});void this.loadTree(project,tree,'',1,viewer);
  }
  private async findLocal(project:RemoteProject,container:HTMLElement,refresh=false) {
    const heading=element('strong','','Cópias no volume SEA');const status=element('p','launcher-muted','Procurando cópias locais…');
    container.replaceChildren(heading,status);
    try {
      const result=await window.dk.gitlabLocalMatches(project.id,refresh);
      if(this.selected!==project || !container.isConnected || this.host.hidden)return;
      if(!result.available) status.textContent='Não foi possível consultar o volume SEA ou o Git. Você pode abrir uma pasta pelo seletor local.';
      else if(!result.paths.length) status.textContent=result.incomplete?'A busca foi parcial e não encontrou cópias. Você pode verificar novamente ou abrir uma pasta pelo seletor local.':'Nenhuma cópia correspondente encontrada nas pastas verificadas do volume SEA.';
      else status.textContent=result.incomplete?'Cópias encontradas. A busca foi parcial.':'Escolha uma cópia para abrir:';
      for(const folder of result.paths) {
        const row=element('div','remote-local-row');const label=element('span','',folder);label.title=folder;
        const open=this.button('Abrir projeto',()=>{open.disabled=true;void this.openAndActivate(()=>window.dk.gitlabOpenExisting(project.id,folder)).catch(this.options.notify).finally(()=>{open.disabled=false;});},'launcher-button');
        row.append(label,open);container.append(row);
      }
      container.append(this.button(result.incomplete?'Continuar busca':'Verificar novamente',()=>{void this.findLocal(project,container,true);},'remote-more'));
    } catch(error) { if(this.selected===project&&container.isConnected&&!this.host.hidden){status.textContent='Não foi possível verificar as cópias locais.';this.options.notify(error);} }
  }
  private async loadTree(project:RemoteProject,container:HTMLElement,folder:string,page:number,viewer:HTMLElement) {
    const note=element('p','launcher-muted','Carregando…');container.append(note);
    try {const listing=await window.dk.gitlabTree(project.id,folder,page);if(this.selected!==project||!container.isConnected)return;note.remove();
      for(const entry of listing.entries){const row=element('div','remote-entry');const control=this.button(`${entry.kind==='directory'?'▸':'◇'}  ${entry.name}`,()=>{if(entry.kind==='directory'){const existing=row.querySelector<HTMLElement>('.remote-children');if(existing){existing.hidden=!existing.hidden;return;}const children=element('div','remote-children');row.append(children);void this.loadTree(project,children,entry.path,1,viewer);}else void this.loadFile(project,entry.path,viewer);},'remote-entry-button');row.append(control);container.append(row);}
      if(listing.hasMore){const more=this.button('Mostrar mais',()=>{more.remove();void this.loadTree(project,container,folder,page+1,viewer);},'remote-more');container.append(more);}
      if(!listing.entries.length&&page===1)container.append(element('p','launcher-muted','Pasta vazia.'));
    }catch(error){note.textContent='Não foi possível ler esta pasta.';this.options.notify(error);}
  }
  private async loadFile(project:RemoteProject,name:string,viewer:HTMLElement) {
    viewer.replaceChildren(element('p','launcher-muted','Carregando arquivo…'));viewer.dataset.file=name;
    try {const result=await window.dk.gitlabFile(project.id,name);if(this.selected!==project||viewer.dataset.file!==name)return;const label=element('div','remote-file-label',`${result.name} · somente leitura`);if(result.kind==='image' && result.dataUrl){const img=document.createElement('img');img.className='remote-image';img.src=result.dataUrl;img.alt=result.name;viewer.replaceChildren(label,img);}else viewer.replaceChildren(label,element('pre','remote-file',result.content || ''));}
    catch(error){if(viewer.dataset.file===name)viewer.replaceChildren(element('p','launcher-error','Não foi possível visualizar este arquivo.'));this.options.notify(error);}
  }
  private async settings(refresh=false) {
    const token=++this.loadId;this.title.textContent='Perfil e configurações';this.replaceBody();
    this.body.append(element('p','launcher-intro','Preferências deste computador e conexões usadas pelo SEA Dock.'));
    const grid=element('div','settings-grid');const appearance=this.section('Aparência e terminal'),alerts=this.section('Avisos de atividade'),accounts=this.section('Contas'),tools=this.section('Ferramentas instaladas'),plugins=this.section('Plugins');
    const left=element('div','settings-column'),right=element('div','settings-column');left.append(appearance,accounts);right.append(alerts,tools);
    const diagnostics=this.section('Diagnóstico');diagnostics.querySelector('.settings-heading-note')!.textContent='Colete logs para enviar ao suporte.';diagnostics.dataset.testid='settings-debug';mountDebugSettings(diagnostics,this.options.notify);right.append(diagnostics);
    plugins.classList.add('settings-plugins-section');const pluginTitle=plugins.querySelector('h2')!;pluginTitle.id='settings-plugins-title';plugins.setAttribute('aria-labelledby',pluginTitle.id);
    const pluginHost=element('div','settings-plugins-host');pluginHost.dataset.testid='settings-plugins';plugins.append(pluginHost);
    grid.append(left,right,plugins);this.body.append(grid,element('p','settings-note settings-about','Serviços e suas funções são definidos no projeto. Extensões e modelos de Claude e Codex continuam sob configuração das ferramentas oficiais. As cotas podem ser consultadas na guia Consumo.'));
    try {
      const cleanup=this.options.mountPlugins(pluginHost);
      if(typeof cleanup!=='function')throw new Error('Não foi possível preparar a seção de plugins.');
      if(token!==this.loadId || this.host.hidden || !pluginHost.isConnected)cleanup();else this.pluginsCleanup=cleanup;
    } catch(error) {
      if(token===this.loadId && !this.host.hidden && pluginHost.isConnected){pluginHost.replaceChildren(element('p','launcher-error','Não foi possível carregar os plugins.'));this.options.notify(error);}
    }
    const toggle=(label:string,checked:boolean,change:(value:boolean)=>void)=>{const row=element('label','settings-row');const text=element('span','',label),input=document.createElement('input');input.type='checkbox';input.checked=checked;input.onchange=()=>change(input.checked);row.append(text,input);return row;};
    appearance.append(toggle('Tema SEA',document.body.classList.contains('theme-sea'),value=>this.options.theme(value)),toggle('Sidebar recolhida',document.body.classList.contains('sidebar-collapsed'),value=>this.options.sidebar(value)));
    const transparency=element('div','glass-transparency');
    const transparencyLabel=element('label','','Transparência');transparencyLabel.htmlFor='glass-transparency';
    const slider=document.createElement('input');slider.type='range';slider.id='glass-transparency';slider.min='0';slider.max='60';slider.step='1';slider.value=String(this.options.getGlassAmount());
    const amount=element('output','glass-transparency-value',`${slider.value}%`);amount.htmlFor='glass-transparency';
    slider.disabled=!document.body.classList.contains('appearance-glass');slider.setAttribute('aria-valuetext',`${slider.value}%`);
    slider.oninput=()=>{this.options.glassAmount(Number(slider.value));amount.textContent=`${slider.value}%`;slider.setAttribute('aria-valuetext',`${slider.value}%`);};
    transparency.append(transparencyLabel,slider,amount);
    const glass=toggle('Efeito de vidro (glassmorphism)',document.body.classList.contains('appearance-glass'),value=>{this.options.glass(value);slider.disabled=!value;});
    const glassNote=element('p','settings-note','Ajuste os painéis do tema atual. A redução de transparência do sistema prevalece.');glassNote.id='glass-appearance-note';
    glass.querySelector('input')!.setAttribute('aria-describedby',glassNote.id);slider.setAttribute('aria-describedby',glassNote.id);
    appearance.append(glass,transparency,glassNote);
    const selectRow=(label:string,values:number[],value:number,change:(n:number)=>void)=>{const row=element('label','settings-row');const select=document.createElement('select');select.append(...values.map(n=>option(String(n),String(n))));select.value=String(value);select.onchange=()=>change(Number(select.value));row.append(element('span','',label),select);return row;};
    const prefs=this.options.preferences,update=()=>this.options.applyPreferences();
    appearance.append(toggle('Cursor piscando',prefs.cursorBlink,value=>{prefs.cursorBlink=value;update();}),selectRow('Tamanho da fonte', [11,12,13,14,15,16,18],prefs.fontSize,n=>{prefs.fontSize=n;update();}),selectRow('Linhas de histórico', [1000,5000,10000,20000],prefs.scrollback,n=>{prefs.scrollback=n;update();}));
    alerts.append(toggle('Avisar sobre sessões sem atividade',prefs.idleAlerts,value=>{prefs.idleAlerts=value;update();}),selectRow('Minutos sem comunicação',[15,30,60,120],prefs.idleMinutes,n=>{prefs.idleMinutes=n;update();}),selectRow('Memória mínima (MiB)',[32,64,128,256,512],prefs.idleMemoryMiB,n=>{prefs.idleMemoryMiB=n;update();}),element('p','settings-note','O aviso pede confirmação e não encerra sessões automaticamente.'));
    for(const provider of ['sea','gitlab'] as const){const row=element('div','account-row');const text=element('div');text.append(element('strong','',provider==='sea'?'Conta SEA':'GitLab SEA'));const state=element('small','','Verificando…');text.append(state);const login=this.button('Entrar',()=>{void this.login(provider);},'launcher-button');row.append(text,login);accounts.append(row);void window.dk.accountStatus(provider).then(result=>{if(token!==this.loadId)return;state.textContent=result.status==='connected'?result.name||'Conectada':result.status==='missing'?'Ferramenta não instalada':'Não conectado ou indisponível';}).catch(()=>{if(token===this.loadId)state.textContent='Não foi possível verificar.';});}
    const rows=element('div','tools-list');tools.append(this.button('Verificar novamente',()=>{void this.settings(true);}),rows);rows.textContent='Verificando…';try {const found=await window.dk.checkTools(refresh);if(token!==this.loadId)return;rows.replaceChildren();for(const tool of found){const row=element('div','tool-row');const text=element('div');text.append(element('strong','',tool.name),element('small','',tool.purpose+(tool.id==='codex'?' · opcional':'')));row.append(text,element('span',tool.available?'tool-ok':'tool-missing',tool.available?tool.version||'Disponível':tool.installed?'Não foi possível verificar':'Não encontrado'));rows.append(row);}}catch{if(token===this.loadId)rows.textContent='Não foi possível verificar as ferramentas.';}
  }
  private section(title:string){
    const symbols:Record<string,string>={'Aparência e terminal':'settings','Avisos de atividade':'activity','Contas':'user','Ferramentas instaladas':'tool','Plugins':'tool'};
    const descriptions:Record<string,string>={'Aparência e terminal':'Personalize seu espaço de trabalho.','Avisos de atividade':'Defina quando receber avisos.','Contas':'Gerencie suas conexões.','Ferramentas instaladas':'Confira o que está disponível.','Plugins':'Gerencie extensões e permissões.'};
    const box=element('section','settings-section'),heading=element('div','settings-heading'),copy=element('div','settings-heading-copy');
    copy.append(element('h2','',title),element('p','settings-heading-note',descriptions[title]||''));heading.append(mark(symbols[title]||'settings'),copy);box.append(heading);return box;
  }
  private async login(provider:'sea'|'gitlab') {
    const routeToken=this.loadId,closeGeneration=this.loginGeneration+1;
    await this.closeLogin(false);
    if(this.host.hidden || routeToken!==this.loadId || closeGeneration!==this.loginGeneration)return;
    const generation=++this.loginGeneration;this.accountDialog.hidden=false;this.host.querySelector('#account-title')!.textContent=provider==='sea'?'Entrar com SEA CLI':'Entrar no GitLab SEA';const status=this.host.querySelector<HTMLElement>('#account-status')!;status.textContent='Iniciando…';
    const target=this.host.querySelector<HTMLElement>('#account-terminal')!;target.replaceChildren();let info:SessionInfo|undefined,terminal:Terminal|undefined;let offData=()=>{},offExit=()=>{};
    try {info=await window.dk.startAccount(provider);if(this.accountDialog.hidden||generation!==this.loginGeneration){await window.dk.closeTerminal(info.id);return;}
      const [{Terminal},{FitAddon}]=await Promise.all([import('@xterm/xterm'),import('@xterm/addon-fit')]);if(this.accountDialog.hidden||generation!==this.loginGeneration){await window.dk.closeTerminal(info.id);return;}
      const id=info.id;terminal=new Terminal({cursorBlink:this.options.preferences.cursorBlink,fontSize:13,scrollback:0,theme:{background:'#10181d',foreground:'#e8eff0'},disableStdin:true});const fit=new FitAddon();terminal.loadAddon(fit);terminal.open(target);fit.fit();terminal.onData(data=>{void window.dk.writeTerminal(id,data).catch(this.options.notify);});
      offData=window.dk.onTerminalData(event=>{if(event.id===id)terminal!.write(event.data,()=>{void window.dk.acknowledgeTerminal(id,event.data.length).catch(()=>{});});});
      offExit=window.dk.onTerminalExit(event=>{if(event.id!==id || generation!==this.loginGeneration)return;status.textContent=event.exitCode===0?'Autenticação concluída. Feche esta janela para atualizar o perfil.':`Autenticação encerrada (${event.exitCode}).`;terminal!.options.disableStdin=true;});
      const owned=terminal,ownedElement=terminal.element;this.activeLogin={id,terminal:owned,cleanup:()=>{offData();offExit();owned.dispose();ownedElement?.remove();}};
      await window.dk.startTerminal(id,{cols:terminal.cols,rows:terminal.rows});if(generation!==this.loginGeneration||this.accountDialog.hidden)return;terminal.options.disableStdin=false;status.textContent='Siga as instruções da ferramenta.';terminal.focus();
    }catch(error){if(info)await window.dk.closeTerminal(info.id).catch(()=>{});offData();offExit();terminal?.dispose();if(this.activeLogin?.id===info?.id)this.activeLogin=null;if(generation===this.loginGeneration){status.textContent='Não foi possível iniciar a autenticação.';this.options.notify(error);}}
  }
  private async closeLogin(refreshSettings=true){
    const generation=++this.loginGeneration,routeToken=this.loadId,active=this.activeLogin;
    this.activeLogin=null;this.accountDialog.hidden=true;
    if(active){
      await window.dk.closeTerminal(active.id).catch(()=>{});active.cleanup();
      // Do not undo a later navigation or refresh over a newer login.
      if(refreshSettings && !this.host.hidden && routeToken===this.loadId && generation===this.loginGeneration)this.route('settings');
    }
  }
}
