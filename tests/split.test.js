'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const split = require('../js/split.js');
const png = require('../js/png.js');
const raster = require('../js/raster.js');
const { makeImage, noiseImage, referenceCrop, sameImage, readZip, fixture } = require('./helpers.js');

const rects = (grid) => grid.cells.map((c) => [c.x, c.y, c.width, c.height]);

test('grid by cell size: exact fit', () => {
  const grid = split.computeGrid(128, 64, { mode: 'size', cellWidth: 32, cellHeight: 32 });
  assert.equal(grid.problem, null);
  assert.equal(grid.columns, 4);
  assert.equal(grid.rows, 2);
  assert.equal(grid.cells.length, 8);
  assert.deepEqual(rects(grid).slice(0, 5), [[0, 0, 32, 32], [32, 0, 32, 32], [64, 0, 32, 32], [96, 0, 32, 32], [0, 32, 32, 32]]);
  assert.deepEqual(grid.cells[5], { index: 5, row: 1, column: 1, x: 32, y: 32, width: 32, height: 32 });
  assert.equal(grid.unusedRight, 0);
  assert.equal(grid.unusedBottom, 0);
});

test('grid by cell size: margin and spacing', () => {
  // 2 px margin, 1 px spacing, 16 px cells: 2 + 16 + 1 + 16 + 1 + 16 + 2 = 54
  const grid = split.computeGrid(54, 37, { mode: 'size', cellWidth: 16, cellHeight: 16, margin: 2, spacing: 1 });
  assert.equal(grid.columns, 3);
  assert.equal(grid.rows, 2);
  assert.deepEqual(rects(grid), [
    [2, 2, 16, 16], [19, 2, 16, 16], [36, 2, 16, 16],
    [2, 19, 16, 16], [19, 19, 16, 16], [36, 19, 16, 16],
  ]);
  assert.equal(grid.unusedRight, 2);
  assert.equal(grid.unusedBottom, 2);
});

test('grid by cell size: partial cells at the edges are left out', () => {
  const grid = split.computeGrid(100, 40, { mode: 'size', cellWidth: 32, cellHeight: 32 });
  assert.equal(grid.columns, 3);
  assert.equal(grid.rows, 1);
  assert.equal(grid.unusedRight, 4);
  assert.equal(grid.unusedBottom, 8);
});

test('grid by cell size: margin only on the top/left still works', () => {
  const grid = split.computeGrid(65, 33, { mode: 'size', cellWidth: 32, cellHeight: 32, margin: 1 });
  assert.equal(grid.columns, 2);
  assert.equal(grid.rows, 1);
  assert.deepEqual(rects(grid), [[1, 1, 32, 32], [33, 1, 32, 32]]);
});

test('grid by rows & columns: even division', () => {
  const grid = split.computeGrid(96, 64, { mode: 'count', columns: 3, rows: 2 });
  assert.equal(grid.cellWidth, 32);
  assert.equal(grid.cellHeight, 32);
  assert.equal(grid.cells.length, 6);
  assert.deepEqual(grid.cells[4], { index: 4, row: 1, column: 1, x: 32, y: 32, width: 32, height: 32 });
});

test('grid by rows & columns: margin on all sides and spacing', () => {
  // 3 + 10 + 2 + 10 + 2 + 10 + 3 = 40 wide; 3 + 10 + 3 = 16 tall
  const grid = split.computeGrid(40, 16, { mode: 'count', columns: 3, rows: 1, margin: 3, spacing: 2 });
  assert.deepEqual(rects(grid), [[3, 3, 10, 10], [15, 3, 10, 10], [27, 3, 10, 10]]);
  assert.equal(grid.unusedRight, 3);
});

test('grid by rows & columns: uneven sizes round down and report the leftover', () => {
  const grid = split.computeGrid(100, 50, { mode: 'count', columns: 3, rows: 2 });
  assert.equal(grid.cellWidth, 33);
  assert.equal(grid.cellHeight, 25);
  assert.equal(grid.unusedRight, 1);
  assert.equal(grid.unusedBottom, 0);
});

test('grid reports why nothing fits instead of returning nonsense', () => {
  const big = split.computeGrid(20, 20, { mode: 'size', cellWidth: 32, cellHeight: 8 });
  assert.equal(big.cells.length, 0);
  assert.match(big.problem, /does not fit/);
  assert.equal(big.columns, 0);

  const many = split.computeGrid(10, 10, { mode: 'count', columns: 20, rows: 1 });
  assert.equal(many.cells.length, 0);
  assert.match(many.problem, /20 columns/);

  const tooMany = split.computeGrid(1000, 1000, { mode: 'size', cellWidth: 1, cellHeight: 1 });
  assert.equal(tooMany.cells.length, 0);
  assert.match(tooMany.problem, /limit/);
});

test('grid rejects invalid numbers', () => {
  const bad = [
    { mode: 'size', cellWidth: 0, cellHeight: 8 },
    { mode: 'size', cellWidth: 8.5, cellHeight: 8 },
    { mode: 'size', cellWidth: 8, cellHeight: NaN },
    { mode: 'size', cellWidth: 8, cellHeight: 8, margin: -1 },
    { mode: 'size', cellWidth: 8, cellHeight: 8, spacing: 1.5 },
    { mode: 'count', columns: 0, rows: 1 },
    { mode: 'count', columns: 2, rows: '3' },
  ];
  for (const options of bad) assert.throws(() => split.computeGrid(64, 64, options), RangeError, JSON.stringify(options));
});

test('file names: prefix, zero padding, safe characters', () => {
  assert.equal(split.frameFileName('walk_', 1, 2), 'walk_01.png');
  assert.equal(split.frameFileName('walk_', 7, 3), 'walk_007.png');
  assert.equal(split.frameFileName('walk_', 123, 2), 'walk_123.png', 'never truncates');
  assert.equal(split.frameFileName('', 0, 1), '0.png');
  assert.equal(split.frameFileName('a/b\\c:d*e?"f<g>h|', 1, 2), 'a_b_c_d_e__f_g_h_01.png');
  assert.equal(split.frameFileName('走る-', 5, 2), '走る-05.png');
});

// A 4 × 2 sheet of 8 × 8 cells. Cells 2 and 5 are empty; cell 2 has
// coloured pixels with alpha 0 (still empty); cell 6 has one nearly
// transparent pixel (alpha 1, not empty).
function testSheet() {
  return makeImage(32, 16, (x, y) => {
    const cell = Math.floor(y / 8) * 4 + Math.floor(x / 8);
    if (cell === 2) return [255, 0, 0, 0];
    if (cell === 5) return [0, 0, 0, 0];
    if (cell === 6) return x === 50 % 32 && y === 12 ? [9, 9, 9, 1] : [0, 0, 0, 0];
    return [cell * 30, x * 7, y * 13, 255];
  });
}

const GRID_8 = { mode: 'size', cellWidth: 8, cellHeight: 8 };

test('empty cells are detected by alpha only', () => {
  const plan = split.planSplit(testSheet(), { ...GRID_8, prefix: 'f_' });
  assert.deepEqual(plan.frames.map((f) => f.empty), [false, false, true, false, false, true, false, false]);
  assert.equal(plan.emptyCount, 2);
});

test('skipping empty cells numbers the rest consecutively', () => {
  const plan = split.planSplit(testSheet(), { ...GRID_8, prefix: 'walk_', skipEmpty: true });
  assert.equal(plan.exportCount, 6);
  assert.deepEqual(plan.frames.map((f) => f.fileName), [
    'walk_01.png', 'walk_02.png', null, 'walk_03.png', 'walk_04.png', null, 'walk_05.png', 'walk_06.png',
  ]);
});

test('keeping empty cells, custom start number and digits', () => {
  const plan = split.planSplit(testSheet(), { ...GRID_8, prefix: 'tile', skipEmpty: false, startNumber: 0, digits: 3 });
  assert.equal(plan.exportCount, 8);
  assert.equal(plan.frames[0].fileName, 'tile000.png');
  assert.equal(plan.frames[7].fileName, 'tile007.png');
  assert.ok(plan.frames.every((f) => !f.skipped));
});

test('split copies every cell exactly', () => {
  const sheet = noiseImage(54, 37, 3);
  const options = { mode: 'size', cellWidth: 16, cellHeight: 16, margin: 2, spacing: 1, skipEmpty: false, prefix: 'c' };
  const frames = split.splitSheet(sheet, options);
  const grid = split.computeGrid(54, 37, options);
  assert.equal(frames.length, 6);
  frames.forEach((frame, i) => {
    const c = grid.cells[i];
    assert.ok(sameImage(frame.image, referenceCrop(sheet, c.x, c.y, c.width, c.height)), `cell ${i}`);
  });
});

test('split → ZIP → PNG files: names and pixels survive the whole pipeline', async () => {
  const sheet = testSheet();
  const progress = [];
  const result = await split.buildSplitZip(sheet, { ...GRID_8, prefix: 'walk_' }, {
    date: new Date(2026, 0, 1),
    onProgress: (done, total) => progress.push([done, total]),
  });
  const names = ['walk_01.png', 'walk_02.png', 'walk_03.png', 'walk_04.png', 'walk_05.png', 'walk_06.png'];
  assert.deepEqual(result.names, names);
  assert.deepEqual(progress.at(-1), [6, 6]);

  const entries = readZip(result.zip);
  assert.deepEqual(entries.map((e) => e.name), names);
  const sourceCells = [0, 1, 3, 4, 6, 7];
  for (let i = 0; i < entries.length; i++) {
    const image = await png.decodePng(entries[i].data);
    const cell = sourceCells[i];
    const expected = referenceCrop(sheet, (cell % 4) * 8, Math.floor(cell / 4) * 8, 8, 8);
    assert.ok(sameImage(image, expected), entries[i].name);
  }
});

test('split works on a decoded PNG file (palette + transparency)', async () => {
  const sheet = await png.decodePng(fixture('palette4.png')); // 13 × 7
  const frames = split.splitSheet(sheet, { mode: 'count', columns: 2, rows: 1, skipEmpty: false });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].image.width, 6);
  assert.ok(sameImage(frames[1].image, raster.cropImage(sheet, 6, 0, 6, 7)));
});

test('exporting a sheet with only empty cells is refused', async () => {
  const blank = raster.createImage(16, 16);
  await assert.rejects(split.buildSplitZip(blank, GRID_8), /no frames/);
  assert.throws(() => split.splitSheet(blank, { mode: 'size', cellWidth: 32, cellHeight: 32 }), /does not fit/);
});
