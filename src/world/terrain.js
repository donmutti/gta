// The terrain height field — the ONE source of ground elevation, shared by the renderer (which
// lifts the ground, roads, sidewalks, buildings, props onto it) and the physics (which will read
// the car's ground height, camera pitch, and placement from it). Pure data + math: no THREE, no
// DOM, so both halves import it freely. See the telegraph — groundHeight(x, z) is the seam.
//
// Coordinate law (same as everywhere): world x = map x (east+), world z = -map y (so north is -z).
// The baked grid is row-major in MAP coords: row 0 = south (minY), column 0 = west (minX). Heights
// are metres relative to the slice centre (which is y=0), so the origin sits at ground level and the
// city rises toward the plateau and drops into the Pfaffenthal gorge exactly as the real land does.

// TERRAIN IS OFF. Flip this to true to bring the hills back — nothing else needs changing.
//
// The hills were built and then switched off deliberately. With the car still driving on a flat
// plane, a terraned world broke in ways that ruined simply LOOKING at the city: traffic flew above
// or sank through the roads, and the displaced ground mesh cut black planes across the view. Every
// consumer of this module already treats "no field installed" as a flat world (groundHeight returns
// 0, groundNormal returns straight up, the seating helpers return 0), so refusing to install the
// field flattens the ENTIRE city in one place — geometry, props, decor, easter eggs and all —
// without touching a single call site. The fetch, the baked heightfield.json and all the seating
// maths stay exactly as they were, so reviving the hills is this one flag plus the car work that
// was never finished: read groundHeight for the car's Y and groundNormal for its tilt.
const TERRAIN_ENABLED = false;

let FIELD = null;   // {nx, ny, minX, maxX, minY, maxY, heights[]}

/** Install the baked heightfield (from public/data/heightfield.json). Ignored while terrain is off. */
export function setHeightfield(hf) { FIELD = TERRAIN_ENABLED ? hf : null; }

/** True once a real field is loaded — callers can cheaply skip terrain math before then. */
export function hasTerrain() { return FIELD !== null; }

/**
 * Ground elevation (world Y) at world (x, z). Bilinear over the baked grid; clamps at the edges so
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
  const a = h00 + (h10 - h00) * fx;
  const b = h01 + (h11 - h01) * fx;
  return a + (b - a) * fy;
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
  for (const [px, py] of pts) {
    const g = groundHeight(px, -py);
    if (g < lo) lo = g;
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
