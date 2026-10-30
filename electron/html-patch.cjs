'use strict';

// M3-a: offsets are UTF-16 offsets into doc.text, never byte offsets. The only
// serialization is UTF-8 encoding; parse5 is an oracle, not a writer.
// applyEdit is trusted history replay: it only accepts edits produced by apply
// or invert in this same session. It does not revalidate operation values (undo
// may restore original unsafe values); never pass caller-supplied patches.
const { Parser, Tokenizer, parseFragment, defaultTreeAdapter } = require('parse5');
const { posix } = require('node:path');
const { performance } = require('node:perf_hooks');

const LIMITS = Object.freeze({ document: 2 * 1024 * 1024, text: 64 * 1024, attr: 1024, css: 128, image: 4 * 1024 * 1024 });
const REASONS = Object.freeze(Object.fromEntries([
  'no-target', 'not-leaf', 'raw-context', 'foreign', 'template', 'clone', 'implicit',
  'attr-not-allowed', 'attr-duplicated-in-source', 'value-invalid', 'css-unparseable',
  'css-duplicate', 'path-outside', 'image-missing', 'too-large', 'verify-bytes', 'verify-tree', 'stale-gen',
  'too-deep', 'too-many-attributes', 'too-many-nodes', 'too-complex', 'author-node-on-implicit',
].map(reason => [reason, reason])));
const PARSE_LIMITS = Object.freeze({ depth: 512, attributes: 256, elements: 200000, nodes: 600000, ms: 1500 });
// Linear equivalent of value.match(/\s*!\s*important$/i)?.[0] || '' (the regex
// is quadratic on long whitespace runs in author styles).
function importantSuffix(value) {
  if (value.length < 10 || value.slice(-9).toLowerCase() !== 'important') return '';
  let index = value.length - 9;
  while (index > 0 && /\s/.test(value[index - 1])) index -= 1;
  if (index === 0 || value[index - 1] !== '!') return '';
  index -= 1;
  while (index > 0 && /\s/.test(value[index - 1])) index -= 1;
  return value.slice(index);
}
const HTML = 'http://www.w3.org/1999/xhtml';
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
const GLOBAL_ATTRS = ['id', 'class', 'title', 'lang', 'dir', 'hidden', 'role', 'aria-label'];
const states = new WeakMap();
const fail = reason => ({ ok: false, reason });
function error(reason) { return Object.assign(new Error(reason), { reason, code: reason }); }
const normalizeEOL = text => text.replace(/\r\n?/g, '\n');
const escapeText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = text => escapeText(text).replace(/"/g, '&quot;');
const validString = value => typeof value === 'string' && value.isWellFormed() && !/[\0\r]/.test(value);
const attrValue = (element, name) => element.attrs.find(a => a.name === name && !a.namespace)?.value;

// parse5 7.3.0 hooks: abort while tokenizing/building, before quadratic work
// can accumulate. Count source attributes, including duplicates and end tags,
// before parse5 performs its linear duplicate-name lookup. Raw text/comments
// never produce these events. Keep the classes stable across reparses.
class SourceTokenizer extends Tokenizer {
  prepareToken(token) {
    this.options.parseBudget.tick(); // Includes ignored start/end tags and comments.
    super.prepareToken(token);
  }
  _emitCurrentCharacterToken(location) {
    if (this.currentCharacterToken) this.options.parseBudget.tick();
    super._emitCurrentCharacterToken(location);
  }
  _createAttr(first) {
    if (this.attributeToken !== this.currentToken) {
      this.attributeToken = this.currentToken;
      this.attributeCount = 0;
    }
    if (++this.attributeCount > this.options.parseLimits.attributes) throw error('too-many-attributes');
    super._createAttr(first);
  }
}
class SourceParser extends Parser {
  constructor(options) {
    super(options);
    this.tokenizer = new SourceTokenizer(this.options, this);
    this.declarationsD7 = [];
  }
  onItemPush(node, tid, isTop) {
    this.options.parseBudget.tick();
    if (this.openElements.stackTop + 1 >= this.options.parseLimits.depth) throw error('too-deep');
    super.onItemPush(node, tid, isTop);
  }
  onStartTag(token) {
    // Ignored frameset/charset tags still matter to D7.
    if (['meta', 'frameset', 'plaintext'].includes(token.tagName)) this.declarationsD7.push({ tagName: token.tagName, attrs: token.attrs });
    super.onStartTag(token);
  }
}

// The clock is a dependency of the private parser, not an addition to the
// public API. Tests inject performance.now through node:test's scoped mocks.
function parseSource(text, served = false, now = () => performance.now()) {
  const started = now();
  let events = 0;
  const parseBudget = {
    check() { if (now() - started > PARSE_LIMITS.ms) throw error('too-complex'); },
    tick() { if (++events % 1024 === 0) this.check(); },
  };
  // Adoption-agency clones share the token's attrs array, including clones
  // without sourceCodeLocation. Count creations, not just surviving locations.
  const origins = new WeakMap();
  const errors = new Set();
  const adoptedNames = new WeakMap();
  let creations = 0, nodesCreated = 0;
  // The served copy adds one attribute per source tag and one bridge element.
  // Its script can also occupy one extra open-element slot at EOF and creates
  // at most two nodes (the script element and its text).
  const parseLimits = served ? { depth: PARSE_LIMITS.depth + 1, attributes: PARSE_LIMITS.attributes + 1,
    elements: PARSE_LIMITS.elements + 1, nodes: PARSE_LIMITS.nodes + 2 } : PARSE_LIMITS;
  function countNode() {
    parseBudget.tick();
    if (++nodesCreated > parseLimits.nodes) throw error('too-many-nodes');
  }
  const treeAdapter = {
    ...defaultTreeAdapter,
    createElement(tag, ns, attrs) {
      countNode();
      if (++creations > parseLimits.elements) throw error('too-many-nodes');
      const element = defaultTreeAdapter.createElement(tag, ns, attrs);
      origins.set(attrs, (origins.get(attrs) || 0) + 1);
      return element;
    },
    createCommentNode(data) {
      countNode();
      return defaultTreeAdapter.createCommentNode(data);
    },
    createTextNode(value) {
      countNode();
      return defaultTreeAdapter.createTextNode(value);
    },
    appendChild(parent, node) {
      parseBudget.tick();
      defaultTreeAdapter.appendChild(parent, node);
    },
    detachNode(node) {
      parseBudget.tick();
      defaultTreeAdapter.detachNode(node);
    },
    insertBefore(parent, node, reference) {
      parseBudget.tick();
      // Foster parenting repeatedly inserts just before the last table. A
      // search from the start costs O(siblings) for every insertion/token.
      const index = parent.childNodes.lastIndexOf(reference);
      parent.childNodes.splice(index, 0, node);
      node.parentNode = parent;
    },
    insertText(parent, text) {
      parseBudget.tick();
      const previous = parent.childNodes.at(-1);
      if (previous?.nodeName === '#text') previous.value += text;
      else treeAdapter.appendChild(parent, treeAdapter.createTextNode(text));
    },
    insertTextBefore(parent, text, reference) {
      parseBudget.tick();
      const index = parent.childNodes.lastIndexOf(reference);
      const previous = parent.childNodes[index - 1];
      if (previous?.nodeName === '#text') previous.value += text;
      else {
        const node = treeAdapter.createTextNode(text);
        parent.childNodes.splice(index, 0, node);
        node.parentNode = parent;
      }
    },
    adoptAttributes(recipient, attrs) {
      parseBudget.tick();
      let names = adoptedNames.get(recipient);
      if (!names) {
        names = new Set(recipient.attrs.map(attr => attr.name));
        adoptedNames.set(recipient, names);
      }
      for (const attr of attrs) {
        if (names.has(attr.name)) continue;
        if (names.size >= parseLimits.attributes) throw error('too-many-attributes');
        // There is no source tag on which to put our winning ID. Refuse now,
        // instead of letting an author's late ID masquerade as instrumentation.
        if (attr.name === 'data-dk-node' && !recipient.sourceCodeLocation?.startTag) throw error('author-node-on-implicit');
        names.add(attr.name);
        recipient.attrs.push(attr);
      }
    },
  };
  const parser = new SourceParser({ sourceCodeLocationInfo: true, scriptingEnabled: true, treeAdapter, parseLimits, parseBudget,
    onParseError: e => errors.add(e.code) });
  parser.tokenizer.write(text, true);
  parseBudget.check();
  const tree = parser.document;
  const all = [], comments = [], doctypes = [];
  const sourceTags = new Map();
  const stack = [{ element: tree, parent: -1, template: false, foreign: false }];
  while (stack.length) {
    const item = stack.pop(), e = item.element;
    let parent = item.parent;
    let template = item.template, foreign = item.foreign;
    if (e.tagName) {
      template ||= e.tagName === 'template' && e.namespaceURI === HTML;
      foreign ||= e.namespaceURI !== HTML;
      const location = e.sourceCodeLocation?.startTag;
      const clone = origins.get(e.attrs) > 1;
      const readonly = clone ? 'clone' : !location ? 'implicit' : template ? 'template' : foreign ? 'foreign' : null;
      parent = all.length;
      const entry = { element: e, parent: item.parent, template, foreign, readonly, location };
      all.push(entry);
      if (location) {
        const first = sourceTags.get(location.startOffset);
        if (first) first.readonly = entry.readonly = 'clone';
        else sourceTags.set(location.startOffset, entry);
      }
    } else if (e.nodeName === '#comment') comments.push(e.sourceCodeLocation);
    else if (e.nodeName === '#documentType') doctypes.push([e.name, e.publicId, e.systemId]);
    const children = e.content ? e.content.childNodes : e.childNodes || [];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ element: children[i], parent, template, foreign });
  }
  return { tree, all, comments, doctypes, errors, declarationsD7: parser.declarationsD7 };
}

function eolInfo(text) {
  let lf = false, crlf = false, loneCR = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { if (text[i - 1] === '\r') crlf = true; else lf = true; }
    if (text[i] === '\r' && text[i + 1] !== '\n') loneCR = true;
  }
  return { eol: lf && crlf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none', loneCR };
}

function refusal(reason) { return { ok: false, reason, message: reason }; }
function prepare(bytes, { relative = 'document.html' } = {}) {
  if (typeof relative !== 'string' || !/\.html?$/i.test(relative)) return refusal('extensao-nao-html');
  if (!Buffer.isBuffer(bytes)) return refusal('nao-utf8');
  if (bytes.length > LIMITS.document) return refusal('documento-maior-2-mib');
  const bom = bytes.subarray(0, 3).equals(BOM);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bom ? 3 : 0)); }
  catch { return refusal('nao-utf8'); }
  if (text.includes('\0')) return refusal('nul');
  let state;
  try { state = parseSource(text); }
  catch (e) {
    if (Object.hasOwn(REASONS, e.reason)) return refusal(e.reason);
    throw e;
  }
  const { all, comments, errors } = state;
  // Only actual HTML comments exempt server markers. A bogus <? comment, a
  // comment-looking string in an attribute or raw text is not an exemption.
  const ranges = comments.filter(c => c && text.startsWith('<!--', c.startOffset)).sort((a, b) => a.startOffset - b.startOffset);
  let cursor = 0;
  for (const range of [...ranges, { startOffset: text.length, endOffset: text.length }]) {
    if (/<[?%]/.test(text.slice(cursor, range.startOffset))) return refusal('instrucao-servidor');
    cursor = range.endOffset;
  }
  for (const e of state.declarationsD7) {
    if (e.tagName === 'meta') {
      const charset = attrValue(e, 'charset');
      const content = attrValue(e, 'content') || '';
      const httpCharset = (attrValue(e, 'http-equiv') || '').trim().toLowerCase() === 'content-type'
        ? content.match(/charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;]*))/i) : null;
      if ((charset !== undefined && charset.trim().toLowerCase() !== 'utf-8') ||
          (httpCharset && (httpCharset[1] ?? httpCharset[2] ?? httpCharset[3]).trim().toLowerCase() !== 'utf-8')) return refusal('meta-charset-nao-utf8');
    }
    if (e.tagName === 'frameset' || e.tagName === 'plaintext') return refusal(e.tagName);
  }
  for (const { element: e } of all) {
    if (e.namespaceURI !== HTML) continue;
    if (RAW.has(e.tagName) && e.sourceCodeLocation?.startTag && !e.sourceCodeLocation.endTag) {
      return refusal(['title', 'textarea'].includes(e.tagName) ? 'rcdata-aberto' : 'rawtext-aberto');
    }
  }
  if (errors.has('eof-in-comment')) return refusal('comentario-aberto');
  const nodes = [], byId = new Map(), sourceIds = new Map();
  for (let index = 0; index < all.length; index++) {
    const entry = all[index];
    if (!entry.location) continue; // Implicit nodes have no source identity / ID.
    const { element: e, location, readonly } = entry;
    // Reconstruction copies the token's location. Identity belongs to its
    // source start tag, so every reconstructed occurrence inherits the same ID.
    if (sourceIds.has(location.startOffset)) continue;
    const node = Object.freeze({ id: nodes.length + 1, tag: e.tagName, ns: e.namespaceURI,
      start: location.startOffset, end: location.endOffset, editable: !readonly, readonly });
    nodes.push(node);
    sourceIds.set(location.startOffset, node.id);
    byId.set(node.id, { ...entry, node, index });
  }
  const scripts = all.filter(({ element: e }) => e.tagName === 'script').length;
  const handlers = all.reduce((n, { element: e }) => n + e.attrs.filter(a => /^on/i.test(a.name)).length, 0);
  const warnings = [];
  if (all.some(({ element: e }) => e.tagName === 'base' && e.namespaceURI === HTML)) warnings.push('base');
  const interpolation = text.indexOf('{{');
  if (interpolation !== -1 && text.indexOf('}}', interpolation + 2) !== -1) warnings.push('interpolacao');
  if (scripts || handlers) warnings.push('scripts');
  const doc = Object.freeze({ bom, text, ...eolInfo(text), nodes: Object.freeze(nodes), warnings: Object.freeze(warnings), scripts, handlers });
  states.set(doc, { ...state, relative, byId });
  return { ok: true, doc };
}

function stateOf(doc) { const state = states.get(doc); if (!state) throw error('stale-gen'); return state; }
function encode(doc) { stateOf(doc); return Buffer.from((doc.bom ? '\uFEFF' : '') + doc.text, 'utf8'); }
function targetOf(doc, node) { return stateOf(doc).byId.get(Number.isSafeInteger(node) ? node : node?.id); }

// Scan a located start tag, retaining *every* attribute (parse5 drops duplicate
// attributes). Offsets include quotes, but not surrounding whitespace.
function sourceAttrs(doc, target) {
  const { start, end } = target.node, text = doc.text;
  const name = text.slice(start, end).match(/^<[^\t\n\f\r />]+/);
  if (!name) throw error('verify-tree');
  const attrs = [];
  let i = start + name[0].length;
  const nameEnd = i;
  while (i < end) {
    while (/[\t\n\f\r /]/.test(text[i] || '') && i < end) i++;
    if (i >= end || text[i] === '>') break;
    const a = i;
    while (i < end && !/[\t\n\f\r />=]/.test(text[i])) i++;
    if (i === a) i++; // HTML also accepts a leading '=' in an attribute name.
    const nameEndAttr = i;
    while (i < end && /[\t\n\f\r ]/.test(text[i])) i++;
    let valueStart = i, valueEnd = i, quote = '';
    if (text[i] === '=') {
      i++;
      while (i < end && /[\t\n\f\r ]/.test(text[i])) i++;
      quote = /["']/.test(text[i] || '') ? text[i++] : '';
      valueStart = i;
      while (i < end && (quote ? text[i] !== quote : !/[\t\n\f\r >]/.test(text[i]))) i++;
      valueEnd = i;
      if (quote && text[i] === quote) i++;
    } else i = nameEndAttr;
    attrs.push({ name: text.slice(a, nameEndAttr).toLowerCase(), start: a, end: i, valueStart, valueEnd, quote });
  }
  return { attrs, nameEnd };
}

function leafValue(doc, target) {
  const loc = target.element.sourceCodeLocation;
  const fragment = parseFragment(doc.text.slice(loc.startTag.endOffset, loc.endTag.startOffset), { scriptingEnabled: true });
  if (!fragment.childNodes.every(n => n.nodeName === '#text')) return null;
  const value = fragment.childNodes.map(n => n.value).join('');
  // HTML discards the first newline after these opening tags.
  return ['pre', 'listing'].includes(target.element.tagName) && value.startsWith('\n') ? value.slice(1) : value;
}
function textReason(doc, target) {
  if (target.readonly) return target.readonly;
  const e = target.element;
  if (RAW.has(e.tagName)) return 'raw-context';
  const loc = e.sourceCodeLocation, children = e.childNodes;
  if (!loc?.endTag || children.length !== 1 || children[0].nodeName !== '#text') return 'not-leaf';
  const child = children[0].sourceCodeLocation;
  // In a text-only <body>, trailing whitespace after </body>/</html> can be
  // merged into this text node. Only the explicit inner source range is edited.
  if (!child || child.startOffset !== loc.startTag.endOffset || child.endOffset < loc.endTag.startOffset || leafValue(doc, target) === null) return 'not-leaf';
  return null;
}
function allowedAttrs(tag) { return [...GLOBAL_ATTRS, ...(tag === 'a' ? ['href'] : tag === 'img' ? ['src', 'alt', 'width', 'height', 'srcset'] : [])]; }

// The design specifies categories but not names: these are the v1's 30
// properties. No arbitrary CSS identifiers/functions, variables or escapes.
const number = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const lengthRE = new RegExp(`^(?:0|${number}(?:px|rem|em|%|vh|vw))$`, 'i');
const length = v => lengthRE.test(v);
const signedLength = v => length(v.replace(/^-/, ''));
const oneOf = words => v => words.split(' ').includes(v.toLowerCase());
const series = (validator, max = 4) => v => { const parts = v.split(/\s+/); return parts.length <= max && parts.every(validator); };
function color(v) {
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(v)) return true;
  if (oneOf('transparent currentcolor black silver gray white maroon red purple fuchsia green lime olive yellow navy blue teal aqua orange rebeccapurple')(v)) return true;
  const rgb = v.match(/^(rgb|rgba)\(([^()]*)\)$/i);
  if (!rgb) return false;
  const p = rgb[2].split(',').map(s => s.trim());
  return p.length === (rgb[1].toLowerCase() === 'rgba' ? 4 : 3) && p.slice(0, 3).every(s => /^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(s) && Number(s.replace('%', '')) <= (s.endsWith('%') ? 100 : 255)) &&
    (p.length === 3 || /^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/.test(p[3]));
}
const margin = v => v === 'auto' || signedLength(v);
const dimension = v => v === 'auto' || length(v);
const CSS = Object.freeze({
  color, 'background-color': color,
  'font-family': v => /^(?:[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)(?:\s*,\s*[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)*$/i.test(v),
  'font-size': length, 'font-weight': oneOf('normal bold bolder lighter 100 200 300 400 500 600 700 800 900'),
  'font-style': oneOf('normal italic oblique'), 'line-height': v => v === 'normal' || length(v) || new RegExp(`^${number}$`).test(v),
  'text-align': oneOf('left right center justify start end'), 'text-decoration': oneOf('none underline overline line-through'),
  margin: series(margin), 'margin-top': margin, 'margin-right': margin, 'margin-bottom': margin, 'margin-left': margin,
  padding: series(length), 'padding-top': length, 'padding-right': length, 'padding-bottom': length, 'padding-left': length,
  width: dimension, height: dimension, 'min-width': dimension, 'max-width': v => v === 'none' || dimension(v),
  'min-height': dimension, 'max-height': v => v === 'none' || dimension(v), gap: series(length, 2),
  border: v => v === 'none' || /^(\S+) (solid|dashed|dotted|double|groove|ridge|inset|outset) (.+)$/i.test(v) && (() => { const m = v.match(/^(\S+) (\S+) (.+)$/); return length(m[1]) && color(m[3]); })(),
  'border-radius': series(length), opacity: v => /^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/.test(v),
  display: oneOf('none block inline inline-block flex inline-flex grid inline-grid table table-row table-cell flow-root contents'),
});

// A small declaration scanner, not a CSS sanitizer. It understands comments,
// strings and balanced functions in *existing* CSS, so untouched url() and
// !important survive. Ambiguous syntax is read-only. New values use CSS above.
function declarations(value) {
  const parts = [];
  let start = 0, depth = 0, quote = '', comment = false;
  for (let i = 0; i <= value.length; i++) {
    const c = value[i];
    if (comment) { if (c === '*' && value[i + 1] === '/') { comment = false; i++; } continue; }
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '/' && value[i + 1] === '*') { comment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '\\' || c === '{' || c === '}' || c === '<') return null;
    if (c === '(') depth++;
    if (c === ')' && --depth < 0) return null;
    if ((c === ';' && !depth) || i === value.length) {
      const chunk = value.slice(start, i);
      const offset = chunk.match(/^(?:\s|\/\*[\s\S]*?\*\/)*/)[0].length;
      const body = chunk.slice(offset);
      if (body.trim()) {
        const m = body.match(/^([a-zA-Z-][a-zA-Z0-9-]*)\s*:\s*([\s\S]*)$/);
        if (!m || !m[2].trim()) return null;
        const valueStart = start + offset + m[0].length - m[2].length;
        parts.push({ prop: m[1].toLowerCase(), value: m[2].trim(), start: start + offset,
          end: c === ';' ? i + 1 : i, valueStart, valueEnd: i - (m[2].length - m[2].trimEnd().length), semicolon: c === ';' });
      }
      start = i + 1;
    }
  }
  return depth || quote || comment ? null : parts;
}

function styleInfo(doc, target) {
  const attrs = sourceAttrs(doc, target).attrs.filter(a => a.name === 'style');
  if (attrs.length > 1) return { reason: 'attr-duplicated-in-source', parts: [] };
  const attr = attrs[0];
  if (!attr) return { attr: null, parts: [], value: '' };
  const value = attrValue(target.element, 'style') || '';
  const raw = doc.text.slice(attr.valueStart, attr.valueEnd);
  const parts = declarations(raw);
  // Entity decoding changes offsets. Never rewrite the whole style to obtain
  // convenient offsets; leave such source read-only instead.
  if (!parts || normalizeEOL(raw) !== value || !attr.quote) return { attr, value, parts: declarations(value) || [], reason: 'css-unparseable' };
  return { attr, value: raw, parts };
}

function inspect(doc, node) {
  const target = targetOf(doc, node);
  if (!target) return { tag: null, text: null, attrs: {}, style: {}, can: { text: false, attrs: [], css: false }, reasons: ['no-target'] };
  const names = allowedAttrs(target.node.tag), source = sourceAttrs(doc, target);
  const seen = new Set(), duplicated = new Set();
  for (const a of source.attrs) { if (seen.has(a.name)) duplicated.add(a.name); seen.add(a.name); }
  const attrs = Object.fromEntries(target.element.attrs.filter(a => !a.namespace && names.includes(a.name)).map(a => [a.name, a.value]));
  const info = styleInfo(doc, target), reason = textReason(doc, target);
  const duplicateCSS = new Set(info.parts.map(p => p.prop)).size !== info.parts.length;
  const reasons = [...new Set([target.readonly, reason, duplicated.size ? 'attr-duplicated-in-source' : null,
    info.reason, duplicateCSS ? 'css-duplicate' : null].filter(Boolean))];
  return { tag: target.node.tag, text: reason ? null : leafValue(doc, target), attrs,
    style: Object.fromEntries(info.parts.map(p => [p.prop, p.value])),
    can: { text: !reason, attrs: target.readonly ? [] : names.filter(n => !duplicated.has(n)), css: !target.readonly && !info.reason && !duplicateCSS }, reasons };
}

function localPath(doc, value, image) {
  if (!value || /[\u0000-\u0020\u007f\\<>"']/.test(value) || value.includes('//') || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('/')) return fail('path-outside');
  if (image && /[?#]/.test(value)) return fail('value-invalid');
  let pathname = value.split(/[?#]/, 1)[0];
  try { pathname = decodeURIComponent(pathname); } catch { return fail('path-outside'); }
  if (/[\u0000-\u0020\u007f\\%:?#<>"']/.test(pathname) || pathname.startsWith('/') || pathname.includes('//')) return fail('path-outside');
  const relative = posix.normalize(posix.join(posix.dirname(stateOf(doc).relative), pathname));
  const checked = posix.normalize(relative.normalize('NFKC').toLowerCase());
  if (checked === '..' || checked.startsWith('../') || posix.isAbsolute(checked) || checked.split('/').some(p => (p.startsWith('.') && p !== '.') || p === 'node_modules')) return fail('path-outside');
  if (image && !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(relative)) return fail('value-invalid');
  return { ok: true, relative };
}

function attrValidation(doc, name, value, assetExists) {
  if (value === null) return null;
  if (!validString(value) || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return 'value-invalid';
  if (value.length > LIMITS.attr) return 'too-large';
  if (name === 'srcset') return 'attr-not-allowed'; // removal only
  if (name === 'id' && (!value || /\s/.test(value))) return 'value-invalid';
  if (name === 'lang' && value && !/^[a-z]{1,8}(?:-[a-z\d]{1,8})*$/i.test(value)) return 'value-invalid';
  if (name === 'dir' && !['ltr', 'rtl', 'auto'].includes(value)) return 'value-invalid';
  if (name === 'hidden' && !['', 'hidden', 'until-found'].includes(value)) return 'value-invalid';
  if (name === 'role' && !/^[a-z][a-z-]*(?: [a-z][a-z-]*)*$/.test(value)) return 'value-invalid';
  if (['width', 'height'].includes(name) && !/^[1-9]\d{0,5}$/.test(value)) return 'value-invalid';
  if (name === 'href' || name === 'src') {
    const path = localPath(doc, value, name === 'src');
    if (!path.ok) return path.reason;
    if (name === 'src') {
      let asset;
      try { asset = typeof assetExists === 'function' ? assetExists(path.relative) : null; } catch { return 'image-missing'; }
      if (asset?.ok !== true || !Number.isSafeInteger(asset.size) || asset.size < 0) return 'image-missing';
      if (asset.size > LIMITS.image) return 'too-large';
    }
  }
  return null;
}

function makeEdit(doc, start, end, newText) { return Object.freeze({ start, end, oldText: doc.text.slice(start, end), newText }); }
function attributeEdit(doc, target, name, value) {
  const source = sourceAttrs(doc, target), attrs = source.attrs.filter(a => a.name === name);
  if (attrs.length > 1) return fail('attr-duplicated-in-source');
  const a = attrs[0];
  if (value === null) return { edit: a ? makeEdit(doc, a.start, a.end, '') : makeEdit(doc, source.nameEnd, source.nameEnd, '') };
  const replacement = `${name}="${escapeAttr(value)}"`;
  return { edit: a ? makeEdit(doc, a.start, a.end, replacement) : makeEdit(doc, source.nameEnd, source.nameEnd, ` ${replacement}`) };
}

function cssEdit(doc, target, prop, value) {
  if (typeof prop !== 'string' || !Object.hasOwn(CSS, prop)) return fail('attr-not-allowed');
  if (value !== null) {
    if (!validString(value)) return fail('value-invalid');
    if (value.length > LIMITS.css) return fail('too-large');
    if (!value || /url\s*\(|expression|\\|\/\*|[;{}<>"'!\u0000-\u001f\u007f]/i.test(value) || !CSS[prop](value.trim())) return fail('value-invalid');
    value = value.trim();
  }
  const info = styleInfo(doc, target);
  if (info.reason) return fail(info.reason);
  const matches = info.parts.filter(p => p.prop === prop);
  if (matches.length > 1) return fail('css-duplicate');
  const part = matches[0];
  if (!info.attr) return attributeEdit(doc, target, 'style', value === null ? null : `${prop}: ${value}`);
  const base = info.attr.valueStart;
  if (part) {
    // Preserve comments/spacing inside the declaration too. A value containing
    // comments is ambiguous for a surgical edit and stays read-only.
    if (/\/\*/.test(info.value.slice(part.valueStart, part.valueEnd))) return fail('css-unparseable');
    // Leave the original priority suffix, including its spelling and spacing,
    // outside the patch. New values still cannot introduce !important.
    const priority = importantSuffix(part.value);
    return { edit: value === null ? makeEdit(doc, base + part.start, base + part.end, '')
      : makeEdit(doc, base + part.valueStart, base + part.valueEnd - priority.length, escapeAttr(value)) };
  }
  const last = info.parts.at(-1);
  if (value === null) return { edit: makeEdit(doc, base, base, '') };
  // Insert before trailing trivia, after the last declaration. Never turn a
  // trailing comment or an unterminated previous declaration into our value.
  const at = last ? last.end : 0;
  return { edit: makeEdit(doc, base + at, base + at, `${last && !last.semicolon ? ';' : ''}${at ? ' ' : ''}${prop}: ${escapeAttr(value)};`) };
}

function withRangeEOL(value, original, doc) {
  // Retain the sequence of existing newline kinds in mixed ranges. Additional
  // lines use the last kind; a single-line range inherits the document's first.
  const endings = original.match(/\r\n|\r|\n/g) || [];
  const fallback = endings.at(-1) || doc.text.match(/\r\n|\r|\n/)?.[0] || '\n';
  let i = 0;
  return value.replace(/\n/g, () => endings[i++] || fallback);
}

function sameAttrs(a, b, except) {
  const attrs = e => e.attrs.filter(x => !except || x.name !== except || x.namespace).map(x => [x.name, x.value, x.namespace || '', x.prefix || '']);
  return JSON.stringify(attrs(a)) === JSON.stringify(attrs(b));
}
function verifyTree(before, after, targetIndex, attrName) {
  if (before.tree.mode !== after.tree.mode || JSON.stringify(before.doctypes) !== JSON.stringify(after.doctypes) || before.all.length !== after.all.length) return false;
  return before.all.every((entry, index) => {
    const next = after.all[index], a = entry.element, b = next.element;
    return a.tagName === b.tagName && a.namespaceURI === b.namespaceURI && entry.parent === next.parent &&
      entry.template === next.template && entry.foreign === next.foreign && entry.readonly === next.readonly &&
      Boolean(entry.location) === Boolean(next.location) &&
      (index === targetIndex && attrName === '*' || sameAttrs(a, b, index === targetIndex ? attrName : null));
  });
}

function editDocument(doc, edit, targetIndex, attrName) {
  const before = stateOf(doc);
  if (!edit || !Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > doc.text.length ||
      typeof edit.oldText !== 'string' || typeof edit.newText !== 'string' || !edit.newText.isWellFormed() ||
      doc.text.slice(edit.start, edit.end) !== edit.oldText) throw error('verify-bytes');
  const prefix = doc.text.slice(0, edit.start), suffix = doc.text.slice(edit.end);
  if (!prefix.isWellFormed() || !suffix.isWellFormed()) throw error('verify-bytes');
  const text = prefix + edit.newText + suffix;
  const bytes = Buffer.from((doc.bom ? '\uFEFF' : '') + text, 'utf8');
  if (bytes.length > LIMITS.document) throw error('too-large');
  const oldBytes = encode(doc), prefixSize = Buffer.byteLength(prefix) + (doc.bom ? 3 : 0), suffixSize = Buffer.byteLength(suffix);
  if (!bytes.subarray(0, prefixSize).equals(oldBytes.subarray(0, prefixSize)) ||
      !bytes.subarray(bytes.length - suffixSize).equals(oldBytes.subarray(oldBytes.length - suffixSize))) throw error('verify-bytes');
  const result = prepare(bytes, { relative: before.relative });
  if (!result.ok) throw error(Object.hasOwn(REASONS, result.reason) ? result.reason : 'verify-tree');
  const after = stateOf(result.doc);
  if (!verifyTree(before, after, targetIndex, attrName)) throw error('verify-tree');
  // Location identity must survive the reparse as well as preorder identity.
  const delta = edit.newText.length - edit.oldText.length;
  for (let i = 0; i < before.all.length; i++) {
    const loc = before.all[i].location;
    if (!loc) continue;
    const expected = loc.startOffset >= edit.end ? loc.startOffset + delta : loc.startOffset;
    if (after.all[i].location.startOffset !== expected) throw error('verify-tree');
  }
  return result.doc;
}

function apply(doc, op, { assetExists } = {}) {
  try {
    const target = targetOf(doc, op?.node);
    if (!target) return fail('no-target');
    if (target.readonly) return fail(target.readonly);
    let result, attrName = null;
    if (op.type === 'text') {
      const reason = textReason(doc, target);
      if (reason) return fail(reason);
      if (!validString(op.value)) return fail('value-invalid');
      if (Buffer.byteLength(op.value) > LIMITS.text) return fail('too-large');
      const { startTag, endTag } = target.element.sourceCodeLocation;
      const oldText = doc.text.slice(startTag.endOffset, endTag.startOffset);
      result = { edit: makeEdit(doc, startTag.endOffset, endTag.startOffset, withRangeEOL(escapeText(op.value), oldText, doc)) };
    } else if (op.type === 'attr') {
      if (typeof op.name !== 'string' || !allowedAttrs(target.node.tag).includes(op.name)) return fail('attr-not-allowed');
      const reason = attrValidation(doc, op.name, op.value, assetExists);
      if (reason) return fail(reason);
      attrName = op.name;
      result = attributeEdit(doc, target, op.name, op.value);
    } else if (op.type === 'css') {
      attrName = 'style';
      result = cssEdit(doc, target, op.prop, op.value);
    } else return fail('value-invalid');
    if (!result.edit) return result;
    const next = editDocument(doc, result.edit, target.index, attrName);
    // Confirm the requested value, not merely an unchanged element count.
    const edited = targetOf(next, target.node.id);
    if (!edited || edited.index !== target.index) return fail('verify-tree');
    if (op.type === 'text' && leafValue(next, edited) !== op.value) return fail('verify-tree');
    if (op.type === 'attr' && attrValue(edited.element, op.name) !== (op.value === null ? undefined : op.value)) return fail('verify-tree');
    if (op.type === 'css') {
      const info = styleInfo(next, edited), parts = info.parts.filter(p => p.prop === op.prop);
      const original = styleInfo(doc, target).parts.find(p => p.prop === op.prop);
      const priority = (original ? importantSuffix(original.value) : '');
      if (info.reason || (op.value === null ? parts.length !== 0 : parts.length !== 1 || parts[0].value !== op.value.trim() + priority)) return fail('verify-tree');
    }
    return { ok: true, doc: next, edit: result.edit };
  } catch (e) {
    if (Object.hasOwn(REASONS, e.reason)) return fail(e.reason);
    throw e;
  }
}

/**
 * Replay only an edit returned by apply or invert in this same session.
 * Operation values are not revalidated: undo must restore the original bytes,
 * even for originally unsafe values. Never accept edits from external callers.
 */
function applyEdit(doc, edit) {
  const state = stateOf(doc);
  const target = [...state.byId.values()].find(({ location: l }) => edit?.start > l.startOffset && edit?.end < l.endOffset);
  // History may restore originally unsafe values (undo must be exact), but
  // never changes a forbidden attribute or a readonly/raw-text region.
  if (target?.readonly) throw error(target.readonly);
  if (target) {
    for (const attr of sourceAttrs(doc, target).attrs) {
      const touched = edit.start < attr.end && edit.end > attr.start || edit.start === edit.end && edit.start > attr.start && edit.start < attr.end;
      if (touched && !allowedAttrs(target.node.tag).includes(attr.name) && attr.name !== 'style') throw error('verify-tree');
    }
  }
  const next = editDocument(doc, edit, target?.index ?? -1, target ? '*' : null);
  if (target) {
    const edited = targetOf(next, target.node.id);
    const names = new Set([...target.element.attrs, ...edited.element.attrs].map(a => a.name));
    const changed = [...names].filter(n => attrValue(target.element, n) !== attrValue(edited.element, n));
    if (changed.length > 1 || changed.some(n => !allowedAttrs(target.node.tag).includes(n) && n !== 'style')) throw error('verify-tree');
  } else {
    const leaf = [...state.byId.values()].find(t => {
      const loc = t.element.sourceCodeLocation;
      return loc.endTag && edit.start >= loc.startTag.endOffset && edit.end <= loc.endTag.startOffset &&
        !t.readonly && !RAW.has(t.node.tag) && t.element.childNodes.every(n => n.nodeName === '#text');
    });
    if (!leaf) throw error('verify-tree');
  }
  return next;
}
function invert(edit) {
  return Object.freeze({ start: edit.start, end: edit.start + edit.newText.length, oldText: edit.newText, newText: edit.oldText });
}

function serve(doc, { nonce, chan, gen, bridgeSource }) {
  stateOf(doc);
  if (typeof nonce !== 'string' || !/^[a-z\d+/_=-]{1,128}$/i.test(nonce) || typeof chan !== 'string' || chan.length > 128 ||
      !Number.isSafeInteger(gen) || gen < 0 || typeof bridgeSource !== 'string' || bridgeSource.includes('\0')) throw error('value-invalid');
  // CHAN / GEN are literal placeholders, e.g. { chan: CHAN, gen: GEN }.
  // Quoted placeholders are accepted too. Replace in one pass: a channel
  // containing the word GEN must not undergo a second substitution.
  const literal = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const bridge = bridgeSource.replace(/(["'])\b(CHAN|GEN)\b\1|\b(CHAN|GEN)\b/g, (_m, _q, quoted, bare) => literal((quoted || bare) === 'CHAN' ? chan : gen));
  const insertions = doc.nodes.map(node => {
    const target = targetOf(doc, node.id), at = sourceAttrs(doc, target).nameEnd;
    return { at, text: ` data-dk-node="${node.id}"` };
  }).sort((a, b) => a.at - b.at);
  if (insertions.some((item, i) => i && item.at === insertions[i - 1].at)) throw error('verify-tree');
  const pieces = [];
  let at = 0;
  for (const insertion of insertions) { pieces.push(doc.text.slice(at, insertion.at), insertion.text); at = insertion.at; }
  pieces.push(doc.text.slice(at));
  const body = pieces.join(''), script = `<script nonce="${nonce}">${bridge}</script>`;
  const served = body + script;
  const parsed = parseSource(served, true);
  const scripts = parsed.all.filter(({ element: e }) => e.tagName === 'script');
  const last = scripts.at(-1);
  if (!last || last.template || last.foreign || last.element.namespaceURI !== HTML || last.location?.startOffset !== body.length ||
      last.element.sourceCodeLocation?.endTag?.endOffset !== served.length || attrValue(last.element, 'nonce') !== nonce ||
      last.element.childNodes.map(n => n.value || '').join('') !== normalizeEOL(bridge)) throw error('verify-tree');
  const seen = new Set();
  for (const { element: e, readonly } of parsed.all) {
    const value = attrValue(e, 'data-dk-node');
    if (value === undefined) continue;
    const id = Number(value), node = doc.nodes[id - 1];
    if (!node || value !== String(node.id) || e.tagName !== node.tag || e.namespaceURI !== node.ns) throw error('verify-tree');
    if (seen.has(id)) {
      if (node.readonly !== 'clone' || readonly !== 'clone') throw error('verify-tree');
    } else {
      if (id !== seen.size + 1) throw error('verify-tree');
      seen.add(id);
    }
  }
  if (seen.size !== doc.nodes.length) throw error('verify-tree');
  return Buffer.from((doc.bom ? '\uFEFF' : '') + served, 'utf8');
}

module.exports = { prepare, serve, inspect, apply, applyEdit, invert, encode, LIMITS, REASONS };
