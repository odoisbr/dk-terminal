import { serializeCatalogTask } from './catalog';
import { iconMark, setIconButton } from './icons';

export type AgentRunPreset = {
  skillHint?: string;
  stage?: StageId;
  prompt?: string;
};

export type AgentRunApi = {
  capabilities(root: string): Promise<AgentCapabilities>;
  list(root: string): Promise<AgentRun[]>;
  read(root: string, runId: string): Promise<AgentRunSnapshot>;
  start(root: string, options: AgentStartOptions): Promise<Pick<AgentRun, 'runId' | 'estado'>>;
  cancel(root: string, runId: string): Promise<void>;
  approve(root: string, runId: string, requestId: string, choice: 'allow' | 'deny'): Promise<void>;
  previewPrompt(root: string, options?: AgentPromptOptions): Promise<PromptPreview>;
  listCatalog?(root: string, refresh?: boolean): Promise<CatalogList>;
  readStages?(root: string, refresh?: boolean): Promise<StagesSnapshot>;
  listDirectory?(root: string, relative?: string): Promise<DirectoryListing>;
  onBack?: () => void;
  onOpenTerminal?: () => void;
};

type ProjectDraft = {
  prompt: string;
  skillId: string;
  designSystemId: string;
  files: string[];
  resume: boolean;
};

type StreamItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; messageId: string; text: string }
  | {
      id: string;
      kind: 'tool';
      toolUseId: string;
      name: string;
      inputResumo: string;
      inputBytes: number;
      estado: 'iniciado' | 'concluido';
      hasResult: boolean;
      content: string;
      isError: boolean;
      truncado: boolean;
    }
  | {
      id: string;
      kind: 'approval';
      requestId: string;
      approvalKind: 'tool' | 'prazo';
      status: 'pending' | 'allowed' | 'denied' | 'expired';
      toolName?: string;
      displayName?: string;
      resumo?: string;
      input?: Record<string, unknown>;
      description?: string;
      blockedPath?: string;
      decisionReason?: string;
      prazoMs?: number;
    }
  | { id: string; kind: 'error'; message: string; fatal: boolean };

const ACTIVE_STATES = new Set<string>([
  'na_fila',
  'iniciando',
  'executando',
  'aguardando_aprovacao',
  'prazo_vencido',
  'interrompendo',
]);

const LAYER_LABELS: Record<PromptPreview['camadas'][number]['id'], string> = {
  guia_dk: 'Guia do SEA Dock',
  skill_ativa: 'Skill ativa',
  design_system: 'Design system',
  craft: 'Craft',
  instrucoes_projeto: 'Instruções do projeto (AGENTS.md)',
  etapa_ativa: 'Etapa ativa',
  arquivos: 'Arquivos escolhidos',
};

const ORIGIN_LABELS: Record<Catalog['origin']['type'], string> = {
  kit: 'Kit',
  project: 'Projeto',
  plugin: 'Plugin',
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
}

function button(label: string, action: () => void, className = ''): HTMLButtonElement {
  const result = element('button', className, label);
  result.type = 'button';
  result.addEventListener('click', action);
  return result;
}

function statusText(status?: string): string {
  const labels: Record<string, string> = {
    idle: 'Pronto para nova tarefa',
    na_fila: 'Na fila…',
    iniciando: 'Iniciando Claude…',
    executando: 'Claude executando…',
    aguardando_aprovacao: 'Aguardando sua autorização',
    prazo_vencido: 'Prazo atingido · aguardando decisão',
    interrompendo: 'Interrompendo…',
    concluido: 'Concluído',
    interrompido: 'Interrompido',
    falhou: 'Falhou',
    expirada: 'Sessão anterior encerrada',
    iniciado: 'Em execução',
    pending: 'Aguardando decisão',
    allowed: 'Permitido uma vez',
    denied: 'Recusado',
    expired: 'Solicitação encerrada',
  };
  return status ? labels[status] || status : '';
}

function isRunActive(run: AgentRun | null | undefined): boolean {
  return Boolean(run && ACTIVE_STATES.has(run.estado));
}

function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes >= 0 ? Math.trunc(bytes) : 0;
  return `${safe.toLocaleString('pt-BR')} bytes`;
}

function formatUsage(usage?: AgentUsage, model?: string): string {
  const parts: string[] = [];
  if (model) parts.push(`Modelo: ${model}`);
  if (usage) {
    if (typeof usage.input_tokens === 'number') parts.push(`Entrada: ${usage.input_tokens.toLocaleString('pt-BR')} tok`);
    if (typeof usage.output_tokens === 'number') parts.push(`Saída: ${usage.output_tokens.toLocaleString('pt-BR')} tok`);
    if (typeof usage.cache_read === 'number' && usage.cache_read > 0) {
      parts.push(`Cache: ${usage.cache_read.toLocaleString('pt-BR')} tok`);
    }
    if (typeof usage.total_cost_usd === 'number') {
      parts.push(`Custo: US$ ${usage.total_cost_usd.toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`);
    }
  }
  return parts.join(' · ');
}

function normalizeRelativePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!trimmed || trimmed.length > 8192) return null;
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return null;
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return null;
  const segments = trimmed.split('/');
  if (segments.some(part => !part || part === '.' || part === '..')) return null;
  return segments.join('/');
}

function matchSkillEntryId(catalogList: CatalogList | null, hint?: string): string {
  if (!catalogList || !hint) return '';
  const cleaned = hint.trim().replace(/^\/+/, '').replace(/^dk:/, '');
  if (!cleaned) return '';
  for (const cat of catalogList.catalogs) {
    if (cat.kind !== 'skills') continue;
    for (const entry of cat.entries) {
      if (entry.id === hint || entry.id === cleaned || entry.name === cleaned || entry.name === `dk-${cleaned}`) {
        return entry.id;
      }
    }
  }
  return '';
}

/** Painel de execução de tarefas com Claude (M2): renderização estritamente via nós DOM e textContent. */
export class AgentRunView {
  private root = '';
  private capabilities: AgentCapabilities | null = null;
  private runs: AgentRun[] = [];
  private currentRun: AgentRun | null = null;
  private items: StreamItem[] = [];
  private lastSeq = 0;
  private statusDetail = '';
  private readingRunId: string | null = null;
  private bufferedEvents: AgentRunEvent[] = [];
  private earlyEvents = new Map<string, AgentRunEvent[]>();
  private drafts = new Map<string, ProjectDraft>();
  private selectedRunByRoot = new Map<string, string | null>();
  private selectedFiles: string[] = [];
  private resumeSession = false;
  private pendingSkillHint = '';
  private preferredStageId: StageId | '' = '';
  private currentStageId = '';
  private currentStageDisplay = '';
  private catalogList: CatalogList | null = null;
  private request = 0;
  private capRequest = 0;
  private contextRequest = 0;
  private previewRequest = 0;
  private treeRequest = 0;
  private opening = false;
  private starting = false;
  private canceling = false;
  private approving = new Set<string>();
  private previewOpen = false;
  private filesOpen = false;
  private frame: number | null = null;
  private rows = new Map<string, HTMLElement>();
  private dirty = new Set<string>();
  private destroyed = false;

  private article: HTMLElement;
  private picker: HTMLSelectElement;
  private newButton: HTMLButtonElement;
  private capBadge: HTMLElement;
  private capBadgeText: HTMLElement;
  private capReason: HTMLElement;
  private protocolWarning: HTMLElement;
  private officialTerminalBtn: HTMLButtonElement;
  private scroll: HTMLElement;
  private banner: HTMLElement;
  private previewDrawer: HTMLElement;
  private previewMeta: HTMLElement;
  private previewLayers: HTMLUListElement;
  private previewRawText: HTMLPreElement;
  private filesDrawer: HTMLElement;
  private manualFileInput: HTMLInputElement;
  private fileTreeRoot: HTMLUListElement;
  private stream: HTMLElement;
  private stateNode: HTMLElement;
  private usageNode: HTMLElement;
  private skillSelect: HTMLSelectElement;
  private designSelect: HTMLSelectElement;
  private stageInput: HTMLInputElement;
  private filesToggleBtn: HTMLButtonElement;
  private previewToggleBtn: HTMLButtonElement;
  private fileChips: HTMLUListElement;
  private input: HTMLTextAreaElement;
  private resumeToggleBtn: HTMLButtonElement;
  private submitBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private host: HTMLElement;
  private api: AgentRunApi;
  private onError: (error: unknown) => void;

  constructor(
    host: HTMLElement,
    api: AgentRunApi,
    onError: (error: unknown) => void,
  ) {
    this.host = host;
    this.api = api;
    this.onError = onError;
    this.article = element('section', 'dk-agent');
    this.article.setAttribute('aria-label', 'Tarefa com Claude');

    const top = element('div', 'dk-agent-top');
    const header = element('header', 'dk-agent-header');

    const backBtn = button('Voltar ao terminal', () => {
      this.saveDraft();
      this.api.onBack?.();
    });
    backBtn.dataset.testid = 'agent-back';

    const titleWrap = element('div', 'dk-agent-title');
    titleWrap.append(iconMark('sparkle', 'dk-agent-glyph'), element('strong', '', 'Tarefa com Claude'));

    const modeBadge = element('span', 'dk-agent-cap-badge', 'Modo manual');
    modeBadge.title = 'Permissão manual por operação (--permission-mode manual)';

    this.picker = element('select', 'dk-agent-picker');
    this.picker.setAttribute('aria-label', 'Execuções do projeto');
    this.picker.dataset.testid = 'agent-run-picker';
    this.picker.addEventListener('change', () => {
      void this.onPickerChange();
    });

    this.newButton = element('button');
    this.newButton.type = 'button';
    this.newButton.dataset.testid = 'agent-new';
    this.newButton.title = 'Preparar nova execução';
    this.newButton.append(iconMark('plus', 'dk-agent-btn-icon'), element('span', '', 'Nova'));
    this.newButton.addEventListener('click', () => {
      this.startNewDraft(true);
    });

    header.append(backBtn, titleWrap, modeBadge, this.picker, this.newButton);

    const capBar = element('div', 'dk-agent-capability');
    capBar.dataset.testid = 'agent-capability';

    this.capBadge = element('span', 'dk-agent-cap-badge');
    const capDot = element('span', 'dk-agent-cap-dot');
    capDot.setAttribute('aria-hidden', 'true');
    this.capBadgeText = element('span', '', 'Verificando CLI…');
    this.capBadge.append(capDot, this.capBadgeText);

    this.capReason = element('span', 'dk-agent-cap-reason');
    this.capReason.dataset.testid = 'agent-capability-reason';

    this.protocolWarning = element(
      'span',
      'dk-agent-unconfirmed',
      'Aviso: protocolo não confirmado com a CLI oficial.',
    );
    this.protocolWarning.dataset.testid = 'agent-protocol-warning';

    this.officialTerminalBtn = element('button', 'dk-agent-terminal-btn');
    this.officialTerminalBtn.type = 'button';
    this.officialTerminalBtn.dataset.testid = 'agent-open-terminal';
    this.officialTerminalBtn.hidden = true;
    this.officialTerminalBtn.append(
      iconMark('terminal', 'dk-agent-btn-icon'),
      element('span', '', 'Abrir no terminal oficial'),
    );
    this.officialTerminalBtn.addEventListener('click', () => {
      this.saveDraft();
      this.api.onOpenTerminal?.();
    });

    capBar.append(this.capBadge, this.capReason, this.protocolWarning, this.officialTerminalBtn);
    top.append(header, capBar);

    this.scroll = element('div', 'dk-agent-scroll');
    const inner = element('div', 'dk-agent-inner');

    this.banner = element('div', 'dk-agent-banner');
    this.banner.dataset.testid = 'agent-partial-banner';
    this.banner.setAttribute('role', 'status');
    this.banner.hidden = true;

    this.previewDrawer = element('section', 'dk-agent-drawer dk-agent-preview');
    this.previewDrawer.id = 'agent-prompt-preview-drawer';
    this.previewDrawer.dataset.testid = 'agent-prompt-preview';
    this.previewDrawer.setAttribute('role', 'region');
    this.previewDrawer.setAttribute('aria-label', 'Prévia do prompt composto');
    this.previewDrawer.hidden = true;

    const previewHead = element('div', 'dk-agent-drawer-head');
    const previewTitleGroup = element('div', 'dk-agent-title');
    previewTitleGroup.append(element('strong', '', 'Camadas do prompt'));
    this.previewMeta = element('span', 'dk-agent-drawer-meta');
    previewTitleGroup.append(this.previewMeta);

    const previewCloseBtn = element('button', 'dk-agent-icon-btn');
    previewCloseBtn.type = 'button';
    setIconButton(previewCloseBtn, 'close', 'Fechar prévia do prompt');
    previewCloseBtn.addEventListener('click', () => {
      this.setPreviewOpen(false, true);
    });
    previewHead.append(previewTitleGroup, previewCloseBtn);

    this.previewLayers = element('ul', 'dk-agent-layers');
    this.previewLayers.dataset.testid = 'agent-prompt-layers';

    const previewRawDetails = element('details', 'dk-agent-preview-raw');
    const previewRawSummary = element('summary');
    previewRawSummary.append(
      iconMark('chevron', 'dk-agent-chevron'),
      element('span', '', 'Texto composto completo'),
    );
    this.previewRawText = element('pre');
    this.previewRawText.dataset.testid = 'agent-prompt-text';
    previewRawDetails.append(previewRawSummary, this.previewRawText);
    this.previewDrawer.append(previewHead, this.previewLayers, previewRawDetails);

    this.filesDrawer = element('section', 'dk-agent-drawer');
    this.filesDrawer.id = 'agent-files-drawer';
    this.filesDrawer.dataset.testid = 'agent-files-drawer';
    this.filesDrawer.setAttribute('role', 'region');
    this.filesDrawer.setAttribute('aria-label', 'Arquivos do projeto');
    this.filesDrawer.hidden = true;

    const filesHead = element('div', 'dk-agent-drawer-head');
    filesHead.append(element('strong', '', 'Escolher arquivos do projeto (caminhos relativos)'));
    const filesCloseBtn = element('button', 'dk-agent-icon-btn');
    filesCloseBtn.type = 'button';
    setIconButton(filesCloseBtn, 'close', 'Fechar seletor de arquivos');
    filesCloseBtn.addEventListener('click', () => {
      this.setFilesOpen(false, true);
    });
    filesHead.append(filesCloseBtn);

    const manualRow = element('div', 'dk-agent-file-manual');
    this.manualFileInput = element('input', 'dk-agent-file-input');
    this.manualFileInput.type = 'text';
    this.manualFileInput.placeholder = 'Caminho relativo (ex.: src/main.ts)';
    this.manualFileInput.setAttribute('aria-label', 'Adicionar caminho relativo');
    this.manualFileInput.dataset.testid = 'agent-file-input';
    this.manualFileInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.addManualFile();
      }
    });
    const addFileBtn = button('Adicionar arquivo', () => {
      this.addManualFile();
    });
    addFileBtn.dataset.testid = 'agent-file-add';
    manualRow.append(this.manualFileInput, addFileBtn);

    this.fileTreeRoot = element('ul', 'dk-agent-tree');
    this.fileTreeRoot.dataset.testid = 'agent-file-tree';
    this.filesDrawer.append(filesHead, manualRow, this.fileTreeRoot);

    this.stream = element('div', 'dk-agent-stream');
    this.stream.dataset.testid = 'agent-stream';

    inner.append(this.banner, this.previewDrawer, this.filesDrawer, this.stream);
    this.scroll.append(inner);

    const footer = element('footer', 'dk-agent-footer');
    const footerInner = element('div', 'dk-agent-footer-inner');

    const statusRow = element('div', 'dk-agent-status-row');
    this.stateNode = element('div', 'dk-agent-state');
    this.stateNode.dataset.testid = 'agent-status';
    this.stateNode.setAttribute('role', 'status');
    this.stateNode.setAttribute('aria-live', 'polite');

    this.usageNode = element('div', 'dk-agent-usage');
    this.usageNode.dataset.testid = 'agent-usage';
    statusRow.append(this.stateNode, this.usageNode);

    const form = element('form', 'dk-agent-form');
    form.addEventListener('submit', event => {
      event.preventDefault();
      void this.start();
    });

    const fieldsGrid = element('div', 'dk-agent-fields');

    const skillLabel = element('label', 'dk-agent-field');
    skillLabel.append(element('span', '', 'SKILL'));
    this.skillSelect = element('select');
    this.skillSelect.setAttribute('aria-label', 'Skill do catálogo');
    this.skillSelect.dataset.testid = 'agent-skill-select';
    this.skillSelect.addEventListener('change', () => {
      this.saveDraft();
      if (this.previewOpen) void this.loadPromptPreview();
    });
    skillLabel.append(this.skillSelect);

    const designLabel = element('label', 'dk-agent-field');
    designLabel.append(element('span', '', 'DESIGN SYSTEM'));
    this.designSelect = element('select');
    this.designSelect.setAttribute('aria-label', 'Design system do catálogo');
    this.designSelect.dataset.testid = 'agent-design-select';
    this.designSelect.addEventListener('change', () => {
      this.saveDraft();
      if (this.previewOpen) void this.loadPromptPreview();
    });
    designLabel.append(this.designSelect);

    const stageLabel = element('label', 'dk-agent-field');
    stageLabel.append(element('span', '', 'ETAPA ATUAL'));
    this.stageInput = element('input');
    this.stageInput.type = 'text';
    this.stageInput.readOnly = true;
    this.stageInput.setAttribute('aria-label', 'Etapa atual');
    this.stageInput.dataset.testid = 'agent-stage-input';
    this.stageInput.value = '—';
    stageLabel.append(this.stageInput);

    fieldsGrid.append(skillLabel, designLabel, stageLabel);

    const filesBar = element('div', 'dk-agent-files-bar');

    this.filesToggleBtn = element('button');
    this.filesToggleBtn.type = 'button';
    this.filesToggleBtn.dataset.testid = 'agent-files-toggle';
    this.filesToggleBtn.setAttribute('aria-expanded', 'false');
    this.filesToggleBtn.setAttribute('aria-controls', this.filesDrawer.id);
    this.filesToggleBtn.append(iconMark('files', 'dk-agent-btn-icon'), element('span', '', 'Escolher arquivos'));
    this.filesToggleBtn.addEventListener('click', () => {
      this.setFilesOpen(!this.filesOpen, false);
    });

    this.previewToggleBtn = element('button');
    this.previewToggleBtn.type = 'button';
    this.previewToggleBtn.dataset.testid = 'agent-preview-prompt';
    this.previewToggleBtn.setAttribute('aria-expanded', 'false');
    this.previewToggleBtn.setAttribute('aria-controls', this.previewDrawer.id);
    this.previewToggleBtn.append(iconMark('file', 'dk-agent-btn-icon'), element('span', '', 'Ver prompt'));
    this.previewToggleBtn.addEventListener('click', () => {
      this.setPreviewOpen(!this.previewOpen, false);
    });

    this.fileChips = element('ul', 'dk-agent-file-chips');
    this.fileChips.dataset.testid = 'agent-selected-files';
    this.fileChips.setAttribute('aria-label', 'Arquivos escolhidos');

    filesBar.append(this.filesToggleBtn, this.previewToggleBtn, this.fileChips);

    this.input = element('textarea', 'dk-agent-textarea');
    this.input.placeholder = 'Descreva a tarefa para o Claude executar neste projeto…';
    this.input.setAttribute('aria-label', 'Prompt da tarefa');
    this.input.dataset.testid = 'agent-prompt-input';
    this.input.maxLength = 64000;
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.start();
      }
    });
    this.input.addEventListener('input', () => {
      this.saveDraft();
      this.controls();
    });

    const actionsRow = element('div', 'dk-agent-actions');

    this.resumeToggleBtn = element('button', 'dk-agent-resume-toggle');
    this.resumeToggleBtn.type = 'button';
    this.resumeToggleBtn.dataset.testid = 'agent-resume-toggle';
    this.resumeToggleBtn.setAttribute('aria-pressed', 'false');
    this.resumeToggleBtn.hidden = true;
    const resumeCheck = element('span', 'dk-agent-check');
    resumeCheck.setAttribute('aria-hidden', 'true');
    this.resumeToggleBtn.append(resumeCheck, element('span', '', 'Continuar sessão atual'));
    this.resumeToggleBtn.addEventListener('click', () => {
      this.resumeSession = !this.resumeSession;
      this.resumeToggleBtn.setAttribute('aria-pressed', String(this.resumeSession));
      this.saveDraft();
    });

    this.submitBtn = element('button', 'dk-agent-submit');
    this.submitBtn.type = 'submit';
    this.submitBtn.dataset.testid = 'agent-submit';
    this.submitBtn.append(iconMark('play', 'dk-agent-btn-icon'), element('span', '', 'Executar tarefa'));

    this.stopBtn = element('button', 'dk-agent-stop');
    this.stopBtn.type = 'button';
    this.stopBtn.dataset.testid = 'agent-cancel';
    this.stopBtn.hidden = true;
    this.stopBtn.append(iconMark('stop', 'dk-agent-btn-icon'), element('span', '', 'Interromper'));
    this.stopBtn.addEventListener('click', () => {
      void this.cancel();
    });

    actionsRow.append(this.resumeToggleBtn, this.submitBtn, this.stopBtn);
    form.append(fieldsGrid, filesBar, this.input, actionsRow);

    footerInner.append(statusRow, form);
    footer.append(footerInner);

    this.article.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.key !== 'Escape') return;
      if (this.previewOpen) {
        event.preventDefault();
        event.stopPropagation();
        this.setPreviewOpen(false, true);
      } else if (this.filesOpen) {
        event.preventDefault();
        event.stopPropagation();
        this.setFilesOpen(false, true);
      }
    });

    this.article.append(top, this.scroll, footer);
    this.host.replaceChildren(this.article);

    this.renderCatalogSelectors();
    this.renderHeader();
    this.renderBanner();
    this.renderFileChips();
    this.renderMessages();
    this.controls();
  }

  private fail(error: unknown) {
    this.onError(error);
  }

  private saveDraft() {
    if (!this.root) return;
    this.drafts.set(this.root, {
      prompt: this.input.value,
      skillId: this.skillSelect.value,
      designSystemId: this.designSelect.value,
      files: [...this.selectedFiles],
      resume: this.resumeSession,
    });
  }

  private restoreDraft(root: string, preset?: AgentRunPreset) {
    const saved = this.drafts.get(root);
    this.selectedFiles = saved ? [...saved.files] : [];
    this.resumeSession = Boolean(saved?.resume) && !preset;
    this.resumeToggleBtn.setAttribute('aria-pressed', String(this.resumeSession));
    this.input.value = preset?.prompt !== undefined ? preset.prompt : saved?.prompt || '';
    this.pendingSkillHint = preset?.skillHint || saved?.skillId || '';
    this.preferredStageId = preset?.stage || '';
    this.renderFileChips();
  }

  async open(root: string, preset?: AgentRunPreset) {
    if (this.destroyed) return;
    const request = ++this.request;
    this.capRequest++;
    this.contextRequest++;
    this.previewRequest++;
    this.treeRequest++;

    if (this.root && this.root !== root) {
      this.saveDraft();
    } else if (this.root && preset) {
      this.saveDraft();
    }

    const rootChanged = this.root !== root;
    this.root = root;
    this.readingRunId = null;
    this.bufferedEvents = [];
    this.earlyEvents.clear();
    this.approving.clear();
    this.starting = false;
    this.canceling = false;
    this.statusDetail = '';

    if (rootChanged) {
      this.capabilities = null;
      this.runs = [];
      this.currentRun = null;
      this.items = [];
      this.lastSeq = 0;
      this.catalogList = null;
      this.currentStageId = '';
      this.currentStageDisplay = '';
      this.stageInput.value = '—';
      this.setPreviewOpen(false, false);
      this.setFilesOpen(false, false);
      this.resetRows();
      this.renderCatalogSelectors();
    }

    if (!root) {
      this.opening = false;
      this.input.value = '';
      this.selectedFiles = [];
      this.renderFileChips();
      this.renderPicker();
      this.renderHeader();
      this.renderBanner();
      this.renderMessages();
      this.controls();
      return;
    }

    this.restoreDraft(root, preset);
    this.opening = true;
    this.renderHeader();
    this.renderPicker();
    this.renderBanner();
    this.renderMessages();
    this.controls();

    const contextPromise = this.loadContext(root, false);

    try {
      const [capabilities, runs] = await Promise.all([
        this.api.capabilities(root),
        this.api.list(root),
      ]);
      if (this.destroyed || request !== this.request || this.root !== root) return;
      this.capabilities = capabilities;
      this.runs = runs;
      this.renderHeader();
      this.renderPicker();

      if (preset) {
        this.selectedRunByRoot.set(root, null);
        this.currentRun = null;
        this.items = [];
        this.lastSeq = 0;
        this.resetRows();
        this.renderPicker();
        this.renderBanner();
        this.renderMessages();
      } else {
        const remembered = this.selectedRunByRoot.get(root);
        let targetId: string | undefined;
        if (remembered === null) {
          targetId = undefined;
        } else if (remembered && runs.some(item => item.runId === remembered)) {
          targetId = remembered;
        } else {
          const urgent = runs.find(item => item.estado === 'aguardando_aprovacao' || item.estado === 'prazo_vencido');
          targetId = urgent?.runId || runs[0]?.runId;
        }
        if (targetId) {
          await this.select(targetId, request);
        } else {
          this.currentRun = null;
          this.items = [];
          this.lastSeq = 0;
          this.resetRows();
          this.renderPicker();
          this.renderBanner();
          this.renderMessages();
        }
      }
      await contextPromise;
    } catch (error) {
      if (!this.destroyed && request === this.request && this.root === root) {
        this.fail(error);
      }
    } finally {
      if (!this.destroyed && request === this.request && this.root === root) {
        this.opening = false;
        this.controls();
        if (preset) this.input.focus();
      }
    }
  }

  refreshContext(path: string) {
    if (this.destroyed || !this.root || this.root !== path) return;
    void this.loadContext(this.root, true);
  }

  private async refreshCapabilities() {
    if (this.destroyed || !this.root) return;
    const root = this.root;
    const serial = ++this.capRequest;
    try {
      const next = await this.api.capabilities(root);
      if (this.destroyed || this.root !== root || serial !== this.capRequest) return;
      this.capabilities = next;
      this.renderHeader();
      this.controls();
    } catch {
      // Capability probe failure leaves existing state intact.
    }
  }

  private async loadContext(root: string, refresh: boolean) {
    const serial = ++this.contextRequest;
    const savedDraft = this.drafts.get(root);

    const stagesPromise = this.api.readStages
      ? this.api.readStages(root, refresh).catch(() => null)
      : Promise.resolve(null);
    const catalogPromise = this.api.listCatalog
      ? serializeCatalogTask(() => this.api.listCatalog!(root, refresh)).catch(() => null)
      : Promise.resolve(null);

    const [stagesSnap, catalogSnap] = await Promise.all([stagesPromise, catalogPromise]);
    if (this.destroyed || this.root !== root || serial !== this.contextRequest) return;

    if (stagesSnap) {
      if (!stagesSnap.isDk) {
        this.currentStageId = '';
        this.currentStageDisplay = 'Projeto sem etapas DK';
      } else {
        const chosen =
          (this.preferredStageId ? stagesSnap.stages.find(s => s.id === this.preferredStageId) : undefined) ||
          stagesSnap.stages.find(s => s.liberada && s.estado !== 'concluido');
        if (chosen) {
          this.currentStageId = chosen.id;
          this.currentStageDisplay = `${chosen.ordem}. ${chosen.nome} (${chosen.id})`;
        } else if (stagesSnap.stages.length > 0 && stagesSnap.stages.every(s => s.estado === 'concluido')) {
          this.currentStageId = '';
          this.currentStageDisplay = 'Todas as etapas concluídas';
        } else {
          this.currentStageId = '';
          this.currentStageDisplay = 'Nenhuma etapa ativa';
        }
      }
    } else {
      this.currentStageId = '';
      this.currentStageDisplay = 'Indisponível';
    }
    this.stageInput.value = this.currentStageDisplay;

    this.catalogList = catalogSnap;
    this.renderCatalogSelectors(savedDraft?.skillId, savedDraft?.designSystemId);

    if (this.previewOpen) {
      void this.loadPromptPreview();
    }
  }

  private renderCatalogSelectors(savedSkillId?: string, savedDesignId?: string) {
    const previousSkill = savedSkillId ?? this.skillSelect.value;
    const previousDesign = savedDesignId ?? this.designSelect.value;

    const emptySkill = element('option', '', 'Nenhuma skill selecionada');
    emptySkill.value = '';
    const skillOptions: HTMLOptionElement[] = [emptySkill];

    const emptyDesign = element('option', '', 'Nenhum design system selecionado');
    emptyDesign.value = '';
    const designOptions: HTMLOptionElement[] = [emptyDesign];

    if (this.catalogList) {
      for (const catalog of this.catalogList.catalogs) {
        const origin = catalog.origin.label || ORIGIN_LABELS[catalog.origin.type] || 'Catálogo';
        for (const entry of catalog.entries) {
          const opt = element('option', '', `${entry.title || entry.name} · ${origin}`);
          opt.value = entry.id;
          if (catalog.kind === 'skills') skillOptions.push(opt);
          else if (catalog.kind === 'design-systems') designOptions.push(opt);
        }
      }
    }

    this.skillSelect.replaceChildren(...skillOptions);
    this.designSelect.replaceChildren(...designOptions);

    const matchedHint = this.pendingSkillHint ? matchSkillEntryId(this.catalogList, this.pendingSkillHint) : '';
    const desiredSkill = matchedHint || previousSkill;
    if (desiredSkill && skillOptions.some(opt => opt.value === desiredSkill)) {
      this.skillSelect.value = desiredSkill;
      this.pendingSkillHint = '';
    } else {
      this.skillSelect.value = '';
    }

    if (previousDesign && designOptions.some(opt => opt.value === previousDesign)) {
      this.designSelect.value = previousDesign;
    } else {
      this.designSelect.value = '';
    }
  }

  private startNewDraft(focusInput: boolean) {
    if (!this.root) return;
    this.saveDraft();
    this.request++;
    this.readingRunId = null;
    this.bufferedEvents = [];
    this.selectedRunByRoot.set(this.root, null);
    this.currentRun = null;
    this.items = [];
    this.lastSeq = 0;
    this.statusDetail = '';
    this.resumeSession = false;
    this.resumeToggleBtn.setAttribute('aria-pressed', 'false');
    this.resetRows();
    this.renderPicker();
    this.renderBanner();
    this.renderMessages();
    this.controls();
    if (focusInput) this.input.focus();
  }

  private async onPickerChange() {
    const id = this.picker.value;
    if (!id) {
      this.startNewDraft(false);
      return;
    }
    const request = ++this.request;
    await this.select(id, request);
  }

  private async select(runId: string, callerRequest?: number) {
    if (!this.root) return;
    const root = this.root;
    const request = callerRequest ?? ++this.request;
    this.saveDraft();
    this.selectedRunByRoot.set(root, runId);
    this.readingRunId = runId;
    this.bufferedEvents = [];
    this.controls();

    try {
      const snapshot = await this.api.read(root, runId);
      if (this.destroyed || request !== this.request || this.root !== root) return;
      this.readingRunId = null;
      this.applySnapshot(snapshot);
      const early = this.earlyEvents.get(runId) || [];
      this.earlyEvents.delete(runId);
      const pending = this.bufferedEvents;
      this.bufferedEvents = [];
      const combined = [...early, ...pending]
        .filter(ev => ev.runId === runId)
        .sort((a, b) => a.seq - b.seq);
      for (const ev of combined) {
        if (ev.seq > this.lastSeq) {
          this.applyEventToCurrent(ev);
        }
      }
      this.renderPicker();
      this.renderBanner();
      this.renderMessages();
      this.controls();
      this.scroll.scrollTop = this.scroll.scrollHeight;
    } catch (error) {
      if (!this.destroyed && request === this.request && this.root === root) {
        this.readingRunId = null;
        this.bufferedEvents = [];
        this.fail(error);
      }
    }
  }

  private upsertRunMeta(run: AgentRun) {
    const idx = this.runs.findIndex(item => item.runId === run.runId);
    if (idx >= 0) this.runs[idx] = run;
    else this.runs.unshift(run);
    this.runs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private applySnapshot(snapshot: AgentRunSnapshot) {
    this.currentRun = { ...snapshot.run, usage: { ...(snapshot.run.usage || {}) } };
    this.upsertRunMeta(this.currentRun);
    this.items = [];
    this.lastSeq = 0;
    this.statusDetail = '';
    this.resetRows();

    if (this.currentRun.title) {
      const userId = `prompt:${this.currentRun.runId}`;
      this.items.push({ id: userId, kind: 'user', text: this.currentRun.title });
      this.dirty.add(userId);
    }

    for (const ev of snapshot.eventos) {
      this.applyEventToCurrent(ev);
    }

    if (!this.items.some(item => item.kind === 'assistant') && this.currentRun.texto) {
      const savedId = `text:${this.currentRun.runId}:saved`;
      this.items.push({
        id: savedId,
        kind: 'assistant',
        messageId: `${this.currentRun.runId}:saved`,
        text: this.currentRun.texto,
      });
      this.dirty.add(savedId);
    }
  }

  private applyEventToCurrent(event: AgentRunEvent) {
    if (!this.currentRun || event.runId !== this.currentRun.runId) return;
    if (event.seq > this.lastSeq) this.lastSeq = event.seq;
    this.currentRun.updatedAt = Math.max(this.currentRun.updatedAt, event.at || Date.now());

    switch (event.type) {
      case 'text_delta': {
        const id = `text:${event.messageId}`;
        const existing = this.items.find(
          (item): item is Extract<StreamItem, { kind: 'assistant' }> => item.id === id && item.kind === 'assistant',
        );
        if (existing) {
          existing.text = event.value;
        } else {
          this.items.push({ id, kind: 'assistant', messageId: event.messageId, text: event.value });
        }
        this.dirty.add(id);
        break;
      }
      case 'tool_use': {
        const id = `tool:${event.toolUseId}`;
        const existing = this.items.find(
          (item): item is Extract<StreamItem, { kind: 'tool' }> => item.id === id && item.kind === 'tool',
        );
        if (existing) {
          existing.name = event.name || existing.name;
          existing.inputResumo = event.inputResumo ?? existing.inputResumo;
          existing.inputBytes = typeof event.inputBytes === 'number' ? event.inputBytes : existing.inputBytes;
          existing.estado = event.estado || existing.estado;
        } else {
          this.items.push({
            id,
            kind: 'tool',
            toolUseId: event.toolUseId,
            name: event.name || 'Ferramenta',
            inputResumo: event.inputResumo || '',
            inputBytes: event.inputBytes || 0,
            estado: event.estado || 'iniciado',
            hasResult: false,
            content: '',
            isError: false,
            truncado: false,
          });
        }
        this.dirty.add(id);
        break;
      }
      case 'tool_result': {
        const id = `tool:${event.toolUseId}`;
        const existing = this.items.find(
          (item): item is Extract<StreamItem, { kind: 'tool' }> => item.id === id && item.kind === 'tool',
        );
        if (existing) {
          existing.hasResult = true;
          existing.content = event.content ?? '';
          existing.isError = Boolean(event.is_error);
          existing.truncado = Boolean(event.truncado);
          existing.estado = 'concluido';
        } else {
          this.items.push({
            id,
            kind: 'tool',
            toolUseId: event.toolUseId,
            name: 'Ferramenta',
            inputResumo: '',
            inputBytes: 0,
            estado: 'concluido',
            hasResult: true,
            content: event.content ?? '',
            isError: Boolean(event.is_error),
            truncado: Boolean(event.truncado),
          });
        }
        this.dirty.add(id);
        break;
      }
      case 'approval': {
        const id = `approval:${event.requestId}`;
        if (event.status !== 'pending') {
          this.approving.delete(event.requestId);
        }
        const existing = this.items.find(
          (item): item is Extract<StreamItem, { kind: 'approval' }> => item.id === id && item.kind === 'approval',
        );
        if (existing) {
          existing.status = event.status;
          if (event.toolName !== undefined) existing.toolName = event.toolName;
          if (event.displayName !== undefined) existing.displayName = event.displayName;
          if (event.resumo !== undefined) existing.resumo = event.resumo;
          if (event.input !== undefined) existing.input = event.input;
          if (event.description !== undefined) existing.description = event.description;
          if (event.blockedPath !== undefined) existing.blockedPath = event.blockedPath;
          if (event.decisionReason !== undefined) existing.decisionReason = event.decisionReason;
          if (event.prazoMs !== undefined) existing.prazoMs = event.prazoMs;
        } else {
          this.items.push({
            id,
            kind: 'approval',
            requestId: event.requestId,
            approvalKind: event.kind,
            status: event.status,
            toolName: event.toolName,
            displayName: event.displayName,
            resumo: event.resumo,
            input: event.input,
            description: event.description,
            blockedPath: event.blockedPath,
            decisionReason: event.decisionReason,
            prazoMs: event.prazoMs,
          });
        }
        this.dirty.add(id);
        break;
      }
      case 'usage': {
        this.currentRun.usage = {
          ...this.currentRun.usage,
          ...(event.input_tokens !== undefined ? { input_tokens: event.input_tokens } : {}),
          ...(event.output_tokens !== undefined ? { output_tokens: event.output_tokens } : {}),
          ...(event.cache_read !== undefined ? { cache_read: event.cache_read } : {}),
          ...(event.total_cost_usd !== undefined ? { total_cost_usd: event.total_cost_usd } : {}),
        };
        break;
      }
      case 'status': {
        this.currentRun.estado = event.estado;
        if (event.sessionId) this.currentRun.sessionId = event.sessionId;
        if (event.model) this.currentRun.model = event.model;
        if (event.parcial !== undefined) this.currentRun.parcial = Boolean(event.parcial);
        if (event.cleanupPartial !== undefined) this.currentRun.cleanupPartial = Boolean(event.cleanupPartial);
        if (typeof event.total_cost_usd === 'number') {
          this.currentRun.usage = { ...this.currentRun.usage, total_cost_usd: event.total_cost_usd };
        }
        if (event.motivo) this.statusDetail = event.motivo;
        if (!isRunActive(this.currentRun)) {
          this.canceling = false;
        }
        break;
      }
      case 'error': {
        const id = `error:${event.seq}`;
        if (!this.items.some(item => item.id === id)) {
          this.items.push({ id, kind: 'error', message: event.message, fatal: event.fatal });
          this.dirty.add(id);
        }
        break;
      }
      case 'snapshot': {
        this.applySnapshot({ run: event.run, eventos: event.eventos });
        break;
      }
    }
    this.upsertRunMeta(this.currentRun);
  }

  handle(event: AgentRunEvent) {
    if (this.destroyed || !this.root || event.root !== this.root) return;

    if (event.type === 'error' && event.fatal) {
      void this.refreshCapabilities();
    } else if (event.type === 'status' && event.estado === 'falhou') {
      void this.refreshCapabilities();
    }

    if (event.type === 'snapshot') {
      this.upsertRunMeta(event.run);
    } else {
      const existing = this.runs.find(item => item.runId === event.runId);
      if (existing) {
        existing.updatedAt = Math.max(existing.updatedAt, event.at || Date.now());
        if (event.type === 'status') {
          existing.estado = event.estado;
          if (event.model) existing.model = event.model;
          if (event.parcial !== undefined) existing.parcial = Boolean(event.parcial);
          if (event.cleanupPartial !== undefined) existing.cleanupPartial = Boolean(event.cleanupPartial);
        }
      } else if (event.type === 'status') {
        this.upsertRunMeta({
          runId: event.runId,
          root: event.root,
          provider: 'claude',
          estado: event.estado,
          sessionId: event.sessionId || '',
          title: 'Tarefa em andamento',
          createdAt: event.at || Date.now(),
          updatedAt: event.at || Date.now(),
          texto: '',
          usage: {},
          promptHash: '',
          parcial: Boolean(event.parcial),
          cleanupPartial: Boolean(event.cleanupPartial),
          model: event.model,
        });
      }
    }
    this.renderPicker();

    if (this.readingRunId === event.runId) {
      this.bufferedEvents.push(event);
      return;
    }

    if (!this.currentRun || this.currentRun.runId !== event.runId) {
      if (this.earlyEvents.size >= 32 && !this.earlyEvents.has(event.runId)) {
        const oldestKey = this.earlyEvents.keys().next().value;
        if (oldestKey) this.earlyEvents.delete(oldestKey);
      }
      const list = this.earlyEvents.get(event.runId) || [];
      if (list.length < 200) list.push(event);
      this.earlyEvents.set(event.runId, list);
      return;
    }

    this.applyEventToCurrent(event);
    this.renderBanner();
    this.controls();

    if (this.frame === null) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        if (!this.destroyed) this.renderMessages();
      });
    }
  }

  private renderHeader() {
    const claude = this.capabilities?.claude;
    this.capBadge.classList.remove('is-ready', 'is-unavailable');

    if (!claude) {
      this.capBadgeText.textContent = this.root ? 'Verificando CLI…' : 'Sem projeto ativo';
      this.capReason.textContent = '';
      this.protocolWarning.hidden = false;
      this.officialTerminalBtn.hidden = true;
      return;
    }

    const versionLabel = claude.versao ? ` (${claude.versao})` : '';
    if (claude.disponivel) {
      this.capBadge.classList.add('is-ready');
      this.capBadgeText.textContent = `Claude disponível${versionLabel}`;
    } else {
      this.capBadge.classList.add('is-unavailable');
      this.capBadgeText.textContent = `Claude indisponível${versionLabel}`;
    }

    this.capReason.textContent = claude.motivo || '';
    this.protocolWarning.hidden = Boolean(claude.aprovacao_host_provada);
    this.officialTerminalBtn.hidden = claude.disponivel;
  }

  private renderPicker() {
    const selectedId = this.currentRun?.runId || '';
    const newOption = element('option', '', 'Nova tarefa');
    newOption.value = '';
    const options: HTMLOptionElement[] = [newOption];

    for (const run of this.runs) {
      const label = `${run.title || 'Tarefa'} · ${statusText(run.estado)}`;
      const opt = element('option', '', label);
      opt.value = run.runId;
      options.push(opt);
    }

    this.picker.replaceChildren(...options);
    this.picker.value = options.some(opt => opt.value === selectedId) ? selectedId : '';
  }

  private renderBanner() {
    this.banner.replaceChildren();
    const parcial = Boolean(this.currentRun?.parcial);
    const cleanup = Boolean(this.currentRun?.cleanupPartial);
    if (!parcial && !cleanup) {
      this.banner.hidden = true;
      return;
    }
    this.banner.hidden = false;
    if (parcial) {
      this.banner.append(
        element(
          'p',
          '',
          'Resultado parcial: esta execução foi interrompida ou encerrada antes de concluir todos os passos.',
        ),
      );
    }
    if (cleanup) {
      this.banner.append(
        element(
          'p',
          '',
          'Limpeza parcial: não foi possível confirmar o encerramento completo de todos os recursos auxiliares.',
        ),
      );
    }
  }

  private renderFileChips() {
    this.fileChips.replaceChildren();
    for (const rel of this.selectedFiles) {
      const li = element('li', 'dk-agent-file-chip');
      li.append(element('code', '', rel));
      const removeBtn = element('button', 'dk-agent-icon-btn');
      removeBtn.type = 'button';
      setIconButton(removeBtn, 'close', `Remover arquivo ${rel}`);
      removeBtn.addEventListener('click', () => {
        this.toggleFile(rel, false);
      });
      li.append(removeBtn);
      this.fileChips.append(li);
    }
    this.syncTreeCheckboxes();
  }

  private toggleFile(relative: string, force?: boolean) {
    const normalized = normalizeRelativePath(relative);
    if (!normalized) {
      this.fail(new Error('Informe um caminho relativo válido dentro da raiz do projeto.'));
      return;
    }
    const exists = this.selectedFiles.includes(normalized);
    const shouldAdd = force !== undefined ? force : !exists;
    if (shouldAdd && !exists) {
      if (this.selectedFiles.length >= 200) {
        this.fail(new Error('O limite máximo é de 200 arquivos por execução.'));
        return;
      }
      this.selectedFiles.push(normalized);
    } else if (!shouldAdd && exists) {
      this.selectedFiles = this.selectedFiles.filter(item => item !== normalized);
    }
    this.saveDraft();
    this.renderFileChips();
    if (this.previewOpen) void this.loadPromptPreview();
  }

  private addManualFile() {
    const value = this.manualFileInput.value;
    const normalized = normalizeRelativePath(value);
    if (!normalized) {
      this.fail(new Error('Informe um caminho relativo válido (sem ".." nem barra inicial).'));
      return;
    }
    this.manualFileInput.value = '';
    this.toggleFile(normalized, true);
  }

  private setPreviewOpen(open: boolean, restoreFocus: boolean) {
    this.previewOpen = open;
    this.previewDrawer.hidden = !open;
    this.previewToggleBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      if (this.filesOpen) {
        this.filesOpen = false;
        this.filesDrawer.hidden = true;
        this.filesToggleBtn.setAttribute('aria-expanded', 'false');
      }
      void this.loadPromptPreview();
    } else if (restoreFocus) {
      this.previewToggleBtn.focus();
    }
  }

  private setFilesOpen(open: boolean, restoreFocus: boolean) {
    this.filesOpen = open;
    this.filesDrawer.hidden = !open;
    this.filesToggleBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      if (this.previewOpen) {
        this.previewOpen = false;
        this.previewDrawer.hidden = true;
        this.previewToggleBtn.setAttribute('aria-expanded', 'false');
      }
      void this.loadRootTree();
    } else if (restoreFocus) {
      this.filesToggleBtn.focus();
    }
  }

  private currentPromptOptions(): AgentPromptOptions {
    const options: AgentPromptOptions = {};
    if (this.skillSelect.value) options.skillId = this.skillSelect.value;
    if (this.designSelect.value) options.designSystemId = this.designSelect.value;
    if (this.currentStageId) options.stage = this.currentStageId;
    if (this.selectedFiles.length > 0) options.files = [...this.selectedFiles];
    return options;
  }

  private async loadPromptPreview() {
    if (!this.root) return;
    const root = this.root;
    const serial = ++this.previewRequest;
    this.previewMeta.textContent = 'Compondo prévia…';
    this.previewLayers.replaceChildren();
    this.previewRawText.textContent = '';

    try {
      const preview = await this.api.previewPrompt(root, this.currentPromptOptions());
      if (this.destroyed || this.root !== root || serial !== this.previewRequest) return;

      let presentCount = 0;
      let truncatedCount = 0;
      let absentCount = 0;
      const items: HTMLLIElement[] = [];

      for (const camada of preview.camadas) {
        if (camada.ausente) absentCount++;
        else {
          presentCount++;
          if (camada.truncado) truncatedCount++;
        }

        const li = element('li', 'dk-agent-layer');
        li.dataset.layerId = camada.id;

        const badgeClass = camada.ausente ? 'is-ausente' : camada.truncado ? 'is-truncado' : 'is-presente';
        const badgeText = camada.ausente ? 'Ausente' : camada.truncado ? 'Truncada' : 'Presente';
        const badge = element('span', `dk-agent-layer-badge ${badgeClass}`, badgeText);

        const bytesLabel = camada.truncado
          ? `${formatBytes(camada.bytes)} de ${formatBytes(camada.bytesOriginais)}`
          : formatBytes(camada.bytes);
        const bytesNode = element('span', 'dk-agent-layer-bytes', bytesLabel);

        li.append(element('strong', '', LAYER_LABELS[camada.id] || camada.id), element('code', '', camada.id));
        if (camada.fonte) {
          li.append(element('code', '', camada.fonte));
        }
        li.append(badge, bytesNode);

        if (camada.motivo) {
          li.append(element('p', 'dk-agent-layer-reason', camada.motivo));
        }
        items.push(li);
      }

      this.previewMeta.textContent = `${formatBytes(preview.totalBytes)} · ${presentCount} presentes · ${truncatedCount} truncadas · ${absentCount} ausentes`;
      this.previewLayers.replaceChildren(...items);
      this.previewRawText.textContent = preview.text || '(Prompt sem conteúdo.)';
    } catch (error) {
      if (!this.destroyed && this.root === root && serial === this.previewRequest) {
        this.previewMeta.textContent = 'Falha ao carregar a prévia.';
        this.fail(error);
      }
    }
  }

  private async loadRootTree() {
    if (!this.root || !this.api.listDirectory) {
      this.fileTreeRoot.replaceChildren(
        element('li', 'dk-agent-drawer-meta', 'Listagem de arquivos indisponível; adicione o caminho relativo manualmente.'),
      );
      return;
    }
    const root = this.root;
    const serial = ++this.treeRequest;
    this.fileTreeRoot.replaceChildren(element('li', 'dk-agent-drawer-meta', 'Carregando arquivos do projeto…'));

    try {
      const listing = await this.api.listDirectory(root);
      if (this.destroyed || this.root !== root || serial !== this.treeRequest) return;
      this.renderDirectoryInto(this.fileTreeRoot, root, listing);
    } catch (error) {
      if (!this.destroyed && this.root === root && serial === this.treeRequest) {
        this.fileTreeRoot.replaceChildren(element('li', 'dk-agent-drawer-meta', 'Não foi possível listar a pasta do projeto.'));
        this.fail(error);
      }
    }
  }

  private renderDirectoryInto(container: HTMLUListElement, root: string, listing: DirectoryListing) {
    container.replaceChildren();
    for (const entry of listing.entries) {
      const li = element('li');
      if (entry.kind === 'directory') {
        const dirBtn = element('button', 'dk-agent-tree-dir');
        dirBtn.type = 'button';
        dirBtn.setAttribute('aria-expanded', 'false');
        dirBtn.append(
          iconMark('chevron', 'dk-agent-chevron'),
          iconMark('folder', 'dk-agent-btn-icon'),
          element('span', '', entry.name),
        );
        let childList: HTMLUListElement | null = null;
        let expanded = false;
        let loading = false;
        dirBtn.addEventListener('click', () => {
          if (loading || !this.api.listDirectory || this.root !== root) return;
          expanded = !expanded;
          dirBtn.setAttribute('aria-expanded', String(expanded));
          if (childList) {
            childList.hidden = !expanded;
            return;
          }
          if (!expanded) return;
          loading = true;
          void this.api
            .listDirectory(root, entry.relative)
            .then(sub => {
              if (this.destroyed || this.root !== root || !dirBtn.isConnected) return;
              childList = element('ul');
              this.renderDirectoryInto(childList, root, sub);
              li.append(childList);
            })
            .catch(err => {
              expanded = false;
              dirBtn.setAttribute('aria-expanded', 'false');
              this.fail(err);
            })
            .finally(() => {
              loading = false;
            });
        });
        li.append(dirBtn);
      } else {
        const fileBtn = element('button', 'dk-agent-tree-file');
        fileBtn.type = 'button';
        fileBtn.setAttribute('role', 'checkbox');
        fileBtn.dataset.relative = entry.relative;
        const checked = this.selectedFiles.includes(entry.relative);
        fileBtn.setAttribute('aria-checked', String(checked));
        const checkMark = element('span', 'dk-agent-check');
        checkMark.setAttribute('aria-hidden', 'true');
        fileBtn.append(
          checkMark,
          iconMark('file', 'dk-agent-btn-icon'),
          element('code', '', entry.relative),
        );
        fileBtn.addEventListener('click', () => {
          this.toggleFile(entry.relative);
        });
        li.append(fileBtn);
      }
      container.append(li);
    }
    if (!listing.entries.length || listing.truncated) {
      container.append(
        element(
          'li',
          'dk-agent-drawer-meta',
          listing.truncated ? 'Exibindo os primeiros 500 itens desta pasta.' : 'Pasta vazia.',
        ),
      );
    }
  }

  private syncTreeCheckboxes() {
    const selected = new Set(this.selectedFiles);
    this.fileTreeRoot.querySelectorAll<HTMLButtonElement>('button.dk-agent-tree-file').forEach(btn => {
      const rel = btn.dataset.relative || '';
      btn.setAttribute('aria-checked', String(selected.has(rel)));
    });
  }

  private controls() {
    const active = isRunActive(this.currentRun) || this.starting;
    const claudeReady = Boolean(this.capabilities?.claude.disponivel);
    const hasRoot = Boolean(this.root);

    this.picker.disabled = !hasRoot || this.opening;
    this.newButton.disabled = !hasRoot || this.opening || this.starting;
    this.skillSelect.disabled = !hasRoot || this.opening || active;
    this.designSelect.disabled = !hasRoot || this.opening || active;
    this.filesToggleBtn.disabled = !hasRoot || this.opening || active;
    this.previewToggleBtn.disabled = !hasRoot || this.opening;
    this.input.disabled = !hasRoot || this.opening || active;

    const canResume = !active && Boolean(this.currentRun?.sessionId) && this.currentRun?.estado === 'concluido';
    this.resumeToggleBtn.hidden = !canResume;
    if (!canResume && this.resumeSession) {
      this.resumeSession = false;
      this.resumeToggleBtn.setAttribute('aria-pressed', 'false');
    }

    this.submitBtn.hidden = active;
    this.submitBtn.disabled = !hasRoot || this.opening || active || !claudeReady || !this.input.value.trim();

    this.stopBtn.hidden = !active;
    this.stopBtn.disabled =
      !hasRoot ||
      !this.currentRun ||
      !isRunActive(this.currentRun) ||
      this.currentRun.estado === 'interrompendo' ||
      this.canceling;

    this.stateNode.replaceChildren();
    if (active) {
      const dot = element('span', 'dk-agent-dot');
      dot.setAttribute('aria-hidden', 'true');
      this.stateNode.append(dot);
    }
    const baseState = this.opening
      ? 'Carregando execuções…'
      : this.starting
        ? 'Enfileirando tarefa…'
        : this.currentRun
          ? statusText(this.currentRun.estado)
          : statusText('idle');
    const fullState =
      this.currentRun && this.currentRun.estado === 'falhou' && this.statusDetail
        ? `${baseState}: ${this.statusDetail}`
        : baseState;
    this.stateNode.append(document.createTextNode(fullState));

    this.usageNode.textContent = this.currentRun
      ? formatUsage(this.currentRun.usage, this.currentRun.model)
      : '';
  }

  private renderMessages() {
    const atBottom = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 100;

    if (!this.items.length) {
      const empty = element('div', 'dk-agent-empty');
      empty.append(
        iconMark('sparkle', 'dk-agent-glyph'),
        element('strong', '', 'Tarefas com aprovação por operação.'),
        element(
          'p',
          '',
          'Escolha skill, design system e arquivos do projeto, confira as camadas em "Ver prompt" e acompanhe a execução.',
        ),
        element(
          'p',
          '',
          'Cada operação sensível exige sua confirmação explícita; nenhuma permissão permanente é gravada.',
        ),
      );
      this.stream.replaceChildren(empty);
      this.rows.clear();
      this.dirty.clear();
      return;
    }

    if (!this.rows.size) this.stream.replaceChildren();

    const visible = this.items.slice(-250);
    for (const item of visible) {
      let row = this.rows.get(item.id);
      if (!row) {
        row = element('div');
        this.rows.set(item.id, row);
        this.dirty.add(item.id);
        this.stream.append(row);
      }
      if (this.dirty.has(item.id)) {
        this.renderRow(row, item);
      }
    }

    const live = new Set(visible.map(item => item.id));
    for (const [id, row] of this.rows) {
      if (!live.has(id)) {
        row.remove();
        this.rows.delete(id);
      }
    }
    this.dirty.clear();

    if (atBottom) {
      this.scroll.scrollTop = this.scroll.scrollHeight;
    }
  }

  private renderRow(row: HTMLElement, item: StreamItem) {
    if (item.kind === 'user') {
      const box = element('div', 'dk-agent-message dk-agent-message-user');
      box.append(element('div', 'dk-agent-label', 'Tarefa solicitada'), element('div', 'dk-agent-content', item.text));
      row.replaceChildren(box);
      return;
    }

    if (item.kind === 'assistant') {
      const box = element('div', 'dk-agent-message');
      const label = element('div', 'dk-agent-label');
      label.append(iconMark('sparkle', 'dk-agent-btn-icon'), element('span', '', 'Claude'));
      box.append(label, element('div', 'dk-agent-content', item.text));
      row.replaceChildren(box);
      return;
    }

    if (item.kind === 'tool') {
      const previousOpen = row.querySelector('details')?.open ?? false;
      const details = element('details', 'dk-agent-tool');
      details.dataset.testid = 'agent-tool';
      details.dataset.toolUseId = item.toolUseId;
      details.open = previousOpen;

      const summary = element('summary');
      summary.append(
        iconMark('chevron', 'dk-agent-chevron'),
        iconMark('tool', 'dk-agent-btn-icon'),
        element('strong', '', item.name || 'Ferramenta'),
      );
      if (item.inputBytes > 0) {
        summary.append(element('span', 'dk-agent-tool-bytes', formatBytes(item.inputBytes)));
      }
      const stateLabel = item.hasResult
        ? item.isError
          ? 'Erro'
          : 'Concluído'
        : statusText(item.estado);
      const stateSpan = element(
        'span',
        `dk-agent-tool-status${item.isError ? ' is-error' : ''}`,
        stateLabel,
      );
      summary.append(stateSpan);
      details.append(summary);

      if (item.inputResumo) {
        const inputPre = element('pre', 'dk-agent-tool-input');
        inputPre.textContent = item.inputResumo;
        details.append(inputPre);
      }

      if (item.hasResult) {
        const outputPre = element('pre', `dk-agent-tool-output${item.isError ? ' is-error' : ''}`);
        outputPre.textContent = item.content || '(Sem saída de texto.)';
        details.append(outputPre);
      }

      if (item.truncado) {
        details.append(element('p', 'dk-agent-tool-note', 'Saída truncada no limite de 64 KiB.'));
      }

      row.replaceChildren(details);
      return;
    }

    if (item.kind === 'approval') {
      const busy = this.approving.has(item.requestId);
      const card = element('div', 'dk-agent-approval');
      card.dataset.requestId = item.requestId;
      card.dataset.approvalKind = item.approvalKind;
      card.dataset.status = item.status;

      if (item.approvalKind === 'prazo') {
        card.dataset.testid = 'agent-approval-prazo';
        const head = element('div', 'dk-agent-approval-head');
        head.append(element('strong', '', 'Prazo do turno atingido'));
        card.append(head);

        const minutes = item.prazoMs ? Math.max(1, Math.round(item.prazoMs / 60000)) : 15;
        card.append(
          element(
            'p',
            'dk-agent-approval-desc',
            `A execução atingiu o prazo de ${minutes} min. Escolha continuar por mais 15 minutos ou interromper.`,
          ),
        );

        if (item.status === 'pending') {
          const actions = element('div', 'dk-agent-approval-actions');
          const continueBtn = button(
            'Continuar 15 min',
            () => {
              void this.approve(item.id, item.requestId, 'allow');
            },
            'dk-agent-allow',
          );
          continueBtn.dataset.testid = 'agent-prazo-continue';
          continueBtn.disabled = busy;

          const stopTurnBtn = button(
            'Interromper',
            () => {
              void this.approve(item.id, item.requestId, 'deny');
            },
            'dk-agent-deny',
          );
          stopTurnBtn.dataset.testid = 'agent-prazo-stop';
          stopTurnBtn.disabled = busy;

          actions.append(continueBtn, stopTurnBtn);
          card.append(actions);
        } else {
          card.append(
            element(
              'p',
              'dk-agent-approval-resolved',
              item.status === 'allowed' ? 'Prazo estendido em 15 min' : statusText(item.status),
            ),
          );
        }
        row.replaceChildren(card);
        return;
      }

      card.dataset.testid = 'agent-approval-tool';
      const toolLabel = item.displayName || item.toolName || 'Ferramenta';
      const head = element('div', 'dk-agent-approval-head');
      head.append(iconMark('tool', 'dk-agent-btn-icon'), element('strong', '', `Ferramenta: ${toolLabel}`));
      if (item.displayName && item.toolName && item.displayName !== item.toolName) {
        head.append(element('code', '', item.toolName));
      }
      card.append(head);

      if (item.description) {
        card.append(element('p', 'dk-agent-approval-desc', item.description));
      }

      const resumoWrap = element('div', 'dk-agent-approval-field');
      resumoWrap.append(element('span', 'dk-agent-field-label', 'Resumo'));
      const resumoPre = element('pre');
      resumoPre.textContent = item.resumo || '(Sem resumo informado)';
      resumoWrap.append(resumoPre);
      card.append(resumoWrap);

      const blockedRow = element('p', 'dk-agent-approval-meta');
      blockedRow.append(
        element('span', 'dk-agent-field-label', 'Caminho bloqueado: '),
        element('code', '', item.blockedPath || 'Não informado'),
      );
      card.append(blockedRow);

      const reasonRow = element('p', 'dk-agent-approval-meta');
      reasonRow.append(
        element('span', 'dk-agent-field-label', 'Motivo: '),
        element('span', '', item.decisionReason || 'Confirmação manual exigida por operação.'),
      );
      card.append(reasonRow);

      if (item.input && Object.keys(item.input).length > 0) {
        const previousInputOpen = row.querySelector<HTMLDetailsElement>('details.dk-agent-approval-input')?.open ?? false;
        const inputDetails = element('details', 'dk-agent-approval-input');
        inputDetails.open = previousInputOpen;
        const inputSummary = element('summary');
        inputSummary.append(iconMark('chevron', 'dk-agent-chevron'), element('span', '', 'Parâmetros completos'));
        const inputPre = element('pre');
        inputPre.textContent = JSON.stringify(item.input, null, 2);
        inputDetails.append(inputSummary, inputPre);
        card.append(inputDetails);
      }

      if (item.status === 'pending') {
        const actions = element('div', 'dk-agent-approval-actions');
        const allowBtn = button(
          'Permitir uma vez',
          () => {
            void this.approve(item.id, item.requestId, 'allow');
          },
          'dk-agent-allow',
        );
        allowBtn.dataset.testid = 'agent-approve-allow';
        allowBtn.disabled = busy;

        const denyBtn = button(
          'Recusar',
          () => {
            void this.approve(item.id, item.requestId, 'deny');
          },
          'dk-agent-deny',
        );
        denyBtn.dataset.testid = 'agent-approve-deny';
        denyBtn.disabled = busy;

        actions.append(allowBtn, denyBtn);
        card.append(actions);
      } else {
        card.append(element('p', 'dk-agent-approval-resolved', statusText(item.status)));
      }

      row.replaceChildren(card);
      return;
    }

    const errBox = element('div', 'dk-agent-error');
    errBox.setAttribute('role', 'alert');
    errBox.append(
      element('strong', '', item.fatal ? 'Erro na execução' : 'Aviso da execução'),
      element('p', '', item.message),
    );
    row.replaceChildren(errBox);
  }

  private resetRows() {
    this.stream.replaceChildren();
    this.rows.clear();
    this.dirty.clear();
  }

  private async start() {
    if (
      !this.root ||
      this.opening ||
      this.starting ||
      isRunActive(this.currentRun) ||
      !this.capabilities?.claude.disponivel
    ) {
      return;
    }
    const prompt = this.input.value.trim();
    if (!prompt) return;

    const root = this.root;
    const options: AgentStartOptions = {
      provider: 'claude',
      prompt,
      modo: 'interativo',
    };
    if (this.skillSelect.value) options.skillId = this.skillSelect.value;
    if (this.designSelect.value) options.designSystemId = this.designSelect.value;
    if (this.currentStageId) options.stage = this.currentStageId;
    if (this.selectedFiles.length > 0) options.files = [...this.selectedFiles];
    if (this.resumeSession && this.currentRun?.sessionId && this.currentRun.estado === 'concluido') {
      options.sessionId = this.currentRun.sessionId;
    }

    this.starting = true;
    this.controls();

    try {
      const created = await this.api.start(root, options);
      if (this.destroyed) return;
      if (this.root === root) {
        this.input.value = '';
        this.resumeSession = false;
        this.resumeToggleBtn.setAttribute('aria-pressed', 'false');
        this.saveDraft();
        await this.select(created.runId);
      }
    } catch (error) {
      if (!this.destroyed && this.root === root) {
        this.fail(error);
        void this.refreshCapabilities();
      }
    } finally {
      this.starting = false;
      if (!this.destroyed) this.controls();
    }
  }

  private async cancel() {
    if (!this.root || !this.currentRun || !isRunActive(this.currentRun) || this.canceling) return;
    const root = this.root;
    const runId = this.currentRun.runId;
    this.canceling = true;
    this.controls();

    try {
      await this.api.cancel(root, runId);
    } catch (error) {
      if (!this.destroyed && this.root === root) {
        this.fail(error);
      }
    } finally {
      this.canceling = false;
      if (!this.destroyed) this.controls();
    }
  }

  private async approve(itemId: string, requestId: string, choice: 'allow' | 'deny') {
    if (!this.root || !this.currentRun || this.approving.has(requestId)) return;
    const root = this.root;
    const runId = this.currentRun.runId;
    this.approving.add(requestId);
    const row = this.rows.get(itemId);
    row?.querySelectorAll('button').forEach(btn => {
      btn.disabled = true;
    });

    try {
      await this.api.approve(root, runId, requestId, choice);
    } catch (error) {
      this.approving.delete(requestId);
      if (!this.destroyed && this.root === root && this.currentRun?.runId === runId) {
        this.fail(error);
        this.dirty.add(itemId);
        this.renderMessages();
      }
    } finally {
      this.approving.delete(requestId);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.saveDraft();
    this.destroyed = true;
    this.request++;
    this.capRequest++;
    this.contextRequest++;
    this.previewRequest++;
    this.treeRequest++;
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.rows.clear();
    this.dirty.clear();
    this.earlyEvents.clear();
    this.bufferedEvents = [];
    this.article.remove();
  }
}
