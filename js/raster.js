/*
 * Pixel Toolbox — raw RGBA image helpers.
 *
 * An image is a plain object: { width, height, data }, where `data` is a
 * Uint8ClampedArray of width * height * 4 bytes (R, G, B, A per pixel,
 * row by row). Every operation here copies pixels exactly: no smoothing,
 * no interpolation, no blending.
 *
 * MIT License. Copyright (c) 2026 YunaWorks.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    (root.PixelToolbox = root.PixelToolbox || {}).raster = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Largest image (in pixels) the tool will create: 8192 × 8192. */
  const MAX_PIXELS = 8192 * 8192;

  function checkSize(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
      throw new RangeError('Invalid image size: ' + width + ' × ' + height + '.');
    }
    if (width * height > MAX_PIXELS) {
      throw new RangeError(
        'The image would be ' + width + ' × ' + height + ' px, which is too large ' +
        '(the limit is ' + MAX_PIXELS.toLocaleString('en-US') + ' pixels).'
      );
    }
  }

  /** Creates a new, fully transparent image (or wraps existing RGBA data). */
  function createImage(width, height, data) {
    checkSize(width, height);
    const size = width * height * 4;
    if (data === undefined) {
      data = new Uint8ClampedArray(size);
    } else {
      if (!(data instanceof Uint8ClampedArray)) {
        data = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
      }
      if (data.length !== size) {
        throw new RangeError('Pixel data has ' + data.length + ' bytes, expected ' + size + '.');
      }
    }
    return { width: width, height: height, data: data };
  }

  /** Intersects a rectangle with the image bounds. Returns null when empty. */
  function clip(image, x, y, width, height) {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(image.width, x + width);
    const y1 = Math.min(image.height, y + height);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  /**
   * Copies a rectangle out of `image` into a new image of exactly
   * width × height. Parts outside the source stay transparent.
   */
  function cropImage(image, x, y, width, height) {
    const out = createImage(width, height);
    const r = clip(image, x, y, width, height);
    if (!r) return out;
    const rowBytes = (r.x1 - r.x0) * 4;
    for (let sy = r.y0; sy < r.y1; sy++) {
      const s = (sy * image.width + r.x0) * 4;
      const d = ((sy - y) * width + (r.x0 - x)) * 4;
      out.data.set(image.data.subarray(s, s + rowBytes), d);
    }
    return out;
  }

  /**
   * Copies every pixel of `src` onto `dst` with its top-left corner at
   * (dx, dy). Pixels are replaced, not blended. Anything that falls
   * outside `dst` is clipped.
   */
  function blitImage(dst, src, dx, dy) {
    const r = clip(dst, dx, dy, src.width, src.height);
    if (!r) return dst;
    const rowBytes = (r.x1 - r.x0) * 4;
    for (let ty = r.y0; ty < r.y1; ty++) {
      const s = ((ty - dy) * src.width + (r.x0 - dx)) * 4;
      const d = (ty * dst.width + r.x0) * 4;
      dst.data.set(src.data.subarray(s, s + rowBytes), d);
    }
    return dst;
  }

  /** True when every pixel in the rectangle has alpha 0. */
  function isRegionTransparent(image, x, y, width, height) {
    const r = clip(image, x, y, width, height);
    if (!r) return true;
    const data = image.data;
    for (let py = r.y0; py < r.y1; py++) {
      const end = (py * image.width + r.x1) * 4;
      for (let i = (py * image.width + r.x0) * 4 + 3; i < end; i += 4) {
        if (data[i] !== 0) return false;
      }
    }
    return true;
  }

  return {
    MAX_PIXELS: MAX_PIXELS,
    checkSize: checkSize,
    createImage: createImage,
    cropImage: cropImage,
    blitImage: blitImage,
    isRegionTransparent: isRegionTransparent,
  };
});
