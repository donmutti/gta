import {defineConfig} from 'vite'
import {appendFileSync} from 'node:fs'

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

export default defineConfig({
  server: {port: 5199},
  plugins: [journal],
})
