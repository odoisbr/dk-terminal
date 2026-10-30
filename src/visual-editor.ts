export type VisualReason = string;
export interface VisualDocInfo {
  url: string;
  gen: number;
  chan: string;
  nodes: number;
  warnings: string[];
  scripts: number;
  handlers: number;
  eol: 'lf' | 'crlf' | 'mixed' | 'none';
  loneCR: boolean;
}
export interface VisualState {
  open: boolean;
  relative: string | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  truncated: boolean;
  gen: number | null;
}
export type VisualResult<T> = ({ ok: true } & T) | { ok: false; reason: VisualReason; message: string };
export interface VisualInspect {
  tag: string;
  text: string | null;
  attrs: Record<string, string>;
  style: Record<string, string>;
  can: { text: boolean; attrs: string[]; css: boolean };
  reasons: string[];
  readonly: string | null;
}
export type VisualOp =
  | { type: 'text'; node: number; value: string }
  | { type: 'attr'; node: number; name: string; value: string | null }
  | { type: 'css'; node: number; prop: string; value: string | null };
type DocumentResult = { doc: VisualDocInfo; state: VisualState };
export interface VisualApi {
  openVisual(root: string, relative: string, options: { codeEditorDirty: boolean }): Promise<VisualResult<DocumentResult>>;
  inspectVisual(root: string, gen: number, node: number): Promise<VisualResult<{ inspect: VisualInspect }>>;
  applyVisual(root: string, gen: number, op: VisualOp): Promise<VisualResult<DocumentResult>>;
  undoVisual(root: string, gen: number): Promise<VisualResult<DocumentResult>>;
  redoVisual(root: string, gen: number): Promise<VisualResult<DocumentResult>>;
  saveVisual(root: string, gen: number): Promise<VisualResult<{ state: VisualState; revision: string }>>;
  reloadVisual(root: string): Promise<VisualResult<DocumentResult>>;
  closeVisual(root: string): Promise<{ ok: true }>;
  visualState(root: string): Promise<VisualState>;
  onVisualEvent(callback: (event: { type: 'revoked'; reason: string }) => void): () => void;
  onBack?(): void;
  onOpenCode?(root: string, relative: string): void;
  onSaved?(root: string, relative: string): void | Promise<void>;
}
type Session = DocumentResult & { root: string; relative: string };
type Tab = 'text' | 'attrs' | 'style' | 'link' | 'image';
type Counts = Record<'img' | 'style' | 'font' | 'connect' | 'other', number>;
type BridgeBase = { dk: 1; v: 1; chan: string; gen: number };
export type BridgeMessage = BridgeBase & (
  | { type: 'dk-edit-ready'; nodes: number; scripts_off: boolean }
  | { type: 'dk-edit-select'; node: number; count: number }
  | { type: 'dk-edit-blocked'; counts: Counts; hosts: string[] }
  | { type: 'dk-edit-scroll'; y: number }
);
const encoder = new TextEncoder();
const categories = ['img', 'style', 'font', 'connect', 'other'] as const;
const imageAttrs = ['src', 'alt', 'width', 'height', 'srcset'];
const tabs: Record<Tab, string> = { text: 'Texto', attrs: 'Atributos', style: 'Estilo', link: 'Link', image: 'Imagem' };
const reasons: Record<string, string> = {
  'no-target': 'Elemento não encontrado nesta versão.',
  'not-leaf': 'Selecione um elemento interno com texto simples.',
  'raw-context': 'O texto desta tag deve ser editado no código.',
  foreign: 'Elementos SVG e MathML são somente leitura.',
  template: 'Elementos dentro de template são somente leitura.',
  clone: 'Elemento duplicado pela estrutura HTML. Edite no código.',
  implicit: 'Elemento implícito sem tag no código. Edite no código.',
  'attr-not-allowed': 'Este atributo não pode ser editado visualmente.',
  'attr-duplicated-in-source': 'Atributo duplicado. Corrija no código.',
  'value-invalid': 'Valor inválido para este campo.',
  'css-unparseable': 'Estilo com sintaxe não suportada. Edite no código.',
  'css-duplicate': 'Propriedade CSS duplicada. Corrija no código.',
  'path-outside': 'Use um caminho relativo dentro do projeto.',
  'image-missing': 'Imagem ausente, não suportada ou maior que 4 MiB.',
  'too-large': 'O valor excede o limite permitido.',
  'verify-bytes': 'Alteração recusada na verificação de integridade.',
  'verify-tree': 'A alteração mudaria a estrutura HTML.',
  'stale-gen': 'O documento mudou. Tente novamente.',
  'not-open': 'A sessão visual não está aberta.',
  'dirty-code-editor': 'Salve ou descarte as alterações no código antes de editar visualmente.',
  'editor-codigo-sujo': 'Salve ou descarte as alterações no código antes de editar visualmente.',
  'project-changed': 'O projeto mudou. Abra o arquivo novamente.',
  revoked: 'A sessão visual foi encerrada.',
  FILE_CONFLICT: 'O arquivo foi alterado no disco.',
  'extensao-nao-html': 'Apenas arquivos .html e .htm são aceitos.',
  'documento-maior-2-mib': 'O arquivo excede o limite de 2 MiB.',
  'nao-utf8': 'O arquivo não está em UTF-8 válido.',
  nul: 'O arquivo contém bytes nulos.',
  'meta-charset-nao-utf8': 'O documento declara outra codificação.',
  'instrucao-servidor': 'O arquivo contém instruções de servidor. Edite no código.',
  frameset: 'Documentos com frameset não são suportados.',
  plaintext: 'Documentos com plaintext não são suportados.',
  'comentario-aberto': 'O arquivo termina com comentário não fechado.',
  'rcdata-aberto': 'O arquivo termina com tag de texto não fechada.',
  'rawtext-aberto': 'O arquivo termina com script ou estilo não fechado.',
};
const cssFields: Record<string, string> = {
  color: 'Cor do texto', 'background-color': 'Cor de fundo', 'font-size': 'Tamanho da fonte',
  'font-weight': 'Peso da fonte', 'font-style': 'Estilo da fonte', 'line-height': 'Altura de linha',
  'letter-spacing': 'Espaçamento de letras', 'text-align': 'Alinhamento', 'text-decoration': 'Decoração',
  margin: 'Margem', 'margin-top': 'Margem superior', 'margin-right': 'Margem direita',
  'margin-bottom': 'Margem inferior', 'margin-left': 'Margem esquerda', padding: 'Espaçamento interno',
  'padding-top': 'Espaçamento superior', 'padding-right': 'Espaçamento direito',
  'padding-bottom': 'Espaçamento inferior', 'padding-left': 'Espaçamento esquerdo',
  width: 'Largura', height: 'Altura', 'min-width': 'Largura mínima', 'max-width': 'Largura máxima',
  'min-height': 'Altura mínima', 'max-height': 'Altura máxima', gap: 'Espaço entre itens',
  border: 'Borda', 'border-radius': 'Arredondamento', opacity: 'Opacidade', display: 'Exibição',
};
const attrLabels: Record<string, string> = {
  id: 'Identificador', class: 'Classes', title: 'Título', 'aria-label': 'Rótulo acessível',
  role: 'Papel ARIA', lang: 'Idioma', dir: 'Direção (ltr, rtl ou auto)', hidden: 'Ocultar elemento',
  href: 'Destino do link', src: 'Caminho da imagem', alt: 'Texto alternativo',
  width: 'Largura', height: 'Altura',
};

function object(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function keys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(',') === expected;
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Pure shape/envelope validation. The view separately enforces the rolling 30 messages/s budget. */
export function validateBridgeMessage(
  data: unknown, origin: string, sourceOk: boolean, doc: Pick<VisualDocInfo, 'chan' | 'gen' | 'nodes'>,
): data is BridgeMessage {
  if (!sourceOk || origin !== 'null' || !object(data)) return false;
  if (data.dk !== 1 || data.v !== 1 || data.chan !== doc.chan || data.gen !== doc.gen) return false;
  try {
    const json = JSON.stringify(data);
    if (json.length > 16384 || encoder.encode(json).byteLength > 16384) return false;
  } catch { return false; }
  switch (data.type) {
    case 'dk-edit-ready':
      return keys(data, 'chan,dk,gen,nodes,scripts_off,type,v')
        && integer(data.nodes, 0, 200000) && data.scripts_off === true;
    case 'dk-edit-select':
      return keys(data, 'chan,count,dk,gen,node,type,v')
        && integer(data.node, 0, Math.min(doc.nodes, 200000) - 1) && integer(data.count, 1, 64);
    case 'dk-edit-scroll':
      return keys(data, 'chan,dk,gen,type,v,y')
        && typeof data.y === 'number' && Number.isFinite(data.y) && data.y >= 0;
    case 'dk-edit-blocked':
      return keys(data, 'chan,counts,dk,gen,hosts,type,v')
        && object(data.counts) && keys(data.counts, 'connect,font,img,other,style')
        && categories.every(key => integer((data.counts as Record<string, unknown>)[key], 0, Number.MAX_SAFE_INTEGER))
        && Array.isArray(data.hosts) && data.hosts.length <= 10
        && data.hosts.every(host => typeof host === 'string' && host.length >= 1 && host.length <= 253
          && !/[\s/?#\\@\x00-\x1f\x7f]/.test(host));
    default: return false;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function button(label: string, action: () => void, className = ''): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function reason(code: string, fallback = 'Operação recusada no editor visual.'): string {
  return reasons[code] ?? fallback.replace(/[\u2013\u2014]/g, ':');
}

export class VisualEditorView {
  private session: Session | null = null;
  private target: { root: string; relative: string } | null = null;
  private busy = false;
  private closing = false;
  private destroyed = false;
  private epoch = 0;
  private inspectRequest = 0;
  private selected: number | null = null;
  private cloneCount = 1;
  private scrollY = 0;
  private ready = false;
  private selectionPending = false;
  private inspect: VisualInspect | null = null;
  private activeTab: Tab = 'text';
  private receivedAt: number[] = [];
  private blockedTotal = 0;
  private blockedHosts = new Set<string>();
  private conflict = false;
  private cancelConfirm: (() => void) | null = null;
  private readonly unsubscribe: () => void;
  private readonly article = el('section', 'dk-visual');
  private readonly toolbar = el('div', 'dk-visual-toolbar');
  private readonly filename = el('strong', 'dk-visual-filename', 'Editor visual');
  private readonly badge = el('span', 'dk-visual-dirty-badge', 'Não salvo');
  private readonly banners = el('div', 'dk-visual-banners');
  private readonly status = el('div', 'dk-visual-status-screen', 'Abra um arquivo HTML para editar visualmente.');
  private readonly body = el('div', 'dk-visual-body');
  private readonly stage = el('div', 'dk-visual-stage');
  private iframe: HTMLIFrameElement | null = null;
  private readonly inspector = el('aside', 'dk-visual-inspector');
  private readonly heading = el('div', 'dk-visual-inspector-head', 'Elemento selecionado');
  private readonly tabBar = el('div', 'dk-visual-tabs');
  private readonly panel = el('div', 'dk-visual-panel-scroll');
  private readonly feedback = el('p', 'dk-visual-error');
  private readonly appliedFields = el('ul', 'dk-visual-applied-fields');
  private readonly dialog = el('dialog', 'dk-visual-confirm');
  private readonly back: HTMLButtonElement;
  private readonly undo: HTMLButtonElement;
  private readonly redo: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly reloadButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly codeButton: HTMLButtonElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly api: VisualApi,
    private readonly notify: (message: unknown) => void,
  ) {
    const boundApi = {} as VisualApi;
    for (const method of [
      'openVisual', 'inspectVisual', 'applyVisual', 'undoVisual', 'redoVisual',
      'saveVisual', 'reloadVisual', 'closeVisual', 'visualState', 'onVisualEvent',
    ] as const) {
      const fn = api[method];
      if (typeof fn !== 'function') throw new Error('Editor visual indisponível: API incompleta.');
      Reflect.set(boundApi, method, fn.bind(api));
    }
    boundApi.onBack = api.onBack;
    boundApi.onOpenCode = api.onOpenCode;
    boundApi.onSaved = api.onSaved;
    this.api = boundApi;
    this.back = button('Voltar', () => { void this.close(); });
    this.undo = button('Desfazer', () => { void this.history('undoVisual'); });
    this.redo = button('Refazer', () => { void this.history('redoVisual'); });
    this.saveButton = button('Salvar', () => { void this.save(); }, 'dk-visual-primary');
    this.reloadButton = button('Recarregar', () => { void this.reload(); });
    this.closeButton = button('Fechar', () => { void this.close(); });
    this.codeButton = button('Abrir no editor de código', () => { void this.openCode(); });
    this.article.setAttribute('aria-label', 'Editor visual de HTML');
    this.back.dataset.testid = 'visual-back';
    const file = el('div', 'dk-visual-file');
    file.append(this.filename, this.badge);
    const actions = el('div', 'dk-visual-actions');
    actions.append(this.undo, this.redo, this.saveButton, this.reloadButton, this.closeButton, this.codeButton);
    this.toolbar.append(this.back, file, actions);
    this.tabBar.setAttribute('role', 'tablist');
    this.tabBar.setAttribute('aria-label', 'Propriedades do elemento');
    this.inspector.setAttribute('aria-label', 'Elemento selecionado');
    this.appliedFields.setAttribute('aria-live', 'polite');
    this.inspector.append(this.heading, this.tabBar, this.panel, this.appliedFields, this.feedback);
    this.body.append(this.stage, this.inspector);
    this.banners.setAttribute('aria-live', 'polite');
    this.feedback.setAttribute('role', 'alert');
    this.dialog.setAttribute('aria-label', 'Confirmar alterações');
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.cancelConfirm?.(); });
    this.article.append(this.toolbar, this.banners, this.status, this.body, this.dialog);
    this.article.addEventListener('keydown', event => {
      if (event.defaultPrevented || this.dialog.open || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 's') { event.preventDefault(); void this.save(); }
      if (key === 'z' && !(event.target instanceof Element && event.target.closest('input, textarea, select'))) {
        event.preventDefault();
        void this.history(event.shiftKey ? 'redoVisual' : 'undoVisual');
      }
    });
    this.renderControls();
    this.renderInspector();
    this.unsubscribe = this.api.onVisualEvent(event => {
      if (event.type !== 'revoked' || this.closing || (!this.target && !this.session)) return;
      this.reset();
      this.status.textContent = 'Sessão visual encerrada.';
      this.notify('Editor visual fechado: ' + reason(event.reason, 'a sessão foi revogada.'));
      this.api.onBack?.();
    });
    try {
      if (typeof this.unsubscribe !== 'function') throw new Error('Editor visual indisponível: API de eventos inválida.');
      window.addEventListener('message', this.onMessage);
      host.replaceChildren(this.article);
    } catch (error) {
      window.removeEventListener('message', this.onMessage);
      if (typeof this.unsubscribe === 'function') this.unsubscribe();
      throw error;
    }
  }

  dirty(): boolean { return this.session?.state.dirty ?? false; }
  isOpenFor(root: string): boolean { return this.target?.root === root; }
  isOpen(): boolean { return this.target !== null; }

  async open(root: string, relative: string, codeEditorDirty = false): Promise<boolean> {
    if (this.destroyed || this.busy || this.dialog.open) return false;
    if (this.session && !await this.close(false)) return false;
    const epoch = ++this.epoch;
    this.target = { root, relative };
    this.busy = true;
    this.status.textContent = 'Abrindo editor visual…';
    this.renderControls();
    try {
      const response = await this.api.openVisual(root, relative, { codeEditorDirty });
      if (epoch !== this.epoch) return false;
      const result = this.unwrap(response);
      this.session = { root, relative, ...result };
      this.setGeneration(result);
      return true;
    } catch (error) {
      if (epoch === this.epoch) {
        this.status.textContent = error instanceof Error ? error.message : 'Falha ao abrir o arquivo.';
        this.notify(this.status.textContent);
      }
      return false;
    } finally {
      if (epoch === this.epoch) { this.busy = false; this.renderControls(); }
    }
  }

  async close(notifyBack = true): Promise<boolean> {
    if (this.busy || this.dialog.open) return false;
    const session = this.session;
    if (session && this.dirty()) {
      const choice = await this.confirm('Salvar alterações em ' + session.relative + '?', [
        ['cancel', 'Cancelar'], ['discard', 'Descartar alterações'], ['save', 'Salvar'],
      ]);
      if (this.session !== session || choice === 'cancel') return false;
      if (choice === 'save' && (!await this.save() || this.dirty())) return false;
    }
    this.busy = true;
    this.closing = true;
    this.renderControls();
    try {
      if (this.target) await this.api.closeVisual(this.target.root);
      this.reset();
      if (notifyBack) this.api.onBack?.();
      return true;
    } catch (error) { this.notify(error); return false; }
    finally { this.busy = false; this.closing = false; this.renderControls(); }
  }

  async save(): Promise<boolean> {
    if (!this.session) return false;
    if (!this.dirty()) return true;
    return this.perform(async session => {
      const response = await this.api.saveVisual(session.root, session.doc.gen);
      if (this.session !== session) return;
      const result = this.unwrap(response);
      session.state = result.state;
      this.conflict = false;
      await this.api.onSaved?.(session.root, session.relative);
    });
  }

  private async reload(): Promise<void> {
    const session = this.session;
    if (!session || this.busy || this.dialog.open) return;
    const choice = await this.confirm('Recarregar do disco? As alterações e o histórico serão descartados.', [
      ['cancel', 'Cancelar'], ['reload', 'Recarregar'],
    ]);
    if (choice !== 'reload' || this.session !== session) return;
    await this.perform(async current => {
      const response = await this.api.reloadVisual(current.root);
      if (this.session !== current) return;
      const result = this.unwrap(response);
      this.conflict = false;
      this.setGeneration(result);
    });
  }

  private async openCode(): Promise<void> {
    const target = this.target;
    if (await this.close(false)) {
      if (target && this.api.onOpenCode) this.api.onOpenCode(target.root, target.relative);
      else this.api.onBack?.();
    }
  }

  private async history(method: 'undoVisual' | 'redoVisual'): Promise<void> {
    if (!this.session?.state[method === 'undoVisual' ? 'canUndo' : 'canRedo']) return;
    await this.perform(async session => {
      const response = await this.api[method](session.root, session.doc.gen);
      if (this.session === session) this.setGeneration(this.unwrap(response));
    });
  }

  private unwrap<T>(result: VisualResult<T>): T {
    if (result.ok) return result;
    if (result.reason === 'FILE_CONFLICT') this.conflict = true;
    throw new Error(reason(result.reason, result.message));
  }

  /** Keep one mutation in flight and discard completions from a revoked/replaced session. */
  private async perform(task: (session: Session) => Promise<void>): Promise<boolean> {
    const session = this.session;
    if (!session || this.busy || this.dialog.open) return false;
    this.busy = true;
    this.feedback.textContent = '';
    this.renderControls();
    try {
      await task(session);
      return this.session === session;
    } catch (error) {
      if (this.session === session) {
        this.feedback.textContent = error instanceof Error ? error.message : 'Falha na operação visual.';
        this.notify(this.feedback.textContent);
      }
      return false;
    } finally {
      if (this.session === session) {
        this.busy = false;
        this.renderControls();
        this.renderBanners();
      }
    }
  }

  private setGeneration(result: DocumentResult): void {
    if (!this.session) return;
    this.session.doc = result.doc;
    this.session.state = result.state;
    this.inspectRequest++;
    this.inspect = null;
    this.ready = false;
    this.selectionPending = this.selected !== null;
    this.blockedTotal = 0;
    this.blockedHosts.clear();
    if (this.selected !== null && this.selected >= result.doc.nodes) this.selected = null;
    try {
      if (new URL(result.doc.url).protocol !== 'dk-preview:') throw new Error();
    } catch {
      const message = 'Endereço de prévia inválido. Abra o arquivo novamente.';
      this.iframe?.remove();
      this.iframe = null;
      this.stage.replaceChildren(el('p', 'dk-visual-empty', message));
      this.renderControls();
      this.renderBanners();
      this.renderInspector();
      throw new Error(message);
    }
    if (!this.iframe) {
      this.iframe = el('iframe', 'dk-visual-frame');
      this.iframe.setAttribute('sandbox', 'allow-scripts');
      this.iframe.setAttribute('allow', '');
      this.iframe.setAttribute('referrerpolicy', 'no-referrer');
      this.iframe.title = 'Edição visual de ' + this.session.relative;
      this.iframe.addEventListener('load', () => this.sendMark());
      this.stage.replaceChildren(this.iframe);
    }
    this.iframe.src = result.doc.url;
    this.renderControls();
    this.renderBanners();
    this.renderInspector();
    if (this.selected !== null) void this.loadInspect();
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const session = this.session;
    if (!session || !this.iframe || event.source !== this.iframe.contentWindow || event.origin !== 'null') return;
    const now = performance.now();
    this.receivedAt = this.receivedAt.filter(time => now - time < 1000);
    if (this.receivedAt.length >= 30) return;
    this.receivedAt.push(now);
    const data: unknown = event.data;
    if (!validateBridgeMessage(data, event.origin, event.source === this.iframe.contentWindow, session.doc)) return;
    switch (data.type) {
      case 'dk-edit-ready':
        this.ready = true;
        this.sendMark();
        break;
      case 'dk-edit-select':
        if (this.busy || this.dialog.open) return;
        this.selected = data.node;
        this.selectionPending = false;
        this.cloneCount = data.count;
        this.appliedFields.replaceChildren();
        this.feedback.textContent = '';
        void this.loadInspect();
        break;
      case 'dk-edit-scroll':
        if (this.ready) this.scrollY = data.y;
        break;
      case 'dk-edit-blocked':
        for (const key of categories) this.blockedTotal = Math.min(Number.MAX_SAFE_INTEGER, this.blockedTotal + data.counts[key]);
        for (const host of data.hosts) if (this.blockedHosts.size < 10) this.blockedHosts.add(host);
        this.renderBanners();
        break;
    }
  };

  private sendMark(): void {
    const doc = this.session?.doc;
    if (!doc || !this.iframe) return;
    this.iframe.contentWindow?.postMessage({
      type: 'dk-edit-mark', dk: 1, v: 1, chan: doc.chan, gen: doc.gen,
      node: this.selectionPending ? null : this.selected, scrollY: this.scrollY,
    }, '*');
  }

  private async loadInspect(): Promise<void> {
    const session = this.session, node = this.selected;
    if (!session || node === null) return;
    const gen = session.doc.gen, request = ++this.inspectRequest;
    this.inspect = null;
    this.renderInspector();
    try {
      const result = await this.api.inspectVisual(session.root, gen, node);
      if (this.session !== session || gen !== session.doc.gen || request !== this.inspectRequest) return;
      this.inspect = this.unwrap(result).inspect;
      this.selectionPending = false;
      this.sendMark();
      this.renderInspector();
    } catch (error) {
      if (this.session !== session || gen !== session.doc.gen || request !== this.inspectRequest) return;
      this.selected = null;
      this.selectionPending = false;
      this.sendMark();
      this.renderInspector();
      this.feedback.textContent = error instanceof Error ? error.message : 'Falha na inspeção.';
      this.renderControls();
    }
  }

  private renderControls(): void {
    this.filename.textContent = this.target?.relative ?? 'Editor visual';
    this.filename.title = this.filename.textContent;
    this.badge.hidden = !this.dirty();
    this.undo.disabled = this.busy || !this.session?.state.canUndo;
    this.redo.disabled = this.busy || !this.session?.state.canRedo;
    this.saveButton.disabled = this.busy || !this.dirty();
    this.reloadButton.disabled = this.busy || !this.session;
    this.back.disabled = this.closeButton.disabled = this.busy;
    this.codeButton.disabled = this.busy || !this.target;
    this.body.hidden = !this.session;
    this.status.hidden = !!this.session;
    this.inspector.inert = this.busy;
    this.feedback.hidden = !this.feedback.textContent;
  }

  private renderBanners(): void {
    this.banners.replaceChildren();
    const session = this.session;
    if (!session) { this.banners.hidden = true; return; }
    const { doc, state } = session;
    const add = (text: string) => {
      const banner = el('div', 'dk-visual-banner', text);
      this.banners.append(banner);
      return banner;
    };
    if (this.conflict) {
      const banner = add('Conflito ao salvar: o arquivo foi alterado no disco.');
      banner.classList.add('is-conflict');
      banner.append(
        button('Recarregar (descarta alterações)', () => { void this.reload(); }),
        button('Continuar editando', () => { this.conflict = false; this.renderBanners(); }),
      );
    }
    if (doc.scripts + doc.handlers > 0) {
      add('Scripts desativados na edição: ' + doc.scripts + ' scripts e ' + doc.handlers
        + ' manipuladores. Use a prévia de serviço para testar o comportamento.');
    }
    if (this.blockedTotal) {
      add(this.blockedTotal + ' recursos externos não carregados'
        + (this.blockedHosts.size ? ': ' + [...this.blockedHosts].join(', ') : '') + '.');
    }
    if (doc.eol === 'mixed' || doc.loneCR) {
      add('Aviso: ' + [doc.eol === 'mixed' ? 'finais de linha mistos' : '', doc.loneCR ? '\\r solitário' : '']
        .filter(Boolean).join(' e ') + '. Os bytes fora do trecho editado são preservados.');
    }
    if (doc.warnings.includes('base')) add('Tag <base> ignorada na edição visual.');
    if (doc.warnings.includes('interpolacao')) add('Marcadores de template ({{ }}) detectados.');
    if (state.truncated) add('Limite do histórico atingido. Alterações antigas não podem ser desfeitas.');
    this.banners.hidden = !this.banners.childElementCount;
  }

  private availableTabs(inspect: VisualInspect): Tab[] {
    if (inspect.readonly !== null || this.cloneCount > 1) return [];
    const result: Tab[] = [];
    if (inspect.can.text) result.push('text');
    if (this.attributes(inspect, 'attrs').length) result.push('attrs');
    if (inspect.can.css) result.push('style');
    if (inspect.can.attrs.includes('href')) result.push('link');
    if (inspect.can.attrs.some(attr => imageAttrs.includes(attr))) result.push('image');
    return result;
  }

  private attributes(inspect: VisualInspect, tab: Tab): string[] {
    return inspect.can.attrs.filter(attr => tab === 'link' ? attr === 'href'
      : tab === 'image' ? imageAttrs.includes(attr) : attr !== 'href' && !imageAttrs.includes(attr));
  }

  private renderInspector(): void {
    this.tabBar.replaceChildren();
    this.panel.replaceChildren();
    const inspect = this.inspect;
    this.heading.textContent = inspect ? '<' + inspect.tag + '> #' + this.selected : 'Elemento selecionado';
    if (!inspect) {
      this.panel.append(el('p', 'dk-visual-empty', this.selected === null
        ? 'Clique em um elemento na página para editar.' : 'Inspecionando elemento…'));
      return;
    }
    const available = this.availableTabs(inspect);
    if (!available.length) {
      const code = this.cloneCount > 1 ? 'clone' : inspect.readonly ?? inspect.reasons[0] ?? 'not-leaf';
      this.panel.append(el('p', 'dk-visual-readonly', 'Elemento somente leitura. ' + reason(code)));
      return;
    }
    if (!available.includes(this.activeTab)) this.activeTab = available[0];
    for (const tab of available) {
      const tabButton = button(tabs[tab], () => {
        this.activeTab = tab;
        this.feedback.textContent = '';
        this.renderInspector();
        this.renderControls();
      }, 'dk-visual-tab');
      tabButton.setAttribute('role', 'tab');
      tabButton.setAttribute('aria-selected', String(tab === this.activeTab));
      this.tabBar.append(tabButton);
    }
    if (inspect.reasons.length) this.panel.append(el('p', 'dk-visual-note', reason(inspect.reasons[0])));
    this.renderForm(inspect);
  }

  /** The same field builder handles attributes, links, images and the fixed CSS vocabulary. */
  private renderForm(inspect: VisualInspect): void {
    const node = this.selected!;
    const form = el('form', 'dk-visual-form');
    const readers: Array<() => VisualOp | null> = [];
    const field = (name: string, type: 'text' | 'attr' | 'css') => {
      const values = type === 'css' ? inspect.style : inspect.attrs;
      const initial = type === 'text' ? inspect.text ?? '' : values[name] ?? null;
      const label = el('label', 'dk-visual-field');
      label.append(el('span', '', type === 'text' ? 'Texto do elemento'
        : (type === 'css' ? cssFields[name] : attrLabels[name]) + ' (' + name + ')'));
      const input = type === 'text' ? el('textarea', 'dk-visual-textarea') : el('input');
      if (input instanceof HTMLInputElement) {
        input.type = name === 'hidden' || name === 'srcset' ? 'checkbox' : 'text';
        if (input.type === 'checkbox') input.checked = name === 'hidden' && initial !== null;
        else input.placeholder = 'Vazio remove';
      }
      input.value = initial ?? '';
      if (name === 'srcset') {
        label.firstChild!.textContent = 'Remover srcset existente';
        label.append(el('small', '', 'Este atributo só pode ser removido.'));
      }
      label.append(input);
      form.append(label);
      readers.push(() => {
        let value: string | null;
        if (input instanceof HTMLInputElement && input.type === 'checkbox') {
          if (name === 'srcset') return input.checked ? { type: 'attr', node, name, value: null } : null;
          value = input.checked ? '' : null;
        } else {
          const raw = input.value;
          if (raw === initial) return null;
          if (/[\r\0]/.test(raw)) throw new Error('Remova retornos de carro e caracteres nulos.');
          if (type === 'text' && encoder.encode(raw).byteLength > 65536) throw new Error('Texto maior que 64 KiB.');
          if (type !== 'text' && raw.length > (type === 'css' ? 128 : 1024)) throw new Error('Valor acima do limite permitido.');
          value = type === 'text' ? raw : raw === '' ? null : raw;
        }
        if (value === initial) return null;
        return type === 'text' ? { type, node, value: value! }
          : type === 'css' ? { type, node, prop: name, value } : { type, node, name, value };
      });
    };
    if (this.activeTab === 'text') field('text', 'text');
    else if (this.activeTab === 'style') for (const prop of Object.keys(cssFields)) field(prop, 'css');
    else {
      for (const attr of this.attributes(inspect, this.activeTab)) {
        if (attr !== 'srcset' || Object.hasOwn(inspect.attrs, attr)) field(attr, 'attr');
      }
      if (this.activeTab === 'image' || this.activeTab === 'link') {
        form.append(el('p', 'dk-visual-note', 'Use caminhos relativos dentro do projeto.'
          + (this.activeTab === 'image' ? ' Imagens de até 4 MiB.' : '')));
      }
    }
    const apply = el('button', 'dk-visual-primary', 'Aplicar');
    apply.type = 'submit';
    form.append(apply);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (this.busy || this.dialog.open) return;
      try {
        const ops = readers.map(read => read()).filter((op): op is VisualOp => op !== null);
        if (ops.length) void this.applyOperations(ops);
      } catch (error) {
        this.feedback.textContent = error instanceof Error ? error.message : 'Valor inválido.';
        this.renderControls();
      }
    });
    this.panel.append(form);
  }

  private async applyOperations(ops: VisualOp[]): Promise<void> {
    await this.perform(async session => {
      const rows = ops.map(op => {
        const name = op.type === 'text' ? 'Texto do elemento'
          : op.type === 'css' ? cssFields[op.prop] + ' (' + op.prop + ')'
            : (attrLabels[op.name] ?? op.name) + ' (' + op.name + ')';
        return { name, row: el('li', '', name + ': aguardando.') };
      });
      this.appliedFields.replaceChildren(...rows.map(({ row }) => row));
      for (const [index, op] of ops.entries()) {
        const { name, row } = rows[index];
        try {
          const result = await this.api.applyVisual(session.root, session.doc.gen, op);
          if (this.session !== session) return;
          const document = this.unwrap(result);
          row.textContent = name + ': aplicado. Pode ser desfeito separadamente.';
          this.setGeneration(document);
        } catch (error) {
          if (this.session !== session) return;
          row.textContent = name + ': falhou.';
          for (const pending of rows.slice(index + 1)) pending.row.textContent = pending.name + ': não enviado.';
          throw new Error('Falha no campo ' + name + ': '
            + (error instanceof Error ? error.message : 'Falha na operação visual.'));
        }
      }
    });
  }

  private confirm(message: string, choices: Array<[string, string]>): Promise<string> {
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      const finish = (choice: string) => {
        this.cancelConfirm = null;
        this.dialog.close();
        this.dialog.replaceChildren();
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        resolve(choice);
      };
      this.cancelConfirm = () => finish('cancel');
      const actions = el('div', 'dk-visual-actions');
      for (const [value, label] of choices) actions.append(button(label, () => finish(value)));
      this.dialog.replaceChildren(el('p', '', message), actions);
      this.dialog.showModal();
      actions.querySelector('button')?.focus();
    });
  }

  private reset(): void {
    this.epoch++;
    this.inspectRequest++;
    this.cancelConfirm?.();
    this.session = null;
    this.target = null;
    this.busy = false;
    this.selected = null;
    this.cloneCount = 1;
    this.scrollY = 0;
    this.ready = false;
    this.selectionPending = false;
    this.inspect = null;
    this.receivedAt = [];
    this.blockedTotal = 0;
    this.blockedHosts.clear();
    this.conflict = false;
    this.feedback.textContent = '';
    this.appliedFields.replaceChildren();
    this.iframe?.remove();
    this.iframe = null;
    this.banners.replaceChildren();
    this.banners.hidden = true;
    this.status.textContent = 'Editor visual fechado.';
    this.renderControls();
    this.renderInspector();
  }

  destroy(): boolean {
    if (this.busy || this.dirty()) return false;
    this.destroyed = true;
    this.reset();
    window.removeEventListener('message', this.onMessage);
    this.unsubscribe();
    this.host.replaceChildren();
    return true;
  }
}
