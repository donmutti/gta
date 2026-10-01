// Run against the dev server: node tools/probe.mjs --file tools/turns-check.js
(async () => {
  await new Promise(resolve => setTimeout(resolve, 3000))
  const wrap = value => Math.atan2(Math.sin(value), Math.cos(value))
  const previous = new Map(), errors = []
  let busTurnFrames = 0, turnFrames = 0, start
  await new Promise(done => {
    function frame(now) {
      start ??= now
      for (const car of game.traffic.cars) {
        const prior = previous.get(car)
        if (prior && Math.abs(car.ox) + Math.abs(car.oy) + Math.abs(car.spin) < 0.03 && !car.pullOver) {
          const dx = car.x - prior.x, dy = car.y - prior.y, distance = Math.hypot(dx, dy)
          if (distance > 0.02 && distance < 1 && car.junction?.active && prior.turn === car.junction) {
            const heading = prior.heading + wrap(car.face - prior.heading) / 2
            errors.push(Math.abs(wrap(Math.atan2(dy, dx) - heading)) * 180 / Math.PI)
            turnFrames++
            if (car.box.halfL > 4) busTurnFrames++
          }
        }
        previous.set(car, {x: car.x, y: car.y, heading: car.face, turn: car.junction})
      }
      if (now - start < 12000) requestAnimationFrame(frame)
      else done()
    }
    requestAnimationFrame(frame)
  })
  errors.sort((a, b) => a - b)
  const result = {turnFrames, busTurnFrames, worstHeadingErrorDegrees: errors.at(-1),
    p95HeadingErrorDegrees: errors[Math.floor(errors.length * 0.95)]}
  if (!turnFrames || !busTurnFrames || result.p95HeadingErrorDegrees > 3) throw new Error(JSON.stringify(result))
  return result
})()
