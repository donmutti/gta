// The wanted system and the cars that enforce it.
//
// Deliberately a toy, not a crime sim: you knock people over, they flip and get up rubbing their
// head, and the police want a word. Nobody is armed and nobody dies. The tension comes from being
// chased through streets you recognise, which is enough.

import {createCar, stepCar, CAR_RADIUS} from './car.js'
import {groundAt} from '../world/ground.js'
import {orientToGround} from './carvisual.js'

/** Metres. Generous, because a near miss at speed should still count as hitting someone. */
const HIT_RADIUS = 2.4
/** A knocked pedestrian is out of action this long, then gets up. */
const DOWN_TIME = 4.0
/**
 * Escape is about DISTANCE, sustained. Inside NO_ESCAPE metres of the nearest car the meter does
 * not fall at all — you are caught, and waiting does not help. Beyond that it falls faster the
 * further you get, reaching FULL_DECAY at CLEAR_RANGE. Losing them is therefore something you do by
 * driving, not by hiding behind a timer.
 */
const NO_ESCAPE = 45
const CLEAR_RANGE = 260
const FULL_DECAY = 11          // heat per second at or beyond CLEAR_RANGE
/** Out of line of sight the ladder falls faster still. */
const UNSEEN_BONUS = 1.5

/**
 * Being caught. A chase with no possible ending but escape is not a chase, it is a countdown that
 * only runs one way — so a cop who has you boxed and stopped eventually gets you out of the car.
 */
const BUST_RANGE = 22
const BUST_SECONDS = 8
/**
 * m/s — 15 km/h. Above this they cannot physically get you out of the car, however close they are,
 * so the clock does not run. It is the condition that makes the rule fair: being chased hard at
 * speed is tense but survivable, and being pinned in traffic with a car alongside is fatal.
 */
const BUST_SPEED = 4.17
/**
 * Breaking away does not instantly clear the clock — it drains, at this multiple of real time.
 * Draining rather than resetting is what makes the rule a pressure instead of a switch: shaking a
 * cop for half a second buys you a little back, and nothing more.
 */
const BUST_RECOVERY = 0.8
const MAX_STARS = 5
/** How close a cop must be to see you at all. */
const SIGHT = 85
/** Cops re-path on a timer, never per frame — the graph search is the one thing here that is not free. */
const REPATH_EVERY = 0.7

const SPEEDING = 24         // m/s past which the police take an interest at all

export function createPolice(world, scene, makeCar, signals) {
  const cops = []
  const state = {
    stars: 0,
    heat: 0,            // rises with crime, decays out of sight; stars are thresholds on it
    since: 0,           // seconds since last seen
    knocked: 0,         // running total, for the HUD
    message: '',
    messageFor: 0,
    cornered: 0,        // seconds spent stopped next to a cop
    busted: false,      // set for one frame when they get you; the caller resets the run
  }

  const scratch = []
  /** The junction we last charged for a red, so one crossing is one offence. */
  let lastRed = null
  const RED = 'red'

  /** Which way along its road the player is travelling: +1 toward b, -1 toward a. */
  function playerDirection(player) {
    const pts = player.road.pts
    const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1]
    return (player.vx * (bx - ax) + player.vy * (by - ay)) >= 0 ? 1 : -1
  }

  function say(text, seconds = 2.5) {
    state.message = text
    state.messageFor = seconds
  }

  function spawnCop(x, y, heading) {
    const car = createCar(x, y, heading)
    // {police: true} is what fits the roof lightbar — without it these were just blue cars with no
    // lights to flash at all. makeCar also hands back a headlight and tail glow, which nothing was
    // switching on either: the renderer only drives the lights of the car it is following.
    const mesh = makeCar(0x2b4f9e, {police: true})
    scene.add(mesh)
    cops.push({
      car, mesh, repathIn: 0, target: null,
      bar: mesh.userData.lightbar ?? null,
      headlight: mesh.userData.headlight ?? null,
      tail: mesh.userData.tailGlow ?? null,
    })
    return cops[cops.length - 1]
  }

  /**
   * Nearest point ON A ROAD to (x, y), with the road's direction there.
   *
   * Dispatch needs this because a point "70m behind the player" is, more often than not, the middle
   * of a building — a cop spawned there is wedged by the collision resolver and sits at 0 m/s for
   * the whole chase. Measured exactly that before this existed.
   */
  function snapToRoad(x, y) {
    let best = null
    for (const e of world.edges) {
      for (let i = 1; i < e.pts.length; i++) {
        const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i]
        const dx = bx - ax, dy = by - ay
        const len2 = dx * dx + dy * dy
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0
        const cx = ax + dx * t, cy = ay + dy * t
        const d2 = (x - cx) ** 2 + (y - cy) ** 2
        if (!best || d2 < best.d2) best = {d2, x: cx, y: cy, heading: Math.atan2(dy, dx)}
      }
    }
    return best
  }

  /**
   * Where a new cop comes from, by how wanted you are.
   *
   * One or two stars and they arrive behind you — a tail. From three they start cutting ahead.
   * At four and five some spawn IN FRONT, so you are boxed rather than merely chased, which is
   * the moment a pursuit stops being a race and becomes a problem.
   */
  function approachAngle(player, stars) {
    if (stars >= 4) return Math.random() < 0.5 ? player.heading : player.heading + Math.PI
    if (stars >= 3) return player.heading + Math.PI + (Math.random() - 0.5) * 1.8
    return player.heading + Math.PI
  }

  /** Put a cop on a street near the player, from whichever side their star level warrants. */
  function dispatch(player) {
    const behind = approachAngle(player, state.stars + 1)
    // Close enough to be a threat, far enough to be a surprise. Spawned at 70-120m and from rest,
    // a cop measured 89m back doing 5.6 m/s after three seconds — never catching anyone, which is
    // a chase in name only. They now arrive already moving, at the speed of traffic.
    const dist = 45 + Math.random() * 30
    const on = snapToRoad(player.x + Math.cos(behind) * dist, player.y + Math.sin(behind) * dist)
    if (!on) return
    // Face along the road, in whichever direction points at the player.
    const toPlayer = Math.atan2(player.y - on.y, player.x - on.x)
    let d = toPlayer - on.heading
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    const heading = Math.abs(d) > Math.PI / 2 ? on.heading + Math.PI : on.heading
    const cop = spawnCop(on.x, on.y, heading)
    const roll = Math.max(Math.abs(player.speed), 12)
    cop.car.vx = Math.cos(heading) * roll
    cop.car.vy = Math.sin(heading) * roll
    cop.car.speed = roll
    say('WANTED — police responding')
  }

  /**
   * Steer a cop toward a point with the same physics the player has. Cops are not on rails: they
   * use the identical car model, so they understeer, scrape walls and lose you — which is the only
   * reason a chase is fun rather than a countdown.
   */
  function driveToward(cop, tx, ty, dt) {
    const dx = tx - cop.car.x, dy = ty - cop.car.y
    const want = Math.atan2(dy, dx)
    let diff = want - cop.car.heading
    while (diff > Math.PI) diff -= Math.PI * 2
    while (diff < -Math.PI) diff += Math.PI * 2

    const dist = Math.hypot(dx, dy)
    const input = {
      // Ease off when pointing the wrong way, or they spend the chase driving into walls at speed.
      throttle: Math.abs(diff) > 1.4 ? 0.45 : (dist > 14 ? 1 : 0.55),
      steer: Math.max(-1, Math.min(1, diff * 1.6)),
      handbrake: false,
    }
    stepCar(cop.car, input, dt, world, scratch)
  }

  return {
    state,
    cops,

    /** Called when the player's car is close enough to a pedestrian to have hit them. */
    knock(ped, player) {
      ped.down = DOWN_TIME
      // Send them tumbling away from the impact rather than straight down — a flip, not a collapse.
      const away = Math.atan2(ped.y - player.y, ped.x - player.x)
      ped.flipX = Math.cos(away) * 3.2
      ped.flipY = Math.sin(away) * 3.2
      state.knocked++
      state.heat += 34
      say('You knocked someone over!')
    },

    update(dt, player, crowd, clock = 0, traffic = null, night = 0) {
      // Light every cop car. The bar strobes blue/red on opposite beats whenever they are actually
      // responding (stars > 0); parked-up patrols keep it dark, which is what makes the strobe mean
      // something when it starts. Headlights and tail glow follow the clock like any other car's.
      const beat = Math.floor(clock * 5) % 2 === 0          // ~5Hz alternation, the real cadence
      const responding = state.stars > 0
      for (const cop of cops) {
        if (cop.bar) {
          cop.bar.blue.emissiveIntensity = responding ? (beat ? 3.4 : 0.12) : 0.05
          cop.bar.red.emissiveIntensity  = responding ? (beat ? 0.12 : 3.4) : 0.05
        }
        if (cop.headlight) cop.headlight.intensity = night * 55
        if (cop.tail) cop.tail.intensity = 2.2 + night * 3.5
      }

      if (state.messageFor > 0) {
        state.messageFor -= dt
        if (state.messageFor <= 0) state.message = ''
      }

      // Crime 1: running people over. Checked against the travelling crowd, which is already the
      // only set of pedestrians anywhere near the car.
      for (const ped of crowd.peds) {
        if (ped.down > 0) continue
        const dx = ped.x - player.x, dy = ped.y - player.y
        if (dx * dx + dy * dy < HIT_RADIUS * HIT_RADIUS && Math.abs(player.speed) > 2) {
          this.knock(ped, player)
        }
      }

      // Crime 2: driving where people walk. Cheap to check and it makes the pedestrian streets of
      // Ville-Haute mean something, which is why they were kept drivable.
      if (player.road?.pedestrianZone && Math.abs(player.speed) > 6) state.heat += 14 * dt
      // Crime 3: speed, but only once they already care.
      if (state.stars > 0 && Math.abs(player.speed) > SPEEDING) state.heat += 3 * dt

      // Crime 4: running a red. Charged ONCE per junction as the car crosses the stop line, not
      // continuously — a per-frame charge would fine you for the whole time you sat in the box.
      if (signals && player.road) {
        const dir = playerDirection(player)
        const ahead = signals.ahead(player.road, dir, clock, player.x, player.y)
        if (ahead && ahead.light === RED && ahead.dist < 6 && Math.abs(player.speed) > 4) {
          if (lastRed !== ahead.junction.id) {
            lastRed = ahead.junction.id
            state.heat += 18
            say('Ran a red light')
          }
        } else if (ahead && ahead.dist > 20) {
          lastRed = null
        }
      }

      // How far away is the nearest car that wants you? That distance, held, is the escape.
      let nearest = Infinity
      for (const cop of cops) {
        const dx = cop.car.x - player.x, dy = cop.car.y - player.y
        const d2 = dx * dx + dy * dy
        if (d2 < nearest) nearest = d2
      }
      nearest = cops.length ? Math.sqrt(nearest) : CLEAR_RANGE
      const seen = nearest < SIGHT

      // Ramp from nothing at NO_ESCAPE to the full rate at CLEAR_RANGE, so the meter visibly
      // starts falling the moment you have put a couple of streets between you.
      const span = Math.max(1, CLEAR_RANGE - NO_ESCAPE)
      const reach = Math.max(0, Math.min(1, (nearest - NO_ESCAPE) / span))
      const decay = FULL_DECAY * reach * (seen ? 1 : UNSEEN_BONUS)
      state.since = seen ? 0 : state.since + dt

// Cornered. Three conditions together: a police car inside 22m, for eight seconds, while you
      // are slow enough to be taken (under 15 km/h). Proximity and time alone would bust a player
      // being chased hard at speed, which is the one moment the game is working; adding the speed
      // gate makes the rule "do not let them pin you" rather than "do not let them near you".
      const catchable = Math.abs(player.speed) < BUST_SPEED
      if (state.stars > 0 && nearest < BUST_RANGE && catchable) {
        state.cornered += dt
        if (state.cornered > BUST_SECONDS) {
          state.busted = true
          state.cornered = 0
          state.heat = 0
          state.stars = 0
          for (const cop of cops) scene.remove(cop.mesh)
          cops.length = 0
          say('BUSTED', 3.5)
          return
        }
        // Count the player down out loud over the last three seconds. A threat you cannot see
        // coming is just a punishment.
        const left = BUST_SECONDS - state.cornered
        if (left < 3) say(`BUSTED IN ${Math.ceil(left)}`, 0.3)
        else if (left < 5) say('They have you pinned — drive!', 0.3)
      } else {
        state.cornered = Math.max(0, state.cornered - dt * BUST_RECOVERY)
      }

      state.heat = Math.max(0, state.heat - decay * dt)
      const stars = Math.min(MAX_STARS, Math.floor(state.heat / 30))
      // One car PER STAR GAINED, not one per transition. A single bad moment can jump the meter
      // two or three levels at once, and dispatching once left three stars with one lone car
      // following you — the escalation was invisible because the force never arrived.
      for (let s = state.stars; s < stars; s++) dispatch(player)
      // Announce the ladder falling — a star lost is the feedback that the escape is working.
      if (stars < state.stars) say(stars === 0 ? 'You lost them' : `Wanted level down — ${stars}`)
      state.stars = stars

      // Retire the force once the meter is clear, so a quiet drive stays quiet.
      if (stars === 0 && cops.length) {
        for (const cop of cops) scene.remove(cop.mesh)
        cops.length = 0
      }

      for (const cop of cops) {
        cop.repathIn -= dt
        if (cop.repathIn <= 0) {
          cop.repathIn = REPATH_EVERY
          // Aim where the player WILL be, not where they are — the difference between a tail and a
          // chase. The lead grows with the star level, so low-level cops trail you and high-level
          // ones cut the corner you are about to take.
          const lead = state.stars >= 3 ? 1.4 : 0.5
          cop.target = {x: player.x + player.vx * lead, y: player.y + player.vy * lead}
        }
        if (cop.target) driveToward(cop, cop.target.x, cop.target.y, dt)

        // Cop against player. stepCar only resolves buildings and street furniture, so without
        // this a pursuing car drives straight THROUGH you — the one collision a player is
        // guaranteed to be staring at. Both cars are pushed, and the heavier blow lands on
        // whoever was doing the closing.
        const dx = cop.car.x - player.x, dy = cop.car.y - player.y
        const min = CAR_RADIUS * 2
        const d2 = dx * dx + dy * dy
        if (d2 < min * min) {
          const d = Math.sqrt(d2) || 0.0001
          const nx = dx / d, ny = dy / d
          const overlap = min - d
          // Separate CONTINUOUSLY, never in one step. Resolving the whole overlap in a single frame
          // teleported both cars metres apart on a hard hit — the impulse below is what a collision
          // is; this is only here to stop two bodies slowly sinking into each other. A few
          // centimetres of slop keeps resting contact from jittering, a fifth of the remainder is
          // taken per frame, and the per-frame step is capped so nothing can ever visibly jump.
          const SLOP = 0.05, BIAS = 0.2, MAX_STEP = 0.12
          const corr = Math.min(MAX_STEP, Math.max(0, overlap - SLOP) * BIAS)
          if (corr > 0) {
            cop.car.x += nx * corr * 0.5
            cop.car.y += ny * corr * 0.5
            player.x -= nx * corr * 0.5
            player.y -= ny * corr * 0.5
          }

          // Exchange the closing speed along the contact normal.
          const rel = (cop.car.vx - player.vx) * nx + (cop.car.vy - player.vy) * ny
          if (rel < 0) {
            const j = rel * 0.85
            cop.car.vx -= nx * j
            cop.car.vy -= ny * j
            player.vx += nx * j
            player.vy += ny * j
            player.contact = true
          }
        }

        // Cops shove traffic aside exactly as the player does, so a pursuit through busy streets
        // scatters cars instead of passing through them.
        if (traffic) {
          traffic.collideWith(cop.car)
          traffic.yieldToSiren(cop.car.x, cop.car.y)
        }

        orientToGround(cop.mesh, cop.car.x, cop.car.y, cop.car.heading, groundAt(cop.car.x, cop.car.y))
      }
    },
  }
}
