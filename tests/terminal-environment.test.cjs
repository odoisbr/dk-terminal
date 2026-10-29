const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalEnvironment } = require('../electron/terminal-environment.cjs');
test('terminais independentes persistem o histórico do Claude sem herdar marcadores de sessão filha', () => {
  const source = { PATH: '/bin', SHELL: '/bin/zsh', CLAUDE_CODE_CHILD_SESSION: 'inherited', CLAUDECODE: '1', CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '0', ANTHROPIC_MODEL: 'configured-model', ANTHROPIC_BASE_URL: 'https://configured.example.test', DK_TERMINAL_TEST: '1', ELECTRON_RUN_AS_NODE: '1' };
  const result = terminalEnvironment(source);
  assert.equal(result.TERM_PROGRAM_VERSION, require('../package.json').version);
  assert.equal(result.CLAUDE_CODE_CHILD_SESSION, undefined);
  assert.equal(result.CLAUDECODE, undefined);
  assert.equal(result.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, '1');
  assert.equal(result.ANTHROPIC_MODEL, source.ANTHROPIC_MODEL);
  assert.equal(result.ANTHROPIC_BASE_URL, source.ANTHROPIC_BASE_URL);
  assert.equal(result.DK_TERMINAL_TEST, undefined);
  assert.equal(result.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(source.CLAUDE_CODE_CHILD_SESSION, 'inherited');
  assert.equal(source.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, '0');
});
