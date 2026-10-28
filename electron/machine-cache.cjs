const { execFile } = require('node:child_process');

function runPurge(execute = execFile) {
  return new Promise((resolve, reject) => {
    execute('/usr/bin/osascript', ['-e', 'do shell script "/usr/sbin/purge" with administrator privileges'], { timeout: 120000, maxBuffer: 16 * 1024, windowsHide: true }, error => {
      if (error) reject(new Error('A limpeza foi cancelada ou não pôde ser concluída.'));
      else resolve();
    });
  });
}
async function clearMachineFileCache({ platform = process.platform, confirm, run = runPurge }) {
  if (platform !== 'darwin') throw new Error('Esta ação está disponível somente no macOS.');
  if (!await confirm()) return { status: 'cancelled' };
  await run();
  return { status: 'completed' };
}
module.exports = { clearMachineFileCache, runPurge };
