import fs from 'node:fs'
import assert from 'node:assert/strict'
import {buildWorld} from '../src/world/model.js'
import {createCar,stepCar} from '../src/game/car.js'
import {stepVertical} from '../src/game/vertical.js'
import {setHeightfield,configureTerrain,groundHeight,surfaceHeight,surfaceNormal} from '../src/world/terrain.js'
import {setGroundSampler,setNormalSampler} from '../src/world/ground.js'
const load=name=>JSON.parse(fs.readFileSync(new URL(`../public/data/${name}.json`,import.meta.url)))
const findel=load('findel'),world=buildWorld(load('city'),findel)
world.findel=findel;setHeightfield(load('heightfield'));configureTerrain(world)
setGroundSampler((x,y,h)=>surfaceHeight(x,-y,h));setNormalSampler((x,y,h)=>surfaceNormal(x,-y,h))
for(const throttle of [-1,1]){
 const car=createCar(47.7,562.1,3*Math.PI/180);car.elevation=groundHeight(car.x,-car.y)
 const initial={x:car.x,y:car.y,h:car.elevation}
 for(let i=0;i<300;i++){stepCar(car,{throttle,steer:0,handbrake:false},1/60,world);stepVertical(car,1/60)}
 if(throttle<0)assert.ok(car.x<initial.x-15 && car.speed < -2, 'must reverse uphill away from the wall')
 console.log({throttle,distance:Math.hypot(car.x-initial.x,car.y-initial.y),speed:car.speed})
}
