// City dressing — the European-street layer. Everything here is instanced and placed from
// REAL positions (OSM cafes, post boxes, monuments, steps); only the road-works sites are
// invented, and those deterministically. Nothing simulates: props, not actors.
import * as THREE from 'three';
import {groundHeight} from '../world/terrain.js';
import {shoveClear} from './clearance.js';

// Every prop is placed at a map point (x, mapY); its world Y is the TERRAIN height there plus its
// own local offset y. gy(p) is the ground under a map point, so `makeTranslation(p[0], gy(p)+off, -p[1])`
// seats anything on the hills. Before terrain loads groundHeight returns 0 and this is the old flat world.
const gy = (p) => groundHeight(p[0], -p[1]);
const V = (p, y = 0) => new THREE.Vector3(p[0], gy(p) + y, -p[1]);
const hashAngle = (i) => (Math.sin(i * 78.233) * 43758.5453 % 1 + 1) % 1 * Math.PI * 2;

export function buildDecorations(world) {
  const group = new THREE.Group();

  // --- cafe verandas: parasol + table at every cafe, colour hashed per cafe ----------------
  if (world.cafes?.length) {
    const n = world.cafes.length;
    const poleG = new THREE.CylinderGeometry(0.04, 0.04, 2.1, 6); poleG.translate(0, 1.05, 0);
    const canopyG = new THREE.ConeGeometry(1.25, 0.55, 8); canopyG.translate(0, 2.25, 0);
    const tableG = new THREE.CylinderGeometry(0.45, 0.45, 0.06, 10); tableG.translate(0, 0.72, 0);
    const tlegG = new THREE.CylinderGeometry(0.04, 0.04, 0.72, 6); tlegG.translate(0, 0.36, 0);
    const PALETTE = [0xa63d2f, 0x2f6b4f, 0xb8893a, 0x51586b];
    const poles = new THREE.InstancedMesh(poleG, new THREE.MeshLambertMaterial({color: 0x6a6f78}), n);
    const canopies = new THREE.InstancedMesh(canopyG, new THREE.MeshLambertMaterial({color: 0xffffff}), n);
    const tables = new THREE.InstancedMesh(tableG, new THREE.MeshLambertMaterial({color: 0xd8d3c8}), n);
    const tlegs = new THREE.InstancedMesh(tlegG, new THREE.MeshLambertMaterial({color: 0x4a4e57}), n);
    const m = new THREE.Matrix4(), c = new THREE.Color();
    // A cafe node sits on the building it belongs to, and our carriageways are wider than the real
    // streets, so a fair number of terraces end up pitched in a traffic lane. Shove the terrace to
    // the kerb rather than dropping it — a cafe with no parasol is a missing cafe.
    let terraces = 0;
    world.cafes.forEach((p, i) => {
      const jx = (Math.sin(i * 12.9898) * 43758.5453 % 1 + 1) % 1 * 1.6 - 0.8;
      const clear = shoveClear(world, p[0] + jx, p[1], 0.4) ?? [p[0] + jx, p[1]];
      if (clear[0] !== p[0] + jx || clear[1] !== p[1]) terraces++;
      const pos = V(clear);
      m.makeTranslation(pos.x, pos.y, pos.z);
      poles.setMatrixAt(i, m); canopies.setMatrixAt(i, m);
      // the table sits beside its parasol, and must not be the thing left in the road
      const tb = shoveClear(world, clear[0] + 1.1, clear[1] - 0.4, 0.4) ?? [clear[0] + 1.1, clear[1] - 0.4];
      const t2 = m.clone().setPosition(tb[0], gy(tb), -tb[1]);
      tables.setMatrixAt(i, t2); tlegs.setMatrixAt(i, t2);
      c.set(PALETTE[i % PALETTE.length]);
      canopies.setColorAt(i, c);
    });
    console.info(`cafe terraces: ${terraces} of ${n} moved out of a carriageway`);
    canopies.instanceColor && (canopies.instanceColor.needsUpdate = true);
    for (const x of [poles, canopies, tables, tlegs]) { x.castShadow = true; group.add(x); }
  }

  // --- neon bar/cafe signs: emissive quads that catch the bloom pass at night --------------
  // Placed at every cafe/bar node, tucked against a facade height, colour + word-shape hashed.
  // They are lit ALWAYS (emissive), but only read as neon once night falls and bloom ramps —
  // by day they are dim coloured boards, which is exactly how a real neon sign looks unlit.
  if (world.cafes?.length) {
    const NEON = [0xff2e6e, 0x2ee6ff, 0xffd42e, 0x9b5cff, 0x39ff88, 0xff6a2e];
    const n = world.cafes.length;
    const signG = new THREE.PlaneGeometry(1.7, 0.5);
    const mat = new THREE.MeshBasicMaterial({toneMapped: false, transparent: true});
    // per-instance colour needs a material that supports instanceColor: use MeshBasic + vertexColors
    const signs = new THREE.InstancedMesh(signG, new THREE.MeshBasicMaterial({toneMapped: false, transparent: true}), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1,1,1), c = new THREE.Color();
    const e = new THREE.Euler();
    world.cafes.forEach((p, i) => {
      const face = hashAngle(i);
      e.set(0, face, 0); q.setFromEuler(e);
      const px = p[0] + Math.sin(face) * 0.3, pz = -p[1] + Math.cos(face) * 0.3;
      m.compose(new THREE.Vector3(px, groundHeight(px, pz) + 3.2 + (i % 3) * 0.9, pz), q, s);
      signs.setMatrixAt(i, m);
      c.set(NEON[i % NEON.length]); signs.setColorAt(i, c);
    });
    signs.instanceColor.needsUpdate = true;
    group.add(signs);
    // faint glow backing so the sign washes the wall behind it
    const glowG = new THREE.PlaneGeometry(2.3, 1.0);
    const glows = new THREE.InstancedMesh(glowG, new THREE.MeshBasicMaterial({
      toneMapped: false, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false}), n);
    world.cafes.forEach((p, i) => {
      const face = hashAngle(i);
      e.set(0, face, 0); q.setFromEuler(e);
      const px = p[0] + Math.sin(face) * 0.25, pz = -p[1] + Math.cos(face) * 0.25;
      m.compose(new THREE.Vector3(px, groundHeight(px, pz) + 3.2 + (i % 3) * 0.9, pz), q, s);
      glows.setMatrixAt(i, m);
      c.set(NEON[i % NEON.length]); glows.setColorAt(i, c);
    });
    glows.instanceColor.needsUpdate = true;
    group.add(glows);
    group.userData.neon = {signs, glows};
  }

  // --- post boxes: Luxembourg post is YELLOW ----------------------------------------------
  if (world.postboxes?.length) {
    const g = new THREE.BoxGeometry(0.42, 0.62, 0.30); g.translate(0, 0.75, 0);
    const legG = new THREE.CylinderGeometry(0.05, 0.05, 0.45, 6); legG.translate(0, 0.22, 0);
    const box = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({color: 0xf5c518}), world.postboxes.length);
    const leg = new THREE.InstancedMesh(legG, new THREE.MeshLambertMaterial({color: 0x3a3d44}), world.postboxes.length);
    const m = new THREE.Matrix4();
    world.postboxes.forEach((p0, i) => {
      const p = shoveClear(world, p0[0], p0[1], 0.4) ?? p0;
      m.makeTranslation(p[0], gy(p), -p[1]); box.setMatrixAt(i, m); leg.setMatrixAt(i, m);
    });
    box.castShadow = true; group.add(box, leg);
  }

  // --- monuments: plinth + weathered-bronze figure column ----------------------------------
  if (world.monuments?.length) {
    const plinthG = new THREE.BoxGeometry(1.6, 0.9, 1.6); plinthG.translate(0, 0.45, 0);
    const colG = new THREE.CylinderGeometry(0.35, 0.5, 2.6, 8); colG.translate(0, 2.2, 0);
    const plinths = new THREE.InstancedMesh(plinthG, new THREE.MeshLambertMaterial({color: 0x8d8a83}), world.monuments.length);
    const cols = new THREE.InstancedMesh(colG, new THREE.MeshStandardMaterial({color: 0x4f7d68, metalness: 0.6, roughness: 0.5}), world.monuments.length);
    const m = new THREE.Matrix4();
    // A monument is usually on a square or an island, but where OSM put one at a junction centre our
    // width swallows it. Larger clearance than a postbox: this is a 1.6 m plinth, not a bollard.
    world.monuments.forEach((p0, i) => {
      const p = shoveClear(world, p0[0], p0[1], 1.2) ?? p0;
      m.makeTranslation(p[0], gy(p), -p[1]); plinths.setMatrixAt(i, m); cols.setMatrixAt(i, m);
    });
    plinths.castShadow = cols.castShadow = true;
    group.add(plinths, cols);
  }

  // --- staircases: light stepped ribbons, visual only --------------------------------------
  if (world.steps?.length) {
    const pos = [], idx = [];
    let v = 0;
    for (const pts of world.steps) {
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len, half = 1.1;
        // Never pave a staircase across a carriageway. In the real city a stairway and the road it
        // passes are at different heights — that is the entire point of a stairway — and the flat
        // world collapses that separation, dropping pale ribbons flat onto the tarmac. Clausen and
        // the Grund are built out of public staircases, so this is not a rare case there: it is what
        // made whole streets look strewn with random slabs. Sampled along the segment rather than at
        // its midpoint, because a stairway can be long and only partly over the road.
        if (world.onRoad) {
          let onTar = false;
          const n = Math.max(1, Math.ceil(len / 2));
          for (let k = 0; k <= n && !onTar; k++) {
            const t = k / n;
            if (world.onRoad(x1 + dx * t, y1 + dy * t, 0.5)) onTar = true;
          }
          if (onTar) continue;
        }
        const g1a = groundHeight(x1 + nx * half, -(y1 + ny * half)) + 0.04, g1b = groundHeight(x1 - nx * half, -(y1 - ny * half)) + 0.04;
        const g2a = groundHeight(x2 + nx * half, -(y2 + ny * half)) + 0.04, g2b = groundHeight(x2 - nx * half, -(y2 - ny * half)) + 0.04;
        pos.push(x1 + nx * half, g1a, -(y1 + ny * half), x1 - nx * half, g1b, -(y1 - ny * half),
                 x2 + nx * half, g2a, -(y2 + ny * half), x2 - nx * half, g2b, -(y2 - ny * half));
        idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        v += 4;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    group.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({color: 0x9a978f})));
  }

  // --- fountains: a circular basin with a tiered centre and a pale water disc -----------------
  // ONLY at REAL OSM fountains (26 of them). We deliberately do NOT invent a fountain at every
  // square centroid — most of Luxembourg's "squares" are paved traffic plazas (Place Guillaume II,
  // Place de la Constitution), and dropping a basin on their midpoint plants an obstacle right where
  // cars drive and spawn. A real fountain is mapped where a real fountain is. Water is a flat
  // translucent disc; a raised stepped centrepiece reads as jets at street scale.
  const fountainSites = [];
  for (const p of (world.fountains ?? [])) fountainSites.push([p[0], p[1]]);
  if (fountainSites.length) {
    const n = fountainSites.length;
    const basinG = new THREE.CylinderGeometry(2.4, 2.6, 0.55, 20); basinG.translate(0, 0.28, 0);
    const rimG = new THREE.TorusGeometry(2.4, 0.16, 8, 24).rotateX(Math.PI / 2); rimG.translate(0, 0.55, 0);
    const waterG = new THREE.CircleGeometry(2.25, 20).rotateX(-Math.PI / 2); waterG.translate(0, 0.5, 0);
    const pedG = new THREE.CylinderGeometry(0.35, 0.6, 1.4, 12); pedG.translate(0, 1.2, 0);
    const bowlG = new THREE.CylinderGeometry(1.0, 0.3, 0.3, 14); bowlG.translate(0, 1.95, 0);
    const stoneM = new THREE.MeshLambertMaterial({color: 0x9c968b});
    const waterM = new THREE.MeshStandardMaterial({color: 0x4a7fa6, metalness: 0.2, roughness: 0.15,
      transparent: true, opacity: 0.82});
    const basins = new THREE.InstancedMesh(basinG, stoneM, n);
    const rims = new THREE.InstancedMesh(rimG, stoneM, n);
    const peds = new THREE.InstancedMesh(pedG, stoneM, n);
    const bowls = new THREE.InstancedMesh(bowlG, stoneM, n);
    const waters = new THREE.InstancedMesh(waterG, waterM, n);
    const m = new THREE.Matrix4();
    fountainSites.forEach((p0, i) => {
      const p = shoveClear(world, p0[0], p0[1], 1.2) ?? p0;
      m.makeTranslation(p[0], gy(p), -p[1]);
      basins.setMatrixAt(i, m); rims.setMatrixAt(i, m); peds.setMatrixAt(i, m);
      bowls.setMatrixAt(i, m); waters.setMatrixAt(i, m);
    });
    for (const x of [basins, rims, peds, bowls]) { x.castShadow = true; group.add(x); }
    group.add(waters);
  }

  // --- groomed bushes: low rounded shrubs ringing squares and park edges ----------------------
  // Deliberately NOT the wild trees — clipped, uniform, hedge-green domes, the way a European
  // plaza is kept. One squashed icosphere, instanced along square perimeters and green edges.
  const bushPts = [];
  for (const sq of (world.squares ?? [])) {
    if (sq.r < 6) continue;
    const ring = Math.max(8, Math.floor(sq.r * 0.9));    // denser ring on bigger squares
    for (let k = 0; k < ring; k++) {
      const a = (k / ring) * Math.PI * 2;
      bushPts.push([sq.c[0] + Math.cos(a) * (sq.r - 1.5), sq.c[1] + Math.sin(a) * (sq.r - 1.5)]);
    }
  }
  // a light hedge along each green polygon's boundary, every ~5m, capped so a huge park does not flood
  for (const poly of (world.green ?? [])) {
    let acc = 0;
    for (let i = 0; i < poly.length - 1 && bushPts.length < 4000; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[i + 1];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      let d = 5 - acc;
      while (d < len) { bushPts.push([x1 + dx / len * d, y1 + dy / len * d]); d += 5; }
      acc = (acc + len) % 5;
    }
  }
  // Squares and parks routinely overlap the street network — a plaza ring or a park boundary runs
  // straight across the carriageway — so a hedge placed purely from that geometry ends up growing
  // out of the road you are driving down. Drop anything on the tarmac, with a metre of clearance so
  // the survivors sit behind the kerb rather than against it.
  const offRoad = world.onRoad ? bushPts.filter(([x, y]) => !world.onRoad(x, y, 1.0)) : bushPts;
  bushPts.length = 0;
  bushPts.push(...offRoad);
  if (bushPts.length) {
    const bushG = new THREE.IcosahedronGeometry(0.85, 1);
    const bpos = bushG.attributes.position;
    for (let i = 0; i < bpos.count; i++) bpos.setY(i, bpos.getY(i) * 0.6);   // clipped dome
    bushG.computeVertexNormals(); bushG.translate(0, 0.5, 0);
    const bushM = new THREE.MeshLambertMaterial({color: 0x3d6b39});
    const bushes = new THREE.InstancedMesh(bushG, bushM, bushPts.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    bushPts.forEach((p, i) => {
      const j = 0.8 + ((Math.sin(i * 91.7) * 4373 % 1) + 1) % 1 * 0.5;
      s.set(j, j, j);
      m.compose(new THREE.Vector3(p[0], gy(p), -p[1]), q, s);
      bushes.setMatrixAt(i, m);
    });
    bushes.castShadow = true;
    group.add(bushes);
  }

  // --- Gëlle Fra: the landmark monument on the primary square ---------------------------------
  // The Golden Lady — a 21m granite obelisk on Place de la Constitution, crowned by a 3.3m gilded
  // winged Nike holding a laurel wreath. Placed on the largest square in the slice, the one the
  // player will read as the city's heart. Reference: en.wikipedia.org/wiki/Gëlle_Fra.
  {
    // Gëlle Fra's TRUE position: Place de la Constitution, 49.60961°N, 6.13000°E, which projects to
    // local (0, -322). Anchor the monument to that point; if a mapped square sits close, drop it on
    // the square's centroid so it stands centred on the plaza, otherwise plant it at the true point.
    const FRA = [0, -322];
    const squares = (world.squares ?? []).slice()
      .sort((a, b) => ((a.c[0] - FRA[0]) ** 2 + (a.c[1] - FRA[1]) ** 2) - ((b.c[0] - FRA[0]) ** 2 + (b.c[1] - FRA[1]) ** 2));
    const nearest = squares[0];
    const onSquare = nearest && ((nearest.c[0] - FRA[0]) ** 2 + (nearest.c[1] - FRA[1]) ** 2 < 45 * 45);
    const host = {c: onSquare ? nearest.c : FRA};
    if (host) {
      const mon = new THREE.Group();
      const stoneM = new THREE.MeshLambertMaterial({color: 0x8f8a80});
      const gold = new THREE.MeshStandardMaterial({color: 0xd4af37, metalness: 0.9, roughness: 0.28,
        emissive: 0x2a2008, emissiveIntensity: 0.3});
      const step = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.8, 0.6, 16), stoneM); step.position.y = 0.3;
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.6, 2.4), stoneM); plinth.position.y = 1.4;
      // the obelisk: a tall square granite shaft, gently tapering
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.85, 17, 4), stoneM);
      shaft.rotation.y = Math.PI / 4; shaft.position.y = 1.6 + 8.5;
      // the golden Nike: a slim figure with a raised wreath, suggested with a body + wings + ring
      const nike = new THREE.Group();
      const bodyF = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, 2.2, 8), gold); bodyF.position.y = 1.1;
      const wingL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.6, 0.7), gold); wingL.position.set(-0.35, 1.3, -0.1); wingL.rotation.z = 0.5;
      const wingR = wingL.clone(); wingR.position.x = 0.35; wingR.rotation.z = -0.5;
      const wreath = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.07, 6, 12), gold); wreath.position.set(0, 2.6, 0); wreath.rotation.x = Math.PI / 2.4;
      nike.add(bodyF, wingL, wingR, wreath);
      nike.position.y = 1.6 + 17;
      mon.add(step, plinth, shaft, nike);
      mon.position.set(host.c[0], groundHeight(host.c[0], -host.c[1]), -host.c[1]);
      mon.traverse(o => { if (o.isMesh) o.castShadow = true; });
      group.add(mon);
    }
  }

  // --- road works: deterministic sites with fences, cones, spoil and hi-vis workers --------
  const sites = pickWorkSites(world, 3);
  const work = buildWorkSites(sites);
  group.add(work);

  return {group, sites};
}

// Residential edges, deterministic pick: longest few, spread apart.
function pickWorkSites(world, count) {
  const cands = world.edges.filter(e => e.kind === 'residential' && e.length > 60)
    .sort((a, b) => b.length - a.length);
  const sites = [];
  for (const e of cands) {
    const mid = e.pts[Math.floor(e.pts.length / 2)];
    if (sites.every(s => (s.x - mid[0]) ** 2 + (s.y - mid[1]) ** 2 > 300 ** 2)) {
      const [x1, y1] = e.pts[0], [x2, y2] = e.pts[e.pts.length - 1];
      sites.push({x: mid[0], y: mid[1], ang: Math.atan2(y2 - y1, x2 - x1), width: e.width});
      if (sites.length === count) break;
    }
  }
  return sites;
}

function buildWorkSites(sites) {
  const g = new THREE.Group();
  const fenceG = new THREE.BoxGeometry(1.8, 0.9, 0.08); fenceG.translate(0, 0.55, 0);
  const fenceM = new THREE.MeshLambertMaterial({color: 0xffffff});
  const stripeG = new THREE.BoxGeometry(1.8, 0.3, 0.09); stripeG.translate(0, 0.75, 0);
  const stripeM = new THREE.MeshLambertMaterial({color: 0xd23a28});
  const coneG = new THREE.ConeGeometry(0.18, 0.5, 8); coneG.translate(0, 0.25, 0);
  const coneM = new THREE.MeshLambertMaterial({color: 0xe8611f});
  const heapG = new THREE.SphereGeometry(1.1, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  const heapM = new THREE.MeshLambertMaterial({color: 0x6b5a44});
  const signG = new THREE.BoxGeometry(0.7, 0.7, 0.06); signG.translate(0, 1.2, 0);
  const signM = new THREE.MeshLambertMaterial({color: 0xd23a28});
  // hi-vis worker: legs + torso + head + helmet, leaning pose baked
  const workerM = new THREE.MeshLambertMaterial({color: 0xe8ef1a});
  const trouserM = new THREE.MeshLambertMaterial({color: 0x2b3d55});
  const skinM = new THREE.MeshLambertMaterial({color: 0xd9b08a});
  const helmetM = new THREE.MeshLambertMaterial({color: 0xe8ef1a});

  for (const s of sites) {
    const site = new THREE.Group();
    site.position.set(s.x, groundHeight(s.x, -s.y), -s.y);
    site.rotation.y = -s.ang;
    // fences boxing ~14m of one lane, cones tapering in
    for (const [dx, dz, ry] of [[-7, s.width / 4, Math.PI / 2], [7, s.width / 4, Math.PI / 2],
                                [-5.5, s.width / 4 + 1, 0], [-2, s.width / 4 + 1.2, 0], [1.5, s.width / 4 + 1.2, 0], [5, s.width / 4 + 1, 0]]) {
      const f = new THREE.Group();
      const panel = new THREE.Mesh(fenceG, fenceM), stripe = new THREE.Mesh(stripeG, stripeM);
      f.add(panel, stripe);
      f.position.set(dx, 0, dz); f.rotation.y = ry;
      site.add(f);
    }
    for (const [dx, dz] of [[-9, s.width / 4 - 0.5], [-8, s.width / 4 + 0.8], [8.5, s.width / 4 + 0.3], [9.5, s.width / 4 - 0.6]]) {
      const c = new THREE.Mesh(coneG, coneM); c.position.set(dx, 0, dz); site.add(c);
    }
    const heap = new THREE.Mesh(heapG, heapM); heap.position.set(2.5, 0, s.width / 4 + 0.4); heap.scale.set(1, 0.55, 0.8); site.add(heap);
    const sign = new THREE.Mesh(signG, signM); sign.position.set(-8.5, 0, s.width / 4 + 1.4); sign.rotation.z = Math.PI / 4; site.add(sign);
    // two workers, one leaning on a "shovel" (thin cylinder), one crouched at the heap
    const mkWorker = (lean) => {
      const w = new THREE.Group();
      const legs = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.72, 0.22), trouserM); legs.position.y = 0.36;
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.26), workerM); torso.position.y = 0.98;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), skinM); head.position.y = 1.42;
      const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), helmetM); helmet.position.y = 1.47;
      w.add(legs, torso, head, helmet);
      if (lean) {
        w.rotation.z = 0.18;
        const shovel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.4, 5), trouserM);
        shovel.position.set(0.35, 0.7, 0); shovel.rotation.z = -0.35;
        w.add(shovel);
      } else {
        w.scale.y = 0.62; // crouched
      }
      return w;
    };
    const w1 = mkWorker(true); w1.position.set(0.6, 0, s.width / 4 + 0.2); site.add(w1);
    const w2 = mkWorker(false); w2.position.set(3.4, 0, s.width / 4 + 0.9); w2.rotation.y = 1.2; site.add(w2);
    site.traverse(o => { if (o.isMesh) o.castShadow = true; });
    g.add(site);
  }
  return g;
}

// --- Notre-Dame de Luxembourg ---------------------------------------------------------------
// The cathedral's OSM footprint carries a nonsense 9.6m height, so the skyline loses the one
// silhouette every resident would look for. This raises the nave and plants the three dark
// spires — the tall needle over the west tower and its two flanks — on the REAL footprint's
// axis. Landmark treatment, same philosophy as the Pont Rouge: help the true shape, invent
// as little as possible.
export function buildCathedral(world) {
  const g = new THREE.Group();
  // locate: largest footprint within 60m of the cathedral's true position (locals: 99, -350)
  // Notre-Dame de Luxembourg's TRUE position: 49.61028°N, 6.13188°E, which projects to local
  // (136, -247) under the fetch's equirectangular projection about the slice centre. The largest
  // footprint within reach of that point IS the cathedral.
  const CATH = [136, -247];
  let best = null, bestArea = 0;
  for (const b of world.buildings) {
    const cx = b.pts.reduce((s, q) => s + q[0], 0) / b.pts.length;
    const cy = b.pts.reduce((s, q) => s + q[1], 0) / b.pts.length;
    if ((cx - CATH[0]) ** 2 + (cy - CATH[1]) ** 2 > 70 * 70) continue;
    let area = 0;
    for (let i = 0; i < b.pts.length - 1; i++) {
      area += b.pts[i][0] * b.pts[i + 1][1] - b.pts[i + 1][0] * b.pts[i][1];
    }
    area = Math.abs(area / 2);
    if (area > bestArea) { bestArea = area; best = {b, cx, cy}; }
  }
  if (!best) return g;
  // principal axis of the footprint by covariance
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of best.b.pts) { const dx = x - best.cx, dy = y - best.cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  // Anchor the whole cathedral to its GENUINE projected coordinate, not the nearby footprint's
  // centroid — the largest building within reach can drift tens of metres off the true spot. We keep
  // the footprint only for the long-axis orientation; the position is the real one.
  best.cx = CATH[0]; best.cy = CATH[1];

  // Notre-Dame de Luxembourg, modelled from its real silhouette: a late-Gothic stone body under
  // three towers — a west and an east tower of roughly equal height, each carrying a THIN, DELICATE
  // BLACK SPIRE (the cathedral's signature), and a short central tower over the transept, only about
  // a third their height, with a wide pyramid base and a narrow copper-capped peak. Reference:
  // luxembourg.public.lu — "three towers, two of which are 40 metres high".
  const stone = new THREE.MeshLambertMaterial({color: 0x9b9488});          // pale ashlar
  const black = new THREE.MeshLambertMaterial({color: 0x191b1f});          // the black steeples
  const copper = new THREE.MeshStandardMaterial({color: 0x2f6b5e, metalness: 0.5, roughness: 0.5}); // oxidised cap
  const slate = new THREE.MeshLambertMaterial({color: 0x30343b});

  // nave: a long stone box with a steep dark gable roof running along the footprint's long axis
  const naveBox = new THREE.Mesh(new THREE.BoxGeometry(42, 12, 13), stone);
  naveBox.position.set(best.cx, 6, -best.cy);
  naveBox.rotation.y = -ang;
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 9.2, 42, 4, 1), slate);
  roof.rotation.z = Math.PI / 2; roof.rotation.y = -ang;
  roof.scale.set(1, 1, 0.55);
  roof.position.set(best.cx, 14, -best.cy);
  g.add(naveBox, roof);

  // a tower: a SLENDER square stone shaft, a slim belfry stage, and — the cathedral's whole
  // identity — a needle-thin BLACK spire much taller than the stone below it, with four corner
  // pinnacles clustered at its base. Kept narrow so it reads as delicate Gothic, not a grey slab.
  const bigTower = (side) => {
    const t = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(side, 22, side), stone);
    shaft.position.y = 11;
    // belfry: a shorter, slightly inset stone stage with tall lancet-dark faces
    const belfry = new THREE.Mesh(new THREE.BoxGeometry(side * 0.9, 5, side * 0.9), stone);
    belfry.position.y = 22 + 2.5;
    // the spire: a very slender, very tall octagonal cone, matte black — the tallest thing here
    const steeple = new THREE.Mesh(new THREE.ConeGeometry(side * 0.42, 22, 8), black);
    steeple.position.y = 22 + 5 + 11;
    t.add(shaft, belfry, steeple);
    // four corner pinnacles hugging the spire base
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const pin = new THREE.Mesh(new THREE.ConeGeometry(side * 0.14, 4.5, 6), black);
      pin.position.set(sx * side * 0.44, 22 + 5 + 1.5, sz * side * 0.44);
      t.add(pin);
    }
    return t;
  };
  // central tower over the transept: a third the height, wide pyramid base, narrow copper peak
  const centralTower = () => {
    const t = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(7, 6, 7), stone);
    base.position.y = 15;                     // sits astride the nave ridge
    const pyr = new THREE.Mesh(new THREE.ConeGeometry(5.0, 6, 4), slate);    // wide pyramid base
    pyr.position.y = 15 + 3 + 3;
    const peak = new THREE.Mesh(new THREE.ConeGeometry(0.9, 5, 8), copper);  // narrow copper peak
    peak.position.y = 15 + 3 + 6 + 2.5;
    t.add(base, pyr, peak);
    return t;
  };

  // stations along the axis: west tower at one end, east tower at the other, central over the middle
  const west = bigTower(6.5);  west.position.set(best.cx + ux * 22, 0, -(best.cy + uy * 22));
  const east = bigTower(6.2); east.position.set(best.cx - ux * 22, 0, -(best.cy - uy * 22));
  const centre = centralTower(); centre.position.set(best.cx, 0, -best.cy);
  g.add(west, east, centre);

  // Seat the whole cathedral on the terrain under its footprint centre (it stands on one footprint,
  // so one base height lifts every tower/nave part together).
  g.position.y = groundHeight(best.cx, -best.cy);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// --- traffic signal heads: pole + housing + one lamp whose colour the simulation drives ----
export function buildSignals(world) {
  const n = world.signals?.length ?? 0;
  if (!n) return {group: new THREE.Group(), setPhase: () => {}};
  const poleG = new THREE.CylinderGeometry(0.06, 0.08, 3.4, 6); poleG.translate(0, 1.7, 0);
  const headG = new THREE.BoxGeometry(0.26, 0.72, 0.2); headG.translate(0, 3.1, 0);
  const lampG = new THREE.SphereGeometry(0.09, 8, 6); lampG.translate(0, 3.1, 0.12);
  const poles = new THREE.InstancedMesh(poleG, new THREE.MeshLambertMaterial({color: 0x3a3e45}), n);
  const heads = new THREE.InstancedMesh(headG, new THREE.MeshLambertMaterial({color: 0x22252b}), n);
  const lamps = new THREE.InstancedMesh(lampG, new THREE.MeshBasicMaterial({color: 0xffffff}), n);
  const m = new THREE.Matrix4(), c = new THREE.Color();
  const COLOURS = [0xd0342c, 0xe8a13a, 0x3fbf5a]; // red, amber, green
  // OSM puts a traffic_signals node in the MIDDLE of the junction it governs, which is where the
  // logic wants it and the last place the mast should stand: 270 of these 285 were sitting in a live
  // carriageway, and a signal pole in the middle of a crossroads is the most conspicuous version of
  // an object in the road. So the mast is shoved to the nearest kerb and turned to face back at the
  // junction, while `world.signals` keeps the original point — the simulation indexes phases by
  // position in that array and pairs each one with its node, so the data must not move.
  let masts = 0;
  world.signals.forEach((p, i) => {
    const spot = shoveClear(world, p[0], p[1], 0.4) ?? p;
    if (spot !== p) masts++;
    // Heads point at the junction centre. A mast on the kerb facing nowhere reads as a lamp post.
    const rot = Math.atan2(p[0] - spot[0], -(p[1] - spot[1]));
    m.makeRotationY(rot).setPosition(spot[0], gy(spot), -spot[1]);
    poles.setMatrixAt(i, m); heads.setMatrixAt(i, m); lamps.setMatrixAt(i, m);
    c.set(COLOURS[2]); lamps.setColorAt(i, c);
  });
  console.info(`traffic signals: ${masts} of ${n} masts moved from the junction centre to a kerb`);
  window.__props = Object.assign(window.__props ?? {}, {signalMasts: masts, signals: n});
  poles.castShadow = true;
  const group = new THREE.Group(); group.add(poles, heads, lamps);
  // The simulation owns phases: it calls setPhase(i, 0|1|2) whenever a head changes.
  const setPhase = (i, phase) => {
    c.set(COLOURS[phase] ?? COLOURS[2]);
    lamps.setColorAt(i, c);
    lamps.instanceColor.needsUpdate = true;
  };
  return {group, setPhase};
}
