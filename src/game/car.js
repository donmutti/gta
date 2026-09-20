// Arcade car. A rear-wheel bicycle model with an explicit grip term, which is what buys drift
// without a physics engine: the car carries a velocity VECTOR, not a speed along its nose, and the
// difference between where it points and where it is going is the whole feel of the thing.
//
// World units are metres, +Y north, heading measured anticlockwise from +X. Pure: no Three.js.

import {ROAD_KINDS} from '../world/model.js'

/** Metres between axles. Short enough to turn in Ville-Haute's old streets. */
const WHEELBASE = 2.6
/** Collision radius. The car is a circle to the world — cheap, and at this speed nobody can tell. */
export const CAR_RADIUS = 1.7

const MAX_STEER = 0.62          // radians at full lock, standing still
const STEER_RATE = 5.0          // how fast the wheel reaches the commanded angle
const ENGINE = 11.0             // m/s^2 at full throttle
const BRAKE = 20.0              // m/s^2 on the brake
const REVERSE = 5.0             // m/s^2 backwards — deliberately feeble
const DRAG = 0.0080             // quadratic, dominates at the top end
const ROLL = 0.9                // linear, brings you to rest
const GRIP = 13.0                // lateral acceleration the tyres can hold, m/s^2
const HANDBRAKE_GRIP = 3.2      // what is left of it with the handbrake up
const OFFROAD_DRAG = 5.5        // extra linear drag on anything that is not tarmac

/**
 * The world is closed by the FOREST — a wall of trees you can see, resolved by ordinary obstacle
 * collision. But driving INTO dense woodland at speed should not be a series of invisible-feeling
 * impacts even once it is drawn, so the car is also eased back at the treeline itself: you slow in
 * the trees rather than crashing through them one trunk at a time.
 *
 * This doubles as the safe state while the wood has collision but no geometry yet — without it,
 * the boundary is 48,729 invisible trees, which is worse than the invisible wall it replaced.
 */
const EDGE_PUSH = 20
/** Hard clamp far beyond everything, so an unanticipated gap cannot strand anyone. */
const EDGE_BACKSTOP = 220

/** Steering authority falls away with speed, or the car is undriveable above 20 m/s. */
const steerLimit = (speed) => MAX_STEER / (1 + Math.abs(speed) * 0.055)

export function createCar(x, y, heading = 0) {
  return {
    x, y, heading,
    vx: 0, vy: 0,        // velocity in world metres/second
    steer: 0,            // current front wheel angle, radians
    speed: 0,            // signed speed along the nose, for the HUD and the camera
    lateral: 0,          // signed slip, for tyre smoke and the drift feel
    onRoad: true,
    yawRate: 0,        // radians/second actually applied this frame
    contact: false,      // touched something solid this frame
  }
}

/** Squared distance from a point to a segment, plus the closest point on it. */
function closestOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
  const cx = ax + dx * t, cy = ay + dy * t
  return {cx, cy, d2: (px - cx) ** 2 + (py - cy) ** 2}
}

function pointInPolygon(px, py, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi) inside = !inside
  }
  return inside
}

/**
 * Push the car out of any building it has entered and kill the velocity going into the wall.
 *
 * Resolved as a circle against the footprint's edges. Sliding falls out of it for free — only the
 * component along the wall normal is removed, so clipping a corner at speed scrapes you round it
 * rather than stopping you dead, which is the arcade behaviour we want.
 */
function resolveBuildings(car, world, scratch) {
  const candidates = world.grid.near(car.x, car.y, CAR_RADIUS + 2, scratch)

  // Find the single DEEPEST contact rather than resolving every overlapping footprint in turn.
  // Pushing once per building made them FIGHT: where two footprints meet — a terrace, or a
  // synthetic townhouse standing against a surveyed one — each shoved the car a different way every
  // frame, the pushes cancelled, and the car sat glued to the wall with reverse doing nothing,
  // because the corrections were re-applied before the engine could carry it clear. One contact,
  // one resolution, and the car can always drive out of it.
  let deepest = null
  for (const b of candidates) {
    const {minX, minY, maxX, maxY} = b.aabb
    if (car.x < minX - CAR_RADIUS || car.x > maxX + CAR_RADIUS) continue
    if (car.y < minY - CAR_RADIUS || car.y > maxY + CAR_RADIUS) continue

    let best = null
    const pts = b.pts
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const c = closestOnSegment(car.x, car.y, pts[j][0], pts[j][1], pts[i][0], pts[i][1])
      if (!best || c.d2 < best.d2) best = c
    }
    if (!best) continue

    const inside = pointInPolygon(car.x, car.y, pts)
    const dist = Math.sqrt(best.d2)
    if (!inside && dist >= CAR_RADIUS) continue

    // Outward normal: away from the wall when outside, back out the nearest wall when inside.
    let nx = car.x - best.cx, ny = car.y - best.cy
    const nlen = Math.hypot(nx, ny) || 1
    nx /= nlen; ny /= nlen
    if (inside) { nx = -nx; ny = -ny }

    const pen = inside ? dist + CAR_RADIUS : CAR_RADIUS - dist
    if (!deepest || pen > deepest.pen) deepest = {pen, nx, ny}
  }
  if (!deepest) return false

  const {nx, ny, pen} = deepest
  // Ease out rather than snap out. A couple of centimetres of slop stops resting contact from
  // jittering, and the per-frame ceiling means even a car buried deep inside a building walks out
  // over a few frames instead of being flung across the street.
  const SLOP = 0.02, MAX_STEP = 0.25
  const corr = Math.min(MAX_STEP, Math.max(0, pen - SLOP))
  car.x += nx * corr
  car.y += ny * corr

  const into = car.vx * nx + car.vy * ny
  if (into < 0) {
    // Remove EXACTLY the normal component and leave the tangential almost intact, so the car slides
    // along the wall. Nothing is damped when the car is moving AWAY from the wall (into >= 0), which
    // is what makes reversing out of a scrape actually work.
    car.vx -= nx * into
    car.vy -= ny * into
    car.vx *= 0.985
    car.vy *= 0.985
  }
  return true
}

/**
 * Push the car off any tree or lamp post it is overlapping — or take the thing down.
 *
 * Circle against circle, so there is no inside/outside case to get wrong. A post that HOLDS does not
 * move, so all of the correction lands on the car, which is what makes clipping a lamp feel like a
 * mistake rather than a bump.
 *
 * A post that does NOT hold is the destructible case, and it is graded by the impact ENERGY rather
 * than by contact, because "energetic hits" is a statement about energy: the measure is the square of
 * the closing speed along the contact normal, the same quantity `main.js` shakes the camera by, and
 * the thresholds live beside the radii in `PROP_KINDS` so the model owns the whole answer. Nothing
 * is resolved against a prop that this blow felled — the car ploughs on through the gap it just
 * made, minus exactly the energy the break cost, which is what makes the camera shake and the impact
 * thump arrive for free off the speed it lost.
 */
function resolveObstacles(car, world, scratch) {
  if (!world.obstacles) return false
  const near = world.obstacles.near(car.x, car.y, CAR_RADIUS + 1, scratch)
  let hit = false
  for (const o of near) {
    if (o.broken) continue           // a stump or a lamp lying in the gutter is not a standing post
    const dx = car.x - o.x, dy = car.y - o.y
    const min = CAR_RADIUS + o.r
    const d2 = dx * dx + dy * dy
    if (d2 >= min * min) continue
    const d = Math.sqrt(d2) || 0.0001
    const nx = dx / d, ny = dy / d
    const into = car.vx * nx + car.vy * ny

    // Decided BEFORE the positional correction: a prop that comes down must not also shove the car,
    // or felling it reads as hitting something invisible in the same spot.
    if (into < 0 && o.hp > 0 && world.obstacles.hit(o, into * into, -nx, -ny)) {
      // Pay for it out of the closing speed. Energy in, energy out: what is left along the normal is
      // sqrt(E - breakEnergy), so a lamp barely slows a car doing fifty and a tree taken at its
      // threshold stops you almost dead — no separate table of "how much a break costs" needed.
      const keep = Math.sqrt(Math.max(0, into * into - o.breakEnergy))
      const bleed = -into - keep
      car.vx += nx * bleed
      car.vy += ny * bleed
      hit = true
      continue
    }

    car.x += nx * (min - d)
    car.y += ny * (min - d)
    if (into < 0) {
      // A post is small enough to deflect you round rather than stop you, so the normal is removed
      // with a little bounce and the along-post motion is kept.
      car.vx -= nx * into * 1.2
      car.vy -= ny * into * 1.2
      car.vx *= 0.95
      car.vy *= 0.95
    }
    hit = true
  }
  return hit
}

/**
 * Keep the car inside the modelled world. Returns true while it is being pushed back, so the HUD
 * can say why the car is fighting the wheel instead of letting it feel like a bug.
 */
function resolveBounds(car, world, dt) {
  const b = world.bounds
  if (!b) return false
  // The treeline, a little inside it so the car is already slowing as the first trunks pass.
  const lip = (world.forestInner ?? 6) - 4
  const over = (v, lo, hi) => (v < lo ? v - lo : v > hi ? v - hi : 0)
  const ox = over(car.x, b.minX + lip, b.maxX - lip)
  const oy = over(car.y, b.minY + lip, b.maxY - lip)
  let easing = false
  if (ox !== 0) { car.vx -= Math.sign(ox) * EDGE_PUSH * dt; car.vx *= 0.975; easing = true }
  if (oy !== 0) { car.vy -= Math.sign(oy) * EDGE_PUSH * dt; car.vy *= 0.975; easing = true }
  car.x = Math.min(Math.max(car.x, b.minX - EDGE_BACKSTOP), b.maxX + EDGE_BACKSTOP)
  car.y = Math.min(Math.max(car.y, b.minY - EDGE_BACKSTOP), b.maxY + EDGE_BACKSTOP)
  return easing
}

/** Nearest drivable edge within `r`, and how far the car is from its centreline. */
export function roadUnder(world, x, y, r = 24) {
  let best = null
  for (const e of world.edges) {
    // Cheap reject on the segment's own bounding interval before touching the geometry.
    for (let i = 1; i < e.pts.length; i++) {
      const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i]
      if (Math.min(ax, bx) - r > x || Math.max(ax, bx) + r < x) continue
      if (Math.min(ay, by) - r > y || Math.max(ay, by) + r < y) continue
      const c = closestOnSegment(x, y, ax, ay, bx, by)
      if (!best || c.d2 < best.d2) best = {edge: e, d2: c.d2}
    }
  }
  if (!best) return null
  return {edge: best.edge, distance: Math.sqrt(best.d2)}
}

/**
 * One physics step.
 *
 * `input` is {throttle: -1..1, steer: -1..1, handbrake: boolean}. `dt` is clamped by the caller;
 * this assumes a sane frame.
 */
export function stepCar(car, input, dt, world, scratch = []) {
  // Steering follows the command rather than snapping to it, which is most of what makes a
  // keyboard car feel like a car instead of a cursor.
  const want = input.steer * steerLimit(car.speed)
  car.steer += (want - car.steer) * Math.min(1, STEER_RATE * dt)

  // ORDER MATTERS, and getting it wrong is silent. Drive the engine along the CURRENT nose, then
  // rotate the car, then decompose against the NEW nose. Decomposing before the rotation and
  // re-adding the same lateral vector afterwards effectively rotates the velocity with the body,
  // which erases the slip entirely — the car then rails as if on a track, handbrake or not.
  const fx = Math.cos(car.heading), fy = Math.sin(car.heading)
  const forward = car.vx * fx + car.vy * fy

  let accel = 0
  if (input.throttle > 0) accel = ENGINE * input.throttle
  else if (input.throttle < 0) accel = forward > 0.5 ? -BRAKE : REVERSE * input.throttle
  const speedAbs = Math.abs(forward)
  accel -= Math.sign(forward) * (DRAG * speedAbs * speedAbs + ROLL)
  // Off-road drag RAMPS IN WITH SPEED instead of being a flat force. Applied as a constant it was
  // 5.5 m/s^2 even at a standstill, and REVERSE is only 5.0 — so once you nosed into a building and
  // ended up on the pavement, reverse could not overcome the drag at all: 5.0 against 0.9 of roll
  // plus 5.5 of off-road is a net 1.4 m/s^2 STILL PUSHING YOU FORWARD. The car sat there jittering,
  // because the sign of `forward` flipped every frame, and it read as being glued to the wall you
  // had just hit. Forward never showed it, the engine being 11.0. Fading it below ~3 m/s means the
  // car can always get itself moving, while a car that is already rolling over grass is still
  // dragged down to a crawl.
  if (!car.onRoad) accel -= Math.sign(forward) * OFFROAD_DRAG * Math.min(1, speedAbs / 3)
  if (input.handbrake) accel -= Math.sign(forward) * 8

  const nextForward = forward + accel * dt
  // Rolling resistance must not drag a stopped car backwards.
  const stopped = Math.sign(nextForward) !== Math.sign(forward) && Math.abs(input.throttle) < 0.01
  const drive = stopped ? 0 : nextForward - forward

  car.vx += fx * drive
  car.vy += fy * drive

  // Yaw from the bicycle model — but BOUNDED BY GRIP, which is the difference between a car and a
  // spinning top. Holding a turn of rate w at speed v demands lateral acceleration v*w; the tyres
  // can only supply GRIP. Unbounded, full lock at 100km/h asks for 2 rad/s and ~70 m/s^2, the car
  // pirouettes and scrubs all its speed away, and the handbrake changes nothing because the tyres
  // were already past their limit. Clamped, the car understeers when gripping and the handbrake
  // becomes the thing that actually lets the tail go.
  const yawWanted = (forward / WHEELBASE) * Math.tan(car.steer)
  const yawHeld = (input.handbrake ? HANDBRAKE_GRIP : GRIP) / Math.max(Math.abs(forward), 2)
  // A little over the limit, so cornering hard still slips a touch and feels alive.
  const yawMax = yawHeld * 1.15
  const yaw = input.handbrake ? yawWanted : Math.max(-yawMax, Math.min(yawMax, yawWanted))
  car.heading += yaw * dt
  // Published for the visuals: lateral load is speed * yaw rate, which is what leans the body.
  car.yawRate = yaw

  const nfx = Math.cos(car.heading), nfy = Math.sin(car.heading)
  let fwd = car.vx * nfx + car.vy * nfy
  let lx = car.vx - nfx * fwd, ly = car.vy - nfy * fwd

  // Lateral grip: bleed the sideways velocity away at the tyres' limit. The handbrake lowers that
  // limit, the slip survives the frame, and the car rotates ahead of its own path — the drift.
  const grip = (input.handbrake ? HANDBRAKE_GRIP : GRIP) * dt
  const lmag = Math.hypot(lx, ly)
  if (lmag > 1e-6) {
    const keep = Math.max(0, lmag - grip) / lmag
    lx *= keep; ly *= keep
  }

  if (stopped) fwd = 0
  car.vx = nfx * fwd + lx
  car.vy = nfy * fwd + ly

  car.x += car.vx * dt
  car.y += car.vy * dt

  car.contact = resolveBuildings(car, world, scratch)
  if (resolveObstacles(car, world, scratch)) car.contact = true
  car.leaving = resolveBounds(car, world, dt)

  // Recompute the reported scalars after collision so the HUD and camera see the truth.
  car.speed = car.vx * nfx + car.vy * nfy
  car.lateral = car.vx * -nfy + car.vy * nfx

  const road = roadUnder(world, car.x, car.y, 30)
  car.onRoad = !!road && road.distance <= road.edge.width * 0.5 + 1.2
  car.road = road ? road.edge : null

  return car
}

export {ROAD_KINDS}
