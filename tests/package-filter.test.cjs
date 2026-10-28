const { test } = require('node:test');
const assert = require('node:assert/strict');

test('distribuição aceita só arquivos do aplicativo e exclui credenciais', async () => {
  const { packageIgnores } = await import('../scripts/package-filter.mjs');
  const excluded = value => packageIgnores.some(pattern => pattern.test(value));
  for (const value of ['/notes.txt', '/.gitignore', '/integrations/example', '/dist/.env', '/assets/secrets.pem', '/electron/.npmrc', '/node_modules/unrelated/index.js']) assert.equal(excluded(value), true, value);
  for (const value of ['/package.json', '/dist/index.html', '/electron/main.cjs', '/extensions/claude/extension.json', '/assets/dk-logo.svg', '/node_modules/node-pty/index.js']) assert.equal(excluded(value), false, value);
});
