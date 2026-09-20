// Findel airport — the one region east of the city you can drive into and onto a live runway.
// Owns nothing but its own Group; Master places it, runs the access road through the open gate,
// and makes the runway drivable. Everything here is REAL Findel geometry from public/data/findel.json
// (OSM, re-anchored so the airport centroid sits at map [1550, 300], a short drive past the city).
//
// COORDINATE CONVENTION (the one law that governs every vertex below):
//   The data is map space: [x, y] points, +y = north. The game renders in Three's XZ ground plane
//   and NEGATES map y into world z:  world.x = map.x,  world.z = -map.y  (see src/render/scene.js).
//   Ground is y = 0. So every point [mx, my] becomes THREE position (mx, height, -my). The helper
//   V([mx,my], h) does exactly that and is used EVERYWHERE — never hand-write -y anywhere else.
//
// MATERIALS: no env map exists in the scene, so metalness ~1 renders BLACK. Everything here is
// MeshLambert or MeshStandard with low metalness. Surfaces are merged; fence posts are instanced.
//
// CONTRACT (the only export Master calls):
//   buildFindel(findel) -> THREE.Group
//     group.userData.gate     = {x, z, heading}  // world coords of the open gate mouth + facing
//     group.userData.airplane = {x, z}           // world coords of the parked airliner
//
import * as THREE from 'three';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// map [x,y] -> world Vector3 (world.z = -y). The single source of the y-negation.
const V = (p, y = 0) => new THREE.Vector3(p[0], y, -p[1]);
const pseudo = (n) => { const s = Math.sin(n) * 43758.5453; return s - Math.floor(s); };

// ---------------------------------------------------------------------------
// Palette — kept in one place so the airport reads as one built place, not a pile of parts.
const COL = {
  runway:   0x25272c,   // dark aged asphalt — reads clearly against grass
  concrete: 0xadb0b6,   // apron concrete, distinctly pale so pavement reads
  taxiway:  0x9a9da3,   // taxiway concrete, a touch darker than apron
  paint:    0xf4f2ea,   // runway/taxi markings, bright warm white
  taxiLine: 0xe0c53a,   // taxiway centreline yellow
  terminal: 0x9ea6b0,   // terminal cladding
  glass:    0x5b7690,   // curtain-wall glazing — muted steel-blue, not a black wall
  hangar:   0xc2c7cd,   // hangar sheet metal
  hangarRoof: 0x757b83,
  building: 0x8f8a84,   // generic airport sheds — matches the city sandstone
  towerShaft: 0xd2d5da,
  towerCab:  0x2a3c50,
  fence:    0x3b4048,
  planeBody: 0xf2f4f7,  // fuselage white
  planeLivery: 0xc0392b,// a red cheatline + tail (generic carrier)
  planeWing: 0xdfe3e8,
  planeEngine: 0x4a4e57,
};

export function buildFindel(findel) {
  const group = new THREE.Group();
  group.name = 'findel';

  // The real Findel geometry sprawls ~3km with 400 OSM footprints scattered across fields. That
  // reads as noise, not an airport. We build around a compact CORE — the terminal, control tower,
  // hangars and the aprons that serve them — and keep the full REAL runway as the drivable strip
  // reaching out of the core. The fence and gate enclose the core; the runway pierces it.
  const core = coreBounds(findel);
  group.userData.core = core;

  // ---- surfaces (merged): runway, taxiways, aprons ----------------------------------------
  const {runwayCenter, runwayDir, runwayHalf} = addSurfaces(group, findel, core);

  // ---- runway markings: dashed centreline, threshold bars, runway number -------------------
  addRunwayMarkings(group, findel.runways, runwayCenter, runwayDir, runwayHalf);

  // ---- buildings: terminal (glazed), hangars (gabled), sheds, and the control tower --------
  addBuildings(group, findel, core);
  addControlTower(group, findel.tower);

  // ---- perimeter fence with a pair of open gates on the city-facing (west) side ------------
  const gate = addPerimeterFence(group, findel, core);
  group.userData.gate = gate;

  // ---- the parked airliner standing on the apron near the terminal -------------------------
  const plane = addAirliner(group, findel, core);
  group.userData.airplane = {x: plane.x, z: plane.z};

  return group;
}

// ===========================================================================================
// Core bounds — the heart of the field. Anchored on the terminal cluster (terminals + hangars +
// the control tower), then grown to include the aprons that touch it, so the built area reads as
// one enclosed airport rather than a scatter of sheds. A hard cap keeps it drivable-scale.
function coreBounds(findel) {
  // seed from terminals, hangars and the tower — the unambiguous "airport" objects
  let sx = 0, sy = 0, n = 0;
  const eatSeed = (p) => { sx += p[0]; sy += p[1]; n++; };
  for (const b of findel.buildings) {
    if (b.kind === 'terminal' || b.kind === 'hangar') for (const p of b.pts) eatSeed(p);
  }
  if (findel.tower) eatSeed(findel.tower);
  const cx = n ? sx / n : 1550, cy = n ? sy / n : 300;

  // grow to include aprons whose centroid is within reach of the seed centre
  let minX = cx, maxX = cx, minY = cy, maxY = cy;
  const eat = (p) => { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
                       if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; };
  for (const b of findel.buildings) {
    if (b.kind === 'terminal' || b.kind === 'hangar') for (const p of b.pts) eat(p);
  }
  if (findel.tower) eat(findel.tower);
  const REACH = 520; // aprons within this of the seed centre belong to the core
  for (const a of findel.aprons) {
    let ax = 0, ay = 0; for (const p of a) { ax += p[0]; ay += p[1]; } ax /= a.length; ay /= a.length;
    if (Math.hypot(ax - cx, ay - cy) < REACH) for (const p of a) eat(p);
  }
  const PAD = 60;
  minX -= PAD; maxX += PAD; minY -= PAD; maxY += PAD;
  // hard cap the span so the fenced field stays a short-drive scale, centred on the seed
  const CAP = 620; // half-extent cap
  minX = Math.max(minX, cx - CAP); maxX = Math.min(maxX, cx + CAP);
  minY = Math.max(minY, cy - CAP); maxY = Math.min(maxY, cy + CAP);
  return {minX, maxX, minY, maxY, cx, cy};
}

const inBounds = (p, b) => p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY;
function ringInBounds(pts, b) {
  let cx = 0, cy = 0; for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;
  return cx >= b.minX && cx <= b.maxX && cy >= b.minY && cy <= b.maxY;
}

// ===========================================================================================
// Surfaces. Runway is one thick strip (~45m) built from the runway polyline offset by its half
// width. Taxiways merge into one thin ribbon geometry; aprons fill as triangulated polygons.
function addSurfaces(group, findel, core) {
  // --- runway: the primary asphalt strip. A wide grey shoulder underneath makes the strip read
  //     against the ground, with the darker running surface on top. ---------------------------
  const rw = findel.runways[0];
  const RUNWAY_HALF = 22.5; // ~45m running surface
  const shoulderGeoms = [], runGeoms = [];
  for (const line of findel.runways) {
    shoulderGeoms.push(ribbon(line, RUNWAY_HALF + 8, 0.03)); // paved shoulder / stopway margin
    runGeoms.push(ribbon(line, RUNWAY_HALF, 0.05));
  }
  const shoulder = new THREE.Mesh(mergeGeometries(shoulderGeoms),
    new THREE.MeshStandardMaterial({color: 0x6b6d72, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide}));
  shoulder.receiveShadow = true;
  group.add(shoulder);
  const runwayMat = new THREE.MeshStandardMaterial({color: COL.runway, roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide});
  const runway = new THREE.Mesh(mergeGeometries(runGeoms), runwayMat);
  runway.receiveShadow = true;
  group.add(runway);

  // --- aprons: filled polygons, concrete. Keep those near the core; drop distant stand slabs. -
  const apronGeoms = [];
  for (const poly of findel.aprons) {
    let ax = 0, ay = 0; for (const p of poly) { ax += p[0]; ay += p[1]; } ax /= poly.length; ay /= poly.length;
    if (Math.hypot(ax - core.cx, ay - core.cy) > 760) continue;
    const g = polygonFill(poly, 0.02);
    if (g) apronGeoms.push(g);
  }
  if (apronGeoms.length) {
    const apron = new THREE.Mesh(mergeGeometries(apronGeoms),
      new THREE.MeshStandardMaterial({color: COL.concrete, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide}));
    apron.receiveShadow = true;
    group.add(apron);
  }

  // --- taxiways: 109 polylines merged into one ribbon. Keep near-core segments (the rest are
  //     field taxiways feeding the far runway ends and just read as clutter). ------------------
  const taxiGeoms = [];
  for (const line of findel.taxiways) {
    if (line.length < 2) continue;
    let inside = false;
    for (const p of line) if (Math.hypot(p[0] - core.cx, p[1] - core.cy) < 820) { inside = true; break; }
    if (!inside) continue;
    taxiGeoms.push(ribbon(line, 11, 0.04)); // ~22m taxiways
  }
  if (taxiGeoms.length) {
    const taxi = new THREE.Mesh(mergeGeometries(taxiGeoms),
      new THREE.MeshStandardMaterial({color: COL.taxiway, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide}));
    taxi.receiveShadow = true;
    group.add(taxi);
  }

  // runway centre + direction (unit) for markings + airliner alignment
  const a = rw[0], b = rw[rw.length - 1];
  const dir = new THREE.Vector2(b[0] - a[0], b[1] - a[1]).normalize();
  const center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return {runwayCenter: center, runwayDir: dir, runwayHalf: RUNWAY_HALF};
}

// A flat ribbon along a polyline: two triangles per segment, offset by half width, at height y.
function ribbon(line, half, y) {
  const pos = [], idx = [];
  let v = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [x1, y1] = line[i], [x2, y2] = line[i + 1];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * half, ny = dx / len * half;
    pos.push(x1 + nx, y, -(y1 + ny), x1 - nx, y, -(y1 - ny),
             x2 + nx, y, -(y2 + ny), x2 - nx, y, -(y2 - ny));
    idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Triangulated fill of a closed polygon (map space), laid flat at height y.
function polygonFill(poly, y) {
  const pts = poly.slice();
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) return null;
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area2 += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  if (Math.abs(area2) < 8) return null;
  const flat = pts.map(p => new THREE.Vector2(p[0], p[1]));
  const tris = THREE.ShapeUtils.triangulateShape(flat, []);
  if (!tris.length) return null;
  const pos = [], norm = [], idx = [];
  for (let i = 0; i < pts.length; i++) { pos.push(pts[i][0], y, -pts[i][1]); norm.push(0, 1, 0); }
  for (const t of tris) idx.push(t[0], t[2], t[1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3)); // force UP: apron winding varies per polygon
  g.setIndex(idx);
  return g;
}

// ===========================================================================================
// Runway markings: dashed centreline down the strip, a threshold bar cluster at each end, and
// a big painted runway number ("06" / "24" — Findel's real designators) near each threshold.
function addRunwayMarkings(group, runways, center, dir, half) {
  const rw = runways[0];
  const a = rw[0], b = rw[rw.length - 1];
  const paint = new THREE.MeshBasicMaterial({color: COL.paint});
  const marks = [];
  const Y = 0.12; // float paint clearly above the asphalt so it never z-fights out

  // a rectangle centred at map (cx,cy), extents hx along dir (ax,ay), hz across
  const bar = (cx, cy, hx, hz, ax, ay) => {
    const nx = -ay, ny = ax;
    const g = new THREE.BufferGeometry();
    const pos = [
      cx + ax*hx + nx*hz, Y, -(cy + ay*hx + ny*hz),
      cx - ax*hx + nx*hz, Y, -(cy - ay*hx + ny*hz),
      cx + ax*hx - nx*hz, Y, -(cy + ay*hx - ny*hz),
      cx - ax*hx - nx*hz, Y, -(cy - ay*hx - ny*hz),
    ];
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    g.computeVertexNormals();
    marks.push(g);
  };

  const ax = dir.x, ay = dir.y;
  const total = Math.hypot(b[0] - a[0], b[1] - a[1]);
  // centreline dashes: 30m stroke, 20m gap, starting well inside the thresholds
  for (let d = 90; d < total - 90; d += 50) {
    const cx = a[0] + ax * d, cy = a[1] + ay * d;
    bar(cx + ax * 15, cy + ay * 15, 15, 0.9, ax, ay); // 30m long x 1.8m wide, bold enough to see
  }
  // runway edge lines: continuous bright stripes down both sides of the running surface
  for (const side of [1, -1]) {
    const off = (half - 1.2) * side;
    const ex = a[0] + (-ay) * off, ey = a[1] + (ax) * off;
    bar((a[0] + b[0]) / 2 + (-ay) * off, (a[1] + b[1]) / 2 + (ax) * off, total / 2 - 60, 0.6, ax, ay);
  }
  // threshold bars: a fan of longitudinal stripes across the width at each end (piano keys)
  const keys = (endX, endY, sign) => {
    for (let k = -5; k <= 5; k++) {
      if (k === 0) continue;
      const off = k * (half / 6);
      const bx = endX + (-ay) * off, by = endY + (ax) * off;
      const sx = bx + ax * sign * 22, sy = by + ay * sign * 22; // stripe centre 22m in from end
      bar(sx, sy, 11, 0.9, ax, ay);
    }
  };
  keys(a[0], a[1], 1);
  keys(b[0], b[1], -1);
  // threshold line across the full width at each end
  bar(a[0] + ax * 6, a[1] + ay * 6, 0.9, half - 1.5, ax, ay);
  bar(b[0] - ax * 6, b[1] - ay * 6, 0.9, half - 1.5, ax, ay);

  const markMesh = new THREE.Mesh(mergeGeometries(marks), paint);
  markMesh.renderOrder = 2;
  group.add(markMesh);

  // Runway numbers as extruded painted glyphs, one near each threshold, facing down the runway.
  const heading = Math.atan2(ay, ax); // world-space heading of the runway direction
  addRunwayNumber(group, a[0] + ax * 60, a[1] + ay * 60, heading, '06', paint);
  addRunwayNumber(group, b[0] - ax * 60, b[1] - ay * 60, heading + Math.PI, '24', paint);
}

// Painted two-digit number, drawn as filled 7-seg-ish blocky glyphs on the deck.
function addRunwayNumber(group, mx, my, heading, text, mat) {
  const g = new THREE.Group();
  const H = 20, W = 12, T = 2.2, GAP = 4; // glyph metrics in metres
  const geoms = [];
  const rect = (cx, cy, hw, hh) => {
    const geo = new THREE.PlaneGeometry(hw * 2, hh * 2);
    geo.rotateX(-Math.PI / 2);
    geo.translate(cx, 0, cy);
    geoms.push(geo);
  };
  // digit strokes in a local frame: x across (width), y down the runway (height)
  const digit = (ox, ch) => {
    const segs = SEG7[ch];
    // 7-seg layout: top, tl, tr, mid, bl, br, bot
    const w = W, h = H, t = T;
    const cxL = ox - w / 2 + t / 2, cxR = ox + w / 2 - t / 2, cxM = ox;
    const yT = h / 2 - t / 2, yM = 0, yB = -h / 2 + t / 2;
    const yTM = h / 4, yBM = -h / 4;
    const seg = {
      top: [cxM, yT, w / 2 - t, t / 2],
      mid: [cxM, yM, w / 2 - t, t / 2],
      bot: [cxM, yB, w / 2 - t, t / 2],
      tl:  [cxL, yTM, t / 2, h / 4 - t / 2],
      tr:  [cxR, yTM, t / 2, h / 4 - t / 2],
      bl:  [cxL, yBM, t / 2, h / 4 - t / 2],
      br:  [cxR, yBM, t / 2, h / 4 - t / 2],
    };
    for (const s of segs) { const [cx, cy, hw, hh] = seg[s]; rect(cx, cy, hw, hh); }
  };
  digit(-(W / 2 + GAP / 2), text[0]);
  digit(+(W / 2 + GAP / 2), text[1]);
  const mesh = new THREE.Mesh(mergeGeometries(geoms), mat);
  mesh.position.set(mx, 0.06, -my);
  mesh.rotation.y = heading - Math.PI / 2; // local +y (down-runway) aligns with heading
  mesh.renderOrder = 2;
  group.add(mesh);
}
const SEG7 = {
  '0': ['top', 'tl', 'tr', 'bl', 'br', 'bot'],
  '2': ['top', 'tr', 'mid', 'bl', 'bot'],
  '4': ['tl', 'tr', 'mid', 'br'],
  '6': ['top', 'tl', 'mid', 'bl', 'br', 'bot'],
};

// ===========================================================================================
// Buildings: extrude every footprint. Terminal gets a glazed upper facade; hangars get big
// curved/gabled roofs; generic sheds are plain boxes. All heights re-assigned by kind (the OSM
// data flattened everything to 8m, which reads as nothing distinctive).
function addBuildings(group, findel, core) {
  const wallGeoms = [], roofGeoms = [], glassGeoms = [], hangarRoofGeoms = [];
  for (const b of findel.buildings) {
    const kind = b.kind || 'building';
    // terminals + hangars are the airport; keep them wherever they sit. Generic OSM footprints
    // are only kept inside the core so the field is a place, not a scatter across the fields.
    if (kind === 'building' && !ringInBounds(b.pts, core)) continue;
    const pts = closeRing(b.pts);
    if (pts.length < 4) continue;
    let area2 = 0;
    for (let i = 0; i < pts.length - 1; i++) area2 += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
    if (Math.abs(area2) < 20) continue;

    if (kind === 'hangar') {
      addHangar(pts, wallGeoms, hangarRoofGeoms);
    } else if (kind === 'terminal') {
      addTerminal(pts, wallGeoms, glassGeoms, roofGeoms);
    } else {
      // generic airport shed: low box, flat roof
      const h = 6 + pseudo(pts[0][0] * 0.11 + pts[0][1] * 0.19) * 5;
      extrude(pts, 0, h, wallGeoms);
      const rf = polygonFill(b.pts, h + 0.02); if (rf) roofGeoms.push(rf);
    }
  }
  const add = (geoms, mat) => {
    if (!geoms.length) return;
    const m = new THREE.Mesh(mergeGeometries(geoms), mat);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
  };
  // DoubleSide throughout so no airport building is HOLLOW — the runway is drivable, so the camera
  // can get right up against (or inside) a terminal or hangar; single-sided walls would cull to
  // see-through from there, and any reversed-wound footprint would lose its outward walls entirely.
  add(wallGeoms, new THREE.MeshLambertMaterial({color: COL.building, side: THREE.DoubleSide}));
  add(roofGeoms, new THREE.MeshLambertMaterial({color: COL.hangarRoof, side: THREE.DoubleSide}));
  add(glassGeoms, new THREE.MeshStandardMaterial({color: COL.glass, roughness: 0.25, metalness: 0.1, side: THREE.DoubleSide}));
  add(hangarRoofGeoms, new THREE.MeshLambertMaterial({color: COL.hangar, side: THREE.DoubleSide}));
}

function closeRing(pts) {
  const r = pts.slice();
  const a = r[0], b = r[r.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) r.push([a[0], a[1]]);
  return r;
}

// Extrude closed ring walls from y0 to y1 into geoms[].
function extrude(ring, y0, y1, geoms) {
  const pos = [], idx = [];
  let v = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1m] = ring[i], [x2, y2m] = ring[i + 1];
    pos.push(x1, y0, -y1m, x2, y0, -y2m, x1, y1, -y1m, x2, y1, -y2m);
    idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  geoms.push(g);
}

// Terminal: solid plinth (0..4m) + glazed curtain wall (4..16m) + a thin roof cap. The glass
// band is a second wall ring nudged out so it reads as a facade layer, and a flat roof closes it.
function addTerminal(ring, wallGeoms, glassGeoms, roofGeoms) {
  const H = 13;
  extrude(ring, 0, 3.2, wallGeoms);        // stone plinth
  extrude(ring, 3.2, H, glassGeoms);       // glazed body
  // roof cap
  const rg = fillRing(ring, H + 0.02); if (rg) roofGeoms.push(rg);
  // a slim parapet band at the top edge for a finished skyline
  extrude(ring, H, H + 1.0, wallGeoms);
}

// Hangar: tall walls + a curved barrel roof spanning the footprint's short axis.
function addHangar(ring, wallGeoms, roofGeoms) {
  const H = 14;
  extrude(ring, 0, H, wallGeoms);
  // Fit an oriented box to the footprint and cap it with a curved roof arc.
  const box = obb(ring);
  addBarrelRoof(box, H, roofGeoms);
}

// Oriented bounding box of a ring: centroid, principal axis via covariance, extents.
function obb(ring) {
  let cx = 0, cy = 0, n = 0;
  for (let i = 0; i < ring.length - 1; i++) { cx += ring[i][0]; cy += ring[i][1]; n++; }
  cx /= n; cy /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const dx = ring[i][0] - cx, dy = ring[i][1] - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(theta), uy = Math.sin(theta);
  const vx = -uy, vy = ux;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const dx = ring[i][0] - cx, dy = ring[i][1] - cy;
    const pu = dx * ux + dy * uy, pv = dx * vx + dy * vy;
    if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
    if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
  }
  return {cx, cy, ux, uy, vx, vy, minU, maxU, minV, maxV,
          lenU: maxU - minU, lenV: maxV - minV,
          midU: (minU + maxU) / 2, midV: (minV + maxV) / 2};
}

// A curved (barrel) roof over an OBB: arch spans the SHORT axis, ridge runs the LONG axis.
function addBarrelRoof(box, wallTop, geoms) {
  // long axis = the larger extent; the arch bows across the short axis
  let longU = box.lenU >= box.lenV;
  const halfLong = (longU ? box.lenU : box.lenV) / 2;
  const halfShort = (longU ? box.lenV : box.lenU) / 2;
  const aX = longU ? box.ux : box.vx, aY = longU ? box.uy : box.vy;   // long axis dir
  const sX = longU ? box.vx : box.ux, sY = longU ? box.vy : box.uy;   // short axis dir
  const ctrX = box.cx + box.ux * box.midU + box.vx * box.midV;
  const ctrY = box.cy + box.uy * box.midU + box.vy * box.midV;
  const rise = Math.min(halfShort * 0.55, 7);
  const SEG = 8;
  const pos = [], idx = [];
  let v = 0;
  const worldPt = (along, across, up) => {
    const mx = ctrX + aX * along + sX * across;
    const my = ctrY + aY * along + sY * across;
    return [mx, up, -my];
  };
  // build a strip of the arch, extruded along the long axis (two rings: -halfLong, +halfLong)
  for (let i = 0; i < SEG; i++) {
    const t0 = i / SEG, t1 = (i + 1) / SEG;
    const cr0 = (t0 * 2 - 1) * halfShort, cr1 = (t1 * 2 - 1) * halfShort;
    const up0 = wallTop + rise * Math.cos(t0 * Math.PI - Math.PI / 2) * 0 + rise * Math.sin(Math.PI * t0);
    const up1 = wallTop + rise * Math.sin(Math.PI * t1);
    const A = worldPt(-halfLong, cr0, up0);
    const B = worldPt(+halfLong, cr0, up0);
    const C = worldPt(-halfLong, cr1, up1);
    const D = worldPt(+halfLong, cr1, up1);
    pos.push(...A, ...B, ...C, ...D);
    idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  geoms.push(g);
}

// Fill a closed ring at height y (roof cap) — ring is [ [x,y], ..., first ] (closed).
function fillRing(ring, y) {
  const pts = ring.slice();
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) return null;
  const flat = pts.map(p => new THREE.Vector2(p[0], p[1]));
  const tris = THREE.ShapeUtils.triangulateShape(flat, []);
  if (!tris.length) return null;
  const pos = [], norm = [], idx = [];
  for (let i = 0; i < pts.length; i++) { pos.push(pts[i][0], y, -pts[i][1]); norm.push(0, 1, 0); }
  for (const t of tris) idx.push(t[0], t[2], t[1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3)); // force UP (ring winding varies)
  g.setIndex(idx);
  return g;
}

// ===========================================================================================
// Control tower: a slender shaft topped by a cantilevered glazed cab and a thin roof mast.
// The tallest, most distinctive silhouette on the field — the thing you steer toward.
function addControlTower(group, tower) {
  if (!tower) return null;
  const [mx, my] = tower;
  const g = new THREE.Group();
  const SHAFT_H = 34, CAB_H = 6;

  const shaftMat = new THREE.MeshStandardMaterial({color: COL.towerShaft, roughness: 0.6, metalness: 0.05});
  const cabMat   = new THREE.MeshStandardMaterial({color: COL.towerCab, roughness: 0.2, metalness: 0.1});
  const trimMat  = new THREE.MeshLambertMaterial({color: 0x3a3f47});

  // tapered shaft
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.4, SHAFT_H, 12), shaftMat);
  shaft.position.y = SHAFT_H / 2;
  shaft.castShadow = true;
  g.add(shaft);

  // cantilevered cab: a wider frustum flaring out, glazed
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 2.6, 2.4, 12), trimMat);
  collar.position.y = SHAFT_H + 0.4;
  g.add(collar);
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.4, CAB_H, 12), cabMat);
  cab.position.y = SHAFT_H + 2.6 + CAB_H / 2;
  cab.castShadow = true;
  g.add(cab);
  // bright glazing band around the cab so it plainly reads as a glassed-in control room
  const glassBand = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, CAB_H * 0.62, 12, 1, true),
    new THREE.MeshStandardMaterial({color: 0x8fb7cf, roughness: 0.15, metalness: 0.1, side: THREE.DoubleSide,
      emissive: 0x24506a, emissiveIntensity: 0.35}));
  glassBand.position.y = SHAFT_H + 2.6 + CAB_H * 0.55;
  g.add(glassBand);
  // sloped roof cap over the cab
  const cap = new THREE.Mesh(new THREE.ConeGeometry(6.0, 2.4, 12), trimMat);
  cap.position.y = SHAFT_H + 2.6 + CAB_H + 1.2;
  g.add(cap);
  // mast + beacon
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 5, 6), trimMat);
  mast.position.y = SHAFT_H + 2.6 + CAB_H + 2.4 + 2.5;
  g.add(mast);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6),
    new THREE.MeshBasicMaterial({color: 0xff5a3c}));
  beacon.position.y = SHAFT_H + 2.6 + CAB_H + 2.4 + 5.2;
  g.add(beacon);

  g.position.set(mx, 0, -my);
  group.add(g);
  return g;
}

// ===========================================================================================
// Perimeter fence with an OPEN GATE on the city-facing (west / min-x) side. The fence is a chain
// of instanced posts + a thin rail ribbon following the grounds rectangle, with a gap left on the
// west edge where two gate leaves stand swung open so the access road can pass onto the apron.
function addPerimeterFence(group, findel, core) {
  const b = core;
  const H = 3.2;                 // fence height
  const POST_STEP = 8;           // metres between posts

  // Gate opening: centred on the west edge, at the midpoint of the north-south run, sized for a road.
  const gateCenterY = (b.minY + b.maxY) / 2;
  const GATE_HALF = 9;           // 18m opening
  const gateX = b.minX;

  // Walk the rectangle as segments, skipping the gate gap on the west edge.
  const corners = [
    [b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY],
  ];
  const railGeoms = [];
  const postPts = [];
  const addRun = (ax, ay, bx, by) => {
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.5) return;
    // rail ribbon (thin vertical strip) as two stacked quads
    railGeoms.push(fenceRail(ax, ay, bx, by, H));
    const n = Math.max(1, Math.round(len / POST_STEP));
    for (let i = 0; i <= n; i++) postPts.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n]);
  };
  // sides in order; the west edge (last, from [minX,maxY] back to [minX,minY]) is split by the gate
  addRun(corners[0][0], corners[0][1], corners[1][0], corners[1][1]); // south (minY)
  addRun(corners[1][0], corners[1][1], corners[2][0], corners[2][1]); // east (maxX)
  addRun(corners[2][0], corners[2][1], corners[3][0], corners[3][1]); // north (maxY)
  // west edge, split around the gate gap
  addRun(corners[3][0], corners[3][1], gateX, gateCenterY + GATE_HALF); // north part
  addRun(gateX, gateCenterY - GATE_HALF, corners[0][0], corners[0][1]); // south part

  // rails merged
  const rail = new THREE.Mesh(mergeGeometries(railGeoms),
    new THREE.MeshLambertMaterial({color: COL.fence, side: THREE.DoubleSide, transparent: true, opacity: 0.55}));
  group.add(rail);

  // instanced posts
  const postG = new THREE.CylinderGeometry(0.12, 0.12, H, 5); postG.translate(0, H / 2, 0);
  const posts = new THREE.InstancedMesh(postG, new THREE.MeshLambertMaterial({color: 0x2d3138}), postPts.length + 4);
  const m = new THREE.Matrix4();
  postPts.forEach((p, i) => { m.makeTranslation(p[0], 0, -p[1]); posts.setMatrixAt(i, m); });
  posts.castShadow = true;
  group.add(posts);

  // Two gate leaves, hinged at the opening edges and swung open (rotated back along the fence),
  // so the gap plainly reads as a gate rather than a break. Each leaf is a framed panel.
  const leafMat = new THREE.MeshLambertMaterial({color: 0x545b64, side: THREE.DoubleSide});
  const LEAF_LEN = GATE_HALF - 0.5;
  const makeLeaf = (hingeY, swingIn) => {
    const leaf = new THREE.Group();
    // panel lies along +x by default (LEAF_LEN long), then we rotate it open around the hinge (world -z/+ into grounds)
    const panel = new THREE.Mesh(new THREE.BoxGeometry(LEAF_LEN, H, 0.16), leafMat);
    panel.position.set(LEAF_LEN / 2, H / 2, 0);
    leaf.add(panel);
    // a couple of cross bars for a gate look
    for (const yy of [H * 0.3, H * 0.7]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(LEAF_LEN, 0.12, 0.2), new THREE.MeshLambertMaterial({color: 0x30343b}));
      bar.position.set(LEAF_LEN / 2, yy, 0);
      leaf.add(bar);
    }
    // hinge post at the opening edge
    leaf.position.set(gateX, 0, -hingeY);
    // swing open ~110°: leaves fold back toward the fence, opening the mouth to the east (into grounds)
    leaf.rotation.y = swingIn; // radians
    return leaf;
  };
  // North leaf hinged at (gateX, gateCenterY+GATE_HALF), swung open pointing north-ish along fence into grounds
  group.add(makeLeaf(gateCenterY + GATE_HALF, -Math.PI * 0.62));
  group.add(makeLeaf(gateCenterY - GATE_HALF, Math.PI * 0.62 + Math.PI));

  // A little paved approach slab through the gate + a guard shack beside it, so the entrance
  // plainly reads as a controlled way in rather than a gap in a fence into empty grass. (Master's
  // access road meets this from the west; the slab just makes the mouth look built either way.)
  const apronPad = new THREE.Mesh(new THREE.PlaneGeometry(2 * GATE_HALF + 6, 46),
    new THREE.MeshStandardMaterial({color: COL.taxiway, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide}));
  apronPad.rotation.x = -Math.PI / 2;
  apronPad.rotation.z = Math.PI / 2;                    // long axis runs east-west (through the gate)
  apronPad.position.set(gateX + 20, 0.03, -gateCenterY);
  apronPad.receiveShadow = true;
  group.add(apronPad);
  // guard shack: a small box just inside, to the north of the opening
  const shack = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 5),
    new THREE.MeshLambertMaterial({color: 0xcabf9e}));
  shack.position.set(gateX + 3, 1.5, -(gateCenterY + GATE_HALF + 4));
  shack.castShadow = true;
  group.add(shack);
  const shackRoof = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.4, 5.6),
    new THREE.MeshLambertMaterial({color: 0x8a3b32}));
  shackRoof.position.set(gateX + 3, 3.2, -(gateCenterY + GATE_HALF + 4));
  group.add(shackRoof);

  // Gate world position + heading. The road approaches from the west (city) heading EAST into the
  // grounds. World: x = gateX, z = -gateCenterY. Heading points into the grounds = +x (toward higher x).
  const gate = {x: gateX, z: -gateCenterY, heading: 0}; // heading 0 = facing +x (east, into the airport)
  return gate;
}

// A fence rail as a thin double-quad ribbon between two map points, rising to height H.
function fenceRail(ax, ay, bx, by, H) {
  const pos = [], idx = [];
  // two horizontal rails at 0.4H and 0.85H, drawn as thin strips
  const rails = [0.42, 0.86];
  let v = 0;
  for (const r of rails) {
    const y0 = H * (r - 0.03), y1 = H * (r + 0.03);
    pos.push(ax, y0, -ay, bx, y0, -by, ax, y1, -ay, bx, y1, -by);
    idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ===========================================================================================
// Parked airliner (~37m narrowbody): fuselage tube + nose + tapered tail, swept wings, tail fin
// and horizontal stabilisers, two under-wing engines, a window row, red livery cheatline + tail.
// Placed on the apron, close to a terminal, aligned along the runway so driving out reveals it.
function addAirliner(group, findel, core) {
  const plane = new THREE.Group();

  const white = new THREE.MeshStandardMaterial({color: COL.planeBody, roughness: 0.4, metalness: 0.05});
  const wingMat = new THREE.MeshStandardMaterial({color: COL.planeWing, roughness: 0.45, metalness: 0.05});
  const livery = new THREE.MeshStandardMaterial({color: COL.planeLivery, roughness: 0.4, metalness: 0.05});
  const engineMat = new THREE.MeshStandardMaterial({color: COL.planeEngine, roughness: 0.5, metalness: 0.1});
  const glass = new THREE.MeshStandardMaterial({color: 0x1a2733, roughness: 0.2, metalness: 0.1});

  const L = 37, R = 1.9; // fuselage length, radius. Built along local +x (nose at +x).

  // fuselage: a capsule made of a tube + nose cone + tapered tail cone
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(R, R, L * 0.62, 20), white);
  tube.rotation.z = Math.PI / 2;
  tube.position.set(0, R + 2.6, 0); // sit on gear height
  plane.add(tube);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(R, 18, 12), white);
  nose.scale.set(2.3, 1, 1);   // elongated so the nose reads as a jet, not a rounded drone
  nose.position.set(L * 0.31 + R * 0.9, R + 2.6, 0);
  plane.add(nose);
  // tapered tail: a stubby cone continuing the tube (not a long nozzle), lifted for the tailcone upsweep.
  // +Z rotation, not -Z: a cone's apex starts at +y, so -90° about z aimed the point FORWARD at the
  // nose and left a blunt face at the back. +90° sends the apex aft, where the taper belongs.
  const tailCone = new THREE.Mesh(new THREE.ConeGeometry(R, L * 0.24, 18), white);
  tailCone.rotation.z = Math.PI / 2;
  tailCone.position.set(-L * 0.31 - L * 0.12 * 0.5, R + 2.6 + 0.55, 0); // slight upsweep
  plane.add(tailCone);

  // cheatline: a thin red band along the window line
  const cheat = new THREE.Mesh(new THREE.BoxGeometry(L * 0.62, 0.5, R * 2.02), livery);
  cheat.position.set(0, R + 2.6 + 0.5, 0);
  cheat.scale.set(1, 1, 0.5);
  // keep it flush by making it a thin ring-ish band: use a slightly larger cylinder sleeve instead
  // (box would poke; a shallow cylinder sleeve reads cleaner)
  plane.remove(cheat);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.02, R + 0.02, 0.6, 20, 1, true), livery);
  band.rotation.z = Math.PI / 2;
  band.position.set(0, R + 2.6 + 0.55, 0);
  plane.add(band);

  // window row: a thin dark strip of small windows along the upper fuselage
  const winStrip = new THREE.Mesh(new THREE.BoxGeometry(L * 0.55, 0.5, 0.08), glass);
  winStrip.position.set(0, R + 2.6 + 1.05, R - 0.05);
  plane.add(winStrip);
  const winStrip2 = winStrip.clone(); winStrip2.position.z = -(R - 0.05); plane.add(winStrip2);
  // cockpit windows
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, R * 1.6), glass);
  cockpit.position.set(L * 0.31 + R * 0.3, R + 2.6 + 0.9, 0);
  plane.add(cockpit);

  // wings: swept AND tapered, built from an explicit trapezoid so the planform reads as an
  // airliner wing (broad root, narrow raked tip) rather than a plain slab. Local frame: the wing
  // extends outboard along +z*side; root at the fuselage, tip swept back (-x) and thinned.
  const SPAN = 19, ROOT_CH = 8.5, TIP_CH = 3.0, SWEEP = 6.5;
  const wing = (side) => {
    const rootZ = side * (R + 0.2), tipZ = side * (R + SPAN);
    const yTop = R + 2.0, yBot = R + 1.55;
    // four planform corners (root LE, root TE, tip LE, tip TE), duplicated top/bottom for thickness
    const rLEx = 3.2, rTEx = 3.2 - ROOT_CH;               // root leading/trailing edge x
    const tLEx = 3.2 - SWEEP, tTEx = 3.2 - SWEEP - TIP_CH; // tip swept back
    const C = [
      [rLEx, yTop, rootZ], [rTEx, yTop, rootZ], [tLEx, yTop, tipZ], [tTEx, yTop, tipZ], // top
      [rLEx, yBot, rootZ], [rTEx, yBot, rootZ], [tLEx, yBot, tipZ], [tTEx, yBot, tipZ], // bottom
    ];
    const pos = [], idx = [];
    for (const p of C) pos.push(...p);
    // top(0-3), bottom(4-7). faces: top, bottom, LE, TE, tip
    const quad = (a, b, c, d) => { idx.push(a, b, c, a, c, d); };
    quad(0, 1, 3, 2);          // top
    quad(4, 6, 7, 5);          // bottom
    quad(0, 2, 6, 4);          // leading edge
    quad(1, 5, 7, 3);          // trailing edge
    quad(2, 3, 7, 6);          // tip
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const w = new THREE.Mesh(g, wingMat);
    w.castShadow = true;
    plane.add(w);

    // engine: a modestly-sized nacelle on a short pylon UNDER the wing, hung with ground clearance
    // (turbofan proportions, not a scraping barrel). Slightly forward of the leading edge.
    const ez = side * (R + 7.2);
    const engY = R + 0.9;                    // sits below wing but well clear of the pad
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 0.4), engineMat);
    pylon.position.set(0.4, engY + 0.7, ez);
    plane.add(pylon);
    const eng = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 0.95, 3.8, 16), engineMat);
    eng.rotation.z = Math.PI / 2;
    eng.position.set(1.4, engY, ez);
    plane.add(eng);
    // dark intake lip at the front (nose end = +x)
    const lip = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.4, 16), new THREE.MeshLambertMaterial({color: 0x14171a}));
    lip.rotation.z = Math.PI / 2; lip.position.set(1.4 + 2.0, engY, ez);
    plane.add(lip);
    // fan face hint inside the intake
    const fan = new THREE.Mesh(new THREE.CircleGeometry(0.85, 14), new THREE.MeshLambertMaterial({color: 0x30343a}));
    fan.rotation.y = Math.PI / 2; fan.position.set(1.4 + 1.95, engY, ez);
    plane.add(fan);
  };
  wing(1); wing(-1);

  // tail fin (vertical stabiliser) — a clearly swept trapezoid rising from the tail, red livery.
  // Local x = fuselage axis (nose +x); the fin's leading edge rakes back (-x) as it climbs.
  {
    const baseX = -L * 0.34, baseY = R + 2.6 + 0.4;
    const H = 7.5, ROOT = 6.5, TIP = 2.6, RAKE = 4.2, TH = 0.35;
    // corners: root LE, root TE, tip LE, tip TE (x,y), extruded ±TH in z
    const c2 = [
      [baseX, baseY], [baseX - ROOT, baseY],                       // root LE, TE
      [baseX - RAKE, baseY + H], [baseX - RAKE - TIP, baseY + H],  // tip LE, TE (raked back)
    ];
    const pos = [], idx = [];
    for (const [x, y] of c2) pos.push(x, y, TH);   // 0-3 near side
    for (const [x, y] of c2) pos.push(x, y, -TH);  // 4-7 far side
    const quad = (a, b, c, d) => idx.push(a, b, c, a, c, d);
    quad(0, 1, 3, 2); quad(4, 6, 7, 5);            // two faces
    quad(0, 2, 6, 4); quad(1, 5, 7, 3); quad(2, 3, 7, 6); // LE, TE, tip
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const fin = new THREE.Mesh(g, livery);
    fin.castShadow = true;
    plane.add(fin);
  }
  // horizontal stabilisers — small swept fins each side of the tail, slightly raked
  const hs = (side) => {
    const s = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.3, 5.0), wingMat);
    s.position.set(-L * 0.4, R + 2.6 + 0.9, side * 3.0);
    s.rotation.y = side * 0.32;
    s.castShadow = true;
    plane.add(s);
  };
  hs(1); hs(-1);

  // landing gear: a nose strut + two main struts with simple wheels, so it stands on the apron
  const strut = (px, pz) => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 2.6, 6), engineMat);
    leg.position.set(px, 1.3, pz);
    plane.add(leg);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.5, 12), new THREE.MeshLambertMaterial({color: 0x15171a}));
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(px, 0.6, pz);
    plane.add(wheel);
  };
  strut(L * 0.26, 0);
  strut(-2, R + 0.6); strut(-2, -(R + 0.6));

  for (const c of plane.children) { c.castShadow = true; }

  // --- placement: on the apron, near a terminal, aligned along the runway --------------------
  // Pick the terminal centroid, then step onto the nearest apron toward the runway a little.
  const term = findel.buildings.find(b => b.kind === 'terminal') || findel.buildings[0];
  let tcx = 0, tcy = 0; for (const p of term.pts) { tcx += p[0]; tcy += p[1]; } tcx /= term.pts.length; tcy /= term.pts.length;
  // aim the plane parallel to the runway
  const rw = findel.runways[0];
  const a = rw[0], b = rw[rw.length - 1];
  const heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
  // stand it a bit south-west of the terminal, out on the apron, clear of the building
  const px = tcx - 40, py = tcy - 60;

  // A broad concrete stand apron under the plane so it plainly stands on pavement, not grass, and
  // reaches back toward the terminal so there is no grass gap between building and aircraft.
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(95, 60),
    new THREE.MeshStandardMaterial({color: COL.concrete, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide}));
  pad.rotation.x = -Math.PI / 2;
  pad.rotation.z = heading;             // align long side with the fuselage
  // nudge the pad toward the terminal (north-east) so it visually bridges to the building
  pad.position.set(px + 8, 0.03, -(py + 12));
  pad.receiveShadow = true;
  group.add(pad);
  // Stand lead-in line: parented to the plane so it is guaranteed to run down the fuselage
  // centreline (local +x = nose) and stop at the nose gear, guiding straight in — no misalignment.
  const leadIn = new THREE.Mesh(new THREE.PlaneGeometry(34, 0.5),
    new THREE.MeshBasicMaterial({color: COL.taxiLine}));
  leadIn.rotation.x = -Math.PI / 2;         // lie flat
  leadIn.position.set(L * 0.26 - 17 + 3, 0.09, 0); // from nose gear (x=L*0.26) running aft along centreline
  plane.add(leadIn);

  plane.position.set(px, 0, -py);
  // world heading: local +x is the nose. Rotate so nose points along runway heading in world.
  // world.z = -y, so a map-heading theta maps to a rotation about world-y of -theta.
  plane.rotation.y = -heading;
  group.add(plane);

  return {x: px, z: -py};
}
