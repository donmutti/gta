import test from 'node:test'
import assert from 'node:assert/strict'
import {recoverCar} from '../src/game/recovery.js'
import {stepVertical} from '../src/game/vertical.js'

test('recovery preserves bridge location and drops two metres onto its deck', () => {
  const car = {x:47.8,y:563.1,heading:1.3,elevation:-2.6,vx:10,vy:4,speed:11}
  recoverCar(car)
  assert.deepEqual([car.x,car.y,car.heading],[47.8,563.1,1.3])
  assert.equal(car.speed,0)
  assert.ok(Math.abs(car.elevation+.6)<1e-9)
  for(let i=0;i<60;i++)stepVertical(car,1/60,()=>-2.6)
  assert.equal(car.airborne,false)
  assert.equal(car.elevation,-2.6)
})

test('leaving a bridge falls under gravity rather than teleporting to the valley', () => {
  const car={x:0,y:0,elevation:50,verticalVelocity:0}
  stepVertical(car,.05,()=>0)
  assert.equal(car.airborne,true)
  assert.ok(car.elevation>49)
  for(let i=0;i<200;i++)stepVertical(car,1/60,()=>0)
  assert.equal(car.airborne,false)
  assert.equal(car.elevation,0)
})

test('ramp launch preserves upward velocity and pause does not integrate', () => {
  const car={x:0,y:0,elevation:10,verticalVelocity:12}
  stepVertical(car,.05,()=>10)
  assert.equal(car.airborne,true)
  assert.ok(car.elevation>10)
  const h=car.elevation
  stepVertical(car,0,()=>0)
  assert.equal(car.elevation,h)
})
