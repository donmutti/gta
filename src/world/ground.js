// Simulation coordinates use +y north; renderer coordinates use -z north.
// The samplers installed at boot keep that conversion in one place.

/** Swapped for the real sampler when terrain lands. Pure: no THREE, no DOM, no fetch. */
let sample = () => 0
let installed = false

/**
 * Install the real height sampler.
 *
 * @param fn (x, y) => height in metres, in WORLD map coordinates (+y north), not Three's z.
 */
export function setGroundSampler(fn) {
  installed = typeof fn === 'function'
  sample = installed ? fn : () => 0
}

/** Surface normal sampler. Flat-world default points straight up. */
let normalSample = () => ({x: 0, y: 1, z: 0})

/** @param fn (x, y) => {x, y, z} unit up-normal, in WORLD map coordinates (+y north). */
export function setNormalSampler(fn) {
  normalSample = typeof fn === 'function' ? fn : () => ({x: 0, y: 1, z: 0})
}

/** The terrain's up-normal under a world-map point. */
export function groundNormalAt(x, y, reference) {
  return normalSample(x, y, reference)
}

/** Height under a world-map point. An optional previous elevation selects the same bridge level. */
export function groundAt(x, y, reference) {
  return sample(x, y, reference)
}

/** True once a real heightfield is installed — for anything that wants to skip flat-world work. */
export function hasTerrain() {
  return installed
}
