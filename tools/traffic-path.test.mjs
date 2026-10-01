import test from 'node:test'
import assert from 'node:assert/strict'
import {createLanePath, createJunctionPath, samplePath} from '../src/game/traffic-path.js'

const edge = pts => ({pts, width: 10, oneway: false})
const error = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

test('opposite directions keep to their own right-hand lanes', () => {
  const road = edge([[0, 0], [100, 0]])
  assert.equal(samplePath(createLanePath(road, 1, 1), 20).y, -2.5)
  assert.equal(samplePath(createLanePath(road, -1, 1), 20).y, 2.5)
})

test('bent roads keep heading aligned with actual movement', () => {
  const path = createLanePath(edge([[0, 0], [40, 0], [40, 50]]), 1, 1, 12)
  for (let d = 0.2; d < path.length - 0.2; d += 0.15) {
    const a = samplePath(path, d - 0.1), b = samplePath(path, d + 0.1), middle = samplePath(path, d)
    assert.ok(error(middle.heading, Math.atan2(b.y - a.y, b.x - a.x)) < 0.04)
  }
})

test('junctions join both lane positions and tangents without a sideways jump', () => {
  const a = createLanePath(edge([[-50, 0], [0, 0]]), 1, 1)
  const b = createLanePath(edge([[0, 0], [0, 50]]), 1, 1)
  const join = createJunctionPath(a, b, 12)
  const start = samplePath(a, join.start), end = samplePath(b, join.end)
  assert.deepEqual(samplePath(join, 0), start)
  assert.ok(Math.hypot(samplePath(join, join.length).x - end.x, samplePath(join, join.length).y - end.y) < 1e-8)
  assert.ok(error(samplePath(join, join.length).heading, end.heading) < 1e-8)
  for (let d = 0.2; d < join.length - 0.2; d += 0.15) {
    const p = samplePath(join, d), q = samplePath(join, d + 0.1)
    assert.ok(error(p.heading, Math.atan2(q.y - p.y, q.x - p.x)) < 0.05)
  }
})

test('narrow one-way bridge has one centred lane', () => {
  const edge={pts:[[0,0],[100,0]],width:3.4,oneway:true}
  for(const lane of[-1,1])assert.equal(samplePath(createLanePath(edge,1,lane),50).y,0)
})
