// Recovery preserves map position, heading and the current bridge/valley level.
export function recoverCar(car, visual) {
  car.vx = car.vy = car.speed = car.steer = car.yawRate = car.lateral = 0
  car.contact = false
  car.elevation = (car.elevation ?? 0) + 2
  car.verticalVelocity = 0
  car.airborne = true
  if (visual) visual.roll = visual.pitch = visual.lastSpeed = 0
}
