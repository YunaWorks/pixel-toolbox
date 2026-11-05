/*
 * Pixel Toolbox — CRC-32 (the checksum used by both PNG and ZIP).
 * MIT License. Copyright (c) 2026 YunaWorks.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    (root.PixelToolbox = root.PixelToolbox || {}).crc32 = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    TABLE[n] = c >>> 0;
  }

  /**
   * Computes the CRC-32 of `bytes[start, end)`.
   * Pass a previous result as `crc` to continue a running checksum.
   */
  function crc32(bytes, start, end, crc) {
    const from = start === undefined ? 0 : start;
    const to = end === undefined ? bytes.length : end;
    let c = crc === undefined ? 0xffffffff : (crc ^ 0xffffffff) >>> 0;
    for (let i = from; i < to; i++) {
      c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  return crc32;
});
