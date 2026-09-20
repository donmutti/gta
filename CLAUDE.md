# GTA Luxembourg — working notes

A browser GTA-style game set in real Luxembourg City, built from OpenStreetMap data. Drivable car, ambient traffic and pedestrians, day/night, weather, police/wanted system, terrain, and a lot of city dressing. Three.js renderer, Vite dev server, no backend.

This file is the memory of how the project was built. It was made in one overnight sprint by a **team of cooperating Claude Code sessions** coordinating through a plain-text telegraph. If you are resuming the project, read this whole file first — especially "Restoring the team" at the end.

## Running it

```bash
cd path/to/gta
npm install          # first time only
npm run dev          # Vite dev server — the game runs on http://localhost:5199
npm run build        # production build into dist/
npm run smoke        # headless-Chrome check: fails on any thrown exception OR a black frame
npm run smoke -- --prod   # build, preview dist, and smoke that
```

The dev server is on **port 5199** (not Vite's default 5173 — that port is taken by another project on this machine). Controls: WASD/arrows to drive, Space handbrake, R respawn, P pause, **M full-screen map** (M or Esc closes it; the world freezes and goes silent while it is up). Debug hooks on `window.game` (car, world, police, traffic, etc.) and `window.__forceHours = <0..24>` to freeze the clock.

## Architecture at a glance

- `src/main.js` — the entry point and frame loop. Owns the clock, input, the car, the chase camera. Calls `createScene(world)` and, each frame, `update(dt, gameHours)` + `renderer.render`. **The physics/simulation half lives here and under `src/game/`.**
- `src/world/model.js` — `buildWorld(city)` turns raw OSM (`public/data/city.json`) into the derived model both halves agree on: welded road graph (`edges`), building footprints with AABBs and a spatial `grid`, point-obstacle grid, the boundary forest, and passthrough decor arrays. **Pure — no Three.js.**
- `src/world/terrain.js` — the heightfield. `groundHeight(x,z)`, `groundNormal(x,z)`, `seatGroundUnder(pts)`, `minGroundUnder(pts)`, `setHeightfield`, `hasTerrain`. Pure data + math, imported by BOTH the renderer (to seat geometry) and the physics (to put the car on the ground). This is the shared "seam" between the two halves.
- `src/render/scene.js` — the renderer. `createScene(world)` returns `{scene, camera, renderer, update, follow, resize, makeCar, ...}`. The whole city draws in a small number of calls: buildings are ONE merged geometry with a procedural facade shader; roads/sidewalks/markings are merged; trees/lamps/props/decor are InstancedMeshes. Sky dome, day-night cycle, bloom, fog, rain, and the terrain heightfield mesh all live here.
- `src/render/*.js` — the asset modules, each built by a dedicated session (see below): `car.js` (4 vehicle types + fleet), `decor.js` (cafes, postboxes, monuments, steps, cathedral, Gëlle Fra, roadworks, neon, signals), `townhouse.js`, `streetprops.js`, `parks.js`, `airport.js`, `critters.js`, `eastereggs.js`.
- `src/game/*.js` — the simulation: `car.js` physics, `camera.js` chase cam (with camera-collision so it never sits inside a building), `pedestrians.js`, `traffic.js`, `police.js`, `signals.js`, `minimap.js`, `hud.js`, `audio.js`.

### The coordinate law (used EVERYWHERE)
The map is XY with +Y north. The Three.js ground is XZ. The mapping, in every file:
```
three.x = map.x     three.z = -map.y     (north points into -Z; the map reads like a map)
```
So a map point `[mx, my]` is placed at world `(mx, y, -my)`, and terrain is sampled as `groundHeight(mx, -(-my)) = groundHeight(worldX, worldZ)`. Get this wrong and everything mirrors or floats.

### Terrain — BUILT, THEN SWITCHED OFF (the world is flat today)
`TERRAIN_ENABLED = false` at the top of `src/world/terrain.js` is the master switch, and it is off. With the car still driving on a flat plane, a terraned world put traffic above and below the roads and made the city hard to simply look at, so the whole thing is disabled in one place: `setHeightfield` refuses to install the grid, every helper returns its flat value, and all the seating maths below stays in the code resolving to zero. Objects keep their elevation reasoning; the flat world just disregards it. To revive the hills: flip the flag, then finish the car work (read `groundHeight` for the car's Y, `groundNormal` for its tilt). The rest of this section describes how the terrain works when it is on.


The world was flat (y=0) until the final hours, then a DEM was baked (`tools/fetch-terrain.mjs` → `public/data/heightfield.json`, ~73m of gorge relief) and every STATIC thing was seated on it via `groundHeight`. Buildings seat at their footprint **centroid** ground minus a small bury (seating at the lowest corner sank sloped storefronts below the street). Roads/sidewalks/markings/paths drape per-vertex. Lamp light-pools sit 0.25m up so they clear sloped roads. The airport is lifted to ONE flat anchor height (a runway must stay flat). Bridges are deliberately NOT draped — they span valleys. **Open S3 item when mothballed:** the CAR still drives on the flat plane — it needs to read `groundHeight` for its Y and tilt to `groundNormal` on slopes (physics half, `src/game/` + `main.js`).

## Data pipeline

All game data is committed under `public/data/` — the game never touches the network at play time. Regenerate with the fetch tools (they hit public APIs, be polite):
- `tools/fetch-city.mjs` — Overpass → `city.json` (roads, buildings, trees, lamps, water, green, signals, crossings, cafes, postboxes, monuments, steps, fountains, squares).
- `tools/fetch-terrain.mjs` — opentopodata SRTM → `heightfield.json` (elevation grid, zeroed at the slice centre).
- `tools/fetch-findel.mjs` — Overpass → `findel.json` (real Findel airport geometry, re-anchored just east of the city so it's a short drive).

## Screenshots (how the team "saw" the game)

There is no committed shot harness (they lived in a scratch dir), but the approach is: launch headless Chrome with `--remote-debugging-port`, open `http://localhost:5199`, wait for `typeof window.game === 'object'`, set `window.game.car.x/y/heading` + `window.__forceHours`, wait ~2.5s, `Page.captureScreenshot`. **Always kill the Chrome child** (add a `process.on('exit')` trap) — leaked headless Chromes were the main resource leak. `npm run smoke` uses the same CDP flow and is the canonical "did I break it" check — it fails on a thrown exception AND on an all-black frame (which caught the camera-trapped-in-a-building class of bug that runs fine but renders nothing).

## The development methodology (multi-session, telegraph-coordinated)

This is how the project was built, and how to resume it.

**The shape: one hub, many spokes.** A single **Master** session designs, integrates every asset into `scene.js`, and is the ONLY router between the asset builders and the simulation owner. A **Padawan** session owns the whole simulation half (`main.js`, `src/game/*`, physics, pedestrians, traffic, police) and listens ONLY to Master. Any number of short-lived **Builder** sessions each own ONE new asset file exclusively (`townhouse.js`, `streetprops.js`, `parks.js`, `airport.js`, `eastereggs.js`, and repeated passes on `car.js`). A hub beats a mesh once there are more than a couple of sessions.

**The rules that made it work:**
- **One file per builder, exclusively.** A builder never edits another session's file. Cross-cutting needs are routed through Master on the telegraph. This is what let a dozen sessions commit into one repo without clobbering each other.
- **Frozen contracts.** When many sessions depend on a module (e.g. `makeCar` / `makeCarFleet`), its interface is frozen and written down; a builder may change the guts, never the signature or the named hooks (`wheelFL/FR/RL/RR` pivots, `userData.headlight/tailGlow/lightbar`). Master verifies the contract survived before trusting a builder's report.
- **Smoke after every integration.** Five builders committing into one scene kept taking the game down with undefined-symbol crashes that looked fine in isolation. `npm run smoke` (load the page once, fail on exception or black frame) catches them in seconds. Run it after every wire-in.
- **Verify with a screenshot or a number, never an assumption.** The recurring bug family all night was "looks right in the code, wrong only in a measured value" — drift, a mis-signed offset, a stale build, a black frame. Shoot it or measure it.
- **Gemini as an outside A-class eye.** Builders sent close-up renders to Gemini (`GEMINI_LLM_API_KEY`, `gemini-3.7-flash:generateContent`) for a 1-10 rating + concrete fixes, and iterated on the fixes (not the number — it anchors low on low-poly).
- **Tag before risky work.** `git tag stable-pre-terrain` gave a one-command rollback before the terrain rewrite.
- **Never `git push`.** Commit freely to `main`; pushing is the human's call.

### The telegraph — `1.txt`

`1.txt` (in this repo) is the shared coordination log. Newest entry at the bottom; one aligned column format `DATE TIME  WHO  TYPE  message`. Sessions post when they START (claiming a file), hit MILESTONES, are BLOCKED, or DONE (releasing a file with the commit name). Types used: NOTE, ASK, ANSWER, ACK, DECISION, RELAY, BLOCKED, PROPOSE, STATUS, VERIFIED, SHUTDOWN. A session's telegraph watch is just `tail -F 1.txt | grep` for the tags it cares about (Padawan grepped `MASTER` only). It is kept in the repo as the record of how this was built.

## Restoring the team (how to resume this project)

To pick the project back up with the same setup:

1. **Start the game and confirm it runs:** `npm install && npm run dev`, then `npm run smoke` — it must pass before you build anything on top.
2. **Open the telegraph:** read `1.txt` end-to-end (it's the full history), then post a fresh `HELLO`/`NOTE` line so any other session knows a human is driving. Restart a watch if you want live coordination: `tail -F 1.txt | grep -E "MASTER|<your tags>"`.
3. **Re-establish the roles you need:**
   - **Master** (this role): design + integrate into `scene.js`/`decor.js` + route between builders and Padawan. Run `smoke` after every integration.
   - **Padawan**: own `main.js` + `src/game/*`. First job on resume is the open **S3** item — put the car on the terrain: set the car mesh Y to `groundHeight(car.x, -car.y)` and orient its up-vector to `groundNormal(...)` so it pitches/rolls on slopes, and make `stepCar`/collision read ground height. `groundHeight` and `groundNormal` are exported from both `src/world/terrain.js` and re-exported from `src/render/scene.js`.
   - **Builders**: spawn one per new asset, each with an exclusive new file under `src/render/`, the frozen-contract discipline, the Gemini loop, and "commit your file only, never push." Let them exit on completion; don't leave idle sessions consuming tokens.
4. **Spawning sessions on this machine:** launch each with `claude` in this directory. If you want them auto-managed like the paragrapher sessions, mirror that project's LaunchAgent pattern (a `.plist` + a start script that runs `claude --bg -n <Name> --model <model> --effort <level>` per session). Otherwise just start them by hand as needed — the telegraph is all the coordination they require.

### Open items at mothball time
- **S3 — car on terrain** (Padawan): the one unfinished piece of the terrain feature (see above).
- **Cars** — geometry was improved a lot (tumblehome greenhouse, hips, crowned roof, 4 body types) but the final Gemini-gated polish pass was cut off by a session limit. `car.js` holds the frozen contract; a fresh builder can resume the loop.
- **BACKLOG.md** — remaining ideas (notably real terrain refinement was largely done; other detail passes noted there).
