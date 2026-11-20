#!/usr/bin/env python3
"""Procedural tile generation for MuseGM.

Code over AI where code wins: fog wisps, floor tiles, walls and doors are
better drawn procedurally — exact, tileable by construction, seamless, and
consistent by definition, with real alpha. AI images are only used where
they earn it (organic dressing: bones, chests, skeletons), cut out in code.

No SVG renderer is assumed on the machine (no rsvg/inkscape/cairosvg);
PIL is the renderer. Usage:

    python3 generate_tiles.py            # writes fog-wisp.png, floor-tile.png
"""

from PIL import Image, ImageDraw, ImageFilter
import random

S = 400


def fog_wisp(seed: int = 7) -> Image.Image:
    """Soft green-grey fog wisp on a transparent background."""
    random.seed(seed)
    fog = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(fog)
    for (cx, cy, rx, ry, a) in [
        (200, 210, 180, 70, 90), (140, 170, 120, 55, 70),
        (270, 250, 130, 60, 80), (200, 130, 150, 45, 55),
        (120, 270, 110, 50, 60), (290, 150, 100, 45, 50),
    ]:
        d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                  fill=(190, 220, 190, a))
    fog = fog.filter(ImageFilter.GaussianBlur(22))
    t = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dt = ImageDraw.Draw(t)
    for (x0, y0, x1, y1, w, a) in [
        (40, 300, 360, 180, 26, 60), (60, 120, 340, 280, 20, 50),
        (180, 40, 220, 360, 18, 45),
    ]:
        dt.line([x0, y0, x1, y1], fill=(200, 225, 200, a), width=w)
    t = t.filter(ImageFilter.GaussianBlur(14))
    return Image.alpha_composite(fog, t)


def floor_tile(seed: int = 7) -> Image.Image:
    """4x4 stone floor tile. Grout runs to the outer edge so tiles butt
    together seamlessly."""
    random.seed(seed)
    fl = Image.new("RGB", (S, S), (96, 100, 104))
    d = ImageDraw.Draw(fl)
    for gy in range(4):
        for gx in range(4):
            v = random.randint(-8, 8)
            d.rectangle([gx * 100 + 2, gy * 100 + 2,
                         (gx + 1) * 100 - 2, (gy + 1) * 100 - 2],
                        fill=(96 + v, 100 + v, 104 + v))
            x0, y0 = (gx * 100 + random.randint(15, 85),
                      gy * 100 + random.randint(15, 85))
            d.line([x0, y0, x0 + random.randint(-25, 25),
                    y0 + random.randint(-25, 25)],
                   fill=(70, 72, 76), width=2)
    for i in range(5):
        d.line([i * 100, 0, i * 100, S], fill=(58, 60, 64), width=4)
        d.line([0, i * 100, S, i * 100], fill=(58, 60, 64), width=4)
    return fl


if __name__ == "__main__":
    fog_wisp().save("fog-wisp.png")
    floor_tile().save("floor-tile.png")
    print("wrote fog-wisp.png, floor-tile.png")
