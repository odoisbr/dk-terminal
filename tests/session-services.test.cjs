const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseListeners, parseProcessList, buildDetected, sessionTrees, listenerURL, summarize, SessionServices } = require('../electron/session-services.cjs');

const started = 'Thu Oct 29 10:00:00 2026';
const psOutput = [
  `  100     1   100 ${started}     /bin/zsh -il`,
  `  200   100   200 Thu Oct 29 10:01:02 2026     npm run dev`,
  `  201   200   200 Thu Oct 29 10:01:03 2026     /usr/local/bin/node /p/node_modules/.bin/vite --port 5173`,
  `  300   100   300 Thu Oct 29 10:02:00 2026     node -e require('http').createServer().listen(0)`,
  `  400     1   400 Thu Oct 29 10:03:00 2026     /usr/sbin/sshd`,
  `  500     1   500 Thu Oct 29 10:04:00 2026     /bin/zsh -il`,
  'linha inválida',
].join('\n');

test('interpreta a lista de processos com início e comando', () => {
  const rows = parseProcessList(psOutput);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[2], { pid: 201, ppid: 200, pgid: 200, started: 'Thu Oct 29 10:01:03 2026', command: '/usr/local/bin/node /p/node_modules/.bin/vite --port 5173' });
});

test('interpreta a saída do lsof em campos', () => {
  const output = ['p201', 'cnode', 'f20', 'tIPv6', 'n[::1]:5173', 'f21', 'tIPv4', 'n127.0.0.1:5173', 'f22', 'tIPv6', 'n*:24678', 'p300', 'cnode', 'f12', 'tIPv6', 'n*:51152', 'p400', 'csshd', 'f3', 'tIPv4', 'n*:22', 'f4', 'tIPv4', 'nlixo', ''].join('\n');
  const listeners = parseListeners(output);
  assert.deepEqual(listeners.map(item => [item.pid, item.port, item.addresses]), [[201, 5173, ['::1', '127.0.0.1']], [201, 24678, ['*']], [300, 51152, ['*']], [400, 22, ['*']]]);
  assert.deepEqual(parseListeners(''), []);
});

test('escolhe a URL da prévia pelo endereço de escuta', () => {
  assert.equal(listenerURL(['*'], 3000), 'http://127.0.0.1:3000');
  assert.equal(listenerURL(['::'], 3000), 'http://127.0.0.1:3000');
  assert.equal(listenerURL(['::1'], 5173), 'http://[::1]:5173');
  assert.equal(listenerURL(['192.168.0.10'], 80), null);
});

test('monta a árvore das sessões e lista só processos delas que escutam', () => {
  const rows = parseProcessList(psOutput);
  const roots = [{ id: 'a', pid: 100, label: 'Terminal' }];
  const owner = sessionTrees(rows, roots);
  assert.deepEqual([...owner.keys()].sort((a, b) => a - b), [100, 200, 201, 300]);
  assert.equal(owner.get(201).depth, 2);
  const listeners = parseListeners(['p201', 'n*:24678', 'n127.0.0.1:5173', 'p300', 'n*:51152', 'p400', 'n*:22'].join('\n'));
  const detected = buildDetected(rows, roots, listeners);
  assert.deepEqual(detected.map(item => [item.pid, item.ports, item.url]), [[201, [5173, 24678], 'http://127.0.0.1:5173'], [300, [51152], 'http://127.0.0.1:51152']]);
  assert.equal(detected[0].command, 'node /p/node_modules/.bin/vite --port 5173');
  assert.equal(detected[0].sessionId, 'a');
  assert.equal(detected[0].pgid, 200);
  assert.equal(buildDetected(rows, [{ id: 'b', pid: 999 }], listeners).length, 0);
});

test('resume comandos longos', () => {
  assert.equal(summarize('/opt/bin/python3 -m http.server'), 'python3 -m http.server');
  assert.equal(summarize('x '.repeat(200)).length, 158);
  assert.equal(summarize(''), 'Processo');
});

test('descobre por projeto e encerra o grupo só quando ele está dentro da sessão', async () => {
  const rows = parseProcessList(psOutput);
  const signals = []; let lsofPids = null;
  const services = new SessionServices({
    platform: 'darwin',
    roots: root => root === '/projeto' ? [{ id: 'a', pid: 100, label: 'Terminal' }] : [],
    readProcesses: async () => rows,
    readListeners: async pids => { lsofPids = pids; return parseListeners(['p201', 'n*:5173', 'p300', 'n*:51152', 'p400', 'n*:22'].join('\n')); },
    signal: (pid, value) => signals.push([pid, value]),
  });
  const result = await services.detect('/projeto');
  assert.deepEqual(lsofPids.sort((a, b) => a - b), [100, 200, 201, 300]);
  assert.deepEqual(result.items.map(item => item.pid), [201, 300]);
  assert.deepEqual((await services.detect('/outro')).items, []);
  await services.terminate('/projeto', 201, 'Thu Oct 29 10:01:03 2026');
  assert.deepEqual(signals.at(-1), [-200, 'SIGTERM']);
  await assert.rejects(() => services.terminate('/projeto', 201, 'Fri Oct 30 10:01:03 2026'), /já foi encerrado/);
  await assert.rejects(() => services.terminate('/projeto', 400, 'Thu Oct 29 10:03:00 2026'), /não pertence/);
  await assert.rejects(() => services.terminate('/outro', 201, 'Thu Oct 29 10:01:03 2026'), /não pertence/);
  assert.equal(signals.length, 1);
});

test('não envia sinal ao grupo do shell quando o processo compartilha o grupo da sessão', async () => {
  const rows = [
    { pid: 100, ppid: 1, pgid: 100, started: 'a', command: 'node server.js' },
    { pid: 101, ppid: 100, pgid: 100, started: 'b', command: 'node worker.js' },
  ];
  const signals = [];
  const services = new SessionServices({ platform: 'darwin', roots: () => [{ id: 'a', pid: 100 }], readProcesses: async () => rows, readListeners: async () => [], signal: (pid, value) => signals.push([pid, value]) });
  await services.terminate('/p', 101, 'b');
  assert.deepEqual(signals, [[101, 'SIGTERM']]);
});

test('informa falha quando não é possível listar processos', async () => {
  const services = new SessionServices({ platform: 'darwin', roots: () => [{ id: 'a', pid: 100 }], readProcesses: async () => null, readListeners: async () => [] });
  await assert.rejects(() => services.detect('/p'), /Não foi possível listar/);
  const unsupported = new SessionServices({ platform: 'win32', roots: () => [] });
  assert.deepEqual(await unsupported.detect('/p'), { items: [], supported: false });
});
