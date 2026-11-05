'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const merge = require('../js/merge.js');
const png = require('../js/png.js');
const raster = require('../js/raster.js');
const pkg = require('../package.json');
const { makeImage, noiseImage, referenceCrop, sameImage, fixture } = require('./helpers.js');

test('natural sort puts numbers in numeric order', () => {
  const names = ['walk_10.png', 'walk_2.png', 'walk_1.png', 'walk_20.png', 'walk_3.png'];
  assert.deepEqual(names.slice().sort(merge.naturalCompare), ['walk_1.png', 'walk_2.png', 'walk_3.png', 'walk_10.png', 'walk_20.png']);
});

test('natural sort: leading zeros, case, several numbers, prefixes', () => {
  const sorted = (list) => list.slice().sort(merge.naturalCompare);
  assert.deepEqual(sorted(['f010.png', 'f9.png', 'f0011.png', 'f001.png']), ['f001.png', 'f9.png', 'f010.png', 'f0011.png']);
  assert.deepEqual(sorted(['B.png', 'a.png', 'C.png']), ['a.png', 'B.png', 'C.png']);
  assert.deepEqual(sorted(['run2_10.png', 'run10_1.png', 'run2_9.png', 'idle_1.png']), ['idle_1.png', 'run2_9.png', 'run2_10.png', 'run10_1.png']);
  assert.deepEqual(sorted(['frame 10.png', 'frame 9.png', 'frame.png']), ['frame 9.png', 'frame 10.png', 'frame.png']);
  assert.deepEqual(sorted(['a1.png', 'a.png']), ['a.png', 'a1.png']);
  assert.deepEqual(sorted(['x99999999999999999999.png', 'x100000000000000000000.png']), ['x99999999999999999999.png', 'x100000000000000000000.png']);
  assert.equal(merge.naturalCompare('walk_1.png', 'walk_1.png'), 0);
  assert.ok(merge.naturalCompare('a1', 'a01') !== 0, 'equal values are still ordered deterministically');
});

test('sortByName is stable and leaves the input alone', () => {
  const items = [{ name: 'b2', id: 1 }, { name: 'b10', id: 2 }, { name: 'a', id: 3 }, { name: 'b2', id: 4 }];
  const copy = items.slice();
  assert.deepEqual(merge.sortByName(items).map((i) => i.id), [3, 1, 4, 2]);
  assert.deepEqual(items, copy);
});

test('layout: cell size comes from the largest frame in each direction', () => {
  const layout = merge.computeLayout([{ width: 10, height: 30 }, { width: 24, height: 12 }, { width: 16, height: 16 }], { columns: 8 });
  assert.equal(layout.cellWidth, 24);
  assert.equal(layout.cellHeight, 30);
  assert.equal(layout.columns, 3, 'never more columns than frames');
  assert.equal(layout.rows, 1);
  assert.equal(layout.width, 72);
  assert.equal(layout.height, 30);
});

test('layout: frames per row, spacing and margin', () => {
  const sizes = Array.from({ length: 7 }, () => ({ width: 16, height: 8 }));
  const layout = merge.computeLayout(sizes, { columns: 3, spacing: 2, margin: 4 });
  assert.equal(layout.columns, 3);
  assert.equal(layout.rows, 3);
  assert.equal(layout.width, 4 + 16 * 3 + 2 * 2 + 4);
  assert.equal(layout.height, 4 + 8 * 3 + 2 * 2 + 4);
  assert.deepEqual(layout.placements.map((p) => [p.x, p.y]), [
    [4, 4], [22, 4], [40, 4],
    [4, 14], [22, 14], [40, 14],
    [4, 24],
  ]);
});

test('layout: centre alignment (odd leftovers go right / down)', () => {
  const layout = merge.computeLayout([{ width: 32, height: 32 }, { width: 21, height: 10 }], { columns: 2, align: 'center' });
  const p = layout.placements[1];
  assert.deepEqual(p.cell, { x: 32, y: 0, width: 32, height: 32 });
  assert.equal(p.offsetX, 5); // (32 - 21) / 2 = 5.5 → 5
  assert.equal(p.offsetY, 11);
  assert.equal(p.x, 37);
  assert.equal(p.y, 11);
});

test('layout: bottom alignment keeps feet on the cell floor, centred horizontally', () => {
  const layout = merge.computeLayout([{ width: 32, height: 32 }, { width: 20, height: 10 }], { columns: 1, align: 'bottom', spacing: 3 });
  const p = layout.placements[1];
  assert.deepEqual(p.cell, { x: 0, y: 35, width: 32, height: 32 });
  assert.equal(p.offsetX, 6);
  assert.equal(p.offsetY, 22);
  assert.equal(p.y + p.height, p.cell.y + p.cell.height);
});

test('layout rejects bad input', () => {
  assert.throws(() => merge.computeLayout([], { columns: 4 }), RangeError);
  assert.throws(() => merge.computeLayout([{ width: 8, height: 8 }], { columns: 0 }), RangeError);
  assert.throws(() => merge.computeLayout([{ width: 8, height: 8 }], { columns: 2, spacing: -1 }), RangeError);
  assert.throws(() => merge.computeLayout([{ width: 8, height: 8 }], { columns: 2, align: 'top' }), RangeError);
  assert.throws(() => merge.computeLayout([{ width: 9000, height: 9000 }], { columns: 1 }), /too large/);
});

test('packing copies every frame exactly and leaves the rest transparent', () => {
  const frames = [noiseImage(16, 16, 1), noiseImage(9, 13, 2), noiseImage(16, 5, 3), noiseImage(1, 1, 4)];
  const { image, layout } = merge.packSprites(frames, { columns: 3, spacing: 1, margin: 2, align: 'bottom' });
  assert.equal(image.width, 2 + 16 * 3 + 2 + 2);
  assert.equal(image.height, 2 + 16 * 2 + 1 + 2);

  const covered = new Uint8Array(image.width * image.height);
  for (const p of layout.placements) {
    assert.ok(sameImage(referenceCrop(image, p.x, p.y, p.width, p.height), frames[p.index]), `frame ${p.index}`);
    for (let y = p.y; y < p.y + p.height; y++) for (let x = p.x; x < p.x + p.width; x++) covered[y * image.width + x] = 1;
  }
  for (let i = 0; i < covered.length; i++) {
    if (!covered[i]) assert.deepEqual([...image.data.subarray(i * 4, i * 4 + 4)], [0, 0, 0, 0]);
  }
});

test('frame data (JSON) lists position and size of every frame', () => {
  const names = ['walk_01.png', 'walk_02.png', 'walk_03.png'];
  const layout = merge.computeLayout([{ width: 32, height: 32 }, { width: 30, height: 28 }, { width: 32, height: 32 }], {
    columns: 2, spacing: 2, margin: 1, align: 'bottom',
  });
  const atlas = merge.buildAtlas(names, layout, 'walk.png');
  assert.equal(atlas.frames.length, 3);
  assert.deepEqual(atlas.frames[0], {
    filename: 'walk_01.png',
    frame: { x: 1, y: 1, w: 32, h: 32 },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: 32, h: 32 },
    sourceSize: { w: 32, h: 32 },
    cell: { x: 1, y: 1, w: 32, h: 32 },
  });
  assert.deepEqual(atlas.frames[1], {
    filename: 'walk_02.png',
    frame: { x: 36, y: 5, w: 30, h: 28 },
    rotated: false,
    trimmed: true,
    spriteSourceSize: { x: 1, y: 4, w: 30, h: 28 },
    sourceSize: { w: 32, h: 32 },
    cell: { x: 35, y: 1, w: 32, h: 32 },
  });
  assert.deepEqual(atlas.frames[2].cell, { x: 1, y: 35, w: 32, h: 32 });
  assert.deepEqual(atlas.meta, {
    app: 'Pixel Toolbox',
    version: pkg.version,
    image: 'walk.png',
    format: 'RGBA8888',
    size: { w: 68, h: 68 },
    scale: '1',
    grid: { columns: 2, rows: 2, cell: { w: 32, h: 32 }, margin: 1, spacing: 2, align: 'bottom' },
  });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(atlas)));
});

test('frame data is written as readable, valid JSON', () => {
  const layout = merge.computeLayout([{ width: 16, height: 16 }, { width: 8, height: 12 }], { columns: 2 });
  const atlas = merge.buildAtlas(['a "quoted" name.png', 'b.png'], layout, 'sheet.png');
  const text = merge.stringifyAtlas(atlas);
  assert.deepEqual(JSON.parse(text), atlas);
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.includes('\n      "frame": { "x": 0, "y": 0, "w": 16, "h": 16 },\n'), 'rectangles on one line');
  assert.ok(text.includes('"filename": "a \\"quoted\\" name.png"'), 'names are escaped');
  assert.equal(merge.stringifyAtlas({ frames: [] }), '{\n  "frames": []\n}\n');
});

test('merge works end to end with real PNG files of different formats', async () => {
  const files = ['rgba8.png', 'palette2.png', 'gray16.png', 'rgba8-multi-idat.png'];
  const images = await Promise.all(files.map((f) => png.decodePng(fixture(f))));
  const { image, layout } = merge.packSprites(images, { columns: 2, align: 'center' });
  const back = await png.decodePng(await png.encodePng(image));
  assert.ok(sameImage(back, image));
  layout.placements.forEach((p) => {
    assert.ok(sameImage(raster.cropImage(back, p.x, p.y, p.width, p.height), images[p.index]), files[p.index]);
  });
});

test('a single frame produces a sheet of exactly that frame', () => {
  const frame = makeImage(5, 3, (x, y) => [x, y, 7, 200]);
  const { image } = merge.packSprites([frame], { columns: 4 });
  assert.ok(sameImage(image, frame));
});
