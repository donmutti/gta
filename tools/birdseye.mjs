// Bird's-eye shooter: photograph the running city straight down from a given altitude.
//
// A complaint about the world is almost always a complaint about its LAYOUT — pavements that do not
// follow their road, buildings standing in a carriageway, a junction that wraps wrongly — and from
// inside the car you can see about one street of it at a time. From two hundred metres up the whole
// pattern is in one frame, which is the difference between "this looks messy" and "447 junction
// nodes are stamping a ring where nothing turns".
//
// The trick that makes this work is not fighting the chase camera. The frame loop owns it and will
// overwrite anything written to it within 16ms. So this renders ONE frame through a second camera of
// its own and pulls the canvas straight out with toDataURL, before the loop draws again.
//
// Run (dev server on :5199 must already be up):
//   node tools/birdseye.mjs --x 435 --y -95 --alt 130 --out /tmp/clausen.png
//   node tools/birdseye.mjs --x 435 --y -95 --alt 400 --hour 21 --tilt 35 --size 1600
//
// Coordinates are WORLD MAP metres, the same pair the F3 panel shows, so a shot is reproducible
// from any screenshot the player sends back.
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import net from 'node:net';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};

const X = Number(arg('x', 0));
const Y = Number(arg('y', 0));
const ALT = Number(arg('alt', 150));
// 0 is straight down. Tilting pulls the camera back along +y (south) and looks at the same point,
// which is what you want for a skyline; straight down is what you want for layout.
const TILT = Number(arg('tilt', 0));
const HOUR = arg('hour', null);
const SIZE = Number(arg('size', 1280));
const OUT = arg('out', '/tmp/birdseye.png');
const URL = arg('url', 'http://localhost:5199');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9700 + Math.floor(process.pid % 90);

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle', '--use-angle=metal',
  '--ignore-gpu-blocklist', '--enable-webgl', `--window-size=${SIZE},${SIZE}`,
  '--no-first-run', `--user-data-dir=/tmp/bird-${PORT}`, 'about:blank',
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
  if (!booted) die('birdseye: window.game never booted — is the dev server up on :5199?');

  // --hour has to PIN the clock, not set it once. setHours writes gameHours and the frame loop then
  // advances it 2.5 seconds later while we wait for streaming, so a midday shot came back at dusk and
  // a 13:00 shot of a park came back at night. main.js already honours window.__forceHours on every
  // tick, which is the documented debug hook and the only thing the loop will not overwrite.
  // Park the car at the point being photographed. The shot is taken through its own camera, but the
  // simulation streams traffic, pedestrians and tiled geometry around the CAR, so a camera looking
  // at a spot the car is nowhere near photographs a half-populated city.
  await rpc(ws, id++, 'Runtime.evaluate', {returnByValue: true, expression: `(() => {
    const g = window.game;
    g.car.x = ${X}; g.car.y = ${Y}; g.car.vx = 0; g.car.vy = 0; g.car.speed = 0;
    ${HOUR === null ? '' : `window.__forceHours = ${Number(HOUR)}; if (g.setHours) g.setHours(${Number(HOUR)});`}
    return 1;
  })()`});
  // Let the streaming catch up with where the car was just put.
  await new Promise(r => setTimeout(r, 2500));

  const shot = await rpc(ws, id++, 'Runtime.evaluate', {returnByValue: true, expression: `(() => {
    const {THREE, scene, renderer} = window.game;
    const el = renderer.domElement;
    const cam = new THREE.PerspectiveCamera(55, el.width / el.height, 1, 4000);
    const tilt = ${TILT} * Math.PI / 180;
    // World map +y is north and Three's z is -y, so the pull-back for a tilt is along +z.
    cam.position.set(${X}, ${ALT} * Math.cos(tilt), -(${Y}) + ${ALT} * Math.sin(tilt));
    // Straight down has no natural "up" — the default +y is parallel to the view direction and the
    // frame comes out undefined. Point up at -z so north sits at the top, like a map.
    if (tilt < 0.05) cam.up.set(0, 0, -1);
    cam.lookAt(${X}, 0, -(${Y}));
    renderer.render(scene, cam);
    return el.toDataURL('image/png');
  })()`});

  const data = shot.result?.value;
  if (typeof data !== 'string' || !data.startsWith('data:image/png')) die('birdseye: the canvas returned no image');
  writeFileSync(OUT, Buffer.from(data.split(',')[1], 'base64'));
  console.log(`birdseye: ${OUT} — x ${X}, y ${Y}, ${ALT}m up, tilt ${TILT}°${HOUR === null ? '' : `, ${HOUR}:00`}`);
  chrome.kill();
  process.exit(0);
} catch (e) {
  die(`birdseye: harness error — ${e.message}`);
}
