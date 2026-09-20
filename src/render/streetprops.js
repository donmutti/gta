// Street furniture — the pavement layer. Everything here is instanced and Master places it from
// road polylines (see scene.js / decor.js for the idiom). Nothing simulates: props, not actors.
//
// WORLD AXIS. The game model is XY with +Y north; three's ground is XZ. The mapping used
// EVERYWHERE in this project is three.x = model.x, three.z = -model.y — i.e. world Z = -y_map.
// So every setAt(i, x, z, rotY) below takes x,z as THREE-space coords already (y=0 ground).
// Master, if you place from model coords [mx, my], call setAt(i, mx, -my, rotY). rotY is a
// yaw in radians about the up axis; the "front" of each prop faces +Z at rotY=0 (see per-prop
// notes). All factories share materials, keep each prop a few dozen to ~200 tris, use low/zero
// metalness (no env map exists — metalness~1 renders black), and cast shadows.
//
// Contract, identical shape for every prop:
//   const b = makeBollards(count)
//   b.setAt(i, x, z, rotY)        // 0 <= i < count; world x,z; yaw radians
//   scene.add(b.mesh)            // mesh is an InstancedMesh or a Group of them
//   b.mesh /* after the last setAt */  // matrices upload automatically on first render,
//                                       // but if you set fewer than `count`, the tail instances
//                                       // sit at the origin — over-allocate or scale unused to 0.
// b.count echoes the capacity you asked for.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared materials — one instance of each, reused across every prop so the whole
// furniture layer costs a handful of materials no matter how many thousands of props.
// Municipal metalwork is one anthracite (≈RAL 7016), the way a real city keeps its furniture
// coherent — bollards, bins, racks and shelter frames all key off it, with only slight value
// steps so parts read apart in shadow rather than fusing into one blob.
const MAT = {
  darkMetal:   new THREE.MeshLambertMaterial({color: 0x373f43}),   // anthracite, the base street iron
  greyMetal:   new THREE.MeshLambertMaterial({color: 0x424a4f}),   // anthracite, one step lighter
  midMetal:    new THREE.MeshLambertMaterial({color: 0x4c545a}),   // anthracite, frames/racks
  wood:        new THREE.MeshLambertMaterial({color: 0x7a5230}),   // bench slats, warm brown
  woodDark:    new THREE.MeshLambertMaterial({color: 0x5c3d24}),   // shadowed slat variant
  stone:       new THREE.MeshLambertMaterial({color: 0x8f8a80}),   // planter concrete
  soil:        new THREE.MeshLambertMaterial({color: 0x3f342a}),   // planter earth
  hedge:       new THREE.MeshLambertMaterial({color: 0x3d6b39}),   // planter greenery
  // The bin keeps a muted municipal green — the one warm break in an anthracite layer, and a
  // colour genuinely common on continental street bins — but desaturated so it sits WITH the
  // anthracite rather than fighting it.
  binBody:     new THREE.MeshLambertMaterial({color: 0x3c4a41}),   // muted euro-green
  binLid:      new THREE.MeshLambertMaterial({color: 0x313f39}),
  red:         new THREE.MeshLambertMaterial({color: 0xb02a20}),   // reflector bands, sign posts
  white:       new THREE.MeshLambertMaterial({color: 0xf0f0ee}),
  signBlue:    new THREE.MeshLambertMaterial({color: 0x21518f}),   // European direction sign
  roof:        new THREE.MeshLambertMaterial({color: 0x30343b}),   // shelter roof
  // Glass: translucent, double-sided, faint blue. No env map, so keep metalness low or it blacks.
  glass:       new THREE.MeshStandardMaterial({
    color: 0xbcd2dd, metalness: 0.0, roughness: 0.1,
    transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false,
  }),
};

// A small helper: turn a list of pre-translated geometries into one merged geometry so a whole
// multi-part prop is a SINGLE InstancedMesh (one draw call, one matrix per instance). All parts
// must share one material — split into separate InstancedMeshes when they don't (see benches).
function merge(geoms) {
  const nonIndexed = geoms.map(g => (g.index ? g.toNonIndexed() : g));
  const total = nonIndexed.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), norm = new Float32Array(total * 3);
  let o = 0;
  for (const g of nonIndexed) {
    const gp = g.attributes.position.array;
    pos.set(gp, o * 3);
    if (g.attributes.normal) norm.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  out.computeVertexNormals();
  return out;
}

// The standard single-mesh factory: one merged geometry, one material, a setAt that composes
// (translation, yaw, scale=1). Returns {mesh, setAt, count}. castShadow on by default.
function instanced(geom, material, count, {shadow = true} = {}) {
  const mesh = new THREE.InstancedMesh(geom, material, count);
  mesh.castShadow = shadow;
  mesh.count = count;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  const setAt = (i, x, z, rotY = 0, y = 0) => {
    e.set(0, rotY, 0); q.setFromEuler(e); p.set(x, y, z);   // y = terrain height (0 if flat)
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    mesh.instanceMatrix.needsUpdate = true;
  };
  return {mesh, setAt, count};
}

// A group factory for multi-material props: keeps N parallel InstancedMeshes (one per material)
// and drives them all from one setAt with a shared matrix. Returns {mesh: Group, setAt, count}.
function instancedGroup(parts, count, {shadow = true} = {}) {
  // parts: [{geom, material}]. Each becomes its own InstancedMesh; they move together.
  const group = new THREE.Group();
  const meshes = parts.map(({geom, material}) => {
    const im = new THREE.InstancedMesh(geom, material, count);
    im.castShadow = shadow;
    im.count = count;
    group.add(im);
    return im;
  });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  const setAt = (i, x, z, rotY = 0, y = 0) => {
    e.set(0, rotY, 0); q.setFromEuler(e); p.set(x, y, z);   // y = terrain height (0 if flat)
    m.compose(p, q, s);
    for (const im of meshes) { im.setMatrixAt(i, m); im.instanceMatrix.needsUpdate = true; }
  };
  return {mesh: group, setAt, count};
}

// ===========================================================================
// 1. BOLLARDS — short cast-iron posts along pavement edges. ~40 tris.
// A tapered shaft with a rounded cap and a faint reflector band near the top. Radially
// symmetric, so rotY is cosmetic. Height ~0.9m — knee-high, the real thing.
export function makeBollards(count) {
  const shaft = new THREE.CylinderGeometry(0.075, 0.10, 0.82, 8); shaft.translate(0, 0.41, 0);
  const cap = new THREE.SphereGeometry(0.085, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2); cap.translate(0, 0.82, 0);
  const collar = new THREE.CylinderGeometry(0.11, 0.11, 0.06, 8); collar.translate(0, 0.10, 0);
  const geom = merge([shaft, cap, collar]);
  return instanced(geom, MAT.darkMetal, count);
}

// A brighter variant with a white reflector band — for crossings and kerb build-outs.
// Same silhouette, so it shares the shaft geometry and only differs in a two-part group.
export function makeReflectorBollards(count) {
  const shaft = new THREE.CylinderGeometry(0.075, 0.10, 0.82, 8); shaft.translate(0, 0.41, 0);
  const cap = new THREE.SphereGeometry(0.085, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2); cap.translate(0, 0.82, 0);
  const collar = new THREE.CylinderGeometry(0.11, 0.11, 0.06, 8); collar.translate(0, 0.10, 0);
  const band = new THREE.CylinderGeometry(0.102, 0.102, 0.09, 8); band.translate(0, 0.66, 0);
  return instancedGroup([
    {geom: merge([shaft, cap, collar]), material: MAT.midMetal},
    {geom: band, material: MAT.white},
  ], count);
}

// ===========================================================================
// 2. LITTER BINS — European post-mounted street bin: a rounded body on a stem, with a
// slightly overhanging lid and a slot. ~120 tris. Faces +Z (the opening) at rotY=0, so
// point rotY toward the pavement. Dark green, the common continental colour.
export function makeBins(count) {
  const stem = new THREE.CylinderGeometry(0.05, 0.05, 0.55, 6); stem.translate(0, 0.28, 0);
  const base = new THREE.CylinderGeometry(0.11, 0.14, 0.08, 8); base.translate(0, 0.04, 0);
  // body: a barrel, slightly tapered, open-topped feel via a darker lid above
  const body = new THREE.CylinderGeometry(0.19, 0.17, 0.5, 9); body.translate(0, 0.82, 0);
  const bodyRim = new THREE.TorusGeometry(0.19, 0.02, 5, 9).rotateX(Math.PI / 2); bodyRim.translate(0, 1.07, 0);
  const geomBody = merge([stem, base, body, bodyRim]);
  // lid: a shallow dome overhanging the rim, and a deposit hood on the front (+Z)
  const lid = new THREE.CylinderGeometry(0.215, 0.20, 0.06, 9); lid.translate(0, 1.12, 0);
  const dome = new THREE.SphereGeometry(0.2, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2.6); dome.translate(0, 1.13, 0);
  const geomLid = merge([lid, dome]);
  return instancedGroup([
    {geom: geomBody, material: MAT.binBody},
    {geom: geomLid, material: MAT.binLid},
  ], count);
}

// ===========================================================================
// 3. BENCHES — park/street bench, wood slats on cast-iron end frames. ~150 tris.
// The seat runs along the X axis at rotY=0; the backrest is on the -Z side, so a sitter
// faces +Z. Length ~1.8m, seat height 0.45m. Two materials: wood slats + dark iron frame.
export function makeBenches(count) {
  const L = 1.8, seatY = 0.45, backY = 0.85;
  // --- wood: 3 seat slats + 3 back slats, thin boards running the length -----------------
  const slats = [];
  for (let k = 0; k < 3; k++) {
    const s = new THREE.BoxGeometry(L, 0.04, 0.11);
    s.translate(0, seatY, -0.18 + k * 0.15);           // seat slats, front to back
    slats.push(s);
  }
  for (let k = 0; k < 3; k++) {
    const b = new THREE.BoxGeometry(L, 0.11, 0.035);
    b.translate(0, backY - 0.02 + k * 0.15, -0.28);    // back slats, stacked up the rest
    slats.push(b);
  }
  const geomWood = merge(slats);
  // --- iron: two end frames (an A of legs + armrest hint) + a stretcher ------------------
  const frame = [];
  for (const sx of [-1, 1]) {
    const x = sx * (L / 2 - 0.08);
    const frontLeg = new THREE.BoxGeometry(0.05, seatY, 0.05); frontLeg.translate(x, seatY / 2, 0.12);
    const backLeg = new THREE.BoxGeometry(0.05, backY + 0.1, 0.05); backLeg.translate(x, (backY + 0.1) / 2, -0.28);
    const seatBar = new THREE.BoxGeometry(0.05, 0.05, 0.55); seatBar.translate(x, seatY, -0.08);
    frame.push(frontLeg, backLeg, seatBar);
  }
  const stretcher = new THREE.BoxGeometry(L - 0.2, 0.04, 0.04); stretcher.translate(0, 0.12, 0.0);
  frame.push(stretcher);
  const geomIron = merge(frame);
  return instancedGroup([
    {geom: geomWood, material: MAT.wood},
    {geom: geomIron, material: MAT.darkMetal},
  ], count);
}

// ===========================================================================
// 4. BUS SHELTERS — glass-and-frame: a flat roof on two/three uprights, a glass back panel,
// a glass side panel, and a slim bench inside. ~180 tris. The shelter opens toward +Z (the
// road/kerb side is +Z; the back glass is on -Z), so rotY points the opening at the street.
// Width ~2.6m, depth ~1.3m, height ~2.3m.
export function makeShelters(count) {
  const W = 2.6, D = 1.3, H = 2.3;
  // --- frame: roof slab + 4 corner posts + a bench frame, all dark metal -----------------
  const frame = [];
  const roof = new THREE.BoxGeometry(W + 0.2, 0.09, D + 0.25); roof.translate(0, H, -0.05);
  frame.push(roof);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = new THREE.BoxGeometry(0.09, H, 0.09);
    post.translate(sx * (W / 2 - 0.06), H / 2, sz * (D / 2 - 0.06));
    frame.push(post);
  }
  // a thin perimeter beam under the roof to tie the posts (front open)
  const beamBack = new THREE.BoxGeometry(W, 0.06, 0.06); beamBack.translate(0, H - 0.08, -(D / 2 - 0.06));
  const beamL = new THREE.BoxGeometry(0.06, 0.06, D); beamL.translate(-(W / 2 - 0.06), H - 0.08, 0);
  const beamR = new THREE.BoxGeometry(0.06, 0.06, D); beamR.translate(W / 2 - 0.06, H - 0.08, 0);
  frame.push(beamBack, beamL, beamR);
  const geomFrame = merge(frame);
  // --- roof cap: a separate lighter slab on top so the roof reads as a panel, not a beam --
  const geomRoof = new THREE.BoxGeometry(W + 0.3, 0.05, D + 0.35); geomRoof.translate(0, H + 0.06, -0.05);
  // --- bench: a wood-slat seat along the back, low, for the waiting passenger ------------
  const benchSeat = new THREE.BoxGeometry(W - 0.5, 0.06, 0.34); benchSeat.translate(0, 0.44, -(D / 2 - 0.32));
  const benchLegL = new THREE.BoxGeometry(0.06, 0.44, 0.3); benchLegL.translate(-(W / 2 - 0.5), 0.22, -(D / 2 - 0.32));
  const benchLegR = new THREE.BoxGeometry(0.06, 0.44, 0.3); benchLegR.translate(W / 2 - 0.5, 0.22, -(D / 2 - 0.32));
  const geomBench = merge([benchSeat]);
  const geomBenchLegs = merge([benchLegL, benchLegR]);
  // --- glass: back panel (-Z) + two side panels. Kept as one merged glass geometry. -----
  const back = new THREE.BoxGeometry(W - 0.16, H - 0.35, 0.02); back.translate(0, (H - 0.35) / 2 + 0.15, -(D / 2 - 0.05));
  const sideL = new THREE.BoxGeometry(0.02, H - 0.35, D - 0.16); sideL.translate(-(W / 2 - 0.05), (H - 0.35) / 2 + 0.15, 0);
  // right side only half-glazed (the entry side of many shelters) — a shorter panel
  const sideR = new THREE.BoxGeometry(0.02, H - 0.35, (D - 0.16) * 0.45); sideR.translate(W / 2 - 0.05, (H - 0.35) / 2 + 0.15, -(D / 2 - 0.05) + (D - 0.16) * 0.225);
  const geomGlass = merge([back, sideL, sideR]);
  return instancedGroup([
    {geom: geomFrame, material: MAT.greyMetal},
    {geom: geomRoof, material: MAT.roof},
    {geom: geomBench, material: MAT.wood},
    {geom: geomBenchLegs, material: MAT.darkMetal},
    {geom: geomGlass, material: MAT.glass},
  ], count);
}

// ===========================================================================
// 5. BIKE RACKS — a row of inverted-U "Sheffield" stands. ~90 tris. The bar of each hoop
// runs along X; a rack of 3 hoops sits along X at rotY=0, so rotY aligns it to the kerb.
export function makeBikeRacks(count) {
  const parts = [];
  const hoopH = 0.78, hoopW = 0.7, tube = 0.06;   // ~60mm steel — reads as pipe, not wire
  for (let k = 0; k < 3; k++) {
    const x = (k - 1) * 0.75;
    // two uprights + a top bar, approximated with three boxes (cheaper than torus arcs)
    const legA = new THREE.BoxGeometry(tube, hoopH, tube); legA.translate(x - hoopW / 2, hoopH / 2, 0);
    const legB = new THREE.BoxGeometry(tube, hoopH, tube); legB.translate(x + hoopW / 2, hoopH / 2, 0);
    const top = new THREE.BoxGeometry(hoopW + tube, tube, tube); top.translate(x, hoopH, 0);
    parts.push(legA, legB, top);
  }
  return instanced(merge(parts), MAT.darkMetal, count);
}

// ===========================================================================
// 6. DRINKING FOUNTAINS — a slim cast column with a basin and a spout. ~110 tris.
// Radially near-symmetric; the spout faces +Z at rotY=0. Height ~1.0m.
export function makeFountains(count) {
  const column = new THREE.CylinderGeometry(0.09, 0.13, 0.95, 8); column.translate(0, 0.475, 0);
  const base = new THREE.CylinderGeometry(0.16, 0.2, 0.08, 8); base.translate(0, 0.04, 0);
  const basin = new THREE.CylinderGeometry(0.17, 0.13, 0.1, 10); basin.translate(0, 0.9, 0);
  const basinHollow = new THREE.CylinderGeometry(0.13, 0.11, 0.07, 10); basinHollow.translate(0, 0.94, 0);
  const geomBody = merge([column, base, basin]);
  const spout = new THREE.CylinderGeometry(0.015, 0.015, 0.14, 5).rotateX(Math.PI / 2.4); spout.translate(0, 1.0, 0.06);
  const button = new THREE.SphereGeometry(0.03, 6, 5); button.translate(0, 1.02, -0.09);
  return instancedGroup([
    {geom: geomBody, material: MAT.greyMetal},
    {geom: merge([basinHollow]), material: MAT.midMetal},
    {geom: merge([spout, button]), material: MAT.darkMetal},
  ], count);
}

// ===========================================================================
// 7. DIRECTION POSTS — a slim pole carrying two stacked blue direction blades pointing
// off to one side (the +X direction at rotY=0). ~70 tris. Reads as European wayfinding.
export function makeSignPosts(count) {
  const pole = new THREE.CylinderGeometry(0.045, 0.05, 2.7, 6); pole.translate(0, 1.35, 0);
  const geomPole = merge([pole]);
  // two direction blades: pointed fingerpost arrows extruded from a flat shape, mounted high
  // (top blade at ~2.5m) so they clear a walker's head. The point is on +X (the sign direction).
  const bladeShape = () => {
    const w = 0.72, h = 0.16, tip = 0.13;   // rectangle body ending in a chevron point
    const s = new THREE.Shape();
    s.moveTo(0, -h / 2);
    s.lineTo(w - tip, -h / 2);
    s.lineTo(w, 0);                          // the arrow tip
    s.lineTo(w - tip, h / 2);
    s.lineTo(0, h / 2);
    s.closePath();
    return new THREE.ExtrudeGeometry(s, {depth: 0.03, bevelEnabled: false});
  };
  const blades = [];
  for (let k = 0; k < 2; k++) {
    const b = bladeShape();
    b.translate(0.05, 2.5 - k * 0.22, 0.03);
    blades.push(b);
  }
  return instancedGroup([
    {geom: geomPole, material: MAT.greyMetal},
    {geom: merge(blades), material: MAT.signBlue},
  ], count);
}

// ===========================================================================
// 8. PLANTERS — a square concrete/stone trough with soil and a low rounded shrub. ~90 tris.
// Symmetric; rotY cosmetic. ~0.7m across. Brings green to hard plazas.
export function makePlanters(count) {
  // hollow box trough: four walls + a bottom, so it reads as a container not a solid block.
  // Sized as a heavy street barrier (~1m across, 0.55m tall), not a flowerpot.
  const walls = [];
  const w = 0.98, h = 0.55, t = 0.09;
  walls.push(boxAt(w, h, t, 0, h / 2, w / 2 - t / 2));       // front
  walls.push(boxAt(w, h, t, 0, h / 2, -(w / 2 - t / 2)));    // back
  walls.push(boxAt(t, h, w - 2 * t, w / 2 - t / 2, h / 2, 0)); // right
  walls.push(boxAt(t, h, w - 2 * t, -(w / 2 - t / 2), h / 2, 0)); // left
  const geomStone = merge(walls);
  const soil = new THREE.BoxGeometry(w - 2 * t, 0.05, w - 2 * t); soil.translate(0, h - 0.06, 0);
  // shrub sized to overflow the rim slightly, the way a maintained planter spills over its edge
  const shrub = new THREE.IcosahedronGeometry(0.5, 1);
  const sp = shrub.attributes.position;
  for (let i = 0; i < sp.count; i++) sp.setY(i, sp.getY(i) * 0.65);
  shrub.computeVertexNormals(); shrub.translate(0, h + 0.12, 0);
  return instancedGroup([
    {geom: geomStone, material: MAT.stone},
    {geom: soil, material: MAT.soil},
    {geom: shrub, material: MAT.hedge},
  ], count);
}
function boxAt(sx, sy, sz, x, y, z) { const b = new THREE.BoxGeometry(sx, sy, sz); b.translate(x, y, z); return b; }

// ===========================================================================
// 9. FIRE HYDRANTS — a pillar hydrant: hex base flange, tapered barrel, two side outlet caps, a
// larger pumper outlet on the front, a domed bonnet with its operating nut. ~150 tris. The pumper
// outlet faces +Z at rotY=0, so the same "point +Z at the carriageway" rule as every other prop
// here puts the working face toward the street, which is where a fire crew would stand.
//
// Luxembourg's real hydrants are mostly underground plates, so this is the recognisable pillar
// instead of the strictly local fitting: the prop has to read as a hydrant from a moving car at
// thirty metres, and a flush cover in the pavement reads as nothing at all. Kept in the municipal
// red of the rest of the street signage (MAT.red) rather than a brighter pillar-box, so a hundred
// and fifty of them punctuate the anthracite layer without shouting over it.
export function makeHydrants(count) {
  const flange = new THREE.CylinderGeometry(0.23, 0.25, 0.07, 6); flange.translate(0, 0.035, 0);
  const barrel = new THREE.CylinderGeometry(0.135, 0.165, 0.60, 9); barrel.translate(0, 0.37, 0);
  const shoulder = new THREE.CylinderGeometry(0.115, 0.175, 0.10, 9); shoulder.translate(0, 0.72, 0);
  const bonnet = new THREE.SphereGeometry(0.125, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  bonnet.translate(0, 0.77, 0);
  // the pumper outlet: a short barrel stub on the front face, the thing a hose couples to
  const pumper = new THREE.CylinderGeometry(0.085, 0.085, 0.10, 8).rotateX(Math.PI / 2);
  pumper.translate(0, 0.50, 0.15);
  const geomBody = merge([flange, barrel, shoulder, bonnet, pumper]);
  // caps and the operating nut in dark metal, so the working parts read apart from the casting
  const parts = [];
  for (const sx of [-1, 1]) {
    const cap = new THREE.CylinderGeometry(0.062, 0.062, 0.07, 6).rotateZ(Math.PI / 2);
    cap.translate(sx * 0.165, 0.46, 0);
    parts.push(cap);
  }
  const pumperCap = new THREE.CylinderGeometry(0.092, 0.092, 0.04, 8).rotateX(Math.PI / 2);
  pumperCap.translate(0, 0.50, 0.21);
  const nut = new THREE.CylinderGeometry(0.045, 0.05, 0.07, 5); nut.translate(0, 0.88, 0);
  parts.push(pumperCap, nut);
  return instancedGroup([
    {geom: geomBody, material: MAT.red},
    {geom: merge(parts), material: MAT.darkMetal},
  ], count);
}
