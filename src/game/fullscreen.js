/**
 * Going fullscreen, on the two kinds of device that can.
 *
 * Small, and it is a separate file because the interesting part is not the API call — it is
 * knowing where the API does not exist and saying so instead of drawing a button that does
 * nothing.
 *
 * **iOS Safari on iPhone has no Fullscreen API at all.** iPad has it; iPhone does not, and has
 * never had it. The honest answer on an iPhone is Add to Home Screen, which is a different
 * feature with a different prompt and is not this. So `fullscreenAvailable()` is asked before anything is
 * drawn, and on an iPhone no control appears rather than a control that silently fails.
 *
 * The other trap is that `requestFullscreen()` must be called from inside a user gesture. Both
 * callers here are a keydown or a tap, which satisfies it; anything that ever calls this from a
 * timer or a frame callback will be rejected by the browser and should not be added.
 */

const root = () => document.documentElement

/** Is there a fullscreen API here at all? False on iPhone, and that is the point of asking. */
export function fullscreenAvailable() {
  const el = root()
  return !!(el.requestFullscreen || el.webkitRequestFullscreen)
}

export function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement)
}

/**
 * Toggle, and return what was attempted rather than what happened.
 *
 * The promise is deliberately swallowed: a browser may refuse for reasons that are none of the
 * game's business (a permissions policy in an iframe, a gesture it did not believe), and a
 * rejected promise here would be an unhandled rejection in the console for something the player
 * can simply try again.
 */
export function toggleFullscreen() {
  if (!fullscreenAvailable()) return false
  try {
    if (isFullscreen()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen
      exit?.call(document)
    } else {
      const el = root()
      const go = el.requestFullscreen || el.webkitRequestFullscreen
      go?.call(el, {navigationUI: 'hide'})
    }
  } catch { /* refused; the player can press it again */ }
  return true
}

/** Fires whenever the browser enters or leaves fullscreen, including via Esc or the OS. */
export function onFullscreenChange(fn) {
  document.addEventListener('fullscreenchange', fn)
  document.addEventListener('webkitfullscreenchange', fn)
  return () => {
    document.removeEventListener('fullscreenchange', fn)
    document.removeEventListener('webkitfullscreenchange', fn)
  }
}
