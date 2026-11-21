#!/usr/bin/env python3
"""Procedural tile pack generation for MuseGM — the Lich's Lair look.

The reference is maps/lichs-lair-entry-hall.png: top-down floor, but the
WALLS have visible height — you see the wall's inner face (stone block
courses, shaded, with depth), Zelda-1 style. The floor is varied pavers
with moss in the cracks; the grid is subtle; dressing sits IN the world
(broken columns, skeletons, fog pools, sconces on the wall faces, a big
iron-bound double door). The old "strict top-down, no perspective"
rule is gone: the floor stays top-down, the walls get height.

Pack structure — three kinds (the manifest carries a `kind` per entry):
  (1) base tiles — clean material only: floor (stone texture: grain,
      wear, mottling, cracks IN the stone, moss in the cracks), wall
      faces (masonry, no sconces or torches baked in), fog/dust.
      Nothing that is an object is baked into a base tile.
  (2) macro pieces — multi-square assemblies (2x2, 3x3), bounding box
      grid-aligned, free-form inside (a circular dais, a round pool,
      a curved wall section, a fallen column). Dressing layer, square
      sizes only (the composer places tiles by sizePx, square).
  (3) prop sprites — independent dressing images, placeable at any
      grid cell (bones, chests, altars, rubble piles, bookshelves,
      treasure, broken columns, skeletons, sconces). Off-grid (pixel)
      placement is a composer gap, not a pack gap — see the report.

Code over AI where code wins: floors, walls, fog and most dressing are
drawn procedurally — exact, tileable by construction, seamless, and
consistent by definition, with real alpha. AI images are used where
they earn it: (a) texture detail references — a stone texture, a
sandstone texture and a wood-plank texture, sampled as high-pass
detail and blended in code at low alpha (never a raw AI tile: seams +
transparency); (b) organic dressing that code cannot draw well (full
skeleton, chest, open chest, partial skeleton) — generated on
flat magenta, cut out by cutout.py, copied in by build_pack(). The
altar was first tried as an AI cutout too, but the generated image
was a flat blue slab, not a stone altar — so the altar is procedural
now and the blue cutout in ai-source/ is retired, not used.

Tile unit: 100px = 1 grid square (Foundry grid size 100). Floors and
walls are 100x100 full squares; dressing is 100x100 or 200x200;
macro pieces are 200x200 or 300x300; fog is 200x200 or 400x400.

No SVG renderer is assumed on the machine (no rsvg/inkscape/cairosvg);
PIL + numpy is the renderer. Usage:

    python3 generate_tiles.py            # writes tiles/pack/*.png + tiles/manifest.json
    python3 generate_tiles.py --preview  # also renders the three previews

Style: cold blue-grey stone, warm amber torch pools, bone off-white,
green eerie fog, muted, desaturated, torchlit — the palette stays;
the rendering quality is what changed.
"""

from PIL import Image, ImageDraw, ImageFilter
import argparse
import json
import math
import os
import random
import time
from pathlib import Path

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TILES_DIR = os.path.dirname(HERE)
PACK_DIR = os.path.join(TILES_DIR, "pack")
AI_DIR = os.path.join(TILES_DIR, "ai-source")
AI_SOURCE = Path(AI_DIR)  # pathlib form, for the AI-cutout prop loaders
TILES_DIR = Path(TILES_DIR)  # pathlib form from here on (manifest, previews)
PACK_DIR = Path(PACK_DIR)

# Palette (STYLE.md — unchanged)
FLOOR = (96, 100, 104)
FLOOR_DARK = (62, 66, 74)
GROUT = (58, 60, 64)
GROUT_DARK = (40, 42, 48)
CRACK = (70, 72, 76)
WALL_STONE = (88, 92, 100)
MORTAR = (52, 55, 62)
WALL_SHADOW = (30, 32, 38)
BONE = (232, 226, 208)
BONE_OUTLINE = (106, 101, 88)
AMBER = (255, 154, 60)
FOG = (190, 220, 190)
CHARCOAL = (26, 28, 32)
MOSS = (86, 110, 62)
MOSS_DARK = (58, 80, 44)

# Western palette (FR-2): sun-baked sandstone, wood planks, warm dust.
SAND = (196, 168, 124)
SAND_DARK = (148, 122, 86)
GROUT_SAND = (138, 112, 78)
GROUT_SAND_DARK = (104, 82, 56)
CRACK_SAND = (118, 94, 62)
DUST = (214, 190, 150)
WOOD = (122, 90, 58)
WOOD_DARK = (88, 64, 40)
WOOD_GRAIN = (100, 74, 48)
WOOD_SHADOW = (30, 22, 14)
SAND_MOSS = (120, 118, 70)

# AI texture references (tiles/ai-source/) — sampled as high-pass
# detail in code, never pasted raw. The sandstone file is a 400x400
# crop of the generated texture's clean top-left corner (the full
# frame carries a faint stock watermark across its middle).
STONE_TEX = "media-generation-stone-texture-0-607f2c20-d73a-4d41-b3e4-29fac44d5cd3.png"
SAND_TEX = "sandstone-detail.png"
WOOD_TEX = "media-generation-wood-planks-texture-0-805715db-a847-4e88-b41a-0abbba591ae9.png"

# Wall geometry (the Zelda height): a 100x100 wall tile is a wall TOP
# (big blocks seen from above) over a wall FACE (receding courses,
# shaded toward the floor). The face lives inside the tile, so the
# composer places it with no changes — rotation still maps each side
# to its outer edge.
TOP_H = 38
FACE_H = 100 - TOP_H

# Floor palettes, by theme. `floor_tile` takes `pal` — the default is the
# dungeon palette.
DUNGEON_FLOOR_PAL = {
    "base": FLOOR, "dark": FLOOR_DARK, "grout": GROUT,
    "grout_dark": GROUT_DARK, "crack": CRACK, "speckle_dark": (30, 34, 40),
    "moss": MOSS, "moss_dark": MOSS_DARK,
}
WESTERN_FLOOR_PAL = {
    "base": SAND, "dark": SAND_DARK, "grout": GROUT_SAND,
    "grout_dark": GROUT_SAND_DARK, "crack": CRACK_SAND,
    "speckle_dark": (96, 76, 52),
    "moss": SAND_MOSS, "moss_dark": (90, 88, 52),
}


def _shade(rgb, dv):
    return tuple(max(0, min(255, c + dv)) for c in rgb)


# ---------------------------------------------------------------- noise + AI detail

def _value_noise(size, seed, cells=4, octaves=2):
    """Tileable value noise in [0, 1]: a random grid wrapped at the
    edges, bilinearly upsampled — opposite edges match by construction,
    so a tile mottled with this never shows a seam."""
    rng = np.random.default_rng(seed)
    base = np.zeros((size, size), dtype=np.float64)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        n = cells * (2 ** o)
        grid = rng.random((n + 1, n + 1))
        grid[-1, :] = grid[0, :]
        grid[:, -1] = grid[:, 0]
        xs = np.linspace(0, n, size, endpoint=False)
        ys = np.linspace(0, n, size, endpoint=False)
        x0 = xs.astype(int)
        y0 = ys.astype(int)
        fx = xs - x0
        fy = ys - y0
        v = (grid[y0[:, None], x0[None, :]] * (1 - fx[None, :]) * (1 - fy[:, None])
             + grid[y0[:, None], x0[None, :] + 1] * fx[None, :] * (1 - fy[:, None])
             + grid[y0[:, None] + 1, x0[None, :]] * (1 - fx[None, :]) * fy[:, None]
             + grid[y0[:, None] + 1, x0[None, :] + 1] * fx[None, :] * fy[:, None])
        base += amp * v
        total += amp
        amp *= 0.5
    return base / total


def _mottle(img, noise, strength):
    """Multiply an image's RGB by (1 + strength * (noise - 0.5) * 2).
    Works on RGB and RGBA (alpha untouched)."""
    arr = np.asarray(img).astype(np.float32)
    mult = 1.0 + strength * (noise - 0.5) * 2.0
    if arr.shape[-1] == 4:
        arr[..., :3] *= mult[..., None]
    else:
        arr *= mult[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), img.mode)


_detail_cache = {}


def _ai_detail(path, size=100):
    """High-pass detail from an AI texture reference, made tileable:
    the texture is reduced to its fine grain (image minus its blur —
    large-scale joints and seams drop out), then opposite edges are
    feathered together by the offset-blend trick, so the detail wraps
    seamlessly. Returned in [-1, 1]; blend at low alpha only.
    `path` is relative to tiles/ai-source/."""
    key = (path, size)
    if key in _detail_cache:
        return _detail_cache[key]
    im = Image.open(os.path.join(AI_DIR, path)).convert("L")
    im = im.resize((size, size), Image.LANCZOS)
    arr = np.asarray(im).astype(np.float32)
    blur = np.asarray(im.filter(ImageFilter.GaussianBlur(3))).astype(np.float32)
    detail = np.clip((arr - blur) / 48.0, -1.0, 1.0)
    # Offset-blend: w is 0 at the edges, 1 in the middle; the rolled
    # copy supplies the edge values, and rolled edges are neighbours
    # in the source, so the wrap is smooth.
    rolled = np.roll(np.roll(detail, size // 2, axis=0), size // 2, axis=1)
    ramp = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(size) / size)
    w = ramp[:, None] * ramp[None, :]
    detail = detail * w + rolled * (1.0 - w)
    _detail_cache[key] = detail
    return detail


def _detail_for(path, size, seed):
    """The AI detail for one tile: rotated/flipped by seed (rotations
    and flips of a tileable array stay tileable), so neighbouring tiles
    never repeat the same grain."""
    detail = _ai_detail(path, size)
    rnd = random.Random(seed)
    detail = np.rot90(detail, rnd.randint(0, 3))
    if rnd.random() < 0.5:
        detail = np.fliplr(detail)
    if rnd.random() < 0.5:
        detail = np.flipud(detail)
    return detail


def _blend_detail(img, detail, alpha):
    """Blend a [-1, 1] detail layer into an image at strength alpha
    (0.12-0.18: the grain reads, the source texture never shows)."""
    arr = np.asarray(img).astype(np.float32)
    mult = 1.0 + alpha * detail
    if arr.shape[-1] == 4:
        arr[..., :3] *= mult[..., None]
    else:
        arr *= mult[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), img.mode)


def _vignette(img, strength=0.05):
    """A very subtle per-tile vignette: corners a touch darker, so
    each stone reads as slightly dished. Kept at 5% — stronger would
    print a dark grid across the room."""
    w, h = img.size
    y, x = np.mgrid[0:h, 0:w]
    r = np.sqrt(((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2)
    mask = np.clip((r - 0.6) / 0.8, 0, 1)
    arr = np.asarray(img).astype(np.float32)
    arr *= (1.0 - strength * mask[..., None])
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), img.mode)


def _vertical_shade(img, top, bottom):
    """Multiply an image by a vertical gradient: `top` at y=0, `bottom`
    at y=height. The wall face's falloff — light at the top, dark at
    the base where it meets the floor."""
    w, h = img.size
    grad = np.linspace(top, bottom, h)[:, None]
    arr = np.asarray(img).astype(np.float32)
    if arr.shape[-1] == 4:
        arr[..., :3] *= grad[..., None]
    else:
        arr *= grad[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), img.mode)


def _contact_shadow(img, cx, cy, rx, ry, alpha=70, blur=6, dy=4):
    """A soft dark ellipse under a prop, offset slightly down — the
    thing that makes dressing sit IN the world instead of floating on
    it. Composite the shadow first, draw the prop on top."""
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(sh)
    d.ellipse([cx - rx, cy - ry + dy, cx + rx, cy + ry + dy],
              fill=(0, 0, 0, alpha))
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(img, sh)


def _speckle(d, size, n, color, seed):
    rnd = random.Random(seed)
    for _ in range(n):
        x, y = rnd.randint(0, size - 1), rnd.randint(0, size - 1)
        d.point((x, y), fill=color)


def _wavy_line(d, x0, y0, x1, y1, color, width, seed, amp=1.2):
    """A grout/seam line with a slight hand-drawn wander instead of a
    ruler-straight edge."""
    rnd = random.Random(seed)
    length = math.hypot(x1 - x0, y1 - y0)
    n = max(2, int(length // 8))
    dx, dy = x1 - x0, y1 - y0
    L = length or 1
    px, py = -dy / L, dx / L
    phase = rnd.uniform(0, 2 * math.pi)
    pts = []
    for i in range(n + 1):
        t = i / n
        off = math.sin(t * math.pi * 2 + phase) * amp * rnd.uniform(0.6, 1.4)
        pts.append((x0 + dx * t + px * off, y0 + dy * t + py * off))
    d.line(pts, fill=color, width=width)


def _crack(d, x0, y0, length, dark, light, seed):
    """A jagged crack with varied line weight and a 1px light offset —
    the light edge gives the crack depth instead of a flat dark line."""
    rnd = random.Random(seed)
    x, y = x0, y0
    angle = rnd.uniform(0, 2 * math.pi)
    pts = [(x, y)]
    for _ in range(length):
        nx = x + math.cos(angle) * 7 + rnd.randint(-3, 3)
        ny = y + math.sin(angle) * 7 + rnd.randint(-3, 3)
        pts.append((nx, ny))
        x, y = nx, ny
        angle += rnd.uniform(-0.6, 0.6)
    d.line([(px + 1, py + 1) for px, py in pts], fill=light, width=2)
    for i in range(len(pts) - 1):
        d.line([pts[i], pts[i + 1]], fill=dark, width=3 if i % 2 == 0 else 2)


def _moss_patch(d, x, y, r, pal, seed):
    """Moss growing in a crack or seam: a cluster of small green dots,
    darker at the centre."""
    rnd = random.Random(seed)
    for _ in range(r * 2):
        mx = x + rnd.randint(-r, r)
        my = y + rnd.randint(-r // 2, r // 2)
        c = pal["moss_dark"] if rnd.random() < 0.5 else pal["moss"]
        d.ellipse([mx - 1, my - 1, mx + 1, my + 1], fill=c)

# ---------------------------------------------------------------- floors

def floor_tile(variant="plain", seed=7, pal=None, detail_path=None):
    """100x100 clean floor tile — just floor, nothing baked in. The
    stone is 2x2 pavers per tile (50px each, like the Lair's floor),
    each with its own tone + value-noise mottling + AI grain detail;
    seams are wavy hand-drawn grout, not ruler lines; moss grows in
    the seams; cracks are IN the stone (varied weight + a light edge
    for depth). `detail_path` names an ai-source texture for the
    grain layer (stone for dungeon, sandstone for western); None
    skips the AI layer. Grout runs to the outer edge so tiles butt
    together seamlessly; every effect stays tiling-safe."""
    pal = pal or DUNGEON_FLOOR_PAL
    rnd = random.Random(seed)
    base = pal["dark"] if variant == "dark" else pal["base"]
    grout = pal["grout_dark"] if variant == "dark" else pal["grout"]
    fl = Image.new("RGB", (100, 100), grout)
    d = ImageDraw.Draw(fl)
    # Pavers: 2x2 per tile, each its own tone. The paver grid aligns
    # to the tile edges (seams at 0/50/100), so neighbouring tiles
    # butt into continuous stone.
    # The paver cross is offset per tile (seeded) so neighbouring
    # tiles don't line up into a rigid grid; the tile-edge seams stay
    # at 0/100 so tiles still butt seamlessly.
    cx, cy = 50 + rnd.randint(-10, 10), 50 + rnd.randint(-10, 10)
    for (px0, py0, px1, py1) in [(2, 2, cx - 2, cy - 2),
                                 (cx + 2, 2, 98, cy - 2),
                                 (2, cy + 2, cx - 2, 98),
                                 (cx + 2, cy + 2, 98, 98)]:
        v = rnd.randint(-12, 12)
        d.rectangle([px0, py0, px1, py1], fill=_shade(base, v))
    # Wavy paver seams (the cross in the middle + the tile edge grout
    # is the flat grout fill underneath).
    _wavy_line(d, 2, cy, 98, cy, _shade(base, -18), 2, seed + 11)
    _wavy_line(d, cx, 2, cx, 98, _shade(base, -18), 2, seed + 12)
    # Mottling: two octaves of tileable value noise over the whole tile.
    fl = _mottle(fl, _value_noise(100, seed + 21, cells=4, octaves=2), 0.16)
    fl = _mottle(fl, _value_noise(100, seed + 22, cells=9, octaves=1), 0.08)
    # AI grain detail, low alpha — the stone's fine grain and pitting.
    if detail_path:
        fl = _blend_detail(fl, _detail_for(detail_path, 100, seed + 23), 0.14)
    d = ImageDraw.Draw(fl)
    # Moss in the seams (more on dark floors — the damp deep rooms):
    # on the paver cross (x=50 or y=50) or the edge grout.
    moss_n = 10 if variant == "dark" else 5
    for i in range(moss_n):
        if rnd.random() < 0.5:
            mx, my = cx + rnd.randint(-3, 3), rnd.randint(4, 96)
        else:
            mx, my = rnd.randint(4, 96), cy + rnd.randint(-3, 3)
        _moss_patch(d, mx, my, rnd.randint(2, 4), pal, seed + 31 + i)
    _speckle(d, 100, 50, _shade(base, -24), seed + 1)
    if variant in ("cracked", "rubble"):
        _crack(d, rnd.randint(20, 80), rnd.randint(20, 80), 5,
               pal["crack"], _shade(base, 26), seed + 2)
        _crack(d, rnd.randint(20, 80), rnd.randint(20, 80), 4,
               pal["crack"], _shade(base, 26), seed + 3)
    if variant == "rubble":
        # Uneven flagstones — NOT a rubble pile (that is a prop sprite).
        # Some pavers sit proud or sunken: re-tone one quadrant darker
        # with a displaced seam, and embed small stones in the floor.
        d.rectangle([cx + 2, cy + 2, 98, 98], fill=_shade(base, -16))
        _wavy_line(d, cx + 2, cy + 4, 96, cy + 4, _shade(base, -30), 2, seed + 41)
        for i in range(5):
            cx, cy = rnd.randint(15, 85), rnd.randint(15, 85)
            r = rnd.randint(3, 6)
            d.ellipse([cx - r, cy - r, cx + r, cy + r],
                      fill=_shade(base, -26), outline=_shade(base, -42))
    if variant == "dark":
        _speckle(d, 100, 40, pal["speckle_dark"], seed + 4)
    fl = _vignette(fl, 0.05)
    return fl


# Shallow-water palette (FR-13, BRA-226): cold deep-blue water over
# stone. The tint is uniform (tiling-safe); sheen pools and ripple
# rings stay inset from the edges so tiles butt seamlessly.
WATER_TINT = (36, 60, 78)
WATER_SHEEN = (150, 182, 200)
WATER_RIPPLE = (172, 202, 216)


def wet_tile(variant="plain", dry_seed=7, water_seed=207, pal=None):
    """100x100 wet floor tile: the same stone floor under shallow
    water. The dry base is drawn with `dry_seed` — the same seed the
    shipped dry tile uses, so the cracks/moss/pavers sit in the same
    places and the swap reads as the same floor, now wet — then water
    is laid over it: a translucent deep-blue tint, soft sheen pools
    and 1-2 ripple rings. `pal` selects the theme palette (default:
    the dungeon palette)."""
    pal = pal or DUNGEON_FLOOR_PAL
    base = floor_tile(variant, dry_seed, pal, detail_path=STONE_TEX).convert("RGBA")
    # Uniform water tint: darkens and cools the stone evenly, so the
    # tile still butts seamlessly with its neighbours.
    tint = Image.new("RGBA", (100, 100), WATER_TINT + (96,))
    wet = Image.alpha_composite(base, tint)
    # Soft sheen pools: pale reflections, blurred, inset from the
    # edges (nothing crosses a tile boundary).
    rnd = random.Random(water_seed)
    sheen = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheen)
    for _ in range(3):
        cx, cy = rnd.randint(24, 76), rnd.randint(24, 76)
        rx, ry = rnd.randint(10, 20), rnd.randint(6, 12)
        sd.ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                   fill=WATER_SHEEN + (52,))
    sheen = sheen.filter(ImageFilter.GaussianBlur(5))
    wet = Image.alpha_composite(wet, sheen)
    # Ripple rings: 1-2 thin pale arcs, also inset.
    rd = ImageDraw.Draw(wet)
    for _ in range(rnd.randint(1, 2)):
        cx, cy = rnd.randint(26, 74), rnd.randint(26, 74)
        rx, ry = rnd.randint(8, 16), rnd.randint(5, 10)
        rd.ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                   outline=WATER_RIPPLE + (85,), width=2)
    return wet.convert("RGB")

# ---------------------------------------------------------------- walls
# A wall tile is 100x100: a wall TOP (big blocks seen from above,
# TOP_H px) over a wall FACE (receding courses, shaded toward the
# floor). The face lives inside the tile, so the composer places it
# with no changes — rotation still maps each side to its outer edge.
# The tile is opaque: top + face fill the whole square.

def _base_shadow(layer, y0, y1, max_alpha=90):
    """Darken the bottom of a face layer: black with alpha ramping
    0 -> max_alpha from y0 to y1 — the soft shadow where the wall
    meets the floor."""
    h = y1 - y0
    arr = np.zeros((h, layer.size[0], 4), dtype=np.uint8)
    arr[..., 3] = np.linspace(0, max_alpha, h).astype(np.uint8)[:, None]
    sh = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    sh.paste(Image.fromarray(arr, "RGBA"), (0, y0))
    return Image.alpha_composite(layer, sh)


def _glyph(d, cx, cy, s, kind, dark, light):
    """An incised glyph: dark lines with a 1px light offset below, so
    it reads as carved into the stone rather than painted on."""
    def line(pts, color, width=2):
        d.line(pts, fill=color, width=width)
    if kind == "circle":
        line([(cx - s, cy - s), (cx + s, cy - s), (cx + s, cy + s),
              (cx - s, cy + s), (cx - s, cy - s)], dark)
        d.ellipse([cx - 2, cy - 2, cx + 2, cy + 2], fill=dark)
    elif kind == "triangle":
        line([(cx, cy - s), (cx + s, cy + s), (cx - s, cy + s),
              (cx, cy - s)], dark)
    elif kind == "zigzag":
        line([(cx - s, cy), (cx - s // 2, cy - s), (cx, cy),
              (cx + s // 2, cy - s), (cx + s, cy)], dark)
    elif kind == "diamond":
        line([(cx, cy - s), (cx + s, cy), (cx, cy + s),
              (cx - s, cy), (cx, cy - s)], dark)
    else:  # "rune": a stem with two branches
        line([(cx, cy - s), (cx, cy + s)], dark)
        line([(cx, cy - s), (cx + s, cy - s // 2)], dark)
        line([(cx, cy), (cx + s, cy + s // 2)], dark)
    # light offset (incised edge): redraw the same shape 1px down in light
    # — cheap approximation: a 1px light line under the glyph's bottom.
    d.line([cx - s, cy + s + 1, cx + s, cy + s + 1], fill=light, width=1)


def _stone_top(d, x0, y0, x1, y1, seed):
    """Wall top: one row of big blocks seen from above, each with its
    own tone, a bevel (light top edge, dark bottom edge) and the odd
    chipped corner."""
    rnd = random.Random(seed)
    d.rectangle([x0, y0, x1, y1], fill=WALL_SHADOW)
    x = x0
    while x < x1:
        bw = rnd.randint(28, 38)
        bx1 = min(x + bw, x1)
        if bx1 - x < 4:  # a 1-3px sliver reads as mortar; don't draw it
            break
        v = rnd.randint(-10, 10)
        d.rectangle([x + 1, y0 + 1, bx1 - 1, y1 - 1], fill=_shade(WALL_STONE, v))
        d.line([x + 1, y0 + 1, bx1 - 1, y0 + 1], fill=_shade(WALL_STONE, v + 26), width=1)
        d.line([x + 1, y1 - 1, bx1 - 1, y1 - 1], fill=_shade(WALL_STONE, v - 26), width=1)
        if rnd.random() < 0.4:
            cx, cy = rnd.choice([(x + 2, y0 + 2), (bx1 - 2, y0 + 2)])
            d.polygon([(cx, cy), (cx + 5, cy), (cx, cy + 5)], fill=WALL_SHADOW)
        x = bx1


def _stone_face(d, x0, y0, x1, y1, seed, glyphs=False):
    """Wall face: three courses of smaller blocks in running bond,
    each course a touch darker than the one above — the falloff is
    baked into the tones, and _vertical_shade + _base_shadow deepen
    it. `glyphs` carves a few runes into random blocks."""
    rnd = random.Random(seed)
    d.rectangle([x0, y0, x1, y1], fill=MORTAR)
    ch = (y1 - y0) // 3
    kinds = ["circle", "triangle", "zigzag", "diamond", "rune"]
    for r in range(3):
        ry0, ry1 = y0 + r * ch, y0 + (r + 1) * ch if r < 2 else y1
        tone = 8 - r * 10  # top course catches the light, base is dark
        off = 16 if r % 2 else 0
        x = x0 - off
        while x < x1:
            bw = rnd.randint(24, 34)
            bx1 = min(x + bw, x1)
            if bx1 - x < 4:
                break
            v = rnd.randint(-8, 8)
            d.rectangle([x + 1, ry0 + 1, bx1 - 1, ry1 - 1],
                        fill=_shade(WALL_STONE, tone + v))
            if glyphs and rnd.random() < 0.22:
                _glyph(d, (x + bx1) // 2, (ry0 + ry1) // 2, 5,
                       rnd.choice(kinds), _shade(WALL_STONE, tone - 34),
                       _shade(WALL_STONE, tone + 14))
            x = bx1
        d.line([x0, ry1 - 1, x1, ry1 - 1], fill=MORTAR, width=2)
    # light catching the top of the face
    d.line([x0, y0 + 1, x1, y0 + 1], fill=_shade(WALL_STONE, 30), width=1)


def _finish_wall(t, seed, detail_path):
    """Unify a wall tile: value-noise mottling + AI grain detail,
    then the face falloff is already in the tones. Returns RGBA."""
    t = _mottle(t, _value_noise(100, seed + 51, cells=4, octaves=2), 0.10)
    if detail_path:
        t = _blend_detail(t, _detail_for(detail_path, 100, seed + 53), 0.12)
    return t


def _stone_wall(seed=11, door=False, broken=False, carved=False):
    """100x100 stone wall tile: top over face. `door` leaves a gap
    for the iron-bound double door; `broken` collapses the middle;
    `carved` incises glyphs + a frieze into the face."""
    t = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    gap = (32, 68) if door else None
    # --- top ---
    if broken:
        # Collapsed middle: the top band's bottom edge jags down in the
        # middle third, and the top stones there sit lower/darker.
        _stone_top(d, 0, 0, 100, TOP_H, seed)
        d.polygon([(38, TOP_H), (62, TOP_H), (58, TOP_H - 12),
                   (46, TOP_H - 14), (40, TOP_H - 6)],
                  fill=_shade(WALL_STONE, -22), outline=MORTAR)
        d.line([38, TOP_H, 46, TOP_H - 14, 58, TOP_H - 12, 62, TOP_H],
               fill=MORTAR, width=2)
    elif gap:
        _stone_top(d, 0, 0, gap[0], TOP_H, seed)
        _stone_top(d, gap[1], 0, 100, TOP_H, seed + 1)
    else:
        _stone_top(d, 0, 0, 100, TOP_H, seed)
    # --- face (its own layer, for the vertical falloff) ---
    face = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    fd = ImageDraw.Draw(face)
    if gap:
        _stone_face(fd, 0, TOP_H, gap[0], 100, seed + 2)
        _stone_face(fd, gap[1], TOP_H, 100, 100, seed + 3)
    elif broken:
        _stone_face(fd, 0, TOP_H, 100, 100, seed + 2)
        # a dark hole where the wall has fallen through, rubble below it
        fd.polygon([(40, 52), (60, 52), (58, 78), (46, 84), (40, 70)],
                   fill=(8, 8, 10))
        for (sx, sy, sr) in [(44, 88, 5), (52, 90, 6), (58, 86, 4), (48, 94, 4)]:
            fd.ellipse([sx - sr, sy - sr, sx + sr, sy + sr],
                       fill=_shade(WALL_STONE, -14), outline=MORTAR)
    else:
        _stone_face(fd, 0, TOP_H, 100, 100, seed + 2, glyphs=carved)
        if carved:
            # incised frieze: a diamond pattern across the middle course
            for cx in range(10, 100, 18):
                _glyph(fd, cx, TOP_H + FACE_H // 2, 4, "diamond",
                       _shade(WALL_STONE, -30), _shade(WALL_STONE, 12))
    face = _vertical_shade(face, 1.06, 0.58)
    face = _base_shadow(face, TOP_H + 20, 100, 90)
    t = Image.alpha_composite(t, face)
    if gap:
        _draw_door(t, gap, seed)
    t = _finish_wall(t, seed, STONE_TEX)
    return t


def _draw_door(t, gap, seed):
    """The iron-bound double door, set into the wall face in the gap:
    a stone frame, two wood leaves with iron straps + studs, ring
    handles, and a threshold slab. The door is closed — its open/closed
    state is the Wall document's job, not the art's."""
    d = ImageDraw.Draw(t)
    x0, x1 = gap
    # stone frame: lighter border on the gap edges + a lintel slab
    d.rectangle([x0 - 2, TOP_H, x0 + 1, 100], fill=_shade(WALL_STONE, 18))
    d.rectangle([x1 - 1, TOP_H, x1 + 2, 100], fill=_shade(WALL_STONE, 18))
    d.rectangle([x0, TOP_H, x1, TOP_H + 6], fill=_shade(WALL_STONE, 12))
    # recess shadow just inside the frame
    d.line([x0 + 2, TOP_H + 6, x0 + 2, 100], fill=(20, 20, 24), width=2)
    d.line([x1 - 2, TOP_H + 6, x1 - 2, 100], fill=(20, 20, 24), width=2)
    # two leaves: vertical planks
    rnd = random.Random(seed + 7)
    mid = (x0 + x1) // 2
    for lx0, lx1 in [(x0 + 2, mid), (mid, x1 - 2)]:
        for px in range(lx0, lx1, 6):
            v = rnd.randint(-8, 8)
            d.rectangle([px, TOP_H + 6, min(px + 5, lx1), 94],
                        fill=_shade((74, 62, 44), v))
            d.line([px, TOP_H + 6, px, 94], fill=(40, 32, 20), width=1)
        # iron straps with studs
        for sy in (TOP_H + 16, TOP_H + 40):
            d.rectangle([lx0, sy, lx1, sy + 6], fill=(38, 38, 44))
            for sx in range(lx0 + 3, lx1, 6):
                d.ellipse([sx - 1, sy + 1, sx + 1, sy + 3], fill=(88, 88, 96))
        # ring handle near the centre seam
        hx = mid - 3 if lx1 <= mid else mid + 3
        d.ellipse([hx - 3, 66, hx + 3, 72], outline=(30, 30, 34), width=2)
    # threshold slab at the base
    d.rectangle([x0, 94, x1, 100], fill=_shade(WALL_STONE, 20))


def wall_straight(seed=11):
    """100x100 opaque tile: a stone wall with height — top over face."""
    return _stone_wall(seed)


def wall_corner(seed=12):
    """100x100 opaque tile: the north-west outer corner — top L over
    two faces meeting at a diagonal seam in the inner square. The
    composer rotates it for the other corners."""
    t = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    # north top (full width); the west top goes on AFTER the faces —
    # the north face would otherwise paint over it below the corner.
    _stone_top(d, 0, 0, 100, TOP_H, seed)
    # faces: north face over the whole inner square, then the west face
    # as the triangle x<y (closer to the left edge), with a diagonal seam.
    face = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    fd = ImageDraw.Draw(face)
    _stone_face(fd, 0, TOP_H, 100, 100, seed + 2)
    # west face: courses clipped to the triangle by clamping each
    # course's blocks to x <= y (the diagonal is x=y in the square).
    face_w = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    wd = ImageDraw.Draw(face_w)
    ch = FACE_H // 3
    rnd = random.Random(seed + 3)
    for r in range(3):
        ry0, ry1 = TOP_H + r * ch, TOP_H + (r + 1) * ch if r < 2 else 100
        tone = 8 - r * 10
        off = 16 if r % 2 else 0
        x = TOP_H - off
        while x < 100:
            bw = rnd.randint(24, 34)
            bx1 = min(x + bw, 100)
            # clamp the block to the triangle: its right edge may not
            # pass the diagonal (x = y at the row's middle).
            lim = (ry0 + ry1) // 2
            bx1 = min(bx1, lim)
            if bx1 > x + 1:
                v = rnd.randint(-8, 8)
                wd.rectangle([x + 1, ry0 + 1, bx1 - 1, ry1 - 1],
                             fill=_shade(WALL_STONE, tone + v))
            x += bw
        wd.line([TOP_H, ry1 - 1, min(ry1 - 1, 100), ry1 - 1], fill=MORTAR, width=2)
    face_w = _vertical_shade(face_w, 1.06, 0.58)
    face = Image.alpha_composite(face, face_w)
    face = _vertical_shade(face, 1.06, 0.58)
    face = _base_shadow(face, TOP_H + 20, 100, 90)
    # diagonal seam
    fd2 = ImageDraw.Draw(face)
    fd2.line([TOP_H, TOP_H, 100, 100], fill=MORTAR, width=2)
    t = Image.alpha_composite(t, face)
    # west top: a horizontal top band rotated 90 degrees, drawn after
    # the faces so the north face cannot paint over it. The two tops
    # meet in the 38x38 corner square, which gets one solid corner
    # stone over the joint.
    band = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    _stone_top(ImageDraw.Draw(band), 0, 0, 100, TOP_H, seed + 1)
    t = Image.alpha_composite(t, band.rotate(-90, expand=False))
    d = ImageDraw.Draw(t)
    d.rectangle([1, 1, 37, 37], fill=_shade(WALL_STONE, 6))
    d.line([1, 1, 37, 1], fill=_shade(WALL_STONE, 30), width=1)
    d.line([1, 37, 37, 37], fill=_shade(WALL_STONE, -26), width=1)
    t = _finish_wall(t, seed, STONE_TEX)
    return t


def wall_door(seed=13):
    """100x100 opaque tile: a stone wall with the iron-bound double
    door set into its face (the Lair's south door)."""
    return _stone_wall(seed, door=True)


def wall_broken(seed=14):
    """100x100 opaque tile: a wall with its middle collapsed — the top
    sags, the face has a dark hole, rubble spills at the base."""
    return _stone_wall(seed, broken=True)


def wall_carved(seed=15):
    """100x100 opaque tile: a wall whose face is carved — glyphs on
    the blocks and an incised diamond frieze across the middle course."""
    return _stone_wall(seed, carved=True)


def wall_diagonal(seed=16):
    """100x100 transparent tile: a diagonal wall (corner to corner).
    The top strip runs along the diagonal with block joints; the face
    lies on the room side of the strip, courses parallel to the
    diagonal, shaded away from it. Decorative until the composer can
    place diagonal walls — see the report."""
    t = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    rnd = random.Random(seed)
    # diagonal unit vector + perpendicular
    ux, uy = math.sqrt(0.5), math.sqrt(0.5)
    px, py = -uy, ux
    def pt(along, off):
        return (50 + ux * along + px * off, 50 + uy * along + py * off)
    # top strip: -19..+19 off the diagonal, joints every ~30px along it
    top_poly = [pt(-75, -19), pt(75, -19), pt(75, 19), pt(-75, 19)]
    d.polygon(top_poly, fill=WALL_SHADOW)
    joints = [-75, -45, -15, 15, 45, 75]
    for i in range(len(joints) - 1):
        a, b = joints[i], joints[i + 1]
        v = rnd.randint(-10, 10)
        d.polygon([pt(a, -18), pt(b, -18), pt(b, 18), pt(a, 18)],
                  fill=_shade(WALL_STONE, v))
        d.line([pt(a, -18), pt(a, 18)], fill=MORTAR, width=2)
    d.line([pt(-75, -19), pt(75, -19)], fill=_shade(WALL_STONE, 26), width=1)
    # face: +19..+52 off the diagonal, courses parallel to it
    face = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    fd = ImageDraw.Draw(face)
    for c, (o0, o1) in enumerate([(19, 30), (30, 41), (41, 52)]):
        tone = 6 - c * 10
        # course band as a polygon along the diagonal
        fd.polygon([pt(-75, o0), pt(75, o0), pt(75, o1), pt(-75, o1)],
                   fill=_shade(WALL_STONE, tone))
        # block joints across the course
        for a in range(-60, 76, 28):
            fd.line([pt(a, o0), pt(a, o1)], fill=MORTAR, width=2)
        fd.line([pt(-75, o1), pt(75, o1)], fill=MORTAR, width=2)
    face = _base_shadow(face, 0, 100, 0)  # no-op guard: shade below
    # shade the face away from the diagonal: darker with offset
    arr = np.asarray(face).astype(np.float32)
    yy, xx = np.mgrid[0:100, 0:100]
    off = (xx - 50) * px + (yy - 50) * py  # perpendicular distance
    shade = np.clip(1.06 - np.maximum(off - 19, 0) / 52.0 * 0.48, 0.58, 1.06)
    arr[..., :3] *= shade[..., None]
    face = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")
    t = Image.alpha_composite(t, face)
    t = _finish_wall(t, seed, STONE_TEX)
    return t


# ---------------------------------------------------------------- western walls (FR-2)

def _wood_top(d, x0, y0, x1, y1, seed):
    """Wall top in wood: two rows of horizontal planks with grain,
    butt joints, knots and nails; bevelled like the stone top."""
    rnd = random.Random(seed)
    d.rectangle([x0, y0, x1, y1], fill=WOOD_DARK)
    rh = (y1 - y0) // 2
    for r in range(2):
        ry0, ry1 = y0 + r * rh, y0 + (r + 1) * rh
        off = 22 if r % 2 else 0
        x = x0 - off
        while x < x1:
            bw = rnd.randint(30, 44)
            bx1 = min(x + bw, x1)
            if bx1 - x < 4:
                break
            v = rnd.randint(-8, 8)
            d.rectangle([x + 1, ry0 + 1, bx1 - 1, ry1 - 1], fill=_shade(WOOD, v))
            gy = (ry0 + ry1) // 2 + rnd.randint(-3, 3)
            d.line([x + 3, gy, bx1 - 3, gy + rnd.randint(-2, 2)],
                   fill=_shade(WOOD_GRAIN, v), width=1)
            nx = min(x + 6, x1 - 3)
            d.ellipse([nx - 2, (ry0 + ry1) // 2 - 2, nx + 2, (ry0 + ry1) // 2 + 2],
                      fill=(40, 30, 20))
            x = bx1
        d.line([x0, ry1 - 1, x1, ry1 - 1], fill=WOOD_DARK, width=2)
    d.line([x0, y0 + 1, x1, y0 + 1], fill=_shade(WOOD, 26), width=1)
    d.line([x0, y1 - 1, x1, y1 - 1], fill=WOOD_SHADOW, width=2)


def _wood_face(d, x0, y0, x1, y1, seed):
    """Wood wall face: vertical planks with wavy vertical grain, knots
    and nail heads, a horizontal crossbeam near the top, and the same
    falloff as the stone face (tones darken per course)."""
    rnd = random.Random(seed)
    d.rectangle([x0, y0, x1, y1], fill=WOOD_DARK)
    # vertical planks
    x = x0
    while x < x1:
        bw = rnd.randint(22, 30)
        bx1 = min(x + bw, x1)
        if bx1 - x < 4:
            break
        v = rnd.randint(-10, 10)
        d.rectangle([x + 1, y0 + 1, bx1 - 1, y1 - 1], fill=_shade(WOOD, v))
        gx = (x + bx1) // 2 + rnd.randint(-2, 2)
        d.line([gx, y0 + 3, gx + rnd.randint(-2, 2), y1 - 3],
               fill=_shade(WOOD_GRAIN, v), width=1)
        if rnd.random() < 0.4:
            kx, ky = (x + bx1) // 2, rnd.randint(y0 + 12, y1 - 12)
            d.ellipse([kx - 4, ky - 3, kx + 4, ky + 3],
                      outline=_shade(WOOD_GRAIN, v - 10), width=1)
            d.ellipse([kx - 2, ky - 1, kx + 2, ky + 1],
                      fill=_shade(WOOD_GRAIN, v - 14))
        x = bx1
    # crossbeam near the top of the face
    by0, by1 = y0 + 8, y0 + 16
    d.rectangle([x0, by0, x1, by1], fill=_shade(WOOD_DARK, 6))
    d.line([x0, by0, x1, by0], fill=_shade(WOOD, 20), width=1)
    for nx in range(x0 + 10, x1, 24):
        d.ellipse([nx - 2, (by0 + by1) // 2 - 2, nx + 2, (by0 + by1) // 2 + 2],
                  fill=(40, 30, 20))
    d.line([x0, y0 + 1, x1, y0 + 1], fill=_shade(WOOD, 30), width=1)


def _wood_wall(seed=111, door=False, broken=False):
    """100x100 wood wall tile: plank top over a plank face. Same
    geometry as the stone wall — only the material changes."""
    t = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    gap = (32, 68) if door else None
    if broken:
        _wood_top(d, 0, 0, 100, TOP_H, seed)
        # collapsed middle: jagged plank ends + splinters
        d.polygon([(38, TOP_H), (62, TOP_H), (58, TOP_H - 10),
                   (46, TOP_H - 12), (40, TOP_H - 5)],
                  fill=_shade(WOOD_DARK, 4), outline=WOOD_SHADOW)
        for (sx, sy, ex, ey) in [(44, TOP_H - 8, 40, TOP_H + 4),
                                 (54, TOP_H - 9, 58, TOP_H + 3)]:
            d.line([sx, sy, ex, ey], fill=_shade(WOOD, 22), width=1)
    elif gap:
        _wood_top(d, 0, 0, gap[0], TOP_H, seed)
        _wood_top(d, gap[1], 0, 100, TOP_H, seed + 1)
    else:
        _wood_top(d, 0, 0, 100, TOP_H, seed)
    face = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    fd = ImageDraw.Draw(face)
    if gap:
        _wood_face(fd, 0, TOP_H, gap[0], 100, seed + 2)
        _wood_face(fd, gap[1], TOP_H, 100, 100, seed + 3)
    elif broken:
        _wood_face(fd, 0, TOP_H, 100, 100, seed + 2)
        fd.polygon([(40, 52), (60, 52), (58, 76), (46, 82), (40, 68)],
                   fill=(10, 8, 6))
        for (sx, sy, ex, ey) in [(46, 84, 42, 92), (54, 82, 58, 90)]:
            fd.line([sx, sy, ex, ey], fill=_shade(WOOD, 20), width=1)
    else:
        _wood_face(fd, 0, TOP_H, 100, 100, seed + 2)
    face = _vertical_shade(face, 1.06, 0.58)
    face = _base_shadow(face, TOP_H + 20, 100, 90)
    t = Image.alpha_composite(t, face)
    if gap:
        _draw_door(t, gap, seed)
    t = _finish_wall(t, seed, WOOD_TEX)
    return t


def wall_wood_straight(seed=111):
    """100x100 opaque tile: a wood-plank wall with height — top over face."""
    return _wood_wall(seed)


def wall_wood_corner(seed=112):
    """100x100 opaque tile: the north-west wood corner — top L over
    two plank faces meeting at a diagonal seam. Rotated for the rest."""
    t = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    # north top; the west top goes on AFTER the faces (see wall_corner).
    _wood_top(d, 0, 0, 100, TOP_H, seed)
    face = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    _wood_face(ImageDraw.Draw(face), 0, TOP_H, 100, 100, seed + 2)
    face_w = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    wd = ImageDraw.Draw(face_w)
    # west face, clipped to the triangle x<y by clamping each plank
    x = TOP_H
    rnd = random.Random(seed + 3)
    while x < 100:
        bw = rnd.randint(22, 30)
        bx1 = min(x + bw, 100)
        lim = 100  # planks run vertically; the triangle clips their tops
        if bx1 > x + 1:
            v = rnd.randint(-10, 10)
            # the plank's top is cut by the diagonal: it starts at y=x
            wd.polygon([(x + 1, max(TOP_H, x + 1)), (bx1 - 1, max(TOP_H, bx1 - 1)),
                        (bx1 - 1, 99), (x + 1, 99)],
                       fill=_shade(WOOD, v))
        x = bx1
    face_w = _vertical_shade(face_w, 1.06, 0.58)
    face = Image.alpha_composite(face, face_w)
    face = _vertical_shade(face, 1.06, 0.58)
    face = _base_shadow(face, TOP_H + 20, 100, 90)
    ImageDraw.Draw(face).line([TOP_H, TOP_H, 100, 100], fill=WOOD_DARK, width=2)
    t = Image.alpha_composite(t, face)
    # west top after the faces, then one solid corner plank over the joint.
    band = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    _wood_top(ImageDraw.Draw(band), 0, 0, 100, TOP_H, seed + 1)
    t = Image.alpha_composite(t, band.rotate(-90, expand=False))
    d = ImageDraw.Draw(t)
    d.rectangle([1, 1, 37, 37], fill=_shade(WOOD, 6))
    d.line([1, 1, 37, 1], fill=_shade(WOOD, 26), width=1)
    d.line([1, 37, 37, 37], fill=WOOD_SHADOW, width=1)
    t = _finish_wall(t, seed, WOOD_TEX)
    return t


def wall_wood_door(seed=113):
    """100x100 opaque tile: a wood wall with the iron-bound double
    door set into its face."""
    return _wood_wall(seed, door=True)


def wall_wood_broken(seed=114):
    """100x100 opaque tile: a wood wall with its middle collapsed —
    jagged plank ends, splinters, a dark hole."""
    return _wood_wall(seed, broken=True)

# ---------------------------------------------------------------- fog

def _wavy_fog_line(d, rnd, size, y_base, amp, alpha, width, color):
    """One drifting smoke line: a sine polyline spanning the tile,
    so the wisp has visible curl instead of a straight band."""
    pts = []
    steps = 16
    phase = rnd.random() * 1.2
    for i in range(steps + 1):
        x = size * 0.05 + i * (size * 0.9) / steps
        y = (y_base + math.sin(i * 0.8 + phase) * amp
             + rnd.randint(-2, 2))
        pts.append((x, y))
    d.line(pts, fill=color + (alpha,), width=width, joint="curve")


def fog_tile(seed=21, variant="pool", color=(110, 190, 130), size=100):
    """Fog tile drawn at its native `size` (100/200/400): a soft pool
    of eerie smoke on a transparent background, so it can sit over any
    floor. `color` is the smoke colour — green for the dungeon, tan
    dust for the western theme. Drawn at native size, not upscaled:
    the old build drew at 100px then 4x-upscaled, which blurred the
    wisps to almost nothing at table scale while the pool read as one
    flat glow. Alphas stay moderate so the floor stays readable
    through it, and nothing touches the tile edge, so neighbours butt
    seamlessly."""
    t = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    rnd = random.Random(seed)
    s = size / 100.0
    m = size * 0.06  # keep clear of the edges
    if variant == "pool":
        # overlapping blobs of varied size/alpha so the pool reads as
        # smoke with structure, not one flat glow; cores are smaller
        # and off-centre so the middle stays readable through
        for _ in range(6):
            cx = rnd.randint(int(size * 0.30), int(size * 0.70))
            cy = rnd.randint(int(size * 0.30), int(size * 0.70))
            rx = rnd.randint(int(12 * s), int(24 * s))
            ry = rnd.randint(int(9 * s), int(17 * s))
            d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                      fill=color + (rnd.randint(130, 170),))
        for _ in range(2):
            cx = rnd.randint(int(size * 0.38), int(size * 0.62))
            cy = rnd.randint(int(size * 0.38), int(size * 0.62))
            d.ellipse([cx - int(9 * s), cy - int(6 * s),
                       cx + int(9 * s), cy + int(6 * s)],
                      fill=color + (190,))
        # a couple of thin satellite wisps at the pool's edge
        for _ in range(2):
            y = rnd.randint(int(size * 0.2), int(size * 0.8))
            d.line([(int(m), y), (int(size - m), y + rnd.randint(-8, 8))],
                   fill=color + (110,), width=max(3, int(5 * s)))
    elif variant == "wisp":
        # faint broad body, then wavy drifting lines spanning the tile
        d.ellipse([m, size * 0.30, size - m, size * 0.70],
                  fill=color + (55,))
        for k in range(4):
            _wavy_fog_line(d, rnd, size, size * (0.32 + 0.12 * k),
                       6 * s, rnd.randint(150, 185), max(4, int(9 * s)),
                       color)
    else:  # "ring"
        d.ellipse([26 * s, 26 * s, 74 * s, 74 * s],
                  outline=color + (200,), width=max(3, int(12 * s)))
    t = t.filter(ImageFilter.GaussianBlur(max(4, int(size * 0.03))))
    return t


# ---------------------------------------------------------------- dressing
# Props are separate sprites: each its own image, transparent
# background, free placement. All are drawn at 100x100 (except the
# macro pieces below) and get a contact shadow where they meet the
# floor, so they sit IN the room instead of floating on it.

BONE = (218, 210, 186)
BONE_DARK = (168, 158, 132)
BONE_LIGHT = (242, 236, 214)
CHEST_WOOD = (86, 64, 40)
CHEST_WOOD_DARK = (56, 40, 24)
IRON = (38, 38, 44)
GOLD = (212, 172, 66)


def _prop_canvas():
    return Image.new("RGBA", (100, 100), (0, 0, 0, 0))


def bones_tile(seed=31, scattered=False):
    """Scattered bones: a femur, a rib or two, and a skull or a small
    bone pile. `scattered=True` spreads them wider across the tile."""
    t = _prop_canvas()
    # contact shadow: a soft dark ellipse under the whole pile
    shadow = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse([22, 74, 78, 86], fill=(0, 0, 0, 70))
    t = Image.alpha_composite(t, shadow.filter(ImageFilter.GaussianBlur(1)))
    d = ImageDraw.Draw(t)
    rnd = random.Random(seed)
    # femur: a long shaft with a knob at each end
    x0, y0, x1, y1 = 28, 58, 66, 44
    d.line([x0, y0, x1, y1], fill=BONE_DARK, width=5)
    d.line([x0, y0, x1, y1], fill=BONE, width=3)
    for (kx, ky) in [(x0, y0), (x1, y1)]:
        d.ellipse([kx - 5, ky - 5, kx + 5, ky + 5], fill=BONE,
                  outline=BONE_DARK)
    # rib bones: small arcs
    for i in range(3):
        cx = 34 + i * 9
        d.arc([cx - 5, 62, cx + 5, 78], 180, 360, fill=BONE, width=2)
    # skull
    sx, sy = (58, 30) if not scattered else (70, 22)
    d.ellipse([sx - 8, sy - 7, sx + 8, sy + 7], fill=BONE, outline=BONE_DARK)
    d.rectangle([sx - 6, sy + 5, sx + 6, sy + 11], fill=BONE,
                outline=BONE_DARK)
    for ex in (-3, 3):
        d.ellipse([sx + ex - 2, sy - 2, sx + ex + 2, sy + 2], fill=(24, 24, 26))
    d.polygon([(sx - 2, sy + 7), (sx + 2, sy + 7), (sx, sy + 10)],
              fill=(24, 24, 26))
    if scattered:
        # a second, smaller pile in the far corner
        d.line([14, 74, 30, 68], fill=BONE, width=3)
        d.ellipse([12, 70, 18, 76], fill=BONE, outline=BONE_DARK)
        d.ellipse([28, 64, 34, 70], fill=BONE, outline=BONE_DARK)
    return t


def rubble_tile(seed=32):
    """A rubble pile: heaped stones with moss — the prop that
    replaces the old baked-in floor-rubble tiles."""
    t = _prop_canvas()
    d = ImageDraw.Draw(t)
    rnd = random.Random(seed)
    d.ellipse([18, 74, 82, 88], fill=(0, 0, 0, 80))
    stones = [(50, 58, 16), (34, 66, 12), (64, 66, 12), (42, 46, 10),
              (58, 46, 10), (50, 34, 9), (28, 74, 9), (72, 74, 9)]
    for (sx, sy, sr) in stones:
        v = rnd.randint(-12, 12)
        d.polygon([(sx - sr, sy + sr // 2), (sx - sr // 2, sy - sr),
                   (sx + sr, sy - sr // 3), (sx + sr // 2, sy + sr // 2)],
                  fill=_shade(WALL_STONE, v), outline=MORTAR)
    for _ in range(3):
        _moss_patch(d, rnd.randint(30, 70), rnd.randint(40, 66),
                    rnd.randint(2, 4), DUNGEON_FLOOR_PAL, seed + 1)
    return t


def pillar_tile(seed=33):
    """A standing pillar: a square column with a capital, base and
    cracked shaft — the upright half of the broken-column story."""
    t = _prop_canvas()
    d = ImageDraw.Draw(t)
    rnd = random.Random(seed)
    d.ellipse([26, 84, 74, 92], fill=(0, 0, 0, 80))
    # base, shaft, capital — the shaft is lighter on its left edge
    d.rectangle([26, 78, 74, 88], fill=_shade(WALL_STONE, -6))
    d.rectangle([32, 18, 68, 78], fill=_shade(WALL_STONE, 4))
    d.rectangle([32, 18, 42, 78], fill=_shade(WALL_STONE, 18))
    d.rectangle([32, 18, 68, 24], fill=_shade(WALL_STONE, -4))
    d.rectangle([28, 10, 72, 18], fill=_shade(WALL_STONE, 10))
    d.rectangle([28, 10, 72, 13], fill=_shade(WALL_STONE, 26))
    # a crack down the shaft
    _crack(d, 46, 30, 5, _shade(WALL_STONE, -28), _shade(WALL_STONE, 14),
           seed + 1)
    return t


def sconce_tile(seed=34):
    """A wall-mounted sconce: iron bracket + amber flame + glow pool.
    It is placed at a wall cell so the bracket sits on the wall face;
    the glow is a soft radial pool (no hard edge)."""
    t = _prop_canvas()
    d = ImageDraw.Draw(t)
    # iron bracket: a vertical bar + a cup at its top
    d.rectangle([46, 10, 54, 42], fill=IRON)
    d.rectangle([42, 8, 58, 14], fill=IRON)
    d.rectangle([44, 38, 56, 44], fill=IRON)
    # flame: a teardrop, amber with a bright core (big enough to read
    # at 100px when the sconce sits on a wall face)
    d.polygon([(50, 14), (58, 30), (55, 42), (45, 42), (42, 30)],
              fill=(240, 180, 60))
    d.polygon([(50, 22), (55, 34), (53, 40), (47, 40), (45, 34)],
              fill=(250, 225, 140))
    # glow pool: a radial amber wash, blurred, under the flame
    glow = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([14, 6, 86, 92], fill=(240, 170, 60, 85))
    glow = glow.filter(ImageFilter.GaussianBlur(10))
    t = Image.alpha_composite(glow, t)
    return t


def candle_tile(seed=42):
    """A candle in a small brass holder: a wax stick, a pale flame and
    a soft glow pool. A standalone prop sprite (100px, like the
    sconce) — never baked into a floor tile. It sits on a table cell
    (or a floor cell next to a wall), so the holder is drawn low in
    the canvas with the flame rising above it."""
    t = _prop_canvas()
    d = ImageDraw.Draw(t)
    # contact shadow + holder: a low brass dish with a stem
    d.ellipse([30, 82, 70, 90], fill=(0, 0, 0, 70))
    d.rectangle([38, 76, 62, 82], fill=_shade(GOLD, -20))
    d.ellipse([36, 74, 64, 82], fill=GOLD, outline=_shade(GOLD, -50))
    d.rectangle([46, 66, 54, 76], fill=_shade(GOLD, -30))
    # wax stick: pale, slightly uneven, with a drip on one side
    d.rectangle([45, 44, 55, 68], fill=(238, 228, 200), outline=(196, 182, 150))
    d.rectangle([53, 52, 57, 68], fill=(222, 210, 178))
    # wick + flame: a small pale teardrop, bright core, big enough to
    # read at 100px — the candle's light is smaller and paler than a
    # torch's, so the flame is narrower and the glow is softer
    d.line([50, 40, 50, 46], fill=(30, 24, 18), width=2)
    d.polygon([(50, 16), (57, 32), (54, 42), (46, 42), (43, 32)],
              fill=(255, 196, 107))
    d.polygon([(50, 24), (54, 34), (52, 40), (48, 40), (46, 34)],
              fill=(255, 238, 180))
    # glow pool: a small pale wash, blurred, centred on the flame
    glow = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([26, 8, 74, 76], fill=(255, 196, 107, 60))
    glow = glow.filter(ImageFilter.GaussianBlur(8))
    t = Image.alpha_composite(glow, t)
    return t


def brazier_tile(seed=43):
    """A standing brazier: an iron bowl on a tripod, fire tongues
    rising from it. A standalone prop sprite (100px, like the
    sconce) — the bowl is drawn bold to fill the canvas, because the
    dressing plan puts braziers in room corners where a 200px
    footprint would not fit. Never baked into a floor tile."""
    t = _prop_canvas()
    d = ImageDraw.Draw(t)
    # contact shadow + tripod legs
    d.ellipse([24, 82, 76, 92], fill=(0, 0, 0, 80))
    d.polygon([(38, 62), (46, 62), (34, 88), (28, 88)], fill=IRON)
    d.polygon([(62, 62), (54, 62), (66, 88), (72, 88)], fill=IRON)
    d.polygon([(48, 62), (52, 62), (50, 88), (46, 88)], fill=_shade(IRON, 20))
    # bowl: a wide iron dish with a rim highlight and rivets
    d.polygon([(22, 52), (78, 52), (70, 68), (30, 68)], fill=IRON)
    d.ellipse([22, 46, 78, 58], fill=_shade(IRON, 26), outline=_shade(IRON, -20))
    d.ellipse([30, 48, 70, 56], fill=(16, 12, 10))
    for rx in (30, 40, 50, 60, 70):
        d.ellipse([rx - 1, 59, rx + 1, 61], fill=_shade(IRON, 40))
    # fire: three tongues over the coals — orange outside, yellow
    # core — with ember dots, big enough to read at 100px
    d.polygon([(50, 12), (60, 34), (56, 50), (44, 50), (40, 34)],
              fill=(255, 140, 46))
    d.polygon([(36, 26), (44, 42), (40, 50), (30, 50), (28, 40)],
              fill=(240, 160, 60))
    d.polygon([(64, 26), (72, 40), (70, 50), (60, 50), (56, 42)],
              fill=(240, 160, 60))
    d.polygon([(50, 24), (56, 38), (53, 48), (47, 48), (44, 38)],
              fill=(255, 214, 110))
    for (ex, ey) in [(40, 46), (60, 46), (50, 40)]:
        d.ellipse([ex - 1, ey - 1, ex + 1, ey + 1], fill=(255, 120, 40))
    # glow pool: a strong amber wash over the whole tile
    glow = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([8, 2, 92, 90], fill=(255, 140, 46, 80))
    glow = glow.filter(ImageFilter.GaussianBlur(10))
    t = Image.alpha_composite(glow, t)
    return t


def ritual_circle_tile(seed=35):
    """A ritual circle: a worn chalk ring, inner star lines, runes —
    drawn with varied weight so it reads as hand-drawn, not stamped."""
    t = _prop_canvas()
    d = ImageDraw.Draw(t)
    rnd = random.Random(seed)
    d.ellipse([16, 16, 84, 84], outline=(214, 206, 184, 220), width=3)
    d.ellipse([24, 24, 76, 76], outline=(214, 206, 184, 180), width=1)
    for i in range(5):
        ang = math.pi * 2 * i / 5 - math.pi / 2
        d.line([50 + 34 * math.cos(ang), 50 + 34 * math.sin(ang),
                50 + 34 * math.cos(ang + 4 * math.pi / 5),
                50 + 34 * math.sin(ang + 4 * math.pi / 5)],
               fill=(214, 206, 184, 200), width=2)
    for i in range(8):
        ang = math.pi * 2 * i / 8
        _glyph(d, 50 + 29 * math.cos(ang), 50 + 29 * math.sin(ang), 3,
               rnd.choice(["circle", "triangle", "diamond", "rune"]),
               (120, 116, 100, 220), (240, 236, 220, 120))
    # wear: fade (not erase) two arcs of the ring so it looks old.
    # The mask is the wear alpha itself: 0 outside the arcs (keep the
    # ring), ~120 inside (fade it to about half).
    wear = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    wd = ImageDraw.Draw(wear)
    wd.arc([16, 16, 84, 84], 20, 60, fill=(0, 0, 0, 120), width=4)
    wd.arc([16, 16, 84, 84], 200, 240, fill=(0, 0, 0, 120), width=4)
    t = Image.composite(Image.new("RGBA", (100, 100), (0, 0, 0, 0)), t,
                        wear.split()[3])
    return t


def spear_tile(seed=36):
    """A spear stuck in the floor: haft, head and fletching, leaning
    slightly, with a contact shadow at its base."""
    t = _prop_canvas()
    d = ImageDraw.Draw(t)
    d.ellipse([56, 82, 76, 90], fill=(0, 0, 0, 70))
    d.line([64, 82, 56, 22], fill=(120, 92, 52), width=4)
    d.line([64, 82, 56, 22], fill=(150, 118, 70), width=2)
    # leaf-shaped head
    d.polygon([(56, 22), (50, 34), (56, 42), (62, 34)], fill=(170, 174, 180))
    d.line([56, 22, 56, 42], fill=(220, 224, 230), width=1)
    # fletching near the base
    d.polygon([(64, 82), (58, 74), (66, 72)], fill=(160, 60, 50))
    return t


def chest_tile(seed=37, open_=False):
    """A chest: iron-banded, with a clasp. `open_` lifts the lid and
    shows gold inside (the AI cutout supplies the rich interior)."""
    if open_:
        src = Image.open(AI_SOURCE / "chest-open.png").convert("RGBA")
        # the cutout is a full open chest on transparency — use it at
        # native size; build_pack resizes to the declared sizePx.
        return src
    t = _prop_canvas()
    d = ImageDraw.Draw(t)
    d.ellipse([22, 80, 78, 90], fill=(0, 0, 0, 80))
    # body + lid, iron bands, studs, clasp
    d.rectangle([22, 46, 78, 82], fill=CHEST_WOOD)
    d.rectangle([22, 46, 78, 52], fill=_shade(CHEST_WOOD, 16))
    d.rounded_rectangle([20, 34, 80, 50], radius=8, fill=_shade(CHEST_WOOD, 8))
    d.line([22, 50, 78, 50], fill=CHEST_WOOD_DARK, width=2)
    for bx in (30, 70):
        d.rectangle([bx, 34, bx + 5, 82], fill=IRON)
        for sy in (40, 60, 76):
            d.ellipse([bx + 1, sy - 1, bx + 3, sy + 1], fill=(90, 90, 96))
    d.rectangle([46, 50, 54, 60], fill=IRON)
    return t


def altar_tile(seed=38):
    """A stone altar: stepped base, a tapered shaft with a carved
    glyph, a slab top with a skull resting on it — drawn procedurally
    so it sits in the stone palette. (The old AI cutout was a flat
    blue slab — a poster, not an altar — so it is retired.)"""
    t = _prop_canvas()
    d = ImageDraw.Draw(t)
    d.ellipse([20, 82, 80, 92], fill=(0, 0, 0, 80))
    # stepped base
    d.rectangle([22, 76, 78, 86], fill=_shade(WALL_STONE, -8))
    d.rectangle([28, 68, 72, 76], fill=_shade(WALL_STONE, -2))
    # shaft with a light left edge
    d.rectangle([32, 30, 68, 68], fill=_shade(WALL_STONE, 4))
    d.rectangle([32, 30, 40, 68], fill=_shade(WALL_STONE, 18))
    # carved glyph on the shaft
    _glyph(d, 50, 50, 7, "circle", _shade(WALL_STONE, -30),
           _shade(WALL_STONE, 16))
    # slab top + a skull resting on it
    d.rectangle([26, 20, 74, 30], fill=_shade(WALL_STONE, 10))
    d.line([26, 20, 74, 20], fill=_shade(WALL_STONE, 28), width=1)
    d.ellipse([42, 8, 58, 20], fill=BONE, outline=BONE_DARK)
    d.rectangle([44, 18, 56, 22], fill=BONE, outline=BONE_DARK)
    for ex in (-4, 4):
        d.ellipse([50 + ex - 2, 12, 50 + ex + 2, 16], fill=(24, 24, 26))
    # moss at the base
    _moss_patch(d, 30, 80, 3, DUNGEON_FLOOR_PAL, seed + 1)
    _moss_patch(d, 68, 78, 3, DUNGEON_FLOOR_PAL, seed + 2)
    return t


def skeleton_tile(seed=39, partial=False):
    """A skeleton lying on the floor. `partial` is the half-buried
    variant (AI cutout: skull + ribcage + femur in rubble + moss)."""
    if partial:
        src = Image.open(AI_SOURCE / "skeleton-partial.png").convert("RGBA")
        return src
    src = Image.open(AI_SOURCE / "skeleton.png").convert("RGBA")
    return src


def bookshelf_tile(seed=40):
    """A bookshelf: dark wood frame, three shelves of books in varied
    muted tones, a couple of leaning spines and a scroll on top."""
    t = _prop_canvas()
    d = ImageDraw.Draw(t)
    rnd = random.Random(seed)
    d.ellipse([16, 82, 84, 92], fill=(0, 0, 0, 80))
    d.rectangle([16, 10, 84, 84], fill=_shade(CHEST_WOOD, 6))
    d.rectangle([16, 10, 84, 14], fill=_shade(CHEST_WOOD, 20))
    tones = [(140, 60, 50), (90, 100, 140), (160, 130, 70), (90, 120, 80),
             (150, 110, 90), (110, 80, 120)]
    for shelf_y in (14, 38, 60):
        d.rectangle([20, shelf_y + 20, 80, shelf_y + 24],
                    fill=CHEST_WOOD_DARK)
        x = 21
        while x < 79:
            bw = rnd.randint(5, 8)
            tone = rnd.choice(tones)
            d.rectangle([x, shelf_y + 2, x + bw - 1, shelf_y + 20],
                        fill=tone)
            d.line([x, shelf_y + 2, x, shelf_y + 20],
                   fill=_shade(tone, 24), width=1)
            x += bw
    # a scroll lying on the top shelf
    d.rectangle([24, 6, 52, 10], fill=(230, 220, 190))
    return t


def treasure_pile_tile(seed=41):
    """A treasure pile: heaped gold coins, a goblet, a gem or two —
    the hoard the Lich guards, drawn with a contact shadow."""
    t = _prop_canvas()
    d = ImageDraw.Draw(t)
    rnd = random.Random(seed)
    d.ellipse([18, 76, 82, 88], fill=(0, 0, 0, 80))
    for _ in range(26):
        cx = rnd.randint(26, 74)
        cy = rnd.randint(52, 78)
        r = rnd.randint(3, 6)
        v = rnd.randint(-16, 16)
        d.ellipse([cx - r, cy - r, cx + r, cy + r],
                  fill=_shade(GOLD, v), outline=_shade(GOLD, -40))
    # a goblet and a ruby on top
    d.polygon([(52, 48), (60, 48), (58, 58), (54, 58)], fill=GOLD)
    d.ellipse([50, 44, 62, 50], fill=_shade(GOLD, 20))
    d.polygon([(66, 50), (70, 56), (66, 62), (62, 56)],
              fill=(190, 50, 60))
    return t


# ---------------------------------------------------------------- macro pieces
# Multi-square assemblies: the bounding box snaps to the grid, but
# inside the piece shapes are free-form — round is fine. All macro
# pieces are dressing-layer entries at 200x200 or 300x300.

def _macro_canvas(size):
    return Image.new("RGBA", (size, size), (0, 0, 0, 0))


def dais_round_tile(seed=51):
    """A 2x2 circular dais: concentric stone rings with a raised edge,
    moss in the outer ring, a glyph in the centre — the round piece
    that sits in a square room and still aligns (200x200 box)."""
    t = _macro_canvas(200)
    d = ImageDraw.Draw(t)
    rnd = random.Random(seed)
    cx = cy = 100
    # outer ring (the dais edge): a raised stone rim with a highlight
    d.ellipse([8, 8, 192, 192], fill=_shade(WALL_STONE, -8))
    d.ellipse([12, 12, 188, 188], outline=_shade(WALL_STONE, 22), width=2)
    d.ellipse([8, 8, 192, 192], outline=MORTAR, width=2)
    # inner rings: alternating tones, wavy joints
    for (r0, r1, tone) in [(88, 88, 0), (64, 88, 4), (40, 64, -4), (0, 40, 8)]:
        d.ellipse([cx - r1, cy - r1, cx + r1, cy + r1],
                  fill=_shade(WALL_STONE, tone))
        d.ellipse([cx - r1, cy - r1, cx + r1, cy + r1],
                  outline=MORTAR, width=2)
    # radial joints on the middle ring
    for i in range(8):
        ang = math.pi * i / 4
        d.line([cx + 40 * math.cos(ang), cy + 40 * math.sin(ang),
                cx + 88 * math.cos(ang), cy + 88 * math.sin(ang)],
               fill=MORTAR, width=2)
    # centre glyph
    _glyph(d, cx, cy, 12, "circle", _shade(WALL_STONE, -30),
           _shade(WALL_STONE, 16))
    # moss on the outer ring
    for _ in range(6):
        ang = rnd.random() * 2 * math.pi
        _moss_patch(d, int(cx + 78 * math.cos(ang)),
                    int(cy + 78 * math.sin(ang)), 4, DUNGEON_FLOOR_PAL,
                    seed + 1)
    t = _mottle(t, _value_noise(200, seed + 61, cells=4, octaves=2), 0.10)
    return t


def pool_round_tile(seed=52):
    """A 2x2 round pool: dark water inside a stone rim, sheen pools
    and ripple rings, moss on the rim — the Lair's fog pool as a
    macro piece."""
    t = _macro_canvas(200)
    d = ImageDraw.Draw(t)
    rnd = random.Random(seed)
    cx = cy = 100
    # stone rim
    d.ellipse([10, 10, 190, 190], fill=_shade(WALL_STONE, -6))
    d.ellipse([14, 14, 186, 186], outline=_shade(WALL_STONE, 20), width=2)
    # water: a deep green-blue disc, darker at the rim
    d.ellipse([18, 18, 182, 182], fill=(30, 58, 52))
    d.ellipse([18, 18, 182, 182], outline=(16, 34, 30), width=4)
    # sheen pools + ripple rings, blurred
    sheen = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheen)
    for _ in range(3):
        x, y = rnd.randint(60, 140), rnd.randint(60, 140)
        sd.ellipse([x - 24, y - 14, x + 24, y + 14],
                   fill=(150, 200, 180, 60))
    sheen = sheen.filter(ImageFilter.GaussianBlur(8))
    t = Image.alpha_composite(t, sheen)
    d = ImageDraw.Draw(t)
    for _ in range(2):
        x, y = rnd.randint(70, 130), rnd.randint(70, 130)
        d.ellipse([x - 18, y - 12, x + 18, y + 12],
                  outline=(180, 220, 200, 120), width=2)
    # green fog wisp over the water
    fog = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fog)
    fd.ellipse([60, 80, 140, 120], fill=(110, 190, 130, 90))
    fog = fog.filter(ImageFilter.GaussianBlur(12))
    t = Image.alpha_composite(t, fog)
    return t


def column_broken_tile(seed=53):
    """A 2x2 broken column: the fallen shaft lying across the tile,
    built from three stone drums with mortar joints and per-drum tone,
    its capital tipped over at the shaft's end, stones scattered
    around — the Lair's broken column as one macro piece."""
    t = _macro_canvas(200)
    d = ImageDraw.Draw(t)
    rnd = random.Random(seed)
    d.ellipse([20, 150, 180, 168], fill=(0, 0, 0, 70))
    # fallen shaft: three drums, each its own tone, mortar joints
    shaft = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shaft)
    x = 28
    for i in range(3):
        bw = 46 if i < 2 else 44
        v = rnd.randint(-8, 8)
        sd.rounded_rectangle([x, 82, x + bw, 122], radius=12,
                             fill=_shade(WALL_STONE, v))
        sd.line([x, 86, x + bw, 86], fill=_shade(WALL_STONE, v + 22), width=2)
        if i < 2:
            sd.line([x + bw, 82, x + bw, 122], fill=MORTAR, width=3)
        x += bw
    # a crack across the middle drum
    _crack(sd, 84, 96, 4, _shade(WALL_STONE, -26), _shade(WALL_STONE, 14),
           seed + 1)
    shaft = shaft.rotate(-18, center=(100, 102), resample=Image.BICUBIC)
    t = Image.alpha_composite(t, shaft)
    d = ImageDraw.Draw(t)
    # the capital, tipped over at the shaft's lower end
    d.rounded_rectangle([16, 116, 58, 142], radius=4,
                        fill=_shade(WALL_STONE, 10), outline=MORTAR)
    d.line([16, 120, 58, 120], fill=_shade(WALL_STONE, 26), width=2)
    d.rectangle([22, 142, 52, 148], fill=_shade(WALL_STONE, -6))
    # scattered stones + moss around it
    for _ in range(8):
        sx, sy = rnd.randint(30, 170), rnd.randint(118, 162)
        sr = rnd.randint(4, 9)
        d.polygon([(sx - sr, sy + sr // 2), (sx, sy - sr),
                   (sx + sr, sy), (sx, sy + sr)],
                  fill=_shade(WALL_STONE, rnd.randint(-14, 10)),
                  outline=MORTAR)
    for _ in range(3):
        _moss_patch(d, rnd.randint(40, 160), rnd.randint(120, 155),
                    3, DUNGEON_FLOOR_PAL, seed + 2)
    return t


def wall_curved_tile(seed=54):
    """A 3x3 curved wall section: an arc of wall top + face, sweeping
    from the top-left corner to the bottom-right — the curved wall
    run the pack could not express as 1-square tiles. 300x300."""
    t = _macro_canvas(300)
    d = ImageDraw.Draw(t)
    rnd = random.Random(seed)
    cx, cy, r = 20, 280, 240  # arc centre: bottom-left, radius 240
    # face: the band r-62..r from the centre, courses along the arc
    for (r0, r1, tone) in [(r - 62, r - 42, 8), (r - 42, r - 21, -2),
                           (r - 21, r, -12)]:
        d.pieslice([cx - r1, cy - r1, cx + r1, cy + r1], -90, 0,
                   fill=_shade(WALL_STONE, tone))
        d.arc([cx - r1, cy - r1, cx + r1, cy + r1], -90, 0, fill=MORTAR,
              width=2)
        # block joints along the arc
        for ang in range(-80, 0, 15):
            a = math.radians(ang)
            d.line([cx + r0 * math.cos(a), cy + r0 * math.sin(a),
                    cx + r1 * math.cos(a), cy + r1 * math.sin(a)],
                   fill=MORTAR, width=2)
    # top: the band r..r+38 from the centre, big blocks along the arc
    d.pieslice([cx - r - 38, cy - r - 38, cx + r + 38, cy + r + 38], -90, 0,
               fill=WALL_SHADOW)
    for i, ang in enumerate(range(-90, 0, 18)):
        a0 = math.radians(ang)
        a1 = math.radians(min(ang + 18, 0))
        v = rnd.randint(-10, 10)
        d.pieslice([cx - r - 38, cy - r - 38, cx + r + 38, cy + r + 38],
                   ang, min(ang + 18, 0), fill=_shade(WALL_STONE, v))
        d.line([cx + (r + 38) * math.cos(a1), cy + (r + 38) * math.sin(a1),
                cx + r * math.cos(a1), cy + r * math.sin(a1)],
               fill=MORTAR, width=2)
    # light catching the top of the face (the arc at radius r)
    d.arc([cx - r, cy - r, cx + r, cy + r], -90, 0,
          fill=_shade(WALL_STONE, 30), width=2)
    t = _mottle(t, _value_noise(300, seed + 71, cells=6, octaves=2), 0.10)
    return t

# ---------------------------------------------------------------- pack lists
# 46 tiles in three kinds: base (28 — clean floor + wall faces +
# fog/dust), macro (4 — multi-square assemblies), prop (14 — free
# sprites). Sizes: base 100 (fog 200/400), props 200 (sconce 100),
# macro 200/300. Walls keep layer "floor" exactly as the old manifest
# did — the composer reads wall tiles from the floor layer.

DUST = (210, 190, 150)

PACK_SPECS = [
    # --- dungeon base (13) ---
    {"name": "floor-plain", "make": lambda: floor_tile("plain", 7, DUNGEON_FLOOR_PAL, STONE_TEX),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["floor", "stone"]},
    {"name": "floor-cracked", "make": lambda: floor_tile("cracked", 8, DUNGEON_FLOOR_PAL, STONE_TEX),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["floor", "stone", "cracked"]},
    {"name": "floor-rubble", "make": lambda: floor_tile("rubble", 9, DUNGEON_FLOOR_PAL, STONE_TEX),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["floor", "stone", "rubble"]},
    {"name": "floor-dark", "make": lambda: floor_tile("dark", 10, DUNGEON_FLOOR_PAL, STONE_TEX),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["floor", "stone", "dark", "deep"]},
    {"name": "wall-straight", "make": lambda: wall_straight(11),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["wall", "straight"]},
    {"name": "wall-corner", "make": lambda: wall_corner(12),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["wall", "corner"]},
    {"name": "wall-door", "make": lambda: wall_door(13),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["wall", "door"]},
    {"name": "wall-broken", "make": lambda: wall_broken(14),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["wall", "broken"]},
    {"name": "wall-carved", "make": lambda: wall_carved(15),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["wall", "carved"]},
    {"name": "wall-diagonal", "make": lambda: wall_diagonal(16),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["wall", "diagonal"]},
    {"name": "fog-wisp-small", "make": lambda: fog_tile(22, "wisp", size=200),
     "sizePx": 200, "layer": "atmosphere", "kind": "base", "tags": ["fog", "atmosphere", "green"]},
    {"name": "fog-wisp-large", "make": lambda: fog_tile(23, "wisp", size=400),
     "sizePx": 400, "layer": "atmosphere", "kind": "base", "tags": ["fog", "atmosphere", "green"]},
    {"name": "fog-pool", "make": lambda: fog_tile(21, "pool", size=400),
     "sizePx": 400, "layer": "atmosphere", "kind": "base", "tags": ["fog", "atmosphere", "green", "dense"]},
    # --- western base (11) ---
    {"name": "floor-sand", "make": lambda: floor_tile("plain", 107, WESTERN_FLOOR_PAL, SAND_TEX),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["floor", "sand", "western"]},
    {"name": "floor-sand-cracked", "make": lambda: floor_tile("cracked", 108, WESTERN_FLOOR_PAL, SAND_TEX),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["floor", "sand", "cracked", "western"]},
    {"name": "floor-sand-rubble", "make": lambda: floor_tile("rubble", 109, WESTERN_FLOOR_PAL, SAND_TEX),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["floor", "sand", "rubble", "western"]},
    {"name": "floor-sand-dark", "make": lambda: floor_tile("dark", 110, WESTERN_FLOOR_PAL, SAND_TEX),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["floor", "sand", "dark", "western"]},
    {"name": "wall-wood-straight", "make": lambda: wall_wood_straight(111),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["wall", "wood", "straight", "western"]},
    {"name": "wall-wood-corner", "make": lambda: wall_wood_corner(112),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["wall", "wood", "corner", "western"]},
    {"name": "wall-wood-door", "make": lambda: wall_wood_door(113),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["wall", "wood", "door", "western"]},
    {"name": "wall-wood-broken", "make": lambda: wall_wood_broken(114),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["wall", "wood", "broken", "western"]},
    {"name": "dust-wisp-small", "make": lambda: fog_tile(122, "wisp", DUST, size=200),
     "sizePx": 200, "layer": "atmosphere", "kind": "base", "tags": ["dust", "atmosphere", "western"]},
    {"name": "dust-wisp-large", "make": lambda: fog_tile(123, "wisp", DUST, size=400),
     "sizePx": 400, "layer": "atmosphere", "kind": "base", "tags": ["dust", "atmosphere", "western"]},
    {"name": "dust-pool", "make": lambda: fog_tile(121, "pool", DUST, size=400),
     "sizePx": 400, "layer": "atmosphere", "kind": "base", "tags": ["dust", "atmosphere", "dense", "western"]},
    # --- wet base (4): same dry seed as the dry twin, so the swap
    # reads as the same floor, now under water ---
    {"name": "floor-wet", "make": lambda: wet_tile("plain", 7, 207),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["floor", "stone", "wet"]},
    {"name": "floor-wet-cracked", "make": lambda: wet_tile("cracked", 8, 208),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["floor", "stone", "cracked", "wet"]},
    {"name": "floor-wet-rubble", "make": lambda: wet_tile("rubble", 9, 209),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["floor", "stone", "rubble", "wet"]},
    {"name": "floor-wet-dark", "make": lambda: wet_tile("dark", 10, 210),
     "sizePx": 100, "layer": "floor", "kind": "base", "tags": ["floor", "stone", "dark", "deep", "wet"]},
    # --- props (14): free sprites, dressing layer ---
    {"name": "rubble", "make": lambda: rubble_tile(32),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "rubble", "stone"]},
    {"name": "bones", "make": lambda: bones_tile(31),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "bones"]},
    {"name": "bones-scattered", "make": lambda: bones_tile(31, scattered=True),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "bones"]},
    {"name": "pillar", "make": lambda: pillar_tile(33),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "pillar"]},
    {"name": "sconce", "make": lambda: sconce_tile(34),
     "sizePx": 100, "layer": "dressing", "kind": "prop", "tags": ["dressing", "torch", "sconce"]},
    {"name": "candle", "make": lambda: candle_tile(42),
     "sizePx": 100, "layer": "dressing", "kind": "prop", "tags": ["dressing", "candle", "light"]},
    {"name": "brazier", "make": lambda: brazier_tile(43),
     "sizePx": 100, "layer": "dressing", "kind": "prop", "tags": ["dressing", "brazier", "fire"]},
    {"name": "ritual-circle", "make": lambda: ritual_circle_tile(35),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "ritual", "lich"]},
    {"name": "spear", "make": lambda: spear_tile(36),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "prop", "spear", "weapon"]},
    {"name": "skeleton", "make": lambda: skeleton_tile(39),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "skeleton", "bones"]},
    {"name": "skeleton-partial", "make": lambda: skeleton_tile(39, partial=True),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "skeleton", "bones"]},
    {"name": "chest", "make": lambda: chest_tile(37),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "chest", "treasure"]},
    {"name": "chest-open", "make": lambda: chest_tile(37, open_=True),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "chest", "treasure"]},
    {"name": "altar", "make": lambda: altar_tile(38),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "altar", "ritual", "lich"]},
    {"name": "bookshelf", "make": lambda: bookshelf_tile(40),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "bookshelf"]},
    {"name": "treasure-pile", "make": lambda: treasure_pile_tile(41),
     "sizePx": 200, "layer": "dressing", "kind": "prop", "tags": ["dressing", "treasure", "gold"]},
    # --- macro pieces (4): multi-square assemblies, dressing layer ---
    {"name": "dais-round", "make": lambda: dais_round_tile(51),
     "sizePx": 200, "layer": "dressing", "kind": "macro", "tags": ["dressing", "macro", "dais", "round"]},
    {"name": "pool-round", "make": lambda: pool_round_tile(52),
     "sizePx": 200, "layer": "dressing", "kind": "macro", "tags": ["dressing", "macro", "pool", "round"]},
    {"name": "column-broken", "make": lambda: column_broken_tile(53),
     "sizePx": 200, "layer": "dressing", "kind": "macro", "tags": ["dressing", "macro", "column", "broken"]},
    {"name": "wall-curved", "make": lambda: wall_curved_tile(54),
     "sizePx": 300, "layer": "dressing", "kind": "macro", "tags": ["dressing", "macro", "wall", "curved"]},
]


def _to_size(img, size):
    """Crop to square (centre) and resize to sizePx. AI cutouts come
    at native resolution, procedural tiles at 100x100 — both land on
    the declared size."""
    w, h = img.size
    if w != h:
        s = min(w, h)
        img = img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))
    if img.size[0] != size:
        img = img.resize((size, size), Image.LANCZOS)
    return img


def build_pack():
    """Render every tile in PACK_SPECS and write tiles/manifest.json."""
    t0 = time.time()
    entries = []
    for spec in PACK_SPECS:
        img = _to_size(spec["make"](), spec["sizePx"])
        img.save(PACK_DIR / f"{spec['name']}.png")
        entries.append({"name": spec["name"], "file": f"pack/{spec['name']}.png",
                        "sizePx": spec["sizePx"], "layer": spec["layer"],
                        "kind": spec["kind"], "tags": spec["tags"]})
    manifest = {"version": 1, "tilePx": 100, "generated": "2026-11-20",
                "tiles": entries, "gaps": []}
    (TILES_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))
    kinds = {}
    for e in entries:
        kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
    print(f"pack: {len(entries)} tiles ({kinds}) in {time.time() - t0:.1f}s, 0 gaps")
    return manifest


# ---------------------------------------------------------------- previews
# Each preview builds a real room from the shipped tiles — clean base +
# free props + macro pieces — so Brandon can judge the separation.
# Wall rotation (base tile faces south): north 0, south 180,
# west 270, east 90; corners NW 0, NE 270, SW 90, SE 180.

def _load_pack_images():
    return {p.stem: Image.open(p) for p in PACK_DIR.glob("*.png")}


def _room(canvas, ox, oy, cells, floor_for, straight, corner, door, props, pack):
    """Draw one room at pixel origin (ox, oy): floor everywhere, wall
    ring with rotation, a south door, then props (name, gx, gy) pasted
    with their alpha — props may overlap the wall ring, like dressing
    does in the composer."""
    for gy in range(cells):
        for gx in range(cells):
            canvas.paste(pack[floor_for(gx, gy)], (ox + gx * 100, oy + gy * 100))
    for gx in range(cells):
        canvas.paste(pack[straight], (ox + gx * 100, oy))
        canvas.paste(pack[straight].rotate(180, expand=False),
                     (ox + gx * 100, oy + (cells - 1) * 100))
    for gy in range(cells):
        canvas.paste(pack[straight].rotate(270, expand=False), (ox, oy + gy * 100))
        canvas.paste(pack[straight].rotate(90, expand=False),
                     (ox + (cells - 1) * 100, oy + gy * 100))
    canvas.paste(pack[corner], (ox, oy))
    canvas.paste(pack[corner].rotate(270, expand=False), (ox + (cells - 1) * 100, oy))
    canvas.paste(pack[corner].rotate(90, expand=False), (ox, oy + (cells - 1) * 100))
    canvas.paste(pack[corner].rotate(180, expand=False),
                 (ox + (cells - 1) * 100, oy + (cells - 1) * 100))
    canvas.paste(pack[door].rotate(180, expand=False),
                 (ox + (cells // 2) * 100, oy + (cells - 1) * 100))
    for name, gx, gy in props:
        img = pack[name]
        canvas.paste(img, (ox + gx * 100, oy + gy * 100), img)


def render_previews():
    """Three previews, all from the shipped pack:
    - dungeon: two 6x6 rooms side by side, SAME clean floor, DIFFERENT
      prop arrangements (left: dais + bones + chest + skeleton + sconce;
      right: pool + column + altar + ritual-circle + bones-scattered).
    - western: one 6x6 room (sand + wood walls + bookshelf, treasure,
      chest-open, bones-scattered, dust).
    - wet: one 6x6 room, dry on the left, wet on the right, with
      rubble + a half-buried skeleton + fog."""
    pack = _load_pack_images()
    # dungeon — 1200x600, two rooms
    c = Image.new("RGB", (1200, 600), (12, 12, 14))
    _room(c, 0, 0, 6, lambda gx, gy: "floor-plain",
          "wall-straight", "wall-corner", "wall-door",
          [("dais-round", 2, 2), ("bones", 1, 1), ("chest", 3, 1),
           ("skeleton", 1, 3), ("sconce", 2, 0), ("candle", 4, 1),
           ("brazier", 4, 3), ("fog-wisp-small", 5, 4)],
          pack)
    _room(c, 600, 0, 6, lambda gx, gy: "floor-plain",
          "wall-straight", "wall-corner", "wall-door",
          [("pool-round", 2, 2), ("column-broken", 1, 1), ("altar", 3, 1),
           ("ritual-circle", 1, 3), ("bones-scattered", 3, 3),
           ("sconce", 3, 0)],
          pack)
    c.save(TILES_DIR / "pack-preview.png")
    # western — 600x600, one room
    c = Image.new("RGB", (600, 600), (12, 12, 14))
    _room(c, 0, 0, 6, lambda gx, gy: "floor-sand",
          "wall-wood-straight", "wall-wood-corner", "wall-wood-door",
          [("bookshelf", 1, 1), ("treasure-pile", 3, 1),
           ("chest-open", 1, 3), ("bones-scattered", 3, 3),
           ("dust-wisp-large", 1, 1)],
          pack)
    c.save(TILES_DIR / "pack-preview-western.png")
    # wet — 600x600, one room: dry left, wet right
    wet_names = ["floor-wet", "floor-wet-cracked", "floor-wet-rubble", "floor-wet-dark"]
    c = Image.new("RGB", (600, 600), (12, 12, 14))
    _room(c, 0, 0, 6,
          lambda gx, gy: "floor-plain" if gx < 3 else wet_names[(gx + gy) % 4],
          "wall-straight", "wall-corner", "wall-door",
          [("rubble", 1, 1), ("skeleton-partial", 3, 2),
           ("fog-pool", 2, 1)],
          pack)
    c.save(TILES_DIR / "pack-preview-wet.png")
    print("previews: pack-preview.png, pack-preview-western.png, pack-preview-wet.png")


def main():
    ap = argparse.ArgumentParser(description="Generate the MuseGM tile pack.")
    ap.add_argument("--preview", action="store_true",
                    help="only render previews from the existing pack")
    args = ap.parse_args()
    if not args.preview:
        build_pack()
    render_previews()


if __name__ == "__main__":
    main()
