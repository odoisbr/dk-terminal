const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../electron/visual-bridge.js'), 'utf8');
const CHAN = '0123456789abcdef0123456789abcdef';
const GEN = 7;

// No browser, network or real clock: exercise the page script as served by main.
function harness({ loading = false, nodeCount, clobbered = false } = {}) {
  let time = 0;
  let nextTimer = 1;
  const timers = new Map();
  const messages = [];
  const shadows = [];

  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener, options) {
      const entries = this.listeners.get(type) || [];
      entries.push({ listener, capture: options === true || !!options?.capture, once: !!options?.once });
      this.listeners.set(type, entries);
    }
    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.listener !== listener));
    }
    emit(type, fields = {}) {
      const event = {
        type, target: this, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
        ...fields,
      };
      const entries = [...(this.listeners.get(type) || [])].sort((a, b) => b.capture - a.capture);
      for (const entry of entries) {
        entry.listener(event);
        if (entry.once) this.listeners.set(type, this.listeners.get(type).filter(item => item !== entry));
        if (event.stopped) break;
      }
      return event;
    }
  }

  function style() {
    const result = {};
    Object.defineProperty(result, 'cssText', {
      set(value) {
        for (const declaration of value.split(';')) {
          const [name, text] = declaration.split(':');
          if (name && text) result[name.trim().replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = text.trim();
        }
      },
    });
    return result;
  }

  class Node extends Events {
    constructor(type) {
      super();
      this._nodeType = type;
      this._parent = null;
      this.children = [];
    }
    get nodeType() { return this._nodeType; }
    get parentNode() { return this._parent; }
    get parentElement() { return this._parent instanceof Element ? this._parent : null; }
    appendChild(child) { this.children.push(child); child._parent = this; return child; }
    get isConnected() {
      let node = this;
      while (node._parent) node = node._parent;
      return node === document;
    }
  }

  const clobberNames = [
    'createElement', 'addEventListener', 'removeEventListener', 'querySelectorAll',
    'documentElement', 'readyState', 'closest', 'getAttribute', 'parentElement',
    'parentNode', 'nodeType', 'getBoundingClientRect', 'isConnected', 'localName',
    'appendChild', 'setAttribute', 'attachShadow',
  ];
  function clobber(target) {
    for (const name of clobberNames) {
      const fake = new Element('input');
      fake.name = name;
      Object.defineProperty(target, name, { value: fake, configurable: true });
    }
  }

  class Element extends Node {
    constructor(name, node, rect = {}) {
      super(1);
      this._localName = name;
      this.attrs = new Map(node === undefined ? [] : [['data-dk-node', String(node)]]);
      this.style = style();
      this.rect = { left: 10, top: 20, width: 100, height: 30, ...rect };
      if (clobbered && name === 'form') clobber(this);
    }
    get localName() { return this._localName; }
    setAttribute(name, value) { this.attrs.set(name, value); }
    getAttribute(name) {
      assert.equal(name, 'data-dk-node', 'only injected identity may be read');
      return this.attrs.get(name) ?? null;
    }
    getBoundingClientRect() { return this.rect; }
    matches(selector) {
      if (selector === '[data-dk-node]') return this.attrs.has('data-dk-node');
      const identity = /^\[data-dk-node="(\d+)"\]$/.exec(selector);
      if (identity) return this.attrs.get('data-dk-node') === identity[1];
      const input = /^input\[type="(\w+)"\]$/.exec(selector);
      return input ? this._localName === 'input' && this.type === input[1] : this._localName === selector;
    }
    closest(selector) {
      for (let element = this; element instanceof Element; element = element._parent) {
        if (selector.split(',').some(part => Element.prototype.matches.call(element, part))) return element;
      }
      return null;
    }
    attachShadow(options) {
      assert.equal(options.mode, 'closed');
      const root = new Node(11);
      shadows.push({ host: this, root, mode: options.mode });
      return root;
    }
  }
  for (const name of ['innerHTML', 'outerHTML', 'textContent', 'innerText', 'nodeValue', 'attributes']) {
    Object.defineProperty(Element.prototype, name, { get() { throw new Error('Forbidden content read: ' + name); } });
  }

  class DOMTokenList extends Set {
    contains(value) { return this.has(value); }
  }
  class HTMLImageElement extends Element {
    constructor(node, rect) { super('img', node, rect); this._src = ''; this._currentSrc = ''; }
    get src() { return this._src; }
    set src(value) { this._src = value; }
    get currentSrc() { return this._currentSrc; }
    set currentSrc(value) { this._currentSrc = value; }
  }
  class HTMLLinkElement extends Element {
    constructor(node, rect) { super('link', node, rect); this._href = ''; this._as = ''; this._relList = new DOMTokenList(); }
    get href() { return this._href; }
    set href(value) { this._href = value; }
    get as() { return this._as; }
    set as(value) { this._as = value; }
    get relList() { return this._relList; }
  }
  class Document extends Node {
    constructor() {
      super(9);
      this._documentElement = new Element('html', 0);
      Node.prototype.appendChild.call(this, this._documentElement);
      if (clobbered) clobber(this);
    }
    get readyState() { return loading ? 'loading' : 'complete'; }
    get documentElement() { return this._documentElement; }
    createElement(name) {
      return name === 'img' ? new HTMLImageElement() : name === 'link' ? new HTMLLinkElement() : new Element(name);
    }
    querySelectorAll(selector) {
      if (selector === '[data-dk-node]' && nodeCount !== undefined) return { length: nodeCount };
      const results = [];
      function walk(element) {
        if (element instanceof Element && Element.prototype.matches.call(element, selector)) results.push(element);
        element.children.forEach(walk); // Closed shadow trees are not document nodes.
      }
      walk(this._documentElement);
      return results;
    }
  }
  const document = new Document();

  const window = new Events();
  const parent = { postMessage(data, origin) {
    assert.equal(origin, '*');
    assert.ok(Buffer.byteLength(JSON.stringify(data), 'utf8') <= 16 * 1024);
    messages.push({ time, data: JSON.parse(JSON.stringify(data)) });
  } };
  window.parent = parent;
  window.scrollY = 0;
  window.scrollCalls = [];
  window.scrollTo = options => {
    window.scrollCalls.push({ ...options });
    window.scrollY = options.top;
    window.emit('scroll');
  };

  function add(name, node, ancestor = document._documentElement, rect) {
    const element = name === 'img' ? new HTMLImageElement(node, rect)
      : name === 'link' ? new HTMLLinkElement(node, rect) : new Element(name, node, rect);
    return Node.prototype.appendChild.call(ancestor, element);
  }
  function advance(ms) {
    const end = time + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      time = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    time = end;
  }
  const context = vm.createContext({
    window, document, URL, EventTarget: Events, Node, Element, Document,
    HTMLImageElement, HTMLLinkElement, DOMTokenList,
    performance: { now: () => time },
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { at: time + delay, fn }); return id; },
  });
  function run() {
    vm.runInContext(source.replace('__DK_CHAN__', CHAN).replace('__DK_GEN__', String(GEN)), context, { timeout: 1000 });
  }
  const mark = (fields = {}, event = {}) => window.emit('message', {
    source: parent,
    data: { type: 'dk-edit-mark', dk: 1, v: 1, chan: CHAN, gen: GEN, node: 1, ...fields },
    ...event,
  });
  return { document, window, parent, messages, shadows, add, advance, run, mark,
    realDocumentElement: document._documentElement,
    text: ancestor => Node.prototype.appendChild.call(ancestor, new Node(3)),
    ofType: type => messages.filter(item => item.data.type === type),
    selection: () => shadows[0].root.children[0], hover: () => shadows[0].root.children[1] };
}

test('ready waits for the DOM and counts identities, excluding the closed overlay', () => {
  const h = harness({ loading: true });
  h.add('body', 1);
  h.add('p', 2);
  h.run();
  assert.equal(h.messages.length, 0);
  h.document.emit('DOMContentLoaded');
  h.document.emit('DOMContentLoaded');
  assert.deepEqual(h.messages.map(item => item.data), [{
    type: 'dk-edit-ready', dk: 1, v: 1, chan: CHAN, gen: GEN, nodes: 3, scripts_off: true,
  }]);
  const { host, mode, root } = h.shadows[0];
  assert.equal(mode, 'closed');
  assert.equal(host.attrs.has('data-dk-node'), false);
  assert.equal(root.children.length, 2);
  assert.equal(h.document.querySelectorAll('[data-dk-node]').length, 3);
  assert.match(host.style.pointerEvents, /^none/);
});

test('ready caps the reported document count at 200000', () => {
  const h = harness({ nodeCount: 200001 });
  h.run();
  assert.equal(h.messages[0].data.nodes, 200000);
});

for (const loading of [false, true]) {
  test(`prototype references survive document/form named overrides (loading=${loading})`, () => {
    const h = harness({ clobbered: true, loading });
    const form = h.add('form', 1, undefined, { left: 73 });
    const text = h.text(form);
    h.add('form', 1);
    const image = h.add('img', 2);
    image.src = 'https://images.test/private.png';
    for (const target of [h.document, form]) {
      for (const name of ['createElement', 'addEventListener', 'querySelectorAll', 'documentElement',
        'readyState', 'closest', 'getAttribute', 'parentElement', 'nodeType', 'getBoundingClientRect']) {
        assert.ok(Object.hasOwn(target, name));
        assert.equal(typeof target[name], 'object');
      }
    }
    h.run();
    assert.equal(h.ofType('dk-edit-ready').length, loading ? 0 : 1);
    if (loading) h.document.emit('DOMContentLoaded');
    assert.equal(h.ofType('dk-edit-ready')[0].data.nodes, 4);
    assert.ok(h.realDocumentElement.children.includes(h.shadows[0].host));
    assert.equal(h.document.documentElement.children.includes(h.shadows[0].host), false);
    const click = h.document.emit('click', { target: text });
    assert.ok(click.defaultPrevented && click.stopped);
    assert.equal(h.ofType('dk-edit-select')[0].data.node, 1);
    assert.equal(h.ofType('dk-edit-select')[0].data.count, 2);
    assert.equal(h.selection().style.display, 'block');
    assert.equal(h.selection().style.left, '73px');
    h.document.emit('pointermove', { target: form });
    assert.equal(h.hover().style.left, '73px');
    h.mark({ node: null });
    h.mark();
    assert.equal(h.selection().style.display, 'block');
    for (const type of ['submit', 'dragstart']) {
      const event = h.document.emit(type, { target: form });
      assert.ok(event.defaultPrevented && event.stopped);
    }
    h.document.emit('error', { target: form });
    h.document.emit('error', { target: image });
    h.document.emit('securitypolicyviolation', { effectiveDirective: 'connect-src', blockedURI: 'https://policy.test/private' });
    h.advance(500);
    assert.deepEqual(h.ofType('dk-edit-blocked')[0].data.counts, { img: 1, style: 0, font: 0, connect: 1, other: 0 });
  });
}

test('click/auxclick select the closest ancestor and report its actual clone count', () => {
  const h = harness();
  const outer = h.add('section', 1);
  const inner = h.add('a', 2, outer, { left: 42 });
  const child = h.add('span', undefined, inner);
  h.add('a', 2);
  h.run();
  let bubbled = false;
  h.document.addEventListener('click', () => { bubbled = true; });
  for (const type of ['click', 'auxclick']) {
    const event = h.document.emit(type, { target: child });
    assert.ok(event.defaultPrevented);
    assert.ok(event.stopped);
  }
  assert.equal(bubbled, false);
  assert.deepEqual(h.ofType('dk-edit-select').map(item => item.data), [0, 1].map(() => ({
    type: 'dk-edit-select', dk: 1, v: 1, chan: CHAN, gen: GEN, node: 2, count: 2,
  })));
  assert.equal(h.selection().style.display, 'block');
  assert.equal(h.selection().style.left, '42px');
  h.document.emit('pointermove', { target: child });
  assert.equal(h.hover().style.left, '42px');
  h.document.emit('mouseout', { relatedTarget: null });
  assert.equal(h.hover().style.display, 'none');
});

test('invalid node ids and clone counts above 64 do not emit selections', () => {
  const h = harness();
  const bad = ['-1', '1.2', '01', '200000', '1e2', '1]body', ''].map(id => h.add('div', id));
  const clone = h.add('p', 1);
  for (let i = 1; i < 65; i++) h.add('p', 1);
  h.run();
  for (const target of [...bad, clone]) h.document.emit('click', { target });
  assert.equal(h.ofType('dk-edit-select').length, 0);
  const boundary = harness();
  const target = boundary.add('p', 199999);
  for (let i = 1; i < 64; i++) boundary.add('p', 199999);
  boundary.run();
  boundary.document.emit('click', { target });
  assert.equal(boundary.ofType('dk-edit-select')[0].data.count, 64);
});

test('document mouseout clears hover only when the pointer leaves the document', () => {
  const h = harness();
  const first = h.add('p', 1);
  const second = h.add('p', 2);
  h.run();
  h.document.emit('pointermove', { target: first });
  assert.equal(h.hover().style.display, 'block');
  h.document.emit('mouseout', { target: first, relatedTarget: second });
  assert.equal(h.hover().style.display, 'block');
  h.document.emit('mouseout', { target: first, relatedTarget: null });
  assert.equal(h.hover().style.display, 'none');
  const listeners = h.document.listeners.get('mouseout');
  assert.ok(listeners.length && listeners.every(entry => entry.capture));
  assert.equal(h.document.listeners.has('pointerleave'), false);
});

test('capture blocks submit, dragstart and Enter/Space on links and buttons', () => {
  const h = harness();
  const linkChild = h.add('span', undefined, h.add('a', 1));
  const button = h.add('button', 2);
  const inputButton = h.add('input', 3);
  inputButton.type = 'submit';
  h.run();
  for (const type of ['submit', 'dragstart']) {
    const event = h.document.emit(type, { target: button });
    assert.ok(event.defaultPrevented && event.stopped);
  }
  for (const target of [linkChild, button, inputButton]) {
    for (const key of ['Enter', ' ', 'Spacebar']) {
      const event = h.document.emit('keydown', { key, target });
      assert.ok(event.defaultPrevented && event.stopped);
    }
  }
  assert.equal(h.document.emit('keydown', { key: 'Tab', target: button }).defaultPrevented, false);
  assert.equal(h.document.emit('keydown', { key: 'Enter', target: h.add('input', 4) }).defaultPrevented, false);
});

test('mark accepts the parent, exact v1 shape, current channel/generation and null', () => {
  const h = harness();
  h.add('p', 1, undefined, { left: 51 });
  h.run();
  h.mark();
  assert.equal(h.selection().style.left, '51px');
  assert.equal(h.selection().style.display, 'block');
  assert.equal(h.ofType('dk-edit-select').length, 0);
  h.mark({ node: null, scrollY: 123 });
  assert.equal(h.selection().style.display, 'none');
  assert.equal(h.window.scrollY, 123);
  assert.deepEqual(h.window.scrollCalls, [{ top: 123, behavior: 'instant' }]);
  h.mark({ node: 1, scrollY: 0 });
  assert.equal(h.selection().style.display, 'block');
  assert.equal(h.window.scrollY, 0);
});

test('mark rejects wrong sources, identities, versions, extra/missing keys and invalid values atomically', () => {
  const h = harness();
  h.add('p', 1);
  h.run();
  const malformed = [
    { extra: true }, { v: 2 }, { gen: GEN - 1 }, { chan: 'f'.repeat(32) }, { dk: 2 },
    { type: 'dk-edit-select' }, { node: -1 }, { node: 200000 }, { node: '1' }, { node: 1.5 },
    { node: 99 }, { node: undefined }, { scrollY: NaN }, { scrollY: Infinity },
    { scrollY: -1 }, { scrollY: '5' }, { scrollY: undefined }, { extra: 'x'.repeat(1024 * 1024) },
  ];
  for (const fields of malformed) h.mark({ scrollY: 50, ...fields });
  h.mark({ scrollY: 50 }, { source: {} });
  h.mark({ scrollY: 50 }, { source: h.window });
  for (const data of [null, [], 'message', 1, { type: 'dk-edit-mark' }]) h.mark({}, { data });
  assert.equal(h.selection().style.display, 'none');
  assert.equal(h.window.scrollCalls.length, 0);
});

test('the global rolling limit drops messages above 30 per second without replay', () => {
  const h = harness();
  const target = h.add('p', 1);
  h.run();
  for (let i = 0; i < 1000; i++) h.document.emit('click', { target });
  assert.equal(h.messages.length, 30); // Includes ready.
  h.window.emit('scroll');
  h.advance(999);
  h.document.emit('auxclick', { target });
  assert.equal(h.messages.length, 30);
  h.advance(1);
  assert.equal(h.messages.length, 30); // Nothing queued for later.
  for (let i = 0; i < 20; i++) h.document.emit('click', { target });
  h.advance(900);
  for (let i = 0; i < 100; i++) h.document.emit('click', { target });
  assert.equal(h.messages.length, 60);
  h.advance(100);
  for (let i = 0; i < 100; i++) h.document.emit('click', { target });
  for (const message of h.messages) {
    assert.ok(h.messages.filter(item => item.time > message.time - 1000 && item.time <= message.time).length <= 30);
  }
});

test('a rate-limited selection keeps the last successfully sent outline', () => {
  const h = harness();
  const first = h.add('p', 1, undefined, { left: 31 });
  const second = h.add('p', 2, undefined, { left: 62 });
  h.run();
  for (let i = 0; i < 29; i++) h.document.emit('click', { target: first });
  h.mark({ node: null });
  assert.equal(h.selection().style.display, 'none');
  h.document.emit('click', { target: first });
  assert.equal(h.ofType('dk-edit-select').length, 29);
  assert.equal(h.selection().style.display, 'none');
  h.advance(1000);
  h.document.emit('click', { target: first });
  assert.equal(h.selection().style.left, '31px');
  for (let i = 0; i < 29; i++) h.document.emit('click', { target: first });
  const dropped = h.document.emit('click', { target: second });
  assert.ok(dropped.defaultPrevented && dropped.stopped);
  assert.equal(h.selection().style.left, '31px');
  assert.equal(h.ofType('dk-edit-select').some(item => item.data.node === 2), false);
  h.advance(1000);
  assert.equal(h.selection().style.left, '31px');
  h.document.emit('auxclick', { target: second });
  assert.equal(h.selection().style.left, '62px');
});

test('blocked reports retain totals and hosts across global rate-limit drops', () => {
  const h = harness();
  const target = h.add('p', 1);
  h.run();
  for (let i = 0; i < 29; i++) h.document.emit('click', { target });
  h.document.emit('securitypolicyviolation', { effectiveDirective: 'img-src', blockedURI: 'https://first.test/private' });
  h.advance(500);
  assert.equal(h.ofType('dk-edit-blocked').length, 0);
  h.document.emit('securitypolicyviolation', { effectiveDirective: 'font-src', blockedURI: 'https://second.test/private' });
  h.advance(499);
  assert.equal(h.messages.length, 30);
  h.advance(1);
  const report = h.ofType('dk-edit-blocked')[0];
  assert.equal(report.time, 1000);
  assert.deepEqual(report.data.counts, { img: 1, style: 0, font: 1, connect: 0, other: 0 });
  assert.deepEqual(report.data.hosts, ['first.test', 'second.test']);
  h.document.emit('securitypolicyviolation', { effectiveDirective: 'img-src', blockedURI: 'https://third.test/private' });
  h.advance(500);
  assert.deepEqual(h.ofType('dk-edit-blocked')[1].data.counts, { img: 1, style: 0, font: 0, connect: 0, other: 0 });
  assert.deepEqual(h.ofType('dk-edit-blocked')[1].data.hosts, ['third.test']);
  h.advance(1000);
  assert.equal(h.ofType('dk-edit-blocked').length, 2);
});

test('scroll reports at most every 250ms, using the latest position on trailing delivery', () => {
  const h = harness();
  h.run();
  h.window.scrollY = 1;
  h.window.emit('scroll');
  h.advance(50);
  for (let i = 0; i < 50; i++) { h.window.scrollY = i; h.window.emit('scroll'); }
  h.advance(199);
  assert.equal(h.ofType('dk-edit-scroll').length, 1);
  h.advance(1);
  assert.deepEqual(h.ofType('dk-edit-scroll').map(item => [item.time, item.data.y]), [[0, 1], [250, 49]]);
  h.window.scrollY = -20;
  h.window.emit('scroll');
  h.advance(250);
  assert.equal(h.ofType('dk-edit-scroll').at(-1).data.y, 0);
});

test('CSP and img/link failures aggregate by category every 500ms and disclose only ten hosts', () => {
  const h = harness();
  const image = h.add('img', 1);
  image.currentSrc = 'https://user:password@images.test:8443/private/image.png?secret=yes#fragment';
  const stylesheet = h.add('link', 2);
  stylesheet.relList.add('stylesheet');
  stylesheet.href = 'https://styles.test/private/style.css?secret=yes';
  const font = h.add('link', 3);
  font.as = 'font';
  font.href = 'https://fonts.test/private/font.woff2';
  h.run();
  for (const directive of ['img-src', 'style-src', 'style-src-elem', 'style-src-attr', 'font-src', 'connect-src', 'script-src']) {
    h.document.emit('securitypolicyviolation', { effectiveDirective: directive, blockedURI: 'https://policy.test/private?secret=yes' });
  }
  h.document.emit('securitypolicyviolation', { effectiveDirective: 'script-src', blockedURI: 'inline' });
  for (const target of [image, stylesheet, font]) h.document.emit('error', { target });
  h.document.emit('error', { target: h.window }); // Runtime errors are not resource failures.
  for (let i = 0; i < 20; i++) h.document.emit('securitypolicyviolation', {
    effectiveDirective: 'connect-src', blockedURI: `https://host${i}.test/private?secret=yes`,
  });
  h.advance(499);
  assert.equal(h.ofType('dk-edit-blocked').length, 0);
  h.advance(1);
  const first = h.ofType('dk-edit-blocked')[0].data;
  assert.deepEqual(first.counts, { img: 2, style: 4, font: 2, connect: 21, other: 0 });
  assert.equal(first.hosts.length, 10);
  assert.ok(first.hosts.includes('images.test:8443'));
  assert.ok(first.hosts.includes('policy.test'));
  assert.ok(first.hosts.every(host => !/[/?#@]/.test(host)));
  assert.doesNotMatch(JSON.stringify(first), /private|secret|password|https:/);
  h.document.emit('securitypolicyviolation', { effectiveDirective: 'font-src', blockedURI: 'data:font/woff2;base64,SECRET' });
  h.advance(500);
  assert.deepEqual(h.ofType('dk-edit-blocked')[1].data.counts, { img: 0, style: 0, font: 1, connect: 0, other: 0 });
  assert.deepEqual(h.ofType('dk-edit-blocked')[1].data.hosts, []);
  assert.deepEqual(h.ofType('dk-edit-blocked').map(item => item.time), [500, 1000]);
});

test('script CSP violations never schedule or contribute to resource reports', () => {
  const h = harness();
  h.run();
  const scripts = () => {
    for (const effectiveDirective of ['script-src', 'script-src-elem', 'script-src-attr']) {
      h.document.emit('securitypolicyviolation', { effectiveDirective, blockedURI: 'https://scripts.test/private.js' });
    }
  };
  scripts();
  h.advance(1000);
  assert.equal(h.ofType('dk-edit-blocked').length, 0);
  h.document.emit('securitypolicyviolation', { effectiveDirective: 'object-src', blockedURI: 'https://objects.test/private' });
  scripts();
  h.advance(500);
  assert.deepEqual(h.ofType('dk-edit-blocked')[0].data.counts, { img: 0, style: 0, font: 0, connect: 0, other: 1 });
  assert.deepEqual(h.ofType('dk-edit-blocked')[0].data.hosts, ['objects.test']);
});

test('resource hosts include only http/https and never the preview token', () => {
  const h = harness();
  const token = 'fedcba9876543210fedcba9876543210';
  const image = h.add('img', 1);
  image.currentSrc = `dk-preview://${token}/private.png`;
  h.run();
  h.document.emit('error', { target: image });
  for (const blockedURI of [
    `dk-preview://${token}/private.css`, `blob:dk-preview://${token}/private`,
    'ftp://files.test/private', 'ws://socket.test/private', 'wss://secure-socket.test/private',
    'file://local.test/private', 'data:image/png,PRIVATE', 'inline',
    'http://plain.test/private?q=secret', 'https://secure.test:8443/private?q=secret',
  ]) h.document.emit('securitypolicyviolation', { effectiveDirective: 'img-src', blockedURI });
  h.advance(500);
  const report = h.ofType('dk-edit-blocked')[0].data;
  assert.equal(report.counts.img, 11);
  assert.deepEqual(report.hosts, ['plain.test', 'secure.test:8443']);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${token}|private|secret`, 'i'));
});

test('source contains one of each injection marker and no content/network/execution APIs', () => {
  for (const marker of ['__DK_CHAN__', '__DK_GEN__']) assert.equal(source.split(marker).length - 1, 1);
  for (const forbidden of [
    /\binnerHTML\b/, /\bouterHTML\b/, /\btextContent\b/, /\bfetch\b/, /\bXMLHttpRequest\b/,
    /\blocalStorage\b/, /\bsessionStorage\b/, /\beval\b/, /\bFunction\s*\(/, /contenteditable/i,
    /\binnerText\b/, /\bnodeValue\b/, /\binsertAdjacentHTML\b/, /\bdocument\s*\.\s*write\b/,
    /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bwindow\s*\.\s*open\b/,
    /\blocation\b/, /\bcookie\b/, /\bgetComputedStyle\b/, /\bgetSelection\b/,
    /\bdocument\s*\.\s*[\w$]+\s*\(/,
    /\b(?:require|import|export)\b/,
  ]) assert.doesNotMatch(source, forbidden);
  assert.match(source, /attachShadow\.call\(host, \{ mode: 'closed' \}\)/);
  assert.match(source, /window\.parent\.postMessage\(message, '\*'\)/);
  assert.equal([...source.matchAll(/\bpostMessage\b/g)].length, 1);
  const attributeCalls = [...source.matchAll(/\bgetAttribute\s*(?:\.\s*call\s*)?\(([^)]*)\)/g)];
  assert.ok(attributeCalls.length > 0);
  for (const call of attributeCalls) assert.match(call[1], /(?:^|,)\s*'data-dk-node'\s*$/);
});
