const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexChat } = require('../electron/codex-chat.cjs');

// A local, synthetic JSONL server: these tests never contact Codex or an LLM.
const SERVER = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.env.DK_TEST_MODE;
const log = value => fs.appendFileSync(process.env.DK_TEST_LOG, JSON.stringify(value) + '\n');
log({ spawn: process.argv.slice(2) });
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => out({ method, params });
let threadId = 'test-thread';
const turnId = 'test-turn';
const item = { type: 'commandExecution', id: 'command-1', command: 'printf synthetic', cwd: process.cwd(), commandActions: [], status: 'inProgress' };
const finish = decision => {
  const output = mode === 'large' ? 'x'.repeat(100000) : 'synthetic output';
  notify('item/completed', { threadId, turnId, item: { ...item, status: decision === 'decline' ? 'declined' : 'completed', aggregatedOutput: output, exitCode: decision === 'decline' ? null : 0 } });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'agent-1', delta: 'Resposta ' });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'agent-1', delta: 'de teste.' });
  notify('item/completed', { threadId, turnId, item: { id: 'agent-1', type: 'agentMessage', text: 'Resposta de teste.' } });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); log(request);
  if (!request.method) { if (request.id === 'approval-1' && request.result) finish(request.result.decision); return; }
  if (request.method === 'initialize') {
    if (mode !== 'hang-initialize') out({ id: request.id, result: { userAgent: 'mock', platformFamily: 'unix' } });
  } else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    threadId = request.params.threadId || threadId;
    out({ id: request.id, result: { thread: { id: threadId }, model: 'configured-model' } });
  } else if (request.method === 'turn/start') {
    out({ id: request.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
    notify('item/started', { threadId, turnId, item: { id: 'reasoning-1', type: 'reasoning', summary: ['PRIVATE_REASONING_SHOULD_NOT_APPEAR'], content: ['PRIVATE_REASONING_SHOULD_NOT_APPEAR'] } });
    notify('item/started', { threadId, turnId, item });
    notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: item.id, delta: 'synthetic output' });
    if (mode === 'approval' || mode === 'file-approval') {
      out({ id: 'approval-1', method: mode === 'approval' ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: item.id, startedAtMs: Date.now(), command: item.command, cwd: item.cwd, reason: 'Synthetic approval', grantRoot: mode === 'file-approval' ? '/synthetic/root' : null } });
    } else if (mode === 'unsupported') {
      out({ id: 'unknown-1', method: 'item/tool/requestUserInput', params: { threadId, turnId, questions: [] } });
      finish();
    } else if (mode !== 'hang') finish();
  } else if (request.method === 'turn/interrupt') {
    out({ id: request.id, result: {} });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', items: [] } });
  }
});
`;

function fixture(t, mode = 'auto') {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-codex-chat-')));
  const root = path.join(temp, 'project'); const other = path.join(temp, 'other'); const bin = path.join(temp, 'bin');
  fs.mkdirSync(root); fs.mkdirSync(other); fs.mkdirSync(bin);
  const file = path.join(bin, 'codex');
  fs.writeFileSync(file, `#!${process.execPath}\n${SERVER}`, { mode: 0o755 });
  const storeFile = path.join(temp, 'private', 'chat.json'), logFile = path.join(temp, 'protocol.jsonl');
  const events = [];
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, DK_TEST_MODE: mode, DK_TEST_LOG: logFile };
  const chat = new CodexChat({ env, storeFile, emit: event => events.push(event) });
  t.after(async () => { await chat.closeAll(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { root, other, env, storeFile, chat, events, log: () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] };
}

async function until(predicate, timeout = 4500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail('Timed out waiting for mock app-server');
}
const options = { skip: process.platform === 'win32' ? 'Synthetic Unix executable fixture' : false };

test('creating and listing conversations is local and the private store is outside the project', options, t => {
  const f = fixture(t);
  const session = f.chat.create(f.root);
  assert.equal(session.running, false); assert.equal(f.chat.read(f.root, session.id).messages.length, 0);
  assert.equal(f.log().length, 0);
  assert.equal(fs.statSync(f.storeFile).mode & 0o777, 0o600);
  assert.equal(f.chat.list(f.root).length, 1); assert.equal(f.chat.list(f.other).length, 0);
  assert.throws(() => f.chat.read(f.other, session.id), /não encontrada/);
  const unsafe = new CodexChat({ storeFile: path.join(f.root, 'chat.json') });
  assert.throws(() => unsafe.create(f.root), /fora/);
});

test('official stdio handshake, deltas, output bounds, private reasoning filtering and thread resume', options, async t => {
  const f = fixture(t, 'large'); const session = f.chat.create(f.root);
  await f.chat.send(f.root, session.id, 'Synthetic user request.');
  await until(() => !f.chat.read(f.root, session.id).session.running);
  const first = f.chat.read(f.root, session.id);
  assert.equal(first.session.status, 'completed'); assert.equal(first.session.model, 'configured-model');
  assert.equal(first.messages.find(message => message.kind === 'assistant').text, 'Resposta de teste.');
  assert.ok(Buffer.byteLength(first.messages.find(message => message.kind === 'tool').output) <= 64 * 1024);
  assert.ok(!JSON.stringify(first).includes('PRIVATE_REASONING'));
  assert.ok(!JSON.stringify(f.events).includes('PRIVATE_REASONING'));
  assert.ok(!fs.readFileSync(f.storeFile, 'utf8').includes('PRIVATE_REASONING'));
  let log = f.log();
  assert.deepEqual(log[0].spawn, ['app-server', '--listen', 'stdio://']);
  assert.deepEqual(log.find(value => value.method === 'initialize').params, { clientInfo: { name: 'dk_terminal', title: 'DK Terminal', version: '0.1.0' } });
  assert.ok(log.some(value => value.method === 'initialized'));
  assert.deepEqual(log.find(value => value.method === 'thread/start').params, { cwd: f.root });
  assert.deepEqual(log.find(value => value.method === 'turn/start').params.input, [{ type: 'text', text: 'Synthetic user request.' }]);
  assert.ok(!JSON.stringify(log).includes('approvalPolicy'));
  assert.ok(f.events.some(event => event.type === 'delta'));
  await f.chat.send(f.root, session.id, 'Second synthetic request.');
  await until(() => !f.chat.read(f.root, session.id).session.running);
  log = f.log();
  assert.equal(f.chat.read(f.root, session.id).messages.filter(message => message.kind === 'assistant').length, 2);
  assert.deepEqual(log.find(value => value.method === 'thread/resume').params, { threadId: 'test-thread', cwd: f.root, excludeTurns: true });
  assert.equal(log.filter(value => value.spawn).length, 2);
  const reopened = new CodexChat({ env: f.env, storeFile: f.storeFile });
  assert.equal(reopened.list(f.root).length, 1);
  assert.equal(reopened.read(f.root, session.id).session.running, false);
  await reopened.closeAll();
});

test('command execution approvals wait for the user and reject invalid scopes or persistent choices', options, async t => {
  const f = fixture(t, 'approval'); const session = f.chat.create(f.root);
  await f.chat.send(f.root, session.id, 'Synthetic approval request.');
  await until(() => f.events.some(event => event.type === 'permission'));
  const permission = f.chat.read(f.root, session.id).messages.find(message => message.kind === 'permission');
  assert.equal(permission.status, 'pending');
  assert.ok(!f.log().some(message => message.id === 'approval-1' && message.result));
  await assert.rejects(f.chat.approve(f.other, session.id, permission.requestId, 'accept'), /não encontrada/);
  await assert.rejects(f.chat.approve(f.root, session.id, permission.requestId, 'acceptForSession'), /uma vez/);
  await assert.rejects(f.chat.approve(f.root, session.id, 'guessed-request', 'accept'), /encerrada/);
  await f.chat.approve(f.root, session.id, permission.requestId, 'decline');
  await until(() => !f.chat.read(f.root, session.id).session.running);
  assert.deepEqual(f.log().find(message => message.id === 'approval-1' && message.result).result, { decision: 'decline' });
  assert.equal(f.chat.read(f.root, session.id).messages.find(message => message.kind === 'permission').status, 'declined');
});

test('file approvals display the requested root and only accept the current request', options, async t => {
  const f = fixture(t, 'file-approval'); const session = f.chat.create(f.root);
  await f.chat.send(f.root, session.id, 'Synthetic file request.');
  await until(() => f.events.some(event => event.type === 'permission'));
  const permission = f.chat.read(f.root, session.id).messages.find(message => message.kind === 'permission');
  assert.match(permission.reason, /Synthetic approval/); assert.match(permission.reason, /\/synthetic\/root/);
  await f.chat.approve(f.root, session.id, permission.requestId, 'accept');
  await until(() => !f.chat.read(f.root, session.id).session.running);
  assert.equal(f.log().find(message => message.id === 'approval-1' && message.result).result.decision, 'accept');
});

test('unsupported requests return an error rather than granting an approval', options, async t => {
  const f = fixture(t, 'unsupported'); const session = f.chat.create(f.root);
  await f.chat.send(f.root, session.id, 'Synthetic unsupported request.');
  await until(() => !f.chat.read(f.root, session.id).session.running);
  const response = f.log().find(message => message.id === 'unknown-1' && message.error);
  assert.equal(response.error.code, -32601); assert.equal(response.result, undefined);
  assert.match(f.chat.read(f.root, session.id).messages.find(message => message.kind === 'system').text, /não suporta/);
});

test('interrupt cancels the active turn, closes its process and limits concurrent turns', options, async t => {
  const f = fixture(t, 'hang');
  const one = f.chat.create(f.root), two = f.chat.create(f.root), three = f.chat.create(f.root);
  await f.chat.send(f.root, one.id, 'Synthetic waiting request one.');
  await f.chat.send(f.root, two.id, 'Synthetic waiting request two.');
  await assert.rejects(f.chat.send(f.root, three.id, 'Synthetic waiting request three.'), /duas conversas/);
  await until(() => f.chat.read(f.root, one.id).session.status === 'running');
  await f.chat.cancel(f.root, one.id);
  await until(() => !f.chat.read(f.root, one.id).session.running);
  assert.equal(f.chat.read(f.root, one.id).session.status, 'interrupted');
  assert.ok(f.log().some(message => message.method === 'turn/interrupt'));
  await f.chat.closeAll();
  assert.equal(f.chat.active.size, 0);
});

test('cancel also stops a process that has not completed initialization', options, async t => {
  const f = fixture(t, 'hang-initialize'), session = f.chat.create(f.root);
  await f.chat.send(f.root, session.id, 'Synthetic initialization request.');
  await until(() => f.log().some(message => message.method === 'initialize'));
  await f.chat.cancel(f.root, session.id);
  await until(() => !f.chat.read(f.root, session.id).session.running);
  assert.equal(f.chat.read(f.root, session.id).session.status, 'interrupted');
  assert.ok(!f.log().some(message => message.method === 'turn/start'));
});

test('history keeps at most 30 conversations and 200 messages per conversation', options, async t => {
  const f = fixture(t);
  for (let index = 0; index < 35; index++) f.chat.create(f.root);
  assert.equal(f.chat.list(f.root).length, 30);
  const session = f.chat.sessions.values().next().value;
  for (let index = 0; index < 205; index++) f.chat._append(session, { kind: 'user', text: 'Synthetic bounded history ' + index });
  assert.equal(f.chat.read(f.root, session.id).messages.length, 200);
});

test('fechar projeto interrompe apenas conversas daquele projeto e preserva histórico', options, async t => {
  const f=fixture(t,'hang');
  const first=f.chat.create(f.root),second=f.chat.create(f.other);
  await f.chat.send(f.root,first.id,'Conversa do primeiro projeto');
  await f.chat.send(f.other,second.id,'Conversa do segundo projeto');
  await until(()=>f.chat.read(f.root,first.id).session.status==='running'&&f.chat.read(f.other,second.id).session.status==='running');
  assert.equal(await f.chat.closeProject(f.root),1);
  assert.equal(f.chat.read(f.root,first.id).session.status,'interrupted');
  assert.equal(f.chat.read(f.other,second.id).session.running,true);
  assert.equal(f.chat.read(f.root,first.id).messages[0].text,'Conversa do primeiro projeto');
});
