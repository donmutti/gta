#!/usr/bin/env node
// Shove buildings out of the roadway.
//
// The footprints are real OSM; the road WIDTHS are ours, invented per highway class. Where a narrow
// real street was given a 9 or 12 metre carriageway, the ribbon we paint swallows the buildings
// along it — so you drive round a corner and meet a house standing in the middle of the road.
//
// The fix moves the building rather than deleting it (the city fabric is the real thing worth
// keeping) and rather than narrowing the street (which the simulation also drives and parks on).
// Each offending footprint is translated bodily along the outward normal of the road it intrudes
// into, far enough to clear the kerb plus a margin. Repeated a few times because a building pushed
// clear of one street can land in another; buildings that cannot be freed are reported, not hidden.
//
// Run:  node tools/unblock-roads.mjs        (rewrites public/data/city.json)
import {readFileSync, writeFileSync} from 'node:fs';

const FILE = 'public/data/city.json';
const city = JSON.parse(readFileSync(FILE, 'utf8'));

// Must match ROAD_KINDS in src/world/model.js — the widths the game actually paints and drives.
const W = {
  motorway: 14, trunk: 13, primary: 12, secondary: 10, tertiary: 9,
  residential: 7, unclassified: 7, living_street: 6, service: 4.5, pedestrian: 4,
};
const MARGIN = 0.6;      // metres of daylight between kerb and wall once moved
const TRIGGER = 0.4;     // ignore intrusions smaller than this; they read as flush frontage
const PASSES = 6;
// A building hemmed in by streets on several sides bounces between them and, left alone, ends up
// flung tens of metres across the block — which wrecks the real city far worse than the overlap it
// was fixing. Anything that cannot be freed within this budget is put back exactly where it was.
const MAX_SHIFT = Number(process.env.MAX_SHIFT ?? 6);

const segs = [];
for (const r of city.roads) {
  const hw = (W[r.kind] ?? 0) / 2;
  if (!hw) continue;
  for (let i = 0; i < r.pts.length - 1; i++) segs.push({a: r.pts[i], b: r.pts[i + 1], hw});
}

// uniform grid over the segments so each footprint only tests its own neighbourhood
const G = 40;
const cells = new Map();
const key = (i, j) => `${i}:${j}`;
for (const s of segs) {
  const x0 = Math.min(s.a[0], s.b[0]), x1 = Math.max(s.a[0], s.b[0]);
  const y0 = Math.min(s.a[1], s.b[1]), y1 = Math.max(s.a[1], s.b[1]);
  for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++) {
    for (let j = Math.floor(y0 / G); j <= Math.floor(y1 / G); j++) {
      const k = key(i, j);
      const bucket = cells.get(k);
      if (bucket) bucket.push(s); else cells.set(k, [s]);
    }
  }
}

/** Deepest intrusion of this footprint into any carriageway, and the way out. */
function worstIntrusion(pts) {
  let best = null;
  for (const [x, y] of pts) {
    const ci = Math.floor(x / G), cj = Math.floor(y / G);
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        const bucket = cells.get(key(i, j));
        if (!bucket) continue;
        for (const s of bucket) {
          const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
          const l2 = dx * dx + dy * dy || 1;
          let t = ((x - s.a[0]) * dx + (y - s.a[1]) * dy) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = s.a[0] + t * dx, py = s.a[1] + t * dy;
          const d = Math.hypot(x - px, y - py);
          const over = s.hw - d;
          if (over > 0 && (!best || over > best.over)) {
            // push straight out from the centreline; if the vertex sits exactly on it, use the
            // segment's own normal so the direction is still well defined
            let nx = x - px, ny = y - py, n = Math.hypot(nx, ny);
            if (n < 1e-6) { const L = Math.hypot(dx, dy) || 1; nx = -dy / L; ny = dx / L; n = 1; }
            best = {over, dirX: nx / n, dirY: ny / n};
          }
        }
      }
    }
  }
  return best;
}

let moved = 0, reverted = 0, totalShift = 0, maxShift = 0;
for (const b of city.buildings) {
  const original = b.pts.map(p => [p[0], p[1]]);
  let shifted = 0, freed = true;
  for (let pass = 0; pass < PASSES; pass++) {
    const hit = worstIntrusion(b.pts);
    if (!hit || hit.over < TRIGGER) break;
    const step = hit.over + MARGIN;
    if (shifted + step > MAX_SHIFT) { freed = false; break; }
    for (const p of b.pts) { p[0] += hit.dirX * step; p[1] += hit.dirY * step; }
    shifted += step;
  }
  if (!freed || (worstIntrusion(b.pts)?.over ?? 0) >= TRIGGER) {
    // put it back rather than leave it displaced AND still in the road
    b.pts.forEach((p, i) => { p[0] = original[i][0]; p[1] = original[i][1]; });
    if (shifted > 0) reverted++;
    continue;
  }
  if (shifted > 0) {
    moved++;
    totalShift += shifted;
    if (shifted > maxShift) maxShift = shifted;
  }
}

// ---------------------------------------------------------------------------------------------
// Step 2: the hemmed-in ones. A footprint with streets on several sides cannot be moved anywhere —
// every direction is another road — so for those the honest lever is the other one: the width. The
// footprint is surveyed fact, the carriageway width is our invention per highway class, so we
// narrow the specific road until the real building is outside it. Floored at MIN_ROAD so a street
// never becomes undriveable, and stored per road as an override the model prefers over the class
// default.
const MIN_ROAD = 3.4;   // Luxembourg old-town lanes really are this tight
let narrowed = 0;
const stillIn = city.buildings.filter(b => (worstIntrusion(b.pts)?.over ?? 0) >= TRIGGER);
for (const b of stillIn) {
  for (const r of city.roads) {
    const hw = ((r.width ?? W[r.kind]) ?? 0) / 2;
    if (!hw) continue;
    let need = hw;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], c2 = r.pts[i + 1];
      const dx = c2[0] - a[0], dy = c2[1] - a[1], l2 = dx * dx + dy * dy || 1;
      for (const [x, y] of b.pts) {
        let t = ((x - a[0]) * dx + (y - a[1]) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = a[0] + t * dx, py = a[1] + t * dy;
        const d = Math.hypot(x - px, y - py);
        if (d < hw) need = Math.min(need, d - MARGIN);   // this road clips the building
      }
    }
    if (need < hw) {
      const w = Math.max(MIN_ROAD, need * 2);
      if (!r.width || w < r.width) { r.width = +w.toFixed(2); narrowed++; }
    }
  }
}
// rebuild the segment index with the narrowed widths so the verification below is honest
segs.length = 0;
cells.clear();
for (const r of city.roads) {
  const hw = ((r.width ?? W[r.kind]) ?? 0) / 2;
  if (!hw) continue;
  for (let i = 0; i < r.pts.length - 1; i++) segs.push({a: r.pts[i], b: r.pts[i + 1], hw});
}
for (const s of segs) {
  const x0 = Math.min(s.a[0], s.b[0]), x1 = Math.max(s.a[0], s.b[0]);
  const y0 = Math.min(s.a[1], s.b[1]), y1 = Math.max(s.a[1], s.b[1]);
  for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++) {
    for (let j = Math.floor(y0 / G); j <= Math.floor(y1 / G); j++) {
      const k = key(i, j);
      const bucket = cells.get(k);
      if (bucket) bucket.push(s); else cells.set(k, [s]);
    }
  }
}

writeFileSync(FILE, JSON.stringify(city));

// verify against the freshly written data
let remaining = 0;
for (const b of city.buildings) {
  const hit = worstIntrusion(b.pts);
  if (hit && hit.over >= TRIGGER) remaining++;
}
console.log(`narrowed ${narrowed} road(s) around buildings that could not be moved`);
console.log(`moved ${moved} buildings out of the roadway`);
console.log(`  average shift ${(totalShift / Math.max(1, moved)).toFixed(2)}m, largest ${maxShift.toFixed(2)}m`);
console.log(`  left in place (hemmed in, could not be freed within ${MAX_SHIFT}m): ${reverted}`);
console.log(`  still intruding overall: ${remaining} of ${city.buildings.length}`);
