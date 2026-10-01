import {surfaceHeight} from '../world/terrain.js'

// A support must be beneath the wheels: approaching a bridge from below cannot
// pull a falling car upwards onto its deck. A small tolerance handles road seams.
export function stepVertical(car, dt, support = (x,y,h) => surfaceHeight(x,-y,undefined,h+.35)) {
  if (car.elevation === undefined) car.elevation = surfaceHeight(car.x,-car.y)
  if (dt <= 0) return 0
  const floor = support(car.x,car.y,car.elevation)
  const velocity = car.verticalVelocity ?? 0
  if (!car.airborne && car.elevation + velocity*dt - floor <= .35) {
    car.verticalVelocity = (floor-car.elevation)/dt
    car.elevation = floor
    return 0
  }
  car.airborne = true
  car.elevation += velocity*dt - .5*9.81*dt*dt
  car.verticalVelocity = velocity - 9.81*dt
  if (car.elevation <= floor) {
    const impact = Math.max(0,-car.verticalVelocity)
    car.elevation = floor
    car.verticalVelocity = 0
    car.airborne = false
    return impact
  }
  return 0
}
