const labels: Record<string, string> = { pronto: 'Pronto', bloqueado: 'Bloqueado', em_execucao: 'Em execução', concluido: 'Concluído', falhou: 'Falhou', parado: 'Parado', desconhecido: 'Não informado' };
export function renderOrchestration(host: HTMLElement, data: GraphListing) {
  const previous = host.querySelector<HTMLSelectElement>('select')?.value;
  host.replaceChildren();
  if (data.warnings.length) { const warning = document.createElement('p'); warning.className = 'graph-warning'; warning.textContent = data.warnings.join('\n'); host.append(warning); }
  if (!data.graphs.length) {
    const empty = document.createElement('div'); empty.className = 'graph-empty'; empty.innerHTML = '<h2>Nenhuma orquestração registrada.</h2><p>Os fluxos gravados pelo DK aparecerão aqui com suas tarefas, dependências e estados reais.</p>'; host.append(empty); return;
  }
  const controls = document.createElement('div'); controls.className = 'graph-controls';
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Selecionar orquestração');
  for (const graph of data.graphs) { const option = document.createElement('option'); option.value = graph.file; option.textContent = graph.id; select.append(option); }
  if (data.graphs.some(graph => graph.file === previous)) select.value = previous!;
  const summary = document.createElement('span'); controls.append(select, summary); host.append(controls);
  const objective = document.createElement('p'); objective.className = 'graph-objective'; host.append(objective);
  const viewport = document.createElement('div'); viewport.className = 'graph-viewport'; host.append(viewport);
  const detail = document.createElement('div'); detail.className = 'graph-detail'; detail.textContent = 'Selecione uma tarefa para ver seu estado.'; host.append(detail);
  const draw = () => {
    const graph = data.graphs.find(item => item.file === select.value)!;
    objective.textContent = graph.objective;
    summary.textContent = `${labels[graph.state] || graph.state} · ${graph.nodes.filter(n => n.state === 'concluido').length}/${graph.nodes.length} tarefas · revisão ${graph.revision}`;
    viewport.replaceChildren();
    const counts = new Map<number, number>(), positions = new Map<string, { x: number; y: number }>();
    for (const node of graph.nodes) { const row = counts.get(node.depth) || 0; counts.set(node.depth, row + 1); positions.set(node.id, { x: 24 + node.depth * 264, y: 24 + row * 136 }); }
    const width = Math.max(500, 264 * (1 + Math.max(0, ...graph.nodes.map(n => n.depth))));
    const height = Math.max(300, 48 + 136 * Math.max(1, ...counts.values()));
    const scene = document.createElement('div'); scene.className = 'graph-scene'; scene.style.width = `${width}px`; scene.style.height = `${height}px`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height)); svg.setAttribute('aria-hidden', 'true');
    for (const node of graph.nodes) for (const id of node.dependencies) {
      const a = positions.get(id)!, b = positions.get(node.id)!;
      const edge = document.createElementNS(svg.namespaceURI, 'path');
      edge.setAttribute('d', `M${a.x + 216},${a.y + 50} C${a.x + 244},${a.y + 50} ${b.x - 28},${b.y + 50} ${b.x},${b.y + 50}`); edge.setAttribute('class', 'graph-edge'); svg.append(edge);
    }
    scene.append(svg);
    for (const node of graph.nodes) {
      const position = positions.get(node.id)!;
      const card = document.createElement('button'); card.className = `graph-node state-${node.state}`; card.dataset.node = node.id; card.style.left = `${position.x}px`; card.style.top = `${position.y}px`; card.title = node.label;
      const id = document.createElement('small'); id.textContent = node.id;
      const name = document.createElement('strong'); name.textContent = node.label;
      const state = document.createElement('span'); state.textContent = labels[node.state] || node.state;
      card.append(id, name, state);
      card.onclick = () => { scene.querySelectorAll('.selected').forEach(el => el.classList.remove('selected')); card.classList.add('selected'); detail.textContent = `${node.id} · ${labels[node.state] || node.state} · ${node.attempts} tentativa(s)${node.blocked ? ' · ' + node.blocked : ''}`; };
      scene.append(card);
    }
    viewport.append(scene);
  };
  select.onchange = draw; draw();
}
