// The heads-up display.
//
// Built and styled entirely from here rather than from index.html, which belongs to the renderer —
// the whole HUD is simulation output, so it lives on this side of the seam and owns its own DOM.
//
// The layout answers a critique of the first version: everything was one grey sentence in the
// bottom-left corner, which made the player read prose to find out how fast they were going and
// buried the wanted level at the end of a string. Speed and threat are now the two loud things,
// separated and placed where the eye already goes.

import {touchLayout} from './touch.js'

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
/** Every piece of HUD text sits over a moving 3D scene, so all of it carries a hard shadow. */
const SHADOW = '0 1px 3px rgba(0,0,0,.95), 0 0 10px rgba(0,0,0,.65)'

function el(tag, style, parent) {
  const node = document.createElement(tag)
  Object.assign(node.style, style)
  parent.appendChild(node)
  return node
}

export function createHud() {
  const root = el('div', {
    position: 'fixed', inset: '0', pointerEvents: 'none',
    fontFamily: FONT, color: '#fff', userSelect: 'none',
  }, document.body)

  // --- speed, bottom right above the map: the number read most often, so it is the biggest.
  const speedBox = el('div', {
    // Clear of the minimap: the dial is 186px tall sitting 16px up, so its top edge is at 202px.
    // The speed used to start at 196 and collided with the ring.
    position: 'fixed', right: '24px', bottom: '224px', textAlign: 'right', textShadow: SHADOW,
  }, root)
  const speedValue = el('div', {
    fontSize: '46px', fontWeight: '700', lineHeight: '1', letterSpacing: '-1px',
    fontVariantNumeric: 'tabular-nums',
  }, speedBox)
  const speedUnit = el('div', {
    fontSize: '12px', fontWeight: '600', opacity: '.75', letterSpacing: '1.5px', marginTop: '2px',
  }, speedBox)
  speedUnit.textContent = 'KM/H'

  // --- wanted level, top right, out of the sentence and big enough to read peripherally.
  const stars = el('div', {
    position: 'fixed', right: '24px', top: '20px', display: 'flex', gap: '4px',
    fontSize: '30px', lineHeight: '1', textShadow: SHADOW,
  }, root)
  const starEls = []
  for (let i = 0; i < 5; i++) {
    const s = el('div', {color: 'rgba(255,255,255,.22)', transition: 'color .18s, transform .18s'}, stars)
    s.textContent = '★'
    starEls.push(s)
  }

  // --- clock, top left. Quiet: it matters for atmosphere, not for driving.
  const clock = el('div', {
    position: 'fixed', left: '24px', top: '20px', fontSize: '15px', fontWeight: '600',
    opacity: '.8', textShadow: SHADOW, fontVariantNumeric: 'tabular-nums',
  }, root)

  // --- the bust meter, top centre. It DRAINS: full when they first get alongside you, empty when
  // they have you. A bar that fills reads as progress you are making; a bar that empties reads as
  // time you are losing, which is the correct feeling for the thing about to end your run.
  const bustBox = el('div', {
    position: 'fixed', left: '50%', top: '22px', transform: 'translateX(-50%)',
    width: '340px', opacity: '0', transition: 'opacity .2s', textAlign: 'center',
  }, root)
  const bustLabel = el('div', {
    fontSize: '12px', fontWeight: '700', letterSpacing: '2.5px', marginBottom: '6px',
    textShadow: SHADOW,
  }, bustBox)
  bustLabel.textContent = 'BEING CAUGHT'
  const bustWrap = el('div', {
    width: '100%', height: '9px', background: 'rgba(0,0,0,.55)', borderRadius: '5px',
    overflow: 'hidden', boxShadow: '0 1px 6px rgba(0,0,0,.6)',
  }, bustBox)
  const bustFill = el('div', {
    height: '100%', width: '100%', background: '#ffc21f', borderRadius: '5px',
    transition: 'width .1s linear, background .2s',
  }, bustWrap)

  // --- alerts, centred low: transient, so it belongs where the eye lands when something happens.
  // Anchored to the TOP, under the bust bar. It used to sit low and centre, directly over the road
  // the player is about to drive into — a status message should never cover the thing it is warning
  // you about.
  const alert = el('div', {
    position: 'fixed', left: '0', right: '0', top: '56px', textAlign: 'center',
    fontSize: '19px', fontWeight: '700', letterSpacing: '.4px', textShadow: SHADOW,
    opacity: '0', transition: 'opacity .18s',
  }, root)

  // --- street name, bottom left. Every road in the data carries its real name and nothing ever
  // showed it; seeing "Boulevard Royal" appear as you turn onto it is most of what makes this feel
  // like a place rather than a generated grid.
  const street = el('div', {
    position: 'fixed', left: '24px', bottom: '40px', fontSize: '21px', fontWeight: '700',
    textShadow: SHADOW, letterSpacing: '.2px', opacity: '0', transition: 'opacity .35s',
  }, root)

  // --- state line, bottom left: small, for things that are true rather than urgent.
  const state = el('div', {
    position: 'fixed', left: '24px', bottom: '22px', fontSize: '13px', fontWeight: '600',
    opacity: '.75', textShadow: SHADOW, letterSpacing: '.3px',
  }, root)

  // --- the debug panel, ON by default. While the city is still being built this number is worth
  // more than the pixels it costs: the 30fps floor is a hard requirement and nobody watches a
  // counter they have to remember to switch on. It carries its own "F3" label so the key that
  // dismisses it is written on the thing itself.
  //
  // It reports DRAW CALLS and TRIANGLES as well as fps, because with several people adding geometry
  // to one scene the frame budget is spent in draw calls and nobody could see the number they were
  // spending. An fps figure tells you that you are slow; the call count tells you who made you slow.
  const fpsBox = el('div', {
    position: 'fixed', left: '24px', top: '46px', fontSize: '12px', fontWeight: '600',
    opacity: '.62', textShadow: SHADOW, display: 'block', fontVariantNumeric: 'tabular-nums',
    lineHeight: '1.5', whiteSpace: 'pre',
  }, root)
  // Off by default on a touch device, and the reason is not clutter: the only way to dismiss this
  // panel is F3, and a phone has no F3. A developer panel that a player cannot close is worse on
  // the device that cannot close it. Found by screenshotting the game at 390 points rather than by
  // reasoning about it.
  let showFps = !(window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0)
  fpsBox.style.display = showFps ? 'block' : 'none'
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F3' || (e.code === 'KeyF' && e.shiftKey)) {
      showFps = !showFps
      fpsBox.style.display = showFps ? 'block' : 'none'
    }
  })

  // --- opening hint. A player who opens this knows nothing about it; the controls are the first
  // thing they need and the last thing they should still be reading thirty seconds later. It shows
  // on load and fades the moment they touch anything, which is the only signal that they no longer
  // need it.
  const hint = el('div', {
    position: 'fixed', left: '50%', bottom: '120px', transform: 'translateX(-50%)',
    textAlign: 'center', fontSize: '15px', fontWeight: '600', lineHeight: '1.9',
    textShadow: SHADOW, opacity: '0', transition: 'opacity .6s', letterSpacing: '.3px',
    background: 'rgba(0,0,0,.42)', padding: '14px 22px', borderRadius: '10px',
  }, root)
  // The hint names the controls the device actually has. Telling somebody on a phone to press
  // W A S D is worse than saying nothing: it is the first thing they read and it is false, and it
  // was on screen for every mobile visitor until the touch controls were built.
  const coarse = window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0
  // Which touch layout is live changes what the hint should say, and getting that wrong is the
  // same fault as telling a phone to press W: instructions for controls that are not on screen.
  const stick = coarse && touchLayout() !== 'buttons'
  hint.innerHTML = '<div style="font-size:13px;opacity:.7;letter-spacing:2px;margin-bottom:6px">LUXEMBOURG</div>'
    + (!coarse
      ? 'W A S D  or  arrows to drive<br>SPACE to handbrake — this is how you drift<br>R to respawn · P to pause · C to change camera'
      : stick
        ? 'Left thumb on the stick — it comes to your thumb<br>Push up to go, down to brake · Drift to slide<br>Menu for map, camera, fullscreen'
        : 'Left thumb anywhere to steer<br>Go and Brake to drive · Drift to slide<br>Menu for map, camera, fullscreen')
  requestAnimationFrame(() => { hint.style.opacity = '1' })
  let hintGone = false
  const dismissHint = () => {
    if (hintGone) return
    hintGone = true
    hint.style.opacity = '0'
    setTimeout(() => hint.remove(), 700)
  }
  for (const ev of ['keydown', 'pointerdown']) window.addEventListener(ev, dismissHint, {once: true})

  let shownAlert = ''
  let shownStreet = null

  return {
    root,
    update({gameHours, kmh, stars: level, message, fps, drifting, paused, streetName, bustProgress = 0, draws = 0, tris = 0, peds = 0, cars = 0, x = 0, y = 0, heading = 0}) {
      // bustProgress is 0..1 of the way to being caught, so the bar shows what is LEFT.
      const remaining = Math.max(0, 1 - bustProgress)
      bustBox.style.opacity = bustProgress > 0.02 ? '1' : '0'
      // The alert drops below the bar when the bar is up, so the two never sit on each other.
      alert.style.top = bustProgress > 0.02 ? '84px' : '56px'
      bustFill.style.width = `${remaining * 100}%`
      bustFill.style.background = remaining < 0.35 ? '#ff3322' : (remaining < 0.7 ? '#ff8c1a' : '#ffc21f')
      bustLabel.style.color = remaining < 0.35 ? '#ff6655' : '#fff'
      // Only redraw on change: writing the same string sixty times a second restarts the fade.
      if (streetName !== shownStreet) {
        shownStreet = streetName
        if (streetName) street.textContent = streetName
        street.style.opacity = streetName ? '1' : '0'
      }
      speedValue.textContent = String(kmh)
      speedValue.style.color = drifting ? '#ffcf5a' : '#fff'

      for (let i = 0; i < 5; i++) {
        const lit = i < level
        starEls[i].style.color = lit ? '#ffc21f' : 'rgba(255,255,255,.22)'
        starEls[i].style.transform = lit ? 'scale(1)' : 'scale(.82)'
      }

      const hh = String(Math.floor(gameHours)).padStart(2, '0')
      const mm = String(Math.floor((gameHours % 1) * 60)).padStart(2, '0')
      clock.textContent = `${hh}:${mm}`

      if (message !== shownAlert) {
        shownAlert = message
        alert.textContent = message
        alert.style.opacity = message ? '1' : '0'
      }

      state.textContent = paused ? 'PAUSED' : (drifting ? 'DRIFT' : '')
      if (showFps) {
        // Where you are, which way you face, and what time it is. Together these are everything a
        // screenshot needs to be reproducible: a complaint about a dark corner or a building in the
        // road is only actionable if someone else can stand in the same spot at the same hour.
        // Heading is given as a compass bearing because "217°" is a thing a person can picture,
        // while the engine's own angle (0 = east, counting anticlockwise) is not.
        const deg = (a) => ((a % 360) + 360) % 360
        const bearing = deg(90 - heading * 180 / Math.PI)
        const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
        fpsBox.textContent = [
          `${fps} fps`,
          `${draws} draw calls`,
          `${(tris / 1000).toFixed(0)}k triangles`,
          `${peds} people · ${cars} cars`,
          `x ${x.toFixed(1)}  y ${y.toFixed(1)}`,
          `${bearing.toFixed(0)}° ${COMPASS[Math.round(bearing / 45) % 8]}  ·  ${hh}:${mm}`,
          'F3 to hide',
        ].join('\n')
      }
    },
  }
}
