export interface PluginAction {
  id: string;
  title: string;
  description: string;
  commandPreview: string;
  available: boolean;
  icon?: string;
}

export interface PluginContribution {
  id: string;
  title: string;
  active: false;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  origin: 'app' | 'user' | 'project';
  permissions: string[];
  revision: string;
  schema?: 1 | 2;
  errors?: string[];
  contributes: {
    actions: PluginAction[];
    views: PluginContribution[];
    panels: PluginContribution[];
    stages: PluginContribution[];
    catalogs: PluginContribution[];
  };
}

export interface PluginSnapshot {
  plugins: PluginInfo[];
  errors: string[];
}

export interface PluginsPanelCallbacks {
  list(root: string): Promise<PluginSnapshot>;
  reload(root: string): Promise<PluginSnapshot>;
  execute(root: string, pluginId: string, actionId: string, revision: string): Promise<unknown>;
}

export interface PluginsPanel {
  setProject(root: string | null, name?: string): Promise<void>;
  reload(): Promise<void>;
  destroy(): void;
}

const ORIGINS: Record<PluginInfo['origin'], string> = {
  app: 'Aplicativo',
  user: 'Perfil',
  project: 'Projeto',
};

const PERMISSIONS: Record<string, string> = {
  'fs:project': 'Arquivos do projeto · permissão declarada',
  'process:spawn': 'Executar programas quando solicitado',
  'preview:bridge': 'Interagir com a prévia · indisponível nesta versão',
  'agent:run': 'Iniciar agentes · indisponível nesta versão',
};

const CONTRIBUTIONS: Array<[keyof Omit<PluginInfo['contributes'], 'actions'>, string]> = [
  ['views', 'Visualização'],
  ['panels', 'Painel'],
  ['stages', 'Etapa'],
  ['catalogs', 'Catálogo'],
];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Panel data is presentation only: the host remains responsible for authorization and execution. */
export function createPluginsPanel(host: HTMLElement, callbacks: PluginsPanelCallbacks): PluginsPanel {
  const panel = element('div', 'plugins-panel');
  panel.dataset.testid = 'plugins-panel';
  const heading = element('div', 'plugins-heading');
  const headingCopy = element('div', 'plugins-heading-copy');
  headingCopy.append(element('span', 'plugins-eyebrow', 'EXTENSÕES DO PROJETO'), element('h2', 'plugins-title', 'Plugins'));
  const refreshButton = element('button', 'plugins-refresh', '↻');
  refreshButton.type = 'button';
  refreshButton.dataset.testid = 'plugins-reload';
  refreshButton.title = 'Recarregar plugins';
  refreshButton.setAttribute('aria-label', 'Recarregar plugins');
  heading.append(headingCopy, refreshButton);
  const status = element('p', 'plugins-status');
  status.dataset.testid = 'plugins-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const errors = element('div', 'plugins-errors');
  errors.dataset.testid = 'plugins-errors';
  errors.setAttribute('role', 'alert');
  const list = element('div', 'plugins-list');
  const project = element('p', 'plugins-project');
  project.dataset.testid = 'plugins-project';
  project.hidden = true;
  panel.append(heading, project, status, errors, list);
  host.replaceChildren(panel);

  let root: string | null = null;
  let request = 0;
  let destroyed = false;

  const isCurrent = (project: string, serial: number) => !destroyed && root === project && request === serial;

  function empty() {
    list.replaceChildren();
    errors.replaceChildren();
    refreshButton.disabled = true;
    status.textContent = 'Abra um projeto para ver seus plugins.';
  }

  function displayErrors(messages: string[]) {
    errors.replaceChildren();
    if (!messages.length) return;
    errors.append(element('strong', 'plugins-errors-title', 'Alguns plugins não foram carregados'));
    const items = element('ul', 'plugins-errors-list');
    for (const message of messages) items.append(element('li', '', message));
    errors.append(items);
  }

  function displayAction(plugin: PluginInfo, action: PluginAction, project: string, serial: number): HTMLElement {
    const row = element('li', 'plugins-action');
    const name = element('strong', 'plugins-action-name', action.title);
    row.append(name);
    if (action.description) row.append(element('p', 'plugins-action-description', action.description));
    if (action.commandPreview) {
      const command = element('div', 'plugins-command');
      command.append(element('span', 'plugins-command-label', 'Comando · prévia'), element('code', 'plugins-command-value', action.commandPreview));
      row.append(command);
    }
    // Capture exactly the identity and revision displayed when this card was built.
    const pluginId = plugin.id;
    const actionId = action.id;
    const revision = plugin.revision;
    const available = action.available;
    const button = element('button', 'plugins-action-button', 'Executar');
    button.type = 'button';
    button.dataset.testid = 'plugin-action';
    button.dataset.pluginId = pluginId;
    button.dataset.actionId = actionId;
    button.setAttribute('aria-label', `Executar ${action.title} de ${plugin.name}`);
    const revisionIsValid = typeof revision === 'string' && revision.length > 0;
    button.disabled = !available || !revisionIsValid;
    if (!available) {
      row.append(element('p', 'plugins-action-unavailable', 'Ação indisponível neste computador.'));
    } else if (!revisionIsValid) {
      row.append(element('p', 'plugins-action-unavailable', 'Recarregue os plugins antes de executar.'));
    }
    const feedback = element('p', 'plugins-action-feedback');
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    button.addEventListener('click', async () => {
      if (!isCurrent(project, serial) || button.disabled || !available || !revisionIsValid) return;
      button.disabled = true;
      feedback.classList.remove('is-error');
      feedback.textContent = 'Aguardando confirmação…';
      try {
        await callbacks.execute(project, pluginId, actionId, revision);
        if (isCurrent(project, serial)) feedback.textContent = '';
      } catch (error) {
        if (isCurrent(project, serial)) {
          feedback.classList.add('is-error');
          feedback.textContent = `Não foi possível executar: ${errorMessage(error)}`;
        }
      } finally {
        if (isCurrent(project, serial)) button.disabled = false;
      }
    });
    row.append(button, feedback);
    return row;
  }

  function displayPlugin(plugin: PluginInfo, project: string, serial: number): HTMLElement {
    const card = element('article', 'plugins-card');
    card.dataset.testid = 'plugin-card';
    card.dataset.pluginId = plugin.id;
    const top = element('div', 'plugins-card-heading');
    const name = element('h3', 'plugins-card-title', plugin.name);
    const origin = element('span', 'plugins-origin', ORIGINS[plugin.origin] || String(plugin.origin));
    top.append(name, origin);
    card.append(top);
    if (plugin.version) card.append(element('p', 'plugins-version', `Versão ${plugin.version}`));
    if (plugin.description) card.append(element('p', 'plugins-description', plugin.description));
    if (plugin.errors?.length) {
      const pluginErrors = element('div', 'plugins-card-errors');
      pluginErrors.dataset.testid = 'plugin-errors';
      pluginErrors.append(element('h4', 'plugins-section-title', 'Atenção'));
      const items = element('ul', 'plugins-errors-list');
      for (const message of plugin.errors) items.append(element('li', '', message));
      pluginErrors.append(items);
      card.append(pluginErrors);
    }

    if (plugin.permissions.length) {
      const permissions = element('div', 'plugins-permissions');
      permissions.append(element('h4', 'plugins-section-title', 'Permissões declaradas'));
      const items = element('ul', 'plugins-permission-list');
      for (const permission of plugin.permissions) {
        items.append(element('li', '', PERMISSIONS[permission] || `Permissão desconhecida: ${permission}`));
      }
      permissions.append(items);
      if (plugin.permissions.includes('process:spawn')) {
        permissions.append(element('p', 'plugins-permission-note', 'Os programas executados usam as permissões da sua conta.'));
      }
      card.append(permissions);
    }

    if (plugin.contributes.actions.length) {
      const actions = element('section', 'plugins-actions');
      actions.append(element('h4', 'plugins-section-title', 'Ações'));
      const items = element('ul', 'plugins-action-list');
      for (const action of plugin.contributes.actions) items.append(displayAction(plugin, action, project, serial));
      actions.append(items);
      card.append(actions);
    }

    const inactive = CONTRIBUTIONS.flatMap(([key, label]) => plugin.contributes[key].map(item => ({ label, item })));
    if (inactive.length) {
      const details = element('details', 'plugins-inactive');
      const summary = element('summary', 'plugins-inactive-summary', `Recursos declarados · ${inactive.length}`);
      const note = element('p', 'plugins-inactive-note', 'Ainda não disponíveis nesta versão.');
      const items = element('ul', 'plugins-inactive-list');
      for (const { label, item } of inactive) items.append(element('li', '', `${label}: ${item.title} · Inativo`));
      details.append(summary, note, items);
      card.append(details);
    }
    return card;
  }

  function displaySnapshot(snapshot: PluginSnapshot, project: string, serial: number) {
    displayErrors(snapshot.errors);
    list.replaceChildren();
    if (!snapshot.plugins.length) {
      status.textContent = 'Nenhum plugin encontrado.';
      list.append(element('p', 'plugins-empty', 'Os plugins deste projeto aparecerão aqui.'));
      return;
    }
    status.textContent = `${snapshot.plugins.length} ${snapshot.plugins.length === 1 ? 'plugin encontrado' : 'plugins encontrados'}.`;
    const cards = document.createDocumentFragment();
    // This changes presentation only; the host has already resolved duplicate IDs.
    const priority: Record<PluginInfo['origin'], number> = { project: 0, user: 1, app: 2 };
    const ordered = snapshot.plugins.map((plugin, index) => ({ plugin, index })).sort((a, b) =>
      (priority[a.plugin.origin] ?? 3) - (priority[b.plugin.origin] ?? 3) || a.index - b.index);
    for (const { plugin } of ordered) cards.append(displayPlugin(plugin, project, serial));
    list.append(cards);
  }

  async function load(project: string, force: boolean) {
    const serial = ++request;
    list.replaceChildren();
    errors.replaceChildren();
    status.textContent = 'Carregando plugins…';
    refreshButton.disabled = true;
    try {
      const snapshot = await (force ? callbacks.reload(project) : callbacks.list(project));
      if (isCurrent(project, serial)) displaySnapshot(snapshot, project, serial);
    } catch (error) {
      if (isCurrent(project, serial)) {
        status.textContent = 'Não foi possível carregar os plugins.';
        displayErrors([errorMessage(error)]);
      }
    } finally {
      if (isCurrent(project, serial)) refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', () => {
    if (root && !destroyed) void load(root, true);
  });
  empty();

  return {
    async setProject(path, name) {
      if (destroyed) return;
      root = typeof path === 'string' && path.length > 0 ? path : null;
      project.textContent = root ? `Projeto selecionado: ${name || root}` : '';
      project.hidden = !root;
      if (!root) {
        request++;
        empty();
        return;
      }
      await load(root, false);
    },
    async reload() {
      if (root && !destroyed) await load(root, true);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      root = null;
      request++;
      panel.remove();
    },
  };
}
