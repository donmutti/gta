#!/usr/bin/env node
// Open up the passages so a street and its two pavements actually fit between the walls.
//
// The sibling tool, unblock-roads.mjs, solves the gross version of this: a building standing IN the
// carriageway. It succeeds, and then stops — its test is "is this footprint inside the tarmac", and
// the tarmac is only the middle of a street. scene.js also lays a pavement down each side,
// walkWidth = clamp(width * 0.30, 1.2, 3.6) metres of it, and nothing has ever checked that the
// pavement has anywhere to go. So the city is full of streets that are legal by the old test and
// wrong to look at: the kerb line runs into a wall, the footway is a 40cm skirting board, and in the
// tightest lanes you drive down a slot with no pavement at all on either side.
//
// WHAT "COMFORTABLE" MEANS HERE
//
// A street fits when, on EACH side of its centreline, the nearest wall stands at least
//
//     width/2  +  walkWidth(width)  +  DAYLIGHT
//
// away. Per side, not summed: the ribbon is centred on the OSM polyline and this tool does not move
// polylines (the 446 parcels in city.json are cut from them), so 20 metres of room is no use to a
// street if 4 of them are on the left and 16 on the right.
//
// DAYLIGHT is 0.5m and that is deliberately small. scene.js lets a pavement's far edge run under a
// building — in a real old town the footway meets the frontage, and flush is correct, not a fault. So
// the half metre is not for looks; it buys float tolerance so no wall ever crosses the kerb LINE
// itself, and a strip for the lamps, postboxes, bins and cafe tables the decor modules stand on the
// pavement. More than that and we would be prising Luxembourg's old town apart to fix nothing.
//
// Corridors that rule gives, per class:  primary 20.2  secondary 17.0  tertiary 15.4
// residential/unclassified 12.2  living_street 10.6  service 8.2  pedestrian 5.0 (paved edge to
// edge, so no pavement to find room for).
//
// WHY THERE IS NO 4m-VERSUS-8m JUDGEMENT CALL TO MAKE
//
// Measured first, decided after. Over the 9,593 samples where both sides are walled within 20m, the
// wall-to-wall passage runs p5 7.1m, p25 12.0m, p50 17.1m, p90 26.3m; 224 are under 6m, 708 under 8m,
// 2,423 under 12m. Picking a flat "narrow means under N metres" out of that would have been a guess,
// and the wrong shape of answer anyway — 12m is roomy for a back lane and mean for a boulevard.
// Scored against the per-class rule above instead, the whole fault population turns out to be ONE
// band: 7,026 of 43,946 samples short, median 1.32m, p90 2.77m, worst 4.73m, and only 36 samples in
// the whole city short by 4m or more. That is unblock-roads' fingerprint — it already shoved every
// footprint clear of the tarmac, so what is missing city-wide is exactly a pavement's worth of room
// and never more. Hence no threshold to argue about: fix everything above TRIGGER, and a 5m shift cap
// is provably enough to reach all of it.
//
// TWO LEVERS, AND WHICH ONE IS HONEST WHERE
//
// A passage can be tight because the walls are close, or because the width we invented for that
// street is absurd. Both get used.
//
//  1. MOVE THE WALL. Translate the footprint along the road's outward normal, unblock-roads' move,
//     against the corridor instead of the carriageway. This is the preferred lever because the
//     deficits along one side of one street are near-uniform (Avenue de la Liberte measures 5.8,
//     5.9, 6.2, 6.2 down its pinched side), so the whole frontage translates together and the street
//     still reads as a straight terrace. The call, quoted: "You may deviate from OSM."
//
//  2. RE-DERIVE THE WIDTH. unblock-roads writes per-road `width` overrides, and 140 roads carry one.
//     They are the other half of the same problem and they are in tension with this tool: it
//     narrowed streets to save buildings, this widens gaps to save streets. They are NOT undone
//     wholesale. What they are is stale — each was set from the worst single building anywhere along
//     the road, which is how the Pont Grande-Duchesse Charlotte, a bridge, ended up 3.4m wide, and
//     how a 12m arterial ends up a slot because of one house 300m away. So after the wall pass every
//     override is recomputed from the walls that now exist: raised toward the class default where
//     there is room (measured from the road's TIGHTEST point, so raising can never put a building
//     back in the road), lowered only where a wall could not be moved, floored at unblock-roads'
//     MIN_ROAD so nothing becomes undriveable. Roads with no override are left at their class
//     default unless a wall defeated us.
//
//     The deepest cuts this makes look alarming and are not. Avenue de la Liberte goes 12m -> 6.7m,
//     and Avenue de la Liberte is all THIRTEEN of its ways flagged oneway: OSM has it as a dual
//     carriageway, one polyline per direction, so painting a 12m primary ribbon on each half was
//     drawing the street twice. The walls know the truth and the measurement finds it. Same story on
//     Avenue Monterey, Boulevard d'Avranches and Boulevard Roosevelt, which are all part-oneway.
//
// WHAT IS DELIBERATELY NOT TOUCHED
//
// 453 samples have the centreline INSIDE a building, and those are left alone whatever their corridor
// measures: either the road is a covered way, or the footprint and the polyline disagree so badly
// that no 5m nudge helps — unblock-roads already tried those and reverted them.
//
// Separately, every road whose name begins Pont / Tunnel / Viaduc / Passerelle / Passage is exempt
// from both levers in the destructive direction — see STRUCTURE below for why a flat world cannot
// tell a bridge from a collision.
//
// Centrelines are never moved, so the 446 parcels (cut from centrelines, blind to footprints and to
// width — see the header of tools/parcels.mjs) stay valid. Do not re-run parcels.mjs after this.
//
// RUN IT ONCE, AND AGAINST FETCHED DATA
//
// The schedule at the bottom converges. Raising ROUNDS to 3, 4 or 6 produces a byte-identical
// city.json, so no further internal round reaches anything the two rounds missed. A second
// INVOCATION is a different matter, and it is not idempotent: it clears about 95 more samples, but
// it does so by handing every footprint a fresh MAX_SHIFT budget, and the three worst then finish
// 6.8m from where OSM put them. That 5m cap is the promise this tool makes about how far the city
// may drift from the survey, and running the tool twice breaks it quietly, with nothing in the
// output to say so. If the result is not good enough, change a constant and re-run from the
// FETCHED city.json — never from one that has already been widened.
//
// Run:  node tools/widen-passages.mjs          (rewrites public/data/city.json)
//       node tools/widen-passages.mjs --dry    (measure and report, write nothing)

import {readFileSync, writeFileSync} from 'node:fs';
// The width table is imported, not copied. tools/unblock-roads.mjs keeps its own duplicate of it and
// that duplication is already a live drift hazard in this codebase; a third copy would make it a
// certainty. model.js is pure by contract — no imports of its own, no Three.js — so a node tool can
// read it directly.
import {ROAD_KINDS} from '../src/world/model.js';

const FILE = 'public/data/city.json';
const DRY = process.argv.includes('--dry');
const city = JSON.parse(readFileSync(FILE, 'utf8'));

/** The pavement rule, from src/render/scene.js:539. Duplicated because scene.js pulls in Three.js
 *  and cannot be imported by a node tool; it is two lines and scene.js is the source of truth. */
const walkWidth = (w) => Math.max(1.2, Math.min(3.6, w * 0.30));

const DAYLIGHT = 0.5;      // metres of wall-to-pavement-edge tolerance; argued above
const TRIGGER = 0.25;      // shortfalls under this read as flush frontage, not as a fault
const PASSES = 5;          // a wall pushed clear of one corridor can land in another
const MAX_SHIFT = 5;       // the worst measured deficit is 3.93m, so this reaches all of it
const MIN_ROAD = 3.4;      // unblock-roads' floor. Luxembourg old-town lanes really are this tight
const RAISE_EPS = 0.3;     // do not rewrite an override to gain less than this
// A footprint pushed off the street lands in the back of its own block, where dense old-town terraces
// already share and slightly overlap walls, so some interpenetration has to be tolerated or nothing
// in the old town can move at all. Deeper than this and the push is refused and the street is left to
// lever 2. Swept, not guessed: at 1.5m the guard blocks 996 pushes and 1,068 samples stay short; at
// 3m it blocks 283 and 841 stay short, and 61 fewer roads have to be narrowed; at 6m only 17 more
// samples clear. 3 is the knee — past it we would be burying buildings in each other for nothing.
const OVERLAP_TOL = Number(process.env.OVERLAP_TOL ?? 3);
const EDGE_STEP = 2;       // metres; a long flush wall has no vertex near the road, so subdivide it
const SAMPLE_STEP = 3;     // metres; centreline sampling for the measurement and the width pass
const RAY = 26;            // metres; ray budget when measuring clearance. Beyond this it is not a passage

const roadWidth = (r) => r.width ?? ROAD_KINDS[r.kind]?.width ?? 0;
const pedZone = (kind) => !!ROAD_KINDS[kind]?.pedestrianZone;

// A bridge deck, a tunnel bore and a covered arcade are at a DIFFERENT LEVEL from the footprints
// around them, so a tool reading only x and y sees a conflict where there is none: the Pont
// Grande-Duchesse Charlotte crosses the Pfaffenthal above the houses in it, the Tunnel Rene Konen
// runs under the Petrusse, and the Passage de l'Hotel de Ville is a hole THROUGH a building that is
// supposed to be there. The world is flat today (TERRAIN_ENABLED = false in src/world/terrain.js) so
// that separation is not in the geometry, and fetch-city.mjs keeps only highway/name/oneway — the OSM
// bridge=yes and tunnel=yes tags never reach city.json. Luxembourg's street names are the only signal
// left, and they are explicit about it.
//
// Such a road is exempt from BOTH levers in the destructive direction: its corridor never moves a
// wall (widening an arcade means punching a hole in a building, and prising the Pfaffenthal apart
// fixes nothing), and its width is never narrowed. It may still be RAISED where the walls genuinely
// allow it, which is how Pont de Clausen gets its 12m back. Where it cannot, it is reported by name.
const STRUCTURE = /^(Pont|Tunnel|Viaduc|Passerelle|Passage)\b/i;
const structural = (r) => !!r.name && STRUCTURE.test(r.name);
/** Half the corridor a road needs on each side: carriageway, pavement, daylight. */
const halfCorridor = (r) => {
  const w = roadWidth(r);
  return w / 2 + (pedZone(r.kind) ? 0 : walkWidth(w)) + DAYLIGHT;
};

// --- spatial indexes ---------------------------------------------------------------------------
// Two grids, because the two passes ask opposite questions. The ROAD grid answers "which corridors
// is this footprint in" (the wall pass, iterating buildings). The BUILDING grid answers "where is
// the nearest wall from here" (the measurement and the width pass, iterating centrelines).
const G = 40;
const key = (i, j) => `${i}:${j}`;

function gridOf(cellSize) {
  const cells = new Map();
  return {
    add(x0, y0, x1, y1, item) {
      for (let i = Math.floor(x0 / cellSize); i <= Math.floor(x1 / cellSize); i++) {
        for (let j = Math.floor(y0 / cellSize); j <= Math.floor(y1 / cellSize); j++) {
          const k = key(i, j), bucket = cells.get(k);
          if (bucket) bucket.push(item); else cells.set(k, [item]);
        }
      }
    },
    near(x, y, pad = 1) {
      const ci = Math.floor(x / cellSize), cj = Math.floor(y / cellSize), out = [];
      for (let i = ci - pad; i <= ci + pad; i++) {
        for (let j = cj - pad; j <= cj + pad; j++) {
          const bucket = cells.get(key(i, j));
          if (bucket) out.push(bucket);
        }
      }
      return out;
    },
  };
}

/** Road segments carrying the half-corridor they demand. Rebuilt whenever a width changes. */
let roadGrid;
function indexRoads() {
  roadGrid = gridOf(G);
  for (const r of city.roads) {
    const hc = halfCorridor(r);
    const hw = roadWidth(r) / 2;
    if (!hw) continue;                               // the Pfaffenthal lift is not a road
    if (structural(r)) continue;                     // a bridge, a bore or an arcade moves no walls
    for (let i = 0; i < r.pts.length - 1; i++) {
      const s = {a: r.pts[i], b: r.pts[i + 1], hc, hw};
      roadGrid.add(Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]),
                   Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1]), s);
    }
  }
}
indexRoads();

/** Building edges, with their owner, plus a per-building AABB. Rebuilt after footprints move. */
const BG = 20;
let bldGrid, bldBox;
function indexBuildings() {
  bldGrid = gridOf(BG);
  bldBox = [];
  for (let bi = 0; bi < city.buildings.length; bi++) {
    const pts = city.buildings[bi].pts;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    bldBox.push([x0, y0, x1, y1]);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      bldGrid.add(Math.min(a[0], b[0]), Math.min(a[1], b[1]),
                  Math.max(a[0], b[0]), Math.max(a[1], b[1]), {a, b, bi});
    }
  }
}
indexBuildings();

// --- geometry ----------------------------------------------------------------------------------
function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Index of a building containing this point, or -1. */
function buildingAt(px, py) {
  const tried = new Set();
  for (const bucket of bldGrid.near(px, py, 2)) {
    for (const e of bucket) {
      if (tried.has(e.bi)) continue;
      tried.add(e.bi);
      const [x0, y0, x1, y1] = bldBox[e.bi];
      if (px < x0 || px > x1 || py < y0 || py > y1) continue;
      if (pointInPoly(px, py, city.buildings[e.bi].pts)) return e.bi;
    }
  }
  return -1;
}

/** Distance from (px,py) along (dx,dy) to the first building wall, capped at RAY. */
function castToWall(px, py, dx, dy) {
  let best = RAY;
  for (let step = 0; step * BG <= RAY + BG; step++) {
    const t = Math.min(RAY, step * BG);
    for (const bucket of bldGrid.near(px + dx * t, py + dy * t, 1)) {
      for (const e of bucket) {
        const ex = e.b[0] - e.a[0], ey = e.b[1] - e.a[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;          // ray parallel to the wall
        const qx = e.a[0] - px, qy = e.a[1] - py;
        const tt = (qx * ey - qy * ex) / den;
        if (tt < 1e-9 || tt > best) continue;
        const u = (qx * dy - qy * dx) / den;
        if (u < 0 || u > 1) continue;
        best = tt;
      }
    }
  }
  return best;
}

/** Points to test a footprint at: its vertices, plus every EDGE_STEP along its walls. A 30m flush
 *  frontage has vertices only at its ends, and on a bending street its middle is the close part. */
function probePoints(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push(a);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(L / EDGE_STEP);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * Deepest intrusion of this footprint into any road CORRIDOR, and the way out.
 * `field` picks which radius to test: `hc` the full corridor, `hw` the bare carriageway.
 */
function worstIntrusion(pts, field = 'hc') {
  let best = null;
  for (const [x, y] of probePoints(pts)) {
    for (const bucket of roadGrid.near(x, y, 1)) {
      for (const s of bucket) {
        const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
        const l2 = dx * dx + dy * dy || 1;
        let t = ((x - s.a[0]) * dx + (y - s.a[1]) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = s.a[0] + t * dx, py = s.a[1] + t * dy;
        const over = s[field] - Math.hypot(x - px, y - py);
        if (over > 0 && (!best || over > best.over)) {
          // straight out from the centreline; on the centreline itself, use the segment normal so
          // the direction is still well defined
          let nx = x - px, ny = y - py, n = Math.hypot(nx, ny);
          if (n < 1e-6) { const L = Math.hypot(dx, dy) || 1; nx = -dy / L; ny = dx / L; n = 1; }
          best = {over, dirX: nx / n, dirY: ny / n};
        }
      }
    }
  }
  return best;
}

/** How deep this footprint sits inside its neighbours: max distance any vertex of one is past the
 *  other's boundary. Zero when nothing overlaps. Only ever called for footprints we are moving. */
function neighbourPenetration(bi) {
  const mine = city.buildings[bi].pts, [x0, y0, x1, y1] = bldBox[bi];
  const tried = new Set([bi]);
  let worst = 0;
  const depthInto = (pts, poly) => {
    let d = 0;
    for (const [x, y] of pts) {
      if (!pointInPoly(x, y, poly)) continue;
      let edge = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
        let t = ((x - a[0]) * dx + (y - a[1]) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        edge = Math.min(edge, Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)));
      }
      d = Math.max(d, edge);
    }
    return d;
  };
  for (const bucket of bldGrid.near((x0 + x1) / 2, (y0 + y1) / 2, 3)) {
    for (const e of bucket) {
      if (tried.has(e.bi)) continue;
      tried.add(e.bi);
      const B = bldBox[e.bi];
      if (x1 < B[0] || x0 > B[2] || y1 < B[1] || y0 > B[3]) continue;
      const other = city.buildings[e.bi].pts;
      worst = Math.max(worst, depthInto(mine, other), depthInto(other, mine));
    }
  }
  return worst;
}

function refreshBox(bi) {
  const pts = city.buildings[bi].pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  bldBox[bi] = [x0, y0, x1, y1];
}

// --- measurement -------------------------------------------------------------------------------
/**
 * Walk every centreline and measure, per side, how much room there is versus how much is needed.
 * Returns the raw sample list; everything reported is derived from it, so before and after are the
 * same measurement of two different cities.
 */
function survey() {
  const samples = [];
  for (let ri = 0; ri < city.roads.length; ri++) {
    const r = city.roads[ri];
    const w = roadWidth(r);
    if (!w) continue;
    const need = halfCorridor(r);
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 1e-6) continue;
      const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
      const n = Math.max(1, Math.round(L / SAMPLE_STEP));
      for (let s = 0; s < n; s++) {
        const t = L * (s + 0.5) / n, px = a[0] + ux * t, py = a[1] + uy * t;
        const struct = structural(r);
        if (buildingAt(px, py) >= 0) { samples.push({ri, w, need, covered: true, struct}); continue; }
        const l = castToWall(px, py, nx, ny), rr = castToWall(px, py, -nx, -ny);
        samples.push({ri, w, need, covered: false, struct, l, r: rr, px, py});
      }
    }
  }
  return samples;
}

const pct = (sorted, p) => sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : NaN;

function report(label, samples) {
  const open = samples.filter(s => !s.covered && !s.struct);
  const walled = open.filter(s => s.l < 20 && s.r < 20);
  const widths = walled.map(s => s.l + s.r).sort((a, b) => a - b);
  const defs = open.map(s => Math.max(s.need - s.l, s.need - s.r)).filter(d => d > TRIGGER).sort((a, b) => a - b);
  console.log(`\n${label}`);
  console.log(`  samples ${samples.length}  (${samples.filter(s => s.covered).length} with the centreline inside a building,` +
              ` ${samples.filter(s => s.struct && !s.covered).length} on a bridge/tunnel/arcade — both excluded below)`);
  console.log(`  wall-to-wall passage, ${walled.length} samples walled both sides:`);
  console.log(`    p5 ${pct(widths, .05).toFixed(1)}  p25 ${pct(widths, .25).toFixed(1)}  ` +
              `p50 ${pct(widths, .5).toFixed(1)}  p90 ${pct(widths, .9).toFixed(1)}`);
  console.log('    ' + [4, 6, 8, 10, 12].map(t =>
    `<${t}m ${widths.filter(x => x < t).length}`).join('  '));
  console.log(`  short of its corridor on at least one side: ${defs.length} of ${open.length}`);
  if (defs.length) {
    console.log(`    median ${pct(defs, .5).toFixed(2)}m  p90 ${pct(defs, .9).toFixed(2)}m  worst ${defs[defs.length - 1].toFixed(2)}m`);
    console.log('    ' + [0.5, 1, 2, 3, 4].map(t =>
      `>=${t}m ${defs.filter(x => x >= t).length}`).join('  '));
  }
  return {defs, widths, open};
}

const before = report('BEFORE', survey());

// --- lever 1: move the wall --------------------------------------------------------------------
// unblock-roads' move, run against the corridor rather than the carriageway.
//
// One deliberate difference from the precedent. unblock-roads reverts a footprint outright if it is
// still in a road after its passes, on the grounds that displaced AND blocking is worse than merely
// blocking. That is right for a building in the tarmac and wrong here: a wall hemmed between two
// corridors will always still be short of one of them, and two metres more daylight is two metres
// more even if the third is unreachable. So a partial gain is kept, and a move is undone only when
// it made things WORSE — a deeper corridor intrusion than it started with, or any intrusion into a
// bare carriageway, which is unblock-roads' invariant and must never regress.
const shiftOf = new Float32Array(city.buildings.length);   // total displacement per footprint
let reverted = 0, refusedOverlap = 0;
function wallPass() {
  for (let bi = 0; bi < city.buildings.length; bi++) {
    const b = city.buildings[bi];
    const start = worstIntrusion(b.pts, 'hc');
    if (!start || start.over < TRIGGER) continue;
    const original = b.pts.map(p => [p[0], p[1]]);
    const penBefore = neighbourPenetration(bi);
    const budget = MAX_SHIFT - shiftOf[bi];
    let shifted = 0;
    for (let pass = 0; pass < PASSES; pass++) {
      const hit = worstIntrusion(b.pts, 'hc');
      if (!hit || hit.over < TRIGGER) break;
      const step = Math.min(hit.over, budget - shifted);
      if (step < TRIGGER) break;
      for (const p of b.pts) { p[0] += hit.dirX * step; p[1] += hit.dirY * step; }
      shifted += step;
      refreshBox(bi);
      if (neighbourPenetration(bi) > Math.max(penBefore, OVERLAP_TOL)) {
        // it would be inside a neighbour, not merely flush against it — back this step out and stop
        for (const p of b.pts) { p[0] -= hit.dirX * step; p[1] -= hit.dirY * step; }
        shifted -= step;
        refreshBox(bi);
        refusedOverlap++;
        break;
      }
    }
    if (shifted <= 0) continue;
    const end = worstIntrusion(b.pts, 'hc');
    const road = worstIntrusion(b.pts, 'hw');
    if ((end?.over ?? 0) > start.over + 1e-6 || (road?.over ?? 0) >= TRIGGER) {
      b.pts.forEach((p, i) => { p[0] = original[i][0]; p[1] = original[i][1]; });
      refreshBox(bi);
      reverted++;
      continue;
    }
    // A position we invented does not deserve seventeen significant figures, and city.json is
    // already 3.3MB of them. Millimetres, which is four orders finer than anything here cares about.
    for (const p of b.pts) { p[0] = +p[0].toFixed(3); p[1] = +p[1].toFixed(3); }
    refreshBox(bi);
    shiftOf[bi] += shifted;
  }
  indexBuildings();   // footprints moved, so the wall index is stale
}

// --- lever 2: re-derive the widths -------------------------------------------------------------
// Invert the corridor rule: given the room a road's TIGHTEST point has, what is the widest street
// that fits there? Monotonic in `clear`, so a bisection is exact enough and needs no case analysis
// around walkWidth's two clamps.
function widthFor(clear, ped) {
  if (ped) return Math.max(0, 2 * (clear - DAYLIGHT));
  let lo = 0, hi = 24;
  for (let i = 0; i < 48; i++) {
    const m = (lo + hi) / 2;
    if (m / 2 + walkWidth(m) + DAYLIGHT <= clear) lo = m; else hi = m;
  }
  return lo;
}

/**
 * One-sided clearance along a road: the absolute tightest, and the tightest once the worst PINCH of
 * its length is discounted.
 *
 * Two numbers because the width lever is COARSE — `width` is a property of a whole road, while the
 * room varies metre by metre along it. Driving the width off the single worst point is that coarseness
 * at its worst: it is how a 300m arterial ends up 3.4m wide because of one house, and how the Pont
 * Grande-Duchesse Charlotte, an 80m bridge, ended up 3.4m because the deck clips a footprint at one
 * end. So the two constraints are checked at different points:
 *
 *   - the CARRIAGEWAY must never contain a wall, anywhere: checked at the absolute minimum. This is
 *     unblock-roads' invariant and it is not negotiable at any point on the road.
 *   - the PAVEMENT should fit: checked at the discounted minimum. Where a short pinch clips a footway
 *     the honest outcome is a clipped footway for those few metres, not a street narrowed end to end.
 */
const PINCH = 0.10;        // fraction of a road's length allowed to be tighter than its width admits
function clearances(r) {
  const all = [];
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 1e-6) continue;
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const n = Math.max(1, Math.round(L / SAMPLE_STEP));
    for (let s = 0; s < n; s++) {
      const t = L * (s + 0.5) / n, px = a[0] + ux * t, py = a[1] + uy * t;
      if (buildingAt(px, py) >= 0) continue;
      all.push(Math.min(castToWall(px, py, nx, ny), castToWall(px, py, -nx, -ny)));
    }
  }
  if (!all.length) return null;
  all.sort((p, q) => p - q);
  return {min: all[0], soft: all[Math.floor(PINCH * (all.length - 1))]};
}

// Snapshot the widths as they arrived, so the report is a diff against the file on disk rather than
// a tally of edits — the width pass runs three times and a road it raises twice is one raise.
const origWidth = city.roads.map(roadWidth);
const overridesBefore = city.roads.filter(r => r.width != null).length;
function widthPass({allowNarrowing}) {
  for (const r of city.roads) {
    const cls = ROAD_KINDS[r.kind]?.width ?? 0;
    if (!cls) continue;
    const c = clearances(r);
    if (!c) continue;                                // wholly covered; leave it exactly as it is
    const fits = Math.min(cls,
      widthFor(c.soft, pedZone(r.kind)),             // pavement fits off the pinch points
      2 * (c.min - TRIGGER));                        // and no wall is ever inside the tarmac
    const now = roadWidth(r);
    if (fits > now + RAISE_EPS) {
      // the walls allow more than the stale override says
      if (fits >= cls - 1e-6) delete r.width; else r.width = +fits.toFixed(2);
    } else if (allowNarrowing && !structural(r) && fits < now - RAISE_EPS) {
      // a wall that would not move. Narrow to fit, but never below the floor: an undriveable street is
      // a worse bug than a clipped pavement.
      r.width = +Math.max(MIN_ROAD, fits).toFixed(2);
    }
  }
  indexRoads();     // widths changed, so the corridors changed
}

// --- the order the levers run in ---------------------------------------------------------------
// Widening a street opens a corridor that was not there a moment ago, and something has to make room
// for it — so a raise must be followed by another chance to move walls, or every road we widen simply
// books a fresh deficit. Hence: move walls, raise what the new walls allow, move walls again. Only
// then, once nothing more will budge, is narrowing allowed — it is the last resort and it runs once.
const ROUNDS = 2;
for (let round = 0; round < ROUNDS; round++) {
  wallPass();
  widthPass({allowNarrowing: false});
}
wallPass();
widthPass({allowNarrowing: true});

const moved = shiftOf.reduce((n, s) => n + (s > 0 ? 1 : 0), 0);
const totalShift = shiftOf.reduce((a, s) => a + s, 0);
const maxShift = shiftOf.reduce((a, s) => Math.max(a, s), 0);

if (!DRY) writeFileSync(FILE, JSON.stringify(city));

// --- verification, against the data that was just written --------------------------------------
const afterSamples = survey();
const after = report(DRY ? 'AFTER (dry run, nothing written)' : 'AFTER', afterSamples);

console.log('\nwalls moved');
console.log(`  ${moved} footprints translated out of a corridor`);
console.log(`  average ${(totalShift / Math.max(1, moved)).toFixed(2)}m, largest ${maxShift.toFixed(2)}m`);
console.log(`  ${refusedOverlap} pushes stopped short: would have gone >${OVERLAP_TOL}m inside a neighbour`);
console.log(`  ${reverted} put back: the move made a corridor or a carriageway worse`);
// A straight diff against the widths as they arrived, so nothing is counted twice.
const changes = city.roads.map((r, i) => ({r, from: origWidth[i], to: roadWidth(r)}))
  .filter(c => Math.abs(c.to - c.from) > 1e-9);
const ups = changes.filter(c => c.to > c.from), downs = changes.filter(c => c.to < c.from);
const sum = (a, f) => a.reduce((n, c) => n + f(c), 0);
console.log('widths re-derived');
console.log(`  ${ups.length} roads widened toward their class default (avg +${(sum(ups, c => c.to - c.from) / Math.max(1, ups.length)).toFixed(2)}m)`);
console.log(`    of which ${ups.filter(c => c.r.width == null).length} no longer need an override at all`);
console.log(`  ${downs.length} roads narrowed to fit a wall that would not move (avg -${(sum(downs, c => c.from - c.to) / Math.max(1, downs.length)).toFixed(2)}m)`);
console.log(`    of which ${downs.filter(c => c.to <= MIN_ROAD + 1e-6).length} sit on the ${MIN_ROAD}m floor`);
console.log(`  per-road width overrides in the file: ${overridesBefore} -> ${city.roads.filter(r => r.width != null).length}`);
for (const c of downs.sort((a, b) => (b.from - b.to) - (a.from - a.to)).slice(0, 6)) {
  console.log(`    cut ${c.from.toFixed(1)} -> ${c.to.toFixed(1)}m  ${c.r.kind}  "${c.r.name || '-'}"`);
}
for (const c of ups.sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 6)) {
  console.log(`    up  ${c.from.toFixed(1)} -> ${c.to.toFixed(1)}m  ${c.r.kind}  "${c.r.name || '-'}"`);
}
// per class, because "207 roads narrowed" hides whether it was back lanes or arterials
const byKind = new Map();
for (const c of changes) {
  const k = byKind.get(c.r.kind) ?? {raise: 0, narrow: 0, worst: 0, worstTo: 0};
  if (c.to > c.from) k.raise++; else {
    k.narrow++;
    if (c.from - c.to > k.worst) { k.worst = c.from - c.to; k.worstTo = c.to; }
  }
  byKind.set(c.r.kind, k);
}
for (const [kind, k] of [...byKind].sort((a, b) => b[1].narrow - a[1].narrow)) {
  console.log(`    ${kind.padEnd(14)} +${k.raise} raised  -${k.narrow} narrowed` +
              (k.narrow ? `  (deepest cut ${k.worst.toFixed(1)}m, down to ${k.worstTo.toFixed(1)}m)` : ''));
}

const stillShort = after.defs.length;
console.log('\nresidual');
console.log(`  ${before.defs.length} -> ${stillShort} samples short of their corridor ` +
            `(${(100 * (1 - stillShort / Math.max(1, before.defs.length))).toFixed(1)}% cleared)`);
console.log(`  worst remaining shortfall ${stillShort ? after.defs[stillShort - 1].toFixed(2) + 'm' : 'none'}`);
console.log(`  ${afterSamples.filter(s => s.covered).length} samples untouchable by design: the centreline is`);
console.log('    inside a building — a covered way, or a footprint that disagrees with its polyline');
// the named structures, so "could not fix" is a list rather than a number
const structShort = new Map();
for (const s of afterSamples) {
  if (!s.struct || s.covered) continue;
  const d = Math.max(s.need - s.l, s.need - s.r);
  if (d <= TRIGGER) continue;
  const name = city.roads[s.ri].name;
  structShort.set(name, Math.max(structShort.get(name) ?? 0, d));
}
if (structShort.size) {
  console.log(`  ${structShort.size} bridges/tunnels/arcades left alone (a flat world cannot tell a deck from a collision):`);
  for (const [name, d] of [...structShort].sort((a, b) => b[1] - a[1])) {
    console.log(`    -${d.toFixed(2)}m  "${name}"`);
  }
}

const biggestOffenders = new Map();
for (const s of after.open) {
  const d = Math.max(s.need - s.l, s.need - s.r);
  if (d <= TRIGGER) continue;
  const cur = biggestOffenders.get(s.ri);
  if (!cur || d > cur.d) biggestOffenders.set(s.ri, {d, s});
}
const worst = [...biggestOffenders.entries()].sort((a, b) => b[1].d - a[1].d).slice(0, 10);
if (worst.length) {
  console.log('  worst 10 roads left:');
  for (const [ri, {d, s}] of worst) {
    const r = city.roads[ri];
    console.log(`    -${d.toFixed(2)}m  L${s.l.toFixed(1)} R${s.r.toFixed(1)}  w=${roadWidth(r)} ` +
                `${r.kind}  "${r.name || '-'}"  x=${s.px.toFixed(0)} y=${s.py.toFixed(0)}`);
  }
}
