# Interfaces

The contract between the two halves. Master owns rendering, Padawan owns simulation, and neither owns the layer between them — that is the derived world model, written once and imported twice. Anything in this file is load-bearing for both sides: change it here and say so in the telegraph before changing it in code.

## 1. The shape of the pipeline

`data/city.json` is the source and is never read by the game directly. It is raw OSM denormalised into local metres, and it carries no width, no junctions, and no notion of what may be driven on.

```
data/city.json  ->  src/world/model.js  ->  renderer   (Master)
                                        ->  simulation (Padawan)
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

**Master — everything downstream of the model that is visual.** Road ribbons and junction fills, extruded buildings, materials, trees, lamps, water, parks, sky, the day-night cycle and its lighting, the gorge. Also `index.html`, the Vite config, and the Three scene graph.

**Padawan — everything that moves or is decided.** `buildWorld` and the model itself, car physics, input, the chase camera, collision resolution, pedestrians, cops and the wanted system, the HUD.

The seam is narrow by construction: Master reads the model and never writes it; Padawan writes the model and never touches a material.

## 5. The scene handshake

Master exports `createScene(world)` from `src/render/scene.js`, returning `{scene, camera, renderer, update(dt, gameHours), follow(target), resize(w, h)}`, plus `makeCar(tint)`. Padawan owns the frame loop, calls `update`, and positions `camera` itself — the chase camera is simulation, not rendering.

`gameHours` is 0..24 and is **simulation state**: Padawan ticks it, pauses it, and passes it in; Master turns it into sky, lamps and lit windows. The clock is something the game decides and the renderer depicts, not the other way round.

`follow(target)` takes the player's car object once, so the renderer can anchor fog, light culling and the shadow frustum on it. It never moves the camera.

`makeCar(tint)` returns a `THREE.Object3D` that Padawan positions each frame by setting `position` and `rotation.y`. Its `userData.headlight` is **read-only** to the simulation: the renderer drives headlight intensity from sun elevation, and a second writer simply fights it frame by frame.

There is deliberately no `makePed`. Pedestrians are one `InstancedMesh` owned entirely by the simulation — a per-pedestrian `Object3D` with its own material is exactly the draw-call explosion the performance budget forbids, so the two rules were in conflict and the mesh-per-person side lost.

World coordinates are metres with +Y north; the Three mapping is `(x, y) → (x, up, -y)` and a heading of `h` is `rotation.y = h + π/2`. That conversion appears in exactly two places, one per side.

## 6. Priority, because the deadline is morning

Cut from the bottom, never from the top.

1. A car that drives real Luxembourg streets, collides with real buildings, with a chase camera and the night lighting. This alone is a complete thing and is what ships if everything else fails.
2. Pedestrians that walk the graph and flinch, cops and the wanted meter.
3. Sound.
