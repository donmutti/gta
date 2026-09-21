# GTA Luxembourg — backlog

## Real terrain (altitudes)
The world is currently dead flat (y=0 everywhere). Luxembourg is famously hilly — the Pfaffenthal gorge, the plateau escarpments, the drop the Pont Rouge spans. Add real elevation:
- Source a DEM (SRTM 30m, or Copernicus / IGN Luxembourg LiDAR for finer detail).
- Sample elevation per road/building/tree vertex during the fetch; carry a `z`/height per point.
- Raise the ground to a heightfield mesh; sit buildings on their footprint's ground height; ramp roads along the terrain.
- Physics: the car currently drives on a plane — stepCar/collision would need to read ground height (slopes affect speed, the camera pitches). This is the big ripple, not the rendering.
- The Pont Rouge and Pfaffenthal lift only make literal sense once the gorge has depth.
Effort: large (touches fetch, world model, renderer, and physics). Deferred to the backlog on 2026-09-19.
