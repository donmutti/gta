// A pedestrian struck by a car.
//
// The old knockdown snapped the figure flat in a single frame and scattered its limbs to fixed
// offsets, which is why it read as a doll coming apart rather than as a body being hit. This is the
// replacement: a small rigid-body sim for the trunk, plus passive springs for the limbs.
//
// The trunk is ONE rigid body — a rod from the hips through the head, carrying a position, a
// velocity, a quaternion and an angular velocity. It is launched by the impact, falls under gravity,
// and resolves against the pavement at five contact points strung along its length (head, shoulders,
// hips, knees, feet). Contacts are what make it read: a body that lands head-first pitches over
// because the impulse is applied off the centre of mass, and the same maths gives the slide, the
// second small bounce and the settle for free. Nothing about the final pose is authored.
//
// The limbs are NOT part of the rigid body — four two-segment chains and a neck, each a damped
// spring pulled toward the direction the joint would hang if gravity were the only thing acting on
// it. That target is computed in the body's own frame, so the arms and legs flail against the tumble
// and flop down when it stops, which is the whole difference between a ragdoll and a rotating plank.
// Per limb it costs two floats and no allocation.
//
// Everything is graded by impact energy `e`: how far the body is thrown, how fast it tumbles, how
// many times it bounces, how long it lies there and how hard it is to get up. A clip at 20 km/h is a
// stumble and a knee on the tarmac; 90 km/h is over the roof.
//
// Pure: no THREE, no DOM. Coordinates are THREE's (x right, y up, z), because that is the frame the
// instance matrices are written in; the caller converts to and from the map's +y-north.

/** Gravity. A touch above 9.81: arcade bodies that fall at exactly 1g read as floaty. */
const G = 11.5
/** The trunk's moment of inertia about the hips, for unit mass. Tuned, not derived. */
const INERTIA = 0.16
/** How much of a landing is given back. A body is not a ball; this is deliberately small. */
const RESTITUTION = 0.17
/** Sliding friction at a contact, as a fraction of the normal impulse. */
const FRICTION = 0.55

/** Angular velocity below which a grounded body is considered to have stopped rolling. */
const CALM_SPIN = 1.1
/** And linear speed. */
const CALM_SPEED = 0.7

/** Seconds spent levelling out of the last roll into a flat lie. */
const SETTLE = 0.45
/** Getting back up, in seconds. Slower after a bigger hit. */
const RISE_MIN = 1.15, RISE_MAX = 1.9

/**
 * The joint angles of one figure. Shared vocabulary with the walk in pedestrians.js: the same names
 * are filled by the walk cycle and by this file, and the drawing code neither knows nor cares which
 * produced them.
 *
 * All angles are radians. A positive `swing` rotates a limb's down-axis BACKWARD (about the body's
 * local +X, which points to the figure's left). A positive `lean` tips it toward the figure's left.
 * Knees and elbows are flexions: always >= 0, always bending the natural way.
 */
export function createPose() {
  return {
    spine: 0, spineZ: 0, twist: 0,
    neck: 0, headYaw: 0, headZ: 0,
    hipLs: 0, hipLz: 0, hipRs: 0, hipRz: 0,
    kneeL: 0, kneeR: 0, ankL: 0, ankR: 0,
    shLs: 0, shLz: 0, shRs: 0, shRz: 0,
    elbL: 0, elbR: 0,
  }
}

/** Every joint this file drives, with its limits and how stiffly it is sprung. */
const JOINTS = [
  // key      lo     hi    stiffness damping  what it hangs toward
  ['spine', -0.55, 0.45, 26, 5.5, 'swing', 0.0],
  ['spineZ', -0.40, 0.40, 26, 5.5, 'lean', 0.0],
  ['twist', -0.55, 0.55, 18, 5.0, 'zero', 0.0],
  ['neck', -0.75, 0.62, 34, 4.6, 'swing', 0.0],
  ['headZ', -0.55, 0.55, 34, 4.6, 'lean', 0.0],
  ['headYaw', -0.9, 0.9, 20, 5.0, 'zero', 0.0],
  ['hipLs', -2.05, 0.45, 30, 4.2, 'swing', 0.0],
  ['hipRs', -2.05, 0.45, 30, 4.2, 'swing', 0.0],
  ['hipLz', -0.30, 0.55, 30, 4.2, 'lean', 0.10],
  ['hipRz', -0.55, 0.30, 30, 4.2, 'lean', -0.10],
  ['shLs', -2.90, 1.50, 22, 3.4, 'swing', 0.0],
  ['shRs', -2.90, 1.50, 22, 3.4, 'swing', 0.0],
  ['shLz', -0.35, 1.75, 22, 3.4, 'lean', 0.22],
  ['shRz', -1.75, 0.35, 22, 3.4, 'lean', -0.22],
  // Hinges have no gravity direction of their own — they sag toward a slack bend.
  ['kneeL', 0, 2.30, 26, 4.0, 'slack', 0.30],
  ['kneeR', 0, 2.30, 26, 4.0, 'slack', 0.30],
  ['elbL', 0, 2.40, 24, 3.6, 'slack', 0.35],
  ['elbR', 0, 2.40, 24, 3.6, 'slack', 0.35],
  ['ankL', -0.55, 0.45, 30, 4.4, 'slack', -0.15],
  ['ankR', -0.55, 0.45, 30, 4.4, 'slack', -0.15],
]

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Begin a strike.
 *
 * @param facing  the figure's yaw at the moment of impact (local +Z is forward)
 * @param scale   the person's height as a fraction of the 1.75m reference
 * @param x,z     where they are standing, in THREE coordinates
 * @param travelX,travelZ  the unit direction the CAR is travelling — the body goes this way
 * @param awayX,awayZ      unit direction from the car to the body — the sideways component
 * @param speed   closing speed in m/s, which is the whole of the grading
 * @param pose    the pose the walk cycle left them in, which the ragdoll continues FROM
 * @param rand    the crowd's deterministic generator, so a reload replays the same accident
 */
export function strikeRagdoll({facing, scale, x, z, travelX, travelZ, awayX, awayZ, speed, pose, rand}) {
  // 0 at a walking-pace nudge, 1 at 90 km/h, and it keeps climbing past that. Everything below
  // reads off this one number, which is what makes 20 km/h a different event from 90.
  const e = clamp((Math.abs(speed) - 1.5) / 23, 0, 1.45)
  const hip = 0.908 * scale

  // A bumper hits below the centre of mass, so the body is scooped up and rotated forward over the
  // bonnet. At a crawl it is barely lifted and mostly just falls over.
  const along = Math.min(speed * 0.62, 5 + 9 * e)
  const lift = 1.1 + 4.9 * e
  const sideways = (0.6 + 1.6 * e) * (0.4 + rand() * 0.6)

  // The tumble axis is horizontal and perpendicular to the travel, so the body goes over end over
  // end down the road rather than spinning like a top. A little yaw and roll are mixed in per
  // person, because two people hit identically and tumbling identically is the doll tell again.
  // Measured at 90km/h, 9.5 put the trunk at nearly two revolutions a second, which is a circus
  // act rather than an accident. A struck body turns over roughly once in the air.
  const spin = 2.2 + 5.0 * e
  const axX = -travelZ, axZ = travelX

  const rag = {
    e,
    scale,
    hipRest: hip,
    x, z, y: hip,
    vx: travelX * along + awayX * sideways,
    vz: travelZ * along + awayZ * sideways,
    vy: lift,
    // Quaternion: upright, yawed to their facing.
    qx: 0, qy: Math.sin(facing / 2), qz: 0, qw: Math.cos(facing / 2),
    wx: axX * spin, wy: (rand() - 0.5) * (1.5 + 5 * e), wz: axZ * spin,
    // Rotation columns, refreshed from the quaternion every step: the body's own X, Y, Z in world.
    col: new Float64Array(9),
    // CONTINUED from the walk, never reset to a zero pose: a figure whose arms snap to its sides on
    // the frame it is hit has already broken the shot before the physics gets a chance.
    pose: pose ? {...pose} : createPose(),
    vel: createPose(),          // one angular velocity per joint, same keys
    phase: 'air',
    t: 0,
    airborne: 0,
    grounded: 0,
    bumps: 0,
    settleFor: 0,
    // How long they lie there before trying to get up, and how long the getting up takes.
    //
    // Five to eight seconds, randomised, and biased upward by how hard they were hit. It used to
    // be 0.55 to 2.95, which read as bouncing straight back up from being run over by a car. The
    // pose they hold through it is not chosen here and must not be: it is wherever the tumble and
    // the settle left them, which is the point of having physics do it.
    restFor: 5 + 3 * (0.5 * rand() + 0.5 * Math.min(1, e)),
    riseFor: RISE_MIN + (RISE_MAX - RISE_MIN) * Math.min(1, e),
    riseT: 0,
    riseFrom: null,
    yawOut: facing,
    lieSign: rand() < 0.5 ? 1 : -1,     // face-down or face-up when they come to rest
    done: false,
    rand,
  }
  refreshColumns(rag)
  // Nobody is limp at the instant of impact — the limbs are still where the walk left them, and the
  // caller has just written them. They are kicked here instead, which is what makes the first 200ms
  // read as a person being hit rather than as a mannequin released.
  const kick = 5 + 13 * e
  for (const [key] of JOINTS) rag.vel[key] = (rand() - 0.5) * kick
  return rag
}

/** The rotation matrix's three columns — the body's local axes, expressed in world. */
function refreshColumns(r) {
  const {qx: x, qy: y, qz: z, qw: w} = r
  const c = r.col
  c[0] = 1 - 2 * (y * y + z * z); c[1] = 2 * (x * y + z * w); c[2] = 2 * (x * z - y * w)
  c[3] = 2 * (x * y - z * w); c[4] = 1 - 2 * (x * x + z * z); c[5] = 2 * (y * z + x * w)
  c[6] = 2 * (x * z + y * w); c[7] = 2 * (y * z - x * w); c[8] = 1 - 2 * (x * x + y * y)
}

/**
 * Contact points down the trunk: offset along the body's local Y from the hips, and the radius of
 * the body there. Five is enough that a body never pivots on a single point and jitters, and few
 * enough to be free.
 *
 * The radii are not decoration. With one radius for the whole trunk a STANDING figure's feet are
 * already buried in the pavement, so the first frame of every strike began with a spurious shove
 * upward — which at walking-pace impacts was most of the launch.
 */
const CONTACTS = [
  [0.70, 0.12],   // head
  [0.42, 0.15],   // shoulders
  [0.00, 0.15],   // hips
  [-0.45, 0.10],  // knees
  [-0.86, 0.05],  // feet
]

/** Integrate one figure for one frame. Mutates `r` and returns nothing. */
export function stepRagdoll(r, dt) {
  r.t += dt
  if (r.phase === 'rise') { rise(r, dt); return }

  // --- trunk ------------------------------------------------------------------------------------
  r.vy -= G * dt
  r.x += r.vx * dt
  r.y += r.vy * dt
  r.z += r.vz * dt

  // q += 0.5 * w * q, normalised. Small-angle integration is fine at 60Hz and a tenth the cost of
  // building a delta quaternion per frame.
  const {wx, wy, wz, qx, qy, qz, qw} = r
  const h = dt * 0.5
  let nx = qx + h * (wx * qw + wy * qz - wz * qy)
  let ny = qy + h * (wy * qw + wz * qx - wx * qz)
  let nz = qz + h * (wz * qw + wx * qy - wy * qx)
  let nw = qw - h * (wx * qx + wy * qy + wz * qz)
  const inv = 1 / (Math.hypot(nx, ny, nz, nw) || 1)
  r.qx = nx * inv; r.qy = ny * inv; r.qz = nz * inv; r.qw = nw * inv
  refreshColumns(r)

  // --- the pavement -----------------------------------------------------------------------------
  // Heights are relative to the ground under the body; the caller adds the terrain back.
  const c = r.col
  let touched = false
  for (let k = 0; k < CONTACTS.length; k++) {
    const L = CONTACTS[k][0] * r.scale
    // Offset of this point from the hips, in world.
    const rx = c[3] * L, ry = c[4] * L, rz = c[5] * L
    const pen = CONTACTS[k][1] * r.scale - (r.y + ry)
    if (pen <= 0) continue
    touched = true

    // Push out, but share the correction between the points rather than satisfying each in full —
    // resolving every contact completely in one pass launched bodies off the kerb.
    r.y += pen * 0.55

    // Velocity of the material point: v + w x r. Read from `r` rather than from the values cached
    // for the quaternion step — an earlier contact this frame has already changed them, and using
    // the stale spin made a body resolve its second contact against a rotation it no longer had.
    const pvx = r.vx + (r.wy * rz - r.wz * ry)
    const pvy = r.vy + (r.wz * rx - r.wx * rz)
    const pvz = r.vz + (r.wx * ry - r.wy * rx)
    if (pvy >= 0) continue

    // Normal impulse along +Y. The lever arm (r x n) has length sqrt(rx^2+rz^2), and that is the
    // whole reason a body landing on its head rotates instead of stopping: the further the contact
    // is from the hips, the more of the impulse becomes spin.
    const lever = (rx * rx + rz * rz) / INERTIA
    const jn = -(1 + RESTITUTION) * pvy / (1 + lever)
    r.vy += jn
    // dw = I^-1 (r x J) with J = (0, jn, 0), so r x J = (-rz*jn, 0, rx*jn). Both signs matter: with
    // them the wrong way round a body landing head-first drives its head FURTHER into the road.
    r.wx += (-rz * jn) / INERTIA
    r.wz += (rx * jn) / INERTIA

    // Friction: scrub the tangential velocity, capped by the normal impulse. This is the slide.
    const tmag = Math.hypot(pvx, pvz)
    if (tmag > 1e-4) {
      const jt = Math.min(FRICTION * jn, tmag)
      const tx = -pvx / tmag * jt, tz = -pvz / tmag * jt
      r.vx += tx
      r.vz += tz
      r.wy += (rz * tx - rx * tz) / INERTIA * 0.5
    }
    if (jn > 0.9) r.bumps++
    // Every landing rattles the limbs.
    if (jn > 0.6) {
      const kick = Math.min(9, jn * 2.4)
      for (const [key] of JOINTS) r.vel[key] += (r.rand() - 0.5) * kick
    }
  }

  if (touched) {
    r.grounded += dt
    // Rolling resistance. Without it a body spins on the tarmac for ever, because a rod on a plane
    // has nothing to stop it.
    const d = Math.exp(-3.2 * dt)
    r.wx *= d; r.wy *= d; r.wz *= d
    r.vx *= Math.exp(-1.9 * dt)
    r.vz *= Math.exp(-1.9 * dt)
  } else {
    r.airborne += dt
    r.grounded = 0
  }

  limbs(r, dt)

  // --- has it stopped? --------------------------------------------------------------------------
  const spin = Math.hypot(r.wx, r.wy, r.wz)
  const move = Math.hypot(r.vx, r.vy, r.vz)
  if (r.phase === 'air' && touched && r.grounded > 0.12 && spin < CALM_SPIN && move < CALM_SPEED) {
    r.phase = 'down'
    r.settleFor = 0
    // Which way the body is lying, so it can stand up facing somewhere sensible. Take the trunk's
    // own forward axis, flattened; if it is pointing at the sky (landed on its head) fall back to
    // the up axis, which is then horizontal.
    let fx = c[6], fz = c[8]
    if (fx * fx + fz * fz < 0.04) { fx = c[3]; fz = c[5] }
    r.yawOut = Math.atan2(fx, fz)
  }

  if (r.phase === 'down') {
    // Level out of the last roll: ease the trunk onto its side/front instead of leaving it propped
    // at whatever angle the final bounce happened to freeze. Physics gets a body to the ground;
    // this is the half second that makes it look like it has come to rest there.
    r.settleFor += dt
    if (r.settleFor < SETTLE) {
      const k = Math.min(1, dt * 7)
      slerpToLying(r, k)
      refreshColumns(r)
    }
    r.vx *= Math.exp(-5 * dt); r.vz *= Math.exp(-5 * dt)
    r.wx *= Math.exp(-6 * dt); r.wy *= Math.exp(-6 * dt); r.wz *= Math.exp(-6 * dt)
    if (r.settleFor > r.restFor + SETTLE) {
      r.phase = 'rise'
      r.riseT = 0
      r.riseFrom = {qx: r.qx, qy: r.qy, qz: r.qz, qw: r.qw, y: r.y, pose: {...r.pose}}
    }
  }
}

/** Roll the trunk down flat, keeping the direction it is pointing. */
function slerpToLying(r, k) {
  // Target: yaw to yawOut, then pitched 90 degrees so the body's local +Y lies along the ground.
  // Which way it pitches decides face-up or face-down, and it is chosen per victim — a street full
  // of people who all come to rest staring at the sky is the doll problem again, lying down.
  const hy = r.yawOut / 2
  const ty = Math.sin(hy), tw = Math.cos(hy)
  // q = Ry(yaw) * Rx(+-90deg)
  const sx = r.lieSign * Math.SQRT1_2, cx = Math.SQRT1_2
  const gx = tw * sx, gy = ty * cx, gz = -ty * sx, gw = tw * cx
  let dot = r.qx * gx + r.qy * gy + r.qz * gz + r.qw * gw
  let ax = gx, ay = gy, az = gz, aw = gw
  if (dot < 0) { ax = -ax; ay = -ay; az = -az; aw = -aw }
  r.qx += (ax - r.qx) * k
  r.qy += (ay - r.qy) * k
  r.qz += (az - r.qz) * k
  r.qw += (aw - r.qw) * k
  const n = 1 / (Math.hypot(r.qx, r.qy, r.qz, r.qw) || 1)
  r.qx *= n; r.qy *= n; r.qz *= n; r.qw *= n
}

/**
 * The limbs. Each joint is a damped spring toward the angle it would hang at under gravity alone,
 * computed once per body in the body's own frame and shared by every joint that hangs.
 */
function limbs(r, dt) {
  const c = r.col
  // World down, in body-local coordinates: dot the down vector with each body axis.
  const dx = -c[1], dy = -c[4], dz = -c[7]
  // A limb rotated by Rx(swing)Rz(lean) points its down-axis at
  //   (sin lean, -cos lean cos swing, -cos lean sin swing)
  // so inverting for the hang direction is one asin and one atan2 for the whole figure.
  const hangZ = Math.asin(clamp(dx, -1, 1))
  const hangS = Math.atan2(-dz, -dy)

  const pose = r.pose, vel = r.vel
  // Once down, the springs stiffen and the body goes slack rather than twitching for ever.
  const settled = r.phase === 'down' ? 1 : 0
  for (let i = 0; i < JOINTS.length; i++) {
    const j = JOINTS[i]
    const key = j[0], lo = j[1], hi = j[2], bias = j[6]
    const stiff = j[3] * (1 + settled * 0.6), damp = j[4] * (1 + settled * 1.4)
    const kind = j[5]
    const target = kind === 'swing' ? clamp(hangS + bias, lo, hi)
      : kind === 'lean' ? clamp(hangZ + bias, lo, hi)
        : kind === 'slack' ? bias
          : 0
    let v = vel[key] + (stiff * (target - pose[key]) - damp * vel[key]) * dt
    let a = pose[key] + v * dt
    // Joints stop at their limits and lose most of the energy doing it, which is what keeps a
    // ragdoll from folding a knee the wrong way.
    if (a < lo) { a = lo; v *= -0.18 }
    else if (a > hi) { a = hi; v *= -0.18 }
    vel[key] = v
    pose[key] = a
  }
}

/** Standing back up: onto a knee first, then upright. */
function rise(r, dt) {
  r.riseT += dt
  const u = Math.min(1, r.riseT / r.riseFor)
  const f = r.riseFrom

  // Orientation: all the way to upright, but most of the turn happens in the first half, while they
  // are still gathering themselves — a body that rotates at a constant rate reads as a hinge.
  const s = u * u * (3 - 2 * u)
  const hy = r.yawOut / 2
  const gx = 0, gy = Math.sin(hy), gz = 0, gw = Math.cos(hy)
  let dot = f.qx * gx + f.qy * gy + f.qz * gz + f.qw * gw
  const sg = dot < 0 ? -1 : 1
  r.qx = f.qx + (sg * gx - f.qx) * s
  r.qy = f.qy + (sg * gy - f.qy) * s
  r.qz = f.qz + (sg * gz - f.qz) * s
  r.qw = f.qw + (sg * gw - f.qw) * s
  const n = 1 / (Math.hypot(r.qx, r.qy, r.qz, r.qw) || 1)
  r.qx *= n; r.qy *= n; r.qz *= n; r.qw *= n
  refreshColumns(r)

  // Height: prone, then a crouch at the halfway mark, then standing. The dwell at crouch height is
  // what makes it a push-up off the pavement rather than a body inflating back to full size.
  const crouch = 0.46 * r.hipRest
  r.y = u < 0.5
    ? f.y + (crouch - f.y) * smooth(u / 0.5)
    : crouch + (r.hipRest - crouch) * smooth((u - 0.5) / 0.5)

  // Limbs unfold: knees tucked under at the crouch, then extended.
  const tuck = Math.sin(Math.min(1, u * 1.6) * Math.PI) * 0.9
  for (const [key] of JOINTS) {
    const from = f.pose[key]
    let to = 0
    if (key === 'kneeL' || key === 'kneeR') to = tuck
    else if (key === 'hipLs' || key === 'hipRs') to = -tuck * 0.75
    else if (key === 'spine') to = -0.35 * (1 - s)
    else if (key === 'shLz') to = 0.18
    else if (key === 'shRz') to = -0.18
    r.pose[key] = from + (to - from) * s
    r.vel[key] = 0
  }

  if (u >= 1) r.done = true
}

const smooth = (u) => u * u * (3 - 2 * u)

/** How long the whole thing will take, so the caller can hold the figure out of circulation. */
export function ragdollDuration(r) {
  return 0.9 + r.restFor + SETTLE + r.riseFor
}
