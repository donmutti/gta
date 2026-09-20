import {defineConfig} from 'vite'
import {appendFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {execSync} from 'node:child_process'

// The dev server doubles as the journal. A page cannot write to disk, so anything the game decides
// worth keeping POSTs here and this appends one JSON line per record to feedback.jsonl at the repo
// root — a plain file Claude can read later when asked to "address feedback".
//
// ONE file, deliberately, not one per feature. A report ("too dark here") and an edit ("parcel 214
// gets grass") are the same kind of thing: a decision made in the world, at a place, that has to
// survive the reload. Splitting them into two queues would mean two formats, two readers and two
// chances to forget one of them. Records are discriminated by `kind`, and anything else on the
// record is carried through untouched, so a new kind needs no change here at all.
//
// Dev only, by design: configureServer does not run for a production build, and the game treats a
// failed POST as non-fatal, so the feature simply does nothing in a built copy.
const journal = {
  name: 'journal-sink',
  configureServer(server) {
    server.middlewares.use('/__feedback', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; return res.end() }
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          const rec = JSON.parse(body)
          rec.at = new Date().toISOString()
          appendFileSync('feedback.jsonl', JSON.stringify(rec) + '\n')
          const where = rec.target ?? (rec.x !== undefined ? `${Math.round(rec.x)},${Math.round(rec.y)}` : '')
          console.log(`[${rec.kind}] ${where}${rec.value !== undefined ? ` = ${rec.value}` : ''}`)
          res.statusCode = 204
          res.end()
        } catch {
          res.statusCode = 400
          res.end()
        }
      })
    })
  },
}


// ------------------------------------------------------------------------------------------------
// Version stamping, so a running game can tell it is not the game that exists.
//
// Two different staleness problems wear the same face. A player with the deployed tab open has
// whatever bundle they loaded, and a fix pushed an hour ago does not reach them until they happen to
// reload. Somebody who cloned the repository and runs it from source — which is what the first
// outside player actually did — has a checkout that goes stale the moment anything is pushed, and
// nothing on their screen will ever say so.
//
// Both are answered by the same question asked of different authorities. The build stamps the commit
// it was built from into the bundle, and /version.json says what the server has NOW. Deployed, that
// compares the bundle you loaded against the bundle being served. From source, the dev server also
// asks git what origin/main has, because in that case the server and the page are the same stale
// thing and neither of them knows it.
//
// The dev branch shells out to git and touches the network; that is a developer's machine and a
// check that happens when nobody is driving. The built branch does neither: version.json is a static
// file written once at build time, and the browser fetches a few dozen bytes of it.
const sha = () => {
  // Vercel hands the commit to the build; a local build has to ask git; a tarball has neither.
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12)
  try { return execSync('git rev-parse HEAD', {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim().slice(0, 12) }
  catch { return 'unknown' }
}

const version = {
  name: 'version-stamp',
  // Dev: answer live, because the working tree changes under the server. Includes what origin/main
  // is, since a source clone is stale relative to the remote rather than to itself.
  configureServer(server) {
    let cached = {at: 0, upstream: null}
    server.middlewares.use('/version.json', (req, res) => {
      let upstream = cached.upstream
      if (Date.now() - cached.at > 300_000) {          // five minutes; git ls-remote is a network call
        try {
          const out = execSync('git ls-remote origin main', {stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000})
          upstream = out.toString().trim().split(/\s+/)[0]?.slice(0, 12) ?? null
        } catch { upstream = null }                     // offline, no remote, no git: say nothing rather than guess
        cached = {at: Date.now(), upstream}
      }
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify({mode: 'source', sha: sha(), upstream}))
    })
  },
  // Build: a static file beside the bundle, and the same sha compiled into the bundle.
  // One place decides the mode, and it is the command actually running: `vite` is somebody's clone,
  // `vite build` is what gets deployed. An earlier version defined this twice, in the plugin and in
  // the server config, and the plugin's copy won — so a dev server reported itself as deployed. The
  // decision never used it, which is exactly why it would have sat there being wrong.
  config(_, {command}) {
    return {define: {
      __BUILD_SHA__: JSON.stringify(sha()),
      __BUILD_MODE__: JSON.stringify(command === 'build' ? 'deployed' : 'source'),
    }}
  },
  closeBundle() {
    try {
      mkdirSync('dist', {recursive: true})
      writeFileSync('dist/version.json', JSON.stringify({mode: 'deployed', sha: sha(), builtAt: new Date().toISOString()}))
    } catch { /* a build that cannot write its own version file still runs; the check just says nothing */ }
  },
}

export default defineConfig({
  server: {port: 5199},
  plugins: [journal, version],
})
