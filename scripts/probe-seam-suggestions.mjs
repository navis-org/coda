/**
 * Does `seam:suggestions` read a real suggestion set, over real HTTP, by byte range?
 *
 * The unit tests read the committed fixture from a `Blob`, which exercises the parquet decoding
 * and none of the transport. Everything that has ever gone wrong in this path is in the
 * transport: a host that answers a ranged GET with the whole eleven-megabyte object, a `HEAD` the
 * server will not answer, a CORS header missing on the parquet but present on the JSON, a
 * redirect that drops the Range. None of those is visible from a test, and each one looks like
 * "the set would not load".
 *
 * So this runs the node's own reader in a browser against whatever URL it is given — the hosted
 * set, or a static server over a local copy — and checks what came back against the manifest's
 * own counts. It is the end-to-end check Phase D of the other model never had until the node was
 * already built.
 *
 * ## It reads, and nothing else
 *
 * No CAVE token, no credentials, no writes. A suggestion set is a published file.
 *
 * Usage: `pnpm dev --port 5178` in another terminal, then
 *   pnpm probe:seam-suggestions
 *
 * With no arguments it reads the published Aedes sets. `--set` takes another directory's index
 * (with `--id` naming which set) or one set's manifest directly. With
 * no `--set`, a local copy is served instead: `--dir` is a directory holding the files, and
 * `--entry` which document to start from (`fixture.json` by default, `index.json` for the
 * directory path).
 */

import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

import { launchChrome, probeArgs, probeReport, APP_MODULE } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5178/'
const dir = args.value('--dir') ?? ''
/** The published Aedes sets. Overridden by `--set`, or by `--dir` to serve a local copy. */
const PUBLISHED = 'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/suggestions/aedes/index.json'
let address = args.value('--set') ?? (args.value('--dir') ? '' : PUBLISHED)
/** Which set of a directory's index to read; empty where the address is one set's manifest. */
const setId = args.value('--id') ?? 'rv2'
/** The document served as the entry point when `--dir` stands one up. */
const entry = args.value('--entry') ?? 'fixture.json'
if (!address && !dir) {
  console.error(
    'pass --set <index or manifest url> [--id <set>], or --dir <a directory to serve> ' +
      '[--entry index.json] [--id <set>]',
  )
  process.exit(2)
}

/** Its own, and deleted on the way out — nothing is handed a credential, but the rule is the rule. */
const PROFILE = '/tmp/coda-seam-suggestions-profile'

const TYPES = { '.json': 'application/json', '.parquet': 'application/vnd.apache.parquet' }

/**
 * A static server that **honours Range**, because that is the behaviour being probed. It also
 * answers `HEAD` and sends CORS headers, since the page is on another origin — a local server
 * that did neither would fail the probe for reasons that are the probe's own fault.
 */
let server
if (!address) {
  const root = normalize(dir)
  server = createServer((req, res) => {
    const name = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^\/+/, '')
    // Not a security boundary — a probe serving a directory the user named — but a traversal
    // here would read somewhere nobody meant, and the refusal costs one line.
    if (name.includes('..')) {
      res.writeHead(400).end()
      return
    }
    const path = join(root, name)
    let size
    try {
      size = statSync(path).size
    } catch {
      res.writeHead(404).end()
      return
    }
    const headers = {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'content-length, content-range, last-modified',
      'accept-ranges': 'bytes',
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    const from = range && range[1] !== '' ? Number(range[1]) : 0
    const to = range && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'content-length': String(size) }).end()
      return
    }
    if (range) {
      res.writeHead(206, {
        ...headers,
        'content-length': String(to - from + 1),
        'content-range': `bytes ${from}-${to}/${size}`,
      })
      createReadStream(path, { start: from, end: to }).pipe(res)
      return
    }
    res.writeHead(200, { ...headers, 'content-length': String(size) })
    createReadStream(path).pipe(res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  address = `http://127.0.0.1:${server.address().port}/${entry}`
  console.log(`serving ${root} at ${address}`)
}

const report = probeReport()
const { evaluate, waitFor, send, close } = await launchChrome({ port: 9345, profile: PROFILE })
await send('Page.navigate', { url })
await waitFor('Boolean(document.querySelector("#root"))', 'the app')

const script = `(async () => {
  const load = ${APP_MODULE}
  const [setMod, readMod, nodeMod, idxMod] = await Promise.all([
    load('/src/packs/seam/suggestionSet.ts'),
    load('/src/packs/seam/suggestionRead.ts'),
    load('/src/packs/seam/suggestions.ts'),
    load('/src/packs/seam/suggestionIndex.ts'),
  ])
  const t0 = performance.now()
  // The same two steps the node takes: resolve the address (a directory's index, or one set's
  // manifest) and then read the set it names. A probe that skipped the first would not exercise
  // the addressing the production path is built on.
  // Through the node's own normaliser, so a directory pasted here reaches the same file the
  // card would read. The probe resolving addresses its own way is how it comes to pass against
  // something the app cannot open.
  const address = idxMod.suggestionsAddress(${JSON.stringify(address)})
  const wanted = ${JSON.stringify(setId)}
  let manifest = address
  const document = JSON.parse(await (await fetch(address)).text())
  if (Array.isArray(document.sets)) {
    const index = idxMod.parseSuggestionIndex(document, address)
    const entry = wanted ? idxMod.entryById(index, wanted) : index.sets[0]
    if (!entry) throw new Error('no set ' + wanted + ' in ' + address)
    manifest = new URL(entry.path, address).toString()
  }
  const set = await setMod.loadSuggestionSet(manifest)
  const manifestMs = Math.round(performance.now() - t0)

  const t1 = performance.now()
  const built = await nodeMod.readSuggestions(
    set,
    readMod.openOverHttp((file) => setMod.fileUrl(set, file)),
  )
  const readMs = Math.round(performance.now() - t1)

  // What the node would publish, as a reader sees it -- read off the tables rather than from the
  // loop, so this checks the published columns and not the intermediate state.
  const first = []
  for (let i = 0; i < Math.min(3, built.tips.length); i++) {
    first.push({
      neuronId: built.tips.data.neuronId[i],
      candidateId: built.tips.data.candidateId[i],
      shown: built.tips.data.shown[i],
      r: built.tips.data.r[i],
      q: built.tips.data.q[i],
    })
  }
  return {
    address,
    set: {
      datastack: set.datastack, snapshot: set.snapshot, commit: set.commit,
      cutoff: set.cutoff, neurons: set.neurons.length, counts: set.counts,
    },
    manifestMs,
    readMs,
    read: {
      tips: built.tips.length,
      candidates: built.candidates.length,
      shown: built.shown,
      neurons: built.neurons.length,
      points: built.points.positions.length / 3,
      suggestions: built.suggestions.length,
    },
    idTypes: {
      neuronId: typeof built.tips.data.neuronId[0],
      candidateId: typeof built.tips.data.candidateId[0],
      shown: typeof built.tips.data.shown[0],
    },
    first,
  }
})()`

const got = await evaluate(script, 600_000)
console.log(JSON.stringify(got, null, 2))

report.check(got.read.tips === got.set.counts.tips, `${got.read.tips} tips, manifest says ${got.set.counts.tips}`)
report.check(
  got.read.candidates === got.set.counts.candidates,
  `${got.read.candidates} candidates, manifest says ${got.set.counts.candidates}`,
)
report.check(got.read.shown === got.set.counts.shown, `${got.read.shown} shown, manifest says ${got.set.counts.shown}`)
report.check(got.read.neurons === got.set.neurons, `${got.read.neurons} neuron rows for ${got.set.neurons} neurons`)
report.check(got.read.points === got.read.tips, `${got.read.points} points for ${got.read.tips} tips`)
// Invariant 8, over the transport this time: a root id that came back as a number is already a
// different neuron, and nothing downstream could tell.
report.check(got.idTypes.neuronId === 'string', `neuronId is ${got.idTypes.neuronId}`)
report.check(got.idTypes.candidateId === 'string', `candidateId is ${got.idTypes.candidateId}`)
report.check(got.idTypes.shown === 'boolean', `shown is ${got.idTypes.shown}`)
console.log(`manifest ${got.manifestMs} ms, both files ${got.readMs} ms`)

await close()
server?.close()
report.finish('is `pnpm dev --port 5178` running?')
