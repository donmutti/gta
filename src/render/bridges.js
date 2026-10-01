import * as THREE from 'three'
import {groundHeight} from '../world/terrain.js'

export function buildBridges(world) {
  const group = new THREE.Group()
  group.name = 'bridges'
  const road = new THREE.MeshStandardMaterial({color:0x42454a,roughness:.8})
  const stone = new THREE.MeshLambertMaterial({color:0xaaa28e})
  const rail = new THREE.MeshLambertMaterial({color:0x8b8982})
  function strip(a,b,ha,hb,width,offset,material,raise=0) {
    const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),nx=-dy/length,ny=dx/length
    const points=[]
    for(const [p,h]of[[a,ha],[b,hb]])for(const side of[-1,1]){
      const off=offset+side*width/2
      points.push(p[0]+nx*off,h+raise,-p[1]-ny*off)
    }
    const g=new THREE.BufferGeometry()
    g.setAttribute('position',new THREE.Float32BufferAttribute(points,3))
    g.setIndex([0,2,1,1,2,3]);g.computeVertexNormals()
    const mesh=new THREE.Mesh(g,material);mesh.receiveShadow=true;group.add(mesh)
  }
  for(const e of world.edges){
    if(!e.bridge)continue
    for(let i=1;i<e.pts.length;i++){
      const a=e.pts[i-1],b=e.pts[i],ha=e.deckHeights[i-1],hb=e.deckHeights[i]
      const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),nx=-dy/length,ny=dx/length
      strip(a,b,ha,hb,e.width,0,road,.02)
      for(const side of[-1,1]){
        strip(a,b,ha,hb,1.8,side*(e.width/2+.9),stone,.15)
        const beam=new THREE.Mesh(new THREE.BoxGeometry(length, .3, .16),rail)
        const off=side*(e.width/2+1.7)
        beam.position.set((a[0]+b[0])/2+nx*off,(ha+hb)/2+1.05,-(a[1]+b[1])/2-ny*off)
        beam.rotation.set(0,Math.atan2(dy,dx),Math.atan2(hb-ha,length),'YXZ')
        group.add(beam)
      }
      const deck=new THREE.Mesh(new THREE.BoxGeometry(length,1,e.width+3.6),stone)
      deck.position.set((a[0]+b[0])/2,(ha+hb)/2-.5,-(a[1]+b[1])/2)
      deck.rotation.set(0,Math.atan2(dy,dx),Math.atan2(hb-ha,length),'YXZ')
      deck.castShadow=true;group.add(deck)
      for(let d=24;d<length-12;d+=45){
        const t=d/length,x=a[0]+dx*t,y=a[1]+dy*t,h=ha+(hb-ha)*t,base=groundHeight(x,-y)
        if(h-base<3)continue
        const pier=new THREE.Mesh(new THREE.BoxGeometry(3,h-base,e.width+1),stone)
        pier.position.set(x,(h+base)/2-.5,-y);pier.rotation.y=Math.atan2(dy,dx);pier.castShadow=true;group.add(pier)
      }
    }
  }
  return group
}
