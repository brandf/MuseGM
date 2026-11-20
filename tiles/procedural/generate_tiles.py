#!/usr/bin/env python3
"""Procedural tile pack generation for MuseGM.

Code over AI where code wins: fog wisps, floor tiles, walls, doors and
most dressing are drawn procedurally — exact, tileable by construction,
seamless, and consistent by definition, with real alpha. AI images are
only used where they earn it (organic dressing: full skeleton, chest,
altar) — those are recorded as gaps in the manifest, never faked.

Tile unit: 100px = 1 grid square (Foundry grid size 100). Floors and
walls are 100x100 full squares; dressing is 200x200 (2x2 squares);
fog is 200x200 (small) or 400x400 (large/pool).

No SVG renderer is assumed on the machine (no rsvg/inkscape/cairosvg);
PIL is the renderer. Usage:

    python3 generate_tiles.py            # writes tiles/pack/*.png + tiles/manifest.json

Style: STYLE.md — cold blue-grey stone, warm amber torch pools, bone
off-white, green eerie fog, strict top-down, no text.
"""

from PIL import Image, ImageDraw, ImageFilter
import json
import math
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
TILES_DIR = os.path.dirname(HERE)
PACK_DIR = os.path.join(TILES_DIR, "pack")

# Palette (STYLE.md)
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


def _shade(rgb, dv):
    return tuple(max(0, min(255, c + dv)) for c in rgb)


def _speckle(d, size, n, color, seed):
    random.seed(seed)
    for _ in range(n):
        x, y = random.randint(0, size - 1), random.randint(0, size - 1)
        d.point((x, y), fill=color)


def _crack(d, x0, y0, length, color, seed):
    """A jagged crack: a few short segments wandering off in one direction."""
    random.seed(seed)
    x, y = x0, y0
    angle = random.uniform(0, 2 * math.pi)
    for _ in range(length):
        nx = x + math.cos(angle) * 7 + random.randint(-3, 3)
        ny = y + math.sin(angle) * 7 + random.randint(-3, 3)
        d.line([x, y, nx, ny], fill=color, width=2)
        x, y = nx, ny
        angle += random.uniform(-0.6, 0.6)


# ---------------------------------------------------------------- floors

def floor_tile(variant="plain", seed=7):
    """100x100 stone floor tile. Grout runs to the outer edge so tiles butt
    together seamlessly (a 4px grout line where two tiles meet)."""
    random.seed(seed)
    base = FLOOR_DARK if variant == "dark" else FLOOR
    grout = GROUT_DARK if variant == "dark" else GROUT
    fl = Image.new("RGB", (100, 100), grout)
    d = ImageDraw.Draw(fl)
    v = random.randint(-8, 8)
    d.rectangle([2, 2, 98, 98], fill=_shade(base, v))
    # faint inner slab seams (a single stone, split once for texture)
    d.line([2, 52, 98, 52], fill=_shade(base, v - 14), width=2)
    d.line([52, 2, 52, 52], fill=_shade(base, v - 14), width=2)
    _speckle(d, 100, 60, _shade(base, v - 22), seed + 1)
    if variant in ("cracked", "rubble"):
        _crack(d, random.randint(20, 80), random.randint(20, 80), 5, CRACK, seed + 2)
        _crack(d, random.randint(20, 80), random.randint(20, 80), 4, CRACK, seed + 3)
    if variant == "rubble":
        for i in range(5):
            cx, cy = random.randint(15, 85), random.randint(15, 85)
            r = random.randint(4, 9)
            d.ellipse([cx - r, cy - r, cx + r, cy + r],
                      fill=_shade(base, -26), outline=_shade(base, -40))
    if variant == "dark":
        _speckle(d, 100, 40, (30, 34, 40), seed + 4)
    return fl


# ---------------------------------------------------------------- walls

def _wall_band(d, x0, y0, x1, y1, seed):
    """Stone block band in the rectangle (x0,y0)-(x1,y1): two rows of
    blocks with offset seams, mortar lines, and a shadow line at the
    bottom edge. Drawn into the top of the tile; the rest stays
    transparent so the floor shows through below the wall."""
    random.seed(seed)
    d.rectangle([x0, y0, x1, y1], fill=WALL_SHADOW)
    rows = 2
    rh = (y1 - y0) // rows
    for r in range(rows):
        ry0, ry1 = y0 + r * rh, y0 + (r + 1) * rh
        off = 18 if r % 2 else 0
        x = x0 - off
        while x < x1:
            bw = random.randint(26, 38)
            v = random.randint(-8, 8)
            d.rectangle([x + 1, ry0 + 1, min(x + bw - 1, x1), ry1 - 1],
                        fill=_shade(WALL_STONE, v))
            x += bw
        d.line([x0, ry1, x1, ry1], fill=MORTAR, width=2)
    d.line([x0, y1, x1, y1], fill=WALL_SHADOW, width=3)


def wall_straight(seed=11):
    """100x100 transparent tile: a stone wall band across the top."""
    t = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    _wall_band(ImageDraw.Draw(t), 0, 0, 100, 48, seed)
    return t


def wall_corner(seed=12):
    """100x100 transparent tile: wall bands across the top AND the left
    (the north-west corner; the composer rotates it for other corners)."""
    t = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    _wall_band(d, 0, 0, 100, 48, seed)
    _wall_band(d, 0, 0, 48, 100, seed + 1)
    return t


def _dashed_arc(d, cx, cy, r, a0, a1, color, width=2, dash=6):
    """Dashed arc from angle a0 to a1 (radians), drawn as short segments."""
    steps = 60
    prev = None
    for i in range(steps + 1):
        a = a0 + (a1 - a0) * i / steps
        p = (cx + r * math.cos(a), cy + r * math.sin(a))
        on = (i // 3) % 2 == 0
        if prev is not None and on:
            d.line([prev, p], fill=color, width=width)
        prev = p


def wall_door(seed=13):
    """100x100 transparent tile: wall band with a gap in the middle, the
    door leaf flat from above (hinged at the left of the gap, ajar), plus
    the dashed quarter-circle swing arc. Per STYLE.md, top-down only."""
    t = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    # band in two pieces, leaving a 36px gap in the middle
    _wall_band(d, 0, 0, 32, 48, seed)
    _wall_band(d, 68, 0, 100, 48, seed + 1)
    # door leaf: thin rectangle hinged at (32, 48), swung ~35 deg into the room
    hx, hy = 32, 48
    ang = math.radians(35)
    lx, ly = 34, 6  # leaf length, thickness
    dx, dy = math.cos(ang), math.sin(ang)
    px, py = -dy, dx  # perpendicular
    leaf = [
        (hx + px * ly / 2, hy + py * ly / 2),
        (hx + dx * lx + px * ly / 2, hy + dy * lx + py * ly / 2),
        (hx + dx * lx - px * ly / 2, hy + dy * lx - py * ly / 2),
        (hx - px * ly / 2, hy - py * ly / 2),
    ]
    d.polygon(leaf, fill=(74, 62, 44), outline=(40, 32, 20))
    # dashed swing arc, radius = leaf length, from the wall out into the room
    _dashed_arc(d, hx, hy, lx, 0, math.radians(35), (200, 200, 200, 180))
    return t


# ---------------------------------------------------------------- fog

def fog_wisp(size=400, seed=7, density=1.0):
    """Soft green eerie fog on a transparent background. Blobs plus thin
    tendrils, blurred. `density` scales the alpha (pool is denser)."""
    random.seed(seed)
    fog = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(fog)
    n = 6 if size <= 200 else 8
    for i in range(n):
        cx = size * random.uniform(0.15, 0.85)
        cy = size * random.uniform(0.15, 0.85)
        rx = size * random.uniform(0.2, 0.45)
        ry = size * random.uniform(0.08, 0.2)
        a = int(random.randint(55, 95) * density)
        d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry],
                  fill=FOG + (min(255, a),))
    fog = fog.filter(ImageFilter.GaussianBlur(max(8, size // 18)))
    t = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dt = ImageDraw.Draw(t)
    for _ in range(3):
        x0, y0 = random.uniform(0, size), random.uniform(0, size)
        x1, y1 = random.uniform(0, size), random.uniform(0, size)
        w = max(6, size // 16)
        a = int(random.randint(45, 65) * density)
        dt.line([x0, y0, x1, y1], fill=FOG + (min(255, a),), width=w)
    t = t.filter(ImageFilter.GaussianBlur(max(6, size // 28)))
    return Image.alpha_composite(fog, t)


def fog_pool(size=400, seed=21):
    """Denser fog that pools: same wisp, plus a heavy center mass."""
    base = fog_wisp(size, seed, density=1.0)
    pool = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(pool)
    c = size // 2
    for (rx, ry, a) in [(size * 0.32, size * 0.22, 110),
                        (size * 0.22, size * 0.16, 90),
                        (size * 0.16, size * 0.12, 80)]:
        d.ellipse([c - rx, c - ry, c + rx, c + ry], fill=FOG + (a,))
    pool = pool.filter(ImageFilter.GaussianBlur(size // 10))
    return Image.alpha_composite(base, pool)


# ---------------------------------------------------------------- dressing

def _bone_femur(d, x, y, length, angle, seed):
    """A stylized femur from above: shaft + knobbed ends, bone off-white
    with a dark outline. Drawn at (x, y), rotated by angle (degrees)."""
    random.seed(seed)
    a = math.radians(angle)
    dx, dy = math.cos(a), math.sin(a)
    px, py = -dy, dx
    ex, ey = x + dx * length, y + dy * length
    w = 7
    d.line([x, y, ex, ey], fill=BONE_OUTLINE, width=w + 3)
    d.line([x, y, ex, ey], fill=BONE, width=w)
    for (cx, cy) in [(x, y), (ex, ey)]:
        for s in (-1, 1):
            kx, ky = cx + px * s * 6, cy + py * s * 6
            d.ellipse([kx - 7, ky - 7, kx + 7, ky + 7],
                      fill=BONE, outline=BONE_OUTLINE)
        d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=BONE)


def bones(seed=31):
    """200x200 transparent tile: a scattered bone pile — femurs, a skull,
    rib arcs. Top-down, bone off-white."""
    t = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    random.seed(seed)
    _bone_femur(d, 50, 130, 80, -25, seed + 1)
    _bone_femur(d, 120, 60, 70, 55, seed + 2)
    _bone_femur(d, 90, 150, 60, 10, seed + 3)
    # skull: round cranium, dark eye sockets, jaw
    d.ellipse([128, 108, 168, 148], fill=BONE, outline=BONE_OUTLINE, width=2)
    d.ellipse([138, 122, 148, 132], fill=CHARCOAL)
    d.ellipse([152, 122, 162, 132], fill=CHARCOAL)
    d.rectangle([140, 140, 158, 152], fill=BONE, outline=BONE_OUTLINE)
    # rib arcs
    for (cx, cy, r) in [(60, 60, 26), (70, 70, 20), (52, 72, 18)]:
        d.arc([cx - r, cy - r, cx + r, cy + r], start=200, end=340,
              fill=BONE_OUTLINE, width=4)
        d.arc([cx - r, cy - r, cx + r, cy + r], start=200, end=340,
              fill=BONE, width=2)
    # a few small loose bones
    for (x, y) in [(40, 110), (150, 80), (100, 90)]:
        d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=BONE,
                  outline=BONE_OUTLINE)
    return t


def rubble(seed=41):
    """200x200 transparent tile: broken stone chunks — irregular polygons
    with dark outlines and a lighter top edge, plus small stones."""
    t = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    random.seed(seed)
    for _ in range(6):
        cx, cy = random.randint(40, 160), random.randint(40, 160)
        r = random.randint(14, 30)
        pts = []
        for k in range(6):
            a = 2 * math.pi * k / 6 + random.uniform(-0.3, 0.3)
            rr = r * random.uniform(0.7, 1.1)
            pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
        v = random.randint(-10, 10)
        d.polygon(pts, fill=_shade(WALL_STONE, v), outline=MORTAR)
        d.line([pts[0], pts[1]], fill=_shade(WALL_STONE, v + 22), width=2)
    for _ in range(8):
        cx, cy = random.randint(20, 180), random.randint(20, 180)
        r = random.randint(3, 7)
        d.ellipse([cx - r, cy - r, cx + r, cy + r],
                  fill=_shade(WALL_STONE, -18), outline=MORTAR)
    return t


def pillar(seed=51):
    """200x200 transparent tile: a round pillar seen from directly above —
    concentric stone rings with a highlight. Top-down, so it is a circle."""
    t = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    c = 100
    d.ellipse([c - 52, c - 52, c + 52, c + 52], fill=(0, 0, 0, 90))
    d.ellipse([c - 48, c - 48, c + 48, c + 48], fill=WALL_STONE,
              outline=MORTAR, width=2)
    d.ellipse([c - 36, c - 36, c + 36, c + 36],
              fill=_shade(WALL_STONE, 10), outline=MORTAR)
    d.ellipse([c - 20, c - 20, c + 20, c + 20],
              fill=_shade(WALL_STONE, 22), outline=_shade(WALL_STONE, -8))
    d.ellipse([c - 8, c - 8, c + 8, c + 8], fill=_shade(WALL_STONE, 30))
    return t


def sconce(seed=61):
    """100x100 transparent tile: a wall torch sconce from above — a dark
    bracket with a warm amber glow pool. (The light itself is a separate
    AmbientLight document; this is only the visual.)"""
    t = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    glow = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([22, 22, 78, 78], fill=AMBER + (90,))
    glow = glow.filter(ImageFilter.GaussianBlur(14))
    t = Image.alpha_composite(t, glow)
    d = ImageDraw.Draw(t)
    d.rectangle([44, 40, 56, 62], fill=(52, 44, 36), outline=(20, 16, 10))
    d.ellipse([42, 34, 58, 50], fill=AMBER, outline=(120, 70, 20))
    return t


def ritual_circle(seed=71):
    """200x200 transparent tile: a ritual circle — concentric thin rings,
    radial ticks and small diamond glyphs, bone-white lines. Geometric,
    so it draws cleanly in code."""
    t = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    c = 100
    ink = BONE + (200,)
    d.ellipse([c - 88, c - 88, c + 88, c + 88], outline=ink, width=2)
    d.ellipse([c - 64, c - 64, c + 64, c + 64], outline=ink, width=2)
    d.ellipse([c - 30, c - 30, c + 30, c + 30], outline=ink, width=2)
    for k in range(12):
        a = 2 * math.pi * k / 12
        x0, y0 = c + 64 * math.cos(a), c + 64 * math.sin(a)
        x1, y1 = c + 88 * math.cos(a), c + 88 * math.sin(a)
        d.line([x0, y0, x1, y1], fill=ink, width=2)
    for k in range(8):
        a = 2 * math.pi * k / 8 + math.pi / 8
        cx, cy = c + 76 * math.cos(a), c + 76 * math.sin(a)
        d.polygon([(cx, cy - 6), (cx + 5, cy), (cx, cy + 6), (cx - 5, cy)],
                  outline=ink)
    return t


# ---------------------------------------------------------------- pack

# name -> (builder, kwargs, size_px, layer, tags)
PACK = [
    ("floor-plain", lambda: floor_tile("plain", 7), 100, "floor",
     ["floor", "stone"]),
    ("floor-cracked", lambda: floor_tile("cracked", 8), 100, "floor",
     ["floor", "stone", "cracked"]),
    ("floor-rubble", lambda: floor_tile("rubble", 9), 100, "floor",
     ["floor", "stone", "rubble"]),
    ("floor-dark", lambda: floor_tile("dark", 10), 100, "floor",
     ["floor", "stone", "dark", "deep"]),
    ("wall-straight", wall_straight, 100, "floor",
     ["wall", "straight"]),
    ("wall-corner", wall_corner, 100, "floor",
     ["wall", "corner"]),
    ("wall-door", wall_door, 100, "floor",
     ["wall", "door"]),
    ("fog-wisp-small", lambda: fog_wisp(200, 7), 200, "atmosphere",
     ["fog", "atmosphere", "green"]),
    ("fog-wisp-large", lambda: fog_wisp(400, 7), 400, "atmosphere",
     ["fog", "atmosphere", "green"]),
    ("fog-pool", lambda: fog_pool(400, 21), 400, "atmosphere",
     ["fog", "atmosphere", "green", "dense"]),
    ("rubble", rubble, 200, "dressing",
     ["dressing", "rubble", "stone"]),
    ("bones", bones, 200, "dressing",
     ["dressing", "bones"]),
    ("pillar", pillar, 200, "dressing",
     ["dressing", "pillar"]),
    ("sconce", sconce, 100, "dressing",
     ["dressing", "torch", "sconce"]),
    ("ritual-circle", ritual_circle, 200, "dressing",
     ["dressing", "ritual", "lich"]),
]

# Pieces that genuinely need AI art. Recorded as gaps, never faked.
GAPS = [
    {"name": "skeleton",
     "reason": "A full articulated skeleton lying down needs AI art — "
               "procedural bones read as a pile, not a body.",
     "needs": "ai-image"},
    {"name": "chest",
     "reason": "A wooden chest from above needs AI art. The openable "
               "chest token already uses Foundry's built-in chest icon.",
     "needs": "ai-image"},
    {"name": "altar",
     "reason": "A ritual altar from above needs AI art.",
     "needs": "ai-image"},
]


def build_pack():
    os.makedirs(PACK_DIR, exist_ok=True)
    entries = []
    for name, fn, size, layer, tags in PACK:
        img = fn()
        fname = f"{name}.png"
        img.save(os.path.join(PACK_DIR, fname))
        entries.append({
            "name": name,
            "file": f"pack/{fname}",
            "sizePx": size,
            "layer": layer,
            "tags": tags,
        })
        print(f"wrote pack/{fname} ({size}x{size}, {layer})")
    manifest = {
        "version": 1,
        "tilePx": 100,
        "generated": "2026-11-19",
        "tiles": entries,
        "gaps": GAPS,
    }
    with open(os.path.join(TILES_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"wrote manifest.json ({len(entries)} tiles, {len(GAPS)} gaps)")


def preview():
    """Render a 6x6 sample room from the pack (floor + wall ring + a
    door + dressing + fog) to tiles/pack-preview.png, exactly the way
    the composer lays a room out. A visual check that the tiles read
    as a room; regenerate with `python3 generate_tiles.py --preview`."""
    from PIL import Image as _Image  # local alias to keep the top tidy
    pack = {name: fn() for name, fn, _, _, _ in PACK}
    W = H = 600
    room = _Image.new("RGBA", (W, H), (5, 5, 8, 255))
    random.seed(3)
    variants = ["plain"] * 6 + ["cracked"] * 3 + ["rubble"]
    for gy in range(6):
        for gx in range(6):
            room.paste(pack[f"floor-{random.choice(variants)}"].convert("RGBA"),
                       (gx * 100, gy * 100))

    def rot(img, deg):
        # PIL rotates counter-clockwise; negate for Foundry's clockwise degrees.
        return img.rotate(-deg, expand=False)

    straight, corner, door = (pack["wall-straight"], pack["wall-corner"],
                              pack["wall-door"])
    for gx in range(6):
        room.alpha_composite(rot(straight, 0), (gx * 100, 0))
        room.alpha_composite(
            rot(door if gx == 3 else straight, 180), (gx * 100, 500))
    for gy in range(6):
        room.alpha_composite(rot(straight, 270), (0, gy * 100))
        room.alpha_composite(rot(straight, 90), (500, gy * 100))
    for img, deg, x, y in [(corner, 0, 0, 0), (corner, 90, 500, 0),
                           (corner, 180, 500, 500), (corner, 270, 0, 500)]:
        room.alpha_composite(rot(img, deg), (x, y))
    room.alpha_composite(pack["bones"], (200, 200))
    room.alpha_composite(pack["rubble"], (400, 100))
    room.alpha_composite(pack["pillar"], (100, 300))
    room.alpha_composite(pack["ritual-circle"], (300, 300))
    room.alpha_composite(pack["fog-wisp-large"], (100, 100))
    out = os.path.join(TILES_DIR, "pack-preview.png")
    room.save(out)
    print(f"wrote pack-preview.png (6x6 sample room)")


if __name__ == "__main__":
    import sys
    if "--preview" in sys.argv:
        build_pack()
        preview()
    else:
        build_pack()
