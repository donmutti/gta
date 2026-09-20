// What a broken prop LOOKS like.
//
// The physics decides that a tree came down (src/game/car.js against the point grid in
// src/world/model.js); this file is the only thing that knows what that looks like, and it is built
// around one hard constraint: the city's roadside furniture is INSTANCED. Trees are tiled
// InstancedMeshes of twelve thousand; lamps are one mesh of five thousand; each kind of furniture is
// one mesh of a few hundred. Pulling a broken prop out of its mesh means rebuilding the mesh, and
// giving it its own animated Mesh with its own material means the performance budget of this project
// (the whole city in under twenty draw calls) is gone the first time somebody flattens a bus stop.
//
// So nothing is ever created when something breaks. Two moves only:
//
//  1. REWRITE THE INSTANCE MATRIX. A prop's geometry has its origin at the base, so a rotation about
//     a horizontal axis through that origin tips the thing over exactly the way it would really fall
//     — a tree goes down trunk and crown together, a lamp column swings to the gutter, a shelter
//     lands on its side. This costs one matrix write per frame per falling prop and no new object at
//     all, and it is why a break here is a TOPPLE rather than a disappearance. Parts that should not
//     survive the fall (a shelter's glass) get a zero-scale matrix instead, which is the cheapest
//     possible "gone" in an instanced mesh.
//
//  2. SPAWN FROM A POOL. Chunks come out of one fixed InstancedMesh of tinted shards, leftovers out
//     of two more (a stump and a torn base plate). Three meshes, three materials, for every break in
//     the city forever; when the pool is full the oldest chunk is recycled, because a shard nobody is
//     looking at any more is the right thing to lose.
//
// The debris READS rather than simulates. Ballistic arcs, one bounce, a settle, and a fade — no
// rigid bodies, no contacts between chunks, no rolling. A player watching a tree come down at forty
// is looking at the tree, and every frame spent solving chunk-on-chunk contacts would be spent on
// something nobody sees. What they do notice is whether anything is LEFT: a tree that vanishes reads
// as a bug, so a break always leaves its stump or its sheared-off base plate standing there
// afterwards as the record that you did this.
import * as THREE from 'three';

/** Chunks alive at once. Roughly twelve full trees' worth, which no player reaches on one street. */
const CHUNK_CAP = 320;
/** Leftovers kept before the oldest is recycled. A long session will not exhaust it. */
const MARK_CAP = 160;
/** How many props may be mid-fall at once. Beyond this the oldest is snapped flat. */
const FALL_CAP = 24;

/** Seconds a chunk lives, and how long it spends shrinking away at the end of that. */
const CHUNK_LIFE = 7.5;
const CHUNK_FADE = 1.1;
/** Heavier than real gravity on purpose: at this scale true 9.81 reads as debris falling in syrup. */
const GRAVITY = 17;
/** Seconds a prop takes to go over. Slow enough to watch, fast enough not to look weightless. */
const FALL_TIME = 0.85;
/** A little past the horizontal, so a felled thing settles flat instead of balancing on its edge. */
const FALL_ANGLE = Math.PI / 2 + 0.06;

/**
 * Per-kind recipe: what flies off, how much of it, and what is left standing.
 *
 * `tint` is the palette a burst draws from at random — the colours of the prop's own materials, plus
 * one contrast note that carries the idea of the break (a warm lamp lens, pale glass, paper out of a
 * bin, a white plume off a hydrant). `mark` is the leftover: 'stump' for anything that grew,
 * 'plate' for anything that was bolted down, null for something that leaves nothing.
 */
const RECIPE = {
  tree:    {chunks: 14, tint: [0x554033, 0x6b4a33, 0x463327, 0x3f6b3a, 0x4a7a41], mark: 'stump', spread: 4.2, lift: 4.4},
  lamp:    {chunks: 8,  tint: [0x2b2f36, 0x3a3f47, 0x22262c, 0xffd9a0],           mark: 'plate', spread: 3.4, lift: 3.6},
  shelter: {chunks: 18, tint: [0xbcd2dd, 0xcfe2ea, 0x424a4f, 0x30343b, 0x7a5230], mark: 'plate', spread: 5.0, lift: 4.0},
  hydrant: {chunks: 11, tint: [0xb02a20, 0x8e2018, 0x373f43, 0xe8f0f4, 0xdfeaf2], mark: 'plate', spread: 3.8, lift: 5.2},
  bin:     {chunks: 10, tint: [0x3c4a41, 0x313f39, 0xd8d2c4, 0xe6e0d2],           mark: 'plate', spread: 3.6, lift: 3.4},
  bench:   {chunks: 11, tint: [0x7a5230, 0x5c3d24, 0x8a5f38, 0x373f43],           mark: 'plate', spread: 3.6, lift: 3.0},
  bike:    {chunks: 8,  tint: [0x373f43, 0x4c545a, 0x2b3035],                     mark: 'plate', spread: 3.4, lift: 3.2},
  sign:    {chunks: 7,  tint: [0x424a4f, 0x21518f, 0x2f6ab0],                     mark: 'plate', spread: 3.2, lift: 3.4},
};
/** A hit that counted but did not fell: a few chips off the same palette, no leftover, no topple. */
const SCAR_CHUNKS = 4;

/** A shard: a tetrahedron roughened per-vertex so no two faces are parallel. ~4 tris. */
function shardGeometry() {
  const g = new THREE.TetrahedronGeometry(0.17, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const h = Math.sin(i * 12.9898) * 43758.5453;
    const j = 0.7 + 0.6 * (h - Math.floor(h));
    p.setXYZ(i, p.getX(i) * j, p.getY(i) * j * 0.8, p.getZ(i) * j);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * The destruction driver. `groundAt(x, z)` is the terrain height in THREE coordinates, so debris
 * settles on the hillside rather than on the y=0 plane (it returns 0 while the terrain is switched
 * off, and this code does not need to know which).
 *
 * Returns {group, felled, scarred, update, stats} — add `group` to the scene once, call `update(dt)`
 * every frame, and call `felled`/`scarred` from whatever drains the model's break queue.
 */
export function createDestruction(groundAt = () => 0) {
  const group = new THREE.Group();
  group.name = 'destruction';

  // --- the chunk pool: one mesh, one material, tinted per instance ---------------------------
  const chunkMesh = new THREE.InstancedMesh(
    shardGeometry(), new THREE.MeshLambertMaterial({color: 0xffffff}), CHUNK_CAP);
  chunkMesh.castShadow = true;
  chunkMesh.frustumCulled = false;      // debris is always near the car, and it MOVES every frame
  chunkMesh.userData.baked = true;      // not a pickable object in the editor: it is transient
  group.add(chunkMesh);

  // --- the leftovers: a sawn stump for anything that grew, a torn base plate for anything bolted
  // down. Both are ring buffers of permanent instances — nothing about them animates. -----------
  // Seven-sided and a touch wider at the root, so a sawn-off bole reads at a glance rather than
  // looking like a peg somebody left in the pavement.
  const stumpG = new THREE.CylinderGeometry(0.34, 0.46, 0.42, 7); stumpG.translate(0, 0.21, 0);
  const stumpMesh = new THREE.InstancedMesh(
    stumpG, new THREE.MeshLambertMaterial({color: 0x4b3a2c}), MARK_CAP);
  stumpMesh.castShadow = true;
  stumpMesh.userData.baked = true;
  group.add(stumpMesh);

  const plateG = new THREE.CylinderGeometry(0.2, 0.24, 0.05, 6); plateG.translate(0, 0.025, 0);
  const plateMesh = new THREE.InstancedMesh(
    plateG, new THREE.MeshLambertMaterial({color: 0x30363c}), MARK_CAP);
  plateMesh.userData.baked = true;
  group.add(plateMesh);

  // Every instance of both pools starts at zero scale — an unused instance of an InstancedMesh sits
  // at the origin at full size otherwise, which would pile a hundred and sixty stumps on the map's
  // centre point before anything had been broken at all.
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < CHUNK_CAP; i++) chunkMesh.setMatrixAt(i, ZERO);
  for (let i = 0; i < MARK_CAP; i++) { stumpMesh.setMatrixAt(i, ZERO); plateMesh.setMatrixAt(i, ZERO); }
  chunkMesh.instanceMatrix.needsUpdate = true;
  stumpMesh.instanceMatrix.needsUpdate = true;
  plateMesh.instanceMatrix.needsUpdate = true;

  // --- pool state -----------------------------------------------------------------------------
  const chunks = [];
  for (let i = 0; i < CHUNK_CAP; i++) {
    chunks.push({live: false, age: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
                 sx: 1, sy: 1, sz: 1, rest: false,
                 q: new THREE.Quaternion(), spin: new THREE.Quaternion()});
  }
  let chunkNext = 0;          // ring cursor: the oldest chunk is the next one overwritten
  let stumpNext = 0, plateNext = 0;
  const falls = [];           // props currently going over
  const stats = {felled: 0, scarred: 0, chunksSpawned: 0};

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
  const v = new THREE.Vector3(), s = new THREE.Vector3(), axis = new THREE.Vector3();
  const col = new THREE.Color();
  const rnd = (a, b) => a + Math.random() * (b - a);

  /** Compose a prop's instance transform with `angle` radians of lean toward (dirX, dirZ). */
  function leanMatrix(ref, angle, dirX, dirZ) {
    const len = Math.hypot(dirX, dirZ) || 1;
    // The axis that tips +Y toward the fall direction is up × direction — see the check in the
    // commit that added this: for a fall along +X the axis is -Z, and Y swings to +X.
    axis.set(dirZ / len, 0, -dirX / len);
    q.setFromAxisAngle(axis, angle);
    qy.setFromAxisAngle(UP, ref.rotY ?? 0);
    q.multiply(qy);
    v.set(ref.x, ref.y, ref.z);
    s.setScalar(ref.scale ?? 1);
    return m.compose(v, q, s);
  }

  function writeFall(ref, angle, dirX, dirZ) {
    const mat = leanMatrix(ref, angle, dirX, dirZ);
    for (const im of ref.topple) { im.setMatrixAt(ref.i, mat); im.instanceMatrix.needsUpdate = true; }
  }

  /** Hide the parts that do not survive the fall, and any light the prop was casting. */
  function hideParts(ref) {
    for (const im of (ref.hide ?? [])) { im.setMatrixAt(ref.i, ZERO); im.instanceMatrix.needsUpdate = true; }
    // The lamp glow is a Points cloud, not an instanced mesh, so its one vertex is sunk out of the
    // world instead. A toppled lamp that keeps glowing eight metres up is the tell that would give
    // the whole trick away.
    if (ref.glow) {
      ref.glow.attr.setY(ref.glow.i, -400);
      ref.glow.attr.needsUpdate = true;
    }
  }

  function burst(x, y, z, recipe, count, dirX, dirZ, energy) {
    // Harder hits throw further. Capped, or a fifty-km/h lamp post reaches the next street.
    const punch = Math.min(1.8, 0.7 + Math.sqrt(Math.max(energy, 1)) / 11);
    const len = Math.hypot(dirX, dirZ) || 1;
    const fx = dirX / len, fz = dirZ / len;
    for (let n = 0; n < count; n++) {
      const at = chunkNext;
      chunkNext = (chunkNext + 1) % CHUNK_CAP;
      const c = chunks[at];
      c.live = true; c.rest = false; c.age = 0;
      c.x = x + rnd(-0.35, 0.35);
      c.y = y + rnd(0.25, 1.6);
      c.z = z + rnd(-0.35, 0.35);
      // Along the blow, fanned out to either side, and up. The fan is what makes it read as a
      // shatter rather than as a shotgun.
      const fan = rnd(-0.9, 0.9);
      const speed = rnd(0.35, 1) * recipe.spread * punch;
      c.vx = (fx * Math.cos(fan) - fz * Math.sin(fan)) * speed;
      c.vz = (fz * Math.cos(fan) + fx * Math.sin(fan)) * speed;
      c.vy = rnd(0.35, 1) * recipe.lift * punch;
      c.sx = rnd(0.55, 1.35); c.sy = rnd(0.45, 1.2); c.sz = rnd(0.55, 1.35);
      c.q.set(Math.random(), Math.random(), Math.random(), Math.random()).normalize();
      // Spin as a small per-second delta quaternion, multiplied in each frame. Cheaper than
      // carrying angular velocity and re-deriving a quaternion from it, and looks identical.
      c.spin.setFromAxisAngle(
        axis.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize(), rnd(3, 11));
      col.set(recipe.tint[(Math.random() * recipe.tint.length) | 0]);
      chunkMesh.setColorAt(at, col);
      stats.chunksSpawned++;
    }
    if (chunkMesh.instanceColor) chunkMesh.instanceColor.needsUpdate = true;
  }

  function leaveMark(ref, recipe) {
    if (recipe.mark === 'stump') {
      v.set(ref.x, ref.y, ref.z);
      q.setFromAxisAngle(UP, Math.random() * Math.PI);
      s.setScalar(ref.scale ?? 1);
      stumpMesh.setMatrixAt(stumpNext, m.compose(v, q, s));
      stumpMesh.instanceMatrix.needsUpdate = true;
      stumpNext = (stumpNext + 1) % MARK_CAP;
    } else if (recipe.mark === 'plate') {
      v.set(ref.x, ref.y + 0.01, ref.z);
      q.setFromAxisAngle(UP, ref.rotY ?? 0);
      s.setScalar(ref.scale ?? 1);
      plateMesh.setMatrixAt(plateNext, m.compose(v, q, s));
      plateMesh.instanceMatrix.needsUpdate = true;
      plateNext = (plateNext + 1) % MARK_CAP;
    }
  }

  return {
    group,
    stats,

    /**
     * It came down. `ref` is the opaque handle the renderer registered with the world model,
     * `kind` keys RECIPE, and (dirX, dirZ) is the direction the car was travelling in THREE
     * coordinates — the thing falls the way it was hit.
     */
    felled(ref, kind, dirX, dirZ, energy = 0) {
      const recipe = RECIPE[kind];
      if (!ref || !recipe) return;
      hideParts(ref);
      leaveMark(ref, recipe);
      burst(ref.x, ref.y, ref.z, recipe, recipe.chunks, dirX, dirZ, energy);
      if (ref.topple?.length) {
        // Over the cap, the oldest faller is snapped flat rather than dropped mid-air.
        if (falls.length >= FALL_CAP) {
          const old = falls.shift();
          writeFall(old.ref, FALL_ANGLE, old.dirX, old.dirZ);
        }
        falls.push({ref, dirX, dirZ, t: 0});
      }
      stats.felled++;
    },

    /**
     * It took a hit that counted and stayed up. A handful of chips, nothing else: the point is that
     * the player can tell a tree that is nearly down from one nobody has touched.
     */
    scarred(ref, kind, dirX, dirZ, energy = 0) {
      const recipe = RECIPE[kind];
      if (!ref || !recipe) return;
      burst(ref.x, ref.y + 0.4, ref.z, recipe, SCAR_CHUNKS, dirX, dirZ, energy);
      stats.scarred++;
    },

    update(dt) {
      // --- props going over ---------------------------------------------------------------
      for (let i = falls.length - 1; i >= 0; i--) {
        const f = falls[i];
        f.t += dt / FALL_TIME;
        // Accelerating, like a real fall: slow off the vertical, fast into the ground. Squaring
        // the parameter is the whole of it, and it is the difference between a tree falling and a
        // tree being rotated by a program.
        const eased = Math.min(1, f.t) ** 2;
        writeFall(f.ref, FALL_ANGLE * eased, f.dirX, f.dirZ);
        if (f.t >= 1) falls.splice(i, 1);
      }

      // --- chunks ------------------------------------------------------------------------
      let dirty = false;
      for (let i = 0; i < CHUNK_CAP; i++) {
        const c = chunks[i];
        if (!c.live) continue;
        c.age += dt;
        if (c.age >= CHUNK_LIFE) {
          c.live = false;
          chunkMesh.setMatrixAt(i, ZERO);
          dirty = true;
          continue;
        }
        if (!c.rest) {
          c.vy -= GRAVITY * dt;
          c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
          const floor = groundAt(c.x, c.z) + 0.07;
          if (c.y <= floor) {
            c.y = floor;
            // One bounce with most of the energy gone, then it stops. Two bounces would be more
            // correct and nobody has ever noticed the difference on a piece of bark.
            if (c.vy < -1.4) { c.vy = -c.vy * 0.3; c.vx *= 0.55; c.vz *= 0.55; }
            else { c.rest = true; c.vx = c.vy = c.vz = 0; }
          }
          if (!c.rest) c.q.multiply(slerpDelta(c.spin, dt)).normalize();
        }
        const fade = c.age > CHUNK_LIFE - CHUNK_FADE
          ? Math.max(0, (CHUNK_LIFE - c.age) / CHUNK_FADE) : 1;
        v.set(c.x, c.y, c.z);
        s.set(c.sx * fade, c.sy * fade, c.sz * fade);
        chunkMesh.setMatrixAt(i, m.compose(v, c.q, s));
        dirty = true;
      }
      if (dirty) chunkMesh.instanceMatrix.needsUpdate = true;
    },
  };
}

const UP = new THREE.Vector3(0, 1, 0);
/** A spin quaternion scaled to this frame: a partial rotation toward the per-second one. */
const IDENTITY = new THREE.Quaternion();
const _delta = new THREE.Quaternion();
function slerpDelta(perSecond, dt) {
  return _delta.copy(IDENTITY).slerp(perSecond, Math.min(1, dt));
}
