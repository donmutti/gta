// European townhouse factory. Every house is ONE THREE.Group, deterministically varied by a
// seed so the same lot always looks the same across scene reloads (no Math.random anywhere).
//
// ORIGIN + FACING CONVENTION
// --------------------------
// The returned Group's origin is the FRONT-CENTRE of the house at ground level (y = 0). The
// facade faces +Z; the building extends in -Z (back), and the shallow front yard — hedge and
// driveway — sits in +Z, between the facade and the road. Width runs along X (centred on 0),
// height along +Y. So Master places one house by putting the origin on a footprint edge and
// rotating about Y until +Z points at the road.
//
// PERFORMANCE
// -----------
// A house is a handful of merged BufferGeometries, not dozens of meshes: one body mesh
// (walls + roof + door + steps + cornice + chimney + hedge + driveway, all sharing vertex
// colours on a single MeshLambertMaterial) and one window mesh (an emissive material shared
// across ALL houses so windows can glow warm at night under the scene's bloom pass). ~600-1200
// tris per house. buildTownhouseRow merges many houses into those same two meshes for a whole
// terrace at two draw calls.

import * as THREE from 'three';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// --- deterministic hash: a small integer PRNG seeded per-house, no trig, GPU-collapse-proof --
// mulberry32: fast, well-distributed, stable. Returns a function yielding floats in [0,1).
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const range = (r, lo, hi) => lo + r() * (hi - lo);
const chance = (r, p) => r() < p;

// --- palettes: believable European plasters, brick, stone, muted washes ---------------------
const FACADE = [
  0xe8dcc4, 0xdccbaa, 0xe6d3a8, 0xd8c088, // creams & ochres
  0xcdb894, 0xc9a26a, 0xbf8f5a,           // warm sand / ochre
  0xb5654a, 0xa8503c, 0x9d4436,           // muted brick reds
  0xd9d4cc, 0xc4c0b8, 0xb0aca4,           // greys / stone
  0xbcc6cf, 0xa9bcc8, 0xc7d2d6,           // pale blues
  0xcdd6c2, 0xb7c4a8,                     // pale sage
];
const TRIM = 0xf3efe6;                    // window frames, cornice, sills — off-white stone
const ROOF = [0x4a4e57, 0x3c4048, 0x565a63, 0x6b4636, 0x7a4a38, 0x555049]; // slate greys + tile reds
const DOOR = [0x2a3d2e, 0x14202e, 0x5a1f22, 0x33251a, 0x1f1f24, 0x2d4256, 0x6b5030]; // deep green/navy/oxblood/walnut
const HEDGE = [0x3a5a34, 0x33512e, 0x40613a];
const PAVING = [0x9a938a, 0x8c857c, 0xa39c92];

// --- shared materials (created once, reused by every house) ---------------------------------
let _bodyMat = null;
let _windowMat = null;
export function townhouseMaterials() {
  if (!_bodyMat) {
    // DoubleSide so a townhouse is never hollow: you drive down residential streets these line, and
    // a single-sided wall culls to see-through the instant the camera clips a facade, plus it rescues
    // any hand-built roof prism whose winding faces inward.
    _bodyMat = new THREE.MeshLambertMaterial({vertexColors: true, side: THREE.DoubleSide});
    // Emissive window glass. Colour warm; emissive driven by Master (or left as a gentle glow).
    // toneMapped:false lets it read as a light source through the bloom pass at night.
    // A faint cool baseline emissive keeps the near-black glass reading as GLASS in daylight
    // (a matte-black pane looks like a boarded hole); Master raises this warm at night for glow.
    _windowMat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      emissive: 0x9fbcd6,      // cool sky-reflection tint by day
      emissiveIntensity: 0.55, // keeps panes from going pitch-black in shadow; raise+warm at night
    });
  }
  return {bodyMat: _bodyMat, windowMat: _windowMat};
}

// A geometry with a flat vertex colour baked in, so many can merge onto one material. All merged
// geometries must share the EXACT same attribute set, so we keep only position + normal + color
// (BoxGeometry ships a uv the hand-built prisms lack, and a mismatch makes mergeGeometries fail).
function coloured(geo, color) {
  if (geo.index) geo = geo.toNonIndexed();
  delete geo.attributes.uv;
  delete geo.attributes.uv1;
  delete geo.attributes.uv2;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
function box(w, h, d, x, y, z, color) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return coloured(g, color);
}

// Build the raw geometry pieces for one house, split into body pieces and window pieces so the
// caller can merge each set onto its own material. offsetX/rotY let a row lay houses side by side
// in one merge. Returns {body:[geos], glass:[geos], width}.
function houseGeometry(seed, opts = {}) {
  const r = rng((seed | 0) * 2654435761 >>> 0 || 1);

  // storeys 3..6, biased toward 3-4 so the row reads as townhouses, not apartment towers
  const storeys = opts.storeys ?? pick(r, [3, 3, 3, 4, 4, 4, 5, 5, 6]);
  // width varies widely so a row mixes narrow 2-bay and wide 4-bay houses
  const width = opts.width ?? pick(r, [4.8, 5.4, 6.2, 6.2, 7.0, 7.8, 8.6, 9.4]);
  const depth = opts.depth ?? range(r, 7, 11);
  const sh = range(r, 3.0, 3.3);                 // storey height
  const groundExtra = range(r, 0.3, 0.7);        // taller ground floor
  const wallH = groundExtra + storeys * sh;

  const facade = pick(r, FACADE);
  const roofCol = pick(r, ROOF);
  const doorCol = pick(r, DOOR);
  const hedgeCol = pick(r, HEDGE);
  const pavingCol = pick(r, PAVING);

  const halfW = width / 2;
  const backZ = -depth;              // facade at z=0, back wall at z=-depth
  const body = [];
  const glass = [];

  // ---- main wall block. Facade colour on the whole box -------------------------------------
  body.push(box(width, wallH, depth, 0, wallH / 2, -depth / 2, facade));
  const groundH = sh + groundExtra;
  // ---- ground storey: a distinct RUSTICATED STONE base, paler/greyer than the facade --------
  const stoneCol = new THREE.Color(0xcfc7b8).lerp(new THREE.Color(facade), 0.25).getHex();
  body.push(box(width * 1.01, groundH, 0.1, 0, groundH / 2, 0.05, stoneCol)); // proud stone face
  // horizontal rustication grooves — a few recessed dark lines across the ground storey
  const nGroove = 3;
  for (let i = 1; i <= nGroove; i++) {
    const gy = groundH * i / (nGroove + 1);
    body.push(box(width * 1.01, 0.04, 0.06, 0, gy, 0.06, 0x8a8175));
  }

  // ---- cornice: a lip under the roof line, lighter stone -------------------------------------
  body.push(box(width + 0.5, 0.35, depth + 0.5, 0, wallH + 0.02, -depth / 2, TRIM));
  // string course between ground floor and upper floors — a horizontal band, very European
  body.push(box(width + 0.12, 0.16, depth + 0.12, 0, groundExtra + sh, -depth / 2, TRIM));
  // ---- plinth: a distinct DARK STONE base course, tall enough to read ------------------------
  const plinthH = range(r, 0.6, 1.0);
  body.push(box(width + 0.18, plinthH, depth + 0.18, 0, plinthH / 2, -depth / 2, 0x5a544c));

  // ---- windows: a grid of TALL VERTICAL casements with a mullion cross -----------------------
  // Vertical proportion (~1:2) reads European; a cross bar (one vertical + one horizontal glazing
  // bar) turns a grey pane into a casement window. Ground floor windows are taller than upper ones.
  const cols = Math.max(2, Math.min(4, Math.round(width / 2.2)));
  const bayW = width / cols;
  const winW = Math.min(1.0, bayW * range(r, 0.40, 0.50));
  const upperH = winW * range(r, 1.9, 2.3);      // 1:2-ish, vertical
  const recess = 0.12;
  const sillOut = chance(r, 0.8);           // protruding stone sills (most houses)
  const lintel = chance(r, 0.55);           // lintel bar above windows
  const arched = chance(r, 0.35);           // arched heads (semicircle on top) on some houses
  const doorBay = Math.floor(r() * cols);   // which ground bay holds the door
  const commercial = chance(r, 0.4);        // a shopfront on the ground floor of some houses
  const awningCol = pick(r, [0x8a2f2f, 0x2f5f4a, 0x2f4a6a, 0x6a5a2f, 0x4a3a5a]);
  const balcony = pick(r, ['none', 'none', 'juliet', 'full']); // wrought-iron balconies
  const ironCol = 0x1c1c20;                  // wrought iron, near-black
  const shutters = chance(r, 0.45);
  // shutters are a saturated colour (grey-green, blue-grey, oxblood, dark brown) — clearly joinery
  const shutterCol = pick(r, [0x4a5b46, 0x40566a, 0x6b3a34, 0x3a3128, 0x555b60]);
  const glassCol = 0x445a6b;                 // slate-blue glass (a lit sky reflection, not a hole)

  // A window that reads as a GLAZED OPENING, not a slab: a large dark recessed pane fills the
  // hole, and a THIN white picture-frame (four bars) rings it so the dark centre dominates from
  // any angle. Muntins split the pane into panes. Deep reveal so it reads as a real opening.
  function windowAt(cx, cy, h, w) {
    // dark reveal walls of the opening (sides go back), then the glass at the back of the recess
    body.push(box(w + 0.14, h + 0.14, 0.16, cx, cy, -0.02, 0x241f18)); // sunk dark reveal
    glass.push(box(w, h, 0.04, cx, cy, -recess, glassCol));            // the dark glass pane
    // thin white frame: four bars flush with the wall face, ringing the opening
    const t = 0.09;                                                    // bar thickness
    body.push(box(w + 2 * t, t, 0.09, cx, cy + h / 2 + t / 2, 0.04, TRIM)); // top
    body.push(box(w + 2 * t, t, 0.09, cx, cy - h / 2 - t / 2, 0.04, TRIM)); // bottom
    body.push(box(t, h, 0.09, cx - w / 2 - t / 2, cy, 0.04, TRIM));         // left
    body.push(box(t, h, 0.09, cx + w / 2 + t / 2, cy, 0.04, TRIM));         // right
    // muntins: bold white glazing bars across the glass — one central mullion, one transom, plus
    // a second vertical each side so the pane clearly reads as a multi-light casement, not a hole
    const mz = -recess + 0.05;
    body.push(box(0.06, h, 0.05, cx, cy, mz, TRIM));            // central mullion
    body.push(box(w, 0.06, 0.05, cx, cy, mz, TRIM));            // transom
    body.push(box(0.045, h, 0.05, cx - w * 0.25, cy, mz, TRIM)); // left light bar
    body.push(box(0.045, h, 0.05, cx + w * 0.25, cy, mz, TRIM)); // right light bar
    if (arched) {
      body.push(box(w + 2 * t, 0.14, 0.12, cx, cy + h / 2 + t + 0.05, 0.03, TRIM));
      body.push(box(0.16, 0.22, 0.14, cx, cy + h / 2 + t + 0.12, 0.02, TRIM)); // keystone
    } else if (lintel) {
      body.push(box(w + 0.3, 0.12, 0.14, cx, cy + h / 2 + t + 0.03, 0.05, TRIM));
    }
    if (sillOut) body.push(box(w + 0.34, 0.12, 0.2, cx, cy - h / 2 - t - 0.03, 0.06, TRIM));
    if (shutters) {
      // shutters folded flat against the wall to the SIDES of the opening — clearly not glass:
      // coloured louvred panels, darker than the frame, standing proud of the facade
      const sw = w * 0.5;
      body.push(box(sw, h + 0.12, 0.06, cx - w / 2 - sw / 2 - t, cy, 0.08, shutterCol));
      body.push(box(sw, h + 0.12, 0.06, cx + w / 2 + sw / 2 + t, cy, 0.08, shutterCol));
    }
  }

  // a shopfront in one ground-floor bay: big glazed pane, dark stall riser, fascia + awning
  function shopfront(cx, w) {
    const g0 = groundExtra + 0.35;              // above the plinth
    const g1 = groundH - 0.5;                   // below the string course
    const gh = g1 - g0, gcy = (g0 + g1) / 2;
    body.push(box(w + 0.14, gh + 0.14, 0.14, cx, gcy, 0.07, 0x3a352c));   // dark shop frame
    body.push(box(w * 0.32, gh, 0.06, cx, gcy - 0.05, 0.02, 0x2a2620));   // mullion between panes
    glass.push(box(w * 0.44, gh - 0.1, 0.04, cx - w * 0.26, gcy, -0.06, 0x2a3a44));
    glass.push(box(w * 0.44, gh - 0.1, 0.04, cx + w * 0.26, gcy, -0.06, 0x2a3a44));
    body.push(box(w + 0.3, 0.35, 0.16, cx, g1 + 0.2, 0.08, 0x2a251e));    // fascia board (sign)
    // striped awning: a slab tilted out over the shopfront
    const aw = new THREE.BoxGeometry(w + 0.3, 0.1, 0.9);
    aw.rotateX(-0.35); aw.translate(cx, g1 + 0.05, 0.55);
    body.push(coloured(aw, awningCol));
  }

  // a wrought-iron railing centred at (cx) with given span, at height y, standing out at zFront
  function railing(cx, span, y, zFront) {
    const railH = 0.65;
    body.push(box(span, 0.05, 0.05, cx, y + railH, zFront, ironCol));       // top rail
    body.push(box(span, 0.05, 0.05, cx, y + 0.06, zFront, ironCol));        // bottom rail
    const nB = Math.max(4, Math.round(span / 0.22));
    for (let i = 0; i <= nB; i++) {
      const bx = cx - span / 2 + span * i / nB;
      body.push(box(0.03, railH, 0.03, bx, y + railH / 2, zFront, ironCol)); // balusters
    }
  }

  for (let s = 0; s < storeys; s++) {
    const isGround = s === 0;
    const isPiano = s === 1;                        // piano nobile: grand first upper floor
    const floorBase = groundExtra + (isGround ? 0 : sh + (s - 1) * sh);
    const h = isGround ? upperH * 1.15 : (isPiano ? upperH * 1.18 : upperH);
    const cy = floorBase + (isGround ? groundH * 0.5 : sh * 0.5) + 0.15;
    // full-width balcony slab on the piano nobile
    if (isPiano && balcony === 'full') {
      body.push(box(width + 0.3, 0.12, 0.7, 0, cy - h / 2 - 0.05, 0.35, 0x6a655c)); // stone slab
      railing(0, width + 0.2, cy - h / 2 - 0.05, 0.62);
    }
    for (let c = 0; c < cols; c++) {
      const cx = -halfW + bayW * (c + 0.5);
      if (isGround && c === doorBay) continue;      // door goes here instead
      if (isGround && commercial) { shopfront(cx, bayW * 0.82); continue; }
      windowAt(cx, cy, h, winW);
      // juliet balcony: a short railing across the window sill
      if (isPiano && balcony === 'juliet') railing(cx, winW + 0.3, cy - h / 2 - 0.02, 0.16);
    }
  }

  // ---- front door: a tall panelled door with a fanlight over it, step and portico -----------
  {
    const dx = -halfW + bayW * (doorBay + 0.5);
    const dw = Math.min(1.2, bayW * 0.62);
    const dh = range(r, 2.3, 2.7);            // taller than a window — a proper entrance
    // stone surround, wider and taller so it reads as an important opening
    body.push(box(dw + 0.4, dh + 0.5, 0.14, dx, (dh + 0.5) / 2, 0.07, TRIM));
    body.push(box(dw, dh, 0.06, dx, dh / 2, 0.02, doorCol));                  // the door leaf
    // two recessed panels on the leaf, hinted with a slightly darker inset
    const pc = new THREE.Color(doorCol).multiplyScalar(0.8).getHex();
    body.push(box(dw * 0.6, dh * 0.32, 0.03, dx, dh * 0.32, 0.05, pc));
    body.push(box(dw * 0.6, dh * 0.32, 0.03, dx, dh * 0.66, 0.05, pc));
    body.push(box(dw * 0.28, 0.14, 0.07, dx, dh * 0.5, 0.09, 0xd8c56a));      // brass handle strip
    // fanlight / transom window above the door — glows at night like the windows
    glass.push(box(dw, 0.4, 0.04, dx, dh + 0.28, -0.02, glassCol));
    body.push(box(0.06, 0.4, 0.05, dx, dh + 0.28, 0.03, TRIM));               // fanlight bar
    // step(s)
    body.push(box(dw + 0.7, 0.16, 0.55, dx, 0.08, 0.3, PAVING[0]));
    body.push(box(dw + 0.4, 0.16, 0.32, dx, 0.24, 0.2, PAVING[0]));
    // slim portico canopy on some houses
    if (chance(r, 0.45)) {
      body.push(box(dw + 0.7, 0.14, 0.6, dx, dh + 0.62, 0.26, TRIM));
      body.push(box(0.12, 0.5, 0.12, dx - dw / 2 - 0.15, dh + 0.35, 0.5, TRIM)); // bracket
      body.push(box(0.12, 0.5, 0.12, dx + dw / 2 + 0.15, dh + 0.35, 0.5, TRIM));
    }
  }

  // ---- roof: a STEEP pitched roof — the single strongest European tell -----------------------
  // Three types: street-facing gable (triangle faces the road), eaves-front gable (long slope
  // faces the road, dormers poke through), and mansard (steep skirt + shallow cap, dormers).
  const roofType = pick(r, ['gableStreet', 'gableEaves', 'gableEaves', 'mansard', 'mansard']);
  const rTop = wallH + 0.35;
  const roofW = width + 0.4, roofD = depth + 0.4;
  // a small dormer: box body + glass, sitting on a slope at front z
  function dormer(cx, y, z, faceCol) {
    body.push(box(0.85, 0.85, 0.55, cx, y, z, faceCol));
    body.push(prismGableX(0.95, 0.6, 0.4, cx, y + 0.42, z, faceCol)); // little gable cap
    glass.push(box(0.55, 0.55, 0.04, cx, y, z + 0.29, glassCol));
  }
  if (roofType === 'gableStreet') {
    // ridge runs front-to-back; steep triangular gable faces +Z (the street)
    const ph = range(r, 3.0, 4.5);
    body.push(prismGable(roofW, roofD, ph, 0, rTop, -depth / 2, roofCol));
    // a small round/oval attic vent in the gable triangle
    if (chance(r, 0.6)) glass.push(box(0.5, 0.5, 0.05, 0, rTop + ph * 0.55, 0.02, glassCol));
  } else if (roofType === 'gableEaves') {
    // ridge runs left-right; two long slopes face front/back; steep. Dormers poke from front slope.
    const ph = range(r, 2.6, 3.8);
    body.push(prismGableX(roofW, roofD, ph, 0, rTop, -depth / 2, roofCol));
    const nD = 1 + Math.floor(r() * Math.max(1, cols - 1));
    for (let i = 0; i < nD; i++) {
      const dcx = -halfW + width * (i + 1) / (nD + 1);
      dormer(dcx, rTop + ph * 0.42, 0.15, new THREE.Color(facade).multiplyScalar(1.02).getHex());
    }
  } else {
    // mansard: steep lower skirt (frustum) + shallow gable cap; dormers on the front skirt
    const lowH = range(r, 1.6, 2.2);
    body.push(frustum(roofW, roofD, width - 0.8, depth - 0.8, lowH, 0, rTop, -depth / 2, roofCol));
    const capCol = new THREE.Color(roofCol).multiplyScalar(0.88).getHex();
    body.push(prismGableX(width - 0.8, depth - 0.8, 0.7, 0, rTop + lowH, -depth / 2, capCol));
    const nD = 1 + Math.floor(r() * Math.max(1, cols - 1));
    for (let i = 0; i < nD; i++) {
      const dcx = -halfW + width * (i + 1) / (nD + 1);
      // dormers sit on the front skirt, pushed slightly forward and up
      dormer(dcx, rTop + lowH * 0.45, 0.35, new THREE.Color(facade).multiplyScalar(1.02).getHex());
    }
  }

  // ---- chimney(s): tall brick stacks on the ridge, breaking the silhouette ------------------
  {
    const nCh = chance(r, 0.85) ? (chance(r, 0.4) ? 2 : 1) : 0;
    const brick = new THREE.Color(0x8a5a44).multiplyScalar(0.92).getHex();
    for (let i = 0; i < nCh; i++) {
      // sit near the roof apex so it reads against the sky; toward the party walls for realism
      const chx = nCh === 2 ? (i === 0 ? -width * 0.34 : width * 0.34) : range(r, -width * 0.28, width * 0.28);
      const chH = range(r, 1.6, 2.4);
      const chz = -depth * range(r, 0.35, 0.6);
      const chBase = rTop + 1.0;             // start above the eaves, poke through the roof
      body.push(box(0.6, chH, 0.55, chx, chBase + chH / 2, chz, brick));
      body.push(box(0.74, 0.18, 0.68, chx, chBase + chH, chz, 0x4a4038)); // cap
      // 2-3 pots on the cap
      const pc = 0x8a4a3a;
      body.push(box(0.14, 0.28, 0.14, chx - 0.14, chBase + chH + 0.2, chz, pc));
      body.push(box(0.14, 0.28, 0.14, chx + 0.14, chBase + chH + 0.2, chz, pc));
    }
  }

  // ---- front yard: hedge with a gap for the path, and a driveway strip toward +Z (road) -----
  const yardDepth = range(r, 3.0, 4.5);
  const hedgeH = range(r, 0.55, 0.9);
  const hedgeZ = yardDepth - 0.3;
  const gapX = -halfW + bayW * (doorBay + 0.5);      // gap aligns with the door path
  const gapHalf = 0.9;
  // hedge is two segments left/right of the gap, clipped-box look (slightly domed by scale)
  const leftLen = (gapX - gapHalf) - (-halfW - 0.2);
  const rightLen = (halfW + 0.2) - (gapX + gapHalf);
  if (leftLen > 0.2) body.push(box(leftLen, hedgeH, 0.7, -halfW - 0.2 + leftLen / 2, hedgeH / 2, hedgeZ, hedgeCol));
  if (rightLen > 0.2) body.push(box(rightLen, hedgeH, 0.7, gapX + gapHalf + rightLen / 2, hedgeH / 2, hedgeZ, hedgeCol));
  // a couple of clipped topiary balls flanking the gate on some houses
  if (chance(r, 0.4)) {
    const ballCol = new THREE.Color(hedgeCol).multiplyScalar(1.1).getHex();
    body.push(sphere(0.4, gapX - gapHalf - 0.1, 0.4, hedgeZ, ballCol));
    body.push(sphere(0.4, gapX + gapHalf + 0.1, 0.4, hedgeZ, ballCol));
  }
  // driveway / front path: paving strip from facade to the road side, through the hedge gap
  const drive = chance(r, 0.55); // some are a garden path, some a full driveway
  const pathW = drive ? Math.min(width * 0.55, 3.2) : 1.6;
  const pathX = drive ? range(r, -halfW * 0.3, halfW * 0.3) : gapX;
  body.push(box(pathW, 0.06, yardDepth + 0.4, pathX, 0.03, yardDepth / 2, pavingCol));
  // lawn/soil border strip so the yard reads as a yard, not floating paving
  const lawnCol = new THREE.Color(0x4a6b3a).multiplyScalar(0.9).getHex();
  body.push(box(width + 0.6, 0.04, yardDepth + 0.2, 0, 0.02, yardDepth / 2 - 0.1, lawnCol));

  return {body, glass, width, depth, storeys};
}

// --- helper geometries ----------------------------------------------------------------------
// A gable prism: triangular cross-section along the ridge (ridge runs along Z, i.e. front-back).
function prismGable(w, d, h, cx, cy, cz, color) {
  const hw = w / 2, hd = d / 2;
  const pos = [];
  // Two triangular gable ends + two roof slopes + two? We build as: ridge line at (0,h,±hd).
  const A = [-hw, 0, hd], B = [hw, 0, hd], R1 = [0, h, hd];      // front gable
  const C = [-hw, 0, -hd], D = [hw, 0, -hd], R2 = [0, h, -hd];   // back gable
  const tri = (p, q, s) => { pos.push(...p, ...q, ...s); };
  tri(A, B, R1);                          // front gable triangle
  tri(D, C, R2);                          // back gable triangle
  tri(A, R1, R2); tri(A, R2, C);          // left slope (two tris)
  tri(B, R2, R1); tri(B, D, R2);          // right slope
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.translate(cx, cy, cz);
  return coloured(g, color);
}
// Gable prism with the ridge running along X: triangular ends face ±X, the two long slopes face
// front/back (±Z). This is the "eaves-front" roof — the long slope is what you see from the street.
function prismGableX(w, d, h, cx, cy, cz, color) {
  const hw = w / 2, hd = d / 2;
  const pos = [];
  const A = [hw, 0, hd], B = [hw, 0, -hd], R1 = [hw, h, 0];      // right gable end
  const C = [-hw, 0, hd], D = [-hw, 0, -hd], R2 = [-hw, h, 0];   // left gable end
  const tri = (p, q, s) => { pos.push(...p, ...q, ...s); };
  tri(A, R1, B);                          // right gable triangle
  tri(C, D, R2);                          // left gable triangle
  tri(A, C, R2); tri(A, R2, R1);          // front slope
  tri(B, R1, R2); tri(B, R2, D);          // back slope
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.translate(cx, cy, cz);
  return coloured(g, color);
}
// A rectangular frustum (bottom wxd, top w2xd2) of height h — for mansard/hip roofs.
function frustum(w, d, w2, d2, h, cx, cy, cz, color) {
  const hw = w / 2, hd = d / 2, hw2 = w2 / 2, hd2 = d2 / 2;
  const b0 = [-hw, 0, hd], b1 = [hw, 0, hd], b2 = [hw, 0, -hd], b3 = [-hw, 0, -hd];
  const t0 = [-hw2, h, hd2], t1 = [hw2, h, hd2], t2 = [hw2, h, -hd2], t3 = [-hw2, h, -hd2];
  const pos = [];
  const quad = (a, b, c, d2_) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d2_); };
  quad(b0, b1, t1, t0); quad(b1, b2, t2, t1); quad(b2, b3, t3, t2); quad(b3, b0, t0, t3);
  quad(t0, t1, t2, t3); // top cap
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.translate(cx, cy, cz);
  return coloured(g, color);
}
function sphere(rad, cx, cy, cz, color) {
  const g = new THREE.SphereGeometry(rad, 7, 5);
  g.scale(1, 0.9, 1);
  g.translate(cx, cy, cz);
  return coloured(g, color);
}

// --- public: ONE townhouse as a Group (the required interface) ------------------------------
export function makeTownhouse(seed = 0, opts = {}) {
  const {body, glass} = houseGeometry(seed, opts);
  const {bodyMat, windowMat} = townhouseMaterials();
  const g = new THREE.Group();
  g.name = 'townhouse';
  const bodyGeo = mergeGeometries(body, false);
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true; bodyMesh.receiveShadow = true;
  g.add(bodyMesh);
  if (glass.length) {
    const glassGeo = mergeGeometries(glass, false);
    const glassMesh = new THREE.Mesh(glassGeo, windowMat);
    glassMesh.castShadow = false;
    g.add(glassMesh);
  }
  return g;
}

// --- public: a whole terrace merged into two meshes (body + glass) --------------------------
// houses: array of {seed, x, z, rotY, storeys?, width?, depth?}. Positions/rotations are baked
// into the merged geometry, so the returned Group has just two draw calls for the whole row.
export function buildTownhouseRow(houses) {
  const {bodyMat, windowMat} = townhouseMaterials();
  const allBody = [], allGlass = [];
  const m = new THREE.Matrix4(), e = new THREE.Euler();
  for (const h of houses) {
    const {body, glass} = houseGeometry(h.seed | 0, h);
    e.set(0, h.rotY || 0, 0);
    m.makeRotationFromEuler(e);
    m.setPosition(h.x || 0, h.y || 0, h.z || 0);   // h.y = terrain height under the house (0 if flat)
    for (const b of body) allBody.push(b.applyMatrix4(m));
    for (const gl of glass) allGlass.push(gl.applyMatrix4(m));
  }
  const group = new THREE.Group();
  group.name = 'townhouse-row';
  if (allBody.length) {
    const mesh = new THREE.Mesh(mergeGeometries(allBody, false), bodyMat);
    mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
  }
  if (allGlass.length) {
    group.add(new THREE.Mesh(mergeGeometries(allGlass, false), windowMat));
  }
  return group;
}
