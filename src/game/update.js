/**
 * "New version available." — telling a player that the game they are playing is not the game that
 * exists.
 *
 * WHAT IT WILL NOT DO, which is most of the design.
 *
 * It never says you are up to date. There is exactly one thing this can put on screen, an offer, and
 * the absence of it means nothing was found rather than that everything is current. A check that
 * reassures is a check that can lie, and an unknown answer dressed as a good one is the failure shape
 * this project keeps meeting: the branch written for "I do not understand this state" must be the
 * loudest one, never the quietest. Here loud means the console and the F3 panel; the player sees
 * nothing, because a player cannot act on "I could not reach the server".
 *
 * It never checks while you are driving. No timer, no polling, no request between frames. The checks
 * happen when the page becomes visible again, when the game is paused, and once at boot after the
 * city has finished building — moments when nobody is mid-corner and the network is idle. 340 people
 * and 120 cars at 60 fps on somebody else's laptop is the thing being protected.
 *
 * It never interrupts. A toast in the corner with a button, which can be dismissed and which does not
 * take focus, steal input or pause anything. Somebody at four stars with a police car alongside is
 * not going to be handed a modal.
 *
 * And it never offers what it cannot do. A source clone cannot update itself from a browser button,
 * so it is not given one — it is told the two commands instead. A button labelled "Update now" that
 * cannot update is a lie of the same family as a version check that says up to date.
 */

const LOADED = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'unknown'
const MODE = typeof __BUILD_MODE__ === 'string' ? __BUILD_MODE__ : 'source'
const BOOT_DELAY = 4000      // let the city finish building before touching the network
const MIN_GAP = 60_000       // never check twice within a minute, however many events arrive

export function createUpdateCheck({onStatus} = {}) {
  let last = 0
  let offered = null         // the sha we have already offered; never nag twice for the same one
  let dismissed = null
  let el = null

  const status = (s) => { if (onStatus) onStatus(s) }

  async function check(reason) {
    const now = Date.now()
    if (now - last < MIN_GAP) return
    last = now
    let data
    try {
      // no-store, or a cached copy answers the question "what is being served now" with what was
      // being served an hour ago, which is precisely the lie this is here to avoid.
      const res = await fetch('/version.json', {cache: 'no-store'})
      if (!res.ok) throw new Error(`version.json ${res.status}`)
      data = await res.json()
    } catch (e) {
      // Offline, blocked, no such file: say nothing to the player and be loud in the console.
      console.info(`[update] check failed (${reason}): ${e.message}. Cannot tell whether this build is current.`)
      status({state: 'unknown', reason: e.message})
      return
    }

    // Source clone: the server and the page are the same stale thing, so the authority is the remote.
    // Deployed: the served bundle is the authority, and a new deploy changes it.
    const available = data.mode === 'source'
      ? (data.upstream && data.sha && data.upstream !== data.sha ? data.upstream : null)
      : (data.sha && data.sha !== LOADED ? data.sha : null)

    if (!available) {
      console.info(`[update] running ${LOADED} (${data.mode}); nothing newer found.`)
      status({state: 'current', sha: LOADED})
      return
    }
    status({state: 'available', sha: available, mode: data.mode})
    if (available === offered || available === dismissed) return
    offered = available
    show(available, data.mode)
  }

  function show(sha, mode) {
    if (el) el.remove()
    el = document.createElement('div')
    el.style.cssText = [
      // Above the touch controls rather than over them: Stop and Drift live in the bottom right
      // corner on a phone, and a toast there covers the brake.
      'position:fixed', 'left:16px',
      (window.matchMedia('(pointer: coarse)').matches ? 'bottom:200px' : 'bottom:16px'),
      'right:16px', 'z-index:60',
      'display:flex', 'align-items:center', 'gap:12px',
      'padding:10px 12px', 'border-radius:8px',
      'background:rgba(18,20,24,0.92)', 'color:#e8e8ea',
      'font:13px/1.35 system-ui,-apple-system,sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,0.45)',
      'border:1px solid rgba(255,255,255,0.12)',
      'max-width:min(92vw,420px)',
    ].join(';')

    const text = document.createElement('div')
    text.textContent = 'New version available.'
    el.appendChild(text)

    if (mode === 'source') {
      // Cannot update itself. Say what to run instead of pretending a button could do it.
      text.textContent = 'New version available on origin/main.'
      const how = document.createElement('code')
      how.textContent = 'git pull && npm install'
      how.style.cssText = 'background:rgba(255,255,255,0.08);padding:3px 6px;border-radius:4px;white-space:nowrap'
      el.appendChild(how)
    } else {
      const btn = document.createElement('button')
      btn.textContent = 'Update now'
      btn.style.cssText = [
        'cursor:pointer', 'border:0', 'border-radius:6px', 'padding:6px 10px',
        'background:#3b82f6', 'color:#fff', 'font:inherit', 'font-weight:600',
      ].join(';')
      // A plain reload is enough: index.html is served no-cache by Vercel and points at a
      // content-hashed bundle, so the new hash pulls the new code.
      btn.onclick = () => location.reload()
      el.appendChild(btn)
    }

    const close = document.createElement('button')
    close.textContent = '×'
    close.setAttribute('aria-label', 'dismiss')
    close.style.cssText = 'cursor:pointer;border:0;background:transparent;color:#9aa0a6;font:16px/1 system-ui;padding:2px 4px'
    close.onclick = () => { dismissed = sha; el.remove(); el = null }
    el.appendChild(close)

    // Never takes focus: the player may be steering with the keyboard and a focused button eats keys.
    el.tabIndex = -1
    document.body.appendChild(el)
  }

  // The triggers, all of them moments when nobody is driving.
  const onVisible = () => { if (document.visibilityState === 'visible') check('tab visible') }
  document.addEventListener('visibilitychange', onVisible)
  const boot = setTimeout(() => check('boot'), BOOT_DELAY)

  return {
    /** Called by the frame loop when the game pauses — a natural, free moment to ask. */
    onPause() { check('paused') },
    loaded: LOADED,
    mode: MODE,
    stop() { clearTimeout(boot); document.removeEventListener('visibilitychange', onVisible); if (el) el.remove() },
  }
}
