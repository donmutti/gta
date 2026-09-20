// The full-screen map. M opens it, M or Esc closes it.
//
// North-up and whole-city, deliberately unlike the minimap: the dial in the corner is for driving
// (car-up, close range), this is for orienting yourself (where am I in Luxembourg, where are the
// cops, how far is that). Two different jobs, so two different maps.
//
// The static city — roads, parks, building footprints, the map edge — is drawn ONCE into an
// offscreen canvas when the map is opened or the window resizes. Every frame after that just blits
// that bitmap and paints the handful of things that move. Re-tracing six thousand footprints per
// frame would cost more than the entire 3D scene.

const PAD = 48              // px of margin between the city and the screen edge

const ROAD_COLOUR = {
  primary: '#e8ecf4',
  secondary: '#ccd4e2',
  tertiary: '#b3bccd',
  default: '#7f899b',
}

export function createBigMap(world) {
  const bounds = world.bounds
  const dpr = Math.min(window.devicePixelRatio || 1, 2)

  const canvas = document.createElement('canvas')
  Object.assign(canvas.style, {
    position: 'fixed', inset: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: '40', display: 'none',
  })
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')

  const still = document.createElement('canvas')   // offscreen: the static city
  const sctx = still.getContext('2d')

  let open = false
  let W = 0, H = 0, scale = 1, ox = 0, oy = 0

  // The airport is drawn too — it is part of the drivable world, and an airport you cannot find on
  // the map is an airport you never drive to. main.js already loaded it for the bounds, so it comes
  // in on the world rather than being fetched a second time.
  const findel = world.findel ?? null

  const toScreen = (x, y) => [ox + x * scale, oy - y * scale]   // +y is north, so screen y flips

  /** The rectangle the map must contain: the city slice, plus the airport when it has loaded. */
  function extent() {
    let {minX, minY, maxX, maxY} = bounds
    const grow = (pts) => { for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    } }
    if (findel) {
      for (const r of (findel.runways ?? [])) grow(r)
      for (const b of (findel.buildings ?? [])) grow(b.pts)
    }
    return {minX, minY, maxX, maxY}
  }

  function layout() {
    W = window.innerWidth
    H = window.innerHeight
    for (const c of [canvas, still]) { c.width = W * dpr; c.height = H * dpr }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const e = extent()
    const w = e.maxX - e.minX, h = e.maxY - e.minY
    scale = Math.min((W - PAD * 2) / w, (H - PAD * 2) / h)
    ox = W / 2 - ((e.minX + e.maxX) / 2) * scale
    oy = H / 2 + ((e.minY + e.maxY) / 2) * scale
    drawStill()
  }

  function drawStill() {
    sctx.clearRect(0, 0, W, H)
    sctx.fillStyle = '#0a0d14'
    sctx.fillRect(0, 0, W, H)

    // the slice itself, so the city sits on a lighter ground than the surrounding void
    const [bx0, by0] = toScreen(bounds.minX, bounds.maxY)
    const [bx1, by1] = toScreen(bounds.maxX, bounds.minY)
    sctx.fillStyle = '#141a25'
    sctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0)

    // parks
    sctx.fillStyle = 'rgba(46,96,54,.85)'
    for (const poly of (world.green ?? [])) {
      if (poly.length < 3) continue
      sctx.beginPath()
      poly.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); i ? sctx.lineTo(sx, sy) : sctx.moveTo(sx, sy) })
      sctx.closePath()
      sctx.fill()
    }

    // building footprints — faint, so they read as city fabric without competing with the streets
    sctx.fillStyle = 'rgba(126,138,158,.30)'
    for (const b of world.buildings) {
      const pts = b.pts
      if (pts.length < 3) continue
      sctx.beginPath()
      pts.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); i ? sctx.lineTo(sx, sy) : sctx.moveTo(sx, sy) })
      sctx.closePath()
      sctx.fill()
    }

    // streets, over everything
    sctx.lineCap = 'round'
    for (const e of world.edges) {
      sctx.strokeStyle = ROAD_COLOUR[e.kind] ?? ROAD_COLOUR.default
      sctx.lineWidth = Math.max(0.7, e.width * scale * 0.85)
      sctx.beginPath()
      e.pts.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); i ? sctx.lineTo(sx, sy) : sctx.moveTo(sx, sy) })
      sctx.stroke()
    }

    // the edge of the drivable world
    sctx.strokeStyle = 'rgba(96,150,96,.7)'
    sctx.lineWidth = 2
    sctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0)

    // Findel, east of the city: aprons and terminals as pale blocks, the runway as the broad bar it
    // is, and a label — an airport you cannot find on the map is an airport you never drive to.
    if (findel) {
      sctx.fillStyle = 'rgba(126,138,158,.32)'
      for (const b of (findel.buildings ?? [])) {
        if (b.pts.length < 3) continue
        sctx.beginPath()
        b.pts.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); i ? sctx.lineTo(sx, sy) : sctx.moveTo(sx, sy) })
        sctx.closePath(); sctx.fill()
      }
      sctx.strokeStyle = '#cfd6e4'
      sctx.lineCap = 'butt'
      let tip = null
      for (const r of (findel.runways ?? [])) {
        sctx.lineWidth = Math.max(2, 45 * scale)
        sctx.beginPath()
        r.forEach(([x, y], i) => { const [sx, sy] = toScreen(x, y); i ? sctx.lineTo(sx, sy) : sctx.moveTo(sx, sy) })
        sctx.stroke()
        if (r.length) tip = toScreen(r[0][0], r[0][1])
      }
      if (tip) {
        sctx.fillStyle = 'rgba(255,255,255,.8)'
        sctx.font = '600 12px system-ui, -apple-system, sans-serif'
        sctx.fillText('✈  FINDEL', tip[0] - 26, tip[1] - 12)
      }
    }

    // title + how to get out, top-left
    sctx.fillStyle = 'rgba(255,255,255,.92)'
    sctx.font = '600 15px system-ui, -apple-system, sans-serif'
    sctx.fillText('LUXEMBOURG', PAD, PAD - 16)
    sctx.fillStyle = 'rgba(255,255,255,.55)'
    sctx.font = '13px system-ui, -apple-system, sans-serif'
    sctx.fillText('M or Esc to close', PAD, PAD + 2)

    // north arrow, top-right
    const nx = W - PAD, ny = PAD + 6
    sctx.strokeStyle = 'rgba(255,255,255,.6)'
    sctx.fillStyle = 'rgba(255,255,255,.85)'
    sctx.lineWidth = 2
    sctx.beginPath(); sctx.moveTo(nx, ny + 18); sctx.lineTo(nx, ny - 14); sctx.stroke()
    sctx.beginPath(); sctx.moveTo(nx, ny - 20); sctx.lineTo(nx - 5, ny - 9); sctx.lineTo(nx + 5, ny - 9); sctx.closePath(); sctx.fill()
    sctx.font = '600 12px system-ui, -apple-system, sans-serif'
    sctx.fillText('N', nx - 4, ny + 32)
  }

  return {
    isOpen: () => open,
    toggle() { open ? this.close() : this.show() },
    show() {
      layout()                       // catches a window resized while the map was shut
      open = true
      canvas.style.display = 'block'
    },
    close() {
      open = false
      canvas.style.display = 'none'
    },
    /** Blit the static city, then paint what moves. Only called while the map is open. */
    update(car, police, traffic) {
      if (!open) return
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) layout()
      ctx.clearRect(0, 0, W, H)
      ctx.drawImage(still, 0, 0, W, H)

      if (traffic) {
        ctx.fillStyle = 'rgba(150,160,178,.8)'
        for (const t of traffic.cars) {
          const [x, y] = toScreen(t.x, t.y)
          ctx.fillRect(x - 1.5, y - 1.5, 3, 3)
        }
      }

      if (police) {
        for (const cop of police.cops) {
          const [x, y] = toScreen(cop.car.x, cop.car.y)
          ctx.shadowColor = '#2f7bff'
          ctx.shadowBlur = 10
          ctx.fillStyle = '#5ea2ff'
          ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill()
          ctx.shadowBlur = 0
        }
      }

      // The easter eggs, pinned where they actually are. Spider-Man and the Hulk wander, so the
      // positions are read fresh every time the map is drawn rather than captured at build time —
      // half the fun is opening the map and seeing that the spider has moved.
      const eggs = world.eggs?.markers?.() ?? []
      if (eggs.length) {
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        for (const e of eggs) {
          const [x, y] = toScreen(e.x, e.y)
          ctx.beginPath()
          ctx.arc(x, y, 9, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(12,16,24,.78)'
          ctx.fill()
          ctx.strokeStyle = 'rgba(255,214,120,.9)'
          ctx.lineWidth = 1.4
          ctx.stroke()
          ctx.font = '11px system-ui, -apple-system, sans-serif'
          ctx.fillStyle = '#fff'
          ctx.fillText(e.icon, x, y + 0.5)
          ctx.font = '600 10px system-ui, -apple-system, sans-serif'
          ctx.fillStyle = 'rgba(255,214,120,.95)'
          ctx.fillText(e.label, x, y + 18)
        }
        ctx.textAlign = 'start'
        ctx.textBaseline = 'alphabetic'
      }

      // you: an arrow at your real position, pointing where the car points. Heading 0 is +x (east),
      // and screen y is flipped, so the screen-space rotation is the negated heading.
      const [px, py] = toScreen(car.x, car.y)
      ctx.save()
      ctx.translate(px, py)
      ctx.rotate(-car.heading)
      ctx.shadowColor = 'rgba(0,0,0,.9)'
      ctx.shadowBlur = 8
      ctx.fillStyle = '#ff5540'
      ctx.beginPath()
      ctx.moveTo(11, 0); ctx.lineTo(-7, 7.5); ctx.lineTo(-3.5, 0); ctx.lineTo(-7, -7.5)
      ctx.closePath()
      ctx.fill()
      ctx.restore()

      // a ring around you, so the arrow is findable on a city-wide map at a glance
      ctx.strokeStyle = 'rgba(255,85,64,.55)'
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.arc(px, py, 15, 0, Math.PI * 2); ctx.stroke()
    },
    dispose() { canvas.remove() },
  }
}
