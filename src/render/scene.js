// The world, rendered. Consumes the derived model (INTERFACES.md §3) and returns the scene
// handshake (§5, as amended in the telegraph): {scene, camera, renderer, update(dt, gameHours),
// follow(target), makeCar(tint)}. Pedestrians are wholly the simulation's (one InstancedMesh).
//
// The whole city draws in under twenty calls on purpose — buildings are ONE merged geometry with
// procedural facades in the shader, roads one, trees one instanced mesh, lamps a pole instance
// plus one Points for the glows. "Extraordinary" here is art direction, not asset weight: the
// night frame with six thousand individually lit windows is the shot, and it costs one material.
import * as THREE from 'three';
import {ROAD_KINDS, PROP_KINDS} from '../world/model.js';
import {makeCar, makeCarFleet} from './car.js';
import {buildDecorations, buildSignals, buildCathedral} from './decor.js';
import {propSpot, shoveClear, inFootprint, PROP_CLEAR} from './clearance.js';
import {createSiting} from './siting.js';
import {makeBollards, makeBins, makeBenches, makeShelters, makeBikeRacks, makeSignPosts, makePlanters, makeHydrants} from './streetprops.js';
import {createDestruction} from './debris.js';
import {buildTownhouseRow} from './townhouse.js';
import {buildFindel} from './airport.js';
import {buildParks} from './parks.js';
import {setHeightfield, groundHeight, minGroundUnder, seatGroundUnder, hasTerrain} from '../world/terrain.js';
import {makeDog, makePigeonFleet} from './critters.js';
import {buildEasterEggs} from './eastereggs.js';
import {EffectComposer} from 'three/examples/jsm/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/examples/jsm/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/examples/jsm/postprocessing/OutputPass.js';
export {makeCar, makeCarFleet};
// Re-export the terrain seam so the physics half (main.js / game/*) can import ground height from
// one place without reaching into world/terrain.js directly.
export {groundHeight, groundNormal, hasTerrain} from '../world/terrain.js';

// Load the baked heightfield at MODULE scope, before createScene runs. main.js awaits city.json at
// top level and imports this module first, so an ES top-level await here resolves before the scene
// is built — meaning the ground, roads and buildings can all be seated on real terrain from frame 1.
// If the file is missing the game simply stays flat (groundHeight returns 0).
try {
  const hf = await fetch('/data/heightfield.json').then(r => r.ok ? r.json() : null);
  if (hf) setHeightfield(hf);
} catch { /* flat world */ }

// ---------------------------------------------------------------------------
// Palette — one place, so dawn/dusk ramps stay coherent instead of per-feature.
const SKY = {
  night: {top: 0x0b1026, bottom: 0x1a2342, sun: 0xbfd4ff, ambient: 0x27304d, fog: 0x121a33},
  dawn:  {top: 0x2a3c6e, bottom: 0xd98a5a, sun: 0xffc9a3, ambient: 0x6a6a8a, fog: 0x8a7a8a},
  day:   {top: 0x77aee8, bottom: 0xcfe6f5, sun: 0xfff4d6, ambient: 0x9fb4cf, fog: 0xcfdcea},
  dusk:  {top: 0x352a63, bottom: 0xd4581f, sun: 0xff8f4d, ambient: 0x6d5570, fog: 0x8a5f52},
};
const LERP = (a, b, t) => a + (b - a) * t;
const mixColor = (out, a, b, t) => out.setRGB(
  LERP(((a >> 16) & 255) / 255, ((b >> 16) & 255) / 255, t),
  LERP(((a >> 8) & 255) / 255, ((b >> 8) & 255) / 255, t),
  LERP((a & 255) / 255, (b & 255) / 255, t),
);

// Piecewise day phases: hour -> [phaseA, phaseB, t]. Blue hour lives at 5-7 and 18-20.
function skyPhase(h) {
  if (h < 5) return ['night', 'night', 0];
  if (h < 7) return ['night', 'dawn', (h - 5) / 2];
  if (h < 9) return ['dawn', 'day', (h - 7) / 2];
  if (h < 17) return ['day', 'day', 0];
  if (h < 19) return ['day', 'dusk', (h - 17) / 2];
  if (h < 21) return ['dusk', 'night', (h - 19) / 2];
  return ['night', 'night', 0];
}

// ---------------------------------------------------------------------------
export function createScene(world) {
  // Draw distance is a knob: the merged city meshes cannot be per-triangle culled, so the lever
  // that actually moves fill+vertex cost is how far we draw at all. Fog hides the cut edge, the
  // far plane refuses to draw past it — the cull the merged geometry cannot do for itself.
  const DRAW = 1100;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x77aee8);
  // Exponential fog reads more atmospheric than linear and hides the low-poly horizon; density
  // is nudged up at night and further in rain from update(). Sky-bottom colour so they meet.
  scene.fog = new THREE.FogExp2(0x121a33, 0.0016);

  const camera = new THREE.PerspectiveCamera(62, 1, 0.5, DRAW + 400);
  camera.position.set(0, 60, 80);

  const renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
  // Cap below devicePixelRatio (2 on this MacBook): ~2.3x fewer shaded pixels, invisible at 16".
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  // --- sky dome: gradient in a shader, driven per frame by uniforms -------------------------
  const skyUniforms = {
    topColor: {value: new THREE.Color(SKY.night.top)},
    bottomColor: {value: new THREE.Color(SKY.night.bottom)},
    sunDir: {value: new THREE.Vector3(0, 1, 0)},
    sunColor: {value: new THREE.Color(SKY.night.sun)},
    // Angular size of the sun, as (1 - cos r). 0.02 put the disc at an 11.5° RADIUS — 23° across,
    // forty times the real sun — which read as a white dome parked on the horizon rather than as a
    // sun at all. 0.0008 is about 4.6° across: still generous so it survives the bloom pass, but
    // unmistakably a sun.
    sunSize: {value: 0.0008},
    uTime: {value: 0},
    cloudTint: {value: new THREE.Color(0xffffff)},
    cloudAmount: {value: 0.5},
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(DRAW + 300, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: skyUniforms,
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 topColor, bottomColor, sunColor, sunDir, cloudTint;
        uniform float sunSize, uTime, cloudAmount; varying vec3 vPos;
        float chash(vec2 p){ p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(chash(i), chash(i + vec2(1,0)), f.x), mix(chash(i + vec2(0,1)), chash(i + vec2(1,1)), f.x), f.y);
        }
        float fbm(vec2 p){ return 0.6 * vnoise(p) + 0.3 * vnoise(p * 2.13 + 7.7) + 0.12 * vnoise(p * 4.7 + 19.1); }
        void main(){
          vec3 d = normalize(vPos);
          float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 col = mix(bottomColor, topColor, pow(h, 0.8));
          // cloud layer: sample fbm on the dome projected to a plane, drift with time
          if (d.y > 0.02) {
            vec2 cp = d.xz / (d.y + 0.22);
            float cl = fbm(cp * 1.6 + vec2(uTime * 0.011, uTime * 0.004));
            float cover = smoothstep(0.52, 0.78, cl) * cloudAmount;
            float horizonFade = smoothstep(0.02, 0.18, d.y);
            col = mix(col, cloudTint, cover * horizonFade * 0.85);
          }
          float s = max(dot(d, normalize(sunDir)), 0.0);
          col += sunColor * smoothstep(1.0 - sunSize, 1.0 - sunSize * 0.35, s);       // disc
          // Two-part glow. pow(s, 6.0) alone was still a quarter-bright forty-odd degrees away, so
          // the "halo" whitewashed a third of the sky into the dome. A tight corona does the work
          // of reading as glare; a very faint wide term keeps the air near the sun warm.
          col += sunColor * 0.55 * pow(s, 280.0);                                     // corona
          col += sunColor * 0.06 * pow(s, 8.0);                                       // sky scatter
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
  );
  scene.add(sky);

  // --- lights ------------------------------------------------------------------------------
  const ambient = new THREE.AmbientLight(0x27304d, 0.9);
  const hemi = new THREE.HemisphereLight(0x3a4a7a, 0x14161d, 0.5);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 900;
  const D = 220; // tight frustum, re-anchored by follow()
  Object.assign(sun.shadow.camera, {left: -D, right: D, top: D, bottom: -D});
  sun.shadow.bias = -0.0004;
  scene.add(ambient, sun, sun.target);

  // --- ground: a heightfield mesh following the terrain, not a flat plane -------------------
  // A subdivided plane whose every vertex is lifted to groundHeight(x,z). When no terrain is loaded
  // groundHeight returns 0 and this is exactly the old flat plane. Segment count is coarse (the
  // baked DEM is ~34x40) so this adds almost nothing.
  const b = world.bounds;
  const gw = b.maxX - b.minX + 800, gd = b.maxY - b.minY + 800;
  const gcx = (b.minX + b.maxX) / 2, gcy = (b.minY + b.maxY) / 2;
  const groundGeo = new THREE.PlaneGeometry(gw, gd, 80, 80);
  {
    const p = groundGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      // plane is in its own XY (pre-rotation): local x -> world x, local y -> world +mapY.
      const lx = p.getX(i), ly = p.getY(i);
      const wx = gcx + lx, wz = -(gcy + ly);       // world x,z
      p.setZ(i, groundHeight(wx, wz));             // Z here becomes world Y after the -90° X rotation
    }
    groundGeo.computeVertexNormals();
  }
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({color: 0x49505b}));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(gcx, -0.05, -gcy);
  ground.receiveShadow = true;
  scene.add(ground);

  // World axes: model is XY with +Y north; Three ground is XZ. Mapping used EVERYWHERE:
  // three.x = model.x, three.z = -model.y, so north points into -Z and the map reads like a map.
  const toV3 = (p, y = 0) => new THREE.Vector3(p[0], y, -p[1]);

  // --- roads: one geometry of triangulated ribbons -----------------------------------------
  // --- parcels: the land, under everything. Built FIRST so the tarmac paints over it.
  const parcels = buildParcels(world);
  scene.add(parcels.group);
  scene.userData.parcels = parcels;
  // --- roads: one geometry of triangulated ribbons -----------------------------------------
  const roads = buildRoads(world);
  scene.add(roads);
  // --- sidewalks: raised kerb + pavement strip on both sides of every drivable road. Purely
  // visual (Padawan's car collides only with footprints + point obstacles, never the ground, so a
  // 0.15m lip is invisible to physics). His pedestrians already stand at half-width+1.4 — dead
  // centre of this strip — so they land on it with no re-routing. -----------------------------
  const sidewalks = buildSidewalks(world);
  sidewalks.name = 'sidewalks';
  scene.add(sidewalks);
  // --- road markings: centre dashes + zebra crossings, one mesh floating on the tarmac ------
  const markings = buildMarkings(world);
  markings.name = 'markings';
  scene.add(markings);
  // --- the Pont Rouge: the one landmark that gets its own structure ------------------------
  scene.add(buildPontRouge(world));
  // --- city dressing + signal heads --------------------------------------------------------
  const decor = buildDecorations(world);
  scene.add(decor.group);
  const neon = decor.group.userData.neon;
  // --- fountain jets: one Points cloud over all real fountains, arcing water stepped in update()
  const fountainJets = buildFountainJets(world.fountains ?? []);
  if (fountainJets) scene.add(fountainJets.points);
  const signals = buildSignals(world);
  scene.add(signals.group);
  scene.add(buildCathedral(world));
  // --- buildings: ONE merged geometry, procedural facade shader ----------------------------
  const buildings = buildBuildings(world);
  scene.add(buildings.mesh);
  // --- green + water, flat tinted fills ----------------------------------------------------
  scene.add(buildPolys(world.green, 0x2e4a33, 0.02));
  // The fetch collects `waterway=river` alongside real water AREAS, but a river is a LINE, not a
  // polygon — filling its 36km self-crossing ring painted a 13km² sheet of dark navy straight across
  // the city centre and over Place Guillaume. Until rivers are drawn as ribbons with a real width,
  // keep only sane water BODIES: every genuine pond in this slice is under ~1000m², while the two
  // river lines are 215,000m² and 13,400,000m², so the threshold is not a close call.
  const waterBodies = (world.water ?? []).filter(pts => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, a = 0;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    for (let i = 0; i < pts.length - 1; i++) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
    return (maxX - minX) < 1500 && (maxY - minY) < 1500 && Math.abs(a / 2) < 50000;
  });
  scene.add(buildPolys(waterBodies, 0x1d3247, 0.01));
  // --- dress big bare plazas: real squares of open asphalt look unnaturally empty. Scatter grass
  // patches + planters in each big square's outer ring, skipping anything near a building or off the
  // road grid, so the middle stays drivable but the emptiness is broken up. -----------------------
  const dressing = buildOpenSpaceDressing(world);
  dressing.name = 'openSpaceDressing';
  scene.add(dressing);
  // --- easter eggs: Spider-Man swinging overhead, Hulk in a park, dinosaurs by the treeline,
  // stormtroopers at the airport. Animated from the scene's own update() so main.js is untouched. --
  let eggs = null;
  try { eggs = buildEasterEggs(world); scene.add(eggs.group); world.eggs = eggs; } catch { /* eggs are optional */ }
  // --- trees: instanced broadleaf, real crowns + bark; the 2,467 mapped city trees ----------
  // Clear any tree that would grow ON TOP of a landmark — a broadleaf crown planted at the
  // cathedral or the Gëlle Fra hides the very thing it stands next to. These are the two anchored
  // monument positions (true projected coords); keep everything else exactly as surveyed.
  const LANDMARKS = [[136, -247, 32], [0, -322, 24]];   // [x, y, clear-radius]
  // Drop any OSM tree that stands ON a carriageway — ~15% of them fall within a road's width from
  // mapping imprecision, and a tree growing out of the road you're driving on is the worst artifact.
  // Test against the drivable edges' half-width (+0.5m margin) using the world's broad phase.
  const onRoad = (tx, ty) => {
    for (const e of world.edges) {
      if (!e.width) continue;
      const hw = e.width / 2 + 0.5;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const [ax, ay] = e.pts[i], [bx, by] = e.pts[i + 1];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
        let t = ((tx - ax) * dx + (ty - ay) * dy) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + t * dx, cy = ay + t * dy;
        if ((tx - cx) ** 2 + (ty - cy) ** 2 < hw * hw) return true;
      }
    }
    return false;
  };
  // --- the two passes that have to run BEFORE the trees -------------------------------------
  // Trees are the last layer to be scattered and the only one that scatters blind: the street-tree
  // rhythm comes off road centrelines and the park fill comes off a 12 m grid inside a green
  // polygon, so neither knows what is already standing there. It planted trees in the amphitheatre
  // rings, along the pond bank and inside bus shelters. `siting` is the one test that answers "is
  // this square metre taken", and it can only answer it if the things that take it exist first —
  // hence the furniture and the parks are built here and merely ADDED to the scene further down.
  const furniture = buildStreetFurniture(world);
  const parksGroup = buildParks(world.green ?? [], world.onRoad);
  const siting = createSiting(world, {
    keepClear: parksGroup.userData.keepClear ?? [],
    furniture: furniture.props,
  });

  // A mapped tree in a lane gets MOVED to the nearest kerb, not deleted: the tree is surveyed and
  // the width that swallowed it is ours. Only the handful that cannot be freed at all are dropped.
  const treeStats = {kept: 0, moved: 0, dropped: 0, landmark: 0, inWater: 0};
  const cityTrees = [];
  for (const [tx, ty] of world.trees) {
    if (LANDMARKS.some(([lx, ly, r]) => (tx - lx) ** 2 + (ty - ly) ** 2 < r * r)) { treeStats.landmark++; continue; }
    // Only the WATER test applies to a surveyed tree. The rest of the exclusion list is our own
    // dressing, and a mapped tree standing where we invented a bus shelter is the shelter's fault:
    // deleting the real thing to protect the invented one would be the wrong way round. A tree in
    // the middle of the Alzette is wrong however it got into the data.
    if (siting.inWater(tx, ty)) { treeStats.inWater++; continue; }
    if (!onRoad(tx, ty)) { treeStats.kept++; cityTrees.push([tx, ty]); continue; }
    const spot = shoveClear(world, tx, ty);
    if (spot && !siting.inWater(spot[0], spot[1])) { treeStats.moved++; cityTrees.push(spot); }
    else treeStats.dropped++;
  }
  console.info(`mapped trees: ${treeStats.kept} clear, ${treeStats.moved} moved off a carriageway, ` +
               `${treeStats.dropped} unfreeable, ${treeStats.landmark} cleared from landmarks, ` +
               `${treeStats.inWater} standing in water`);
  window.__props = Object.assign(window.__props ?? {}, {trees: treeStats});
  // The 2,467 mapped trees are sparse (~366/km²); a leafy city reads far denser. Augment with street
  // trees along frontages and fill trees inside parks — never on a carriageway, a building, in the
  // river or on top of something that is already there.
  const treeSet = cityTrees.concat(augmentTrees(world, onRoad, siting), deadEndHorseshoes(world, siting));
  console.info(`tree siting: ${siting.counts.water} rejected in water or on a bank, ` +
               `${siting.counts.park} in a park's own keep-clear discs, ${siting.counts.decor} on a ` +
               `cafe/fountain/monument/postbox, ${siting.counts.furniture} on street furniture ` +
               `(${siting.discCount} discs, ${siting.counts.waterBodies} water bodies and ` +
               `${siting.counts.waterLines} river lines)`);
  window.__props = Object.assign(window.__props ?? {}, {siting: {...siting.counts}});
  const trees = buildTrees(treeSet);
  scene.add(trees.group);
  // --- the green wall that closes the world: a continuous tall hedge-wall ringing the city
  // bounds. Cheaper and cleaner than a forest of instances, and it says "edge of the map" as a
  // place rather than a rule. Padawan's world.forest remains the collision wall; this is the face
  // the player sees. ---------------------------------------------------------------------------
  scene.add(buildGreenWall(world.bounds));
  // --- parks: flowerbeds, path networks, allées, topiary, planters, benches inside the big park
  // polygons — the lush interior layer over the plain grass. Built above, with the furniture. -----
  scene.add(parksGroup);
  // --- Findel airport: real runway, terminal, tower, hangars, open gate, parked airliner, anchored
  // east of the city. findel.json isn't threaded through the world model, so fetch it here and add
  // the group when it resolves — the scene is already live, adding a group later is fine. ---------
  // main.js already loaded the airport (the world bounds depend on it), so build it straight from
  // the world instead of racing a second fetch — it is then present from the very first frame.
  Promise.resolve(world.findel ?? fetch('/data/findel.json').then(r => r.json())).then(findel => {
    if (!findel) return;
    const airport = buildFindel(findel);
    // Seat the whole airport at ONE terrain height (its anchor) — a runway/apron must stay FLAT, not
    // drape the hills, so we lift the entire group rather than each surface.
    const anchor = findel.anchor || [1550, 300];
    airport.position.y = groundHeight(anchor[0], -anchor[1]);
    scene.add(airport);
    scene.userData.airport = airport;   // gate/airplane positions live on airport.userData for later road wiring
  }).catch(() => { /* no airport data -> city runs without it */ });
  // --- townhouses: fill EMPTY residential frontages with terraces of varied 3-6 storey houses.
  // Purely additive — a house is only placed where its footprint hits no existing OSM building, so
  // the real city keeps its real buildings and only the bare stretches get dressed. --------------
  scene.add(buildTownhouseFrontages(world));
  // --- street furniture: bollards, bins, benches, shelters, bike racks, signs, planters, hydrants,
  // laid along pavement edges of the busier streets so the city is dressed, not bare. Placed above,
  // before the trees, because the tree siting test has to know where it all ended up. ------------
  furniture.meshes.forEach(m => scene.add(m));
  // --- lamps: instanced poles + one Points cloud of glows, plus N REAL lights near the car --
  const lamps = buildLamps(augmentLamps(world));
  scene.add(lamps.poles, lamps.glows, lamps.pools);
  const carLights = [0, 1, 2].map(() => {
    const l = new THREE.PointLight(0xffb46b, 0, 42, 1.6);
    scene.add(l); return l;
  });

  // --- hand the drawn world back to the physics ---------------------------------------------
  // Placement is decided HERE, so this is where the collision has to come from. The model deliberately
  // no longer derives tree and lamp obstacles from the raw OSM points (see the note over
  // `inCarriageway` in src/world/model.js): it filtered out every point that fell in one of our
  // invented carriageways, while this file moves those same points to the kerb and draws them there —
  // 540 trees and 51 lamps of them, all of them visible and all of them drive-through. And the ~10,000
  // augmented trees, ~4,900 synthetic lamps and 1,328 pieces of furniture below were never in any
  // collision structure at all. One registration of the FINAL positions fixes both, the same way
  // `registerBuildings` already hands back the synthetic townhouses.
  if (world.registerProps) {
    const registered = world.registerProps([...trees.props, ...lamps.props, ...furniture.props]);
    console.info(`obstacles: ${trees.props.length} trees + ${lamps.props.length} lamps + ` +
                 `${furniture.props.length} furniture registered as collidable; ${registered} point ` +
                 `obstacles in the world (the rest is the boundary forest)`);
    window.__props = Object.assign(window.__props ?? {}, {obstacles: {
      trees: trees.props.length, lamps: lamps.props.length, furniture: furniture.props.length,
      total: registered,
    }});
  }

  // --- destruction: what a broken prop looks like. The physics marks props broken in the point
  // grid and queues the events; this drains the queue each frame and topples the instance. -------
  const destruction = createDestruction(groundHeight);
  scene.add(destruction.group);
  // Reachable from window.game.scene, so a probe can count what has been flattened without a
  // screenshot — the same reason parcels and the airport hang here.
  scene.userData.destruction = destruction;
  exposeDestruction(world, destruction);

  // --- bloom: the night glow. Threshold keeps daylight clean; strength rides the clock ----
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.0, 0.45, 0.72);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // --- rain: daily 16:00-17:00, ~20 sim-minutes of ramp at each edge ------------------------
  const RAIN_N = 1400;
  const rainPos = new Float32Array(RAIN_N * 3);
  for (let i = 0; i < RAIN_N; i++) {
    rainPos[i * 3] = (Math.random() - 0.5) * 90;
    rainPos[i * 3 + 1] = Math.random() * 40;
    rainPos[i * 3 + 2] = (Math.random() - 0.5) * 90;
  }
  const rainG = new THREE.BufferGeometry();
  rainG.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {uOpacity: {value: 0}},
    vertexShader: `void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = clamp(160.0 / -mv.z, 1.0, 3.0);
      gl_Position = projectionMatrix * mv;
    }`,
    fragmentShader: `uniform float uOpacity;
      void main(){
        vec2 q = gl_PointCoord - 0.5;
        float a = (1.0 - smoothstep(0.05, 0.5, abs(q.x))) * (1.0 - abs(q.y) * 1.6);
        gl_FragColor = vec4(0.62, 0.70, 0.82, max(a, 0.0) * uOpacity);
      }`,
  });
  const rain = new THREE.Points(rainG, rainMat);
  rain.frustumCulled = false;
  scene.add(rain);
  const rainFactor = (h) => {
    const up = THREE.MathUtils.smoothstep(h, 15.7, 16.05);
    const down = 1 - THREE.MathUtils.smoothstep(h, 16.95, 17.3);
    return Math.min(up, down);
  };

  // ----------------------------------------------------------------------------------------
  let followTarget = null;
  const follow = (obj) => { followTarget = obj; };

  const _c = new THREE.Color();
  let skyTime = 0;
  function update(dt, gameHours) {
    skyTime += dt;
    skyUniforms.uTime.value = skyTime;
    if (fountainJets) fountainJets.step(dt);   // arc the fountain droplets
    if (eggs) eggs.update(dt, gameHours);      // animate Spidey/Hulk/dinos/troopers
    // Anything the car knocked down since the last frame. The physics only records THAT a prop broke
    // and which way the blow went; turning that into a falling lamp post is this half's business, and
    // the split is what keeps src/game/car.js free of Three.js.
    const broken = world.obstacles?.takeEvents?.();
    if (broken) {
      for (const ev of broken) {
        // Map coordinates to Three: the blow direction's north component flips sign, as everywhere.
        const dirX = ev.dirX, dirZ = -ev.dirY;
        if (!ev.felled) { destruction.scarred(ev.item.ref, ev.item.kind, dirX, dirZ, ev.energy); continue; }
        destruction.felled(ev.item.ref, ev.item.kind, dirX, dirZ, ev.energy);
        // A downed lamp also comes off the roster of columns that may carry one of the three real
        // PointLights — see `downed` in buildLamps.
        if (ev.item.kind === 'lamp') lamps.downed.add(ev.item.ref.i);
      }
    }
    destruction.update(dt);
    const [pa, pb, t] = skyPhase(gameHours);
    const A = SKY[pa], B = SKY[pb];
    mixColor(skyUniforms.topColor.value, A.top, B.top, t);
    mixColor(skyUniforms.bottomColor.value, A.bottom, B.bottom, t);
    mixColor(skyUniforms.sunColor.value, A.sun, B.sun, t);
    mixColor(scene.fog.color, A.fog, B.fog, t);
    scene.background.copy(skyUniforms.bottomColor.value);
    mixColor(ambient.color, A.ambient, B.ambient, t);
    // clouds: bright by day, barely-there slate at night — and they CATCH FIRE whenever the
    // sun sits low, which is what makes 18:00 a late-autumn sunset rather than a dimmer switch.
    mixColor(skyUniforms.cloudTint.value, A.bottom, 0xffffff, 0.55);
    skyUniforms.cloudTint.value.lerp(_c.set(0xfff1df), 0.2);

    // Sun rides a great arc: noon overhead, midnight under the world (moonlight stand-in).
    const ang = ((gameHours - 6) / 24) * Math.PI * 2; // sunrise ~6 at the horizon
    const sunDir = new THREE.Vector3(Math.cos(ang), Math.sin(ang), 0.35).normalize();
    skyUniforms.sunDir.value.copy(sunDir);
    const dayness = THREE.MathUtils.smoothstep(sunDir.y, -0.02, 0.35);
    // low-sun glow: peaks when the sun skims the horizon, zero when high or deep under
    const lowSun = Math.pow(Math.max(0, 1 - Math.abs(sunDir.y) * 3.5), 2) * (sunDir.y > -0.15 ? 1 : 0);
    skyUniforms.cloudTint.value.lerp(skyUniforms.sunColor.value, lowSun * 0.75);
    skyUniforms.bottomColor.value.lerp(skyUniforms.sunColor.value, lowSun * 0.35);
    sun.intensity = 0.15 + dayness * 1.75;
    sun.color.set(dayness > 0.4 ? 0xfff2dd : 0xaac4ff); // warm sun, cool moon
    // Night keeps a real light floor: a lived-in city is never pitch black — street lamps, spill
    // from windows and shopfronts, and the general urban skyglow bounce enough that surfaces read.
    // The floor is warmed toward sodium as night deepens so the darkness looks INHABITED, not dead.
    const night = 1 - dayness;
    ambient.intensity = 0.85 + dayness * 0.35;
    ambient.color.lerp(_c.set(0x3a3550), night * 0.5);          // warm-violet urban night, not navy void

    // Night switches the facade windows on and the lamp glows up.
    // Published so the simulation can light things the renderer does not own — the police cars'
    // headlights, for one, which only the police module knows how to find.
    scene.userData.night = night;
    buildings.uniforms.uNight.value = night;
    lamps.glows.material.uniforms.uOpacity.value = night * 0.95;
    hemi.intensity = 0.45 + night * 0.55;
    // set (not lerp) from a base each frame so the warm-night tint never accumulates
    hemi.color.set(0x3a4a7a).lerp(_c.set(0x4a4666), night * 0.5); // sky term warms toward city skyglow
    // Surfaces join the cycle: honest mid-grey asphalt in sunshine (~0.3 albedo), dark and
    // pool-lit at night. A black road at midday was the last thing floating the city on void.
    mixColor(roads.material.color, 0x3c3f45, 0x6d6f73, dayness);
    mixColor(ground.material.color, 0x44474d, 0x787a7e, dayness);

    // Rain hour: gloomy and blueish, deliberately UNDERSTATED — the brief said natural. The
    // sun cools and softens rather than dying, clouds close over, fog breathes in, the road
    // goes wet-dark. Everything keys off the same factor so it arrives like weather, not a
    // light switch.
    const rainF = rainFactor(gameHours);
    if (rainF > 0) {
      sun.intensity *= 1 - rainF * 0.55;
      sun.color.lerp(_c.set(0x9fb2c8), rainF * 0.6);
      ambient.color.lerp(_c.set(0x6e7c92), rainF * 0.45);
      skyUniforms.cloudAmount.value = 0.5 + rainF * 0.45;
      skyUniforms.cloudTint.value.lerp(_c.set(0x8e99a8), rainF * 0.7);
      // the sky itself greys over — a blue horizon under a rain deck read as a hole in the weather
      skyUniforms.topColor.value.lerp(_c.set(0x5a6474), rainF * 0.5);
      skyUniforms.bottomColor.value.lerp(_c.set(0x8b939e), rainF * 0.5);
      scene.fog.color.lerp(_c.set(0x77828f), rainF * 0.5);
      roads.material.color.lerp(_c.set(0x22262e), rainF * 0.55);
      ground.material.color.lerp(_c.set(0x3a4149), rainF * 0.5);
    } else {
      skyUniforms.cloudAmount.value = 0.5;
    }
    rainMat.uniforms.uOpacity.value = rainF * 0.75;
    roads.material.userData.wet.value = Math.min(1, night * 0.4 + rainF);
    // fog breathes: thin by day, denser at night, thickest in the rain
    scene.fog.density = 0.0013 + night * 0.0007 + rainF * 0.0016;
    if (rainF > 0) {
      const rp = rainG.attributes.position;
      const cx = followTarget ? followTarget.position.x : 0;
      const cz = followTarget ? followTarget.position.z : 0;
      for (let i = 0; i < RAIN_N; i++) {
        let y = rp.array[i * 3 + 1] - dt * 34;
        if (y < 0) {
          y = 30 + Math.random() * 10;
          rp.array[i * 3] = cx + (Math.random() - 0.5) * 90;
          rp.array[i * 3 + 2] = cz + (Math.random() - 0.5) * 90;
        }
        rp.array[i * 3 + 1] = y;
      }
      rp.needsUpdate = true;
    }
    lamps.pools.material.uniforms.uNight.value = night;
    bloom.strength = night * 0.85;
    if (neon) { neon.signs.material.opacity = 0.25 + night * 0.75; neon.glows.material.opacity = night * 0.4; } // day: zero, dusk ramps in, full halo at night
    renderer.toneMappingExposure = 1.05 + night * 0.25;

    if (followTarget) {
      const p = followTarget.position;
      // The followed car's headlights are the renderer's to switch: night falls, they come on.
      // The simulation never needs to know the lamp exists.
      const hl = followTarget.userData.headlight;
      if (hl) hl.intensity = night * 55; // candela — physical falloff eats small numbers
      const tg = followTarget.userData.tailGlow;
      if (tg) tg.intensity = 2.2 + night * 3.5; // brake/'on' glow pooling on the road behind
      sun.position.set(p.x + sunDir.x * 400, Math.max(sunDir.y, 0.06) * 400, p.z + sunDir.z * 400);
      sun.target.position.copy(p);
      // The 3 nearest real lamp lights follow the car; everything else is emissive fake.
      lamps.nearest(p, 3).forEach((lp, i) => {
        carLights[i].position.set(lp[0], 7.5, -lp[1]);
        carLights[i].intensity = night * 40;
      });
    }
  }

  function resize(w, h) {
    camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
    composer.setSize(w, h);
  }

  // The frame loop should call THIS rather than renderer.render — it is the same draw plus
  // the bloom chain. renderer stays exported so a fallback loop still shows a picture.
  function render() { composer.render(); }

  // What the editor's pointer is allowed to touch. Everything the city BAKES — ground, roads,
  // pavements, the building shells, the terraces, the trees — is one merged mesh per tile holding
  // thousands of unrelated things, so "the object under the cursor" is not a thing that exists
  // there. The dressing is different: lamps, signals, benches, bins, the easter eggs are each their
  // own instance and can be picked, moved and deleted one at a time. Marking the baked side is the
  // shorter list to maintain, and anything added to the scene LATER (cars, people, police) is
  // pickable by default, which is the behaviour you want.
  {
    const pickable = new Set([decor.group, signals.group, lamps.poles, parcels.group, ...furniture.meshes]);
    if (eggs) pickable.add(eggs.group);
    for (const o of scene.children) if (!pickable.has(o)) o.userData.baked = true;
  }

  // --- the delivery beacon. A column of light standing on the point the player is driving to.
  //
  // It is tall and thin and unlit rather than pretty, and the height is the whole specification:
  // it has to clear the buildings from a street away, because a player who has never seen this
  // game has no other way of knowing where to go. The street name tells somebody who knows
  // Luxembourg; the beacon tells everybody else.
  // depthTest OFF, and this is the whole point of it rather than a rendering preference. A beacon
  // that is occluded by the city is a beacon you can only see once you no longer need it: tested
  // by standing 70m from a drop with a building between, where it disappeared completely. It draws
  // through geometry like a waypoint, because a player who has never seen this game has nothing
  // else telling them where to go.
  const beaconMat = new THREE.MeshBasicMaterial({
    color: 0xffc21f, transparent: true, opacity: 0.38, depthWrite: false, depthTest: false,
  });
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 90, 10, 1, true), beaconMat);
  beacon.renderOrder = 999;          // after the city, so 'no depth test' means 'over it'
  beacon.name = 'deliveryBeacon';   // named so a test can find THIS cylinder, not any of the hundreds in the city
  beacon.frustumCulled = false;
  beacon.visible = false;
  scene.add(beacon);

  /** Map coordinates, or null to hide it. The coordinate law: three.z is -map.y. */
  function setBeacon(p) {
    beacon.visible = !!p;
    if (p) beacon.position.set(p.x, 45, -p.y);
  }

  return {scene, camera, renderer, render, update, follow, resize, makeCar, makeDog, makePigeonFleet, toV3, setBeacon, setSignalPhase: signals.setPhase};
}

// =============================================================================
// Canvas-baked tiles — richer than a flat colour, zero download, generated once at startup.
function asphaltTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#3a3d43'; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const g = 40 + Math.random() * 70;
    x.fillStyle = `rgba(${g},${g},${g+4},${0.05 + Math.random() * 0.12})`;
    x.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
  }
  // faint patch seams
  x.strokeStyle = 'rgba(20,20,24,0.35)'; x.lineWidth = 2;
  for (let i = 0; i < 5; i++) { x.beginPath(); x.moveTo(Math.random()*256,0); x.lineTo(Math.random()*256,256); x.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// PAVEMENTS. A pavement is a property of its road, not a thing in its own right, and every rule
// below follows from that one sentence: it exists only where a road exists, it takes the road's
// spine, it takes the road's round joints, and its width is a fraction of the road's width. A
// boulevard gets a broad footway and a back lane a narrow one, which is the proportion that makes a
// street read as a street instead of as scattered strips.
//
// Two edges, deliberately unalike. The CARRIAGEWAY edge is pronounced — a vertical kerb face, the
// hard line a driver and a walker both navigate by. The far edge is not: it simply ends, and is
// free to run under a building, because in the real city that is exactly what a pavement does.
//
// The theory of laying pavements UNDERNEATH the tarmac and letting the road paint over them is
// right about the intent and wrong about the mechanism: draw order cannot hide a slab that stands
// 15cm proud, and from inside a car it is the height, not the depth sorting, that betrays it. So
// the tarmac wins by GEOMETRY instead. The ribbon is clipped every few metres against the road
// network, so it stops dead at each junction mouth; and the corner that clipping opens up is then
// paved by a ring around the junction node, interrupted by each road arriving at it. That ring is
// the piece that was missing — without it every corner in the city had a notch bitten out of it,
// and a kerb line that disappears at each corner is precisely what "sporadic" looks like.
const SIDEWALK_H = 0.15;      // kerb height
const SIDEWALK_STEP = 2.5;    // metres; the resolution at which the ribbon is clipped to the tarmac
const SIDEWALK_MIN_RUN = 5;   // metres; shorter surviving runs are debris, not pavements

/** A pavement's width, derived from its road's. The whole proportion rule, in one line. */
function walkWidth(roadWidth) { return Math.max(1.2, Math.min(3.6, roadWidth * 0.30)); }
/** Does this road carry a pavement at all? Pedestrian zones are paved edge to edge already. */
function hasWalk(e) { return !e.pedestrianZone && e.width >= 3; }

function buildSidewalks(world) {
  const pos = [], idx = [], uv = [];
  let v = 0;
  // `flip` reverses the winding. The two sides of a street are MIRROR IMAGES, so emitting their
  // corners in the same order sends one side's face normal into the ground — and a front-facing
  // material simply does not draw it. That is why every street in the city had a pavement on
  // exactly one side: the other one was built, and culled. The geometry was never the problem.
  const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, u, flip) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    uv.push(0, 0, 1, 0, 0, u, 1, u);
    if (flip) idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    else idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    v += 4;
  };
  /** A paved disc at kerb-top height: the pavement's round joint, mirroring the road's. */
  const walkDisc = (cx, cy, r) => {
    const SEG = 8;
    const centre = v;
    pos.push(cx, groundHeight(cx, -cy) + SIDEWALK_H, -cy);
    uv.push(0.5, 0.5);
    for (let k = 0; k <= SEG; k++) {
      const a = (k / SEG) * Math.PI * 2;
      const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
      pos.push(px, groundHeight(px, -py) + SIDEWALK_H, -py);
      uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
    }
    for (let k = 0; k < SEG; k++) idx.push(centre, centre + 1 + k, centre + 2 + k);
    v += 2 + SEG;
  };

  /** One length of ribbon: the kerb face standing on the carriageway edge, and the slab behind it. */
  const ribbon = (a, b, flip) => {
    const len = Math.hypot(b.ix - a.ix, b.iy - a.iy);
    if (len < 1e-3) return;                       // the duplicated cross-section at a bend
    const u = len / 3;
    const gia = groundHeight(a.ix, -a.iy), gib = groundHeight(b.ix, -b.iy);
    const goa = groundHeight(a.ox, -a.oy), gob = groundHeight(b.ox, -b.oy);
    quad(a.ix, gia + 0.02, -a.iy, b.ix, gib + 0.02, -b.iy,
         a.ix, gia + SIDEWALK_H, -a.iy, b.ix, gib + SIDEWALK_H, -b.iy, u, flip);
    quad(a.ix, gia + SIDEWALK_H, -a.iy, a.ox, goa + SIDEWALK_H, -a.oy,
         b.ix, gib + SIDEWALK_H, -b.iy, b.ox, gob + SIDEWALK_H, -b.oy, u, flip);
  };

  for (const e of world.edges) {
    if (!hasWalk(e)) continue;
    const half = e.width / 2;
    const walk = walkWidth(e.width);
    for (const side of [1, -1]) {
      // Sample the street at a fixed pace rather than one cross-section per polyline segment. A
      // segment can be fifty metres long, and judging fifty metres of kerb by whether its MIDPOINT
      // happened to land on another road is what produced both symptoms at once: slabs marooned in
      // the middle of a carriageway, and kerb lines that vanished for half a block. At this pace the
      // ribbon stops within a couple of metres of the tarmac it must not cross.
      const samples = [];
      for (let i = 0; i < e.pts.length - 1; i++) {
        const [x1, y1] = e.pts[i], [x2, y2] = e.pts[i + 1];
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const nx = -uy * side, ny = ux * side;
        const n = Math.max(1, Math.ceil(len / SIDEWALK_STEP));
        for (let k = 0; k <= n; k++) {
          const t = (k / n) * len;
          const px = x1 + ux * t, py = y1 + uy * t;
          // the pavement's own spine: where the round joins are centred
          const sx = px + nx * (half + walk / 2), sy = py + ny * (half + walk / 2);
          // A pavement is the OUTLINE of the road fill: paved exactly where a point is off every
          // carriageway yet within a footway's width of one. So the test runs ACROSS the strip —
          // just outside the kerb, at the spine, and just inside the far edge — and all three must
          // be clear. Judging the whole strip by its centre line let a ribbon whose inner half lay
          // on a neighbouring street survive, which is the pale bar with no kerb lying in the road.
          const on = (t) => world.onRoad(px + nx * t, py + ny * t, 0);
          const clear = !world.onRoad || (!on(half + 0.15) && !on(half + walk / 2) && !on(half + walk - 0.15));
          samples.push({
            ix: px + nx * half, iy: py + ny * half,
            ox: px + nx * (half + walk), oy: py + ny * (half + walk),
            sx, sy,
            // Anything hit here is a DIFFERENT road, because this strip lies outside its own by
            // construction — and the right answer is to stop, since that gap is the mouth of a
            // junction and the ring below paves around it.
            keep: clear,
            // true on the second of the two cross-sections a bend produces, where the round join goes
            bend: i > 0 && k === 0,
          });
        }
      }
      // Emit in RUNS of consecutive surviving samples, and only runs long enough to read as a
      // pavement — a two-metre slab of kerb standing alone is debris, and better absent.
      let run = [], runLen = 0;
      const flush = () => {
        if (runLen >= SIDEWALK_MIN_RUN) {
          for (let i = 0; i < run.length - 1; i++) ribbon(run[i], run[i + 1], side > 0);
          // The SAME round join the carriageway uses, on the pavement's own spine with the
          // pavement's own radius. Roads and footways built by one rule is why they now agree.
          for (const s of run) if (s.bend) walkDisc(s.sx, s.sy, walk / 2);
        }
        run = []; runLen = 0;
      };
      for (const s of samples) {
        if (!s.keep) { flush(); continue; }
        if (run.length) runLen += Math.hypot(s.ix - run[run.length - 1].ix, s.iy - run[run.length - 1].iy);
        run.push(s);
      }
      flush();
    }
  }

  // THE CORNERS. Clipping the ribbons at each junction mouth is correct and leaves a hole: the
  // pavement of the street you are on ends, the pavement of the street you turn into begins, and
  // between them is the corner itself — unpaved, in every corner of the city. A real corner is a
  // continuous kerb that wraps around and is interrupted only where a road arrives.
  //
  // So pave the node. A ring from the junction's tarmac edge outward, the width of the widest
  // footway arriving; each incident road blanks the angular sector its own mouth occupies. One rule
  // covers everything from a simple crossroads to a five-way, and a dead end comes out right for
  // free — one blocked sector, and the pavement wraps the other five-sixths of the turning head.
  const edgeById = new Map(world.edges.map(e => [e.id, e]));
  const wrap = (a) => { let d = a % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  for (const n of (world.nodes ?? [])) {
    const inc = (n.edges ?? []).map(id => edgeById.get(id)).filter(Boolean);
    if (!inc.length) continue;
    let r0 = 0, band = 0;
    for (const e of inc) {
      if (e.width / 2 > r0) r0 = e.width / 2;                 // matches the road's own junction disc
      if (hasWalk(e) && walkWidth(e.width) > band) band = walkWidth(e.width);
    }
    if (band <= 0 || r0 <= 0) continue;
    const r1 = r0 + band;
    // Each approach blanks the sector its carriageway subtends at the ring.
    const blocked = [];
    for (const e of inc) {
      const first = e.pts[0], last = e.pts[e.pts.length - 1];
      const atStart = (first[0] - n.x) ** 2 + (first[1] - n.y) ** 2 <= (last[0] - n.x) ** 2 + (last[1] - n.y) ** 2;
      const p = atStart ? (e.pts[1] ?? last) : (e.pts[e.pts.length - 2] ?? first);
      blocked.push({c: Math.atan2(p[1] - n.y, p[0] - n.x), hw: Math.atan2(e.width / 2, Math.max(0.5, r0))});
    }
    // A road that simply ENDS gets no ring. There is no corner to wrap at a dead end — the kerb
    // reaches the end of the street and stops — and wrapping it drew a horseshoe of pavement round
    // the road's mouth, `half + walk` in radius, which on a 7m street is an eleven-metre loop lying
    // across the end of it. Most of these are not even cul-de-sacs: they are streets that end where
    // a pedestrian zone or a square begins, and the model sees no second edge at the node.
    if (blocked.length < 2) continue;

    // A ring belongs at a CORNER, and only at one. OSM splits a single street into several ways
    // wherever a tag changes, so a straight road carries a degree-2 node every twenty or thirty
    // metres where nothing turns — and a ring was being stamped at every one of them. Since the arc
    // at 60° off the road's axis stands 0.87·(r0+band) from the centreline, each stamped a circle
    // bulging more than a metre INTO the carriageway. That is the scalloped kerb running down every
    // straight in the city: not a join, just a circle where nothing was turning.
    if (blocked.length === 2 && Math.abs(wrap(blocked[0].c - blocked[1].c)) > Math.PI - 0.5) continue;

    const steps = Math.max(8, Math.min(32, Math.round((Math.PI * 2 * r1) / 1.5)));
    for (let k = 0; k < steps; k++) {
      const a0 = (k / steps) * Math.PI * 2, a1 = ((k + 1) / steps) * Math.PI * 2;
      const mid = (a0 + a1) / 2;
      if (blocked.some(b => Math.abs(wrap(mid - b.c)) <= b.hw)) continue;
      // And the ring obeys the same rule the ribbons do: pavement is what lies OFF every
      // carriageway. Blanking the sector a road subtends only approximates that — a road leaving at
      // a shallow angle still runs beneath the arc beside it — so test the arc itself.
      if (world.onRoad) {
        const cm = Math.cos(mid), sm = Math.sin(mid);
        const onArc = (r) => world.onRoad(n.x + cm * r, n.y + sm * r, 0);
        if (onArc(r0 + 0.15) || onArc((r0 + r1) / 2) || onArc(r1 - 0.15)) continue;
      }
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const ax = n.x + c0 * r0, ay = n.y + s0 * r0, bx = n.x + c1 * r0, by = n.y + s1 * r0;
      const cx = n.x + c0 * r1, cy = n.y + s0 * r1, dx2 = n.x + c1 * r1, dy2 = n.y + s1 * r1;
      const ga = groundHeight(ax, -ay), gb = groundHeight(bx, -by);
      const gc = groundHeight(cx, -cy), gd = groundHeight(dx2, -dy2);
      // the kerb face, on the tarmac edge, exactly as along a straight
      quad(ax, ga + 0.02, -ay, bx, gb + 0.02, -by,
           ax, ga + SIDEWALK_H, -ay, bx, gb + SIDEWALK_H, -by, 0.6);
      quad(ax, ga + SIDEWALK_H, -ay, cx, gc + SIDEWALK_H, -cy,
           bx, gb + SIDEWALK_H, -by, dx2, gd + SIDEWALK_H, -dy2, 0.6);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({color: 0x9a9690, roughness: 0.9, metalness: 0.0});
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  return mesh;
}

// Break up big empty plazas. For each large mapped square, lay low grass discs and occasional
// planters around its OUTER ring (0.55..0.9 of the radius) — never the centre, which stays drivable —
// skipping any spot that hits a real building. Deterministic (position-hashed), seated on terrain.
function buildOpenSpaceDressing(world) {
  const group = new THREE.Group();
  const squares = (world.squares ?? []).filter(s => s.r >= 28);
  if (!squares.length) return group;
  const scratch = [];
  const nearBuilding = (x, y) => {
    const near = world.grid.near(x, y, 6, scratch);
    for (const b of near) { const a = b.aabb; if (x > a.minX - 2 && x < a.maxX + 2 && y > a.minY - 2 && y < a.maxY + 2) return true; }
    return false;
  };
  const grassPts = [], planterPts = [];
  for (const sq of squares) {
    const ring = Math.floor(sq.r * 0.7);
    for (let k = 0; k < ring; k++) {
      const a = (k / ring) * Math.PI * 2 + pseudo(sq.c[0] + k) * 0.5;
      const rr = sq.r * (0.55 + pseudo(k * 3.1 + sq.c[1]) * 0.35);
      const x = sq.c[0] + Math.cos(a) * rr, y = sq.c[1] + Math.sin(a) * rr;
      // Buildings AND roads: a mapped square is often half carriageway, so testing only footprints
      // left grass discs and planters sitting in the middle of the street.
      if (nearBuilding(x, y)) continue;
      if (world.onRoad && world.onRoad(x, y, 1.0)) continue;
      (pseudo(x * 0.3 + y * 0.7) > 0.82 ? planterPts : grassPts).push([x, y]);
    }
  }
  if (grassPts.length) {
    const g = new THREE.CircleGeometry(2.2, 10).rotateX(-Math.PI / 2);
    const inst = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({color: 0x3a6b3b}), grassPts.length);
    const m = new THREE.Matrix4();
    grassPts.forEach((p, i) => { m.makeTranslation(p[0], groundHeight(p[0], -p[1]) + 0.03, -p[1]); inst.setMatrixAt(i, m); });
    inst.receiveShadow = true; group.add(inst);
  }
  if (planterPts.length) {
    const tub = new THREE.CylinderGeometry(0.5, 0.4, 0.7, 8); tub.translate(0, 0.35, 0);
    const mound = new THREE.IcosahedronGeometry(0.55, 0); mound.translate(0, 0.85, 0);
    const tubs = new THREE.InstancedMesh(tub, new THREE.MeshLambertMaterial({color: 0x9a938a}), planterPts.length);
    const mounds = new THREE.InstancedMesh(mound, new THREE.MeshLambertMaterial({color: 0x3d6b39}), planterPts.length);
    const m = new THREE.Matrix4();
    planterPts.forEach((p, i) => { m.makeTranslation(p[0], groundHeight(p[0], -p[1]), -p[1]); tubs.setMatrixAt(i, m); mounds.setMatrixAt(i, m); });
    tubs.castShadow = true; group.add(tubs, mounds);
  }
  return group;
}

function buildRoads(world) {
  const pos = [], idx = [], uv = [];
  let v = 0;

  /**
   * A paved disc on the tarmac — the round join. Every road segment is its own rectangle, so where
   * two of them meet at an angle the OUTSIDE of the corner is an empty wedge; a circle of the
   * road's own radius fills that wedge whatever the angle, with no mitre maths and no special case
   * for the sharp ones. Used at the bends inside a street and, crucially, at the junctions between
   * streets. This is exactly what SVG means by stroke-linejoin="round".
   */
  const disc = (cx, cy, r) => {
    const SEG = 10;
    const centre = v;
    pos.push(cx, groundHeight(cx, -cy) + 0.02, -cy);
    uv.push(0.5, 0.5);
    for (let k = 0; k <= SEG; k++) {
      const a = (k / SEG) * Math.PI * 2;
      const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
      pos.push(px, groundHeight(px, -py) + 0.02, -py);
      uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
    }
    for (let k = 0; k < SEG; k++) idx.push(centre, centre + 1 + k, centre + 2 + k);
    v += 2 + SEG;
  };
  for (const e of world.edges) {
    const half = e.width / 2;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [x1, y1] = e.pts[i], [x2, y2] = e.pts[i + 1];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * half, ny = dx / len * half;
      // Two triangles per segment, each corner LIFTED onto the terrain (+0.02 so tarmac sits just
      // above the ground mesh rather than z-fighting it). Roads now drape over the hills.
      const gLL = groundHeight(x1 + nx, -(y1 + ny)) + 0.02, gLR = groundHeight(x1 - nx, -(y1 - ny)) + 0.02;
      const gRL = groundHeight(x2 + nx, -(y2 + ny)) + 0.02, gRR = groundHeight(x2 - nx, -(y2 - ny)) + 0.02;
      pos.push(x1 + nx, gLL, -(y1 + ny), x1 - nx, gLR, -(y1 - ny),
               x2 + nx, gRL, -(y2 + ny), x2 - nx, gRR, -(y2 - ny));
      // UV: along-length in metres/4 x across-width, so the asphalt tile keeps a constant scale
      const uL = 0; const uR = Math.hypot(x2 - x1, y2 - y1) / 4;
      uv.push(0, 0, 1, 0, 0, uR, 1, uR);
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      v += 4;

      // ROUND JOIN, the same thing SVG's stroke-linejoin="round" does. Every segment is its own
      // rectangle, so at a bend the OUTSIDE of the corner is left as an empty wedge between the two
      // quads — the sharper the turn, the bigger the bite out of the tarmac. A disc of the road's
      // own radius dropped on the shared vertex fills that wedge at any angle, without having to
      // work out mitres. Only INTERIOR vertices get one: the two ends of a street are caps, not
      // joins, and rounding those would bulge the tarmac out into the junction.
      if (i > 0) disc(x1, y1, half);
    }
  }

  // JUNCTIONS. Rounding the interior vertices of each polyline fixed the bends WITHIN a street, but
  // a junction is where two SEPARATE ways meet end-to-end, and an end was deliberately left square
  // as a cap — so the wedge simply reappeared at every corner where one road joins another. This is
  // not a curve-resolution problem and more points along the polyline would not touch it.
  //
  // The model already welds those ends into shared nodes and records which edges meet at each, so
  // the fix is to pave the node itself: one disc sized to the WIDEST road arriving there, which
  // covers the full mouth of every approach. Degree-1 nodes are true dead ends and stay square.
  const edgeById = new Map(world.edges.map(e => [e.id, e]));
  for (const n of (world.nodes ?? [])) {
    if (!n.edges || n.edges.length < 2) continue;
    let r = 0;
    for (const id of n.edges) {
      const e = edgeById.get(id);
      if (e && e.width / 2 > r) r = e.width / 2;
    }
    if (r > 0) disc(n.x, n.y, r);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 0.55, metalness: 0.0, map: asphaltTexture()});
  mat.userData.wet = {value: 0}; // driven by rain + night in update()
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWet = mat.userData.wet;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldR;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldR = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWorldR;
        float rhash(vec2 p){ p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
        float rnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(rhash(i), rhash(i+vec2(1,0)), f.x), mix(rhash(i+vec2(0,1)), rhash(i+vec2(1,1)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float agg = rhash(floor(vWorldR.xz * 14.0));
        float blotch = rnoise(vWorldR.xz * 0.11);
        float seam = smoothstep(0.985, 1.0, rnoise(vWorldR.xz * 0.45));
        diffuseColor.rgb *= (0.95 + agg * 0.12) * (0.97 + blotch * 0.08);
        diffuseColor.rgb *= 1.0 - seam * 0.12;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.16, uWet);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.5, uWet);`);
    shader.fragmentShader = 'uniform float uWet;\n' + shader.fragmentShader;
  };
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}

// The Grand Duchess Charlotte bridge is red, and everyone in Luxembourg calls it by that
// colour. Its OSM segments get side girders and posts so the crossing reads as THE bridge
// rather than as tarmac over nothing. Purely additive: the deck stays a normal road.
function buildMarkings(world) {
  const pos = [], idx = [];
  let v = 0;
  const quad = (cx, cz, hx, hz, ax, az) => {
    // a rectangle centred at (cx,cz), half-extents along axis (ax,az)=length dir and its normal.
    // Each corner rides the terrain (+0.05 above the road) so markings drape the hills with the road.
    const nx = -az, nz = ax;
    const cxA = cx + ax*hx + nx*hz, czA = cz + az*hx + nz*hz;
    const cxB = cx - ax*hx + nx*hz, czB = cz - az*hx + nz*hz;
    const cxC = cx + ax*hx - nx*hz, czC = cz + az*hx - nz*hz;
    const cxD = cx - ax*hx - nx*hz, czD = cz - az*hx - nz*hz;
    pos.push(cxA, groundHeight(cxA, -czA) + 0.05, -czA,
             cxB, groundHeight(cxB, -czB) + 0.05, -czB,
             cxC, groundHeight(cxC, -czC) + 0.05, -czC,
             cxD, groundHeight(cxD, -czD) + 0.05, -czD);
    idx.push(v, v+2, v+1, v+1, v+2, v+3); v += 4;
  };
  // centre dashes on the wider drivable roads only (dashing a 4m service road looks wrong)
  for (const e of world.edges) {
    if (e.width < 7 || e.pedestrianZone) continue;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [x1, y1] = e.pts[i], [x2, y2] = e.pts[i+1];
      const dx = x2-x1, dy = y2-y1, len = Math.hypot(dx,dy) || 1;
      const ax = dx/len, az = dy/len;
      for (let d = 2; d < len - 1; d += 6) {
        const cx = x1 + ax*(d+1.5), cz = y1 + az*(d+1.5);
        quad(cx, cz, 1.5, 0.12, ax, az); // 3m dash, 24cm wide
      }
    }
  }
  // zebra crossings at real nodes: a band of bars across the nearest wide road's width
  for (const p of (world.crossings ?? [])) {
    // find nearest drivable edge point for orientation
    let best = null, bd = 1e9;
    for (const e of world.edges) {
      if (e.width < 7) continue;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const mx = (e.pts[i][0]+e.pts[i+1][0])/2, my = (e.pts[i][1]+e.pts[i+1][1])/2;
        const dd = (mx-p[0])**2 + (my-p[1])**2;
        if (dd < bd) { bd = dd; best = {e, i}; }
      }
    }
    if (!best || bd > 25*25) continue;
    const e = best.e, [x1,y1] = e.pts[best.i], [x2,y2] = e.pts[best.i+1];
    const len = Math.hypot(x2-x1, y2-y1) || 1, ax = (x2-x1)/len, az = (y2-y1)/len;
    const half = e.width/2;
    for (let s = -half + 0.5; s < half; s += 1.0) {
      const cx = p[0] + (-az)*s, cz = p[1] + ax*s;
      quad(cx, cz, 0.35, half*0.6, ax, az); // bar across, aligned with travel
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({color: 0xd8d6cc}));
  m.renderOrder = 1;
  return m;
}

function buildPontRouge(world) {
  const group = new THREE.Group();
  const red = new THREE.MeshLambertMaterial({color: 0xb02a20});
  const girder = [], posts = [];
  for (const e of world.edges) {
    if (!/pont grande-duchesse charlotte/i.test(e.name ?? '')) continue;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [x1, y1] = e.pts[i], [x2, y2] = e.pts[i + 1];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len, half = e.width / 2 + 0.6;
      for (const s of [1, -1]) {
        // side girder: a long thin box per segment per side
        const gx = (x1 + x2) / 2 + nx * half * s, gy = (y1 + y2) / 2 + ny * half * s;
        const beam = new THREE.Mesh(new THREE.BoxGeometry(len, 2.6, 0.5), red);
        beam.position.set(gx, 1.3, -gy);
        beam.rotation.y = Math.atan2(dy, dx);
        girder.push(beam);
        // posts every ~10m
        for (let d = 5; d < len; d += 10) {
          const px = x1 + dx / len * d + nx * half * s, py = y1 + dy / len * d + ny * half * s;
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4.2, 0.4), red);
          post.position.set(px, 2.1, -py);
          posts.push(post);
        }
      }
    }
  }
  for (const m of [...girder, ...posts]) { m.castShadow = true; group.add(m); }
  return group;
}

// One merged extrusion for every building; the facade lives in the fragment shader.
// Per-fragment window grid from world position: zero textures, crisp at any distance,
// per-window pseudo-random warm light at night. uNight fades the whole city's windows in.
function buildBuildings(world) {
  const pos = [], norm = [], rnd = [], idx = [], bas = [];
  let v = 0;
  for (const bl of world.buildings) {
    const pts = bl.pts, n = pts.length, h = bl.h, seed = Math.random();
    // Drop degenerate footprints: OSM building:part and barrier=wall outlines can be a sliver
    // (2 points, or a near-zero-area strip) and extrude into a 2D wall standing on edge — the
    // "thin wall" artifact. A real building encloses area; require it.
    let area2 = 0;
    for (let i = 0; i < n - 1; i++) area2 += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
    if (n < 4 || Math.abs(area2) < 12) continue;
    // Seat the building at its footprint CENTROID's ground — where it meets the street — minus a
    // small 0.3m bury. Seating at the lowest corner sank street-facing storefronts below the road on
    // sloped footprints; the centroid keeps the visible face at street level. Top is floor + height.
    const base = seatGroundUnder(pts) - 0.3;
    const top = base + h;
    // walls
    for (let i = 0; i < n - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      const nx = dy / len, nz = dx / len;
      // ~2cm outward nudge per building, seeded: OSM building:part outlines share planes with
      // their parent building, and two coplanar facades with different window seeds z-fight
      // into a dithered static patch. The nudge is invisible and breaks every such tie.
      const ox = nx * (0.015 + seed * 0.025), oy = -nz * (0.015 + seed * 0.025);
      pos.push(x1 + ox, base, -(y1 + oy), x2 + ox, base, -(y2 + oy), x1 + ox, top, -(y1 + oy), x2 + ox, top, -(y2 + oy));
      for (let k = 0; k < 4; k++) { norm.push(nx, 0, nz); rnd.push(seed); bas.push(base); }
      idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      v += 4;
    }
    // flat roof — ear-clipped. Fan triangulation was tried first and produced a black
    // pyramid over the Coque: a concave footprint fanned from vertex 0 spikes across
    // itself. ShapeUtils handles concavity and costs nothing at build time.
    const roofStart = v;
    const flat = [];
    for (let i = 0; i < n - 1; i++) {
      const [x, y] = pts[i];
      pos.push(x, top, -y); norm.push(0, 1, 0); rnd.push(seed); bas.push(base);
      flat.push(new THREE.Vector2(x, y));
      v++;
    }
    for (const tri of THREE.ShapeUtils.triangulateShape(flat, [])) {
      idx.push(roofStart + tri[0], roofStart + tri[2], roofStart + tri[1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBase', new THREE.Float32BufferAttribute(bas, 1));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  g.setAttribute('aRnd', new THREE.Float32BufferAttribute(rnd, 1));
  g.setIndex(idx);

  const uniforms = {
    uNight: {value: 0},
    uDiffuse: {value: new THREE.Color(0x8f8a84)},   // Luxembourg sandstone
    uRoof: {value: new THREE.Color(0x4a4440)},
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog, uniforms]),
    lights: true, fog: true,
    // Double-sided so no building is ever HOLLOW: walls render from inside as well as outside, which
    // (a) stops the see-through/empty-shell look when the camera clips into a facade, and (b) rescues
    // any OSM footprint wound the "wrong" way whose outward normals would otherwise face inward and
    // cull its street-facing walls to invisible. The lambert term below flips the normal to face the
    // camera so interior faces light correctly rather than going flat-black.
    side: THREE.DoubleSide,
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      #include <shadowmap_pars_vertex>
      attribute float aRnd; attribute float aBase; varying float vRnd; varying float vLocalY; varying vec3 vWorld; varying vec3 vNormalW;
      void main(){
        vRnd = aRnd;
        vLocalY = position.y - aBase;   // height above THIS building's own floor, terrain-independent
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        #if NUM_DIR_LIGHT_SHADOWS > 0
          vec4 shadowWorldPosition = wp + vec4(vNormalW * 0.05, 0.0);
          vDirectionalShadowCoord[0] = directionalShadowMatrix[0] * shadowWorldPosition;
        #endif
      }`,
    fragmentShader: `
      #include <common>
      #include <packing>
      #include <fog_pars_fragment>
      #include <bsdfs>
      #include <lights_pars_begin>
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>
      uniform float uNight; uniform vec3 uDiffuse; uniform vec3 uRoof;
      varying float vRnd; varying float vLocalY; varying vec3 vWorld; varying vec3 vNormalW;
      // cheap hash — per-window randomness
      // Inputs wrapped small before sin(): on Apple GPUs sin() of large arguments loses all
      // precision and the hash collapses to a constant — which rendered every window unlit.
      float hash(vec2 p){ p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
      vec3 warmSign(vec2 s){ return 0.35 + 0.5 * vec3(hash(s), hash(s+3.1), hash(s+7.7)); }
      void main(){
        bool roof = vNormalW.y > 0.7;
        // facade coordinate: distance along the wall (from world xz) x height
        vec2 fc = vec2(dot(vWorld.xz, vec2(vNormalW.z, -vNormalW.x)), vLocalY);
        vec2 cell = floor(fc / vec2(2.4, 3.1));            // window every 2.4m, storey 3.1m
        vec2 inCell = fract(fc / vec2(2.4, 3.1));
        bool ground = !roof && vLocalY < 3.4 && vLocalY > 0.35;
        // ground-floor shopfront: wide glazing on a 3.6m bay with mullions, over a low riser
        vec2 shopCell = floor(fc / vec2(3.6, 3.2));
        vec2 shopIn = fract(fc / vec2(3.6, 3.2));
        bool shopGlass = ground && vLocalY > 0.9 && vLocalY < 2.9 && shopIn.x > 0.14 && shopIn.x < 0.86 && fract(shopIn.x*4.0) > 0.18;
        bool isWin = !roof && !ground && inCell.x > 0.28 && inCell.x < 0.78 && inCell.y > 0.30 && inCell.y < 0.75;
        float wr = hash(cell + vRnd * 97.0);
        vec3 base = roof ? uRoof : uDiffuse * (0.86 + 0.14 * hash(vec2(vRnd, 1.0)));
        if (!roof) {
          // plaster grain — fine noise, +-4%, breaks the flat fill at kerb distance
          base *= 0.96 + 0.08 * hash(floor(fc * 9.0));
          // storey ledges — a darker course at each floor line
          float ledge = smoothstep(0.0, 0.05, abs(fract(fc.y / 3.1) - 0.02) );
          base *= mix(0.78, 1.0, ledge);
          // weathering streaks under sills: darkened wash below each window column, gated per cell
          float below = step(0.75, inCell.y);
          float streakGate = step(0.45, hash(cell * 7.3 + vRnd));
          float inCol = smoothstep(0.24, 0.34, inCell.x) * (1.0 - smoothstep(0.72, 0.82, inCell.x));
          base *= 1.0 - below * streakGate * inCol * 0.10;
          // grime rising from the street
          base *= 1.0 - smoothstep(3.0, 0.0, vLocalY) * 0.13;
        } else {
          // slate seams
          float seam = min(fract(vWorld.x / 0.9), fract(vWorld.z / 0.9));
          base *= mix(0.86, 1.0, smoothstep(0.0, 0.06, seam));
          base *= 0.94 + 0.12 * hash(floor(vWorld.xz * 1.3));
        }
        // simple lambert against scene lights. Flip the normal on back faces (DoubleSide interior
        // walls) so they light toward the camera instead of collapsing to black.
        vec3 N = gl_FrontFacing ? vNormalW : -vNormalW;
        vec3 nl = vec3(0.0);
        #if NUM_DIR_LIGHTS > 0
          nl += directionalLights[0].color * max(dot(N, directionalLights[0].direction), 0.0) * getShadowMask();
        #endif
        nl += ambientLightColor;
        // faint self-illumination floor so night walls silhouette instead of vanishing
        vec3 col = base * (nl + vec3(0.035, 0.04, 0.055));
        if (isWin) {
          vec3 dayGlass = mix(vec3(0.18, 0.22, 0.28), vec3(0.5, 0.6, 0.7), hash(cell * 1.7));
          float lit = step(wr, 0.55) * uNight;               // ~55% of windows light at night
          vec3 warm = mix(vec3(1.0, 0.75, 0.42), vec3(1.0, 0.87, 0.6), hash(cell * 3.1));
          col = mix(dayGlass * nl, warm * (1.4 + 0.6 * hash(cell * 5.3)), lit);
        } else if (ground) {
          // riser band at pavement level reads as stone/tile plinth
          if (vLocalY < 0.9) col *= 0.62;
          if (shopGlass) {
            float open = step(hash(shopCell * 2.3), 0.7);    // some units shuttered
            vec3 dayShop = mix(vec3(0.12,0.14,0.17), vec3(0.35,0.42,0.5), hash(shopCell*1.9));
            vec3 nightShop = mix(vec3(0.95,0.82,0.55), vec3(0.55,0.78,0.95), hash(shopCell*7.7)) * 0.85;
            col = mix(dayShop * nl, mix(dayShop*nl*0.4, nightShop, uNight), open);
            // fascia sign strip just above the glazing
            if (shopIn.y > 0.86) col = mix(col, warmSign(shopCell), 0.7 + 0.3*uNight);
          }
        }
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // UniformsUtils.merge CLONES its inputs, so the local `uniforms` object is not what the
  // material reads — updating it moved nothing on screen. Hand back the material's own.
  return {mesh, uniforms: mat.uniforms};
}

function buildPolys(polys, color, y) {
  const shapes = [];
  for (const pts of polys) {
    if (pts.length < 3) continue;
    const s = new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    shapes.push(s);
  }
  const g = new THREE.ShapeGeometry(shapes);
  g.rotateX(-Math.PI / 2); // ShapeGeometry XY -> ground XZ; model +Y becomes -Z, matching toV3
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({color}));
  m.position.y = y;
  m.receiveShadow = true;
  return m;
}

// A broadleaf, not a fir: a tapered trunk splitting into a few thick boughs, crowned by four
// overlapping deformed spheres so the canopy reads as bushy foliage from any angle — never the
// two-cone christmas tree it used to be. One merged geometry, instanced across every mapped tree,
// with per-instance scale, yaw and a green tint drawn from a small palette so a street of them
// does not look stamped from one mould.
function treeGeometry() {
  const parts = [];
  // trunk: a short tapered bole
  const trunk = new THREE.CylinderGeometry(0.16, 0.32, 2.4, 6); trunk.translate(0, 1.2, 0);
  parts.push(trunk);
  // three boughs angling up and out from the crotch — thin cylinders, just enough to read
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const bough = new THREE.CylinderGeometry(0.06, 0.13, 1.8, 4);
    // lean the bough outward: translate up its own length, then tilt and swing into place
    bough.translate(0, 0.9, 0);
    bough.rotateZ(0.5);
    bough.rotateY(a);
    bough.translate(0, 2.2, 0);
    parts.push(bough);
  }
  const g = mergeGeoms(parts);            // all bark, one material slot
  g.userData.trunkCount = parts.length;
  return g;
}
function crownGeometry() {
  // four low-poly spheres, each squashed and jittered, clustered into a lumpy canopy. Detail=1
  // icospheres are ~80 tris apiece; four of them per tree stays cheap enough to instance thousands.
  const blobs = [
    [0, 4.3, 0, 2.3], [1.5, 3.9, 0.4, 1.7], [-1.2, 4.0, -0.6, 1.6], [0.3, 5.2, 0.2, 1.5],
  ];
  const parts = [];
  for (const [x, y, z, r] of blobs) {
    const s = new THREE.IcosahedronGeometry(r, 1);
    // squash vertically and roughen each vertex so no blob is a clean ball
    const pos = s.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
      const j = 0.82 + 0.36 * pseudo(vx * 3.1 + vy * 1.7 + vz * 2.3 + x);
      pos.setXYZ(i, vx * j, vy * 0.82 * j, vz * j);
    }
    s.computeVertexNormals();
    s.translate(x, y, z);
    parts.push(s);
  }
  return mergeGeoms(parts);
}
// small deterministic hash so the canopy is lumpy the same way every load (no per-frame Math.random)
function pseudo(n) { const s = Math.sin(n) * 43758.5453; return s - Math.floor(s); }

// Synthetic trees to green a sparse city. Street trees: every ~20m along the busier roads, set back
// on the pavement (off the carriageway), alternating sides. Fill trees: scattered inside the larger
// green polygons. Deterministic by position.
//
// Both kinds go through the SAME test, and the test is `siting.plantable` (src/render/siting.js) on
// top of the road and building checks. The street trees need it as badly as the park fill does —
// they are the ones that land on a cafe terrace or inside a bus shelter, because that is exactly
// where the pavement rhythm puts them.
function augmentTrees(world, onRoad, siting) {
  const out = [];
  const scratch = [];
  const inBuilding = (x, y) => {
    const near = world.grid.near(x, y, 4, scratch);
    for (const b of near) { const a = b.aabb; if (x > a.minX && x < a.maxX && y > a.minY && y < a.maxY) return true; }
    return false;
  };
  const ok = (x, y) => !onRoad(x, y) && !inBuilding(x, y) && siting.plantable(x, y);
  // street trees along frontages
  const LINED = new Set(['primary', 'secondary', 'tertiary', 'residential', 'living_street']);
  for (const e of world.edges) {
    if (!LINED.has(e.kind)) continue;
    let acc = 0, side = 1;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [x1, y1] = e.pts[i], [x2, y2] = e.pts[i + 1];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      let d = 20 - acc;
      while (d < len) {
        const px = x1 + dx / len * d, py = y1 + dy / len * d;
        const off = (e.width / 2 + 2.6) * side;               // out on the pavement, past the kerb
        const tx = px - dy / len * off, ty = py + dx / len * off;
        if (ok(tx, ty)) { out.push([tx, ty]); side = -side; }
        d += 20;
      }
      acc = (acc + len) % 20;
    }
  }
  // fill trees inside the bigger green polygons (grid scatter, point-in-poly)
  const inPoly = (x, y, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  for (const poly of (world.green ?? [])) {
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (const [x, y] of poly) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    if ((maxx - minx) * (maxy - miny) < 400) continue;         // skip tiny verges
    for (let x = minx; x < maxx; x += 12) {
      for (let y = miny; y < maxy; y += 12) {
        const jx = x + pseudo(x * 0.7 + y) * 8, jy = y + pseudo(y * 0.3 - x) * 8;
        if (inPoly(jx, jy, poly) && ok(jx, jy)) out.push([jx, jy]);
      }
    }
  }
  return out;
}

const CROWN_TINTS = [0x3f6b3a, 0x4a7a41, 0x35603a, 0x567f3e, 0x2f5533, 0x6a8a3c];
/**
 * How many energetic hits a trunk of this scale takes before it comes down.
 *
 * The one place in the game where mass is graded, and it is graded off the scale the tree was already
 * DRAWN at, so the thing that looks thick is the thing that resists — a sapling and a mature plane
 * tree that go down alike is the version of this feature nobody would believe. `buildTrees` picks
 * that scale from a position hash, so this is stable across reloads for free.
 */
function trunkToughness(scale) { return scale < 1.0 ? 1 : scale < 1.36 ? 2 : 3; }

function buildTrees(trees) {
  const barkG = treeGeometry();
  const crownG = crownGeometry();
  const barkMat = new THREE.MeshLambertMaterial({color: 0x554033});
  const crownMat = new THREE.MeshLambertMaterial({color: 0xffffff});   // tinted per instance
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), e = new THREE.Euler();
  const pos = new THREE.Vector3(), c = new THREE.Color();
  const group = new THREE.Group();

  // TILED, for the same reason the terraces are. An InstancedMesh is culled as ONE object, so a
  // single mesh holding 12,757 trees submitted all 12,757 of them every frame — five million
  // triangles, most of them behind the camera. Split by tile and the frustum test throws away the
  // ones you are not looking at.
  const tiles = new Map();
  for (const p of trees) {
    const key = `${Math.floor(p[0] / TILE)}:${Math.floor(p[1] / TILE)}`;
    const bucket = tiles.get(key);
    if (bucket) bucket.push(p); else tiles.set(key, [p]);
  }

  // Every drawn tree also becomes a physics prop, registered by the caller. The handle carries the
  // two meshes that hold it and its index in them, which is all the destruction driver needs to tip
  // that one instance over without touching the other twelve thousand in the tile.
  const props = [];

  for (const bucket of tiles.values()) {
    const bark = new THREE.InstancedMesh(barkG, barkMat, bucket.length);
    const crown = new THREE.InstancedMesh(crownG, crownMat, bucket.length);
    bucket.forEach((p, i) => {
      // deterministic per-tree variation keyed on position — stable across reloads
      const h = pseudo(p[0] * 0.13 + p[1] * 0.29);
      const sc = 0.78 + h * 0.9;
      const rotY = pseudo(p[0] * 0.7 - p[1] * 0.3) * Math.PI * 2;
      const gy = groundHeight(p[0], -p[1]);
      e.set(0, rotY, 0); q.setFromEuler(e); s.setScalar(sc);
      pos.set(p[0], gy, -p[1]);   // plant the trunk on the terrain
      m.compose(pos, q, s);
      bark.setMatrixAt(i, m); crown.setMatrixAt(i, m);
      c.set(CROWN_TINTS[Math.floor(h * CROWN_TINTS.length) % CROWN_TINTS.length]);
      crown.setColorAt(i, c);
      props.push({
        x: p[0], y: p[1], kind: 'tree',
        r: 0.42 * sc,                       // the trunk the player can see, not a nominal one
        hp: trunkToughness(sc),
        ref: {topple: [bark, crown], hide: [], glow: null,
              i, x: p[0], y: gy, z: -p[1], rotY, scale: sc},
      });
    });
    bark.castShadow = true; crown.castShadow = true;
    bark.userData.kind = 'Tree'; crown.userData.kind = 'Tree';
    if (crown.instanceColor) crown.instanceColor.needsUpdate = true;
    // The bounding sphere has to span the INSTANCES, not the single tree the geometry describes, or
    // the tile is culled by the wrong volume and trees blink out while still on screen.
    bark.computeBoundingSphere(); crown.computeBoundingSphere();
    group.add(bark, crown);
  }
  return {group, props};
}

// The green wall that closes the world. One extruded ribbon following the map's boundary rectangle,
// its top edge jittered into a lumpy hedge crest and its face given a little in/out wobble so it
// reads as a deep clipped hedge rather than a flat billboard. A handful of hundred triangles for the
// whole ring — the cheapest possible "edge of the map is a place, not a rule".
function buildGreenWall(bounds) {
  const {minX, minY, maxX, maxY} = bounds;
  const M = 40;                          // sit the wall just outside the drivable bounds
  const H = 11;                          // hedge height
  const x0 = minX - M, x1 = maxX + M, y0 = minY - M, y1 = maxY + M;
  // walk the rectangle perimeter as a dense polyline so the crest can undulate
  const ring = [];
  const step = 6;
  const edge = (ax, ay, bx, by) => {
    const len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) ring.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n]);
  };
  edge(x0, y0, x1, y0); edge(x1, y0, x1, y1); edge(x1, y1, x0, y1); edge(x0, y1, x0, y0);
  ring.push(ring[0]);

  const pos = [], idx = [];
  let v = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
    const topA = H + 2.4 * pseudo(ax * 0.3 + ay * 0.2);   // jittered crest so it reads as a hedge, not a fence
    const topB = H + 2.4 * pseudo(bx * 0.3 + by * 0.2);
    pos.push(ax, 0, -ay,  bx, 0, -by,  ax, topA, -ay,  bx, topB, -by);   // world Z = -y
    idx.push(v, v + 1, v + 2,  v + 1, v + 3, v + 2);
    v += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({color: 0x2f5233, side: THREE.DoubleSide});
  const wall = new THREE.Mesh(g, mat);
  wall.castShadow = false;
  return wall;
}

// Fountain water as a real particle system: one THREE.Points cloud spanning every mapped fountain,
// each spouting ~50 droplets that launch upward-and-out from the basin centre, arc under gravity,
// and respawn when they fall back to basin level. One draw call, ~1.3k points for 26 fountains,
// stepped each frame in update(). Reuses the proven rain-Points pattern; here the motion is a
// ballistic fountain jet rather than falling rain.
const FOUNTAIN_JET_N = 50;          // droplets per fountain
const FOUNTAIN_BASIN_Y = 0.6;       // water surface height (matches the basin disc in decor.js)
function buildFountainJets(fountains) {
  if (!fountains.length) return null;
  const per = FOUNTAIN_JET_N, total = fountains.length * per;
  const pos = new Float32Array(total * 3);
  // per-particle ballistic state, kept parallel to the position buffer
  const base = new Float32Array(total * 2);   // basin centre (x,z) per particle
  const basinY = new Float32Array(total);     // water-surface Y per particle (terrain + basin height)
  const vel = new Float32Array(total * 3);    // current velocity
  const life = new Float32Array(total);       // seconds since launch, staggered so the jet is continuous
  const launch = (i, stagger) => {
    const ang = pseudo(i * 12.9) * Math.PI * 2;
    const out = 0.25 + pseudo(i * 7.3) * 0.7;         // gentler outward -> a plume, not a dome
    const up = 4.2 + pseudo(i * 3.1) * 1.8;           // taller thinner arc (~1.5-2.5m)
    vel[i * 3] = Math.cos(ang) * out;
    vel[i * 3 + 1] = up;
    vel[i * 3 + 2] = Math.sin(ang) * out;
    life[i] = stagger;
  };
  fountains.forEach((f, fi) => {
    const fg = groundHeight(f[0], -f[1]);              // terrain under this fountain
    for (let k = 0; k < per; k++) {
      const i = fi * per + k;
      base[i * 2] = f[0]; base[i * 2 + 1] = -f[1];     // world Z = -y
      basinY[i] = fg + FOUNTAIN_BASIN_Y;               // water surface rides the terrain
      pos[i * 3] = f[0]; pos[i * 3 + 1] = basinY[i]; pos[i * 3 + 2] = -f[1];
      launch(i, pseudo(i * 1.7) * 0.9);                // spread initial ages so it's a steady spray
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    uniforms: {uSize: {value: 1.5}},
    vertexShader: `uniform float uSize; varying float vY;
      void main(){ vY = position.y; vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = uSize * (300.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vY;
      void main(){ vec2 c = gl_PointCoord - 0.5; float d2 = dot(c,c); if (d2 > 0.25) discard;
        // soft round droplet; whiter at the top of the arc (spray), bluer low (water)
        float a = (1.0 - d2 * 4.0) * 0.6;
        vec3 col = mix(vec3(0.6,0.78,0.96), vec3(0.96,0.99,1.0), clamp(vY*0.35,0.0,1.0));
        gl_FragColor = vec4(col, a); }`,
  });
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false;
  const G = 9.0;   // gravity for the arc
  const step = (dt) => {
    const p = g.attributes.position.array;
    for (let i = 0; i < total; i++) {
      life[i] += dt;
      vel[i * 3 + 1] -= G * dt;
      p[i * 3] += vel[i * 3] * dt;
      p[i * 3 + 1] += vel[i * 3 + 1] * dt;
      p[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (p[i * 3 + 1] <= basinY[i]) {                  // fell back into the basin -> relaunch
        p[i * 3] = base[i * 2]; p[i * 3 + 1] = basinY[i]; p[i * 3 + 2] = base[i * 2 + 1];
        launch(i, 0);
      }
    }
    g.attributes.position.needsUpdate = true;
  };
  return {points, step};
}

// Fill empty residential frontages with terraces. Walk each residential edge, step along it in
// ~7m house-widths, and set a house back from the carriageway on each side facing the road — but
// ONLY where that house's footprint centre hits no existing OSM building (grid.near test) and no
// other townhouse already claimed the spot. Additive: the real city is untouched; only the bare
// stretches between real buildings get a terrace. One merged row = 2 draw calls for the whole city.
const _thScratch = [];
function buildTownhouseFrontages(world) {
  const houses = [];
  const claimed = [];                       // [x, y] of placed house centres, to avoid double-placing
  const HOUSE_W = 7.0;                       // stride along the frontage
  const SETBACK = 5.5;                       // house origin distance from carriageway centreline edge
  const clear = (x, y, r) => {
    // reject if within r of any real building
    const near = world.grid.near(x, y, r + 8, _thScratch);
    for (const b of near) {
      // building.aabb quick reject then centre distance
      const a = b.aabb;
      if (x > a.minX - r && x < a.maxX + r && y > a.minY - r && y < a.maxY + r) return false;
    }
    for (const c of claimed) if ((c[0] - x) ** 2 + (c[1] - y) ** 2 < (HOUSE_W * 0.9) ** 2) return false;
    return true;
  };
  for (const e of world.edges) {
    if (e.kind !== 'residential' && e.kind !== 'living_street' && e.kind !== 'unclassified') continue;
    for (let seg = 0; seg < e.pts.length - 1; seg++) {
      const [x1, y1] = e.pts[seg], [x2, y2] = e.pts[seg + 1];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      if (len < HOUSE_W) continue;
      const nx = -dy / len, ny = dx / len;                   // unit normal
      const n = Math.floor(len / HOUSE_W);
      for (let side = -1; side <= 1; side += 2) {
        const off = e.width / 2 + SETBACK;
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) * HOUSE_W;
          const px = x1 + dx / len * t, py = y1 + dy / len * t;
          const hx = px + nx * off * side, hy = py + ny * off * side;
          if (!clear(hx, hy, HOUSE_W * 0.6)) continue;
          claimed.push([hx, hy]);
          // The facade is local +Z, and a yaw of rotY sends +Z to (sin rotY, cos rotY) in Three's
          // x/z. The house must face back down its own normal, which is map -(nx,ny)·side; map
          // (mx,my) is Three (mx,-my), so the target is (-nx·side, +ny·side) — hence this atan2.
          // The second argument was negated, which reflects every house about the map's y-axis:
          // on an east-west street that turns the facade to face directly AWAY from the road, and
          // on a diagonal it lands at a mirrored angle. That is the terrace of houses standing at
          // arbitrary angles to the street they belong to.
          const rotY = Math.atan2(-nx * side, ny * side);
          // Depth is chosen HERE rather than left to the model's own seed, because the physics
          // footprint below has to be the same rectangle the renderer draws.
          const depth = 7 + pseudo(hx * 0.9 - hy * 0.4) * 4;
          houses.push({seed: (Math.floor(hx * 7.3 + hy * 3.1) & 0x7fffffff), x: hx, y: groundHeight(hx, -hy) - 0.4, z: -hy, rotY,
            storeys: 3 + (Math.floor(pseudo(hx * 0.2 + hy * 0.5) * 4)), width: HOUSE_W, depth});
        }
      }
    }
  }
  // Hand the footprints to the physics. A townhouse's origin is its FRONT-CENTRE with the facade
  // facing +Z and the body running back to -depth (townhouse.js documents this), so the rectangle in
  // local space is x in [-w/2, w/2], z in [-depth, 0]. Rotate it by the house's yaw, translate, and
  // convert back to map coordinates (mapY = -worldZ) — the space every other footprint lives in.
  const footprintOf = (h) => {
    const c = Math.cos(h.rotY), s = Math.sin(h.rotY), hw = h.width / 2;
    const local = [[-hw, 0], [hw, 0], [hw, -h.depth], [-hw, -h.depth]];
    return local.map(([lx, lz]) => {
      const wx = h.x + lx * c + lz * s;
      const wz = h.z - lx * s + lz * c;
      return [wx, -wz];
    });
  };
  // Reject any house whose FOOTPRINT lies on a carriageway. The placement test above only ever
  // checked the house's centre point against BUILDINGS — never against roads — so a terrace laid
  // along one street happily put its flank across the crossing street at the end of it. That was
  // invisible while townhouses were scenery; the moment they became solid it turned into a wall
  // across the road, which is what the reports were.
  const onCarriageway = (h) => {
    if (!world.onRoad) return false;
    const pts = footprintOf(h);
    if (world.onRoad(h.x, -h.z, 0.5)) return true;
    for (const [px, py] of pts) if (world.onRoad(px, py, 0.5)) return true;
    // also the midpoint of each side, so a long flank cannot straddle a narrow lane between corners
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (world.onRoad((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0.5)) return true;
    }
    return false;
  };
  const kept = houses.filter(h => !onCarriageway(h));
  houses.length = 0;
  houses.push(...kept);

  // Hand the footprints to the physics.
  if (houses.length && world.registerBuildings) {
    world.registerBuildings(houses.map(h => {
      const pts = footprintOf(h);
      pts.push([pts[0][0], pts[0][1]]);        // closed ring, like the OSM footprints
      return {pts, h: 12};
    }));
  }
  // TILE the terraces instead of merging the whole city into one mesh. Merging was right for draw
  // calls and catastrophic for culling: 12 MILLION triangles in a single object, and an object is
  // culled whole or not at all, so every house in Luxembourg was submitted every frame no matter
  // where the camera looked. One merged mesh per TILE keeps the draw calls low (only the handful of
  // tiles on screen are drawn) and finally lets the frustum test do its job.
  const group = new THREE.Group();
  if (houses.length) {
    const tiles = new Map();
    for (const h of houses) {
      const key = `${Math.floor(h.x / TILE)}:${Math.floor(h.z / TILE)}`;
      const bucket = tiles.get(key);
      if (bucket) bucket.push(h); else tiles.set(key, [h]);
    }
    for (const bucket of tiles.values()) group.add(buildTownhouseRow(bucket));
  }
  return group;
}

/** Side of a culling tile, metres. Small enough that most of the city is off screen, large enough
 *  that the draw-call count stays sane. */
const TILE = 260;

// Dress the pavements. Walk the busier streets and, every ~40m, drop a prop just past the
// carriageway edge facing the street. The TYPE is chosen by a stable per-site hash so the mix is
// varied but identical across reloads; shelters and benches are rarer than bollards and bins. Each
// factory is an instanced mesh, so this is a handful of draw calls for the whole city's furniture.
// ------------------------------------------------------------------------------------------------
// Dead-end horseshoes
//
// A street that simply stops is the least finished thing in the city: the tarmac ends on a straight
// edge with nothing behind it, and from the air 411 of them read as unfinished roadworks rather than
// as places. Real dead ends are planted — a turning head with a stand of trees wrapped round the end
// of it, which is what tells a driver the road is over before the kerb does.
//
// Only the ones with room get it. Of the 411 degree-1 nodes, 43 have at least 30 m of empty radius
// (measured to the nearest building corner and the nearest other carriageway); the other 368 end in
// a wall, a junction or a river bank, and a horseshoe there would be trees growing out of masonry.
// Thirty metres is the figure that was asked for, and it turns out to be a natural cut in the distribution: the
// next bucket down, 20 to 30 m, holds only 15 more.
//
// Variegation comes free and is worth knowing about rather than re-implementing: buildTrees already
// keys scale (0.78 to 1.68) and crown tint off the tree's own position, deterministically, so an arc
// of points comes out as a mixed stand rather than a row of clones.
const HORSESHOE_MIN_CLEAR = 30;    // metres of empty radius demanded before a dead end is planted
const HORSESHOE_SPACING = 4.5;     // along the arc; a stand, not a hedge
const HORSESHOE_SPAN = 2.3;        // radians of arc, ~130 degrees each side of the outbound bearing

/** The empty radius around a point: distance to the nearest building corner or other carriageway. */
function clearRadius(world, x, y, skipEdgeIds, cap = 80) {
  let clear = cap;
  for (const b of world.grid.near(x, y, cap)) {
    for (const [bx, by] of b.pts) {
      const d = Math.hypot(bx - x, by - y);
      if (d < clear) clear = d;
    }
  }
  for (const e of world.edges) {
    if (skipEdgeIds.includes(e.id)) continue;
    for (const [px, py] of e.pts) {
      const d = Math.hypot(px - x, py - y) - e.width / 2;
      if (d < clear) clear = d;
    }
  }
  return clear;
}

function deadEndHorseshoes(world, siting) {
  const byId = new Map(world.edges.map(e => [e.id, e]));
  const out = [];
  let planted = 0, skippedTight = 0;
  for (const n of world.nodes) {
    if (!n.edges || n.edges.length !== 1) continue;         // degree 1 is a true dead end
    const e = byId.get(n.edges[0]);
    if (!e) continue;
    const clear = clearRadius(world, n.x, n.y, n.edges);
    if (clear < HORSESHOE_MIN_CLEAR) { skippedTight++; continue; }

    // Outbound bearing: away from the road, along the last segment of the edge that touches this node.
    const atStart = Math.hypot(e.pts[0][0] - n.x, e.pts[0][1] - n.y) <
                    Math.hypot(e.pts[e.pts.length - 1][0] - n.x, e.pts[e.pts.length - 1][1] - n.y);
    const tip = atStart ? e.pts[0] : e.pts[e.pts.length - 1];
    const back = atStart ? e.pts[1] : e.pts[e.pts.length - 2];
    const bearing = Math.atan2(tip[1] - back[1], tip[0] - back[0]);

    // Radius: clear of the turning head, and never wider than the room actually measured.
    const r = Math.min(clear - 3, Math.max(9, e.width / 2 + 6));
    const step = HORSESHOE_SPACING / r;                      // radians per tree at this radius
    for (let a = -HORSESHOE_SPAN; a <= HORSESHOE_SPAN + 1e-6; a += step) {
      const tx = n.x + Math.cos(bearing + a) * r, ty = n.y + Math.sin(bearing + a) * r;
      if (world.onRoad(tx, ty, 1.0)) continue;               // never in the lane it is closing off
      if (inFootprint(world, tx, ty)) continue;
      if (siting && !siting.plantable(tx, ty)) continue;     // nor in the river, nor on a bus shelter
      out.push([tx, ty]);
    }
    planted++;
  }
  console.info(`dead ends: ${planted} planted with a horseshoe, ${skippedTight} too tight ` +
               `(under ${HORSESHOE_MIN_CLEAR}m clear), ${out.length} trees added`);
  window.__props = Object.assign(window.__props ?? {}, {horseshoes: planted, horseshoeTrees: out.length});
  return out;
}

function buildStreetFurniture(world) {
  // Hydrants join the roster on the same footing as the other kinds rather than getting a placement
  // pass of their own: a hydrant stands exactly where a bollard or a bin stands, a metre or so onto
  // the pavement off a street with frontage, and one shared walk to a clear spot (`propSpot`) is the
  // only thing in this file that knows how to find one.
  const KINDS = ['bollard', 'bollard', 'bin', 'bench', 'planter', 'bike', 'sign', 'shelter', 'hydrant'];
  const LIT = new Set(['primary', 'secondary', 'tertiary', 'residential', 'pedestrian']);
  const sites = {bollard: [], bin: [], bench: [], planter: [], bike: [], sign: [], shelter: [], hydrant: []};
  let dropped = 0, nudged = 0;
  for (const e of world.edges) {
    if (!LIT.has(e.kind)) continue;
    let acc = 0, side = 1;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [x1, y1] = e.pts[i], [x2, y2] = e.pts[i + 1];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      let d = 40 - acc;
      while (d < len) {
        const px = x1 + dx / len * d, py = y1 + dy / len * d;
        const base = e.width / 2 + 1.4;                         // just onto the pavement
        const nx = -dy / len, ny = dx / len;
        const spot = propSpot(world, e, px, py, nx, ny, side, base);
        if (!spot) { dropped++; side = -side; d += 40; continue; }
        const [sx, sy, s] = spot;
        if (s !== side || Math.hypot(sx - (px + nx * base * side), sy - (py + ny * base * side)) > 0.01) nudged++;
        const kind = KINDS[Math.floor(pseudo(sx * 0.5 + sy * 0.3) * KINDS.length) % KINDS.length];
        // shelters and benches want a bit of clearance; only on wider streets
        if ((kind === 'shelter' || kind === 'bench') && e.width < 8) { d += 40; side = -side; continue; }
        // yaw so the prop's +Z front faces the street (toward the carriageway centre)
        sites[kind].push([sx, sy, Math.atan2(-dx * s, dy * s)]);
        side = -side;
        d += 40;
      }
      acc = (acc + len) % 40;
    }
  }
  const placed = Object.values(sites).reduce((n, a) => n + a.length, 0);
  const byKind = Object.fromEntries(Object.entries(sites).map(([k, a]) => [k, a.length]));
  console.info(`street furniture: ${placed} placed, ${nudged} moved clear of a carriageway, ` +
               `${dropped} dropped as hemmed in — ` +
               Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', '));
  window.__props = Object.assign(window.__props ?? {}, {furniture: {placed, nudged, dropped, byKind}});
  const out = [];
  const props = [];
  // The kind travels WITH the geometry. The editor has to be able to say "Bench 12" rather than
  // "instance 12 of an unnamed mesh", and only this function knows which pile of matrices is benches.
  //
  // `shatters` names the parts that do NOT survive the prop being knocked over — the shelter's glass —
  // by their index in the factory's part list. They get a zero-scale matrix while the frame topples,
  // which is what a shelter losing its panes looks like for the price of one matrix write.
  const wire = (arr, factory, kind, propKind = null, shatters = []) => {
    if (!arr.length) return;
    const built = factory(arr.length);
    arr.forEach(([sx, sy, rot], i) => built.setAt(i, sx, -sy, rot, groundHeight(sx, -sy)));   // world Z = -y; seat on terrain
    built.mesh.traverse((o) => { o.userData.kind = kind; });
    out.push(built.mesh);
    if (!propKind) return;
    const parts = built.mesh.isInstancedMesh ? [built.mesh]
      : built.mesh.children.filter(o => o.isInstancedMesh);
    const glass = shatters.map(n => parts[n]).filter(Boolean);
    const frame = parts.filter(p => !glass.includes(p));
    arr.forEach(([sx, sy, rot], i) => props.push({
      x: sx, y: sy, kind: propKind,
      ref: {topple: frame, hide: glass, glow: null,
            i, x: sx, y: groundHeight(sx, -sy), z: -sy, rotY: rot, scale: 1},
    }));
  };
  // The propKind column is the whole destructibility policy for the furniture layer, and the two
  // blanks are deliberate. A bollard and a planter are street ARMOUR — stopping a vehicle without
  // moving is the entire reason a city installs them — so they collide and they hold. Everything else
  // here is sheet metal, wood or glass on a thin post, and a car that hits one properly takes it with
  // it. `PROP_KINDS` in src/world/model.js sets what "properly" means in energy for each.
  wire(sites.bollard, makeBollards, 'Bollard', 'bollard');
  wire(sites.bin, makeBins, 'Bin', 'bin');
  wire(sites.bench, makeBenches, 'Bench', 'bench');
  wire(sites.planter, makePlanters, 'Planter', 'planter');
  wire(sites.bike, makeBikeRacks, 'Bike rack', 'bike');
  wire(sites.sign, makeSignPosts, 'Sign', 'sign');
  wire(sites.shelter, makeShelters, 'Shelter', 'shelter', [4]);   // part 4 is the glazing
  wire(sites.hydrant, makeHydrants, 'Hydrant', 'hydrant');
  return {meshes: out, props};
}

/**
 * The outside handle on destructibility, hung on `window.game.destruction`.
 *
 * Destruction is the one feature in this project that cannot be checked by looking at a still: a
 * screenshot of a street shows trees, not whether those trees have health, and a screenshot of a
 * stump does not say how hard you had to hit it. So the whole thing is queryable and drivable from
 * outside — `census()` counts what is standing, `find()` picks a target by kind and toughness, and
 * `hit()` applies a blow of a stated energy through exactly the path a car takes. That is what
 * tools/probe.mjs talks to, and it is also how the frame-by-frame shooter aims.
 *
 * Nothing here is used by the game itself. It is deliberately a thin skin over the point grid rather
 * than a second copy of any of its logic: a test that measures its own private arithmetic measures
 * nothing.
 */
function exposeDestruction(world, destruction) {
  const grid = world.obstacles;
  const api = {
    /** The policy table: radius, health and break energy per kind. */
    kinds: PROP_KINDS,
    /** Cumulative, from the renderer's side: {felled, scarred, chunksSpawned}. */
    stats: destruction.stats,
    /** Every registered prop by kind — totals, how many are still up, the hp range within the kind. */
    census: () => grid.census(),
    total: () => grid.items.length,
    standing: () => grid.standing(),
    /** Something to drive at. Map coordinates; see `PointGrid.nearest` for the options. */
    find: (x, y, opts) => grid.nearest(x, y, opts),
    /** A prop as plain data — its `ref` holds Three objects and will not cross a CDP boundary. */
    plain: (p) => p && {x: p.x, y: p.y, kind: p.kind, r: p.r, hp: p.hp,
                        breakEnergy: p.breakEnergy, broken: p.broken},
    /**
     * Hit a prop without a car, at a stated energy (m/s squared — the square of the closing speed).
     * The same entry point `resolveObstacles` uses, so the health arithmetic, the event queue and the
     * topple are the real ones and only the collision detection is skipped. Returns whether this blow
     * felled it.
     */
    hit(p, energy, dirX = 1, dirY = 0) {
      const len = Math.hypot(dirX, dirY) || 1;
      return grid.hit(p, energy, dirX / len, dirY / len);
    },
  };
  window.__destruction = api;
  // window.game is assembled at the END of main.js, long after createScene has returned, so there is
  // nothing to hang this on yet. A macrotask lands after the whole module body however main.js is
  // laid out, which a microtask would stop doing the day somebody puts an await between the two.
  setTimeout(() => { if (window.game) window.game.destruction = api; }, 0);
}

// The 226 mapped lamps are real but sparse — mostly the bridge and the boulevards. A night
// city needs rhythm on every street the player drives, so major unlit roads get synthetic
// lamps every ~32m, alternating sides. Real positions are kept exactly; synthesis only fills
// where the survey is silent.
function augmentLamps(world) {
  // The 226 mapped lamps get the same treatment as the mapped trees: a real lamp standing in our
  // invented carriageway is moved to the kerb rather than deleted. This one matters more than a
  // tree, because lamps are in the obstacle grid and the car stops dead against them.
  const lampStats = {kept: 0, moved: 0, dropped: 0};
  const out = [];
  for (const [lx0, ly0] of world.lamps) {
    if (!world.onRoad(lx0, ly0, PROP_CLEAR)) { lampStats.kept++; out.push([lx0, ly0]); continue; }
    const spot = shoveClear(world, lx0, ly0);
    if (spot) { lampStats.moved++; out.push(spot); } else lampStats.dropped++;
  }
  // service and unclassified were missing, which left whole yards, lanes and back streets unlit —
  // they are streets, and a street with no lamp on it is a hole in the city at night.
  const LIT_KINDS = new Set(['primary', 'secondary', 'tertiary', 'residential', 'living_street',
                             'pedestrian', 'service', 'unclassified']);
  const near = (x, y, r2) => out.some(l => (l[0] - x) ** 2 + (l[1] - y) ** 2 < r2);
  // Denser than before (22m rather than 32m) and alternating sides so a driven street gets an
  // unbroken chain of pools rather than dark gaps between them — the roads were reading as black.
  for (const e of world.edges) {
    if (!LIT_KINDS.has(e.kind)) continue;
    let acc = 0, side = 1;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [x1, y1] = e.pts[i], [x2, y2] = e.pts[i + 1];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      let d = 22 - acc;
      while (d < len) {
        const px = x1 + dx / len * d, py = y1 + dy / len * d;
        // A lamp post is the worst thing on this list to leave in a lane: it is in the obstacle grid,
        // so the car does not drive through it, it stops dead against a column standing on the
        // tarmac. Same clearance walk as the furniture.
        const spot = propSpot(world, e, px, py, -dy / len, dx / len, side, e.width / 2 + 0.6);
        if (spot && !near(spot[0], spot[1], 13 * 13)) { out.push([spot[0], spot[1]]); side = -side; }
        d += 22;
      }
      acc = (acc + len) % 22;
    }
  }
  // Light the STAIRCASES. Luxembourg's montées and the river-valley steps are where the street
  // network simply stops, so lamp augmentation that only follows roads leaves the Grund and the
  // Alzette valley pitch dark — reported from in-game four times along one stretch of it. These are
  // real mapped stairways, and a real one is lit.
  for (const pts of (world.steps ?? [])) {
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      let d = 16 - acc;
      while (d < len) {
        const px = x1 + dx / len * d, py = y1 + dy / len * d;
        // A flight of steps can run beside, under or across a street, so the 1.8 m offset lands in a
        // lane often enough to matter. Shove it clear rather than skipping the lamp: the Grund going
        // dark again is the fault this loop exists to fix.
        const cand = shoveClear(world, px - dy / len * 1.8, py + dx / len * 1.8);
        if (cand && !near(cand[0], cand[1], 12 * 12)) out.push(cand);
        d += 16;
      }
      acc = (acc + len) % 16;
    }
  }

  // Light the RIVER BANKS. The Alzette valley — the Grund and Clausen — has no road network down in
  // it, so road-following lamps leave the whole valley floor black; four reports came from one
  // stretch of it. The real quays down there are lit, and the river geometry is the only thing that
  // follows the valley, so the bank line is exactly the right place to hang the lamps. Clipped to
  // the world bounds, since the river runs far past the slice.
  const b2 = world.bounds;
  for (const poly of (world.water ?? [])) {
    let acc = 0;
    for (let i = 0; i < poly.length - 1; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[i + 1];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      if (len > 400) continue;                       // a ring that jumps the map is not a bank
      let d = 26 - acc;
      while (d < len) {
        const cand = shoveClear(world, x1 + dx / len * d, y1 + dy / len * d);
        if (cand) {
          const [lx, ly] = cand;
          if (lx > b2.minX && lx < b2.maxX && ly > b2.minY && ly < b2.maxY && !near(lx, ly, 20 * 20)) {
            out.push([lx, ly]);
          }
        }
        d += 26;
      }
      acc = (acc + len) % 26;
    }
  }

  // Light the RESPAWN area properly. The player always respawns on the big street nearest the slice
  // centre (main.js spawnPoint picks it by midpoint distance from the origin), and arriving there at
  // night into near-darkness is a bad first frame. Rather than duplicate that selection logic, light
  // every street within reach of the origin at double density — wherever the spawn lands inside that
  // circle, it lands lit.
  const SPAWN_R = 150, SPAWN_SPACING = 11;
  for (const e of world.edges) {
    if (!LIT_KINDS.has(e.kind)) continue;
    let acc = 0, side = 1;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [x1, y1] = e.pts[i], [x2, y2] = e.pts[i + 1];
      if (Math.hypot(x1, y1) > SPAWN_R && Math.hypot(x2, y2) > SPAWN_R) continue;
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      let d = SPAWN_SPACING - acc;
      while (d < len) {
        const px = x1 + dx / len * d, py = y1 + dy / len * d;
        const spot = propSpot(world, e, px, py, -dy / len, dx / len, side, e.width / 2 + 0.6);
        if (spot && Math.hypot(spot[0], spot[1]) < SPAWN_R && !near(spot[0], spot[1], 6 * 6)) {
          out.push([spot[0], spot[1]]); side = -side;
        }
        d += SPAWN_SPACING;
      }
      acc = (acc + len) % SPAWN_SPACING;
    }
  }
  console.info(`mapped lamps: ${lampStats.kept} clear, ${lampStats.moved} moved off a carriageway, ` +
               `${lampStats.dropped} unfreeable; ${out.length} lamps in total after synthesis`);
  window.__props = Object.assign(window.__props ?? {}, {lamps: lampStats, lampTotal: out.length});
  return out;
}

function buildLamps(lamps) {
  const pole = new THREE.CylinderGeometry(0.07, 0.1, 7.5, 5); pole.translate(0, 3.75, 0);
  const inst = new THREE.InstancedMesh(pole, new THREE.MeshLambertMaterial({color: 0x2b2f36}), lamps.length);
  const m = new THREE.Matrix4();
  lamps.forEach((p, i) => { m.makeTranslation(p[0], groundHeight(p[0], -p[1]), -p[1]); inst.setMatrixAt(i, m); });

  const pos = new Float32Array(lamps.length * 3);
  lamps.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = groundHeight(p[0], -p[1]) + 7.6; pos[i * 3 + 2] = -p[1]; });
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // Round soft sprites via shader — PointsMaterial without a map draws SQUARES, which at
  // close range became huge white billboards. Size in pixels, clamped, radial falloff.
  const glowMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {uOpacity: {value: 0}},
    vertexShader: `void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = clamp(900.0 / -mv.z, 2.0, 26.0);
      gl_Position = projectionMatrix * mv;
    }`,
    fragmentShader: `uniform float uOpacity;
      void main(){
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = pow(max(1.0 - d, 0.0), 2.2) * uOpacity;
        gl_FragColor = vec4(1.0, 0.76, 0.45, a);
      }`,
  });
  const glows = new THREE.Points(pg, glowMat);

  // Warm pools on the tarmac: one instanced disc per lamp, radial gradient, additive.
  // This is what makes night streets read as LIT — zero real lights involved.
  const disc = new THREE.CircleGeometry(9.5, 20); disc.rotateX(-Math.PI / 2);
  const poolMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {uNight: {value: 0}},
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uNight; varying vec2 vUv;
      void main(){
        float d = length(vUv - 0.5) * 2.0;
        // brighter core, wider spill (falloff 1.4 not 1.8) so pools overlap into a continuous
        // lit ribbon down the street rather than isolated bright spots on black tar.
        float a = pow(max(1.0 - d, 0.0), 1.4) * 0.62 * uNight;
        gl_FragColor = vec4(1.0, 0.74, 0.42, a);
      }`,
  });
  inst.userData.kind = 'Lamp';
  const pools = new THREE.InstancedMesh(disc, poolMat, lamps.length);
  // Pool sits a bit higher above the tarmac now that roads DRAPE terrain: a flat horizontal disc on
  // a sloped road z-fights/hides at 6cm; 0.25m clears the incline and, being additively blended, still
  // reads as a warm glow pooled on the road rather than a floating disc.
  lamps.forEach((p, i) => { m.makeTranslation(p[0], groundHeight(p[0], -p[1]) + 0.25, -p[1]); pools.setMatrixAt(i, m); });

  // Lamps that have been knocked down. Only three of these columns ever carry a real PointLight, and
  // the three are chosen by proximity to the car — so a flattened lamp is exactly the one the player
  // is standing next to, and it would go on casting the only true light on the street from the spot
  // its head used to occupy.
  const downed = new Set();

  // nearest-N by linear scan once a frame — even augmented (~1-2k lamps) this is trivial.
  const nearest = (p, n) => lamps
    .map((lp, i) => [lp, (lp[0] - p.x) ** 2 + (-lp[1] - p.z) ** 2, i])
    .filter(x => !downed.has(x[2]))
    .sort((a, b) => a[1] - b[1]).slice(0, n).map(x => x[0]);

  // Physics props, one per drawn lamp. The column TOPPLES (its geometry is based at the pavement, so
  // a rotation about the instance origin swings it into the gutter), while everything that is not the
  // column goes out: the light pool on the tarmac is zero-scaled, the glow sprite eight metres up is
  // sunk out of the world, and the real light is taken off the roster above. A lamp lying flat that
  // is still lighting the street from where its head used to be would give the whole trick away.
  const props = lamps.map((p, i) => ({
    x: p[0], y: p[1], kind: 'lamp',
    ref: {topple: [inst], hide: [pools], glow: {attr: pg.attributes.position, i},
          i, x: p[0], y: groundHeight(p[0], -p[1]), z: -p[1], rotY: 0, scale: 1},
  }));
  return {poles: inst, glows, pools, nearest, props, downed};
}

function mergeGeoms(geoms) {
  // minimal non-indexed merge — three's example module not imported to keep deps at zero
  const nonIndexed = geoms.map(g => g.toNonIndexed());
  const total = nonIndexed.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), norm = new Float32Array(total * 3);
  let o = 0;
  for (const g of nonIndexed) {
    pos.set(g.attributes.position.array, o * 3);
    norm.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  return out;
}

// =============================================================================================
// PARCELS. The land itself, cut from the road centrelines by tools/parcels.mjs and baked into
// city.json. They tile the map with no gaps, so every square metre belongs to exactly one, and they
// sit just BELOW the tarmac — the road, its pavements and everything else paint over them. That is
// the whole trick: a parcel runs to the middle of the street that bounds it, like a real cadastre,
// and the covering hides the half that is road.
//
// Every parcel is always in the scene even when its terrain is None, because an invisible parcel
// still has to be clickable: raycasting ignores alpha, so a fully transparent face is picked exactly
// like a painted one. That is why terrain lives in the vertex COLOUR (rgba) rather than in
// visibility — turning a parcel off must not remove it from the ray's path.
//
// Tiled for the same reason everything else is: one merged mesh per 260m square, so the frustum test
// can throw away the ones you are not looking at.
const PARCEL_Y = 0.015;        // under the tarmac's 0.02, over the ground's -0.05
const TERRAIN = {
  none: [0, 0, 0, 0],
  grass: [0.29, 0.48, 0.25, 1],
  concrete: [0.60, 0.59, 0.56, 1],
};

function buildParcels(world) {
  const group = new THREE.Group();
  group.name = 'parcels';
  const list = world.parcels ?? [];
  const reg = new Map();        // id -> {mesh, vStart, vCount, terrain, bevel}
  if (!list.length) return {group, reg, setTerrain: () => {}, bevel: () => {}, info: () => null};

  const tiles = new Map();
  for (const p of list) {
    const k = `${Math.floor(p.c[0] / TILE)}:${Math.floor(p.c[1] / TILE)}`;
    const bucket = tiles.get(k);
    if (bucket) bucket.push(p); else tiles.set(k, [p]);
  }

  for (const bucket of tiles.values()) {
    const pos = [], col = [], idx = [];
    const faceParcel = [];      // triangle index -> parcel id, which is how a click resolves
    let v = 0;
    for (const p of bucket) {
      // ShapeUtils wants a simple contour; a parcel is exactly that, concave or not.
      const contour = p.pts.map(([x, y]) => new THREE.Vector2(x, y));
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { tris = []; }
      if (!tris.length) continue;
      const vStart = v;
      const c = TERRAIN.none;
      for (const q of contour) {
        pos.push(q.x, PARCEL_Y, -q.y);
        col.push(c[0], c[1], c[2], c[3]);
        v++;
      }
      for (const [a, b, cc] of tris) {
        idx.push(vStart + a, vStart + b, vStart + cc);
        faceParcel.push(p.id);
      }
      reg.set(p.id, {vStart, vCount: contour.length, terrain: 'none', bevel: 0, parcel: p});
    }
    if (!idx.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
      vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false,
    }));
    mesh.userData.faceParcel = faceParcel;
    mesh.userData.isParcelLayer = true;
    mesh.userData.painted = 0;
    mesh.receiveShadow = true;
    // A tile with nothing painted on it is not DRAWN. Transparent, double-sided, depth-write-off
    // geometry covering every square metre of the map costs a lot of blending for pixels that are
    // fully see-through: keeping it drawn took the frame from 61fps to 34. Raycasting does not care
    // about visibility — the picker looks past the flag for this layer specifically — so an unpainted
    // tile stays perfectly clickable while costing nothing at all.
    mesh.visible = false;
    group.add(mesh);
    for (const p of bucket) { const e = reg.get(p.id); if (e) e.mesh = mesh; }
  }

  /** Paint a parcel. Rewrites its own vertices' colour and nothing else's. */
  function setTerrain(id, kind) {
    const e = reg.get(id);
    if (!e || !e.mesh) return false;
    const c = TERRAIN[kind] ?? TERRAIN.none;
    const attr = e.mesh.geometry.attributes.color;
    for (let i = 0; i < e.vCount; i++) attr.setXYZW(e.vStart + i, c[0], c[1], c[2], c[3]);
    attr.needsUpdate = true;
    const was = e.terrain !== 'none', now = kind !== 'none';
    if (was !== now) e.mesh.userData.painted += now ? 1 : -1;
    e.mesh.visible = e.mesh.userData.painted > 0;
    e.terrain = kind;
    return true;
  }

  /** Raise or lower a parcel. Lifting it above the tarmac is how a raised lawn reads. */
  function bevel(id, delta) {
    const e = reg.get(id);
    if (!e || !e.mesh) return false;
    const attr = e.mesh.geometry.attributes.position;
    for (let i = 0; i < e.vCount; i++) attr.setY(e.vStart + i, attr.getY(e.vStart + i) + delta);
    attr.needsUpdate = true;
    e.mesh.geometry.computeBoundingSphere();
    e.bevel = +(e.bevel + delta).toFixed(3);
    return true;
  }

  const info = (id) => {
    const e = reg.get(id);
    return e ? {id, terrain: e.terrain, bevel: e.bevel, area: e.parcel.area, thin: e.parcel.thin, pts: e.parcel.pts} : null;
  };
  return {group, reg, setTerrain, bevel, info};
}
