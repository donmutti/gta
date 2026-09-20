// Record a clip of the running city — frames, optionally the game's own sound, then a GIF or an MP4.
//
// birdseye.mjs answers "what does the layout look like" and portrait.mjs answers "what does this
// model look like". Neither can answer "what does this FEEL like", because the interesting things in
// a driving game are events: a body carried over a bonnet, a tree coming down, a police car arriving.
// A still cannot show any of them and prose about them is not evidence.
//
// Run (dev server on :5199 must already be up):
//   node tools/clip.mjs --scene hitrun --mp4 /tmp/hit.mp4 --sound
//   node tools/clip.mjs --scene hitrun --speed 8 --gif /tmp/slow.gif
//   node tools/clip.mjs --scene drive --at 139,203 --frames 60 --mp4 /tmp/drive.mp4 --sound
//
// Scenes:
//   hitrun  drive at a pedestrian on a long straight road and keep going past them
//   break   drive at the nearest destructible prop and keep going
//   drive   drive along the road nearest --at, hitting nothing
//
// FOUR THINGS THIS GETS RIGHT THAT COST AN EVENING TO LEARN.
//
// 1. The camera stands IN the carriageway, looking back along it. Every side-on placement from a
//    pavement put a street tree in the sight line, and no query can predict that: a tree filter can
//    only see the 2,467 surveyed trees in city.json, while almost everything drawn is synthetic and
//    invented at scene-build time. The middle of the road is the one sight line that is clear BY
//    CONSTRUCTION, because nothing is allowed to stand in a carriageway (src/render/clearance.js).
//
// 2. The framerate is MEASURED, not chosen. Each frame costs a CDP round trip plus a sleep, so a
//    42-frame capture takes about five seconds of wall clock rather than the three that 14 fps would
//    imply. The game and its audio run in real time throughout, so the video framerate has to be
//    derived from the elapsed time or picture and sound drift apart. Interpolation afterwards makes
//    it smooth without changing the duration.
//
// 3. The clock needs BOTH window.__forceHours and game.setHours. setHours alone is overwritten by
//    the frame loop within a frame; __forceHours alone is only honoured in the loop's un-paused
//    branch, so a headless page that never took focus sits at the start hour. Two agents shot whole
//    sequences in blue-hour light before anyone worked this out.
//
// 4. The audio is TEED out of the game rather than reconstructed. src/game/audio.js exposes only
//    resume/silence/update — no context, no master gain — so this wraps AudioContext before the game
//    builds it and patches connect() so anything reaching ctx.destination also reaches a
//    MediaStreamDestination. The game is unchanged and unaware. What you get is its real engine note
//    and its real impact, not a foley track laid over the picture.
import {spawn, spawnSync} from 'node:child_process';
import {writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(`--${n}`);

const SCENE = arg('scene', 'hitrun');
const SPEED = Number(arg('speed', 22));          // m/s at the moment of contact; 22 is about 80 km/h
const FRAMES = Number(arg('frames', 42));
const EVERY = Number(arg('every', 65));          // ms of sleep between frames
const BACK = Number(arg('back', 15));            // metres the camera stands beyond the subject
const CAMH = Number(arg('camh', 2.4));
const HOUR = Number(arg('hour', 11));
const SIZE = Number(arg('size', 900));
const AT = arg('at', null);                      // "x,y" map metres, for --scene drive
const GIF = arg('gif', null);
const MP4 = arg('mp4', null);
const SOUND = has('sound');
const KEEP = arg('keep', null);                  // keep the PNG frames here instead of a temp dir
const URL = arg('url', 'http://localhost:5199');

if (!GIF && !MP4 && !KEEP) die('clip: give --gif <path>, --mp4 <path>, or --keep <dir>');
if (SOUND && !MP4) console.warn('clip: --sound only reaches an MP4; a GIF carries no audio track');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9500 + Math.floor(process.pid % 90);
const DIR = KEEP || mkdtempSync(join(tmpdir(), 'clip-'));

function die(m) { console.error(m); process.exit(1); }

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle', '--use-angle=metal',
  '--ignore-gpu-blocklist', '--enable-webgl', `--window-size=${SIZE},${Math.round(SIZE * 9 / 16)}`,
  // Audio needs both: no gesture to start it, and no attempt to open a real output device. The tap
  // records from the graph, so muting the device costs nothing.
  '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  '--no-first-run', `--user-data-dir=/tmp/clip-${PORT}`, 'about:blank',
], {stdio: 'ignore'});
// Leaked headless Chromes are this project's main resource leak. Trap every exit, not just the
// happy one, and SIGKILL because a Chrome wedged on a GPU context ignores the polite signal.
const reap = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', reap);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reap(); process.exit(130); });
process.on('uncaughtException', (e) => { reap(); console.error(e); process.exit(1); });

const waitPort = (p) => new Promise((res, rej) => {
  let n = 0;
  const t = setInterval(() => {
    const s = net.connect(p, '127.0.0.1');
    s.on('connect', () => { s.destroy(); clearInterval(t); res(); });
    s.on('error', () => { s.destroy(); if (++n > 100) { clearInterval(t); rej(new Error('no devtools')); } });
  }, 100);
});
const rpc = (ws, id, m, p = {}) => new Promise((res, rej) => {
  const h = e => { const x = JSON.parse(e.data); if (x.id !== id) return; ws.removeEventListener('message', h);
    x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result); };
  ws.addEventListener('message', h); ws.send(JSON.stringify({id, method: m, params: p}));
});

const TAP = `(() => {
  if (window.__clip) return 'already';
  const cap = window.__clip = {};
  const Real = window.AudioContext || window.webkitAudioContext;
  window.AudioContext = window.webkitAudioContext = class extends Real {
    constructor(...a) { super(...a); cap.ctx = this; cap.msd = this.createMediaStreamDestination(); }
  };
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = orig.call(this, dest, ...rest);
    try { if (cap.ctx && cap.msd && dest === cap.ctx.destination) orig.call(this, cap.msd); } catch {}
    return r;
  };
  return 'armed';
})()`;

// Choose the subject and place the camera. All three scenes share the same shape: something to aim
// at, a direction to arrive from, and a camera on the centreline beyond it looking back.
const SETUP = `(() => {
  const g = window.game, w = g.world;
  const scene = ${JSON.stringify(SCENE)};
  const at = ${AT ? JSON.stringify(AT.split(',').map(Number)) : 'null'};
  const straight = (e) => {
    if (!e || e.pts.length < 2) return null;
    const [ax, ay] = e.pts[0], [bx, by] = e.pts[e.pts.length - 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 70) return null;
    return {ax, ay, len, dx: (bx - ax) / len, dy: (by - ay) / len};
  };
  let subject = null, road = null;
  if (scene === 'hitrun') {
    let best = null;
    for (const p of g.crowd.peds) {
      if (p.down > 0) continue;
      const r = straight(p.edge); if (!r) continue;
      const t = (p.x - r.ax) * r.dx + (p.y - r.ay) * r.dy;
      if (t < 30 || t > r.len - 30) continue;      // room to run in and to drive away
      if (!best || r.len > best.r.len) best = {p, r, t};
    }
    if (!best) return null;
    subject = {x: best.p.x, y: best.p.y}; road = best.r; var tt = best.t;
  } else if (scene === 'break') {
    const d = g.destruction; if (!d) return null;
    const near = d.find(g.car.x, g.car.y, {minHp: 1});
    if (!near) return null;
    subject = {x: near.x, y: near.y};
    let best = null;
    for (const e of w.edges) {
      const r = straight(e); if (!r) continue;
      const t = (subject.x - r.ax) * r.dx + (subject.y - r.ay) * r.dy;
      if (t < 30 || t > r.len - 30) continue;
      const px = r.ax + r.dx * t, py = r.ay + r.dy * t;
      const off = Math.hypot(subject.x - px, subject.y - py);
      if (off > e.width / 2 + 4) continue;
      if (!best || r.len > best.len) { best = r; tt = t; }
    }
    if (!best) return null;
    road = best;
  } else {
    const [qx, qy] = at || [g.car.x, g.car.y];
    let best = null;
    for (const e of w.edges) {
      const r = straight(e); if (!r) continue;
      const t = Math.max(30, Math.min(r.len - 30, (qx - r.ax) * r.dx + (qy - r.ay) * r.dy));
      const px = r.ax + r.dx * t, py = r.ay + r.dy * t;
      const d2 = (qx - px) ** 2 + (qy - py) ** 2;
      if (!best || d2 < best.d2) { best = {r, t, d2}; }
    }
    if (!best) return null;
    road = best.r; tt = best.t;
    subject = {x: road.ax + road.dx * tt, y: road.ay + road.dy * tt};
  }
  const s = window.__clipS = {subject, road, t: tt};
  // Camera: on the centreline BEYOND the subject, looking back down the road at it. The carriageway
  // is the only sight line guaranteed clear of props, and a subject coming at the lens reads far
  // better than one crossing it.
  let cx = road.ax + road.dx * (tt + ${BACK});
  let cy = road.ay + road.dy * (tt + ${BACK});
  if (w.onRoad && !w.onRoad(cx, cy, -1)) {           // the straight-line fit drifts on a curve
    for (let k = 1; k <= 14; k++) {
      const o = k * 0.6;
      if (w.onRoad(cx - road.dy * o, cy + road.dx * o, -1)) { cx -= road.dy * o; cy += road.dx * o; break; }
      if (w.onRoad(cx + road.dy * o, cy - road.dx * o, -1)) { cx += road.dy * o; cy -= road.dx * o; break; }
    }
  }
  s.camx = cx; s.camy = cy;
  return {subject: [+subject.x.toFixed(1), +subject.y.toFixed(1)], road: +road.len.toFixed(0)};
})()`;

// Hold the velocity every frame, THROUGH the event and past it. A measuring rig releases at contact
// so the physics resolves untouched; a clip is about what happens afterwards, so this does not.
const LAUNCH = `(() => {
  const g = window.game, s = window.__clipS, r = s.road;
  const D = ${SPEED} * 0.5 + 6;
  g.car.x = s.subject.x - r.dx * D; g.car.y = s.subject.y - r.dy * D;
  g.car.heading = Math.atan2(r.dy, r.dx);
  g.car.steer = 0; g.car.lateral = 0; g.car.contact = false;
  s.go = true;
  const tick = () => {
    if (!s.go) return;
    g.car.vx = r.dx * ${SPEED}; g.car.vy = r.dy * ${SPEED}; g.car.speed = ${SPEED}; g.car.steer = 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 1;
})()`;

const SHOT = `(() => {
  const {THREE, scene, renderer, car} = window.game, s = window.__clipS;
  const el = renderer.domElement;
  const cam = new THREE.PerspectiveCamera(48, el.width / el.height, 0.3, 2000);
  cam.position.set(s.camx, ${CAMH}, -s.camy);
  cam.lookAt(s.subject.x, 1.1, -s.subject.y);
  renderer.render(scene, cam);
  return {png: el.toDataURL('image/png'), d: +Math.hypot(car.x - s.subject.x, car.y - s.subject.y).toFixed(1)};
})()`;

const START_AUDIO = `(() => {
  const cap = window.__clip, g = window.game;
  g.audio.resume();
  if (!cap.msd) return 'no context';
  const rec = new MediaRecorder(cap.msd.stream, {mimeType: 'audio/webm;codecs=opus'});
  cap.chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) cap.chunks.push(e.data); };
  rec.start(); cap.rec = rec;
  return cap.ctx.state;
})()`;

const STOP_AUDIO = `(async () => {
  const cap = window.__clip;
  if (!cap.rec) return null;
  await new Promise(r => { cap.rec.onstop = r; cap.rec.stop(); });
  const buf = new Uint8Array(await new Blob(cap.chunks, {type: 'audio/webm'}).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
})()`;

try {
  await waitPort(PORT);
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${URL}`, {method: 'PUT'})).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 1;
  await rpc(ws, id++, 'Runtime.enable');
  // Arm the audio tap before the page has any chance to build its context.
  await rpc(ws, id++, 'Runtime.evaluate', {expression: TAP, returnByValue: true});

  let booted = false;
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 250));
    const r = await rpc(ws, id++, 'Runtime.evaluate', {expression: 'typeof window.game', returnByValue: true});
    if (r.result?.value === 'object') { booted = true; break; }
  }
  if (!booted) die(`clip: window.game never booted — is the dev server up on ${URL}?`);

  await rpc(ws, id++, 'Runtime.evaluate', {returnByValue: true,
    expression: `(() => { window.__forceHours = ${HOUR}; window.game.setHours(${HOUR}); return 1; })()`});
  await new Promise(r => setTimeout(r, 1500));

  const setup = await rpc(ws, id++, 'Runtime.evaluate', {expression: SETUP, returnByValue: true});
  if (!setup.result?.value) die(`clip: no subject found for --scene ${SCENE}`);
  console.log('clip: subject', JSON.stringify(setup.result.value));

  // Park the car near the scene first, so the streamer has the right tiles resident before the run.
  await rpc(ws, id++, 'Runtime.evaluate', {returnByValue: true, expression:
    `(() => { const s = window.__clipS, g = window.game;
       g.car.x = s.subject.x - s.road.dx * 40; g.car.y = s.subject.y - s.road.dy * 40;
       g.car.vx = g.car.vy = g.car.speed = 0; return 1; })()`});
  await new Promise(r => setTimeout(r, 2500));

  if (SOUND) {
    const a = await rpc(ws, id++, 'Runtime.evaluate', {expression: START_AUDIO, returnByValue: true});
    console.log('clip: audio', a.result?.value);
  }

  const t0 = Date.now();
  await rpc(ws, id++, 'Runtime.evaluate', {expression: LAUNCH, returnByValue: true});
  for (let i = 0; i < FRAMES; i++) {
    const r = await rpc(ws, id++, 'Runtime.evaluate', {expression: SHOT, returnByValue: true});
    const v = r.result?.value;
    if (!v?.png) die('clip: the canvas returned no frame');
    writeFileSync(join(DIR, `f-${String(i).padStart(3, '0')}.png`), Buffer.from(v.png.split(',')[1], 'base64'));
    await new Promise(r => setTimeout(r, EVERY));
  }
  const elapsed = (Date.now() - t0) / 1000;
  const fps = (FRAMES - 1) / elapsed;

  let wav = null;
  if (SOUND) {
    const a = await rpc(ws, id++, 'Runtime.evaluate', {expression: STOP_AUDIO, returnByValue: true, awaitPromise: true});
    if (a.result?.value) { wav = join(DIR, 'a.webm'); writeFileSync(wav, Buffer.from(a.result.value, 'base64')); }
    else console.warn('clip: no audio captured — the MP4 will be silent');
  }
  chrome.kill('SIGKILL');
  console.log(`clip: ${FRAMES} frames, ${elapsed.toFixed(2)}s wall clock -> ${fps.toFixed(2)} fps`);

  const ff = (args) => {
    const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {stdio: 'inherit'});
    if (r.status !== 0) die('clip: ffmpeg failed');
  };
  const frames = join(DIR, 'f-%03d.png');
  if (MP4) {
    // Interpolate up to 24 fps so it is smooth, without changing the duration the audio expects.
    const v = `[0:v]scale=${SIZE >= 900 ? 760 : SIZE}:-2,minterpolate=fps=24:mi_mode=mci:mc_mode=aobmc:vsbmc=1[v]`;
    ff(wav
      ? ['-framerate', String(fps), '-i', frames, '-i', wav, '-filter_complex', v, '-map', '[v]', '-map', '1:a',
         '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', MP4]
      : ['-framerate', String(fps), '-i', frames, '-filter_complex', v, '-map', '[v]',
         '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', MP4]);
    console.log(`clip: ${MP4}`);
  }
  if (GIF) {
    ff(['-framerate', String(fps), '-i', frames, '-vf',
        `fps=${Math.min(20, Math.round(fps * 2))},scale=700:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
        '-loop', '0', GIF]);
    console.log(`clip: ${GIF}`);
  }
  if (!KEEP) rmSync(DIR, {recursive: true, force: true});
  process.exit(0);
} catch (e) {
  die(`clip: ${e.message}`);
}
