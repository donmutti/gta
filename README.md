# Luxembourg

A browser game set in the actual streets of Luxembourg City. The roads, the buildings, the trees, the staircases down into the Pfaffenthal gorge — all real, pulled from OpenStreetMap and projected into metres so you can drive on them.

## Start here

You need **Node 20.19 or newer** (22.12+ also fine; `node -v` will tell you). Nothing else — no database, no API keys, no account.

```bash
git clone https://github.com/donmutti/gta.git
cd gta
npm install
npm run dev
```

It prints a line like `Local: http://localhost:5199/`. Open that.

**What it looks like when it is working:** a few seconds of black while the city builds, then you are sitting in a red car on a real Luxembourg street, in daylight, with people walking past on the pavement. If you get a black screen that stays black for more than about fifteen seconds, something is wrong — see below.

A cold clone installs in under a second and downloads about 17 packages. The city itself is committed, so nothing is fetched while you play.

### If it does not work

**`npm install` fails, or Vite refuses to start.** Almost always an old Node. This needs 20.19+ and Vite will say so. `node -v`, then install a newer one.

**The page is black and stays black.** Open the browser console. The city takes a few seconds to build on a slow machine; if there is an error there, that is the real story. It is a WebGL game, so a browser with hardware acceleration disabled will fail here.

**Port 5199 is already taken.** `npm run dev -- --port 5200`.

**You want to check the game itself is sound** rather than your setup: `npm run smoke`. It loads the page headless and fails on an exception, a game that never boots, or a frame that renders black. It should print `SMOKE PASS`.

## The first thirty seconds

Drive. `W` to go, `A` and `D` to steer. Get up to speed on the boulevard you spawn on.

Then do these, in this order, because they are what the city is for:

**Pull the handbrake into a corner.** `Space`. The tail lets go and you can hold a slide through the junction. The car holds a velocity vector rather than a speed along its nose, and the gap between where it points and where it is actually going is the entire feel of the thing.

**Run a red light.** Wait at a signalised junction until it goes green, then do it again and go through on red. One star appears, top right, and a police car comes looking.

**Knock a bollard over. Then find a tree.** Street furniture breaks: bins, bollards, bus shelters, hydrants, lamp posts. A hydrant goes on the first solid hit. A thick tree takes two or three, and comes down across your bonnet when it goes.

**Get to four stars and try to escape.** Escaping is about distance held, not hiding: inside 45 metres of the nearest car the meter does not fall at all, and sitting still never works. From four stars a clean run is about eleven seconds of real distance.

**Then let them catch you.** Eight seconds within 22 metres of a police car while under 15 km/h and you are BUSTED. The bar across the top drains while they have you, and the last three seconds count down out loud.

**Press `C`.** The camera goes to birdseye — straight down, north up, the real street plan with you on it. Scroll to zoom out to 400 metres. It is the best way to see what you have been driving through.

**Then park at a kerb and watch the pavement for a moment.** People walk, carry bags, stop. Someone crossing walks to the next zebra ahead of them, waits at the kerb if the traffic has a green, and then crosses. Standing still and watching that is the bit that makes it a city rather than a track.

## Controls

| key | |
|---|---|
| `W` / `↑` | accelerate |
| `S` / `↓` | brake, then reverse |
| `A` `D` / `←` `→` | steer |
| `Space` | handbrake — this is how you drift |
| `C` | change camera: chase, then birdseye |
| scroll | zoom, in birdseye |
| `M` | full-screen map — the world pauses and goes silent |
| `R` | respawn on the nearest big street |
| `P` | pause |
| `F3` | position, bearing, clock and frame counter |

The clock runs at one game hour per real minute, so a full day passes every twenty-four. The lamps come on at dusk by themselves.

---

Everything below is for the curious. You do not need any of it to play.

## The city is real

`tools/fetch-city.mjs` asks Overpass for one slice of Luxembourg — Ville-Haute, Kirchberg, and the Pont Rouge over the Pfaffenthal gorge — and writes `public/data/city.json`. That file is committed, and the game never touches the network while you play.

What comes back: **1,667 roads, 6,196 buildings** with real heights, **2,467 trees, 226 street lamps, 285 traffic signals, 739 pedestrian crossings**, 290 greens, 584 staircases and 43 squares, denormalised into flat local metres with +Y pointing north. Split at junctions, those roads become 2,284 drivable edges, 546 of them one-way.

To refetch it: `npm run fetch-city`.

The widths are ours, not OSM's — invented per highway class — and that mismatch is the source of most of the interesting problems in this repository. A 12-metre carriageway painted down a real 7-metre street swallows whatever stood beside it.

## What was wrong with the city, and what was done about it

**Nothing stands in a driving lane.** 1,105 pieces of decor were inside a carriageway: trees the survey put where we later painted tarmac, and — the worst of it — 270 of the 285 traffic signals, because OSM puts a `traffic_signals` node in the *middle* of the junction it governs. Signal masts now stand on the kerb and face back at the junction. Trees that fell in a road are **moved to the pavement rather than deleted**, because the tree is surveyed fact and the width that swallowed it is our invention. 526 of them moved; 12 could not be freed and only those were dropped.

**The passages fit.** A street needs its carriageway plus a pavement on each side, and 6,998 sample points along the city's walls were short of that. Buildings were pushed apart — 1,845 footprints, average 1.70 m — leaving 794 samples still tight, which satellite imagery confirms are genuinely narrow real streets rather than artefacts. Avenue de la Liberté was being drawn twice: OSM carries it as a dual carriageway, one polyline per direction, so a 12-metre ribbon on each half painted the boulevard on top of itself.

**Dead ends are places.** 411 streets simply stop. The 43 with at least 30 metres of clear ground around them are planted with a horseshoe of trees, which is what tells a driver the road is over before the kerb does.

**Parks are laid out like parks.** Walkways enter at the gates, connect what is worth walking between, and leave — traced off aerial imagery, so they cut the corners the real ones cut. Programme follows: playgrounds away from traffic, a dog run away from the playground, a cafe terrace near the busiest entrance. No path dead-ends in grass, and no path crosses a carriageway.

**Nothing is planted where it should not be.** One test decides whether a tree may stand somewhere: not in water or within 2.5 m of its bank, not inside a park's programme, not in a cafe or a fountain or a bus shelter. It rejects 787 of 13,975 candidates.

## Breaking things

Trees, street lamps, bus shelters and fire hydrants are destructible, graded by impact energy rather than by contact — a nudge at parking speed breaks nothing.

| | breaks at |
|---|---|
| fire hydrant | one solid hit |
| street lamp | one solid hit |
| bus shelter | one solid hit, and the glazing goes separately |
| thin tree | survives 6 m/s, falls at 13 |
| thick tree | two or three energetic hits |

A felled tree leaves a stump and lies down along the pavement; a lamp falls and stops lighting the street from where its head used to be. The debris is one pooled instanced mesh, so a city full of wreckage costs the same three draw calls as an empty one.

Everything you can hit is in the collision grid: **59,708 obstacles**, of which 19,682 are street props and the rest is the forest that closes the world.

## The crowd

340 people, and the interesting part is that they are people rather than dolls. Sixteen instanced parts on real proportions — hip at 52% of height, shoulder at 80% — with arms that swing out of phase with the legs, shoulders and hips that counter-rotate, and a heel that strikes before the toe. Height, build, clothing, hair, hat, bag and gait all vary, because a crowd of identical figures reads as dolls however good one figure is.

Hit one and the body is a rigid trunk resolved against the pavement at five contact points: the tumble, the bounce, the slide and the settle all come out of the contact impulses rather than being keyframed. At 20 km/h the body folds down beside the car and stops within three metres. At 90 it goes 2.4 metres into the air, eighteen metres down the road, bounces twice and comes to rest after twenty-one. Eighty people dying at once costs 25% more than the same crowd walking.

People also get out of the way: a car over 7 m/s inside fifteen metres sends them running perpendicular to your line, away from the road rather than directly away from the car, because running straight away just keeps them in front of the bumper.

## The police

Knock someone over and the row of five stars starts filling. They drive the same car you do, with the same physics, so they understeer into walls and scrape the same corners you do.

Escaping is **distance, held**. Within 45 metres of the nearest car the meter does not fall at all. Past that it falls faster the further you get, reaching full rate around 260 metres, and quicker still once nobody can see you.

They can also catch you, and this is what the driving is *for*. Eight seconds within 22 metres **while under 15 km/h** and you are **BUSTED**. All three conditions matter: proximity alone would punish you for being chased, adding time gives you a chance to break away, and the speed gate means a hard chase at speed is tense but survivable while being pinned in traffic is fatal. The rule is *do not let them pin you*, not *do not let them near you*.

How they come for you depends on how badly they want you. At one or two stars a car picks you up behind and tails. At three they aim where you are *going* rather than where you are, and cut corners. At four and five some arrive in front of you, so you are boxed rather than merely chased.

## Traffic and the lights

The 285 traffic signals are real OSM positions snapped to the nearest modelled junction. Each signalised junction sorts its approaches into two opposing groups by bearing and cycles green, amber, all-red, then the other group.

The phase is *computed* from the clock and an offset derived from the junction's own id, never stored and ticked. That makes it deterministic — the same second always gives the same state, reloading desynchronises nothing, there is no accumulated drift, and the whole city does not blink in unison.

Traffic obeys the lights, keeps headway, drives on the right, respects one-way streets, yields at unsignalled junctions to whoever reached the box first, and brakes for you. A car too close to stop safely goes through on amber, as a driver would. It pulls over for a passing police car and holds that for a couple of seconds after the siren has gone, because a car that snaps back into lane the instant the cop is level reads as scripted.

## The edge of the world

The slice has to end somewhere, and an invisible wall is the worst way to say so — the player feels a rule rather than a place. Luxembourg is surrounded by woodland, so the map ends in trees: 33,665 of them on a 3.6-metre grid with jitter. The pitch is what makes it a wall rather than a suggestion — the gap has to be narrower than the car. Sixteen escape attempts at full throttle, one every 22 degrees, get nobody out.

## How it is put together

Raw OSM is not drivable: no widths, no junctions, no notion of what may be driven on. `src/world/model.js` derives all of that once at load, and both halves of the game consume the same numbers — the renderer paves what the simulation collides with, so they cannot disagree.

Junctions are the part worth knowing. OSM joins a side road to a main road at a vertex in the *middle* of the main road's geometry, so welding polyline endpoints alone leaves every T-junction invisible and the network in disconnected stubs. Roads are split wherever two ways share a vertex, taking the largest connected component from 49.0% of nodes to 93.7%.

```
public/data/city.json     raw OSM, committed, never fetched at play time
src/world/model.js        widths, drivability, the welded road graph, the obstacle grid
src/render/scene.js       sky, sun and moon, shader facades, roads, trees, lamps
src/render/clearance.js   how anything gets out of a carriageway
src/render/siting.js      whether a tree may stand somewhere
src/render/parks.js       park layout: gates, walkways, playgrounds, dog runs
src/render/debris.js      what breaking looks like
src/render/car.js         the car, and the instanced fleet traffic drives
src/game/car.js           arcade physics — bicycle model, grip-bounded yaw, drift
src/game/pedestrians.js   the crowd
src/game/ragdoll.js       what happens when you hit one
src/game/police.js        the wanted meter and the cars that enforce it
src/game/traffic.js       ambient cars on the road graph
src/game/audio.js         synthesised engine, tyres and siren
src/main.js               the frame loop, the clock, the chase camera
```

`INTERFACES.md` is the contract between the rendering half and the simulation half, and is the thing to read before changing either.

Sound is synthesised rather than sampled — there is not an audio file in the repository. The engine has a five-speed note that falls back as each gear catches, the tyres only scrub when the car is genuinely sliding, impacts are noise bursts pitched by how hard you hit, and the siren's volume tracks the *nearest* cop, so it reaches you before they do.

## Notes on the driving

Yaw is bounded by the grip available, which matters more than it sounds. Left unbounded, full lock at 100 km/h asks for about 70 m/s² of cornering force, the car pirouettes, and it scrubs from 104 km/h to 4 in a single corner — and the handbrake changes nothing, because the tyres were already past their limit either way.

Top speed is about 99 km/h. It corners on the limit at 0.61 rad/s and comes out of a hard turn still doing 88.

## Tools

```bash
npm run smoke            # load the page headless; fails on an exception or a black frame
npm run smoke -- --prod  # build, preview, and check the built bundle
npm run build            # production build into dist/
```

`tools/birdseye.mjs` photographs the running city from above, because a complaint about a world is almost always a complaint about its layout and you cannot see a layout from inside a car. `tools/portrait.mjs` frames a single vehicle. `tools/probe.mjs` asks the running game a question and prints the answer. `tools/clip.mjs` records a GIF or an MP4 with the game's own sound.

Built by a team of cooperating Claude Code sessions, one file each, with every change verified by a picture or a number rather than an assertion.
