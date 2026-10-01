// Run in an isolated dev browser: node tools/probe.mjs --file tools/avoidance-check.js
(async () => {
  const {VEHICLE_BOX, inBox, SHOULDER} = await import('/src/game/vehicles.js')
  game.input.state.paused = true
  const ped = game.crowd.peds[0]
  Object.assign(ped, {idle: 99, pace: 0, fox: 0, foy: 0, fvx: 0, fvy: 0,
    crossAt: null, crossing: 0, down: 0, rag: null})
  const observer = {x: ped.x, y: ped.y, heading: 0, speed: 0, vx: 0, vy: 0}
  game.crowd.update(0, observer, 0, null, [])
  const startY = ped.y
  const vehicle = {x: ped.x - 25, y: ped.y, heading: 0, vx: 12, vy: 0,
    box: VEHICLE_BOX.bus, elevation: 0}
  let hits = 0, clearance = 0
  for (let i = 0; i < 80; i++) {
    vehicle.x += vehicle.vx * 0.05
    game.crowd.update(0.05, observer, i * 0.05, null, [vehicle])
    if (inBox(ped.x, ped.y, vehicle.x, vehicle.y, 1, 0, vehicle.box, SHOULDER)) hits++
    clearance = Math.max(clearance, Math.abs(ped.y - startY))
  }
  const result = {hits, clearance, standing: ped.down === 0}
  if (hits || clearance < VEHICLE_BOX.bus.halfW + SHOULDER || !result.standing) {
    throw new Error(JSON.stringify(result))
  }
  return result
})()
