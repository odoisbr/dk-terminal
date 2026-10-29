import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import logoUrl from '../assets/dk-logo.svg';
import seaLogo from '../assets/sea-horizontal-white.png';
import seaLogoCompact from '../assets/sea-vertical-white.png';
import claudeIcon from '../assets/claude.svg';
import codexIcon from '../assets/codex.png';
import antigravityIcon from '../assets/antigravity.svg';
import geminiIcon from '../assets/gemini.svg';
import { renderOrchestration } from './orchestration';
import { renderUsage } from './usage';
import { Launcher } from './launcher';
import { GitView } from './git-view';
import { TreeMenu } from './tree-menu';
import { createPluginsPanel } from './plugins';
import { ViewRegistry } from './views';
import { playSeaMotion } from './sea-motion.mjs';
import './plugins.css';

const startupMotion = playSeaMotion(document.querySelector<SVGSVGElement>('#sea-motion-stage'));

const paths: Record<string, string> = {
  home: '<path d="M3 11 12 3l9 8M5 10v10h14V10M9 20v-6h6v6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>',
  terminal: '<path d="m5 6 6 6-6 6m8 0h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  code: '<path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 18"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
  scan: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 12h10"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  file: '<path d="M14 3H5v18h14V8Zm0 0v6h5M8 13h8m-8 4h6"/>',
  git: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m2-6h4a6 6 0 0 0 6-2"/>',
  chart: '<path d="M4 20h16M6 17v-5m5 5V7m5 10V4m4 13v-8"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  restore: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 7a7 7 0 0 1 11.6-2L20 8M4 16l2.9 3A7 7 0 0 0 18.5 17"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  splitDown: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
  detach: '<rect x="3" y="4" width="8" height="16" rx="1"/><path d="M15 8h6m-2-2 2 2-2 2M15 16h6m-2-2 2 2-2 2"/>',
  single: '<rect x="3" y="4" width="18" height="16" rx="2"/>',
  graph: '<rect x="3" y="8" width="5" height="7" rx="1"/><rect x="16" y="3" width="5" height="6" rx="1"/><rect x="16" y="15" width="5" height="6" rx="1"/><path d="M8 11h4V6h4m-4 5v7h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
};
const icon = (name: string, extra = '') => `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.terminal}</svg>`;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <aside class="sidebar">
    <div class="window-space" aria-hidden="true"></div>
    <div class="brand"><img class="brand-logo" src="${logoUrl}" alt="" /><div><strong>SEA Dock</strong><span>Seu espaço de trabalho</span></div><span class="beta">ALPHA</span></div>
    <div class="sea-signature" hidden><img class="sea-logo-wide" src="${seaLogo}" alt="SEA Tecnologia" /><img class="sea-logo-compact" src="${seaLogoCompact}" alt="SEA Tecnologia" /></div>
    <button id="open-project" class="button open-button">${icon('plus')}<span>Abrir projeto</span><kbd>⌘ O</kbd></button>
    <div class="section-label"><span>PROJETOS RECENTES</span><span id="project-count">0</span></div>
    <nav id="project-list" aria-label="Projetos recentes"></nav>
    <div class="sidebar-bottom"><div class="kit-summary"><span class="status-dot" id="kit-dot"></span><div><strong id="kit-label">Detectando plugin DK</strong><span id="kit-description">Verificando instalação do Claude</span></div></div><button id="install-dk-plugin" class="button kit-button" hidden>Instalar plugin DK no Claude</button><div id="system-resources" class="system-resources" tabindex="0" aria-label="Consumo da máquina sendo calculado"><button id="system-resources-toggle" class="system-resources-title" type="button" aria-expanded="true" aria-controls="system-resources-content"><span>MÁQUINA</span>${icon('down')}</button><div id="system-resources-content"><div class="system-resource"><span>CPU</span><strong id="system-cpu">—</strong></div><div class="system-meter"><span id="system-cpu-bar"></span></div><div class="system-resource"><span>Memória · inclui cache</span><strong id="system-memory">—</strong></div><div class="system-meter"><span id="system-memory-bar"></span></div><div class="system-resource"><span>Swap</span><strong id="system-swap">—</strong></div><div class="system-meter"><span id="system-swap-bar"></span></div><div class="resource-breakdown" aria-label="Detalhamento de memória"><div class="system-resource"><span>SEA Dock · RSS</span><strong id="system-dk-memory">—</strong></div><div class="system-resource"><span>Filhos detectados · RSS</span><strong id="system-child-memory">—</strong></div><div class="system-resource"><span>Outros processos · RSS</span><strong id="system-other-memory">—</strong></div><div class="system-resource"><span>Disponibilidade · estimada</span><strong id="system-available">—</strong></div><div class="system-resource"><span id="system-cache-label">Cache recuperável</span><strong id="system-cache">—</strong></div><div class="system-resource"><span>Pressão de memória</span><strong id="system-pressure">—</strong></div><small class="resource-breakdown-note">RSS soma páginas compartilhadas; valores não são parcelas exclusivas da memória da máquina.</small></div><button id="optimize-resources" class="button system-optimize" title="Limpar o cache do SEA Dock sem interromper projetos" aria-describedby="optimize-explanation">${icon('refresh')}Otimizar recursos</button><p id="optimize-explanation" class="system-optimize-help">Limpa apenas o cache do SEA Dock.</p><details id="mac-memory-tools" hidden><summary>Ferramentas avançadas do macOS</summary><button id="clear-system-cache" class="button system-optimize" title="Limpar cache de arquivos do macOS">Limpar cache do macOS</button><p class="system-optimize-help">Limpa cache de arquivos, não a memória dos aplicativos. Pode pedir senha e reduzir a velocidade temporariamente.</p><button id="open-activity-monitor" class="button system-optimize">Monitor de Atividade</button></details><div id="optimize-status" class="system-optimize-status" role="status" aria-live="polite"></div></div></div><div class="sidebar-footnote">LOCAL POR NATUREZA<span id="version">v—</span></div></div>
  </aside>
  <main class="workspace">
    <header class="titlebar"><button id="toggle-sidebar" class="icon-button sidebar-toggle" aria-label="Recolher sidebar" aria-expanded="true" title="Recolher ou expandir sidebar">${icon('panel')}</button><span class="breadcrumb">Workspace ${icon('chevron')} <strong id="breadcrumb-project"><span id="project-title">Início</span></strong></span><div class="titlebar-actions"><button id="reveal-project" class="icon-button" aria-label="Abrir pasta do projeto" title="Abrir pasta do projeto" hidden>${icon('folder')}</button><button id="launcher-show" class="icon-button" aria-label="Página inicial" title="Página inicial">${icon('home')}</button><button id="profile-show" class="icon-button" aria-label="Perfil e configurações" title="Perfil e configurações">${icon('settings')}</button><button id="theme-toggle" class="theme-toggle" type="button" aria-pressed="false" title="Alternar tema SEA">Tema SEA</button><span class="local-badge"><span class="status-dot ready"></span>Ambiente local</span></div></header>
    <div class="action-bar"><span class="action-label">AÇÕES DK</span><button class="button action" data-action="audit" disabled>${icon('scan')}Auditoria</button><button class="button action" data-action="validate" disabled>${icon('check')}Validar projeto</button><button class="button action" data-action="doctor" disabled>${icon('activity')}Diagnóstico</button><button class="button action" id="show-graph" disabled>${icon('graph')}Orquestração</button><span class="action-hint" id="action-hint">Instale ou ative o plugin DK para executar as ações.</span></div>
    <div id="extension-bar" class="extension-bar" aria-label="Extensões de agentes" hidden></div>
    <div class="work-area">
      <section id="terminal-view" class="terminal-card" aria-label="Área de trabalho do projeto">
        <div class="terminal-toolbar"><div class="workspace-tabs"><div id="tabs" role="tablist" aria-label="Guias do projeto"></div><div id="file-tabs"></div></div><div class="terminal-controls"><button id="single-terminal" class="icon-button" aria-label="Visualização única" title="Visualização única" hidden>${icon('single')}</button><button id="detach-pane" class="icon-button" aria-label="Separar painel ativo do split" title="Separar painel ativo do split" hidden>${icon('detach')}</button><button id="split-right" class="icon-button" aria-label="Dividir terminal à direita" title="Dividir à direita (⌘ D)" disabled>${icon('split')}</button><button id="split-down" class="icon-button" aria-label="Dividir terminal abaixo" title="Dividir abaixo (⌘ ⇧ D)" disabled>${icon('splitDown')}</button><button id="split-agent" class="icon-button" aria-label="Dividir com agente" title="Dividir com Claude, Codex ou outra ferramenta" aria-haspopup="menu" aria-expanded="false" disabled>${icon('activity')}</button><button id="launch-claude" class="icon-button agent-launch" aria-label="Abrir Claude Code" title="Abrir Claude Code" disabled><img src="${claudeIcon}" alt="" /></button><button id="launch-codex" class="icon-button agent-launch" aria-label="Abrir Codex" title="Abrir Codex" disabled><img src="${codexIcon}" alt="" /></button><button id="launch-antigravity" class="icon-button agent-launch" aria-label="Abrir Antigravity CLI" title="Abrir Antigravity CLI" hidden><img src="${antigravityIcon}" alt="" /></button><button id="launch-gemini" class="icon-button agent-launch" aria-label="Abrir Gemini CLI" title="Abrir Gemini CLI" hidden><img src="${geminiIcon}" alt="" /></button><button id="launch-dk" class="icon-button agent-launch" aria-label="Abrir DK CLI" title="Abrir DK CLI" hidden><img src="${logoUrl}" alt="" /></button><button id="open-browser" class="icon-button" aria-label="Visualizar protótipo" title="Visualizar protótipo" disabled>${icon('globe')}</button><span class="toolbar-divider" aria-hidden="true"></span><button id="expand-terminal" class="icon-button" aria-label="Expandir terminal" aria-pressed="false" title="Expandir terminal (⌘ ⇧ E)">${icon('expand')}</button><button id="search-toggle" class="icon-button" aria-label="Buscar no terminal" title="Buscar no terminal (⌘ F)" disabled>${icon('search')}</button><button id="new-session" class="icon-button" aria-label="Nova sessão" title="Nova sessão (⌘ T)" disabled>${icon('plus')}</button></div></div>
        <div id="terminal-workspace" class="terminal-workspace">
        <div id="search-bar" hidden><label for="terminal-search" class="sr-only">Buscar no terminal</label><input id="terminal-search" placeholder="Buscar nesta sessão" autocomplete="off" /><button id="search-previous" class="icon-button" aria-label="Resultado anterior">${icon('up')}</button><button id="search-next" class="icon-button" aria-label="Próximo resultado">${icon('down')}</button><button id="search-close" class="icon-button" aria-label="Fechar busca">${icon('close')}</button></div>
        <div class="terminal-content"><div id="welcome"><div class="welcome-symbol">${icon('terminal')}</div><span class="eyebrow">MENOS DISTÂNCIA ENTRE IDEIA E ENTREGA</span><h2>O projeto é o ponto de partida.</h2><p>Seu terminal, suas ferramentas e os comandos do DK.<br>Tudo no mesmo espaço, direto no seu computador.</p><button id="welcome-open" class="button primary">${icon('folder')}Abrir um projeto${icon('arrow')}</button><span class="welcome-hint">Selecione uma pasta para começar</span></div><div id="terminal-empty" hidden><span class="welcome-symbol small">${icon('terminal')}</span><h2>Espaço pronto.</h2><p>Abra um terminal quando precisar.</p><button id="empty-new" class="button primary">${icon('plus')}Nova sessão</button></div><div id="terminal-host"><section id="editor-view" class="editor-card" aria-label="Editor de arquivos" hidden><div id="editor-content"></div></section></div></div>
        <footer class="terminal-footer"><span><span class="status-dot" id="session-dot"></span><span id="session-state" role="status" aria-live="polite">Nenhuma sessão aberta</span></span><span id="session-dimensions">UTF-8</span></footer>
        </div>
        <section id="browser-view" class="browser-card" role="tabpanel" aria-labelledby="browser-tab" aria-label="Browser do projeto" hidden><div class="auxiliary-toolbar"><strong>${icon('globe')}Browser</strong><button id="browser-fullscreen" class="icon-button" aria-label="Abrir browser em tela cheia" aria-pressed="false" title="Abrir browser em tela cheia">${icon('expand')}</button><button id="browser-copy-ai" class="button secondary" title="Copia o texto que ensina qualquer IA a usar dock-preview">Copiar instrução para IA</button><button id="browser-back" class="button secondary">Voltar ao terminal</button></div><div class="browser-runtime"><label for="browser-service">Serviço</label><select id="browser-service" aria-label="Serviço para visualizar"></select><button id="browser-start" class="button primary">Executar projeto</button><button id="browser-stop" class="icon-button" aria-label="Desligar serviço da prévia" title="Desligar serviço" disabled>${icon('stop')}</button></div><form id="browser-navigation" class="browser-navigation"><label for="browser-address" class="sr-only">Endereço local da prévia</label><input id="browser-address" type="text" placeholder="http://localhost:5173" autocomplete="off" spellcheck="false" /><button type="submit" class="icon-button" aria-label="Abrir endereço local" title="Abrir ou recarregar endereço">${icon('arrow')}</button></form><div id="browser-canvas"><div id="browser-placeholder">Selecione um serviço ou informe o endereço local do projeto.</div></div><footer class="auxiliary-footer"><span id="browser-status">Projeto local · A página pode acessar a rede</span></footer></section>
      </section>
      <section id="graph-view" class="graph-card" aria-label="Orquestração do DK" hidden><div class="auxiliary-toolbar"><strong>${icon('graph')}Orquestração do DK</strong><button id="refresh-graph" class="icon-button" aria-label="Atualizar grafo">${icon('refresh')}</button><button id="graph-back" class="button secondary">Voltar ao terminal</button></div><div id="graph-content"></div><footer class="auxiliary-footer">Visualização dos registros locais do DK</footer></section>
      <section id="action-view" class="action-card" aria-label="Resultado do DK" hidden><div class="auxiliary-toolbar"><strong>${icon('scan')}Resultado do DK</strong><button id="cancel-action" class="button secondary" hidden>Interromper</button><button id="action-back" class="button secondary">Voltar ao terminal</button></div><div id="action-content" role="status" aria-live="polite"></div></section>
      <section id="chat-view" class="chat-card" aria-label="Codex" hidden></section>
      <div class="project-inspector">
        <aside id="project-inspector-panel" class="context-panel" aria-label="Painel do projeto" hidden>
          <section id="panel-git" class="inspector-panel" aria-labelledby="tab-git" tabindex="0" hidden></section>
          <section id="panel-context" class="inspector-panel" aria-labelledby="tab-context" tabindex="0" hidden><div class="context-heading">${icon('code')}<h2>Contexto do projeto</h2></div><div id="context-empty"><p>Ao abrir uma pasta, você verá aqui a estrutura reconhecida pelo DK.</p><div class="context-illustration"><span>projeto.yml</span><span>.dk/projeto.json</span><span>.git/</span></div></div><div id="context-details" hidden><div class="context-label">PASTA ATIVA</div><strong id="context-name"></strong><span class="project-tag" id="context-kind"></span><div class="context-label files-label">ESTRUTURA RECONHECIDA</div><ul id="project-files"></ul><p class="context-note" id="context-note"></p></div><div class="context-tip"><span class="tip-number">01 / ESPAÇO LOCAL</span><p>Cada sessão fica na pasta em que foi aberta. Troque de projeto sem misturar seus terminais.</p></div></section>
          <section id="panel-services" class="inspector-panel" aria-labelledby="tab-services" tabindex="0" hidden><p id="services-placeholder" class="context-note">Abra um projeto para acompanhar seus serviços.</p><div id="services-section" class="services-section" hidden><div class="section-label"><span>SERVIÇOS DO PROJETO</span><span id="service-count">0</span></div><div id="service-list"></div></div><div id="preview-ai" class="preview-ai" hidden><div class="section-label"><span>APRESENTAR COM IA</span></div><p class="context-note">Agentes abertos pelo SEA Dock mostram protótipos, telas e documentos no navegador do app com <code>dock-preview &lt;alvo&gt;</code>. Copie a instrução e cole no chat da IA ou no AGENTS.md, CLAUDE.md ou GEMINI.md do projeto.</p><button id="preview-ai-copy" class="button secondary preview-ai-copy">Copiar instrução para IA</button></div></section>
          <section id="panel-files" class="inspector-panel" aria-labelledby="tab-files" tabindex="0" hidden><div class="tree-toolbar tree-project-heading"><span class="tree-project-symbol">${icon('folder')}</span><div class="tree-project-copy"><span>ARQUIVOS DO PROJETO</span><strong id="tree-project-name">Pasta do projeto</strong></div><button id="refresh-tree" class="icon-button" aria-label="Atualizar árvore de pastas" title="Atualizar árvore">${icon('refresh')}</button></div><p id="tree-placeholder" class="context-note">Abra um projeto para visualizar suas pastas e arquivos.</p><div id="folder-tree" aria-label="Pastas e arquivos do projeto"></div></section>
          <section id="panel-usage" class="inspector-panel" aria-labelledby="tab-usage" tabindex="0" hidden><div class="tree-toolbar"><strong>Contas e uso</strong><button id="refresh-usage" class="icon-button" aria-label="Atualizar consumo" title="Consultar ferramentas oficiais">${icon('refresh')}</button></div><p id="usage-status" class="context-note"></p><div id="usage-content"></div></section>
        </aside>
        <nav id="project-inspector-rail" class="inspector-rail" aria-label="Ferramentas do projeto">
          <button id="tab-files" type="button" aria-label="Pasta" title="Pasta" aria-expanded="false" aria-controls="panel-files" data-panel="files">${icon('folder')}</button>
          <button id="tab-git" type="button" aria-label="Git" title="Git" aria-expanded="false" aria-controls="panel-git" data-panel="git">${icon('git')}</button>
          <button id="tab-context" type="button" aria-label="Contexto" title="Contexto" aria-expanded="false" aria-controls="panel-context" data-panel="context">${icon('code')}</button>
          <button id="tab-services" type="button" aria-label="Serviços" title="Serviços" aria-expanded="false" aria-controls="panel-services" data-panel="services">${icon('activity')}</button>
          <button id="tab-usage" type="button" aria-label="Consumo" title="Consumo" aria-expanded="false" aria-controls="panel-usage" data-panel="usage">${icon('chart')}</button>
        </nav>
      </div>
    </div>
    <footer class="workspace-footer"><span class="workspace-signature">SEA DOCK<span class="footer-divider">/</span>FEITO PARA CONSTRUIR</span><div class="footer-status"><span id="resource-indicator" class="resource-indicator" role="group" tabindex="0" aria-label="Consumo de recursos sendo calculado" title="Calculando consumo de recursos…"><span class="resource-scope" id="resource-scope"></span><span class="resource-metric"><span>CPU</span><strong id="resource-cpu">—</strong></span><span class="resource-metric"><span>RAM</span><strong id="resource-memory">—</strong></span></span><span id="session-count">0 sessões</span></div></footer>
  </main><aside id="idle-notice" class="idle-notice" role="status" aria-live="polite" hidden><strong>Sessão sem atividade recente</strong><p id="idle-description"></p><small>A sessão pode estar aguardando uma operação. Ela só será encerrada se você confirmar.</small><div><button id="idle-keep" class="button secondary">Manter sessão</button><button id="idle-close" class="button secondary">Encerrar sessão</button></div></aside><div id="split-menu" role="menu" aria-label="Dividir com agente" hidden></div><div id="toast" role="status" aria-live="polite" hidden></div>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => $<HTMLButtonElement>(id);
const api = window.dk;
type Session = SessionInfo & { terminal: Terminal; fit: FitAddon; search?: SearchAddon; searchLoading?: Promise<SearchAddon | null>; element: HTMLDivElement; started: boolean; exited: boolean; closing?: boolean; exitCode?: number; ackPending: number; ackTimer?: ReturnType<typeof setTimeout>; lastSize?: { cols: number; rows: number } };
const sessions = new Map<string, Session>();
let projects: Project[] = [], recentProjects: Project[] = [], remoteProjects: {id:number;name:string;path:string}[] = [], current: Project | null = null, activeId: string | null = null;
let pluginStatus: ClaudePlugin['status'] | 'checking' = 'checking';
let kit: Bootstrap['kit'] = null, busy = false, toastTimer: ReturnType<typeof setTimeout>;
let opening = Promise.resolve();
let agentOpening: { root: string; name: string } | null = null;
let activationGeneration = 0;
let projectIntent = 0, appliedProjectIntent = 0;
function beginProjectIntent() { return ++projectIntent; }
let installedExtensions: Extension[] = [];
const lastActive = new Map<string, string>();
const projectWorkspaceViews = new Map<string, 'terminal' | 'editor'>();
const closingProjects = new Set<string>();
const changingBranches = new Set<string>();
const projectServices = new Map<string, Service[]>();
const projectDependencyPlans = new Map<string, DependencyPlan>();
const serviceLogs = new Set<string>();
const paneGroups = new Map<string, { ids: string[]; direction: 'right' | 'down' }>();
type InspectorPanel = 'context' | 'services' | 'files' | 'usage' | 'git';
let selectedPanel: InspectorPanel | null = null;
let treeProject: string | null = null;
let treeRequest = 0;
type MainView = 'terminal' | 'graph' | 'browser' | 'editor' | 'chat' | 'action';
let mainView: MainView = 'terminal';
let workspaceView: 'terminal' | 'editor' = 'terminal';
const views = new ViewRegistry<MainView>();
views.register('terminal', [$('terminal-view'), $('terminal-workspace')]);
views.register('editor', [$('terminal-view'), $('terminal-workspace'), $('editor-view')]);
views.register('graph', [$('graph-view')]);
views.register('browser', [$('terminal-view'), $('browser-view')]);
views.register('chat', [$('chat-view')]);
views.register('action', [$('action-view')]);
let focusedPane: 'terminal' | 'editor' = 'terminal';
type BrowserTab = { id: string | null; ready: Promise<string | null> | null; url: string; wantedService: string; selectedService: string; waitingForService: boolean; status: string; caption?: string };
const browserTabs = new Map<string, BrowserTab>();
let browserFullscreenActive = false, browserFullscreenDesired = false, browserFullscreenPending = false, browserFullscreenRecovery = false, browserFullscreenRequest = 0;
let fileEditor: import('./editor').FileEditor | null = null;
const gitView = new GitView($('panel-git'), {getRoot:()=>current?.path || null, hasUnsaved:()=>!!current && !!fileEditor?.hasUnsaved(current.path), changeBranch:async(root,action,name)=>{
  if(changingBranches.has(root))throw new Error('Aguarde a troca de branch.');
  changingBranches.add(root);
  try {
    if(editorOpening)await editorOpening;
    if(fileEditor?.hasUnsaved(root))throw new Error('Salve os arquivos abertos no editor antes de trocar de branch.');
    if(fileEditor && !await fileEditor.closeProject(root))throw new Error('A troca de branch foi cancelada.');
    await api.gitBranchAction(root,action,name);
    if(current?.path===root)await loadRootTree();
  } finally {changingBranches.delete(root);}
}});
const treeMenu = new TreeMenu({currentRoot:()=>current?.path||null,openFile:(root,name)=>openFile(root,name),notify});
let editorOpening: Promise<import('./editor').FileEditor> | null = null;
let usageSnapshot: UsageSnapshot | null = null, usageLoading = false;
let chatView: import('./chat').CodexChatView | null = null;
let chatOpening: Promise<import('./chat').CodexChatView> | null = null;
const actionResults = new Map<string, DkActionResult>();
const runningActions = new Set<string>();

const preferenceDefaults = { fontSize: 13, scrollback: 10000, idleMinutes: 30, idleMemoryMiB: 64, idleAlerts: true, cursorBlink: false };
const preferenceValues = { fontSize: [11,12,13,14,15,16,18], scrollback: [1000,5000,10000,20000], idleMinutes: [15,30,60,120], idleMemoryMiB: [32,64,128,256,512] };
const preferences = { ...preferenceDefaults };
try {
  const saved = JSON.parse(localStorage.getItem('terminalPreferences') || '{}');
  for (const key of ['fontSize','scrollback','idleMinutes','idleMemoryMiB'] as const) if (preferenceValues[key].includes(saved[key])) preferences[key] = saved[key];
  if (typeof saved.idleAlerts === 'boolean') preferences.idleAlerts = saved.idleAlerts;
  if (typeof saved.cursorBlink === 'boolean') preferences.cursorBlink = saved.cursorBlink;
} catch {}
document.body.classList.toggle('terminal-cursor-static', !preferences.cursorBlink);
function applyPreferences() {
  try { localStorage.setItem('terminalPreferences', JSON.stringify(preferences)); } catch {}
  document.body.classList.toggle('terminal-cursor-static', !preferences.cursorBlink);
  for (const session of sessions.values()) { session.terminal.options.fontSize = preferences.fontSize; session.terminal.options.scrollback = preferences.scrollback; }
  updateTerminalVisibility();
  renderIdleNotice(); requestAnimationFrame(fitActive);
}
let pluginsPanel: ReturnType<typeof createPluginsPanel> | null = null;
const launcher = new Launcher({
  beginProjectIntent,
  isCurrentIntent: intent => intent === projectIntent,
  activateProject: (info, intent) => activate(info, intent),
  rememberProject: rememberRecent,
  getProjects: () => recentProjects, hasProject: () => !!current, getRemoteProjects: () => remoteProjects,
  rememberRemote: item => { remoteProjects = [{id:item.id,name:item.name,path:item.path}, ...remoteProjects.filter(existing=>existing.id!==item.id)].slice(0,12); },
  mountPlugins: host => {
    const panel: ReturnType<typeof createPluginsPanel> = createPluginsPanel(host, {
      list: root => api.listPlugins(root),
      reload: root => api.reloadPlugins(root),
      execute: async (root, pluginId, actionId, revision) => {
        if (current?.path !== root) throw new Error('Selecione o projeto do plugin antes de executar a ação.');
        if (busy || closingProjects.has(root)) throw new Error('Aguarde a sessão atual terminar de abrir ou o projeto terminar de fechar.');
        const opened = await newSession(undefined, undefined, undefined, async () => {
          const session = await api.executePlugin(root, pluginId, actionId, revision);
          if (session && current?.path !== root) {
            await api.closeTerminal(session.id);
            throw new Error('O projeto selecionado mudou. Selecione-o novamente para executar a ação.');
          }
          return session;
        });
        if (opened && current?.path === root && pluginsPanel === panel) { launcher.hide(); active()?.terminal.focus(); fitActive(); }
      },
    });
    pluginsPanel = panel;
    run(() => panel.setProject(current?.path || null, current?.title || current?.name));
    return () => {
      panel.destroy();
      if (pluginsPanel === panel) {
        pluginsPanel = null;
        run(() => api.stopWatchingPlugins());
      }
    };
  },
  preferences, applyPreferences, theme: setSeaTheme, glass: setGlassAppearance, glassAmount: setGlassTransparency, getGlassAmount: () => glassTransparency, sidebar, notify,
});
function notify(error: unknown) {
  $('toast').textContent = error instanceof Error ? error.message : String(error);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 7000);
}
function rememberRecent(info: Project) {
  const index = recentProjects.findIndex(project => project.path === info.path);
  if (index >= 0) {
    if (recentProjects[index] === info) return;
    recentProjects[index] = info;
  } else recentProjects = [...recentProjects, info].slice(-12);
  launcher.refreshRecents();
}
const run = (task: () => Promise<unknown>) => { task().catch(notify); };
function renderKit() {
  $('kit-dot').classList.toggle('ready', !!kit);
  $('kit-label').textContent = pluginStatus === 'installed' ? 'Plugin DK conectado' : kit ? 'Design Kit conectado' : 'Plugin DK indisponível';
  $('kit-description').textContent = pluginStatus === 'missing' ? 'Plugin DK ausente no Claude' : pluginStatus === 'disabled' ? 'Plugin DK desativado no Claude' : pluginStatus === 'no-claude' ? 'Instale o Claude Code para usar o plugin' : pluginStatus === 'unavailable' ? 'Não foi possível verificar o plugin' : kit?.path || 'Verificando instalação do plugin DK';
  button('install-dk-plugin').hidden = pluginStatus !== 'missing' && pluginStatus !== 'disabled';
  button('install-dk-plugin').textContent = pluginStatus === 'disabled' ? 'Ativar plugin DK no Claude' : 'Instalar plugin DK no Claude';
  $('kit-description').title = kit?.path || '';
  $('action-hint').textContent = !kit ? 'Instale ou ative o plugin DK para executar as ações.' : !current ? 'Abra uma pasta para começar.' : 'Resultados renderizados · JSON disponível.';
  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(el => { el.disabled = !kit || !current || runningActions.has(current.path) || (el.dataset.action === 'validate' && !current.isDk); });
}
function renderProjects() {
  const list = $('project-list');
  list.replaceChildren();
  $('project-count').textContent = String(projects.length);
  if (!projects.length) {
    const hint = document.createElement('p'); hint.className = 'no-projects'; hint.textContent = 'Seus projetos aparecem aqui.'; list.append(hint);
  }
  for (const info of projects) {
    const row = document.createElement('div'); row.className = `project-row${current?.path === info.path ? ' selected' : ''}`;
    const select = document.createElement('button'); select.className = 'project-select'; select.title = info.title || info.name;
    if (current?.path === info.path) select.setAttribute('aria-current', 'page');
    select.innerHTML = `${icon('folder')}<span><strong></strong><small></small></span>`;
    select.querySelector('strong')!.textContent = info.title || info.name;
    select.querySelector('small')!.textContent = info.isDk ? 'Projeto DK' : 'Pasta de trabalho';
    select.onclick = () => run(async () => {
      const intent = beginProjectIntent(), snapshot = launcher.captureState();
      const selected = await api.activateProject(info.path); rememberRecent(selected);
      if (!launcher.isCurrent(snapshot)) return;
      if (await activate(selected, intent)) launcher.completeOpen(snapshot, intent === projectIntent);
    });
    const forget = document.createElement('button'); forget.className = 'icon-button forget-project'; forget.title = 'Fechar projeto'; forget.setAttribute('aria-label', `Fechar projeto ${info.title || info.name}`); forget.innerHTML = icon('close');
    forget.onclick = () => run(async () => {
      if (closingProjects.has(info.path)) return;
      closingProjects.add(info.path); forget.disabled = true;
      try {
      await opening;
      if (editorOpening && !fileEditor) await editorOpening;
      if (fileEditor && !await fileEditor.closeProject(info.path)) return;
      const result = await api.closeProjectSessions(info.path);
      for (const [id, session] of [...sessions]) if (session.cwd === info.path) {
        clearTimeout(session.ackTimer); session.ackPending = 0; session.terminal.dispose(); session.element.remove(); sessions.delete(id); idleSnoozed.delete(id);
      }
      lastActive.delete(info.path); projectWorkspaceViews.delete(info.path); paneGroups.delete(info.path); browserTabs.delete(info.path); renderIdleNotice();
      projects = projects.filter(project => project.path !== info.path);
      if (current?.path === info.path) {
        current = null; activeId = null;
        fileEditor?.setProject('');
        selectMainView('terminal');
        renderProject(); focusSession(null, false);
        selectPanel(null); await loadRootTree();
        launcher.show('home');
        if (result.partial) notify('O projeto foi fechado, mas não foi possível confirmar a liberação de todas as sessões ou dos dados temporários da prévia.');
      } else { renderProjects(); if (!current) launcher.show('home'); if (result.partial) notify('O projeto foi fechado, mas não foi possível confirmar a liberação de todas as sessões ou dos dados temporários da prévia.'); }
      } finally { closingProjects.delete(info.path); forget.disabled = false; }
    });
    row.append(select, forget); list.append(row);
  }
}
function renderProject() {
  const label = current?.title || current?.name || 'Início';
  $('project-title').textContent = label;
  $('breadcrumb-project').dataset.projectPath = current?.path || '';
  $('breadcrumb-project').title = label;
  const reveal = button('reveal-project'); reveal.hidden = !current;
  reveal.title = current ? `Abrir pasta: ${current.path}` : 'Abrir pasta do projeto';
  if (current) reveal.setAttribute('aria-description', `Pasta: ${current.path}`); else reveal.removeAttribute('aria-description');
  button('new-session').disabled = !current;
  button('show-graph').disabled = !current;
  $('welcome').hidden = !!current;
  $('context-empty').hidden = !!current;
  $('context-details').hidden = !current;
  if (current) {
    $('context-name').textContent = current.name;
    $('context-kind').textContent = current.isDk ? 'Projeto DK reconhecido' : 'Pasta de trabalho';
    const files = $('project-files'); files.replaceChildren();
    for (const file of current.files) {
      const li = document.createElement('li'); li.className = file.present ? 'present' : 'absent';
      li.innerHTML = `${icon('file')}<span></span><small></small>`;
      li.querySelector('span')!.textContent = file.name;
      li.querySelector('small')!.textContent = file.present ? 'Encontrado' : 'Ausente';
      files.append(li);
    }
    $('context-note').textContent = current.isDk ? 'A validação do projeto mostra pendências e evidências do registro.' : 'O terminal funciona nesta pasta. A validação DK fica disponível quando houver um manifesto do projeto.';
  }
  renderProjects(); renderKit(); renderTabs(); renderServices(); renderExtensions();
}
function renderExtensions() {
  const list = $('extension-bar'); list.replaceChildren();
  const customExtensions = installedExtensions.filter(extension => !['claude', 'codex', 'antigravity', 'gemini', 'dk', 'browser'].includes(extension.id));
  list.hidden = customExtensions.length === 0;
  renderPreviewAction();
  for (const id of ['claude', 'codex']) {
    const extension = installedExtensions.find(item => item.id === id);
    const control = button(`launch-${id}`);
    control.disabled = !current || !extension?.available;
    control.title = !extension?.available ? `${id === 'claude' ? 'Claude' : 'Codex'} não encontrado neste computador` : `Abrir ${id === 'claude' ? 'Claude Code' : 'Codex'} neste projeto`;
  }
  for (const id of ['antigravity', 'gemini', 'dk']) {
    const extension = installedExtensions.find(item => item.id === id), control = button(`launch-${id}`);
    control.hidden = !extension?.available; control.disabled = !current || !extension?.available;
  }
  if (!customExtensions.length) return;
  const label = document.createElement('span'); label.className = 'action-label'; label.textContent = 'EXTENSÕES'; list.append(label);
  for (const extension of customExtensions) {
    const control = document.createElement('button'); control.className = 'button extension';
    control.innerHTML = `${icon(extension.kind === 'browser' ? 'globe' : 'terminal')}<span></span><small></small>`;
    control.querySelector('span')!.textContent = extension.name;
    control.querySelector('small')!.textContent = extension.kind === 'browser' ? 'Prévia local' : extension.available ? 'CLI local' : 'Não encontrado';
    control.disabled = !current || !extension.available;
    control.title = extension.description + ' Usa o login e as configurações da ferramenta oficial.';
    control.onclick = () => run(() => newSession(`extension:${extension.id}`));
    list.append(control);
  }
}
function renderPreviewAction() {
  const available = installedExtensions.some(item => item.id === 'browser' && item.available);
  const services = current ? projectServices.get(current.path) || [] : [];
  const running = services.some(item => item.status === 'running' && isPreviewService(item));
  const staticPreview = !services.some(item => item.id !== 'static:preview' && isPreviewService(item)) && services.some(item => item.id === 'static:preview' && item.status !== 'stopping');
  const control = button('open-browser'); control.disabled = !available || (!running && !staticPreview);
  control.title = control.disabled ? 'Inicie um serviço de front-end para visualizar o protótipo' : staticPreview && !running ? 'Iniciar prévia estática' : 'Visualizar protótipo';
}
function isPreviewService(service: Service) {
  if (service.role) return service.role === 'frontend';
  return /^(?:dev|start|serve|preview|web|site|frontend|front|client|prototipo)(?::(?:web|frontend|front|client|site))?$/i.test(service.name);
}
function renderServices() {
  $('services-section').hidden = !current;
  $('services-placeholder').hidden = !!current;
  $('preview-ai').hidden = !current;
  const list = $('service-list'); list.replaceChildren();
  const items = current ? projectServices.get(current.path) || [] : [];
  $('service-count').textContent = String(items.filter(s => ['running', 'starting', 'stopping'].includes(s.status)).length);
  const plan = current && projectDependencyPlans.get(current.path);
  if (current && plan && (plan.ok || plan.reason !== 'missing')) {
    const root = current.path, section = document.createElement('div'); section.className = 'service-row';
    const description = document.createElement('small');
    description.textContent = plan.ok ? `Gerenciador: ${plan.manager} · usa o cache configurado` : plan.error;
    const prepare = document.createElement('button'); prepare.id = 'prepare-dependencies'; prepare.className = 'button'; prepare.textContent = 'Preparar dependências';
    prepare.disabled = !plan.ok;
    prepare.onclick = () => run(() => newSession(undefined, undefined, undefined, () => api.prepareDependencies(root)));
    section.append(description, prepare); list.append(section);
  }
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'no-projects';
    empty.textContent = 'Nenhum serviço definido. Scripts dev, start e preview aparecem aqui.'; list.append(empty);
  }
  const labels = { starting: 'Iniciando', running: 'Rodando', stopping: 'Encerrando', stopped: 'Parado', failed: 'Falhou' };
  for (const service of items) {
    const row = document.createElement('div'); row.className = 'service-row'; row.dataset.serviceId = service.id;
    const heading = document.createElement('div'); heading.className = 'service-heading';
    heading.innerHTML = '<span class="status-dot"></span><div><strong></strong><small></small></div>';
    heading.querySelector('.status-dot')!.classList.toggle('ready', service.status === 'running');
    heading.querySelector('strong')!.textContent = service.name;
    heading.querySelector('small')!.textContent = labels[service.status] + (service.status === 'running' && service.pid ? ` · ${service.pid}` : '');
    const running = ['running', 'starting'].includes(service.status);
    const control = document.createElement('button'); control.className = `icon-button service-control${running ? ' stop' : ''}`;
    control.innerHTML = icon(running ? 'stop' : 'play');
    control.setAttribute('aria-label', `${running ? 'Desligar' : 'Iniciar'} serviço ${service.name}`);
    control.title = running ? 'Desligar serviço e seus processos filhos' : 'Iniciar serviço';
    control.disabled = service.status === 'stopping';
    const root = current!.path;
    control.onclick = () => run(async () => {
      control.disabled = true;
      try {
        if (!running && isPreviewService(service)) { await openBrowserView(service.id); return; }
        const result = running ? await api.stopService(root, service.id) : await api.startService(root, service.id);
        updateService(root, result);
      } finally { if (control.isConnected) control.disabled = false; }
    });
    heading.append(control); row.append(heading);
    if (service.url) { const address = document.createElement('div'); address.className = 'service-address'; address.textContent = service.url; row.append(address); }
    if (service.log) {
      const key = `${root}:${service.id}`;
      const details = document.createElement('details'); details.className = 'service-log'; details.open = serviceLogs.has(key);
      const summary = document.createElement('summary'); summary.textContent = 'Ver saída';
      const log = document.createElement('pre'); log.textContent = service.log.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      details.append(summary, log); details.ontoggle = () => { if (details.open) serviceLogs.add(key); else serviceLogs.delete(key); };
      row.append(details);
    }
    list.append(row);
  }
}
function updateService(root: string, service: Service) {
  const items = projectServices.get(root) || [];
  const index = items.findIndex(item => item.id === service.id);
  if (index === -1) items.push(service); else items[index] = service;
  projectServices.set(root, items);
  if (current?.path === root) renderPreviewAction();
  if (current?.path === root && selectedPanel === 'services') renderServices();
  const tab = browserTabs.get(root);
  if (tab && service.id === tab.wantedService) {
    if (service.url && service.status === 'running' && (service.url !== tab.url || tab.waitingForService)) {
      tab.waitingForService = false; run(() => navigatePreview(root, service.url!, tab));
    }
    if (service.status === 'failed') setBrowserStatus(root, tab, 'O serviço não iniciou. Confira a saída na guia Serviços.');
    if (service.status === 'stopped') setBrowserStatus(root, tab, 'Serviço encerrado.');
  }
  if (current?.path === root && mainView === 'browser') {
    renderBrowserServices();
  }
}
async function loadServices(root: string, valid: () => boolean = () => true) {
  try { const [services, plan] = await Promise.all([api.listServices(root), api.dependencyPlan(root)]); if (!valid()) return; projectServices.set(root, services); projectDependencyPlans.set(root, plan); }
  catch (error) { if (!valid()) return; notify(error); }
  if (!valid()) return;
  if (current?.path === root) renderPreviewAction();
  if (current?.path === root && selectedPanel === 'services') renderServices();
}
function selectPanel(panel: InspectorPanel | null, loadFiles = true) {
  const previous = selectedPanel, container = $('project-inspector-panel');
  if (previous !== panel && container.contains(document.activeElement)) {
    const focusTarget = panel || previous;
    if (focusTarget) button(`tab-${focusTarget}`).focus();
  }
  selectedPanel = panel; container.hidden = panel === null;
  document.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(control => {
    const selected = control.dataset.panel === panel;
    control.setAttribute('aria-expanded', String(selected));
    $(`panel-${control.dataset.panel}`).hidden = !selected;
  });
  if (panel === 'services') renderServices();
  if (panel === 'usage') run(() => loadUsage());
  if (panel === 'git') void gitView.refresh();
  if (loadFiles && panel === 'files' && current?.path !== treeProject) run(loadRootTree);
  requestAnimationFrame(fitActive);
  schedulePreviewResize();
}
function fileType(name: string): string {
  const lower = name.toLowerCase();
  if (/\.(?:md|markdown|mdx)$/.test(lower)) return 'markdown';
  if (/\.(?:mmd|mermaid)$/.test(lower)) return 'diagram';
  if (/\.(?:json|ya?ml|toml)$/.test(lower)) return 'config';
  if (/\.(?:html|css|js|jsx|ts|tsx|py|sh)$/.test(lower)) return 'code';
  if (/\.(?:png|jpe?g|gif|webp|svg)$/.test(lower)) return 'image';
  return 'file';
}
function syncTreeSelection() {
  const active = fileEditor?.getCurrentFile();
  document.querySelectorAll<HTMLButtonElement>('#folder-tree .tree-file').forEach(row => {
    const selected = !!active && active.root === current?.path && row.dataset.relative === active.relative;
    row.classList.toggle('selected', selected);
    if (selected) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
  });
}
function directoryList(root: string, listing: DirectoryListing): HTMLUListElement {
  const list = document.createElement('ul'); list.className = 'file-tree';
  for (const entry of listing.entries) {
    const item = document.createElement('li');
    if (entry.kind === 'directory') {
      const control = document.createElement('button'); control.className = 'tree-folder'; control.dataset.relative = entry.relative;
      control.innerHTML = `${icon('chevron', 'tree-chevron')}${icon('folder')}<span></span>`;
      control.querySelector('span')!.textContent = entry.name;
      control.title = entry.relative; control.setAttribute('aria-expanded', 'false');
      control.oncontextmenu = event => treeMenu.open(event,control,root,entry);
      control.onkeydown = event => {if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10'))treeMenu.open(event,control,root,entry);};
      let children: HTMLUListElement | null = null, expanded = false, loading = false;
      control.onclick = () => run(async () => {
        if (loading) return;
        expanded = !expanded; control.setAttribute('aria-expanded', String(expanded));
        if (children) { children.hidden = !expanded; return; }
        if (!expanded) return;
        loading = true; control.classList.add('loading');
        try {
          const data = await api.listDirectory(root, entry.relative);
          if (control.isConnected && current?.path === root) { children = directoryList(root, data); item.append(children); syncTreeSelection(); }
        } catch (error) { expanded = false; control.setAttribute('aria-expanded', 'false'); throw error; }
        finally { loading = false; control.classList.remove('loading'); }
      });
      item.append(control);
    } else {
      const row = document.createElement('button'); row.className = 'tree-file'; row.dataset.relative = entry.relative; row.dataset.type = fileType(entry.name);
      row.onclick = () => run(() => openFile(root, entry.relative)); row.title = entry.relative + (entry.kind === 'link' ? ' · Link simbólico' : '');
      row.oncontextmenu = event => treeMenu.open(event,row,root,entry);
      row.onkeydown = event => {if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10'))treeMenu.open(event,row,root,entry);};
      row.innerHTML = `${icon('file')}<span></span>`; row.querySelector('span')!.textContent = entry.name + (entry.kind === 'link' ? ' ↗' : ''); item.append(row);
    }
    list.append(item);
  }
  if (!listing.entries.length || listing.truncated) {
    const note = document.createElement('li'); note.className = 'tree-note'; note.textContent = listing.truncated ? 'Primeiros 500 itens desta pasta.' : 'Pasta vazia'; list.append(note);
  }
  return list;
}
async function loadRootTree() {
  const request = ++treeRequest;
  const root = current?.path || null;
  treeProject = root; $('folder-tree').replaceChildren();
  $('tree-project-name').textContent = current?.title || current?.name || 'Pasta do projeto';
  $('tree-project-name').title = current?.title || current?.name || '';
  button('refresh-tree').disabled = !root;
  $('tree-placeholder').hidden = !!root;
  if (!root) return;
  $('folder-tree').textContent = 'Carregando pastas…';
  try {
    const listing = await api.listDirectory(root);
    if (request === treeRequest && current?.path === root) { $('folder-tree').replaceChildren(directoryList(root, listing)); syncTreeSelection(); }
  } catch (error) { if (request === treeRequest && current?.path === root) { $('folder-tree').textContent = 'Não foi possível abrir esta pasta.'; treeProject = null; throw error; } }
}
function expandTerminal() {
  if (mainView !== 'terminal' && mainView !== 'editor') selectMainView(workspaceView);
  const expanded = document.body.classList.toggle('terminal-expanded');
  button('expand-terminal').setAttribute('aria-pressed', String(expanded));
  button('expand-terminal').setAttribute('aria-label', expanded ? 'Restaurar visualização do terminal' : 'Expandir terminal');
  button('expand-terminal').title = expanded ? 'Restaurar visualização (⌘ ⇧ E)' : 'Expandir terminal (⌘ ⇧ E)';
  button('expand-terminal').innerHTML = icon(expanded ? 'restore' : 'expand');
  requestAnimationFrame(() => { fitActive(); if (focusedPane === 'terminal') active()?.terminal.focus(); });
}
function selectMainView(view: typeof mainView) {
  const previousView = mainView;
  mainView = view;
  document.body.classList.toggle('browser-active', view === 'browser');
  updateTerminalVisibility();
  if (view === 'terminal' || view === 'editor') { workspaceView = view; if (current) projectWorkspaceViews.set(current.path, view); }
  views.select(view);
  if (view !== 'browser') leaveBrowserFullscreen(previousView === 'browser');
  // Only the selected project's native view may be above the workspace.
  const root = view === 'browser' ? current?.path || null : null;
  const selected = root ? browserTabs.get(root) : undefined;
  api.selectBrowser(selected?.id ? root : null, selected?.id || undefined).catch(notify);
  fileEditor?.setWorkspaceActive(view === 'editor');
  if (view === 'browser') renderBrowserState();
  renderTabs();
  if (view === 'graph') run(loadGraph);
  else api.watchOrchestrations(null).catch(() => {});
  if (view === 'terminal' || view === 'editor') { focusSession(activeId, false); requestAnimationFrame(fitActive); }
}
async function openFile(root: string, relative: string) {
  if (closingProjects.has(root) || changingBranches.has(root)) return;
  if (!editorOpening) editorOpening = import('./editor').then(({ FileEditor }) => {
    fileEditor = new FileEditor($('editor-content'), {
      read: api.readFile, save: api.saveFile, confirmClose: api.confirmCloseFile, tabsHost: $('file-tabs'),
      onSelect: () => { focusedPane = 'editor'; syncTreeSelection(); if (mainView !== 'editor') selectMainView('editor'); else focusSession(activeId, false); },
      onDirty: files => { api.setDirtyFiles(files).catch(notify); },
      onEmpty: () => { syncTreeSelection(); if (mainView === 'editor') selectMainView('terminal'); else renderTabs(); }, onError: notify,
    });
    if (current) fileEditor.setProject(current.path);
    return fileEditor;
  });
  const editor = await editorOpening;
  if (current?.path !== root) return;
  selectMainView('editor');
  await editor.open(root, relative);
}
async function openCodex() {
  if (!current || closingProjects.has(current.path)) return;
  const root = current.path;
  selectMainView('chat');
  if (!chatView) $('chat-view').innerHTML = '<div class="chat-loading" role="status">Abrindo Codex…</div>';
  if (!chatOpening) chatOpening = import('./chat').then(({ CodexChatView }) => {
    chatView = new CodexChatView($('chat-view'), { create: api.createChat, list: api.listChats, read: api.readChat, send: api.sendChat, cancel: api.cancelChat, approve: api.approveChat, onBack: () => selectMainView(workspaceView) }, notify);
    return chatView;
  });
  let view;
  try { view = await chatOpening; } catch (error) { chatOpening = null; throw error; }
  if (current?.path !== root || mainView !== 'chat') return;
  await view.open(root);
}
async function showActionResult(result: DkActionResult) {
  const { renderAction } = await import('./actions');
  if (current?.path !== result.root) return;
  renderAction($('action-content'), result);
}
async function runDkAction(action: string) {
  if (!current || runningActions.has(current.path)) return;
  const root = current.path;
  runningActions.add(root); renderKit();
  selectMainView('action');
  $('action-content').textContent = 'Executando a ação do DK…';
  button('cancel-action').hidden = false;
  try {
    const result = await api.runAction(root, action);
    actionResults.set(root, result);
    if (current?.path === root) await showActionResult(result);
  } catch (error) {
    if (current?.path === root) $('action-content').textContent = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    runningActions.delete(root); renderKit();
    if (current?.path === root) button('cancel-action').hidden = true;
  }
}
async function loadUsage(refresh = false) {
  if (!current || usageLoading) return;
  if (usageSnapshot && !refresh) { renderUsage($('usage-content'), usageSnapshot, () => run(() => newSession('extension:claude'))); return; }
  usageLoading = true; button('refresh-usage').disabled = true;
  $('usage-status').textContent = 'Consultando as ferramentas oficiais…';
  try {
    usageSnapshot = await api.readUsage(current.path, refresh);
    renderUsage($('usage-content'), usageSnapshot, () => run(() => newSession('extension:claude')));
    $('usage-status').textContent = 'Percentuais consumidos das cotas informadas pelas contas.';
  } finally { usageLoading = false; button('refresh-usage').disabled = false; }
}
function previewBounds(): PreviewBounds {
  const rect = $('browser-canvas').getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
let previewResizeFrame = 0;
function schedulePreviewResize() {
  cancelAnimationFrame(previewResizeFrame);
  previewResizeFrame = requestAnimationFrame(() => {
    if (mainView === 'browser' && current && browserTabs.get(current.path)?.url) api.resizeBrowser(previewBounds()).catch(() => {});
  });
}
function renderBrowserFullscreen() {
  const active = browserFullscreenActive && browserFullscreenDesired && mainView === 'browser';
  document.body.classList.toggle('browser-fullscreen', active);
  const control = button('browser-fullscreen');
  control.setAttribute('aria-pressed', String(active));
  control.setAttribute('aria-label', active || browserFullscreenRecovery ? 'Sair da tela cheia do browser' : 'Abrir browser em tela cheia');
  control.title = active || browserFullscreenRecovery ? 'Sair da tela cheia (Esc)' : 'Abrir browser em tela cheia';
  control.innerHTML = icon(active || browserFullscreenRecovery ? 'restore' : 'expand');
  schedulePreviewResize();
}
async function setBrowserFullscreen(enabled: boolean) {
  const request = ++browserFullscreenRequest;
  browserFullscreenDesired = enabled;
  browserFullscreenPending = true;
  button('browser-fullscreen').disabled = true;
  renderBrowserFullscreen();
  try {
    const actual = await api.setBrowserFullscreen(enabled);
    if (request !== browserFullscreenRequest) return;
    browserFullscreenActive = actual;
    browserFullscreenRecovery = false;
    browserFullscreenDesired = actual && mainView === 'browser';
    renderBrowserFullscreen();
  } catch (error) {
    if (request !== browserFullscreenRequest) return;
    const recovery = await api.browserFullscreenNeedsRestore().catch(() => false);
    if (request !== browserFullscreenRequest) return;
    browserFullscreenRecovery = recovery;
    browserFullscreenDesired = browserFullscreenActive && mainView === 'browser';
    renderBrowserFullscreen();
    throw error;
  } finally {
    if (request === browserFullscreenRequest) {
      browserFullscreenPending = false;
      button('browser-fullscreen').disabled = false;
    }
  }
}
function leaveBrowserFullscreen(force = false) {
  if (force || browserFullscreenDesired || browserFullscreenActive || browserFullscreenPending || browserFullscreenRecovery) run(() => setBrowserFullscreen(false));
}
function renderBrowserServices(preferred?: string) {
  const select = $<HTMLSelectElement>('browser-service');
  const tab = current ? browserTabs.get(current.path) : undefined;
  const previous = preferred === undefined ? tab?.selectedService || '' : preferred;
  select.replaceChildren();
  const items = current ? (projectServices.get(current.path) || []).filter(item => isPreviewService(item)) : [];
  const manual = document.createElement('option'); manual.value = ''; manual.textContent = 'Endereço manual'; select.append(manual);
  for (const item of items) { const option = document.createElement('option'); option.value = item.id; option.textContent = `${item.name} · ${['running', 'starting'].includes(item.status) ? 'Rodando' : 'Parado'}`; select.append(option); }
  select.value = items.some(item => item.id === previous) ? previous : '';
  if (tab) tab.selectedService = select.value;
  const selected = items.find(item => item.id === select.value);
  button('browser-start').disabled = !selected || selected.status === 'starting' || selected.status === 'stopping';
  button('browser-start').textContent = selected?.status === 'starting' ? 'Iniciando…' : selected?.status === 'running' ? 'Visualizar projeto' : 'Executar projeto';
  button('browser-stop').disabled = !selected || !['running', 'starting'].includes(selected.status);
}
function setBrowserStatus(root: string, tab: BrowserTab, status: string) {
  if (browserTabs.get(root) !== tab) return;
  tab.status = status;
  if (current?.path === root && mainView === 'browser') $('browser-status').textContent = status;
}
function renderBrowserState() {
  const tab = current ? browserTabs.get(current.path) : undefined;
  $<HTMLInputElement>('browser-address').value = tab?.url || '';
  $('browser-placeholder').hidden = !!tab?.url;
  $('browser-status').textContent = tab?.status || 'Projeto local · A página pode acessar a rede';
  renderBrowserServices(tab?.selectedService);
  schedulePreviewResize();
}
async function closeBrowserTab(root: string) {
  const tab = browserTabs.get(root); if (!tab) return;
  browserTabs.delete(root);
  if (current?.path === root && mainView === 'browser') selectMainView(workspaceView);
  else renderTabs();
  if (tab.id) await api.closeBrowser(root, tab.id);
  else await tab.ready?.catch(() => null);
}
async function prepareBrowserTab(root: string, tab: BrowserTab): Promise<string | null> {
  const id = await api.createBrowserTab(root);
  if (browserTabs.get(root) !== tab) { await api.closeBrowser(root, id).catch(() => {}); return null; }
  tab.id = id;
  try { if (current?.path === root && mainView === 'browser') await api.selectBrowser(root, id); }
  catch (error) { await api.closeBrowser(root, id).catch(() => {}); throw error; }
  return id;
}
async function openBrowserView(requestedService?: string) {
  if (!current) return;
  const root = current.path;
  let tab = browserTabs.get(root);
  const created = !tab;
  if (!tab) {
    tab = { id: null, ready: null, url: '', wantedService: '', selectedService: '', waitingForService: false, status: 'Escolha o serviço do protótipo ou informe um endereço local.' };
    browserTabs.set(root, tab);
    tab.ready = prepareBrowserTab(root, tab);
  }
  selectMainView('browser');
  if (!created && !requestedService) return;
  const expected = tab;
  try { if (!await expected.ready) return; }
  catch (error) {
    if (browserTabs.get(root) === expected) { browserTabs.delete(root); if (current?.path === root && mainView === 'browser') selectMainView(workspaceView); else renderTabs(); }
    throw error;
  }
  if (browserTabs.get(root) !== expected) return;
  await loadServices(root, () => browserTabs.get(root) === expected);
  if (browserTabs.get(root) !== expected) return;
  const services = projectServices.get(root) || [];
  const webServices = services.filter(service => isPreviewService(service));
  const running = webServices.filter(service => service.status === 'running');
  const staticPreview = !webServices.some(service => service.id !== 'static:preview') ? webServices.find(service => service.id === 'static:preview' && service.status !== 'stopping') : undefined;
  if (!requestedService && !running.length && !staticPreview) { if (created) await closeBrowserTab(root); if (current?.path === root) renderPreviewAction(); return; }
  const candidate = requestedService ? webServices.find(service => service.id === requestedService) || null : running.length === 1 ? running[0] : running.length ? null : staticPreview || null;
  expected.selectedService = candidate?.id || '';
  if (current?.path === root && mainView === 'browser') renderBrowserServices();
  if (candidate) await startBrowserService(root, candidate, expected);
  else setBrowserStatus(root, expected, services.length ? 'Escolha o serviço do protótipo ou informe um endereço local.' : 'Nenhum serviço encontrado. Informe um endereço local para visualizar o projeto.');
}
async function startBrowserService(root: string, service: Service, tab = browserTabs.get(root)) {
  if (!tab || browserTabs.get(root) !== tab) return;
  tab.wantedService = service.id; tab.selectedService = service.id; tab.caption = undefined;
  tab.waitingForService = service.status !== 'running' || !service.url;
  if (service.status === 'running' && service.url) { if (tab.url !== service.url) await navigatePreview(root, service.url, tab); return; }
  if (service.status === 'running' || service.status === 'starting') {
    setBrowserStatus(root, tab, 'Aguardando o endereço do serviço. Você também pode informá-lo acima.'); return;
  }
  if (service.status === 'stopping') { setBrowserStatus(root, tab, 'Aguarde o serviço terminar de encerrar.'); return; }
  setBrowserStatus(root, tab, 'Iniciando projeto e aguardando seu endereço local…');
  try {
    const started = await api.startService(root, service.id);
    if (browserTabs.get(root) !== tab) return;
    const latest = projectServices.get(root)?.find(item => item.id === service.id);
    if (!latest || latest.status === 'stopped' || latest.status === 'failed') updateService(root, started);
  } catch (error) {
    if (browserTabs.get(root) === tab && tab.wantedService === service.id) setBrowserStatus(root, tab, 'Não foi possível iniciar o serviço. Confira a configuração na guia Serviços.');
    throw error;
  }
}
async function navigatePreview(root: string, url: string, tab = browserTabs.get(root)) {
  if (!tab || browserTabs.get(root) !== tab) return;
  tab.url = url;
  setBrowserStatus(root, tab, 'Carregando prévia…');
  if (current?.path === root && mainView === 'browser') renderBrowserState();
  const id = await tab.ready;
  if (!id || browserTabs.get(root) !== tab || tab.url !== url) return;
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  if (browserTabs.get(root) !== tab || tab.url !== url) return;
  try { await api.openBrowser(root, url, previewBounds(), id); }
  catch (error) { if (browserTabs.get(root) === tab) { setBrowserStatus(root, tab, 'Não foi possível abrir a prévia. Confira o endereço e o serviço.'); throw error; } }
}
async function loadGraph(valid: () => boolean = () => true) {
  if (!current) return;
  const root = current.path;
  const listing = await api.listOrchestrations(root);
  if (!valid() || current?.path !== root || mainView !== 'graph') return;
  renderOrchestration($('graph-content'), listing);
  await api.watchOrchestrations(root);
}
function active() { return activeId ? sessions.get(activeId) : undefined; }
function hasCurrentEditor() { return !!current && fileEditor?.getCurrentFile()?.root === current.path; }
function updateTerminalVisibility() {
  const workspaceVisible = (mainView === 'terminal' || mainView === 'editor') && document.visibilityState === 'visible';
  for (const session of sessions.values()) {
    const visible = workspaceVisible && !session.element.hidden;
    if (session.terminal.options.screenReaderMode !== visible) session.terminal.options.screenReaderMode = visible;
    const blink = preferences.cursorBlink && visible && !session.exited && session.id === activeId && document.hasFocus();
    if (session.terminal.options.cursorBlink !== blink) session.terminal.options.cursorBlink = blink;
  }
}
function fitActive() {
  if ($('terminal-view').hidden || $('terminal-workspace').hidden) return;
  for (const session of sessions.values()) {
    if (session.element.hidden) continue;
    try {
      session.fit.fit();
      if (session.id === activeId) $('session-dimensions').textContent = `${session.terminal.cols} × ${session.terminal.rows} · UTF-8`;
      const size = { cols: session.terminal.cols, rows: session.terminal.rows };
      if (session.started && !session.exited && (size.cols !== session.lastSize?.cols || size.rows !== session.lastSize?.rows)) {
        session.lastSize = size;
        api.resizeTerminal(session.id, size).catch(() => { if (session.lastSize === size) session.lastSize = undefined; });
      }
    } catch {}
  }
}
function focusSession(id: string | null, focus = true) {
  activeId = id;
  const group = current ? paneGroups.get(current.path) : null;
  const visible = id && group?.ids.includes(id) ? group.ids.filter(key => sessions.has(key)) : id ? [id] : [];
  const editorVisible = mainView === 'editor' && hasCurrentEditor();
  const host = $('terminal-host');
  const count = visible.length + (editorVisible ? 1 : 0);
  const direction = group?.direction || 'right';
  host.classList.toggle('split', count > 1);
  host.style.gridTemplateColumns = `repeat(${direction === 'right' ? Math.min(2, count) : 1},minmax(0,1fr))`;
  host.style.gridTemplateRows = `repeat(${direction === 'right' ? Math.ceil(count / 2) : count},minmax(0,1fr))`;
  const ordered: HTMLElement[] = [];
  if (editorVisible) ordered.push($('editor-view'));
  for (const session of sessions.values()) {
    session.element.hidden = !visible.includes(session.id);
    session.element.classList.toggle('focused', session.id === id);
    session.element.style.gridColumn = '';
    if (!session.element.hidden) ordered.push(session.element);
  }
  updateTerminalVisibility();
  $('editor-view').style.gridColumn = '';
  if (direction === 'right' && count === 3) ordered[2].style.gridColumn = '1 / -1';
  button('single-terminal').hidden = visible.length < 2;
  button('detach-pane').hidden = visible.length < 2;
  if (id && current) lastActive.set(current.path, id);
  renderTabs();
  requestAnimationFrame(() => { fitActive(); if (focus) active()?.terminal.focus(); });
}
function renderTabs() {
  const list = $('tabs'); list.replaceChildren();
  const visible = [...sessions.values()].filter(s => s.cwd === current?.path);
  for (const session of visible) {
    const selected = mainView !== 'browser' && activeId === session.id;
    const tab = document.createElement('div'); tab.className = `tab${selected ? ' active' : ''}`;
    const select = document.createElement('button'); select.className = 'tab-select'; select.role = 'tab'; select.id = `tab-${session.id}`; select.setAttribute('aria-selected', String(selected)); select.setAttribute('aria-controls', `pane-${session.id}`);
    select.innerHTML = icon(session.kind === 'shell' ? 'terminal' : session.exited ? 'check' : 'activity');
    const text = document.createElement('span'); text.textContent = session.label;
    select.append(text); select.onclick = () => { if (mainView !== 'terminal' && mainView !== 'editor') selectMainView(workspaceView); focusedPane = 'terminal'; focusSession(session.id); };
    const close = document.createElement('button'); close.className = 'icon-button tab-close'; close.setAttribute('aria-label', `Fechar ${session.label}`); close.innerHTML = icon('close'); close.onclick = () => run(() => closeSession(session.id));
    tab.append(select, close); list.append(tab);
  }
  if (current && browserTabs.has(current.path)) {
    const root = current.path, selected = mainView === 'browser';
    const tab = document.createElement('div'); tab.className = `tab${selected ? ' active' : ''}`;
    const select = document.createElement('button'); select.type = 'button'; select.id = 'browser-tab'; select.className = 'tab-select'; select.role = 'tab';
    select.setAttribute('aria-selected', String(selected)); select.setAttribute('aria-controls', 'browser-view'); select.innerHTML = `${icon('globe')}<span>Browser</span>`;
    select.onclick = () => { if (current?.path === root) selectMainView('browser'); };
    const close = document.createElement('button'); close.type = 'button'; close.id = 'browser-tab-close'; close.className = 'icon-button tab-close'; close.setAttribute('aria-label', 'Fechar browser'); close.title = 'Fechar browser'; close.innerHTML = icon('close');
    close.onclick = () => run(() => closeBrowserTab(root));
    tab.append(select, close); list.append(tab);
  }
  const editorVisible = mainView === 'editor' && hasCurrentEditor();
  $('terminal-empty').hidden = !current || visible.length > 0 || editorVisible;
  $('terminal-host').hidden = !visible.length && !editorVisible;
  button('search-toggle').disabled = !active() || mainView === 'browser';
  button('split-right').disabled = button('split-down').disabled = button('split-agent').disabled = !active() || mainView === 'browser';
  $('session-count').textContent = `${sessions.size} ${sessions.size === 1 ? 'sessão' : 'sessões'}`;
  const session = active();
  $('session-state').textContent = agentOpening && agentOpening.root === current?.path ? `Abrindo ${agentOpening.name}…` : !session ? 'Nenhuma sessão aberta' : session.exited ? `Encerrada · código ${session.exitCode ?? '—'}` : !session.started ? 'Abrindo sessão…' : session.kind === 'shell' ? 'Terminal conectado' : 'Comando em execução';
  $('session-dot').classList.toggle('ready', !!session?.started && !session.exited);
  if (!session) { $('session-dimensions').textContent = 'UTF-8'; $('search-bar').hidden = true; }
}
async function activate(info: Project, intent = beginProjectIntent()): Promise<boolean> {
  if (closingProjects.has(info.path)) throw new Error('Aguarde o encerramento do projeto.');
  rememberRecent(info);
  if (intent < appliedProjectIntent) return false;
  await opening;
  if (intent < appliedProjectIntent) return false;
  if (closingProjects.has(info.path)) throw new Error('Aguarde o encerramento do projeto.');
  appliedProjectIntent = intent;
  const generation = ++activationGeneration;
  const projectChanged = current?.path !== info.path;
  current = info;
  const valid = () => generation === activationGeneration && current?.path === info.path && !closingProjects.has(info.path);
  const projectIndex = projects.findIndex(p => p.path === info.path);
  if (projectIndex >= 0) projects[projectIndex] = info;
  else projects = [...projects, info].slice(-12);
  if (pluginsPanel) run(() => pluginsPanel!.setProject(info.path, info.title || info.name));
  fileEditor?.setProject(info.path);
  if (projectChanged) workspaceView = projectWorkspaceViews.get(info.path) === 'editor' && hasCurrentEditor() ? 'editor' : 'terminal';
  syncTreeSelection();
  const previous = lastActive.get(info.path);
  activeId = previous && sessions.has(previous) ? previous : [...sessions.values()].find(s => s.cwd === info.path)?.id || null;
  renderProject();
  if (projectChanged && (mainView === 'terminal' || mainView === 'editor' || mainView === 'browser')) selectMainView(workspaceView);
  else focusSession(activeId, mainView !== 'editor');
  if (projectChanged && selectedPanel !== null) selectPanel('files', false);
  // Clear the previous project's tree immediately, even when chat startup is slow.
  // Attach the rejection handler now so a slow chat cannot leave it unhandled.
  const treeLoading = selectedPanel === 'files' && treeProject !== info.path ? loadRootTree().then(() => null, (error: unknown) => ({ error })) : null;
  if (mainView === 'chat' && chatView) { await chatView.open(info.path); if (!valid()) return false; }
  if (treeLoading) { const result = await treeLoading; if (!valid()) return false; if (result) throw result.error; }
  await loadServices(info.path, valid); if (!valid()) return false;
  if (mainView === 'graph') { await loadGraph(valid); if (!valid()) return false; }
  if (mainView === 'browser') renderBrowserServices();
  if (mainView === 'action') {
    const result = actionResults.get(info.path);
    if (result) { await showActionResult(result); if (!valid()) return false; }
    else $('action-content').textContent = runningActions.has(info.path) ? 'Executando a ação do DK…' : 'Escolha uma ação do DK para visualizar seu resultado.';
    button('cancel-action').hidden = !runningActions.has(info.path);
  }
  void refreshClaudePlugin().catch(notify);
  return valid();
}
async function openProject() {
  const intent = beginProjectIntent(), snapshot = launcher.captureState();
  const info = await api.selectProject(); if (!info) return;
  rememberRecent(info);
  if (!launcher.isCurrent(snapshot)) { notify('Projeto disponível nos recentes.'); return; }
  if (await activate(info, intent)) launcher.completeOpen(snapshot, intent === projectIntent);
}
async function newSession(action?: string, duplicate?: string, agent?: string, create?: () => Promise<SessionInfo | null>) {
  if (!current || busy || closingProjects.has(current.path)) return false;
  const previousFocus = activeId;
  // A cancelled plugin prompt must leave the current browser/chat/graph intact.
  if (!create && !duplicate && mainView !== 'terminal' && mainView !== 'editor') selectMainView(workspaceView);
  busy = true;
  const agentId = agent || (action?.startsWith('extension:') ? action.slice(10) : undefined);
  const agentName = installedExtensions.find(item => item.id === agentId)?.name;
  const pendingAgent = agentName ? { root: current.path, name: agentName } : null;
  if (pendingAgent) { agentOpening = pendingAgent; renderTabs(); }
  let release!: () => void;
  opening = new Promise<void>(resolve => { release = resolve; });
  let info: SessionInfo | undefined;
  let terminal: Terminal | undefined;
  let element: HTMLDivElement | undefined;
  try {
    info = (create ? await create() : duplicate ? await api.splitTerminal(current.path, duplicate, agent) : await api.createTerminal(current.path, action)) || undefined;
    if (!info) return false; // The user cancelled a plugin confirmation.
    if ((create || duplicate) && mainView !== 'terminal' && mainView !== 'editor') selectMainView(workspaceView);
    if (duplicate && info.cwdFallback) notify('Não foi possível identificar a pasta atual; o novo terminal abriu na última pasta conhecida.');
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    terminal = new Terminal({
      fontFamily: '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace', fontSize: preferences.fontSize, lineHeight: 1.5,
      cursorBlink: false, cursorStyle: 'bar', scrollback: preferences.scrollback, screenReaderMode: false, allowProposedApi: false, disableStdin: true,
      theme: { background: document.body.classList.contains('theme-sea') ? '#10181d' : '#101214', foreground: '#d4d9df', cursor: '#6ed9b0', selectionBackground: '#304d46', black: '#31383f', red: '#f38b91', green: '#87d6ad', yellow: '#edcf8c', blue: '#8db9ec', magenta: '#cba9ef', cyan: '#8cd7dc', white: '#e6e9ed', brightBlack: '#7b858f', brightRed: '#ffa6ab', brightGreen: '#a4edc5', brightYellow: '#ffe4a6', brightBlue: '#b0d1ff', brightMagenta: '#e3c4ff', brightCyan: '#a9f0f4', brightWhite: '#ffffff' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    element = document.createElement('div'); element.id = `pane-${info.id}`; element.className = 'terminal-pane'; element.role = 'tabpanel'; element.setAttribute('aria-labelledby', `tab-${info.id}`); $('terminal-host').append(element);
    const session: Session = { ...info, terminal, fit, element, started: false, exited: false, ackPending: 0 };
    element.onpointerdown = () => { if (activeId !== session.id) focusSession(session.id); };
    sessions.set(info.id, session);
    terminal.open(element);
    terminal.onData(data => { if (idleId === session.id) { idleSnapshot = null; renderIdleNotice(); } if (!session.exited) api.writeTerminal(session.id, data).catch(notify); });
    focusSession(info.id);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    fit.fit();
    await api.startTerminal(info.id, { cols: terminal.cols, rows: terminal.rows });
    session.lastSize = { cols: terminal.cols, rows: terminal.rows };
    session.started = true; element.dataset.ready = 'true'; terminal.options.disableStdin = false;
    renderTabs(); terminal.focus(); fitActive();
    return true;
  } catch (error) {
    if (info) { sessions.delete(info.id); await api.closeTerminal(info.id).catch(() => {}); }
    terminal?.dispose(); element?.remove();
    if (info || terminal || element) focusSession(duplicate && sessions.has(duplicate) ? duplicate : previousFocus && sessions.has(previousFocus) ? previousFocus : null);
    throw error;
  } finally { if (agentOpening === pendingAgent) agentOpening = null; busy = false; release(); if (pendingAgent) renderTabs(); }
}
async function closeSession(id: string) {
  const session = sessions.get(id); if (!session || session.closing) return;
  session.closing = true;
  let result: {partial:boolean};
  try { result = await api.closeTerminal(id); }
  catch(error) { session.closing = false; throw error; }
  if (sessions.get(id) !== session) return;
  clearTimeout(session.ackTimer); session.ackPending = 0;
  sessions.delete(id); idleSnoozed.delete(id); session.terminal.dispose(); session.element.remove();
  renderIdleNotice();
  const group = paneGroups.get(session.cwd);
  if (group) { group.ids = group.ids.filter(key => key !== id); if (group.ids.length < 2) paneGroups.delete(session.cwd); }
  if (activeId === id) focusSession([...sessions.values()].filter(s => s.cwd === current?.path).at(-1)?.id || null);
  else renderTabs();
  if (result?.partial) notify('A sessão foi fechada, mas não foi possível confirmar o encerramento de todos os processos associados.');
}
async function splitTerminal(direction: 'right' | 'down', agent?: string) {
  if (!current || !activeId || busy) return;
  const root = current.path, previous = activeId;
  const group = paneGroups.get(root);
  const ids = group?.ids.includes(previous) ? [...group.ids] : [previous];
  if (ids.length >= 4) throw new Error('Esta visualização já tem quatro painéis. Abra outra sessão para continuar.');
  await newSession(undefined, previous, agent);
  if (current?.path === root && activeId && activeId !== previous) {
    paneGroups.set(root, { ids: [...ids, activeId], direction }); focusSession(activeId);
  }
}
function toggleSearch(show = $('search-bar').hidden) {
  if (!active()) return;
  $('search-bar').hidden = !show;
  if (show) { $<HTMLInputElement>('terminal-search').focus(); void ensureSearch(active()!).catch(notify); } else active()?.terminal.focus();
  requestAnimationFrame(fitActive);
}
async function ensureSearch(session: Session): Promise<SearchAddon | null> {
  if (session.search) return session.search;
  if (!session.searchLoading) session.searchLoading = import('@xterm/addon-search').then(({ SearchAddon }) => {
    if (sessions.get(session.id) !== session) return null;
    const addon = new SearchAddon(); session.terminal.loadAddon(addon); session.search = addon; return addon;
  }).finally(() => { session.searchLoading = undefined; });
  return session.searchLoading;
}
function search(previous = false) {
  const query = $<HTMLInputElement>('terminal-search').value;
  const session = active(); if (!session || !query) return;
  void ensureSearch(session).then(addon => {
    if (!addon || active() !== session || $('search-bar').hidden || $<HTMLInputElement>('terminal-search').value !== query) return;
    const found = previous ? addon.findPrevious(query) : addon.findNext(query);
    $<HTMLInputElement>('terminal-search').classList.toggle('no-match', !found);
  }).catch(notify);
}

function acknowledgeOutput(session: Session, count: number) {
  session.ackPending += count;
  const flush = () => {
    clearTimeout(session.ackTimer); session.ackTimer = undefined;
    if (!sessions.has(session.id)) { session.ackPending = 0; return; }
    while (session.ackPending > 0) {
      const amount = Math.min(session.ackPending, 1024 * 1024);
      session.ackPending -= amount;
      api.acknowledgeTerminal(session.id, amount).catch(() => {});
    }
  };
  if (session.ackPending >= 128 * 1024) flush();
  else if (!session.ackTimer) session.ackTimer = setTimeout(flush, 20);
}
api.onTerminalData(({ id, data }) => {
  const session = sessions.get(id);
  if (idleId === id) { idleSnapshot = null; renderIdleNotice(); }
  if (session) session.terminal.write(data, () => acknowledgeOutput(session, data.length));
});
api.onTerminalExit(({ id, exitCode }) => {
  const session = sessions.get(id); if (!session) return;
  session.exited = true; session.exitCode = exitCode;
  session.terminal.options.cursorBlink = false;
  session.terminal.writeln(`\r\n\x1b[90m[Sessão encerrada · código ${exitCode}]\x1b[0m`);
  renderTabs();
});
api.onServiceChanged(({ path, service }) => updateService(path, service));
api.onChatEvent(event => { if (idleId === event.sessionId) { idleSnapshot = null; renderIdleNotice(); } chatView?.handle(event); });
api.onProjectOpened(info => run(async () => { const intent = beginProjectIntent(), snapshot = launcher.captureState(); if (await activate(info, intent)) launcher.completeOpen(snapshot, intent === projectIntent); }));
api.onOrchestrationChanged(({ path }) => { if (current?.path === path && mainView === 'graph') run(loadGraph); });
api.onPluginsChanged(({ path }) => { const panel = pluginsPanel; if (current?.path === path && panel) run(() => panel.reload()); });
api.onExtensionsChanged(list => { installedExtensions = list; renderExtensions(); });
api.onBrowserRequest(event => {
  void (async () => {
    let ok = false;
    try {
      const root = event.root;
      if (current?.path !== root || closingProjects.has(root)) throw new Error('Abra o projeto correspondente antes de visualizar o protótipo.');
      let tab = browserTabs.get(root);
      if (!tab) {
        tab = { id: null, ready: null, url: '', wantedService: '', selectedService: '', waitingForService: false, status: 'Carregando prévia…' };
        browserTabs.set(root, tab);
        tab.ready = prepareBrowserTab(root, tab);
      }
      const expected = tab;
      selectMainView('browser');
      try { if (!await expected.ready) throw new Error('A guia de navegador não está disponível.'); }
      catch (error) {
        if (browserTabs.get(root) === expected) { browserTabs.delete(root); if (current?.path === root && mainView === 'browser') selectMainView(workspaceView); else renderTabs(); }
        throw error;
      }
      if (browserTabs.get(root) !== expected || current?.path !== root) throw new Error('Abra o projeto correspondente antes de visualizar o protótipo.');
      expected.wantedService = ''; expected.selectedService = ''; expected.waitingForService = false;
      expected.caption = event.title || undefined;
      if (mainView === 'browser') renderBrowserServices('');
      await navigatePreview(root, event.url, expected);
      ok = current?.path === root && mainView === 'browser' && browserTabs.get(root) === expected && expected.url === event.url;
    } catch (error) { notify(error); }
    finally { await api.finishBrowserRequest(event.id, ok).catch(() => {}); }
  })();
});
api.onBrowserChanged(event => {
  const tab = browserTabs.get(event.path); if (!tab || tab.id !== event.id) return;
  setBrowserStatus(event.path, tab, event.error ? `Falha na prévia: ${event.error}` : event.loading ? 'Carregando prévia…' : `${tab.caption ? `${tab.caption} · ` : ''}Projeto local · A página pode acessar a rede`);
  if (event.url) {
    tab.url = event.url;
    if (current?.path === event.path && mainView === 'browser') $<HTMLInputElement>('browser-address').value = event.url;
  }
});
api.onBrowserFullscreenChanged(active => {
  browserFullscreenActive = active;
  if (!active && !browserFullscreenPending) browserFullscreenDesired = false;
  // Ignore a late entry after navigation has already requested an exit.
  renderBrowserFullscreen();
  if (active && (!browserFullscreenDesired || mainView !== 'browser') && !browserFullscreenPending) leaveBrowserFullscreen();
});
api.onBrowserFullscreenError(notify);
api.onMenu(action => {
  if (action === 'open') run(openProject);
  if (action === 'new') run(() => newSession());
  if (action === 'save' && mainView === 'editor') run(async () => fileEditor?.saveCurrent());
  if (action === 'close' && mainView === 'editor' && focusedPane === 'editor') run(async () => fileEditor?.closeCurrent());
  else if (action === 'close' && mainView === 'browser' && current) run(() => closeBrowserTab(current!.path));
  else if (action === 'close' && mainView !== 'terminal' && mainView !== 'editor') selectMainView(workspaceView);
  else if (action === 'close' && activeId) run(() => closeSession(activeId!));
  if (action === 'editor') selectMainView('editor');
  if (action === 'search' && (mainView === 'terminal' || mainView === 'editor')) { if (mainView === 'editor' && focusedPane === 'editor') fileEditor?.search(); else toggleSearch(); }
  if (action === 'clear' && (mainView === 'terminal' || mainView === 'editor')) active()?.terminal.clear();
  if (action === 'expand') expandTerminal();
  if (action === 'split-right') run(() => splitTerminal('right'));
  if (action === 'split-down') run(() => splitTerminal('down'));
});
button('open-project').onclick = button('welcome-open').onclick = () => run(openProject);
async function refreshClaudePlugin() {
  const root = current?.path || null;
  const result = await api.checkClaudePlugin(root);
  if ((current?.path || null) !== root) return;
  pluginStatus = result.status; kit = result.activeKit; renderKit();
}
button('install-dk-plugin').onclick = () => run(async () => {
  const control = button('install-dk-plugin'); control.disabled = true; control.textContent = 'Instalando plugin DK…';
  try { const result = await api.installClaudePlugin(current?.path || null); pluginStatus = result.status; kit = result.activeKit; renderKit(); }
  finally { control.disabled = false; renderKit(); }
});
button('reveal-project').onclick = () => { if (current) run(() => api.revealProject(current!.path)); };
button('new-session').onclick = button('empty-new').onclick = () => run(() => newSession());
button('launch-claude').onclick = () => run(() => newSession('extension:claude'));
button('launch-codex').onclick = () => run(openCodex);
for (const id of ['antigravity', 'gemini', 'dk']) button(`launch-${id}`).onclick = () => run(() => newSession(`extension:${id}`));
button('open-browser').onclick = () => run(openBrowserView);
document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(el => { el.onclick = () => run(() => runDkAction(el.dataset.action!)); });
button('search-toggle').onclick = () => toggleSearch();
button('expand-terminal').onclick = expandTerminal;
button('split-right').onclick = () => run(() => splitTerminal('right'));
button('split-down').onclick = () => run(() => splitTerminal('down'));
function closeSplitMenu() { $('split-menu').hidden = true; button('split-agent').setAttribute('aria-expanded', 'false'); }
button('split-agent').onclick = () => {
  const menu = $('split-menu');
  if (!menu.hidden) { closeSplitMenu(); return; }
  menu.replaceChildren();
  for (const extension of installedExtensions.filter(item => item.kind === 'terminal')) {
    for (const direction of ['right', 'down'] as const) {
      const item = document.createElement('button'); item.role = 'menuitem'; item.disabled = !extension.available;
      item.textContent = `${extension.name} ${direction === 'right' ? 'à direita' : 'abaixo'}`;
      item.onclick = () => { closeSplitMenu(); run(() => splitTerminal(direction, extension.id)); };
      menu.append(item);
    }
  }
  const bounds = button('split-agent').getBoundingClientRect();
  menu.style.top = `${bounds.bottom + 5}px`; menu.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - 240))}px`;
  menu.hidden = false; button('split-agent').setAttribute('aria-expanded', 'true');
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
};
document.addEventListener('pointerdown', event => { if (!$('split-menu').contains(event.target as Node) && !button('split-agent').contains(event.target as Node)) closeSplitMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('split-menu').hidden) { closeSplitMenu(); button('split-agent').focus(); } });
button('detach-pane').onclick = () => {
  if (!current || !activeId) return;
  const group = paneGroups.get(current.path);
  if (!group || !group.ids.includes(activeId)) return;
  group.ids = group.ids.filter(id => id !== activeId);
  if (group.ids.length < 2) paneGroups.delete(current.path);
  focusSession(activeId);
};
button('single-terminal').onclick = () => { if (current) paneGroups.delete(current.path); focusSession(activeId); };
button('show-graph').onclick = () => selectMainView('graph');
button('graph-back').onclick = () => selectMainView(workspaceView);
button('refresh-graph').onclick = () => run(loadGraph);
button('action-back').onclick = () => selectMainView(workspaceView);
button('cancel-action').onclick = () => { if (current) run(() => api.cancelAction(current!.path)); };
button('refresh-usage').onclick = () => run(() => loadUsage(true));
button('browser-back').onclick = () => selectMainView(workspaceView);
async function copyPreviewInstructions() {
  await api.copyPreviewInstructions();
  notify('Instrução copiada. Cole no chat da IA ou no AGENTS.md, CLAUDE.md ou GEMINI.md do projeto.');
}
button('browser-copy-ai').onclick = () => run(copyPreviewInstructions);
button('preview-ai-copy').onclick = () => run(copyPreviewInstructions);
button('browser-fullscreen').onclick = () => run(() => setBrowserFullscreen(!browserFullscreenDesired && !browserFullscreenRecovery));
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.key !== 'Escape' || mainView !== 'browser' || !$('launcher').hidden) return;
  if (browserFullscreenDesired || browserFullscreenActive || browserFullscreenPending || browserFullscreenRecovery) {
    event.preventDefault();
    run(() => setBrowserFullscreen(false));
    button('browser-fullscreen').focus();
  }
});
$('browser-service').onchange = () => {
  const tab = current ? browserTabs.get(current.path) : undefined; if (!tab) return;
  tab.wantedService = ''; tab.waitingForService = false; tab.selectedService = $<HTMLSelectElement>('browser-service').value; renderBrowserServices();
};
$('browser-navigation').onsubmit = event => {
  event.preventDefault(); if (!current) return;
  const root = current.path, tab = browserTabs.get(root); if (!tab) return;
  tab.wantedService = ''; tab.waitingForService = false; tab.caption = undefined; run(() => navigatePreview(root, $<HTMLInputElement>('browser-address').value.trim(), tab));
};
button('browser-start').onclick = () => run(async () => {
  if (!current) return;
  const root = current.path, id = $<HTMLSelectElement>('browser-service').value;
  const item = projectServices.get(root)?.find(service => service.id === id); if (!item) return;
  await startBrowserService(root, item);
});
button('browser-stop').onclick = () => run(async () => {
  if (!current) return;
  const root = current.path, id = $<HTMLSelectElement>('browser-service').value, tab = browserTabs.get(root);
  updateService(root, await api.stopService(root, id));
  if (tab && browserTabs.get(root) === tab && (tab.wantedService === id || tab.selectedService === id)) {
    tab.wantedService = ''; tab.waitingForService = false; setBrowserStatus(root, tab, 'Serviço encerrado.');
  }
});
button('refresh-tree').onclick = () => run(loadRootTree);
document.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach((control, index, controls) => {
  control.onclick = () => {
    const panel = control.dataset.panel as InspectorPanel;
    selectPanel(selectedPanel === panel ? null : panel);
  };
  control.onkeydown = event => {
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % controls.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + controls.length - 1) % controls.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = controls.length - 1;
    else return;
    event.preventDefault(); controls[next].focus();
  };
});
function sidebar(collapsed: boolean) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  button('toggle-sidebar').setAttribute('aria-expanded', String(!collapsed));
  button('toggle-sidebar').setAttribute('aria-label', collapsed ? 'Expandir sidebar' : 'Recolher sidebar');
  try { localStorage.setItem('sidebarCollapsed', String(collapsed)); } catch {}
  requestAnimationFrame(fitActive);
  schedulePreviewResize();
}
function setSeaTheme(enabled: boolean) {
  document.body.classList.toggle('theme-sea', enabled);
  button('theme-toggle').setAttribute('aria-pressed', String(enabled));
  document.querySelector<HTMLElement>('.sea-signature')!.hidden = !enabled;
  for (const session of sessions.values()) session.terminal.options.theme = { ...session.terminal.options.theme, background: enabled ? '#10181d' : '#101214', cursor: enabled ? '#7fcde3' : '#6ed9b0' };
  try { localStorage.setItem('seaTheme', String(enabled)); } catch {}
}
let glassTransparency = 12;
function setGlassTransparency(value: number) {
  glassTransparency = Number.isFinite(value) ? Math.max(0, Math.min(60, Math.round(value))) : 12;
  document.body.style.setProperty('--glass-transparency', `${glassTransparency}%`);
  try { localStorage.setItem('glassTransparency', String(glassTransparency)); } catch {}
}
function setGlassAppearance(enabled: boolean) {
  document.body.classList.toggle('appearance-glass', enabled);
  try { localStorage.setItem('glassAppearance', String(enabled)); } catch {}
}
button('launcher-show').onclick = () => launcher.show('home');
button('profile-show').onclick = () => launcher.show('settings');
button('theme-toggle').onclick = () => setSeaTheme(!document.body.classList.contains('theme-sea'));
try { setSeaTheme(localStorage.getItem('seaTheme') !== 'false'); } catch { setSeaTheme(true); }
try { const saved = localStorage.getItem('glassTransparency'); setGlassTransparency(saved === null ? 12 : Number(saved)); } catch { setGlassTransparency(12); }
try { setGlassAppearance(localStorage.getItem('glassAppearance') === 'true'); } catch { setGlassAppearance(false); }
function setSystemResourcesCollapsed(collapsed: boolean) {
  $('system-resources-content').hidden = collapsed;
  const control = button('system-resources-toggle'); control.setAttribute('aria-expanded', String(!collapsed));
  control.querySelector('svg')!.classList.toggle('collapsed', collapsed);
  try { localStorage.setItem('systemResourcesCollapsed', String(collapsed)); } catch {}
}
button('system-resources-toggle').onclick = () => setSystemResourcesCollapsed(!$('system-resources-content').hidden);
try { setSystemResourcesCollapsed(localStorage.getItem('systemResourcesCollapsed') === 'true'); } catch { setSystemResourcesCollapsed(false); }
button('toggle-sidebar').onclick = () => sidebar(!document.body.classList.contains('sidebar-collapsed'));
try { sidebar(localStorage.getItem('sidebarCollapsed') === 'true'); } catch {}
button('search-close').onclick = () => toggleSearch(false);
button('search-next').onclick = () => search(); button('search-previous').onclick = () => search(true);
$('terminal-search').oninput = () => { $('terminal-search').classList.remove('no-match'); search(); };
$('terminal-search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); search(event.shiftKey); } if (event.key === 'Escape') toggleSearch(false); };
$('terminal-view').addEventListener('focusin', event => { if (!(event.target instanceof Node) || !$('editor-view').contains(event.target)) focusedPane = 'terminal'; });
$('editor-view').addEventListener('focusin', () => { focusedPane = 'editor'; });
button('optimize-resources').onclick = () => run(async () => {
  const control = button('optimize-resources'), status = $('optimize-status');
  if (control.disabled) return;
  control.disabled = true; status.textContent = 'Otimizando recursos do SEA Dock…';
  try {
    fileEditor?.clearTemporaryImages();
    await api.optimizeApp();
    status.textContent = 'Caches temporários do SEA Dock limpos.';
    void refreshResources();
  } catch (error) { status.textContent = 'Não foi possível concluir a otimização.'; throw error; }
  finally { control.disabled = false; }
});
button('clear-system-cache').onclick = () => run(async () => {
  const control=button('clear-system-cache'), status=$('optimize-status');if(control.disabled)return;
  control.disabled=true;status.textContent='Aguardando confirmação…';
  try {const result=await api.clearSystemCache();status.textContent=result.status==='completed'?'Cache de arquivos do macOS limpo.':'Limpeza cancelada.';if(result.status==='completed')void refreshResources();}
  catch(error){status.textContent='A limpeza foi cancelada ou não pôde ser concluída.';throw error;}
  finally {control.disabled=false;}
});
button('open-activity-monitor').onclick = () => run(() => api.openActivityMonitor());
const idleWarningMs = () => preferences.idleMinutes * 60 * 1000;
const idleSnoozed = new Map<string, number>();
let idleSnapshot: ResourceSnapshot | null = null, idleId: string | null = null;
function renderIdleNotice() {
  const now = Date.now();
  const candidate = preferences.idleAlerts ? idleSnapshot?.sessions.find(item => {
    const session = sessions.get(item.id);
    return (item.kind === 'codex' ? !!item.root : !!session && !session.exited) && item.memoryKiB >= preferences.idleMemoryMiB * 1024 && now - item.lastActivity >= idleWarningMs() && now >= (idleSnoozed.get(item.id) || 0);
  }) : undefined;
  idleId = candidate?.id || null; $('idle-notice').hidden = !candidate;
  if (!candidate) return;
  const session = sessions.get(candidate.id);
  const root = candidate.kind === 'codex' ? candidate.root : session?.cwd;
  const projectName = projects.find(project => project.path === root);
  const projectLabel = projectName?.title || projectName?.name || 'Projeto';
  const label = candidate.kind === 'codex' ? 'Codex' : session?.label || 'Terminal';
  $('idle-description').textContent = `${label} · ${projectLabel}${candidate.pid ? ` · PID ${candidate.pid}` : ''} · ${formatMemory(candidate.memoryKiB)} de RSS estimado. Sem entrada ou saída há pelo menos ${preferences.idleMinutes} minutos.`;
  button('idle-close').textContent = candidate.kind === 'codex' ? 'Interromper Codex' : 'Encerrar sessão';
}
button('idle-keep').onclick = () => { if (idleId) idleSnoozed.set(idleId, Date.now() + idleWarningMs()); renderIdleNotice(); };
button('idle-close').onclick = () => {
  const item = idleSnapshot?.sessions.find(candidate => candidate.id === idleId); if (!item) return;
  run(async () => { if (item.kind === 'codex' && item.root) await api.cancelChat(item.root, item.id); else await closeSession(item.id); idleSnapshot = null; renderIdleNotice(); });
};
let resourceTimer: ReturnType<typeof setTimeout> | undefined;
let resourceBusy = false, resourceHasSample = false;
function formatCpu(value: number | null) {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}
function formatMemory(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '—';
  const mib = value / 1024;
  return mib >= 1024 ? `${(mib / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB` : `${Math.round(mib).toLocaleString('pt-BR')} MB`;
}
function renderResources(data: ResourceSnapshot) {
  idleSnapshot = data; renderIdleNotice();
  const combined = data.children !== null;
  $('resource-scope').textContent = 'SEA Dock';
  $('resource-cpu').textContent = formatCpu(data.app.cpuPercent);
  $('resource-memory').textContent = formatMemory(data.app.memoryKiB);
  const details = [
    `SEA Dock: CPU ${formatCpu(data.app.cpuPercent)} · RAM ${formatMemory(data.app.memoryKiB)} · ${data.app.processCount} processo(s)`,
    combined ? `Processos filhos detectados (terminais, agentes e serviços): CPU ${formatCpu(data.children!.cpuPercent)} · RAM ${formatMemory(data.children!.memoryKiB)} · ${data.children!.processCount} processo(s)` : 'Consumo dos processos externos indisponível nesta plataforma.',
    data.otherProcesses ? `Outros processos detectados: RAM RSS ${formatMemory(data.otherProcesses.memoryKiB)} · ${data.otherProcesses.processCount} processo(s)` : 'Consumo dos demais processos indisponível.',
    'CPU aproximada: 100% corresponde a um núcleo; pode ultrapassar 100%. RAM é a soma residente e pode incluir memória compartilhada.',
    `Atualizado às ${new Date(data.sampledAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
  ].join('\n');
  $('resource-indicator').title = details;
  const machine = data.system;
  $('system-dk-memory').textContent = formatMemory(data.app.memoryKiB);
  $('system-child-memory').textContent = formatMemory(data.children?.memoryKiB ?? null);
  $('system-other-memory').textContent = formatMemory(data.otherProcesses?.memoryKiB ?? null);
  $('system-available').textContent = machine.availablePercent == null ? '—' : formatCpu(machine.availablePercent);
  $('system-cache-label').textContent = machine.cache?.kind === 'purgeable' ? 'Purgável · parcial' : 'Cache recuperável · estimado';
  $('system-cache').textContent = formatMemory(machine.cache?.memoryKiB ?? null);
  $('system-pressure').textContent = machine.pressure?.kind === 'linux-psi' ? `${machine.pressure.someAvg10.toLocaleString('pt-BR', {maximumFractionDigits:2})}% espera` : 'Indisponível';
  const systemCpu = formatCpu(machine.cpuPercent);
  const systemMemory = machine.memoryUsedKiB == null || machine.memoryTotalKiB == null ? '—' : `${formatMemory(machine.memoryUsedKiB)} / ${formatMemory(machine.memoryTotalKiB)}`;
  const swap = machine.swap;
  const systemSwap = swap ? `${formatMemory(swap.usedKiB)} / ${formatMemory(swap.totalKiB)}` : '—';
  $('system-cpu').textContent = systemCpu; $('system-memory').textContent = systemMemory; $('system-swap').textContent = systemSwap;
  $('system-swap-bar').style.width = `${swap?.totalKiB ? Math.max(0, Math.min(100, swap.usedKiB / swap.totalKiB * 100)) : 0}%`;
  $('system-cpu-bar').style.width = `${machine.cpuPercent == null ? 0 : Math.max(0, Math.min(100, machine.cpuPercent))}%`;
  $('system-cpu-bar').classList.toggle('high', machine.cpuPercent != null && machine.cpuPercent >= 80);
  const memoryPercent = machine.memoryUsedKiB == null || !machine.memoryTotalKiB ? 0 : machine.memoryUsedKiB / machine.memoryTotalKiB * 100;
  $('system-memory-bar').style.width = `${Math.max(0, Math.min(100, memoryPercent))}%`;
  const description = 'Máquina inteira: CPU média de todos os núcleos. Memória não livre inclui cache e não equivale à pressão de memória. RSS é uma soma aproximada por processo e pode contar páginas compartilhadas várias vezes; não é uma divisão exata da memória física. No macOS, purgável cobre apenas uma parte do cache recuperável e disponibilidade não é pressão. No Linux, a pressão PSI indica a porcentagem média de tempo com alguma tarefa esperando memória nos últimos 10 segundos. Swap mostra uso e espaço atualmente alocado.';
  $('system-resources').title = description;
  $('system-resources').setAttribute('aria-label', `${description} CPU ${systemCpu}; memória não livre ${systemMemory}; swap ${systemSwap}.`);
  $('resource-indicator').setAttribute('aria-label', `SEA Dock: CPU ${formatCpu(data.app.cpuPercent)}, RAM RSS ${formatMemory(data.app.memoryKiB)}. Processos filhos e outros processos estão no detalhamento da máquina.`);
}
async function refreshResources() {
  clearTimeout(resourceTimer);
  if (document.visibilityState !== 'visible' || resourceBusy) return;
  resourceBusy = true;
  try { const data = await api.readResources(); renderResources(data); }
  catch { $('resource-cpu').textContent = '—'; $('resource-memory').textContent = '—'; $('resource-scope').textContent = 'SEA Dock'; $('resource-indicator').title = 'Consumo de recursos indisponível.'; $('resource-indicator').setAttribute('aria-label', 'Consumo de recursos indisponível.'); for(const id of ['system-cpu','system-memory','system-swap','system-dk-memory','system-child-memory','system-other-memory','system-available','system-cache','system-pressure']) $(id).textContent='—'; $('system-cpu-bar').style.width = $('system-memory-bar').style.width = $('system-swap-bar').style.width = '0%'; $('system-cpu-bar').classList.remove('high'); $('system-resources').title = 'Consumo da máquina indisponível.'; $('system-resources').setAttribute('aria-label', 'Consumo da máquina indisponível.'); }
  finally {
    resourceBusy = false;
    if (document.visibilityState === 'visible') {
      const delay = resourceHasSample ? 10000 : 2000;
      resourceHasSample = true; resourceTimer = setTimeout(() => { void refreshResources(); }, delay);
    }
  }
}
document.addEventListener('visibilitychange', () => {
  updateTerminalVisibility();
  clearTimeout(resourceTimer);
  if (document.visibilityState === 'visible') { resourceHasSample = false; void refreshResources(); }
});
window.addEventListener('focus', updateTerminalVisibility);
window.addEventListener('blur', updateTerminalVisibility);
let resizeFrame = 0;
new ResizeObserver(() => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(fitActive); }).observe($('terminal-host'));
new ResizeObserver(schedulePreviewResize).observe($('browser-canvas'));
window.addEventListener('resize', schedulePreviewResize);
// Native child views are always drawn above the HTML document. Hide the
// existing view while the launcher is open, retaining its page and session.
let browserPreviewVisible = true;
const syncBrowserVisibility = () => {
  const visible = $('launcher').hidden === true;
  if (visible === browserPreviewVisible) return;
  browserPreviewVisible = visible;
  api.setBrowserVisible(visible).catch(notify);
  if (visible) schedulePreviewResize();
};
new MutationObserver(syncBrowserVisibility).observe($('launcher'), { attributes: true, attributeFilter: ['hidden'] });
syncBrowserVisibility();

run(async () => {
  try {
  const state = await api.bootstrap(); projects = state.projects; recentProjects = [...state.projects]; remoteProjects = state.remoteProjects; kit = state.kit; installedExtensions = state.extensions;
  if (state.extensionErrors.length) notify(state.extensionErrors.join('\n'));
  $('version').textContent = `v${state.version}`;
  $('mac-memory-tools').hidden = state.platform !== 'darwin';
  if (state.platform !== 'darwin') { document.body.classList.add('other-platform'); document.querySelector('kbd')!.textContent = 'Ctrl O'; }
  renderProject();
  if (state.startupProject) await activate(state.startupProject); else if (!current) launcher.show('home');
  void refreshClaudePlugin().catch(notify);
  } finally {
    void refreshResources();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const remaining = reduced ? 0 : Math.max(0, Math.max(1600, startupMotion.finishBy) - performance.now());
    if (remaining) await new Promise(resolve => setTimeout(resolve, remaining));
    startupMotion.complete();
    document.body.classList.remove('booting');
    const loading = $('startup-loading');
    loading.classList.add('is-leaving');
    setTimeout(() => loading.remove(), reduced ? 0 : 260);
  }
});
