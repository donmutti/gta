// Browser expression for tools/probe.mjs. Measures real animation-frame intervals, including
// GPU back-pressure; simulation dt is clamped and must never be used to calculate FPS.
// npm run performance (start npm run dev first). The uncapped case recreates the old lights.
(async () => {
  const {renderer, police, car, input} = window.game
  const originalUpdate = police.update
  const originalHours = window.__forceHours
  const originalMode = game.camMode()
  const samples = []
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const round = n => Math.round(n * 100) / 100

  async function sample(name, minimum = 30) {
    console.info(`[performance] warming ${name}`)
    await wait(3000)
    const intervals = []
    let start, previous
    let peakKmh = 0, distance = 0, x = car.x, y = car.y
    await new Promise(resolve => {
      function tick(now) {
        peakKmh = Math.max(peakKmh, Math.abs(car.speed) * 3.6)
        distance += Math.hypot(car.x - x, car.y - y)
        x = car.x; y = car.y
        if (previous !== undefined) intervals.push(now - previous)
        else start = now
        previous = now
        if (now - start < 6000) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
    const elapsed = intervals.reduce((sum, value) => sum + value, 0)
    intervals.sort((a, b) => a - b)
    const fps = intervals.length * 1000 / elapsed
    const result = {
      name, fps: round(fps), p95Ms: round(intervals[Math.floor(intervals.length * 0.95)]),
      frames: intervals.length, elapsedMs: round(elapsed),
      draws: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      litPatrols: police.cops.filter(cop => cop.headlight.visible).length,
      patrols: police.cops.length, speedKmh: round(Math.abs(car.speed) * 3.6),
      peakKmh: round(peakKmh), distanceMetres: round(distance),
      pass: fps >= minimum,
    }
    samples.push(result)
    console.info(`[performance] ${name}: ${result.fps} FPS, p95 ${result.p95Ms} ms`)
  }

  try {
    window.__forceHours = 20.4
    game.setCamMode('chase')
    await sample('night, bounded lights')

    // A/B/A in the same browser and city. Change only light visibility, leaving the
    // simulation and renderer identical. Original lighting is evidence, not a pass gate.
    police.update = function (...args) {
      originalUpdate.apply(this, args)
      for (const cop of police.cops) {
        cop.headlight.visible = true
        cop.tail.visible = true
      }
    }
    await sample('night, original unbounded lights', 0)
    police.update = originalUpdate
    await sample('night, bounded lights repeat')

    window.__forceHours = 12
    await sample('day')
    window.__forceHours = 16.5
    await sample('rain')
    window.__forceHours = 20.4
    game.setCamMode('bird')
    game.bird.alt = 400
    await sample('bird camera')
    game.setCamMode('chase')
    // Start along a long straight road, rather than holding throttle at the spawn junction
    // until the car hits a wall. Keep real physics and record distance to prove it moved.
    let straight
    for (const edge of game.world.edges) {
      if (edge.width < 9 || edge.pedestrianZone) continue
      for (let i = 1; i < edge.pts.length; i++) {
        const a = edge.pts[i - 1], b = edge.pts[i]
        if (Math.hypot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) > 1500) continue
        const length = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (!straight || length > straight.length) straight = {a, b, length, width: edge.width}
      }
    }
    if (!straight) throw new Error('No straight road available for the driving benchmark')
    const dx = (straight.b[0] - straight.a[0]) / straight.length
    const dy = (straight.b[1] - straight.a[1]) / straight.length
    car.x = straight.a[0] + dx * 10 + dy * straight.width / 4
    car.y = straight.a[1] + dy * 10 - dx * straight.width / 4
    car.heading = Math.atan2(dy, dx)
    car.vx = car.vy = car.speed = car.steer = 0
    game.chase.ready = false
    police.state.heat = 150
    input.touch.throttle = 1
    await sample('driving with wanted level')
    if (samples.at(-1).distanceMetres < 30) throw new Error('Driving benchmark stalled before covering 30 metres')
    input.touch.throttle = 0

    return {
      viewport: [innerWidth, innerHeight], devicePixelRatio,
      drawingBuffer: [renderer.domElement.width, renderer.domElement.height],
      pass: samples.every(sample => sample.pass), samples,
    }
  } finally {
    police.update = originalUpdate
    input.touch.throttle = 0
    window.__forceHours = originalHours
    game.setCamMode(originalMode)
  }
})()
