// Park interiors — the layer that turns a flat green polygon into a laid-out public park.
// scene.js draws the grass fill (buildPolys(world.green)) and the wild trees; decor.js rings each
// park EDGE with hedge-domes and fountains. This file owns only the INTERIOR: the WALKWAY NETWORK
// and the programme it serves — cafe veranda, kids' playground, fenced dog run, plus the beds,
// benches, planters, topiary and allée trees that dress them.
//
// Contract (called by scene.js, unchanged):
//     scene.add(buildParks(world.green, world.onRoad))
//   buildParks(greenPolys, onRoad) -> THREE.Group
//
//   greenPolys is world.green: polygons of [x, y] MAP points, +Y north. Three's ground is XZ and
//   the mapping used EVERYWHERE in this project is  three.x = map.x,  three.z = -map.y.
//   onRoad(x, y, margin) is world.onRoad — true when the point is inside a carriageway plus margin.
//
// ==============================================================================================
// WHY THE LAYOUT LOOKS LIKE THIS — read from Esri World Imagery over the real parks
// ==============================================================================================
// The previous version drew a hub at the bbox centre and 2-4 spokes to random interior points. The
// spokes stopped in the middle of the grass, and nothing but the spoke ENDPOINTS was ever tested
// against a road, so a walk could cross a carriageway between two legal ends. Both are fixed here,
// and the replacement is not invented: it is copied off aerial photographs of these exact parks.
//
// Parc Municipal, south half (green poly 38, centre ≈ [-478, -361]):
//   sinuous walks in the wooded belt just inside the boundary, looping round an open middle; a
//   kidney pond just south of centre; a circular mound feature up by the boulevard. No straight
//   spoke anywhere, and every walk runs from one street entrance to another.
// Parc Municipal, north lawn (green poly 12, centre ≈ [-321, 304]):
//   the decisive one. The middle is a large open LAWN WITH NO PATHS ACROSS IT. The walks skirt it
//   through the tree belt. Poly 12 also sits wholly inside poly 10 (the whole-park envelope), i.e.
//   it is a lawn compartment of a bigger park, not a park of its own — so it gets skirted, not
//   furnished.
// Kirchberg green (green poly 233, centre ≈ [936, 1157]):
//   the other idiom — straight desire-line diagonals corner to corner, crossing at one X junction,
//   plus a walk along the busy street edge. Convex park, so the direct line wins.
// Pfaffenthal/Alzette valley slopes (green polys 0, 1, 27):
//   wooded escarpment. Essentially NO path network — a contour track at most. A big area alone must
//   therefore not earn the full treatment.
//
// The one construction that produces all of these is: entrances derived from where the boundary
// comes closest to a road, a BELT LOOP inset from the boundary and following its shape through
// every entrance, and DESIRE CHORDS added only between entrance pairs whose walk round the belt is
// much longer than the straight line. On a concave landscape park the belt does the work and the
// middle stays empty (Parc Municipal); on a convex green the chords fire and you get the Kirchberg
// X. Nothing is laid across the open middle unless the chord test asks for it.
//
// No walk may dead-end in grass. That is enforced structurally: an endpoint is legal only if it is
// an entrance (it leads out of the park), a junction of degree >= 2, or a programme element (it
// leads to a thing). Everything else is pruned, repeatedly, until the graph stops changing.
//
// Determinism: NOT Math.random. Every draw comes from a seeded hash of a stable integer.
// Performance: everything repeated is an InstancedMesh with a shared material; every flat surface
// in the whole city — walks, plaza, playground pad, dog-run earth, cafe deck, pond — is ONE merged
// vertex-coloured mesh. Low metalness throughout (no env map in this scene).

import * as THREE from 'three';
import {groundHeight} from '../world/terrain.js';
import {makeBins, makeBikeRacks, makeSignPosts, makeBollards, makeFountains} from './streetprops.js';

// Seat every scattered park element on the terrain: its world Y is groundHeight at its map point.
const gyP = (x, y) => groundHeight(x, -y);

// --- deterministic PRNG ------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFrom(i, x, y) {
  let h = 2166136261 ^ (i * 374761393);
  h = Math.imul(h ^ Math.floor(x * 13.37), 2246822519);
  h = Math.imul(h ^ Math.floor(y * 7.11), 3266489917);
  h ^= h >>> 15;
  return h >>> 0;
}

// --- polygon helpers ---------------------------------------------------------------------------
function polyArea(poly) {
  let a = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1]; }
  return Math.abs(a) / 2;
}
function polyBounds(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return {minX, minY, maxX, maxY};
}
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function distToEdges(x, y, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], ay = poly[j][1], bx = poly[i][0], by = poly[i][1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    let t = ((x - ax) * dx + (y - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx, py = ay + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < best) best = d;
  }
  return best;
}
const dist2d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function polyPerimeter(poly) {
  let p = 0;
  for (let i = 0; i < poly.length; i++) { const j = (i + 1) % poly.length; p += dist2d(poly[i], poly[j]); }
  return p;
}
// Isoperimetric compactness, 1 for a circle. A designed park is a blob; a valley slope is a ribbon.
function compactness(m) {
  const p = polyPerimeter(m.poly);
  return p > 0 ? (4 * Math.PI * m.area) / (p * p) : 0;
}
// What share of this boundary has a street immediately outside it? A town park is enclosed by
// streets; a wood backs onto more wood. Walked at 8m and probed 9m out, which is inside the
// footway on the far side of the railings.
function frontage(poly) {
  let n = 0, hit = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L = dist2d(a, b);
    if (L < 0.5) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const cnt = Math.max(1, Math.round(L / 8));
    for (let k = 0; k < cnt; k++) {
      const t = (k + 0.5) / cnt;
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      let nx = -uy, ny = ux;
      if (pointInPoly(x + nx * 2, y + ny * 2, poly)) { nx = -nx; ny = -ny; }   // face OUT
      n++;
      if (ONROAD && ONROAD(x + nx * 9, y + ny * 9, 4)) hit++;
    }
  }
  return n ? hit / n : 0;
}

// distToEdges is the hottest call in this file — every metre of every candidate walk asks for it,
// and a Parc Municipal ring has 348 vertices. So each park gets a one-off grid of its own edges,
// bucketed at 20m, and the distance query only looks at the cells it could possibly need. The
// answer is capped at CAP because nothing here ever compares against a margin bigger than that.
const EDGE_CELL = 20, EDGE_CAP = 40;
let EIDX = null;                       // {cells, poly} for the park currently being laid out
function setEdgeIndex(poly) {
  const cells = new Map();
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const seg = [a[0], a[1], b[0], b[1]];
    const x0 = Math.floor(Math.min(a[0], b[0]) / EDGE_CELL), x1 = Math.floor(Math.max(a[0], b[0]) / EDGE_CELL);
    const y0 = Math.floor(Math.min(a[1], b[1]) / EDGE_CELL), y1 = Math.floor(Math.max(a[1], b[1]) / EDGE_CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = cx + ':' + cy;
      const bucket = cells.get(k);
      if (bucket) bucket.push(seg); else cells.set(k, [seg]);
    }
  }
  EIDX = {cells, poly, b: polyBounds(poly)};
}
function edgeDist(x, y, poly) {
  if (!EIDX || EIDX.poly !== poly) return distToEdges(x, y, poly);
  const cx = Math.floor(x / EDGE_CELL), cy = Math.floor(y / EDGE_CELL);
  const reach = Math.ceil(EDGE_CAP / EDGE_CELL);
  let best = EDGE_CAP;
  for (let r = 0; r <= reach; r++) {
    for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) {
      if (r > 0 && Math.abs(i - cx) !== r && Math.abs(j - cy) !== r) continue;   // ring shell only
      const bucket = EIDX.cells.get(i + ':' + j);
      if (!bucket) continue;
      for (const s of bucket) {
        const dx = s[2] - s[0], dy = s[3] - s[1], l2 = dx * dx + dy * dy || 1;
        let t = ((x - s[0]) * dx + (y - s[1]) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(x - (s[0] + t * dx), y - (s[1] + t * dy));
        if (d < best) best = d;
      }
    }
    // once the nearest possible edge in the next shell is farther than the best so far, stop
    if (best <= r * EDGE_CELL) break;
  }
  return best;
}

// --- the road test, and everything built on top of it -------------------------------------------
// Park polygons frequently swallow a street, so "inside the park" is NOT "off the tarmac". ONROAD
// is world.onRoad; every point AND every metre of every path is checked against it below.
let ONROAD = null;

// Shapes nothing may be laid across, set per park before a single walk exists. Water is the reason
// this has to come FIRST rather than be argued with afterwards: a photographed pond is ground
// truth and a generated walk is not, so the walk has to route round the water, not the water shrink
// out of the walk's way. Each entry is the traced outline pushed 2m outwards, so the bank stays
// walkable and the circuit path round the pond is still legal.
let BLOCK = [];
function setBlockers(poly) {
  BLOCK = [];
  for (const f of IMAGERY) {
    if (!f.outline || !pointInPoly(f.x, f.y, poly)) continue;
    BLOCK.push(f.outline.map(p => {
      const d = Math.hypot(p[0] - f.x, p[1] - f.y) || 1;
      return [f.x + (p[0] - f.x) * (d + 2) / d, f.y + (p[1] - f.y) * (d + 2) / d];
    }));
  }
}

// How far is (x, y) from the nearest carriageway edge, capped? Binary-searched on onRoad's margin.
// Used to tell a quiet corner (playground, dog run) from a busy frontage (cafe, main entrance).
function roadDist(x, y, cap) {
  if (!ONROAD) return cap;
  if (ONROAD(x, y, 0)) return 0;
  if (!ONROAD(x, y, cap)) return cap;
  let lo = 0, hi = cap;
  for (let i = 0; i < 6; i++) { const m = (lo + hi) / 2; if (ONROAD(x, y, m)) hi = m; else lo = m; }
  return hi;
}

// The single clearance predicate. em = metres clear of the park boundary, rm = metres clear of any
// carriageway. EVERY placement and EVERY path sample in this file goes through it.
// Ordered cheapest-first deliberately: the bbox and the bucketed road test throw out most
// candidates in constant time, and the O(vertices) ray cast only runs on survivors.
// `intoWater` is for the one caller that legitimately asks about ground inside a blocker: the pond
// itself, checking that its own traced outline sits on legal ground.
function okPt(x, y, poly, em, rm, intoWater = false) {
  if (EIDX && EIDX.poly === poly) {
    const b = EIDX.b;
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) return false;
  }
  if (ONROAD && ONROAD(x, y, rm)) return false;
  if (em > 0 && edgeDist(x, y, poly) < em) return false;
  if (!pointInPoly(x, y, poly)) return false;
  if (!intoWater) for (let i = 0; i < BLOCK.length; i++) if (pointInPoly(x, y, BLOCK[i])) return false;
  return true;
}
// The fix for the old bug: a segment is legal only if it is legal ALONG ITS WHOLE LENGTH, not just
// at its two ends. Sampled every `step` metres (2m; the invariant check re-tests at 1m).
function okSeg(a, b, poly, em, rm, step = 2) {
  const L = dist2d(a, b);
  const n = Math.max(2, Math.ceil(L / step));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (!okPt(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, poly, em, rm)) return false;
  }
  return true;
}

// Boundary walk: a point every `step` metres along the ring, each with its INWARD unit normal.
// The normal is resolved by probing, not by winding, because the green rings are not consistently
// wound and a flipped normal would put every entrance outside the park.
function boundarySamples(poly, step) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const L = dist2d(a, b);
    if (L < 0.5) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const cnt = Math.max(1, Math.round(L / step));
    for (let k = 0; k < cnt; k++) {
      const t = (k + 0.5) / cnt;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      let nx = -uy, ny = ux;
      if (!pointInPoly(p[0] + nx * 1.5, p[1] + ny * 1.5, poly)) { nx = -nx; ny = -ny; }
      if (!pointInPoly(p[0] + nx * 1.5, p[1] + ny * 1.5, poly)) continue;   // sliver, no interior
      out.push({p, n: [nx, ny], u: [ux, uy]});
    }
  }
  return out;
}

// A yaw that makes a prop's +Z face `to` from `from`, both in MAP coords. three.z = -map.y, so the
// three-space direction is (dx, -dy) and the yaw about Y is atan2 of that pair.
const faceRot = (fx, fy, tx, ty) => Math.atan2(tx - fx, -(ty - fy));

// ==============================================================================================
// Imagery-derived overrides. Where an aerial photograph shows a real feature, the layout copies it
// instead of reasoning about it. Coordinates are MAP metres, read off an Esri World Imagery export
// and back-projected with the city's own equirectangular projection (tools/fetch-city.mjs toXY,
// origin 49.6125/6.13). Each entry still has to pass the same clearance tests as a computed one —
// a hint may not put a pond in a road.
const IMAGERY = [
  // --- Parc Municipal, SOUTH (green 38) --------------------------------------------------------
  // Tile: Esri World Imagery, bbox 6.12292,49.60859,6.12416,49.60940 — a 90m square over the lake,
  // summer pass, ~0.1 m/px. The ornamental POND is traced vertex by vertex off that photograph. It
  // is a boomerang: broad in the south-west, narrowing to a neck at the north where a footbridge
  // crosses. It is emphatically NOT a disc, and the disc the old version drew was the giveaway that
  // the layout had been invented rather than observed. A fountain jet stands in the middle of it.
  {kind: 'pond', jet: [-464, -394],
   prov: 'Esri World Imagery 6.12292,49.60859,6.12416,49.60940 — pond outline traced off the photo, jet at its middle',
   outline: [[-465, -377], [-459, -378], [-455, -385], [-451, -392], [-447, -397], [-445, -401],
             [-449, -405], [-457, -409], [-466, -413], [-473, -414], [-481, -411], [-484, -405],
             [-484, -400], [-480, -395], [-475, -390], [-471, -384], [-468, -379]]},
  // Tile: Esri World Imagery, bbox 6.12272,49.60926,6.12397,49.61007 — a 90m square against
  // Boulevard Royal. What the first pass called a "grass mound" is in the photograph a set of
  // CONCENTRIC PAVED RINGS: the spiral amphitheatre laid into the slope beside the bastion ruin.
  // Concentric rings are the one thing about it you can read from the air, so rings is what it is.
  {kind: 'rings', x: -489, y: -292, r: 12,
   prov: 'Esri World Imagery 6.12272,49.60926,6.12397,49.61007 — concentric ring amphitheatre by the bastion'},

  // --- Parc Municipal, NORTH (green 10) --------------------------------------------------------
  // Tile: Esri World Imagery, bbox 6.12279,49.61268,6.12640,49.61502 — a 260m square where the park
  // meets Avenue Monterey. A formal circular PARTERRE: a ring walk round a mown oval, clipped beds
  // standing on the ring, a fountain basin at the centre. It is the only geometric thing in an
  // otherwise entirely sinuous park, which is exactly why it has to be copied rather than derived —
  // no rule that produces the winding woodland walks would ever produce this circle.
  {kind: 'rondel', x: -370, y: 156, r: 21,
   prov: 'Esri World Imagery 6.12279,49.61268,6.12640,49.61502 — circular parterre, ring walk + central basin'},
];
// Centre and reach of each hint, worked out once so the fitting loop below has something to shrink
// toward and the "is this hint even in this park" test is a single point-in-polygon.
for (const f of IMAGERY) {
  if (f.outline) {
    f.x = f.outline.reduce((s, p) => s + p[0], 0) / f.outline.length;
    f.y = f.outline.reduce((s, p) => s + p[1], 0) / f.outline.length;
    f.r = Math.max(...f.outline.map(p => Math.hypot(p[0] - f.x, p[1] - f.y)));
  }
}

export function buildParks(greenPolys, onRoad = null) {
  ONROAD = onRoad;
  const group = new THREE.Group();
  group.name = 'parkInteriors';

  // --- placement buckets, filled across every park, realised once at the end ------------------
  const A = {
    quads: [],    // path ribbon segments {ax,ay,bx,by,w,kind}
    discs: [],    // flat round surfaces {x,y,r,rgb,y0}
    rects: [],    // flat rectangles {x,y,ang,hw,hh,rgb,y0}
    polys: [],    // flat traced outlines {pts,rgb,y0} — the shapes read off aerial photographs
    flowers: [], soils: [], planters: [], shrubDomes: [], shrubCones: [], ornTrees: [], benches: [],
    fenceLow: [], fenceTall: [],                 // {x,y,rot}
    swings: [], slides: [], climbers: [],        // {x,y,rot,tint}
    hoops: [], ramps: [],                        // {x,y,rot}
    kiosks: [], parasols: [], tables: [], chairs: [],
    bins: [], racks: [], signs: [], bollards: [], fountains: [],
    keepClear: [],           // {x,y,r} discs no wild tree should be planted in
    endpoints: [],           // every degree-1 node of the finished network, with its terminal flag
  };
  // `perPark` is the debug hook that makes "half this park has no walk in it" a number instead of
  // an impression: one row per green with how its belt, its gates and its prune actually went.
  const stats = {parks: 0, full: 0, wild: 0, compartment: 0, skipped: 0, gates: 0, imagery: [],
                 why: {}, perPark: []};

  // --- classify every polygon once ------------------------------------------------------------
  const metas = greenPolys.map((poly, pi) => {
    if (!Array.isArray(poly) || poly.length < 3) return null;
    const area = polyArea(poly);
    const b = polyBounds(poly);
    return {pi, poly, area, b, w: b.maxX - b.minX, h: b.maxY - b.minY,
            cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2};
  });
  // A green wholly inside a much larger green is a LAWN COMPARTMENT of that park, not a park of
  // its own (green 12, the Parc Municipal north lawn, sits inside green 10, the whole park). The
  // aerial shows such a lawn kept empty and skirted, so it gets a belt walk and nothing else.
  for (const m of metas) {
    if (!m) continue;
    m.compartment = metas.some(o => o && o !== m && o.area > m.area * 3 &&
      pointInPoly(m.cx, m.cy, o.poly) && pointInPoly(m.b.minX + 1, m.b.minY + 1, o.poly));
    // A big sprawling green is usually wooded escarpment, not a laid-out park — the Pétrusse and
    // Alzette valley slopes carry a contour track and nothing more, and area alone must not buy
    // the full programme. But SIZE ALONE GETS IT WRONG, and it got the most important park in the
    // city wrong: Parc Municipal is 162,000m2 and was being written off as woodland, so the city's
    // main park had no cafe, no playground and no dog run in it.
    //
    // Two measured numbers separate the two, and both come straight off the map:
    //   compactness 4*pi*A/P^2 — a designed park is a blob (0.35 for Parc Municipal, 0.69 for its
    //     south half); a valley slope is a ribbon (0.06 Kirchberg woods, 0.08 the Alzette strip,
    //     0.10 the Pétrusse).
    //   street frontage — the share of the boundary with a carriageway just outside it. A town park
    //     is walled in by streets (0.59, 0.71); a wood backs onto more wood (0.04, 0.08, 0.21).
    // Their product ranks it unambiguously: Parc Municipal 0.38, Kirchberg green 0.80, against 0.24
    // for the Pfaffenthal slope and 0.03-0.15 for every genuine wood. The cut is at 0.30, and it
    // only ever RESCUES a big green — a small one is a park by default, as before.
    const oversize = m.area > 60000 || Math.max(m.w, m.h) > 420;
    m.parkIndex = oversize ? compactness(m) * (0.5 + frontage(m.poly)) : 1;
    m.wild = oversize && m.parkIndex < 0.30;
  }

  for (const m of metas) {
    if (!m || m.area < 2000) continue;
    stats.parks++;
    const rng = mulberry32(seedFrom(m.pi, m.cx, m.cy));
    setEdgeIndex(m.poly);
    setBlockers(m.poly);
    const res = layoutPark(m, rng, A, stats);
    if (!res) stats.skipped++;
  }

  realise(group, A);
  group.userData.parkStats = stats;
  // scene.js's augmentTrees fills park interiors with wild trees and knows nothing about what is
  // laid out inside them, so today a tree grows out of the playground and stands in the pond.
  // These two lists are the hook for fixing that from the scene side: keepClear is a set of discs
  // (facilities, pond, mound), walks is every path ribbon. Filtering treeSet against them is a
  // one-line change in scene.js — see the note in the handover.
  group.userData.keepClear = A.keepClear;
  group.userData.walks = A.quads;
  // Debug hook, in the spirit of window.game: the raw placements, so the "no walk and no facility
  // is ever on a carriageway" invariant can be re-checked from outside instead of assumed.
  group.userData.parkDebug = A;
  return group;
}

// ==============================================================================================
// ONE PARK
// ==============================================================================================
function layoutPark(m, rng, A, stats) {
  const {poly, area, pi} = m;
  const full = !m.wild && !m.compartment;
  const big = full && area > 12000;
  const medium = full && area > 5000;

  // ---- 1. ENTRANCES ---------------------------------------------------------------------------
  // Where does the boundary come closest to a road? That is where a pedestrian actually arrives.
  // Sample the ring, probe just OUTSIDE each sample for a carriageway, and keep the samples whose
  // inward point is a legal standing place.
  let perim = 0;
  for (let i = 0; i < poly.length; i++) { const j = (i + 1) % poly.length; perim += dist2d(poly[i], poly[j]); }
  const bstep = Math.min(14, Math.max(5, perim / 110));
  const samples = boundarySamples(poly, bstep);
  if (samples.length < 6) { stats.why.thinRing = (stats.why.thinRing||0)+1; return false; }

  const cands = [];
  for (const s of samples) {
    const outer = [s.p[0] + s.n[0] * 1.3, s.p[1] + s.n[1] * 1.3];   // just inside the kerb line
    const inner = [s.p[0] + s.n[0] * 7.0, s.p[1] + s.n[1] * 7.0];
    if (!okPt(outer[0], outer[1], poly, 0.7, 1.3)) continue;
    if (!okPt(inner[0], inner[1], poly, 2.0, 1.6)) continue;
    if (!okSeg(outer, inner, poly, 0.7, 1.3, 1.0)) continue;
    // how close is the street on the far side of the boundary?
    const probe = [s.p[0] - s.n[0] * 4, s.p[1] - s.n[1] * 4];
    const rd = roadDist(probe[0], probe[1], 26);
    cands.push({outer, inner, n: s.n, rd, bearing: Math.atan2(-s.n[1], -s.n[0])});
  }
  if (!cands.length) { stats.why.noCandidate = (stats.why.noCandidate||0)+1; return false; }
  // Focus a sprawling green on the cluster of entrances people actually use, so a 700m-wide valley
  // does not grow a 400m walk to a gate nobody reaches.
  let pool = cands.filter(c => c.rd < 22);
  if (pool.length < 2) pool = cands.slice().sort((a, b) => a.rd - b.rd).slice(0, 8);
  // A wood gets its gates clustered hard, so a 700m valley does not grow a 400m walk to a gate
  // nobody reaches. A real park is entered from every street that touches it, and Parc Municipal is
  // 650m across, so the span has to grow with the park or half of it would go ungated.
  const MAXSPAN = m.wild ? 400 : Math.max(240, Math.sqrt(area) * 0.95);
  for (let it = 0; it < 3 && pool.length > 2; it++) {
    const gx = pool.reduce((s, c) => s + c.inner[0], 0) / pool.length;
    const gy = pool.reduce((s, c) => s + c.inner[1], 0) / pool.length;
    const keep = pool.filter(c => dist2d(c.inner, [gx, gy]) <= MAXSPAN);
    if (keep.length >= 2) pool = keep; else break;
  }

  // Greedy pick: nearest-to-a-road first, spread around the ring so the park has gates on the
  // sides people come from rather than three gates off one street.
  const maxGates = m.wild ? 4 : big ? Math.min(9, 5 + Math.floor(area / 45000)) : medium ? 4 : 3;
  const minSep = Math.min(95, Math.max(22, Math.sqrt(area) * 0.5));
  pool.sort((a, b) => a.rd - b.rd);
  const gates = [];
  for (const pass of [0, 1]) {
    for (const c of pool) {
      if (gates.length >= maxGates) break;
      const sep = pass === 0 ? minSep : minSep * 0.6;
      if (gates.some(g => dist2d(g.inner, c.inner) < sep)) continue;
      if (pass === 0) {
        const bdiff = (g) => { let d = Math.abs(g.bearing - c.bearing) % (Math.PI * 2); return Math.min(d, Math.PI * 2 - d); };
        if (gates.some(g => bdiff(g) < 0.7)) continue;
      }
      gates.push(c);
    }
  }
  if (!gates.length) { stats.why.noGate = (stats.why.noGate||0)+1; return false; }
  stats.gates += gates.length;

  // ---- 2. THE GRAPH ----------------------------------------------------------------------------
  // Nodes carry `term`: an endpoint is legal only at a terminal (an entrance, or a programme
  // element) or at a junction. Everything else is pruned at the end, which is what guarantees no
  // walk dead-ends in grass.
  const N = [], E = [];
  const addNode = (x, y, term = false) => { N.push({x, y, term}); return N.length - 1; };
  // A Set, not a scan of E: a big park's belt alone is hundreds of edges and every curve below adds
  // more, so scanning the list on each insert is the quadratic term that made an early version of
  // this file take ten seconds.
  const seen = new Set();
  const rawEdge = (a, b, kind) => {
    if (a === b) return false;
    const k = a < b ? a + ':' + b : b + ':' + a;
    if (seen.has(k)) return false;
    seen.add(k);
    E.push({a, b, kind}); return true;
  };
  const pt = (i) => [N[i].x, N[i].y];
  // Straight if the whole length is clear; otherwise try a single bend to either side. A bend node
  // has degree 2 so it is a junction, not a dead end.
  const tryEdge = (a, b, kind, em = 2.0, rm = 1.6) => {
    const pa = pt(a), pb = pt(b);
    if (dist2d(pa, pb) < 2) return false;
    if (okSeg(pa, pb, poly, em, rm)) return rawEdge(a, b, kind);
    const L = dist2d(pa, pb), ux = (pb[0] - pa[0]) / L, uy = (pb[1] - pa[1]) / L;
    const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
    for (const off of [7, -7, 14, -14, 24, -24]) {
      const q = [mid[0] - uy * off, mid[1] + ux * off];
      if (!okPt(q[0], q[1], poly, em, rm)) continue;
      if (okSeg(pa, q, poly, em, rm) && okSeg(q, pb, poly, em, rm)) {
        const qi = addNode(q[0], q[1], false);
        rawEdge(a, qi, kind); rawEdge(qi, b, kind);
        return true;
      }
    }
    return false;
  };
  // A walk in a landscape park BOWS. The photographs are unanimous about it: in Parc Municipal not
  // one walk over about thirty metres is straight, they all sweep. A ruler-straight line between
  // two gates is the single loudest tell that a layout was generated rather than laid out, so any
  // long link is built as a quadratic Bezier, sampled into a chain of short segments — and every
  // one of those segments still has to survive okSeg, so a curve may no more cross a road than a
  // straight ever could. The bow's sign comes from the endpoints, so a park always curves the same
  // way. Bows are tried largest-first and a straight is the last resort, not the first choice.
  const tryCurve = (a, b, kind, em = 2.0, rm = 1.6, bow = 0.11) => {
    const pa = pt(a), pb = pt(b), L = dist2d(pa, pb);
    if (L < 26) return tryEdge(a, b, kind, em, rm);
    const ux = (pb[0] - pa[0]) / L, uy = (pb[1] - pa[1]) / L, nx = -uy, ny = ux;
    const sign = (Math.floor(pa[0] * 3.1 + pb[1] * 5.7) & 1) ? 1 : -1;
    const n = Math.min(10, Math.max(4, Math.round(L / 15)));
    for (const k of [bow * sign, -bow * sign, bow * 0.55 * sign, -bow * 0.55 * sign, 0]) {
      const cx = (pa[0] + pb[0]) / 2 + nx * k * L, cy = (pa[1] + pb[1]) / 2 + ny * k * L;
      const chain = [pa];
      for (let i = 1; i < n; i++) {
        const t = i / n, mt = 1 - t;
        chain.push([mt * mt * pa[0] + 2 * mt * t * cx + t * t * pb[0],
                    mt * mt * pa[1] + 2 * mt * t * cy + t * t * pb[1]]);
      }
      chain.push(pb);
      let ok = true;
      for (let i = 1; i < chain.length - 1 && ok; i++) if (!okPt(chain[i][0], chain[i][1], poly, em, rm)) ok = false;
      for (let i = 0; i + 1 < chain.length && ok; i++) if (!okSeg(chain[i], chain[i + 1], poly, em, rm)) ok = false;
      if (!ok) continue;
      let prev = a;
      for (let i = 1; i < chain.length - 1; i++) {
        const qi = addNode(chain[i][0], chain[i][1], false);
        rawEdge(prev, qi, kind); prev = qi;
      }
      return rawEdge(prev, b, kind) || prev !== a;
    }
    return tryEdge(a, b, kind, em, rm);
  };

  // ---- 3. THE BELT LOOP -------------------------------------------------------------------------
  // The walk that follows the park's own shape, inset into the boundary belt. This is the Parc
  // Municipal move: it curves because the polygon curves, it skirts the open middle, and because it
  // passes every entrance it makes crossing the park on foot a real route rather than decoration.
  const beltTarget = Math.min(17, Math.max(6, Math.sqrt(area) * 0.105));
  const bstep2 = Math.min(18, Math.max(6, perim / 90));
  const ring = boundarySamples(poly, bstep2);
  const offs = ring.map(s => {
    let depth = 0;
    for (let d = 2; d <= beltTarget * 2.6; d += 1.5) {
      if (!okPt(s.p[0] + s.n[0] * d, s.p[1] + s.n[1] * d, poly, 1.6, 1.4)) break;
      depth = d;
    }
    return Math.min(beltTarget, Math.max(3.5, depth * 0.5));
  });
  // A five-tap smooth, not three: the belt's inset is decided independently at every ring sample,
  // and with a short window the walk kinks in and out wherever the boundary has a notch. Widening
  // the window is what turns a jagged inset polygon into the sweeping line the aerials show.
  const sm = offs.map((_, i) => {
    const n = offs.length, at = (k) => offs[(i + k + n * 2) % n];
    return (at(-2) + at(-1) * 3 + at(0) * 4 + at(1) * 3 + at(2)) / 12;
  });
  const beltIdx = ring.map((s, i) => {
    const x = s.p[0] + s.n[0] * sm[i], y = s.p[1] + s.n[1] * sm[i];
    if (!okPt(x, y, poly, 2.0, 1.5)) return -1;
    return addNode(x, y, false);
  });
  const beltW = m.wild ? 0 : 1;   // wild greens get a gravel track, parks a gravel promenade
  for (let i = 0; i < beltIdx.length; i++) {
    const a = beltIdx[i], b = beltIdx[(i + 1) % beltIdx.length];
    if (a < 0 || b < 0) continue;
    // Two neighbouring samples whose insets differ a lot leave a long diagonal, and cutting it as a
    // straight chord would slice across the belt. Bend it instead. A single unbridged link like
    // this one is not a small defect: it opens the ring, the dead-end prune then eats the whole arc
    // back to the outermost gate, and one 20m jump was measured costing the Kirchberg green half
    // its walks — everything south-west of its four gates.
    if (dist2d(pt(a), pt(b)) > bstep2 * 3) { tryCurve(a, b, 0, 1.5, 1.3, 0.14); continue; }
    // A chord between two inset samples slips back outside the belt wherever the boundary turns in
    // on itself, so a failure here is a corner to be rounded, not a link to abandon. The bend is
    // pushed INWARD along the ring normal — the one direction that can possibly help — rather than
    // through tryEdge's six-way probe, because this runs once per belt sample per park.
    if (okSeg(pt(a), pt(b), poly, 1.8, 1.4)) { rawEdge(a, b, 0); continue; }
    const pa = pt(a), pb = pt(b), nrm = ring[i].n;
    for (const extra of [4.5, 10]) {
      const q = [(pa[0] + pb[0]) / 2 + nrm[0] * extra, (pa[1] + pb[1]) / 2 + nrm[1] * extra];
      if (!okPt(q[0], q[1], poly, 1.5, 1.3)) continue;
      if (!okSeg(pa, q, poly, 1.5, 1.3) || !okSeg(q, pb, poly, 1.5, 1.3)) continue;
      const qi = addNode(q[0], q[1], false);
      rawEdge(a, qi, 0); rawEdge(qi, b, 0);
      break;
    }
  }

  // ---- 3b. CLOSE THE BELT ----------------------------------------------------------------------
  // A belt sample is dropped wherever the boundary pinches or a road cuts in, and every drop splits
  // the ring into a separate arc. Arcs dangle at both ends, the dead-end prune below then eats them
  // back to the nearest gate, and the measured result was parks with 146 good belt nodes out of 171
  // keeping fifty edges — one half of the park laid out and the other half with no walk in it at
  // all. A walk does not stop at an obstruction, it goes round it. So every gap gets bridged: the
  // last good node before it joined to the first good node after it, with tryEdge free to swing the
  // link deeper into the park to clear whatever caused the gap. Once the ring closes, every node on
  // it has degree two and the prune cannot touch any of it.
  for (let i = 0; i < beltIdx.length; i++) {
    if (beltIdx[i] < 0) continue;
    let j = (i + 1) % beltIdx.length, span = 0;
    while (beltIdx[j] < 0 && span < beltIdx.length) { j = (j + 1) % beltIdx.length; span++; }
    if (!span) continue;                                   // the next sample is good; nothing to do
    const a = beltIdx[i], b = beltIdx[j];
    if (a < 0 || b < 0 || a === b) continue;
    if (dist2d(pt(a), pt(b)) > 110) continue;              // too far apart to be one walk
    tryEdge(a, b, 0, 1.6, 1.4) || tryCurve(a, b, 0, 1.6, 1.4, 0.16);
  }

  // ---- 3c. TURN A STRANDED BELT END INTO AN EXIT -----------------------------------------------
  // Some gaps cannot be bridged: a road genuinely cuts the green in two, or the boundary pinches to
  // nothing. The arc that stops there is not decoration — in the real city a walk that runs out at
  // the edge of a green beside a street is a way OUT, and leading somewhere is the whole point of
  // the rule. So a stranded belt end with a carriageway close outside it gets a short stub to a
  // terminal on the park edge and becomes an exit, instead of being pruned along with its arc.
  {
    const bdeg = new Map();
    for (const e of E) { bdeg.set(e.a, (bdeg.get(e.a) || 0) + 1); bdeg.set(e.b, (bdeg.get(e.b) || 0) + 1); }
    for (let i = 0; i < beltIdx.length; i++) {
      const bi = beltIdx[i];
      if (bi < 0 || (bdeg.get(bi) || 0) !== 1) continue;
      const s = ring[i];
      const probe = [s.p[0] - s.n[0] * 4, s.p[1] - s.n[1] * 4];
      if (roadDist(probe[0], probe[1], 26) >= 24) continue;         // it would lead nowhere
      const exit = [s.p[0] + s.n[0] * 1.3, s.p[1] + s.n[1] * 1.3];
      if (!okPt(exit[0], exit[1], poly, 0.7, 1.3)) continue;
      if (!okSeg(pt(bi), exit, poly, 0.7, 1.3, 1.0)) continue;
      rawEdge(bi, addNode(exit[0], exit[1], true), 1);
    }
  }

  // ---- 4. ENTRANCE STUBS ------------------------------------------------------------------------
  const gateNodes = [];
  for (const g of gates) {
    const oi = addNode(g.outer[0], g.outer[1], true);      // terminal: it leads OUT of the park
    const ii = addNode(g.inner[0], g.inner[1], false);
    rawEdge(oi, ii, 1);
    // hang the entrance on the nearest belt node
    let best = -1, bd = Infinity;
    for (const bi of beltIdx) {
      if (bi < 0) continue;
      const d = dist2d(pt(bi), g.inner);
      if (d < bd) { bd = d; best = bi; }
    }
    let joined = false;
    if (best >= 0 && bd < 120) joined = tryCurve(ii, best, 1, 1.8, 1.4, 0.08);
    gateNodes.push({g, oi, ii, belt: best, joined});
  }

  // ---- 4b. MAKE THE ENTRANCES REACH EACH OTHER ---------------------------------------------------
  // A small or awkwardly-shaped park has no room for a belt inside its boundary, so its entrances
  // end up on separate islands and the dead-end prune below would erase the whole park. The answer
  // is the thing a pedestrian would actually do: walk straight from one entrance to the next. This
  // is also exactly the Kirchberg pattern — gate to gate, no loop at all.
  {
    const find = (uf, i) => { while (uf[i] !== i) { uf[i] = uf[uf[i]]; i = uf[i]; } return i; };
    for (let pass = 0; pass < gateNodes.length; pass++) {
      const uf = N.map((_, i) => i);
      for (const e of E) { const ra = find(uf, e.a), rb = find(uf, e.b); if (ra !== rb) uf[ra] = rb; }
      const want = [];
      for (let i = 0; i < gateNodes.length; i++) for (let j = i + 1; j < gateNodes.length; j++) {
        const a = gateNodes[i], b = gateNodes[j];
        if (find(uf, a.ii) === find(uf, b.ii)) continue;
        const d = dist2d(pt(a.ii), pt(b.ii));
        if (d > 230) continue;            // a link this long is not a walk anybody takes
        want.push({a, b, d});
      }
      want.sort((p, q) => p.d - q.d);               // shortest hop first, so links stay sensible
      let joinedAny = false;
      for (const w of want) { if (tryCurve(w.a.ii, w.b.ii, 1, 1.8, 1.4, 0.09)) { joinedAny = true; break; } }
      if (!joinedAny) break;
    }
  }

  // ---- 5. DESIRE CHORDS -------------------------------------------------------------------------
  // Only where the belt is a detour. On a convex green (Kirchberg) this fires between opposite
  // corners and the chords cross in an X; on a concave landscape park the belt already serves the
  // pair and the middle stays an empty lawn, exactly as the aerial shows.
  //
  // The two idioms want different geometry and the photographs say so plainly. A short cut across a
  // small convex green IS a straight desire line, drawn by feet, and two of them crossing make the
  // X that gives Kirchberg its character — so those stay straight and get a real junction where
  // they meet. A cross-park walk in a big landscape park is not a desire line at all, it is a
  // designed sweep, and in Parc Municipal every one of them curves. So a big park's chords bow.
  const chordEdges = [];
  if (full && gateNodes.length >= 2) {
    const beltD = beltDistances(N, E, beltIdx);
    const pairs = [];
    for (let i = 0; i < gateNodes.length; i++) for (let j = i + 1; j < gateNodes.length; j++) {
      const a = gateNodes[i], b = gateNodes[j];
      const straight = dist2d(pt(a.ii), pt(b.ii));
      if (straight < 32) continue;
      const round = (a.belt >= 0 && b.belt >= 0) ? beltD(a.belt, b.belt) : Infinity;
      const ratio = round / straight;
      if (ratio < 1.42) continue;
      if (!okSeg(pt(a.ii), pt(b.ii), poly, 2.2, 1.7)) continue;
      pairs.push({a, b, ratio});
    }
    pairs.sort((p, q) => q.ratio - p.ratio);
    for (const p of pairs.slice(0, big ? 2 : 2)) {
      if (big) tryCurve(p.a.ii, p.b.ii, 1, 2.2, 1.7, 0.12);
      else if (rawEdge(p.a.ii, p.b.ii, 1)) chordEdges.push(E[E.length - 1]);
    }
    if (!big) splitCrossings(N, E, chordEdges);
  }

  // ---- 6. PROGRAMME ------------------------------------------------------------------------------
  const prog = full ? placeProgramme(m, rng, N, E, addNode, tryEdge, gateNodes, beltIdx, ring, sm, A, stats, big, medium) : null;

  // ---- 7. PRUNE EVERY DEAD END --------------------------------------------------------------------
  // Peel loose chains off in one linear pass: every time a node drops to degree 1 and is not an
  // entrance or a facility, its last edge goes and its neighbour is re-examined. Iterating the
  // whole edge list instead would be quadratic, and a belt arc is hundreds of nodes long.
  {
    const deg0 = new Array(N.length).fill(0);
    const inc = Array.from({length: N.length}, () => []);
    E.forEach((e, i) => { deg0[e.a]++; deg0[e.b]++; inc[e.a].push(i); inc[e.b].push(i); });
    const dead = new Uint8Array(E.length);
    const stack = [];
    for (let i = 0; i < N.length; i++) if (deg0[i] === 1 && !N[i].term) stack.push(i);
    while (stack.length) {
      const u = stack.pop();
      if (deg0[u] !== 1 || N[u].term) continue;
      for (const ei of inc[u]) {
        if (dead[ei]) continue;
        dead[ei] = 1;
        const v = E[ei].a === u ? E[ei].b : E[ei].a;
        deg0[u]--; deg0[v]--;
        if (deg0[v] === 1 && !N[v].term) stack.push(v);
        break;
      }
    }
    for (let i = E.length - 1; i >= 0; i--) if (dead[i]) E.splice(i, 1);
  }
  if (!E.length) { stats.why.prunedAway = (stats.why.prunedAway||0)+1; return false; }

  // ---- 8. RIBBON + JUNCTION DISCS ------------------------------------------------------------------
  const WIDTH = [2.2, 3.0, 1.8];   // 0 belt walk, 1 main walk, 2 spur
  const deg = new Array(N.length).fill(0), halfAt = new Array(N.length).fill(0);
  for (const e of E) {
    const w = WIDTH[e.kind] || 2.2;
    A.quads.push({ax: N[e.a].x, ay: N[e.a].y, bx: N[e.b].x, by: N[e.b].y, w, kind: e.kind});
    deg[e.a]++; deg[e.b]++;
    halfAt[e.a] = Math.max(halfAt[e.a], w / 2); halfAt[e.b] = Math.max(halfAt[e.b], w / 2);
  }
  for (let i = 0; i < N.length; i++) {
    if (deg[i] === 1) {
      // Every loose end of the finished network, recorded so the "no walk dead-ends in grass"
      // rule can be COUNTED from outside rather than taken on trust. term is true only for an
      // entrance (it leads out of the park) or a facility (it leads to a thing).
      A.endpoints.push({x: N[i].x, y: N[i].y, term: !!N[i].term});
      continue;
    }
    if (deg[i] < 2) continue;
    A.discs.push({x: N[i].x, y: N[i].y, r: halfAt[i], rgb: PAVED, y0: 0.088, seg: 8});
  }

  if (full) dressPark(m, rng, N, E, deg, A, prog, gateNodes, big, medium);
  // A lawn compartment is MOWN OPEN GRASS in the aerial — the Parc Municipal north lawn has a
  // skirting walk and not one tree in the middle. Tell scene.js to keep its wild tree fill out of
  // it; without that hook the compartment reads as woodland, which is the opposite of the truth.
  if (m.compartment) A.keepClear.push({x: m.cx, y: m.cy, r: Math.min(m.w, m.h) * 0.42});
  if (full) stats.full++; else if (m.wild) stats.wild++; else stats.compartment++;
  stats.perPark.push({pi, area: Math.round(area), kind: full ? 'park' : m.wild ? 'wood' : 'lawn',
    idx: +(m.parkIndex ?? 1).toFixed(2), gates: gateNodes.length,
    belt: `${beltIdx.filter(i => i >= 0).length}/${beltIdx.length}`,
    beltKept: E.filter(e => e.kind === 0).length, edges: E.length,
    prog: [prog?.cafe && 'cafe', prog?.play && 'play', prog?.dog && 'dog',
           prog?.pond && 'pond', prog?.rings && 'rings', prog?.rondel && 'rondel'].filter(Boolean).join('+')});
  return true;
}

// Shortest-path distance between two belt nodes, walking the belt edges only. Used to decide
// whether a straight chord between two entrances is worth drawing.
function beltDistances(N, E, beltIdx) {
  const set = new Set(beltIdx.filter(i => i >= 0));
  const adj = new Map();
  for (const e of E) {
    if (e.kind !== 0 || !set.has(e.a) || !set.has(e.b)) continue;
    const w = Math.hypot(N[e.a].x - N[e.b].x, N[e.a].y - N[e.b].y);
    if (!adj.has(e.a)) adj.set(e.a, []); if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push([e.b, w]); adj.get(e.b).push([e.a, w]);
  }
  return (from, to) => {
    if (from === to) return 0;
    const d = new Map([[from, 0]]);
    const q = [from];
    // the belt is a ring: a simple relaxation queue is plenty at this node count
    for (let guard = 0; q.length && guard < 20000; guard++) {
      const u = q.shift(), du = d.get(u);
      for (const [v, w] of (adj.get(u) || [])) {
        const nd = du + w;
        if (d.has(v) && d.get(v) <= nd + 1e-6) continue;
        d.set(v, nd); q.push(v);
      }
    }
    return d.has(to) ? d.get(to) : Infinity;
  };
}

// Where two chords cross, make a real junction — that X in the middle of the Kirchberg green is
// the whole character of that park, and two ribbons passing through each other without a node
// would leave a notch in the merged surface.
function splitCrossings(N, E, chords) {
  for (let i = 0; i < chords.length; i++) {
    for (let j = i + 1; j < chords.length; j++) {
      const e1 = chords[i], e2 = chords[j];
      if (!E.includes(e1) || !E.includes(e2)) continue;
      const p = segIntersect(N[e1.a], N[e1.b], N[e2.a], N[e2.b]);
      if (!p) continue;
      N.push({x: p[0], y: p[1], term: false});
      const k = N.length - 1;
      const b1 = e1.b, b2 = e2.b;
      e1.b = k; e2.b = k;
      E.push({a: k, b: b1, kind: e1.kind}, {a: k, b: b2, kind: e2.kind});
    }
  }
}
function segIntersect(a, b, c, d) {
  const r = [b.x - a.x, b.y - a.y], s = [d.x - c.x, d.y - c.y];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * s[1] - (c.y - a.y) * s[0]) / den;
  const u = ((c.x - a.x) * r[1] - (c.y - a.y) * r[0]) / den;
  if (t < 0.08 || t > 0.92 || u < 0.08 || u > 0.92) return null;
  return [a.x + r[0] * t, a.y + r[1] * t];
}

// --- surface colours (vertex-coloured into the one merged ground mesh) ---------------------------
const GRAVEL = [0.80, 0.68, 0.46];   // honey self-binding gravel — the real allée surface
const PAVED  = [0.82, 0.77, 0.66];   // warm pale limestone
const EDGE   = [0.34, 0.28, 0.20];   // soil edging
const SAND   = [0.86, 0.66, 0.34];   // playground safety surface — warm, so it reads as sand from the air
const EARTH  = [0.47, 0.35, 0.23];   // dog run — bare beaten earth
const DECK   = [0.54, 0.35, 0.21];   // cafe terrace boards
const WATER  = [0.16, 0.30, 0.34];
const FOAM   = [0.72, 0.80, 0.80];   // the plume where a pond's jet lands
const BANK   = [0.42, 0.40, 0.31];
const MOWN   = [0.29, 0.46, 0.24];

// Splice a spur into the network: find the closest point on any existing walk, make a junction
// there, and run a short path to `px,py`. The far end is a TERMINAL because it ends at a facility,
// which is the only reason a path is allowed to stop.
//
// `joinTo` connects to an EXISTING node instead of making a terminal, which is how a closed circuit
// — the pond walk, the parterre ring — gets hooked onto the rest of the park. In that case the
// circuit's own edges are the nearest thing to it by miles, so they are excluded from the search;
// otherwise the ring would cheerfully splice into itself and stay an island.
function attachSpur(N, E, addNode, poly, px, py, joinTo = -1) {
  const ban = new Set();
  if (joinTo >= 0) {
    const q = [joinTo]; ban.add(joinTo);
    for (let guard = 0; q.length && guard < 400; guard++) {          // the whole connected circuit
      const u = q.shift();
      for (const e of E) {
        const v = e.a === u ? e.b : e.b === u ? e.a : -1;
        if (v >= 0 && !ban.has(v)) { ban.add(v); q.push(v); }
      }
    }
  }
  let best = null;
  for (let ei = 0; ei < E.length; ei++) {
    const e = E[ei];
    if (ban.has(e.a) || ban.has(e.b)) continue;
    const a = N[e.a], b = N[e.b];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    let t = ((px - a.x) * dx + (py - a.y) * dy) / l2;
    t = Math.max(0.12, Math.min(0.88, t));
    const qx = a.x + t * dx, qy = a.y + t * dy, d = Math.hypot(px - qx, py - qy);
    if (!best || d < best.d) best = {d, ei, qx, qy};
  }
  if (!best || best.d > 90) return null;
  if (!okSeg([best.qx, best.qy], [px, py], poly, 1.0, 1.2)) return null;
  const e = E[best.ei], ea = e.a, eb = e.b, ek = e.kind;
  E.splice(best.ei, 1);
  const ji = addNode(best.qx, best.qy, false);
  E.push({a: ea, b: ji, kind: ek}, {a: ji, b: eb, kind: ek});
  const ti = joinTo >= 0 ? joinTo : addNode(px, py, true);
  E.push({a: ji, b: ti, kind: 2});
  return {ji, ti};
}

// Does an axis-rotated rectangle fit entirely on legal ground? Tested at the corners, the edge
// midpoints and the centre — a facility may no more sit in a carriageway than a path may cross one.
function fitRect(poly, cx, cy, ang, hw, hh, em = 2.5, rm = 2.0) {
  const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
  for (const [a, b] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = cx + ux * hh * a + vx * hw * b, y = cy + uy * hh * a + vy * hw * b;
    if (!okPt(x, y, poly, em, rm)) return false;
  }
  return true;
}
// Keep a facility off the walks that already exist (its own spur is added afterwards).
function clearOfPaths(N, E, cx, cy, rad) {
  for (const e of E) {
    const a = N[e.a], b = N[e.b];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    let t = ((cx - a.x) * dx + (cy - a.y) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (Math.hypot(cx - (a.x + t * dx), cy - (a.y + t * dy)) < rad) return false;
  }
  return true;
}

// Ring a facility with fencing: panels laid along the rectangle's perimeter, with a gap left on
// the side the spur arrives from so there is a way in.
function fenceRect(bucket, cx, cy, ang, hw, hh, panel, gapAt) {
  const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
  const corner = (a, b) => [cx + ux * hh * a + vx * hw * b, cy + uy * hh * a + vy * hw * b];
  const ring = [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
  for (let i = 0; i < 4; i++) {
    const p = ring[i], q = ring[(i + 1) % 4];
    const L = dist2d(p, q), n = Math.max(1, Math.round(L / panel));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const x = p[0] + (q[0] - p[0]) * t, y = p[1] + (q[1] - p[1]) * t;
      if (gapAt && dist2d([x, y], gapAt) < panel * 1.3) continue;    // the gate
      bucket.push({x, y, rot: Math.atan2(q[0] - p[0], -(q[1] - p[1])), s: L / n / panel});
    }
  }
}

// ==============================================================================================
// PROGRAMME — where a public-space planner puts the things people come for
// ==============================================================================================
function placeProgramme(m, rng, N, E, addNode, tryEdge, gateNodes, beltIdx, ring, sm, A, stats, big, medium) {
  const {poly, area, pi} = m;
  const out = {};

  // ---- features copied straight off the aerial ------------------------------------------------
  // A hint is a photograph, not a licence: it is placed only if the same clearance tests every
  // computed element faces let it stand. If it will not fit at full size it is shrunk about its own
  // centre — which keeps a traced outline's SHAPE, the whole reason for tracing it — and if it will
  // not fit shrunk, it is dropped. A photograph may not put a pond in a carriageway.
  for (const f of IMAGERY) {
    if (!pointInPoly(f.x, f.y, poly)) continue;
    let k = 1;
    // Water has to be clear of the walks — a walk through a pond is a walk in a pond. A PAVED
    // feature does not: the rings and the parterre are surfaces people walk on, and in the
    // photographs the park's walks run right up to them and across them.
    // Water is already reserved — setBlockers kept every walk out of it before the first edge was
    // drawn — so all that is left to confirm is that the traced shape sits on legal ground inside
    // the park and off the carriageway. A PAVED feature (the rings, the parterre) is not reserved
    // at all: those are surfaces people walk on, and in the photographs the walks run over them.
    const fits = (s) => {
      if (!f.outline) return okPt(f.x, f.y, poly, f.r * s * 0.85, 2);
      return f.outline.every(p => okPt(f.x + (p[0] - f.x) * s * 1.14, f.y + (p[1] - f.y) * s * 1.14,
                                       poly, 1.5, 1.8, true));
    };
    while (k > 0.45 && !fits(k)) k -= 0.08;
    if (k <= 0.45) continue;
    const r = f.r * k;
    const scaled = f.outline ? f.outline.map(p => [f.x + (p[0] - f.x) * k, f.y + (p[1] - f.y) * k]) : null;

    if (f.kind === 'pond') {
      // The traced outline, drawn twice: a muddy bank ring a shade wider, then the water inside it.
      A.polys.push({pts: scaled.map(p => [f.x + (p[0] - f.x) * 1.14, f.y + (p[1] - f.y) * 1.14]), rgb: BANK, y0: 0.05});
      A.polys.push({pts: scaled, rgb: WATER, y0: 0.06});
      if (f.jet) {
        const jx = f.x + (f.jet[0] - f.x) * k, jy = f.y + (f.jet[1] - f.y) * k;
        A.discs.push({x: jx, y: jy, r: 2.2 * k, rgb: FOAM, y0: 0.07, seg: 10});   // the fountain plume
      }
      out.pond = {x: f.x, y: f.y, r, pts: scaled};
      A.keepClear.push({x: f.x, y: f.y, r: r + 2.5});
    } else if (f.kind === 'rings') {
      // Concentric paved rings. Eight discs from the outside in, alternating paving and grass, is
      // both what the photograph shows and eight fans in the merged mesh.
      for (let i = 0; i < 8; i++) {
        A.discs.push({x: f.x, y: f.y, r: r * (1 - i / 8), rgb: i % 2 ? MOWN : PAVED,
                      y0: 0.05 + i * 0.002, seg: 20});
      }
      out.rings = {x: f.x, y: f.y, r};
      A.keepClear.push({x: f.x, y: f.y, r: r + 1.5});
    } else if (f.kind === 'rondel') {
      out.rondel = {x: f.x, y: f.y, r};
      A.keepClear.push({x: f.x, y: f.y, r: r + 1.5});
    }
    stats.imagery.push(`green ${pi}: ${f.kind} r=${r.toFixed(0)}m at map [${f.x.toFixed(0)}, ${f.y.toFixed(0)}]` +
                       `${k < 1 ? ` (shrunk to ${(k * 100).toFixed(0)}% to clear)` : ''} — ${f.prov}`);
  }
  // The rondel is a WALK, not a surface, so it is built into the graph rather than the ground mesh:
  // a ring of nodes at the parterre's edge, closed, and one link back to the rest of the park. A
  // closed ring has no degree-1 node anywhere on it, so the dead-end prune cannot touch it.
  if (out.rondel) {
    const R = out.rondel, seg = 18, rw = R.r * 0.84;
    const idx = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const x = R.x + Math.cos(a) * rw, y = R.y + Math.sin(a) * rw;
      idx.push(okPt(x, y, poly, 1.5, 1.5) ? addNode(x, y, false) : -1);
    }
    let live = 0;
    for (let i = 0; i < seg; i++) {
      const a = idx[i], b = idx[(i + 1) % seg];
      if (a >= 0 && b >= 0 && tryEdge(a, b, 0, 1.2, 1.4)) live++;
    }
    if (live < seg - 2) { delete out.rondel; }        // a broken ring is worse than none
    else {
      A.discs.push({x: R.x, y: R.y, r: R.r * 0.74, rgb: MOWN, y0: 0.05, seg: 20});   // the mown oval
      A.discs.push({x: R.x, y: R.y, r: R.r * 0.20, rgb: BANK, y0: 0.06, seg: 14});   // basin coping
      A.discs.push({x: R.x, y: R.y, r: R.r * 0.16, rgb: WATER, y0: 0.07, seg: 14});  // the basin
      // clipped beds standing ON the ring, the way the photograph has them
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + 0.26;
        const hx = R.x + Math.cos(a) * R.r * 0.95, hy = R.y + Math.sin(a) * R.r * 0.95;
        if (okPt(hx, hy, poly, 1.2, 1.4)) A.shrubCones.push({x: hx, y: hy, s: 0.95, tint: 0x2f5f37});
      }
      const near = idx.find(i => i >= 0);
      if (near >= 0) attachSpur(N, E, addNode, poly, N[near].x, N[near].y, near);
    }
  }
  // A pond in a landscape park is walked AROUND — both aerials show the walk hugging the water on
  // every side. A circuit at the bank does that, and being a ring it is again prune-proof.
  if (out.pond?.pts) {
    const P = out.pond, off = 5.0, idx = [];
    for (const p of P.pts) {
      const d = Math.hypot(p[0] - P.x, p[1] - P.y) || 1;
      const x = P.x + (p[0] - P.x) * (d + off) / d, y = P.y + (p[1] - P.y) * (d + off) / d;
      idx.push(okPt(x, y, poly, 1.5, 1.6) ? addNode(x, y, false) : -1);
    }
    let live = 0, broken = 0;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[i], b = idx[(i + 1) % idx.length];
      if (a >= 0 && b >= 0 && tryEdge(a, b, 2, 1.2, 1.4)) live++; else broken++;
    }
    if (broken <= 1 && live > 4) {
      const near = idx.find(i => i >= 0);
      if (near >= 0) attachSpur(N, E, addNode, poly, N[near].x, N[near].y, near);
    }
  }

  // ---- candidate pockets: legal ground inside the belt, off the open middle --------------------
  const pockets = [];
  const stride = Math.max(1, Math.floor(ring.length / 26));
  for (let i = 0; i < ring.length; i += stride) {
    const s = ring[i];
    for (const extra of [11, 19, 29]) {
      const d = sm[i] + extra;
      const x = s.p[0] + s.n[0] * d, y = s.p[1] + s.n[1] * d;
      if (!okPt(x, y, poly, 7, 3.5)) continue;
      pockets.push({x, y, ang: Math.atan2(s.n[1], s.n[0]),
                    quiet: roadDist(x, y, 28), edge: edgeDist(x, y, poly)});
    }
  }
  if (!pockets.length) return out;

  const busiest = gateNodes.slice().sort((a, b) => a.g.rd - b.g.rd)[0];
  const bp = [N[busiest.ii].x, N[busiest.ii].y];
  const scale = Math.min(1, Math.sqrt(area) / 130);
  const take = (cands, score) => {
    let best = null, bs = -Infinity;
    for (const p of cands) { const v = score(p); if (v > bs) { bs = v; best = p; } }
    return best;
  };
  const free = (p, hw, hh) => fitRect(poly, p.x, p.y, p.ang, hw, hh) &&
                              clearOfPaths(N, E, p.x, p.y, Math.max(hw, hh) + 2) &&
                              (!out.pond || dist2d([p.x, p.y], [out.pond.x, out.pond.y]) > out.pond.r + Math.max(hw, hh) + 4);

  // CAFE + VERANDA — at the busiest entrance, where people already walk past.
  if (medium) {
    const hw = 6.5 * scale + 2, hh = 5 * scale + 1.5;
    const c = take(pockets.filter(p => free(p, hw, hh) && dist2d([p.x, p.y], bp) < 85),
                   p => -dist2d([p.x, p.y], bp));
    if (c) out.cafe = {x: c.x, y: c.y, ang: c.ang, hw, hh};
  }
  // PLAYGROUND — set back from traffic, but on the network so it is overlooked, and well away
  // from the cafe terrace and (below) the dog run.
  {
    const hw = 7.5 * scale + 2.5, hh = 6 * scale + 2;
    const c = take(pockets.filter(p => free(p, hw, hh) &&
                     (!out.cafe || dist2d([p.x, p.y], [out.cafe.x, out.cafe.y]) > 26)),
                   p => p.quiet * 1.6 + p.edge * 0.5);
    if (c) out.play = {x: c.x, y: c.y, ang: c.ang, hw, hh};
  }
  // DOG RUN — fenced, in the park's own quiet depth, never beside the playground or the terrace.
  if (big) {
    const hw = 9 * scale + 3, hh = 6.5 * scale + 2;
    const c = take(pockets.filter(p => free(p, hw, hh) &&
                     (!out.play || dist2d([p.x, p.y], [out.play.x, out.play.y]) > 45) &&
                     (!out.cafe || dist2d([p.x, p.y], [out.cafe.x, out.cafe.y]) > 32)),
                   p => p.edge * 1.2 + p.quiet * 0.5);
    if (c) out.dog = {x: c.x, y: c.y, ang: c.ang, hw, hh};
  }

  // ---- realise each facility and wire it to the network ----------------------------------------
  if (out.cafe) {
    const c = out.cafe;
    const door = [c.x + Math.cos(c.ang) * -(c.hh + 1), c.y + Math.sin(c.ang) * -(c.hh + 1)];
    if (!attachSpur(N, E, addNode, poly, door[0], door[1])) { delete out.cafe; }
    else {
      A.keepClear.push({x: c.x, y: c.y, r: Math.hypot(c.hw, c.hh) + 2});
      A.rects.push({x: c.x, y: c.y, ang: c.ang, hw: c.hw, hh: c.hh, rgb: DECK, y0: 0.072});
      // kiosk at the back of the deck, counter facing the terrace; parasol tables in front of it
      const kx = c.x + Math.cos(c.ang) * (c.hh - 1.6), ky = c.y + Math.sin(c.ang) * (c.hh - 1.6);
      A.kiosks.push({x: kx, y: ky, rot: faceRot(kx, ky, door[0], door[1])});
      const ux = Math.cos(c.ang), uy = Math.sin(c.ang), vx = -uy, vy = ux;
      let t = 0;
      for (let r = 0; r < 2; r++) for (let s = -1; s <= 1; s++) {
        const tx = c.x + ux * (c.hh - 5.2 - r * 3.4) + vx * s * (c.hw * 0.52);
        const ty = c.y + uy * (c.hh - 5.2 - r * 3.4) + vy * s * (c.hw * 0.52);
        if (!okPt(tx, ty, poly, 1.5, 1.5)) continue;
        A.tables.push({x: tx, y: ty});
        A.parasols.push({x: tx, y: ty, tint: [0xd8543f, 0xe0e0d6, 0x3f6b8f][(t++) % 3]});
        for (const a of [0, Math.PI * 0.66, Math.PI * 1.33]) {
          const chx = tx + Math.cos(c.ang + a) * 0.95, chy = ty + Math.sin(c.ang + a) * 0.95;
          if (okPt(chx, chy, poly, 1.2, 1.2)) A.chairs.push({x: chx, y: chy, rot: faceRot(chx, chy, tx, ty)});
        }
      }
      A.bins.push({x: door[0], y: door[1], rot: faceRot(door[0], door[1], c.x, c.y)});
    }
  }
  if (out.play) {
    const p = out.play;
    const door = [p.x + Math.cos(p.ang) * -(p.hh + 1), p.y + Math.sin(p.ang) * -(p.hh + 1)];
    if (!attachSpur(N, E, addNode, poly, door[0], door[1])) { delete out.play; }
    else {
      A.keepClear.push({x: p.x, y: p.y, r: Math.hypot(p.hw, p.hh) + 2});
      A.rects.push({x: p.x, y: p.y, ang: p.ang, hw: p.hw, hh: p.hh, rgb: SAND, y0: 0.072});
      fenceRect(A.fenceLow, p.x, p.y, p.ang, p.hw + 0.6, p.hh + 0.6, 1.8, door);
      const ux = Math.cos(p.ang), uy = Math.sin(p.ang), vx = -uy, vy = ux;
      const at = (a, b) => [p.x + ux * p.hh * a * 0.55 + vx * p.hw * b * 0.55,
                            p.y + uy * p.hh * a * 0.55 + vy * p.hw * b * 0.55];
      // A real playground is CROWDED — swings, a slide tower, a climbing frame and a sandpit inside
      // one small pad. A pad with three lonely items on it reads as a car park from the air.
      const swing = at(0.62, -0.62), slide = at(0.55, 0.72), climb = at(-0.62, 0.3), pit = at(-0.6, -0.55);
      A.swings.push({x: swing[0], y: swing[1], rot: p.ang + Math.PI / 2, tint: 0xd94f3d});
      A.slides.push({x: slide[0], y: slide[1], rot: faceRot(slide[0], slide[1], p.x, p.y), tint: 0x2f6fb0});
      A.climbers.push({x: climb[0], y: climb[1], rot: p.ang, tint: 0xe0a72c});
      A.discs.push({x: pit[0], y: pit[1], r: Math.min(3.2, p.hw * 0.34), rgb: [0.93, 0.83, 0.58], y0: 0.078, seg: 12});
      const mid = at(0, 0.05);
      A.climbers.push({x: mid[0], y: mid[1], rot: p.ang + 0.6, tint: 0x3f9a58});
      // parents' benches on the pad edge, facing in — a playground bench faces the children
      for (const s of [-1, 1]) {
        const bx = p.x + vx * (p.hw - 0.9) * s - ux * p.hh * 0.45;
        const by = p.y + vy * (p.hw - 0.9) * s - uy * p.hh * 0.45;
        if (okPt(bx, by, poly, 1.5, 1.5)) A.benches.push({x: bx, y: by, rot: faceRot(bx, by, p.x, p.y)});
      }
      A.bins.push({x: door[0], y: door[1], rot: faceRot(door[0], door[1], p.x, p.y)});
    }
  }
  if (out.dog) {
    const d = out.dog;
    const door = [d.x + Math.cos(d.ang) * -(d.hh + 1), d.y + Math.sin(d.ang) * -(d.hh + 1)];
    if (!attachSpur(N, E, addNode, poly, door[0], door[1])) { delete out.dog; }
    else {
      A.keepClear.push({x: d.x, y: d.y, r: Math.hypot(d.hw, d.hh) + 2});
      A.rects.push({x: d.x, y: d.y, ang: d.ang, hw: d.hw, hh: d.hh, rgb: EARTH, y0: 0.072});
      fenceRect(A.fenceTall, d.x, d.y, d.ang, d.hw + 0.6, d.hh + 0.6, 2.0, door);
      const ux = Math.cos(d.ang), uy = Math.sin(d.ang), vx = -uy, vy = ux;
      A.hoops.push({x: d.x + vx * d.hw * 0.4, y: d.y + vy * d.hw * 0.4, rot: d.ang});
      A.ramps.push({x: d.x - vx * d.hw * 0.45 + ux * d.hh * 0.3,
                    y: d.y - vy * d.hw * 0.45 + uy * d.hh * 0.3, rot: d.ang + Math.PI / 2});
      A.bins.push({x: door[0], y: door[1], rot: faceRot(door[0], door[1], d.x, d.y)});
    }
  }
  return out;
}

// ==============================================================================================
// DRESSING — benches that face something, beds where people gather, planting in the belt
// ==============================================================================================
function dressPark(m, rng, N, E, deg, A, prog, gateNodes, big, medium) {
  const {poly, area, pi, cx, cy} = m;
  const FLOWER_TINTS = [0xd23a3a, 0xe86ea0, 0xf2c527, 0x3f6fd2, 0xffffff, 0x8a3fb0, 0xe8721f];
  const FOLIAGE_TINTS = [0x3a6b39, 0x467a41, 0x2f5f37, 0x568042, 0x355b33];
  const CROWN_TINTS = [0x4a7a41, 0x6a8a3c, 0x3f6b3a, 0x568042, 0x2f5f37, 0x4a7a41, 0x3f6b3a, 0x568042, 0x2f5f37, 0xc06a8a];
  const focus = prog?.pond ? [prog.pond.x, prog.pond.y] : [cx, cy];

  // --- benches along the walks, on the outer side, facing across the walk into the park ---------
  const benchCap = big ? 14 : medium ? 8 : 4;
  let placed = 0, carry = 0;
  for (const e of E) {
    if (placed >= benchCap || e.kind === 2) continue;
    const a = N[e.a], b = N[e.b], L = Math.hypot(b.x - a.x, b.y - a.y);
    carry += L;
    if (carry < 34) continue;
    carry = 0;
    const t = 0.5, mx = a.x + (b.x - a.x) * t, my = a.y + (b.y - a.y) * t;
    const nx = -(b.y - a.y) / (L || 1), ny = (b.x - a.x) / (L || 1);
    // the side AWAY from the park's middle, so the sitter looks back across the walk at the lawn
    const side = ((mx - focus[0]) * nx + (my - focus[1]) * ny) > 0 ? 1 : -1;
    for (const s of [side, -side]) {
      const bx = mx + nx * s * 2.3, by = my + ny * s * 2.3;
      if (!okPt(bx, by, poly, 1.6, 1.6)) continue;
      A.benches.push({x: bx, y: by, rot: faceRot(bx, by, mx, my)});
      if (rng() < 0.45) A.bins.push({x: bx + nx * s * 1.6, y: by + ny * s * 1.6, rot: faceRot(bx, by, mx, my)});
      placed++; break;
    }
  }
  // --- benches facing the pond, the classic thing to face ---------------------------------------
  if (prog?.pond) {
    const P = prog.pond;
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + 0.4;
      const bx = P.x + Math.cos(a) * (P.r + 3.2), by = P.y + Math.sin(a) * (P.r + 3.2);
      if (okPt(bx, by, poly, 1.6, 1.6)) A.benches.push({x: bx, y: by, rot: faceRot(bx, by, P.x, P.y)});
    }
  }

  // --- flowerbeds at the junctions people converge on, and flanking each entrance ---------------
  const bedAt = (bx, by, idx) => {
    if (!okPt(bx, by, poly, 2.2, 1.8)) return;
    const tint = FLOWER_TINTS[(pi + idx) % FLOWER_TINTS.length];
    const r = 1.3 + rng() * 1.1;
    A.soils.push({x: bx, y: by, s: r * 2.15, r: r + 0.35});
    for (let gx = -r; gx <= r; gx += 0.72) for (let gy = -r; gy <= r; gy += 0.72) {
      if (gx * gx + gy * gy > r * r) continue;
      A.flowers.push({x: bx + gx + (rng() - 0.5) * 0.22, y: by + gy + (rng() - 0.5) * 0.22,
                      tint, h: 0.8 + rng() * 0.7});
    }
  };
  let bedIdx = 0;
  const junctions = [];
  for (let i = 0; i < N.length; i++) if (deg[i] >= 3) junctions.push(i);
  for (const j of junctions.slice(0, big ? 5 : 3)) {
    for (const s of [1, -1]) {
      const ang = (N[j].x * 0.31 + N[j].y * 0.17);
      bedAt(N[j].x + Math.cos(ang) * 4.2 * s, N[j].y + Math.sin(ang) * 4.2 * s, bedIdx++);
    }
  }
  // --- entrance furniture: planters and topiary flanking the gate, bollards across it ------------
  const busiest = gateNodes.slice().sort((a, b) => a.g.rd - b.g.rd)[0];
  for (const gn of gateNodes) {
    const o = N[gn.oi], inn = N[gn.ii];
    const L = Math.hypot(inn.x - o.x, inn.y - o.y) || 1;
    const nx = -(inn.y - o.y) / L, ny = (inn.x - o.x) / L;
    for (const s of [1, -1]) {
      const px = o.x + nx * s * 2.4, py = o.y + ny * s * 2.4;
      if (okPt(px, py, poly, 0.8, 1.0)) A.bollards.push({x: px, y: py, rot: 0});
      const tx = inn.x + nx * s * 2.8, ty = inn.y + ny * s * 2.8;
      if (okPt(tx, ty, poly, 1.4, 1.4)) {
        A.shrubCones.push({x: tx, y: ty, s: 1.05, tint: 0x2f5f37});
        A.planters.push({x: inn.x + nx * s * 4.4, y: inn.y + ny * s * 4.4});
      }
    }
    bedAt(inn.x + nx * 3.4, inn.y + ny * 3.4, bedIdx++);
    if (okPt(inn.x, inn.y, poly, 1.4, 1.4)) A.bins.push({x: inn.x + nx * -3.4, y: inn.y + ny * -3.4, rot: faceRot(inn.x, inn.y, o.x, o.y)});
    if (gn === busiest) {
      const rx = inn.x + nx * 5.6, ry = inn.y + ny * 5.6;
      if (okPt(rx, ry, poly, 1.4, 1.4)) A.racks.push({x: rx, y: ry, rot: Math.atan2(inn.x - o.x, -(inn.y - o.y))});
      const sx = inn.x - nx * 5.6, sy = inn.y - ny * 5.6;
      if (okPt(sx, sy, poly, 1.4, 1.4)) A.signs.push({x: sx, y: sy, rot: faceRot(sx, sy, o.x, o.y)});
    }
  }
  // --- a drinking fountain at the busiest junction of a big park --------------------------------
  if (big && junctions.length) {
    const j = junctions[0];
    const fx = N[j].x + 3.6, fy = N[j].y + 1.2;
    if (okPt(fx, fy, poly, 1.4, 1.4)) A.fountains.push({x: fx, y: fy, rot: faceRot(fx, fy, N[j].x, N[j].y)});
  }

  // --- allée trees down the main walks, both sides, and a shrub screen in the belt ---------------
  const alleeCap = big ? 60 : medium ? 30 : 14;
  let allee = 0;
  for (const e of E) {
    if (e.kind !== 1 || allee >= alleeCap) continue;
    const a = N[e.a], b = N[e.b], L = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / (L || 1), uy = (b.y - a.y) / (L || 1), nx = -uy, ny = ux;
    for (let d = 6; d < L - 3 && allee < alleeCap; d += 6.5) {
      for (const s of [1, -1]) {
        const tx = a.x + ux * d + nx * s * 3.0, ty = a.y + uy * d + ny * s * 3.0;
        if (!okPt(tx, ty, poly, 2.0, 2.0)) continue;
        A.ornTrees.push({x: tx, y: ty, s: 0.92 + ((Math.floor(d) + s) % 3) * 0.12,
                         rot: (tx + ty) % (Math.PI * 2), tint: CROWN_TINTS[(pi + Math.floor(d / 6.5)) % CROWN_TINTS.length]});
        allee++;
      }
    }
  }
  // Shrub masses go in the BELT — between the walk and the boundary — never out in the lawn. That
  // is what the aerials show: planting screens the street, the middle is left open.
  const shrubCap = big ? 40 : medium ? 22 : 10;
  let shrubs = 0;
  for (const e of E) {
    if (e.kind !== 0 || shrubs >= shrubCap) continue;
    const a = N[e.a], b = N[e.b], L = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / (L || 1), ny = (b.x - a.x) / (L || 1);
    const side = ((a.x - focus[0]) * nx + (a.y - focus[1]) * ny) > 0 ? 1 : -1;
    for (let d = 3; d < L && shrubs < shrubCap; d += 7) {
      const t = d / (L || 1);
      const mx = a.x + (b.x - a.x) * t, my = a.y + (b.y - a.y) * t;
      const off = 3.4 + rng() * 2.6;
      const sx = mx + nx * side * off, sy = my + ny * side * off;
      if (!okPt(sx, sy, poly, 1.4, 1.6)) continue;
      const clump = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < clump; k++) {
        const jx = sx + (rng() - 0.5) * 2.6, jy = sy + (rng() - 0.5) * 2.6;
        if (!okPt(jx, jy, poly, 1.2, 1.5)) continue;
        const sc = 0.8 + rng() * 0.7, tint = FOLIAGE_TINTS[Math.floor(rng() * FOLIAGE_TINTS.length)];
        if (rng() < 0.75) A.shrubDomes.push({x: jx, y: jy, s: sc, tint});
        else A.shrubCones.push({x: jx, y: jy, s: sc, tint});
      }
      shrubs++;
    }
  }
}

// ==============================================================================================
// REALISATION — every repeated thing is one InstancedMesh; every flat surface is one merged mesh
// ==============================================================================================
function realise(group, A) {
  const MATS = {
    flower: new THREE.MeshLambertMaterial({color: 0xffffff}),
    soil:   new THREE.MeshLambertMaterial({color: 0x4a3527}),
    tub:    new THREE.MeshStandardMaterial({color: 0x9c968b, roughness: 0.9, metalness: 0.0}),
    foliage:new THREE.MeshLambertMaterial({color: 0xffffff}),
    trunk:  new THREE.MeshLambertMaterial({color: 0x5a4635}),
    crown:  new THREE.MeshLambertMaterial({color: 0xffffff}),
    bench:  new THREE.MeshStandardMaterial({color: 0x6a4a30, roughness: 0.75, metalness: 0.0}),
    iron:   new THREE.MeshLambertMaterial({color: 0x2f4438}),   // park railings, municipal green-black
    play:   new THREE.MeshLambertMaterial({color: 0xffffff}),   // tinted per instance
    chute:  new THREE.MeshLambertMaterial({color: 0xc9cdd1}),
    kiosk:  new THREE.MeshLambertMaterial({color: 0xcfc3a8}),
    roof:   new THREE.MeshLambertMaterial({color: 0x4a3b32}),
    canopy: new THREE.MeshLambertMaterial({color: 0xffffff}),
    wood:   new THREE.MeshLambertMaterial({color: 0x7a5230}),
  };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3();
  const e3 = new THREE.Euler(), col = new THREE.Color(), pv = new THREE.Vector3();
  // One instanced mesh from a bucket. place(item, i) fills the matrix; tint is optional.
  const inst = (geom, mat, list, place, shadow = true) => {
    if (!list.length) return null;
    const mesh = new THREE.InstancedMesh(geom, mat, list.length);
    list.forEach((it, i) => {
      place(it, i);
      m4.compose(pv, q, sv);
      mesh.setMatrixAt(i, m4);
      if (it.tint !== undefined) mesh.setColorAt(i, col.set(it.tint));
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = shadow;
    group.add(mesh);
    return mesh;
  };
  const basic = (it, rot = 0, s = 1) => { pv.set(it.x, gyP(it.x, it.y), -it.y); e3.set(0, rot, 0); q.setFromEuler(e3); sv.setScalar(s); };

  // --- horticulture ---------------------------------------------------------------------------
  const flowerG = new THREE.BoxGeometry(0.5, 0.28, 0.5); flowerG.translate(0, 0.14, 0);
  inst(flowerG, MATS.flower, A.flowers, (f) => { pv.set(f.x, gyP(f.x, f.y), -f.y); q.identity(); sv.set(1, f.h, 1); }, false);
  const soilG = new THREE.BoxGeometry(1, 0.12, 1); soilG.translate(0, 0.06, 0);
  const collarG = new THREE.CylinderGeometry(1, 1, 0.44, 14, 1, true); collarG.translate(0, 0.22, 0);
  inst(soilG, MATS.soil, A.soils, (so) => { pv.set(so.x, gyP(so.x, so.y), -so.y); q.identity(); sv.set(so.s, 1, so.s); }, false);
  inst(collarG, MATS.foliage, A.soils.map(s => ({...s, tint: 0x3f6b39})),
       (so) => { pv.set(so.x, gyP(so.x, so.y), -so.y); q.identity(); sv.set(so.r, 1, so.r); });

  const tubG = new THREE.CylinderGeometry(0.42, 0.34, 0.7, 8); tubG.translate(0, 0.35, 0);
  const tubMoundG = squash(new THREE.IcosahedronGeometry(0.4, 0), 0.55); tubMoundG.translate(0, 0.82, 0);
  inst(tubG, MATS.tub, A.planters, (p) => basic(p));
  inst(tubMoundG, MATS.foliage, A.planters.map((p, i) => ({...p, tint: [0x3a6b39, 0x467a41, 0x2f5f37][i % 3]})), (p) => basic(p));

  const shrubDomeG = squash(new THREE.IcosahedronGeometry(0.7, 0), 0.85); shrubDomeG.translate(0, 0.6, 0);
  inst(shrubDomeG, MATS.foliage, A.shrubDomes, (s) => basic(s, s.x * 0.7, s.s));
  const shrubConeG = new THREE.ConeGeometry(0.55, 1.6, 7); shrubConeG.translate(0, 0.8, 0);
  inst(shrubConeG, MATS.foliage, A.shrubCones, (s) => basic(s, 0, s.s));

  const ornTrunkG = new THREE.CylinderGeometry(0.09, 0.14, 1.7, 5); ornTrunkG.translate(0, 0.85, 0);
  const ornCrownG = jitterBall(new THREE.IcosahedronGeometry(1.15, 1)); ornCrownG.translate(0, 2.3, 0);
  inst(ornTrunkG, MATS.trunk, A.ornTrees.map(t => ({...t, tint: undefined})), (t) => basic(t, t.rot, t.s));
  inst(ornCrownG, MATS.crown, A.ornTrees, (t) => basic(t, t.rot, t.s));

  inst(makeBenchGeometry(), MATS.bench, A.benches, (b) => basic(b, b.rot));

  // --- fencing: one panel instanced along each enclosure ----------------------------------------
  inst(fencePanel(0.95, 2), MATS.iron, A.fenceLow,
       (f) => { pv.set(f.x, gyP(f.x, f.y), -f.y); e3.set(0, f.rot, 0); q.setFromEuler(e3); sv.set(f.s || 1, 1, 1); });
  inst(fencePanel(1.55, 4), MATS.iron, A.fenceTall,
       (f) => { pv.set(f.x, gyP(f.x, f.y), -f.y); e3.set(0, f.rot, 0); q.setFromEuler(e3); sv.set(f.s || 1, 1, 1); });

  // --- playground -------------------------------------------------------------------------------
  inst(swingGeom(), MATS.play, A.swings, (s) => basic(s, s.rot));
  inst(slideStruct(), MATS.play, A.slides, (s) => basic(s, s.rot));
  inst(slideChute(), MATS.chute, A.slides.map(s => ({...s, tint: undefined})), (s) => basic(s, s.rot));
  inst(climberGeom(), MATS.play, A.climbers, (c) => basic(c, c.rot));

  // --- dog run agility ---------------------------------------------------------------------------
  inst(hoopGeom(), MATS.play, A.hoops.map(h => ({...h, tint: 0xd94f3d})), (h) => basic(h, h.rot));
  inst(rampGeom(), MATS.wood, A.ramps, (r) => basic(r, r.rot));

  // --- cafe ---------------------------------------------------------------------------------------
  inst(kioskBody(), MATS.kiosk, A.kiosks, (k) => basic(k, k.rot));
  inst(kioskRoof(), MATS.roof, A.kiosks, (k) => basic(k, k.rot));
  const parasolPoleG = new THREE.CylinderGeometry(0.045, 0.045, 2.35, 6); parasolPoleG.translate(0, 1.17, 0);
  const parasolCanopyG = new THREE.ConeGeometry(1.45, 0.5, 8); parasolCanopyG.translate(0, 2.32, 0);
  inst(parasolPoleG, MATS.trunk, A.parasols.map(p => ({...p, tint: undefined})), (p) => basic(p));
  inst(parasolCanopyG, MATS.canopy, A.parasols, (p) => basic(p, p.x * 0.3));
  inst(tableGeom(), MATS.tub, A.tables, (t) => basic(t, t.x * 0.4));
  inst(chairGeom(), MATS.wood, A.chairs, (c) => basic(c, c.rot));

  // --- reused street furniture (shared factories, so no new materials) ----------------------------
  const fromProps = (factory, list) => {
    if (!list.length) return;
    const p = factory(list.length);
    list.forEach((it, i) => p.setAt(i, it.x, -it.y, it.rot || 0, gyP(it.x, it.y)));
    group.add(p.mesh);
  };
  fromProps(makeBins, A.bins);
  fromProps(makeBikeRacks, A.racks);
  fromProps(makeSignPosts, A.signs);
  fromProps(makeBollards, A.bollards);
  fromProps(makeFountains, A.fountains);

  // --- the one merged ground mesh: walks, junction discs, pads, decks, pond ------------------------
  const ground = buildGroundLayer(A.quads, A.discs, A.rects, A.polys);
  if (ground) group.add(ground);
}

// --- small geometry helpers ------------------------------------------------------------------
function squash(g, k) { const p = g.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * k); g.computeVertexNormals(); return g; }
function jitterBall(g) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const j = 0.85 + 0.3 * (Math.sin(x * 5.1 + y * 3.7 + z * 2.3) * 0.5 + 0.5);
    p.setXYZ(i, x * j, y * 0.92 * j, z * j);
  }
  g.computeVertexNormals(); return g;
}
const boxG = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g; };

// A 2m fence panel: two posts and horizontal rails. Instanced along an enclosure perimeter, so a
// whole fenced playground or dog run costs one instance per 2 metres and one draw call city-wide.
function fencePanel(h, rails) {
  const parts = [boxG(0.07, h, 0.07, -0.95, h / 2, 0), boxG(0.07, h, 0.07, 0.95, h / 2, 0)];
  for (let r = 0; r < rails; r++) parts.push(boxG(2.0, 0.05, 0.04, 0, h * (0.28 + 0.68 * r / Math.max(1, rails - 1)), 0));
  return mergeGeoms(parts);
}
// Swing: two A-frames, a top beam, two seats on hangers. Faces along X.
function swingGeom() {
  const parts = [];
  for (const sx of [-1.5, 1.5]) for (const sz of [-0.85, 0.85]) parts.push(tilted(0.09, 2.3, sx, sz));
  parts.push(boxG(3.3, 0.1, 0.1, 0, 2.25, 0));
  for (const sx of [-0.75, 0.75]) {
    parts.push(boxG(0.04, 1.55, 0.04, sx - 0.2, 1.47, 0), boxG(0.04, 1.55, 0.04, sx + 0.2, 1.47, 0));
    parts.push(boxG(0.55, 0.06, 0.2, sx, 0.68, 0));
  }
  return mergeGeoms(parts);
}
function tilted(t, h, x, z) { const g = new THREE.BoxGeometry(t, h, t); g.translate(0, h / 2, 0); g.rotateX(Math.atan2(-z, h) * 0.9); g.translate(x, 0, z); return g; }
// Slide: a small tower with a roof and a ladder. The chute is a separate mesh so it reads bright.
function slideStruct() {
  const parts = [];
  for (const sx of [-0.55, 0.55]) for (const sz of [-0.55, 0.55]) parts.push(boxG(0.1, 1.7, 0.1, sx, 0.85, sz));
  parts.push(boxG(1.3, 0.1, 1.3, 0, 1.6, 0));
  parts.push(boxG(1.5, 0.12, 1.5, 0, 2.5, 0));
  for (const sx of [-0.55, 0.55]) parts.push(boxG(0.08, 0.95, 0.08, sx, 2.05, -0.55));
  for (let r = 0; r < 4; r++) parts.push(boxG(0.9, 0.06, 0.06, 0, 0.35 + r * 0.38, -0.95));
  for (const sx of [-0.45, 0.45]) parts.push(boxG(0.06, 1.5, 0.06, sx, 0.75, -0.95));
  return mergeGeoms(parts);
}
function slideChute() {
  const g = new THREE.BoxGeometry(0.72, 0.08, 2.7);
  g.rotateX(-0.52); g.translate(0, 1.0, 1.35);
  const rail = (sx) => { const r = new THREE.BoxGeometry(0.07, 0.26, 2.7); r.rotateX(-0.52); r.translate(sx, 1.13, 1.35); return r; };
  return mergeGeoms([g, rail(-0.39), rail(0.39)]);
}
// Climbing cube: the twelve edges of a 2m frame.
function climberGeom() {
  const parts = [], s = 1.0;
  for (const x of [-s, s]) for (const z of [-s, s]) parts.push(boxG(0.09, 2 * s, 0.09, x, s, z));
  for (const y of [0.05, s, 2 * s]) for (const z of [-s, s]) parts.push(boxG(2 * s, 0.07, 0.07, 0, y, z));
  for (const y of [0.05, s, 2 * s]) for (const x of [-s, s]) parts.push(boxG(0.07, 0.07, 2 * s, x, y, 0));
  return mergeGeoms(parts);
}
function hoopGeom() {
  const t = new THREE.TorusGeometry(0.62, 0.07, 5, 12); t.translate(0, 0.95, 0);
  return mergeGeoms([t, boxG(0.09, 0.4, 0.09, -0.62, 0.2, 0), boxG(0.09, 0.4, 0.09, 0.62, 0.2, 0)]);
}
function rampGeom() {
  const a = new THREE.BoxGeometry(1.1, 0.07, 1.7); a.rotateX(0.62); a.translate(0, 0.42, -0.72);
  const b = new THREE.BoxGeometry(1.1, 0.07, 1.7); b.rotateX(-0.62); b.translate(0, 0.42, 0.72);
  return mergeGeoms([a, b]);
}
// Park kiosk: a small pavilion with a serving counter under a wide hipped roof.
function kioskBody() {
  const parts = [boxG(3.6, 2.3, 2.4, 0, 1.15, -0.2), boxG(3.9, 0.12, 0.5, 0, 1.12, 1.05)];
  for (const sx of [-1.85, 1.85]) parts.push(boxG(0.12, 2.3, 0.12, sx, 1.15, 1.05));
  return mergeGeoms(parts);
}
function kioskRoof() {
  const r = new THREE.CylinderGeometry(0.1, 3.3, 0.75, 4); r.rotateY(Math.PI / 4); r.translate(0, 2.7, 0.1);
  return mergeGeoms([r, boxG(4.4, 0.1, 3.9, 0, 2.34, 0.1)]);
}
function tableGeom() {
  const top = new THREE.CylinderGeometry(0.46, 0.46, 0.05, 10); top.translate(0, 0.72, 0);
  const col = new THREE.CylinderGeometry(0.06, 0.06, 0.72, 6); col.translate(0, 0.36, 0);
  const foot = new THREE.CylinderGeometry(0.3, 0.33, 0.04, 8); foot.translate(0, 0.02, 0);
  return mergeGeoms([top, col, foot]);
}
function chairGeom() {
  const parts = [boxG(0.42, 0.05, 0.42, 0, 0.44, 0), boxG(0.42, 0.42, 0.05, 0, 0.66, -0.19)];
  for (const x of [-0.17, 0.17]) for (const z of [-0.17, 0.17]) parts.push(boxG(0.04, 0.44, 0.04, x, 0.22, z));
  return mergeGeoms(parts);
}
// The park bench: a seat slab, a reclined back, two end frames. Faces +Z.
function makeBenchGeometry() {
  return mergeGeoms([
    boxG(1.6, 0.08, 0.5, 0, 0.46, 0),
    boxG(1.6, 0.5, 0.08, 0, 0.75, -0.24),
    boxG(0.1, 0.9, 0.5, -0.72, 0.45, 0),
    boxG(0.1, 0.9, 0.5, 0.72, 0.45, 0),
  ]);
}

// ==============================================================================================
// THE GROUND LAYER — every flat surface in every park, in ONE merged vertex-coloured mesh
// ==============================================================================================
function buildGroundLayer(quads, discs, rects, polys = []) {
  if (!quads.length && !discs.length && !rects.length && !polys.length) return null;
  const pos = [], idx = [], col = [], nrm = [];
  let v = 0;
  const strip = (ax, ay, bx, by, halfW, y, rgb) => {
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * halfW, ny = dx / len * halfW;
    pos.push(ax + nx, gyP(ax + nx, ay + ny) + y, -(ay + ny), ax - nx, gyP(ax - nx, ay - ny) + y, -(ay - ny),
             bx + nx, gyP(bx + nx, by + ny) + y, -(by + ny), bx - nx, gyP(bx - nx, by - ny) + y, -(by - ny));
    for (let k = 0; k < 4; k++) { col.push(rgb[0], rgb[1], rgb[2]); nrm.push(0, 1, 0); }
    idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    v += 4;
  };
  const fan = (pts, y, rgb) => {
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;
    const c0 = v;
    pos.push(cx, gyP(cx, cy) + y, -cy); col.push(rgb[0], rgb[1], rgb[2]); nrm.push(0, 1, 0); v++;
    for (const p of pts) { pos.push(p[0], gyP(p[0], p[1]) + y, -p[1]); col.push(rgb[0], rgb[1], rgb[2]); nrm.push(0, 1, 0); v++; }
    for (let i = 0; i < pts.length; i++) idx.push(c0, c0 + 1 + i, c0 + 1 + ((i + 1) % pts.length));
  };
  for (const {ax, ay, bx, by, w, kind} of quads) {
    strip(ax, ay, bx, by, w / 2 + 0.4, 0.062, EDGE);                       // soil edging, just outside
    strip(ax, ay, bx, by, w / 2, 0.085, kind === 1 ? PAVED : GRAVEL);      // the walking surface
  }
  for (const d of discs) {
    const n = d.seg || 12, pts = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push([d.x + Math.cos(a) * d.r, d.y + Math.sin(a) * d.r]); }
    fan(pts, d.y0, d.rgb);
  }
  for (const r of rects) {
    const ux = Math.cos(r.ang), uy = Math.sin(r.ang), vx = -uy, vy = ux;
    const c = (a, b) => [r.x + ux * r.hh * a + vx * r.hw * b, r.y + uy * r.hh * a + vy * r.hw * b];
    fan([c(1, 1), c(1, -1), c(-1, -1), c(-1, 1)], r.y0, r.rgb);
  }
  // Traced outlines. The fan is centroid-based, which is exact for a convex ring and close enough
  // for the gently concave pond — its waist never reaches the centroid.
  for (const p of polys) fan(p.pts, p.y0, p.rgb);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({vertexColors: true, side: THREE.DoubleSide}));
  mesh.receiveShadow = true;
  return mesh;
}

// Minimal non-indexed merge (three's example module is deliberately not a dependency here,
// matching scene.js's own mergeGeoms).
function mergeGeoms(geoms) {
  const nonIndexed = geoms.map(g => (g.index ? g.toNonIndexed() : g));
  const total = nonIndexed.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), norm = new Float32Array(total * 3);
  let o = 0;
  for (const g of nonIndexed) {
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) norm.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  return out;
}
