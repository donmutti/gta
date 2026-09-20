/**
 * Where a wild tree may not be planted.
 *
 * `clearance.js` owns "how to stay off a road". This owns the other half of the same question: given
 * a point that is on neither tarmac nor a building, is there already something standing there? The
 * city dresses itself in half a dozen independent passes — decor, parks, street furniture, trees —
 * and every one of them scatters from its own source data, so nothing stops two of them choosing the
 * same square metre. The result was trees growing out of the Alzette, through the amphitheatre rings
 * in the Parc Municipal, and inside bus shelters.
 *
 * The fix is deliberately ONE function with ONE list rather than six tests scattered down
 * `scene.js`, because the interesting thing about this rule is not any single entry in it: it is that
 * the next person to add a prop type has one obvious place to register it and will not have to
 * discover five others. Everything here reduces to two primitives — a disc you may not stand in, and
 * a water polygon you may not stand in or beside.
 *
 * Nothing in here knows about trees specifically. It is a spatial question about points.
 */

/** Cell size for the broad phase, in metres. Comfortably larger than the biggest exclusion disc. */
const CELL = 16;

/**
 * How much daylight each kind of thing wants around it, in metres, measured from its OWN geometry
 * rather than guessed. The numbers below are read off the builders:
 *
 *  - `cafe` 3.0 — `decor.js` gives a terrace a parasol with a 1.25 m canopy cone plus a table 1.17 m
 *    to one side, and jitters the whole thing up to 0.8 m off the surveyed node before shoving it
 *    clear of the kerb. 3 m covers the terrace wherever it ended up.
 *  - `fountain` 4.6 — a 2.6 m basin with a rim torus at 2.56 (`decor.js`), plus two metres of apron.
 *    People stand round a fountain; a tree in the splash zone is the most obvious fault on the list.
 *  - `monument` 4.0 — a 1.6 m square plinth (1.13 m to its corner) carrying a 2.6 m column. The
 *    whole point of a monument is that you can see it, so it gets the most daylight of the decor.
 *  - `postbox` 1.2 — a 0.42 x 0.30 box on a leg, 0.26 m to its corner, plus about a metre. It is
 *    small and it is meant to be next to things; this only stops a trunk growing through it.
 *
 * The street furniture radii come from `streetprops.js` in the same way: half the widest footprint
 * plus roughly a metre of daylight. `shelter` is the one that matters — a 2.6 x 1.3 m glass box, so
 * 1.46 m to its corner — because a tree inside a bus shelter is the same class of fault as a tree in
 * a fountain, and `bollard` is the one that matters least.
 */
export const SITE_CLEAR = {
  cafe: 3.0, fountain: 4.6, monument: 4.0, postbox: 1.2,
  shelter: 2.6, bench: 1.8, bike: 2.0, planter: 1.6,
  bin: 1.1, sign: 1.0, hydrant: 1.0, bollard: 0.9,
};

/** Inside a water polygon is the river; within this of its edge is the bank. Both are unplantable. */
const BANK = 2.5;

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Squared distance from (x, y) to the segment (ax, ay)-(bx, by). */
function segDist2(x, y, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const vv = vx * vx + vy * vy;
  const t = vv ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / vv)) : 0;
  const dx = ax + vx * t - x, dy = ay + vy * t - y;
  return dx * dx + dy * dy;
}

/** A uniform cell hash. Items are inserted over the bounding box they influence. */
class CellIndex {
  constructor() { this.cells = new Map(); }
  insert(minX, minY, maxX, maxY, item) {
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) {
        const k = `${cx}:${cy}`;
        const b = this.cells.get(k);
        if (b) b.push(item); else this.cells.set(k, [item]);
      }
    }
  }
  at(x, y) { return this.cells.get(`${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`); }
}

/**
 * Build the exclusion set for this world.
 *
 * `keepClear` is whatever `buildParks` published on its group (`userData.keepClear`) — the parks
 * author's own list of discs over playground compartments, fountains, amphitheatre rings, cafe
 * terraces and ponds. `furniture` is the prop list `buildStreetFurniture` hands back, so the caller
 * has to have placed the furniture BEFORE it plants trees; if it has not, this silently excludes
 * nothing, which is why `counts` exists.
 *
 * Returns `{plantable, inWater, counts, discs}`:
 *  - `plantable(x, y)` — the whole test. False if the point is in water, on a bank, or inside any
 *    exclusion disc.
 *  - `inWater(x, y)` — the water half alone, for points that are surveyed fact rather than ours to
 *    place. A mapped tree standing where we invented a bus shelter is the shelter's fault, not the
 *    tree's, but a mapped tree in the middle of the Alzette is wrong however it got there.
 *  - `counts` — what each exclusion rejected, so "it works" can be a number. A pass that rejects
 *    nothing and a pass that rejects everything look identical from a screenshot of one street.
 */
export function createSiting(world, {keepClear = [], furniture = []} = {}) {
  const discs = new CellIndex();
  let n = 0;
  const add = (x, y, r, why) => {
    if (!(r > 0)) return;
    discs.insert(x - r, y - r, x + r, y + r, {x, y, r2: r * r, why});
    n++;
  };

  for (const d of keepClear) add(d.x, d.y, d.r, 'park');
  for (const [x, y] of (world.cafes ?? [])) add(x, y, SITE_CLEAR.cafe, 'decor');
  for (const [x, y] of (world.fountains ?? [])) add(x, y, SITE_CLEAR.fountain, 'decor');
  for (const [x, y] of (world.monuments ?? [])) add(x, y, SITE_CLEAR.monument, 'decor');
  for (const [x, y] of (world.postboxes ?? [])) add(x, y, SITE_CLEAR.postbox, 'decor');
  for (const p of furniture) add(p.x, p.y, SITE_CLEAR[p.kind] ?? 1.0, 'furniture');

  // Water is kept as geometry rather than discs: a disc big enough to cover the Alzette would wipe
  // out half the Grund.
  //
  // But not every entry in `world.water` is a body. Two of the sixteen are the Alzette and the
  // Pétrusse traced as open waterway LINES, and the shape you get by closing them has an area of
  // 26 million and 206 million square metres — `scene.js` already refuses to draw those as puddles
  // for exactly this reason, with exactly this test. Running point-in-polygon on an open line is
  // worse than useless: the implicit closing edge sweeps most of the map, and the first version of
  // this file threw away 9,327 trees "in the river", nearly all of them standing on dry hillside.
  //
  // So a genuine closed body excludes its INTERIOR and its bank — that is the pond, and the bank is
  // the thing Dmitrii actually asked for. A river line excludes only a narrow corridor along the
  // line itself, which is all an untraced width entitles it to.
  const bodies = [], lines = [];
  for (const pts of (world.water ?? [])) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, a2 = 0;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    for (let i = 0; i < pts.length - 1; i++) a2 += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
    const body = (maxX - minX) < 1500 && (maxY - minY) < 1500 && Math.abs(a2 / 2) < 50000;
    (body ? bodies : lines).push({pts, minX, minY, maxX, maxY});
  }
  // Both kinds contribute their edges to the bank index; only bodies contribute an interior.
  const banks = new CellIndex();
  for (const w of bodies.concat(lines)) {
    for (let i = 1; i < w.pts.length; i++) {
      const [ax, ay] = w.pts[i - 1], [bx, by] = w.pts[i];
      banks.insert(Math.min(ax, bx) - BANK, Math.min(ay, by) - BANK,
                   Math.max(ax, bx) + BANK, Math.max(ay, by) + BANK, [ax, ay, bx, by]);
    }
  }

  const counts = {water: 0, park: 0, decor: 0, furniture: 0, discs: n,
                  waterBodies: bodies.length, waterLines: lines.length};

  const inWater = (x, y) => {
    for (const w of bodies) {
      if (x < w.minX - BANK || x > w.maxX + BANK || y < w.minY - BANK || y > w.maxY + BANK) continue;
      if (inPoly(x, y, w.pts)) return true;
    }
    const near = banks.at(x, y);
    if (near) for (const [ax, ay, bx, by] of near) {
      if (segDist2(x, y, ax, ay, bx, by) < BANK * BANK) return true;
    }
    return false;
  };

  return {
    counts,
    discCount: n,
    inWater(x, y) {
      if (!inWater(x, y)) return false;
      counts.water++;
      return true;
    },
    plantable(x, y) {
      if (inWater(x, y)) { counts.water++; return false; }
      const bucket = discs.at(x, y);
      if (bucket) for (const d of bucket) {
        const dx = x - d.x, dy = y - d.y;
        if (dx * dx + dy * dy < d.r2) { counts[d.why]++; return false; }
      }
      return true;
    },
  };
}
