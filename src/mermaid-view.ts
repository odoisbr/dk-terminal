import { addConnectedNode, changeNodeLabel, changeSequenceLabel, connectNodes, findNodeLabel, sequenceLabels } from './mermaid-edit';

let library: Promise<{ mermaid: typeof import('mermaid')['default']; purify: typeof import('dompurify')['default'] }> | null = null;
let nextId = 0;
const revisions = new WeakMap<HTMLElement, number>();
function load() {
  if (!library) library = Promise.all([import('mermaid'), import('dompurify')]).then(([m, p]) => {
    m.default.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'dark', maxTextSize: 50000, maxEdges: 500, htmlLabels: false, flowchart: { htmlLabels: false } });
    return { mermaid: m.default, purify: p.default };
  });
  return library;
}
export function invalidateMermaid(host: HTMLElement) { revisions.set(host, (revisions.get(host) || 0) + 1); }
export async function renderMermaid(host: HTMLElement, source: string, apply: (source: string) => void, readOnly = false) {
  const revision = (revisions.get(host) || 0) + 1; revisions.set(host, revision);
  host.replaceChildren();
  const status = document.createElement('p'); status.className = 'dk-diagram-note'; status.textContent = 'Renderizando diagrama…'; host.append(status);
  if (source.length > 50000) { status.textContent = 'Este diagrama ultrapassa o limite de 50 mil caracteres para visualização. Abra o código para editá-lo.'; return; }
  try {
    const { mermaid, purify } = await load();
    const { svg } = await mermaid.render(`dk-mermaid-${++nextId}`, source);
    if (revisions.get(host) !== revision || !host.isConnected) return;
    const canvas = document.createElement('div'); canvas.className = 'dk-diagram-canvas';
    const fragment = purify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['foreignObject', 'iframe', 'script', 'a'] });
    canvas.append(fragment); host.replaceChildren(canvas);
    // Mermaid may serialize escaped entities as literal text in SVG labels.
    // Decode into text nodes only, after sanitization, so labels never become markup.
    const entities: Record<string, string> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
    for (const text of canvas.querySelectorAll('text, tspan')) for (const child of text.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE || !child.nodeValue) continue;
      child.nodeValue = child.nodeValue.replace(/&(?:quot|apos|lt|gt|amp);/g, match => entities[match.slice(1, -1)]);
    }
    let editable = 0;
    const elements = [...canvas.querySelectorAll<SVGGElement>('g.node')].flatMap(node => {
      const id = node.getAttribute('data-id') || node.id.match(/(?:^|-)flowchart-(.*)-\d+$/)?.[1];
      const label = id && findNodeLabel(source, id);
      return id && label ? [{ node, id, label }] : [];
    });
    if (!readOnly) for (const { node, id, label } of elements) {
      editable++;
      const repeatedLabel = elements.some(other => other.id !== id && other.label.value === label.value);
      node.classList.add('dk-diagram-editable'); node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0'); node.setAttribute('aria-label', `Editar ${label.value}${repeatedLabel ? ` (${id})` : ''}`);
      const edit = () => {
        host.querySelector('.dk-diagram-form')?.remove();
        const form = document.createElement('form'); form.className = 'dk-diagram-form';
        const field = document.createElement('input'); field.value = label.value; field.maxLength = 500; field.setAttribute('aria-label', 'Texto do elemento');
        const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Aplicar';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancelar'; cancel.onclick = () => form.remove();
        const error = document.createElement('span'); error.className = 'dk-diagram-note'; error.setAttribute('role', 'status');
        const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Adicionar etapa';
        const connect = document.createElement('button'); connect.type = 'button'; connect.textContent = 'Conectar';
        add.onclick = () => {
          const newLabel = document.createElement('input'); newLabel.maxLength = 500; newLabel.placeholder = 'Nome da nova etapa'; newLabel.setAttribute('aria-label', 'Nome da nova etapa');
          const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.textContent = 'Adicionar';
          form.replaceChildren(newLabel, confirm, cancel, error); newLabel.focus();
          form.onsubmit = event => { event.preventDefault(); const updated = addConnectedNode(source, id, newLabel.value); if (!updated) { error.textContent = 'Informe um nome para a nova etapa.'; return; } apply(updated); form.remove(); };
        };
        connect.onclick = () => {
          const select = document.createElement('select'); select.setAttribute('aria-label', 'Conectar à etapa');
          for (const other of elements) { const option = document.createElement('option'); option.value = other.id; option.textContent = other.label.value; select.append(option); }
          const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.textContent = 'Criar conexão';
          form.replaceChildren(select, confirm, cancel, error); select.focus();
          form.onsubmit = event => { event.preventDefault(); const updated = connectNodes(source, id, select.value); if (!updated) { error.textContent = 'Não foi possível conectar estas etapas.'; return; } apply(updated); form.remove(); };
        };
        form.append(field, save, add, connect, cancel, error); host.prepend(form); field.focus(); field.select();
        form.onsubmit = event => { event.preventDefault(); const updated = changeNodeLabel(source, id, field.value); if (!updated) { error.textContent = 'Informe um texto para o elemento.'; return; } apply(updated); form.remove(); };
        field.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); form.remove(); node.focus(); } };
      };
      node.addEventListener('click', edit);
      node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); edit(); } });
    }
    if (!readOnly) {
      const labels = sequenceLabels(source);
      for (const node of canvas.querySelectorAll<SVGTextElement>('text.actor-box, text.messageText')) {
        const kind = node.classList.contains('messageText') ? 'message' : 'actor';
        const shown = (node.textContent || '').replace(/\s+/g, ' ').trim();
        const matches = labels.filter(item => item.kind === kind && item.value.replace(/\s+/g, ' ').trim() === shown);
        if (matches.length !== 1) continue;
        const item = matches[0]; editable++;
        node.classList.add('dk-diagram-editable'); node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0'); node.setAttribute('aria-label', `Editar ${item.value}`);
        const edit = () => {
          host.querySelector('.dk-diagram-form')?.remove();
          const form = document.createElement('form'); form.className = 'dk-diagram-form';
          const field = document.createElement('input'); field.value = item.value; field.maxLength = 500; field.setAttribute('aria-label', 'Texto do elemento');
          const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Aplicar';
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancelar'; cancel.onclick = () => form.remove();
          const error = document.createElement('span'); error.className = 'dk-diagram-note'; error.setAttribute('role', 'status');
          form.append(field, save, cancel, error); host.prepend(form); field.focus(); field.select();
          form.onsubmit = event => { event.preventDefault(); const updated = changeSequenceLabel(source, item, field.value); if (!updated) { error.textContent = 'Informe um texto para o elemento.'; return; } apply(updated); form.remove(); };
          field.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); form.remove(); node.focus(); } };
        };
        node.addEventListener('click', edit);
        node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); edit(); } });
      }
    }
    const hint = document.createElement('p'); hint.className = 'dk-diagram-note';
    hint.textContent = readOnly ? 'Somente leitura.' : elements.length && editable ? 'Selecione uma etapa para editar, adicionar outra ou criar uma conexão. Para outras alterações, abra Código.' : editable ? 'Selecione um participante ou uma mensagem para editar. Para outras alterações, abra Código.' : 'Para editar este tipo de diagrama, abra Código.';
    host.append(hint);
  } catch {
    if (revisions.get(host) !== revision || !host.isConnected) return;
    status.textContent = 'Não foi possível renderizar o diagrama. Abra Código para conferir a sintaxe.';
  }
}
