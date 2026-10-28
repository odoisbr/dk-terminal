/** Locate a flowchart node's declaration without rewriting the surrounding Mermaid source. */
export type NodeLabel = { from: number; to: number; value: string; insert: boolean };
const shapes: [string, string][] = [
  ['[[', ']]'], ['((', '))'], ['{{', '}}'], ['([', '])'], ['[(', ')]'], ['[/', '/]'], ['[\\', '\\]'],
  ['[', ']'], ['(', ')'], ['{', '}'],
];
function decodeLabel(value: string) {
  return value.replace(/^"([\s\S]*)"$/, '$1').replace(/#quot;/gi, '"').replace(/#lt;/gi, '<').replace(/#gt;/gi, '>').replace(/#amp;/gi, '&');
}
function encodeLabel(value: string) {
  return value.replace(/\s+/g, ' ').trim().replace(/&/g, '#amp;').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
}
function diagramOffset(source: string, header: RegExp): number {
  let offset = 0, first = true, frontmatter = false;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (first && !trimmed) { offset += line.length + 1; continue; }
    if (first && trimmed === '---') { frontmatter = true; first = false; offset += line.length + 1; continue; }
    first = false;
    if (frontmatter) { if (trimmed === '---') frontmatter = false; offset += line.length + 1; continue; }
    if (header.test(line)) return offset;
    offset += line.length + 1;
  }
  return -1;
}
export function findNodeLabel(source: string, id: string): NodeLabel | null {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(id)) return null;
  const headerOffset = diagramOffset(source, /^\s*(?:graph|flowchart)(?:\s+(?:TD|TB|BT|RL|LR))?\s*(?:;|$)/i);
  if (headerOffset < 0) return null;
  const safeId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Newer shape metadata needs a structural parser to edit safely; keep it in code mode.
  if (new RegExp(`(^|[^A-Za-z0-9_-])${safeId}\\s*@\\s*\\{`).test(source.slice(headerOffset))) return null;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])(${safeId})(?=$|[^A-Za-z0-9_-]|-->|---|==>|-\\.->)`, 'g');
  let bare: NodeLabel | null = null, declared: NodeLabel | null = null, offset = 0;
  for (const originalLine of source.split('\n')) {
    let line = originalLine, lineOffset = offset;
    offset += originalLine.length + 1;
    if (lineOffset < headerOffset) continue;
    if (lineOffset === headerOffset) {
      const separator = line.indexOf(';');
      if (separator < 0) continue;
      line = line.slice(separator + 1); lineOffset += separator + 1;
    }
    if (/^\s*(?:%%|classDef\b|class\b|style\b|linkStyle\b|subgraph\b|end\b|direction\b|click\b)/i.test(line)) continue;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) {
      const startIndex = match.index + match[1].length;
      let quoted = false, escaped = false, pipe = false;
      const stack: string[] = [];
      for (const char of line.slice(0, startIndex)) {
        if (escaped) { escaped = false; continue; }
        if (char === '\\' && quoted) { escaped = true; continue; }
        if (char === '"') { quoted = !quoted; continue; }
        if (quoted) continue;
        if ('[({'.includes(char)) stack.push(char);
        else if ('])}'.includes(char) && stack.length) stack.pop();
        else if (char === '|' && !stack.length) pipe = !pipe;
      }
      if (quoted || pipe || stack.length) continue;
      const after = startIndex + id.length;
      const shape = shapes.find(([open]) => line.startsWith(open, after));
      if (!shape) {
        if (!line.startsWith('@{', after) && !bare) bare = { from: lineOffset + after, to: lineOffset + after, value: id, insert: true };
        continue;
      }
      const [open, close] = shape, start = after + open.length;
      let quote = false, labelEscaped = false;
      for (let i = start; i < line.length; i++) {
        const char = line[i];
        if (labelEscaped) { labelEscaped = false; continue; }
        if (char === '\\' && quote) { labelEscaped = true; continue; }
        if (char === '"') { quote = !quote; continue; }
        if (!quote && line.startsWith(close, i)) { declared = { from: lineOffset + start, to: lineOffset + i, value: decodeLabel(line.slice(start, i)), insert: false }; break; }
      }
    }
  }
  return declared || bare;
}
export function changeNodeLabel(source: string, id: string, value: string): string | null {
  const node = findNodeLabel(source, id), text = encodeLabel(value);
  if (!node || !text || text.length > 500) return null;
  const replacement = node.insert ? `["${text}"]` : `"${text}"`;
  return source.slice(0, node.from) + replacement + source.slice(node.to);
}

export function addConnectedNode(source: string, id: string, label: string): string | null {
  if (!findNodeLabel(source, id)) return null;
  const text = encodeLabel(label); if (!text || text.length > 500) return null;
  let number = 1; while (new RegExp(`(?:^|[^A-Za-z0-9_-])dk_${number}(?:$|[^A-Za-z0-9_-])`).test(source)) number++;
  const prefix = source.endsWith('\n') ? '' : '\n';
  return `${source}${prefix}  ${id} --> dk_${number}["${text}"]\n`;
}
export function connectNodes(source: string, from: string, to: string): string | null {
  if (!findNodeLabel(source, from) || !findNodeLabel(source, to)) return null;
  return `${source}${source.endsWith('\n') ? '' : '\n'}  ${from} --> ${to}\n`;
}
export type SequenceLabel = { from: number; to: number; value: string; kind: 'actor' | 'message'; insert: boolean };
export function sequenceLabels(source: string): SequenceLabel[] {
  const headerOffset = diagramOffset(source, /^\s*sequenceDiagram\b/i);
  if (headerOffset < 0) return [];
  const result: SequenceLabel[] = [];
  let offset = 0;
  for (const line of source.split('\n')) {
    if (offset <= headerOffset) { offset += line.length + 1; continue; }
    const actor = /^(\s*(?:participant|actor)\s+)([A-Za-z0-9_][A-Za-z0-9_-]*)(?:\s+as\s+(.+?))?\s*$/i.exec(line);
    if (actor) {
      const value = actor[3] || actor[2];
      const start = actor[3] ? line.indexOf(actor[3], actor[1].length + actor[2].length) : actor[1].length + actor[2].length;
      result.push({ from: offset + start, to: offset + start + (actor[3]?.length || 0), value: decodeLabel(value), kind: 'actor', insert: !actor[3] });
    } else if (!/^\s*%%/.test(line)) {
      const colon = line.indexOf(':');
      const left = colon < 0 ? '' : line.slice(0, colon);
      if (colon >= 0 && /(?:--?>>|--?>|--?x|--?\)|<<--?>>)/.test(left)) {
        const rest = line.slice(colon + 1), content = rest.trim();
        if (content) { const start = colon + 1 + rest.indexOf(content); result.push({ from: offset + start, to: offset + start + content.length, value: decodeLabel(content), kind: 'message', insert: false }); }
      }
    }
    offset += line.length + 1;
  }
  return result;
}
export function changeSequenceLabel(source: string, item: SequenceLabel, label: string): string | null {
  const text = encodeLabel(label); if (!text || text.length > 500) return null;
  return source.slice(0, item.from) + (item.insert ? ` as ${text}` : text) + source.slice(item.to);
}
