// Ambient traffic. The thing that turns a city you drive through into a city that is already busy
// without you.
//
// These are NOT full physics cars. The police use the real model because a chase has to be able to
// go wrong; traffic just follows the road graph at a sensible speed and is never seen to
// understeer. Forty bicycle-model cars would cost forty collision sweeps a frame and buy nothing —
// nobody watches a background car closely enough to notice it is on rails.

import {makeCarFleet} from '../render/car.js'
import {fleetBox, VEHICLE_BOX, boxContact} from './vehicles.js'
import {STOP_LINE, GREEN_LIGHT} from './signals.js'
import {createLanePath, createJunctionPath, samplePath} from './traffic-path.js'

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
      pullOver: 0,
      // Which half of a one-way street this car uses. Ignored on two-way roads, where the
      // direction of travel decides the side.
      lane: rand() < 0.5 ? 1 : -1,
      // Shunt: displacement from the rails after being hit, and the spin that goes with it.
      ox: 0, oy: 0, ovx: 0, ovy: 0, spin: 0, spinRate: 0,
      edge: usable[(rand() * usable.length) | 0],
      t: rand(),
      dir: 1,                         // corrected immediately below, once the edge is known
      speed: CRUISE * (0.8 + rand() * 0.4),
      x: 0, y: 0, heading: 0, face: undefined, snapFace: false,
      box: fleetBox(i),
    })
  }
  for (const car of cars) car.dir = legalDir(car.edge, rand() < 0.5 ? 1 : -1)
  scene.add(fleet.group)

  const lanePaths = new Map()
  function pathFor(car, edge = car.edge, dir = car.dir) {
    const radius = car.box === VEHICLE_BOX.bus ? 12 : 7
    const key = `${edge.id}:${dir}:${edge.oneway ? car.lane : 1}:${radius}`
    if (!lanePaths.has(key)) lanePaths.set(key, createLanePath(edge, dir, car.lane, radius))
    return lanePaths.get(key)
  }

  function place(car) {
    const path = car.junction?.active ? car.junction.path : pathFor(car)
    const distance = car.junction?.active ? car.junction.distance : (car.dir > 0 ? car.t : 1 - car.t) * path.length
    const pose = samplePath(path, distance)
    car.x = pose.x + Math.sin(pose.heading) * car.pullOver
    car.y = pose.y - Math.cos(pose.heading) * car.pullOver
    car.heading = car.face = pose.heading
    car.snapFace = false
  }

  function planJunction(car) {
    if (car.junction) return
    const node = car.dir > 0 ? car.edge.b : car.edge.a
    let options = (world.nodes[node]?.edges ?? []).map(id => world.edges[id])
      .filter(edge => edge.width >= 6 && !edge.pedestrianZone && enterable(edge, node))
    // Returning along the incoming edge is a dead-end manoeuvre, not a random choice at
    // every crossroads. The old choice frequently asked buses to reverse direction in place.
    const onward = options.filter(edge => edge !== car.edge)
    if (onward.length) options = onward
    if (!options.length) return
    const edge = options[(rand() * options.length) | 0]
    const dir = legalDir(edge, edge.a === node ? 1 : -1)
    const path = createJunctionPath(pathFor(car), pathFor(car, edge, dir), car.box === VEHICLE_BOX.bus ? 12 : 7)
    car.junction = {edge, dir, path, active: false, distance: 0}
  }

  function advanceRoute(car, distance) {
    const beforeOffset = car.pullOver
    const desiredOffset = car.yielding > 0 ? car.edge.width * 0.15 : 0
    car.pullOver += Math.max(-distance * 0.08, Math.min(distance * 0.08, desiredOffset - car.pullOver))
    const path = pathFor(car), junction = car.junction
    if (junction?.active) {
      junction.distance += distance
    } else {
      const next = (car.dir > 0 ? car.t : 1 - car.t) * path.length + distance
      if (junction && next >= junction.path.start) {
        junction.active = true
        junction.distance = next - junction.path.start
      } else {
        const fraction = Math.min(1, next / path.length)
        car.t = car.dir > 0 ? fraction : 1 - fraction
      }
    }
    if (junction?.active && junction.distance >= junction.path.length) {
      car.edge = junction.edge; car.dir = junction.dir
      const fraction = Math.min(1, (junction.path.end + junction.distance - junction.path.length) / pathFor(car).length)
      car.t = car.dir > 0 ? fraction : 1 - fraction
      car.junction = null
    }
    place(car)
    if (distance > 0.001) {
      car.face -= Math.atan2(car.pullOver - beforeOffset, distance)
      car.heading = car.face
    }
  }

  for (const car of cars) place(car)

  /**
   * The player hitting traffic. Traffic is on rails, so being rammed cannot change the route it is
   * driving — instead it picks up a displacement and a spin that decay back to the lane over a
   * couple of seconds. It reads as a car being knocked aside, and it cannot corrupt the graph
   * position, which is the failure that would have cars driving through walls afterwards.
   */
  function shunt(car, player) {
    const hit = boxContact(car.x + car.ox, car.y + car.oy, car.face + car.spin, car.box,
      player.x, player.y, player.heading, VEHICLE_BOX.car)
    if (!hit) return false
    const {nx, ny, depth} = hit
    const trafficShare = car.box === VEHICLE_BOX.bus ? 0.25 : 0.5
    car.ox += nx * (depth + 0.001) * trafficShare
    car.oy += ny * (depth + 0.001) * trafficShare
    player.x -= nx * (depth + 0.001) * (1 - trafficShare)
    player.y -= ny * (depth + 0.001) * (1 - trafficShare)
    const cvx = Math.cos(car.face) * (car.cruise ?? 0) + car.ovx
    const cvy = Math.sin(car.face) * (car.cruise ?? 0) + car.ovy
    const closing = (player.vx - cvx) * nx + (player.vy - cvy) * ny
    player.contact = true
    if (closing <= 0) return false

    const punch = Math.min(closing, 24)
    car.ovx += nx * punch * 0.55
    car.ovy += ny * punch * 0.55
    // Off-centre hits spin it; a square hit mostly just pushes.
    const tangential = player.vx * -ny + player.vy * nx
    car.spinRate += Math.max(-4, Math.min(4, tangential * 0.12))
    car.cruise = 0

    // The player pays for it too — less than a wall, because the other car moves.
    player.vx -= nx * closing * (1 - trafficShare)
    player.vy -= ny * closing * (1 - trafficShare)
    return closing > 0.5
  }

  function separateTraffic() {
    // Headway is anticipation, not a contact solver: crossing roads and a bus's long
    // overhang still need real hulls. Iterate contacts before publishing any fleet matrices.
    for (let pass = 0; pass < 4; pass++) {
      let contacts = 0
      for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i], b = cars[j]
        const hit = boxContact(a.x + a.ox, a.y + a.oy, a.face + a.spin, a.box,
          b.x + b.ox, b.y + b.oy, b.face + b.spin, b.box, 0.02)
        if (!hit) continue
        contacts++
        const push = (hit.depth + 0.001) / 2
        a.ox += hit.nx * push; a.oy += hit.ny * push
        b.ox -= hit.nx * push; b.oy -= hit.ny * push
        if (Math.cos(a.face) * hit.nx + Math.sin(a.face) * hit.ny < 0) a.cruise = 0
        if (Math.cos(b.face) * hit.nx + Math.sin(b.face) * hit.ny > 0) b.cruise = 0
      }
      if (!contacts) break
    }
  }

  function render(eye) {
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]
      const x = car.x + car.ox, y = car.y + car.oy
      const hide = eye && (x - eye.x) ** 2 + (y - eye.y) ** 2 < LENS_RADIUS ** 2
      fleet.setAt(i, hide ? 1e6 : x, hide ? 1e6 : -y, car.face + car.spin + Math.PI / 2, car.paint)
    }
  }

  return {
    cars,
    render,
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
        if (shunt(car, mover)) hits++
      }
      return hits
    },
    /** Number of traffic cars the player is currently shunting; the police read this. */
    lastImpacts: 0,
    update(dt, player, clock = 0, eye = null, crowd = null) {
      this.lastImpacts = 0
      for (let i = 0; i < cars.length; i++) {
        const car = cars[i]
        planJunction(car)

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
        const velocity = car.cruise ?? car.speed
        const stopIn = box.halfL + Math.max(5, velocity * 0.7 + (velocity * velocity) / (2 * EMERGENCY_BRAKE))
        const personAhead = crowd
          ? crowd.pathAhead(car.x + car.ox, car.y + car.oy, car.face, box.halfW + 0.5, stopIn)
          : 0
        const panic = personAhead > 0

        // Traffic lights. A car close enough that stopping would need harder braking than it has
        // is treated as committed and goes through on amber, exactly as a driver would.
        const targetNode = car.dir > 0 ? car.edge.b : car.edge.a
        const sig = signals?.ahead(car.edge, car.dir, clock, car.x, car.y)
        if (!car.junction?.active && sig && sig.light !== GREEN_LIGHT) {
          const toStopLine = sig.dist - STOP_LINE
          const committed = toStopLine < 3.5
          if (!committed && toStopLine < Math.max(6, (car.cruise ?? car.speed) * 2.2)) blocked = true
        }

        // Unsignalled junctions: yield to whoever is closer to the box. Not a full right-of-way
        // model — it is the rule that stops two cars arriving at the same crossroads together,
        // which is the only failure anyone actually sees.
        if (!blocked && !car.junction?.active && !signals?.junctions.has(targetNode)) {
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
        const path = car.junction?.active ? car.junction.path : pathFor(car)
        const distance = car.junction?.active ? car.junction.distance : (car.dir > 0 ? car.t : 1 - car.t) * path.length
        const aheadPose = samplePath(path, distance + Math.max(3, car.cruise ?? car.speed))
        const bend = Math.abs(Math.atan2(Math.sin(aheadPose.heading - car.heading), Math.cos(aheadPose.heading - car.heading)))
        const entering = car.junction && !car.junction.active && car.junction.path.start - distance < 12
        const cornerSpeed = car.junction?.active || entering || bend > 0.2 ? (car.box === VEHICLE_BOX.bus ? 4.5 : 6) : car.speed
        const want = (blocked || panic) ? 0 : Math.min(cornerSpeed, car.yielding > 0 ? car.speed * 0.28 : car.speed)
        // A driver LIFTS OFF for a red light and STANDS ON THE PEDAL for a person, and the
        // difference between those two is the whole point of this line. The old single rate eased
        // toward the target over most of a second, which is fine for a signal you saw coming and
        // is not braking at all when somebody steps off the kerb.
        const now = car.cruise ?? car.speed
        car.cruise = panic
          ? Math.max(0, now - EMERGENCY_BRAKE * dt)
          : now + (want - now) * Math.min(1, 2.5 * dt)

        advanceRoute(car, car.cruise * dt)

        const ddx = car.x - player.x, ddy = car.y - player.y
        if (ddx * ddx + ddy * ddy > RECYCLE_AT * RECYCLE_AT) {
          // Try a few candidate spots and keep the first one the player cannot see. If none of them
          // qualifies (a dead end, or the player parked somewhere with no roads around), leave the
          // car where it is — an unrecycled car far away costs nothing, whereas one conjured into
          // the road ahead costs a crash.
          const hx = Math.cos(player.heading), hy = Math.sin(player.heading)
          const before = {edge: car.edge, t: car.t, dir: car.dir, x: car.x, y: car.y, face: car.face, heading: car.heading, junction: car.junction}
          let placed = false
          for (let attempt = 0; attempt < 8 && !placed; attempt++) {
            const fresh = edgeNear(player.x, player.y, RESPAWN_MAX)
            if (!fresh) break
            car.edge = fresh
            car.junction = null
            car.t = rand()
            car.dir = legalDir(fresh, rand() < 0.5 ? 1 : -1)
            // A recycled car is somewhere else entirely, out of sight, so it points down its new
            // road at once rather than easing round from the heading it had across town.
            car.snapFace = true
            place(car)
            const rx = car.x - player.x, ry = car.y - player.y
            const d = Math.hypot(rx, ry)
            if (d < RESPAWN_MIN || d > RESPAWN_MAX) continue
            const ahead = d > 0 ? (rx * hx + ry * hy) / d : 1
            if (d >= RESPAWN_FAR || ahead <= BEHIND_DOT) {
              placed = !cars.some(other => other !== car && boxContact(car.x, car.y, car.face, car.box,
                other.x + other.ox, other.y + other.oy, other.face + other.spin, other.box, 2))
            }
          }
          if (!placed) {
            car.edge = before.edge; car.t = before.t; car.dir = before.dir
            car.x = before.x; car.y = before.y
            car.face = before.face; car.heading = before.heading; car.snapFace = false; car.junction = before.junction
          } else {
            car.ox = car.oy = car.ovx = car.ovy = car.spin = car.spinRate = 0
            car.pullOver = 0
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

        if (shunt(car, player)) this.lastImpacts++

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
          crowd.strike(car.x + car.ox, car.y + car.oy, car.face + car.spin,
            Math.cos(car.face) * car.cruise, Math.sin(car.face) * car.cruise,
            car.cruise, box)
        }

      }
      separateTraffic()
    },
  }
}
