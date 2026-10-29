// Regenera os ícones de distribuição usando o arquivo oficial da marca.
// Requer ImageMagick. Os binários gerados são incluídos no repositório e o
// processo não faz parte do build nem exige ferramentas gráficas no produto.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const assets = path.resolve(__dirname, '..', 'assets');
const logo = path.join(assets, 'sea-vertical-white.png');
const expected = 'a7ba43234697f6a59ff69e62ada6e20a0f56cc4bff46d9b3cefd51c1e2651e18';
const digest = crypto.createHash('sha256').update(fs.readFileSync(logo)).digest('hex');
if (digest !== expected) throw new Error('A assinatura SEA não corresponde ao arquivo oficial verificado.');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sea-dock-icon-'));
const run = (file, args) => execFileSync(file, args, { stdio: 'inherit' });
try {
  const png = path.join(temp, 'sea-dock.png');
  const ico = path.join(temp, 'sea-dock.ico');
  const icns = path.join(temp, 'sea-dock.icns');
  // A marca completa é reduzida proporcionalmente e fica sobre fundo aprovado;
  // há mais de X/4 de espaço livre entre a assinatura e os limites da forma.
  run('magick', ['-size', '1024x1024', 'xc:none', '-fill', '#006299', '-draw',
    'roundrectangle 80,80 944,944 190,190', '(', logo, '-resize', 'x666', ')',
    '-gravity', 'center', '-compose', 'over', '-composite', '-strip', `PNG32:${png}`]);
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    run('magick', [png, '-filter', 'Lanczos', '-resize', `${size}x${size}`, `PNG32:${path.join(temp, `${size}.png`)}`]);
  }
  // ICNS com entradas PNG em tamanhos padrão e Retina. Esse contêiner simples
  // é o mesmo formato presente no ícone anterior e não depende do iconutil.
  const blocks = [];
  for (const [type, size] of [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128],
    ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
  ]) {
    const pixels = fs.readFileSync(path.join(temp, `${size}.png`));
    const header = Buffer.alloc(8); header.write(type, 0, 'ascii'); header.writeUInt32BE(pixels.length + 8, 4);
    blocks.push(header, pixels);
  }
  const header = Buffer.alloc(8); header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + blocks.reduce((total, block) => total + block.length, 0), 4);
  fs.writeFileSync(icns, Buffer.concat([header, ...blocks]));
  run('magick', [png, '-define', 'icon:auto-resize=256,128,64,48,32,16', ico]);
  for (const name of ['sea-dock.png', 'sea-dock.ico', 'sea-dock.icns']) {
    fs.copyFileSync(path.join(temp, name), path.join(assets, name));
  }
  console.log('Ícones SEA Dock gerados: PNG, ICO e ICNS.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
