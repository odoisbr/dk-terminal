const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Services, definitions } = require('../electron/services.cjs');

function fixture(t, pkg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-service-manager-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  return root;
}

test('conflito de lockfiles bloqueia apenas scripts; serviço personalizado continua disponível', t => {
  const root = fixture(t, { scripts: { dev: 'não executar' } });
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
  fs.writeFileSync(path.join(root, 'yarn.lock'), '');
  fs.writeFileSync(path.join(root, 'dk-terminal.services.json'), JSON.stringify({ services: [{ name: 'api', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'] }] }));
  const service = new Services(() => {}, process.env); t.after(() => service.closeAll());
  const defs = definitions(root);
  assert.match(defs.find(item => item.id === 'script:dev').managerError, /conflito/i);
  assert.equal(defs.find(item => item.id === 'custom:api').managerError, undefined);
  assert.throws(() => service.start(root, 'script:dev'), /conflito/i);
  assert.ok(['starting', 'running'].includes(service.start(root, 'custom:api').status));
  assert.ok(['stopping', 'stopped'].includes(service.stop(root, 'custom:api').status));
});

test('gerenciador desconhecido não é trocado silenciosamente por npm', t => {
  const root = fixture(t, { packageManager: 'custom@1.0.0', scripts: { dev: 'não executar' } });
  const service = new Services(() => {}, process.env); t.after(() => service.closeAll());
  assert.throws(() => service.start(root, 'script:dev'), /gerenciador declarado.*não é reconhecido/i);
});

test('gerenciador declarado é o mesmo usado no plano e no serviço', t => {
  const root = fixture(t, { packageManager: 'pnpm@10.0.0', scripts: { dev: 'test' } });
  const script = definitions(root).find(item => item.id === 'script:dev');
  assert.equal(script.command, 'pnpm'); assert.equal(script.managerError, null);
});
