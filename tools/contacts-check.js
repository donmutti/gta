// Run against the dev server: node tools/probe.mjs --file tools/contacts-check.js
(async () => {
  const {boxContact, personContact} = await import('/src/game/vehicles.js')
  const {createVehicleBodies} = await import('/src/game/vehicle-bodies.js')
  const collect = createVehicleBodies(game.car, game.traffic, game.police)
  await new Promise(resolve => setTimeout(resolve, 4000))
  let worstVehicles = 0, worstPeople = 0, maxDepth = 0, frames = 0, start, last, total = 0
  await new Promise(done => {
    function frame(now) {
      if (last !== undefined) total += now - last
      else start = now
      last = now
      frames++
      const bodies = collect.update()
      let vehicles = 0, people = 0
      for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j]
        if (Math.abs(a.elevation - b.elevation) > 3) continue
        const hit = boxContact(a.x, a.y, a.heading, a.box, b.x, b.y, b.heading, b.box)
        if (hit && hit.depth > 0.03) { vehicles++; maxDepth = Math.max(maxDepth, hit.depth) }
      }
      for (const ped of game.crowd.peds) {
        if (ped.down > 0) continue
        for (const body of bodies) {
          if (Math.abs((ped.elevation ?? body.elevation) - body.elevation) > 2.5) continue
          const hit = personContact(ped.x, ped.y, body.x, body.y, body.heading, body.box)
          if (hit && hit.depth > 0.03) people++
        }
      }
      worstVehicles = Math.max(worstVehicles, vehicles)
      worstPeople = Math.max(worstPeople, people)
      if (now - start < 5000) requestAnimationFrame(frame)
      else done()
    }
    requestAnimationFrame(frame)
  })
  const parkedMeshesMatch = game.police.cops.every(cop =>
    Math.hypot(cop.mesh.position.x - cop.car.x, cop.mesh.position.z + cop.car.y) < 0.001)
  const result = {fps: (frames - 1) * 1000 / total, worstVehicles, worstPeople, maxDepth, parkedMeshesMatch}
  if (worstVehicles || worstPeople || !parkedMeshesMatch) throw new Error(JSON.stringify(result))
  return result
})()
