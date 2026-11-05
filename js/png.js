/*
 * Pixel Toolbox — PNG decoder and encoder.
 *
 * Decoding reads the stored sample values directly, so pixels come out
 * exactly as they were saved: no colour-profile conversion and no
 * premultiplied-alpha rounding. All standard PNG formats are supported
 * (greyscale, RGB, palette, with or without alpha, 1–16 bits, interlaced).
 * 16-bit samples are rounded to 8 bits.
 *
 * Every chunk that affects the pixels (IHDR, PLTE, tRNS, IDAT) is checked
 * against its CRC. A damaged file is refused with a clear message instead of
 * being decoded with silently wrong colours. Other chunks (text, colour
 * profiles…) are not used, so they are skipped without checking.
 *
 * Encoding always writes 8-bit RGBA, non-interlaced.
 *
 * Compression uses the browser's built-in CompressionStream /
 * DecompressionStream (zlib format), so nothing extra is downloaded.
 *
 * MIT License. Copyright (c) 2026 YunaWorks.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./crc32.js'), require('./raster.js'));
  } else {
    const ns = (root.PixelToolbox = root.PixelToolbox || {});
    ns.png = factory(ns.crc32, ns.raster);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (crc32, raster) {
  'use strict';

  const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // [x0, y0, dx, dy] for each Adam7 pass.
  const ADAM7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];

  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const VALID_DEPTHS = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };

  // Chunks whose contents change the decoded pixels.
  const CHECKED_CHUNKS = ['IHDR', 'PLTE', 'tRNS', 'IDAT'];

  /**
   * `damaged` is true when the file itself is broken (checksum mismatch,
   * cut off): such a file must not be decoded "as well as possible".
   */
  class PngError extends Error {
    constructor(message, damaged) {
      super(message);
      this.name = 'PngError';
      this.damaged = !!damaged;
    }
  }

  // ---------------------------------------------------------------------------
  // zlib via the platform's compression streams

  function requireStreams() {
    if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
      throw new PngError(
        'This browser cannot compress or decompress PNG data. ' +
        'Please use a current version of Chrome, Edge, Firefox or Safari.'
      );
    }
  }

  async function pipe(bytes, stream) {
    const output = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(output).arrayBuffer());
  }

  async function inflate(bytes) {
    requireStreams();
    try {
      return await pipe(bytes, new DecompressionStream('deflate'));
    } catch (err) {
      throw new PngError('The PNG image data could not be decompressed.');
    }
  }

  async function deflate(bytes) {
    requireStreams();
    return pipe(bytes, new CompressionStream('deflate'));
  }

  // ---------------------------------------------------------------------------
  // Helpers

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError('Expected PNG bytes as an ArrayBuffer or Uint8Array.');
  }

  function isPng(input) {
    const bytes = toBytes(input);
    if (bytes.length < SIGNATURE.length) return false;
    for (let i = 0; i < SIGNATURE.length; i++) {
      if (bytes[i] !== SIGNATURE[i]) return false;
    }
    return true;
  }

  function readUint32(bytes, pos) {
    return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
  }

  function writeUint32(bytes, pos, value) {
    bytes[pos] = (value >>> 24) & 0xff;
    bytes[pos + 1] = (value >>> 16) & 0xff;
    bytes[pos + 2] = (value >>> 8) & 0xff;
    bytes[pos + 3] = value & 0xff;
  }

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Decoding

  function readChunks(bytes) {
    if (!isPng(bytes)) throw new PngError('This file is not a PNG image.');
    const result = { header: null, palette: null, transparency: null, data: [] };
    let pos = SIGNATURE.length;
    while (pos + 8 <= bytes.length) {
      const length = readUint32(bytes, pos);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      const start = pos + 8;
      const end = start + length;
      const checked = CHECKED_CHUNKS.indexOf(type) >= 0;
      if (end + 4 > bytes.length) {
        if (checked || !result.header) {
          throw new PngError('This PNG file is incomplete (it may not have finished saving or downloading).', true);
        }
        break; // a cut-off chunk that doesn't affect the pixels: ignore it
      }
      if (checked && crc32(bytes, pos + 4, end) !== readUint32(bytes, end)) {
        throw new PngError(
          'This PNG file is damaged: its ' + type + ' data does not match its checksum (CRC), ' +
          'so the pixels can’t be trusted. Please export the image again.',
          true
        );
      }
      const body = bytes.subarray(start, end);
      if (type === 'IHDR') {
        if (length < 13) throw new PngError('This PNG file is damaged: its header is too short.', true);
        result.header = {
          width: readUint32(body, 0),
          height: readUint32(body, 4),
          bitDepth: body[8],
          colorType: body[9],
          compression: body[10],
          filter: body[11],
          interlace: body[12],
        };
      } else if (type === 'PLTE') {
        result.palette = body;
      } else if (type === 'tRNS') {
        result.transparency = body;
      } else if (type === 'IDAT') {
        result.data.push(body);
      } else if (type === 'IEND') {
        break;
      }
      pos = end + 4; // skip CRC
    }
    if (!result.header) throw new PngError('The PNG header is missing.');
    if (result.data.length === 0) throw new PngError('The PNG file contains no image data.');
    return result;
  }

  function validateHeader(h, palette) {
    if (h.width < 1 || h.height < 1) throw new PngError('The PNG image has no pixels.');
    const depths = VALID_DEPTHS[h.colorType];
    if (!depths) throw new PngError('Unsupported PNG colour type ' + h.colorType + '.');
    if (depths.indexOf(h.bitDepth) < 0) {
      throw new PngError('Unsupported PNG bit depth ' + h.bitDepth + ' for colour type ' + h.colorType + '.');
    }
    if (h.compression !== 0 || h.filter !== 0 || (h.interlace !== 0 && h.interlace !== 1)) {
      throw new PngError('Unsupported PNG compression, filter or interlace method.');
    }
    if (h.colorType === 3 && !palette) throw new PngError('The PNG palette is missing.');
    try {
      raster.checkSize(h.width, h.height);
    } catch (err) {
      throw new PngError(err.message);
    }
  }

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  /** Reverses PNG scanline filtering for one pass. */
  function unfilter(raw, offset, rowBytes, rows, bpp) {
    const out = new Uint8Array(rowBytes * rows);
    let src = offset;
    for (let y = 0; y < rows; y++) {
      const type = raw[src++];
      const cur = y * rowBytes;
      const prev = cur - rowBytes;
      switch (type) {
        case 0:
          out.set(raw.subarray(src, src + rowBytes), cur);
          break;
        case 1:
          for (let i = 0; i < rowBytes; i++) {
            out[cur + i] = raw[src + i] + (i >= bpp ? out[cur + i - bpp] : 0);
          }
          break;
        case 2:
          for (let i = 0; i < rowBytes; i++) {
            out[cur + i] = raw[src + i] + (y > 0 ? out[prev + i] : 0);
          }
          break;
        case 3:
          for (let i = 0; i < rowBytes; i++) {
            const left = i >= bpp ? out[cur + i - bpp] : 0;
            const up = y > 0 ? out[prev + i] : 0;
            out[cur + i] = raw[src + i] + ((left + up) >> 1);
          }
          break;
        case 4:
          for (let i = 0; i < rowBytes; i++) {
            const left = i >= bpp ? out[cur + i - bpp] : 0;
            const up = y > 0 ? out[prev + i] : 0;
            const upLeft = i >= bpp && y > 0 ? out[prev + i - bpp] : 0;
            out[cur + i] = raw[src + i] + paeth(left, up, upLeft);
          }
          break;
        default:
          throw new PngError('The PNG image data is damaged (unknown filter ' + type + ').');
      }
      src += rowBytes;
    }
    return out;
  }

  /** Reads sample number `index` from a scanline starting at `rowStart`. */
  function sample(rows, rowStart, index, bitDepth) {
    if (bitDepth === 8) return rows[rowStart + index];
    if (bitDepth === 16) return (rows[rowStart + index * 2] << 8) | rows[rowStart + index * 2 + 1];
    const bit = index * bitDepth;
    return (rows[rowStart + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
  }

  function to8Bit(value, bitDepth) {
    if (bitDepth === 8) return value;
    if (bitDepth === 16) return ((value + 128) / 257) | 0;
    return Math.round((value * 255) / ((1 << bitDepth) - 1));
  }

  /** Converts one unfiltered pass to RGBA and writes it into `out`. */
  function writePass(out, width, rows, rowBytes, passWidth, passHeight, pass, info) {
    const x0 = pass[0];
    const y0 = pass[1];
    const dx = pass[2];
    const dy = pass[3];
    const depth = info.bitDepth;
    const trns = info.transparency;
    for (let py = 0; py < passHeight; py++) {
      const rowStart = py * rowBytes;
      const y = y0 + py * dy;
      for (let px = 0; px < passWidth; px++) {
        const o = ((y * width) + x0 + px * dx) * 4;
        let r, g, b, a;
        switch (info.colorType) {
          case 0: {
            const v = sample(rows, rowStart, px, depth);
            r = g = b = to8Bit(v, depth);
            a = trns && trns.length >= 2 && v === ((trns[0] << 8) | trns[1]) ? 0 : 255;
            break;
          }
          case 2: {
            const vr = sample(rows, rowStart, px * 3, depth);
            const vg = sample(rows, rowStart, px * 3 + 1, depth);
            const vb = sample(rows, rowStart, px * 3 + 2, depth);
            r = to8Bit(vr, depth);
            g = to8Bit(vg, depth);
            b = to8Bit(vb, depth);
            a = trns && trns.length >= 6 &&
              vr === ((trns[0] << 8) | trns[1]) &&
              vg === ((trns[2] << 8) | trns[3]) &&
              vb === ((trns[4] << 8) | trns[5]) ? 0 : 255;
            break;
          }
          case 3: {
            const index = sample(rows, rowStart, px, depth);
            const p = index * 3;
            if (p + 2 < info.palette.length) {
              r = info.palette[p];
              g = info.palette[p + 1];
              b = info.palette[p + 2];
            } else {
              r = g = b = 0;
            }
            a = trns && index < trns.length ? trns[index] : 255;
            break;
          }
          case 4: {
            r = g = b = to8Bit(sample(rows, rowStart, px * 2, depth), depth);
            a = to8Bit(sample(rows, rowStart, px * 2 + 1, depth), depth);
            break;
          }
          default: {
            r = to8Bit(sample(rows, rowStart, px * 4, depth), depth);
            g = to8Bit(sample(rows, rowStart, px * 4 + 1, depth), depth);
            b = to8Bit(sample(rows, rowStart, px * 4 + 2, depth), depth);
            a = to8Bit(sample(rows, rowStart, px * 4 + 3, depth), depth);
          }
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a;
      }
    }
  }

  /** Reads width and height from PNG bytes without decoding the pixels. */
  function readSize(input) {
    const header = readChunks(toBytes(input)).header;
    return { width: header.width, height: header.height };
  }

  /**
   * Decodes PNG bytes into an RGBA image { width, height, data }.
   * Throws a PngError with a readable message if the file can't be used.
   */
  async function decodePng(input) {
    const bytes = toBytes(input);
    const chunks = readChunks(bytes);
    const h = chunks.header;
    validateHeader(h, chunks.palette);

    const raw = await inflate(chunks.data.length === 1 ? chunks.data[0] : concat(chunks.data));
    const bitsPerPixel = CHANNELS[h.colorType] * h.bitDepth;
    const bpp = Math.max(1, bitsPerPixel >> 3);
    const image = raster.createImage(h.width, h.height);
    const info = {
      colorType: h.colorType,
      bitDepth: h.bitDepth,
      palette: chunks.palette,
      transparency: chunks.transparency,
    };

    const passes = h.interlace === 1 ? ADAM7 : [[0, 0, 1, 1]];
    let offset = 0;
    for (const pass of passes) {
      const passWidth = h.width > pass[0] ? Math.ceil((h.width - pass[0]) / pass[2]) : 0;
      const passHeight = h.height > pass[1] ? Math.ceil((h.height - pass[1]) / pass[3]) : 0;
      if (passWidth === 0 || passHeight === 0) continue;
      const rowBytes = (passWidth * bitsPerPixel + 7) >> 3;
      const needed = (rowBytes + 1) * passHeight;
      if (offset + needed > raw.length) {
        throw new PngError('This PNG file is damaged: it contains less image data than its size needs.', true);
      }
      const rows = unfilter(raw, offset, rowBytes, passHeight, bpp);
      offset += needed;
      writePass(image.data, h.width, rows, rowBytes, passWidth, passHeight, pass, info);
    }
    return image;
  }

  // ---------------------------------------------------------------------------
  // Encoding

  function makeChunk(type, body) {
    const out = new Uint8Array(12 + body.length);
    writeUint32(out, 0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    writeUint32(out, 8 + body.length, crc32(out, 4, 8 + body.length));
    return out;
  }

  /** Applies the PNG filter that compresses each row best (libpng's heuristic). */
  function filterRows(data, width, height) {
    const rowBytes = width * 4;
    const out = new Uint8Array((rowBytes + 1) * height);
    const candidate = new Uint8Array(rowBytes);
    const best = new Uint8Array(rowBytes);
    for (let y = 0; y < height; y++) {
      const cur = y * rowBytes;
      const prev = cur - rowBytes;
      let bestType = 0;
      let bestScore = Infinity;
      for (let type = 0; type < 5; type++) {
        let score = 0;
        for (let i = 0; i < rowBytes; i++) {
          const x = data[cur + i];
          const left = i >= 4 ? data[cur + i - 4] : 0;
          const up = y > 0 ? data[prev + i] : 0;
          const upLeft = i >= 4 && y > 0 ? data[prev + i - 4] : 0;
          let v;
          switch (type) {
            case 0: v = x; break;
            case 1: v = x - left; break;
            case 2: v = x - up; break;
            case 3: v = x - ((left + up) >> 1); break;
            default: v = x - paeth(left, up, upLeft);
          }
          v &= 0xff;
          candidate[i] = v;
          score += v < 128 ? v : 256 - v;
          if (score >= bestScore) break;
        }
        if (score < bestScore) {
          bestScore = score;
          bestType = type;
          best.set(candidate);
        }
      }
      const o = y * (rowBytes + 1);
      out[o] = bestType;
      out.set(best, o + 1);
    }
    return out;
  }

  /** Encodes an RGBA image { width, height, data } as PNG bytes (Uint8Array). */
  async function encodePng(image) {
    const width = image.width;
    const height = image.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError('A PNG image must be at least 1 × 1 pixel.');
    }
    if (!image.data || image.data.length !== width * height * 4) {
      throw new RangeError('Pixel data does not match the image size.');
    }
    const header = new Uint8Array(13);
    writeUint32(header, 0, width);
    writeUint32(header, 4, height);
    header[8] = 8; // bit depth
    header[9] = 6; // RGBA
    header[10] = 0; // deflate
    header[11] = 0; // adaptive filtering
    header[12] = 0; // not interlaced
    const compressed = await deflate(filterRows(image.data, width, height));
    return concat([
      SIGNATURE,
      makeChunk('IHDR', header),
      makeChunk('IDAT', compressed),
      makeChunk('IEND', new Uint8Array(0)),
    ]);
  }

  return {
    PngError: PngError,
    isPng: isPng,
    readSize: readSize,
    decodePng: decodePng,
    encodePng: encodePng,
  };
});
