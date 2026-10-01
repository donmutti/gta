// Only a slow player occupying the forward lane counts, not a neighbouring lane
// or a car on another bridge level. Horns are short, with several seconds of rest.
export function playerBlocksLane(car, player) {
  if (Math.abs((car.elevation??0)-(player.elevation??0))>2.5 || Math.abs(player.speed)>2) return false
  const dx=player.x-car.x-car.ox,dy=player.y-car.y-car.oy
  const fx=Math.cos(car.face),fy=Math.sin(car.face)
  const ahead=dx*fx+dy*fy,across=Math.abs(-dx*fy+dy*fx)
  const angle=player.heading-car.face
  const playerWidth=2.215*Math.abs(Math.sin(angle))+1.08*Math.abs(Math.cos(angle))
  return ahead>0 && ahead<car.box.halfL+7 && across<car.box.halfW+playerWidth+.25
}

export function updatePatience(car, blocked, dt, index=0) {
  if (!blocked) {car.blockedTime=0;car.hornRemaining=0;car.hornCooldown=0;return false}
  car.blockedTime=(car.blockedTime??0)+dt
  car.hornCooldown=Math.max(0,(car.hornCooldown??0)-dt)
  car.hornRemaining=Math.max(0,(car.hornRemaining??0)-dt)
  if(car.blockedTime>=3+(index%3)*.4 && !car.hornCooldown){
    car.hornRemaining=.45;car.hornCooldown=4+(index%3)
  }
  return car.hornRemaining>0
}
