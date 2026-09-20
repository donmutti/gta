// Ask the running city a question and print the answer.
//
// Screenshots settle arguments about layout; numbers settle arguments about counts. "The bins are off
// the tarmac now" is a claim, "4,812 placed, 391 moved clear, 12 dropped" is a measurement, and the
// scene modules already compute those counts while they place things. This pulls them out.
//
// It is the same headless-Chrome/CDP flow as tools/birdseye.mjs, minus the camera: boot the page,
// wait for window.game rather than guessing a sleep, evaluate an expression, print it as JSON.
//
// Run (dev server on :5199 must already be up):
//   node tools/probe.mjs 'window.__props'
//   node tools/probe.mjs 'window.game.world.edges.length'
//   node tools/probe.mjs --file check.js          # expression body from a file, for long ones
//
// The expression is evaluated in the page with the game fully booted, so window.game, THREE and the
// world model are all in scope. It runs ONE expression and exits; nothing here drives the frame loop.
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import net from 'node:net';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const FILE = arg('file', null);
const URL = arg('url', 'http://localhost:5199');
const WAIT = Number(arg('wait', 2500));    // ms after boot, for streamed geometry to settle
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const EXPR = FILE ? readFileSync(FILE, 'utf8') : positional[positional.length - 1];
if (!EXPR) die('probe: give an expression, or --file with one in it');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9800 + Math.floor(process.pid % 90);

function die(msg) { console.error(msg); process.exit(1); }

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--use-gl=angle', '--use-angle=metal',
  '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1000,800',
  '--no-first-run', `--user-data-dir=/tmp/probe-${PORT}`, 'about:blank',
], {stdio: 'ignore'});
// Leaked headless Chromes were this project's main resource leak. Always trap the exit.
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch { /* already gone */ } });

const waitPort = (p) => new Promise((res, rej) => {
  let n = 0;
  const t = setInterval(() => {
    const s = net.connect(p, '127.0.0.1');
    s.on('connect', () => { s.destroy(); clearInterval(t); res(); });
    s.on('error', () => { s.destroy(); if (++n > 100) { clearInterval(t); rej(new Error('no devtools')); } });
  }, 100);
});

function rpc(ws, id, method, params = {}) {
  return new Promise((res, rej) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({id, method, params}));
  });
}

try {
  await waitPort(PORT);
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${URL}`, {method: 'PUT'})).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 1;
  await rpc(ws, id++, 'Runtime.enable');

  // Console lines are worth keeping: the placement passes report their counts through console.info,
  // and an exception during scene build shows up here rather than in the expression's result.
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION ' + (m.params.exceptionDetails?.exception?.description ?? ''));
    }
  });

  let booted = false;
  for (let i = 0; i < 160; i++) {
    await new Promise(r => setTimeout(r, 250));
    const r = await rpc(ws, id++, 'Runtime.evaluate', {expression: 'typeof window.game', returnByValue: true});
    if (r.result?.value === 'object') { booted = true; break; }
  }
  if (!booted) {
    console.error(logs.join('\n'));
    die(`probe: window.game never booted — is the dev server up on ${URL}?`);
  }
  await new Promise(r => setTimeout(r, WAIT));

  const out = await rpc(ws, id++, 'Runtime.evaluate', {
    expression: EXPR, returnByValue: true, awaitPromise: true,
  });
  if (out.exceptionDetails) {
    console.error(out.exceptionDetails.exception?.description ?? JSON.stringify(out.exceptionDetails));
    process.exit(1);
  }
  if (process.argv.includes('--logs')) console.error(logs.join('\n'));
  console.log(JSON.stringify(out.result?.value, null, 2));
  chrome.kill();
  process.exit(0);
} catch (e) {
  die(`probe: ${e.message}`);
}
