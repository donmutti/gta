// Portrait shooter: photograph ONE traffic vehicle close up, three-quarter front, on a plain field.
//
// The city is judged from the air (tools/birdseye.mjs); a VEHICLE cannot be. From the chase camera an
// NPC car is thirty pixels of coloured shell at a bad angle, and the things that actually go wrong
// with it — a greenhouse too wide for the shoulders, a roof that reads as a slab, a body that dies
// into a flat deck at the tail — only show at the classic front-three-quarter, close, from a little
// above the roof. That is the one shot a reviewer (human or Gemini) can grade, so this tool takes it
// and nothing else.
//
// Two mechanics are copied from birdseye because they are what make an in-page screenshot possible:
// the frame loop owns game.camera and overwrites anything written to it within 16ms, so the shot is
// rendered through a SECOND camera of this tool's own and pulled off the canvas with toDataURL in the
// same synchronous block; and the headless Chrome is killed on process exit no matter how we leave,
// because leaked Chromes were this project's main resource leak.
//
// Everything the in-page block does — moving the chosen instance to the origin, hiding the rest of
// the world, dropping the fog — is undone before it returns. The simulation cannot observe any of it:
// one JS turn starts and finishes between two frames.
//
// Run (dev server on :5199 must already be up):
//   node tools/portrait.mjs --body van --out /tmp/van.png
//   node tools/portrait.mjs --body bus --size 1600 --az 55 --el 22 --out /tmp/bus.png
//
// Note on what is in the frame: makeCarFleet builds THREE InstancedMeshes per body type — body
// (paint, per-instance colour), trim (glass/lamps/bumpers, vertex-coloured) and wheels (four
// instances per vehicle). The portrait shows all three, so wheel fit and arch clearance can be
// judged from it; only the wheels' roll angle is whatever the simulation last set.
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import net from 'node:net';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};

const BODY = arg('body', 'car');
// Midday by default: a high sun with no coloured cast is the cleanest light to read a surface in.
// Late light looks better and hides exactly the flat spots we are hunting for.
const HOUR = Number(arg('hour', 12));
const SIZE = Number(arg('size', 1280));
const OUT = arg('out', `/tmp/portrait-${BODY}.png`);
const URL = arg('url', 'http://localhost:5199');
// Framing. az is degrees off the nose toward the vehicle's left, el is degrees above the horizontal
// through the body's centre — 40/15 is the standard press three-quarter. dist empty means auto-fit.
const AZ = Number(arg('az', 40));
const EL = Number(arg('el', 15));
const DIST = arg('dist', null);
// Paint and backdrop. A mid-saturation red on flat neutral grey: the paint shows shading across a
// panel where white blows out and black hides everything, and the grey gives the silhouette a clean
// edge without a horizon line or a building cutting through the roof.
const PAINT = arg('paint', '0xb1362f');
const BG = arg('bg', '0x8e949c');

// Body types, keyed as in BODIES in src/render/car.js. Kept here as MEASUREMENTS, not as a name list,
// because BODIES is module-private: the only way to tell which InstancedMesh in the scene is the van
// is to measure its hull and match. len/top/hw are the hull geometry's z-extent, top rail and half
// width; cab is the greenhouse's top. car and wagon differ by 0.02/0.04 here, which is plenty when
// the geometry is generated from a table (the match is exact to float precision), and if car.js is
// re-proportioned the match fails loudly with the measured numbers rather than shooting the wrong car.
const SIGS = {
  car:   {len: 4.42, top: 1.47, hw: 1.07, cab: 1.44},
  van:   {len: 4.70, top: 1.91, hw: 1.10, cab: 1.86},
  bus:   {len: 10.05, top: 2.96, hw: 1.41, cab: 2.90},
  wagon: {len: 4.62, top: 1.55, hw: 1.07, cab: 1.50},
};
if (!SIGS[BODY]) {
  console.error(`portrait: unknown body "${BODY}" — expected one of ${Object.keys(SIGS).join(', ')}`);
  process.exit(1);
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9800 + Math.floor(process.pid % 90);
// A 16:9 window, unlike birdseye's square: every one of these bodies is long and low, and a square
// frame spends half its height on empty backdrop.
const W = SIZE, H = Math.round(SIZE * 9 / 16);

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle', '--use-angle=metal',
  '--ignore-gpu-blocklist', '--enable-webgl', `--window-size=${W},${H}`,
  '--no-first-run', `--user-data-dir=/tmp/portrait-${PORT}`, 'about:blank',
], {stdio: 'ignore'});
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch { /* already gone */ } });

const waitPort = (p) => new Promise((res, rej) => {
  let n = 0;
  const t = setInterval(() => {
    const s = net.connect(p, '127.0.0.1');
    s.on('connect', () => { s.destroy(); clearInterval(t); res(); });
    s.on('error', () => { s.destroy(); if (++n > 100) { clearInterval(t); rej(new Error('no devtools')); } });
  }, 100);
});
const rpc = (ws, id, m, p) => new Promise(r => {
  const h = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', h); r(x.result); } };
  ws.addEventListener('message', h); ws.send(JSON.stringify({id, method: m, params: p}));
});

const die = (msg) => { console.error(msg); chrome.kill(); process.exit(1); };
// A page exception inside an evaluate comes back as a result, not a throw, and the next step then
// fails on a confusing undefined. Check every call.
const evalOr = async (ws, id, expression) => {
  const r = await rpc(ws, id, 'Runtime.evaluate', {returnByValue: true, awaitPromise: true, expression});
  if (r?.exceptionDetails) {
    const e = r.exceptionDetails;
    die(`portrait: the page threw — ${e.exception?.description || e.text || 'unknown error'}`);
  }
  return r?.result?.value;
};

try {
  await waitPort(PORT);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${URL}`, {method: 'PUT'})).json();
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 1;
  await rpc(ws, id++, 'Runtime.enable');

  // The city takes ten-plus seconds to build in dev. Wait for the game rather than guessing a sleep.
  let booted = false;
  for (let i = 0; i < 160; i++) {
    await new Promise(r => setTimeout(r, 250));
    const r = await rpc(ws, id++, 'Runtime.evaluate', {expression: 'typeof window.game', returnByValue: true});
    if (r.result?.value === 'object') { booted = true; break; }
  }
  if (!booted) die(`portrait: window.game never booted — is the dev server up on ${URL}?`);

  // Freeze the clock through __forceHours rather than setHours: the loop advances gameHours every
  // frame, so a one-off set has drifted by the time the shot is taken a couple of seconds later.
  // __forceHours alone is NOT enough: it is applied inside the loop's un-paused branch, and a
  // headless page that never took focus can sit paused at the 20:24 start hour, which shot every
  // body in blue-hour light and made a mid-grey car render near-black. setHours writes the clock
  // directly, so send both and let whichever one the loop honours win.
  await evalOr(ws, id++, `window.__forceHours = ${HOUR}; window.game.setHours && window.game.setHours(${HOUR});`);
  // One second of frames so the day-night mix, the sun and the traffic placement settle at that hour.
  await new Promise(r => setTimeout(r, 1200));

  const shot = await evalOr(ws, id++, `(() => {
    const {THREE, scene, renderer} = window.game;
    const sig = ${JSON.stringify(SIGS[BODY])};
    const el = renderer.domElement;
    const near = (a, b) => Math.abs(a - b) < 0.03;

    // Find the fleet's hull mesh for this body by measuring every InstancedMesh in the scene. The
    // fleet group is not exposed on game.traffic (it is a closure variable behind setVisible), and
    // pedestrians and pigeons are instanced too, so structure tells us nothing and geometry tells us
    // everything.
    const box = new THREE.Box3();
    const dims = (m) => {
      box.setFromBufferAttribute(m.geometry.attributes.position);
      return {len: box.max.z - box.min.z, top: box.max.y, hw: box.max.x, min: box.min.y};
    };
    const hits = [];
    scene.traverse(o => {
      if (!o.isInstancedMesh) return;
      const d = dims(o);
      if (near(d.len, sig.len) && near(d.top, sig.top) && near(d.hw, sig.hw)) hits.push(o);
    });
    if (hits.length !== 1) {
      const seen = [];
      scene.traverse(o => { if (o.isInstancedMesh) { const d = dims(o); seen.push(d.len.toFixed(2) + 'x' + d.top.toFixed(2) + 'x' + d.hw.toFixed(2)); } });
      return {error: 'found ' + hits.length + ' hull meshes matching ${BODY} (len ' + sig.len + ', top ' + sig.top +
        ', halfwidth ' + sig.hw + '); instanced meshes in the scene measure ' + seen.join(', ') +
        ' — has BODIES in src/render/car.js been re-proportioned?'};
    }
    const hull = hits[0];
    if (!hull.count) return {error: 'the ${BODY} hull mesh carries no instances — the fleet allocated none'};

    // The greenhouse is the hull's next sibling: makeCarFleet does group.add(hulls, cabins) per type.
    // Verified by instance count and by the cabin's own roof height, so a reordering is caught.
    const sibs = hull.parent.children;
    const cabin = sibs[sibs.indexOf(hull) + 1];
    if (!cabin?.isInstancedMesh || cabin.count !== hull.count || !near(dims(cabin).top, sig.cab)) {
      return {error: 'the ${BODY} hull has no matching greenhouse mesh beside it — makeCarFleet pairing changed'};
    }

    // The wheels are the third mesh of the trio (makeCarFleet adds body, trim, wheels) and carry
    // four instances per vehicle. They are placed in WORLD space by setAt, not parented to the
    // body, so to move vehicle 0 to the origin we first recover each wheel's transform RELATIVE
    // to its body — inverse(body) * wheel — and then reuse it as-is, the body's new matrix being
    // the identity. That needs no knowledge of the track or the axle stations.
    let wheels = sibs[sibs.indexOf(hull) + 2];
    if (!wheels?.isInstancedMesh || wheels.count !== hull.count * 4) wheels = null;
    const wlocal = [];
    if (wheels) {
      const m0 = new THREE.Matrix4(), inv = new THREE.Matrix4();
      hull.getMatrixAt(0, m0); inv.copy(m0).invert();
      for (let k = 0; k < 4; k++) {
        const wm = new THREE.Matrix4();
        wheels.getMatrixAt(k, wm);
        wlocal.push(new THREE.Matrix4().multiplyMatrices(inv, wm));
      }
      const p = wlocal.map(m => new THREE.Vector3().setFromMatrixPosition(m));
      if (p[0].distanceTo(p[3]) < 0.2) wheels = null;   // never placed — all four still at origin
    }

    // --- everything below is restored before returning -----------------------------------------
    const savedH = hull.instanceMatrix.array.slice();
    const savedC = cabin.instanceMatrix.array.slice();
    const savedW = wheels ? wheels.instanceMatrix.array.slice() : null;
    const savedCol = hull.instanceColor ? hull.instanceColor.array.slice() : null;
    const savedVis = [];
    const hide = (o) => { savedVis.push([o, o.visible]); o.visible = false; };
    const show = (o) => { savedVis.push([o, o.visible]); o.visible = true; };
    const savedFog = scene.fog, savedBg = scene.background;

    // Park every instance of this body far away except local 0, which goes to the origin facing +z
    // (the model's nose). Traffic parks its own culled cars at 1e6 the same way.
    const m = new THREE.Matrix4();
    for (let i = 1; i < hull.count; i++) {
      m.identity().setPosition(1e6, 1e6, 1e6);
      hull.setMatrixAt(i, m); cabin.setMatrixAt(i, m);
    }
    m.identity();
    hull.setMatrixAt(0, m); cabin.setMatrixAt(0, m);
    hull.instanceMatrix.needsUpdate = true; cabin.instanceMatrix.needsUpdate = true;
    if (wheels) {
      for (let i = 4; i < wheels.count; i++) { m.identity().setPosition(1e6, 1e6, 1e6); wheels.setMatrixAt(i, m); }
      for (let k = 0; k < 4; k++) wheels.setMatrixAt(k, wlocal[k]);
      wheels.instanceMatrix.needsUpdate = true;
    }
    if (hull.instanceColor) {
      hull.setColorAt(0, new THREE.Color(${Number(PAINT)}));
      hull.instanceColor.needsUpdate = true;
    }

    // A plain field: hide every drawable in the scene except our two meshes. Only LEAVES are hidden,
    // never the groups above them — the renderer skips an invisible object's whole subtree, so
    // hiding a group that happens to contain a headlight switches that light off. The first attempt
    // hid top-level subtrees and spared any that held a light, which left the hero car and the police
    // cars (their headlights are real lights) parked in the corner of the frame.
    const drawable = (o) => o.isMesh || o.isInstancedMesh || o.isPoints || o.isLine || o.isSprite;
    scene.traverse(o => { if (o !== hull && o !== cabin && o !== wheels && drawable(o) && o.visible) hide(o); });
    for (let p = hull.parent; p && p !== scene; p = p.parent) show(p);  // traffic.setVisible may have
    show(hull); show(cabin); if (wheels) show(wheels);                  // switched the fleet off
    scene.fog = null;
    scene.background = new THREE.Color(${Number(BG)});

    let png = null, info = null;
    try {
      const b = new THREE.Box3().setFromBufferAttribute(hull.geometry.attributes.position);
      b.union(new THREE.Box3().setFromBufferAttribute(cabin.geometry.attributes.position));
      const target = b.getCenter(new THREE.Vector3());
      // Fit to the actual vertices, not to the bounding box: at a three-quarter angle the box's
      // corners hang well outside the body's silhouette, and fitting them left the car filling
      // barely half the frame. Both shells together are under a hundred vertices, so project them all.
      const verts = [];
      for (const g of [hull.geometry, cabin.geometry]) {
        const a = g.attributes.position;
        for (let i = 0; i < a.count; i++) verts.push(new THREE.Vector3().fromBufferAttribute(a, i));
      }
      if (wheels) {                        // the tyres reach the ground: fit must include them
        const a = wheels.geometry.attributes.position;
        for (const wm of wlocal) {
          for (let i = 0; i < a.count; i++) {
            const v = new THREE.Vector3().fromBufferAttribute(a, i).applyMatrix4(wm);
            verts.push(v); b.expandByPoint(v);
          }
        }
      }

      // 26° is a short telephoto, the lens a press shot of a car is taken on. At 34° the auto-fit
      // pulled in to under four metres and the near wing ballooned, which is the one thing a
      // proportion shot must not do.
      const cam = new THREE.PerspectiveCamera(26, el.width / el.height, 0.05, 3000);
      const az = ${AZ} * Math.PI / 180, elev = ${EL} * Math.PI / 180;
      // +z is the nose and +x is the body's left, so the front-left quadrant is +x/+z.
      const dir = new THREE.Vector3(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az));
      const fixed = ${DIST === null ? 'null' : Number(DIST)};
      // Auto-fit by measurement, not by trigonometry on a bounding sphere: a bus and a coupe differ
      // enough in shape that a sphere fit leaves one of them tiny. Project every vertex, take the
      // box they occupy on screen, aim at the CENTRE of that box and scale the distance by how much
      // of the frame it uses, then do it again. Aiming at the body's own centre is not enough: seen
      // from above the near-bottom of the car projects much further from the axis than the roof, so
      // a shot centred on the centroid sits low and left with a quarter of the frame empty.
      const FILL = 0.92;
      let dist = fixed ?? b.getSize(new THREE.Vector3()).length();
      const aim = target.clone(), right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
      const place = () => { cam.position.copy(aim).addScaledVector(dir, dist); cam.lookAt(aim); cam.updateMatrixWorld(); cam.updateProjectionMatrix(); };
      place();
      const measure = () => {
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (const v of verts) {
          const p = v.clone().project(cam);
          x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        }
        return {x0, x1, y0, y1, span: Math.max(x1 - x0, y1 - y0) / 2, out: Math.max(-x0, x1, -y0, y1)};
      };
      // Both corrections are DAMPED. Moving the aim point also slides the camera sideways, which
      // changes the perspective that produced the error, so a full-strength correction of both the
      // aim and the distance at once overshot and cropped the tail off the frame.
      for (let i = 0; i < 12; i++) {
        const m = measure();
        const halfH = dist * Math.tan(cam.fov * Math.PI / 360), halfW = halfH * cam.aspect;
        cam.matrixWorld.extractBasis(right, up, fwd);
        aim.addScaledVector(right, (m.x0 + m.x1) / 2 * halfW * 0.7).addScaledVector(up, (m.y0 + m.y1) / 2 * halfH * 0.7);
        if (fixed === null) dist *= 1 + 0.6 * (m.span / FILL - 1);
        place();
      }
      // Whatever the fit settled on, nothing may be cut off: back away until every vertex is inside.
      for (let i = 0; i < 8; i++) {
        const m = measure();
        if (m.out <= 0.99) break;
        dist *= m.out / FILL; place();
      }
      const fill = measure().span;
      renderer.render(scene, cam);
      png = el.toDataURL('image/png');
      const s = b.getSize(new THREE.Vector3());
      info = {dist: +dist.toFixed(2), instances: hull.count, fill: +(fill * 100).toFixed(0),
              size: [+s.z.toFixed(2), +(s.x).toFixed(2), +s.y.toFixed(2)], px: [el.width, el.height]};
    } finally {
      hull.instanceMatrix.array.set(savedH); cabin.instanceMatrix.array.set(savedC);
      hull.instanceMatrix.needsUpdate = true; cabin.instanceMatrix.needsUpdate = true;
      if (savedW) { wheels.instanceMatrix.array.set(savedW); wheels.instanceMatrix.needsUpdate = true; }
      if (savedCol) { hull.instanceColor.array.set(savedCol); hull.instanceColor.needsUpdate = true; }
      for (const [o, v] of savedVis) o.visible = v;
      scene.fog = savedFog; scene.background = savedBg;
    }
    return {png, info};
  })()`);

  if (!shot) die('portrait: the page returned nothing — the shot block did not run');
  if (shot.error) die(`portrait: ${shot.error}`);
  const data = shot.png;
  if (typeof data !== 'string' || !data.startsWith('data:image/png')) die('portrait: the canvas returned no image');
  writeFileSync(OUT, Buffer.from(data.split(',')[1], 'base64'));
  const i = shot.info;
  console.log(`portrait: ${OUT} — ${BODY} (${i.instances} in the fleet), ${i.size[0]}x${i.size[1]}x${i.size[2]}m, ` +
    `camera ${i.dist}m at az ${AZ}° el ${EL}°, ${HOUR}:00, ${i.px[0]}x${i.px[1]}px, fills ${i.fill}% of the frame`);
  chrome.kill();
  process.exit(0);
} catch (e) {
  die(`portrait: harness error — ${e.message}`);
}
