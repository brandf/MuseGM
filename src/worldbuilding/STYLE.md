# Map style bible — TestBed dungeon

Every map piece generated for this dungeon must match this style. It is the
visual contract: paste the Style block verbatim into every generation prompt,
and pass the previous room's image as a reference so the model keeps the
palette and line work instead of re-rolling them.

## Reference look

The established look is `test-map.png` (the fog-and-bones entry hall, Nov 19):
cold blue-grey stone, warm amber torch pools, bone white, charcoal walls.

## Style (paste verbatim into every prompt)

- **Walls have height (Zelda-style, Nov 20 — overturns the old strict top-down rule):** the floor is top-down, but the walls are drawn with a visible face — stone block courses, shaded, with real depth, like the original Zelda dungeons. The north wall shows its face receding; side walls show their faces; corners are solid masonry. The reference is `maps/lichs-lair-entry-hall.png` (Nov 19): wall faces with depth, rich pavers with moss in the cracks, rubble, broken columns, skeletons and scattered bones, green fog pools, torch sconces, an iron-bound double door. A room must read as a place, not a diagram. Wall variety is required — straight, corner (inner/outer), diagonal, broken/rubble-topped, sconce, carved — so the pack can build interesting rooms, not vanilla squares.
- Doors are a gap in the wall with the leaf flat from above, hinged at one side, plus a thin dashed quarter-circle swing arc — unless the door is a feature door (like the lair's iron-bound double door), which is drawn with full detail.

## Layering (Nov 20 — base tiles are clean, props are free sprites)

- **Base tiles carry structure only, never objects.** A floor tile is just floor: stone texture (grain, wear, mottling, cracks in the stone, moss in the cracks) — no bones, rubble piles, skulls, or chests baked in. A wall tile is just masonry face — no sconces or torches baked in. Texture is surface detail of the material; objects are things sitting on it, and objects are never baked into a base tile.
- **Props are independent sprites.** Bones, chests, treasure, bookshelves, rubble piles, broken columns, skeletons, altars, ritual circles, sconces — each its own image, placeable freely, not grid-locked. They can sit at any position, any size, overlapping tile boundaries.
- **Macro pieces (Nov 20):** chunkier multi-square assemblies (2x2, 3x3, long wall runs) with internal variation and interesting shape — even round shapes (circular dais, round pool, curved wall). A piece aligns to the grid at the macro level (its bounding box snaps to the grid); inside the piece the shapes are free-form. The grid is a placement frame, not a shape constraint.
- **Walls in Foundry are drawn lines.** The wall lines are drawn separately as line segments in Foundry, so the wall art and the collision lines are separate concerns — the art's job is to line up with where the lines go.
- Hand-drawn tabletop map line work: dark outlines, visible square tile
  grid, cracked stone tiles, scattered rubble.
- Palette: cold blue-grey stone floor and walls; warm amber torch glow in
  small pools; bone off-white; near-black beyond the walls. Muted,
  desaturated, torchlit — never bright, never saturated, never cartoon-clean.
- Fog: **green eerie smoke** — translucent green-grey wisps drifting across the floor, pooling in corners and curling around objects. (Nov 19: the first fog version read as plain grey-white smoke; the dungeon's fog is green and eerie.) Fog is atmosphere, not a whiteout — the floor and its contents stay readable through it.
- Light: two or so small glowing torch circles on the walls; warm pools of
  light that fade into the cold ambient. No sun, no sky, no daylight.
- No text, no labels, no compass, no borders or frames.

## Theme evolution (deliberate, not drift)

The dungeon's theme moves along a gradient, room by room — each room keeps
the Style above and changes only what its place in the arc calls for:

1. Entry hall (done): fog + bones, the baseline.
2. Deeper rooms: fog thickens, bones give way to older remains, torchlight
   gets sparser and colder.
3. Lich's lair: the coldest, darkest room — fog at its thickest, bones
   replaced by ritual marks, one cold light source instead of warm torches.

When a new room is requested, name where it sits on this arc and what
changes — never let the style change by accident. If a generation comes
back off-style, regenerate it against this file rather than accepting the
drift.
