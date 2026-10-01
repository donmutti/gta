import test from 'node:test'
import assert from 'node:assert/strict'
import {busImpulse} from '../src/game/vehicles.js'

test('centred bus flank impact pushes away without yaw',()=>{
 const hit=busImpulse(0,0,0,0,-2,0,1,10)
 assert.equal(hit.vx,0)
 assert.ok(hit.vy>0 && hit.vy<2)
 assert.equal(hit.spin,0)
})
test('front and rear flank impacts rotate in opposite directions',()=>{
 const front=busImpulse(0,0,0,4,-2,0,1,10)
 const rear=busImpulse(0,0,0,-4,-2,0,1,10)
 assert.ok(front.spin>0)
 assert.ok(rear.spin<0)
 assert.equal(front.vy,rear.vy)
})
test('bus impulse follows rotated impact direction',()=>{
 const hit=busImpulse(0,0,Math.PI/2,2,0,-1,0,10)
 assert.ok(hit.vx<0)
 assert.equal(hit.vy,0)
 assert.ok(Math.abs(hit.spin)<1e-12)
})
