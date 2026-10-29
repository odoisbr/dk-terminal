import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageIgnores } from './package-filter.mjs';
import icon from '../electron/app-icon.cjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputs = await packager({
  dir: root, name: 'SEA Dock', out: path.join(root, 'release'), overwrite: true,
  asar: { unpackDir: 'node_modules/node-pty' },
  // The renderer is bundled in dist/. Only these dependencies are loaded by the main process at runtime.
  ignore: packageIgnores,
  icon: icon.packageIcon(root),
  // Re-seal the renamed Electron bundle after packaging. This local ad-hoc
  // signature provides integrity but is not a Developer ID signature.
  osxSign: process.platform === 'darwin' ? {
    identity: '-', identityValidation: false, continueOnError: false,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
  } : undefined,
  appBundleId: 'br.com.sea.dk.terminal', appCategoryType: 'public.app-category.developer-tools',
  extendInfo: { CFBundleDocumentTypes: [{ CFBundleTypeName: 'Projeto ou arquivo do SEA Dock', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.folder', 'public.text', 'public.source-code'] }] },
});
for (const output of outputs) console.log(output);
