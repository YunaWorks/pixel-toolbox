/*
 * Pixel Toolbox — sprite sheet splitting.
 *
 * Grid model (same convention as most tile and sprite tools):
 *   - `margin`  is the empty border around the whole sheet, in pixels.
 *   - `spacing` is the gap between neighbouring cells, in pixels.
 *   - Cells are read left to right, top to bottom.
 *
 * "By cell size" uses every whole cell that fits after the left/top margin.
 * "By rows & columns" divides the area inside the margin evenly; any
 * pixels that don't divide evenly are left over at the right/bottom.
 *
 * MIT License. Copyright (c) 2026 YunaWorks.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./raster.js'), require('./png.js'), require('./zip.js'));
  } else {
    const ns = (root.PixelToolbox = root.PixelToolbox || {});
    ns.split = factory(ns.raster, ns.png, ns.zip);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raster, png, zip) {
  'use strict';

  /** Upper limit on the number of cells, to keep the page responsive. */
  const MAX_CELLS = 16384;

  function wholeNumber(value, label, min, max) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
      const range = max === undefined ? 'at least ' + min : 'from ' + min + ' to ' + max;
      throw new RangeError(label + ' must be a whole number ' + range + '.');
    }
    return value;
  }

  /** How many cells of `cell` px fit into `length` px after the leading margin. */
  function fitCount(length, margin, spacing, cell) {
    return Math.max(0, Math.floor((length - margin + spacing) / (cell + spacing)));
  }

  function px(n) {
    return n + ' px';
  }

  /**
   * Works out the cell rectangles for an image of the given size.
   * Throws RangeError for invalid settings (negative numbers, zero sizes…).
   * When the settings are valid but produce no cells, `cells` is empty and
   * `problem` explains why.
   */
  function computeGrid(imageWidth, imageHeight, options) {
    const mode = options.mode === 'count' ? 'count' : 'size';
    const margin = wholeNumber(options.margin === undefined ? 0 : options.margin, 'Margin', 0);
    const spacing = wholeNumber(options.spacing === undefined ? 0 : options.spacing, 'Spacing', 0);
    let columns, rows, cellWidth, cellHeight;
    let problem = null;

    if (mode === 'size') {
      cellWidth = wholeNumber(options.cellWidth, 'Cell width', 1);
      cellHeight = wholeNumber(options.cellHeight, 'Cell height', 1);
      columns = fitCount(imageWidth, margin, spacing, cellWidth);
      rows = fitCount(imageHeight, margin, spacing, cellHeight);
      const withMargin = margin ? ' with a ' + px(margin) + ' margin' : '';
      if (columns === 0) {
        problem = 'A cell ' + px(cellWidth) + ' wide does not fit in this ' + px(imageWidth) + '-wide image' + withMargin + '.';
      } else if (rows === 0) {
        problem = 'A cell ' + px(cellHeight) + ' tall does not fit in this ' + px(imageHeight) + '-tall image' + withMargin + '.';
      }
    } else {
      columns = wholeNumber(options.columns, 'Columns', 1);
      rows = wholeNumber(options.rows, 'Rows', 1);
      cellWidth = Math.floor((imageWidth - 2 * margin - (columns - 1) * spacing) / columns);
      cellHeight = Math.floor((imageHeight - 2 * margin - (rows - 1) * spacing) / rows);
      if (cellWidth < 1) {
        problem = columns + ' columns do not fit in this ' + px(imageWidth) + '-wide image with these margin and spacing values.';
      } else if (cellHeight < 1) {
        problem = rows + ' rows do not fit in this ' + px(imageHeight) + '-tall image with these margin and spacing values.';
      }
    }

    if (!problem && columns * rows > MAX_CELLS) {
      problem = 'That makes ' + (columns * rows).toLocaleString('en-US') + ' cells; the limit is ' +
        MAX_CELLS.toLocaleString('en-US') + '. Try a larger cell size.';
    }

    const cells = [];
    if (!problem) {
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          cells.push({
            index: cells.length,
            row: row,
            column: column,
            x: margin + column * (cellWidth + spacing),
            y: margin + row * (cellHeight + spacing),
            width: cellWidth,
            height: cellHeight,
          });
        }
      }
    }

    const usedWidth = cells.length ? margin + columns * cellWidth + (columns - 1) * spacing : 0;
    const usedHeight = cells.length ? margin + rows * cellHeight + (rows - 1) * spacing : 0;
    return {
      mode: mode,
      margin: margin,
      spacing: spacing,
      columns: cells.length ? columns : 0,
      rows: cells.length ? rows : 0,
      cellWidth: cellWidth,
      cellHeight: cellHeight,
      cells: cells,
      // pixels between the last cell and the right / bottom edge of the image
      unusedRight: cells.length ? imageWidth - usedWidth : 0,
      unusedBottom: cells.length ? imageHeight - usedHeight : 0,
      problem: problem,
    };
  }

  /** Replaces characters that are not allowed in file names. */
  function sanitizeFileName(text) {
    return String(text).replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_');
  }

  /** frameFileName('walk_', 1, 2) → 'walk_01.png' */
  function frameFileName(prefix, number, digits) {
    return sanitizeFileName(prefix) + String(number).padStart(digits, '0') + '.png';
  }

  function namingOptions(options) {
    return {
      prefix: options.prefix === undefined ? '' : String(options.prefix),
      startNumber: wholeNumber(options.startNumber === undefined ? 1 : options.startNumber, 'Start number', 0),
      digits: wholeNumber(options.digits === undefined ? 2 : options.digits, 'Digits', 1, 10),
      skipEmpty: options.skipEmpty !== false,
    };
  }

  /**
   * Plans a split without copying any pixels: the grid, which cells are
   * empty (all pixels fully transparent) and the file name of every cell
   * that will be exported. Skipped cells get `fileName: null`; the others
   * are numbered consecutively.
   */
  function planSplit(image, options) {
    const grid = computeGrid(image.width, image.height, options);
    const naming = namingOptions(options);
    let number = naming.startNumber;
    let exportCount = 0;
    let emptyCount = 0;
    const frames = grid.cells.map(function (cell) {
      const empty = raster.isRegionTransparent(image, cell.x, cell.y, cell.width, cell.height);
      const skipped = empty && naming.skipEmpty;
      if (empty) emptyCount++;
      let fileName = null;
      if (!skipped) {
        fileName = frameFileName(naming.prefix, number++, naming.digits);
        exportCount++;
      }
      return { cell: cell, empty: empty, skipped: skipped, fileName: fileName };
    });
    return { grid: grid, frames: frames, exportCount: exportCount, emptyCount: emptyCount };
  }

  /** Splits the sheet. Returns [{ name, image }] for every exported cell. */
  function splitSheet(image, options) {
    const plan = planSplit(image, options);
    if (plan.grid.problem) throw new RangeError(plan.grid.problem);
    return plan.frames
      .filter(function (frame) { return !frame.skipped; })
      .map(function (frame) {
        const c = frame.cell;
        return { name: frame.fileName, image: raster.cropImage(image, c.x, c.y, c.width, c.height) };
      });
  }

  /**
   * Splits the sheet and packs every frame as a PNG into a ZIP archive.
   * `hooks.onProgress(done, total)` is called after each frame;
   * `hooks.date` sets the modification time stored in the archive.
   * Resolves to { zip: Uint8Array, names: string[] }.
   */
  async function buildSplitZip(image, options, hooks) {
    const plan = planSplit(image, options);
    if (plan.grid.problem) throw new RangeError(plan.grid.problem);
    const frames = plan.frames.filter(function (frame) { return !frame.skipped; });
    if (frames.length === 0) throw new RangeError('There are no frames to export: every cell is empty.');
    const entries = [];
    for (let i = 0; i < frames.length; i++) {
      const c = frames[i].cell;
      const data = await png.encodePng(raster.cropImage(image, c.x, c.y, c.width, c.height));
      entries.push({ name: frames[i].fileName, data: data });
      if (hooks && hooks.onProgress) hooks.onProgress(i + 1, frames.length);
    }
    return {
      zip: zip.createZip(entries, { date: hooks && hooks.date }),
      names: entries.map(function (e) { return e.name; }),
    };
  }

  return {
    MAX_CELLS: MAX_CELLS,
    computeGrid: computeGrid,
    sanitizeFileName: sanitizeFileName,
    frameFileName: frameFileName,
    planSplit: planSplit,
    splitSheet: splitSheet,
    buildSplitZip: buildSplitZip,
  };
});
