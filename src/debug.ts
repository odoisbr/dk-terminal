// Modo debug no renderer: encaminha erros ao processo principal (que redige e grava),
// mostra o indicador no rodapé e monta a seção de Perfil e configurações.
// Nunca encaminha entrada nem saída de terminais.
let state: DebugState | null = null;
let installed = false;
let budget = { start: 0, count: 0 };
let forwarding = false;
const subscribers = new Set<(state: DebugState) => void>();

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try { return (JSON.stringify(value) ?? String(value)).slice(0, 2000); } catch { return String(value); }
}
function forward(level: 'error' | 'warn', parts: unknown[]) {
  if (!state?.enabled || forwarding) return;
  const now = Date.now();
  if (now - budget.start > 10000) budget = { start: now, count: 0 };
  if (++budget.count > 40) return;
  forwarding = true;
  try { void window.dk.reportRendererLog(level, parts.map(describe).filter(Boolean).join(' ').slice(0, 16 * 1024)).catch(() => {}); }
  finally { forwarding = false; }
}
function setState(next: DebugState) {
  state = next;
  renderIndicator();
  for (const subscriber of subscribers) subscriber(next);
}
function renderIndicator() {
  const host = document.querySelector<HTMLElement>('.footer-status');
  let indicator = document.getElementById('debug-indicator') as HTMLButtonElement | null;
  if (!state?.enabled) { indicator?.remove(); return; }
  if (!host) return;
  if (!indicator) {
    indicator = document.createElement('button');
    indicator.id = 'debug-indicator'; indicator.type = 'button'; indicator.className = 'debug-indicator';
    indicator.innerHTML = '<span class="debug-indicator-dot" aria-hidden="true"></span><span>DEBUG</span>';
    indicator.onclick = () => { void window.dk.openDebugFolder().catch(() => {}); };
    host.prepend(indicator);
  }
  indicator.title = 'Modo debug ligado: o SEA Dock está gravando logs de diagnóstico. Clique para abrir a pasta de logs.';
  indicator.setAttribute('aria-label', 'Modo debug ligado. Abrir a pasta de logs');
}
export async function refreshDebugState() {
  try { setState(await window.dk.debugState()); } catch {}
}
export function installDebugCapture() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', event => {
    const where = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '';
    forward('error', ['window.onerror:', event.message, where, event.error instanceof Error ? event.error : '']);
  });
  window.addEventListener('unhandledrejection', event => forward('error', ['unhandledrejection:', event.reason]));
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => { original(...args); forward(level, [`console.${level}:`, ...args]); };
  }
  void refreshDebugState();
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => { const item = document.createElement(tag); item.className = className; item.textContent = text; return item; };

// Conteúdo da seção "Diagnóstico" em Perfil e configurações.
export function mountDebugSettings(host: HTMLElement, notify: (error: unknown) => void) {
  const row = element('label', 'settings-row'); row.htmlFor = 'debug-mode';
  const input = document.createElement('input'); input.type = 'checkbox'; input.id = 'debug-mode';
  row.append(element('span', '', 'Modo debug'), input);
  const note = element('p', 'settings-note', 'Grava erros e eventos do SEA Dock em arquivos neste computador, para você enviar ao suporte. Tokens e o nome da sua pasta pessoal são ocultados. O que você digita e a saída dos terminais nunca são gravados.');
  note.id = 'debug-mode-note'; input.setAttribute('aria-describedby', note.id);
  const forced = element('p', 'settings-note debug-forced', 'Ligado nesta execução por --sea-dock-debug ou SEA_DOCK_DEBUG=1. Para desligar, abra o SEA Dock sem essa opção.');
  const location = element('p', 'settings-note debug-location');
  const actions = element('div', 'debug-actions');
  const exportButton = element('button', 'launcher-button primary debug-action', 'Exportar logs'); exportButton.type = 'button'; exportButton.id = 'debug-export';
  const folderButton = element('button', 'launcher-button debug-action', 'Abrir pasta de logs'); folderButton.type = 'button'; folderButton.id = 'debug-open-folder';
  actions.append(exportButton, folderButton);
  const status = element('p', 'settings-note debug-status'); status.id = 'debug-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  host.append(row, note, forced, location, actions, status);
  const apply = (current: DebugState) => {
    input.checked = current.enabled; input.disabled = current.forced;
    forced.hidden = !current.forced;
    location.textContent = `Pasta: ${current.directory}`;
  };
  // A seção entra no documento logo após montar; atualizações assíncronas
  // posteriores deixam de valer quando a página de configurações é trocada.
  const render = (current: DebugState) => { if (!host.isConnected) { subscribers.delete(render); return; } apply(current); };
  subscribers.add(render);
  if (state) apply(state); else location.textContent = 'Verificando…';
  void refreshDebugState();
  input.onchange = () => {
    const wanted = input.checked; input.disabled = true;
    status.textContent = wanted ? 'Ligando o modo debug…' : 'Desligando o modo debug…';
    void window.dk.setDebugEnabled(wanted).then(next => {
      setState(next);
      status.textContent = next.enabled ? 'Modo debug ligado. Repita o problema e depois exporte os logs.' : 'Modo debug desligado. Os logs já gravados continuam na pasta.';
    }).catch(error => { input.checked = !wanted; status.textContent = 'Não foi possível alterar o modo debug.'; notify(error); })
      .finally(() => { input.disabled = !!state?.forced; });
  };
  exportButton.onclick = () => {
    exportButton.disabled = true; exportButton.setAttribute('aria-busy', 'true'); status.textContent = 'Exportando logs…';
    void window.dk.exportDebugLogs().then(result => { status.textContent = `Logs exportados em ${result.file}. Envie esse arquivo ao suporte.`; })
      .catch(error => { status.textContent = error instanceof Error && /Ainda não há logs/.test(error.message) ? error.message : 'Não foi possível exportar os logs.'; if (!(error instanceof Error && /Ainda não há logs/.test(error.message))) notify(error); })
      .finally(() => { exportButton.disabled = false; exportButton.removeAttribute('aria-busy'); });
  };
  folderButton.onclick = () => { void window.dk.openDebugFolder().catch(notify); };
  return () => { subscribers.delete(render); };
}
