// "Criar projeto no Git": formulário curto, revisão do que vai acontecer e
// execução. Nada é criado antes de a pessoa confirmar a revisão.
type FlowOptions = { close: () => void; isCurrent: () => boolean };
const HOST = 'gitlab.seatecnologia.com.br';
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export function slugify(value: string) {
  const slug = value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/[._-]{2,}/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 100).replace(/[._-]+$/, '');
  return slug || 'projeto';
}

export class GitlabPublishFlow {
  readonly element = el('section', 'gitlab-publish');
  private options: GitlabPublishOptions | null = null;
  private input: GitlabPublishInput | null = null;
  private slugEdited = false;
  private running = false;
  constructor(private readonly root: string, private readonly flow: FlowOptions) {
    this.element.setAttribute('aria-label', 'Criar projeto no GitLab SEA');
    this.element.dataset.testid = 'gitlab-publish';
  }
  get busy() { return this.running; }

  private frame(title: string, intro?: string) {
    this.element.replaceChildren();
    const heading = el('div', 'gitlab-publish-heading');
    heading.append(el('span', 'git-kicker', 'GITLAB SEA'), el('h2', '', title));
    this.element.append(heading);
    if (intro) this.element.append(el('p', 'git-muted', intro));
  }
  private actions(...buttons: HTMLButtonElement[]) { const row = el('div', 'gitlab-publish-actions'); row.append(...buttons); return row; }
  private button(label: string, primary: boolean, action?: () => void) {
    const button = el('button', `button ${primary ? 'primary' : 'secondary'}`, label); button.type = action ? 'button' : 'submit';
    if (action) button.onclick = action;
    return button;
  }
  private failure(message: string, retry: () => void) {
    this.frame('Criar projeto no GitLab SEA');
    const text = el('p', 'git-error gitlab-publish-error', message); text.setAttribute('role', 'alert');
    this.element.append(text, this.actions(this.button('Voltar', false, () => this.flow.close()), this.button('Tentar novamente', true, retry)));
  }

  async start() {
    this.frame('Criar projeto no GitLab SEA', 'Consultando seus grupos no GitLab SEA…');
    this.element.querySelector('.git-muted')?.setAttribute('role', 'status');
    try {
      const options = await window.dk.gitlabPublishOptions(this.root);
      if (!this.flow.isCurrent()) return;
      this.options = options; this.form();
    } catch (error) { if (this.flow.isCurrent()) this.failure(errorText(error), () => void this.start()); }
  }

  private form() {
    const options = this.options!;
    this.frame('Criar projeto no GitLab SEA', 'Cria o projeto no GitLab da empresa e publica esta pasta. Nada é criado antes da sua confirmação.');
    if (options.local.origin?.company) {
      this.element.append(el('p', 'git-error', 'Esta pasta já está ligada ao GitLab SEA. Use Enviar no painel Git para publicar as versões.'), this.actions(this.button('Voltar', false, () => this.flow.close())));
      return;
    }
    if (!options.namespaces.length) {
      this.element.append(el('p', 'git-error', 'Sua conta não pode criar projetos em nenhum grupo do Design. Peça permissão a quem administra o grupo.'), this.actions(this.button('Voltar', false, () => this.flow.close())));
      return;
    }
    const previous = this.input;
    const form = el('form', 'gitlab-publish-form'); form.noValidate = true;
    const field = (label: string, control: HTMLElement, hint?: string) => {
      const wrapper = el('label', 'gitlab-publish-field'); wrapper.append(el('span', 'gitlab-publish-label', label), control);
      if (hint) { const small = el('small', 'git-muted', hint); wrapper.append(small); }
      return wrapper;
    };
    const name = el('input'); name.name = 'name'; name.maxLength = 120; name.required = true; name.autocomplete = 'off'; name.value = previous?.name ?? options.name;
    const slug = el('input'); slug.name = 'path'; slug.maxLength = 100; slug.required = true; slug.autocomplete = 'off'; slug.spellcheck = false; slug.value = previous?.path ?? options.path;
    const group = el('select'); group.name = 'namespace';
    for (const item of options.namespaces) { const option = el('option', '', item.fullPath); option.value = String(item.id); group.append(option); }
    group.value = String(previous?.namespaceId ?? options.defaultNamespace ?? options.namespaces[0].id);
    const visibility = el('select'); visibility.name = 'visibility';
    for (const [value, label] of [['private', 'Privado (padrão)'], ['internal', 'Interno (toda a empresa)']] as const) { const option = el('option', '', label); option.value = value; visibility.append(option); }
    visibility.value = previous?.visibility ?? 'private';
    const description = el('textarea'); description.name = 'description'; description.rows = 2; description.maxLength = 500; description.value = previous?.description ?? '';
    const address = el('p', 'git-muted gitlab-publish-address'); address.setAttribute('aria-live', 'polite');
    const groupPath = () => options.namespaces.find(item => String(item.id) === group.value)?.fullPath ?? 'design';
    const syncAddress = () => { address.textContent = `Endereço: ${HOST}/${groupPath()}/${slug.value.trim() || '…'}`; };
    name.oninput = () => { if (!this.slugEdited) slug.value = slugify(name.value); syncAddress(); };
    slug.oninput = () => { this.slugEdited = true; syncAddress(); };
    group.onchange = syncAddress; syncAddress();
    form.append(field('Nome do projeto', name), field('Caminho', slug, 'Letras minúsculas, números e hífens.'), address, field('Grupo de destino', group), field('Visibilidade', visibility), field('Descrição (opcional)', description));
    let commit: HTMLInputElement | null = null, rename: HTMLInputElement | null = null;
    if (!options.local.hasHead) {
      const row = el('label', 'gitlab-publish-check'); commit = el('input'); commit.type = 'checkbox'; commit.name = 'commit'; commit.checked = previous?.commit ?? false;
      row.append(commit, el('span', '', 'Criar a primeira versão com todos os arquivos da pasta'));
      form.append(row, el('small', 'git-muted', options.local.repository ? 'Sem a primeira versão, o projeto é criado vazio e nada é enviado agora.' : 'A pasta ainda não usa Git: ele será iniciado. Sem a primeira versão, nada é enviado agora.'));
    } else if (options.local.changes) {
      form.append(el('small', 'git-muted', `${options.local.changes} alteração(ões) ainda não salvas ficam só nesta pasta. Serão enviadas as versões já salvas da branch ${options.local.branch}.`));
    }
    if (options.local.origin) {
      const row = el('label', 'gitlab-publish-check'); rename = el('input'); rename.type = 'checkbox'; rename.name = 'renameOrigin'; rename.checked = previous?.renameOrigin ?? false;
      row.append(rename, el('span', '', 'Renomear o remoto atual “origin” para “anterior” e usar o GitLab SEA como origin'));
      const current = el('small', 'git-muted', `Remoto atual: ${options.local.origin.url}`);
      form.append(row, current);
    }
    const message = el('p', 'git-error'); message.setAttribute('role', 'alert'); message.hidden = true;
    const review = this.button('Revisar', true);
    form.append(message, this.actions(this.button('Cancelar', false, () => this.flow.close()), review));
    form.onsubmit = event => {
      event.preventDefault();
      const input: GitlabPublishInput = { name: name.value.trim(), path: slug.value.trim(), namespaceId: Number(group.value), visibility: visibility.value as 'private' | 'internal', description: description.value.trim(), commit: !!commit?.checked, renameOrigin: !!rename?.checked };
      const problem = !input.name ? [name, 'Informe o nome do projeto.'] as const
        : !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(input.path) ? [slug, 'O caminho deve ter letras minúsculas, números, ponto, hífen ou sublinhado, começando e terminando com letra ou número.'] as const
        : rename && !rename.checked ? [rename, 'Marque a opção para renomear o remoto atual. Sem isso o projeto não pode ser ligado.'] as const : null;
      if (problem) { message.hidden = false; message.textContent = problem[1]; (problem[0] as HTMLElement).focus(); return; }
      this.input = input; review.disabled = true; review.textContent = 'Verificando…'; message.hidden = true;
      void window.dk.gitlabPublishPlan(this.root, input).then(plan => { if (this.flow.isCurrent()) this.confirm(plan); })
        .catch(error => { if (!this.flow.isCurrent()) return; message.hidden = false; message.textContent = errorText(error); review.disabled = false; review.textContent = 'Revisar'; });
    };
    this.element.append(form); name.focus();
  }

  private confirm(plan: GitlabPublishPlan) {
    this.frame('Confirme o que vai acontecer');
    const list = el('ol', 'gitlab-publish-steps'); list.dataset.testid = 'gitlab-publish-steps';
    for (const step of plan.steps) list.append(el('li', '', step));
    this.element.append(list);
    for (const note of plan.notes) this.element.append(el('p', 'git-muted', note));
    this.element.append(el('p', 'git-muted', `Link do projeto: ${plan.webUrl}`));
    const create = this.button('Criar e publicar', true, () => void this.run(plan));
    create.dataset.testid = 'gitlab-publish-confirm';
    this.element.append(this.actions(this.button('Voltar e editar', false, () => this.form()), create));
    create.focus();
  }

  private async run(plan: GitlabPublishPlan) {
    this.running = true;
    this.frame('Criando projeto', 'Criando o projeto no GitLab SEA e publicando esta pasta…');
    this.element.querySelector('.git-muted')?.setAttribute('role', 'status');
    try {
      const result = await window.dk.gitlabPublish(this.root, plan.id);
      this.running = false;
      if (this.flow.isCurrent()) this.done(result);
    } catch (error) {
      this.running = false;
      if (this.flow.isCurrent()) this.failure(errorText(error), () => this.form());
    }
  }

  private done(result: GitlabPublishResult) {
    this.frame(result.error ? 'Projeto criado, publicação incompleta' : 'Projeto publicado');
    const status = el('p', result.error ? 'git-error' : 'git-feedback', result.error ?? (result.pushed ? `A branch ${result.branch} foi enviada para ${result.fullPath}.` : `O projeto ${result.fullPath} foi criado e ligado a esta pasta. Salve a primeira versão e use Enviar.`));
    status.setAttribute('role', result.error ? 'alert' : 'status');
    const link = el('p', 'gitlab-publish-link'); const code = el('code', '', result.webUrl); link.append(code);
    this.element.append(status, link);
    if (result.renamed) this.element.append(el('p', 'git-muted', `O remoto anterior agora se chama “${result.renamed}”.`));
    const open = this.button('Abrir no GitLab', true, () => { void window.dk.gitOpenGitlab(this.root, 'project').catch(error => { status.className = 'git-error'; status.textContent = errorText(error); }); });
    open.dataset.testid = 'gitlab-publish-open';
    this.element.append(this.actions(this.button('Concluir', false, () => this.flow.close()), open));
    open.focus();
  }
}
