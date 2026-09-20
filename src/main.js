// Entry point and frame loop. Owns the clock, the input, the car and the camera; asks the renderer
// for a scene and hands it nothing but numbers. See INTERFACES.md — createScene's return is the
// only thing this file may rely on, and it never reaches into a material.

import * as THREE from 'three'
import {buildWorld} from './world/model.js'
import {groundAt, setGroundSampler, setNormalSampler} from './world/ground.js'
import {groundHeight, groundNormal} from './world/terrain.js'
import {createScene, makeCar} from './render/scene.js'
import {createCar, stepCar} from './game/car.js'
import {createInput} from './game/input.js'
import {createChaseCamera, updateChase, resetChase, shakeCamera, createBirdCamera, updateBird, zoomBird, restoreUp} from './game/camera.js'
import {createCarVisual, updateCarVisual} from './game/carvisual.js'
import {createMinimap} from './game/minimap.js'
import {createBigMap} from './game/bigmap.js'
import {createFeedback} from './game/feedback.js'
import {createPicker} from './game/picker.js'
import {createAudio} from './game/audio.js'
import {createHud} from './game/hud.js'
import {createPedestrians} from './game/pedestrians.js'
import {createPolice} from './game/police.js'
import {createTraffic} from './game/traffic.js'
import {createSignals} from './game/signals.js'

// Boot screen progress. The overlay lives in index.html so it is already on screen; all this does
// is name the stage, because a dev-mode cold start spends ten-plus seconds between here and the
// first frame and a motionless screen is indistinguishable from a hang.
const bootStatus = document.getElementById('boot-status')
const bootBar = document.getElementById('boot-bar')
const BOOT_STEPS = 5
let bootStep = 0
// Numbered AND filled to match: "still working" is only half the answer — the other half is how
// much is left, and a bar that says 1/5 while sitting half full is just a decoration.
const boot = (msg) => {
  bootStep++
  if (bootStatus) bootStatus.textContent = `${bootStep}/${BOOT_STEPS}  ${msg}`
  if (bootBar) bootBar.style.width = `${(bootStep / BOOT_STEPS) * 100}%`
}

boot('downloading the city…')
// The airport is fetched alongside the city because the world model needs it: its field has to be
// inside the drivable bounds, or the map edge closes between the city and the terminal.
const [city, findel] = await Promise.all([
  fetch('/data/city.json').then(r => r.json()),
  fetch('/data/findel.json').then(r => r.ok ? r.json() : null).catch(() => null),
])
boot('laying out streets and buildings…')
const world = buildWorld(city, findel)
world.findel = findel
world.parcels = city.parcels ?? []     // cut by tools/parcels.mjs; the land under everything

// S3: the simulation starts reading the terrain. groundAt takes WORLD MAP coordinates with +y
// north; groundHeight takes Three's z, which is -mapY — the sign lives here, in one place, rather
// than at each of the call sites that would otherwise each have to remember it.
setGroundSampler((x, y) => groundHeight(x, -y))
setNormalSampler((x, y) => (groundNormal ? groundNormal(x, -y) : {x: 0, y: 1, z: 0}))
boot('raising the city…')
const {scene, camera, renderer, update, follow, resize} = createScene(world)

document.getElementById('app').appendChild(renderer.domElement)
const fit = () => resize(window.innerWidth, window.innerHeight)
window.addEventListener('resize', fit)
fit()

// Spawn on the longest real street in the slice, pointing along it. Picking a named road rather
// than a coordinate means the spawn survives any later change to the slice.
function spawnPoint() {
  // Nearest big street to the slice centre, entered at its midpoint. The longest road in the slice
  // runs to the boundary, so spawning at its first vertex put the player in the corner of the map
  // facing off the edge of the world — technically a road, and a terrible first frame.
  let best = null
  for (const e of world.edges) {
    if (e.kind !== "primary" && e.kind !== "secondary" && e.kind !== "tertiary") continue
    if (e.length < 40) continue
    const mid = e.pts[Math.floor(e.pts.length / 2)]
    const d2 = mid[0] * mid[0] + mid[1] * mid[1]
    if (!best || d2 < best.d2) best = {edge: e, d2}
  }
  const road = best?.edge ?? world.edges[0]
  const i = Math.max(1, Math.floor(road.pts.length / 2))
  const [ax, ay] = road.pts[i - 1]
  const [bx, by] = road.pts[i]
  return {x: ax, y: ay, heading: Math.atan2(by - ay, bx - ax), name: road.name}
}

const spawn = spawnPoint()
const car = createCar(spawn.x, spawn.y, spawn.heading)
const carMesh = makeCar()
carMesh.userData.noPick = true      // your own car is not scenery to be edited
scene.add(carMesh)
follow(carMesh)

boot('filling the streets with traffic and people…')
const signals = createSignals(world)
const crowd = createPedestrians(world, scene, signals)
const police = createPolice(world, scene, makeCar, signals)
world.signalState = signals          // published so the renderer can light the right lamp
const traffic = createTraffic(world, scene, signals)
const carVisual = createCarVisual(carMesh)
const minimap = createMinimap(world)
const bigmap = createBigMap(world)
const feedback = createFeedback()
// The editor's laser pointer: outlines whatever the cursor is on and edits it in place.
const picker = createPicker(scene, camera, renderer.domElement)
const audio = createAudio()
// Browsers refuse to start audio without a gesture; the first key the player touches is ours.
for (const ev of ['keydown', 'pointerdown']) window.addEventListener(ev, () => audio.resume(), {once: false})
const input = createInput()
const chase = createChaseCamera()
// Camera modes, cycled with C. Chase is the driving view; bird is the map view you edit in.
const bird = createBirdCamera()
const CAM_MODES = ['chase', 'bird']
let camMode = 0
// Scroll to zoom, and only in bird mode. zoomBird has existed since the bird camera was built and
// nothing ever called it, so the altitude was fixed at its default and the mode was far less useful
// than it looks — found while checking that every key the README tells a new player to press
// actually does something. passive: false because a page that scrolls under the map is not a map.
window.addEventListener('wheel', (e) => {
  if (CAM_MODES[camMode] !== 'bird') return
  e.preventDefault()
  zoomBird(bird, e.deltaY > 0 ? 1.12 : 1 / 1.12)
}, {passive: false})
// The old single-line #hud belongs to index.html; hide it and use our own, which owns its layout.
const legacyHud = document.getElementById('hud')
if (legacyHud) legacyHud.style.display = 'none'
const hud = createHud()

// One scratch array for the whole run: the broad phase fills it every frame, and allocating a new
// one per frame is how a smooth game acquires a stutter nobody can find.
const scratch = []

// Stand-in handed to the police while the crowd is toggled off, so nothing can be run over.
const EMPTY_CROWD = {peds: []}
let crowdsOn = true
let lastSpeed = 0           // previous frame's speed, so an impact can be measured as speed lost
let clock = 0               // seconds since load; drives the signal phases
let gameHours = 20.4        // start in the blue hour; the first frame should be the good one
let last = performance.now()
let frames = 0, fpsAt = last, fps = 0
let worstFrame = 0

function frame(now) {
  // Clamp dt: a tab restored after a minute must not integrate a minute of physics in one step and
  // teleport the car through the city.
  const dt = Math.min((now - last) / 1000, 1 / 20)
  last = now

  // Busted: the police have you. Same reset as a respawn, so the run simply ends and restarts.
  if (police.state.busted) {
    police.state.busted = false
    const s = spawnPoint()
    car.x = s.x; car.y = s.y; car.heading = s.heading
    car.vx = 0; car.vy = 0; car.speed = 0; car.steer = 0
    resetChase(chase)
  }

  if (input.takeRespawn()) {
    const s = spawnPoint()
    car.x = s.x; car.y = s.y; car.heading = s.heading
    car.vx = 0; car.vy = 0; car.speed = 0; car.steer = 0
    resetChase(chase)
  }

  const held = input.sample(dt)
  // Full-screen map: M toggles it, Esc only ever closes it. Handled BEFORE the physics so that
  // opening it freezes the same frame it appears on, rather than a frame late.
  if (input.takeMapToggle()) bigmap.toggle()
  if (input.takeMapClose()) bigmap.close()
  // Feedback dialog on 0: same freeze as the map, because you are reporting the spot you are
  // standing in and the world drifting away underneath would defeat the point.
  if (input.takeCamToggle()) {
    camMode = (camMode + 1) % CAM_MODES.length
    // The bird camera points its up vector at north; every other mode assumes world up, so it is
    // put back on the way out rather than left for the next mode to discover.
    if (CAM_MODES[camMode] !== 'bird') { restoreUp(camera); resetChase(chase) } else bird.ready = false
  }
  if (input.takeFbToggle()) feedback.toggle(car, gameHours)
  if (input.takeFbClose()) feedback.close()
  const pick = input.takeFbPick()
  if (pick) {
    const chose = feedback.pick(pick, car, gameHours)
    // The clock is this file's to move, so the dialog asks rather than reaching for it.
    if (chose?.action === 'advanceHour') gameHours = (gameHours + 1) % 24
    if (chose?.action === 'toggleCrowds') {
      crowdsOn = !crowdsOn
      traffic.setVisible?.(crowdsOn)
      crowd.setVisible?.(crowdsOn)
    }
    // The laser pointer is an editing tool, not part of the game. While you are driving, a highlight
    // chasing the cursor and a panel one click away are in the way, so it switches off entirely —
    // ray, outline and panel — rather than merely hiding.
    if (chose?.action === 'toggleLaser') picker.setEnabled(!picker.isEnabled())
  }
  feedback.update(dt)
  // The map covers the screen, so the world stops while it is up — you cannot steer what you cannot
  // see, and coming back to a wreck you could not avoid is not a fair way to lose a car.
  const frozen = held.paused || bigmap.isOpen() || feedback.isOpen()

  if (!frozen) {
    gameHours = (gameHours + dt / 60) % 24    // one game hour per real minute
    // Debug hook: Master photographs dawn/day/dusk without waiting real minutes for them.
    if (typeof window.__forceHours === 'number') gameHours = window.__forceHours
    stepCar(car, held, dt, world, scratch)
  }

  // Shake the camera by the ENERGY the impact took out of the car, not by the speed it lost.
  // Kinetic energy goes with the square of speed, so the same 5 m/s lost means something very
  // different at a crawl than at fifty: linear in delta-v, a nudge into a wall and a proper crash
  // felt nearly alike. Squared, a 14 m/s stop hits about eight times harder than a 5 m/s one, which
  // is the difference the player actually feels through the bodywork.
  if (car.contact) {
    const now = Math.abs(car.speed)
    const energyLost = Math.max(0, lastSpeed * lastSpeed - now * now)   // proportional to 2E/m
    if (energyLost > 1) shakeCamera(chase, Math.min(18, energyLost * 0.09))
  }
  lastSpeed = Math.abs(car.speed)

  carMesh.position.set(car.x, groundAt(car.x, car.y), -car.y)
  updateCarVisual(carVisual, car, dt)

  // Headlight intensity is the renderer's: it drives from sun elevation, and a second writer
  // here just fought it frame by frame. userData.headlight is read-only to this file.

  if (!frozen) {
    // Toggled off means GONE, not merely invisible. Hiding the meshes alone left you colliding with
    // cars you could not see and running over pedestrians who were not there — so when the toggle is
    // off their simulation does not run at all, and the police are handed an empty crowd and no
    // traffic, so nothing can be hit, yielded to, or charged as a crime.
    if (crowdsOn) crowd.update(dt, car, clock, chase.ready ? chase : null)
    clock += dt
    if (crowdsOn) traffic.update(dt, car, clock, chase.ready ? chase : null)
    police.update(dt, car, crowdsOn ? crowd : EMPTY_CROWD, clock,
                  crowdsOn ? traffic : null, scene.userData.night ?? 0)
    audio.update(dt, car, police)
  }
  // Frozen: the simulation stops being ticked, so the audio must be told, or the engine hangs on
  // whatever note it was holding when the world stopped. Same for the map — a siren wailing over a
  // paused map is the kind of detail that reads as a bug.
  if (frozen) audio.silence()

  if (CAM_MODES[camMode] === 'bird') updateBird(bird, car, camera, dt)
  else updateChase(chase, car, camera, dt, world)
  bigmap.update(car, police, crowdsOn ? traffic : null)
  minimap.update(dt, car, police, crowdsOn ? traffic : null)
  update(dt, gameHours)
  renderer.render(scene, camera)

  // Frame timing, measured rather than assumed — the worst frame is the one that reads as lag, and
  // an average hides it completely.
  const cost = performance.now() - now
  if (cost > worstFrame) worstFrame = cost
  frames++
  if (now - fpsAt > 1000) {
    fps = frames; frames = 0; fpsAt = now; worstFrame = 0
  }

  hud.update({
    gameHours,
    kmh: Math.round(Math.abs(car.speed) * 3.6),
    stars: police.state.stars,
    message: police.state.message,
    fps,
    drifting: Math.abs(car.lateral) > 3.5,
    bustProgress: police.state.cornered / 8,
    draws: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
    peds: crowdsOn ? crowd.peds.length : 0,
    cars: crowdsOn ? traffic.cars.length : 0,
    streetName: car.leaving ? 'The forest — turn back' : (car.road?.name ?? null),
    paused: held.paused,
    x: car.x, y: car.y, heading: car.heading,
  })
  picker.update()

  // The boot overlay comes off only once a real frame has been drawn, not when the scripts finish —
  // otherwise it uncovers a blank canvas for the half second the first render still takes.
  if (!booted) {
    booted = true
    const el = document.getElementById('boot')
    if (el) { el.classList.add('done'); setTimeout(() => el.remove(), 500) }
  }

  requestAnimationFrame(frame)
}
let booted = false
boot('almost there…')
requestAnimationFrame(frame)

// Handy while tuning, and harmless in the build: the console can reach the car.
window.game = {THREE, scene, camera, renderer, picker, car, world, bird,
  camMode: () => CAM_MODES[camMode], setCamMode: (m) => { const i = CAM_MODES.indexOf(m); if (i < 0) return false; camMode = i; if (m !== 'bird') { restoreUp(camera); resetChase(chase) } else bird.ready = false; return true }, input, chase, crowd, police, traffic, audio, signals, minimap, carVisual, setHours: h => { gameHours = h }}
