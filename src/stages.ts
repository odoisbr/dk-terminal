import { createCatalogPanel, serializeCatalogTask, type CatalogPanel } from './catalog';
import { iconMark, setIconButton } from './icons';

export type StageClaudePreset = {
  skillHint?: string;
  stage?: StageId;
  prompt?: string;
};

export interface StageBarCallbacks {
  readStages(root: string, refresh?: boolean): Promise<StagesSnapshot>;
  listCatalog?(root: string, refresh?: boolean): Promise<CatalogList>;
  readCatalog?(root: string, catalogId: string, entryId: string): Promise<CatalogRead>;
  capabilitiesAgent?(root: string): Promise<AgentCapabilities>;
  stopWatching?(): Promise<void>;
  runAction(root: string, action: string): Promise<unknown>;
  openClaude?(root: string, preset?: StageClaudePreset): Promise<unknown> | void;
  copyText?(text: string): Promise<void> | void;
  notify?(error: unknown): void;
}

export interface StageBar {
  readonly catalogHost: HTMLElement;
  attachCatalog(panel: CatalogPanel): CatalogPanel;
  closeCatalog(restoreFocus?: boolean): void;
  setProject(root: string | null, isDk?: boolean): Promise<void>;
  setKit(hasKit: boolean): void;
  reload(): Promise<void>;
  reloadCatalog(): Promise<void>;
  destroy(): void;
}

type VisualStageState = 'concluido' | 'pendente' | 'indisponivel' | 'bloqueada';

const STAGE_ORDER: ReadonlyArray<readonly [StageId, string, number]> = [
  ['levantar', 'Levantar', 1],
  ['entender', 'Entender', 2],
  ['entregar', 'Entregar', 3],
  ['prototipar', 'Prototipar', 4],
];

const STAGE_STATE_LABELS: Record<VisualStageState, string> = {
  concluido: 'Concluída',
  pendente: 'Pendente',
  indisponivel: 'Indisponível',
  bloqueada: 'Bloqueada',
};

const CRITERION_STATE_LABELS: Record<StageState, string> = {
  concluido: 'Concluído',
  pendente: 'Pendente',
  indisponivel: 'Indisponível',
};

const STATE_CLASSES: ReadonlyArray<string> = [
  'is-concluido',
  'is-pendente',
  'is-indisponivel',
  'is-bloqueada',
];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultCopyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {}
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('Não foi possível copiar o comando para a área de transferência.');
}

function formatSkillCommand(skill: string, stageId: StageId): string {
  const trimmed = typeof skill === 'string' ? skill.trim().replace(/^\/+/, '') : '';
  if (!trimmed) return `/dk:dk-${stageId}`;
  return trimmed.startsWith('dk:') ? `/${trimmed}` : `/dk:${trimmed}`;
}

function formatDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (detail !== null && typeof detail === 'object') {
    const record = detail as Record<string, unknown>;
    const parts = [record.id || record.item, record.tema || record.pergunta, record.status, record.evidencia]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
    if (parts.length) return parts.join(' · ');
    return JSON.stringify(detail);
  }
  return String(detail);
}

function formatDeclared(declarado: StagesSnapshot['declarado']): string {
  const parts: string[] = [];
  if (declarado?.fase_atual !== undefined && declarado.fase_atual !== null && declarado.fase_atual !== '') {
    parts.push(`fase_atual: ${typeof declarado.fase_atual === 'object' ? JSON.stringify(declarado.fase_atual) : String(declarado.fase_atual)}`);
  }
  if (declarado?.fases_concluidas !== undefined && declarado.fases_concluidas !== null) {
    const list = Array.isArray(declarado.fases_concluidas)
      ? declarado.fases_concluidas.map(String).join(', ')
      : typeof declarado.fases_concluidas === 'object'
        ? JSON.stringify(declarado.fases_concluidas)
        : String(declarado.fases_concluidas);
    if (list) parts.push(`fases_concluidas: ${list}`);
  }
  return parts.join(' · ');
}

function visualStateOf(stage: StageSnapshot): VisualStageState {
  if (!stage.liberada) return 'bloqueada';
  return stage.estado;
}

function fallbackSnapshot(root: string, reason: string): StagesSnapshot {
  const stages: StageSnapshot[] = STAGE_ORDER.map(([id, nome, ordem]) => ({
    id,
    nome,
    skill: `dk:dk-${id}`,
    ordem,
    estado: 'indisponivel',
    liberada: ordem === 1,
    bloqueio: ordem === 1 ? null : `Conclua a etapa ${STAGE_ORDER[ordem - 2][1]} para liberar ${nome}.`,
    criterios: [],
  }));
  return {
    root,
    isDk: true,
    formato: 'ausente',
    esquema: 'ausente',
    kit: null,
    declarado: {},
    computedAt: new Date().toISOString(),
    stages,
    errors: [reason],
    watching: false,
  };
}

/** Stage bar and detail inspector: renders stage snapshots and fixes strictly via DOM text nodes. */
export function createStageBar(host: HTMLElement, callbacks: StageBarCallbacks): StageBar {
  if (!host.getAttribute?.('role')) host.setAttribute('role', 'group');
  if (!host.getAttribute?.('aria-label')) host.setAttribute('aria-label', 'Etapas do DK');

  const barRow = element('div', 'stage-bar-row');
  const barLabel = element('span', 'stage-bar-label', 'ETAPAS');
  const buttonsWrap = element('div', 'stage-buttons');
  const toolsWrap = element('div', 'stage-bar-tools');

  const refreshButton = element('button', 'stage-icon-button stage-refresh');
  refreshButton.type = 'button';
  refreshButton.dataset.testid = 'stages-reload';
  setIconButton(refreshButton, 'refresh', 'Recarregar etapas');

  const catalogButton = element('button', 'stage-catalog-toggle', 'Catálogo');
  catalogButton.type = 'button';
  catalogButton.dataset.testid = 'stage-catalog-toggle';
  catalogButton.setAttribute('aria-pressed', 'false');

  toolsWrap.append(refreshButton, catalogButton);

  const kitWarning = element('p', 'stage-kit-warning');
  kitWarning.dataset.testid = 'stage-kit-warning';
  kitWarning.setAttribute('role', 'status');
  kitWarning.hidden = true;

  const detailsPanel = element('section', 'stage-details');
  detailsPanel.id = host.id ? `${host.id}-details` : 'stage-bar-details';
  detailsPanel.dataset.testid = 'stage-details';
  detailsPanel.setAttribute('role', 'region');
  detailsPanel.setAttribute('aria-live', 'polite');
  detailsPanel.setAttribute('aria-label', 'Detalhes da etapa');
  detailsPanel.hidden = true;

  const catalogDrawer = element('section', 'stage-catalog-drawer');
  catalogDrawer.id = host.id ? `${host.id}-catalog` : 'stage-bar-catalog';
  catalogDrawer.setAttribute('role', 'region');
  catalogDrawer.setAttribute('aria-label', 'Catálogo do DK');
  catalogDrawer.hidden = true;
  catalogButton.setAttribute('aria-controls', catalogDrawer.id);

  const stageButtons: HTMLButtonElement[] = [];
  const stageNumberNodes = new Map<StageId, HTMLSpanElement>();
  const stageNameNodes = new Map<StageId, HTMLSpanElement>();
  const stageStateNodes = new Map<StageId, HTMLSpanElement>();
  const stageButtonById = new Map<StageId, HTMLButtonElement>();

  let root: string | null = null;
  let projectIsDk = false;
  let watchingActive = false;
  let kitOverride: boolean | null = null;
  let currentSnapshot: StagesSnapshot | null = null;
  let catalogSnapshot: CatalogList | null = null;
  let attachedCatalog: CatalogPanel | null = null;
  let unsubscribeCatalog: (() => void) | null = null;
  let ownedCatalog: CatalogPanel | null = null;
  let openStageId: StageId | null = null;
  let catalogOpen = false;
  let rovingIndex = 0;
  let actionRunning = false;
  let request = 0;
  let catalogRequest = 0;
  let capabilityRequest = 0;
  let claudeAvailable = false;
  let destroyed = false;
  let detailsTrigger: HTMLElement | null = null;
  let catalogTrigger: HTMLElement | null = null;

  const isCurrent = (project: string, serial: number) => !destroyed && root === project && request === serial;

  function effectiveKit(): boolean {
    if (kitOverride !== null) return kitOverride;
    return Boolean(currentSnapshot?.kit);
  }

  function syncRovingTabindex(nextIndex: number) {
    rovingIndex = Math.max(0, Math.min(stageButtons.length - 1, nextIndex));
    stageButtons.forEach((btn, idx) => {
      btn.tabIndex = idx === rovingIndex ? 0 : -1;
    });
  }

  function syncPressedStates() {
    for (const [id, btn] of stageButtonById) {
      btn.setAttribute('aria-pressed', String(openStageId === id));
    }
    catalogButton.setAttribute('aria-pressed', String(catalogOpen));
  }

  STAGE_ORDER.forEach(([id, defaultName, defaultOrder], index) => {
    const btn = element('button', 'stage is-pendente');
    btn.type = 'button';
    btn.dataset.stage = id;
    btn.dataset.testid = 'stage-button';
    btn.tabIndex = index === 0 ? 0 : -1;
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-controls', detailsPanel.id);

    const num = element('span', 'stage-number', String(defaultOrder));
    const name = element('span', 'stage-name', defaultName);
    const stateWrap = element('span', 'stage-state');
    const dot = element('span', 'stage-dot');
    dot.setAttribute('aria-hidden', 'true');
    const stateText = element('span', 'stage-state-text', STAGE_STATE_LABELS.pendente);
    stateWrap.append(dot, stateText);
    btn.append(num, name, stateWrap);

    btn.addEventListener('focus', () => {
      syncRovingTabindex(index);
    });

    function toggleStageDetails() {
      if (destroyed || !currentSnapshot) return;
      syncRovingTabindex(index);
      if (openStageId === id) {
        closeDetails(false);
        return;
      }
      if (catalogOpen) {
        catalogOpen = false;
        catalogDrawer.hidden = true;
      }
      detailsTrigger = btn;
      openStageId = id;
      syncPressedStates();
      renderDetails();
      void ensureStageCatalog(false);
      void ensureClaudeCapability();
    }

    btn.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleStageDetails();
        return;
      }
      let target = index;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = (index + 1) % stageButtons.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = (index + stageButtons.length - 1) % stageButtons.length;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = stageButtons.length - 1;
      else return;
      event.preventDefault();
      syncRovingTabindex(target);
      stageButtons[target].focus();
    });

    btn.addEventListener('click', toggleStageDetails);

    stageButtons.push(btn);
    stageNumberNodes.set(id, num);
    stageNameNodes.set(id, name);
    stageStateNodes.set(id, stateText);
    stageButtonById.set(id, btn);
    buttonsWrap.append(btn);
  });

  barRow.append(barLabel, buttonsWrap, toolsWrap);
  host.replaceChildren(barRow, kitWarning, detailsPanel, catalogDrawer);

  function closeDetails(restoreFocus: boolean) {
    if (openStageId === null && detailsPanel.hidden) return;
    openStageId = null;
    detailsPanel.hidden = true;
    detailsPanel.replaceChildren();
    syncPressedStates();
    if (restoreFocus) {
      const target = detailsTrigger && (host.contains?.(detailsTrigger) ?? true) ? detailsTrigger : stageButtons[rovingIndex];
      target?.focus?.();
    }
    detailsTrigger = null;
  }

  function closeCatalog(restoreFocus = false) {
    if (!catalogOpen && catalogDrawer.hidden) return;
    catalogOpen = false;
    catalogDrawer.hidden = true;
    syncPressedStates();
    if (restoreFocus) {
      const target = catalogTrigger && (host.contains?.(catalogTrigger) ?? true) ? catalogTrigger : catalogButton;
      target?.focus?.();
    }
    catalogTrigger = null;
  }

  function ensureCatalogInstance(): CatalogPanel | null {
    if (attachedCatalog) return attachedCatalog;
    if (ownedCatalog) return ownedCatalog;
    if (!callbacks.listCatalog || !callbacks.readCatalog) return null;
    ownedCatalog = createCatalogPanel(catalogDrawer, {
      listCatalog: callbacks.listCatalog,
      readCatalog: callbacks.readCatalog,
      notify: callbacks.notify,
      onClose: () => closeCatalog(true),
      onSnapshot: snap => {
        catalogSnapshot = snap;
        if (openStageId) renderDetails();
      },
    });
    if (root && projectIsDk) void ownedCatalog.setProject(root);
    return ownedCatalog;
  }

  async function ensureStageCatalog(force: boolean) {
    if (!root || !projectIsDk) return;
    const panel = attachedCatalog || ownedCatalog;
    if (panel) {
      if (force) await panel.reload();
      catalogSnapshot = panel.getSnapshot();
      if (openStageId) renderDetails();
      return;
    }
    if (!callbacks.listCatalog) return;
    if (!force && catalogSnapshot && catalogSnapshot.root === root) return;
    const project = root;
    const serial = ++catalogRequest;
    try {
      const next = await serializeCatalogTask(() => callbacks.listCatalog!(project, force));
      if (!destroyed && root === project && catalogRequest === serial) {
        catalogSnapshot = next;
        if (openStageId) renderDetails();
      }
    } catch {
      if (!destroyed && root === project && catalogRequest === serial) {
        catalogSnapshot = null;
      }
    }
  }

    async function ensureClaudeCapability() {
      if (!root || !projectIsDk || !callbacks.capabilitiesAgent) return;
      const project = root;
      const serial = ++capabilityRequest;
      try {
        const cap = await callbacks.capabilitiesAgent(project);
        const next = Boolean(cap?.claude?.disponivel);
        if (!destroyed && root === project && capabilityRequest === serial && claudeAvailable !== next) {
          claudeAvailable = next;
          if (openStageId) renderDetails();
        }
      } catch {
        if (!destroyed && root === project && capabilityRequest === serial && claudeAvailable) {
          claudeAvailable = false;
          if (openStageId) renderDetails();
        }
      }
    }

  function renderKitBanner() {
    if (!currentSnapshot || !currentSnapshot.isDk) {
      kitWarning.hidden = true;
      kitWarning.textContent = '';
      return;
    }
    if (!effectiveKit()) {
      kitWarning.textContent = 'Plugin DK ausente ou inativo · critérios dependentes do kit ficam indisponíveis e as correções ficam desabilitadas.';
      kitWarning.hidden = false;
    } else if (!currentSnapshot.kit) {
      kitWarning.textContent = 'Checklist do kit indisponível · verifique a instalação do plugin DK.';
      kitWarning.hidden = false;
    } else {
      kitWarning.hidden = true;
      kitWarning.textContent = '';
    }
  }

  function renderStageButtons() {
    if (!currentSnapshot) return;
    for (const [id, fallbackName, fallbackOrder] of STAGE_ORDER) {
      const stage = currentSnapshot.stages.find(item => item.id === id);
      const btn = stageButtonById.get(id)!;
      const numNode = stageNumberNodes.get(id)!;
      const nameNode = stageNameNodes.get(id)!;
      const stateNode = stageStateNodes.get(id)!;

      btn.classList.remove(...STATE_CLASSES);
      if (!stage) {
        btn.classList.add('is-indisponivel');
        numNode.textContent = String(fallbackOrder);
        nameNode.textContent = fallbackName;
        stateNode.textContent = STAGE_STATE_LABELS.indisponivel;
        continue;
      }
      const visual = visualStateOf(stage);
      btn.classList.add(`is-${visual}`);
      numNode.textContent = String(stage.ordem);
      nameNode.textContent = stage.nome;
      stateNode.textContent = STAGE_STATE_LABELS[visual];
      btn.title = stage.bloqueio
        ? `${stage.ordem}. ${stage.nome} · ${STAGE_STATE_LABELS[visual]} — ${stage.bloqueio}`
        : `${stage.ordem}. ${stage.nome} · ${STAGE_STATE_LABELS[visual]}`;
    }
    syncPressedStates();
  }

  function renderCriterion(stage: StageSnapshot, criterion: StageCriterion, project: string, serial: number): HTMLLIElement {
    const li = element('li', `stage-criterion is-${criterion.estado}`);
    li.dataset.testid = 'stage-criterion';
    li.dataset.criterionId = criterion.id;

    const top = element('div', 'criterion-header');
    const badge = element('span', `criterion-badge is-${criterion.estado}`);
    const dot = element('span', 'stage-dot');
    dot.setAttribute('aria-hidden', 'true');
    badge.append(dot, element('span', 'criterion-state', CRITERION_STATE_LABELS[criterion.estado]));

    const title = element('strong', 'criterion-title', `${criterion.id} · ${criterion.descricao}`);
    top.append(badge, title);
    li.append(top);

    if (criterion.motivo) {
      li.append(element('p', 'criterion-reason', criterion.motivo));
    }

    const provenanceParts = [criterion.fonte?.arquivo, criterion.fonte?.regra].filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0,
    );
    const provenanceRow = element('p', 'criterion-provenance');
    provenanceRow.append(
      element('span', 'criterion-provenance-label', 'Procedência: '),
      element('code', 'criterion-provenance-value', provenanceParts.join(' · ') || 'Não informada'),
    );
    li.append(provenanceRow);

    if (Array.isArray(criterion.detalhes) && criterion.detalhes.length > 0) {
      const detailsList = element('ul', 'criterion-details');
      for (const item of criterion.detalhes) {
        detailsList.append(element('li', '', formatDetail(item)));
      }
      li.append(detailsList);
    }

    const actionsRow = element('div', 'criterion-actions');
    const fixButton = element('button', 'stage-fix-button');
    fixButton.type = 'button';
    fixButton.dataset.testid = 'stage-fix';
    fixButton.dataset.criterionId = criterion.id;
    fixButton.dataset.fixKind = criterion.fix.kind;

    const fixFeedback = element('span', 'criterion-fix-feedback');
    fixFeedback.setAttribute('role', 'status');
    fixFeedback.setAttribute('aria-live', 'polite');

    if (criterion.fix.kind === 'action') {
      const actionName = criterion.fix.action;
      fixButton.textContent = `Executar dk ${actionName}`;
      fixButton.setAttribute('aria-label', `Corrigir ${criterion.id}: executar ação ${actionName}`);
    } else {
      const command = formatSkillCommand(criterion.fix.skill, stage.id);
      fixButton.append(iconMark('copy', 'stage-fix-icon'), element('span', '', `Copiar ${command}`));
      fixButton.setAttribute('aria-label', `Corrigir ${criterion.id}: copiar comando ${command}`);
    }

    const hasKit = effectiveKit();
    const canFix = stage.liberada && hasKit && !actionRunning;
    fixButton.disabled = !canFix;
    if (!stage.liberada) {
      fixButton.title = stage.bloqueio || 'Conclua a etapa anterior para liberar a correção.';
    } else if (!hasKit) {
      fixButton.title = 'Instale ou ative o plugin DK para habilitar a correção.';
    }

    fixButton.addEventListener('click', async () => {
      if (!isCurrent(project, serial) || fixButton.disabled || !stage.liberada || !effectiveKit() || actionRunning) return;
      if (criterion.fix.kind === 'skill') {
        const command = formatSkillCommand(criterion.fix.skill, stage.id);
        fixButton.disabled = true;
        try {
          await (callbacks.copyText ? callbacks.copyText(command) : defaultCopyText(command));
          if (!isCurrent(project, serial)) return;
          const message = `Comando ${command} copiado para a área de transferência. Cole na sessão do agente.`;
          fixFeedback.textContent = `Copiado: ${command}`;
          callbacks.notify?.(message);
        } catch (error) {
          if (isCurrent(project, serial)) {
            fixFeedback.textContent = `Falha ao copiar: ${errorMessage(error)}`;
            callbacks.notify?.(error);
          }
        } finally {
          if (isCurrent(project, serial)) {
            fixButton.disabled = !stage.liberada || !effectiveKit() || actionRunning;
          }
        }
        return;
      }

      const actionName = criterion.fix.action;
      actionRunning = true;
      renderDetails();
      try {
        await callbacks.runAction(project, actionName);
        if (!destroyed && root === project) {
          await load(project, true);
        }
      } catch (error) {
        if (!destroyed && root === project) {
          callbacks.notify?.(error);
        }
      } finally {
        actionRunning = false;
        if (!destroyed && root === project && openStageId) {
          renderDetails();
        }
      }
    });

    let claudeButton: HTMLButtonElement | null = null;
    if (criterion.fix.kind === 'skill' && claudeAvailable && callbacks.openClaude) {
      const skillRaw = criterion.fix.skill;
      claudeButton = element('button', 'stage-fix-button');
      claudeButton.type = 'button';
      claudeButton.dataset.testid = 'stage-fix-claude';
      claudeButton.dataset.criterionId = criterion.id;
      claudeButton.append(iconMark('sparkle', 'stage-fix-icon'), element('span', '', 'Executar com Claude'));
      claudeButton.disabled = !canFix;
      if (!stage.liberada) {
        claudeButton.title = stage.bloqueio || 'Conclua a etapa anterior para liberar a correção.';
      } else if (!hasKit) {
        claudeButton.title = 'Instale ou ative o plugin DK para habilitar a correção.';
      }
      claudeButton.addEventListener('click', async () => {
        if (!isCurrent(project, serial) || claudeButton!.disabled || !stage.liberada || !effectiveKit() || actionRunning) return;
        const prompt = `Corrija o critério ${criterion.id} (${criterion.descricao}) da etapa ${stage.nome}.${criterion.motivo ? ` Motivo atual: ${criterion.motivo}` : ''}`;
        closeDetails(false);
        try {
          await callbacks.openClaude?.(project, { skillHint: skillRaw, stage: stage.id, prompt });
        } catch (error) {
          if (!destroyed && root === project) callbacks.notify?.(error);
        }
      });
    }

    if (claudeButton) actionsRow.append(fixButton, claudeButton, fixFeedback);
    else actionsRow.append(fixButton, fixFeedback);
    li.append(actionsRow);
    return li;
  }

  function renderStageSkills(stage: StageSnapshot): HTMLElement | null {
    const data = (attachedCatalog || ownedCatalog)?.getSnapshot() ?? catalogSnapshot;
    if (!data && !callbacks.listCatalog && !attachedCatalog) return null;

    const section = element('div', 'stage-skills');
    section.append(element('h4', 'stage-section-title', 'Skills desta etapa no catálogo'));

    if (!data) {
      section.append(element('p', 'stage-skills-note', 'Carregando skills do catálogo…'));
      return section;
    }

    const matches: Array<{ catalog: Catalog; entry: CatalogEntry }> = [];
    for (const cat of data.catalogs) {
      if (cat.kind !== 'skills') continue;
      for (const entry of cat.entries) {
        if (entry.stage === stage.id || entry.name === `dk-${stage.id}`) {
          matches.push({ catalog: cat, entry });
        }
      }
    }

    if (!matches.length) {
      section.append(element('p', 'stage-skills-note', 'Nenhuma skill desta etapa disponível no catálogo atual.'));
      return section;
    }

    const list = element('ul', 'stage-skills-list');
    for (const { catalog, entry } of matches) {
      const item = element('li', 'stage-skill-item');
      const copy = element('div', 'stage-skill-copy');
      const top = element('div', 'stage-skill-top');
      top.append(
        element('strong', 'stage-skill-name', entry.title || entry.name),
        element('span', 'stage-skill-origin', catalog.origin.label || 'Catálogo'),
      );
      copy.append(top);
      if (entry.description) {
        copy.append(element('p', 'stage-skill-desc', entry.description));
      }
      const openBtn = element('button', 'stage-skill-open', 'Ler no catálogo');
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => {
        const panel = ensureCatalogInstance();
        if (!panel) return;
        catalogTrigger = stageButtonById.get(stage.id) || catalogButton;
        openStageId = null;
        detailsPanel.hidden = true;
        detailsPanel.replaceChildren();
        catalogOpen = true;
        catalogDrawer.hidden = false;
        syncPressedStates();
        void panel.openEntry(catalog.id, entry.name, stage.id);
      });
      item.append(copy, openBtn);
      list.append(item);
    }
    section.append(list);
    return section;
  }

  function renderDetails() {
    if (!openStageId || !currentSnapshot || !root) {
      detailsPanel.hidden = true;
      detailsPanel.replaceChildren();
      return;
    }
    const stage = currentSnapshot.stages.find(item => item.id === openStageId);
    if (!stage) {
      detailsPanel.hidden = true;
      detailsPanel.replaceChildren();
      return;
    }

    const project = root;
    const serial = request;
    const visual = visualStateOf(stage);
    detailsPanel.replaceChildren();
    detailsPanel.hidden = false;

    const head = element('div', 'stage-details-head');
    const titleGroup = element('div', 'stage-details-heading');
    const stateBadge = element('span', `stage-details-badge is-${visual}`);
    const dot = element('span', 'stage-dot');
    dot.setAttribute('aria-hidden', 'true');
    stateBadge.append(dot, element('span', '', STAGE_STATE_LABELS[visual]));

    titleGroup.append(
      element('h3', 'stage-details-title', `${stage.ordem}. ${stage.nome}`),
      stateBadge,
      element('code', 'stage-details-skill', `/${stage.skill}`),
    );

    const closeBtn = element('button', 'stage-icon-button stage-details-close');
    closeBtn.type = 'button';
    closeBtn.dataset.testid = 'stage-details-close';
    setIconButton(closeBtn, 'close', 'Fechar detalhes da etapa');
    closeBtn.addEventListener('click', () => closeDetails(true));

    head.append(titleGroup, closeBtn);
    detailsPanel.append(head);

    if (!stage.liberada && stage.bloqueio) {
      const blockedNote = element('p', 'stage-details-note is-bloqueada', `${stage.bloqueio} Os critérios abaixo já foram calculados; a correção é liberada quando a etapa anterior estiver concluída.`);
      detailsPanel.append(blockedNote);
    }

    if (!effectiveKit()) {
      detailsPanel.append(element('p', 'stage-details-note is-indisponivel', 'Sem kit DK ativo: instale ou ative o plugin DK para calcular critérios do kit e habilitar as correções.'));
    }

    if (stage.id === 'prototipar') {
      detailsPanel.append(element('p', 'stage-details-meta', 'Critérios estruturais; verificação completa por dk prototipar --verificar.'));
    }

    const declaredText = formatDeclared(currentSnapshot.declarado);
    if (declaredText) {
      detailsPanel.append(element('p', 'stage-details-meta', `Declarado no manifesto (informativo): ${declaredText}`));
    }

    const applicable = stage.criterios.filter(item => item.aplica_se !== false);
    if (!applicable.length) {
      const reason = currentSnapshot.errors[0] || 'Nenhum critério aplicável disponível.';
      detailsPanel.append(element('p', 'stage-details-empty', reason));
    } else {
      const list = element('ul', 'stage-criteria');
      for (const criterion of applicable) {
        list.append(renderCriterion(stage, criterion, project, serial));
      }
      detailsPanel.append(list);
    }

    const skillsSection = renderStageSkills(stage);
    if (skillsSection) detailsPanel.append(skillsSection);
  }

  async function load(project: string, force: boolean) {
    const serial = ++request;
    refreshButton.disabled = true;
    try {
      const next = await callbacks.readStages(project, force);
      if (!isCurrent(project, serial)) return;
      currentSnapshot = next;
      projectIsDk = next.isDk;
      watchingActive = true;
      if (!next.isDk) {
        host.hidden = true;
        closeDetails(false);
        closeCatalog(false);
        return;
      }
      renderStageButtons();
      renderKitBanner();
      host.hidden = false;
      void ensureClaudeCapability();
      if (openStageId) renderDetails();
    } catch (error) {
      if (!isCurrent(project, serial)) return;
      if (projectIsDk) {
        currentSnapshot = fallbackSnapshot(project, errorMessage(error));
        renderStageButtons();
        renderKitBanner();
        host.hidden = false;
        if (openStageId) renderDetails();
      } else {
        host.hidden = true;
      }
    } finally {
      if (isCurrent(project, serial)) refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', () => {
    if (destroyed || !root || !projectIsDk) return;
    void load(root, true);
    const panel = attachedCatalog || ownedCatalog;
    if (panel) void panel.reload();
    else if (catalogSnapshot) void ensureStageCatalog(true);
  });

  catalogButton.addEventListener('click', () => {
    if (destroyed || !root || !projectIsDk) return;
    if (catalogOpen) {
      closeCatalog(false);
      return;
    }
    const panel = ensureCatalogInstance();
    if (!panel) return;
    if (openStageId) {
      openStageId = null;
      detailsPanel.hidden = true;
      detailsPanel.replaceChildren();
    }
    catalogTrigger = catalogButton;
    catalogOpen = true;
    catalogDrawer.hidden = false;
    syncPressedStates();
  });

  function hasBlockingAppOverlay(): boolean {
    const launcher = document.getElementById?.('launcher');
    if (launcher && !launcher.hidden) return true;
    const splitMenu = document.getElementById?.('split-menu');
    if (splitMenu && !splitMenu.hidden) return true;
    const machine = document.getElementById?.('system-resources-content');
    if (machine && !machine.hidden) return true;
    return false;
  }

  host.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.key !== 'Escape') return;
    if (catalogOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeCatalog(true);
    } else if (openStageId !== null) {
      event.preventDefault();
      event.stopPropagation();
      closeDetails(true);
    }
  });

  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (destroyed || host.hidden || event.defaultPrevented || event.key !== 'Escape') return;
    if (hasBlockingAppOverlay()) return;
    if (catalogOpen) {
      event.preventDefault();
      closeCatalog(true);
    } else if (openStageId !== null) {
      event.preventDefault();
      closeDetails(true);
    }
  };
  document.addEventListener?.('keydown', onDocumentKeyDown);

  return {
    catalogHost: catalogDrawer,
    attachCatalog(panel) {
      unsubscribeCatalog?.();
      attachedCatalog = panel;
      catalogSnapshot = panel.getSnapshot();
      unsubscribeCatalog = panel.subscribe(snap => {
        catalogSnapshot = snap;
        if (!destroyed && openStageId) renderDetails();
      });
      return panel;
    },
    closeCatalog(restoreFocus = true) {
      closeCatalog(restoreFocus);
    },
    async setProject(path, isDk) {
      if (destroyed) return;
      const normalized = typeof path === 'string' && path.length > 0 ? path : null;
      const rootChanged = normalized !== root;
      root = normalized;
      if (rootChanged) {
        catalogSnapshot = null;
        catalogRequest++;
        claudeAvailable = false;
        capabilityRequest++;
        closeDetails(false);
        closeCatalog(false);
        syncRovingTabindex(0);
      }

      if (!root || isDk === false) {
        request++;
        projectIsDk = false;
        currentSnapshot = null;
        host.hidden = true;
        closeDetails(false);
        closeCatalog(false);
        if (watchingActive) {
          watchingActive = false;
          void callbacks.stopWatching?.().catch(() => {});
        }
        if (ownedCatalog) void ownedCatalog.setProject(null);
        return;
      }

      projectIsDk = isDk ?? true;
      if (ownedCatalog && rootChanged) void ownedCatalog.setProject(root);
      await load(root, false);
    },
    setKit(hasKit) {
      if (destroyed) return;
      const next = Boolean(hasKit);
      const changed = kitOverride !== null && kitOverride !== next;
      kitOverride = next;
      renderKitBanner();
      if (openStageId) renderDetails();
      if (changed && root && projectIsDk) {
        void load(root, true);
        const panel = attachedCatalog || ownedCatalog;
        if (panel) void panel.reload();
      }
    },
    async reload() {
      if (destroyed || !root || !projectIsDk) return;
      await load(root, true);
    },
    async reloadCatalog() {
      if (destroyed || !root || !projectIsDk) return;
      catalogSnapshot = (attachedCatalog || ownedCatalog)?.getSnapshot() ?? null;
      if (openStageId) await ensureStageCatalog(false);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      document.removeEventListener?.('keydown', onDocumentKeyDown);
      unsubscribeCatalog?.();
      unsubscribeCatalog = null;
      ownedCatalog?.destroy();
      ownedCatalog = null;
      attachedCatalog = null;
      root = null;
      currentSnapshot = null;
      catalogSnapshot = null;
      request++;
      catalogRequest++;
      capabilityRequest++;
      host.replaceChildren();
    },
  };
}
