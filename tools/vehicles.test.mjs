import test from 'node:test'
import assert from 'node:assert/strict'
import {VEHICLE_BOX, boxContact, personContact, vehicleThreat} from '../src/game/vehicles.js'

test('bus flank and nose collide beyond the old car-sized circle', () => {
  for (const [x, y] of [[5.8, 0], [3.8, 2]]) {
    const hit = boxContact(x, y, 0, VEHICLE_BOX.car, 0, 0, 0, VEHICLE_BOX.bus)
    assert.ok(hit)
    assert.equal(boxContact(x + hit.nx * (hit.depth + 1e-6), y + hit.ny * (hit.depth + 1e-6), 0, VEHICLE_BOX.car, 0, 0, 0, VEHICLE_BOX.bus), null)
  }
})

test('oriented vehicle separation works across headings and coincident centres', () => {
  for (let a = 0; a < Math.PI * 2; a += 0.31) for (let b = 0; b < Math.PI * 2; b += 0.47) {
    const hit = boxContact(0, 0, a, VEHICLE_BOX.bus, 1, 1, b, VEHICLE_BOX.car)
    assert.ok(hit)
    assert.equal(boxContact(hit.nx * (hit.depth + 1e-6), hit.ny * (hit.depth + 1e-6), a, VEHICLE_BOX.bus, 1, 1, b, VEHICLE_BOX.car), null)
  }
  assert.ok(boxContact(0, 0, 0, VEHICLE_BOX.car, 0, 0, 0, VEHICLE_BOX.car))
  assert.equal(boxContact(0, 0, 0, VEHICLE_BOX.car, 0, 2.5, 0, VEHICLE_BOX.car), null)
})

test('pedestrians separate from parked bodies including bus corners', () => {
  for (const [x, y] of [[0, 0], [4.9, 1.4], [5.1, 1.5], [0, -1.5]]) {
    const hit = personContact(x, y, 0, 0, 0, VEHICLE_BOX.bus)
    assert.ok(hit)
    assert.equal(personContact(x + hit.nx * (hit.depth + 1e-6), y + hit.ny * (hit.depth + 1e-6), 0, 0, 0, VEHICLE_BOX.bus), null)
  }
})

test('avoid approaching vehicles and crossing paths, not traffic moving away', () => {
  const car = {x: 0, y: 0, heading: 0, box: VEHICLE_BOX.car, vx: 15, vy: 0}
  assert.ok(vehicleThreat(20, 0.5, 0, 0, car))
  assert.equal(vehicleThreat(-10, 0, 0, 0, car), null)
  assert.equal(vehicleThreat(20, 8, 0, 0, car), null)
  assert.ok(vehicleThreat(10, 4, 0, -4, car))
  assert.ok(vehicleThreat(4, 3, 0, -1, {...car, box: VEHICLE_BOX.bus, vx: 0}))
})
