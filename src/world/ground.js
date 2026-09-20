// Ground height, for the simulation half.
//
// Everything that sits on the world — the car, the police, the crowd, the traffic, the camera —
// asks here rather than assuming y = 0. Today the answer is always 0 and the game behaves exactly
// as it did before; when the real heightfield lands, this file is the only one that changes and
// every consumer follows at once.
//
// The point of doing it BEFORE the terrain exists is that the switch becomes atomic. Wiring a
// heightfield into six systems at four in the morning, one call site at a time, is how a car ends
// up driving through a hill while the pedestrians walk over it — each half correct, the pair
// broken, which has been the shape of every bad hour tonight.

/** Swapped for the real sampler when terrain lands. Pure: no THREE, no DOM, no fetch. */
let sample = () => 0

/**
 * Install the real height sampler.
 *
 * @param fn (x, y) => height in metres, in WORLD map coordinates (+y north), not Three's z.
 */
export function setGroundSampler(fn) {
  sample = typeof fn === 'function' ? fn : () => 0
}

/** Surface normal sampler. Flat-world default points straight up. */
let normalSample = () => ({x: 0, y: 1, z: 0})

/** @param fn (x, y) => {x, y, z} unit up-normal, in WORLD map coordinates (+y north). */
export function setNormalSampler(fn) {
  normalSample = typeof fn === 'function' ? fn : () => ({x: 0, y: 1, z: 0})
}

/** The terrain's up-normal under a world-map point. */
export function groundNormalAt(x, y) {
  return normalSample(x, y)
}

/** Height of the ground under a world-map point, in metres. */
export function groundAt(x, y) {
  return sample(x, y)
}

/** True once a real heightfield is installed — for anything that wants to skip flat-world work. */
export function hasTerrain() {
  return sample !== null && sample.name !== ''
}
