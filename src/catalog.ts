import { iconMark, setIconButton } from './icons';

export interface CatalogPanelCallbacks {
  listCatalog(root: string, refresh?: boolean): Promise<CatalogList>;
  readCatalog(root: string, catalogId: string, entryId: string): Promise<CatalogRead>;
  notify?(error: unknown): void;
  onClose?(): void;
  onSnapshot?(snapshot: CatalogList | null): void;
}

export interface CatalogPanel {
  setProject(root: string | null): Promise<void>;
  reload(): Promise<void>;
  getSnapshot(): CatalogList | null;
  subscribe(listener: (snapshot: CatalogList | null) => void): () => void;
  setStageFilter(stage: string): void;
  openEntry(catalogId: string, entryName: string, stage?: string): Promise<void>;
  focusFirst(): void;
  destroy(): void;
}

const ORIGIN_PRIORITY: Record<Catalog['origin']['type'], number> = {
  kit: 0,
  project: 1,
  plugin: 2,
};

const ORIGIN_FALLBACK: Record<Catalog['origin']['type'], string> = {
  kit: 'Kit',
  project: 'Projeto',
  plugin: 'Plugin',
};

const KIND_LABELS: Record<Catalog['kind'], string> = {
  skills: 'Skills',
  'design-systems': 'Design Systems',
};

const BASE_STAGE_FILTERS: ReadonlyArray<readonly [string, string]> = [
  ['', 'Todas'],
  ['levantar', 'Levantar'],
  ['entender', 'Entender'],
  ['entregar', 'Entregar'],
  ['prototipar', 'Prototipar'],
];

const EXTRA_STAGE_LABELS: Record<string, string> = {
  audit: 'Audit',
  handoff: 'Handoff',
  git: 'Git',
};

const FRONTMATTER_KEYS: ReadonlyArray<keyof Omit<CatalogFrontmatter, 'parser'>> = [
  'name',
  'description',
  'argument-hint',
  'allowed-tools',
  'forma-da-saida',
];

let catalogQueue: Promise<unknown> = Promise.resolve();

/** Serializes IPC calls to electron/catalogs.cjs so concurrent list/read requests never cancel each other. */
export function serializeCatalogTask<T>(task: () => Promise<T>): Promise<T> {
  const next = catalogQueue.then(task, task);
  catalogQueue = next.then(() => undefined, () => undefined);
  return next;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes >= 0 ? Math.trunc(bytes) : 0;
  return `${safe.toLocaleString('pt-BR')} bytes`;
}

function stageLabel(stage: string): string {
  const base = BASE_STAGE_FILTERS.find(([id]) => id === stage);
  if (base) return base[1];
  return EXTRA_STAGE_LABELS[stage] || stage;
}

function formatOrigin(origin: Catalog['origin']): string {
  if (origin.label) return origin.label;
  if (origin.type === 'plugin' && origin.pluginId) return `Plugin ${origin.pluginId}`;
  return ORIGIN_FALLBACK[origin.type] || 'Catálogo';
}

/** Catalog panel renders untrusted markdown and frontmatter strictly as plain text nodes. */
export function createCatalogPanel(host: HTMLElement, callbacks: CatalogPanelCallbacks): CatalogPanel {
  const panel = element('div', 'catalog-panel');
  panel.dataset.testid = 'catalog-panel';

  const header = element('div', 'catalog-header');
  const titleWrap = element('div', 'catalog-heading');
  titleWrap.append(
    element('span', 'catalog-eyebrow', 'CATÁLOGO DO DK'),
    element('h3', 'catalog-title', 'Skills e Design Systems'),
  );
  const headerActions = element('div', 'catalog-header-actions');
  const refreshButton = element('button', 'catalog-icon-button catalog-refresh');
  refreshButton.type = 'button';
  refreshButton.dataset.testid = 'catalog-reload';
  setIconButton(refreshButton, 'refresh', 'Recarregar catálogo');

  const closeButton = element('button', 'catalog-icon-button catalog-close');
  closeButton.type = 'button';
  closeButton.dataset.testid = 'catalog-close';
  setIconButton(closeButton, 'close', 'Fechar catálogo');
  closeButton.hidden = !callbacks.onClose;

  headerActions.append(refreshButton, closeButton);
  header.append(titleWrap, headerActions);

  const filterBar = element('div', 'catalog-filters');
  filterBar.setAttribute('role', 'group');
  filterBar.setAttribute('aria-label', 'Filtrar catálogo por etapa');

  const status = element('p', 'catalog-status');
  status.dataset.testid = 'catalog-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const alerts = element('div', 'catalog-alerts');
  alerts.dataset.testid = 'catalog-errors';

  const body = element('div', 'catalog-layout');
  const listColumn = element('div', 'catalog-list');
  listColumn.dataset.testid = 'catalog-list';

  const readerColumn = element('section', 'catalog-reader');
  readerColumn.dataset.testid = 'catalog-reader';
  readerColumn.setAttribute('aria-label', 'Leitor do catálogo');

  body.append(listColumn, readerColumn);
  panel.append(header, filterBar, status, alerts, body);
  host.replaceChildren(panel);

  let root: string | null = null;
  let snapshot: CatalogList | null = null;
  let activeStage = '';
  let selectedEntryKey: string | null = null;
  let listRequest = 0;
  let readRequest = 0;
  let destroyed = false;
  let filterButtons: HTMLButtonElement[] = [];
  let entryButtons: HTMLButtonElement[] = [];
  const listeners = new Set<(next: CatalogList | null) => void>();

  function emitSnapshot(next: CatalogList | null) {
    callbacks.onSnapshot?.(next);
    for (const listener of listeners) listener(next);
  }

  const isCurrentList = (project: string, serial: number) => !destroyed && root === project && listRequest === serial;
  const isCurrentRead = (project: string, serial: number) => !destroyed && root === project && readRequest === serial;

  function renderEmptyReader(message = 'Selecione um item na lista para ler metadados e conteúdo.') {
    readerColumn.replaceChildren(element('p', 'catalog-reader-empty', message));
  }

  function renderFrontmatter(frontmatter: CatalogFrontmatter): HTMLDListElement {
    const dl = element('dl', 'catalog-frontmatter');
    dl.dataset.testid = 'catalog-frontmatter';
    let count = 0;
    for (const key of FRONTMATTER_KEYS) {
      const raw = frontmatter[key];
      if (raw === undefined) continue;
      const value = Array.isArray(raw) ? raw.join(', ') : String(raw);
      if (!value.trim()) continue;
      const dt = element('dt', 'catalog-frontmatter-key', key);
      const dd = element('dd', 'catalog-frontmatter-value', value);
      dl.append(dt, dd);
      count++;
    }
    if (!count) {
      dl.append(
        element('dt', 'catalog-frontmatter-key', 'frontmatter'),
        element('dd', 'catalog-frontmatter-value', 'Sem campos declarados.'),
      );
    }
    return dl;
  }

  function renderReaderShell(
    catalog: Catalog,
    entry: CatalogEntry,
    bytesValue: number,
    frontmatter: CatalogFrontmatter,
    bodyText: string | null,
    errorText?: string,
  ) {
    readerColumn.replaceChildren();
    const top = element('div', 'catalog-reader-head');
    const titleRow = element('div', 'catalog-reader-title-row');
    titleRow.append(iconMark('file', 'catalog-reader-glyph'), element('h4', 'catalog-reader-title', entry.title || entry.name));
    top.append(titleRow);

    const meta = element('div', 'catalog-reader-meta');
    const originText = formatOrigin(catalog.origin);
    const originItem = element('span', 'catalog-meta-origin', `Origem: ${originText}`);
    originItem.dataset.testid = 'catalog-reader-origin';
    const pathItem = element('code', 'catalog-meta-path', entry.path);
    pathItem.dataset.testid = 'catalog-reader-path';
    const bytesItem = element('span', 'catalog-meta-bytes', formatBytes(bytesValue));
    bytesItem.dataset.testid = 'catalog-reader-bytes';
    meta.append(originItem, pathItem, bytesItem);
    top.append(meta);
    readerColumn.append(top);

    if (errorText) {
      const err = element('p', 'catalog-reader-error', errorText);
      err.setAttribute('role', 'alert');
      readerColumn.append(err);
    }

    readerColumn.append(renderFrontmatter(frontmatter));

    const pre = element('pre', 'catalog-body');
    pre.dataset.testid = 'catalog-body';
    pre.textContent = bodyText !== null ? (bodyText || '(Arquivo sem corpo de texto.)') : '';
    if (bodyText === null && errorText) {
      pre.textContent = '(Conteúdo indisponível.)';
    }
    readerColumn.append(pre);
  }

  async function selectEntry(catalog: Catalog, entry: CatalogEntry, project: string) {
    selectedEntryKey = entry.id;
    syncSelectedEntryButtons();
    const serial = ++readRequest;
    renderReaderShell(catalog, entry, entry.bytes, entry.frontmatter, 'Carregando conteúdo…');
    try {
      const result = await serializeCatalogTask(() => callbacks.readCatalog(project, catalog.id, entry.name));
      if (!isCurrentRead(project, serial)) return;
      const warnings = entry.errors.length ? entry.errors.join(' · ') : undefined;
      renderReaderShell(catalog, entry, result.bytes, result.frontmatter, result.text, warnings);
    } catch (error) {
      if (!isCurrentRead(project, serial)) return;
      renderReaderShell(catalog, entry, entry.bytes, entry.frontmatter, null, errorMessage(error));
    }
  }

  function syncSelectedEntryButtons() {
    for (const btn of entryButtons) {
      const active = btn.dataset.entryKey === selectedEntryKey;
      btn.classList.toggle?.('is-selected', active);
      if (active) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute?.('aria-current');
    }
  }

  function matchesFilter(entry: CatalogEntry): boolean {
    if (!activeStage) return true;
    if (activeStage === '__none__') return entry.stage === '';
    return entry.stage === activeStage;
  }

  function renderFilters(data: CatalogList | null) {
    filterBar.replaceChildren();
    filterButtons = [];
    const presentStages = new Set<string>();
    let hasUnstaged = false;
    if (data) {
      for (const cat of data.catalogs) {
        for (const entry of cat.entries) {
          if (entry.stage) presentStages.add(entry.stage);
          else hasUnstaged = true;
        }
      }
    }
    const filters: Array<[string, string]> = [...BASE_STAGE_FILTERS.map(([id, label]) => [id, label] as [string, string])];
    for (const extra of ['audit', 'handoff', 'git']) {
      if (presentStages.has(extra) || activeStage === extra) {
        filters.push([extra, EXTRA_STAGE_LABELS[extra]]);
      }
    }
    if (hasUnstaged || activeStage === '__none__') {
      filters.push(['__none__', 'Sem etapa']);
    }

    for (const [value, label] of filters) {
      const btn = element('button', 'catalog-filter-button', label);
      btn.type = 'button';
      btn.dataset.stageFilter = value || 'all';
      const pressed = activeStage === value;
      if (pressed) btn.classList?.add('is-active');
      btn.setAttribute('aria-pressed', String(pressed));
      btn.addEventListener('click', () => {
        if (destroyed || activeStage === value) return;
        activeStage = value;
        renderCurrentSnapshot();
      });
      filterButtons.push(btn);
      filterBar.append(btn);
    }
  }

  function renderAlerts(messages: string[]) {
    alerts.replaceChildren();
    if (!messages.length) return;
    const ul = element('ul', 'catalog-alert-list');
    for (const msg of messages) {
      ul.append(element('li', '', msg));
    }
    alerts.append(ul);
  }

  function orderedCatalogs(catalogs: Catalog[]): Catalog[] {
    return [...catalogs].sort((a, b) => {
      const pa = ORIGIN_PRIORITY[a.origin.type] ?? 3;
      const pb = ORIGIN_PRIORITY[b.origin.type] ?? 3;
      if (pa !== pb) return pa - pb;
      return (a.origin.label || a.id).localeCompare(b.origin.label || b.id, 'pt-BR') || a.id.localeCompare(b.id, 'pt-BR');
    });
  }

  function renderCurrentSnapshot() {
    renderFilters(snapshot);
    listColumn.replaceChildren();
    entryButtons = [];
    if (!root) {
      alerts.replaceChildren();
      refreshButton.disabled = true;
      status.textContent = 'Abra um projeto DK para consultar o catálogo.';
      renderEmptyReader();
      return;
    }
    if (!snapshot) {
      refreshButton.disabled = false;
      return;
    }

    renderAlerts(snapshot.errors);
    const project = root;
    const sorted = orderedCatalogs(snapshot.catalogs);
    const groups: HTMLElement[] = [];
    let totalVisibleEntries = 0;
    let selectedFound: { catalog: Catalog; entry: CatalogEntry } | null = null;

    for (const catalog of sorted) {
      const entries = [...catalog.entries]
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
        .filter(matchesFilter);

      if (activeStage && !entries.length) continue;

      const group = element('section', 'catalog-group');
      group.dataset.catalogId = catalog.id;
      group.dataset.originType = catalog.origin.type;

      const groupHead = element('div', 'catalog-group-head');
      const originLabel = formatOrigin(catalog.origin);
      const originBadge = element('strong', 'catalog-origin', originLabel);
      const kindBadge = element('span', 'catalog-kind', KIND_LABELS[catalog.kind] || catalog.kind);
      groupHead.append(originBadge, kindBadge);
      group.append(groupHead);

      if (catalog.truncated) {
        group.append(element('p', 'catalog-group-note', 'Catálogo truncado no limite de 64 itens.'));
      }
      if (catalog.errors.length) {
        const errList = element('ul', 'catalog-group-errors');
        for (const err of catalog.errors) errList.append(element('li', '', err));
        group.append(errList);
      }

      if (!entries.length) {
        group.append(element('p', 'catalog-group-empty', 'Nenhum item disponível nesta origem.'));
      } else {
        const ul = element('ul', 'catalog-entries');
        for (const entry of entries) {
          totalVisibleEntries++;
          if (entry.id === selectedEntryKey) selectedFound = { catalog, entry };

          const li = element('li', 'catalog-entry-item');
          const btn = element('button', 'catalog-entry-button');
          btn.type = 'button';
          btn.dataset.testid = 'catalog-entry';
          btn.dataset.entryKey = entry.id;
          btn.dataset.catalogId = catalog.id;
          btn.dataset.entryName = entry.name;

          const topLine = element('span', 'catalog-entry-top');
          topLine.append(element('strong', 'catalog-entry-title', entry.title || entry.name));
          if (entry.stage) {
            topLine.append(element('span', 'catalog-entry-stage', stageLabel(entry.stage)));
          }
          if (entry.gate) {
            topLine.append(element('span', 'catalog-entry-gate', 'Gate'));
          }
          btn.append(topLine);

          if (entry.description) {
            btn.append(element('span', 'catalog-entry-description', entry.description));
          }
          if (entry.errors.length) {
            btn.append(element('span', 'catalog-entry-error', entry.errors.join(' · ')));
          }

          btn.addEventListener('click', () => {
            if (!destroyed && root === project) void selectEntry(catalog, entry, project);
          });
          entryButtons.push(btn);
          li.append(btn);
          ul.append(li);
        }
        group.append(ul);
      }

      groups.push(group);
    }

    if (!groups.length) {
      status.textContent = activeStage
        ? `Nenhum item encontrado para o filtro "${stageLabel(activeStage)}".`
        : 'Nenhum catálogo disponível para este projeto.';
      listColumn.append(element('p', 'catalog-empty', 'Altere o filtro ou recarregue o catálogo.'));
      renderEmptyReader('Nenhum item corresponde ao filtro atual.');
      return;
    }

    status.textContent = `${totalVisibleEntries} ${totalVisibleEntries === 1 ? 'item listado' : 'itens listados'}.`;
    listColumn.append(...groups);
    syncSelectedEntryButtons();

    if (!selectedFound) {
      selectedEntryKey = null;
      renderEmptyReader();
    }
  }

  async function load(project: string, force: boolean) {
    const serial = ++listRequest;
    refreshButton.disabled = true;
    status.textContent = 'Carregando catálogo…';
    try {
      const next = await serializeCatalogTask(() => callbacks.listCatalog(project, force));
      if (!isCurrentList(project, serial)) return;
      snapshot = next;
      emitSnapshot(next);
      renderCurrentSnapshot();
      if (selectedEntryKey) {
        for (const cat of next.catalogs) {
          const found = cat.entries.find(item => item.id === selectedEntryKey);
          if (found) {
            void selectEntry(cat, found, project);
            break;
          }
        }
      }
    } catch (error) {
      if (!isCurrentList(project, serial)) return;
      snapshot = null;
      emitSnapshot(null);
      listColumn.replaceChildren();
      status.textContent = 'Não foi possível carregar o catálogo.';
      renderAlerts([errorMessage(error)]);
      renderEmptyReader('Erro ao carregar o catálogo.');
    } finally {
      if (isCurrentList(project, serial)) refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', () => {
    if (root && !destroyed) void load(root, true);
  });

  closeButton.addEventListener('click', () => {
    if (!destroyed) callbacks.onClose?.();
  });

  renderCurrentSnapshot();

  return {
    async setProject(path) {
      if (destroyed) return;
      const normalized = typeof path === 'string' && path.length > 0 ? path : null;
      const changed = normalized !== root;
      root = normalized;
      if (changed) {
        activeStage = '';
        selectedEntryKey = null;
        snapshot = null;
        readRequest++;
        emitSnapshot(null);
      }
      if (!root) {
        listRequest++;
        renderCurrentSnapshot();
        return;
      }
      await load(root, false);
    },
    async reload() {
      if (root && !destroyed) await load(root, true);
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setStageFilter(stage) {
      if (destroyed) return;
      activeStage = stage;
      renderCurrentSnapshot();
    },
    async openEntry(catalogId, entryName, stage = '') {
      if (destroyed || !root) return;
      const project = root;
      if (!snapshot) await load(project, false);
      if (destroyed || root !== project || !snapshot) return;
      activeStage = stage;
      renderCurrentSnapshot();
      const cat = snapshot.catalogs.find(item => item.id === catalogId);
      const entry = cat?.entries.find(item => item.name === entryName);
      if (cat && entry) {
        await selectEntry(cat, entry, project);
      }
    },
    focusFirst() {
      const target = filterButtons.find(btn => btn.getAttribute?.('aria-pressed') === 'true')
        || filterButtons[0]
        || refreshButton;
      target.focus?.();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      root = null;
      snapshot = null;
      listRequest++;
      readRequest++;
      panel.remove();
    },
  };
}
