#!/usr/bin/env node
/**
 * BigClust Project in a real browser, on a real project — the half of it vitest cannot reach.
 *
 *   pnpm dev --port 5177 &
 *   pnpm probe:bigclust --project ~/Downloads/bigclust-projects/fish2-connectivity2
 *
 * Without `--project` it reads the five-neuron fixture (`src/data/bigclust/__fixtures__/tiny`).
 *
 * ## Why this exists
 *
 * Every vitest run reads on its own thread — Node has no `Worker` — so the two workers a project
 * is read through (the table-file reader for meta and the embeddings, the BigClust worker for the
 * k-NN graph and the features) execute nowhere else. Nor does the network: here the project is
 * served over HTTP with Range and CORS, the way a bucket serves one, so this is the URL path end
 * to end. And it is the only place the cost is measured at the size the node exists for.
 *
 * ## What it checks
 *
 * The answers, not that a run succeeded. A node is run for each embedding, and pyarrow reads the
 * same files independently: the neuron count; the first neuron's coordinates in that embedding;
 * for the one with a k-NN graph, the rows left after BigClust's own drops (missing, out of range,
 * self) and the first neuron's nearest; for the one with features, the non-zero count and one
 * value — and Neighbours and Features empty for the rest. So an alignment off by a row fails here
 * however plausible the tables look. Then the first embedding is joined to Neurons, drawn as a
 * Scatter Plot coloured by type, and a screenshot kept.
 */

import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, normalize, resolve } from 'node:path'

import { APP_MODULE, launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

const args = probeArgs()
const BASE = args.value('--url') ?? 'http://localhost:5177'
const PROJECT = resolve(
  (args.value('--project') ?? 'src/data/bigclust/__fixtures__/tiny').replace(/^~/, homedir()),
)
const PORT = 5199
const report = probeReport()

// ── the truth, from pyarrow ──────────────────────────────────────────────────────────────────────

const truth = JSON.parse(
  execFileSync(
    'python3',
    [
      '-c',
      `
import json, sys, numpy as np, pyarrow.parquet as pq
root = sys.argv[1]
info = json.load(open(root + '/info'))
meta = pq.read_table(root + '/' + info['meta']['file'] if isinstance(info['meta'], dict) else root + '/' + info['meta']).to_pandas()
ids = (meta.index if 'id' not in meta.columns else meta['id']).astype('int64').tolist()
n = len(ids)
entries = info['embeddings'] if isinstance(info['embeddings'], list) else [info['embeddings']]
out = {'n': n, 'first': str(ids[0]), 'embeddings': {}}
# What each embedding's node should hand over, read independently: its first row, and its k-NN
# graph and features where it has them (None where it has not, which the node makes empty).
for e in entries:
    if 'columns' in e:
        continue
    t = pq.read_table(root + '/' + e['file']).to_pandas()
    xy = [c for c in t.columns if c not in ('id', 'index', '__index_level_0__')]
    truth = {'xy': [float(t[xy[0]].iloc[0]), float(t[xy[1]].iloc[0])], 'knn': None, 'nnz': None}
    d = e.get('distances')
    if isinstance(d, dict) and str(d.get('type', '')).lower().endswith('knn'):
        k = pq.read_table(root + '/' + d['file']).to_pandas()
        idx = k[[c for c in k.columns if str(c).startswith('nn_idx_')]].to_numpy(dtype='float64')
        rows = np.arange(n)[:, None]
        ok = np.isfinite(idx) & (idx >= 0) & (idx < n) & (idx != rows)
        truth['knn'] = int(ok.sum())
        first = [int(v) for v in idx[0] if np.isfinite(v) and 0 <= v < n and v != 0]
        truth['nearest'] = str(ids[first[0]]) if first else None
    f = e.get('features')
    if f:
        ft = pq.read_table(root + '/' + (f['file'] if isinstance(f, dict) else f)).to_pandas()
        cols = [c for c in ft.columns if c not in ('id', 'index', '__index_level_0__')]
        v = ft[cols].to_numpy(dtype='float64')
        truth['nnz'] = int((np.isfinite(v) & (v != 0)).sum())
        r, c = np.argwhere(np.isfinite(v) & (v != 0))[0]
        truth['feature'] = {'id': str(ids[r]), 'name': str(cols[c]), 'value': float(v[r, c])}
    out['embeddings'][e['name']] = truth
print(json.dumps(out))
`,
      PROJECT,
    ],
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  ),
)
console.log(`project: ${PROJECT} — ${truth.n.toLocaleString()} neurons (pyarrow)`)

// ── the project, served as a bucket serves it ───────────────────────────────────────────────────

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Range')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Last-Modified')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  const path = normalize(join(PROJECT, decodeURIComponent(new URL(req.url, 'http://x').pathname)))
  if (!path.startsWith(PROJECT) || !existsSync(path) || statSync(path).isDirectory()) {
    return res.writeHead(404).end()
  }
  const { size, mtime } = statSync(path)
  res.setHeader('Last-Modified', mtime.toUTCString())
  res.setHeader('Accept-Ranges', 'bytes')
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  if (!range) {
    res.writeHead(200, { 'Content-Length': size })
    return req.method === 'HEAD' ? res.end() : createReadStream(path).pipe(res)
  }
  const start = Number(range[1])
  const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` })
  return req.method === 'HEAD' ? res.end() : createReadStream(path, { start, end }).pipe(res)
})
await new Promise((done) => server.listen(PORT, done))
process.on('exit', () => server.close())

// ── the app ──────────────────────────────────────────────────────────────────────────────────────

const page = await launchChrome({ port: 9439, profile: '/tmp/coda-probe-bigclust', width: 1600, height: 1000 })
await page.send('Page.navigate', { url: `${BASE}/` })
const STORE = `(${APP_MODULE})('/src/store/graphStore.ts').then((m) => m.useGraphStore)`
await page.waitFor(`${STORE}.then((s) => Boolean(s.getState().graph))`, 'the app to load')

// Workers the page constructs, by script — resource timing does not list a worker's script.
await page.evaluate(`(() => {
  const made = (window.__workers = [])
  const Real = window.Worker
  window.Worker = class extends Real {
    constructor(url, options) { made.push(String(url)); super(url, options) }
  }
  return true
})()`)

/** One node reading `embedding`, run, and what its four outputs hold. */
const runEmbedding = async (embedding, featureId = '') => {
  const started = Date.now()
  const result = await page.evaluate(`${STORE}.then(async (store) => {
    const s = store.getState()
    s.closeStartPage?.()
    s.closeGuides?.()
    const p = s.addNode('annotation:bigclust', { x: 0, y: 0 })
    s.setParam(p, 'url', 'http://localhost:${PORT}/')
    s.setParam(p, 'embedding', ${JSON.stringify(embedding)})
    const featureId = ${JSON.stringify(featureId)}
    await s.runNode(p)
    const info = s.nodeInfo(p)
    const t = (port) => s.nodeOutput(p, port)
    const neurons = t('neurons'), coords = t('embedding'), neighbours = t('neighbours'), features = t('features')
    if (!neurons) return { p, state: info.state, error: info.error }
    const first = neurons.data.neuronId[0]
    return {
      p,
      state: info.state,
      warning: s.nodeWarning(p),
      neurons: neurons.length, neighbours: neighbours.length, features: features.length,
      first, xy: [coords.data.x[0], coords.data.y[0]], coordsId: coords.data.neuronId[0],
      nearest: neighbours.data.targetId[neighbours.data.queryId.indexOf(first)] ?? null,
      featureRows: Array.from({ length: features.length }, (_, i) => i)
        .filter((i) => features.data.neuronId[i] === featureId)
        .map((i) => [features.data.group[i], features.data.feature[i], features.data.value[i]]),
      workers: window.__workers,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : undefined,
    }
  })`)
  return { ...result, seconds: (Date.now() - started) / 1000 }
}

await page.evaluate(`${STORE}.then((store) => (store.getState().newGraph(), true))`)
let firstNode
for (const [name, expected] of Object.entries(truth.embeddings)) {
  const [x, y] = expected.xy
  const r = await runEmbedding(name, expected.feature?.id)
  firstNode ??= r.p
  console.log(`"${name}": ${r.state} in ${r.seconds.toFixed(1)} s, JS heap ${r.heapMB ?? '?'} MB`)
  if (r.warning) console.log(`  warnings: ${r.warning}`)
  report.check(r.state === 'ok', `"${name}" runs (${r.state}${r.error ? `: ${r.error}` : ''})`)
  if (r.state !== 'ok') continue
  report.check(r.neurons === truth.n && r.first === truth.first, `  Neurons has every neuron, meta's first first as text: ${r.neurons.toLocaleString()}, ${r.first}`)
  report.check(
    r.coordsId === truth.first && Math.abs(r.xy[0] - x) < 1e-4 && Math.abs(r.xy[1] - y) < 1e-4,
    `  Embedding row 1 is ${truth.first} at (${x.toFixed(4)}, ${y.toFixed(4)}): got ${r.coordsId} at ${r.xy.map((v) => v.toFixed(4)).join(', ')}`,
  )
  const knn = expected.knn !== null
  report.check(r.neighbours === (expected.knn ?? 0), `  Neighbours ${knn ? 'keeps what BigClust keeps' : 'is empty'}: ${r.neighbours.toLocaleString()}${knn ? ` of ${expected.knn.toLocaleString()}` : ''}`)
  if (knn) report.check(r.nearest === expected.nearest, `  and the first neuron's nearest is ${expected.nearest}: got ${r.nearest}`)
  const feats = expected.nnz !== null
  report.check(r.features === (expected.nnz ?? 0), `  Features ${feats ? 'holds every non-zero' : 'is empty'}: ${r.features.toLocaleString()}${feats ? ` of ${expected.nnz.toLocaleString()}` : ''}`)
  if (feats) {
    const tuple = /^\(\s*'(.*?)'\s*,\s*'(.*)'\s*\)$/.exec(expected.feature.name)
    const [group, feature] = tuple ? [tuple[1], tuple[2]] : [null, expected.feature.name]
    report.check(
      r.featureRows.some(([g, f, v]) => g === group && f === feature && Math.abs(v - expected.feature.value) < 1e-9),
      `  and ${expected.feature.id}'s ${expected.feature.name} is ${expected.feature.value}`,
    )
  }
  report.check(
    r.workers.some((w) => w.includes('files/worker')) &&
      ((!knn && !feats) || r.workers.some((w) => w.includes('bigclust/worker'))),
    `  read off the page thread (${r.workers.length} workers started so far)`,
  )
}

// The first embedding as a Scatter, joined to Neurons so it can be coloured by type.
if (firstNode) {
  await page.evaluate(`${STORE}.then(async (store) => {
    const s = store.getState()
    const j = s.addNode('core.join', { x: 400, y: 0 })
    s.connect({ source: ${JSON.stringify(firstNode)}, sourceHandle: 'embedding', target: j, targetHandle: 'left' })
    s.connect({ source: ${JSON.stringify(firstNode)}, sourceHandle: 'neurons', target: j, targetHandle: 'right' })
    s.setParam(j, 'leftKey', 'neuronId')
    s.setParam(j, 'rightKey', 'neuronId')
    const sc = s.addNode('out.scatter', { x: 800, y: 0 })
    s.connect({ source: j, sourceHandle: 'out', target: sc, targetHandle: 'in' })
    s.setParam(sc, 'x', 'x')
    s.setParam(sc, 'y', 'y')
    s.setParam(sc, 'aspect', 'equal')
    s.setParam(sc, 'pointColorMode', 'categorical')
    s.setParam(sc, 'pointColorBy', 'type')
    await s.runAll()
    s.expandNode(sc)
    return true
  })`)
  await new Promise((done) => setTimeout(done, 1500))
  console.log(`screenshot: ${await page.screenshot('bigclust-scatter')}`)
}

page.close()
server.close()
report.finish()
