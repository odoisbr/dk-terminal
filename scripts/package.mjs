import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageIgnores } from './package-filter.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputs = await packager({
  dir: root, name: 'DK Terminal', out: path.join(root, 'release'), overwrite: true,
  asar: { unpackDir: 'node_modules/node-pty' },
  // The renderer is bundled in dist/. Only these dependencies are loaded by the main process at runtime.
  ignore: packageIgnores,
  icon: process.platform === 'darwin' ? path.join(root, 'assets', 'dk-terminal.icns') : undefined,
  appBundleId: 'br.com.sea.dk.terminal', appCategoryType: 'public.app-category.developer-tools',
  extendInfo: { CFBundleDocumentTypes: [{ CFBundleTypeName: 'Projeto ou arquivo do DK', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.folder', 'public.text', 'public.source-code'] }] },
});
for (const output of outputs) console.log(output);
