/**
 * What each vehicle physically occupies, and who is inside it.
 *
 * Pure data and pure maths: no Three.js, because both halves of the game need this. The renderer
 * draws the hull, the simulation decides what the hull hits, and before this file existed the two
 * disagreed — the simulation used a single circle of radius 2.4m for every vehicle in the game,
 * including a ten-metre bus.
 *
 * THE NUMBERS ARE MEASURED, NOT DECLARED. Each box is the bounding box of the actual rendered
 * geometry for that body type, read out of `Box3.setFromObject` in the running game and written
 * down here. Deriving them from the spec table in `src/render/car.js` by hand gets the length
 * right and the width wrong, because wheel arches stand proud of the widest body station: a sedan
 * measures 1.82m across its flanks and 2.16m across its arches, and a pedestrian standing beside
 * the front wheel is touching the car.
 *
 * Re-measure with `tools/probe.mjs` if the body specs change; a box that no longer matches its
 * hull is worse than no box, because it is wrong in a way that looks deliberate.
 */

/** Half-extents in metres, in the vehicle's own frame: halfL down its length, halfW out the doors. */
export const VEHICLE_BOX = {
  car:   {halfL: 2.215, halfW: 1.08},
  wagon: {halfL: 2.315, halfW: 1.08},
  van:   {halfL: 2.355, halfW: 1.11},
  bus:   {halfL: 5.037, halfW: 1.42},
}

/**
 * The mix of body types across fleet slots, by index.
 *
 * This lives here rather than in the renderer because the simulation now needs it too: a bus has
 * to knock people over along ten metres of flank, and the only thing that says slot 11 is a bus is
 * this list. The renderer imports it from here, so there is one list rather than two that drift.
 */
export const FLEET_MIX = ['car', 'car', 'car', 'wagon', 'car', 'van', 'car', 'car', 'wagon', 'van', 'car', 'bus']

/** Slot i is always the same vehicle: deterministic, and cheap. */
export function fleetTypeFor(i) { return FLEET_MIX[i % FLEET_MIX.length] }

/** The box of the vehicle in fleet slot i. */
export function fleetBox(i) { return VEHICLE_BOX[fleetTypeFor(i)] }

/**
 * Is the point (px, py) inside the oriented box of a vehicle at (cx, cy) facing (fx, fy)?
 *
 * `pad` widens the box by a body radius, so a person is struck when their shoulder touches the
 * paintwork rather than when their centre line does.
 *
 * Cost is four multiplies and two compares, and it is meant to run only on whatever survived a
 * cheap circular reject — see `broadRadius`. Turning the point into the vehicle's own frame is the
 * whole trick: once it is there, the test is two absolute values.
 */
export function inBox(px, py, cx, cy, fx, fy, box, pad = 0) {
  const dx = px - cx, dy = py - cy
  const along = dx * fx + dy * fy
  const across = dy * fx - dx * fy
  return Math.abs(along) < box.halfL + pad && Math.abs(across) < box.halfW + pad
}

/** Nothing outside this circle can be inside the box, so it is a sound cheap reject. */
export function broadRadius(box, pad = 0) {
  return Math.hypot(box.halfL, box.halfW) + pad
}

/** A pedestrian is hit when their shoulder touches, not their centre line. */
export const SHOULDER = 0.25
