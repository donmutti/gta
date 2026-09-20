#!/usr/bin/env node
// Cut the city into parcels, cadastre-style, and bake them into public/data/city.json.
//
// The roads are the spine. Every closed region the street network encloses is a parcel; together
// they tile the map with no gaps and no overlaps, because they are cut by the road CENTRELINES —
// hair-thin, zero width. A parcel therefore runs to the middle of the street that bounds it, exactly
// as a real cadastre does. Anything that wants to paint inside one (grass, concrete) applies its own
// inset at paint time; the parcel itself never knows how wide the road is.
//
// Run AFTER unblock-roads.mjs, which is the last thing that moves geometry:
//   node tools/fetch-city.mjs && node tools/unblock-roads.mjs && node tools/parcels.mjs
//
// The seven steps, in order, each of which exists because of a specific failure:
//   1. polylines -> sections
//   2. split every section where it CROSSES another with no junction recorded. In a flat world with
//      no bridges or tunnels a crossing is an intersection, and without this the two faces either
//      side of the crossing merge into one.
//   3. weld endpoints that land within TOL of each other.
//   4. pull an endpoint that stops just short of another section's INTERIOR onto it, and split that
//      section there — the T-junction that misses. ONE batched pass: done iteratively it never
//      terminates, because every split makes a fresh endpoint that lands near a third section.
//   5. prune dangling chains — a street that ends in nothing divides nothing.
//   6. walk the faces of the planar graph.
//   7. drop the single unbounded face; everything else is land.
//
// Nothing is merged. Merging two faces means deleting the edges they share, and here every edge is a
// street, so a merged parcel straddles a carriageway and whatever is painted on it runs across the
// road. Instead each parcel carries `thin`, set from the largest circle that fits inside it — which
// separates a traffic island (small but compact) from a snapping artefact (small and sliver-shaped)
// where area cannot. What to do about a thin parcel is the paint step's business, not this one's.
import {readFileSync, writeFileSync} from 'node:fs';

const FILE = 'public/data/city.json';
const TOL = 1.0;        // metres; within this, two sections touch
const THIN_R = 1.5;     // metres; a parcel whose biggest inscribed circle is smaller is `thin`
const GRID = 40;        // metres; spatial index cell

const city = JSON.parse(readFileSync(FILE, 'utf8'));

// --- 1. polylines -> sections -----------------------------------------------------------------
let segs = [];
for (const r of city.roads) {
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    segs.push({a: [a[0], a[1]], b: [b[0], b[1]]});
  }
}
const rawSegs = segs.length;

/** Uniform grid over segments, so nothing is ever compared against the whole city. */
function index(list) {
  const cells = new Map();
  list.forEach((s, i) => {
    const x0 = Math.min(s.a[0], s.b[0]), x1 = Math.max(s.a[0], s.b[0]);
    const y0 = Math.min(s.a[1], s.b[1]), y1 = Math.max(s.a[1], s.b[1]);
    for (let cx = Math.floor((x0 - TOL) / GRID); cx <= Math.floor((x1 + TOL) / GRID); cx++) {
      for (let cy = Math.floor((y0 - TOL) / GRID); cy <= Math.floor((y1 + TOL) / GRID); cy++) {
        const k = `${cx}:${cy}`;
        const bucket = cells.get(k);
        if (bucket) bucket.push(i); else cells.set(k, [i]);
      }
    }
  });
  return cells;
}
function near(cells, x, y, pad = 0) {
  const out = new Set();
  for (let cx = Math.floor((x - pad) / GRID); cx <= Math.floor((x + pad) / GRID); cx++) {
    for (let cy = Math.floor((y - pad) / GRID); cy <= Math.floor((y + pad) / GRID); cy++) {
      for (const i of (cells.get(`${cx}:${cy}`) ?? [])) out.add(i);
    }
  }
  return out;
}

// --- 2. split at crossings ----------------------------------------------------------------------
// Computed against the ORIGINAL segments and applied in one pass. The crossing points do not move
// when a segment is split, so a single pass is exact — and it cannot cascade.
{
  const cells = index(segs);
  const cuts = segs.map(() => []);
  let crossings = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const cand = near(cells, (s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2,
                      Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) / 2 + GRID);
    for (const j of cand) {
      if (j <= i) continue;
      const t = segs[j];
      const rx = s.b[0] - s.a[0], ry = s.b[1] - s.a[1];
      const sx = t.b[0] - t.a[0], sy = t.b[1] - t.a[1];
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) continue;
      const u = ((t.a[0] - s.a[0]) * sy - (t.a[1] - s.a[1]) * sx) / den;
      const v = ((t.a[0] - s.a[0]) * ry - (t.a[1] - s.a[1]) * rx) / den;
      const E = 1e-9;
      if (u <= E || u >= 1 - E || v <= E || v >= 1 - E) continue;   // endpoints are step 3's job
      cuts[i].push(u); cuts[j].push(v);
      crossings++;
    }
  }
  const out = [];
  segs.forEach((s, i) => {
    const at = [...new Set(cuts[i].map(u => +u.toFixed(9)))].sort((p, q) => p - q);
    let prev = s.a;
    for (const u of at) {
      const p = [s.a[0] + u * (s.b[0] - s.a[0]), s.a[1] + u * (s.b[1] - s.a[1])];
      out.push({a: prev, b: p});
      prev = [p[0], p[1]];
    }
    out.push({a: prev, b: s.b});
  });
  segs = out;
  console.log(`crossings cut: ${crossings}`);
}

// --- 3. weld endpoints within TOL ---------------------------------------------------------------
{
  const cellOf = new Map();
  const key = (x, y) => `${Math.floor(x / TOL)}:${Math.floor(y / TOL)}`;
  const clusters = [];
  let welded = 0;
  const place = (p) => {
    const cx = Math.floor(p[0] / TOL), cy = Math.floor(p[1] / TOL);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (const ci of (cellOf.get(`${i}:${j}`) ?? [])) {
          const c = clusters[ci];
          if ((c.x - p[0]) ** 2 + (c.y - p[1]) ** 2 < TOL * TOL) { c.members.push(p); welded++; return; }
        }
      }
    }
    const c = {x: p[0], y: p[1], members: [p]};
    clusters.push(c);
    const k = key(p[0], p[1]);
    const bucket = cellOf.get(k);
    if (bucket) bucket.push(clusters.length - 1); else cellOf.set(k, [clusters.length - 1]);
  };
  for (const s of segs) { place(s.a); place(s.b); }
  for (const c of clusters) for (const m of c.members) { m[0] = c.x; m[1] = c.y; }
  console.log(`endpoints welded: ${welded} into ${clusters.length} nodes`);
}

// --- 4. the T-junction that misses --------------------------------------------------------------
{
  const cells = index(segs);
  const snapshot = segs.slice();
  const cuts = new Map();
  let tJoins = 0;
  for (const s of snapshot) {
    for (const end of [s.a, s.b]) {
      let best = null;
      for (const k of near(cells, end[0], end[1], TOL)) {
        const t = snapshot[k];
        if (t === s) continue;
        const dx = t.b[0] - t.a[0], dy = t.b[1] - t.a[1], l2 = dx * dx + dy * dy || 1;
        const u = ((end[0] - t.a[0]) * dx + (end[1] - t.a[1]) * dy) / l2;
        if (u <= 0.001 || u >= 0.999) continue;          // that is an endpoint, not an interior
        const px = t.a[0] + u * dx, py = t.a[1] + u * dy;
        const d2 = (end[0] - px) ** 2 + (end[1] - py) ** 2;
        if (d2 >= TOL * TOL || d2 < 1e-12) continue;
        if (!best || d2 < best.d2) best = {t, u, px, py, d2};
      }
      if (!best) continue;
      end[0] = best.px; end[1] = best.py;
      const list = cuts.get(best.t);
      if (list) list.push(best.u); else cuts.set(best.t, [best.u]);
      tJoins++;
    }
  }
  const out = [];
  for (const s of segs) {
    const at = cuts.has(s) ? [...new Set(cuts.get(s).map(u => +u.toFixed(9)))].sort((p, q) => p - q) : [];
    let prev = s.a;
    for (const u of at) {
      const p = [s.a[0] + u * (s.b[0] - s.a[0]), s.a[1] + u * (s.b[1] - s.a[1])];
      out.push({a: prev, b: p});
      prev = [p[0], p[1]];
    }
    out.push({a: prev, b: s.b});
  }
  segs = out;
  console.log(`T-junctions pulled in: ${tJoins}`);
}

// --- 5. graph ------------------------------------------------------------------------------------
const nodeIx = new Map(); const nodes = [];
const nodeOf = (p) => {
  const k = `${p[0].toFixed(3)}:${p[1].toFixed(3)}`;
  if (nodeIx.has(k)) return nodeIx.get(k);
  nodeIx.set(k, nodes.length); nodes.push([p[0], p[1]]);
  return nodes.length - 1;
};
const edgeSet = new Set(); const edges = [];
for (const s of segs) {
  const u = nodeOf(s.a), v = nodeOf(s.b);
  if (u === v) continue;
  const k = u < v ? `${u}-${v}` : `${v}-${u}`;
  if (edgeSet.has(k)) continue;
  edgeSet.add(k); edges.push([u, v]);
}

const alive = edges.map(() => true);
let pruned = 0;
for (let pass = 0; pass < 2000; pass++) {
  const deg = new Int32Array(nodes.length);
  edges.forEach(([u, v], i) => { if (alive[i]) { deg[u]++; deg[v]++; } });
  let cut = false;
  edges.forEach(([u, v], i) => { if (alive[i] && (deg[u] === 1 || deg[v] === 1)) { alive[i] = false; pruned++; cut = true; } });
  if (!cut) break;
}
console.log(`graph: ${nodes.length} nodes, ${edges.length} edges, ${pruned} pruned as dangling`);

// --- 6. walk the faces ---------------------------------------------------------------------------
// Every edge gives two darts. At the far node, take the neighbour one step CLOCKWISE from where you
// came in, and keep going; each cycle you close is a face.
const live = edges.filter((_, i) => alive[i]);
const adj = nodes.map(() => []);
for (const [u, v] of live) { adj[u].push(v); adj[v].push(u); }
const ang = (f, t) => Math.atan2(nodes[t][1] - nodes[f][1], nodes[t][0] - nodes[f][0]);
for (let n = 0; n < nodes.length; n++) adj[n].sort((p, q) => ang(n, p) - ang(n, q));
const posIn = nodes.map((_, n) => { const m = new Map(); adj[n].forEach((w, i) => m.set(w, i)); return m; });

const seen = new Set(); const all = [];
for (const [a, b] of live) {
  for (const [s0, s1] of [[a, b], [b, a]]) {
    if (seen.has(`${s0}>${s1}`)) continue;
    const cyc = [];
    let u = s0, v = s1;
    for (let step = 0; step < 1e6; step++) {
      seen.add(`${u}>${v}`); cyc.push(u);
      const ring = adj[v], i = posIn[v].get(u);
      const w = ring[(i - 1 + ring.length) % ring.length];
      u = v; v = w;
      if (u === s0 && v === s1) break;
    }
    all.push(cyc);
  }
}
const signedArea = (cyc) => {
  let s = 0;
  for (let i = 0; i < cyc.length; i++) {
    const a = nodes[cyc[i]], b = nodes[cyc[(i + 1) % cyc.length]];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
};

// --- 7. drop the outside world; measure what is left ---------------------------------------------
const faces = all.map(cyc => ({cyc, area: signedArea(cyc)})).filter(f => f.area > 0.25);
console.log(`faces walked: ${all.length} | parcels: ${faces.length} | outside: ${all.length - faces.length}`);

function pointIn(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToEdge(x, y, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    let t = ((x - a[0]) * dx + (y - a[1]) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
    if (d < best) best = d;
  }
  return best;
}
/** Radius of the largest circle that fits inside — a coarse probe, refined around the winner. */
function inradius(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  let best = 0, bx = (minX + maxX) / 2, by = (minY + maxY) / 2;
  let step = Math.max(maxX - minX, maxY - minY) / 16 || 1;
  for (let pass = 0; pass < 4; pass++) {
    for (let x = bx - step * 8; x <= bx + step * 8; x += step) {
      for (let y = by - step * 8; y <= by + step * 8; y += step) {
        if (!pointIn(x, y, pts)) continue;
        const d = distToEdge(x, y, pts);
        if (d > best) { best = d; bx = x; by = y; }
      }
    }
    step /= 4;
  }
  return best;
}

const parcels = faces.map(f => {
  const pts = f.cyc.map(n => [+nodes[n][0].toFixed(2), +nodes[n][1].toFixed(2)]);
  // centroid of the polygon, which is where a label goes and how the id is ordered
  let cx = 0, cy = 0, a2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const cr = p[0] * q[1] - q[0] * p[1];
    a2 += cr; cx += (p[0] + q[0]) * cr; cy += (p[1] + q[1]) * cr;
  }
  a2 *= 0.5;
  const c = Math.abs(a2) < 1e-9 ? pts[0] : [cx / (6 * a2), cy / (6 * a2)];
  const r = inradius(pts);
  return {pts, c: [+c[0].toFixed(2), +c[1].toFixed(2)], area: +f.area.toFixed(1), r: +r.toFixed(2), thin: r < THIN_R};
});

// Ids are fixed by centroid, north-to-south then west-to-east, and NOT by extraction order — a
// number you quote today has to mean the same parcel after the next re-run.
parcels.sort((p, q) => (q.c[1] - p.c[1]) || (p.c[0] - q.c[0]));
parcels.forEach((p, i) => { p.id = i + 1; });

city.parcels = parcels;
writeFileSync(FILE, JSON.stringify(city));

const areas = parcels.map(p => p.area).sort((a, b) => a - b);
const pct = (q) => areas[Math.min(areas.length - 1, Math.floor(areas.length * q))];
console.log(`sections: ${rawSegs} raw -> ${segs.length} after cutting`);
console.log(`parcels written: ${parcels.length} | thin (r < ${THIN_R}m): ${parcels.filter(p => p.thin).length}`);
console.log(`area m2: min ${areas[0] | 0}, p25 ${pct(0.25) | 0}, median ${pct(0.5) | 0}, p75 ${pct(0.75) | 0}, max ${areas[areas.length - 1] | 0}`);
console.log(`total parcel area: ${(areas.reduce((s, x) => s + x, 0) / 1e6).toFixed(2)} km2`);
