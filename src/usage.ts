export function renderUsage(host: HTMLElement, snapshot: UsageSnapshot | null, openClaude: () => void) {
  host.replaceChildren();
  if (!snapshot) { const empty = document.createElement('p'); empty.className = 'context-note'; empty.textContent = 'Abra um projeto para consultar o uso das suas contas.'; host.append(empty); return; }
  for (const provider of snapshot.providers) {
    const card = document.createElement('section'); card.className = 'usage-provider';
    const heading = document.createElement('h3'); heading.textContent = provider.name;
    card.append(heading);
    if (provider.account || provider.plan) { const account = document.createElement('p'); account.className = 'usage-account'; account.textContent = [provider.account, provider.plan].filter(Boolean).join(' · '); card.append(account); }
    for (const window of provider.windows) {
      const quota = document.createElement('div'); quota.className = 'usage-quota';
      const line = document.createElement('div'); line.className = 'usage-label';
      const label = document.createElement('span'); label.textContent = window.label;
      const percent = document.createElement('strong'); percent.textContent = `${Math.round(window.usedPercent)}%`;
      const bar = document.createElement('div'); bar.className = 'usage-bar'; bar.role = 'progressbar'; bar.setAttribute('aria-label', `${provider.name}: ${window.label}, uso consumido`); bar.setAttribute('aria-valuenow', String(window.usedPercent)); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
      const fill = document.createElement('span'); fill.style.width = `${window.usedPercent}%`; bar.append(fill);
      if (window.usedPercent >= 90) bar.classList.add('near-limit');
      line.append(label, percent); quota.append(line, bar);
      const reset = document.createElement('small'); reset.textContent = window.resetsAt ? `Reinicia ${new Date(window.resetsAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : window.resetLabel || 'Horário de reinício não informado'; quota.append(reset); card.append(quota);
    }
    if (provider.message) { const note = document.createElement('p'); note.className = 'context-note'; note.textContent = provider.message; card.append(note); }
    if (provider.id === 'claude' && !provider.windows.length) { const control = document.createElement('button'); control.className = 'button secondary'; control.textContent = 'Abrir Claude'; control.onclick = openClaude; card.append(control); }
    const source = document.createElement('small'); source.className = 'usage-source'; source.textContent = provider.source || 'Consulta à ferramenta local'; card.append(source); host.append(card);
  }
  const updated = document.createElement('p'); updated.className = 'usage-source'; updated.textContent = `Atualizado às ${new Date(snapshot.checkedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · Atualização manual`; host.append(updated);
}
