// Chase camera. Works in world metres and writes into the Three camera at the end; it never
// imports Three, so it stays testable and the mapping lives in exactly one place.
//
// It follows the car's HEADING, not its velocity. Following velocity is the obvious choice and it
// is wrong: in a drift the two diverge by design, and a velocity-chase camera swings round to stare
// at the car's flank, which is the one moment the player most needs to see where they are going.

/** world (x, y) -> three (x, up, -y). The single place this conversion happens on the game side. */
export const toThree = (x, y) => [x, -y]

import {groundAt} from '../world/ground.js'

/**
 * The camera sits behind the car, which means that with the car nose-to-a-wall the camera is
 * INSIDE the building — and the inside of a wall renders as nothing, so the screen goes black with
 * no error and a passing smoke test. It is pulled in toward the car until it is clear.
 */
const MIN_DIST = 2.2
const PULL_STEP = 0.9

const BASE_DIST = 9.5
const BASE_HEIGHT = 4.2
const LOOK_AHEAD = 7.0

export function createChaseCamera() {
  return {x: 0, y: 0, h: BASE_HEIGHT, yaw: 0, ready: false, shake: 0, seed: 0}
}

/**
 * Kick the camera. Called on an impact; the magnitude is roughly the speed lost.
 *
 * Shake decays rather than being scheduled, so overlapping hits add up instead of restarting, and
 * a long scrape along a wall produces a rumble rather than a series of identical jolts.
 */
export function shakeCamera(chase, force) {
  chase.shake = Math.min(1.4, chase.shake + force * 0.1)
}

/**
 * Advance the camera and apply it.
 *
 * Smoothing is frame-rate independent — `1 - exp(-k*dt)` rather than a raw lerp factor, or the
 * camera tightens up on a 120Hz pane and lags on a 60Hz one, which is exactly the "feels different
 * on my machine" bug nobody can reproduce.
 */
/** True if (x, y) is inside any building footprint. Uses the same broad phase as the physics. */
function insideBuilding(world, x, y, scratch) {
  if (!world?.grid) return false
  const near = world.grid.near(x, y, 2, scratch)
  for (const b of near) {
    const {minX, minY, maxX, maxY} = b.aabb
    if (x < minX || x > maxX || y < minY || y > maxY) continue
    const pts = b.pts
    let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside
    }
    if (inside) return true
  }
  return false
}

const camScratch = []

export function updateChase(chase, car, camera, dt, world = null) {
  const speed = Math.abs(car.speed)
  // Pull back and rise with speed: the faster you go the more road you need to see.
  const dist = BASE_DIST + speed * 0.28
  const height = BASE_HEIGHT + speed * 0.06

  const wantX = car.x - Math.cos(car.heading) * dist
  const wantY = car.y - Math.sin(car.heading) * dist

  if (!chase.ready) {
    chase.x = wantX; chase.y = wantY; chase.h = height; chase.ready = true
  } else {
    // Position catches up faster than height, so cresting the gorge does not launch the camera.
    const kPos = 1 - Math.exp(-6.5 * dt)
    const kH = 1 - Math.exp(-3.0 * dt)
    chase.x += (wantX - chase.x) * kPos
    chase.y += (wantY - chase.y) * kPos
    chase.h += (height - chase.h) * kH
  }

  // Walk the camera in toward the car while it is buried in geometry. Stepping rather than
  // snapping keeps it smooth when the car scrapes along a wall and the camera dips in and out.
  if (world) {
    let guard = 0
    while (guard++ < 9 && insideBuilding(world, chase.x, chase.y, camScratch)) {
      const dx = car.x - chase.x, dy = car.y - chase.y
      const d = Math.hypot(dx, dy)
      if (d < MIN_DIST) break
      chase.x += (dx / d) * PULL_STEP
      chase.y += (dy / d) * PULL_STEP
    }
  }

  let [cx, cz] = toThree(chase.x, chase.y)
  let ch = chase.h
  if (chase.shake > 0.001) {
    // Decaying, and deliberately not random per frame: two offset sine waves at unrelated
    // frequencies read as a physical wobble, where white noise reads as a broken camera.
    chase.seed += dt * 46
    const a = chase.shake
    cx += Math.sin(chase.seed) * a * 0.55
    cz += Math.sin(chase.seed * 1.37 + 1.1) * a * 0.55
    ch += Math.sin(chase.seed * 0.81 + 2.2) * a * 0.3
    chase.shake *= Math.exp(-6.5 * dt)
  }
  // Height is measured from the ground under the camera, not from sea level, so cresting a hill
  // lifts the camera with the car instead of burying it in the slope.
  camera.position.set(cx, ch + groundAt(chase.x, chase.y), cz)

  // Look a little ahead of the car rather than at it: centring the car puts half the screen behind
  // you, and the thing the player is steering towards belongs in the middle of the frame.
  const lookX = car.x + Math.cos(car.heading) * LOOK_AHEAD
  const lookY = car.y + Math.sin(car.heading) * LOOK_AHEAD
  const [lx, lz] = toThree(lookX, lookY)
  camera.lookAt(lx, 1.2 + groundAt(lookX, lookY), lz)
}

/** Snap without smoothing — after a respawn, where easing in from the old position looks like a bug. */
export function resetChase(chase) { chase.ready = false }

// ---------------------------------------------------------------------------------------------
// BIRD'S EYE. A second, first-class camera mode rather than a debug view: the map from directly
// above, north up, following the car.
//
// North up and not car up, deliberately. The minimap in the corner is car-up because it answers
// "which way do I turn"; this answers "where am I and what is around me", and a map that spins
// under you cannot answer that. It is also the mode you edit in — a parcel you are painting must
// not rotate every time the car does.
//
// Shake is deliberately not applied. From two hundred metres up a collision shaking the whole city
// reads as an earthquake, not as an impact.
const BIRD_MIN = 25
const BIRD_MAX = 400
const BIRD_DEFAULT = 90
/** How fast the view slides to the car. Slower than the chase camera: at altitude, snap reads as a jump. */
const BIRD_EASE = 6.0

export function createBirdCamera() {
  return {x: 0, y: 0, alt: BIRD_DEFAULT, ready: false}
}

/** Zoom, in multiplicative steps so the same key feels the same at every altitude. */
export function zoomBird(bird, factor) {
  bird.alt = Math.max(BIRD_MIN, Math.min(BIRD_MAX, bird.alt * factor))
}

export function updateBird(bird, car, camera, dt) {
  if (!bird.ready) { bird.x = car.x; bird.y = car.y; bird.ready = true }
  const k = Math.min(1, BIRD_EASE * dt)
  bird.x += (car.x - bird.x) * k
  bird.y += (car.y - bird.y) * k
  const [tx, tz] = toThree(bird.x, bird.y)
  const ground = groundAt(bird.x, bird.y)
  // Straight down has no natural "up" — the default +y is parallel to the view direction and the
  // frame comes out undefined. Point up at -z so north sits at the top, exactly like the big map.
  camera.up.set(0, 0, -1)
  camera.position.set(tx, ground + bird.alt, tz)
  camera.lookAt(tx, ground, tz)
}

/** Put the camera's up vector back before handing control to any other mode. */
export function restoreUp(camera) { camera.up.set(0, 1, 0) }
