// The people.
//
// One InstancedMesh per BODY PART, each at full crowd count — sixteen draw calls for however many
// people there are. That is the same idiom as `makeCarFleet`, and it is the only way to have limbs
// that articulate: a mesh per person would be 340 draw calls and 340 materials, which the budget
// forbids outright.
//
// Sixteen parts rather than seven buys the things that separate a person from a doll. A head is a
// skull on a neck with a jaw, not a ball resting on a shoulder. An arm is an upper arm, a forearm
// and a hand, so it bends at the elbow and swings clear of the body instead of being buried inside
// it. A leg is a thigh, a shin and a SHOE, so the figure stands ON the pavement — the old one
// floated 23cm above it, because two 0.4m capsules hung from a 0.78m hip cannot reach the ground.
// Hair is its own part in its own colour, because at fifty metres the eye separates people by
// OUTLINE, and hair, bag and build are the outline.
//
// Everything is driven through one skeleton. `pose` is a flat bag of named joint angles; the walk
// cycle fills it, and so does `ragdoll.js` when somebody is hit. The drawing code below neither
// knows nor cares which of the two wrote it, which is why a body that has just been run over is
// articulated exactly as well as one out for a stroll.
//
// Matrices are written straight into `instanceMatrix.array`. Going through an Object3D cost 1.34ms
// a frame for 2,380 parts (measured); the hand-rolled composition below does 5,440 for a fraction
// of that, and the saving is what pays for the extra parts.

import * as THREE from 'three'
import {groundAt} from '../world/ground.js'
import {createPose, strikeRagdoll, stepRagdoll, ragdollDuration} from './ragdoll.js'

/**
 * Master's curated palette, copied by agreement so scene.js can drop its own copy. It is the BRIGHT
 * half of the wardrobe: a real pavement is mostly grey, navy and brown with a red coat every tenth
 * person, and dressing all 340 out of six saturated hues was its own kind of doll.
 */
const PED_PALETTE = [0xc65b4e, 0x4e7fc6, 0x59a06a, 0xc6a44e, 0x8a5ec6, 0x4ea9c6]
/** The other, larger half. */
const DRAB_PALETTE = [0x3c4350, 0x2b2f36, 0x6b6a63, 0x8f8b82, 0x574b40, 0x46533f, 0xb9b3a7,
  0x7d3f3a, 0x2f4a45, 0x51565e]
/** Share of the crowd in something bright. */
const BRIGHT_SHARE = 0.34
/**
 * Trousers, deliberately spanning the whole range from near-black to stone.
 *
 * The range exists so the contrast rule below always has somewhere to go. A palette of six dark
 * blues and browns guarantees that half the crowd ends up a single mud-coloured column whatever
 * the shirt was, and a figure with no value break at the waist reads as one dipped plastic piece.
 */
const TROUSER_PALETTE = [0x2f3440, 0x23262b, 0x3d4657, 0x4a4238, 0x6a6257, 0x2b3a4a, 0x55504a,
  0x8d8574, 0xa9a394, 0x4f6d8f, 0x6f7d8c, 0xbdb6a6]
/** Relative luminance of a packed hex, for the contrast rule. */
function lum(hex) {
  return (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255
}
/** How far apart a top and a bottom must be in value before they read as two garments. */
const CONTRAST = 0.15
const SKIN_PALETTE = [0xf0d2b4, 0xe8c39e, 0xd7a678, 0xb87f52, 0x8d5a3b, 0x60402c]
const HAIR_PALETTE = [0x1b1614, 0x2a1d16, 0x4a3323, 0x6b4a2a, 0xa07940, 0xc9b27e, 0x8e8b86, 0x59544e]
/** A hat is a hair mesh in a colour hair never is, which is all it takes to read as one. */
const HAT_PALETTE = [0x8c2f2a, 0x2c4f7c, 0x1d1d1f, 0x3f6b45, 0xb0a48c, 0x6d5b8c]
const SHOE_PALETTE = [0x1a1a1c, 0x272428, 0x3a2f28, 0x45454a]
/** Bags are drabber than clothes — a bright bag on every third person reads as a toy. */
const BAG_PALETTE = [0x3b3a38, 0x5a4636, 0x2f3d4a, 0x6b6257, 0x7a3f3a]
/** Fraction of people carrying something. */
const BAG_SHARE = 0.34

// Density is what "alive" means. The simulation costs 0.08ms for 140, so the budget is not the
// constraint — headroom measured, then spent.
const COUNT = 340
const LOOK_RANGE = 22          // metres within which a head tracks the car
const SIDEWALK = 1.4           // metres beyond the kerb
/** Beyond this from the car a pedestrian is recycled; the ring is where they reappear. */
const RECYCLE_AT = 170
const RECYCLE_RING = 130
/** A car closer than this, coming fast, sends people running for the kerb. */
const SCARE_RANGE = 15
const SCARE_SPEED = 7          // m/s below which a car is just traffic, not a threat
const FLEE_TIME = 1.8
/** Seconds to walk from one kerb to the other. */
const CROSS_SECONDS = 2.6
/** Probability per second that someone decides to cross at the next zebra. */
const CROSS_CHANCE = 0.06
/** Metres from the camera within which a person is hidden rather than drawn across the lens. */
const LENS_RADIUS = 4.6

// --- the skeleton ------------------------------------------------------------------------------
// Heights in metres for a 1.75m reference adult, measured from the sole. Everybody is this figure
// scaled by `build.scale`, so a 1.60m woman has 1.60m proportions and not a shrunken 1.75m doll.
// These are real anthropometry: hip joint at 52% of height, shoulder at 80%, head 13% — which is
// most of why the result reads as a person. The old figure had 0.73m shoulders and a 0.27m head.
const REFERENCE_HEIGHT = 1.75
const HIP_Y = 0.908            // hip joint above the sole; also the standing root height
const THIGH = 0.43             // hip -> knee
const SHIN = 0.42              // knee -> ankle
const ANKLE = 0.058            // ankle -> sole
const HIP_HALF = 0.085         // half the distance between the hip joints
const WAIST = 0.092            // hips -> the chest's pivot
/**
 * Chest pivot -> where the arm pivots.
 *
 * Deliberately BELOW the top of the shoulder slope. Hung level with it, the arm's own deltoid ball
 * stands proud above the torso as a nub on each corner, which is the robot-shoulder read.
 */
const CHEST_H = 0.372
const NECK_Y = 0.44            // chest pivot -> where the head pivots
const SHO_HALF = 0.196         // half the shoulder width
const UARM = 0.30              // shoulder -> elbow
const FARM = 0.265             // elbow -> wrist
/** Leg reach at full extension, which is what sets the standing height. */
const LEG = THIGH + SHIN + ANKLE

/**
 * Two adult builds, no children.
 *
 * The difference that actually reads at a distance is the shoulder-to-hip ratio, not height —
 * a broad upper body over narrow hips versus narrower shoulders over wider hips. Heights overlap
 * between the two, as real ones do, so nobody looks like a scaled copy of anybody else.
 */
function buildFor(rand) {
  const female = rand() < 0.5
  const height = female ? 1.58 + rand() * 0.16 : 1.70 + rand() * 0.18
  return {
    female,
    scale: height / REFERENCE_HEIGHT,
    shoulder: female ? 0.88 + rand() * 0.07 : 1.00 + rand() * 0.11,   // chest and shoulder width
    depth: 0.92 + rand() * 0.26,                                      // chest front-to-back
    hipW: female ? 1.04 + rand() * 0.10 : 0.94 + rand() * 0.08,
    limb: (female ? 0.90 : 1.0) + rand() * 0.14,                      // limb thickness
  }
}

// Deterministic noise, so a reload gives the same city rather than a different one each time —
// the difference between a place and a lava lamp.
function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- geometry ------------------------------------------------------------------------------
/**
 * Merge a handful of primitives into one part geometry, keeping position and normal only.
 *
 * Written out rather than pulled from BufferGeometryUtils because a part is three or four
 * primitives and the whole job is twenty lines. Sub-geometries are never welded, so a shoe merged
 * onto a shin keeps its own hard edges when the normals are recomputed.
 */
function merge(pieces) {
  let vtx = 0, idx = 0
  for (const g of pieces) { vtx += g.attributes.position.count; idx += g.index.count }
  const pos = new Float32Array(vtx * 3), nor = new Float32Array(vtx * 3)
  const ind = new Uint16Array(idx)
  let vo = 0, io = 0
  for (const g of pieces) {
    pos.set(g.attributes.position.array, vo * 3)
    nor.set(g.attributes.normal.array, vo * 3)
    const gi = g.index.array
    for (let i = 0; i < gi.length; i++) ind[io + i] = gi[i] + vo
    vo += g.attributes.position.count
    io += gi.length
    g.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  out.setIndex(new THREE.BufferAttribute(ind, 1))
  out.computeVertexNormals()
  return out
}

/** A tapered limb segment hanging DOWN from its joint, which is where every limb pivot sits. */
function segment(rTop, rBot, len, seg = 6) {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, false)
  g.translate(0, -len / 2, 0)
  return g
}
function ball(r, w = 6, h = 4) { return new THREE.SphereGeometry(r, w, h) }
function block(x, y, z) { return new THREE.BoxGeometry(x, y, z) }

/** Every part, authored with its pivot at its joint and the figure facing local +Z. */
function buildParts() {
  // Head: pivot where the neck leaves the shoulders. Skull, jaw and nose — three primitives, and
  // the nose is what tells you which way somebody is facing from across the street.
  // The skull sits FORWARD of the neck, not on top of it. A head balanced dead centre over the
  // spine is the pose of a shop mannequin; a real one carries an inch or two ahead of it, and that
  // small offset is worth more than any amount of face.
  // A skull is an EGG, longer front to back than it is wide, and it overhangs the neck behind as
  // well as in front. Shifted forward on a round ball it grew a flat wall at the back of the head
  // where the neck met it; the fix is length in Z, not offset.
  const skull = ball(0.10, 9, 6); skull.scale(0.84, 1.13, 1.16); skull.translate(0, 0.176, 0.008)
  const jaw = block(0.102, 0.072, 0.112); jaw.translate(0, 0.120, 0.040)
  const neck = new THREE.CylinderGeometry(0.050, 0.058, 0.09, 6); neck.translate(0, 0.045, -0.008)
  const nose = block(0.024, 0.028, 0.034); nose.translate(0, 0.158, 0.122)
  const head = merge([neck, jaw, skull, nose])

  // Hair is a shell over the skull with the FACE cut out of it, not a beanie sitting on top. The
  // cut is a phi range: three.js measures phi from -X, so +Z (the face) is at pi/2, and leaving
  // 70 degrees open there gives a hairline round a face instead of a helmet with a tab on the back.
  // Wraps down past the widest point of the skull and round the nape, rather than perching on top
  // like a sliced bowl. The phi gap is the face.
  const cap = new THREE.SphereGeometry(0.104, 9, 6, Math.PI / 2 + 0.60, Math.PI * 2 - 1.20, 0, 1.92)
  cap.scale(0.89, 1.17, 1.20); cap.translate(0, 0.174, 0.008)
  const hair = merge([cap])

  const mane = block(0.175, 0.22, 0.062); mane.translate(0, 0.005, -0.062)
  const hairLong = merge([mane])

  // Torso and hips are LATHES, not stacks of primitives.
  //
  // Every earlier version built them from a cylinder plus a sphere plus another cylinder, and
  // every one of them had a sawtooth somewhere — because two low-poly surfaces that meet almost
  // tangentially intersect along a ragged line, and "almost tangentially" is exactly what happens
  // when a hem sits on a hip or a shoulder dome sits on a ribcage. Turning the profile on a lathe
  // means there is no intersection to be ragged: one surface, one silhouette, the waist and the
  // shoulder slope built into the curve. It is also fewer triangles than the stack it replaces.
  const prof = (pts) => {
    const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 8)
    g.scale(1, 1, 0.66)
    return g
  }
  // Hem, waist, chest, shoulder line, neck base — heights are relative to the waist pivot, so the
  // shoulder at 0.40 is 1.40m up on the reference figure and the collar closes at 1.50.
  //
  // The profile SLOPES from the widest point down to the collar over 15cm. Held wide to 0.39 and
  // then dropped to the neck in one step, the same lathe produced square corners that read as
  // shoulder pads — an armoured, hunched silhouette. A trapezius runs downhill from the neck to
  // the arm, and the shoulder line is the END of that slope, not a shelf.
  const chest = merge([prof([
    [0.001, -0.115], [0.176, -0.110], [0.182, -0.060], [0.158, 0.020],
    [0.196, 0.240], [0.188, 0.345], [0.168, 0.405], [0.118, 0.452], [0.068, 0.490],
    [0.001, 0.500],
  ])])
  // Hips: widest BELOW the shirt hem, so the shirt always clears them and the seam is the trousers
  // emerging from under it rather than two near-equal ellipses fighting.
  const pelvis = merge([prof([
    [0.001, 0.125], [0.148, 0.120], [0.166, 0.020], [0.170, -0.050], [0.160, -0.090],
    [0.001, -0.095],
  ])])

  // NO ball at the elbow or the knee. A sphere at a joint has to be fatter than the limb to cover
  // the seam, and a 6x4 sphere that is fatter than the limb is a ring of facets catching the light
  // — the "torn sleeve" sawtooth that survived three attempts to shrink it. Instead the DISTAL
  // segment is built long and starts a few centimetres ABOVE its joint at a radius just under the
  // segment above: straight, the overrun is hidden inside the parent; bent, it is exactly the wedge
  // of material a real joint needs. One primitive fewer per limb as well.
  const OVER = 0.05
  const upperArm = merge([ball(0.049), segment(0.047, 0.040, UARM)])
  const foreTube = segment(0.037, 0.031, FARM + OVER); foreTube.translate(0, OVER, 0)
  const handGeo = ball(0.044, 5, 4); handGeo.scale(0.85, 1.25, 0.62); handGeo.translate(0, -FARM - 0.035, 0)
  const forearm = merge([foreTube, handGeo])

  const thigh = merge([ball(0.086), segment(0.082, 0.060, THIGH)])
  const shinTube = segment(0.057, 0.043, SHIN + 0.06); shinTube.translate(0, 0.06, 0)
  const shin = merge([shinTube])
  const shoe = block(0.088, 0.055, 0.235); shoe.translate(0, -0.030, 0.052)
  const foot = merge([shoe])

  const sack = block(0.24, 0.28, 0.13); sack.translate(0, -0.15, 0)
  const bag = merge([sack])

  return {head, hair, hairLong, chest, pelvis, upperArm, forearm, thigh, shin, foot, bag}
}

// --- frames ------------------------------------------------------------------------------------
// A frame is twelve numbers: the part's local X, Y and Z axes in world (columns 0-2, 3-5, 6-8) and
// its origin (9-11). Every part IS a frame, so drawing one is a scaled copy of its own numbers into
// the instance matrix, and a child joint is the parent's frame times a small rotation.

/** The root frame, from a yaw and an optional pitch/roll. Nothing above it in the hierarchy. */
function rootFrame(f, x, y, z, yaw, swing, lean) {
  const ca = Math.cos(yaw), sa = Math.sin(yaw)
  const cb = Math.cos(swing), sb = Math.sin(swing)
  const cc = Math.cos(lean), sc = Math.sin(lean)
  // Ry(yaw) * Rx(swing), column by column.
  const u0x = ca, u0y = 0, u0z = -sa
  const u1x = sa * sb, u1y = cb, u1z = ca * sb
  const u2x = sa * cb, u2y = -sb, u2z = ca * cb
  // ... * Rz(lean).
  f[0] = u0x * cc + u1x * sc; f[1] = u0y * cc + u1y * sc; f[2] = u0z * cc + u1z * sc
  f[3] = -u0x * sc + u1x * cc; f[4] = -u0y * sc + u1y * cc; f[5] = -u0z * sc + u1z * cc
  f[6] = u2x; f[7] = u2y; f[8] = u2z
  f[9] = x; f[10] = y; f[11] = z
}

/** The root frame taken straight from a ragdoll's rotation columns. */
function rootFromColumns(f, col, x, y, z) {
  f[0] = col[0]; f[1] = col[1]; f[2] = col[2]
  f[3] = col[3]; f[4] = col[4]; f[5] = col[5]
  f[6] = col[6]; f[7] = col[7]; f[8] = col[8]
  f[9] = x; f[10] = y; f[11] = z
}

/** A child joint: offset in the parent's frame, then rotated by a YXZ triple within it. */
function joint(f, p, ox, oy, oz, swing, lean, yaw) {
  const p0 = p[0], p1 = p[1], p2 = p[2], p3 = p[3], p4 = p[4], p5 = p[5], p6 = p[6], p7 = p[7], p8 = p[8]
  f[9] = p[9] + p0 * ox + p3 * oy + p6 * oz
  f[10] = p[10] + p1 * ox + p4 * oy + p7 * oz
  f[11] = p[11] + p2 * ox + p5 * oy + p8 * oz

  const ca = Math.cos(yaw), sa = Math.sin(yaw)
  const cb = Math.cos(swing), sb = Math.sin(swing)
  const cc = Math.cos(lean), sc = Math.sin(lean)
  const u0x = ca, u0z = -sa
  const u1x = sa * sb, u1y = cb, u1z = ca * sb
  const v0x = u0x * cc + u1x * sc, v0y = u1y * sc, v0z = u0z * cc + u1z * sc
  const v1x = -u0x * sc + u1x * cc, v1y = u1y * cc, v1z = -u0z * sc + u1z * cc
  const v2x = sa * cb, v2y = -sb, v2z = ca * cb

  f[0] = p0 * v0x + p3 * v0y + p6 * v0z
  f[1] = p1 * v0x + p4 * v0y + p7 * v0z
  f[2] = p2 * v0x + p5 * v0y + p8 * v0z
  f[3] = p0 * v1x + p3 * v1y + p6 * v1z
  f[4] = p1 * v1x + p4 * v1y + p7 * v1z
  f[5] = p2 * v1x + p5 * v1y + p8 * v1z
  f[6] = p0 * v2x + p3 * v2y + p6 * v2z
  f[7] = p1 * v2x + p4 * v2y + p7 * v2z
  f[8] = p2 * v2x + p5 * v2y + p8 * v2z
}

/** A hinge — a child that only pitches. Knees, elbows and ankles, which is half of all joints. */
function hinge(f, p, oy, swing) {
  const p0 = p[0], p1 = p[1], p2 = p[2], p3 = p[3], p4 = p[4], p5 = p[5], p6 = p[6], p7 = p[7], p8 = p[8]
  f[9] = p[9] + p3 * oy
  f[10] = p[10] + p4 * oy
  f[11] = p[11] + p5 * oy
  const cb = Math.cos(swing), sb = Math.sin(swing)
  f[0] = p0; f[1] = p1; f[2] = p2
  f[3] = p3 * cb + p6 * sb; f[4] = p4 * cb + p7 * sb; f[5] = p5 * cb + p8 * sb
  f[6] = -p3 * sb + p6 * cb; f[7] = -p4 * sb + p7 * cb; f[8] = -p5 * sb + p8 * cb
}

/** Write a frame into an instance matrix, scaling each axis as it goes. */
function put(mesh, i, f, sx, sy, sz) {
  const a = mesh.instanceMatrix.array, o = i * 16
  a[o] = f[0] * sx; a[o + 1] = f[1] * sx; a[o + 2] = f[2] * sx; a[o + 3] = 0
  a[o + 4] = f[3] * sy; a[o + 5] = f[4] * sy; a[o + 6] = f[5] * sy; a[o + 7] = 0
  a[o + 8] = f[6] * sz; a[o + 9] = f[7] * sz; a[o + 10] = f[8] * sz; a[o + 11] = 0
  a[o + 12] = f[9]; a[o + 13] = f[10]; a[o + 14] = f[11]; a[o + 15] = 1
}

/** An instance nobody should see. An InstancedMesh has no per-instance visibility; this is it. */
function hide(mesh, i) {
  const a = mesh.instanceMatrix.array, o = i * 16
  for (let j = 0; j < 16; j++) a[o + j] = 0
  a[o] = 1e-5; a[o + 5] = 1e-5; a[o + 10] = 1e-5; a[o + 15] = 1
  a[o + 13] = -60
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
/** Shortest signed angle from a to b. */
function wrap(d) {
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

export function createPedestrians(world, scene, signals) {
  const rand = mulberry(20260919)
  // Walkable edges: everything drivable, plus the pedestrian streets, which is where they belong.
  const walkable = world.edges.filter(e => e.length > 8)
  if (walkable.length === 0) return {update() {}, peds: []}

  const geo = buildParts()
  // One material for the lot. Colour is per instance, so sixteen meshes still share one program.
  const mat = new THREE.MeshLambertMaterial()

  const mesh = {}
  const ORDER = ['head', 'hair', 'hairLong', 'chest', 'pelvis',
    'armL', 'armR', 'foreL', 'foreR', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR', 'bag']
  const GEO_OF = {
    head: 'head', hair: 'hair', hairLong: 'hairLong', chest: 'chest', pelvis: 'pelvis',
    armL: 'upperArm', armR: 'upperArm', foreL: 'forearm', foreR: 'forearm',
    thighL: 'thigh', thighR: 'thigh', shinL: 'shin', shinR: 'shin',
    footL: 'foot', footR: 'foot', bag: 'bag',
  }
  for (const name of ORDER) mesh[name] = new THREE.InstancedMesh(geo[GEO_OF[name]], mat, COUNT)
  const parts = ORDER.map(n => mesh[n])
  for (const m of parts) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    m.frustumCulled = false
    // Every limb of a person answers to the same name, so clicking an arm selects "Pedestrian 12".
    m.userData.kind = 'Pedestrian'
  }
  // Shadows from the big parts only. Sixteen shadow-casting meshes is sixteen extra depth passes
  // for silhouettes nobody can tell apart on the ground.
  for (const m of [mesh.chest, mesh.pelvis, mesh.head, mesh.thighL, mesh.thighR, mesh.bag]) {
    m.castShadow = true
  }

  // Edges bucketed by midpoint, so "a street near the car" is a lookup rather than a scan of 2,465.
  const CELL = 64
  const byCell = new Map()
  for (const e of walkable) {
    const mid = e.pts[Math.floor(e.pts.length / 2)]
    const key = `${Math.floor(mid[0] / CELL)}:${Math.floor(mid[1] / CELL)}`
    const bucket = byCell.get(key)
    if (bucket) bucket.push(e)
    else byCell.set(key, [e])
  }

  /** Edges whose midpoint cell is near (x, y) — the candidate set for snapping a crossing. */
  function edgeCandidates(x, y) {
    const found = []
    for (let cx = Math.floor((x - CELL) / CELL); cx <= Math.floor((x + CELL) / CELL); cx++) {
      for (let cy = Math.floor((y - CELL) / CELL); cy <= Math.floor((y + CELL) / CELL); cy++) {
        const bucket = byCell.get(`${cx}:${cy}`)
        if (bucket) for (const e of bucket) found.push(e)
      }
    }
    return found
  }

  /** A walkable edge within `r` of (x, y), or null if that part of town has no streets. */
  function edgeNear(x, y, r) {
    const found = []
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
        const bucket = byCell.get(`${cx}:${cy}`)
        if (bucket) for (const e of bucket) found.push(e)
      }
    }
    return found.length ? found[(rand() * found.length) | 0] : null
  }

  // Real zebra crossings, snapped onto the edge they cross. 739 positions arrive in the data; each
  // becomes a point along a road where a person may legitimately step off the kerb. Without this
  // they cross wherever they happen to turn, which is the single most obviously wrong thing a
  // crowd can do in a city that is otherwise real.
  const crossingsOn = new Map()          // edge id -> [t along the edge]
  for (const [cx, cy] of world.crossings ?? []) {
    let best = null
    for (const e of edgeCandidates(cx, cy)) {
      let run = 0
      for (let i = 1; i < e.pts.length; i++) {
        const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i]
        const dx = bx - ax, dy = by - ay
        const len2 = dx * dx + dy * dy
        const tt = len2 > 0 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / len2)) : 0
        const px = ax + dx * tt, py = ay + dy * tt
        const d2 = (cx - px) ** 2 + (cy - py) ** 2
        const seg = Math.sqrt(len2)
        if (!best || d2 < best.d2) best = {d2, edge: e, t: (run + tt * seg) / e.length}
        run += seg
      }
    }
    if (!best || best.d2 > 18 * 18) continue
    const list = crossingsOn.get(best.edge.id)
    if (list) list.push(best.t)
    else crossingsOn.set(best.edge.id, [best.t])
  }

  const peds = []
  const tint = new THREE.Color()
  const pick = (palette) => palette[(rand() * palette.length) | 0]
  for (let i = 0; i < COUNT; i++) {
    const build = buildFor(rand)
    // Walking pace is personal. A crowd that all moves at exactly 1.25 m/s is a conveyor belt, and
    // the cadence is derived from the pace below so nobody's feet skate.
    const pace = 1.02 + rand() * 0.52
    const ped = {
      edge: walkable[(rand() * walkable.length) | 0],
      t: rand(),                        // 0..1 along the edge
      dir: rand() < 0.5 ? 1 : -1,
      side: rand() < 0.5 ? 1 : -1,      // which pavement
      phase: rand() * Math.PI * 2,      // walk cycle offset, so they are not a chorus line
      build,
      pace,
      lean: 0.03 + rand() * 0.07,       // how far forward they carry themselves
      swagger: 0.85 + rand() * 0.35,    // arm swing, which is most of a person's gait signature
      bag: rand() < BAG_SHARE,
      bagSide: rand() < 0.5 ? 1 : -1,
      // Some people are standing still — waiting, looking at a window, talking. A crowd where
      // every single person is walking at the same pace reads as a conveyor belt.
      idle: rand() < 0.18 ? 2 + rand() * 9 : 0,
      x: 0, y: 0, heading: 0,
      down: 0, flipX: 0, flipY: 0,
      rag: null,
      pose: createPose(),
      gait: 1,                          // 0 standing, 1 walking, up to ~1.6 running
      // Fleeing displacement from the pavement, decayed back like the traffic shunt: the graph
      // position is never corrupted, so they walk on normally once they have calmed down.
      flee: 0, fox: 0, foy: 0, fvx: 0, fvy: 0,
      // Crossing the road: target point on this edge, then progress 0..1 from one kerb to the other.
      crossAt: null, crossing: 0, waiting: false,
    }
    peds.push(ped)

    const bright = rand() < BRIGHT_SHARE
    const shirt = bright ? pick(PED_PALETTE) : pick(DRAB_PALETTE)
    // Keep drawing trousers until they differ from the shirt in VALUE, not just in hue. Hue alone
    // is nearly invisible at twenty metres; the light-dark break at the waist is what splits a
    // figure into a top and a bottom, and without it a person is one solid lozenge.
    let trouser = pick(TROUSER_PALETTE)
    for (let tries = 0; tries < 10 && Math.abs(lum(trouser) - lum(shirt)) < CONTRAST; tries++) {
      trouser = pick(TROUSER_PALETTE)
    }
    const skin = pick(SKIN_PALETTE)
    const bald = rand() < 0.10
    const hatted = rand() < 0.14
    ped.longHair = !bald && !hatted && rand() < 0.34
    ped.bald = bald
    // Long sleeves put the shirt colour down to the wrist; short sleeves leave skin. Which one it
    // is changes the figure's colour blocking more than the shirt colour does.
    const sleeves = rand() < 0.45 ? shirt : skin

    mesh.chest.setColorAt(i, tint.setHex(shirt))
    mesh.armL.setColorAt(i, tint.setHex(shirt))
    mesh.armR.setColorAt(i, tint.setHex(shirt))
    mesh.foreL.setColorAt(i, tint.setHex(sleeves))
    mesh.foreR.setColorAt(i, tint.setHex(sleeves))
    mesh.head.setColorAt(i, tint.setHex(skin))
    mesh.pelvis.setColorAt(i, tint.setHex(trouser))
    mesh.thighL.setColorAt(i, tint.setHex(trouser))
    mesh.thighR.setColorAt(i, tint.setHex(trouser))
    mesh.shinL.setColorAt(i, tint.setHex(trouser))
    mesh.shinR.setColorAt(i, tint.setHex(trouser))
    mesh.footL.setColorAt(i, tint.setHex(pick(SHOE_PALETTE)))
    mesh.footR.setColorAt(i, tint.setHex(pick(SHOE_PALETTE)))
    const hairCol = hatted ? pick(HAT_PALETTE) : pick(HAIR_PALETTE)
    mesh.hair.setColorAt(i, tint.setHex(hairCol))
    mesh.hairLong.setColorAt(i, tint.setHex(hairCol))
    mesh.bag.setColorAt(i, tint.setHex(pick(BAG_PALETTE)))
    ped.hatted = hatted
  }
  for (const m of parts) if (m.instanceColor) m.instanceColor.needsUpdate = true

  scene.add(...parts)
  const crowdParts = parts

  // Scratch frames, reused by every person in turn. Thirteen allocations for the lifetime of the
  // game rather than thirteen per person per frame, which is the GC stutter the budget forbids.
  const F = {
    root: new Float64Array(12), chest: new Float64Array(12), head: new Float64Array(12),
    armL: new Float64Array(12), armR: new Float64Array(12),
    foreL: new Float64Array(12), foreR: new Float64Array(12),
    thighL: new Float64Array(12), thighR: new Float64Array(12),
    shinL: new Float64Array(12), shinR: new Float64Array(12),
    footL: new Float64Array(12), footR: new Float64Array(12), bag: new Float64Array(12),
  }

  /** Position along a polyline at parameter t (0..1 of its length), offset `off` to the side. */
  function place(ped) {
    const pts = ped.edge.pts
    const target = ped.t * ped.edge.length
    let run = 0
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i]
      const seg = Math.hypot(bx - ax, by - ay)
      if (run + seg >= target || i === pts.length - 1) {
        const f = seg > 0 ? Math.min(1, (target - run) / seg) : 0
        const dx = seg > 0 ? (bx - ax) / seg : 1
        const dy = seg > 0 ? (by - ay) / seg : 0
        // Mid-crossing the person is somewhere between the two kerbs, so the offset is
        // interpolated rather than snapped — that interpolation IS the walk across the road.
        const from = ped.side
        const to = -ped.side
        const lane = ped.crossing > 0 ? from + (to - from) * ped.crossing : from
        const off = lane * (ped.edge.width * 0.5 + SIDEWALK)
        ped.x = ax + dx * (f * seg) - dy * off
        ped.y = ay + dy * (f * seg) + dx * off
        ped.heading = Math.atan2(dy * ped.dir, dx * ped.dir)
        return
      }
      run += seg
    }
  }

  /** Where along their edge does a person now stand? Used to rejoin the pavement after a fall. */
  function reproject(ped) {
    const pts = ped.edge.pts
    let run = 0, best = null
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i]
      const dx = bx - ax, dy = by - ay
      const len2 = dx * dx + dy * dy
      const seg = Math.sqrt(len2)
      const tt = len2 > 0 ? clamp(((ped.x - ax) * dx + (ped.y - ay) * dy) / len2, 0, 1) : 0
      const px = ax + dx * tt, py = ay + dy * tt
      const d2 = (ped.x - px) ** 2 + (ped.y - py) ** 2
      if (!best || d2 < best.d2) best = {d2, t: (run + tt * seg) / ped.edge.length}
      run += seg
    }
    if (best) ped.t = clamp(best.t, 0.001, 0.999)
  }

  /**
   * Decide about crossing, wait at the kerb if the traffic has a green, then walk across.
   *
   * Waiting is the detail that makes it read as a city rather than as people teleporting between
   * pavements: someone stands at the kerb, the lights change, and they go.
   */
  function crossings(ped, dt, clock) {
    if (ped.crossing > 0) {
      ped.crossing = Math.min(1, ped.crossing + dt / CROSS_SECONDS)
      if (ped.crossing >= 1) {
        ped.side = -ped.side          // arrived; that pavement is now home
        ped.crossing = 0
        ped.crossAt = null
      }
      return true                      // crossing occupies them; they do not also walk along
    }

    if (ped.crossAt === null) {
      // Occasionally decide to cross at the next zebra ahead on this road.
      if (rand() < CROSS_CHANCE * dt) {
        const list = crossingsOn.get(ped.edge.id)
        if (list && list.length) {
          const ahead = list.filter(t => (ped.dir > 0 ? t > ped.t : t < ped.t))
          if (ahead.length) ped.crossAt = ped.dir > 0 ? Math.min(...ahead) : Math.max(...ahead)
        }
      }
      return false
    }

    // Reached the zebra?
    const reached = ped.dir > 0 ? ped.t >= ped.crossAt : ped.t <= ped.crossAt
    if (!reached) return false

    // At the kerb. If this road has a green for its traffic, wait for it to change.
    const sig = signals?.ahead(ped.edge, ped.dir, clock, ped.x, ped.y)
    if (sig && sig.light === 'green' && sig.dist < 40) {
      ped.waiting = true
      return true
    }
    ped.waiting = false
    ped.crossing = 0.0001
    return true
  }

  function step(ped, dt) {
    const speed = ped.pace * ped.gait
    if (ped.idle > 0) {
      ped.idle -= dt
      ped.phase += dt * 0.7            // a slight sway, not a frozen statue
      return
    }
    ped.t += (ped.dir * speed * dt) / ped.edge.length
    if (ped.t > 1 || ped.t < 0) {
      // At a junction, pick any other edge leaving it and carry on. A pedestrian that turns round
      // at every corner reads as broken; one that wanders reads as a person with somewhere to be.
      const nodeId = ped.t > 1 ? ped.edge.b : ped.edge.a
      const options = world.nodes[nodeId]?.edges ?? []
      const next = options.length > 0 ? world.edges[options[(rand() * options.length) | 0]] : ped.edge
      ped.edge = next
      // Enter the new edge from whichever end we arrived at.
      const enteredAtA = next.a === nodeId
      ped.t = enteredAtA ? 0.001 : 0.999
      ped.dir = enteredAtA ? 1 : -1
    }
    advance(ped, dt, speed)
  }

  /**
   * Advance the walk cycle at the cadence the pace demands.
   *
   * A stride covers 2 * legLength * sin(amplitude) metres, so the phase rate falls out of the pace
   * rather than being a constant. Get this wrong in either direction and the feet skate along the
   * pavement, which is the single loudest "this is an animation" tell there is.
   */
  function advance(ped, dt, speed) {
    const amp = strideOf(ped)
    const stride = 2 * LEG * ped.build.scale * Math.sin(amp)
    ped.phase += dt * Math.PI * speed / Math.max(0.25, stride)
    // Kept in [0, 4pi) rather than subtracted once: a single conditional subtraction leaves the
    // phase wherever a long frame put it, and it drifts negative over a session.
    const TURN = Math.PI * 4
    if (ped.phase < 0 || ped.phase >= TURN) ped.phase -= Math.floor(ped.phase / TURN) * TURN
  }

  /** How far the legs swing. Longer at a run, nothing at all standing still. */
  function strideOf(ped) {
    return 0.20 + 0.26 * Math.min(1.7, ped.gait)
  }

  // --- the walk ----------------------------------------------------------------------------------
  /**
   * Fill a pose from the walk cycle.
   *
   * The whole figure comes out of one phase angle. Legs swing in opposition; knees flex through the
   * SWING half and again at toe-off, which is the difference between walking and marching; arms
   * counter the legs; and the shoulders and hips twist against each other, because a person walking
   * is a body rotating about its own spine and a doll is not.
   */
  function walkPose(ped, pose, clock) {
    const p = ped.phase
    const s = Math.sin(p), c = Math.cos(p)
    const amp = strideOf(ped) * (ped.idle > 0 ? 0 : 1)
    const run = Math.max(0, ped.gait - 1)

    // Legs. Positive swing is backward, so a leg is furthest FORWARD at phase 3pi/2.
    const hipL = amp * s
    const hipR = -amp * s
    pose.hipLs = hipL
    pose.hipRs = hipR
    pose.kneeL = kneeFlex(p, amp, run)
    pose.kneeR = kneeFlex(p + Math.PI, amp, run)
    // The ankle: flat through mid-stance, TOE DOWN at push-off, TOE UP at heel strike. Those two
    // are the ends of the cycle and they are what a foot is for. Held at a right angle throughout,
    // the trailing foot leaves the ground as an L-bracket and the leading one lands flat, which
    // together are the difference between walking and being slid along on rails.
    const push = 0.62, heel = 0.38
    const flat = -(hipL + pose.kneeL), flatR = -(hipR + pose.kneeR)
    pose.ankL = clamp(flat + push * Math.max(0, s) ** 1.4 - heel * Math.max(0, -s) ** 1.6, -1.05, 0.40)
    pose.ankR = clamp(flatR + push * Math.max(0, -s) ** 1.4 - heel * Math.max(0, s) ** 1.6, -1.05, 0.40)
    pose.hipLz = 0.02
    pose.hipRz = -0.02

    // Arms counter the legs, and the elbow bends more on the forward swing than the back one.
    const swing = -hipL * 0.62 * ped.swagger * (1 + run * 0.5)
    pose.shLs = swing
    pose.shRs = -swing
    const out = 0.11 + (ped.build.shoulder - 0.95) * 0.35 + run * 0.06
    pose.shLz = out
    pose.shRz = -out
    // An arm is never straight while walking. A resting flexion of about 20 degrees, opening on
    // the back swing and closing to nearly 60 on the forward one — an arm that reaches forward
    // straight is a zombie reach, and it is one of the loudest stiffness tells at distance.
    pose.elbL = 0.34 + 2.05 * Math.max(0, -swing) - 0.18 * Math.max(0, swing) + run * 0.55
    pose.elbR = 0.34 + 2.05 * Math.max(0, swing) - 0.18 * Math.max(0, -swing) + run * 0.55
    // A carried bag keeps that arm still and away from the body; it is not swinging with a bag on it.
    if (ped.bag) {
      if (ped.bagSide > 0) { pose.shLs *= 0.25; pose.elbL = 0.32; pose.shLz = out * 1.5 }
      else { pose.shRs *= 0.25; pose.elbR = 0.32; pose.shRz = -out * 1.5 }
    }

    // Spine. The chest twists against the pelvis, dips toward the swinging leg, and breathes.
    // With the pelvis yawing +7 degrees with the leading leg, this puts about 8 degrees of
    // counter-rotation into the shoulders — the transverse twist that stops a walking figure
    // reading as a cardboard cut-out sliding along a rail when you pass it at an angle.
    pose.twist = -0.26 * s * (1 + run * 0.4)
    pose.spine = -0.02 + 0.03 * Math.abs(c) + Math.sin(clock * 1.6 + ped.phase * 0.1) * 0.012
    pose.spineZ = 0.035 * c
    // The head stays level while the body rolls under it, which is a real thing bodies do and a
    // surprisingly strong cue: a head that bobs with the shoulders reads as a puppet on a stick.
    // It is also carried slightly AHEAD of the spine rather than stacked on it.
    pose.headZ = -pose.spineZ * 0.8
    pose.neck = 0.13 - pose.spine * 0.5
  }

  /** Knee flexion through the cycle: a big lobe through the swing, a small one at toe-off. */
  function kneeFlex(p, amp, run) {
    const swingLobe = Math.max(0, -Math.cos(p))
    const toeOff = Math.max(0, Math.sin(p))
    return 0.08 + (2.1 + run * 1.4) * amp * swingLobe ** 1.15 + (0.75 + run) * amp * toeOff ** 2
  }

  /**
   * Standing height of the hips: whichever foot can reach the ground is the one that is on it.
   *
   * This is where the vertical bob comes from, and it comes for free — nobody authors it. At
   * mid-stance the leg is straight and the hips are at their highest; with the legs split they
   * cannot reach as far and the hips drop about 6cm, twice per cycle, which is the real thing.
   *
   * The dorsiflexion term matters: lift the toe and the HEEL becomes the lowest point of the foot,
   * a couple of centimetres below where a flat sole would be, and without it the leading foot
   * sinks into the road on every step.
   */
  function hipHeight(pose, k) {
    const heelL = 0.062 * Math.max(0, -pose.ankL), heelR = 0.062 * Math.max(0, -pose.ankR)
    const reachL = THIGH * Math.cos(pose.hipLs) + SHIN * Math.cos(pose.hipLs + pose.kneeL) + ANKLE + heelL
    const reachR = THIGH * Math.cos(pose.hipRs) + SHIN * Math.cos(pose.hipRs + pose.kneeR) + ANKLE + heelR
    return Math.max(reachL, reachR) * k
  }

  // --- drawing -------------------------------------------------------------------------------
  /**
   * Draw one figure from its root frame and its pose. The only place the meshes are touched.
   *
   * Used by BOTH the walk and the ragdoll: the root frame is a yaw for one and a tumbling
   * quaternion for the other, and everything below the hips is identical.
   */
  function drawFigure(i, ped, pose) {
    const b = ped.build
    const k = b.scale
    const limb = b.limb * k
    const root = F.root

    joint(F.chest, root, 0, WAIST * k, 0, pose.spine, pose.spineZ, pose.twist)
    joint(F.head, F.chest, 0, NECK_Y * k, 0, pose.neck, pose.headZ, pose.headYaw)

    const sho = SHO_HALF * b.shoulder * k
    joint(F.armL, F.chest, sho, CHEST_H * k, 0, pose.shLs, pose.shLz, 0)
    joint(F.armR, F.chest, -sho, CHEST_H * k, 0, pose.shRs, pose.shRz, 0)
    // Elbows bend the opposite way to knees — a hand comes up in FRONT of the body — so the
    // flexion, which is a positive number everywhere in the pose, is negated on the way in.
    hinge(F.foreL, F.armL, -UARM * k, -pose.elbL)
    hinge(F.foreR, F.armR, -UARM * k, -pose.elbR)

    const hip = HIP_HALF * b.hipW * k
    joint(F.thighL, root, hip, 0, 0, pose.hipLs, pose.hipLz, 0)
    joint(F.thighR, root, -hip, 0, 0, pose.hipRs, pose.hipRz, 0)
    hinge(F.shinL, F.thighL, -THIGH * k, pose.kneeL)
    hinge(F.shinR, F.thighR, -THIGH * k, pose.kneeR)
    hinge(F.footL, F.shinL, -SHIN * k, pose.ankL)
    hinge(F.footR, F.shinR, -SHIN * k, pose.ankR)

    put(mesh.pelvis, i, root, k * b.hipW, k, k * b.depth)
    put(mesh.chest, i, F.chest, k * b.shoulder, k, k * b.depth)
    put(mesh.head, i, F.head, k, k, k)
    if (ped.bald) hide(mesh.hair, i)
    else put(mesh.hair, i, F.head, k * (ped.hatted ? 1.1 : 1), k * (ped.hatted ? 1.12 : 1), k * (ped.hatted ? 1.1 : 1))
    if (ped.longHair) put(mesh.hairLong, i, F.head, k, k, k)
    else hide(mesh.hairLong, i)
    put(mesh.armL, i, F.armL, limb, k, limb)
    put(mesh.armR, i, F.armR, limb, k, limb)
    put(mesh.foreL, i, F.foreL, limb, k, limb)
    put(mesh.foreR, i, F.foreR, limb, k, limb)
    put(mesh.thighL, i, F.thighL, limb, k, limb)
    put(mesh.thighR, i, F.thighR, limb, k, limb)
    put(mesh.shinL, i, F.shinL, limb, k, limb)
    put(mesh.shinR, i, F.shinR, limb, k, limb)
    put(mesh.footL, i, F.footL, limb, k, limb)
    put(mesh.footR, i, F.footR, limb, k, limb)
    if (ped.bag) {
      // Hanging from a hand, so it swings with the arm that carries it — but only half as far as
      // the wrist does: a heavy bag hangs closer to plumb than the arm holding it.
      const hand = ped.bagSide > 0 ? F.foreL : F.foreR
      const elbow = ped.bagSide > 0 ? pose.elbL : pose.elbR
      hinge(F.bag, hand, -(FARM + 0.05) * k, elbow * 0.5)
      put(mesh.bag, i, F.bag, k, k, k)
    } else {
      hide(mesh.bag, i)
    }
  }

  return {
    peds,
    /** Debug lever: hide every instanced body part at once. */
    setVisible(v) { for (const m of crowdParts) m.visible = v },
    /**
     * `car` supplies the point the heads look at, and the energy of anything it hits.
     *
     * `eye` is the camera position in world metres. Anything within a couple of metres of it is
     * BETWEEN the camera and the car, and fills the screen as an unrecognisable wall of colour —
     * a pedestrian two metres from the lens is a blue rectangle over the speedometer. They are
     * scaled to nothing rather than skipped, because an InstancedMesh has no per-instance
     * visibility and a stale matrix would leave them frozen where they were.
     */
    update(dt, car, clock = 0, eye = null) {
      for (let i = 0; i < peds.length; i++) {
        const ped = peds[i]
        const k = ped.build.scale

        // Struck. `police.knock` sets `down` and a flip direction; the first frame on which that is
        // true is the impact, and the car's own velocity at that instant is the whole grading. The
        // police file is not ours to change, so the strike is DETECTED here rather than announced —
        // and it means the energy comes off the car, which the knock call never carried.
        if (ped.down > 0 && !ped.rag) {
          const speed = Math.hypot(car.vx, car.vy)
          const inv = 1 / (speed || 1)
          let ax = ped.flipX, ay = ped.flipY
          const alen = Math.hypot(ax, ay) || 1
          ax /= alen; ay /= alen
          ped.rag = strikeRagdoll({
            facing: ped.heading + Math.PI / 2,
            scale: k,
            x: ped.x, z: -ped.y,
            travelX: car.vx * inv, travelZ: -car.vy * inv,
            awayX: ax, awayZ: -ay,
            speed: Math.max(Math.abs(car.speed), speed),
            pose: ped.pose,
            rand,
          })
          // Hold them out of circulation for exactly as long as the sequence takes, so the police
          // do not re-run them over mid-tumble and nobody stands up early.
          ped.down = ragdollDuration(ped.rag)
        }

        if (ped.rag) {
          const rag = ped.rag
          ped.down = Math.max(0.01, ped.down - dt)
          stepRagdoll(rag, dt)
          ped.x = rag.x
          ped.y = -rag.z
          if (rag.done) {
            // Back on their feet somewhere other than where they were standing: rejoin the graph at
            // the nearest point and carry the leftover as a decaying offset, so they WALK back to
            // the pavement rather than snapping to it.
            const wasX = ped.x, wasY = ped.y
            reproject(ped)
            place(ped)
            ped.fox = clamp(wasX - ped.x, -6, 6)
            ped.foy = clamp(wasY - ped.y, -6, 6)
            ped.fvx = 0; ped.fvy = 0; ped.flee = 0
            ped.x = wasX; ped.y = wasY
            ped.rag = null
            ped.down = 0
            ped.flipX = 0; ped.flipY = 0
            ped.idle = 0.8 + rand() * 1.5     // a moment to gather themselves before walking on
          } else {
            rootFromColumns(F.root, rag.col, rag.x, groundAt(ped.x, ped.y) + rag.y, rag.z)
            drawFigure(i, ped, rag.pose)
            continue
          }
        }

        const busy = crossings(ped, dt, clock)
        // Fleeing IS running: a scared person does not stroll away at 1.2 m/s.
        const want = ped.flee > 0 ? 1.65 : 1
        ped.gait += (want - ped.gait) * Math.min(1, dt * 6)
        if (!busy) step(ped, dt)
        else if (!ped.waiting) advance(ped, dt, ped.pace * ped.gait)
        place(ped)

        // Scatter. A car bearing down at speed sends people away from it and, crucially, AWAY FROM
        // THE ROAD — running directly away would keep them in front of the bumper. The push is
        // perpendicular to the car's travel, which is what sends them onto the kerb.
        const cdx = ped.x - car.x, cdy = ped.y - car.y
        const near2 = cdx * cdx + cdy * cdy
        if (Math.abs(car.speed) > SCARE_SPEED && near2 < SCARE_RANGE * SCARE_RANGE) {
          // cdx/cdy point FROM the car TO the person, so the dot product with the car velocity is
          // positive exactly when it is bearing down on them. Negating it, as I first did, made the
          // test true only when driving AWAY — the scatter could never fire.
          const closing = car.vx * cdx + car.vy * cdy
          if (closing > 0) {
            const side = (car.vx * cdy - car.vy * cdx) > 0 ? 1 : -1
            const cs = Math.hypot(car.vx, car.vy) || 1
            // Perpendicular to the car's heading, on whichever side they already are.
            const px = (-car.vy / cs) * side, py = (car.vx / cs) * side
            const urgency = 1 - Math.sqrt(near2) / SCARE_RANGE
            ped.fvx += px * urgency * 26 * dt
            ped.fvy += py * urgency * 26 * dt
            ped.flee = FLEE_TIME
          }
        }

        if (ped.flee > 0 || ped.fox || ped.foy) {
          ped.flee = Math.max(0, ped.flee - dt)
          ped.fox += ped.fvx * dt
          ped.foy += ped.fvy * dt
          const drag = Math.exp(-3.4 * dt)
          ped.fvx *= drag
          ped.fvy *= drag
          // Only walk back to the pavement once the fright has passed.
          if (ped.flee <= 0) {
            const settle = Math.exp(-1.6 * dt)
            ped.fox *= settle
            ped.foy *= settle
            if (Math.abs(ped.fox) < 0.02 && Math.abs(ped.foy) < 0.02) { ped.fox = 0; ped.foy = 0 }
          }
          ped.x += ped.fox
          ped.y += ped.foy
        }

        // A fixed population scattered over the whole slice puts nobody where the player is: 140
        // people across 2,465 streets measured ZERO within 60m of the car. So the crowd travels —
        // anyone left far behind is recycled onto a street near the player, out of sight.
        const dx0 = ped.x - car.x, dy0 = ped.y - car.y
        if (dx0 * dx0 + dy0 * dy0 > RECYCLE_AT * RECYCLE_AT) {
          const fresh = edgeNear(car.x, car.y, RECYCLE_RING)
          if (fresh) {
            ped.edge = fresh
            ped.t = rand()
            ped.dir = rand() < 0.5 ? 1 : -1
            ped.side = rand() < 0.5 ? 1 : -1
            place(ped)
          }
        }

        const pose = ped.pose
        walkPose(ped, pose, clock)

        // The head tracks the car when it is close, and faces along the walk otherwise — but only
        // as far as a neck actually turns. Somebody watching a car go past behind them has to give
        // up at about 70 degrees, and that limit is more convincing than the tracking is.
        const dx = car.x - ped.x, dy = car.y - ped.y
        const facing = ped.heading + Math.PI / 2
        // The pelvis leads the turn and the chest lags it — the counter-rotation that makes a walk
        // a walk. The head is aimed against the SUM of the two, or it swings with the hips.
        const pelvisTwist = 0.12 * Math.sin(ped.phase)
        if (dx * dx + dy * dy < LOOK_RANGE * LOOK_RANGE) {
          const look = Math.atan2(dy, dx) + Math.PI / 2
          pose.headYaw = clamp(wrap(look - facing - pelvisTwist - pose.twist), -1.25, 1.25)
        } else {
          pose.headYaw *= 0.85
        }

        rootFrame(F.root, ped.x, groundAt(ped.x, ped.y) + hipHeight(pose, k), -ped.y,
          facing + pelvisTwist, ped.lean + 0.12 * Math.max(0, ped.gait - 1),
          0.022 * Math.cos(ped.phase))
        drawFigure(i, ped, pose)
      }

      if (eye) {
        for (let i = 0; i < peds.length; i++) {
          const q = peds[i]
          const dx = q.x - eye.x, dy = q.y - eye.y
          if (dx * dx + dy * dy < LENS_RADIUS * LENS_RADIUS) for (const m of parts) hide(m, i)
        }
      }
      for (const m of parts) m.instanceMatrix.needsUpdate = true
    },
  }
}
