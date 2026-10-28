function terminalEnvironment(base) {
  const env = { ...base, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'DK_Terminal', TERM_PROGRAM_VERSION: '0.1.0' };
  for (const key of Object.keys(env)) if (key.startsWith('DK_TERMINAL_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  // Independent terminal sessions must not inherit the launcher's child-session state.
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.CLAUDECODE;
  env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
  return env;
}
module.exports = { terminalEnvironment };
