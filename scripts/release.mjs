// Gera o SEA Dock assinado com Developer ID, notarizado e empacotado em DMG.
//
//   node scripts/release.mjs                # exige vendor/sea-cli e credenciais
//   node scripts/release.mjs --skip-notarize # só assina e gera o DMG (teste local)
//   node scripts/release.mjs --without-sea-cli
//
// Variáveis:
//   DK_SIGN_IDENTITY   nome ou hash da "Developer ID Application" no keychain.
//                      Sem ela, usa a única identidade desse tipo que existir.
//   DK_NOTARY_PROFILE  perfil criado por `xcrun notarytool store-credentials`.
//
// Etapas: build → assina os Mach-O do Ruby embutido → empacota e assina o app
// (hardened runtime) → notariza e grampeia o app → DMG → assina, notariza e
// grampeia o DMG → valida com codesign, spctl e stapler.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { notarize } from '@electron/notarize';
import { packageIgnores } from './package-filter.mjs';
import icon from '../electron/app-icon.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
const skipNotarize = args.has('--skip-notarize');
const withoutSeaCli = args.has('--without-sea-cli');
const name = pkg.productName;
const vendor = path.join(root, 'vendor', 'sea-cli');
const entitlements = path.join(root, 'build', 'entitlements.mac.plist');
const releaseDir = path.join(root, 'release');

const log = message => console.log(`[release] ${message}`);
const run = (file, argv, options = {}) => (execFileSync(file, argv, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options }) || '').trim();
const fail = message => { console.error(`[release] ${message}`); process.exit(1); };

if (process.platform !== 'darwin') fail('o DMG só é gerado no macOS.');

// Identidade: explícita ou a única Developer ID Application do keychain.
function resolveIdentity() {
  const listing = run('security', ['find-identity', '-v', '-p', 'codesigning']);
  const found = [...listing.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application: [^"]+)"/gm)].map(m => ({ hash: m[1], name: m[2] }));
  const wanted = process.env.DK_SIGN_IDENTITY;
  if (wanted) {
    const match = found.find(item => item.hash === wanted || item.name === wanted || item.name.includes(wanted));
    return match || fail(`DK_SIGN_IDENTITY "${wanted}" não é uma Developer ID Application válida no keychain.`);
  }
  if (found.length === 1) return found[0];
  fail(found.length ? `há ${found.length} identidades Developer ID; escolha com DK_SIGN_IDENTITY.` : 'nenhuma Developer ID Application no keychain.');
}
const identity = resolveIdentity();
log(`assinando como ${identity.name}`);

const profile = process.env.DK_NOTARY_PROFILE;
if (!skipNotarize && !profile) fail('defina DK_NOTARY_PROFILE (perfil do `xcrun notarytool store-credentials`) ou use --skip-notarize.');

if (!withoutSeaCli && !fs.existsSync(path.join(vendor, 'bin', 'sea'))) fail('vendor/sea-cli não existe. Rode `bash scripts/vendor-sea-cli.sh` ou use --without-sea-cli.');

// Mach-O é identificado pelo cabeçalho, não pela extensão: o Ruby portátil tem
// executáveis sem extensão e bibliotecas .bundle.
function isMachO(file) {
  const fd = fs.openSync(file, 'r');
  try { const head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0); const magic = head.readUInt32BE(0); return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic); }
  finally { fs.closeSync(fd); }
}
function machOFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...machOFiles(file));
    else if (entry.isFile() && isMachO(file)) out.push(file);
  }
  return out;
}
function signFile(file, extra = []) {
  run('codesign', ['--force', '--sign', identity.hash, '--options', 'runtime', '--timestamp', ...extra, file]);
}

log('build');
run('npm', ['run', 'build'], { stdio: 'inherit' });

if (!withoutSeaCli) {
  const binaries = machOFiles(vendor);
  log(`assinando ${binaries.length} binários do sea-cli embutido`);
  for (const file of binaries) signFile(file);
}

log('empacotando');
const outputs = await packager({
  dir: root, name, out: releaseDir, overwrite: true, prune: true,
  asar: { unpackDir: 'node_modules/node-pty' },
  ignore: packageIgnores,
  icon: icon.packageIcon(root),
  extraResource: withoutSeaCli ? [] : [vendor],
  appBundleId: 'br.com.sea.dk.terminal', appCategoryType: 'public.app-category.developer-tools',
  extendInfo: { CFBundleDocumentTypes: [{ CFBundleTypeName: `Projeto ou arquivo do ${name}`, CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.folder', 'public.text', 'public.source-code'] }] },
  osxSign: {
    identity: identity.hash, hardenedRuntime: true, entitlements, continueOnError: false,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    // Os binários do Ruby já foram assinados acima; o osx-sign assinaria por
    // detecção de "arquivo binário", o que inclui arquivos que não são Mach-O.
    ignore: ['/Resources/sea-cli/'],
    optionsForFile: () => ({ hardenedRuntime: true, entitlements, timestamp: undefined }),
  },
});
const appDir = outputs[0];
const app = path.join(appDir, `${name}.app`);
if (!fs.existsSync(app)) fail(`app não encontrado em ${appDir}`);

log('verificando assinatura');
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });

if (!skipNotarize) {
  log('notarizando o app (pode levar alguns minutos)');
  await notarize({ appPath: app, keychainProfile: profile });
  run('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
}

log('gerando DMG');
const arch = path.basename(appDir).split('-').pop();
const dmg = path.join(releaseDir, `${name.replace(/\s+/g, '-')}-${pkg.version}-${arch}.dmg`);
const staging = fs.mkdtempSync(path.join(releaseDir, '.dmg-'));
try {
  run('cp', ['-R', app, staging]);
  fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
  fs.rmSync(dmg, { force: true });
  run('hdiutil', ['create', '-volname', name, '-srcfolder', staging, '-ov', '-format', 'UDZO', '-fs', 'HFS+', dmg]);
} finally { fs.rmSync(staging, { recursive: true, force: true }); }
run('codesign', ['--force', '--sign', identity.hash, '--timestamp', dmg]);

if (!skipNotarize) {
  log('notarizando o DMG');
  await notarize({ appPath: dmg, keychainProfile: profile });
  run('xcrun', ['stapler', 'validate', dmg], { stdio: 'inherit' });
  const gate = spawnSync('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg], { encoding: 'utf8' });
  if (gate.status !== 0) fail(`Gatekeeper recusou o DMG:\n${gate.stderr}`);
  log('Gatekeeper aceitou o DMG');
}

const size = (fs.statSync(dmg).size / 1024 / 1024).toFixed(1);
log(`pronto: ${dmg} (${size} MB)${skipNotarize ? ' — sem notarização' : ''}`);
