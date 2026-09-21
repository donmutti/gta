/**
 * One delivery. Not a mission system — one job, from offered to finished, and nothing else.
 *
 * Designed in `docs/delivery.md`. The reason it exists is countable rather than aesthetic: before
 * this file, every string the game could say to a player was a reaction to something they had done
 * wrong. WANTED, you knocked someone over, ran a red light, they have you pinned, BUSTED. A player
 * could be punished and could not be asked.
 *
 * THE DESTINATION IS A NAMED STREET, and that is the whole design rather than a detail. The game
 * already puts the name of the road you are on in front of you, every time you turn, so a delivery
 * addressed to "Rue Willy Goergen" is spoken in a vocabulary the player has been handed without
 * being taught it. Cafes and monuments were the obvious choice: the map data carries their
 * positions and not their names, so a delivery to one could only ever be described as a dot — and
 * a dot is findable without being a PLACE, which is the entire reason this city was built out of a
 * real map instead of a generator.
 *
 * Pure simulation. No Three.js, no DOM. The renderer draws the beacon and the HUD prints the line;
 * this decides what is true.
 */

/** Metres. Driving inside this of the marker is arriving — generous, because aiming is not the game. */
const ARRIVE = 9
/** The pickup is at least this far away, or the job is over before the player has read it. */
const MIN_PICKUP = 120
const MAX_PICKUP = 320
/** And the drop is a drive from the pickup rather than round the corner from it. */
const MIN_DROP = 260
const MAX_DROP = 700
/**
 * Seconds per metre of straight-line distance, plus a fixed grace.
 *
 * Deliberately generous: at city pace a car covers about 9 m/s, so 0.22 is roughly two and a half
 * times the time a clean run needs. Failing should mean having stopped rather than having been
 * slow — the first thing this game ever asks of anybody should not be a thing they lose.
 */
const SECONDS_PER_METRE = 0.22
const GRACE = 20
/** Seconds between one job ending and the next being offered. */
const REST = 4

function namedPoints(world) {
  // One point per named road, taken at its midpoint. A road contributes once however long it is,
  // so a delivery is as likely to be a back street as a boulevard.
  const seen = new Map()
  for (const e of world.edges) {
    if (!e.name || seen.has(e.name)) continue
    const pts = e.pts
    const mid = pts[Math.floor(pts.length / 2)]
    if (mid) seen.set(e.name, {name: e.name, x: mid[0], y: mid[1]})
  }
  return [...seen.values()]
}

export function createDelivery(world, rand = Math.random) {
  const places = namedPoints(world)

  const state = {
    phase: 'idle',        // idle | offered | carrying | done | failed
    from: null,           // {name, x, y}
    to: null,
    target: null,         // the point the player is currently driving to
    remaining: 0,
    took: 0,
    message: '',
    rest: 1.5,            // a moment before the first offer, so it does not land during the fade-in
  }

  const far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

  function pick(near, min, max) {
    // A handful of tries rather than a sort: the city has over a thousand named roads and any of
    // them at the right distance will do.
    for (let i = 0; i < 60; i++) {
      const p = places[(rand() * places.length) | 0]
      if (!p) break
      const d = far(p, near)
      if (d >= min && d <= max) return p
    }
    return null
  }

  function offer(car) {
    const from = pick(car, MIN_PICKUP, MAX_PICKUP)
    if (!from) return                       // nowhere suitable this frame; try again next one
    const to = pick(from, MIN_DROP, MAX_DROP)
    if (!to) return
    state.from = from
    state.to = to
    state.target = from
    state.phase = 'offered'
    state.message = `Pickup on ${from.name}`
  }

  return {
    state,
    /** Where the beacon and the map marker go, or null when there is nothing to show. */
    marker: () => (state.phase === 'offered' || state.phase === 'carrying' ? state.target : null),

    /**
     * @param car     the player, for position and for whether they are still driving
     * @param busted  true on the frame the police take them
     */
    update(dt, car, busted = false) {
      // The rest is a hard gate, not a countdown running alongside the phases. An early version
      // decremented it and then fell through to offering in the same frame, so the pause between
      // jobs existed in the variable and not on the screen.
      if (state.rest > 0) {
        state.rest -= dt
        if (state.rest > 0) return
        // Rest over: whatever finished is cleared and the next job may be offered from here.
        state.phase = 'idle'
        state.message = ''
      }

      if (state.phase === 'idle') { offer(car); return }

      if (state.phase === 'offered') {
        if (far(car, state.from) < ARRIVE) {
          state.phase = 'carrying'
          state.target = state.to
          // The timer is set from the distance actually being asked for, so a long job is not
          // harder than a short one — it is longer.
          state.remaining = GRACE + far(state.from, state.to) * SECONDS_PER_METRE
          state.took = 0
          state.message = `Deliver to ${state.to.name}`
        }
        return
      }

      if (state.phase === 'carrying') {
        state.remaining -= dt
        state.took += dt
        if (busted) { finish('failed', 'Busted — delivery lost'); return }
        if (state.remaining <= 0) { finish('failed', 'Too late'); return }
        if (far(car, state.to) < ARRIVE) {
          finish('done', `Delivered — ${state.took.toFixed(0)}s`)
        }
      }
    },
  }

  function finish(phase, message) {
    state.phase = phase
    state.message = message
    state.target = null
    state.from = null
    state.to = null
    state.rest = REST
  }
}
