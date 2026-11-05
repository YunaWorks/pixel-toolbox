'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const png = require('../js/png.js');
const { noiseImage, makeImage, sameImage, fixture, FIXTURES } = require('./helpers.js');

const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));

test('decodes every fixture made by other encoders, pixel for pixel', async (t) => {
  const names = Object.keys(expected);
  assert.ok(names.length >= 20, 'fixtures are missing');
  for (const name of names) {
    await t.test(name, async () => {
      const want = expected[name];
      const image = await png.decodePng(fixture(name));
      assert.equal(image.width, want.width);
      assert.equal(image.height, want.height);
      assert.ok(image.data instanceof Uint8ClampedArray);
      assert.deepEqual(Buffer.from(image.data), Buffer.from(want.rgba, 'base64'));
    });
  }
});

test('encode → decode keeps every pixel exactly, including partial alpha', async () => {
  for (const [w, h] of [[1, 1], [3, 5], [17, 2], [64, 33]]) {
    const image = noiseImage(w, h, w * 31 + h);
    const bytes = await png.encodePng(image);
    const back = await png.decodePng(bytes);
    assert.ok(sameImage(image, back), `round trip failed for ${w}×${h}`);
  }
});

test('encoded files are valid PNG: signature, header, CRCs and zlib data', async () => {
  const image = noiseImage(20, 9, 5);
  const bytes = Buffer.from(await png.encodePng(image));
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const chunks = [];
  let pos = 8;
  while (pos < bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('latin1', pos + 4, pos + 8);
    const body = bytes.subarray(pos + 8, pos + 8 + length);
    const crc = bytes.readUInt32BE(pos + 8 + length);
    assert.equal(crc, zlib.crc32(bytes.subarray(pos + 4, pos + 8 + length)), `CRC of ${type}`);
    chunks.push({ type, body });
    pos += 12 + length;
  }
  assert.equal(pos, bytes.length);
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);

  const ihdr = chunks[0].body;
  assert.equal(ihdr.readUInt32BE(0), 20);
  assert.equal(ihdr.readUInt32BE(4), 9);
  assert.deepEqual([...ihdr.subarray(8)], [8, 6, 0, 0, 0]); // 8-bit RGBA, no interlace

  const raw = zlib.inflateSync(chunks[1].body);
  assert.equal(raw.length, (20 * 4 + 1) * 9);
  for (let y = 0; y < 9; y++) assert.ok(raw[y * 81] <= 4, 'valid filter type');
});

test('fully transparent pixels keep their stored colour', async () => {
  const image = makeImage(2, 1, (x) => (x === 0 ? [10, 20, 30, 0] : [200, 100, 50, 255]));
  const back = await png.decodePng(await png.encodePng(image));
  assert.deepEqual([...back.data], [10, 20, 30, 0, 200, 100, 50, 255]);
});

test('isPng and readSize', () => {
  assert.equal(png.isPng(fixture('rgba8.png')), true);
  assert.equal(png.isPng(new Uint8Array([1, 2, 3])), false);
  assert.equal(png.isPng(new TextEncoder().encode('GIF89a......')), false);
  assert.deepEqual(png.readSize(fixture('rgba8-multi-idat.png')), { width: 32, height: 24 });
});

test('rejects files that are not PNG or are damaged, with a readable message', async () => {
  await assert.rejects(png.decodePng(new TextEncoder().encode('not a png at all')), {
    name: 'PngError',
    message: /not a PNG/,
  });

  const good = fixture('rgba8.png');
  await assert.rejects(png.decodePng(good.subarray(0, 40)), { name: 'PngError' });

  // Corrupt the compressed data (but keep the chunk structure).
  const bad = new Uint8Array(good);
  const idat = Buffer.from(bad).indexOf('IDAT');
  for (let i = idat + 6; i < idat + 20; i++) bad[i] ^= 0x5a;
  await assert.rejects(png.decodePng(bad), { name: 'PngError' });
});

test('refuses to encode impossible images', async () => {
  await assert.rejects(png.encodePng({ width: 0, height: 4, data: new Uint8ClampedArray(0) }), RangeError);
  await assert.rejects(png.encodePng({ width: 2, height: 2, data: new Uint8ClampedArray(3) }), RangeError);
});
