import { icon } from './icons';
// Seção "Detectados nas sessões" da guia Serviços: servidores que o usuário
// iniciou nos terminais do projeto ativo (por exemplo, npm run dev digitado).
type Options = {
  openPreview(root: string, url: string): Promise<void>;
  reloadDeclared(root: string): Promise<void>;
  notify(error: unknown): void;
};
const AUTO_REFRESH_MS = 10000;
const refreshIcon = icon('refresh');
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => { const item = document.createElement(tag); item.className = className; item.textContent = text; return item; };

export class DetectedServicesView {
  private readonly refreshButton: HTMLButtonElement;
  private readonly section: HTMLElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly count: HTMLElement;
  private root: string | null = null;
  private visible = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private request = 0;
  private loading = false;
  private readonly results = new Map<string, DetectedServices>();
  private readonly errors = new Map<string, string>();
  private readonly busy = new Set<number>();

  constructor(host: HTMLElement, private readonly options: Options) {
    const toolbar = element('div', 'services-toolbar');
    this.refreshButton = element('button', 'button services-refresh');
    this.refreshButton.type = 'button'; this.refreshButton.id = 'services-refresh';
    this.refreshButton.title = 'Procurar de novo os serviços do projeto e os servidores abertos nas sessões';
    this.refreshButton.onclick = () => { if (this.root) void this.refresh(true); };
    toolbar.append(this.refreshButton);
    host.prepend(toolbar);
    this.section = element('div', 'detected-services'); this.section.id = 'detected-services';
    const label = element('div', 'section-label'); label.append(element('span', '', 'DETECTADOS NAS SESSÕES'));
    this.count = element('span', '', '0'); this.count.id = 'detected-count'; label.append(this.count);
    this.status = element('p', 'context-note detected-status'); this.status.id = 'detected-status'; this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.list = element('div', 'detected-list'); this.list.id = 'detected-list';
    this.section.append(label, this.status, this.list);
    host.append(this.section);
    this.renderButton();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.visible && this.root) void this.refresh(false);
      this.schedule();
    });
  }

  // Chamado ao renderizar a guia e ao trocar de painel ou de projeto.
  update(root: string | null, visible: boolean) {
    const changed = root !== this.root, shown = visible && !this.visible;
    this.root = root; this.visible = visible && !!root;
    this.schedule();
    if (changed) this.render();
    if (this.visible && (changed || shown)) void this.refresh(false);
  }

  private schedule() {
    const active = this.visible && document.visibilityState === 'visible';
    if (active && !this.timer) this.timer = setInterval(() => { if (this.root && !this.loading) void this.refresh(false); }, AUTO_REFRESH_MS);
    if (!active && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async refresh(manual: boolean) {
    const root = this.root;
    if (!root) return;
    const request = ++this.request;
    this.loading = true; this.renderButton();
    try {
      const work: Promise<unknown>[] = [window.dk.detectSessionServices(root).then(result => {
        if (request !== this.request) return;
        this.results.set(root, result); this.errors.delete(root);
      })];
      if (manual) work.push(this.options.reloadDeclared(root));
      await Promise.all(work);
    } catch (error) {
      this.errors.set(root, 'Não foi possível consultar os processos das sessões. Tente atualizar de novo.');
      if (manual) this.options.notify(error);
    } finally {
      if (request === this.request) { this.loading = false; this.renderButton(); }
      if (this.root === root) this.render();
    }
  }

  private renderButton() {
    this.refreshButton.disabled = this.loading;
    this.refreshButton.innerHTML = `${refreshIcon}<span>${this.loading ? 'Atualizando…' : 'Atualizar'}</span>`;
    this.refreshButton.classList.toggle('loading', this.loading);
    if (this.loading) { this.refreshButton.setAttribute('aria-busy', 'true'); this.section.setAttribute('aria-busy', 'true'); }
    else { this.refreshButton.removeAttribute('aria-busy'); this.section.removeAttribute('aria-busy'); }
  }

  private render() {
    const root = this.root;
    this.list.replaceChildren();
    const result = root ? this.results.get(root) : undefined;
    const items = result?.items || [];
    this.count.textContent = String(items.length);
    const error = root ? this.errors.get(root) : undefined;
    if (!root) { this.status.textContent = ''; return; }
    if (error) this.status.textContent = error;
    else if (!result) this.status.textContent = 'Procurando servidores nas sessões…';
    else if (!result.supported) this.status.textContent = 'A detecção de servidores nas sessões está disponível no macOS e no Linux.';
    else if (!items.length) this.status.textContent = 'Nenhum servidor escutando nas sessões deste projeto. Rode um servidor num terminal, como npm run dev, e toque em Atualizar.';
    else this.status.textContent = 'Servidores abertos por você nos terminais deste projeto.';
    for (const item of items) this.list.append(this.row(root, item));
  }

  private row(root: string, item: DetectedService) {
    const row = element('div', 'service-row detected-row'); row.dataset.detectedPid = String(item.pid);
    const heading = element('div', 'service-heading');
    const dot = element('span', 'status-dot ready'); dot.setAttribute('aria-hidden', 'true');
    const copy = element('div'); const name = element('strong', '', item.command); name.title = item.command;
    copy.append(name, element('small', '', `PID ${item.pid} · porta${item.ports.length > 1 ? 's' : ''} ${item.ports.join(', ')} · ${item.sessionLabel}`));
    heading.append(dot, copy); row.append(heading);
    if (item.url) { const address = element('div', 'service-address', item.url); address.title = item.url; row.append(address); }
    const actions = element('div', 'detected-actions');
    const open = element('button', 'button detected-preview', 'Abrir na prévia'); open.type = 'button';
    open.disabled = !item.url;
    open.title = item.url ? `Abrir ${item.url} na prévia do projeto` : 'Este servidor não escuta em localhost';
    open.setAttribute('aria-label', `Abrir na prévia: ${item.command}, porta ${item.ports[0]}`);
    open.onclick = () => {
      if (!item.url) return;
      open.disabled = true;
      void this.options.openPreview(root, item.url).catch(this.options.notify).finally(() => { if (open.isConnected) open.disabled = false; });
    };
    const stop = element('button', 'button detected-stop', this.busy.has(item.pid) ? 'Encerrando…' : 'Encerrar'); stop.type = 'button';
    stop.disabled = this.busy.has(item.pid);
    stop.title = 'Encerrar este processo e os do mesmo grupo. Pede confirmação.';
    stop.setAttribute('aria-label', `Encerrar processo ${item.pid}: ${item.command}`);
    stop.onclick = () => { void this.terminate(root, item, stop); };
    actions.append(open, stop); row.append(actions);
    return row;
  }

  private async terminate(root: string, item: DetectedService, control: HTMLButtonElement) {
    if (this.busy.has(item.pid)) return;
    this.busy.add(item.pid); control.disabled = true; control.textContent = 'Aguardando confirmação…';
    try {
      const result = await window.dk.terminateDetectedService(root, item.pid, item.started);
      if (result.status === 'terminated' && this.root === root) this.status.textContent = `Pedido de encerramento enviado ao PID ${item.pid}.`;
    } catch (error) { this.options.notify(error); }
    finally {
      this.busy.delete(item.pid);
      if (this.root === root) {
        await this.refresh(false);
        // Servidores costumam levar alguns instantes para liberar a porta.
        setTimeout(() => { if (this.root === root && this.visible) void this.refresh(false); }, 1500);
      }
    }
  }
}
