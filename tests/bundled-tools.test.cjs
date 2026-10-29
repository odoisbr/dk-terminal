const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bundledToolsPath, withBundledTools } = require('../electron/bundled-tools.cjs');

function fakeTree(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-bundled-'));
  const bin = kind === 'packaged' ? path.join(root, 'Resources', 'sea-cli', 'bin') : path.join(root, 'app', 'vendor', 'sea-cli', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'sea'), '#!/bin/sh\n');
  return { root, bin };
}

test('o sea embutido é encontrado em Resources no pacote e em vendor/ no desenvolvimento', () => {
  const packaged = fakeTree('packaged');
  assert.equal(bundledToolsPath({ isPackaged: true, resourcesPath: path.join(packaged.root, 'Resources'), appPath: '/nao-usado' }), packaged.bin);
  const dev = fakeTree('dev');
  assert.equal(bundledToolsPath({ isPackaged: false, resourcesPath: '/nao-usado', appPath: path.join(dev.root, 'app') }), dev.bin);
  assert.equal(bundledToolsPath({ isPackaged: true, resourcesPath: path.join(dev.root, 'vazio'), appPath: dev.root }), null);
});

test('a pasta embutida entra no fim do PATH, sem repetir e sem alterar o ambiente original', () => {
  const env = { PATH: '/usr/bin:/bin', HOME: '/Users/teste' };
  const result = withBundledTools(env, '/App/Resources/sea-cli/bin');
  assert.equal(result.PATH, '/usr/bin:/bin:/App/Resources/sea-cli/bin');
  assert.equal(result.HOME, '/Users/teste');
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(withBundledTools(result, '/App/Resources/sea-cli/bin').PATH, result.PATH);
  assert.equal(withBundledTools(env, null), env);
  assert.equal(withBundledTools({}, '/x/bin').PATH, '/x/bin');
});
