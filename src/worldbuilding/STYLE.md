# Map style bible — TestBed dungeon

Every map piece generated for this dungeon must match this style. It is the
visual contract: paste the Style block verbatim into every generation prompt,
and pass the previous room's image as a reference so the model keeps the
palette and line work instead of re-rolling them.

## Reference look

The established look is `test-map.png` (the fog-and-bones entry hall, Nov 19):
cold blue-grey stone, warm amber torch pools, bone white, charcoal walls.

## Style (paste verbatim into every prompt)

- Strict top-down plan view, seen directly from above. No front-on or
  perspective elements — nothing standing up, nothing lying flat that
  should be vertical. Doors are a gap in the wall with the leaf flat from
  above, hinged at one side, plus a thin dashed quarter-circle swing arc.
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
