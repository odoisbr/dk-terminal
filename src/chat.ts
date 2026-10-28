export type CodexChatSession = {
  id: string; root: string; title: string; createdAt: number; updatedAt: number;
  model: string | null; running: boolean; status: string;
};
export type CodexChatMessage = {
  id: string; kind: 'user' | 'assistant' | 'tool' | 'system' | 'permission'; createdAt: number;
  text?: string; output?: string; command?: string; cwd?: string; label?: string;
  toolType?: string; status?: string; reason?: string; requestId?: string; exitCode?: number | null;
};
export type CodexChatSnapshot = { session: CodexChatSession; messages: CodexChatMessage[] };
export type CodexChatEvent = {
  sessionId: string; root: string; type: 'snapshot' | 'message' | 'delta' | 'tool' | 'permission' | 'status' | 'error';
  snapshot?: CodexChatSnapshot; session?: CodexChatSession; message?: CodexChatMessage | string;
  tool?: CodexChatMessage; permission?: CodexChatMessage; messageId?: string;
  field?: 'text' | 'output'; value?: string;
};
// Errors share the `message` property with user-visible string errors from the main process.
type IncomingEvent = CodexChatEvent;
export type CodexChatApi = {
  create(root: string): Promise<CodexChatSession>;
  list(root: string): Promise<CodexChatSession[]>;
  read(root: string, id: string): Promise<CodexChatSnapshot>;
  send(root: string, id: string, text: string): Promise<void>;
  cancel(root: string, id: string): Promise<void>;
  approve(root: string, id: string, requestId: string, choice: 'accept' | 'decline'): Promise<void>;
  onBack?: () => void;
};

const CSS = `
.dk-chat{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--surface,#151a1c);color:var(--text,#e7eae9);font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.dk-chat *{box-sizing:border-box}.dk-chat button,.dk-chat select,.dk-chat textarea{font:inherit;color:inherit}.dk-chat button,.dk-chat select{border:1px solid var(--border,#354044);border-radius:6px;background:transparent}.dk-chat button{cursor:pointer;padding:5px 10px}.dk-chat button:hover{background:#ffffff0d}.dk-chat button:disabled{opacity:.45;cursor:default}.dk-chat button:focus-visible,.dk-chat select:focus-visible,.dk-chat textarea:focus-visible{outline:2px solid var(--accent,#b8d991);outline-offset:2px}
.dk-chat-header{display:flex;align-items:center;gap:10px;min-height:51px;padding:10px 16px;border-bottom:1px solid var(--border,#303b3f)}.dk-chat-header strong{font-size:13px;white-space:nowrap}.dk-chat-header select{min-width:60px;max-width:300px;width:100%;padding:5px 8px;margin-left:auto;background:var(--surface,#151a1c)}.dk-chat-header button{white-space:nowrap}.dk-chat-back{border:0!important;font-size:19px!important;padding:0 6px!important}
.dk-chat-scroll{overflow:auto;flex:1;min-height:0;overscroll-behavior:contain;padding:26px clamp(16px,4vw,64px) 16px;scrollbar-width:thin}.dk-chat-stream{width:100%;max-width:1000px;margin:0 auto}.dk-chat-empty{max-width:550px;margin:clamp(20px,12vh,130px) auto;text-align:center;color:var(--muted,#8e9c9c)}.dk-chat-empty strong{display:block;color:var(--text,#e7eae9);font-size:25px;letter-spacing:-.7px;margin:12px}.dk-chat-empty p{margin:10px 0}
.dk-chat-message{margin:0 0 24px;white-space:pre-wrap;overflow-wrap:anywhere}.dk-chat-label{display:flex;gap:7px;align-items:center;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--muted,#9aa6a5);margin-bottom:8px;text-transform:uppercase}.dk-chat-user{padding:14px 17px;background:#ffffff06;border:1px solid var(--border,#303b3f);border-radius:8px}.dk-chat-assistant{padding:0 1px}.dk-chat-system{padding:10px 14px;border-left:2px solid #d4ad76;color:#dfbb88;background:#dfbb8808}.dk-chat-content{margin:0;white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.7}
.dk-chat-tool{margin-bottom:14px;border:1px solid var(--border,#354044);border-radius:8px;overflow:hidden}.dk-chat-tool summary{display:flex;gap:9px;align-items:center;padding:9px 12px;cursor:pointer;font-size:12px;list-style:none}.dk-chat-tool summary::before{content:'›';font-size:18px;color:var(--muted,#94a29f)}.dk-chat-tool[open] summary::before{transform:rotate(90deg)}.dk-chat-tool-status{margin-left:auto;color:var(--muted,#94a29f);font-size:11px}.dk-chat-tool pre{margin:0;padding:12px 15px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0002;max-height:340px;overflow:auto}.dk-chat-command{border-bottom:1px solid var(--border,#303b3f)}
.dk-chat-permission{padding:15px;border:1px solid #bfab71;border-radius:8px;background:#bfab7108;margin-bottom:16px}.dk-chat-permission p{margin:4px 0 12px;white-space:pre-wrap;overflow-wrap:anywhere}.dk-chat-permission pre{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}.dk-chat-permission-actions{display:flex;gap:8px}.dk-chat-accept{border-color:#b8d991!important;color:#c6e3a7!important}
.dk-chat-footer{width:100%;max-width:1128px;margin:0 auto;padding:12px clamp(16px,4vw,64px) 20px}.dk-chat-state{min-height:23px;font-size:11px;color:var(--muted,#98a6a1);display:flex;gap:8px;align-items:center}.dk-chat-dot{width:6px;height:6px;background:var(--accent,#b8d991);border-radius:50%;animation:dk-chat-pulse 1.8s ease-in-out infinite}.dk-chat-form{border:1px solid var(--border,#3e4b4e);border-radius:10px;background:#ffffff03;padding:10px 12px}.dk-chat-form:focus-within{border-color:var(--accent,#a1c47b)}.dk-chat-form textarea{border:0;outline:none!important;background:transparent;display:block;width:100%;height:58px;min-height:44px;max-height:180px;resize:vertical;line-height:1.6;padding:2px 0}.dk-chat-form textarea::placeholder{color:var(--muted,#84928f)}.dk-chat-form-row{display:flex;align-items:center;gap:10px;margin-top:9px}.dk-chat-model{font-size:11px;color:var(--muted,#98a6a1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dk-chat-submit{margin-left:auto;background:var(--accent,#b8d991)!important;color:#17201b!important;border-color:transparent!important;font-size:12px!important}.dk-chat-stop{margin-left:auto;color:#e9ba9e!important}.dk-chat-note{font-size:10px;text-align:center;margin:7px 0 0;color:var(--muted,#85938e)}
@keyframes dk-chat-pulse{50%{opacity:.3}}@media(prefers-reduced-motion:reduce){.dk-chat-dot{animation:none}}@media(max-width:600px){.dk-chat-header{padding:8px;gap:6px}.dk-chat-header button{padding:5px 7px}.dk-chat-header strong{font-size:12px}.dk-chat-scroll{padding:18px 12px}.dk-chat-footer{padding:8px 12px 12px}.dk-chat-note{display:none}}
`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); result.className = className; result.textContent = text; return result;
}
function button(label: string, action: () => void, className = '') {
  const result = element('button', className, label); result.type = 'button'; result.addEventListener('click', action); return result;
}
function statusText(status?: string) {
  const labels: Record<string, string> = { idle: 'Pronto', starting: 'Conectando ao Codex…', running: 'Codex trabalhando…', completed: 'Concluído', interrupted: 'Interrompido', failed: 'Falhou', inProgress: 'Em andamento', declined: 'Recusado', accepted: 'Permitido', expired: 'Encerrado', pending: 'Aguardando sua decisão' };
  return status ? labels[status] || status : '';
}

/** Safe text-only Codex conversation pane, with no hosted extension or HTML from model output. */
export class CodexChatView {
  private root = '';
  private session: CodexChatSession | null = null;
  private sessions: CodexChatSession[] = [];
  private messages: CodexChatMessage[] = [];
  private request = 0;
  private opening = false;
  private sending = false;
  private frame: number | null = null;
  private rows = new Map<string, HTMLElement>();
  private dirty = new Set<string>();
  private article: HTMLElement;
  private scroll: HTMLElement;
  private stream: HTMLElement;
  private picker: HTMLSelectElement;
  private input: HTMLTextAreaElement;
  private submit: HTMLButtonElement;
  private stop: HTMLButtonElement;
  private state: HTMLElement;
  private model: HTMLElement;
  private drafts = new Map<string, string>();

  constructor(private host: HTMLElement, private api: CodexChatApi, private onError: (error: unknown) => void) {
    if (!document.getElementById('dk-codex-chat-style')) { const style = element('style'); style.id = 'dk-codex-chat-style'; style.textContent = CSS; document.head.append(style); }
    this.article = element('section', 'dk-chat'); this.article.setAttribute('aria-label', 'Conversa com Codex');
    const header = element('header', 'dk-chat-header');
    const back = button('‹', () => { this.saveDraft(); this.api.onBack?.(); }, 'dk-chat-back'); back.title = 'Voltar ao terminal'; back.setAttribute('aria-label', 'Voltar ao terminal');
    this.picker = element('select'); this.picker.setAttribute('aria-label', 'Conversas do projeto');
    this.picker.addEventListener('change', () => { void this.select(this.picker.value); });
    header.append(back, element('strong', '', 'Codex'), this.picker, button('+ Nova', () => { void this.create(); }));
    this.scroll = element('div', 'dk-chat-scroll'); this.stream = element('div', 'dk-chat-stream'); this.scroll.append(this.stream);
    const footer = element('footer', 'dk-chat-footer'); this.state = element('div', 'dk-chat-state'); this.state.setAttribute('role', 'status');
    const form = element('form', 'dk-chat-form');
    this.input = element('textarea'); this.input.placeholder = 'Peça ao Codex para trabalhar neste projeto…'; this.input.setAttribute('aria-label', 'Mensagem para o Codex'); this.input.maxLength = 64000;
    this.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.send(); } });
    this.input.addEventListener('input', () => { this.saveDraft(); this.controls(); });
    const row = element('div', 'dk-chat-form-row'); this.model = element('span', 'dk-chat-model');
    this.submit = button('Enviar ↑', () => { void this.send(); }, 'dk-chat-submit');
    this.stop = button('■ Interromper', () => { void this.cancel(); }, 'dk-chat-stop');
    row.append(this.model, this.submit, this.stop); form.append(this.input, row);
    form.addEventListener('submit', event => { event.preventDefault(); void this.send(); });
    footer.append(this.state, form, element('p', 'dk-chat-note', 'Conta e configuração da CLI oficial · Enter envia · Shift + Enter quebra a linha'));
    this.article.append(header, this.scroll, footer); this.host.replaceChildren(this.article); this.controls(); this.renderMessages();
  }

  private fail(error: unknown) { this.onError(error); }
  private saveDraft() { if (this.session) this.drafts.set(this.session.id, this.input.value); }

  async open(root: string) {
    const request = ++this.request;
    this.saveDraft(); this.root = root; this.opening = true; this.controls();
    try {
      const sessions = await this.api.list(root);
      if (request !== this.request) return;
      this.sessions = sessions;
      const previous = this.session?.root === root && sessions.some(session => session.id === this.session?.id) ? this.session.id : sessions[0]?.id;
      if (previous) await this.select(previous);
      else await this.create();
    } catch (error) { this.fail(error); }
    finally { if (request === this.request) { this.opening = false; this.controls(); } }
  }

  private async create() {
    if (!this.root) return;
    const root = this.root, request = ++this.request;
    try {
      const session = await this.api.create(root);
      if (root !== this.root || request !== this.request) return;
      this.saveDraft(); this.sessions.unshift(session); this.session = session; this.messages = [];
      this.input.value = ''; this.resetRows(); this.renderPicker(); this.renderMessages(); this.controls(); this.input.focus();
    } catch (error) { this.fail(error); }
    finally { if (request === this.request) { this.opening = false; this.controls(); } }
  }

  private async select(id: string) {
    const request = ++this.request;
    const root = this.root;
    this.saveDraft();
    try {
      const snapshot = await this.api.read(root, id);
      if (request !== this.request || root !== this.root) return;
      this.session = snapshot.session; this.messages = snapshot.messages;
      this.input.value = this.drafts.get(id) || '';
      this.resetRows(); this.renderPicker(); this.renderMessages(); this.controls(); this.scroll.scrollTop = this.scroll.scrollHeight;
    } catch (error) { this.fail(error); }
    finally { if (request === this.request) { this.opening = false; this.controls(); } }
  }

  handle(event: IncomingEvent) {
    if (event.root !== this.root) return;
    if (event.session) {
      const index = this.sessions.findIndex(session => session.id === event.sessionId);
      if (index >= 0) this.sessions[index] = event.session;
      else this.sessions.unshift(event.session);
      this.renderPicker();
    }
    if (!this.session || event.sessionId !== this.session.id) return;
    if (event.type === 'snapshot' && event.snapshot) {
      this.session = event.snapshot.session; this.messages = event.snapshot.messages;
      this.messages.forEach(message => this.dirty.add(message.id));
    } else if (event.type === 'status' && event.session) {
      this.session = event.session;
    } else if (event.type === 'delta' && event.messageId && event.field && typeof event.value === 'string') {
      const item = this.messages.find(message => message.id === event.messageId);
      if (item) { item[event.field] = event.value; this.dirty.add(item.id); }
    } else if (event.type === 'message' || event.type === 'tool' || event.type === 'permission') {
      const item = event.tool || event.permission || (typeof event.message === 'object' ? event.message : undefined);
      if (item) { const index = this.messages.findIndex(message => message.id === item.id); if (index >= 0) this.messages[index] = item; else this.messages.push(item); this.dirty.add(item.id); }
    }
    // Error text is also stored as a system message by the backend; avoid duplicate toast noise.
    this.controls();
    if (this.frame === null) this.frame = requestAnimationFrame(() => { this.frame = null; this.renderMessages(); });
  }

  private renderPicker() {
    const selected = this.session?.id;
    this.picker.replaceChildren(...this.sessions.map(session => { const option = element('option', '', `${session.running ? '● ' : ''}${session.title}`); option.value = session.id; return option; }));
    if (selected) this.picker.value = selected;
  }

  private controls() {
    const running = Boolean(this.session?.running || this.sending);
    this.input.disabled = this.opening || !this.session;
    this.submit.hidden = running; this.submit.disabled = this.opening || !this.session || !this.input.value.trim();
    this.stop.hidden = !running; this.stop.disabled = !this.session?.running;
    this.model.textContent = this.session?.model || 'Configuração atual do Codex';
    this.state.replaceChildren();
    if (running) this.state.append(element('span', 'dk-chat-dot'));
    this.state.append(document.createTextNode(this.opening ? 'Abrindo conversa…' : statusText(this.session?.status || 'idle')));
  }

  private renderMessages() {
    const atBottom = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 100;
    if (!this.messages.length) {
      const empty = element('div', 'dk-chat-empty'); empty.append(element('span', '', '✳'), element('strong', '', 'O seu projeto, em conversa.'), element('p', '', 'Peça uma análise, uma alteração ou ajuda para entender o código.'), element('p', '', 'O Codex usa a conta e as preferências da CLI instalada.'));
      this.stream.replaceChildren(empty); this.rows.clear(); return;
    }
    if (!this.rows.size) this.stream.replaceChildren();
    for (const message of this.messages.slice(-200)) {
      let row = this.rows.get(message.id);
      if (!row) { row = element('div'); this.rows.set(message.id, row); this.dirty.add(message.id); this.stream.append(row); }
      if (this.dirty.has(message.id)) this.renderRow(row, message);
    }
    const live = new Set(this.messages.map(message => message.id));
    for (const [id, row] of this.rows) if (!live.has(id)) { row.remove(); this.rows.delete(id); }
    this.dirty.clear();
    if (atBottom) this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  private renderRow(row: HTMLElement, message: CodexChatMessage) {
    if (message.kind === 'tool') {
      const previous = row.querySelector('details')?.open;
      const details = element('details', 'dk-chat-tool'); details.open = previous ?? false;
      const summary = element('summary'); summary.append(element('strong', '', message.label || 'Ferramenta'), element('span', 'dk-chat-tool-status', statusText(message.status)));
      details.append(summary);
      if (message.command) details.append(element('pre', 'dk-chat-command', message.command));
      if (message.cwd) { const cwd = element('pre', '', message.cwd); cwd.style.opacity = '.6'; details.append(cwd); }
      if (message.output) details.append(element('pre', '', message.output));
      if (message.exitCode !== undefined && message.exitCode !== null) details.append(element('pre', '', `Código de saída: ${message.exitCode}`));
      row.replaceChildren(details);
    } else if (message.kind === 'permission') {
      const card = element('div', 'dk-chat-permission');
      card.append(element('strong', '', message.label || 'O Codex precisa da sua autorização'));
      if (message.reason) card.append(element('p', '', message.reason));
      if (message.command) card.append(element('pre', '', message.command));
      if (message.cwd) card.append(element('p', '', message.cwd));
      if (message.output) card.append(element('pre', '', message.output));
      if (message.status === 'pending') {
        const actions = element('div', 'dk-chat-permission-actions');
        actions.append(button('Permitir uma vez', () => { void this.approve(message, 'accept'); }, 'dk-chat-accept'), button('Recusar', () => { void this.approve(message, 'decline'); }));
        card.append(actions);
      } else card.append(element('p', '', statusText(message.status)));
      row.replaceChildren(card);
    } else {
      const box = element('div', `dk-chat-message dk-chat-${message.kind}`);
      box.append(element('div', 'dk-chat-label', message.kind === 'user' ? 'Você' : message.kind === 'assistant' ? '✳ Codex' : 'Aviso'), element('div', 'dk-chat-content', message.text || ''));
      row.replaceChildren(box);
    }
  }

  private resetRows() { this.stream.replaceChildren(); this.rows.clear(); this.dirty.clear(); }

  private async send() {
    if (!this.session || this.session.running || this.sending || !this.input.value.trim()) return;
    const root = this.root, id = this.session.id, text = this.input.value.trim();
    this.sending = true; this.controls();
    try {
      await this.api.send(root, id, text);
      this.drafts.delete(id);
      if (this.root === root && this.session?.id === id) this.input.value = '';
    } catch (error) { this.fail(error); }
    finally { this.sending = false; this.controls(); }
  }

  private async cancel() {
    if (!this.session?.running) return;
    this.stop.disabled = true;
    try { await this.api.cancel(this.root, this.session.id); }
    catch (error) { this.fail(error); this.controls(); }
  }

  private async approve(message: CodexChatMessage, choice: 'accept' | 'decline') {
    if (!this.session || !message.requestId) return;
    const row = this.rows.get(message.id);
    row?.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try { await this.api.approve(this.root, this.session.id, message.requestId, choice); }
    catch (error) { this.fail(error); row?.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  }

  destroy() {
    this.saveDraft(); this.request++;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null; this.rows.clear(); this.article.remove();
  }
}
