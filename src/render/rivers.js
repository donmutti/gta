import * as THREE from 'three'
import {drapeGeometry} from './terrain-mesh.js'
import {groundHeight, terrainField} from '../world/terrain.js'

// OSM river centre lines are open polylines, never polygon fills. Cross-sections
// follow the sampled riverbed along the valley, not world height zero.
export function buildRivers(lines) {
  const f = terrainField(), positions = [], indices = []
  if (!f) return new THREE.Group()
  for (const line of lines) {
    let length = 0
    for (let i=1;i<line.length;i++) length+=Math.hypot(line[i][0]-line[i-1][0],line[i][1]-line[i-1][1])
    const half = length > 20000 ? 3.5 : 1.5
    for(let i=1;i<line.length;i++){
      const a=line[i-1],b=line[i],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy)
      if(!len || Math.max(a[0],b[0])<f.minX || Math.min(a[0],b[0])>f.maxX || Math.max(a[1],b[1])<f.minY || Math.min(a[1],b[1])>f.maxY)continue
      const nx=-dy/len,ny=dx/len,steps=Math.ceil(len/2)
      let previous=null
      for(let j=0;j<=steps;j++){
        const t=j/steps,x=a[0]+dx*t,y=a[1]+dy*t
        if(x<f.minX || x>f.maxX || y<f.minY || y>f.maxY){previous=null;continue}
        const h=groundHeight(x,-y)+.06,k=positions.length/3
        positions.push(x-nx*half,h,-y+ny*half,x+nx*half,h,-y-ny*half)
        if(previous!==null)indices.push(previous,k,previous+1,previous+1,k,k+1)
        previous=k
      }
    }
  }
  const g=new THREE.BufferGeometry()
  g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setIndex(indices);g.computeVertexNormals()
  const mesh=new THREE.Mesh(drapeGeometry(g, .04),new THREE.MeshStandardMaterial({color:0x284d5b,roughness:.28,metalness:.25,side:THREE.DoubleSide}))
  mesh.name='rivers';return mesh
}
