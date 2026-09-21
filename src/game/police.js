// The wanted system and the cars that enforce it.
//
// Deliberately a toy, not a crime sim: you knock people over, they flip and get up rubbing their
// head, and the police want a word. Nobody is armed and nobody dies. The tension comes from being
// chased through streets you recognise, which is enough.

import {createCar, stepCar, CAR_RADIUS} from './car.js'
import {VEHICLE_BOX, broadRadius, inBox, SHOULDER} from './vehicles.js'
import {groundAt} from '../world/ground.js'
import {orientToGround} from './carvisual.js'

/** Metres. Generous, because a near miss at speed should still count as hitting someone. */
// The player drives the sedan hull, so their strike box is the sedan's — measured, not guessed.
//
// This used to be a single circle of radius 2.4m about the car's centre, and it was wrong in both
// directions at once. Sideways it reached 1.3m past the doors, so people died with clear air
// between them and the paintwork, which is what it looked like and what somebody playing it
// reported. Lengthways it fell SHORT: the front corners sit 2.47m out, so clipping a pedestrian
// with the corner of the bumper did nothing at all.
const HERO_BOX = VEHICLE_BOX.car
/** Broad phase only. Nothing outside this circle can be inside the box, so the cheap test stands. */
const HIT_RADIUS = broadRadius(HERO_BOX, SHOULDER)
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
/**
 * Every crime's heat, divided by this before it lands.
 *
 * A knockdown used to add 34 against a first-star threshold of 30, so **one accidental pedestrian
 * made you wanted** — which is what the owner reported after playing it: "you run people over
 * accidentally all the time". He asked for a grace band rather than a gentler ramp: below one
 * star nothing responds at all, and it should take roughly ten knockdowns to get there.
 *
 * Dividing every crime by ten rather than lowering the knockdown alone is deliberate. Knocking a
 * person down at 3 while a red light still cost 18 would make a traffic signal six times graver
 * than a human being, which is a proportion nobody asked for and nobody would defend. One factor
 * on all of them keeps every crime worth exactly what it was worth relative to the others.
 */
const CRIME = 10
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

  /**
   * The standing force: a fixed number of police cars planted across the city at start, parked,
   * always on the map, and never removed.
   *
   * The owner's design, and his reason: a player should be able to SEE where the danger is and
   * drive around it, rather than being caught by an ambush they could not have anticipated. Before
   * this, pursuit was conjured — `dispatch()` put a car 45 to 75 metres behind the player, already
   * at the player's speed, at the instant a star landed. Nothing to see coming and nothing to
   * avoid.
   *
   * THE STANDING FORCE IS THE SOURCE OF PURSUIT, and that is the whole of why it is worth having.
   * Thirty visible cars beside a thirty-first that is still conjured would be decoration: the
   * player would route around every dot on the map and be ambushed anyway, which is worse than
   * today because it teaches that the map is reliable and then breaks it.
   *
   * The price, stated rather than discovered: thirty cars over 2,872 by 3,300 metres is a mean
   * spacing of 562 metres, so the nearest responder now starts several hundred metres away and
   * from rest, where it used to arrive at 45 metres already moving. Chases are markedly easier.
   * That is what was asked for.
   *
   * A parked cop costs a position and a dot. Only a responding one runs the car model, so the
   * frame cost is what it always was until somebody is actually being chased.
   */
  const STANDING = 30

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

  /**
   * Plant the standing force on a grid across the city, each car snapped to the nearest road.
   *
   * A grid rather than random points, because "uniformly across the city" is what was asked for
   * and thirty random draws clump. The jitter keeps them off a visible lattice.
   */
  function plantStandingForce() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const e of world.edges) for (const [x, y] of e.pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
    const cols = Math.ceil(Math.sqrt(STANDING * (maxX - minX) / Math.max(1, maxY - minY)))
    const rows = Math.ceil(STANDING / cols)
    let n = 0
    for (let r = 0; r < rows && n < STANDING; r++) {
      for (let c = 0; c < cols && n < STANDING; c++) {
        const fx = (c + 0.5) / cols, fy = (r + 0.5) / rows
        const jx = (Math.random() - 0.5) * (maxX - minX) / cols * 0.5
        const jy = (Math.random() - 0.5) * (maxY - minY) / rows * 0.5
        const on = snapToRoad(minX + fx * (maxX - minX) + jx, minY + fy * (maxY - minY) + jy)
        if (!on) continue
        const cop = spawnCop(on.x, on.y, on.heading)
        cop.standing = true          // never retired, and parked until a star lands
        n++
      }
    }
    return n
  }

  /** Put a cop on a street near the player, from whichever side their star level warrants. */
  function dispatch(player) {
    // NOTHING IS CONJURED. The nearest standing car that is not already chasing starts moving,
    // so what comes for the player is a car that was on the map before the crime.
    let best = null, bestD = Infinity
    for (const cop of cops) {
      if (cop.chasing) continue
      const d = Math.hypot(cop.car.x - player.x, cop.car.y - player.y)
      if (d < bestD) { bestD = d; best = cop }
    }
    if (!best) return
    best.chasing = true
    // From rest, on the road it was parked on. The old version handed a conjured car the player's
    // own speed because it appeared behind them and would otherwise never catch up; a car that was
    // already there does not need the gift.
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

  plantStandingForce()

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
      // Who hit them, so the crowd grades the tumble by THIS vehicle rather than by whatever is
      // passed in as `car` when it steps. It matters now that buses can knock people over too.
      ped.hitBy = {vx: player.vx, vy: player.vy, speed: player.speed}
      state.knocked++
      state.heat += 34 / CRIME
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
      //
      // Two phases, and the cost is the point. The circle is the same single squared-distance
      // compare per person the old test was, and it rejects all but the one or two people who are
      // genuinely alongside. Only those get turned into the car's own frame — four multiplies and
      // two compares — so the exact test runs a couple of times a frame rather than 340. The two
      // trig calls are hoisted out of the loop, where the old code had none and was wrong.
      const moving = Math.abs(player.speed) > 2
      const fx = Math.cos(player.heading), fy = Math.sin(player.heading)
      for (const ped of crowd.peds) {
        if (ped.down > 0) continue
        const dx = ped.x - player.x, dy = ped.y - player.y
        if (dx * dx + dy * dy > HIT_RADIUS * HIT_RADIUS) continue
        if (!moving) continue
        if (inBox(ped.x, ped.y, player.x, player.y, fx, fy, HERO_BOX, SHOULDER)) {
          this.knock(ped, player)
        }
      }

      // Crime 2: driving where people walk. Cheap to check and it makes the pedestrian streets of
      // Ville-Haute mean something, which is why they were kept drivable.
      if (player.road?.pedestrianZone && Math.abs(player.speed) > 6) state.heat += 14 * dt / CRIME
      // Crime 3: speed, but only once they already care.
      if (state.stars > 0 && Math.abs(player.speed) > SPEEDING) state.heat += 3 * dt / CRIME

      // Crime 4: running a red. Charged ONCE per junction as the car crosses the stop line, not
      // continuously — a per-frame charge would fine you for the whole time you sat in the box.
      if (signals && player.road) {
        const dir = playerDirection(player)
        const ahead = signals.ahead(player.road, dir, clock, player.x, player.y)
        if (ahead && ahead.light === RED && ahead.dist < 6 && Math.abs(player.speed) > 4) {
          if (lastRed !== ahead.junction.id) {
            lastRed = ahead.junction.id
            state.heat += 18 / CRIME
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
      // BELOW THE FIRST STAR THE METER DOES NOT DRAIN, and without this the grace band does not
      // exist. Heat decays at up to 16.5 a second when nobody is chasing you; a knockdown now adds
      // 3.4. Ten of those reach the first star only if they land inside about two seconds, which
      // is not "you can run over about ten people before your first star" — it is a meter that can
      // never fill. So under one star the count accumulates and the drain is off: the band is a
      // tally of what you have done, and it starts behaving like a meter the moment the police
      // are actually interested.
      const decay = state.stars === 0 ? 0 : FULL_DECAY * reach * (seen ? 1 : UNSEEN_BONUS)
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
          for (const cop of cops) { cop.chasing = false; cop.target = null }
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

      // The force is never retired. A cleared meter sends everybody back to parked rather than
      // deleting them: they are the city's standing police and the map is meant to be the truth
      // about where they are, which it cannot be if they vanish whenever the player is clean.
      if (stars === 0) {
        for (const cop of cops) { cop.chasing = false; cop.target = null }
      }

      for (const cop of cops) {
        // Parked. No repath, no stepCar, no collision resolution — a standing car is a position
        // and a dot until it is told to move, which is what keeps thirty of them free.
        if (!cop.chasing) continue
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
