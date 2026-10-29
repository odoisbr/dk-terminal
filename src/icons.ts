// Mapa canônico de ícones do SEA Dock: um desenho por significado e um
// significado por desenho. Todos os módulos do renderer importam daqui; não crie
// SVG avulso nem use glifo de texto (↻ × › ▸ ◇ ✓) como ícone de botão ou estado.
// viewBox 24, sem preenchimento, traço 1.6 arredondado.
// Decisões e conflitos resolvidos: docs/ux-decisoes.md ("Mapa canônico de ícones").
const paths = {
  // Navegação e aplicativo
  home: '<path d="M3 11 12 3l9 8M5 10v10h14V10M9 20v-6h6v6"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
  sliders: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M5.5 8h1M5.5 11h1M5.5 14h1"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  arrowUp: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14m-6-6 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 7a7 7 0 0 1 11.6-2L20 8M4 16l2.9 3A7 7 0 0 0 18.5 17"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  // Projetos, pastas e arquivos
  plus: '<path d="M12 5v14M5 12h14"/>',
  folderOpen: '<path d="M3 18V6a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v2"/><path d="M3 18l3-7h15l-3 7Z"/>',
  project: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 12.5h18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>',
  files: '<path d="M9 3h7l4 4v11H9Z"/><path d="M16 3v4h4"/><path d="M6 7H5v14h11v-1"/>',
  reveal: '<path d="M3 18V7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v2"/><path d="M3 18h9"/><path d="M15 20l6-6m-4 0h4v4"/>',
  file: '<path d="M14 3H5v18h14V8Zm0 0v6h5M8 13h8m-8 4h6"/>',
  // Terminal, agentes e layout
  terminal: '<path d="m5 6 6 6-6 6m8 0h6"/>',
  terminalPlus: '<path d="m4 7 5 5-5 5m7 0h4"/><path d="M19 4v6m-3-3h6"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 16v4m-2-2h4"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  splitDown: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
  single: '<rect x="3" y="4" width="18" height="16" rx="2"/>',
  detach: '<rect x="3" y="4" width="8" height="16" rx="1"/><path d="M15 8h6m-2-2 2 2-2 2M15 16h6m-2-2 2 2-2 2"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  restore: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  // Ações DK
  fileSearch: '<path d="M13 3H5v18h6"/><path d="M13 3v5h5v3"/><circle cx="16" cy="16" r="3.5"/><path d="m18.5 18.5 2.5 2.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16 9.5"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  graph: '<rect x="3" y="8" width="5" height="7" rx="1"/><rect x="16" y="3" width="5" height="6" rx="1"/><rect x="16" y="15" width="5" height="6" rx="1"/><path d="M8 11h4V6h4m-4 5v7h4"/>',
  // Painel do projeto
  git: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m2-6h4a6 6 0 0 0 6-2"/>',
  code: '<path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 18"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/>',
  chart: '<path d="M4 20h16M6 17v-5m5 5V7m5 10V4m4 13v-8"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  // GitLab remoto
  cloudDown: '<path d="M7 17a4 4 0 0 1-.5-8 6 6 0 0 1 11.5 1.5A3.5 3.5 0 0 1 17.5 17"/><path d="M12 12v9m-3-3 3 3 3-3"/>',
  cloudUp: '<path d="M7 17a4 4 0 0 1-.5-8 6 6 0 0 1 11.5 1.5A3.5 3.5 0 0 1 17.5 17"/><path d="M12 21v-9m-3 3 3-3 3 3"/>',
  // Máquina, configurações e diagnóstico
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3M19 9h3m-3 6h3"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4Z"/><path d="M10 21h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  tool: '<path d="M14 4a5 5 0 0 0-6 6L3 15l6 6 5-5a5 5 0 0 0 6-6l-3 3-3-3 3-3z"/>',
  blocks: '<rect x="3" y="3" width="7.5" height="7.5" rx="1"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1"/><path d="M17.25 3v7.5M13.5 6.75H21"/>',
  bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="m9.5 3.5 1.5 2.5m3.5-2.5L13 6M3 13h5m8 0h5M4 8l4 2m12-2-4 2M4 19l4-2m12 2-4-2M12 10v10"/>',
} as const;

export type IconName = keyof typeof paths;
export const iconNames = Object.keys(paths) as IconName[];

/** SVG inline do ícone; o rótulo acessível fica no controle que o contém. */
export function icon(name: IconName, extra = ''): string {
  return `<svg class="icon${extra ? ` ${extra}` : ''}" data-icon="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

/** Ícone envolto em <span> decorativo (cartões do Início, cabeçalhos de seção). */
export function iconMark(name: IconName, className = 'launcher-glyph'): HTMLSpanElement {
  const item = document.createElement('span');
  item.className = className;
  item.setAttribute('aria-hidden', 'true');
  item.innerHTML = icon(name);
  return item;
}

/** Botão só-ícone com title e aria-label iguais, descrevendo a ação. */
export function setIconButton(button: HTMLButtonElement, name: IconName, label: string, shortcut = '') {
  button.innerHTML = icon(name);
  button.setAttribute('aria-label', label);
  button.title = shortcut ? `${label} (${shortcut})` : label;
}
