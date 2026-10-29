import { basicSetup } from 'codemirror';
import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { undo, redo, undoDepth, redoDepth, isolateHistory } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { setIconButton } from './icons';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { visualMarkdown, imagePath } from './markdown-visual';
import { renderMermaid, invalidateMermaid } from './mermaid-view';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';

interface FileData {
  path: string;
  relative: string;
  name: string;
  kind: 'text' | 'image' | 'binary';
  size: number;
  readOnly: boolean;
  revision: string | null;
  content?: string;
  dataUrl?: string;
  reason?: string;
  bom?: boolean;
  newline?: string;
}
interface EditorOptions {
  read(root: string, relative: string): Promise<FileData>;
  save(root: string, relative: string, text: string, revision: string): Promise<FileData>;
  confirmClose(name: string): Promise<'save' | 'discard' | 'cancel'>;
  tabsHost: HTMLElement;
  onSelect(): void;
  onDirty(files: string[]): void;
  onEmpty(): void;
  onError(error: unknown): void;
}
interface FileTab {
  key: string;
  root: string;
  relative: string;
  file: FileData;
  state: EditorState | null;
  savedDoc: Text | null;
  dirty: boolean;
  visual: boolean;
  showCode: boolean;
  saving?: Promise<boolean>;
  closing?: boolean;
}
const MAX_TABS = 12;
const markdownFile = (name: string) => /\.(md|markdown|mdown)$/i.test(name);
const htmlFile = (name: string) => /\.(html|htm)$/i.test(name);
const mermaidFile = (name: string) => /\.(mmd|mermaid)$/i.test(name);
const STYLES = `
.dk-file-editor{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;background:#171d1f;color:#dbe4e4;font:12px system-ui,sans-serif}
.dk-editor-top{display:flex;align-items:stretch;min-height:37px;border-bottom:1px solid #303b3e;background:#1c2325;flex-shrink:0;gap:5px}
.dk-editor-tabs{display:flex;align-items:stretch;flex:1;min-width:0;overflow-x:auto;scrollbar-width:thin}
.dk-editor-tab{display:flex;align-items:center;flex-shrink:0;border-right:1px solid #303b3e;border-top:2px solid transparent;background:transparent;max-width:220px;gap:5px}
.dk-editor-tab[aria-selected=true]{background:#171d1f;border-top-color:#c7e98e}
.dk-editor-tab button{border:0;border-radius:0;background:transparent;color:inherit;cursor:pointer;font:inherit}
.dk-editor-tab-name{padding:8px 2px 9px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:175px}
.dk-editor-tab-close{padding:5px 8px!important;color:#8e9b9e!important;font-size:16px!important}
.dk-editor-tab-close:hover{color:#fff!important}.dk-editor-dirty{font-size:13px;color:#c7e98e}
.dk-editor-tab-close .icon{width:12px;height:12px;display:block}.dk-editor-actions button .icon{width:14px;height:14px;display:block}
.dk-editor-actions{margin-left:auto;display:flex;align-items:center;gap:4px;padding:4px 8px;flex-shrink:0}
.dk-editor-actions button{border:1px solid #3d494c;border-radius:5px;color:#dbe4e4;background:transparent;font:inherit;padding:4px 8px;cursor:pointer}
.dk-editor-actions button:hover:not(:disabled){background:#303b3e}.dk-editor-actions button:disabled{opacity:.4;cursor:default}
.dk-html-frame{width:100%;height:100%;border:0;background:white}.dk-editor-area{flex:1;min-height:0;min-width:0;position:relative;overflow:hidden}
.dk-editor-area.dk-diagram-layout{display:flex}.dk-diagram-layout .dk-editor-code{flex:0 0 42%;min-width:180px;border-right:1px solid #303b3e}.dk-editor-diagram{flex:1;min-width:0;min-height:0;overflow:auto;padding:22px;background:#171d1f}
.dk-editor-code{height:100%;min-height:0}.dk-editor-code .cm-editor{height:100%}.dk-editor-code .cm-scroller{overflow:auto}
.dk-editor-preview{height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;text-align:center;padding:24px;box-sizing:border-box;overflow:auto}
.dk-editor-preview p{margin:0;color:#94a2a5;max-width:520px;line-height:1.6}.dk-editor-preview strong{font-size:14px;font-weight:500;overflow-wrap:anywhere;max-width:100%}
.dk-editor-preview img{display:block;max-height:calc(100% - 45px);max-width:100%;object-fit:contain;min-height:0;user-select:none}
.dk-editor-status{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:25px;flex-shrink:0;border-top:1px solid #303b3e;padding:3px 10px;box-sizing:border-box;font-size:10px;color:#92a1a4}
.dk-editor-status-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dk-editor-status-info{white-space:nowrap}
.dk-markdown-visual .cm-content{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif!important;font-size:14px;line-height:1.75;padding:22px 32px;max-width:1000px;margin:auto}.dk-markdown-visual .cm-gutters{display:none}.dk-markdown-visual .cm-line{padding:1px 0}.dk-md-heading{font-weight:650;line-height:1.35;margin-top:.8em;margin-bottom:.25em;color:#eef4e9}.dk-md-heading-1{font-size:1.9em}.dk-md-heading-2{font-size:1.55em}.dk-md-heading-3{font-size:1.3em}.dk-md-heading-4,.dk-md-heading-5,.dk-md-heading-6{font-size:1.1em}.dk-md-strong{font-weight:700}.dk-md-emphasis{font-style:italic}.dk-md-strike{text-decoration:line-through}.dk-md-link{color:#b8d995;text-decoration:underline;text-underline-offset:3px}.dk-md-inline-code{font-family:ui-monospace,monospace;background:#34413b;border-radius:4px;padding:2px 4px;font-size:.9em}.dk-md-bullet{display:inline-block;color:#c7e98e;font-size:1.2em}.dk-md-checkbox{accent-color:#b8d991;margin:0 6px 0 0}.dk-md-quote-line{border-left:3px solid #b8d991;padding-left:14px!important;color:#b5c6ba}.dk-md-table-wrap{overflow:auto;margin:15px 0}.dk-md-table{width:100%;border-collapse:collapse;font:13px/1.5 system-ui,sans-serif}.dk-md-table td,.dk-md-table th{text-align:left;padding:8px 10px;border:1px solid #3a4944;min-width:70px}.dk-md-table th{background:#26342d;color:#e2eadc}.dk-md-table [role=button]{cursor:text}.dk-md-table input{width:100%;background:#151d19;border:1px solid #b8d991;color:#e5eee4;padding:4px;font:inherit}.dk-md-rule{display:block;border-top:1px solid #53615a;margin:18px 0}.dk-md-code-line{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:#202b26;padding-left:12px!important}.dk-md-image{display:block;width:100%;max-width:100%;color:#9aaba0}.dk-md-image img{display:block;max-width:100%;max-height:360px;object-fit:contain;border-radius:5px}.dk-md-diagram{display:block;margin:16px 0;border:1px solid #34423b;border-radius:8px;padding:15px;background:#1c2520}.dk-diagram-canvas{width:100%;overflow:auto;text-align:center}.dk-diagram-canvas svg{max-width:100%;height:auto}.dk-diagram-editable{cursor:pointer}.dk-diagram-editable:hover,.dk-diagram-editable:focus{filter:brightness(1.35);outline:none}.dk-diagram-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 15px}.dk-diagram-form input,.dk-diagram-form select{flex:1;min-width:140px;padding:7px 9px;border:1px solid #b8d991;border-radius:5px;background:#171e1a;color:#e7ede6}.dk-diagram-form button{padding:7px 10px;border:1px solid #536452;border-radius:5px;background:#26352a;color:#e7ede6;cursor:pointer}.dk-diagram-note{font:11px/1.5 system-ui,sans-serif;color:#93a59a;margin:12px 0}.dk-file-editor [hidden]{display:none!important}.dk-file-editor button:focus-visible{outline:2px solid #c7e98e;outline-offset:-2px}
`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; return node;
}
function language(name: string): Extension[] {
  const extension = name.toLowerCase().split('.').pop();
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'].includes(extension ?? '')) return [javascript({ typescript: ['ts', 'mts', 'cts', 'tsx'].includes(extension!), jsx: extension === 'jsx' || extension === 'tsx' })];
  if (extension === 'json' || extension === 'jsonc') return [json()];
  if (extension === 'md' || extension === 'markdown' || extension === 'mdown') return [markdown({ extensions: [GFM] })];
  if (extension === 'html' || extension === 'htm') return [html()];
  if (extension === 'css') return [css()];
  if (extension === 'py') return [python()];
  return [];
}

/** One live view; documents and undo history stay in memory while their tabs are open. */
export class FileEditor {
  private readonly tabs = new Map<string, FileTab>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly recentByProject = new Map<string, string>();
  private readonly tabBar = element('div', 'dk-editor-tabs');
  private readonly codeHost = element('div', 'dk-editor-code');
  private readonly preview = element('div', 'dk-editor-preview');
  private readonly area = element('div', 'dk-editor-area');
  private readonly diagram = element('div', 'dk-editor-diagram');
  private readonly visualMode = new Compartment();
  private readonly imageCache = new Map<string, Promise<string | null>>();
  private readonly modeButton = element('button', '');
  private readonly undoButton = element('button', '');
  private readonly redoButton = element('button', '');
  private diagramTimer: ReturnType<typeof setTimeout> | undefined;
  private diagramKey: string | null = null;
  private readonly pathLabel = element('span', 'dk-editor-status-path');
  private readonly infoLabel = element('span', 'dk-editor-status-info');
  private readonly saveButton = element('button', '');
  private readonly reloadButton = element('button', '');
  private readonly view: EditorView;
  private projectRoot = '';
  private currentKey: string | null = null;
  private workspaceActive = false;
  private viewTabKey: string | null = null;
  private destroyed = false;

  constructor(private readonly host: HTMLElement, private readonly options: EditorOptions) {
    if (!document.getElementById('dk-file-editor-styles')) {
      const style = document.createElement('style'); style.id = 'dk-file-editor-styles'; style.textContent = STYLES; document.head.append(style);
    }
    host.classList.add('dk-file-editor');
    const top = element('div', 'dk-editor-top'), actions = element('div', 'dk-editor-actions');
    this.tabBar.setAttribute('role', 'tablist'); this.tabBar.setAttribute('aria-label', 'Arquivos abertos');
    this.saveButton.textContent = 'Salvar'; this.saveButton.title = 'Salvar arquivo (⌘/Ctrl+S)'; this.saveButton.type = 'button';
    this.reloadButton.textContent = 'Recarregar'; this.reloadButton.title = 'Ler novamente o arquivo do disco'; this.reloadButton.type = 'button';
    this.saveButton.addEventListener('click', () => { void this.saveCurrent(); });
    this.reloadButton.addEventListener('click', () => { void this.reloadCurrent(); });
    this.modeButton.type = 'button'; this.modeButton.addEventListener('click', () => this.toggleMode());
    this.undoButton.type = this.redoButton.type = 'button';
    setIconButton(this.undoButton, 'undo', 'Desfazer', '⌘ Z');
    setIconButton(this.redoButton, 'redo', 'Refazer', '⌘ ⇧ Z');
    this.undoButton.addEventListener('click', () => { undo(this.view); });
    this.redoButton.addEventListener('click', () => { redo(this.view); });
    this.host.addEventListener('keydown', event => {
      if (!(event.target instanceof Element) || !event.target.closest('.dk-editor-diagram, .dk-md-diagram') || event.target instanceof HTMLInputElement) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      event.preventDefault(); event.shiftKey ? redo(this.view) : undo(this.view);
    });
    actions.append(this.undoButton, this.redoButton, this.modeButton, this.reloadButton, this.saveButton); top.append(actions); this.options.tabsHost.append(this.tabBar);
    this.diagram.setAttribute('aria-label', 'Diagrama Mermaid');
    this.area.append(this.codeHost, this.diagram, this.preview);
    const status = element('div', 'dk-editor-status'); status.append(this.pathLabel, this.infoLabel);
    host.replaceChildren(top, this.area, status);
    this.view = new EditorView({ parent: this.codeHost, state: EditorState.create({ extensions: [EditorState.readOnly.of(true)] }) });
    this.render();
  }

  setProject(root: string): void {
    this.projectRoot = root;
    const recent = this.recentByProject.get(root);
    const next = recent && this.tabs.get(recent)?.root === root ? recent : [...this.tabs.values()].find(tab => tab.root === root)?.key;
    this.activate(next ?? null, false);
  }

  setWorkspaceActive(active: boolean): void {
    if (this.workspaceActive === active) return;
    this.workspaceActive = active;
    this.renderTabs();
  }

  async open(root: string, relative: string): Promise<void> {
    if (this.destroyed) return;
    const key = `${root}\0${relative}`;
    this.setProject(root);
    if (this.tabs.has(key)) { this.activate(key); return; }
    const opening = this.pending.get(key); if (opening) return opening;
    if (this.tabs.size + this.pending.size >= MAX_TABS) { this.error(`Você pode manter até ${MAX_TABS} arquivos abertos. Feche uma aba para abrir outro arquivo.`); return; }
    const task = Promise.resolve().then(async () => {
      try {
        const file = await this.options.read(root, relative);
        if (this.destroyed) return;
        const visual = markdownFile(file.name) && (file.content?.length ?? 0) <= 256 * 1024;
        const state = file.kind === 'text' ? this.createState(file, visual, root) : null;
        const tab: FileTab = { key, root, relative, file, state, savedDoc: state?.doc ?? null, dirty: false, visual, showCode: false };
        this.tabs.set(key, tab);
        if (this.projectRoot === root) this.activate(key); else this.renderTabs();
      } catch (error) { this.options.onError(error); }
      finally { this.pending.delete(key); }
    });
    this.pending.set(key, task);
    return task;
  }

  async closeProject(root: string): Promise<boolean> {
    await Promise.allSettled([...this.pending.entries()].filter(([key]) => key.startsWith(root + '\0')).map(([, task]) => task));
    const tabs = [...this.tabs.values()].filter(tab => tab.root === root);
    for (const tab of tabs) if (!await this.allowReplace(tab)) return false;
    for (const tab of tabs) this.tabs.delete(tab.key);
    for (const key of this.imageCache.keys()) if (key.startsWith(root + '\0')) this.imageCache.delete(key);
    this.recentByProject.delete(root); this.emitDirty();
    if (this.projectRoot === root) this.activate(null, false); else this.renderTabs();
    return true;
  }

  clearTemporaryImages(): void { this.imageCache.clear(); }

  hasUnsaved(root?: string): boolean { return [...this.tabs.values()].some(tab => tab.dirty && (!root || tab.root === root)); }

  async saveCurrent(): Promise<boolean> {
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement && this.host.contains(focused) && focused.closest('.dk-md-table-wrap')) focused.blur();
    const tab = this.currentTab(); return tab ? this.saveTab(tab) : true;
  }

  async closeCurrent(): Promise<boolean> {
    const tab = this.currentTab(); return tab ? this.closeTab(tab) : true;
  }

  search(): void {
    if (this.currentTab()?.file.kind === 'text') { openSearchPanel(this.view); this.view.focus(); }
  }

  destroy(): boolean {
    if (this.hasUnsaved()) return false;
    this.destroyed = true; clearTimeout(this.diagramTimer); invalidateMermaid(this.diagram); this.view.destroy(); this.tabs.clear(); this.host.replaceChildren(); this.tabBar.remove(); return true;
  }

  private createState(file: FileData, visual: boolean, root: string): EditorState {
    return EditorState.create({
      doc: file.content ?? '',
      extensions: [basicSetup, oneDark, ...language(file.name), this.visualMode.of(visual && markdownFile(file.name) ? visualMarkdown(file.readOnly, file.relative, relative => this.loadImage(root, relative)) : []), EditorView.lineWrapping, EditorState.readOnly.of(file.readOnly), EditorView.editable.of(!file.readOnly),
        EditorView.theme({ '&': { height: '100%', backgroundColor: '#171d1f' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }, '.cm-gutters': { backgroundColor: '#171d1f', borderRight: '1px solid #273235' } }),
        keymap.of([{ key: 'Mod-s', run: () => { void this.saveCurrent(); return true; } }]),
        EditorView.updateListener.of(update => {
          const tab = this.currentTab(); if (!tab || tab.file.kind !== 'text') return;
          tab.state = update.state;
          if (update.docChanged) {
            if (mermaidFile(tab.file.name)) this.queueDiagram();
            const dirty = !tab.savedDoc?.eq(update.state.doc);
            if (dirty !== tab.dirty) { tab.dirty = dirty; this.emitDirty(); this.renderTabs(); this.renderStatus(); }
            this.renderHistory();
          }
        })]
    });
  }

  getCurrentFile(): { root: string; relative: string } | null { const tab = this.currentTab(); return tab ? { root: tab.root, relative: tab.relative } : null; }

  private currentTab(): FileTab | undefined { return this.currentKey ? this.tabs.get(this.currentKey) : undefined; }

  private activate(key: string | null, focus = true): void {
    const tab = key ? this.tabs.get(key) : undefined;
    this.currentKey = tab?.key ?? null;
    if (tab) this.recentByProject.set(tab.root, tab.key);
    if (tab?.state) { this.view.setState(tab.state); this.viewTabKey = tab.key; }
    else if (this.viewTabKey !== null) {
      // Do not keep the last document and its undo tree alive after it closes
      // or while a non-text preview is displayed. Open tabs retain their own state.
      // Keep CodeMirror's base fields available for any pending blur or
      // completion callback while dropping the old document and undo history.
      this.view.setState(EditorState.create({ extensions: [basicSetup, EditorState.readOnly.of(true)] }));
      this.viewTabKey = null;
    }
    this.render();
    if (focus && tab) this.options.onSelect();
    if (focus && tab?.state && (!mermaidFile(tab.file.name) || tab.showCode) && (!htmlFile(tab.file.name) || tab.showCode)) this.view.focus();
  }

  private render(): void {
    const tab = this.currentTab(), isText = tab?.file.kind === 'text';
    const isDiagram = Boolean(isText && tab && mermaidFile(tab.file.name));
    const isHtmlPreview = Boolean(isText && tab && htmlFile(tab.file.name) && !tab.showCode);
    this.codeHost.hidden = !isText || Boolean(isDiagram && !tab?.showCode) || isHtmlPreview; this.diagram.hidden = !isDiagram; this.preview.hidden = Boolean(isText) && !isHtmlPreview; this.preview.replaceChildren();
    this.preview.classList.toggle('dk-html-preview', isHtmlPreview);
    if (isHtmlPreview && tab) void this.renderHtml(tab);
    this.codeHost.classList.toggle('dk-markdown-visual', Boolean(tab?.visual && isText && markdownFile(tab.file.name)));
    this.area.classList.toggle('dk-diagram-layout', isDiagram);
    this.modeButton.hidden = !tab || !isText || !(markdownFile(tab.file.name) || isDiagram || htmlFile(tab.file.name));
    this.modeButton.disabled = Boolean(tab && markdownFile(tab.file.name) && tab.state && tab.state.doc.length > 256 * 1024);
    this.modeButton.textContent = tab && htmlFile(tab.file.name) ? (tab.showCode ? 'Visual' : 'Código') : isDiagram ? (tab?.showCode ? 'Ocultar código' : 'Código') : tab?.visual ? 'Código' : 'Visual';
    this.modeButton.title = this.modeButton.disabled ? 'Visualização disponível para arquivos de até 256 KB' : isDiagram ? 'Mostrar ou ocultar o código do diagrama' : 'Alternar entre edição visual e código Markdown';
    if (isDiagram) this.queueDiagram(); else { clearTimeout(this.diagramTimer); invalidateMermaid(this.diagram); this.diagram.replaceChildren(); this.diagramKey = null; }
    if (!isText) {
      const title = element('strong', ''); title.textContent = tab?.file.name ?? 'Editor de arquivos'; this.preview.append(title);
      if (tab?.file.kind === 'image' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(tab.file.dataUrl ?? '')) {
        const image = document.createElement('img'); image.src = tab.file.dataUrl!; image.alt = tab.file.name; image.draggable = false; this.preview.append(image);
      } else {
        const message = document.createElement('p'); message.textContent = tab?.file.reason ?? 'Abra um arquivo pela árvore do projeto para visualizar ou editar seu conteúdo.'; this.preview.append(message);
      }
    }
    this.renderTabs(); this.renderStatus();
    if (isText) this.view.requestMeasure();
  }

  private async renderHtml(tab: FileTab): Promise<void> {
    const source = tab.state?.doc.toString() || '';
    const documentView = new DOMParser().parseFromString(source, 'text/html');
    documentView.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv]').forEach(node => node.remove());
    documentView.querySelectorAll('a').forEach(node => node.removeAttribute('href'));
    for (const node of documentView.querySelectorAll('link[rel~="stylesheet"]')) {
      const reference = node.getAttribute('href') || '', target = imagePath(tab.relative, reference);
      if (!target) { node.remove(); continue; }
      try {
        const css = await this.options.read(tab.root, target);
        if (css.kind !== 'text' || !/\.css$/i.test(target) || !css.content) { node.remove(); continue; }
        const style = documentView.createElement('style'); style.textContent = css.content; node.replaceWith(style);
      } catch { node.remove(); }
    }
    for (const node of documentView.querySelectorAll('img[src]')) {
      const target = imagePath(tab.relative, node.getAttribute('src') || '');
      const data = target ? await this.loadImage(tab.root, target) : null;
      if (data) node.setAttribute('src', data); else node.removeAttribute('src');
      node.removeAttribute('srcset');
    }
    if (this.currentTab() !== tab || tab.showCode || tab.state?.doc.toString() !== source) return;
    const policy = documentView.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
    documentView.head.prepend(policy);
    const frame = document.createElement('iframe'); frame.className = 'dk-html-frame'; frame.title = `Visualização de ${tab.file.name}`; frame.setAttribute('sandbox', '');
    frame.srcdoc = '<!doctype html>' + documentView.documentElement.outerHTML;
    this.preview.replaceChildren(frame);
  }

  private loadImage(root: string, relative: string): Promise<string | null> {
    const key = `${root}\0${relative}`;
    let cached = this.imageCache.get(key);
    if (!cached) {
      cached = this.options.read(root, relative).then(async file => {
        if (file.kind === 'image') return file.dataUrl ?? null;
        if (file.kind !== 'text' || !/\.svg$/i.test(relative) || !file.content || file.content.length > 256 * 1024) return null;
        const { default: purify } = await import('dompurify');
        const cleaned = purify.sanitize(file.content, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'iframe', 'script', 'a', 'image', 'style'], FORBID_ATTR: ['href', 'xlink:href', 'style'] });
        return cleaned.includes('<svg') ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cleaned)}` : null;
      }).catch(() => null);
      if (this.imageCache.size >= 4) this.imageCache.delete(this.imageCache.keys().next().value!);
      this.imageCache.set(key, cached);
    }
    return cached;
  }

  private toggleMode(): void {
    const tab = this.currentTab(); if (!tab?.state) return;
    if (mermaidFile(tab.file.name) || htmlFile(tab.file.name)) tab.showCode = !tab.showCode;
    else if (markdownFile(tab.file.name)) {
      tab.visual = !tab.visual;
      this.view.dispatch({ effects: this.visualMode.reconfigure(tab.visual ? visualMarkdown(tab.file.readOnly, tab.relative, relative => this.loadImage(tab.root, relative)) : []) });
    }
    this.render();
    if (!this.codeHost.hidden) this.view.focus();
  }

  private queueDiagram(): void {
    clearTimeout(this.diagramTimer);
    const tab = this.currentTab(); if (!tab?.state || !mermaidFile(tab.file.name)) return;
    if (this.diagramKey !== tab.key) { this.diagram.replaceChildren(); this.diagramKey = tab.key; }
    this.diagram.inert = true;
    invalidateMermaid(this.diagram);
    const source = tab.state.doc.toString();
    this.diagramTimer = setTimeout(() => {
      if (this.currentTab() !== tab || !this.diagram.isConnected) return;
      void renderMermaid(this.diagram, source, updated => {
        if (this.currentTab() !== tab || this.view.state.doc.toString() !== source) return;
        this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: updated }, annotations: isolateHistory.of('full') });
      }, tab.file.readOnly).finally(() => {
        if (this.currentTab() === tab && this.view.state.doc.toString() === source) this.diagram.inert = false;
      });
    }, 220);
  }

  private renderTabs(): void {
    const nodes: HTMLElement[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.root !== this.projectRoot) continue;
      const wrapper = element('div', 'dk-editor-tab'); wrapper.setAttribute('role', 'tab'); wrapper.setAttribute('aria-selected', String(this.workspaceActive && tab.key === this.currentKey)); wrapper.title = tab.relative;
      const name = element('button', 'dk-editor-tab-name'); name.type = 'button'; name.textContent = tab.file.name; name.addEventListener('click', () => this.activate(tab.key));
      const mark = element('span', 'dk-editor-dirty'); mark.textContent = tab.dirty ? '●' : ''; mark.setAttribute('aria-label', tab.dirty ? 'Alterações não salvas' : 'Arquivo salvo');
      const close = element('button', 'dk-editor-tab-close'); close.type = 'button'; setIconButton(close, 'close', `Fechar ${tab.file.name}`); close.addEventListener('click', () => { void this.closeTab(tab); });
      wrapper.append(name, mark, close); nodes.push(wrapper);
    }
    this.tabBar.replaceChildren(...nodes);
  }

  private renderStatus(): void {
    const tab = this.currentTab();
    this.saveButton.disabled = !tab?.dirty || Boolean(tab.file.readOnly || tab.saving);
    this.saveButton.textContent = tab?.saving ? 'Salvando…' : 'Salvar'; this.reloadButton.disabled = !tab || Boolean(tab.saving);
    this.pathLabel.textContent = tab?.relative ?? ''; this.pathLabel.title = tab?.file.path ?? '';
    this.infoLabel.textContent = tab ? [tab.file.readOnly ? 'Somente leitura' : tab.dirty ? 'Não salvo' : 'Salvo', tab.file.kind === 'text' ? `UTF-8${tab.file.bom ? ' BOM' : ''} · ${tab.file.newline === '\r\n' ? 'CRLF' : 'LF'}` : '', `${Math.max(1, Math.round(tab.file.size / 1024))} KB`].filter(Boolean).join(' · ') : '';
    this.renderHistory();
  }

  private renderHistory(): void {
    const tab = this.currentTab();
    this.undoButton.disabled = !tab?.state || tab.file.readOnly || undoDepth(tab.state) === 0;
    this.redoButton.disabled = !tab?.state || tab.file.readOnly || redoDepth(tab.state) === 0;
  }

  private async saveTab(tab: FileTab): Promise<boolean> {
    if (tab.saving) return tab.saving;
    if (!tab.dirty || !tab.state) return true;
    if (tab.file.readOnly || !tab.file.revision) { this.error('Este arquivo está disponível somente para visualização.'); return false; }
    const document = tab.state.doc, expectedRevision = tab.file.revision;
    const task = Promise.resolve().then(async () => {
      try {
        const saved = await this.options.save(tab.root, tab.relative, document.toString(), expectedRevision);
        tab.file = saved; tab.savedDoc = document; tab.dirty = !tab.state!.doc.eq(document); this.emitDirty(); return true;
      } catch (error) { this.options.onError(error); return false; }
      finally { tab.saving = undefined; this.renderTabs(); this.renderStatus(); }
    });
    tab.saving = task; this.renderStatus(); return task;
  }

  private async allowReplace(tab: FileTab): Promise<boolean> {
    if (tab.saving && !await tab.saving) return false;
    if (!tab.dirty) return true;
    const choice = await this.options.confirmClose(tab.file.name);
    if (choice === 'cancel') return false;
    if (choice === 'save') return await this.saveTab(tab) && !tab.dirty;
    return choice === 'discard';
  }

  private async closeTab(tab: FileTab): Promise<boolean> {
    if (tab.closing || !this.tabs.has(tab.key)) return false;
    tab.closing = true;
    try {
      if (!await this.allowReplace(tab)) return false;
      this.tabs.delete(tab.key); this.emitDirty();
      if (this.currentKey === tab.key) {
        const next = [...this.tabs.values()].filter(candidate => candidate.root === this.projectRoot).at(-1);
        this.activate(next?.key ?? null, this.workspaceActive);
        if (!next) this.options.onEmpty();
      } else this.renderTabs();
      return true;
    } catch (error) { this.options.onError(error); return false; }
    finally { tab.closing = false; }
  }

  private async reloadCurrent(): Promise<void> {
    const tab = this.currentTab(); if (!tab || tab.closing) return;
    tab.closing = true;
    try {
      if (!await this.allowReplace(tab)) return;
      this.imageCache.clear();
      const before = tab.state?.doc;
      const file = await this.options.read(tab.root, tab.relative);
      if (this.destroyed || !this.tabs.has(tab.key)) return;
      if (before && !before.eq(tab.state!.doc)) { this.error('O arquivo recebeu novas alterações durante a leitura. Seu conteúdo foi mantido.'); return; }
      tab.file = file; tab.visual = markdownFile(file.name) && (file.content?.length ?? 0) <= 256 * 1024 && tab.visual; tab.state = file.kind === 'text' ? this.createState(file, tab.visual, tab.root) : null; tab.savedDoc = tab.state?.doc ?? null; tab.dirty = false; this.emitDirty();
      if (this.currentKey === tab.key) this.activate(tab.key); else this.renderTabs();
    } catch (error) { this.options.onError(error); }
    finally { tab.closing = false; }
  }

  private emitDirty(): void { this.options.onDirty([...this.tabs.values()].filter(tab => tab.dirty).map(tab => tab.file.path)); }
  private error(message: string): void { this.options.onError(new Error(message)); }
}
