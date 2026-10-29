// Processo isolado: uma regressão no matcher deve expirar sem bloquear a suíte.
const { evaluate } = require('../../../electron/stages.cjs');
async function main() {
  let last = performance.now(), longest = 0;
  const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 5);
  const start = performance.now();
  try {
    const snapshot = await evaluate(process.argv[2], { kitPath: process.argv[3] });
    const elapsed = performance.now() - start;
    longest = Math.max(longest, performance.now() - last);
    const d3 = snapshot.stages.flatMap(s => s.criterios).find(c => c.id === 'D3');
    process.stdout.write(JSON.stringify({ d3, elapsed, longest }));
  } finally { clearInterval(timer); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
