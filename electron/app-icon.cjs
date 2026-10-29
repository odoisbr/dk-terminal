const path = require('node:path');

// The PNG is used by BrowserWindow (including Linux) and the development Dock.
function windowIcon(root) { return path.join(root, 'assets', 'sea-dock.png'); }

// Electron Packager embeds native icons only on macOS and Windows.
function packageIcon(root, platform = process.platform) {
  if (platform === 'darwin') return path.join(root, 'assets', 'sea-dock.icns');
  if (platform === 'win32') return path.join(root, 'assets', 'sea-dock.ico');
  return undefined;
}

module.exports = { windowIcon, packageIcon };
