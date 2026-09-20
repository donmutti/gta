# Interfaces

The contract between the two halves of this game: the renderer under `src/render/`, and the simulation under `src/game/` plus `src/main.js`. Neither owns the layer between them — that is the derived world model, written once and imported twice.

Everything in this file is load-bearing for both sides. A change here is a change to something the other half is relying on, so change the document first and the code second; the value of the contract is that it can be read without reading either implementation.

## 1. The shape of the pipeline

`data/city.json` is the source and is never read by the game directly. It is raw OSM denormalised into local metres, and it carries no width, no junctions, and no notion of what may be driven on.

```
data/city.json  ->  src/world/model.js  ->  renderer     (src/render/)
                                        ->  simulation  (src/game/, src/main.js)
```

`src/world/model.js` exports `buildWorld(city)` and is pure: same input, same output, no Three.js import, no DOM. The renderer draws what it describes; the simulation collides and navigates against the same numbers. That is the whole point — if tarmac is painted from one width table and the car steers by another, the car drives visibly off the road and it looks like a physics bug.

## 2. Road width and drivability

One table, in `model.js`, exported as `ROAD_KINDS`. Widths are the full carriageway in metres, centred on the OSM polyline.

| kind | width | drivable | pedestrian zone |
|---|---|---|---|
| `primary` | 12.0 | yes | no |
| `secondary` | 10.0 | yes | no |
| `tertiary` | 9.0 | yes | no |
| `residential` | 7.0 | yes | no |
| `unclassified` | 7.0 | yes | no |
| `living_street` | 6.0 | yes | no |
| `service` | 4.5 | yes | no |
| `pedestrian` | 4.0 | yes | **yes** |
| `elevator` | — | **no** | — |

> A pedestrian street is drivable on purpose. Driving down one is exactly the kind of thing this game should let you do and then punish you for, so it stays in the world and carries a flag the wanted system reads. An elevator is not a road at all — the Pfaffenthal lift arrives in the OSM highway list and must be paved by nobody and routed through by nobody.

## 3. The derived world model

`buildWorld(city)` returns:

- `bounds` — `{minX, minY, maxX, maxY}` over every feature, so both sides agree where the world ends.
- `edges` — one per drivable road: `{id, a, b, pts, kind, width, oneway, pedestrianZone, length}`. `a` and `b` are node ids; `pts` is the polyline in metres.
- `nodes` — `{id, x, y, edges}`, welded from shared endpoints. Two road ends within `WELD` (0.5 m) are the same junction.
- `buildings` — `{id, pts, h, aabb}` where `aabb` is `{minX, minY, maxX, maxY}`.
- `grid` — a uniform spatial hash over building AABBs, cell `GRID` (32 m), with `grid.near(x, y, r)` returning candidate buildings. 6,196 buildings cannot be tested per frame; the broad phase is not optional.
- `trees`, `lamps`, `water`, `green` — passed through from the source untouched.

> The road graph exists for the simulation: pedestrians walk it, cops chase along it, traffic follows it. The renderer is free to ignore `nodes` entirely and draw `edges` as ribbons. Nothing in the model knows about Three.js, and nothing in it may.

## 4. What each side owns

**The renderer — everything downstream of the model that is visual.** `src/render/`: road ribbons and junction fills, extruded buildings, materials, trees, lamps, water, parks, sky, the day-night cycle and its lighting, the gorge, the debris a broken prop leaves behind. Also `index.html`, the Vite config, and the Three scene graph.

**The simulation — everything that moves or is decided.** `src/world/model.js` and the model itself, car physics, input, the chase and birdseye cameras, collision resolution, pedestrians and their ragdolls, cops and the wanted system, the HUD.

The seam is narrow by construction: the renderer reads the model and never writes it; the simulation writes the model and never touches a material.

**Two places deliberately cross that line, and both are documented rather than accidental.**

`world.registerBuildings(extra)` and `world.registerProps(list)` let the renderer push what it invented back into physics. Most of what stands in this city — synthetic street trees and lamps, all seven kinds of street furniture, the townhouse frontages — has no existence in `city.json` at all; it is decided at scene-build time. Without these the player drives through things that are plainly drawn, which is exactly what happened: 363 mapped trees and 45 lamps were drawn at the kerb and driven through, and the 1,337 furniture props had never been collidable at all. **What is drawn is what is collided with, and these two calls are how that stays true.**

`src/render/clearance.js` and `src/render/siting.js` are renderer-side but answer questions the simulation also cares about — whether a point is in a carriageway, and whether an object may stand somewhere. They defer to `world.onRoad` rather than carrying a second width table, because road width was already known in three places and a fourth copy is how they drift apart.

## 5. The scene handshake

The renderer exports `createScene(world)` from `src/render/scene.js`, returning `{scene, camera, renderer, update(dt, gameHours), follow(target), resize(w, h)}`, plus `makeCar(tint)`. The simulation owns the frame loop, calls `update`, and positions `camera` itself — the chase and birdseye cameras are simulation, not rendering.

`gameHours` is 0..24 and is **simulation state**: the simulation ticks it, pauses it, and passes it in; the renderer turns it into sky, lamps and lit windows. The clock is something the game decides and the renderer depicts, not the other way round. `window.__forceHours` overrides it for a screenshot, and is honoured only in the loop's un-paused branch — every capture tool in `tools/` sets both that and `setHours`, because either alone leaves the clock where it started.

`follow(target)` takes the player's car object once, so the renderer can anchor fog, light culling and the shadow frustum on it. It never moves the camera.

`makeCar(tint)` returns a `THREE.Object3D` that the simulation positions each frame by setting `position` and `rotation.y`. Its `userData.headlight` is **read-only** to the simulation: the renderer drives headlight intensity from sun elevation, and a second writer simply fights it frame by frame.

**The frozen hooks are named rather than implied**, because several passes have rebuilt the geometry underneath them: `wheelFL`, `wheelFR`, `wheelRL`, `wheelRR` as pivots, and `userData.headlight`, `userData.tailGlow`, `userData.lightbar`. A rewrite may change everything about how a car is built and none of these names. `makeCarFleet(count)` returns `{group, setAt, count, palette}`, and `setAt(i, x, z, rotY, colourIndex)` must place everything belonging to slot `i` — body, glass and all four wheels — or the fleet drives with its wheels somewhere else.

There is deliberately no `makePed`. Pedestrians are one `InstancedMesh` owned entirely by the simulation — a per-pedestrian `Object3D` with its own material is exactly the draw-call explosion the performance budget forbids, so the two rules were in conflict and the mesh-per-person side lost.

World coordinates are metres with +Y north; the Three mapping is `(x, y) → (x, up, -y)` and a heading of `h` is `rotation.y = h + π/2`. That conversion appears in exactly two places, one per side.

## 6. What the contract is for

The reason to keep this narrow is not tidiness. Both halves consume the same derived numbers, so a disagreement between them is not a visual bug — it is a car that drives visibly off a road that was painted from a different table. Every expensive fault in this project has lived on this seam or on the one between the invented widths and the surveyed points.

So: if you are about to make one half assume something about the other, write it here first. If you cannot state it here in a sentence, the seam is in the wrong place.
