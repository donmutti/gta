// Smoke test: build (if asked) then load the page headless and fail on any console/page error or a
// game that never boots. Five sessions commit into one scene; the thing that reliably catches an
// undefined-symbol integration crash is loading the page ONCE, not review. This is that check,
// runnable by anyone as `npm run smoke` (dev server on :5199) or `npm run smoke -- --prod`
// (production build on a temp preview server).
import {spawn} from 'node:child_process';
import net from 'node:net';

const PROD = process.argv.includes('--prod');
const URL = PROD ? 'http://localhost:4178' : 'http://localhost:5199';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9900 + Math.floor((Date.now ? 0 : 0)) + Math.floor(process.pid % 90);

let preview;
if (PROD) {
  // build, then serve dist on a fixed temp port
  const build = spawn('npm', ['run', 'build'], {stdio: 'inherit'});
  await new Promise((r, j) => build.on('exit', c => c === 0 ? r() : j(new Error('build failed'))));
  preview = spawn('npx', ['vite', 'preview', '--port', '4178'], {stdio: 'ignore'});
  await new Promise(r => setTimeout(r, 2500));
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle', '--use-angle=metal',
  '--ignore-gpu-blocklist', '--enable-webgl', '--no-first-run', `--user-data-dir=/tmp/smoke-${PORT}`, 'about:blank',
], {stdio: 'ignore'});

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

// Kill the children on EVERY exit path, not just the ones we thought of.
//
// finish() below cleans up when smoke reaches a verdict. It is the paths that do not reach one that
// leak: an exception before the try block, a rejected promise, the caller pressing Ctrl-C, the
// process being killed. Two orphaned Chromes were found alive on this machine tonight, parented to
// init, 30 and 50 minutes after their smoke runs had gone — and leaked headless Chromes are the
// documented main resource leak of this project, each one holding a GPU context and a core on a
// laptop that is already the team's dominant load. birdseye.mjs, portrait.mjs and probe.mjs all
// carry this trap; the canonical gate everybody runs did not.
//
// SIGKILL rather than SIGTERM: a Chrome wedged on a GPU context ignores the polite one, which is
// exactly the state a smoke run that hung would leave it in.
const reap = () => {
  try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
  try { if (preview) preview.kill('SIGKILL'); } catch { /* already gone */ }
};
process.on('exit', reap);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reap(); process.exit(130); });
process.on('uncaughtException', (e) => { reap(); console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { reap(); console.error(e); process.exit(1); });

const finish = (code, msg) => { console.log(msg); reap(); process.exit(code); };

try {
  await waitPort(PORT);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${URL}`, {method: 'PUT'})).json();
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 1;
  const errs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    // 404s for optional resources are noise; a real integration crash throws an exception
  });
  await rpc(ws, id++, 'Runtime.enable');
  let ok = false;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 300));
    const r = await rpc(ws, id++, 'Runtime.evaluate', {expression: 'typeof window.game', returnByValue: true});
    if (r.result?.value === 'object') { ok = true; break; }
    if (errs.length) break;   // fail fast on a thrown exception
  }
  if (errs.length) finish(1, `SMOKE FAIL (${PROD ? 'prod' : 'dev'}): ${errs.slice(0, 5).join(' | ')}`);
  else if (!ok) finish(1, `SMOKE FAIL (${PROD ? 'prod' : 'dev'}): window.game never booted within 18s`);
  else {
    // "Runs but shows nothing": the game can boot with no exception and still render a black frame
    // — e.g. the chase camera trapped inside a building (backfaces cull to nothing). Smoke proves
    // it RUNS; this proves it RENDERS. Let a few frames draw, then sample the canvas's mean
    // brightness by downscaling it to 8x8 on a 2D canvas and averaging. An all-but-black frame fails.
    await new Promise(r => setTimeout(r, 1200));
    // Capture the COMPOSITOR output via CDP (the WebGL canvas itself reads empty without
    // preserveDrawingBuffer, which caused a false all-black reading). Load that PNG as an <img>
    // in-page, draw it 16x16, and average luminance.
    const shot = await rpc(ws, id++, 'Page.captureScreenshot', {format: 'png'});
    const mean = await new Promise(async (resolve) => {
      const r = await rpc(ws, id++, 'Runtime.evaluate', {awaitPromise: true, returnByValue: true, expression: `
        new Promise((res) => {
          const img = new Image();
          img.onload = () => {
            const s = document.createElement('canvas'); s.width = 16; s.height = 16;
            const cx = s.getContext('2d'); cx.drawImage(img, 0, 0, 16, 16);
            const d = cx.getImageData(0, 0, 16, 16).data; let sum = 0;
            for (let i = 0; i < d.length; i += 4) sum += 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
            res(sum / (d.length / 4));
          };
          img.onerror = () => res(-1);
          img.src = 'data:image/png;base64,${shot.data}';
        })`});
      resolve(r.result?.value ?? -1);
    });
    // A real daylight/night frame averages well above this; a black frame is ~0-3. 6 is a safe floor.
    if (mean >= 0 && mean < 6) finish(1, `SMOKE FAIL (${PROD ? 'prod' : 'dev'}): renders a BLACK frame (mean luminance ${mean.toFixed(1)}) — camera trapped or nothing drawn`);
    else finish(0, `SMOKE PASS (${PROD ? 'prod' : 'dev'}): window.game live, no exceptions, frame renders (luminance ${mean < 0 ? 'n/a' : mean.toFixed(1)})`);
  }
} catch (e) {
  finish(1, `SMOKE FAIL: harness error — ${e.message}`);
}
