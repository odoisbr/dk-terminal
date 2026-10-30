// Synthetic offline protocol fixture. Tests install this with process.execPath
// as its shebang and put only synthetic directories in PATH. No provider is contacted.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const mode = process.env.DK_FAKE_CLAUDE_MODE || 'ok';
const log = data => { if (process.env.DK_TEST_LOG) fs.appendFileSync(process.env.DK_TEST_LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...data }) + '\n'); };
log({ spawn: args, executable: process.argv[1], cwd: process.cwd() });
if (args.includes('--group-child')) {
  process.on('SIGTERM', () => {
    log({ signal: 'SIGTERM' });
    setTimeout(() => { log({ groupChildExiting: true }); process.exit(0); }, 20);
  });
  setInterval(() => {}, 1000);
  process.send({ ready: true });
  return;
}
if (args.includes('--version')) {
  const version = () => process.stdout.write((process.env.DK_FAKE_VERSION || '2.1.312 (Claude Code)') + '\n');
  const marker = process.env.DK_TEST_LOG + '.probe-once';
  if (process.env.DK_FAKE_SLOW_PROBE_ONCE && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'probe started');
    setTimeout(version, 11000);
  } else version();
  return;
}
if (args.includes('--help')) {
  let help = fs.readFileSync(path.join(__dirname, 'claude-help.txt'), 'utf8');
  if (process.env.DK_FAKE_MISSING_FLAG) help = help.replaceAll(process.env.DK_FAKE_MISSING_FLAG, 'flag-removed');
  process.stdout.write(help);
  return;
}
if (!args.includes('-p')) { process.stderr.write('unknown option\n'); process.exitCode = 1; return; }
const value = name => args[args.indexOf(name) + 1];
const session = value(args.includes('--resume') ? '--resume' : '--session-id');
const promptFile = value('--append-system-prompt-file');
log({ promptFile, promptMode: fs.statSync(promptFile).mode & 0o777, prompt: fs.readFileSync(promptFile, 'utf8'),
  env: { terminal: process.env.DK_TERMINAL_SHOULD_REMOVE || null, electron: process.env.ELECTRON_RUN_AS_NODE || null, preview: process.env.SEA_PREVIEW_TEST || null, guide: process.env.SEA_DOCK_AGENTS_MD || null } });
const out = message => process.stdout.write(JSON.stringify(message) + '\n');
const stream = event => out({ type: 'stream_event', event, session_id: session });
const text = text => stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const toolResult = (content = 'synthetic output', is_error = false) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content, is_error }] } });
const assistant = value => out({ type: 'assistant', message: { id: 'message-1', content: [{ type: 'text', text: value }, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'printf synthetic' } }], usage: { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 2 } } });
const result = () => {
  log({ result: true });
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 25, total_cost_usd: 0.01, permission_denials: [], session_id: session, usage: { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 2 } });
  if (mode === 'result-delay') setTimeout(() => log({ exitingAfterResult: true }), 2000);
};
const toolStart = () => stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} } });
const ask = (id = 'cli-approval-1') => out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Terminal', tool_use_id: 'tool-1',
  input: { command: process.env.DK_FAKE_LARGE_INPUT ? 'x'.repeat(17 * 1024) : 'printf synthetic', file_path: 'test.txt', nested: { keep: true } },
  description: 'Synthetic permission', blocked_path: '/synthetic/blocked', decision_reason: 'Synthetic reason',
  permission_suggestions: [{ type: 'setMode', mode: 'bypassPermissions', marker: 'SUGGESTIONS_MUST_NOT_ESCAPE' }] } });
const finish = denied => { toolResult('synthetic output', denied); text('completa.'); assistant('Resposta completa.'); result(); };
let descendant = null;
if (mode === 'cancel-resistant' || mode === 'result-resistant') {
  process.on('SIGTERM', () => log({ signal: 'SIGTERM' }));
  // Optional detached descendant verifies snapshot cleanup after leader death.
  if (process.env.DK_FAKE_DESCENDANT) {
    descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    log({ descendant: descendant.pid }); descendant.unref();
  }
}
if (mode === 'result-hang' || mode === 'result-delay') process.on('SIGTERM', () => { log({ signal: 'SIGTERM' }); process.exit(0); });
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  const request = JSON.parse(line); log({ stdin: request });
  if (request.type === 'control_request' && request.request?.subtype === 'interrupt') {
    if (mode !== 'cancel-resistant') { result(); input.close(); process.stdin.destroy(); }
    return;
  }
  if (request.type === 'control_response') {
    const response = request.response;
    if (response.request_id === 'cli-approval-1' && response.subtype === 'success') finish(response.response.behavior === 'deny');
    if (response.subtype === 'error' && mode === 'unsupported-control') finish();
    return;
  }
  if (request.type !== 'user') return;
  if (mode === 'exit-early') { process.stderr.write('unknown option: --permission-prompt-tool\n'); process.exitCode = 1; input.close(); process.stdin.destroy(); return; }
  if (mode === 'invalid-option-value') { process.stderr.write(process.env.DK_FAKE_PROTOCOL_STDERR + '\n'); process.exitCode = 1; input.close(); process.stdin.destroy(); return; }
  if (mode === 'hang-init' || mode === 'exit-early-transient') {
    process.stderr.write('synthetic init diagnostic 1\n');
    process.stderr.write('synthetic init diagnostic 2\n');
    if (process.env.DK_FAKE_LARGE_STDERR) process.stderr.write('á'.repeat(40 * 1024));
    if (mode === 'exit-early-transient') { process.exitCode = 1; input.close(); process.stdin.destroy(); }
    return;
  }
  if (mode === 'resume' && !args.includes('--resume')) { process.stderr.write('expected --resume\n'); process.exitCode = 1; input.close(); process.stdin.destroy(); return; }
  out({ type: 'system', subtype: 'init', permissionMode: process.env.DK_FAKE_INIT_MODE || (mode === 'bypass-init' ? 'bypassPermissions' : 'manual'), session_id: mode === 'wrong-session' ? 'divergent-session' : session, model: 'synthetic-model', tools: ['Bash', 'Read'] });
  out(request); // replay-user-messages
  stream({ type: 'message_start', message: { id: 'message-1' } });
  out({ type: 'future_extension', private: 'UNKNOWN_MUST_NOT_ESCAPE' });
  stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'THINKING_MUST_NOT_ESCAPE' } });
  if (mode === 'multibyte') {
    const wire = Buffer.from('\n' + JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Olá 🌊\nsegunda linha' } } }) + '\r\n');
    const emoji = wire.indexOf(Buffer.from('🌊'));
    for (const chunk of [wire.subarray(0, emoji + 1), wire.subarray(emoji + 1, emoji + 3), wire.subarray(emoji + 3, wire.length - 1), wire.subarray(wire.length - 1)]) {
      process.stdout.write(chunk); await new Promise(resolve => setTimeout(resolve, 20));
    }
    // Unterminated final JSON is flushed on EOF.
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: session }));
    input.close(); process.stdin.destroy(); return;
  }
  if (mode === 'invalid-json') { process.stdout.write('{bad\nnot json\n{\n'); return; }
  if (mode === 'out-of-order') {
    toolResult(); toolStart(); text('antes do result'); result(); text('AFTER_RESULT_MUST_NOT_ESCAPE'); ask('late-approval'); return;
  }
  if (mode === 'large') {
    text('🌊'.repeat(100000));
    toolResult('á'.repeat(60000));
    await new Promise(resolve => setTimeout(resolve, 100));
    process.stdout.write('x'.repeat(1024 * 1024 + 1) + '\n'); return;
  }
  text('Resposta '); toolStart();
  stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"printf synthetic"}' } });
  stream({ type: 'message_delta', usage: { output_tokens: 2 } });
  if (mode === 'approval') {
    ask();
    if (process.env.DK_FAKE_EVENT_FLOOD) for (let index = 0; index < 600; index++) toolResult('bounded event ' + index);
    if (process.env.DK_FAKE_CANCEL_REQUEST) setTimeout(() => { out({ type: 'control_cancel_request', request_id: 'cli-approval-1' }); }, 100);
  } else if (mode === 'unsupported-control') {
    out({ type: 'control_request', request_id: 'unsupported-1', request: { subtype: process.env.DK_FAKE_CONTROL || 'hook_callback' } });
  } else if (mode === 'slow' || mode === 'cancel-resistant' || mode === 'bypass-init') {
    if (process.env.DK_FAKE_EVENT_FLOOD) for (let index = 0; index < 600; index++) toolResult('bounded event ' + index);
  } else {
    if (mode === 'result-group-child') {
      const child = spawn(process.execPath, [__filename, '--group-child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      await new Promise(resolve => child.once('message', resolve));
      log({ groupChild: child.pid }); child.disconnect(); child.unref();
    }
    finish();
  }
});
if (['cancel-resistant', 'result-hang', 'result-resistant'].includes(mode)) {
  // Stay alive after EOF; resistant modes also ignore SIGTERM.
  setInterval(() => {}, 1000);
}
