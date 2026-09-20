// Traffic lights.
//
// The state machine and who must stop live here; the signal heads themselves are the renderer's.
// This module never touches a mesh — it publishes a phase per junction and a helper that answers
// "may a car on this edge enter this junction right now", and the renderer reads the same phase to
// light the correct lamp.
//
// Phases are derived from the clock and a per-junction offset rather than stored and ticked. That
// makes them deterministic: the same second always gives the same state, a reload does not
// desynchronise anything, and there is no accumulated drift to debug at four in the morning.

/** Seconds. One full cycle: group A green, both red briefly, group B green, both red. */
const GREEN = 11
const AMBER = 2.4
const ALL_RED = 1.2
const HALF = GREEN + AMBER + ALL_RED
const CYCLE = HALF * 2

/** A junction needs at least this many approaches to be worth signalising. */
const MIN_DEGREE = 3
/** Metres before the junction where a car must have stopped. */
export const STOP_LINE = 7

export const GREEN_LIGHT = 'green'
export const AMBER_LIGHT = 'amber'
export const RED_LIGHT = 'red'

/**
 * Build the signalised junctions.
 *
 * `world.signals`, when the fetcher provides it, is a list of real OSM traffic-signal coordinates;
 * each is snapped to its nearest graph node. Without it, the busiest junctions are signalised
 * instead, so the system works either way and simply gets more honest when the data arrives.
 */
export function createSignals(world) {
  const junctions = new Map()   // nodeId -> {id, x, y, groupOf: Map(edgeId -> 0|1), offset}

  const candidates = []
  if (Array.isArray(world.signals) && world.signals.length) {
    for (const [sx, sy] of world.signals) {
      let best = null
      for (const node of world.nodes) {
        if (node.edges.length < 2) continue
        const d2 = (node.x - sx) ** 2 + (node.y - sy) ** 2
        if (!best || d2 < best.d2) best = {node, d2}
      }
      // A signal more than 30m from any junction is signalling something we did not model.
      if (best && best.d2 < 30 * 30) candidates.push(best.node)
    }
  } else {
    for (const node of world.nodes) if (node.edges.length >= MIN_DEGREE) candidates.push(node)
  }

  for (const node of candidates) {
    if (junctions.has(node.id)) continue

    // Sort the approaches into two opposing groups. A bearing and its reverse are the same street,
    // so the angle is taken mod 180 and split about the median — which turns a crossroads into the
    // two phases a driver expects rather than four independent arms.
    const bearings = []
    for (const edgeId of node.edges) {
      const edge = world.edges[edgeId]
      if (!edge) continue
      const far = edge.a === node.id ? edge.pts[1] : edge.pts[edge.pts.length - 2]
      if (!far) continue
      let deg = (Math.atan2(far[1] - node.y, far[0] - node.x) * 180) / Math.PI
      deg = ((deg % 180) + 180) % 180
      bearings.push({edgeId, deg})
    }
    if (bearings.length < MIN_DEGREE) continue

    const sorted = [...bearings].sort((p, q) => p.deg - q.deg)
    const pivot = sorted[Math.floor(sorted.length / 2)].deg
    const groupOf = new Map()
    for (const b of bearings) {
      // Distance on a circle of 180 degrees, so 5 and 175 are neighbours rather than opposites.
      const raw = Math.abs(b.deg - pivot)
      const gap = Math.min(raw, 180 - raw)
      groupOf.set(b.edgeId, gap < 45 ? 0 : 1)
    }

    junctions.set(node.id, {
      id: node.id,
      x: node.x,
      y: node.y,
      groupOf,
      // Deterministic per-junction offset, so the whole city does not blink in unison.
      offset: (node.id * 7.37) % CYCLE,
    })
  }

  /** The light shown to `group` (0 or 1) at this junction, at time `t` seconds. */
  function lightFor(junction, group, t) {
    const phase = (t + junction.offset) % CYCLE
    const mine = group === 0 ? phase : phase - HALF
    const within = ((mine % CYCLE) + CYCLE) % CYCLE
    if (within < GREEN) return GREEN_LIGHT
    if (within < GREEN + AMBER) return AMBER_LIGHT
    return RED_LIGHT
  }

  return {
    junctions,

    /** Published for the renderer: what each junction is showing right now. */
    lightFor,

    /**
     * May something on `edgeId` enter `nodeId` now?
     *
     * Amber counts as go for anything already committed — a car that would have to brake harder
     * than it can stop for is better off through the junction, which is also what a driver does.
     */
    mayEnter(nodeId, edgeId, t, committed = false) {
      const junction = junctions.get(nodeId)
      if (!junction) return true
      const group = junction.groupOf.get(edgeId)
      if (group === undefined) return true
      const light = lightFor(junction, group, t)
      if (light === GREEN_LIGHT) return true
      if (light === AMBER_LIGHT) return committed
      return false
    },

    /** The junction a point is approaching on this edge, if it is close enough to matter. */
    ahead(edge, dir, t, x, y) {
      const nodeId = dir > 0 ? edge.b : edge.a
      const junction = junctions.get(nodeId)
      if (!junction) return null
      const dist = Math.hypot(junction.x - x, junction.y - y)
      if (dist > 45) return null
      const group = junction.groupOf.get(edge.id)
      return {junction, dist, group, light: lightFor(junction, group ?? 0, t)}
    },
  }
}
