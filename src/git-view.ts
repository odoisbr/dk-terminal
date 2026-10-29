import { icon, setIconButton } from './icons';
import { renderGitGraph } from './git-graph';
import { GitlabPublishFlow } from './gitlab-publish';
import './git.css';

type GitOptions = {
  getRoot: () => string | null;
  hasUnsaved: () => boolean;
  changeBranch: (root: string, action: 'create' | 'switch', name: string) => Promise<void>;
};
type Section = 'changes' | 'graph' | 'tools';
type GitState = {
  message: string;
  selected: Set<string>;
  sections: Record<Section, boolean>;
  busy: boolean;
  feedback: { text: string; error: boolean } | null;
};
type ReadResult<T> = { value: T; error: null } | { value: null; error: string };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const conflict = (code: string) => /U/.test(code) || code === 'AA' || code === 'DD';
const readResult = <T>(result: PromiseSettledResult<T>): ReadResult<T> => result.status === 'fulfilled'
  ? { value: result.value, error: null }
  : { value: null, error: errorText(result.reason) };

export class GitView {
  private serial = 0;
  private root: string | null = null;
  private readonly states = new Map<string, GitState>();
  private readonly publishFlows = new Map<string, GitlabPublishFlow>();
  constructor(private host: HTMLElement, private options: GitOptions) {}

  private state(root: string): GitState {
    let state = this.states.get(root);
    if (!state) {
      state = { message: '', selected: new Set(), sections: { changes: true, graph: true, tools: false }, busy: false, feedback: null };
      this.states.set(root, state);
    }
    return state;
  }

  private current(root: string): boolean { return this.root === root && this.options.getRoot() === root; }

  async refresh() {
    const root = this.options.getRoot(), serial = ++this.serial;
    this.root = root;
    this.host.replaceChildren();
    if (!root) { this.host.append(el('p', 'context-note', 'Abra um projeto para acompanhar suas versões.')); return; }
    const flow = this.publishFlows.get(root);
    if (flow) { this.host.replaceChildren(flow.element); return; }
    const state = this.state(root);
    if (state.busy) {
      const notice = el('p', 'git-feedback', 'Operação Git em andamento…');
      notice.setAttribute('role', 'status');
      this.host.append(notice);
      return;
    }
    this.host.append(el('p', 'context-note', 'Consultando alterações…'));
    try {
      const status = await window.dk.gitStatus(root);
      if (serial !== this.serial || !this.current(root)) return;
      if (!status.repository) {
        this.host.replaceChildren(el('p', 'context-note', 'Esta pasta ainda não é um repositório Git. Abra um projeto com Git para acompanhar alterações e histórico, ou publique esta pasta como um novo projeto no GitLab SEA.'), this.publishButton(root));
        return;
      }
      // An unavailable history or branch list must not hide pending changes.
      const [branches, graph] = await Promise.allSettled([window.dk.gitBranches(root), window.dk.gitGraph(root)]);
      if (serial !== this.serial || !this.current(root)) return;
      this.render(root, status, readResult(branches), readResult(graph));
    } catch (error) {
      if (serial === this.serial && this.current(root)) this.host.replaceChildren(el('p', 'git-error', errorText(error)));
    }
  }

  private section(root: string, key: Section, title: string, count?: string) {
    const state = this.state(root), section = el('section', `git-section git-section-${key}`);
    section.dataset.testid = `git-${key}-section`;
    const toggle = el('button', 'git-section-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', count === undefined ? title : `${title}, ${count}`);
    toggle.setAttribute('aria-controls', `git-${key}-content`);
    const arrow = el('span', 'git-section-arrow'); arrow.innerHTML = icon('chevron'); arrow.setAttribute('aria-hidden', 'true');
    const label = el('strong', '', title); toggle.append(arrow, label);
    if (count !== undefined) { const badge = el('span', 'git-section-count', count); badge.setAttribute('aria-hidden', 'true'); toggle.append(badge); }
    const body = el('div', `git-section-content git-${key}-content`); body.id = `git-${key}-content`;
    const apply = () => {
      toggle.setAttribute('aria-expanded', String(state.sections[key]));
      section.classList.toggle('is-open', state.sections[key]);
      body.hidden = !state.sections[key];
    };
    toggle.onclick = () => { state.sections[key] = !state.sections[key]; apply(); };
    apply(); section.append(toggle, body);
    return { section, body };
  }

  private render(root: string, status: Extract<GitStatus, { repository: true }>, branches: ReadResult<GitBranch[]>, graph: ReadResult<GitGraphCommit[]>) {
    const state = this.state(root);
    const available = new Set(status.changes.filter(item => !conflict(item.code)).map(item => item.path));
    for (const path of state.selected) if (!available.has(path)) state.selected.delete(path);
    this.host.replaceChildren();

    const header = el('div', 'git-heading'), copy = el('div');
    copy.append(el('span', 'git-kicker', 'CONTROLE DE VERSÃO'), el('strong', 'git-branch', status.branch));
    const refresh = el('button', 'git-refresh'); refresh.type = 'button';
    setIconButton(refresh, 'refresh', 'Atualizar Git');
    refresh.onclick = () => void this.refresh(); header.append(copy, refresh); this.host.append(header);

    const notice = el('p', 'git-operation-status'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    this.host.append(notice); this.updateNotice(root);
    if (!status.gitlab && !status.gitlabHost) {
      const callout = el('div', 'gitlab-publish-callout');
      callout.append(el('p', 'git-muted', status.hasOrigin ? 'O remoto desta pasta não é o GitLab SEA.' : 'Esta pasta ainda não está no GitLab SEA.'), this.publishButton(root));
      this.host.append(callout);
    }
    const layout = el('div', 'git-dashboard');
    const changes = this.section(root, 'changes', 'Alterações', String(status.changes.length));
    const history = this.section(root, 'graph', 'Grafo', graph.value ? String(graph.value.length) : '—');
    const tools = this.section(root, 'tools', 'Ferramentas', branches.error === null ? undefined : '!');
    if (branches.error !== null) {
      const toggle = tools.section.querySelector('button')!;
      toggle.setAttribute('aria-label', 'Ferramentas, erro ao carregar branches');
      toggle.title = 'Não foi possível carregar as branches';
    }
    layout.append(changes.section, history.section, tools.section); this.host.append(layout);

    this.renderChanges(root, state, status, changes.body);
    if (graph.error !== null) {
      history.body.append(el('p', 'git-error', `Não foi possível carregar o grafo: ${graph.error}`));
    } else {
      const list = el('div', 'git-graph'); list.tabIndex = 0; list.setAttribute('aria-label', 'Histórico de versões');
      renderGitGraph(list, graph.value, root, () => this.current(root));
      history.body.append(list);
      if (graph.value.length === 100) history.body.append(el('p', 'git-muted git-graph-limit', 'Exibindo as 100 versões mais recentes das referências locais.'));
    }
    this.renderTools(root, status, branches, tools.body);
  }

  private renderChanges(root: string, state: GitState, status: Extract<GitStatus, { repository: true }>, body: HTMLElement) {
    const form = el('form', 'git-commit');
    const message = el('textarea'); message.rows = 2; message.placeholder = 'Descreva o que mudou'; message.maxLength = 2000;
    message.setAttribute('aria-label', 'Mensagem da versão'); message.dataset.testid = 'git-commit-message'; message.value = state.message;
    message.disabled = status.changes.length === 0;
    const hint = el('p', 'git-commit-hint', 'Usa o conteúdo já salvo dos arquivos selecionados.'); hint.id = 'git-commit-hint';
    const submit = el('button', 'button primary', 'Salvar versão'); submit.type = 'submit'; submit.dataset.testid = 'git-commit';
    submit.setAttribute('aria-describedby', hint.id);
    const updateSubmit = () => { submit.disabled = state.busy || !state.selected.size || !state.message.trim(); };
    message.oninput = () => { state.message = message.value; updateSubmit(); };
    message.onkeydown = event => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        if (!submit.disabled) form.requestSubmit();
      }
    };
    form.onsubmit = event => {
      event.preventDefault();
      if (submit.disabled || !this.current(root)) return;
      if (this.options.hasUnsaved()) { window.alert('Salve os arquivos abertos no editor antes de criar uma versão. O Git registra o conteúdo salvo no disco.'); return; }
      const names = [...state.selected], savedMessage = state.message;
      void this.perform(root, () => window.dk.gitCommit(root, names, savedMessage), {
        commit: true,
        onSuccess: result => {
          if (result !== true) throw new Error('Não foi possível confirmar a criação da versão.');
          if (state.message === savedMessage) state.message = '';
          names.forEach(name => state.selected.delete(name));
        }
      });
    };
    updateSubmit(); form.append(message, submit, hint); body.append(form);

    const selection = el('div', 'git-selection-bar');
    const selectAll = el('button', 'git-select-all', 'Selecionar todos'); selectAll.type = 'button';
    selectAll.disabled = !status.changes.some(item => !conflict(item.code));
    const selectionCount = el('span', 'git-selected-count');
    const updateCount = () => { selectionCount.textContent = `${state.selected.size} selecionado${state.selected.size === 1 ? '' : 's'}`; updateSubmit(); };
    selection.append(selectAll, selectionCount); body.append(selection);
    const rows = el('div', 'git-changes'); rows.setAttribute('aria-label', 'Arquivos alterados'); rows.tabIndex = 0;
    const checks = new Map<string, HTMLInputElement>();
    for (const item of status.changes) {
      const row = el('div', 'git-change');
      const check = el('input'); check.type = 'checkbox'; check.setAttribute('aria-label', `Selecionar ${item.path}`);
      check.disabled = conflict(item.code); check.checked = state.selected.has(item.path);
      if (check.disabled) check.title = 'Resolva o conflito antes de salvar a versão.';
      check.onchange = () => { if (check.checked) state.selected.add(item.path); else state.selected.delete(item.path); updateCount(); };
      checks.set(item.path, check);
      const name = el('button', 'git-file', item.path); name.type = 'button'; name.title = `Ver alteração de ${item.path}`;
      const badge = el('span', 'git-change-badge', conflict(item.code) ? 'Conflito' : item.code === '??' ? 'Novo' : item.code.includes('D') ? 'Removido' : 'Alterado');
      if (conflict(item.code)) badge.classList.add('is-conflict');
      const details = el('div', 'git-diff'); details.hidden = true;
      name.onclick = async () => {
        if (!details.hidden) { details.hidden = true; return; }
        details.hidden = false; details.textContent = 'Carregando comparação…';
        try {
          const diff = await window.dk.gitDiff(root, item.path);
          if (this.current(root) && details.isConnected) details.textContent = diff;
        } catch (error) { if (this.current(root) && details.isConnected) details.textContent = errorText(error); }
      };
      row.append(check, name, badge); rows.append(row, details);
    }
    if (!status.changes.length) rows.append(el('p', 'git-muted', 'Nenhuma alteração pendente.'));
    selectAll.onclick = () => {
      for (const [path, check] of checks) if (!check.disabled) { check.checked = true; state.selected.add(path); }
      updateCount();
    };
    updateCount(); body.append(rows);
  }

  private renderTools(root: string, status: Extract<GitStatus, { repository: true }>, branches: ReadResult<GitBranch[]>, body: HTMLElement) {
    const counts = status.ahead === null || status.behind === null ? 'Sincronização indisponível' : `${status.ahead} para enviar · ${status.behind} para receber`;
    const syncTitle = el('div', 'git-tool-title', 'Sincronização');
    body.append(syncTitle, el('p', 'git-muted git-sync-counts', counts));
    const action = (label: string, callback: () => Promise<unknown>, confirmation?: string, refresh = true) => {
      const button = el('button', 'button secondary', label); button.type = 'button';
      button.onclick = () => {
        if (!this.current(root) || this.state(root).busy) return;
        if (confirmation && !window.confirm(confirmation)) return;
        void this.perform(root, callback, { refresh });
      };
      return button;
    };
    const sync = el('div', 'git-actions');
    sync.append(action('Buscar', () => window.dk.gitSync(root, 'fetch')),
      action('Atualizar', () => { if (this.options.hasUnsaved()) throw new Error('Salve os arquivos abertos no editor antes de atualizar o projeto.'); return window.dk.gitSync(root, 'pull'); }, 'Atualizar o projeto com as versões disponíveis? A atualização só acontece quando não há alterações locais.'),
      action('Enviar', () => window.dk.gitSync(root, 'push'), 'Enviar as versões locais para o repositório remoto?'));
    body.append(sync);

    const branchSection = el('div', 'git-branches');
    const title = el('div', 'git-tool-title', 'Branches');
    if (branches.value) title.append(el('span', 'git-tool-count', String(branches.value.length)));
    branchSection.append(title);
    if (branches.error !== null) branchSection.append(el('p', 'git-error', `Não foi possível carregar as branches: ${branches.error}`));
    else if (!status.hasHead) branchSection.append(el('p', 'git-muted', 'Salve a primeira versão para criar branches.'));
    else {
      const label = el('label', 'git-branch-label', 'Branch local');
      const select = el('select', 'git-branch-select'); select.setAttribute('aria-label', 'Selecionar branch local');
      for (const branch of branches.value) {
        const option = el('option', '', branch.name + (branch.current ? ' · atual' : ''));
        option.value = branch.name; option.selected = branch.current; select.append(option);
      }
      label.append(select); branchSection.append(label);
      const buttons = el('div', 'git-actions');
      const switchButton = el('button', 'button secondary', 'Trocar'); switchButton.type = 'button'; switchButton.disabled = !branches.value.length;
      switchButton.onclick = () => {
        if (!this.current(root) || this.state(root).busy) return;
        const name = select.value; if (name === status.branch) return;
        if (status.changes.length) { window.alert('Salve ou resolva todas as alterações locais antes de trocar de branch.'); return; }
        if (!window.confirm(`Trocar para a branch “${name}”? Arquivos abertos deste projeto serão fechados.`)) return;
        void this.perform(root, () => this.options.changeBranch(root, 'switch', name));
      };
      const remove = el('button', 'button secondary', 'Excluir'); remove.type = 'button'; remove.disabled = !branches.value.length;
      remove.onclick = () => {
        if (!this.current(root) || this.state(root).busy) return;
        const name = select.value;
        if (name === status.branch) { window.alert('Troque de branch antes de excluir a branch atual.'); return; }
        if (!window.confirm(`Excluir a branch local “${name}”? Apenas branches integradas à branch atual podem ser excluídas.`)) return;
        void this.perform(root, () => window.dk.gitBranchAction(root, 'delete', name));
      };
      buttons.append(switchButton, remove); branchSection.append(buttons);
      const form = el('form', 'git-new-branch'), field = el('input'); field.placeholder = 'Nome da nova branch'; field.maxLength = 255; field.setAttribute('aria-label', 'Nome da nova branch');
      const create = el('button', 'button secondary', 'Criar e trocar'); create.type = 'submit'; form.append(field, create);
      form.onsubmit = event => {
        event.preventDefault(); if (!this.current(root) || this.state(root).busy) return;
        const name = field.value.trim(); if (!name) { window.alert('Informe o nome da nova branch.'); return; }
        if (status.changes.length) { window.alert('Salve ou resolva todas as alterações locais antes de criar e trocar de branch.'); return; }
        if (!window.confirm(`Criar e trocar para “${name}”? Arquivos abertos deste projeto serão fechados.`)) return;
        void this.perform(root, () => this.options.changeBranch(root, 'create', name));
      };
      branchSection.append(form);
    }
    body.append(branchSection);
    if (status.gitlab) {
      body.append(el('div', 'git-tool-title', 'GitLab SEA'), el('p', 'git-muted', status.gitlab));
      const links = el('div', 'git-actions gitlab-actions');
      links.append(action('Abrir projeto', () => window.dk.gitOpenGitlab(root, 'project'), undefined, false), action('Merge requests', () => window.dk.gitOpenGitlab(root, 'merge-requests'), undefined, false));
      if (status.branch !== '(HEAD destacado)') links.append(action('Criar merge request', () => window.dk.gitOpenGitlab(root, 'new-merge-request'), undefined, false));
      body.append(links);
    }
  }

  private publishButton(root: string) {
    const button = el('button', 'button primary gitlab-publish-start', 'Criar projeto no GitLab SEA'); button.type = 'button'; button.insertAdjacentHTML('afterbegin', icon('cloudUp'));
    button.dataset.testid = 'gitlab-publish-start';
    button.onclick = () => {
      if (!this.current(root) || this.state(root).busy || this.publishFlows.has(root)) return;
      if (this.options.hasUnsaved()) { window.alert('Salve os arquivos abertos no editor antes de publicar a pasta.'); return; }
      const flow = new GitlabPublishFlow(root, {
        // The flow keeps rendering into its own element while the panel shows
        // another project; refresh() reattaches it.
        isCurrent: () => this.publishFlows.get(root) === flow,
        close: () => { if (flow.busy) return; this.publishFlows.delete(root); if (this.current(root)) void this.refresh(); },
      });
      this.publishFlows.set(root, flow); this.host.replaceChildren(flow.element); void flow.start();
    };
    return button;
  }

  private updateNotice(root: string) {
    if (!this.current(root)) return;
    const notice = this.host.querySelector<HTMLElement>('.git-operation-status');
    if (!notice) return;
    const feedback = this.state(root).feedback;
    notice.hidden = !feedback;
    notice.classList.toggle('git-error', !!feedback?.error);
    notice.classList.toggle('git-feedback', !!feedback && !feedback.error);
    notice.textContent = feedback?.text || '';
  }

  private setBusyControls(root: string, busy: boolean) {
    if (!this.current(root)) return;
    this.host.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea').forEach(control => {
      if (busy) { control.dataset.gitDisabledBeforeBusy = String(control.disabled); control.disabled = true; }
      else if ('gitDisabledBeforeBusy' in control.dataset) {
        control.disabled = control.dataset.gitDisabledBeforeBusy === 'true'; delete control.dataset.gitDisabledBeforeBusy;
      }
    });
  }

  private async perform(root: string, work: () => Promise<unknown>, options: { refresh?: boolean; commit?: boolean; onSuccess?: (result: unknown) => void } = {}) {
    const state = this.state(root);
    if (!this.current(root) || state.busy) return;
    state.busy = true; state.feedback = { text: 'Executando…', error: false };
    // Invalidate any read that began before this explicit mutation.
    this.serial++; this.setBusyControls(root, true); this.updateNotice(root);
    let failed = false;
    try {
      const result = await work();
      options.onSuccess?.(result);
      state.feedback = null;
    } catch (error) {
      failed = true;
      const detail = options.commit ? ' A preparação dos arquivos selecionados pode ter mudado. Atualize a guia para conferir.' : '';
      state.feedback = { text: errorText(error) + detail, error: true };
    } finally {
      state.busy = false; this.setBusyControls(root, false); this.updateNotice(root);
    }
    if (this.current(root) && (options.refresh !== false || failed)) await this.refresh();
  }
}
