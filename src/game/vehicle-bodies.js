import {VEHICLE_BOX} from './vehicles.js'
import {groundAt} from '../world/ground.js'

// One reusable snapshot of the actual hull positions for pedestrian prediction and contacts.
// Traffic's route coordinates exclude its impact offset; the visible body does not.
export function createVehicleBodies(player, traffic, police) {
  const entries = [
    {source: player, box: VEHICLE_BOX.car, kind: 'player'},
    ...traffic.cars.map(source => ({source, box: source.box, kind: 'traffic'})),
    ...police.cops.map(cop => ({source: cop.car, box: VEHICLE_BOX.car, kind: 'police'})),
  ]
  const bodies = []
  return {
    bodies,
    update(trafficVisible = true) {
      bodies.length = 0
      for (const body of entries) {
        if (!trafficVisible && body.kind === 'traffic') continue
        const car = body.source, ambient = body.kind === 'traffic'
        body.x = car.x + (ambient ? car.ox : 0)
        body.y = car.y + (ambient ? car.oy : 0)
        body.heading = ambient ? car.face + car.spin : car.heading
        body.vx = ambient ? Math.cos(car.face) * (car.cruise ?? 0) + car.ovx : car.vx
        body.vy = ambient ? Math.sin(car.face) * (car.cruise ?? 0) + car.ovy : car.vy
        body.elevation = groundAt(body.x, body.y)
        bodies.push(body)
      }
      return bodies
    },
  }
}
