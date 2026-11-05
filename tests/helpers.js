'use strict';
// Shared helpers for the test suite (not a test file itself).

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const raster = require('../js/raster.js');

/** Builds an image where fn(x, y) returns [r, g, b, a] for each pixel. */
function makeImage(width, height, fn) {
  const image = raster.createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = fn(x, y);
      image.data.set(px, (y * width + x) * 4);
    }
  }
  return image;
}

/** A deterministic pseudo-random image that uses every kind of alpha value. */
function noiseImage(width, height, seed) {
  let s = seed || 1;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s >> 16;
  };
  return makeImage(width, height, () => [next() & 255, next() & 255, next() & 255, [0, 255, next() & 255][next() % 3]]);
}

function pixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(i, i + 4));
}

/** Reference crop written independently of raster.cropImage. */
function referenceCrop(image, x0, y0, w, h) {
  return makeImage(w, h, (x, y) => {
    const sx = x0 + x;
    const sy = y0 + y;
    if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) return [0, 0, 0, 0];
    return pixel(image, sx, sy);
  });
}

function sameImage(a, b) {
  return a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;
}

/**
 * Reads a ZIP archive written with the "stored" method, checking the
 * structures and CRCs along the way. Returns [{ name, data, flags, method, time, date }].
 */
function readZip(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = buf.length - 22;
  if (buf.readUInt32LE(eocd) !== 0x06054b50) throw new Error('missing end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  if (buf.readUInt16LE(eocd + 8) !== count) throw new Error('entry counts differ');
  const cdSize = buf.readUInt32LE(eocd + 12);
  let pos = buf.readUInt32LE(eocd + 16);
  if (pos + cdSize !== eocd) throw new Error('central directory size/offset mismatch');
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad central directory header');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const time = buf.readUInt16LE(pos + 12);
    const date = buf.readUInt16LE(pos + 14);
    const crc = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20);
    const usize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header for ' + name);
    if (buf.readUInt32LE(local + 14) !== crc) throw new Error('local/central CRC differ for ' + name);
    const localNameLen = buf.readUInt16LE(local + 26);
    const localExtraLen = buf.readUInt16LE(local + 28);
    if (buf.subarray(local + 30, local + 30 + localNameLen).toString('utf8') !== name) throw new Error('name mismatch');
    const start = local + 30 + localNameLen + localExtraLen;
    const data = new Uint8Array(buf.subarray(start, start + csize));
    if (method !== 0 || csize !== usize) throw new Error('expected stored entries');
    if (zlib.crc32(data) !== crc) throw new Error('CRC mismatch for ' + name);
    entries.push({ name, data, flags, method, time, date });
  }
  return entries;
}

const FIXTURES = path.join(__dirname, 'fixtures');

function fixture(name) {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

module.exports = { makeImage, noiseImage, pixel, referenceCrop, sameImage, readZip, fixture, FIXTURES };
