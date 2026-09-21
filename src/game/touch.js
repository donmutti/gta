/**
 * Touch controls, so the game is playable when somebody opens the link on a phone.
 *
 * Designed in `docs/mobile-controls.md`; the reasoning lives there and only what the code needs is
 * repeated here.
 *
 * THE ONE THING TO GET RIGHT IS `pointerId`. Holding "Go" while steering is two simultaneous
 * touches, and drifting is three: throttle held, wheel turned, handbrake stabbed. A handler that
 * tracks "the touch" rather than "the touch with this id" lets the second finger steal the first,
 * and the symptom is not a crash — it is steering that sticks when a button is pressed, or throttle
 * that drops when the wheel turns, which reads as a physics bug and gets debugged in the wrong file.
 * So every control captures the pointer that began on it, follows only that id, and releases only
 * its own.
 *
 * Nothing here touches the simulation. The controls write `input.touch`, which `input.sample()`
 * folds into the same axes the keyboard produces, so the car cannot tell which one drove it.
 */

const PAD_FULL_LOCK = 0.33   // fraction of screen width from the origin that means full lock

/** Is this a device that wants touch controls? Primary pointer, deliberately: see the design. */
export function wantsTouch() {
  return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0
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
.tc-item { min-width:112px; padding:11px 14px; border-radius:10px; text-align:center;
  font:600 14px/1 system-ui,-apple-system,sans-serif; color:#fff;
  background:rgba(20,22,26,0.72); border:1.5px solid rgba(255,255,255,0.3); }
.tc-ring { position:absolute; width:96px; height:96px; margin:-48px 0 0 -48px; border-radius:999px;
  border:2px solid rgba(255,255,255,0.35); pointer-events:none; opacity:0; }
.tc-ring.on { opacity:1; }
.tc-nub { position:absolute; width:40px; height:40px; margin:-20px 0 0 -20px; border-radius:999px;
  background:rgba(255,255,255,0.35); pointer-events:none; opacity:0; }
.tc-nub.on { opacity:1; }
`

/**
 * @param input  the object from createInput(); its `touch` field is what this writes
 * @param acts   {map, camera, respawn, pause} — one-shots the menu fires
 */
export function createTouchControls(input, acts = {}) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'tc'
  const el = (cls, text) => { const d = document.createElement('div'); d.className = cls; if (text) d.textContent = text; root.appendChild(d); return d }

  const pad = el('tc-pad')
  const ring = el('tc-ring')
  const nub = el('tc-nub')
  const go = el('tc-btn tc-go', 'Go')
  const stop = el('tc-btn tc-stop', 'Stop')
  const drift = el('tc-btn tc-drift', 'Drift')
  const menu = el('tc-btn tc-menu', 'Menu')
  const sheet = el('tc-sheet')
  const item = (label) => { const d = document.createElement('div'); d.className = 'tc-item'; d.textContent = label; sheet.appendChild(d); return d }
  const items = {Map: item('Map'), Camera: item('Camera'), Respawn: item('Respawn'), Pause: item('Pause')}
  document.body.appendChild(root)

  // pointerId -> what that finger is doing. The whole correctness of multi-touch lives in this map.
  const claimed = new Map()

  const setSteer = (v) => { input.touch.steer = v < -1 ? -1 : v > 1 ? 1 : v }

  const onPadDown = (e) => {
    claimed.set(e.pointerId, {kind: 'pad', x0: e.clientX})
    ring.style.left = nub.style.left = `${e.clientX}px`
    ring.style.top = nub.style.top = `${e.clientY}px`
    ring.classList.add('on'); nub.classList.add('on')
    pad.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }

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

  const release = (rec, node) => { node.classList.remove('held') }

  hold(go, 'go', (on) => { input.touch.throttle = on ? 1 : 0 })
  hold(stop, 'stop', (on) => { input.touch.throttle = on ? -1 : 0 })
  hold(drift, 'drift', (on) => { input.touch.handbrake = on })

  pad.addEventListener('pointerdown', onPadDown)

  const onMove = (e) => {
    const rec = claimed.get(e.pointerId)
    if (!rec || rec.kind !== 'pad') return          // a finger on a button does not steer
    const span = window.innerWidth * PAD_FULL_LOCK
    setSteer(-(e.clientX - rec.x0) / span)          // right of the origin steers right, which is -1
    nub.style.left = `${e.clientX}px`
    e.preventDefault()
  }

  const onUp = (e) => {
    const rec = claimed.get(e.pointerId)
    if (!rec) return
    claimed.delete(e.pointerId)
    if (rec.kind === 'pad') {
      // Only centre the wheel if no OTHER finger is still steering: two thumbs on the pad is a
      // thing hands do, and lifting one must not drop the wheel the other is holding.
      if (![...claimed.values()].some(r => r.kind === 'pad')) {
        setSteer(0)
        ring.classList.remove('on'); nub.classList.remove('on')
      }
    }
    if (rec.kind === 'go' || rec.kind === 'stop') {
      if (![...claimed.values()].some(r => r.kind === 'go' || r.kind === 'stop')) input.touch.throttle = 0
      release(rec, rec.kind === 'go' ? go : stop)
    }
    if (rec.kind === 'drift') {
      if (![...claimed.values()].some(r => r.kind === 'drift')) input.touch.handbrake = false
      release(rec, drift)
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

  return {
    /** Remove every trace, including the axes: a docked tablet must not drive on alone. */
    destroy() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      claimed.clear()
      input.touch.throttle = 0; input.touch.steer = 0; input.touch.handbrake = false
      root.remove(); style.remove()
    },
  }
}
