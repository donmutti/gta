// Easter-egg NPCs — playful, low-poly set-dressing scattered across the city. NONE of this is
// simulation; it is charm. Four cameos:
//   - Spider-Man swinging on a web line high above a street, re-anchoring at each arc's end.
//   - The Hulk pacing a small loop in the largest park.
//   - Two sauropod dinosaurs grazing just inside the forest boundary.
//   - Four stormtroopers standing guard at Findel airport.
//
// COORDINATE LAW (same as everywhere in this project — see scene.js / airport.js):
//   world.x = map.x,  world.z = -map.y  (north is -z).  Ground is NOT flat: every ground creature
//   sits at groundHeight(x, z) plus its own leg height. Spider-Man rides high above the street.
//
// MATERIALS: there is no env map in the scene, so metalness ~1 renders BLACK. Everything here is
// MeshLambert / MeshStandard at low metalness. Each character is a few hundred tris, hand-built
// from boxes/cylinders/cones/spheres and recognisable by SILHOUETTE + COLOUR.
//
// CONTRACT (the only export Master calls):
//   import {buildEasterEggs} from './render/eastereggs.js'
//   const eggs = buildEasterEggs(world)
//   scene.add(eggs.group)
//   // each frame:
//   eggs.update(dt, gameHours)     // dt = seconds since last frame; gameHours unused today
//
// update() does NO per-frame allocation: all scratch vectors/matrices are module-level and reused.

import * as THREE from 'three';
import {groundHeight} from '../world/terrain.js';

// map [x, mapY] -> world Vector3.  world.z = -mapY.  The single y-negation for this file.
const gy = (x, z) => groundHeight(x, z);   // groundHeight already takes world z

// ---------------------------------------------------------------------------------------------
// Shared materials — one instance each so the whole cameo cast reads as one deliberate layer.
const MAT = {
  spideyRed:  new THREE.MeshStandardMaterial({color: 0xc0261f, roughness: 0.6, metalness: 0.05}),
  spideyBlue: new THREE.MeshStandardMaterial({color: 0x1f3f8f, roughness: 0.6, metalness: 0.05}),
  spideyEye:  new THREE.MeshStandardMaterial({color: 0xf2f2f2, roughness: 0.4, metalness: 0.05}),
  web:        new THREE.MeshStandardMaterial({color: 0xf4f6f8, roughness: 0.9, metalness: 0.0, transparent: true, opacity: 0.75}),
  hulkGreen:  new THREE.MeshStandardMaterial({color: 0x3aa02c, roughness: 0.75, metalness: 0.03}),
  hulkDark:   new THREE.MeshStandardMaterial({color: 0x2b7a20, roughness: 0.8,  metalness: 0.03}),
  hulkPants:  new THREE.MeshStandardMaterial({color: 0x5b3ea0, roughness: 0.85, metalness: 0.02}),
  dinoBody:   new THREE.MeshStandardMaterial({color: 0x6b8f4e, roughness: 0.9,  metalness: 0.02}),
  dinoBelly:  new THREE.MeshStandardMaterial({color: 0x8fae6e, roughness: 0.9,  metalness: 0.02}),
  trooperW:   new THREE.MeshStandardMaterial({color: 0xf1f2f4, roughness: 0.55, metalness: 0.05}),
  trooperK:   new THREE.MeshStandardMaterial({color: 0x14161a, roughness: 0.5,  metalness: 0.1}),
};

// =============================================================================================
// SPIDER-MAN — red/blue humanoid hanging from a web line, swinging on a pendulum arc.
// Built facing +x, standing height ~1.9m centred so the group can be anchored by its head.
// The body is a small group `manikin` whose parent group we swing; a separate web cylinder
// stretches from the anchor down to his hands.
// =============================================================================================
function makeSpiderman() {
  const g = new THREE.Group();

  // torso (red) + pelvis (blue)
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.26), MAT.spideyRed);
  torso.position.y = 1.15;
  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.30, 0.25), MAT.spideyBlue);
  pelvis.position.y = 0.78;
  // head (red) with two white eye patches
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), MAT.spideyRed);
  head.position.y = 1.55;
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), MAT.spideyEye);
  eyeL.scale.set(1.3, 0.8, 0.5); eyeL.position.set(0.16, 1.58, 0.09);
  const eyeR = eyeL.clone(); eyeR.position.z = -0.09;
  // arms — one reaching UP to the web (left, +z toward anchor above), one trailing
  const armGeo = new THREE.CapsuleGeometry(0.075, 0.55, 3, 6);
  const armUp = new THREE.Mesh(armGeo, MAT.spideyRed);
  armUp.position.set(0.02, 1.55, 0.16); armUp.rotation.x = -0.5; armUp.rotation.z = 0.15;
  const armDown = new THREE.Mesh(armGeo, MAT.spideyRed);
  armDown.position.set(0.0, 1.05, -0.22); armDown.rotation.x = 0.9;
  // legs — trailing behind in a swing tuck (blue)
  const legGeo = new THREE.CapsuleGeometry(0.09, 0.6, 3, 6);
  const legL = new THREE.Mesh(legGeo, MAT.spideyBlue);
  legL.position.set(0.12, 0.45, -0.1); legL.rotation.x = 0.7;
  const legR = new THREE.Mesh(legGeo, MAT.spideyBlue);
  legR.position.set(-0.12, 0.5, 0.05); legR.rotation.x = -0.4;

  g.add(torso, pelvis, head, eyeL, eyeR, armUp, armDown, legL, legR);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// =============================================================================================
// HULK — big green brute. Wide shoulders, huge arms, small head, purple shorts. Built standing
// on the XZ plane with feet at y=0; walks facing +x. Named leg pivots so update() can bob him.
// =============================================================================================
function makeHulk() {
  const g = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 0.9), MAT.hulkGreen);
  torso.position.y = 2.4;
  // a slab of shoulders on top for the classic tapered-down silhouette
  const shoulders = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.6, 1.0), MAT.hulkGreen);
  shoulders.position.y = 3.0;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), MAT.hulkDark);
  head.position.set(0.05, 3.55, 0);
  // the classic black mop of hair on top — the fastest read cue for "Hulk", per a vision check
  const hair = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.6), MAT.trooperK);
  hair.position.set(0.02, 3.86, -0.02);
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.5), MAT.hulkDark);
  jaw.position.set(0.05, 3.28, 0);
  // massive arms hanging past the knees
  const armGeo = new THREE.CylinderGeometry(0.34, 0.28, 1.9, 8);
  const armL = new THREE.Mesh(armGeo, MAT.hulkGreen); armL.position.set(0, 2.35, 0.72); armL.rotation.x = 0.12;
  const armR = new THREE.Mesh(armGeo, MAT.hulkGreen); armR.position.set(0, 2.35, -0.72); armR.rotation.x = -0.12;
  const fistGeo = new THREE.SphereGeometry(0.34, 8, 6);
  const fistL = new THREE.Mesh(fistGeo, MAT.hulkGreen); fistL.position.set(0.05, 1.45, 0.78);
  const fistR = new THREE.Mesh(fistGeo, MAT.hulkGreen); fistR.position.set(0.05, 1.45, -0.78);
  // purple shorts + legs (leg pivots at the hip so a walk cycle swings the whole leg)
  const shorts = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 0.95), MAT.hulkPants);
  shorts.position.y = 1.5;
  g.add(torso, shoulders, head, hair, jaw, armL, armR, fistL, fistR, shorts);
  const legGeo = new THREE.CylinderGeometry(0.32, 0.3, 1.3, 8);
  for (const [name, z] of [['legL', 0.38], ['legR', -0.38]]) {
    const pivot = new THREE.Group(); pivot.name = name; pivot.position.set(0, 1.15, z);
    const leg = new THREE.Mesh(legGeo, MAT.hulkDark); leg.position.y = -0.65; pivot.add(leg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 0.5), MAT.hulkDark);
    foot.position.set(0.12, -1.25, 0); pivot.add(foot);
    g.add(pivot);
  }
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// =============================================================================================
// SAUROPOD — long-necked dinosaur from stacked tapered cylinders. Reads instantly by silhouette:
// four pillar legs, a barrel body, a long up-curved neck to a tiny head, and a long tail. Built
// facing +x, feet at y=0. Named `neck` + leg pivots for a gentle graze/step animation.
// =============================================================================================
function makeSauropod() {
  const g = new THREE.Group();
  // body barrel (long axis along x)
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.0, 3.6, 10).rotateZ(Math.PI / 2), MAT.dinoBody);
  body.position.set(0, 2.6, 0);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(1.15, 10, 8), MAT.dinoBelly);
  belly.scale.set(1.4, 0.8, 1.0); belly.position.set(0, 2.35, 0);
  // neck: a pivot group so it can sway; three tapering segments curving up and forward
  const neck = new THREE.Group(); neck.name = 'neck'; neck.position.set(1.7, 3.3, 0);
  const nSegGeo1 = new THREE.CylinderGeometry(0.55, 0.7, 1.6, 8);
  const n1 = new THREE.Mesh(nSegGeo1, MAT.dinoBody); n1.position.set(0.4, 0.6, 0); n1.rotation.z = -0.9;
  const n2 = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.55, 1.6, 8), MAT.dinoBody);
  n2.position.set(1.15, 1.55, 0); n2.rotation.z = -0.6;
  const n3 = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 1.4, 8), MAT.dinoBody);
  n3.position.set(1.9, 2.5, 0); n3.rotation.z = -0.35;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.45), MAT.dinoBody);
  head.position.set(2.55, 3.15, 0);
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.3, 0.38), MAT.dinoBody);
  snout.position.set(2.95, 3.1, 0);
  neck.add(n1, n2, n3, head, snout);
  // tail: three tapering segments trailing down and back
  const t1 = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.45, 1.8, 8).rotateZ(Math.PI / 2), MAT.dinoBody);
  t1.position.set(-2.4, 2.5, 0); t1.rotation.y = 0.0; t1.rotation.z = 0.2;
  const t2 = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.25, 1.8, 8).rotateZ(Math.PI / 2), MAT.dinoBody);
  t2.position.set(-3.7, 2.1, 0); t2.rotation.z = 0.35;
  const t3 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.06, 1.6, 8).rotateZ(Math.PI / 2), MAT.dinoBody);
  t3.position.set(-4.9, 1.6, 0); t3.rotation.z = 0.5;
  g.add(body, belly, neck, t1, t2, t3);
  // four pillar legs on hip pivots for a slow plod
  const legGeo = new THREE.CylinderGeometry(0.4, 0.34, 2.2, 8);
  const legs = [['legFL', 1.2, 0.7], ['legFR', 1.2, -0.7], ['legRL', -1.1, 0.7], ['legRR', -1.1, -0.7]];
  for (const [name, x, z] of legs) {
    const pivot = new THREE.Group(); pivot.name = name; pivot.position.set(x, 2.0, z);
    const leg = new THREE.Mesh(legGeo, MAT.dinoBody); leg.position.y = -1.1; pivot.add(leg);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.3, 8), MAT.dinoBelly);
    foot.position.y = -2.1; pivot.add(foot);
    g.add(pivot);
  }
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// =============================================================================================
// STORMTROOPER — white armour, black visor. A box body, rounded white helmet with a black
// visor band, white limbs. Built standing, feet at y=0, facing +x.
// =============================================================================================
function makeStormtrooper() {
  const g = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.34), MAT.trooperW);
  torso.position.y = 1.25;
  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.28, 0.32), MAT.trooperK);
  pelvis.position.y = 0.82;
  // helmet: white dome + a black visor band across the front
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), MAT.trooperW);
  helmet.scale.set(1.0, 1.15, 1.05); helmet.position.y = 1.78;
  // the iconic black T-visor: a brow band across the front, two angled eye lenses below it, and a
  // short vertical strip down the centre — the single strongest "stormtrooper" read cue.
  const brow = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.30), MAT.trooperK);
  brow.position.set(0.15, 1.83, 0);
  const eyeGeo = new THREE.BoxGeometry(0.11, 0.11, 0.09);
  const eyeL = new THREE.Mesh(eyeGeo, MAT.trooperK); eyeL.position.set(0.16, 1.75, 0.08); eyeL.rotation.z = 0.35;
  const eyeR = new THREE.Mesh(eyeGeo, MAT.trooperK); eyeR.position.set(0.16, 1.75, -0.08); eyeR.rotation.z = 0.35;
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.06), MAT.trooperK);
  snout.position.set(0.17, 1.7, 0);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.12, 6), MAT.trooperK);
  neck.position.y = 1.6;
  // arms + legs, white
  const armGeo = new THREE.CapsuleGeometry(0.08, 0.55, 3, 6);
  const armL = new THREE.Mesh(armGeo, MAT.trooperW); armL.position.set(0, 1.2, 0.32);
  const armR = new THREE.Mesh(armGeo, MAT.trooperW); armR.position.set(0, 1.2, -0.32);
  const legGeo = new THREE.CapsuleGeometry(0.1, 0.62, 3, 6);
  const legL = new THREE.Mesh(legGeo, MAT.trooperW); legL.position.set(0, 0.42, 0.13);
  const legR = new THREE.Mesh(legGeo, MAT.trooperW); legR.position.set(0, 0.42, -0.13);
  g.add(torso, pelvis, helmet, brow, eyeL, eyeR, snout, neck, armL, armR, legL, legR);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers for placement
function polygonAreaCentroid(poly) {
  // poly: array of [x, mapY]. Returns {area, cx, cy} in MAP coords (shoelace).
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % n];
    const cross = x0 * y1 - x1 * y0;
    a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-6) return {area: 0, cx: poly[0][0], cy: poly[0][1]};
  return {area: Math.abs(a), cx: cx / (6 * a), cy: cy / (6 * a)};
}

// module-level scratch — NO per-frame allocation in update()
const _v = new THREE.Vector3();

// =============================================================================================
// buildEasterEggs — assemble the cast, place it, and return the {group, update} contract.
// =============================================================================================
export function buildEasterEggs(world) {
  const group = new THREE.Group();
  group.name = 'eastereggs';

  // -- animated actors registry: each has a mesh (already added to group) + per-frame state ----
  const spideys = [];
  const hulks = [];
  const dinos = [];
  const troopers = [];   // they stand still, but the map still wants to know where they are

  // ---- SPIDER-MAN: swing high above a street near the city centre. ----------------------------
  // We pick a fixed high corridor and swing him along +x on a pendulum. The web line is a thin
  // cylinder from an anchor point down to his hands; every arc he re-anchors a little further on.
  {
    const spider = makeSpiderman();
    // web line: unit cylinder along +y, scaled/positioned each frame so it spans anchor->hands.
    const web = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 5), MAT.web);
    group.add(spider, web);
    // corridor: run him along a central street. Pick map centre-ish, high above ground.
    const b = world.bounds || {minX: -1000, minY: -1000, maxX: 1000, maxY: 1000};
    const midX = (b.minX + b.maxX) * 0.5;
    const midY = (b.minY + b.maxY) * 0.5;
    spideys.push({
      mesh: spider, web,
      // anchor in WORLD coords (x, z). z = -mapY.
      baseX: midX, baseZ: -midY,
      travel: 0,             // metres travelled along +x corridor (wraps)
      span: 220,             // corridor length before wrapping back
      anchorY: 34,           // web anchor height (rooftop level over centre)
      ropeLen: 15,           // pendulum length
      phase: 0,
    });
  }

  // ---- HULK: pace a small loop near the centroid of the largest green polygon. ----------------
  {
    const greens = world.green || [];
    let best = null, bestArea = -1;
    for (const poly of greens) {
      if (!poly || poly.length < 3) continue;
      const c = polygonAreaCentroid(poly);
      if (c.area > bestArea) { bestArea = c.area; best = c; }
    }
    const cx = best ? best.cx : 0, cy = best ? best.cy : 0;   // map coords
    const hulk = makeHulk();
    group.add(hulk);
    hulks.push({
      mesh: hulk,
      // loop centre in WORLD coords
      cx, cz: -cy,
      radius: 9,
      angle: 0,
      speed: 0.35,          // rad/s around the loop
      stride: 0,
    });
  }

  // ---- DINOSAURS: two sauropods just inside the forest boundary (near the bounds edge). -------
  {
    const b = world.bounds || {minX: -1000, minY: -1000, maxX: 1000, maxY: 1000};
    const inset = 40; // metres inside bounds, so they sit at the treeline
    // Place along the north edge (map maxY), spread across x, facing into the map (-x-ish).
    const spots = [
      {mx: b.minX + (b.maxX - b.minX) * 0.32, my: b.maxY - inset, heading: -0.6},
      {mx: b.minX + (b.maxX - b.minX) * 0.62, my: b.maxY - inset, heading: 0.4},
      {mx: b.minX + (b.maxX - b.minX) * 0.80, my: b.minY + inset, heading: Math.PI + 0.3},
    ];
    for (const s of spots) {
      const dino = makeSauropod();
      const wx = s.mx, wz = -s.my;
      dino.position.set(wx, gy(wx, wz), wz);
      dino.rotation.y = s.heading;
      group.add(dino);
      dinos.push({mesh: dino, phase: Math.random() * Math.PI * 2, neck: dino.getObjectByName('neck')});
    }
  }

  // ---- STORMTROOPERS: four standing near the Findel anchor. -----------------------------------
  // The airport group is lifted to groundHeight(anchor), so we seat troopers at the same height
  // (sampled at the anchor) to sit flush with the apron rather than on the raw terrain under them.
  {
    const anchor = (world.findel && world.findel.anchor) ? world.findel.anchor : [1550, 300];
    const ax = anchor[0], amy = anchor[1];
    const az = -amy;
    const baseY = gy(ax, az);   // airport is seated at groundHeight(anchor)
    // a little squad in a loose row, all facing roughly the same way (out toward the road)
    const offsets = [[-6, 4], [-2, 5], [2, 4.5], [6, 3.5]];
    let i = 0;
    for (const [dx, dz] of offsets) {
      const t = makeStormtrooper();
      t.position.set(ax + dx, baseY, az + dz);
      t.rotation.y = -0.9 + (i - 1.5) * 0.12;
      troopers.push(t);
      group.add(t);
      i++;
    }
  }

  // -------------------------------------------------------------------------------------------
  // update(dt, gameHours) — cheap procedural motion. No allocation.
  // -------------------------------------------------------------------------------------------
  function update(dt, _gameHours) {
    if (!(dt > 0)) dt = 0.016;
    if (dt > 0.1) dt = 0.1;   // clamp big frame gaps so nothing teleports

    // --- Spider-Man: pendulum swing along the corridor, re-anchoring per arc ---
    for (const s of spideys) {
      s.phase += dt * 1.1;                     // swing speed
      s.travel += dt * 9;                      // forward crawl along +x
      if (s.travel > s.span) s.travel -= s.span;
      const swing = Math.sin(s.phase) * 0.9;   // pendulum angle (rad)
      // anchor point (world) travels down the corridor; hands hang below on the rope
      const anchorX = s.baseX + s.travel;
      const anchorZ = s.baseZ;
      const anchorY = gy(anchorX, anchorZ) + s.anchorY;
      // his body position = anchor + rope rotated by swing angle in the x-y plane
      const bx = anchorX + Math.sin(swing) * s.ropeLen;
      const by = anchorY - Math.cos(swing) * s.ropeLen;
      s.mesh.position.set(bx, by, anchorZ);
      // lean into the swing; face along travel
      s.mesh.rotation.set(0, -Math.PI / 2, swing * 0.8);
      // web cylinder: from anchor down to his upraised hands (~head height above body).
      const handY = by + 1.55;
      const midY = (anchorY + handY) * 0.5;
      const dy = anchorY - handY;
      const dx = anchorX - bx;
      const len = Math.hypot(dx, dy);
      s.web.position.set((anchorX + bx) * 0.5, midY, anchorZ);
      // unit cylinder is along +y; tilt it to point from hands to anchor
      s.web.scale.set(1, len, 1);
      s.web.rotation.set(0, 0, Math.atan2(-dx, dy));
    }

    // --- Hulk: walk a slow loop, bob with a two-beat stride, swing legs ---
    for (const h of hulks) {
      h.angle += dt * h.speed;
      h.stride += dt * 4.5;
      const wx = h.cx + Math.cos(h.angle) * h.radius;
      const wz = h.cz + Math.sin(h.angle) * h.radius;
      const gh = gy(wx, wz);
      const bob = Math.abs(Math.sin(h.stride)) * 0.12;
      h.mesh.position.set(wx, gh + bob, wz);
      // face along the tangent of the loop
      h.mesh.rotation.y = -h.angle + Math.PI / 2;
      const legL = h.mesh.getObjectByName('legL');
      const legR = h.mesh.getObjectByName('legR');
      if (legL) legL.rotation.z = Math.sin(h.stride) * 0.5;
      if (legR) legR.rotation.z = -Math.sin(h.stride) * 0.5;
    }

    // --- Dinosaurs: gentle neck sway + slow breathing bob (they graze in place) ---
    for (const d of dinos) {
      d.phase += dt * 0.6;
      if (d.neck) d.neck.rotation.z = Math.sin(d.phase) * 0.18 - 0.05;
      // subtle vertical breathe using the existing seated y
      const base = gy(d.mesh.position.x, d.mesh.position.z);
      d.mesh.position.y = base + Math.sin(d.phase * 0.5) * 0.05;
    }
  }

  /**
   * Where each character is RIGHT NOW, in map coordinates, for the full-screen map to pin.
   * Spider-Man and the Hulk move, so this is read fresh each time the map is drawn rather than
   * captured once at build time. Map y is the negation of world z, as everywhere else.
   */
  function markers() {
    const out = [];
    const add = (mesh, icon, label) => {
      if (!mesh) return;
      out.push({icon, label, x: mesh.position.x, y: -mesh.position.z});
    };
    for (const s of spideys) add(s.mesh, '\u{1F577}', 'Spider-Man');
    for (const h of hulks) add(h.mesh, '\u{1F9B8}', 'Hulk');
    for (const d of dinos) add(d.mesh, '\u{1F995}', 'dinosaur');
    troopers.forEach((t, i) => { if (i === 0) add(t, '\u{1F916}', 'stormtroopers'); });
    return out;
  }

  return {group, update, markers};
}
