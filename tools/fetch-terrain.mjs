#!/usr/bin/env node
// Fetch a DEM (SRTM 30m via opentopodata) over the game's slice and bake a coarse heightfield grid
// the game samples with bilinear interpolation. Output committed like city.json — no network at play.
//
// The grid is in the SAME local-metre projection as city.json (equirectangular about the slice
// centre), and elevations are shifted so the slice CENTRE reads y=0 — the game world is built
// around the origin, so the ground should pass through zero there and rise/fall around it.
import {readFileSync, writeFileSync} from 'node:fs';

const meta = JSON.parse(readFileSync('public/data/city.json', 'utf8')).meta;
const [S, W, N, E] = meta.bbox.split(',').map(Number);
const lat0 = (S + N) / 2, lon0 = (W + E) / 2, R = 6378137, DEG = Math.PI / 180;
const toXY = (lat, lon) => [(lon - lon0) * DEG * R * Math.cos(lat0 * DEG), (lat - lat0) * DEG * R];

// Grid resolution. SRTM is ~30m; sampling finer than that just interpolates the same data, so a
// ~35m spacing over the slice is honest. The slice is ~2.2km E-W x ~2.8km N-S.
const NX = 34, NY = 40;                 // grid columns x rows (1360 points, batched politely)
const lats = [], lons = [];
for (let j = 0; j < NY; j++) {
  for (let i = 0; i < NX; i++) {
    lats.push(S + (N - S) * (j / (NY - 1)));
    lons.push(W + (E - W) * (i / (NX - 1)));
  }
}

// opentopodata: max 100 locations per request, 1 req/sec courtesy. Batch.
const elev = new Array(lats.length).fill(0);
const BATCH = 100;
async function sleep(ms) { await new Promise(r => setTimeout(r, ms)); }
for (let b = 0; b < lats.length; b += BATCH) {
  const locs = [];
  for (let k = b; k < Math.min(b + BATCH, lats.length); k++) locs.push(`${lats[k]},${lons[k]}`);
  let ok = false;
  for (let attempt = 0; attempt < 4 && !ok; attempt++) {
    try {
      const res = await fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${locs.join('|')}`);
      if (res.status === 429) { await sleep(2000); continue; }
      const j = await res.json();
      if (j.status !== 'OK') { await sleep(1500); continue; }
      j.results.forEach((r, idx) => { elev[b + idx] = r.elevation ?? 0; });
      ok = true;
    } catch (e) { await sleep(1500); }
  }
  if (!ok) { console.error('batch failed at', b); process.exit(1); }
  process.stdout.write(`\r sampled ${Math.min(b + BATCH, lats.length)}/${lats.length}`);
  await sleep(1100);   // stay under 1 req/sec
}
console.log('');

// Centre elevation -> the value we subtract so the origin sits at y=0.
const cLat = lat0, cLon = lon0;
// nearest grid point to centre
let ci = 0, cd = Infinity;
for (let k = 0; k < lats.length; k++) {
  const d = (lats[k] - cLat) ** 2 + (lons[k] - cLon) ** 2;
  if (d < cd) { cd = d; ci = k; }
}
const base = elev[ci];

// Bake: local-metre extent of the grid corners, the grid dims, and the zeroed heights row-major.
const [x0, y0] = toXY(S, W);   // note: y here is map-Y (north+). grid row j runs S->N so map-Y increases.
const [x1, y1] = toXY(N, E);
const minMX = Math.min(x0, x1), maxMX = Math.max(x0, x1);
const minMY = Math.min(y0, y1), maxMY = Math.max(y0, y1);
const heights = elev.map(e => +(e - base).toFixed(2));

const out = {
  nx: NX, ny: NY,
  // bounds in local map coords (x east, y north). Sample maps world (x, mapY) into [0..nx-1]/[0..ny-1].
  minX: +minMX.toFixed(2), maxX: +maxMX.toFixed(2),
  minY: +minMY.toFixed(2), maxY: +maxMY.toFixed(2),
  base: +base.toFixed(2),
  heights,   // row-major, row 0 = south (minY), column 0 = west (minX)
};
writeFileSync('public/data/heightfield.json', JSON.stringify(out));
const lo = Math.min(...heights), hi = Math.max(...heights);
console.log(`baked ${NX}x${NY} heightfield, base ${base}m, relief ${lo.toFixed(0)}..${hi.toFixed(0)}m -> public/data/heightfield.json`);
