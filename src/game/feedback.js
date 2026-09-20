// In-game feedback. 0 opens it, 0 or Esc closes it, 1 and 2 file a report.
//
// The point is to capture WHERE something is wrong while standing in front of it, because "a
// building is in the road somewhere in the old town" is not actionable and "building on road at
// (412, -318) heading 2.1rad at 21:40" is. Each report POSTs to the dev server's /__feedback sink,
// which appends a line to feedback.jsonl at the repo root.
//
// It only RECORDS. Nothing in the game changes as a result — the backlog is drained deliberately,
// later, by asking Claude to address it.

// Two kinds of entry live here. A REPORT is filed to disk and changes nothing now; an ACTION is a
// debug lever that takes effect immediately and is never written down.
const OPTIONS = [
  {key: 'Digit1', label: '1', kind: 'too dark here'},
  {key: 'Digit2', label: '2', kind: 'a building on the road'},
  {key: 'Digit3', label: '3', kind: 'skip the clock forward one hour', action: 'advanceHour'},
  {key: 'Digit4', label: '4', kind: 'toggle cars and pedestrians', action: 'toggleCrowds'},
  {key: 'Digit5', label: '5', kind: 'toggle the laser pointer', action: 'toggleLaser'},
]

export function createFeedback() {
  const el = document.createElement('div')
  Object.assign(el.style, {
    position: 'fixed', inset: '0', zIndex: '60', display: 'none',
    alignItems: 'center', justifyContent: 'center',
    background: 'rgba(6,9,16,.82)', backdropFilter: 'blur(2px)',
    color: '#fff', font: '500 15px/1.6 system-ui, -apple-system, sans-serif',
    pointerEvents: 'none',
  })
  el.innerHTML = `
    <div style="min-width:340px;padding:26px 30px;border-radius:12px;background:#121722;
                border:1px solid rgba(255,255,255,.12);box-shadow:0 18px 60px rgba(0,0,0,.6)">
      <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#8d97ad">Report a problem here</div>
      <div id="fb-where" style="margin:6px 0 18px;color:#5f6a80;font-size:12px"></div>
      <div id="fb-list"></div>
      <div style="margin-top:18px;color:#5f6a80;font-size:12px">0 or Esc to close</div>
    </div>`
  document.body.appendChild(el)

  const list = el.querySelector('#fb-list')
  const where = el.querySelector('#fb-where')
  for (const o of OPTIONS) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:7px 0'
    row.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;
      width:26px;height:26px;border-radius:6px;background:#222b3a;
      border:1px solid rgba(255,255,255,.14);font-weight:600">${o.label}</span><span>${o.kind}</span>`
    list.appendChild(row)
  }

  let open = false
  let flashFor = 0
  const note = document.createElement('div')
  note.style.cssText = 'margin-top:14px;color:#6ee78a;font-size:13px;min-height:1.2em'
  list.parentElement.appendChild(note)

  return {
    isOpen: () => open,
    toggle(car, gameHours) { open ? this.close() : this.show(car, gameHours) },
    show(car, gameHours) {
      open = true
      note.textContent = ''
      where.textContent = `at ${Math.round(car.x)}, ${Math.round(car.y)}  ·  ${String(Math.floor(gameHours)).padStart(2, '0')}:${String(Math.floor((gameHours % 1) * 60)).padStart(2, '0')}`
      el.style.display = 'flex'
    },
    close() { open = false; el.style.display = 'none' },
    /** Called with whichever option key was pressed while the dialog is up. */
    pick(code, car, gameHours) {
      const opt = OPTIONS.find(o => o.key === code)
      if (!opt || !open) return null
      // Actions fire straight away and leave no trace in the backlog — they are for looking at the
      // world, not for describing what is wrong with it.
      if (opt.action) {
        note.textContent = opt.kind
        flashFor = 1.2
        return {action: opt.action}
      }
      const rec = {
        kind: opt.kind,
        x: +car.x.toFixed(1), y: +car.y.toFixed(1),
        heading: +car.heading.toFixed(3),
        gameHours: +gameHours.toFixed(2),
        street: car.road?.name ?? null,
      }
      fetch('/__feedback', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(rec),
      }).then(() => { note.textContent = `noted — ${opt.kind}` })
        .catch(() => { note.textContent = 'could not reach the dev server (build mode?)' })
      flashFor = 1.2
      return {recorded: opt.kind}
    },
    update(dt) {
      if (flashFor > 0) {
        flashFor -= dt
        if (flashFor <= 0) note.textContent = ''
      }
    },
    dispose() { el.remove() },
  }
}
