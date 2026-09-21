// Ambient traffic. The thing that turns a city you drive through into a city that is already busy
// without you.
//
// These are NOT full physics cars. The police use the real model because a chase has to be able to
// go wrong; traffic just follows the road graph at a sensible speed and is never seen to
// understeer. Forty bicycle-model cars would cost forty collision sweeps a frame and buy nothing —
// nobody watches a background car closely enough to notice it is on rails.

import {makeCarFleet} from '../render/car.js'
import {fleetBox} from './vehicles.js'
import {STOP_LINE, GREEN_LIGHT} from './signals.js'
import {groundAt} from '../world/ground.js'

const COUNT = 120
const CRUISE = 9.5              // m/s, about 34 km/h — city pace
// 34 cars over a 220m radius measured one car per 4,500 square metres — real traffic that nobody
// ever sees. The population is concentrated instead of enlarged: the streets you are on are busy,
// and the ones you are not do not need to be.
const RECYCLE_AT = 260          // beyond this from the player, move them somewhere useful
const RECYCLE_RING = 135
// Where a recycled car is allowed to reappear. It used to be "any edge within 135m, at a random
// point along it", which happily materialised a car twenty metres up the road you were looking at —
// so you drove into something that had not existed a moment earlier. A car may now only appear
// where you cannot see it: either far enough away that the street bends or a building hides it, or
// behind you. RESPAWN_MAX stays below RECYCLE_AT or a fresh car would be recycled on arrival.
const RESPAWN_MIN = 90          // never closer than this, in any direction
const RESPAWN_FAR = 170         // beyond this, ahead is fine — city sightlines rarely run further
const RESPAWN_MAX = 210
const BEHIND_DOT = -0.25        // and "behind" means properly behind, not just off to the side
/** Slow down when the car ahead on the same road is close. Stops them driving through each other. */
const HEADWAY = 12
/**
 * Metres per second per second, when the thing ahead is a person.
 *
 * 7 is roughly what a road car on dry tarmac actually manages — about 0.7g — so from city cruise
 * a driver who sees somebody at six metres stops in time and one who sees them at two does not.
 * That is the correct outcome: this makes traffic TRY, which is what was asked for, rather than
 * making the road safe.
 */
const EMERGENCY_BRAKE = 7
/** Metres at which traffic hears a siren, and how long it keeps its head down afterwards. */
const SIREN_RANGE = 34
const SIREN_HOLD = 2.4
/** Metres from the camera within which a car is hidden rather than drawn across the lens. */
const LENS_RADIUS = 4.8

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createTraffic(world, scene, signals) {
  const rand = mulberry(770119)
  // Only roads wide enough to have two directions; a car crawling down a 4m service alley reads
  // as a mistake rather than as traffic.
  const usable = world.edges.filter(e => e.width >= 6 && e.length > 20 && !e.pedestrianZone)
  if (!usable.length) return {cars: [], update() {}}

  const CELL = 64
  const byCell = new Map()
  for (const e of usable) {
    const mid = e.pts[Math.floor(e.pts.length / 2)]
    const key = `${Math.floor(mid[0] / CELL)}:${Math.floor(mid[1] / CELL)}`
    const bucket = byCell.get(key)
    if (bucket) bucket.push(e)
    else byCell.set(key, [e])
  }
  const edgeNear = (x, y, r) => {
    const found = []
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) {
        const bucket = byCell.get(`${cx}:${cy}`)
        if (bucket) for (const e of bucket) found.push(e)
      }
    }
    return found.length ? found[(rand() * found.length) | 0] : null
  }

  // The fleet is the renderer's — the same hull as the hero car, instanced. Traffic used to be
  // boxes of my own making, which meant one real car surrounded by sixty shoeboxes; worse than if
  // everything had been a box. Mesh authorship stays entirely on that side of the seam.
  const fleet = makeCarFleet(COUNT)
  const paletteSize = Array.isArray(fleet.palette) ? fleet.palette.length
    : (typeof fleet.palette === 'number' && fleet.palette > 0 ? fleet.palette : 8)

  /**
   * A one-way street runs from its first point to its last, which is what OSM's oneway flag means.
   * 424 of the 1,042 streets traffic can use are one-way, so choosing direction at random put
   * roughly half the cars on 41% of Luxembourg facing the wrong way — correct-looking traffic
   * flowing the wrong direction down the old town, which is exactly the kind of thing that reads as
   * broken without anyone being able to say why.
   */
  const legalDir = (edge, preferred) => (edge.oneway ? 1 : preferred)

  /** Can a car enter this edge from `nodeId`? Not if that would mean going up a one-way street. */
  const enterable = (edge, nodeId) => !edge.oneway || edge.a === nodeId

  const cars = []
  for (let i = 0; i < COUNT; i++) {
    cars.push({
      // makeCarFleet reports `palette` as a COUNT, not an array. Reading .length off a number gave
      // undefined and silently fell back to 8, so the fleet only ever used the first eight colours
      // however many the renderer defined. Handle both shapes rather than assume either.
      paint: (rand() * paletteSize) | 0,
      // Seconds left of pulling over for a siren.
      yielding: 0,
      // Which half of a one-way street this car uses. Ignored on two-way roads, where the
      // direction of travel decides the side.
      lane: rand() < 0.5 ? 1 : -1,
      // Shunt: displacement from the rails after being hit, and the spin that goes with it.
      ox: 0, oy: 0, ovx: 0, ovy: 0, spin: 0, spinRate: 0,
      edge: usable[(rand() * usable.length) | 0],
      t: rand(),
      dir: 1,                         // corrected immediately below, once the edge is known
      speed: CRUISE * (0.8 + rand() * 0.4),
      x: 0, y: 0, heading: 0,
    })
  }
  for (const car of cars) car.dir = legalDir(car.edge, rand() < 0.5 ? 1 : -1)
  scene.add(fleet.group)

  function place(car) {
    const pts = car.edge.pts
    const target = car.t * car.edge.length
    let run = 0
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i]
      const seg = Math.hypot(bx - ax, by - ay)
      if (run + seg >= target || i === pts.length - 1) {
        const f = seg > 0 ? Math.min(1, (target - run) / seg) : 0
        const dx = seg > 0 ? (bx - ax) / seg : 1
        const dy = seg > 0 ? (by - ay) / seg : 0
        // Drive on the right, like Luxembourg: a quarter of the width off the centreline puts the
        // car in the middle of its lane, for any road width.
        //
        // A ONE-WAY street is different: every car on it travels the same way, so both halves are
        // legal lanes. Keying the offset off direction alone left all 572 one-way streets with
        // traffic hugging one side and the other half permanently empty — correct, and obviously
        // wrong to look at. Each car picks a side instead and keeps it.
        const side = car.edge.oneway ? car.lane : car.dir
        // Pulling over: out of the lane centre and most of the way to the kerb.
        const laneFrac = car.yielding > 0 ? 0.40 : 0.25
        const off = side * car.edge.width * laneFrac
        car.x = ax + dx * (f * seg) + dy * off
        car.y = ay + dy * (f * seg) - dx * off
        car.heading = Math.atan2(dy * car.dir, dx * car.dir)
        return
      }
      run += seg
    }
  }

  /** Metres. Player circle plus traffic circle; generous, since both are boxes pretending. */
  const HIT = 3.5

  /**
   * The player hitting traffic. Traffic is on rails, so being rammed cannot change the route it is
   * driving — instead it picks up a displacement and a spin that decay back to the lane over a
   * couple of seconds. It reads as a car being knocked aside, and it cannot corrupt the graph
   * position, which is the failure that would have cars driving through walls afterwards.
   */
  function shunt(car, player) {
    const dx = (car.x + car.ox) - player.x, dy = (car.y + car.oy) - player.y
    const d = Math.hypot(dx, dy) || 0.0001
    const nx = dx / d, ny = dy / d
    const closing = (player.vx * nx + player.vy * ny) - 0
    if (closing <= 0.5) return false

    const punch = Math.min(closing, 24)
    car.ovx += nx * punch * 0.55
    car.ovy += ny * punch * 0.55
    // Off-centre hits spin it; a square hit mostly just pushes.
    const tangential = player.vx * -ny + player.vy * nx
    car.spinRate += Math.max(-4, Math.min(4, tangential * 0.12))
    car.cruise = 0

    // The player pays for it too — less than a wall, because the other car moves.
    const into = player.vx * nx + player.vy * ny
    player.vx -= nx * into * 0.55
    player.vy -= ny * into * 0.55
    player.contact = true
    return true
  }

  return {
    cars,
    /** Debug lever: hide the fleet and stop it being drawn. Simulation keeps running either way. */
    setVisible(v) { fleet.group.visible = v },
    /**
     * A police car is coming through. Traffic within earshot slows and edges toward the kerb, and
     * keeps doing it for a moment after the cop has passed — a car that snaps back into lane the
     * instant the siren is level reads as scripted, where one that hesitates reads as a driver.
     */
    yieldToSiren(x, y) {
      for (const car of cars) {
        const dx = car.x - x, dy = car.y - y
        if (dx * dx + dy * dy < SIREN_RANGE * SIREN_RANGE) car.yielding = SIREN_HOLD
      }
    },

    /**
     * Shove any traffic near (x, y) that something moving has run into. Used for police cars, which
     * otherwise drive straight through the traffic they are weaving among — the chase looks wrong
     * long before anyone works out why.
     */
    collideWith(mover) {
      let hits = 0
      for (const car of cars) {
        const dx = (car.x + car.ox) - mover.x, dy = (car.y + car.oy) - mover.y
        if (dx * dx + dy * dy < HIT * HIT) {
          if (shunt(car, mover)) hits++
        }
      }
      return hits
    },
    /** Number of traffic cars the player is currently shunting; the police read this. */
    lastImpacts: 0,
    update(dt, player, clock = 0, eye = null, crowd = null) {
      this.lastImpacts = 0
      for (let i = 0; i < cars.length; i++) {
        const car = cars[i]

        // Keep a gap from whoever is ahead on the same road and going the same way.
        let blocked = false
        for (let j = 0; j < cars.length; j++) {
          if (j === i) continue
          const other = cars[j]
          if (other.edge !== car.edge || other.dir !== car.dir) continue
          const gap = (other.t - car.t) * car.dir * car.edge.length
          if (gap > 0 && gap < HEADWAY) { blocked = true; break }
        }
        // And for the player, so they brake rather than drive through you.
        const pdx = player.x - car.x, pdy = player.y - car.y
        if (pdx * pdx + pdy * pdy < 64) {
          const ahead = Math.cos(car.heading) * pdx + Math.sin(car.heading) * pdy
          if (ahead > 0) blocked = true
        }

        // SOMEBODY IN THE ROAD. Traffic has no right-of-way model and is not getting one here —
        // it does the thing a driver does when a person steps out, which is stand on the brakes.
        //
        // The sight distance is the real stopping distance and not a constant: reaction time at
        // this speed plus v^2 / 2a for the deceleration below. A fixed lookahead either brakes
        // far too early when crawling or far too late at cruise, and the second one is the
        // failure that looked like traffic not caring.
        const box = fleetBox(i)
        const stopIn = Math.max(5, car.cruise * 0.7 + (car.cruise * car.cruise) / (2 * EMERGENCY_BRAKE))
        const personAhead = crowd
          ? crowd.pathAhead(car.x + car.ox, car.y + car.oy, car.heading, box.halfW + 0.5, stopIn)
          : 0
        const panic = personAhead > 0

        // Traffic lights. A car close enough that stopping would need harder braking than it has
        // is treated as committed and goes through on amber, exactly as a driver would.
        const targetNode = car.dir > 0 ? car.edge.b : car.edge.a
        const sig = signals?.ahead(car.edge, car.dir, clock, car.x, car.y)
        if (sig && sig.light !== GREEN_LIGHT) {
          const toStopLine = sig.dist - STOP_LINE
          const committed = toStopLine < 3.5
          if (!committed && toStopLine < Math.max(6, (car.cruise ?? car.speed) * 2.2)) blocked = true
        }

        // Unsignalled junctions: yield to whoever is closer to the box. Not a full right-of-way
        // model — it is the rule that stops two cars arriving at the same crossroads together,
        // which is the only failure anyone actually sees.
        if (!blocked && !signals?.junctions.has(targetNode)) {
          const node = world.nodes[targetNode]
          if (node) {
            const myGap = Math.hypot(node.x - car.x, node.y - car.y)
            if (myGap < 16) {
              for (let j = 0; j < cars.length; j++) {
                if (j === i) continue
                const other = cars[j]
                if (other.edge === car.edge) continue
                const otherTarget = other.dir > 0 ? other.edge.b : other.edge.a
                if (otherTarget !== targetNode) continue
                if (Math.hypot(node.x - other.x, node.y - other.y) < myGap) { blocked = true; break }
              }
            }
          }
        }

        if (car.yielding > 0) car.yielding -= dt
        const want = (blocked || panic) ? 0 : (car.yielding > 0 ? car.speed * 0.28 : car.speed)
        // A driver LIFTS OFF for a red light and STANDS ON THE PEDAL for a person, and the
        // difference between those two is the whole point of this line. The old single rate eased
        // toward the target over most of a second, which is fine for a signal you saw coming and
        // is not braking at all when somebody steps off the kerb.
        const now = car.cruise ?? car.speed
        car.cruise = panic
          ? Math.max(0, now - EMERGENCY_BRAKE * dt)
          : now + (want - now) * Math.min(1, 2.5 * dt)

        car.t += (car.dir * car.cruise * dt) / car.edge.length
        if (car.t > 1 || car.t < 0) {
          const nodeId = car.t > 1 ? car.edge.b : car.edge.a
          const options = (world.nodes[nodeId]?.edges ?? []).filter(id => {
            const e = world.edges[id]
            return e.width >= 6 && !e.pedestrianZone && enterable(e, nodeId)
          })
          const next = options.length ? world.edges[options[(rand() * options.length) | 0]] : car.edge
          car.edge = next
          const enteredAtA = next.a === nodeId
          car.t = enteredAtA ? 0.001 : 0.999
          car.dir = legalDir(next, enteredAtA ? 1 : -1)
        }
        place(car)

        const ddx = car.x - player.x, ddy = car.y - player.y
        if (ddx * ddx + ddy * ddy > RECYCLE_AT * RECYCLE_AT) {
          // Try a few candidate spots and keep the first one the player cannot see. If none of them
          // qualifies (a dead end, or the player parked somewhere with no roads around), leave the
          // car where it is — an unrecycled car far away costs nothing, whereas one conjured into
          // the road ahead costs a crash.
          const hx = Math.cos(player.heading), hy = Math.sin(player.heading)
          const before = {edge: car.edge, t: car.t, dir: car.dir, x: car.x, y: car.y}
          let placed = false
          for (let attempt = 0; attempt < 8 && !placed; attempt++) {
            const fresh = edgeNear(player.x, player.y, RESPAWN_MAX)
            if (!fresh) break
            car.edge = fresh
            car.t = rand()
            car.dir = legalDir(fresh, rand() < 0.5 ? 1 : -1)
            place(car)
            const rx = car.x - player.x, ry = car.y - player.y
            const d = Math.hypot(rx, ry)
            if (d < RESPAWN_MIN || d > RESPAWN_MAX) continue
            const ahead = d > 0 ? (rx * hx + ry * hy) / d : 1
            if (d >= RESPAWN_FAR || ahead <= BEHIND_DOT) placed = true
          }
          if (!placed) {
            car.edge = before.edge; car.t = before.t; car.dir = before.dir
            car.x = before.x; car.y = before.y
          }
        }

        // Apply and decay any shunt, then draw where the car actually ended up.
        if (car.ovx || car.ovy || car.ox || car.oy || car.spinRate || car.spin) {
          car.ox += car.ovx * dt
          car.oy += car.ovy * dt
          car.spin += car.spinRate * dt
          const drag = Math.exp(-2.6 * dt)
          car.ovx *= drag
          car.ovy *= drag
          car.spinRate *= drag
          // Ease back into the lane once the energy is gone, rather than leaving it parked askew.
          const settle = Math.exp(-1.1 * dt)
          car.ox *= settle
          car.oy *= settle
          car.spin *= settle
          if (Math.abs(car.ox) < 0.01 && Math.abs(car.oy) < 0.01) { car.ox = 0; car.oy = 0 }
        }

        const pdx2 = (car.x + car.ox) - player.x, pdy2 = (car.y + car.oy) - player.y
        if (pdx2 * pdx2 + pdy2 * pdy2 < HIT * HIT) {
          if (shunt(car, player)) this.lastImpacts++
        }

        // Knock over anybody under this vehicle. Until now the player was the only thing in the
        // city that could touch a person, so buses drove through crowds and nobody flinched —
        // which is the loudest possible reminder that the other traffic is scenery.
        //
        // The box is this slot's OWN measured footprint, from the same table the renderer draws
        // from, so a bus catches people along ten metres of flank and a sedan does not. The cost
        // is one bucket lookup per vehicle, not a sweep of the crowd: see crowd.strike.
        if (crowd) {
          // Traffic cars carry no velocity vector — they move along an edge — so it is built from
          // the heading and the speed they are ACTUALLY doing, which after the braking above may
          // be nothing like their cruise. Measured undefined on the first attempt at this.
          crowd.strike(car.x + car.ox, car.y + car.oy, car.heading + car.spin,
            Math.cos(car.heading) * car.cruise, Math.sin(car.heading) * car.cruise,
            car.cruise, box)
        }

        // A car inside the camera is a wall of paint across the screen; drop it far below the
        // world for the frame instead. The fleet API has no hide, and a stale matrix would leave
        // it parked in mid-air where it was last drawn.
        const ex = eye ? (car.x + car.ox) - eye.x : 999
        const ey = eye ? (car.y + car.oy) - eye.y : 999
        if (eye && ex * ex + ey * ey < LENS_RADIUS * LENS_RADIUS) {
          fleet.setAt(i, 1e6, 1e6, 0, car.paint)
        } else {
          fleet.setAt(i, car.x + car.ox, -(car.y + car.oy), car.heading + car.spin + Math.PI / 2, car.paint)
        }
      }
    },
  }
}
