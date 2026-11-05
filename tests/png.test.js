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

// ---------------------------------------------------------------- checksums

/** Lists the chunks of a PNG file: { type, start, dataStart, dataEnd }. */
function listChunks(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const list = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    list.push({ type: buf.toString('latin1', pos + 4, pos + 8), start: pos, dataStart: pos + 8, dataEnd: pos + 8 + length });
    pos += 12 + length;
  }
  return list;
}

/** Copy of `bytes` with one byte changed inside the data of the n-th chunk of `type`; its CRC is left alone. */
function damageChunk(bytes, type, offset, nth) {
  const chunk = listChunks(bytes).filter((c) => c.type === type)[nth || 0];
  assert.ok(chunk, `no ${type} chunk`);
  const copy = new Uint8Array(bytes);
  copy[chunk.dataStart + offset] ^= 0x01;
  return copy;
}

function isDamagedError(type) {
  return (err) => {
    assert.equal(err.name, 'PngError');
    assert.equal(err.damaged, true, 'marked as damaged');
    assert.match(err.message, /damaged/);
    if (type) assert.ok(err.message.includes(type), err.message);
    return true;
  };
}

test('a damaged palette is refused instead of decoding with wrong colours', async () => {
  // The palette is not covered by zlib's own checksum, so without the CRC
  // check this file decodes "fine", with one colour silently changed.
  const bad = damageChunk(fixture('palette4.png'), 'PLTE', 4);
  await assert.rejects(png.decodePng(bad), isDamagedError('PLTE'));
});

test('every chunk that affects the pixels is checked against its CRC', async () => {
  const cases = [
    ['rgba8.png', 'IHDR', 3, 0],
    ['rgba8.png', 'IDAT', 10, 0],
    ['rgba8-multi-idat.png', 'IDAT', 100, 2],
    ['palette4.png', 'tRNS', 1, 0],
    ['rgb8-trns.png', 'tRNS', 1, 0],
    ['gray8-trns.png', 'tRNS', 1, 0],
  ];
  for (const [file, type, offset, nth] of cases) {
    await assert.rejects(png.decodePng(damageChunk(fixture(file), type, offset, nth)), isDamagedError(type), `${file} ${type}`);
  }
  assert.throws(() => png.readSize(damageChunk(fixture('rgba8.png'), 'IHDR', 3)), isDamagedError('IHDR'));
});

test('a file cut off inside a checksum is reported as incomplete', async () => {
  const good = fixture('rgba8.png');
  const idat = listChunks(good).find((c) => c.type === 'IDAT');
  await assert.rejects(png.decodePng(good.subarray(0, idat.dataEnd + 2)), (err) => {
    assert.equal(err.damaged, true);
    assert.match(err.message, /incomplete/);
    return true;
  });
});

test('a bad checksum on a chunk that does not affect pixels (text) is ignored', async () => {
  const good = fixture('rgba8.png');
  const ihdr = listChunks(good).find((c) => c.type === 'IHDR');
  const text = Buffer.concat([
    Buffer.from([0, 0, 0, 7]), Buffer.from('tEXtnote\0hi', 'latin1'), Buffer.from([1, 2, 3, 4]), // wrong CRC
  ]);
  const withText = new Uint8Array(Buffer.concat([
    Buffer.from(good.subarray(0, ihdr.dataEnd + 4)), text, Buffer.from(good.subarray(ihdr.dataEnd + 4)),
  ]));
  const a = await png.decodePng(good);
  const b = await png.decodePng(withText);
  assert.ok(sameImage(a, b));
});
