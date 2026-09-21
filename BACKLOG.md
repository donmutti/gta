# GTA Luxembourg — backlog

## Real terrain (altitudes)
The world is currently dead flat (y=0 everywhere). Luxembourg is famously hilly — the Pfaffenthal gorge, the plateau escarpments, the drop the Pont Rouge spans. Add real elevation:
- Source a DEM (SRTM 30m, or Copernicus / IGN Luxembourg LiDAR for finer detail).
- Sample elevation per road/building/tree vertex during the fetch; carry a `z`/height per point.
- Raise the ground to a heightfield mesh; sit buildings on their footprint's ground height; ramp roads along the terrain.
- Physics: the car currently drives on a plane — stepCar/collision would need to read ground height (slopes affect speed, the camera pitches). This is the big ripple, not the rendering.
- The Pont Rouge and Pfaffenthal lift only make literal sense once the gorge has depth.
Effort: large (touches fetch, world model, renderer, and physics). Deferred to the backlog on 2026-09-19.

## Measure the frame rate on a phone, and turn the knobs only if it is bad
The mobile controls shipped and the game was played on a real iPhone without anybody complaining about it being slow, so the performance work planned in `docs/mobile-controls.md` section 6 "Performance on a real phone" was never needed and no knob was turned. The number itself was never captured.
- The workload is 844 draw calls and 8.4 million triangles per frame, which is comfortable on a laptop GPU and large for a phone throttling under a browser.
- The knobs, cheapest first: the renderer's pixel-ratio cap (1.5 today, and 1.0 would remove more than half the shaded pixels at arm's length), then fog and tile streaming radius, then crowd and traffic counts (340 people and 120 vehicles) which are visible and should be last.
- Get a number before touching any of them. Guessing about performance is how a game ends up slower and uglier at once, and the one thing known today is that nobody has complained.
Effort: small to measure, unknown to act on. Added on 2026-09-21.
