interface ActionResult {
  action: string;
  label: string;
  root: string;
  code: number | null;
  data: unknown;
  output: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  status?: string;
  signal?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
  truncated?: boolean;
  cleanupPartial?: boolean;
  jsonParsed?: boolean;
}
type RecordValue = Record<string, unknown>;
const LABELS: Record<string, string> = {
  projeto: 'Projeto', tipo: 'Tipo de projeto', stack: 'Tecnologias', gerenciador: 'Gerenciador', evidencias: 'Evidências', estrutura: 'Estrutura',
  metricas: 'Métricas', arquivos: 'Arquivos', bytes: 'Tamanho em bytes', tokens_estimados_total: 'Tokens estimados', tokens_dos_importantes: 'Tokens dos arquivos importantes',
  nota: 'Observação', linguagens: 'Linguagens', conformidade: 'Conformidade com o DK', usa_dk: 'Usa DK', esquema: 'Esquema', classificacao: 'Classificação', artefatos: 'Artefatos', achados: 'Achados',
  importantes: 'Arquivos importantes', ignorados: 'Itens ignorados', caminho: 'Caminho', importancia: 'Importância', motivo: 'Motivo', tokens_estimados: 'Tokens estimados',
  perfil: 'Perfil do projeto', estado: 'Estado do projeto', fase_observada: 'Fase observada', explicacao: 'Explicação', erros: 'Erros', avisos: 'Avisos', codigo: 'Código', mensagem: 'Mensagem',
  ok: 'Resultado da validação', pacote: 'Pacote DK', dependencias: 'Dependências', capacidades: 'Capacidades', configuracao: 'Configuração', limites: 'Limites informados',
  host: 'Ambiente', versao: 'Versão', localizado: 'Localizado', sessao: 'Sessão', modo: 'Modo', contexto: 'Contexto', titulo: 'Título', evidencia: 'Evidência', impacto: 'Impacto',
};
const CSS = `
.dk-action-result{height:100%;min-height:0;box-sizing:border-box;overflow:auto;color:#dce5e4;background:#171d1f;font:12px system-ui,sans-serif;padding:24px}
.dk-action-head{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #303b3d;padding-bottom:19px;margin-bottom:20px}
.dk-action-head h2{font-size:20px;font-weight:550;margin:0 0 7px;letter-spacing:-.4px}.dk-action-subtitle{color:#8f9fa3;font-size:11px;overflow-wrap:anywhere;line-height:1.6}
.dk-action-tools{display:flex;align-items:center;gap:9px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
.dk-action-toggle{background:transparent;border:1px solid #3a484a;border-radius:6px;padding:6px 10px;color:#dce5e4;font:inherit;cursor:pointer}.dk-action-toggle:hover{background:#283235}.dk-action-toggle:focus-visible{outline:2px solid #c7e98e;outline-offset:2px}
.dk-action-status{font-size:10px;border:1px solid #405145;border-radius:20px;color:#c7e98e;padding:5px 9px;white-space:nowrap}.dk-action-status[data-state=failed]{color:#f2ad98;border-color:#64443b}.dk-action-status[data-state=interrupted]{color:#e0ca91;border-color:#635636}
.dk-action-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-bottom:22px}.dk-action-card{border:1px solid #303b3d;background:#1c2426;border-radius:8px;padding:13px 15px;min-width:0}.dk-action-card span{display:block;color:#94a4a6;font-size:10px;margin-bottom:7px}.dk-action-card strong{font-size:15px;font-weight:500;overflow-wrap:anywhere}
.dk-action-section{margin:0 0 17px;border:1px solid #303b3d;border-radius:8px;padding:16px;background:#1b2224}.dk-action-section h3{font-size:12px;font-weight:550;margin:0 0 13px;color:#c8d4d5}.dk-action-values{display:grid;grid-template-columns:minmax(130px,.35fr) 1fr;gap:9px 18px;margin:0;align-items:start}.dk-action-values dt{font-size:11px;color:#91a2a5;overflow-wrap:anywhere}.dk-action-values dd{margin:0;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap;line-height:1.5}
.dk-action-list{display:flex;flex-direction:column;gap:9px;margin:0;padding-left:18px;line-height:1.6}.dk-action-list-object{padding:12px;background:#20292c;border:1px solid #344044;border-radius:6px;list-style:none;margin-left:-18px}
.dk-action-nested{margin:4px 0 0;border-top:1px solid #354044;padding-top:10px}.dk-action-nested summary{cursor:pointer;font-size:11px;color:#b0bfc1;margin-bottom:10px}.dk-action-muted{color:#8b9c9e;line-height:1.6;font-size:11px}.dk-action-log{margin:0;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;font:11px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cbd6d6;background:#111719;padding:15px;border-radius:6px;border:1px solid #2e393c}.dk-action-notice{padding:12px 15px;border:1px solid #695a3b;color:#e0ca91;background:#28271f;border-radius:6px;line-height:1.6;margin-bottom:17px}.dk-action-result [hidden]{display:none!important}
@media(max-width:640px){.dk-action-result{padding:15px}.dk-action-head{flex-direction:column}.dk-action-values{grid-template-columns:1fr;gap:4px}.dk-action-values dd{margin-bottom:9px}.dk-action-tools{justify-content:flex-start}}
`;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); result.className = className; if (text !== undefined) result.textContent = text; return result;
}
function record(value: unknown): RecordValue | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null; }
function label(key: string): string { return Object.hasOwn(LABELS, key) ? LABELS[key] : key.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase()); }
function scalar(value: unknown): string {
  if (value === null || value === undefined) return 'Não informado';
  if (value === true) return 'Sim'; if (value === false) return 'Não';
  if (typeof value === 'number') return value.toLocaleString('pt-BR');
  return String(value);
}
function status(result: ActionResult): { text: string; state: string } {
  if (result.timedOut) return { text: 'Tempo esgotado', state: 'interrupted' };
  if (result.cancelled) return { text: 'Cancelado', state: 'interrupted' };
  if (result.truncated) return { text: 'Limite de saída atingido', state: 'interrupted' };
  if (result.code === 0) return { text: 'Execução concluída', state: 'completed' };
  return { text: result.code === null ? 'Execução interrompida' : `Código de saída ${result.code}`, state: 'failed' };
}

/** Render source values as text nodes; JSON and command output are never HTML. */
export function renderAction(host: HTMLElement, result: ActionResult): void {
  if (!document.getElementById('dk-action-result-styles')) {
    const style = document.createElement('style'); style.id = 'dk-action-result-styles'; style.textContent = CSS; document.head.append(style);
  }
  host.classList.add('dk-action-result', 'dk-action'); host.setAttribute('aria-label', `Resultado DK: ${result.label}`); host.replaceChildren();
  const header = node('div', 'dk-action-head'), heading = node('div');
  heading.append(node('h2', '', result.label));
  const duration = new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime();
  heading.append(node('div', 'dk-action-subtitle', [result.root, Number.isFinite(duration) && duration >= 0 ? `${(duration / 1000).toFixed(1).replace('.', ',')} s` : ''].filter(Boolean).join(' · ')));
  const tools = node('div', 'dk-action-tools'), execution = status(result), badge = node('span', 'dk-action-status', execution.text); badge.dataset.state = execution.state; tools.append(badge);
  header.append(heading, tools); host.append(header);
  if (result.timedOut || result.cancelled || result.truncated) {
    const message = result.timedOut ? 'A ação atingiu o prazo e foi interrompida. Os dados abaixo são a saída recebida até a interrupção.' : result.cancelled ? 'A ação foi cancelada. Os dados abaixo são a saída recebida até o cancelamento.' : 'A saída ultrapassou 2 MB e a ação foi interrompida. A saída recebida aparece parcialmente abaixo.';
    host.append(node('p', 'dk-action-notice', message));
  }
  if (result.cleanupPartial) host.append(node('p', 'dk-action-notice', 'Não foi possível confirmar o encerramento de todos os processos associados à ação.'));
  const formatted = node('div'), raw = node('pre', 'dk-action-log'); raw.hidden = true; host.append(formatted, raw);
  const hasJson = result.jsonParsed === true || result.data !== null && result.data !== undefined;
  if (hasJson) {
    const toggle = node('button', 'dk-action-toggle', 'Ver JSON'); toggle.type = 'button'; toggle.setAttribute('aria-pressed', 'false');
    toggle.addEventListener('click', () => {
      const show = raw.hidden;
      if (show && !raw.textContent) raw.textContent = result.output || JSON.stringify(result.data, null, 2);
      raw.hidden = !show; formatted.hidden = show; toggle.textContent = show ? 'Ver resultado' : 'Ver JSON'; toggle.setAttribute('aria-pressed', String(show));
    });
    tools.append(toggle); renderData(formatted, result.data, result.action);
  } else {
    formatted.append(node('pre', 'dk-action-log', result.output || 'A ação não retornou saída de texto.'));
  }
  if (result.stderr) {
    const section = node('section', 'dk-action-section'); section.style.marginTop = '17px';
    section.append(node('h3', '', 'Mensagens da execução'), node('pre', 'dk-action-log', result.stderr)); host.append(section);
  }
  if (result.signal) host.append(node('p', 'dk-action-muted', `Sinal de encerramento: ${result.signal}`));
}

function renderData(host: HTMLElement, data: unknown, action: string): void {
  const source = record(data), cards = node('div', 'dk-action-cards');
  const addCard = (name: string, value: unknown) => {
    if (value === undefined || value === null) return;
    const card = node('div', 'dk-action-card'); card.append(node('span', '', name), node('strong', '', Array.isArray(value) ? value.map(scalar).join(' · ') || 'Nenhuma retornada' : scalar(value))); cards.append(card);
  };
  if (source && action === 'audit') {
    const project = record(source.projeto), metrics = record(source.metricas), compliance = record(source.conformidade);
    addCard('Projeto', project?.tipo); addCard('Tecnologias', project?.stack); addCard('Gerenciador', project?.gerenciador);
    addCard('Conformidade', compliance?.classificacao); addCard('Arquivos', metrics?.arquivos); addCard('Tokens estimados', metrics?.tokens_estimados_total);
  } else if (source && action === 'validate') {
    if (typeof source.ok === 'boolean') addCard('Validação do DK', source.ok ? 'Projeto válido' : 'Bloqueado para avanço');
    addCard('Fase observada', record(source.estado)?.fase_observada);
    if (Array.isArray(source.erros)) addCard('Erros retornados', source.erros.length);
    if (Array.isArray(source.avisos)) addCard('Avisos retornados', source.avisos.length);
  } else if (source && action === 'doctor') {
    addCard('DK', record(source.pacote)?.versao); addCard('Ambiente', record(source.host)?.id);
    addCard('Orquestração', record(source.host)?.orquestracao);
  }
  if (cards.childElementCount) host.append(cards);
  let remaining = 500;
  const renderValue = (value: unknown, depth: number): HTMLElement => {
    if (--remaining < 0 || depth > 8) return node('p', 'dk-action-muted', 'Estrutura extensa. Use Ver JSON para consultar todos os dados.');
    if (Array.isArray(value)) {
      if (!value.length) return node('span', 'dk-action-muted', 'Nenhum item retornado.');
      const list = node('ul', 'dk-action-list');
      for (const item of value.slice(0, 100)) {
        if (remaining < 0) break;
        const row = node('li', record(item) || Array.isArray(item) ? 'dk-action-list-object' : ''); row.append(renderValue(item, depth + 1)); list.append(row);
      }
      if (value.length > list.childElementCount) list.append(node('li', 'dk-action-muted', `${value.length - list.childElementCount} outros itens disponíveis em Ver JSON.`));
      return list;
    }
    const object = record(value);
    if (object) {
      const entries = Object.entries(object);
      if (!entries.length) return node('span', 'dk-action-muted', 'Nenhum item retornado.');
      const values = node('dl', 'dk-action-values');
      for (const [key, child] of entries) {
        if (remaining < 0) { values.append(node('dt', '', 'Outros campos'), node('dd', 'dk-action-muted', 'Disponíveis em Ver JSON.')); break; }
        const name = node('dt', '', label(key)), content = node('dd'); content.append(renderValue(child, depth + 1)); values.append(name, content);
      }
      return values;
    }
    return node('span', '', scalar(value));
  };
  if (source) {
    for (const [key, value] of Object.entries(source)) {
      if (remaining < 0) { host.append(node('p', 'dk-action-muted', 'Outros campos estão disponíveis em Ver JSON.')); break; }
      const section = node('section', 'dk-action-section'); section.append(node('h3', '', label(key)), renderValue(value, 0)); host.append(section);
    }
  } else {
    const section = node('section', 'dk-action-section'); section.append(node('h3', '', 'Resultado'), renderValue(data, 0)); host.append(section);
  }
}
