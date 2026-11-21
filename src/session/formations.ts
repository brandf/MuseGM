/**
 * Formation helpers — pure geometry for cutscenes (FR-5).
 *
 * "Nine soldiers surround them" is one intent, not nine positions
 * enumerated by Muse. Muse writes the intent (ring of 9 around a
 * center); code expands it into concrete positions + facings. Every
 * function here is pure — no Foundry, no I/O — so it unit-tests with
 * no connection.
 *
 * Angles are Foundry token-rotation degrees: 0 = north (up, -y),
 * clockwise (90 = east, 180 = south, 270 = west). A position's
 * `facingDeg` is the rotation that points the token at the formation's
 * focus (the center for a ring, the direction of travel for a line,
 * the apex's facing for a wedge).
 */

export interface Point {
  x: number;
  y: number;
}

export interface FormationPosition extends Point {
  /** Token rotation (degrees, 0 = north, clockwise) facing the focus. */
  facingDeg: number;
}

export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * The rotation that faces `from` toward `to`, in Foundry degrees
 * (0 = north, clockwise). Assumes Foundry's convention (rotation 0
 * points up, increasing clockwise) — flag for live verification.
 */
export function angleToFace(from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return 0;
  // atan2(dx, -dy): angle from north (-y), clockwise.
  return normalizeAngle((Math.atan2(dx, -dy) * 180) / Math.PI);
}

/**
 * The screen angle from `from` toward `to`: 0 = east, clockwise in
 * screen coordinates (y down), raw atan2 range (-180, 180]. This is
 * the encounter-gen `Placement` convention — NOT Foundry token
 * rotation (see angleToFace). It lives here so both formation users
 * share one angle implementation instead of each keeping a local
 * copy; the formula is the raw atan2 (not a conversion from
 * angleToFace) because encounter-gen's demo output pins these numbers
 * exactly, and a round-trip through the north convention would change
 * the last bits. The live rotation convention is still unverified
 * either way — see the Placement doc in encounter-gen.ts.
 */
export function angleToEast(from: Point, to: Point): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

/**
 * N positions evenly spaced on a circle of `radius` around `center`,
 * each facing the center. Position 0 is at the top (north) by default;
 * `startAngleDeg` rotates the whole ring (degrees, same convention).
 */
export function ringPositions(
  count: number,
  center: Point,
  radius: number,
  opts: { startAngleDeg?: number } = {},
): FormationPosition[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`ring: count must be an integer >= 1, got ${count}`);
  }
  if (!(radius > 0) || !Number.isFinite(radius)) {
    throw new Error(`ring: radius must be a positive number, got ${radius}`);
  }
  const start = opts.startAngleDeg ?? -90;
  const out: FormationPosition[] = [];
  for (let i = 0; i < count; i++) {
    const deg = start + (360 * i) / count;
    const rad = (deg * Math.PI) / 180;
    const x = Math.round(center.x + radius * Math.cos(rad));
    const y = Math.round(center.y + radius * Math.sin(rad));
    out.push({ x, y, facingDeg: angleToFace({ x, y }, center) });
  }
  return out;
}

/**
 * N positions evenly spaced on the straight line from `from` to `to`
 * (inclusive of both ends), each facing along the line's direction
 * (toward `to`). With count 1, the single position is `from`.
 */
export function linePositions(
  count: number,
  from: Point,
  to: Point,
): FormationPosition[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`line: count must be an integer >= 1, got ${count}`);
  }
  const facingDeg = angleToFace(from, to);
  if (count === 1) return [{ x: from.x, y: from.y, facingDeg }];
  const out: FormationPosition[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    out.push({
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
      facingDeg,
    });
  }
  return out;
}

/**
 * A wedge (V) of N positions: the apex at `apex`, opening in
 * `directionDeg` (Foundry degrees, 0 = north), with `spreadDeg`
 * between the two arms and `spacing` px between ranks. Rank 0 is the
 * apex; each later rank adds one position per arm, so a wedge of
 * count N fills ranks until N positions exist. Every position faces
 * `directionDeg` (the wedge advances that way). `armOrder` picks
 * which arm fills first within a rank — "left-first" (default) is
 * the cutscene convention; "right-first" is the encounter-gen legacy
 * wedge, which filled the +perpendicular arm first.
 */
export function wedgePositions(
  count: number,
  apex: Point,
  directionDeg: number,
  opts: { spreadDeg?: number; spacing?: number; armOrder?: "left-first" | "right-first" } = {},
): FormationPosition[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`wedge: count must be an integer >= 1, got ${count}`);
  }
  const spread = opts.spreadDeg ?? 60;
  const spacing = opts.spacing ?? 100;
  if (!(spread > 0) || spread >= 180) {
    throw new Error(`wedge: spreadDeg must be in (0, 180), got ${spread}`);
  }
  if (!(spacing > 0) || !Number.isFinite(spacing)) {
    throw new Error(`wedge: spacing must be a positive number, got ${spacing}`);
  }
  if (opts.armOrder !== undefined && opts.armOrder !== "left-first" && opts.armOrder !== "right-first") {
    throw new Error(`wedge: armOrder must be "left-first" or "right-first", got ${opts.armOrder}`);
  }
  const dir = (directionDeg * Math.PI) / 180;
  const half = (spread / 2) * (Math.PI / 180);
  // Unit vectors along the two arms, in canvas coordinates (y down):
  // direction (dx, dy) for angle a (0 = north, clockwise) is
  // (sin a, -cos a).
  const arm = (sign: number): Point => {
    const a = dir + sign * half;
    return { x: Math.sin(a), y: -Math.cos(a) };
  };
  const left = arm(-1);
  const right = arm(1);
  const facingDeg = normalizeAngle(directionDeg);
  const out: FormationPosition[] = [{ x: apex.x, y: apex.y, facingDeg }];
  const arms = opts.armOrder === "right-first" ? [right, left] : [left, right];
  let rank = 1;
  while (out.length < count) {
    for (const vec of arms) {
      if (out.length >= count) break;
      out.push({
        x: Math.round(apex.x + vec.x * spacing * rank),
        y: Math.round(apex.y + vec.y * spacing * rank),
        facingDeg,
      });
    }
    rank++;
  }
  return out;
}
