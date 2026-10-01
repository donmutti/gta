# GTA Luxembourg — working notes

A browser GTA-style game set in real Luxembourg City, built from OpenStreetMap data. Drivable car, ambient traffic and pedestrians, day/night, weather, police/wanted system, terrain, and a lot of city dressing. Three.js renderer, Vite dev server, no backend.

This file is the orientation for anybody working on the code: the decisions that are not obvious from reading it, the invariants that break everything when they are broken, and the traps that have already cost somebody a night. Read it before changing anything under `src/`.

`README.md` is for playing the game. `INTERFACES.md` is the contract between the rendering half and the simulation half, and is the thing to read before touching either.

## Running it

```bash
cd path/to/gta
npm install          # first time only
npm run dev          # Vite dev server — the game runs on http://localhost:5199
npm run build        # production build into dist/
npm run smoke        # headless-Chrome check: fails on any thrown exception OR a black frame
npm run smoke -- --prod   # build, preview dist, and smoke that
```

The dev server is on **port 5199** (not Vite's default 5173 — that port is taken by another project on this machine). Controls: WASD/arrows to drive, Space handbrake, R respawn, P pause, **M full-screen map** (M or Esc closes it; the world freezes and goes silent while it is up), **F fullscreen** (absent on iPhone, which has no Fullscreen API). Debug hooks on `window.game` (car, world, police, traffic, etc.) and `window.__forceHours = <0..24>` to freeze the clock.

## Architecture at a glance

- `src/main.js` — the entry point and frame loop. Owns the clock, input, the car, the chase camera. Calls `createScene(world)` and, each frame, `update(dt, gameHours)` + `renderer.render`. **The physics/simulation half lives here and under `src/game/`.**
- `src/world/model.js` — `buildWorld(city)` turns raw OSM (`public/data/city.json`) into the derived model both halves agree on: welded road graph (`edges`), building footprints with AABBs and a spatial `grid`, point-obstacle grid, the boundary forest, and passthrough decor arrays. **Pure — no Three.js.**
- `src/world/terrain.js` — the heightfield. `groundHeight(x,z)`, `groundNormal(x,z)`, `seatGroundUnder(pts)`, `minGroundUnder(pts)`, `setHeightfield`, `hasTerrain`. Pure data + math, imported by BOTH the renderer (to seat geometry) and the physics (to put the car on the ground). This is the shared "seam" between the two halves.
- `src/render/scene.js` — the renderer. `createScene(world)` returns `{scene, camera, renderer, update, follow, resize, makeCar, ...}`. The whole city draws in a small number of calls: buildings are ONE merged geometry with a procedural facade shader; roads/sidewalks/markings are merged; trees/lamps/props/decor are InstancedMeshes. Sky dome, day-night cycle, bloom, fog, rain, and the terrain heightfield mesh all live here.
- `src/render/*.js` — the asset modules, each built by a dedicated session (see below): `car.js` (4 vehicle types + fleet), `decor.js` (cafes, postboxes, monuments, steps, cathedral, Gëlle Fra, roadworks, neon, signals), `townhouse.js`, `streetprops.js`, `parks.js`, `airport.js`, `critters.js`, `eastereggs.js`.
- `src/game/*.js` — the simulation: `car.js` physics, `camera.js` chase cam (with camera-collision so it never sits inside a building), `pedestrians.js`, `traffic.js`, `police.js`, `signals.js`, `minimap.js`, `hud.js`, `audio.js`.

### The words for the things

These are the owner's words and the code's words, and they are the same words. Written down because the two nearly diverged: he described a change as "heat between 0 and 1 stars" and it was only luck that the code already called it that.

| Term | What it is |
|---|---|
| `heat` | the continuous meter the police keep on the player. Invisible. |
| `stars` | the discrete surfacing of heat, `floor(heat / 30)`. **The only part a player sees.** |
| `CRIME` | the divisor every crime's heat passes through. Raising it widens the grace band below one star. |
| the grace band | heat below one star, where nothing responds and the meter does not drain |
| the standing force | the thirty police cars planted at start. Parked, always on the map, never removed, and the **only** source of pursuit. |
| the beacon | the column of light on the delivery's active point. Drawn through the city, so it gives a bearing and never a route. |
| the marker | the same point on the minimap |
| the objective line | the gold line under the clock: the destination and the countdown |
| pickup / drop | the two ends of a delivery, each a point on a named street |

> A delivery is addressed by street name because the game already prints the name of the road you are on. The player it was built for navigated by the beacon and never used a name — that is measured rather than assumed, and the names have not been removed.

### The coordinate law (used EVERYWHERE)
The map is XY with +Y north. The Three.js ground is XZ. The mapping, in every file:
```
three.x = map.x     three.z = -map.y     (north points into -Z; the map reads like a map)
```
So a map point `[mx, my]` is placed at world `(mx, y, -my)`, and terrain is sampled as `groundHeight(mx, -(-my)) = groundHeight(worldX, worldZ)`. Get this wrong and everything mirrors or floats.

### Terrain and bridge levels

The world uses ACT's CC0 2024 bare-earth LiDAR, baked to an 8 m grid by `tools/bake-terrain.py`. `groundHeight(x,z)` returns the earth, while `surfaceHeight(x,z,previousElevation)` also considers named bridge decks. Passing the previous elevation preserves the level of a vehicle beneath an overpass. `configureTerrain(world)` installs bridge profiles and grades the relocated airport onto its flat platform before scene construction.

The renderer and sampler use the same grid triangles. `src/render/terrain-mesh.js` clips roads, sidewalks, parks and green polygons onto those triangles; interpolating only a road's original endpoints lets the earth cut through its middle. Buildings keep their centroid floor elevation and extend foundations to the lowest sampled perimeter. Traffic, police and the player publish elevation and slope; collision and pedestrian avoidance reject bodies on another vertical level. River polylines render as narrow ribbons along the bed, never as filled polygons at height zero.

Keep grass below asphalt: equal heights cause Z-fighting. Asphalt uses world-space UVs so overlapping road ribbons have identical texture coordinates. The relocated airport is an intentional gameplay modification, not the real Findel elevation at its geographical location.

## Data pipeline

All game data is committed under `public/data/` — the game never touches the network at play time. Regenerate with the fetch tools (they hit public APIs, be polite):
- `tools/fetch-city.mjs` — Overpass → `city.json` (roads, buildings, trees, lamps, water, green, signals, crossings, cafes, postboxes, monuments, steps, fountains, squares).
- `tools/fetch-terrain.mjs` / `tools/bake-terrain.py` — ACT 2024 LiDAR MNT → `heightfield.json` (8 m grid, zeroed at the slice centre).
- `tools/fetch-findel.mjs` — Overpass → `findel.json` (real Findel airport geometry, re-anchored just east of the city so it's a short drive).

## Verifying a change

Reading the code is not evidence. Every fault worth finding in this project was found by a picture or a number, including faults in code whose author had just described it correctly.

```bash
npm run smoke            # load the page headless; fails on an exception, a game that never boots, or a BLACK FRAME
npm run smoke -- --prod  # build, preview dist, and check the built bundle
```

The black-frame check is the one that earns its keep: a camera trapped inside a building renders nothing, throws nothing, and passes every other test.

- `tools/birdseye.mjs` photographs the running city straight down from a given altitude. A complaint about a world is almost always a complaint about its layout, and you cannot see a layout from inside a car.
- `tools/portrait.mjs` frames a single vehicle from the instanced fleet.
- `tools/probe.mjs` evaluates an expression inside the running game and prints the result, which is how you get a number rather than an impression.
- `tools/clip.mjs` records a GIF or an MP4 with the game's own audio. `.claude/skills/clip/SKILL.md` explains the traps, and there are several.

All four drive headless Chrome over CDP. **Every one of them traps `process.on('exit')` and kills its browser**, because leaked headless Chromes were this project's main resource leak — two were once found alive, parented to init, fifty minutes after the runs that spawned them had finished.

## Open items

- **The car does not drive on the terrain.** The heightfield is built and switched off (see above). Reviving it means the car reading `groundHeight` for its Y and tilting to `groundNormal` on slopes, and `stepCar` collision reading ground height. That is the one unfinished piece of the terrain work.
- **NPC tail lamps carry no emissive.** The trim mesh is one vertex-coloured material and `emissive` is a uniform, so lit lamps would need another InstancedMesh per body type. At night they read as dark blocks. The hero car is unaffected.
- **Traffic and pedestrians still pass through destructible props**, and there is no sound on a break — the feedback is the existing impact shake. Vehicles DO knock pedestrians over now, each using its own measured box from `src/game/vehicles.js`, and they brake hard for anybody in their path.
- **`BACKLOG.md`** holds the remaining ideas.
