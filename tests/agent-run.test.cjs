const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { AgentRun, normalize, claude, LIMITS } = require('../electron/agent-run.cjs');

const fixtureDir = path.join(__dirname, 'fixtures', 'agent-run');
const platform = { skip: process.platform === 'win32' ? 'Fixture executável com shebang Unix; Windows não validado.' : false };
const terminal = new Set(['concluido', 'interrompido', 'falhou', 'expirada']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return; await delay(10); }
  assert.fail('Tempo esgotado aguardando CLI sintética.');
}
function fixture(t, mode = 'ok', config = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sea-agent-run-')));
  const root = path.join(temp, 'project'), other = path.join(temp, 'other'), bin = path.join(temp, 'bin'), privateDir = path.join(temp, 'private');
  for (const dir of [root, other, bin, privateDir]) fs.mkdirSync(dir);
  const binary = path.join(bin, 'claude');
  fs.writeFileSync(binary, `#!${process.execPath}\n${fs.readFileSync(path.join(fixtureDir, 'fake-claude.cjs'), 'utf8')}`, { mode: 0o755 });
  fs.copyFileSync(path.join(fixtureDir, 'claude-help.txt'), path.join(bin, 'claude-help.txt'));
  const storeFile = path.join(privateDir, 'agent-runs.json'), runsDir = path.join(privateDir, 'agent-runs'), logFile = path.join(temp, 'wire.jsonl');
  const events = [];
  const env = { ...process.env, PATH: bin, DK_FAKE_CLAUDE_MODE: mode, DK_TEST_LOG: logFile,
    DK_TERMINAL_SHOULD_REMOVE: 'remove', ELECTRON_RUN_AS_NODE: '1', ...config.env };
  const runner = new (config.Runner || AgentRun)({ env, storeFile, runsDir, emit: e => events.push(e), sources: config.sources,
    previewEnvironment: () => ({ SEA_PREVIEW_TEST: 'preview', DK_TERMINAL_INJECTED: 'remove' }),
    limits: { init_ms: 1000, interrupt_ms: 80, sigkill_ms: 60, ...config.limits } });
  t.after(async () => { await runner.closeAll(); fs.rmSync(temp, { recursive: true, force: true }); });
  const log = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const start = (options = {}, project = root) => runner.start(project, { provider: 'claude', prompt: 'Pedido sintético.', ...options });
  const read = id => runner.read(root, id);
  const done = async (id, project = root, timeout) => { await until(() => terminal.has(runner.read(project, id).run.estado), timeout); return runner.read(project, id); };
  return { temp, root, other, bin, binary, privateDir, storeFile, runsDir, env, runner, events, log, start, read, done };
}
const pending = (f, id, kind = 'tool') => f.runner.read(f.runner.runs.get(id).root, id).eventos.find(e => e.type === 'approval' && e.kind === kind && e.status === 'pending');
const responses = f => f.log().filter(e => e.stdin?.type === 'control_response').map(e => e.stdin.response);

test('contrato exato do argv, prompt privado composto, eventos e histórico', platform, async t => {
  const f = fixture(t, 'approval');
  const guide = path.join(f.temp, 'guide.md'); fs.writeFileSync(guide, 'GUIA_UNICO'); f.runner.sources.guide = guide;
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), 'Instruções deste projeto.');
  const cap = await f.runner.capabilities(f.root);
  assert.equal(cap.claude.binario, f.binary); assert.equal(cap.claude.versao, '2.1.312');
  assert.equal(cap.claude.disponivel, true); assert.equal(cap.claude.aprovacao_host_provada, false);
  assert.match(cap.claude.motivo, /não confirmado/); assert.deepEqual(cap.codex, { disponivel: false, motivo: 'Use o painel Codex' });
  const { runId } = await f.start();
  await until(() => pending(f, runId));
  const promptFile = path.join(f.runsDir, runId, 'system-prompt.md');
  assert.equal(fs.statSync(promptFile).mode & 0o777, 0o600);
  assert.ok(!promptFile.startsWith(f.root + path.sep));
  const wire = f.log(), spawn = wire.find(e => e.spawn?.includes('-p'));
  const expected = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--replay-user-messages', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--permission-mode', 'manual', '--append-system-prompt-file', promptFile, '--setting-sources', 'user,local', '--session-id', f.read(runId).run.sessionId];
  assert.deepEqual(spawn.spawn, expected); assert.equal(spawn.cwd, f.root);
  assert.equal(spawn.spawn[spawn.spawn.indexOf('--setting-sources') + 1], 'user,local');
  assert.ok(wire.filter(e => e.spawn).every(e => e.executable === f.binary));
  assert.ok(!spawn.spawn.some(s => /bypassPermissions|^auto$|dontAsk|acceptEdits|--allowedTools|--dangerously-/.test(s)));
  const prompt = wire.find(e => e.promptFile);
  assert.equal(prompt.prompt.split('GUIA_UNICO').length - 1, 1); assert.match(prompt.prompt, /Instruções deste projeto/);
  assert.deepEqual(prompt.env, { terminal: null, electron: null, preview: 'preview', guide });
  assert.deepEqual(wire.find(e => e.stdin?.type === 'user').stdin, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Pedido sintético.' }] }, parent_tool_use_id: null });
  assert.equal(fs.statSync(f.storeFile).mode & 0o777, 0o600);
  assert.ok(f.runner.resourceRoots().some(r => r.id === runId && r.root === f.root && r.kind === 'claude-run' && r.pid === spawn.pid));
  await f.runner.approve(f.root, runId, pending(f, runId).requestId, 'allow');
  const result = await f.done(runId);
  assert.equal(result.run.estado, 'concluido'); assert.equal(result.run.texto, 'Resposta completa.');
  assert.equal(result.run.usage.output_tokens, 6); assert.equal(result.run.usage.total_cost_usd, 0.01);
  assert.equal(fs.existsSync(promptFile), false); assert.equal(f.runner.resourceRoots().length, 0);
  assert.ok(result.eventos.some(e => e.type === 'tool_use' && e.inputBytes > 0));
  assert.ok(result.eventos.some(e => e.type === 'tool_result'));
  assert.ok(result.eventos.some(e => e.type === 'status' && e.aceito));
  assert.ok(result.run.unknownEvents >= 1);
  const emitted = f.events.filter(e => e.runId === runId);
  assert.ok(emitted.every((e, i) => e.root === f.root && e.at > 0 && (!i || e.seq > emitted[i - 1].seq)));
  assert.equal(emitted.at(-1).type, 'snapshot'); assert.equal(emitted.at(-1).run.estado, 'concluido');
  assert.ok(!JSON.stringify(result).match(/THINKING_MUST|UNKNOWN_MUST|SUGGESTIONS_MUST|cli-approval-1/));
});

for (const choice of ['allow', 'deny']) test(`aprovação ${choice}: identidade tripla, input original, sem sugestões persistidas`, platform, async t => {
  const f = fixture(t, 'approval'), { runId } = await f.start();
  await until(() => pending(f, runId));
  const approval = pending(f, runId);
  assert.notEqual(approval.requestId, 'cli-approval-1'); assert.match(approval.resumo, /printf synthetic/);
  assert.equal(approval.blockedPath, '/synthetic/blocked'); assert.equal(approval.decisionReason, 'Synthetic reason');
  assert.equal(responses(f).length, 0);
  assert.equal(f.runner.list(f.other).length, 0); assert.equal(pending(f, runId).status, 'pending');
  await assert.rejects(f.runner.approve(f.other, runId, approval.requestId, choice), /não encontrada/);
  await assert.rejects(f.runner.approve(f.root, randomUUID(), approval.requestId, choice), /não encontrada/);
  await assert.rejects(f.runner.approve(f.root, runId, randomUUID(), choice), /encerrada/);
  await assert.rejects(f.runner.approve(f.root, runId, approval.requestId, 'acceptForSession'), /uma vez/);
  const second = await f.start(); await until(() => pending(f, second.runId));
  await assert.rejects(f.runner.approve(f.root, second.runId, approval.requestId, choice), /encerrada/);
  f.runner._save();
  const disk = fs.readFileSync(f.storeFile, 'utf8');
  assert.ok(!disk.includes(approval.requestId)); assert.ok(!disk.includes('cli-approval')); assert.ok(!disk.includes('pending')); assert.ok(!disk.includes('permission_suggestions'));
  await f.runner.approve(f.root, runId, approval.requestId, choice);
  const final = await f.done(runId);
  const response = responses(f).find(r => r.request_id === 'cli-approval-1');
  assert.deepEqual(response, { subtype: 'success', request_id: 'cli-approval-1', response: choice === 'allow' ? { behavior: 'allow', updatedInput: approval.input } : { behavior: 'deny', message: 'Recusado no SEA Dock' } });
  assert.equal(final.eventos.find(e => e.type === 'tool_result').is_error, choice === 'deny');
  await assert.rejects(f.runner.approve(f.root, runId, approval.requestId, choice), /encerrada/);
  assert.ok(!JSON.stringify(f.events).includes('permission_suggestions'));
  assert.ok(!JSON.stringify(f.events).includes('SUGGESTIONS_MUST_NOT_ESCAPE'));
});

test('StringDecoder preserva emoji partido, linhas vazias, CRLF e EOF sem newline', platform, async t => {
  const f = fixture(t, 'multibyte'), { runId } = await f.start();
  const final = await f.done(runId);
  assert.equal(final.run.estado, 'concluido'); assert.equal(final.run.texto, 'Olá 🌊\nsegunda linha');
  assert.ok(!JSON.stringify(f.events).includes('�'));
  assert.ok(f.events.some(e => e.type === 'text_delta' && e.value === 'Olá 🌊\nsegunda linha'));
});

test('texto e tool_result truncados em UTF-8; linha >1 MiB aborta com parcial', platform, async t => {
  const f = fixture(t, 'large'), { runId } = await f.start();
  const final = await f.done(runId);
  assert.equal(final.run.estado, 'falhou'); assert.equal(final.run.parcial, true);
  const text = final.eventos.find(e => e.type === 'text_delta').value, tool = final.eventos.find(e => e.type === 'tool_result');
  assert.ok(Buffer.byteLength(text) <= 256 * 1024); assert.match(text, /…\[truncado\]$/); assert.ok(!text.includes('�'));
  assert.ok(Buffer.byteLength(tool.content) <= 64 * 1024); assert.equal(tool.truncado, true); assert.match(tool.content, /\[truncado\]/);
  assert.ok(Buffer.byteLength(final.run.texto) <= 64 * 1024); assert.match(final.run.texto, /\[truncado\]/);
  assert.ok(final.eventos.some(e => e.type === 'error' && /1 MiB/.test(e.message)));
  assert.equal(fs.existsSync(path.join(f.runsDir, runId)), false);
});

test('aprovação acima de 16 KiB é recusada sem expor input truncado como aprovável', platform, async t => {
  const f = fixture(t, 'approval', { env: { DK_FAKE_LARGE_INPUT: '1' } }), { runId } = await f.start();
  const final = await f.done(runId);
  assert.ok(!final.eventos.some(e => e.type === 'approval'));
  assert.equal(responses(f)[0].response.behavior, 'deny');
  assert.ok(final.eventos.some(e => e.type === 'error' && /16 KiB/.test(e.message)));
});

test('prazo pede decisão, mantém processo sem decisão e renova; deny interrompe', platform, async t => {
  const f = fixture(t, 'slow', { limits: { prazo_ms: 80 } }), { runId } = await f.start();
  await until(() => pending(f, runId, 'prazo'));
  const first = pending(f, runId, 'prazo'); assert.equal(f.read(runId).run.estado, 'prazo_vencido');
  await delay(180);
  assert.equal(f.runner.resourceRoots().length, 1); assert.equal(pending(f, runId, 'prazo').requestId, first.requestId);
  assert.ok(!f.log().some(e => e.stdin?.request?.subtype === 'interrupt'));
  await f.runner.approve(f.root, runId, first.requestId, 'allow');
  assert.equal(f.read(runId).run.estado, 'executando');
  await until(() => pending(f, runId, 'prazo'));
  assert.notEqual(pending(f, runId, 'prazo').requestId, first.requestId);
  await f.runner.approve(f.root, runId, pending(f, runId, 'prazo').requestId, 'deny');
  assert.equal(f.read(runId).run.estado, 'interrompido'); assert.equal(f.read(runId).run.parcial, true);
  assert.equal(f.read(runId).run.texto, 'Resposta ');
});

test('cancel expira aprovação, envia deny antes de interrupt e é idempotente', platform, async t => {
  const f = fixture(t, 'approval'), { runId } = await f.start(); await until(() => pending(f, runId));
  const id = pending(f, runId).requestId;
  await Promise.all([f.runner.cancel(f.root, runId), f.runner.cancel(f.root, runId)]);
  assert.equal(f.read(runId).run.estado, 'interrompido');
  assert.equal(f.read(runId).eventos.find(e => e.requestId === id).status, 'expired');
  const inputs = f.log().filter(e => e.stdin).map(e => e.stdin);
  const deny = inputs.findIndex(e => e.response?.response?.behavior === 'deny'), interrupt = inputs.findIndex(e => e.request?.subtype === 'interrupt');
  assert.ok(deny >= 0 && interrupt > deny); assert.match(inputs[interrupt].request_id, /^dk-/);
  await assert.rejects(f.runner.approve(f.root, runId, id, 'allow'), /encerrada/);
  await f.runner.cancel(f.root, runId);
});

test('cancel resistente respeita D9: 5 s, SIGTERM, 1 s, SIGKILL; preserva parcial', platform, async t => {
  const f = fixture(t, 'cancel-resistant', { limits: { interrupt_ms: 5000, sigkill_ms: 1000 } });
  const { runId } = await f.start(); await until(() => f.read(runId).run.estado === 'executando');
  await until(() => f.events.some(e => e.type === 'text_delta'));
  const pid = f.runner.resourceRoots()[0].pid, start = Date.now();
  await f.runner.cancel(f.root, runId);
  const elapsed = Date.now() - start, wire = f.log();
  const interrupted = wire.find(e => e.stdin?.request?.subtype === 'interrupt'), sigterm = wire.find(e => e.signal === 'SIGTERM');
  assert.ok(elapsed >= 5950 && elapsed < 11000, `cancel levou ${elapsed} ms`);
  assert.ok(sigterm.at - interrupted.at >= 4900);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(f.read(runId).run.texto, 'Resposta '); assert.equal(f.read(runId).run.parcial, true);
  assert.equal(f.read(runId).run.estado, 'interrompido');
});

for (const mode of ['invalid-json', 'bypass-init', 'wrong-session', 'exit-early']) test(`falha controlada: ${mode}`, platform, async t => {
  const f = fixture(t, mode, { limits: { init_ms: 1000 } }), { runId } = await f.start();
  if (mode === 'invalid-json') await until(() => f.read(runId).run.invalidLines === 3);
  const result = await f.done(runId);
  assert.equal(result.run.estado, 'falhou'); assert.ok(result.eventos.some(e => e.type === 'error' && e.fatal));
  assert.equal(fs.existsSync(path.join(f.runsDir, runId)), false);
  if (mode === 'invalid-json') assert.equal(result.run.invalidLines, 3);
  else {
    assert.equal((await f.runner.capabilities(f.root)).claude.disponivel, false);
    await assert.rejects(f.start(), /init|permissionMode|opção|encerrou|sessão/);
    if (mode === 'exit-early') assert.match(result.eventos.find(e => e.type === 'status' && e.estado === 'falhou').motivo, /unknown option/);
  }
});

for (const mode of ['hang-init', 'exit-early-transient']) test(`${mode} preserva stderr limitado e permite nova execução`, platform, async t => {
  const f = fixture(t, mode, { limits: { init_ms: 1000 }, env: { DK_FAKE_LARGE_STDERR: '1' } });
  const { runId } = await f.start(), result = await f.done(runId);
  assert.equal(result.run.estado, 'falhou');
  const reason = result.eventos.find(e => e.type === 'status' && e.estado === 'falhou').motivo;
  assert.match(reason, mode === 'hang-init' ? /init manual no prazo/ : /encerrou antes do result/);
  assert.match(reason, /synthetic init diagnostic 1\nsynthetic init diagnostic 2/);
  assert.match(reason, /…\[truncado\]$/); assert.ok(!reason.includes('�'));
  assert.ok(Buffer.byteLength(reason) <= 66 * 1024);
  assert.equal(f.runner.dynamicFailures.size, 0);
  assert.equal((await f.runner.capabilities(f.root)).claude.disponivel, true);
  f.env.DK_FAKE_CLAUDE_MODE = 'ok';
  const next = await f.start(); assert.equal((await f.done(next.runId)).run.estado, 'concluido');
});

test('erro de spawn não bloqueia capacidade após restaurar o binário', platform, async t => {
  const f = fixture(t);
  f.runner.sources.guide = () => { fs.chmodSync(f.binary, 0o600); return 'Guia'; };
  const first = await f.start(), result = await f.done(first.runId);
  assert.equal(result.run.estado, 'falhou');
  assert.match(result.eventos.find(e => e.type === 'error' && e.fatal).message, /iniciar a CLI/);
  assert.equal(f.runner.dynamicFailures.size, 0);
  fs.chmodSync(f.binary, 0o755); f.runner.sources.guide = () => 'Guia';
  const next = await f.start(); assert.equal((await f.done(next.runId)).run.estado, 'concluido');
});

for (const diagnostic of ["argument 'host' is invalid", 'Allowed choices are: terminal', 'too many arguments']) test(`stderr de protocolo marca CLI indisponível: ${diagnostic}`, platform, async t => {
  const f = fixture(t, 'invalid-option-value', { env: { DK_FAKE_PROTOCOL_STDERR: diagnostic } });
  const { runId } = await f.start(), result = await f.done(runId);
  assert.equal(result.run.estado, 'falhou');
  const reason = result.eventos.find(e => e.type === 'status' && e.estado === 'falhou').motivo;
  assert.match(reason, /CLI recusou uma opção do protocolo/); assert.ok(reason.includes(diagnostic));
  assert.equal((await f.runner.capabilities(f.root)).claude.disponivel, false);
  await assert.rejects(f.start(), /CLI recusou uma opção do protocolo/);
});

test('result aguarda saída natural após 2 s sem cleanup parcial', platform, async t => {
  const f = fixture(t, 'result-delay', { limits: { interrupt_ms: LIMITS.interrupt_ms } });
  const { runId } = await f.start(), result = await f.done(runId, f.root, 8000);
  const wire = f.log(), exit = wire.find(e => e.exitingAfterResult);
  assert.ok(exit); assert.ok(exit.at - wire.find(e => e.result).at >= 1900);
  assert.equal(result.run.estado, 'concluido'); assert.equal(result.run.cleanupPartial, false);
  assert.ok(!wire.some(e => e.signal));
  assert.equal(result.eventos.find(e => e.type === 'status' && e.estado === 'concluido').motivo, undefined);
  assert.equal(fs.existsSync(path.join(f.runsDir, runId)), false);
});

test('líder sai normalmente e filho do grupo encerra com SIGTERM sem cleanup parcial', platform, async t => {
  const f = fixture(t, 'result-group-child', { limits: { interrupt_ms: 1000, sigkill_ms: 300 } });
  const { runId } = await f.start(), result = await f.done(runId);
  const wire = f.log(), child = wire.find(e => e.groupChild);
  assert.ok(child); assert.ok(wire.some(e => e.pid === child.groupChild && e.signal === 'SIGTERM'));
  assert.ok(wire.some(e => e.pid === child.groupChild && e.groupChildExiting));
  assert.ok(!wire.some(e => e.pid === child.pid && e.signal));
  assert.equal(result.run.estado, 'concluido'); assert.equal(result.run.cleanupPartial, false);
  const status = result.eventos.find(e => e.type === 'status' && e.estado === 'concluido');
  assert.equal(status.cleanupPartial, false); assert.equal(status.motivo, undefined);
  assert.throws(() => process.kill(child.groupChild, 0), { code: 'ESRCH' });
});

for (const [mode, signal] of [['result-hang', 'SIGTERM'], ['result-resistant', 'SIGKILL']]) test(`${mode}: fim forçado informa cleanupPartial e ${signal}`, platform, async t => {
  const f = fixture(t, mode, { limits: { interrupt_ms: mode === 'result-hang' ? LIMITS.interrupt_ms : 300 } });
  const { runId } = await f.start(), result = await f.done(runId, f.root, 8000);
  const wire = f.log(), sigterm = wire.find(e => e.signal === 'SIGTERM');
  assert.ok(sigterm); assert.ok(sigterm.at - wire.find(e => e.result).at >= f.runner.limits.interrupt_ms * 0.9);
  assert.equal(result.run.estado, 'concluido'); assert.equal(result.run.cleanupPartial, true);
  const status = result.eventos.find(e => e.type === 'status' && e.estado === 'concluido');
  assert.equal(status.cleanupPartial, true); assert.match(status.motivo, new RegExp(signal));
  assert.throws(() => process.kill(sigterm.pid, 0), { code: 'ESRCH' });
  assert.equal(f.runner.resourceRoots().length, 0); assert.equal(fs.existsSync(path.join(f.runsDir, runId)), false);
});

for (const mode of ['auto', 'dontAsk', 'acceptEdits', 'plan', '']) test(`init só aceita manual, rejeita ${mode || 'ausente'}`, platform, async t => {
  const f = fixture(t, 'slow', { env: { DK_FAKE_INIT_MODE: mode || 'undefined' } }), { runId } = await f.start();
  assert.equal((await f.done(runId)).run.estado, 'falhou');
  assert.equal((await f.runner.capabilities(f.root)).claude.disponivel, false);
});

for (const subtype of ['hook_callback', 'mcp_message', 'request_user_dialog', 'elicitation']) test(`controle não suportado: ${subtype}`, platform, async t => {
  const f = fixture(t, 'unsupported-control', { env: { DK_FAKE_CONTROL: subtype } }), { runId } = await f.start();
  assert.equal((await f.done(runId)).run.estado, 'concluido');
  assert.deepEqual(responses(f), [{ subtype: 'error', request_id: 'unsupported-1', error: 'não suportado' }]);
  assert.ok(f.events.some(e => e.type === 'error' && !e.fatal));
});

test('control_cancel_request expira somente o pedido, não mata o processo', platform, async t => {
  const f = fixture(t, 'approval', { env: { DK_FAKE_CANCEL_REQUEST: '1' } }), { runId } = await f.start();
  await until(() => f.read(runId).eventos.some(e => e.type === 'approval' && e.status === 'expired'));
  const approval = f.read(runId).eventos.find(e => e.type === 'approval');
  assert.equal(f.read(runId).run.estado, 'executando'); assert.equal(f.runner.resourceRoots().length, 1);
  await assert.rejects(f.runner.approve(f.root, runId, approval.requestId, 'allow'), /encerrada/);
});

test('fora de ordem: tool_result antes do início; eventos após result são ignorados', platform, async t => {
  const f = fixture(t, 'out-of-order'), { runId } = await f.start();
  const result = await f.done(runId);
  assert.equal(result.run.estado, 'concluido'); assert.equal(result.run.texto, 'antes do result');
  assert.ok(result.eventos.findIndex(e => e.type === 'tool_result') < result.eventos.findIndex(e => e.type === 'tool_use'));
  const count = f.events.length; await delay(100); assert.equal(f.events.length, count);
  assert.ok(!JSON.stringify(f.events).match(/AFTER_RESULT|late-approval/));
});

test('capabilities sem raiz recusa sem sondar, inclusive com cache ou runner fechado', platform, async t => {
  const f = fixture(t);
  for (const root of [undefined, null, '']) await assert.rejects(f.runner.capabilities(root), /raiz/);
  await assert.rejects(f.runner.capabilities(path.join(f.temp, 'ausente')), { code: 'ENOENT' });
  assert.deepEqual(f.log(), []);
  await f.runner.capabilities(f.root);
  const probes = f.log();
  await assert.rejects(f.runner.capabilities(), /raiz/);
  await f.runner.closeAll();
  await assert.rejects(f.runner.capabilities(), /raiz/);
  assert.deepEqual(f.log(), probes);
});

test('capacidade estática usa cache por binário+mtime e exige versão/flags/manual', platform, async t => {
  const f = fixture(t);
  await f.runner.capabilities(f.root); await f.runner.capabilities(f.root);
  assert.equal(f.log().filter(e => e.spawn?.includes('--version')).length, 1);
  let tick = Date.now();
  const invalidate = () => { tick += 1000; fs.utimesSync(f.binary, new Date(tick), new Date(tick)); };
  f.env.DK_FAKE_VERSION = '2.1.311 (Claude Code)'; invalidate();
  assert.equal((await f.runner.capabilities(f.root)).claude.disponivel, false);
  await assert.rejects(f.start(), /capacidade/);
  f.env.DK_FAKE_VERSION = '2.1.312 (Claude Code)';
  for (const flag of ['--permission-prompts', '--permission-prompt-tool', '--input-format', 'stream-json', '--include-partial-messages', '"manual"']) {
    f.env.DK_FAKE_MISSING_FLAG = flag; invalidate();
    assert.equal((await f.runner.capabilities(f.root)).claude.disponivel, false, flag);
  }
  delete f.env.DK_FAKE_MISSING_FLAG; invalidate();
  assert.equal((await f.runner.capabilities(f.root)).claude.disponivel, true);
  assert.ok(!f.log().some(e => e.spawn?.includes('-p')));
  f.env.PATH = path.join(f.temp, 'absent'); assert.equal((await f.runner.capabilities(f.root)).claude.disponivel, false);
});

test('probe lenta expira em 10 s, sai do cache e permite probe rápida sem mudar binário', { ...platform, timeout: 30000 }, async t => {
  const f = fixture(t, 'ok', { env: { DK_FAKE_SLOW_PROBE_ONCE: '1' } });
  const before = fs.statSync(f.binary), started = Date.now();
  assert.equal((await f.runner.capabilities(f.root)).claude.disponivel, false);
  assert.ok(Date.now() - started >= 9900); assert.equal(f.runner.capCache.size, 0);
  assert.equal((await f.runner.capabilities(f.root)).claude.disponivel, true);
  assert.equal(fs.statSync(f.binary).mtimeMs, before.mtimeMs);
  assert.equal(f.log().filter(e => e.spawn?.includes('--version')).length, 2);
  assert.equal(f.log().filter(e => e.spawn?.includes('--help')).length, 1);
  const next = await f.start(); assert.equal((await f.done(next.runId)).run.estado, 'concluido');
});

test('PATH=.:<bin> ignora claude no projeto e resolve somente entrada absoluta', platform, async t => {
  const f = fixture(t), cwd = process.cwd();
  fs.copyFileSync(f.binary, path.join(f.root, 'claude'));
  fs.mkdirSync(path.join(f.root, 'relative-bin'));
  fs.copyFileSync(f.binary, path.join(f.root, 'relative-bin', 'claude'));
  try {
    process.chdir(f.root);
    for (const relative of ['.', 'relative-bin', '']) {
      f.env.PATH = relative + path.delimiter + f.bin;
      assert.equal((await f.runner.capabilities(f.root)).claude.binario, f.binary);
      const { runId } = await f.start(); assert.equal((await f.done(runId)).run.estado, 'concluido');
    }
    assert.ok(f.log().filter(e => e.spawn).every(e => e.executable === f.binary));
  } finally { process.chdir(cwd); }
});

for (const symlink of [false, true]) test(`capabilities e start recusam binário do projeto antes de probe (${symlink ? 'symlink externo' : 'PATH absoluto'})`, platform, async t => {
  const f = fixture(t), projectBinary = path.join(f.root, 'claude');
  fs.copyFileSync(f.binary, projectBinary);
  if (symlink) { fs.unlinkSync(f.binary); fs.symlinkSync(projectBinary, f.binary); }
  else f.env.PATH = f.root + path.delimiter + f.bin;
  const capability = (await f.runner.capabilities(f.root)).claude;
  assert.equal(capability.disponivel, false);
  assert.match(capability.motivo, /Binário.*dentro do projeto recusado/);
  await assert.rejects(f.start(), /Binário.*dentro do projeto recusado/);
  assert.equal(f.log().length, 0); assert.equal(f.runner.runs.size, 0);
});

test('closeAll suprime eventos tardios e preserva o resultado da limpeza no histórico', platform, async t => {
  const f = fixture(t, 'slow'), { runId } = await f.start();
  await until(() => f.read(runId).run.estado === 'executando');
  const count = f.events.length;
  await f.runner.closeAll();
  assert.equal(f.events.length, count);
  assert.equal(f.read(runId).run.estado, 'interrompido');
  assert.equal(JSON.parse(fs.readFileSync(f.storeFile, 'utf8')).runs[0].estado, 'interrompido');
  await assert.rejects(f.start(), /encerrado/);
});

test('retomada exige --resume, mesma raiz e mesmo prompt congelado', platform, async t => {
  const f = fixture(t), first = await f.start(); const previous = await f.done(first.runId);
  f.env.DK_FAKE_CLAUDE_MODE = 'resume';
  const next = await f.start({ sessionId: previous.run.sessionId }); assert.equal((await f.done(next.runId)).run.estado, 'concluido');
  const launches = f.log().filter(e => e.spawn?.includes('-p'));
  assert.deepEqual(launches[1].spawn.slice(-2), ['--resume', previous.run.sessionId]);
  await assert.rejects(f.start({ sessionId: previous.run.sessionId }, f.other), /Nova sessão/);
  // Even two unavailable/identical sources are different skill selections.
  await assert.rejects(f.start({ sessionId: previous.run.sessionId, skillId: 'kit-skills/new' }), /Nova sessão/);
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), 'Mudou.');
  await assert.rejects(f.start({ sessionId: previous.run.sessionId }), /Nova sessão/);
});

test('limites 2/projeto, 3/app, fila FIFO de 4 cancelável', platform, async t => {
  const f = fixture(t, 'slow');
  const a = await f.start(), b = await f.start(), c = await f.start({}, f.other);
  const queue = []; for (let i = 0; i < 4; i++) queue.push(await f.start());
  assert.equal(f.runner.active.size, 3); assert.equal(f.runner.queue.length, 4);
  assert.ok(queue.every(q => f.read(q.runId).run.estado === 'na_fila'));
  await assert.rejects(f.start(), /fila.*cheia/);
  await f.runner.cancel(f.root, queue[1].runId); assert.equal(f.read(queue[1].runId).run.estado, 'interrompido');
  assert.ok(!f.log().some(e => e.promptFile?.includes(queue[1].runId)));
  await f.runner.cancel(f.root, a.runId);
  await until(() => f.read(queue[0].runId).run.estado === 'executando');
  assert.equal(f.read(queue[2].runId).run.estado, 'na_fila');
  assert.equal(f.runner.active.size, 3); assert.equal(f.runner.list(f.other).length, 1);
  assert.ok(f.runner.active.has(b.runId) && f.runner.active.has(c.runId));
});

test('closeProject só fecha a raiz e esvazia sua fila; cancelAll reutilizável; closeAll fecha', platform, async t => {
  const f = fixture(t, 'slow');
  const a = await f.start(), b = await f.start(), c = await f.start({}, f.other), queued = await f.start();
  await until(() => f.runner.read(f.other, c.runId).run.estado === 'executando');
  assert.equal(await f.runner.closeProject(f.root), 3);
  for (const id of [a.runId, b.runId, queued.runId]) assert.equal(f.read(id).run.estado, 'interrompido');
  assert.equal(f.runner.read(f.other, c.runId).run.estado, 'executando');
  await f.runner.cancelAll(); assert.equal(f.runner.closed, false); assert.equal(f.runner.active.size, 0);
  f.env.DK_FAKE_CLAUDE_MODE = 'ok'; const next = await f.start(); assert.equal((await f.done(next.runId)).run.estado, 'concluido');
  const closed = await f.runner.closeAll(); assert.equal(typeof closed.partial, 'boolean'); assert.equal(f.runner.closed, true);
  await assert.rejects(f.start(), /encerrado/);
});

test('composição coleta fontes autorizadas, frontmatter, critérios e caminhos sem conteúdo', platform, async t => {
  const reads = [];
  const f = fixture(t, 'ok', { sources: { guide: () => 'Guia.', catalogs: { read: async (root, catalog, entry) => {
    reads.push({ root, catalog, entry }); if (catalog === 'plugin:foreign/skills') throw new Error('não autorizado');
    return { text: 'Skill body', frontmatter: { name: entry } };
  } }, stages: { read: async () => ({ stages: [{ id: 'entender', nome: 'Entender', liberada: true, estado: 'pendente', criterios: [{ id: 'E1', descricao: 'Verificar', motivo: 'Falta', estado: 'pendente' }, { id: 'E2', descricao: 'DONE_SHOULD_NOT_APPEAR', estado: 'concluido' }] }] }) } } });
  fs.writeFileSync(path.join(f.root, 'file.txt'), 'FILE_CONTENT_MUST_NOT_APPEAR');
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), 'Project instructions');
  const options = { skillId: 'kit-skills/test', designSystemId: 'project-design/design', stage: 'entender', files: ['file.txt'] };
  const preview = await f.runner.preview(f.root, options);
  assert.match(preview.text, /"name":"test"/); assert.match(preview.text, /Project instructions/); assert.match(preview.text, /E1: Verificar/); assert.match(preview.text, /file.txt/);
  assert.ok(!preview.text.match(/FILE_CONTENT_MUST|DONE_SHOULD/)); assert.ok(preview.totalBytes <= 96 * 1024);
  assert.deepEqual(reads.map(r => [r.root, r.catalog, r.entry]), [[f.root, 'kit-skills', 'test'], [f.root, 'project-design', 'design']]);
  const unauthorized = await f.runner.preview(f.root, { skillId: 'plugin:foreign/skills/test' });
  assert.equal(unauthorized.camadas.find(c => c.id === 'skill_ativa').ausente, true);
  fs.unlinkSync(path.join(f.root, 'AGENTS.md')); fs.symlinkSync(path.join(f.other, 'secret'), path.join(f.root, 'AGENTS.md'));
  fs.writeFileSync(path.join(f.other, 'secret'), 'OUTSIDE_SECRET'); fs.symlinkSync(f.other, path.join(f.root, 'escape'));
  for (const files of [['../other/secret'], [path.join(f.other, 'secret')], ['escape/secret'], Array(201).fill('file.txt')]) {
    const result = await f.runner.preview(f.root, { files });
    assert.equal(result.camadas.find(c => c.id === 'instrucoes_projeto').ausente, true);
    assert.equal(result.camadas.find(c => c.id === 'arquivos').ausente, true); assert.ok(!result.text.includes('OUTSIDE_SECRET'));
  }
  fs.unlinkSync(path.join(f.root, 'AGENTS.md')); fs.writeFileSync(path.join(f.root, 'AGENTS.md'), 'x'.repeat(1024 * 1024 + 1));
  assert.equal((await f.runner.preview(f.root)).camadas.find(c => c.id === 'instrucoes_projeto').ausente, true);
  assert.equal(f.log().length, 0);
});

test('fechar durante composição assíncrona impede spawn tardio; cancel antes de spawn limpa prompt', platform, async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, 'ok', { sources: { guide: async () => { entered(); await gate; return 'Guia'; } } });
  const start = f.start(); const rejected = assert.rejects(start, /encerrado/);
  await reached; const closing = f.runner.closeProject(f.root); release(); await rejected; await closing;
  assert.ok(!f.log().some(e => e.spawn?.includes('-p')));
  f.runner.sources.guide = () => 'Guia';
  const run = await f.start(); await f.runner.cancel(f.root, run.runId);
  assert.equal(f.read(run.runId).run.estado, 'interrompido'); assert.equal(fs.existsSync(path.join(f.runsDir, run.runId)), false);
});

test('limites de entrada e modo, store/prompt fora do projeto, normalização isolada', platform, async t => {
  const f = fixture(t);
  for (const options of [{ prompt: '' }, { prompt: 'x'.repeat(64 * 1024) }, { prompt: '\n'.repeat(33000) + 'x' }, { prazoMs: 59999 }, { prazoMs: 7200001 }, { sessionId: 'bad' }, { provider: 'codex' }, { modo: 'somente-leitura' }]) await assert.rejects(f.start(options));
  assert.equal(f.log().length, 0);
  const unsafe = new AgentRun({ env: f.env, storeFile: path.join(f.root, 'private.json'), runsDir: path.join(f.privateDir, 'unsafe-runs') });
  await assert.rejects(unsafe.start(f.root, { provider: 'claude', prompt: 'Test' }), /fora do projeto/); await unsafe.closeAll();
  const unsafePrompt = new AgentRun({ env: f.env, storeFile: path.join(f.privateDir, 'unsafe.json'), runsDir: path.join(f.root, 'runs') });
  await assert.rejects(unsafePrompt.start(f.root, { provider: 'claude', prompt: 'Test' }), /fora do projeto/); await unsafePrompt.closeAll();
  assert.deepEqual(normalize('{"type":"future"}'), []);
  assert.throws(() => normalize('{invalid'));
  assert.equal(claude.argv({ promptFile: '/private/prompt', sessionId: 'session', resume: true }).at(-2), '--resume');
  assert.deepEqual([LIMITS.ativos_por_projeto, LIMITS.ativos_por_app, LIMITS.fila_por_app, LIMITS.prazo_ms, LIMITS.init_ms, LIMITS.interrupt_ms, LIMITS.sigkill_ms], [2, 3, 4, 900000, 20000, 5000, 1000]);
});

test('histórico limita eventos/30 runs/8 MiB, reabre ativos como expirada e remove prompts órfãos', platform, async t => {
  const f = fixture(t, 'slow', { env: { DK_FAKE_EVENT_FLOOD: '1' } }), { runId } = await f.start();
  await until(() => f.events.filter(e => e.type === 'tool_result').length === 600);
  assert.equal(f.read(runId).eventos.length, 500); f.runner._save();
  // Separate private runs directory: another instance must not touch a live prompt.
  const otherRuns = path.join(f.privateDir, 'reopened-runs'); fs.mkdirSync(otherRuns);
  const orphan = path.join(otherRuns, randomUUID()); fs.mkdirSync(orphan); fs.writeFileSync(path.join(orphan, 'system-prompt.md'), 'old prompt');
  const unrelated = path.join(otherRuns, 'keep'); fs.mkdirSync(unrelated); fs.writeFileSync(path.join(unrelated, 'system-prompt.md'), 'keep');
  const reopened = new AgentRun({ env: f.env, storeFile: f.storeFile, runsDir: otherRuns });
  await reopened.ready;
  assert.equal(fs.existsSync(orphan), false); assert.equal(fs.existsSync(path.join(unrelated, 'system-prompt.md')), true);
  assert.equal(reopened.read(f.root, runId).run.estado, 'expirada'); assert.equal(reopened.active.size, 0);
  await reopened.closeAll();
  await f.runner.cancelAll();
  // Exercise actual retention on start without spawning 35 processes.
  for (let i = 0; i < 35; i++) {
    const run = { ...f.runner.runs.get(runId), runId: randomUUID(), estado: 'concluido', eventos: [], texto: 'x'.repeat(64 * 1024) };
    f.runner.runs.set(run.runId, run);
  }
  const saved = [...f.runner.runs.values()].map(({ eventos, seq, ...r }) => r);
  fs.writeFileSync(f.storeFile, JSON.stringify({ runs: saved }), { mode: 0o600 });
  const limited = new AgentRun({ env: f.env, storeFile: f.storeFile, runsDir: otherRuns });
  assert.equal(limited.list(f.root).length, 30); await limited.closeAll();
  assert.ok(fs.statSync(f.storeFile).size <= 8 * 1024 * 1024); assert.equal(fs.statSync(f.storeFile).mode & 0o777, 0o600);
});

test('aprovação pendente permanece recuperável após 600 eventos e expira no fechamento', platform, async t => {
  const f = fixture(t, 'approval', { env: { DK_FAKE_EVENT_FLOOD: '1' } }), { runId } = await f.start();
  await until(() => f.events.filter(e => e.type === 'tool_result').length === 600);
  assert.equal(f.read(runId).eventos.length, 500); assert.ok(pending(f, runId));
  const id = pending(f, runId).requestId;
  await f.runner.closeAll();
  assert.ok(!pending(f, runId));
  assert.ok(f.read(runId).eventos.some(e => e.requestId === id && e.status === 'expired'));
  await assert.rejects(f.runner.approve(f.root, runId, id, 'allow'), /encerrada/);
});

test('raiz substituída durante composição é recusada antes de escrever prompt ou spawn', platform, async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, 'ok', { sources: { guide: async () => { entered(); await gate; return 'Guia'; } } });
  const start = f.start(), rejected = assert.rejects(start, /identidade/);
  await reached; fs.renameSync(f.root, f.root + '-old'); fs.mkdirSync(f.root); release(); await rejected;
  assert.ok(!f.log().some(e => e.spawn?.includes('-p'))); assert.equal(f.runner.runs.size, 0);
});

test('snapshot precede deny/interrupt; stopRecordedProcesses recebe snapshot e propaga partial', platform, async t => {
  const source = path.join(__dirname, '..', 'electron', 'agent-run.cjs'), nativeRequire = createRequire(source);
  const calls = [], records = [{ pid: 999991, ppid: 999990, started: 'synthetic identity' }];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), { module, exports: module.exports, Buffer, process, setTimeout, clearTimeout,
    require: name => name === './session-processes.cjs' ? {
      processSnapshot: async () => { calls.push('snapshot'); return [{ pid: runner.resourceRoots()[0].pid }]; },
      descendants: () => records,
      stopRecordedProcesses: async rows => { assert.deepEqual(rows, records); calls.push('cleanup'); return { partial: true }; },
    } : nativeRequire(name) });
  let runner;
  const f = fixture(t, 'approval', { Runner: module.exports.AgentRun }); runner = f.runner;
  const { runId } = await f.start(); await until(() => pending(f, runId));
  await f.runner.cancel(f.root, runId);
  assert.deepEqual(calls, ['snapshot', 'cleanup']); assert.equal(f.read(runId).run.cleanupPartial, true);
  assert.ok(f.events.some(e => e.type === 'status' && e.estado === 'interrompido' && e.cleanupPartial));
});
