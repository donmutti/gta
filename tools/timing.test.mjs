import test from 'node:test'
import assert from 'node:assert/strict'
import {simulationDelta} from '../src/game/timing.js'

test('startup never integrates time spent constructing the scene',()=>{
 assert.equal(simulationDelta(100, null),0)
 assert.equal(simulationDelta(100, 15000),0)
})
test('normal frames preserve elapsed time and tab restoration is bounded',()=>{
 assert.equal(simulationDelta(1016,1000),.016)
 assert.equal(simulationDelta(61000,1000),.05)
})
