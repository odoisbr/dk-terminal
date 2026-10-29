const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { packageIcon, windowIcon } = require('../electron/app-icon.cjs');

const root = path.resolve(__dirname, '..');
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const read = name => fs.readFileSync(path.join(root, 'assets', name));
function dimensions(buffer) {
  assert.deepEqual(buffer.subarray(0, 8), pngSignature);
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR');
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

// Decode an RGBA PNG to verify actual alpha and palette pixels without native
// imaging libraries or launching Electron in the unit test suite.
function pixels(buffer) {
  const [width, height] = dimensions(buffer);
  assert.deepEqual([...buffer.subarray(24, 29)], [8, 6, 0, 0, 0]);
  const blocks = [];
  for (let pos = 8; pos < buffer.length;) {
    const size = buffer.readUInt32BE(pos), type = buffer.toString('ascii', pos + 4, pos + 8);
    assert.ok(pos + size + 12 <= buffer.length);
    if (type === 'IDAT') blocks.push(buffer.subarray(pos + 8, pos + 8 + size));
    pos += size + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(blocks));
  const stride = width * 4;
  assert.equal(raw.length, (stride + 1) * height);
  const out = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= 4 ? out[i - 4] : 0, b = y ? out[i - stride] : 0;
      const c = y && x >= 4 ? out[i - stride - 4] : 0;
      const correction = filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : 0;
      out[i] = (raw[y * (stride + 1) + x + 1] + correction) & 255;
    }
  }
  return (x, y) => [...out.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
}

test('a origem é a assinatura oficial e o PNG mantém transparência e contraste', () => {
  assert.equal(crypto.createHash('sha256').update(read('sea-vertical-white.png')).digest('hex'),
    'a7ba43234697f6a59ff69e62ada6e20a0f56cc4bff46d9b3cefd51c1e2651e18');
  const png = read('sea-dock.png');
  assert.deepEqual(dimensions(png), [1024, 1024]);
  const pixel = pixels(png);
  assert.equal(pixel(0, 0)[3], 0);
  assert.deepEqual(pixel(512, 100), [0, 98, 153, 255]);
  assert.deepEqual(pixel(512, 250), [255, 255, 255, 255]);
});

test('ICNS inclui tamanhos padrão e Retina legíveis como imagens PNG', () => {
  const file = read('sea-dock.icns');
  assert.equal(file.toString('ascii', 0, 4), 'icns');
  assert.equal(file.readUInt32BE(4), file.length);
  const required = new Map(Object.entries({ icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 }));
  for (let pos = 8; pos < file.length;) {
    const type = file.toString('ascii', pos, pos + 4), length = file.readUInt32BE(pos + 4);
    assert.ok(length >= 8 && pos + length <= file.length);
    if (required.has(type)) {
      assert.deepEqual(dimensions(file.subarray(pos + 8, pos + length)), [required.get(type), required.get(type)]);
      required.delete(type);
    }
    pos += length;
  }
  assert.equal(required.size, 0);
});

test('ICO contém imagens de 16 a 256 pixels e mantém o canto transparente', () => {
  const file = read('sea-dock.ico');
  assert.equal(file.readUInt16LE(0), 0); assert.equal(file.readUInt16LE(2), 1);
  const required = new Set([16, 32, 48, 64, 128, 256]);
  const count = file.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const pos = 6 + i * 16, width = file[pos] || 256, height = file[pos + 1] || 256;
    const length = file.readUInt32LE(pos + 8), offset = file.readUInt32LE(pos + 12);
    assert.ok(offset >= 6 + count * 16 && offset + length <= file.length);
    assert.equal(width, height);
    assert.equal(file.readUInt16LE(pos + 6), 32);
    assert.equal(file.readUInt32LE(offset), 40); // BITMAPINFOHEADER
    assert.equal(file.readInt32LE(offset + 4), width);
    assert.equal(file.readInt32LE(offset + 8), height * 2); // XOR + AND mask
    assert.ok(length >= 40 + width * height * 4);
    assert.equal(file[offset + 40 + (height - 1) * width * 4 + 3], 0);
    required.delete(width);
  }
  assert.equal(required.size, 0);
});

test('seleciona os formatos nativos por plataforma e PNG para janela', () => {
  assert.equal(path.basename(windowIcon(root)), 'sea-dock.png');
  assert.equal(path.basename(packageIcon(root, 'darwin')), 'sea-dock.icns');
  assert.equal(path.basename(packageIcon(root, 'win32')), 'sea-dock.ico');
  assert.equal(packageIcon(root, 'linux'), undefined);
  for (const icon of [windowIcon(root), packageIcon(root, 'darwin'), packageIcon(root, 'win32')]) assert.ok(fs.existsSync(icon));
});
