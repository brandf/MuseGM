#!/usr/bin/env python3
"""Chroma-key cutout for AI dressing tiles (MuseGM).

AI art comes back on a flat magenta background (the generator is asked
for solid #FF00FF). This turns that background transparent so the tile
can sit on the floor as a dressing layer:

- The key colour is sampled from the image corners (the generator's
  magenta is never exactly #FF00FF — it drifts a few units).
- GLOBAL chroma-key, not flood-fill: every pixel near the key goes
  transparent, including magenta showing through gaps in the subject
  (e.g. between the skeleton's ribs) — those gaps should show the floor.
- Soft edge: alpha ramps over a distance band, then a 1px MinFilter on
  the alpha channel pulls the edge in and kills the magenta fringe.
- Output is fitted into a square tile (default 200x200, the dressing
  size) preserving aspect ratio, centred on transparency.

Usage:
    python3 cutout.py <raw.png> <out.png> [--size 200]
"""

import argparse
import math
import os
from PIL import Image, ImageFilter


def _key_color(im):
    """Median of the four corner pixels — the flat background colour."""
    px = im.load()
    w, h = im.size
    pts = [px[3, 3], px[w - 4, 3], px[3, h - 4], px[w - 4, h - 4]]
    chans = [[p[i] for p in pts] for i in range(3)]
    return tuple(sorted(c)[len(c) // 2] for c in chans)


def cutout(im, key=None, inner=40, outer=90):
    """Return an RGBA image with the key-coloured background transparent.
    `inner`/`outer` are RGB-distance thresholds: below inner is fully
    transparent, above outer fully opaque, ramped between."""
    rgb = im.convert("RGB")
    key = key or _key_color(rgb)
    w, h = rgb.size
    src = rgb.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dst = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = src[x, y]
            d = math.sqrt((r - key[0]) ** 2 + (g - key[1]) ** 2 + (b - key[2]) ** 2)
            if d <= inner:
                a = 0
            elif d >= outer:
                a = 255
            else:
                a = int(255 * (d - inner) / (outer - inner))
            dst[x, y] = (r, g, b, a)
    # 1px alpha erosion kills the magenta fringe on the cut edge.
    alpha = out.getchannel("A").filter(ImageFilter.MinFilter(3))
    out.putalpha(alpha)
    return out


def fit_square(im, size=200, pad=4):
    """Crop to the opaque bounding box, scale to fit `size` with `pad`
    px of margin, and centre on a transparent `size` x `size` canvas."""
    bbox = im.getbbox()
    if bbox is None:
        return Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(im.size[0], x1 + pad)
    y1 = min(im.size[1], y1 + pad)
    cropped = im.crop((x0, y0, x1, y1))
    scale = min((size - 2 * pad) / cropped.size[0],
                (size - 2 * pad) / cropped.size[1])
    nw, nh = max(1, int(cropped.size[0] * scale)), max(1, int(cropped.size[1] * scale))
    resized = cropped.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((size - nw) // 2, (size - nh) // 2))
    return canvas


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("raw", help="AI image on a flat magenta background")
    ap.add_argument("out", help="output transparent tile PNG")
    ap.add_argument("--size", type=int, default=200, help="square tile size (default 200)")
    ap.add_argument("--inner", type=int, default=40, help="RGB distance: fully transparent below")
    ap.add_argument("--outer", type=int, default=90, help="RGB distance: fully opaque above")
    args = ap.parse_args()
    im = Image.open(args.raw)
    key = _key_color(im.convert("RGB"))
    cut = cutout(im, key=key, inner=args.inner, outer=args.outer)
    tile = fit_square(cut, size=args.size)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    tile.save(args.out)
    # Report how much of the tile is actually opaque — a sanity check
    # that the subject survived the key (a bad cut leaves almost nothing).
    alpha = tile.getchannel("A")
    hist = alpha.histogram()
    opaque = sum(hist[128:])
    print(f"key={key} size={tile.size} opaque={opaque / (args.size ** 2):.1%} -> {args.out}")


if __name__ == "__main__":
    main()
