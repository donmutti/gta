import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {buildWorld} from '../src/world/model.js'
import {createCar,stepCar} from '../src/game/car.js'
import {setHeightfield,configureTerrain,surfaceHeight,surfaceNormal} from '../src/world/terrain.js'
import {setGroundSampler,setNormalSampler} from '../src/world/ground.js'

test('Pont Rouge stays drivable above the building at the reported invisible block',()=>{
 const load=name=>JSON.parse(fs.readFileSync(new URL(`../public/data/${name}.json`,import.meta.url)))
 const findel=load('findel'),world=buildWorld(load('city'),findel)
 world.findel=findel;setHeightfield(load('heightfield'));configureTerrain(world)
 setGroundSampler((x,y,h)=>surfaceHeight(x,-y,h))
 setNormalSampler((x,y,h)=>surfaceNormal(x,-y,h))
 const car=createCar(47.8,563.1,Math.atan2(619.615-541.714,302.203+45.471))
 car.elevation=surfaceHeight(car.x,-car.y)
 for(let i=0;i<180;i++){
  stepCar(car,{throttle:1,steer:0,handbrake:false},1/60,world)
  car.elevation=surfaceHeight(car.x,-car.y,car.elevation)
 }
 assert.ok(car.x>75,`car stopped at ${car.x}, ${car.y}`)
 assert.ok(car.speed>10)
})
