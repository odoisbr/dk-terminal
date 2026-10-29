const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PREVIEW_INSTRUCTIONS } = require('../electron/preview-instructions.cjs');
const { USAGE } = require('../dock-tools/dock-preview.cjs');

test('a instrução copiada para IA é a mesma do README e cita o comando embutido', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(readme.includes('```markdown\n' + PREVIEW_INSTRUCTIONS + '```'), 'README precisa repetir a instrução literalmente');
  assert.match(PREVIEW_INSTRUCTIONS, /^ {4}dock-preview <alvo> \[--titulo "Texto"\]$/m);
  assert.match(USAGE, /^Uso: dock-preview <alvo> \[--titulo "Texto"\]/);
  assert.ok(fs.statSync(path.join(__dirname, '..', 'dock-tools', 'bin', 'dock-preview')).mode & 0o111, 'o script precisa ser executável');
});
