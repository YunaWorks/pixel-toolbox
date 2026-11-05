/*
 * Pixel Toolbox — sprite sheet merging.
 *
 * Frames are placed on a grid of equal cells, left to right and top to
 * bottom. The cell size is the size of the largest frame (width and height
 * are taken separately). Smaller frames are either centred in their cell or
 * stand on the cell's bottom edge, centred horizontally. When a frame can't
 * be centred exactly, the extra pixel goes to the right / bottom.
 *
 * MIT License. Copyright (c) 2026 YunaWorks.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./raster.js'));
  } else {
    const ns = (root.PixelToolbox = root.PixelToolbox || {});
    ns.merge = factory(ns.raster);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raster) {
  'use strict';

  const APP_NAME = 'Pixel Toolbox';
  const APP_VERSION = '1.0.0';
  const ALIGNMENTS = ['center', 'bottom'];

  function wholeNumber(value, label, min) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
      throw new RangeError(label + ' must be a whole number of at least ' + min + '.');
    }
    return value;
  }

  function isDigit(code) {
    return code >= 48 && code <= 57;
  }

  /**
   * Natural ("human") order for file names: numbers inside names are
   * compared by value, so walk_2.png comes before walk_10.png. Letters are
   * compared without regard to case. Usable directly with Array#sort.
   */
  function naturalCompare(a, b) {
    a = String(a);
    b = String(b);
    let i = 0;
    let j = 0;
    let tie = 0;
    while (i < a.length && j < b.length) {
      const ca = a.charCodeAt(i);
      const cb = b.charCodeAt(j);
      if (isDigit(ca) && isDigit(cb)) {
        const startA = i;
        const startB = j;
        while (i < a.length && isDigit(a.charCodeAt(i))) i++;
        while (j < b.length && isDigit(b.charCodeAt(j))) j++;
        let za = startA;
        let zb = startB;
        while (za < i - 1 && a.charCodeAt(za) === 48) za++;
        while (zb < j - 1 && b.charCodeAt(zb) === 48) zb++;
        const lenA = i - za;
        const lenB = j - zb;
        if (lenA !== lenB) return lenA < lenB ? -1 : 1;
        for (let k = 0; k < lenA; k++) {
          const da = a.charCodeAt(za + k);
          const db = b.charCodeAt(zb + k);
          if (da !== db) return da < db ? -1 : 1;
        }
        // Same value: fewer leading zeros first, but only as a tie-breaker.
        if (tie === 0 && i - startA !== j - startB) tie = i - startA < j - startB ? -1 : 1;
        continue;
      }
      const la = a[i].toLowerCase();
      const lb = b[j].toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
      if (tie === 0 && ca !== cb) tie = ca < cb ? -1 : 1;
      i++;
      j++;
    }
    if (i < a.length) return 1;
    if (j < b.length) return -1;
    return tie;
  }

  /** Returns a new array sorted by name in natural order (stable). */
  function sortByName(items, getName) {
    const name = getName || function (item) { return item.name; };
    return items.slice().sort(function (x, y) { return naturalCompare(name(x), name(y)); });
  }

  /**
   * Computes where each frame goes.
   * @param {{width: number, height: number}[]} sizes frame sizes, in order
   * @param {{columns: number, spacing?: number, margin?: number, align?: 'center'|'bottom'}} options
   */
  function computeLayout(sizes, options) {
    if (!sizes || sizes.length === 0) throw new RangeError('Add at least one image.');
    const columnsWanted = wholeNumber(options.columns, 'Frames per row', 1);
    const spacing = wholeNumber(options.spacing === undefined ? 0 : options.spacing, 'Spacing', 0);
    const margin = wholeNumber(options.margin === undefined ? 0 : options.margin, 'Margin', 0);
    const align = options.align === undefined ? 'center' : options.align;
    if (ALIGNMENTS.indexOf(align) < 0) throw new RangeError('Alignment must be "center" or "bottom".');

    let cellWidth = 0;
    let cellHeight = 0;
    for (const s of sizes) {
      wholeNumber(s.width, 'Frame width', 1);
      wholeNumber(s.height, 'Frame height', 1);
      if (s.width > cellWidth) cellWidth = s.width;
      if (s.height > cellHeight) cellHeight = s.height;
    }
    const columns = Math.min(columnsWanted, sizes.length);
    const rows = Math.ceil(sizes.length / columns);
    const width = 2 * margin + columns * cellWidth + (columns - 1) * spacing;
    const height = 2 * margin + rows * cellHeight + (rows - 1) * spacing;
    raster.checkSize(width, height);

    const placements = sizes.map(function (s, index) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const cellX = margin + column * (cellWidth + spacing);
      const cellY = margin + row * (cellHeight + spacing);
      const offsetX = Math.floor((cellWidth - s.width) / 2);
      const offsetY = align === 'bottom' ? cellHeight - s.height : Math.floor((cellHeight - s.height) / 2);
      return {
        index: index,
        row: row,
        column: column,
        cell: { x: cellX, y: cellY, width: cellWidth, height: cellHeight },
        offsetX: offsetX,
        offsetY: offsetY,
        x: cellX + offsetX,
        y: cellY + offsetY,
        width: s.width,
        height: s.height,
      };
    });

    return {
      width: width,
      height: height,
      columns: columns,
      rows: rows,
      cellWidth: cellWidth,
      cellHeight: cellHeight,
      margin: margin,
      spacing: spacing,
      align: align,
      placements: placements,
    };
  }

  /** Draws the frames onto a new transparent sheet. Returns { image, layout }. */
  function packSprites(images, options) {
    const layout = computeLayout(images, options);
    const sheet = raster.createImage(layout.width, layout.height);
    for (const p of layout.placements) raster.blitImage(sheet, images[p.index], p.x, p.y);
    return { image: sheet, layout: layout };
  }

  /**
   * Builds the frame data that goes next to the sheet. The layout follows
   * the common "JSON Array" texture-atlas format:
   *   frame            – where the frame's own pixels are in the sheet
   *   spriteSourceSize – where those pixels sit inside the cell
   *   sourceSize       – the cell size (the same for every frame)
   *   cell             – the cell's rectangle in the sheet
   */
  function buildAtlas(names, layout, imageName) {
    return {
      frames: layout.placements.map(function (p) {
        return {
          filename: names[p.index],
          frame: { x: p.x, y: p.y, w: p.width, h: p.height },
          rotated: false,
          trimmed: p.width !== layout.cellWidth || p.height !== layout.cellHeight,
          spriteSourceSize: { x: p.offsetX, y: p.offsetY, w: p.width, h: p.height },
          sourceSize: { w: layout.cellWidth, h: layout.cellHeight },
          cell: { x: p.cell.x, y: p.cell.y, w: p.cell.width, h: p.cell.height },
        };
      }),
      meta: {
        app: APP_NAME,
        version: APP_VERSION,
        image: imageName,
        format: 'RGBA8888',
        size: { w: layout.width, h: layout.height },
        scale: '1',
        grid: {
          columns: layout.columns,
          rows: layout.rows,
          cell: { w: layout.cellWidth, h: layout.cellHeight },
          margin: layout.margin,
          spacing: layout.spacing,
          align: layout.align,
        },
      },
    };
  }

  /**
   * Formats the frame data as readable JSON: one key per line, but small
   * objects such as rectangles ({ "x": 0, "y": 0, "w": 32, "h": 32 }) on one line.
   */
  function stringifyAtlas(atlas) {
    function format(value, indent) {
      if (value === null || typeof value !== 'object') return JSON.stringify(value);
      const inner = indent + '  ';
      if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return '[\n' + value.map(function (v) { return inner + format(v, inner); }).join(',\n') + '\n' + indent + ']';
      }
      const keys = Object.keys(value);
      const flat = keys.every(function (k) { return value[k] === null || typeof value[k] !== 'object'; });
      if (flat) {
        return '{ ' + keys.map(function (k) { return JSON.stringify(k) + ': ' + JSON.stringify(value[k]); }).join(', ') + ' }';
      }
      return '{\n' + keys.map(function (k) { return inner + JSON.stringify(k) + ': ' + format(value[k], inner); }).join(',\n') +
        '\n' + indent + '}';
    }
    return format(atlas, '') + '\n';
  }

  /**
   * Keeps the two downloads of a merged sheet (PNG and JSON) in step, so they
   * always describe the same layout.
   *
   *   setSheet(packed, names) – the sheet to export (a packSprites() result and
   *                             the frame names). Refused (returns false) while
   *                             a PNG export is running.
   *   png(baseName)           – encodes the sheet; resolves to { name, data }.
   *   json(baseName)          – { name, text } for the same sheet. During a PNG
   *                             export it describes the sheet being exported,
   *                             under that export's name.
   *   busy                    – true while a PNG export is running.
   *
   * @param {(image) => Promise<Uint8Array>} encode PNG encoder
   */
  function createExportSession(encode) {
    let sheet = null; // { packed, names, data }
    let job = null; // { baseName, pngName, jsonName, json } for `sheet`
    let running = null; // the PNG export in progress

    function jobFor(baseName) {
      if (running) return job;
      if (!sheet) return null;
      if (!job || job.baseName !== baseName) {
        const pngName = baseName + '.png';
        job = {
          baseName: baseName,
          pngName: pngName,
          jsonName: baseName + '.json',
          json: stringifyAtlas(buildAtlas(sheet.names, sheet.packed.layout, pngName)),
        };
      }
      return job;
    }

    return {
      get busy() {
        return running !== null;
      },

      setSheet: function (packed, names) {
        if (running) return false;
        sheet = packed ? { packed: packed, names: names.slice(), data: null } : null;
        job = null;
        return true;
      },

      png: function (baseName) {
        if (running) return Promise.reject(new Error('An export is already running.'));
        const current = jobFor(baseName);
        if (!current) return Promise.reject(new Error('There is nothing to export.'));
        const target = sheet;
        const task = Promise.resolve()
          .then(function () { return target.data || encode(target.packed.image); })
          .then(function (data) {
            target.data = data; // same layout → reuse the encoded file
            return { name: current.pngName, data: data };
          });
        running = task;
        const finish = function () { if (running === task) running = null; };
        task.then(finish, finish);
        return task;
      },

      json: function (baseName) {
        const current = jobFor(baseName);
        return current ? { name: current.jsonName, text: current.json } : null;
      },
    };
  }

  return {
    APP_NAME: APP_NAME,
    APP_VERSION: APP_VERSION,
    naturalCompare: naturalCompare,
    sortByName: sortByName,
    computeLayout: computeLayout,
    packSprites: packSprites,
    buildAtlas: buildAtlas,
    stringifyAtlas: stringifyAtlas,
    createExportSession: createExportSession,
  };
});
