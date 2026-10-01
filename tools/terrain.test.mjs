import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {setHeightfield, groundHeight} from '../src/world/terrain.js'
import {groundGeometry, drapeGeometry} from '../src/render/terrain-mesh.js'

test('terrain sampler and rendered triangles agree inside both cell halves', () => {
  setHeightfield({nx:2,ny:2,minX:0,maxX:8,minY:0,maxY:8,heights:[0,8,16,4]})
  const mesh = new THREE.Mesh(groundGeometry(), new THREE.MeshBasicMaterial({side:THREE.DoubleSide}))
  const ray = new THREE.Raycaster()
  for (let x=.2;x<8;x+=.7) for(let y=.3;y<8;y+=.8) {
    ray.set(new THREE.Vector3(x,100,-y),new THREE.Vector3(0,-1,0))
    const hit = ray.intersectObject(mesh)[0]
    assert.ok(hit)
    assert.ok(Math.abs(hit.point.y-(groundHeight(x,-y)-.05))<1e-5)
  }
})

test('draped paving agrees with ground between original vertices', () => {
  setHeightfield({nx:3,ny:3,minX:0,maxX:16,minY:0,maxY:16,heights:[0,5,0,10,-3,8,4,1,5]})
  const g = new THREE.PlaneGeometry(15,15).rotateX(-Math.PI/2).translate(8,0,-8)
  drapeGeometry(g,.02)
  const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}))
  const ray=new THREE.Raycaster()
  for(let x=1;x<15;x+=1.1)for(let y=1;y<15;y+=1.2){
    ray.set(new THREE.Vector3(x,100,-y),new THREE.Vector3(0,-1,0))
    const hit=ray.intersectObject(mesh)[0]
    assert.ok(hit)
    assert.ok(Math.abs(hit.point.y-groundHeight(x,-y)-.02)<1e-5)
  }
})

test('bridge actors retain their deck or valley level at the same map position', async () => {
  const {configureTerrain,surfaceHeight}=await import('../src/world/terrain.js')
  setHeightfield({nx:3,ny:2,minX:0,maxX:20,minY:0,maxY:10,heights:[10,-20,10,10,-20,10]})
  const edge={name:'Pont test',pts:[[0,5],[20,5]],width:6}
  configureTerrain({edges:[edge]})
  assert.equal(surfaceHeight(10,-5,10),10)
  assert.equal(surfaceHeight(10,-5,-20),-20)
  assert.equal(surfaceHeight(10,-5),10)
  assert.equal(edge.bridge,true)
})
