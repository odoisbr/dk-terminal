(() => {
  'use strict';

  // Named author elements can override even built-ins on Document and forms.
  // Resolve DOM operations from prototypes before touching either object.
  const addEventListener = EventTarget.prototype.addEventListener;
  const removeEventListener = EventTarget.prototype.removeEventListener;
  const querySelectorAll = Document.prototype.querySelectorAll;
  const createElement = Document.prototype.createElement;
  const documentElement = Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement').get;
  const readyState = Object.getOwnPropertyDescriptor(Document.prototype, 'readyState').get;
  const elementClosest = Element.prototype.closest;
  const getAttribute = Element.prototype.getAttribute;
  const setAttribute = Element.prototype.setAttribute;
  const attachShadow = Element.prototype.attachShadow;
  const getBoundingClientRect = Element.prototype.getBoundingClientRect;
  const localName = Object.getOwnPropertyDescriptor(Element.prototype, 'localName').get;
  const parentNode = Object.getOwnPropertyDescriptor(Node.prototype, 'parentNode').get;
  const nodeType = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType').get;
  const isConnected = Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected').get;
  const appendChild = Node.prototype.appendChild;
  const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src').get;
  const imageCurrentSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'currentSrc').get;
  const linkHref = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href').get;
  const linkAs = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'as').get;
  const linkRelList = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'relList').get;
  const tokenContains = DOMTokenList.prototype.contains;

  // Replaced by the main process in the served copy, never in the author file.
  const chan = '__DK_CHAN__';
  const gen = __DK_GEN__;
  const MAX_NODES = 200000;
  const sentAt = [];
  const now = () => performance.now();

  function send(type, fields) {
    const message = { type, dk: 1, v: 1, chan, gen, ...fields };
    // All outgoing strings are ASCII (URL.host is normalized by URL).
    if (JSON.stringify(message).length > 16 * 1024) return false;
    const time = now();
    while (sentAt.length && time - sentAt[0] >= 1000) sentAt.shift();
    if (sentAt.length >= 30) return false; // Drop excess intentions.
    sentAt.push(time);
    window.parent.postMessage(message, '*');
    return true;
  }

  const validNode = value => Number.isInteger(value) && value >= 0 && value < MAX_NODES;
  function closest(target, selector) {
    if (!(target instanceof Node)) return null;
    const element = nodeType.call(target) === 1 ? target : parentNode.call(target);
    return element && nodeType.call(element) === 1 ? elementClosest.call(element, selector) : null;
  }

  // Only the injected identity is read. Author content never enters a message.
  function nodeId(element) {
    if (!element) return null;
    const value = getAttribute.call(element, 'data-dk-node');
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,5})$/.test(value)) return null;
    const node = Number(value);
    return validNode(node) ? node : null;
  }

  function elementsFor(node) {
    return querySelectorAll.call(document, '[data-dk-node="' + node + '"]');
  }

  const host = createElement.call(document, 'div');
  setAttribute.call(host, 'aria-hidden', 'true');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;'
    + 'pointer-events:none!important;z-index:2147483647!important;';
  const shadow = attachShadow.call(host, { mode: 'closed' });

  function makeOutline(color, line) {
    const box = createElement.call(document, 'div');
    box.style.cssText = 'all:initial;position:fixed;pointer-events:none;box-sizing:border-box;'
      + 'display:none;outline:2px ' + line + ' ' + color + ';outline-offset:-2px;';
    appendChild.call(shadow, box);
    return box;
  }

  const selectionBox = makeOutline('#2563eb', 'solid');
  const hoverBox = makeOutline('#0891b2', 'dashed');
  let selected = null;
  let hovered = null;

  function outline(box, element) {
    if (!element || !isConnected.call(element)) {
      box.style.display = 'none';
      return;
    }
    const rect = getBoundingClientRect.call(element);
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  }

  function paint() {
    outline(selectionBox, selected);
    outline(hoverBox, hovered);
  }

  function block(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function select(event) {
    block(event);
    const element = closest(event.target, '[data-dk-node]');
    const node = nodeId(element);
    if (node === null) return;
    const count = elementsFor(node).length;
    if (count < 1 || count > 64) return;
    if (send('dk-edit-select', { node, count })) {
      selected = element;
      paint();
    }
  }

  addEventListener.call(document, 'click', select, true);
  addEventListener.call(document, 'auxclick', select, true);
  addEventListener.call(document, 'submit', block, true);
  addEventListener.call(document, 'dragstart', block, true);
  addEventListener.call(document, 'keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar')
        && closest(event.target, 'a,area,button,input[type="button"],input[type="submit"],input[type="reset"]')) {
      block(event);
    }
  }, true);
  addEventListener.call(document, 'pointermove', event => {
    hovered = closest(event.target, '[data-dk-node]');
    if (nodeId(hovered) === null) hovered = null;
    paint();
  }, true);
  addEventListener.call(document, 'mouseout', event => {
    if (event.relatedTarget !== null) return;
    hovered = null;
    paint();
  }, true);
  window.addEventListener('resize', paint);

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const keys = Object.keys(data).sort().join(',');
    if (keys !== 'chan,dk,gen,node,type,v' && keys !== 'chan,dk,gen,node,scrollY,type,v') return;
    if (data.type !== 'dk-edit-mark' || data.dk !== 1 || data.v !== 1
        || data.chan !== chan || data.gen !== gen) return;
    if (data.node !== null && !validNode(data.node)) return;
    const hasScroll = Object.prototype.hasOwnProperty.call(data, 'scrollY');
    if (hasScroll && (typeof data.scrollY !== 'number' || !Number.isFinite(data.scrollY) || data.scrollY < 0)) return;
    const matches = data.node === null ? [] : elementsFor(data.node);
    if (data.node !== null && (matches.length < 1 || matches.length > 64)) return;
    selected = matches[0] || null;
    if (hasScroll) window.scrollTo({ top: data.scrollY, behavior: 'instant' });
    paint();
  });

  let scrollTimer = null;
  let lastScroll = -Infinity;
  function reportScroll() {
    scrollTimer = null;
    lastScroll = now();
    send('dk-edit-scroll', { y: Math.max(0, window.scrollY) });
  }
  window.addEventListener('scroll', () => {
    paint();
    if (scrollTimer !== null) return;
    const wait = 250 - (now() - lastScroll);
    if (wait <= 0) reportScroll();
    else scrollTimer = setTimeout(reportScroll, wait);
  }, { passive: true });

  const emptyCounts = () => ({ img: 0, style: 0, font: 0, connect: 0, other: 0 });
  let counts = emptyCounts();
  const hosts = new Set();
  let blockedTimer = null;

  function reportBlocked() {
    blockedTimer = null;
    if (send('dk-edit-blocked', { counts, hosts: Array.from(hosts) })) {
      counts = emptyCounts();
      hosts.clear();
    } else {
      // Keep resource totals until the global budget allows a later report.
      blockedTimer = setTimeout(reportBlocked, 500);
    }
  }

  function recordBlocked(category, resource) {
    counts[category] = Math.min(Number.MAX_SAFE_INTEGER, counts[category] + 1);
    if (hosts.size < 10 && typeof resource === 'string') {
      try {
        // Only web hosts; never expose the private preview token.
        const url = new URL(resource);
        if ((url.protocol === 'http:' || url.protocol === 'https:')
            && url.host && url.host.length <= 253) hosts.add(url.host);
      } catch { /* CSP also reports tokens such as "inline". */ }
    }
    if (blockedTimer === null) {
      blockedTimer = setTimeout(reportBlocked, 500);
    }
  }

  addEventListener.call(document, 'securitypolicyviolation', event => {
    const directive = event.effectiveDirective;
    if (directive === 'script-src' || directive === 'script-src-elem' || directive === 'script-src-attr') return;
    let category = 'other';
    if (directive === 'img-src') category = 'img';
    else if (directive === 'style-src' || directive === 'style-src-elem' || directive === 'style-src-attr') category = 'style';
    else if (directive === 'font-src') category = 'font';
    else if (directive === 'connect-src') category = 'connect';
    recordBlocked(category, event.blockedURI);
  }, true);

  addEventListener.call(document, 'error', event => {
    const element = event.target;
    if (!(element instanceof Element)) return;
    // Resource properties are used only to extract a host, never forwarded.
    if (localName.call(element) === 'img') recordBlocked('img', imageCurrentSrc.call(element) || imageSrc.call(element));
    else if (localName.call(element) === 'link') {
      const as = linkAs.call(element);
      const category = as === 'font' ? 'font'
        : tokenContains.call(linkRelList.call(element), 'stylesheet') || as === 'style' ? 'style'
          : as === 'image' ? 'img' : 'other';
      recordBlocked(category, linkHref.call(element));
    }
  }, true);

  function ready() {
    removeEventListener.call(document, 'DOMContentLoaded', ready);
    appendChild.call(documentElement.call(document), host);
    send('dk-edit-ready', {
      nodes: Math.min(MAX_NODES, querySelectorAll.call(document, '[data-dk-node]').length),
      scripts_off: true,
    });
  }

  if (readyState.call(document) === 'loading') addEventListener.call(document, 'DOMContentLoaded', ready);
  else ready();
})();
