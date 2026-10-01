// Browser expression for probe --file. Set window.__terrainView via a copied
// expression to choose an oblique overview; the default inspects Pont Rouge.
(async () => {
  const g=game, view=window.__terrainView ?? {x:100,y:550,eye:[-160,115,-300],target:[110,-25,-570]}
  g.input.state.paused=true;window.__forceHours=12;g.setHours(12)
  g.car.x=view.x;g.car.y=view.y;g.car.elevation=undefined
  await new Promise(r=>setTimeout(r,1000))
  // A still must stop the game's camera updates, not race the next frame.
  window.requestAnimationFrame=()=>0
  await new Promise(r=>setTimeout(r,50))
  g.camera.up.set(0,1,0);g.camera.position.set(...view.eye);g.camera.lookAt(...view.target)
  g.scene.getObjectByName('sky').position.copy(g.camera.position)
  g.renderer.render(g.scene,g.camera)
  const p=g.scene.getObjectByName('terrain').geometry.attributes.position
  let low=Infinity,high=-Infinity
  for(let i=0;i<p.count;i++){low=Math.min(low,p.getY(i));high=Math.max(high,p.getY(i))}
  return {terrainVertices:p.count,low,high,bridges:g.world.edges.filter(e=>e.bridge).map(e=>({name:e.name,heights:e.deckHeights}))}
})()
