/*
 * Pixel Toolbox — minimal ZIP writer.
 *
 * Files are stored without extra compression ("stored" method). The PNG
 * files that go into the archive are already compressed, so deflating them
 * again would barely change the size. File names are written as UTF-8.
 *
 * MIT License. Copyright (c) 2026 YunaWorks.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./crc32.js'));
  } else {
    const ns = (root.PixelToolbox = root.PixelToolbox || {});
    ns.zip = factory(ns.crc32);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (crc32) {
  'use strict';

  const MAX_ENTRIES = 0xffff;
  const MAX_SIZE = 0xffffffff;
  const UTF8_FLAG = 0x0800;

  /** Converts a Date to MS-DOS time and date fields (local time). */
  function dosDateTime(date) {
    let year = date.getFullYear();
    if (year < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01 00:00
    if (year > 2107) year = 2107;
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  /**
   * Builds a ZIP archive.
   * @param {{name: string, data: Uint8Array}[]} entries
   * @param {{date?: Date}} [options] modification time written for every file
   * @returns {Uint8Array}
   */
  function createZip(entries, options) {
    const when = dosDateTime((options && options.date) || new Date());
    if (entries.length > MAX_ENTRIES) {
      throw new RangeError('A ZIP file can hold at most ' + MAX_ENTRIES + ' files.');
    }
    const encoder = new TextEncoder();
    const items = entries.map(function (entry) {
      if (!entry.name) throw new TypeError('Every ZIP entry needs a file name.');
      const name = encoder.encode(entry.name);
      const data = entry.data;
      return { name: name, data: data, crc: crc32(data) };
    });

    let localSize = 0;
    let centralSize = 0;
    for (const item of items) {
      localSize += 30 + item.name.length + item.data.length;
      centralSize += 46 + item.name.length;
    }
    if (localSize + centralSize + 22 > MAX_SIZE) {
      throw new RangeError('The ZIP file would be larger than 4 GB.');
    }

    const out = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(out.buffer);
    let pos = 0;
    const offsets = [];

    for (const item of items) {
      offsets.push(pos);
      view.setUint32(pos, 0x04034b50, true); // local file header
      view.setUint16(pos + 4, 10, true); // version needed (1.0)
      view.setUint16(pos + 6, UTF8_FLAG, true);
      view.setUint16(pos + 8, 0, true); // method: stored
      view.setUint16(pos + 10, when.time, true);
      view.setUint16(pos + 12, when.date, true);
      view.setUint32(pos + 14, item.crc, true);
      view.setUint32(pos + 18, item.data.length, true); // compressed size
      view.setUint32(pos + 22, item.data.length, true); // uncompressed size
      view.setUint16(pos + 26, item.name.length, true);
      view.setUint16(pos + 28, 0, true); // extra field length
      out.set(item.name, pos + 30);
      out.set(item.data, pos + 30 + item.name.length);
      pos += 30 + item.name.length + item.data.length;
    }

    const centralStart = pos;
    items.forEach(function (item, i) {
      view.setUint32(pos, 0x02014b50, true); // central directory header
      view.setUint16(pos + 4, 20, true); // version made by
      view.setUint16(pos + 6, 10, true); // version needed
      view.setUint16(pos + 8, UTF8_FLAG, true);
      view.setUint16(pos + 10, 0, true); // method: stored
      view.setUint16(pos + 12, when.time, true);
      view.setUint16(pos + 14, when.date, true);
      view.setUint32(pos + 16, item.crc, true);
      view.setUint32(pos + 20, item.data.length, true);
      view.setUint32(pos + 24, item.data.length, true);
      view.setUint16(pos + 28, item.name.length, true);
      view.setUint16(pos + 30, 0, true); // extra field length
      view.setUint16(pos + 32, 0, true); // comment length
      view.setUint16(pos + 34, 0, true); // disk number
      view.setUint16(pos + 36, 0, true); // internal attributes
      view.setUint32(pos + 38, 0, true); // external attributes
      view.setUint32(pos + 42, offsets[i], true);
      out.set(item.name, pos + 46);
      pos += 46 + item.name.length;
    });

    view.setUint32(pos, 0x06054b50, true); // end of central directory
    view.setUint16(pos + 4, 0, true);
    view.setUint16(pos + 6, 0, true);
    view.setUint16(pos + 8, items.length, true);
    view.setUint16(pos + 10, items.length, true);
    view.setUint32(pos + 12, pos - centralStart, true);
    view.setUint32(pos + 16, centralStart, true);
    view.setUint16(pos + 20, 0, true); // comment length
    return out;
  }

  return { createZip: createZip };
});
