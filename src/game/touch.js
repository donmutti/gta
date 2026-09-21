/**
 * Touch controls, so the game is playable when somebody opens the link on a phone.
 *
 * Designed in `docs/mobile-controls.md`; the reasoning lives there and only what the code needs is
 * repeated here.
 *
 * THE ONE THING TO GET RIGHT IS `pointerId`. Holding throttle while steering is one touch on the
 * stick, but stabbing "Drift" without letting go of it is two, and the buttons layout makes it
 * three. A handler that tracks "the touch" rather than "the touch with this id" lets the second
 * finger steal the first, and the symptom is not a crash — it is steering that sticks when a button
 * is pressed, or throttle that drops when the wheel turns, which reads as a physics bug and gets
 * debugged in the wrong file. So every control captures the pointer that began on it, follows only
 * that id, and releases only its own.
 *
 * TWO LAYOUTS SHIP, and the player switches between them from the menu. The stick is the default;
 * the buttons are the first design, kept because it was built and verified before the layout was
 * overruled, and because which one feels better is taste, and taste is measured by a thumb rather
 * than argued about. Both write the same three fields, so everything below the controls is
 * identical and neither layout can develop a bug the other does not have.
 *
 * Nothing here touches the simulation. The controls write `input.touch`, which `input.sample()`
 * folds into the same axes the keyboard produces, so the car cannot tell which one drove it.
 */

const STICK_R = 62           // px from the stick centre that means full deflection on an axis
const STICK_DEAD = 0.14      // fraction of the throw ignored, so a resting thumb does not creep
const PAD_FULL_LOCK = 0.33   // buttons layout: fraction of screen width that means full lock
const LAYOUT_KEY = 'gta.touchLayout'


import {fullscreenAvailable} from './fullscreen.js'

/** Is this a device that wants touch controls? Primary pointer, deliberately: see the design. */
export function wantsTouch() {
  return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0
}

/** 'stick' or 'buttons'. Remembered, so a preference survives the next visit. */
export function touchLayout() {
  try {
    const v = localStorage.getItem(LAYOUT_KEY)
    if (v === 'stick' || v === 'buttons') return v
  } catch { /* private browsing throws on localStorage, and the default is the right answer then */ }
  return 'stick'
}

export function rememberLayout(v) {
  try { localStorage.setItem(LAYOUT_KEY, v) } catch { /* nothing to do, and nothing worth reporting */ }
}

const css = `
.tc { position:fixed; inset:0; z-index:40; touch-action:none; -webkit-user-select:none; user-select:none; }
.tc-pad { position:absolute; left:0; top:0; width:50%; height:100%; }
.tc-btn { position:absolute; display:flex; align-items:center; justify-content:center;
  border-radius:999px; font:600 15px/1 system-ui,-apple-system,sans-serif; color:#fff;
  background:rgba(20,22,26,0.55); border:1.5px solid rgba(255,255,255,0.35);
  backdrop-filter:blur(3px); -webkit-backdrop-filter:blur(3px); }
.tc-btn.held { background:rgba(80,140,255,0.55); border-color:rgba(255,255,255,0.7); }
.tc-go   { right:18px; bottom:96px; width:104px; height:104px; font-size:19px; }
.tc-stop { right:136px; bottom:34px; width:78px;  height:78px; }
.tc-drift{ right:24px;  bottom:18px; width:78px;  height:78px; }
.tc-menu { right:14px; top:14px; width:52px; height:36px; border-radius:10px; font-size:13px; }
.tc-sheet{ position:absolute; right:14px; top:58px; display:none; flex-direction:column; gap:8px; }
.tc-sheet.open { display:flex; }
.tc-item { min-width:140px; padding:11px 14px; border-radius:10px; text-align:center;
  font:600 14px/1 system-ui,-apple-system,sans-serif; color:#fff;
  background:rgba(20,22,26,0.72); border:1.5px solid rgba(255,255,255,0.3); }

/* --- the stick. Drawn AT REST, which is the whole point of it: a pad that appears only once you
   touch it is not a control, it is a blank half of the screen that a first-time visitor has no
   reason to touch. The base carries its two axis words so which way is fast needs no instructions. */
.tc-base { position:absolute; width:${STICK_R * 2 + 30}px; height:${STICK_R * 2 + 30}px;
  margin:${-(STICK_R + 15)}px 0 0 ${-(STICK_R + 15)}px; border-radius:999px;
  border:2px solid rgba(255,255,255,0.34); background:rgba(20,22,26,0.30);
  backdrop-filter:blur(2px); -webkit-backdrop-filter:blur(2px); pointer-events:none; }
.tc-knob { position:absolute; width:58px; height:58px; margin:-29px 0 0 -29px; border-radius:999px;
  background:rgba(235,240,255,0.42); border:1.5px solid rgba(255,255,255,0.62);
  box-shadow:0 2px 10px rgba(0,0,0,0.35); pointer-events:none; }
.tc-knob.grabbed { background:rgba(120,170,255,0.62); }
.tc-axis { position:absolute; left:50%; font:700 10px/1 system-ui,-apple-system,sans-serif;
  letter-spacing:1.5px; color:rgba(255,255,255,0.55); pointer-events:none; }
.tc-axis-up { top:13px; transform:translateX(-50%); }
.tc-axis-dn { bottom:13px; transform:translateX(-50%); }

/* --- the buttons layout's steering pad, which has no resting state by design: it is a surface, and
   the ring marks where the thumb decided the centre was. The button says "Brake" rather than
   "Stop": stopping is the outcome, braking is the thing the finger is doing, and the stick's own
   lower axis is labelled the same way so the two layouts agree. */
.tc-ring { position:absolute; width:96px; height:96px; margin:-48px 0 0 -48px; border-radius:999px;
  border:2px solid rgba(255,255,255,0.35); pointer-events:none; opacity:0; }
.tc-ring.on { opacity:1; }
.tc-nub { position:absolute; width:40px; height:40px; margin:-20px 0 0 -20px; border-radius:999px;
  background:rgba(255,255,255,0.35); pointer-events:none; opacity:0; }
.tc-nub.on { opacity:1; }
`

/**
 * @param input  the object from createInput(); its `touch` field is what this writes
 * @param acts   {map, camera, respawn, pause, layout} — one-shots the menu fires
 * @param layout 'stick' (default) or 'buttons'
 */
export function createTouchControls(input, acts = {}, layout = touchLayout()) {
  const stickMode = layout !== 'buttons'

  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'tc'
  const el = (cls, text, parent = root) => {
    const d = document.createElement('div')
    d.className = cls
    if (text) d.textContent = text
    parent.appendChild(d)
    return d
  }

  // pointerId -> what that finger is doing. The whole correctness of multi-touch lives in this map.
  const claimed = new Map()
  const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v)
  const setSteer = (v) => { input.touch.steer = clamp1(v) }

  // A deadzone that RESCALES rather than truncates: without the rescale the first responsive
  // millimetre of throw already commands 0.14, so the control starts with a step in it.
  const dead = (v) => {
    const m = Math.abs(v)
    if (m <= STICK_DEAD) return 0
    return Math.sign(v) * (m - STICK_DEAD) / (1 - STICK_DEAD)
  }

  // --- furniture shared by both layouts. A handbrake has no axis, so Drift is a button whatever
  // the rest of the scheme does; the menu is where everything a phone cannot keyboard lives.
  const drift = el('tc-btn tc-drift', 'Drift')
  const menu = el('tc-btn tc-menu', 'Menu')
  const sheet = el('tc-sheet')
  const item = (label) => el('tc-item', label, sheet)

  const hold = (node, kind, apply) => {
    node.addEventListener('pointerdown', (e) => {
      claimed.set(e.pointerId, {kind})
      node.classList.add('held')
      node.setPointerCapture?.(e.pointerId)
      apply(true)
      e.preventDefault()
      e.stopPropagation()
    })
  }
  hold(drift, 'drift', (on) => { input.touch.handbrake = on })

  let base = null, knob = null, ring = null, nub = null, go = null, stop = null
  let onStickMove = () => {}
  let onStickUp = () => {}
  let stopRest = () => {}
  const pad = el('tc-pad')

  if (stickMode) {
    // The stick FLOATS: it rests somewhere visible, and re-homes to wherever the thumb lands in the
    // left half. A fixed stick is a target you must find without looking down; a purely floating
    // one is invisible until touched, which was the objection. Resting visibly and then coming to
    // the thumb is both at once.
    base = el('tc-base')
    knob = el('tc-knob')
    el('tc-axis tc-axis-up', 'GO', base)
    el('tc-axis tc-axis-dn', 'BRAKE', base)

    let home = {x: 0, y: 0}
    const place = (x, y) => {
      home = {x, y}
      base.style.left = `${x}px`; base.style.top = `${y}px`
      knob.style.left = `${x}px`; knob.style.top = `${y}px`
    }
    // Bottom left, a thumb's reach up from the corner. Recomputed on resize, because a phone
    // rotates and a stick left below the bottom edge is no stick at all.
    const rest = () => place(Math.round(window.innerWidth * 0.22), window.innerHeight - 150)
    rest()
    window.addEventListener('resize', rest)
    stopRest = () => window.removeEventListener('resize', rest)

    // The whole left half takes the touch, not only the drawn circle: on a phone the thumb lands
    // where the thumb lands, and a control that answers only a bullseye is a control you miss.
    pad.addEventListener('pointerdown', (e) => {
      if ([...claimed.values()].some(r => r.kind === 'stick')) return   // one stick, one finger
      claimed.set(e.pointerId, {kind: 'stick'})
      place(e.clientX, e.clientY)
      knob.classList.add('grabbed')
      pad.setPointerCapture?.(e.pointerId)
      e.preventDefault()
    })

    onStickMove = (e) => {
      // PER-AXIS normalisation, which is the point of the whole design: full throttle at full lock.
      // A magnitude-normalised stick splits a diagonal between its axes, so holding up-and-left
      // gives about 0.7 of each and the car slows down BECAUSE you turned. Independent axes mean
      // the reachable area is a square rather than a circle — the stick has corners — and for a
      // driving game that is the feature and not the defect.
      const dx = clamp1((e.clientX - home.x) / STICK_R)
      const dy = clamp1((e.clientY - home.y) / STICK_R)
      setSteer(-dead(dx))                       // right of centre steers right, which is -1
      input.touch.throttle = -dead(dy)          // up the screen is forward
      knob.style.left = `${home.x + dx * STICK_R}px`
      knob.style.top = `${home.y + dy * STICK_R}px`
    }

    onStickUp = () => {
      input.touch.throttle = 0
      setSteer(0)
      knob.classList.remove('grabbed')
      knob.style.left = `${home.x}px`; knob.style.top = `${home.y}px`
    }
  } else {
    ring = el('tc-ring')
    nub = el('tc-nub')
    go = el('tc-btn tc-go', 'Go')
    stop = el('tc-btn tc-stop', 'Brake')
    hold(go, 'go', (on) => { input.touch.throttle = on ? 1 : 0 })
    hold(stop, 'stop', (on) => { input.touch.throttle = on ? -1 : 0 })

    pad.addEventListener('pointerdown', (e) => {
      claimed.set(e.pointerId, {kind: 'pad', x0: e.clientX})
      ring.style.left = nub.style.left = `${e.clientX}px`
      ring.style.top = nub.style.top = `${e.clientY}px`
      ring.classList.add('on'); nub.classList.add('on')
      pad.setPointerCapture?.(e.pointerId)
      e.preventDefault()
    })
  }

  const items = {
    Map: item('Map'),
    Camera: item('Camera'),
    Respawn: item('Respawn'),
    Pause: item('Pause'),
    Layout: item(stickMode ? 'Controls: Stick' : 'Controls: Buttons'),
  }
  // Only where there is an API to call. An iPhone has none, and a menu item that does nothing is
  // worse than a missing one: the player taps it, nothing happens, and they conclude the game is
  // broken rather than that their browser does not do this.
  if (fullscreenAvailable()) items.Fullscreen = item('Fullscreen')
  document.body.appendChild(root)

  const onMove = (e) => {
    const rec = claimed.get(e.pointerId)
    if (!rec) return
    if (rec.kind === 'stick') { onStickMove(e); e.preventDefault(); return }
    if (rec.kind !== 'pad') return                  // a finger on a button does not steer
    setSteer(-(e.clientX - rec.x0) / (window.innerWidth * PAD_FULL_LOCK))
    nub.style.left = `${e.clientX}px`
    e.preventDefault()
  }

  const onUp = (e) => {
    const rec = claimed.get(e.pointerId)
    if (!rec) return
    claimed.delete(e.pointerId)
    // Release only when no OTHER finger is still holding the same kind of control: two thumbs on
    // one surface is a thing hands do, and lifting one must not drop what the other is holding.
    const none = (...kinds) => ![...claimed.values()].some(r => kinds.includes(r.kind))
    if (rec.kind === 'stick' && none('stick')) onStickUp()
    if (rec.kind === 'pad' && none('pad')) {
      setSteer(0)
      ring.classList.remove('on'); nub.classList.remove('on')
    }
    if (rec.kind === 'go' || rec.kind === 'stop') {
      if (none('go', 'stop')) input.touch.throttle = 0
      ;(rec.kind === 'go' ? go : stop).classList.remove('held')
    }
    if (rec.kind === 'drift') {
      if (none('drift')) input.touch.handbrake = false
      drift.classList.remove('held')
    }
  }

  // On window, not on the elements: a finger that slides off a button must still be released, and
  // pointercancel fires when the browser takes the gesture away (a system edge swipe, a call).
  window.addEventListener('pointermove', onMove, {passive: false})
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)

  const closeSheet = () => sheet.classList.remove('open')
  menu.addEventListener('pointerdown', (e) => { sheet.classList.toggle('open'); e.preventDefault(); e.stopPropagation() })
  const tap = (node, fn) => node.addEventListener('pointerdown', (e) => { fn(); closeSheet(); e.preventDefault(); e.stopPropagation() })
  tap(items.Map, () => acts.map?.())
  tap(items.Camera, () => acts.camera?.())
  tap(items.Respawn, () => acts.respawn?.())
  tap(items.Pause, () => acts.pause?.())
  // Switching layout rebuilds the controls in place. Deliberately not a reload: the player is
  // mid-drive, and a reload would dump them back at the spawn point to answer a question about
  // where the throttle should live.
  tap(items.Layout, () => acts.layout?.(stickMode ? 'buttons' : 'stick'))
  if (items.Fullscreen) tap(items.Fullscreen, () => acts.fullscreen?.())

  return {
    layout: stickMode ? 'stick' : 'buttons',
    /** Remove every trace, including the axes: a docked tablet must not drive on alone. */
    destroy() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      stopRest()
      claimed.clear()
      input.touch.throttle = 0; input.touch.steer = 0; input.touch.handbrake = false
      root.remove(); style.remove()
    },
  }
}
