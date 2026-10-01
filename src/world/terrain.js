// The terrain height field — the ONE source of ground elevation, shared by the renderer (which
// lifts the ground, roads, sidewalks, buildings, props onto it) and the physics (which will read
// the car's ground height, camera pitch, and placement from it). Pure data + math: no THREE, no
// DOM, so both halves import it freely. See the telegraph — groundHeight(x, z) is the seam.
//
// Coordinate law (same as everywhere): world x = map x (east+), world z = -map y (so north is -z).
// The baked grid is row-major in MAP coords: row 0 = south (minY), column 0 = west (minX). Heights
// are metres relative to the slice centre (which is y=0), so the origin sits at ground level and the
// city rises toward the plateau and drops into the Pfaffenthal gorge exactly as the real land does.

let FIELD = null;   // {nx, ny, minX, maxX, minY, maxY, heights[]}

/** Install the baked heightfield (from public/data/heightfield.json). Validated by the baking pipeline. */
export function setHeightfield(hf) {
  if (!hf) { FIELD = null; return; }
  if (hf.nx < 2 || hf.ny < 2 || hf.heights.length !== hf.nx * hf.ny ||
      !hf.heights.every(Number.isFinite) || hf.maxX <= hf.minX || hf.maxY <= hf.minY) throw new Error('Invalid terrain grid');
  FIELD = {...hf, heights: [...hf.heights]};
}

/** True once a real field is loaded — callers can cheaply skip terrain math before then. */
export function hasTerrain() { return FIELD !== null; }

/**
 * Ground elevation (world Y) at world (x, z). Piecewise planar over the rendered grid triangles; clamps at the edges so
 * points just outside the slice ride the boundary height rather than snapping to zero. Returns 0
 * when no field is loaded, so every caller is safe to use it before the fetch resolves.
 */
export function groundHeight(x, z) {
  const f = FIELD;
  if (!f) return 0;
  const mapY = -z;                                  // world z -> map y
  // grid fractional coordinates
  let gx = ((x - f.minX) / (f.maxX - f.minX)) * (f.nx - 1);
  let gy = ((mapY - f.minY) / (f.maxY - f.minY)) * (f.ny - 1);
  gx = Math.max(0, Math.min(f.nx - 1, gx));
  gy = Math.max(0, Math.min(f.ny - 1, gy));
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const ix2 = Math.min(f.nx - 1, ix + 1), iy2 = Math.min(f.ny - 1, iy + 1);
  const fx = gx - ix, fy = gy - iy;
  const h = f.heights;
  const h00 = h[iy * f.nx + ix], h10 = h[iy * f.nx + ix2];
  const h01 = h[iy2 * f.nx + ix], h11 = h[iy2 * f.nx + ix2];
  return fx >= fy
    ? h00 + (h10 - h00) * fx + (h11 - h10) * fy
    : h00 + (h11 - h01) * fx + (h01 - h00) * fy;
}

/**
 * The terrain's up-normal at world (x, z), for TILTING things that sit on a slope — a car should
 * pitch on a grade and roll on a camber to match the ground. Central finite differences over a small
 * step; returns a normalized {x, y, z} (world). On flat ground / no terrain it is {0,1,0}. Cheap
 * enough to call per frame for the one hero car.
 */
export function groundNormal(x, z, step = 1.5) {
  if (!FIELD) return {x: 0, y: 1, z: 0};
  const hL = groundHeight(x - step, z), hR = groundHeight(x + step, z);
  const hD = groundHeight(x, z - step), hU = groundHeight(x, z + step);
  // slope vectors: d/dx = (2*step, hR-hL, 0), d/dz = (0, hU-hD, 2*step); normal = dz x dx
  const nx = -(hR - hL) * (2 * step);
  const nz = -(hU - hD) * (2 * step);
  const ny = (2 * step) * (2 * step);
  const len = Math.hypot(nx, ny, nz) || 1;
  return {x: nx / len, y: ny / len, z: nz / len};
}

/**
 * The lowest ground height under a footprint's vertices, for SEATING a building: a building spans
 * varying terrain, so if it sat at its centre height the downhill corners would float. Sit it at the
 * minimum corner height (minus a bury margin, applied by the caller) so no bottom corner sticks out
 * and every wall meets the ground. pts are [x, mapY] (as stored in city.json).
 */
export function minGroundUnder(pts) {
  let lo = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      lo = Math.min(lo, groundHeight(a[0] + (b[0] - a[0]) * t, -a[1] - (b[1] - a[1]) * t));
    }
  }
  return lo === Infinity ? 0 : lo;
}

/**
 * The height to SEAT a building floor at. Uses the footprint CENTROID's ground — which is where the
 * building meets the street the player drives on — rather than the lowest corner. Seating at the min
 * corner sank the street-facing storefront below the road on any sloped footprint (the downhill
 * corner dragged the whole building down); the centroid keeps the visible face at street level. On a
 * slope the far downhill corner may lift a touch off the ground, which is invisible; a sunken shopfront
 * is not. Caller applies a small bury on top.
 */
export function seatGroundUnder(pts) {
  let sx = 0, sy = 0;
  for (const [px, py] of pts) { sx += px; sy += py; }
  const n = pts.length || 1;
  return groundHeight(sx / n, -(sy / n));
}

/** Grid metadata used to build the exact same surface as the sampler. */
export function terrainField() { return FIELD; }

const spans = [];
/** Named bridge spans use their bank elevations, not the valley floor below them. */
export function configureTerrain(world) {
  spans.length = 0;
  if (!FIELD) return;
  const airport = world.findel;
  if (airport?.core) {
    const {x0, x1, y0, y1} = airport.core;
    const h = groundHeight(airport.anchor[0], -airport.anchor[1]);
    for (let j = 0; j < FIELD.ny; j++) for (let i = 0; i < FIELD.nx; i++) {
      const x = FIELD.minX + i * (FIELD.maxX - FIELD.minX) / (FIELD.nx - 1);
      const y = FIELD.minY + j * (FIELD.maxY - FIELD.minY) / (FIELD.ny - 1);
      const distance = Math.max(x0 - x, x - x1, y0 - y, y - y1, 0);
      const t = Math.max(0, 1 - distance / 80);
      const smooth = t * t * (3 - 2 * t);
      const k = j * FIELD.nx + i;
      FIELD.heights[k] += (h - FIELD.heights[k]) * smooth;
    }
  }
  const groups = new Map();
  for (const edge of world.edges) {
    edge.bridge = /^Pont /i.test(edge.name ?? '');
    if (!edge.bridge) continue;
    if (!groups.has(edge.name)) groups.set(edge.name, []);
    groups.get(edge.name).push(edge);
  }
  for (const edges of groups.values()) {
    const points = edges.flatMap(e => e.pts);
    let a = points[0], b = points[1], longest = 0;
    for (const p of points) for (const q of points) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      if (d > longest) { longest = d; a = p; b = q; }
    }
    const ha = groundHeight(a[0], -a[1]), hb = groundHeight(b[0], -b[1]);
    const height = p => {
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / longest));
      return ha + (hb - ha) * t;
    };
    for (const edge of edges) {
      edge.deckHeights = edge.pts.map(height);
      for (let i = 1; i < edge.pts.length; i++) {
        spans.push({a: edge.pts[i - 1], b: edge.pts[i], ha: edge.deckHeights[i - 1], hb: edge.deckHeights[i], half: edge.width / 2 + 2.4});
      }
    }
  }
}

/** Closest vertical surface preserves an actor's level beneath an overpass. */
export function surfaceHeight(x, z, reference, ceiling = Infinity) {
  const ground = groundHeight(x, z);
  let selected = ground;
  for (const s of spans) {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    const t = ((x - s.a[0]) * dx + (-z - s.a[1]) * dy) / (dx * dx + dy * dy);
    if (t < -0.002 || t > 1.002) continue;
    if (Math.hypot(x - s.a[0] - t * dx, -z - s.a[1] - t * dy) > s.half) continue;
    const h = s.ha + (s.hb - s.ha) * Math.max(0, Math.min(1, t));
    if (h < ground - 0.5 || h > ceiling) continue;
    if (reference === undefined ? h > selected : Math.abs(h - reference) < Math.abs(selected - reference)) selected = h;
  }
  return selected;
}

export function surfaceNormal(x, z, reference, step = 1.5) {
  const selected = surfaceHeight(x, z, reference);
  for (const s of spans) {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], length2 = dx * dx + dy * dy;
    const t = ((x - s.a[0]) * dx + (-z - s.a[1]) * dy) / length2;
    if (t < 0 || t > 1 || Math.hypot(x - s.a[0] - t * dx, -z - s.a[1] - t * dy) > s.half) continue;
    if (Math.abs(s.ha + (s.hb - s.ha) * t - selected) > 0.01) continue;
    const gx = (s.hb - s.ha) * dx / length2, gz = -(s.hb - s.ha) * dy / length2;
    const length = Math.hypot(gx, 1, gz);
    return {x: -gx / length, y: 1 / length, z: -gz / length};
  }
  return groundNormal(x, z, step);
}
