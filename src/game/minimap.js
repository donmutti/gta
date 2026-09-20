// The minimap. Draws the real Luxembourg street grid around the player on a 2D canvas.
//
// It builds its own element rather than asking for one in index.html, which keeps the whole feature
// inside the simulation half — nothing here touches the Three scene or the page the renderer owns.
//
// The map rotates so the car always points up. North-up is easier to write and worse to drive by:
// at speed you want the road you are about to take pointing at the top of the dial, not northeast.

const SIZE = 186            // css pixels
const RANGE = 190           // metres from the player to the edge of the dial
const CELL = 64

/** Redraw at 25Hz, not 60. Nobody reads a minimap faster than that and it is pure overdraw. */
const REDRAW_EVERY = 1 / 25

// Bright roads on a dark backing. The first version drew dark grey on near-black, which is
// unreadable in peripheral vision — and a map you have to look AT is a map that causes crashes,
// because you take your eyes off the road to use it.
const ROAD_COLOUR = {
  primary: '#e8ecf4',
  secondary: '#ccd4e2',
  tertiary: '#b3bccd',
  default: '#98a2b5',
}

export function createMinimap(world) {
  const bounds = world.bounds
  const canvas = document.createElement('canvas')
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = SIZE * dpr
  canvas.height = SIZE * dpr
  Object.assign(canvas.style, {
    position: 'fixed', right: '16px', bottom: '16px',
    width: `${SIZE}px`, height: `${SIZE}px`,
    borderRadius: '50%', pointerEvents: 'none',
    boxShadow: '0 3px 18px rgba(0,0,0,.6)', opacity: '1',
  })
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  // Edges bucketed by cell so a frame touches the dozen streets on screen, not all 2,465.
  const byCell = new Map()
  for (const e of world.edges) {
    for (let i = 1; i < e.pts.length; i++) {
      const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i]
      const cx = Math.floor(((ax + bx) / 2) / CELL), cy = Math.floor(((ay + by) / 2) / CELL)
      const key = `${cx}:${cy}`
      const seg = {ax, ay, bx, by, kind: e.kind, width: e.width}
      const bucket = byCell.get(key)
      if (bucket) bucket.push(seg)
      else byCell.set(key, [seg])
    }
  }

  let due = 0

  return {
    canvas,
    update(dt, car, police, traffic) {
      due -= dt
      if (due > 0) return
      due = REDRAW_EVERY

      const r = SIZE / 2
      const scale = r / RANGE

      ctx.clearRect(0, 0, SIZE, SIZE)
      ctx.save()
      ctx.beginPath()
      ctx.arc(r, r, r, 0, Math.PI * 2)
      ctx.clip()

      ctx.fillStyle = 'rgba(10,13,20,0.93)'
      ctx.fillRect(0, 0, SIZE, SIZE)

      // Car up. Canvas y points DOWN, so a world heading h draws at canvas angle -h; to bring the
      // road ahead to the top we need -h + t = -90°, i.e. t = h - 90°. The sign used to be flipped,
      // which was self-consistent only at heading 90° and mirrored the dial everywhere else — at
      // heading 0 the street in front of you was drawn behind you.
      ctx.translate(r, r)
      ctx.rotate(car.heading - Math.PI / 2)

      const toMap = (x, y) => [(x - car.x) * scale, -(y - car.y) * scale]

      ctx.lineCap = 'round'
      const cells = Math.ceil(RANGE / CELL) + 1
      const c0x = Math.floor(car.x / CELL), c0y = Math.floor(car.y / CELL)
      for (let cx = c0x - cells; cx <= c0x + cells; cx++) {
        for (let cy = c0y - cells; cy <= c0y + cells; cy++) {
          const bucket = byCell.get(`${cx}:${cy}`)
          if (!bucket) continue
          for (const s of bucket) {
            const [x1, y1] = toMap(s.ax, s.ay)
            const [x2, y2] = toMap(s.bx, s.by)
            ctx.strokeStyle = ROAD_COLOUR[s.kind] ?? ROAD_COLOUR.default
            ctx.lineWidth = Math.max(1.4, s.width * scale)
            ctx.beginPath()
            ctx.moveTo(x1, y1)
            ctx.lineTo(x2, y2)
            ctx.stroke()
          }
        }
      }

      // The edge of the world, so you can see the forest coming instead of discovering it. Drawn
      // under everything else as a band of green outside the city bounds.
      if (bounds) {
        const corners = [
          [bounds.minX, bounds.minY], [bounds.maxX, bounds.minY],
          [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY],
        ].map(([x, y]) => toMap(x, y))
        ctx.save()
        ctx.beginPath()
        ctx.rect(-r * 2, -r * 2, r * 4, r * 4)
        ctx.moveTo(corners[0][0], corners[0][1])
        for (let i = corners.length - 1; i >= 0; i--) ctx.lineTo(corners[i][0], corners[i][1])
        ctx.closePath()
        ctx.fillStyle = 'rgba(28,58,32,0.92)'
        ctx.fill('evenodd')
        ctx.strokeStyle = 'rgba(96,150,96,.75)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(corners[0][0], corners[0][1])
        for (const [x, y] of corners.slice(1)) ctx.lineTo(x, y)
        ctx.closePath()
        ctx.stroke()
        ctx.restore()
      }

      if (traffic) {
        ctx.fillStyle = 'rgba(150,160,178,.85)'
        for (const t of traffic.cars) {
          const [x, y] = toMap(t.x, t.y)
          if (x * x + y * y > r * r) continue
          ctx.fillRect(x - 1.8, y - 1.8, 3.6, 3.6)
        }
      }

      if (police) {
        for (const cop of police.cops) {
          const [x, y] = toMap(cop.car.x, cop.car.y)
          const d = Math.hypot(x, y)
          // Off-dial cops are pinned to the rim rather than hidden — knowing one is out there and
          // roughly where is the entire value of the map during a chase.
          const [px, py] = d > r - 8 ? [x / d * (r - 8), y / d * (r - 8)] : [x, y]
          // A glow, not a dot: a cop is the thing you must find without looking directly at the map.
          ctx.shadowColor = '#2f7bff'
          ctx.shadowBlur = 10
          ctx.fillStyle = '#5ea2ff'
          ctx.beginPath()
          ctx.arc(px, py, 5, 0, Math.PI * 2)
          ctx.fill()
          ctx.shadowBlur = 0
        }
      }

      ctx.restore()

      // The player, drawn unrotated at the centre so the arrow always points up the screen.
      ctx.save()
      ctx.translate(r, r)
      ctx.shadowColor = 'rgba(0,0,0,.9)'
      ctx.shadowBlur = 6
      ctx.fillStyle = '#ff5540'
      ctx.beginPath()
      ctx.moveTo(0, -9)
      ctx.lineTo(6.6, 7.5)
      ctx.lineTo(0, 3.9)
      ctx.lineTo(-6.6, 7.5)
      ctx.closePath()
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.restore()

      ctx.strokeStyle = 'rgba(255,255,255,0.34)'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(r, r, r - 1, 0, Math.PI * 2)
      ctx.stroke()
    },
  }
}
