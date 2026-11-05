'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const crc32 = require('../js/crc32.js');
const { createZip } = require('../js/zip.js');
const { readZip } = require('./helpers.js');

test('crc32 matches the standard check value and Node’s zlib', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  const data = new Uint8Array(5000).map((_, i) => (i * 7919) & 255);
  assert.equal(crc32(data), zlib.crc32(data));
  // running checksum over two halves equals the checksum of the whole
  assert.equal(crc32(data, 2500, 5000, crc32(data, 0, 2500)), zlib.crc32(data));
});

const DATE = new Date(2026, 10, 5, 14, 30, 58); // local time

function sampleEntries() {
  return [
    { name: 'walk_01.png', data: new Uint8Array([1, 2, 3, 4, 5]) },
    { name: 'walk_02.png', data: new Uint8Array(0) },
    { name: 'héros_走る_03.png', data: new Uint8Array(1000).map((_, i) => i & 255) },
  ];
}

test('writes a well-formed archive that reads back exactly', () => {
  const entries = sampleEntries();
  const bytes = createZip(entries, { date: DATE });
  const back = readZip(bytes);
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  back.forEach((e, i) => {
    assert.deepEqual(e.data, entries[i].data);
    assert.equal(e.method, 0);
    assert.equal(e.flags & 0x0800, 0x0800, 'UTF-8 names flag');
    assert.equal(e.date, ((2026 - 1980) << 9) | (11 << 5) | 5);
    assert.equal(e.time, (14 << 11) | (30 << 5) | 29);
  });
});

test('an empty archive is just the end record', () => {
  const bytes = createZip([], { date: DATE });
  assert.equal(bytes.length, 22);
  assert.deepEqual(readZip(bytes), []);
});

test('rejects entries without a name', () => {
  assert.throws(() => createZip([{ name: '', data: new Uint8Array(1) }]), TypeError);
});

const hasUnzip = spawnSync('unzip', ['-v']).status === 0;

test('the system unzip tool accepts the archive', { skip: !hasUnzip && 'unzip is not available' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-toolbox-zip-'));
  try {
    const file = path.join(dir, 'frames.zip');
    fs.writeFileSync(file, createZip(sampleEntries(), { date: DATE }));
    const result = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /No errors detected/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
