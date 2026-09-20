/**
 * Keeping things off the tarmac.
 *
 * Every roadside object in this city is placed by one of two moves: offset from a road's centreline,
 * or dropped at a surveyed coordinate. Both put objects in live traffic lanes, for the same underlying
 * reason — the carriageway WIDTHS are ours, invented per highway class in `ROAD_KINDS`, while the
 * points and the junctions are real. A 12 m primary painted over a real 7 m street swallows whatever
 * stood beside it, and an offset computed against one edge knows nothing about the wide road crossing
 * it, so junctions collect props in their middle.
 *
 * This module is the one place that knows how to get out of a road, so the knowledge does not end up
 * copied into `scene.js`, `decor.js` and `parks.js` in three versions that drift. It owns no data and
 * no geometry: every function takes the world and returns coordinates.
 *
 * It always defers to `world.onRoad` (`src/world/model.js`) for the actual test, which honours the
 * per-road `width` overrides that `tools/unblock-roads.mjs` wrote and has its own broad phase. There
 * is deliberately no second width table in here.
 */

/** Metres of daylight demanded between a kerb and anything standing beside it. */
export const PROP_CLEAR = 0.5;
/** Furthest past its own kerb a prop may be pushed before we give up on the spot. */
export const PROP_REACH = 3.5;
const PROP_STEP = 0.5;

/** Is (x, y) inside a building footprint? Pushing something out of a road must not post it indoors. */
export function inFootprint(world, x, y) {
  for (const b of world.grid.near(x, y, 2)) {
    const {minX, minY, maxX, maxY} = b.aabb;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    let inside = false;
    for (let i = 0, j = b.pts.length - 1; i < b.pts.length; j = i++) {
      const [xi, yi] = b.pts[i], [xj, yj] = b.pts[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/**
 * A clear pavement spot beside edge `e`, or null if there is none.
 *
 * For the offset-from-centreline case, where the caller knows which road the prop belongs to. Walks
 * outward only as far as it must, tries the other kerb before giving up, and returns null rather than
 * placing badly — a missing bollard nobody notices, a bollard in a lane is a collision.
 *
 * (px, py) is the point on the centreline, (nx, ny) the segment's unit left normal, `side` the kerb to
 * try first, `base` the offset the caller wanted. Returns [x, y, side] so the caller can yaw the prop
 * toward the carriageway it actually ended up beside.
 */
export function propSpot(world, e, px, py, nx, ny, side, base) {
  const limit = e.width / 2 + PROP_REACH;
  for (const s of [side, -side]) {
    for (let off = base; off <= limit; off += PROP_STEP) {
      const sx = px + nx * off * s, sy = py + ny * off * s;
      if (world.onRoad(sx, sy, PROP_CLEAR)) continue;
      if (inFootprint(world, sx, sy)) continue;
      return [sx, sy, s];
    }
  }
  return null;
}

/**
 * Move a point out of the carriageway it is standing in, or null if it cannot be freed.
 *
 * For the surveyed case, where the object is a bare coordinate with no road of its own: a mapped tree,
 * a mapped lamp, a junction's traffic signal. Dropping those is the wrong lever, because the point is
 * surveyed fact and the width that swallowed it is our invention — so the object moves to the nearest
 * kerb and is kept. This is the same argument, and nearly the same arithmetic, as
 * `tools/unblock-roads.mjs` applies to building footprints.
 *
 * It pushes straight out of whichever road it is deepest inside, which is the shortest way to daylight,
 * and repeats a few times because a point pushed clear of one street can land in another.
 */
export function shoveClear(world, x, y, want = PROP_CLEAR, cap = 9) {
  if (!world.onRoad(x, y, want)) return [x, y];
  let bx = x, by = y;
  for (let pass = 0; pass < 4; pass++) {
    let worst = null;
    for (const e of world.edges) {
      if (!e.width) continue;
      const hw = e.width / 2 + want;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const [ax, ay] = e.pts[i], [cx, cy] = e.pts[i + 1];
        const dx = cx - ax, dy = cy - ay, l2 = dx * dx + dy * dy || 1;
        let t = ((bx - ax) * dx + (by - ay) * dy) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + t * dx, py = ay + t * dy;
        const over = hw - Math.hypot(bx - px, by - py);
        if (over > 0 && (!worst || over > worst.over)) {
          let ux = bx - px, uy = by - py, n = Math.hypot(ux, uy);
          // A point exactly on the centreline has no outward direction of its own; use the segment's
          // normal so the push is still well defined rather than dividing by zero.
          if (n < 1e-6) { const L = Math.hypot(dx, dy) || 1; ux = -dy / L; uy = dx / L; n = 1; }
          worst = {over, ux: ux / n, uy: uy / n};
        }
      }
    }
    if (!worst) return inFootprint(world, bx, by) ? null : [bx, by];
    const step = worst.over + 0.1;
    if (Math.hypot(bx + worst.ux * step - x, by + worst.uy * step - y) > cap) return null;
    bx += worst.ux * step; by += worst.uy * step;
  }
  return world.onRoad(bx, by, want) || inFootprint(world, bx, by) ? null : [bx, by];
}
