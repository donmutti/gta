// Keyboard. Held state, not events: the physics asks "is it down now", and an event queue would
// make a dropped frame into a dropped input.
//
// Steering is RAMPED rather than binary. A key that snaps the wheel to full lock feels like a
// cursor; a wheel that takes ~150ms to reach lock and springs back when released feels like a car,
// and costs four lines.

const STEER_ON = 7.0    // how fast the command approaches full lock while held
const STEER_OFF = 11.0  // how fast it returns to centre when let go

export function createInput() {
  const down = new Set()
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
    /** Advance the ramped axes. Call once per frame before the physics. */
    sample(dt) {
      const fwd = held('KeyW', 'ArrowUp') ? 1 : 0
      const back = held('KeyS', 'ArrowDown') ? 1 : 0
      state.throttle = fwd - back

      const want = (held('KeyA', 'ArrowLeft') ? 1 : 0) - (held('KeyD', 'ArrowRight') ? 1 : 0)
      const rate = want === 0 ? STEER_OFF : STEER_ON
      state.steer += (want - state.steer) * Math.min(1, rate * dt)
      if (want === 0 && Math.abs(state.steer) < 0.01) state.steer = 0

      state.handbrake = held('Space')
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
