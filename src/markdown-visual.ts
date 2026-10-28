import { StateField, type Extension, type Range } from '@codemirror/state';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { renderMermaid } from './mermaid-view';

class Bullet extends WidgetType {
  toDOM() { const element = document.createElement('span'); element.className = 'dk-md-bullet'; element.textContent = '•'; return element; }
  ignoreEvent() { return false; }
}
class HorizontalRule extends WidgetType {
  toDOM() { const rule = document.createElement('span'); rule.className = 'dk-md-rule'; rule.setAttribute('aria-hidden', 'true'); return rule; }
}
class LocalImage extends WidgetType {
  constructor(private readonly path: string, private readonly alt: string, private readonly load: (path: string) => Promise<string | null>) { super(); }
  eq(other: LocalImage) { return this.path === other.path && this.alt === other.alt; }
  toDOM(view: EditorView) {
    const wrapper = document.createElement('span'); wrapper.className = 'dk-md-image';
    const label = document.createElement('span'); label.textContent = this.alt || 'Imagem'; wrapper.append(label);
    void this.load(this.path).then(data => {
      if (!wrapper.isConnected || !data || !/^data:image\/(?:(?:png|jpeg|gif|webp);base64,|svg\+xml;charset=utf-8,)/.test(data)) return;
      const image = document.createElement('img'); image.onload = () => view.requestMeasure(); image.src = data; image.alt = this.alt; image.draggable = false; wrapper.replaceChildren(image);
    }).catch(() => {});
    return wrapper;
  }
}
export function imagePath(documentPath: string, reference: string): string | null {
  try {
    let value = reference.replace(/^<|>$/g, '').split(/[?#]/, 1)[0];
    value = decodeURIComponent(value);
    if (!value || value.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.includes('\\')) return null;
    const parts = value.startsWith('/') ? [] : documentPath.split('/').slice(0, -1);
    for (const part of value.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
    }
    return parts.length ? parts.join('/') : null;
  } catch { return null; }
}
class Task extends WidgetType {
  constructor(private readonly from: number, private readonly checked: boolean, private readonly readOnly: boolean) { super(); }
  eq(other: Task) { return this.from === other.from && this.checked === other.checked && this.readOnly === other.readOnly; }
  toDOM(view: EditorView) {
    const input = document.createElement('input'); input.type = 'checkbox'; input.className = 'dk-md-checkbox'; input.checked = this.checked; input.disabled = this.readOnly; input.setAttribute('aria-label', 'Marcar tarefa');
    input.addEventListener('change', () => {
      const current = view.state.doc.sliceString(this.from, this.from + 3);
      if (!/^\[[ xX]\]$/.test(current)) return;
      view.dispatch({ changes: { from: this.from, to: this.from + 3, insert: input.checked ? '[x]' : '[ ]' }, annotations: isolateHistory.of('full') });
    });
    return input;
  }
}
type Cell = { from: number; to: number; value: string };
class Table extends WidgetType {
  constructor(private readonly rows: Cell[][], private readonly readOnly: boolean) { super(); }
  eq(other: Table) { return this.readOnly === other.readOnly && JSON.stringify(this.rows) === JSON.stringify(other.rows); }
  toDOM(view: EditorView) {
    const wrapper = document.createElement('div'); wrapper.className = 'dk-md-table-wrap';
    const table = document.createElement('table'); table.className = 'dk-md-table';
    this.rows.forEach((cells, index) => {
      const row = document.createElement('tr');
      for (const cell of cells) {
        const value = document.createElement(index === 0 ? 'th' : 'td');
        value.textContent = cell.value.replace(/\\\|/g, '|');
        if (!this.readOnly) {
          value.tabIndex = 0; value.setAttribute('role', 'button'); value.setAttribute('aria-label', `Editar célula ${value.textContent || 'vazia'}`);
          const edit = () => {
            if (value.querySelector('input')) return;
            const field = document.createElement('input'); field.value = cell.value.replace(/\\\|/g, '|'); field.setAttribute('aria-label', 'Conteúdo da célula');
            value.replaceChildren(field); field.focus(); field.select();
            const commit = () => {
              if (!field.isConnected) return;
              const text = field.value.replace(/[\r\n]/g, ' ').replace(/(?<!\\)\|/g, '\\|');
              if (view.state.doc.sliceString(cell.from, cell.to) === cell.value) view.dispatch({ changes: { from: cell.from, to: cell.to, insert: text }, annotations: isolateHistory.of('full') });
              else value.textContent = cell.value;
            };
            field.addEventListener('blur', commit, { once: true });
            field.addEventListener('keydown', event => {
              if (event.key === 'Enter') { event.preventDefault(); commit(); view.focus(); }
              if (event.key === 'Escape') { event.preventDefault(); value.textContent = cell.value; view.focus(); }
            });
          };
          value.addEventListener('click', edit);
          value.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); edit(); } });
        }
        row.append(value);
      }
      table.append(row);
    });
    wrapper.append(table); return wrapper;
  }
}
class Diagram extends WidgetType {
  constructor(private readonly code: string, private readonly from: number, private readonly to: number, private readonly readOnly: boolean) { super(); }
  eq(other: Diagram) { return this.code === other.code && this.from === other.from && this.to === other.to && this.readOnly === other.readOnly; }
  toDOM(view: EditorView) {
    const host = document.createElement('div'); host.className = 'dk-md-diagram'; host.setAttribute('aria-label', 'Diagrama Mermaid');
    requestAnimationFrame(() => { void renderMermaid(host, this.code, updated => {
      if (view.state.doc.sliceString(this.from, this.to) !== this.code) return;
      view.dispatch({ changes: { from: this.from, to: this.to, insert: updated }, annotations: isolateHistory.of('full') });
    }, this.readOnly).finally(() => { if (host.isConnected) view.requestMeasure(); }); });
    return host;
  }
}
export function visualMarkdown(readOnly: boolean, documentPath: string, loadImage: (path: string) => Promise<string | null>): Extension {
  const hidden = Decoration.replace({});
  const field = StateField.define<DecorationSet>({
    create(state) { return build(state); },
    update(previous, transaction) { return transaction.docChanged || syntaxTree(transaction.startState) !== syntaxTree(transaction.state) ? build(transaction.state) : previous; },
    provide: item => EditorView.decorations.from(item),
  });
  function build(state: Parameters<typeof syntaxTree>[0]): DecorationSet {
    const ranges: Range<Decoration>[] = [];
    const add = (decoration: Decoration, from: number, to = from) => ranges.push(decoration.range(from, to));
    if (state.doc.length > 256 * 1024) return Decoration.none;
    (ensureSyntaxTree(state, state.doc.length, 20) || syntaxTree(state)).iterate({ enter(node) {
      if (node.name === 'Image') {
        const marks = node.node.getChildren('LinkMark'), url = node.node.getChild('URL');
        if (marks.length >= 2 && url) {
          const reference = state.doc.sliceString(url.from, url.to), target = imagePath(documentPath, reference);
          const alt = state.doc.sliceString(marks[0].to, marks[1].from);
          if (target) add(Decoration.replace({ widget: new LocalImage(target, alt, loadImage) }), node.from, node.to);
          else add(Decoration.replace({ widget: new LocalImage('', alt || 'Imagem externa', async () => null) }), node.from, node.to);
          return false;
        }
      }
      if (node.name === 'HorizontalRule') { add(Decoration.replace({ widget: new HorizontalRule() }), node.from, node.to); return false; }
      if (node.name === 'FencedCode') {
        const info = node.node.getChild('CodeInfo'), code = node.node.getChild('CodeText');
        if (info && code && state.doc.sliceString(info.from, info.to).trim().toLowerCase() === 'mermaid') {
          add(Decoration.replace({ block: true, widget: new Diagram(state.doc.sliceString(code.from, code.to), code.from, code.to, readOnly) }), node.from, node.to);
          return false;
        }
        let line = state.doc.lineAt(node.from);
        for (let count = 0; line.from <= node.to && count < 2000; count++) {
          add(Decoration.line({ class: 'dk-md-code-line' }), line.from);
          if (line.number === state.doc.lines || line.to >= node.to) break;
          line = state.doc.line(line.number + 1);
        }
        for (const mark of node.node.getChildren('CodeMark')) add(hidden, mark.from, mark.to);
        if (info) add(hidden, info.from, info.to);
        return false;
      }
      if (node.name === 'Table') {
        const rows: Cell[][] = [];
        for (let row = node.node.firstChild; row; row = row.nextSibling) {
          if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
          rows.push(row.getChildren('TableCell').map(cell => ({ from: cell.from, to: cell.to, value: state.doc.sliceString(cell.from, cell.to) })));
        }
        if (rows.length && rows.every(row => row.length)) { add(Decoration.replace({ block: true, widget: new Table(rows, readOnly) }), node.from, node.to); return false; }
      }
      const heading = node.name.match(/^ATXHeading([1-6])$/);
      if (heading) add(Decoration.line({ class: `dk-md-heading dk-md-heading-${heading[1]}` }), state.doc.lineAt(node.from).from);
      if (node.name === 'Blockquote') add(Decoration.line({ class: 'dk-md-quote-line' }), state.doc.lineAt(node.from).from);
      if (node.name === 'StrongEmphasis') add(Decoration.mark({ class: 'dk-md-strong' }), node.from, node.to);
      if (node.name === 'Emphasis') add(Decoration.mark({ class: 'dk-md-emphasis' }), node.from, node.to);
      if (node.name === 'Strikethrough') add(Decoration.mark({ class: 'dk-md-strike' }), node.from, node.to);
      if (node.name === 'InlineCode') add(Decoration.mark({ class: 'dk-md-inline-code' }), node.from, node.to);
      if (node.name === 'Link') {
        const marks = node.node.getChildren('LinkMark');
        if (marks.length >= 4) {
          add(Decoration.mark({ class: 'dk-md-link' }), marks[0].to, marks[1].from);
          add(hidden, marks[0].from, marks[0].to); add(hidden, marks[1].from, marks[marks.length - 1].to);
          return false;
        }
      }
      if (node.name === 'HeaderMark') {
        let end = node.to; if (state.doc.sliceString(end, end + 1) === ' ') end++;
        add(hidden, node.from, end);
      } else if (node.name === 'EmphasisMark' || node.name === 'StrikethroughMark' || node.name === 'CodeMark' && node.node.parent?.name === 'InlineCode') add(hidden, node.from, node.to);
      else if (node.name === 'ListMark' && /^[*+-]$/.test(state.doc.sliceString(node.from, node.to))) add(Decoration.replace({ widget: new Bullet() }), node.from, node.to);
      else if (node.name === 'TaskMarker') add(Decoration.replace({ widget: new Task(node.from, /x/i.test(state.doc.sliceString(node.from, node.to)), readOnly) }), node.from, node.to);
      else if (node.name === 'QuoteMark') add(hidden, node.from, node.to);
    }});
    return Decoration.set(ranges, true);
  }
  return field;
}
