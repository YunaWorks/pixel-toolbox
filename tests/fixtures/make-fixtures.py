#!/usr/bin/env python3
"""
Regenerates the PNG decoder test fixtures in this folder.

The fixtures are made by independent PNG encoders (Pillow and ImageMagick)
so the decoder in js/png.js is tested against files it did not write.
Each image is generated from a known pixel model; the expected RGBA pixels
are written to expected.json and also checked by reading every file back
with Pillow.

Requirements (only needed to regenerate, not to run the tests):
  Python 3, Pillow, ImageMagick ("convert").

Usage:  python3 tests/fixtures/make-fixtures.py
"""
import base64
import json
import os
import random
import subprocess
import tempfile
import zlib

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 13, 7  # odd sizes exercise sub-byte rows and partial Adam7 passes

expected = {}


def rgba_model(x, y):
    alphas = [0, 255, 128, 1, 254, 64]
    return (
        (x * 19 + y * 7) % 256,
        (x * 5 + y * 41) % 256,
        ((x * x + y * 3) * 11) % 256,
        alphas[(x + y) % 6],
    )


def gray_level(x, y, bits):
    top = (1 << bits) - 1
    return (x + y * 3) % (top + 1)


def scale(v, bits):
    return round(v * 255 / ((1 << bits) - 1))


def ihdr(path):
    with open(path, 'rb') as f:
        data = f.read(33)
    return {'bitDepth': data[24], 'colorType': data[25], 'interlace': data[28]}


def count_idat(path):
    with open(path, 'rb') as f:
        data = f.read()
    pos, n = 8, 0
    while pos + 8 <= len(data):
        length = int.from_bytes(data[pos:pos + 4], 'big')
        if data[pos + 4:pos + 8] == b'IDAT':
            n += 1
        pos += 12 + length
    return n


def flat(im):
    return list(im.get_flattened_data()) if hasattr(im, 'get_flattened_data') else list(im.getdata())


def record(name, pixels, width=W, height=H, color_type=None, bit_depth=None, interlace=0, pillow_mode='RGBA'):
    path = os.path.join(HERE, name)
    header = ihdr(path)
    assert header['colorType'] == color_type, (name, header)
    assert header['bitDepth'] == bit_depth, (name, header)
    assert header['interlace'] == interlace, (name, header)
    # Cross-check with Pillow.
    with Image.open(path) as im:
        if pillow_mode == 'I;16':
            # Pillow can't convert 16-bit greyscale to RGBA; compare the raw samples instead.
            back = [(v // 257,) * 3 + (255,) for v in flat(im)]
        else:
            back = flat(im.convert('RGBA'))
    assert len(back) == len(pixels), name
    for i, (want, got) in enumerate(zip(pixels, back)):
        if want[3] == 0 and got[3] == 0:
            continue  # colour of fully transparent pixels is irrelevant to Pillow's check
        assert tuple(want) == tuple(got), (name, i, want, got)
    raw = bytes(c for p in pixels for c in p)
    expected[name] = {'width': width, 'height': height, 'rgba': base64.b64encode(raw).decode('ascii')}


def split_idat(src, dst, size):
    """Rewrites a PNG so its compressed data is spread over IDAT chunks of `size` bytes."""
    with open(src, 'rb') as f:
        data = f.read()
    pos, before, idat, after = 8, [], b'', []
    while pos + 8 <= len(data):
        length = int.from_bytes(data[pos:pos + 4], 'big')
        kind = data[pos + 4:pos + 8]
        chunk = data[pos:pos + 12 + length]
        if kind == b'IDAT':
            idat += data[pos + 8:pos + 8 + length]
        elif idat:
            after.append(chunk)
        else:
            before.append(chunk)
        pos += 12 + length

    def make(kind, body):
        return len(body).to_bytes(4, 'big') + kind + body + zlib.crc32(kind + body).to_bytes(4, 'big')

    parts = [make(b'IDAT', idat[i:i + size]) for i in range(0, len(idat), size)]
    with open(dst, 'wb') as f:
        f.write(data[:8] + b''.join(before) + b''.join(parts) + b''.join(after))


def magick(src, dst, *args):
    no_dates = ['+set', 'date:create', '+set', 'date:modify', '+set', 'date:timestamp', '-define', 'png:exclude-chunk=date,time']
    subprocess.run(['convert', src, *args, *no_dates, dst], check=True)


def main():
    tmp = tempfile.mkdtemp()

    # --- RGBA ----------------------------------------------------------------
    rgba = [rgba_model(x, y) for y in range(H) for x in range(W)]
    im = Image.new('RGBA', (W, H))
    im.putdata(rgba)
    im.save(os.path.join(HERE, 'rgba8.png'))
    record('rgba8.png', rgba, color_type=6, bit_depth=8)

    src16 = os.path.join(tmp, 'rgba.png')
    im.save(src16)
    magick(src16, os.path.join(HERE, 'rgba16.png'), '-depth', '16', '-define', 'png:color-type=6', '-define', 'png:bit-depth=16')
    record('rgba16.png', rgba, color_type=6, bit_depth=16)

    magick(src16, os.path.join(HERE, 'rgba8-interlaced.png'), '-interlace', 'PNG', '-define', 'png:color-type=6', '-define', 'png:bit-depth=8')
    record('rgba8-interlaced.png', rgba, color_type=6, bit_depth=8, interlace=1)

    # --- RGB -----------------------------------------------------------------
    rgb = [(r, g, b, 255) for (r, g, b, _) in rgba]
    im = Image.new('RGB', (W, H))
    im.putdata([p[:3] for p in rgb])
    im.save(os.path.join(HERE, 'rgb8.png'))
    record('rgb8.png', rgb, color_type=2, bit_depth=8)

    src = os.path.join(tmp, 'rgb.png')
    im.save(src)
    magick(src, os.path.join(HERE, 'rgb16-interlaced.png'), '-depth', '16', '-interlace', 'PNG',
           '-define', 'png:color-type=2', '-define', 'png:bit-depth=16')
    record('rgb16-interlaced.png', rgb, color_type=2, bit_depth=16, interlace=1)

    # RGB with a tRNS colour key: pixels equal to the key become transparent.
    key = rgb[5][:3]
    keyed = [(r, g, b, 0 if (r, g, b) == key else 255) for (r, g, b, _) in rgb]
    im.save(os.path.join(HERE, 'rgb8-trns.png'), transparency=key)
    record('rgb8-trns.png', keyed, color_type=2, bit_depth=8)

    # --- Greyscale -----------------------------------------------------------
    for bits in (1, 2, 4):
        levels = [gray_level(x, y, bits) for y in range(H) for x in range(W)]
        pixels = [(scale(v, bits),) * 3 + (255,) for v in levels]
        im = Image.new('L', (W, H))
        im.putdata([p[0] for p in pixels])
        src = os.path.join(tmp, 'g%d.png' % bits)
        im.save(src)
        name = 'gray%d.png' % bits
        # ImageMagick picks the bit depth from -depth for greyscale images.
        magick(src, os.path.join(HERE, name), '-colorspace', 'Gray', '-depth', str(bits))
        record(name, pixels, color_type=0, bit_depth=bits)
        if bits == 1:
            magick(src, os.path.join(HERE, 'gray1-interlaced.png'), '-type', 'Bilevel', '-interlace', 'PNG')
            record('gray1-interlaced.png', pixels, color_type=0, bit_depth=1, interlace=1)

    g8 = [((x * 23 + y * 31) % 256) for y in range(H) for x in range(W)]
    im = Image.new('L', (W, H))
    im.putdata(g8)
    gkey = g8[3]
    im.save(os.path.join(HERE, 'gray8-trns.png'), transparency=gkey)
    record('gray8-trns.png', [(v, v, v, 0 if v == gkey else 255) for v in g8], color_type=0, bit_depth=8)

    im16 = Image.new('I;16', (W, H))
    im16.putdata([v * 257 for v in g8])
    im16.save(os.path.join(HERE, 'gray16.png'))
    record('gray16.png', [(v, v, v, 255) for v in g8], color_type=0, bit_depth=16, pillow_mode='I;16')

    # --- Greyscale + alpha ---------------------------------------------------
    ga = [(v, rgba[i][3]) for i, v in enumerate(g8)]
    im = Image.new('LA', (W, H))
    im.putdata(ga)
    im.save(os.path.join(HERE, 'graya8.png'))
    gapix = [(v, v, v, a) for (v, a) in ga]
    record('graya8.png', gapix, color_type=4, bit_depth=8)

    src = os.path.join(tmp, 'ga.png')
    im.save(src)
    magick(src, os.path.join(HERE, 'graya16.png'), '-depth', '16', '-define', 'png:color-type=4', '-define', 'png:bit-depth=16')
    record('graya16.png', gapix, color_type=4, bit_depth=16)

    # --- Palette -------------------------------------------------------------
    for bits, interlaced in ((1, False), (2, False), (4, False), (8, False), (4, True)):
        count = 1 << bits
        palette = [((i * 67) % 256, (i * 151 + 30) % 256, (i * 29 + 200) % 256) for i in range(count)]
        alpha = [0 if i == 0 else (255 if i % 3 else 100) for i in range(count)]
        # Only some entries get a tRNS value; the rest stay opaque.
        trns = bytes(alpha[:max(1, count // 2)])
        indices = [(x * 3 + y) % count for y in range(H) for x in range(W)]
        pixels = []
        for idx in indices:
            a = trns[idx] if idx < len(trns) else 255
            pixels.append(palette[idx] + (a,))
        im = Image.new('P', (W, H))
        im.putpalette([c for rgb_ in palette for c in rgb_])
        im.putdata(indices)
        if interlaced:
            # Pillow can't write interlaced files: re-encode with ImageMagick,
            # which stores this palette image with 8-bit indices.
            name = 'palette-interlaced.png'
            src = os.path.join(tmp, 'p.png')
            im.save(src, bits=bits, transparency=trns)
            magick(src, os.path.join(HERE, name), '-interlace', 'PNG')
            record(name, pixels, color_type=3, bit_depth=8, interlace=1)
        else:
            name = 'palette%d.png' % bits
            im.save(os.path.join(HERE, name), bits=bits, transparency=trns)
            record(name, pixels, color_type=3, bit_depth=bits)

    # --- Several IDAT chunks -------------------------------------------------
    rnd = random.Random(7)
    big_w, big_h = 32, 24
    noise = [(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256), rnd.choice([0, 255, rnd.randrange(256)]))
             for _ in range(big_w * big_h)]
    # Pillow drops the colour of fully transparent pixels in convert(); keep them black so the check is exact.
    noise = [(0, 0, 0, 0) if p[3] == 0 else p for p in noise]
    im = Image.new('RGBA', (big_w, big_h))
    im.putdata(noise)
    src = os.path.join(tmp, 'noise.png')
    im.save(src)
    split_idat(src, os.path.join(HERE, 'rgba8-multi-idat.png'), 500)
    assert count_idat(os.path.join(HERE, 'rgba8-multi-idat.png')) > 2
    record('rgba8-multi-idat.png', noise, width=big_w, height=big_h, color_type=6, bit_depth=8)

    with open(os.path.join(HERE, 'expected.json'), 'w') as f:
        json.dump(expected, f, indent=1, sort_keys=True)
        f.write('\n')
    print('wrote %d fixtures' % len(expected))


if __name__ == '__main__':
    main()
