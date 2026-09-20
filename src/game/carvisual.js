// Motion applied to a car mesh. Not modelling — the shapes are the renderer's — but the part that
// makes the shapes look like a car rather than a prop sliding along the ground.
//
// An A-class eye reads this before it reads polycount: wheels that turn at the speed you are going,
// front wheels that point where you steered, weight shifting onto the outside wheels in a corner,
// and the nose dipping under the brakes. All four are cheap, and their absence is what makes a
// good model look like a sticker.

import * as THREE from 'three'
import {groundNormalAt} from '../world/ground.js'

const WHEEL_RADIUS = 0.34
/** Radians of body roll per m/s² of lateral acceleration, and the ceiling on it. */
const ROLL_PER_G = 0.020
const ROLL_MAX = 0.10
const PITCH_PER_G = 0.011
const PITCH_MAX = 0.055
/** How fast the body catches up to the load it is under. Suspension, effectively. */
const SETTLE = 7.0
/** How fast the body settles onto a new slope. Slower than the suspension, or kerbs make it twitch. */
const SLOPE_SETTLE = 5.0

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const slopeNormal = new THREE.Vector3(0, 1, 0)
const targetNormal = new THREE.Vector3()
const alignQ = new THREE.Quaternion()
const bodyE = new THREE.Euler()
const bodyQ = new THREE.Quaternion()

const otherNormal = new THREE.Vector3()
const otherAlign = new THREE.Quaternion()
const otherE = new THREE.Euler()
const otherQ = new THREE.Quaternion()

/**
 * Sit a car-shaped mesh on the terrain at a heading, aligned to the slope.
 *
 * For cars the simulation moves but does not give a suspension to — the police. Same composition as
 * the hero car (align to the hill, then yaw inside that frame) without the per-car easing state,
 * because nobody is watching a pursuing car closely enough to catch a snapped kerb.
 */
export function orientToGround(mesh, x, y, heading, height) {
  const n = groundNormalAt(x, y)
  otherNormal.set(n.x, n.y, n.z)
  if (otherNormal.lengthSq() < 1e-6) otherNormal.copy(WORLD_UP)
  otherNormal.normalize()
  otherAlign.setFromUnitVectors(WORLD_UP, otherNormal)
  otherE.set(0, heading + Math.PI / 2, 0, 'YXZ')
  otherQ.setFromEuler(otherE)
  mesh.quaternion.copy(otherAlign).multiply(otherQ)
  mesh.position.set(x, height, -y)
}

export function createCarVisual(mesh) {
  // Named groups are the renderer's contract; tolerate their absence so the game still runs
  // against an older car model rather than throwing in the frame loop.
  const wheels = ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'].map(n => mesh.getObjectByName?.(n) ?? null)
  const steered = [wheels[0], wheels[1]]
  // Spin and steer are two Euler angles on the SAME pivot, so the order they compose in decides
  // whether the axle follows the steering. Three's default 'XYZ' yaws the geometry first and then
  // spins it about the PARENT's x axis, so a steered front wheel went on rotating about the
  // straight-ahead axis — scything sideways like a wheel on a bent hub. 'YXZ' spins about the axle
  // first and yaws the spinning wheel afterwards, which is what a steering knuckle actually does.
  for (const w of wheels) if (w) w.rotation.order = 'YXZ'
  return {mesh, wheels, steered, spin: 0, roll: 0, pitch: 0, lastSpeed: 0}
}

/**
 * @param v      the visual state from createCarVisual
 * @param car    the simulated car
 * @param dt     seconds
 */
export function updateCarVisual(v, car, dt) {
  if (dt <= 0) return

  // Wheel spin follows ground speed, not engine speed: on a handbrake slide the car is travelling
  // sideways and the wheels should not be racing.
  v.spin -= (car.speed / WHEEL_RADIUS) * dt
  for (const w of v.wheels) if (w) w.rotation.x = v.spin
  // Front wheels also carry the steering angle. Applied on top, on a different axis.
  for (const w of v.steered) if (w) w.rotation.y = car.steer

  // Lateral load leans the body away from the turn; longitudinal load pitches it.
  const lateralAccel = car.speed * (car.yawRate ?? 0)
  const wantRoll = Math.max(-ROLL_MAX, Math.min(ROLL_MAX, -lateralAccel * ROLL_PER_G))
  const longAccel = (car.speed - v.lastSpeed) / dt
  v.lastSpeed = car.speed
  const wantPitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, -longAccel * PITCH_PER_G))

  const k = Math.min(1, SETTLE * dt)
  v.roll += (wantRoll - v.roll) * k
  v.pitch += (wantPitch - v.pitch) * k

  // Two rotations, composed in this order and not the other: first ALIGN the body to the hill it is
  // standing on, then apply the car's own yaw, braking pitch and cornering roll INSIDE that frame.
  // Done the other way round the car leans relative to the world instead of relative to the road,
  // which on a camber looks like the suspension is broken rather than like the hill is tilted.
  const n = groundNormalAt(car.x, car.y)
  targetNormal.set(n.x, n.y, n.z)
  if (targetNormal.lengthSq() < 1e-6) targetNormal.copy(WORLD_UP)
  targetNormal.normalize()
  // Ease onto the slope so a kerb or a heightfield seam does not snap the body.
  slopeNormal.lerp(targetNormal, Math.min(1, SLOPE_SETTLE * dt)).normalize()
  alignQ.setFromUnitVectors(WORLD_UP, slopeNormal)

  bodyE.set(v.pitch, car.heading + Math.PI / 2, v.roll, 'YXZ')
  bodyQ.setFromEuler(bodyE)
  v.mesh.quaternion.copy(alignQ).multiply(bodyQ)
}
