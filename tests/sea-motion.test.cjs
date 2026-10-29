const { test } = require('node:test');
const assert = require('node:assert/strict');

const motion = import('../src/sea-motion.mjs');

function fixture({ reduced = false, failGeometry = false } = {}) {
  const classes = new Set(), frames = new Map(), nodes = new Map();
  let nextFrame = 0;
  for (const id of ['ring', 'grey', 'white', 'exact', 'vlogo', 'vWord', 'src', 'srcBump', 'srcTail', 'srcBowl']) {
    const attrs = new Map();
    nodes.set(id, {
      attrs,
      setAttribute: (key, value) => attrs.set(key, String(value)),
      getBBox: () => {
        if (failGeometry) throw new Error('SVG geometry unavailable');
        return { x: 212.8, y: 1895, width: 53, height: 39 };
      },
      getTotalLength: () => 100,
      getPointAtLength: value => ({ x: 212.8 + 53 * value / 100, y: 1905 + 8 * Math.sin(value / 10) }),
    });
  }
  const stage = {
    isConnected: true,
    ownerDocument: { body: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } } },
    querySelector: selector => nodes.get(selector.slice(1)),
  };
  const env = {
    matchMedia: () => ({ matches: reduced }),
    performance: { now: () => 200 },
    requestAnimationFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  const advance = timestamp => {
    const entry = frames.entries().next().value;
    assert.ok(entry, 'deve existir um quadro agendado');
    frames.delete(entry[0]); entry[1](timestamp);
  };
  return { stage, env, classes, frames, nodes, advance };
}

test('motion SEA segue a sequência fornecida e termina sem quadros pendentes', async () => {
  const { playSeaMotion } = await motion;
  const { stage, env, classes, frames, nodes, advance } = fixture();
  const animation = playSeaMotion(stage, env);
  assert.equal(animation.finishBy, 1400);
  assert.equal(classes.has('sea-motion-playing'), true);
  assert.equal(frames.size, 1);
  advance(600);
  assert.ok(nodes.get('grey').attrs.get('d').startsWith('M'));
  assert.equal(nodes.get('vlogo').attrs.get('display'), 'none');
  advance(1100);
  assert.equal(nodes.get('exact').attrs.get('display'), 'inline');
  advance(1400);
  assert.equal(nodes.get('vlogo').attrs.get('display'), 'inline');
  assert.equal(nodes.get('vWord').attrs.get('opacity'), '1.000');
  assert.equal(nodes.get('ring').attrs.get('opacity'), '0.000');
  assert.equal(frames.size, 0);
  animation.complete();
  assert.equal(frames.size, 0);
});

test('conclusão antecipa a marca final e cancela quadros pendentes', async () => {
  const { playSeaMotion } = await motion;
  const { stage, env, frames, nodes } = fixture();
  const animation = playSeaMotion(stage, env);
  assert.equal(frames.size, 1);
  animation.complete();
  assert.equal(nodes.get('vlogo').attrs.get('display'), 'inline');
  assert.equal(nodes.get('vWord').attrs.get('opacity'), '1.000');
  assert.equal(frames.size, 0);
});

test('movimento reduzido mantém fallback e evita cálculo e animação', async () => {
  const { playSeaMotion } = await motion;
  const { stage, env, frames, classes } = fixture({ reduced: true, failGeometry: true });
  const animation = playSeaMotion(stage, env);
  assert.equal(animation.finishBy, 0);
  assert.equal(classes.has('sea-motion-playing'), false);
  assert.equal(frames.size, 0);
  animation.complete();
});

test('falha no SVG mantém a marca estática sem impedir a abertura', async () => {
  const { playSeaMotion } = await motion;
  const { stage, env, frames, classes } = fixture({ failGeometry: true });
  const animation = playSeaMotion(stage, env);
  assert.equal(animation.finishBy, 0);
  assert.equal(classes.has('sea-motion-playing'), false);
  assert.equal(frames.size, 0);
  animation.complete();
});
