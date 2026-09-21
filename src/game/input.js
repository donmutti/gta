// Keyboard. Held state, not events: the physics asks "is it down now", and an event queue would
// make a dropped frame into a dropped input.
//
// Steering is RAMPED rather than binary. A key that snaps the wheel to full lock feels like a
// cursor; a wheel that takes ~150ms to reach lock and springs back when released feels like a car,
// and costs four lines.

const STEER_ON = 7.0    // how fast the command approaches full lock while held
const STEER_OFF = 11.0  // how fast it returns to centre when let go
/**
 * How fast the command follows a THUMBSTICK, which is a different question entirely.
 *
 * A stick reports a position, so in principle it needs no smoothing at all and the right number
 * here is infinity. It gets a little anyway, because a thumb resting on glass is never quite
 * still and a completely unfiltered stick transmits that as a shimmy in the steering. At 30 the
 * command is 95 per cent of the way there in a tenth of a second, which is below what a hand
 * notices, where the keyboard's ramp takes a third of a second by design.
 */
const TOUCH_STEER = 30

export function createInput() {
  const down = new Set()
  // What the touch controls are asking for, if there are any. They do not write `state` directly:
  // sample() recomputes the axes from scratch every frame, so anything written from outside is
  // overwritten before the physics sees it. Feeding the same computation instead means touch gets
  // the steering ramp for free and the two inputs sum rather than fight, which is what a laptop
  // with a touchscreen needs.
  const touch = {throttle: 0, steer: 0, handbrake: false}
  // Tracked apart, because they are ramped apart: see the comment in sample().
  let keySteer = 0
  let touchSteer = 0
  const state = {throttle: 0, steer: 0, handbrake: false, respawn: false, paused: false,
                 mapToggle: false, mapClose: false,
                 fbToggle: false, fbClose: false, fbPick: null,
                 camToggle: false}

  const isKey = (e, ...names) => names.includes(e.code)
  const onDown = (e) => {
    // Never swallow the browser's own shortcuts; only claim the keys the game drives with.
    if (isKey(e, 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space')) e.preventDefault()
    down.add(e.code)
    if (e.code === 'KeyR') state.respawn = true
    if (e.code === 'KeyP') state.paused = !state.paused
    // One-shots for the full-screen map. Repeats are ignored so holding M does not strobe it.
    if (e.code === 'KeyM' && !e.repeat) state.mapToggle = true
    if (e.code === 'Escape') state.mapClose = true
    // Feedback dialog: 0 toggles, Esc closes, and the number keys file a report while it is up.
    if (e.code === 'KeyC' && !e.repeat) state.camToggle = true
    if (e.code === 'Digit0' && !e.repeat) state.fbToggle = true
    if (e.code === 'Escape') state.fbClose = true
    if (!e.repeat && /^Digit[1-5]$/.test(e.code)) state.fbPick = e.code
  }
  const onUp = (e) => down.delete(e.code)
  const blur = () => down.clear()   // alt-tab away mid-throttle and the car must not drive on alone

  window.addEventListener('keydown', onDown)
  window.addEventListener('keyup', onUp)
  window.addEventListener('blur', blur)

  const held = (...codes) => codes.some(c => down.has(c))

  return {
    state,
    /** Written by the touch controls; read by sample(). Empty on a device with no touch. */
    touch,
    /** Advance the ramped axes. Call once per frame before the physics. */
    sample(dt) {
      const clamp = (v) => v < -1 ? -1 : v > 1 ? 1 : v
      const fwd = held('KeyW', 'ArrowUp') ? 1 : 0
      const back = held('KeyS', 'ArrowDown') ? 1 : 0
      state.throttle = clamp(fwd - back + touch.throttle)

      // THE RAMP BELONGS TO THE KEYBOARD, AND ONLY TO IT.
      //
      // A key is a switch: it says "left", not "how far left". The ramp is what turns that switch
      // into a progressive turn, and without it the keyboard would snap to full lock. A thumbstick
      // is not a switch — the thumb has ALREADY said how far — so running the same ramp over it
      // adds a third of a second of lag to a command that was exact when it arrived. Reported from
      // a phone as the car waddling: the finger moves, the car thinks about it.
      //
      // So the two are tracked separately and summed. The keys keep their ramp; the stick is
      // followed almost directly, with just enough smoothing to take the noise off a thumb resting
      // on glass.
      const keyWant = (held('KeyA', 'ArrowLeft') ? 1 : 0) - (held('KeyD', 'ArrowRight') ? 1 : 0)
      const rate = keyWant === 0 ? STEER_OFF : STEER_ON
      keySteer += (keyWant - keySteer) * Math.min(1, rate * dt)
      if (keyWant === 0 && Math.abs(keySteer) < 0.01) keySteer = 0
      touchSteer += (touch.steer - touchSteer) * Math.min(1, TOUCH_STEER * dt)
      if (touch.steer === 0 && Math.abs(touchSteer) < 0.01) touchSteer = 0
      state.steer = clamp(keySteer + touchSteer)

      state.handbrake = held('Space') || touch.handbrake
      return state
    },
    /** Read-and-clear, for the one-shot keys. */
    takeRespawn() { const r = state.respawn; state.respawn = false; return r },
    takeMapToggle() { const r = state.mapToggle; state.mapToggle = false; return r },
    takeMapClose() { const r = state.mapClose; state.mapClose = false; return r },
    takeFbToggle() { const r = state.fbToggle; state.fbToggle = false; return r },
    takeFbClose() { const r = state.fbClose; state.fbClose = false; return r },
    takeFbPick() { const r = state.fbPick; state.fbPick = null; return r },
    takeCamToggle() { const r = state.camToggle; state.camToggle = false; return r },
    dispose() {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', blur)
    },
  }
}
