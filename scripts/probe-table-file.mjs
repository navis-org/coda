#!/usr/bin/env node
/**
 * Link Table and Read Rows in a real browser — the half of them jsdom cannot reach.
 *
 *   pnpm dev --port 5177 &   # or pass --url for another server
 *   pnpm probe:table-file
 *
 * Every vitest run reads table files on the test's own thread, because Node has no `Worker`; the
 * worker is the path every browser takes and nothing else executes it. The card's file picker is
 * the other half: a `File` handed over by a real `<input type="file">`, held by the registry, read
 * by slicing. So this drives both routes a user has, end to end, through the running app:
 *
 *  1. **a URL** — the fixture as the dev server serves it, which answers HEAD and Range the way a
 *     bucket does, so this is the Range path as well as the worker path;
 *  2. **a local file** — the same fixture set on the card's own input over CDP;
 *  3. **a Feather file with an index column** — the lookup builds the block index in the worker,
 *     which has its own IndexedDB, and the index must be there afterwards;
 *  4. **a remembered file** — held through a real `FileSystemFileHandle`, then the page reloaded:
 *     the file must come back through its handle and read the same rows;
 *  5. **an edge list** — the file wired into a Custom Dataset's Edges socket and asked a
 *     Connectivity question: read whole, in the edge-list worker, and answered from memory;
 *  6. **a synapse table** — the same file on the Synapses socket, a Synapses node below: looked up
 *     by neuron in the table-file worker, with the lookup column's block index built and kept.
 *
 * Each must find the three rows of one id, through the worker, and the card must say what it
 * opened. A screenshot of the card is written to the temp directory for looking at.
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { APP_MODULE, launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

const args = probeArgs()
const BASE = args.value('--url') ?? 'http://localhost:5177'
const FIXTURE = 'src/data/files/__fixtures__/synapses.parquet'
const ID = '720575940600000001'

const page = await launchChrome({ port: 9361, profile: '/tmp/coda-table-file-profile' })
const report = probeReport()

await page.send('Page.navigate', { url: `${BASE}/#!demo://core.readRows` })
const STORE = `(${APP_MODULE})('/src/store/graphStore.ts').then((m) => m.useGraphStore.getState())`
await page.waitFor(
  `${STORE}.then((s) => s.graph.nodes.some((n) => n.type === 'core.readRows'))`,
  'the Read Rows demo to open',
)
const ids = await page.evaluate(`${STORE}.then((s) => ({
  file: s.graph.nodes.find((n) => n.type === 'core.linkTable')?.id,
  rows: s.graph.nodes.find((n) => n.type === 'core.readRows')?.id,
}))`)
report.check(Boolean(ids.file && ids.rows), 'the demo carries a Link Table feeding Read Rows')

/** A run's state, and its error where it has one — for the line a check prints. */
const outcome = (read) => `${read.info.state}${read.info.error ? `: ${read.info.error}` : ''}`

/*
 * Record every worker the page constructs. Resource timing does not list a worker's script, so
 * whether the read left the page thread is asked of the constructor instead. Installed again after
 * the reload in step 4, which takes it away.
 */
const SPY_ON_WORKERS = `(() => {
  window.__workers = []
  const Native = window.Worker
  window.Worker = class extends Native {
    constructor(url, options) {
      super(url, options)
      window.__workers.push(String(url))
    }
  }
})()`
await page.evaluate(SPY_ON_WORKERS)

/** Set params, run Read Rows, and hand back what it produced and how. */
async function readThrough(fileParams) {
  return page.evaluate(`${STORE}.then(async (s) => {
    for (const [k, v] of Object.entries(${JSON.stringify(fileParams)})) s.setParam('${ids.file}', k, v)
    s.setParam('${ids.rows}', 'matchColumn', 'pre_pt_root_id')
    s.setParam('${ids.rows}', 'ids', '${ID}')
    await s.runNode('${ids.rows}')
    const state = await ${STORE}
    const out = state.nodeOutput('${ids.rows}', 'out')
    return {
      info: state.nodeInfo('${ids.rows}'),
      rows: out?.length,
      pre: out?.data?.pre_pt_root_id,
      size: out?.data?.size,
      worker: window.__workers.some((url) => url.includes('/data/files/worker')),
    }
  })`)
}

// ── 1. A URL, read by Range request, in the worker ─────────────────────────────────────────────
const byUrl = await readThrough({ url: `${BASE}/${FIXTURE}`, fileId: '', fileName: '' })
report.check(
  byUrl.info.state === 'ok' && byUrl.rows === 3,
  `a URL: three rows for one id (${outcome(byUrl)})`,
)
report.check(
  JSON.stringify(byUrl.pre) === JSON.stringify([ID, ID, ID]),
  'the eighteen-digit ids arrive exact, as text',
)
report.check(JSON.stringify(byUrl.size) === '[13,14,15]', `the numbers arrive as numbers (${byUrl.size})`)
report.check(byUrl.worker, 'the read ran in the worker, not on the page thread')

// ── 1b. A Filter Table between them: nothing read there, the condition applied in the worker ───
await page.evaluate('window.__workers = []')
const filtered = await page.evaluate(`${STORE}.then(async (s) => {
  const flt = s.addNode('core.filterTable', { x: 300, y: 200 })
  s.setParam(flt, 'column', 'score')
  s.setParam(flt, 'op', 'ge')
  s.setParam(flt, 'value', '0.4')
  s.connect({ source: '${ids.file}', sourceHandle: 'file', target: flt, targetHandle: 'in' })
  s.connect({ source: flt, sourceHandle: 'out', target: '${ids.rows}', targetHandle: 'file' })
  await s.runNode('${ids.rows}')
  const state = await ${STORE}
  const out = state.nodeOutput('${ids.rows}', 'out')
  const result = {
    info: state.nodeInfo('${ids.rows}'),
    size: out?.data?.size,
    handed: state.nodeOutput(flt, 'out')?.kind,
    worker: window.__workers.some((url) => url.includes('/data/files/worker')),
  }
  // Back as it was, for the steps below.
  s.deleteNodes([flt])
  s.connect({ source: '${ids.file}', sourceHandle: 'file', target: '${ids.rows}', targetHandle: 'file' })
  return result
})`)
report.check(
  filtered.info.state === 'ok' && JSON.stringify(filtered.size) === '[14,15]',
  `a Filter Table below the file: the lookup's rows with the low score dropped (${outcome(filtered)}, ${filtered.size})`,
)
report.check(
  filtered.handed === 'tableFile' && filtered.worker,
  'handed on as a file, and applied in the worker',
)

// ── 2. A local file, through the card's own input ──────────────────────────────────────────────
await page.evaluate(`${STORE}.then((s) => s.setParam('${ids.file}', 'url', ''))`)
const doc = await page.send('DOM.getDocument', { depth: -1, pierce: true })
const input = await page.send('DOM.querySelector', {
  nodeId: doc.result.root.nodeId,
  selector: 'input[aria-label="Choose a Parquet or Feather file"]',
})
report.check(Boolean(input.result?.nodeId), 'the card draws its file input')
await page.send('DOM.setFileInputFiles', {
  nodeId: input.result.nodeId,
  files: [resolve(FIXTURE)],
})
await page.waitFor(
  `${STORE}.then((s) => Boolean(s.graph.nodes.find((n) => n.id === '${ids.file}')?.params.fileId))`,
  'the card to take the file',
)
const status = await page.evaluate(
  `document.querySelector('[data-id="${ids.file}"] .upload-body__status')?.textContent ?? ''`,
)
report.check(/Parquet · 12 rows · 3 row groups/.test(status), `the card says what it opened ("${status}")`)

await page.evaluate('window.__workers = []')
const byFile = await readThrough({})
report.check(
  byFile.info.state === 'ok' && JSON.stringify(byFile.size) === '[13,14,15]',
  `a local file: the same rows (${outcome(byFile)})`,
)
report.check(byFile.worker, 'and that read ran in the worker too')

// The card alone, magnified — at the canvas' fitted zoom its text is a few pixels tall.
const card = await page.rect(`[data-id="${ids.file}"]`)
if (card) {
  const shot = await page.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: card.left - 8, y: card.top - 8, width: card.width + 16, height: card.height + 16, scale: 4 },
  })
  const file = join(tmpdir(), 'coda-table-file-card.png')
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
  console.log(`card screenshot: ${file}`)
}
// ── 3. A Feather index, built in the worker and kept in IndexedDB ─────────────────────────────
const FEATHER = 'src/data/files/__fixtures__/synapses.feather'
// `size` alone: the fixture's `hash` is past 2^53, which Feather keeps no statistics to reveal,
// so read as a number it is refused — correctly, and not what this step is about.
await page.evaluate(`${STORE}.then((s) => s.setParam('${ids.rows}', 'columns', ['size']))`)
await page.evaluate('window.__workers = []')
const indexed = await readThrough({
  url: `${BASE}/${FEATHER}`,
  fileId: '',
  fileName: '',
  indexColumns: ['pre_pt_root_id'],
})
// Through the app's own store, keyed by the fingerprint the file node published: the worker wrote
// it, and this asks the page's side of the same database.
const index = await page.evaluate(`${STORE}.then(async (s) => {
  const file = s.nodeOutput('${ids.file}', 'file')
  const store = await (${APP_MODULE})('/src/data/files/store.ts')
  const held = await store.loadIndex(file.fingerprint, 'pre_pt_root_id')
  return held ? held.mins.length : 0
})`)
report.check(
  indexed.info.state === 'ok' && JSON.stringify(indexed.size) === '[13,14,15]',
  `a Feather file with an index column: the same rows (${outcome(indexed)})`,
)
report.check(indexed.worker, 'in the worker')
report.check(index === 3, `and built its block index there, and kept it (${index} blocks)`)

// ── 4. A remembered file, back after a reload ─────────────────────────────────────────────────
/*
 * The picker cannot be driven headless, but a file in the origin-private file system has a real
 * `FileSystemFileHandle` — permission already granted — so the path a reload takes is the real
 * one: the handle into IndexedDB, and back out, and read.
 */
const REGISTRY = `(${APP_MODULE})('/src/data/files/registry.ts')`
await page.evaluate(`(async () => {
  const bytes = await (await fetch('${BASE}/${FIXTURE}')).arrayBuffer()
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle('synapses.parquet', { create: true })
  const writable = await handle.createWritable()
  await writable.write(bytes)
  await writable.close()
  const id = (await ${REGISTRY}).holdLocalFile(await handle.getFile(), handle)
  const s = await ${STORE}
  s.setParam('${ids.file}', 'url', '')
  s.setParam('${ids.file}', 'indexColumns', [])
  s.setParam('${ids.file}', 'fileName', 'synapses.parquet')
  s.setParam('${ids.file}', 'fileId', id)
  window.__remembered = id
})()`)
const remembered = await page.evaluate('window.__remembered')
// Long enough for the handle's write and the autosave to land before the page goes.
await new Promise((resolve) => setTimeout(resolve, 2000))
await page.send('Page.reload', {})
await page.waitFor(
  `${STORE}.then((s) => s.graph.nodes.some((n) => n.params.fileId === '${remembered}'))`,
  'the graph to come back with the remembered file',
)
await page.waitFor(
  `${REGISTRY}.then((r) => r.localFileState('${remembered}') !== 'restoring')`,
  'the handle lookup to settle',
)
const state = await page.evaluate(`${REGISTRY}.then((r) => r.localFileState('${remembered}'))`)
report.check(state === 'held', `after a reload the file is back, read through its handle (${state})`)
await page.evaluate(`window.__workers = []`)
const afterReload = await readThrough({})
report.check(
  afterReload.info.state === 'ok' && JSON.stringify(afterReload.size) === '[13,14,15]',
  `and reads the same rows (${outcome(afterReload)})`,
)

// ── 5. An edge list, from the file into a Custom Dataset and out of Connectivity ─────────────
await page.evaluate(SPY_ON_WORKERS)
const edges = await page.evaluate(`${STORE}.then(async (s) => {
  s.setParam('${ids.file}', 'fileId', '')
  s.setParam('${ids.file}', 'fileName', '')
  s.setParam('${ids.file}', 'url', '${BASE}/${FIXTURE}')
  const custom = s.addNode('connectome:customDataset', { x: 900, y: 0 })
  const input = s.addNode('neuron.inputIds', { x: 1200, y: 0 })
  const conn = s.addNode('neuron.connectivity', { x: 1500, y: 0 })
  s.connect({ source: '${ids.file}', sourceHandle: 'file', target: custom, targetHandle: 'edges' })
  s.setParam(custom, 'pre', 'pre_pt_root_id')
  s.setParam(custom, 'post', 'post_pt_root_id')
  s.setParam(custom, 'weight', 'size')
  s.setParam(input, 'ids', '${ID}')
  s.setParam(conn, 'direction', 'outputs')
  s.connect({ source: custom, sourceHandle: 'dataset', target: input, targetHandle: 'dataset' })
  s.connect({ source: custom, sourceHandle: 'dataset', target: conn, targetHandle: 'dataset' })
  s.connect({ source: input, sourceHandle: 'neurons', target: conn, targetHandle: 'neurons' })
  await s.runNode(conn)
  const state = await ${STORE}
  const out = state.nodeOutput(conn, 'connections')
  return {
    info: state.nodeInfo(conn),
    post: out?.data?.postId,
    weight: out?.data?.weight,
    worker: window.__workers.some((url) => url.includes('/data/edges/worker')),
  }
})`)
report.check(
  edges.info.state === 'ok' && edges.post?.length === 3,
  `an edge list from the file answers Connectivity: three partners (${outcome(edges)})`,
)
report.check(
  JSON.stringify([...(edges.weight ?? [])].sort()) === '[13,14,15]' &&
    edges.post.every((id) => id.length === 18),
  `with the file's weights, and exact partner ids (${edges.post}: ${edges.weight})`,
)
report.check(edges.worker, 'read in the edge-list worker')

// ── 6. A synapse table, looked up by neuron ────────────────────────────────────────────────────
await page.evaluate(SPY_ON_WORKERS)
// Feather, which keeps no statistics: a sorted Parquet file is skipped by its own row-group ranges
// and needs no index, so the build stands down there by design (`withBlockIndex`).
const synapses = await page.evaluate(`${STORE}.then(async (s) => {
  s.setParam('${ids.file}', 'url', '${BASE}/${FEATHER}')
  const custom = s.addNode('connectome:customDataset', { x: 900, y: 400 })
  const input = s.addNode('neuron.inputIds', { x: 1200, y: 400 })
  const syn = s.addNode('neuron.synapses', { x: 1500, y: 400 })
  s.connect({ source: '${ids.file}', sourceHandle: 'file', target: custom, targetHandle: 'synapses' })
  s.setParam(custom, 'synPre', 'pre_pt_root_id')
  s.setParam(custom, 'synPost', 'post_pt_root_id')
  // The fixture has no coordinates; three numeric columns stand in for them.
  s.setParam(custom, 'synPosition', ['size', 'size', 'score'])
  s.setParam(input, 'ids', '${ID}')
  s.setParam(syn, 'polarity', 'pre')
  s.connect({ source: custom, sourceHandle: 'dataset', target: input, targetHandle: 'dataset' })
  s.connect({ source: custom, sourceHandle: 'dataset', target: syn, targetHandle: 'dataset' })
  s.connect({ source: input, sourceHandle: 'neurons', target: syn, targetHandle: 'neurons' })
  await s.runNode(syn)
  const state = await ${STORE}
  const out = state.nodeOutput(syn, 'points')
  const file = state.nodeOutput('${ids.file}', 'file')
  const store = await (${APP_MODULE})('/src/data/files/store.ts')
  const index = await store.loadIndex(file.fingerprint, 'pre_pt_root_id')
  return {
    info: state.nodeInfo(syn),
    ids: out?.attributes?.data?.neuronId,
    x: out ? [...out.positions].filter((_, i) => i % 3 === 0) : undefined,
    worker: window.__workers.some((url) => url.includes('/data/files/worker')),
    index: index ? index.mins.length : 0,
  }
})`)
report.check(
  synapses.info.state === 'ok' && synapses.ids?.length === 3 && synapses.ids.every((id) => id === ID),
  `a synapse table from the file answers Synapses: three rows, exact ids (${outcome(synapses)})`,
)
report.check(JSON.stringify(synapses.x) === '[13,14,15]', `at the file's coordinates (${synapses.x})`)
report.check(synapses.worker, 'looked up in the table-file worker')
report.check(synapses.index === 3, `and indexed its lookup column on the way (${synapses.index} blocks)`)

report.finish()
process.exit(0)
