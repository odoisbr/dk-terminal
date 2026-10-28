const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const INTERVAL = 1500;

function parseProcessTable(output) {
  const rows = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, cpu, memory] = match;
    rows.push({ pid: Number(pid), ppid: Number(ppid), cpu: Number(cpu), memoryKiB: Number(memory) });
  }
  return rows;
}
function aggregateResources(metrics, processRows, rootPid, collectorPid, hasPrevious, now = Date.now()) {
  const app = { cpuPercent: null, memoryKiB: null, processCount: 0 };
  const seen = new Set();
  const cpu = [], memory = [];
  for (const metric of metrics) {
    if (!Number.isInteger(metric.pid) || seen.has(metric.pid)) continue;
    seen.add(metric.pid); app.processCount++;
    if (Number.isFinite(metric.cpu?.percentCPUUsage) && metric.cpu.percentCPUUsage >= 0) cpu.push(metric.cpu.percentCPUUsage);
    if (Number.isFinite(metric.memory?.workingSetSize) && metric.memory.workingSetSize >= 0) memory.push(metric.memory.workingSetSize);
  }
  if (hasPrevious && cpu.length === app.processCount && cpu.length) app.cpuPercent = cpu.reduce((sum, value) => sum + value, 0);
  if (memory.length === app.processCount && memory.length) app.memoryKiB = memory.reduce((sum, value) => sum + value, 0);
  let children = null;
  if (Array.isArray(processRows) && processRows.some(row => row.pid === rootPid)) {
    const byParent = new Map(), collectors = new Set(Array.isArray(collectorPid) ? collectorPid : [collectorPid]);
    for (const row of processRows) {
      if (collectors.has(row.pid) || !Number.isInteger(row.pid) || !Number.isInteger(row.ppid)) continue;
      const bucket = byParent.get(row.ppid) || []; bucket.push(row); byParent.set(row.ppid, bucket);
    }
    const visited = new Set(), pending = [rootPid, ...seen];
    const descendants = [];
    while (pending.length) {
      const parent = pending.pop(); if (visited.has(parent)) continue; visited.add(parent);
      for (const child of byParent.get(parent) || []) {
        if (visited.has(child.pid)) continue;
        pending.push(child.pid);
        if (!seen.has(child.pid)) descendants.push(child);
      }
    }
    children = { cpuPercent: descendants.reduce((sum, row) => sum + row.cpu, 0), memoryKiB: descendants.reduce((sum, row) => sum + row.memoryKiB, 0), processCount: descendants.length };
  }
  const add = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? a + b : null;
  return { app, children, total: children ? { cpuPercent: add(app.cpuPercent, children.cpuPercent), memoryKiB: add(app.memoryKiB, children.memoryKiB) } : { cpuPercent: app.cpuPercent, memoryKiB: app.memoryKiB }, sampledAt: now };
}
function processTable(platform) {
  if (platform !== 'darwin' && platform !== 'linux') return Promise.resolve(null);
  const executable = fs.existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
  return new Promise(resolve => {
    let child;
    try {
      child = execFile(executable, ['-axo', 'pid=,ppid=,pcpu=,rss='], { timeout: 2500, maxBuffer: 2 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }, (error, stdout) => {
        if (error) return resolve(null);
        const rows = parseProcessTable(stdout);
        resolve(rows.length ? { rows, collectorPid: child?.pid } : null);
      });
      child.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}
function sessionResources(rows, roots, excludedPids = []) {
  if (!Array.isArray(rows) || !Array.isArray(roots)) return [];
  const excluded = new Set(excludedPids), byPid = new Map(), byParent = new Map();
  for (const row of rows) {
    if (excluded.has(row.pid)) continue;
    byPid.set(row.pid, row);
    const children = byParent.get(row.ppid) || []; children.push(row.pid); byParent.set(row.ppid, children);
  }
  return roots.flatMap(root => {
    if (!root || typeof root.id !== 'string' || !byPid.has(root.pid) || !Number.isFinite(root.lastActivity)) return [];
    const pending = [root.pid], visited = new Set(); let memoryKiB = 0;
    while (pending.length) {
      const pid = pending.pop(); if (visited.has(pid)) continue; visited.add(pid);
      const row = byPid.get(pid); if (!row || !Number.isFinite(row.memoryKiB)) return [];
      memoryKiB += row.memoryKiB;
      pending.push(...(byParent.get(pid) || []));
    }
    return [{ id: root.id, kind: root.kind === 'codex' ? 'codex' : 'terminal', root: root.kind === 'codex' ? root.root : undefined, memoryKiB, lastActivity: root.lastActivity }];
  });
}
function systemSample(api = os) {
  try {
    const cpus = api.cpus();
    const totals = cpus.reduce((sum, cpu) => {
      const times = cpu.times;
      sum.idle += times.idle; sum.total += times.user + times.nice + times.sys + times.idle + times.irq;
      return sum;
    }, { idle: 0, total: 0 });
    const totalBytes = api.totalmem(), freeBytes = api.freemem();
    return { ...totals, cores: cpus.length, totalBytes, freeBytes };
  } catch { return null; }
}
function systemResources(sample, previous) {
  if (!sample) return { cpuPercent: null, memoryUsedKiB: null, memoryTotalKiB: null };
  let cpuPercent = null;
  if (previous && sample.cores > 0 && previous.cores === sample.cores) {
    const total = sample.total - previous.total, idle = sample.idle - previous.idle;
    if (total > 0 && idle >= 0 && idle <= total) cpuPercent = (total - idle) / total * 100;
  }
  const validMemory = Number.isFinite(sample.totalBytes) && sample.totalBytes > 0 && Number.isFinite(sample.freeBytes) && sample.freeBytes >= 0 && sample.freeBytes <= sample.totalBytes;
  return { cpuPercent, memoryUsedKiB: validMemory ? (sample.totalBytes - sample.freeBytes) / 1024 : null, memoryTotalKiB: validMemory ? sample.totalBytes / 1024 : null };
}
function parseSwapUsage(output, platform) {
  if (platform === 'darwin') {
    const find = name => {
      const match = new RegExp('\\b' + name + '\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*([KMGT]?)', 'i').exec(output);
      if (!match) return null;
      const factor = { '': 1 / 1024, K: 1, M: 1024, G: 1024 ** 2, T: 1024 ** 3 }[match[2].toUpperCase()];
      return Number(match[1]) * factor;
    };
    const totalKiB = find('total'), usedKiB = find('used');
    return totalKiB != null && usedKiB != null && usedKiB <= totalKiB ? { totalKiB, usedKiB } : null;
  }
  if (platform === 'linux') {
    const total = /^SwapTotal:\s*(\d+)\s*kB\s*$/im.exec(output);
    const free = /^SwapFree:\s*(\d+)\s*kB\s*$/im.exec(output);
    if (!total || !free || Number(free[1]) > Number(total[1])) return null;
    return { totalKiB: Number(total[1]), usedKiB: Number(total[1]) - Number(free[1]) };
  }
  return null;
}
function swapUsage(platform) {
  if (platform === 'linux') return fs.promises.readFile('/proc/meminfo', 'utf8').then(data => ({ usage: parseSwapUsage(data, platform), collectorPid: null })).catch(() => null);
  if (platform !== 'darwin') return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      let child;
      child = execFile('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 2500, maxBuffer: 16 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }, (error, stdout) => resolve({ usage: error ? null : parseSwapUsage(stdout, platform), collectorPid: child?.pid }));
    } catch { resolve(null); }
  });
}
class ResourceMonitor {
  constructor(getMetrics, options = {}) {
    this.getMetrics = getMetrics; this.platform = options.platform || process.platform; this.rootPid = options.rootPid || process.pid;
    this.getTable = options.getTable || processTable; this.clock = options.clock || Date.now;
    this.pending = null; this.last = null; this.previous = false; this.previousSystem = null; this.getSystem = options.getSystem || systemSample; this.getSwap = options.getSwap || swapUsage; this.getTerminals = options.getTerminals || (() => []);
  }
  read() {
    if (this.pending) return this.pending;
    if (this.last && this.clock() - this.last.sampledAt < INTERVAL) return Promise.resolve(this.last);
    this.pending = (async () => {
      let metrics; try { metrics = this.getMetrics(); } catch { metrics = []; }
      if (!Array.isArray(metrics)) metrics = [];
      const [table, swap] = await Promise.all([Promise.resolve().then(() => this.getTable(this.platform)).catch(() => null), Promise.resolve().then(() => this.getSwap(this.platform)).catch(() => null)]);
      let system; try { system = this.getSystem(); } catch { system = null; }
      const data = aggregateResources(metrics, table?.rows ?? null, this.rootPid, [table?.collectorPid, swap?.collectorPid], this.previous, this.clock());
      data.system = { ...systemResources(system, this.previousSystem), swap: swap?.usage ?? null }; this.previousSystem = system;
      let roots; try { roots = this.getTerminals(); } catch { roots = []; }
      data.sessions = sessionResources(table?.rows, roots, [table?.collectorPid, swap?.collectorPid]);
      this.previous = metrics.length > 0; this.last = data; return data;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}
module.exports = { ResourceMonitor, parseProcessTable, aggregateResources, systemSample, systemResources, parseSwapUsage, swapUsage, sessionResources };
