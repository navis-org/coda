#!/usr/bin/env node
/**
 * What handing a 3D View between its card and the overlay costs. `pnpm probe:viewer3d-switch`
 * (needs a dev server — `pnpm dev --port 5191`, or pass `--url` — and a neuPrint token in
 * `NEUPRINT_APPLICATION_CREDENTIALS`).
 *
 * ## Why this exists
 *
 * The card stands down while the overlay owns its node (`showPreview` in `CodaNodeView`), so a
 * switch between them used to unmount one `<Canvas>` and mount another: a new WebGL context, every
 * geometry rebuilt, every buffer uploaded, every program compiled. `PersistentCanvas` now hands one
 * renderer between them, and this is the measurement on both sides of that change and the check
 * that it holds — that a switch builds nothing, that the handed-over canvas still picks and turns,
 * and that a renderer nobody is looking at is released. jsdom has no WebGL to ask any of it.
 *
 * ## What it reads
 *
 * - **A CPU profile of each switch**, self time folded into buckets by the deepest function on the
 *   stack that names one — so a `bufferData` inside React's commit counts as an upload, not React.
 * - **Long tasks**, which is what a person feels: the main thread was not answering.
 * - **The WebGL calls themselves**, wrapped on the prototype: bytes uploaded, triangles in the
 *   index buffers, time in compile/link, contexts created, draw calls.
 *
 * A switch is *settled* once nothing — no long task, no draw call — has happened for
 * `QUIET_MS`. It runs on the dev server, so React is in development mode and its share is an upper
 * bound; three.js, the GL calls and the geometry work are the same code a build ships.
 *
 * ## The token
 *
 * Read from the environment and handed to the page as a **function argument** through
 * `Runtime.callFunctionOn`, never pasted into an expression string, so no error message or log line
 * can carry it. Nothing here prints it, and the Chrome profile holding it is deleted on exit.
 *
 *   pnpm probe:viewer3d-switch
 *   pnpm probe:viewer3d-switch -- --type 'LC10.*' --limit 40 --detail 6000000 --cycles 3
 *   pnpm probe:viewer3d-switch -- --pick         # Select by clicking on, so pick trees build too
 *   pnpm probe:viewer3d-switch -- --skeletons    # skeletons on the same neurons, in the same scene
 *   pnpm probe:viewer3d-switch -- --memory --pick --cycles 0   # bytes of normals and pick trees
 *   pnpm probe:viewer3d-switch -- --pick --cycles 1 --interact  # pick, turn and double-click after a handover
 *   pnpm probe:viewer3d-switch -- --topology --dataset dataset.hemibrain   # a Neuron Topology card instead
 *   pnpm probe:viewer3d-switch -- --neuroglancer --limit 10   # the Neuroglancer frame, kept rather than reloaded
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

import { launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5191/'
const typePattern = args.value('--type') ?? 'LC10.*'
const limit = Number(args.value('--limit') ?? 40)
const detail = args.value('--detail') ?? '1500000'
const cycles = Number(args.value('--cycles') ?? 3)
const pick = args.all.includes('--pick')
const withSkeletons = args.all.includes('--skeletons')
/** `--topology`: a Neuron Topology card instead of a 3D View, which draws through the same viewer. */
const topology = args.all.includes('--topology')
/** `--neuroglancer`: a Neuroglancer card, whose frame is handed between surfaces by `moveBefore`. */
const neuroglancer = args.all.includes('--neuroglancer')
/** The dataset node type the scene is fetched from. Any neuPrint family the token can read. */
const datasetType = args.value('--dataset') ?? 'dataset.malecns'

/** How long nothing has to happen before a switch counts as settled. */
const QUIET_MS = 1500
/** `RELEASE_AFTER_MS` in `persistentRoots.ts`, which a script cannot import. */
const GRACE_MS = 5000
/** How long a switch may take before the probe gives up on it. */
const MAX_SETTLE_MS = 60_000
const PROFILE = '/tmp/coda-probe-viewer3d-switch'

/** The app's own store, as a page-side expression inside an async function. */
const STORE = `(await import('/src/store/graphStore.ts')).useGraphStore`
/** Draw and compile calls, named once for the recorder, the settle check and the report. */
const DRAW_CALLS = ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']
const COMPILE_CALLS = [
  'compileShader',
  'linkProgram',
  'getProgramParameter',
  'getShaderParameter',
  'getProgramInfoLog',
  'getShaderInfoLog',
]

/** The token, from the variable or from a file it names. Never printed. */
function readToken() {
  const raw = process.env.NEUPRINT_APPLICATION_CREDENTIALS
  if (!raw) {
    console.error('NEUPRINT_APPLICATION_CREDENTIALS is not set.')
    process.exit(2)
  }
  if (!existsSync(raw)) return raw.trim()
  const text = readFileSync(raw, 'utf8').trim()
  try {
    const parsed = JSON.parse(text)
    return String(parsed.token ?? parsed.access_token ?? text)
  } catch {
    return text
  }
}

const token = readToken()

const { send, evaluate, waitFor, screenshot, click, doubleClick, drag, rect, close } =
  await launchChrome({
    port: 9451,
    profile: PROFILE,
    width: 1600,
    height: 1000,
    args: ['--use-angle=metal', '--enable-gpu'],
  })
const { check, finish } = probeReport()

/*
 * The profile holds the token in `localStorage`, so it must not outlive the run — on the failing
 * paths above all, which are the ones nobody is watching.
 *
 * Registered *after* the launch and closing Chrome itself, because `exit` handlers run in
 * registration order: registered first, the delete ran while the browser was still alive and
 * writing, and the profile survived an error exit. Retried, because a killed Chrome still flushes
 * for a moment and a single `rmSync` then fails with ENOTEMPTY.
 */
process.on('exit', () => {
  close()
  try {
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  } catch {
    console.error(`Could not delete ${PROFILE}, which holds the token. Delete it by hand.`)
  }
})

/** Run `body` in the page with the store bound to `S`, and hand back what it returns. */
const inStore = (body) => evaluate(`(async () => { const S = ${STORE}; ${body} })()`)

// ── Boot, token, renderer ──────────────────────────────────────────────────────────────────────

await send('Page.navigate', { url })
await waitFor(`!!document.querySelector('.app .toolbar')`, 'the shell to mount')

async function clearLaunch() {
  for (let i = 0; i < 30; i++) {
    const clear = await evaluate(`(() => {
      document.querySelector('.small-screen__actions button')?.click()
      document.querySelector('.start__close')?.click()
      document.querySelector('.overlay__close, .overlay [aria-label="Close"]')?.click()
      return !document.querySelector('.start') && !document.querySelector('.overlay')
    })()`)
    if (clear) return
    await sleep(150)
  }
  throw new Error('the launch sequence did not close')
}
await clearLaunch()

{
  const global = await send('Runtime.evaluate', { expression: 'globalThis' })
  const reply = await send('Runtime.callFunctionOn', {
    objectId: global.result.result.objectId,
    functionDeclaration: `async function (t) {
      const m = await import('/src/data/neuprint/credentials.ts')
      m.setToken(t)
      return !!m.getToken()
    }`,
    arguments: [{ value: token }],
    awaitPromise: true,
    returnByValue: true,
  })
  // The reply is checked, never printed: it carries a boolean, but an exception detail is not
  // somewhere to take chances.
  if (reply.result?.exceptionDetails || reply.result?.result?.value !== true) {
    console.error('Could not hand the token to the page.')
    process.exit(1)
  }
}

const renderer = await evaluate(`(() => {
  const gl = document.createElement('canvas').getContext('webgl2')
  const ext = gl?.getExtension('WEBGL_debug_renderer_info')
  const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'
  gl?.getExtension('WEBGL_lose_context')?.loseContext()
  return name
})()`)
console.log(`renderer  ${renderer}`)
if (/swiftshader/i.test(renderer)) {
  console.error('Software rasteriser — these numbers would mean nothing. See docs/viewers.md.')
  process.exit(1)
}

// ── The page-side recorder ─────────────────────────────────────────────────────────────────────

await evaluate(`(() => {
  const probe = (window.__probe = {
    reset() {
      this.gl = {}
      this.longtasks = []
      this.lastDraw = 0
      this.draws = 0
      this.contexts = 0
    },
    /*
     * React Three Fiber's root registry, imported at the URL the viewer itself imported so it is the
     * same module instance — read off the dev server's transform of the file, once. Resource timing
     * was the first attempt, and its 250-entry buffer is full long before the lazy viewer arrives.
     */
    async roots() {
      if (!this.fiber) {
        const source = await (await fetch('/src/ui/viewers/Viewer3D.tsx')).text()
        const found = /from\\s+["'](\\/node_modules\\/\\.vite\\/deps\\/@react-three_fiber\\.js[^"']*)["']/.exec(source)
        if (!found) throw new Error('could not find the @react-three/fiber import in Viewer3D.tsx')
        this.fiber = await import(found[1])
      }
      return this.fiber._roots
    },
    /** A canvas's scene and its neuron surfaces: the compass has a scene of its own, and a fat line is a Mesh too. */
    async neuronMeshes(selector) {
      const canvas = document.querySelector(selector)
      const state = (await this.roots()).get(canvas).store.getState()
      const meshes = []
      state.scene.traverse((o) => {
        if (o.isMesh && !o.isLineSegments2 && (o.geometry?.index?.count ?? 0) > 3000) meshes.push(o)
      })
      return { canvas, state, meshes }
    },
  })
  probe.reset()
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) probe.longtasks.push([e.startTime, e.duration])
  }).observe({ type: 'longtask' })

  const ELEMENT_ARRAY_BUFFER = 34963
  const tally = (name) => (probe.gl[name] ??= { calls: 0, ms: 0, bytes: 0, indexBytes: 0 })
  const wrap = (proto, name, extra) => {
    const original = proto[name]
    if (typeof original !== 'function') return
    proto[name] = function (...a) {
      const t = performance.now()
      try {
        return original.apply(this, a)
      } finally {
        const now = performance.now()
        const entry = tally(name)
        entry.calls++
        entry.ms += now - t
        extra?.(entry, a, now)
      }
    }
  }
  const P = WebGL2RenderingContext.prototype
  wrap(P, 'bufferData', (entry, a) => {
    const size = typeof a[1] === 'number' ? a[1] : (a[1]?.byteLength ?? 0)
    entry.bytes += size
    if (a[0] === ELEMENT_ARRAY_BUFFER) entry.indexBytes += size
  })
  wrap(P, 'bufferSubData', (entry, a) => (entry.bytes += a[2]?.byteLength ?? 0))
  for (const name of ['texImage2D', 'texStorage2D', ...${JSON.stringify(COMPILE_CALLS)}]) wrap(P, name)
  for (const name of ${JSON.stringify(DRAW_CALLS)}) {
    wrap(P, name, (_entry, _a, now) => {
      probe.draws++
      probe.lastDraw = now
    })
  }
  wrap(HTMLCanvasElement.prototype, 'getContext', (_entry, a) => {
    if (String(a[0]).startsWith('webgl')) probe.contexts++
  })
  return true
})()`)

// ── The scene ──────────────────────────────────────────────────────────────────────────────────

const ids = await inStore(`
  const { encodeRows } = await import('/src/data/filterRows.ts')
  const st = S.getState()
  st.newGraph()
  const at = (x, y) => ({ x, y })
  const wire = (source, sourceHandle, target, targetHandle) =>
    S.getState().connect({ source, sourceHandle, target, targetHandle })
  const ds = st.addNode(${JSON.stringify(datasetType)}, at(0, 0))
  const find = st.addNode('neuron.findNeurons', at(420, 0))
  wire(ds, 'dataset', find, 'dataset')
  S.getState().setParam(find, 'filters', encodeRows([{ field: 'type', op: 'matches', values: [${JSON.stringify(typePattern)}] }]))
  S.getState().setParam(find, 'limit', ${limit})
  if (${neuroglancer}) {
    const view = st.addNode('out.neuroglancer', at(60, 380))
    wire(ds, 'dataset', view, 'dataset')
    wire(find, 'neurons', view, 'neurons')
    return { view }
  }
  if (${topology}) {
    // Neuron Topology fetches its own skeleton, one neuron at a time, and draws through Viewer3D.
    const view = st.addNode('out.topology', at(60, 380))
    wire(ds, 'dataset', view, 'dataset')
    wire(find, 'neurons', view, 'neurons')
    return { view }
  }
  const meshes = st.addNode('neuron.meshes', at(840, 0))
  const view = st.addNode('out.viewer3d', at(60, 380))
  wire(ds, 'dataset', meshes, 'dataset')
  wire(find, 'neurons', meshes, 'neurons')
  wire(meshes, 'meshes', view, 'meshes')
  if (${withSkeletons}) {
    const skeletons = st.addNode('neuron.skeletons', at(840, 260))
    wire(ds, 'dataset', skeletons, 'dataset')
    wire(find, 'neurons', skeletons, 'neurons')
    wire(skeletons, 'skeletons', view, 'skeletons')
  }
  S.getState().setParam(meshes, 'detail', ${JSON.stringify(detail)})
  S.getState().setParam(view, 'selectByClick', ${pick})
  return { view }
`)

const VIEW = JSON.stringify(ids.view)
const CARD_CANVAS = `.react-flow__node[data-id="${ids.view}"] .viewer3d-canvas canvas`
const OVERLAY_CANVAS = `.viewer-panel .viewer3d-canvas canvas`
const CARD_FRAME = `.react-flow__node[data-id="${ids.view}"] .ng-frame iframe`
const OVERLAY_FRAME = `.viewer-panel .ng-frame iframe`
const CAPTION = `.react-flow__node[data-id="${ids.view}"] .viewer__caption`
const present = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
const waitForSelector = (selector, what) =>
  waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, what)

// A dataset listing that has not arrived yet refuses the run with "Run again", so this retries.
let caption = ''
/*
 * Ready means geometry on the card. A 3D View says so in its caption — for both sockets when both
 * are wired, since a scene measured before its skeletons land measures meshes alone. A Topology card
 * has no mesh count to say it with and fetches its own skeleton after the run, so there it is the
 * canvas.
 */
const sceneReady = async () =>
  neuroglancer
    ? await present(CARD_FRAME)
    : topology
      ? await present(CARD_CANVAS)
      : /\bmesh/.test(caption) && (!withSkeletons || /\bskeleton/.test(caption))
for (let attempt = 1; attempt <= 4 && !(await sceneReady()); attempt++) {
  const started = Date.now()
  await inStore(`await S.getState().runAll()`)
  console.log(`run ${attempt}  ${((Date.now() - started) / 1000).toFixed(1)} s`)
  // A Topology card fetches its own skeleton and connectivity after the run, one neuron at a time.
  await sleep(topology ? 30_000 : 1000)
  caption = (await evaluate(`document.querySelector(${JSON.stringify(CAPTION)})?.textContent ?? ''`)) ?? ''
}
if (!(await sceneReady())) {
  const card = await evaluate(
    `(document.querySelector('.react-flow__node[data-id=${VIEW}]')?.textContent ?? '(no card)').replace(/\\s+/g, ' ').slice(0, 400)`,
  )
  console.error(`Nothing drawn on the ${neuroglancer ? 'Neuroglancer' : topology ? 'Topology' : '3D View'} card. Caption: "${caption}".`)
  console.error(`Card text: ${card}`)
  console.error(`Screenshot: ${await screenshot('probe-viewer3d-switch-not-ready')}`)
  process.exit(1)
}
await waitForSelector(neuroglancer ? CARD_FRAME : CARD_CANVAS, 'the card')
console.log(`scene     ${caption.replace(/\s+/g, ' ').trim()}  (type ${typePattern}, limit ${limit}, detail ${detail}${pick ? ', picking on' : ''})`)

/** Open or close the overlay and wait for the canvas to arrive where it should now be. */
async function switchTo(expanded, selector, settleMs = 800) {
  await inStore(`S.getState().expandNode(${expanded ? VIEW : 'undefined'})`)
  await waitForSelector(selector, `the canvas at ${selector}`)
  await sleep(settleMs)
}

/*
 * `--neuroglancer`: the Neuroglancer card's frame, handed between surfaces rather than reloaded.
 *
 * `moveBefore` keeps an iframe's document where `appendChild` reloads it, so the checks are the ones
 * only a real browser can answer: the overlay shows the *same element*, it fires no `load` (a reload
 * would), and — where the dev proxy makes the frame same-origin — a marker set inside its document and
 * the state neuroglancer writes to its own hash are still there. Then the release: parked while
 * nothing shows the node, gone after the grace period, and a fresh frame on the way back.
 */
if (neuroglancer) {
  // Long enough for neuroglancer to boot and restore its scene, so there is a document worth keeping.
  await sleep(8000)
  const origin = await evaluate(`(() => {
    const f = document.querySelector(${JSON.stringify(CARD_FRAME)})
    window.__ngFrame = f
    f.__loads = 0
    f.addEventListener('load', () => f.__loads++)
    try {
      f.contentWindow.__codaKept = true
      return 'same-origin'
    } catch {
      return 'cross-origin'
    }
  })()`)
  const frameState = (selector) =>
    evaluate(`(() => {
      const f = document.querySelector(${JSON.stringify(selector)})
      if (!f) return null
      let kept = null
      let hash = null
      try {
        kept = f.contentWindow.__codaKept === true
        hash = f.contentWindow.location.hash
      } catch {}
      return { same: f === window.__ngFrame, loads: f.__loads ?? null, kept, hash }
    })()`)
  const start = await frameState(CARD_FRAME)

  console.log(`\nneuroglancer frame across surfaces (${origin})`)
  const route = [
    [true, OVERLAY_FRAME, 'overlay'],
    [false, CARD_FRAME, 'card'],
    [true, OVERLAY_FRAME, 'overlay, again'],
    [false, CARD_FRAME, 'card, again'],
  ]
  for (const [expanded, selector, where] of route) {
    await switchTo(expanded, selector, 2000)
    const at = await frameState(selector)
    check(at?.same === true, `the ${where} shows the same iframe element`)
    check(at?.loads === 0, `…which fired no load event (${at?.loads})`)
    if (origin === 'same-origin') {
      check(at?.kept === true, '…and kept its document')
      check(at?.hash === start.hash, '…and the state neuroglancer wrote to its hash')
    }
    // A kept document can still be drawn wrong — pinned at its parked size, or off its scale.
    if (args.keep) {
      console.log(`  → ${await screenshot(`probe-neuroglancer-${where.replace(/\W+/g, '-')}`)}`)
    }
  }

  await checkRelease(CARD_FRAME, async () => [
    (await frameState(CARD_FRAME))?.same === false,
    'a fresh frame built when the card came back',
  ])
  await endProbe()
}

// ── One switch ─────────────────────────────────────────────────────────────────────────────────

const BUCKETS = [
  ['GL buffer upload', (f) => /^(bufferData|bufferSubData)$/.test(f.functionName)],
  ['GL shader compile/link', (f) => f.functionName === 'shaderSource' || COMPILE_CALLS.includes(f.functionName)],
  ['GL context create', (f) => f.functionName === 'getContext'],
  ['vertex normals', (f) => f.functionName === 'computeVertexNormals'],
  ['pick trees (BVH)', (f) => /three-mesh-bvh/.test(f.url)],
  ['skeleton/point buffers', (f) => /^(buildSkeletonSegments|skeletonSegmentColors|skeletonWidthPlan|referenceRadius|buildPoints|setPositions|setColors)$/.test(f.functionName)],
  ['colour resolve', (f) => /^(resolveColor|resolveColorImpl)$/.test(f.functionName)],
  ['GC', (f) => f.functionName === '(garbage collector)'],
  ['React', (f) => /react-dom|react-reconciler|@react-three/.test(f.url)],
  ['three.js (other)', (f) => /\/three\b|three\.module|deps\/three/.test(f.url)],
  ['browser (program)', (f) => f.functionName === '(program)'],
]

/** Self time per bucket, attributed to the deepest function on the stack that names one. */
function foldProfile(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const self = new Map()
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i + 1] ?? 0) / 1000)
  }
  const buckets = {}
  /*
   * What `other JS` is made of, by the function the sample landed in. A bucket nobody can name is a
   * number nobody can act on — the first high-detail run put 65% of the switch there.
   */
  const other = {}
  for (const [id, ms] of self) {
    if (byId.get(id).callFrame.functionName === '(idle)') continue
    let bucket = 'other JS'
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const hit = BUCKETS.find(([, test]) => test(byId.get(at).callFrame))
      if (hit) {
        bucket = hit[0]
        break
      }
    }
    buckets[bucket] = (buckets[bucket] ?? 0) + ms
    if (bucket === 'other JS') {
      const frame = byId.get(id).callFrame
      const file = frame.url.split('/').pop()?.split('?')[0] || '(native)'
      const key = `${frame.functionName || '(anonymous)'}  ${file}:${frame.lineNumber + 1}`
      other[key] = (other[key] ?? 0) + ms
    }
  }
  const otherTop = Object.entries(other).sort((a, b) => b[1] - a[1]).slice(0, 8)
  return { buckets, otherTop }
}

async function measureSwitch(label, action, canvasSelector) {
  // The canvas on screen before the switch, to ask afterwards whether the new surface shows *it*.
  await evaluate(`window.__probe.reset(); window.__beforeCanvas = document.querySelector('.viewer3d-canvas canvas'); true`)
  await send('Profiler.enable')
  await send('Profiler.setSamplingInterval', { interval: 250 })
  await send('Profiler.start')
  const t0 = await inStore(`const t = performance.now(); ${action}; return t`)

  let canvasAt
  for (;;) {
    const state = await evaluate(`(() => {
      const p = window.__probe
      return {
        now: performance.now(),
        canvas: !!document.querySelector(${JSON.stringify(canvasSelector)}),
        last: Math.max(p.lastDraw, ...p.longtasks.map(([s, d]) => s + d)),
        draws: p.draws,
        recentTasks: p.longtasks.filter(([s, d]) => performance.now() - (s + d) < ${QUIET_MS}).length,
      }
    })()`)
    if (state.canvas && canvasAt === undefined) canvasAt = state.now
    const activity = Math.max(state.last, canvasAt ?? 0)
    // A switch must have drawn before it counts as done. The warm-up changes nothing, so it draws
    // nothing — requiring a draw there is what made it "never settle" on the first runs.
    const drawn = state.draws > 0 || action === ''
    if (canvasAt !== undefined && drawn && state.now - activity > QUIET_MS) break
    if (state.now - t0 > MAX_SETTLE_MS) {
      console.log(
        `${label}: did not settle within ${MAX_SETTLE_MS / 1000} s — last draw ${Math.round(state.now - state.last)} ms ago, ` +
          `${state.draws} draw calls in all, ${state.recentTasks} long task(s) in the last ${QUIET_MS} ms`,
      )
      break
    }
    await sleep(100)
  }

  const { result } = await send('Profiler.stop')
  const { buckets, otherTop } = foldProfile(result.profile)
  const page = await evaluate(`(() => {
    const p = window.__probe
    const tasks = p.longtasks.filter(([s]) => s >= ${t0})
    return {
      gl: p.gl,
      draws: p.draws,
      contexts: p.contexts,
      sameCanvas: document.querySelector(${JSON.stringify(canvasSelector)}) === window.__beforeCanvas,
      tasks: tasks.length,
      taskMs: tasks.reduce((sum, [, d]) => sum + d, 0),
      longest: Math.max(0, ...tasks.map(([, d]) => d)),
      busyUntil: Math.max(p.lastDraw, ...tasks.map(([s, d]) => s + d)) - ${t0},
    }
  })()`)
  return { label, canvasMs: canvasAt - t0, buckets, otherTop, ...page }
}

const fmt = (ms) => `${ms.toFixed(0).padStart(6)} ms`

function report(m) {
  const gl = m.gl
  const upload = gl.bufferData ?? { calls: 0, ms: 0, bytes: 0, indexBytes: 0 }
  const compile = COMPILE_CALLS.reduce((sum, name) => sum + (gl[name]?.ms ?? 0), 0)
  console.log(`\n${m.label}`)
  console.log(`  canvas in DOM     ${fmt(m.canvasMs)}`)
  console.log(`  same canvas       ${m.sameCanvas ? 'yes — the renderer was handed over' : 'no — a new renderer was built'}`)
  console.log(`  busy until        ${fmt(m.busyUntil)}   (last long task or draw after the switch)`)
  console.log(`  long tasks        ${fmt(m.taskMs)}   ${m.tasks} of them, longest ${m.longest.toFixed(0)} ms`)
  console.log(`  contexts created  ${m.contexts}`)
  console.log(`  bufferData        ${upload.calls} calls, ${(upload.bytes / 2 ** 20).toFixed(1)} MB, ` +
    `${(upload.indexBytes / 12 / 1e6).toFixed(2)} M triangles, ${upload.ms.toFixed(0)} ms in the call`)
  console.log(`  compile/link      ${compile.toFixed(0)} ms in the calls (${gl.linkProgram?.calls ?? 0} programs)`)
  console.log(`  draw calls        ${m.draws}`)
  console.log('  CPU by bucket:')
  const total = Object.values(m.buckets).reduce((a, b) => a + b, 0)
  for (const [name, ms] of Object.entries(m.buckets).sort((a, b) => b[1] - a[1])) {
    if (ms < 1) continue
    console.log(`    ${name.padEnd(26)} ${fmt(ms)}  ${((ms / total) * 100).toFixed(0).padStart(3)}%`)
  }
  console.log(`    ${'total (non-idle)'.padEnd(26)} ${fmt(total)}`)
  if (m.otherTop.length > 0) {
    console.log('  other JS, by function:')
    for (const [key, ms] of m.otherTop) console.log(`    ${fmt(ms)}  ${key}`)
  }
}

// Settle the card first, so the first switch is not measuring the run's own tail.
await measureSwitch('warm-up (card after run)', '', CARD_CANVAS)

/*
 * `--memory`: what the mounted scene holds beyond the value it draws — the bytes a cache kept
 * across mounts would have had to carry, which is how that alternative was measured and set aside.
 * Counted off the live three.js objects rather than estimated.
 *
 * Positions and indices are printed for scale only. `MeshItem` wraps the value's own arrays without
 * copying, so they are already paid for by the value; normals and pick trees are not.
 */
if (args.all.includes('--memory')) {
  const mem = await evaluate(`(async () => {
    const { meshes } = await window.__probe.neuronMeshes(${JSON.stringify(CARD_CANVAS)})
    const deadline = performance.now() + 120000
    while (${pick} && meshes.some((m) => !m.geometry.boundsTree) && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
    }
    const out = { meshes: meshes.length, triangles: 0, vertices: 0, positions: 0, index: 0, normals: 0, bvhNodes: 0, bvhIndirect: 0, withoutTree: 0 }
    for (const m of meshes) {
      const g = m.geometry
      out.triangles += g.index.count / 3
      out.vertices += g.attributes.position.count
      out.positions += g.attributes.position.array.byteLength
      out.index += g.index.array.byteLength
      out.normals += g.attributes.normal?.array.byteLength ?? 0
      const tree = g.boundsTree
      if (!tree) { out.withoutTree++; continue }
      for (const buffer of tree._roots) out.bvhNodes += buffer.byteLength
      out.bvhIndirect += tree._indirectBuffer?.byteLength ?? 0
    }
    return out
  })()`)
  const mb = (b) => `${(b / 2 ** 20).toFixed(1).padStart(7)} MB`
  const perTri = (b) => `${(b / mem.triangles).toFixed(1)} B/triangle`
  console.log(`\nmemory    ${mem.meshes} meshes, ${(mem.triangles / 1e6).toFixed(2)} M triangles, ${(mem.vertices / 1e6).toFixed(2)} M vertices`)
  console.log(`  already the value's   positions ${mb(mem.positions)}   index ${mb(mem.index)}`)
  console.log(`  normals               ${mb(mem.normals)}   ${perTri(mem.normals)}`)
  if (pick) {
    console.log(`  pick-tree nodes       ${mb(mem.bvhNodes)}   ${perTri(mem.bvhNodes)}`)
    console.log(`  pick-tree indirection ${mb(mem.bvhIndirect)}   ${perTri(mem.bvhIndirect)}`)
    if (mem.withoutTree) console.log(`  (${mem.withoutTree} meshes still had no tree when counted)`)
  }
  console.log(`  cacheable total       ${mb(mem.normals + (pick ? mem.bvhNodes + mem.bvhIndirect : 0))}`)
}

const results = []
for (let i = 1; i <= cycles; i++) {
  const open = await measureSwitch(`#${i} card → overlay`, `S.getState().expandNode(${VIEW})`, OVERLAY_CANVAS)
  report(open)
  results.push(open)
  if (args.keep && i === 1) console.log(`  → ${await screenshot('probe-viewer3d-switch-overlay')}`)
  const back = await measureSwitch(`#${i} overlay → card`, `S.getState().expandNode(undefined)`, CARD_CANVAS)
  report(back)
  results.push(back)
  if (args.keep && i === 1) console.log(`  → ${await screenshot('probe-viewer3d-switch-card')}`)
}

/*
 * `--interact`: the gestures a handed-over renderer has to keep answering.
 *
 * The renderer is kept and the chrome remounts precisely so that events stay on the surface's own
 * React tree, and the pointer binding stays on the host the renderer carries with it. Both halves
 * fail silently — a canvas that draws and ignores the pointer — so each is driven with real input:
 * a pick in each surface, a trackball drag in each, the card inheriting the overlay's camera, and
 * the card's double-click still opening the overlay.
 */
if (args.all.includes('--interact') && cycles > 0 && pick) {
  /** Where one vertex of the first neuron mesh is on screen, and the live camera, in one read. */
  const look = (selector) =>
    evaluate(`(async () => {
      const { canvas, state, meshes } = await window.__probe.neuronMeshes(${JSON.stringify(selector)})
      const g = meshes[0].geometry
      const p = new state.camera.position.constructor()
        .fromBufferAttribute(g.attributes.position, g.index.array[Math.floor(g.index.count / 2)])
        .applyMatrix4(meshes[0].matrixWorld)
        .project(state.camera)
      const r = canvas.getBoundingClientRect()
      return {
        x: r.left + ((p.x + 1) / 2) * r.width,
        y: r.top + ((1 - p.y) / 2) * r.height,
        centre: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        quaternion: state.camera.quaternion.toArray(),
      }
    })()`)
  const selected = () =>
    inStore(`return (S.getState().graph.nodes.find((n) => n.id === ${VIEW})?.params.selection ?? []).length`)
  const turned = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 1e-4)

  /** A pick and a trackball turn in one surface, each checked. Returns where the camera was left. */
  async function pickAndTurn(selector, where, offset) {
    const before = await selected()
    const at = await look(selector)
    await click(at.x, at.y)
    await sleep(400)
    const after = await selected()
    check(after !== before, `a click on a neuron in the ${where} picks it (${before} → ${after} selected)`)
    await drag(at.centre, { x: at.centre.x + offset.x, y: at.centre.y + offset.y })
    await sleep(400)
    const moved = await look(selector)
    check(turned(at.quaternion, moved.quaternion), `a drag in the ${where} turns the camera`)
    return moved
  }

  console.log('\ninteraction after a handover')
  await switchTo(true, OVERLAY_CANVAS)
  const leftByOverlay = await pickAndTurn(OVERLAY_CANVAS, 'overlay', { x: 140, y: 60 })

  await switchTo(false, CARD_CANVAS)
  const inCard = await look(CARD_CANVAS)
  check(!turned(leftByOverlay.quaternion, inCard.quaternion), 'the card carries on with the camera the overlay left')
  await pickAndTurn(CARD_CANVAS, 'card', { x: 80, y: 40 })

  await doubleClick(inCard.centre.x, inCard.centre.y + 30)
  await sleep(600)
  check((await inStore(`return S.getState().expandedNodeId`)) === ids.view, "a double-click on the card's preview still opens the overlay")
  await switchTo(false, CARD_CANVAS, 500)
}

/*
 * `--topology --interact`: a kept renderer keeps its camera, so a Topology card has to frame each
 * neuron it pages to (`frameKey`) while still keeping a turned view across a card ↔ overlay switch.
 * `framingFor` puts the camera on the +z axis looking at the recentred origin, so a framed camera
 * has no x or y, and a turned one has some.
 */
if (topology && args.all.includes('--interact')) {
  const cameraAt = (selector) =>
    evaluate(`(async () => {
      const canvas = document.querySelector(${JSON.stringify(selector)})
      if (!canvas) return null
      return (await window.__probe.roots()).get(canvas).store.getState().camera.position.toArray()
    })()`)
  const framed = (p) => !!p && Math.hypot(p[0], p[1]) < 1e-6 * Math.hypot(...p)
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3 * Math.hypot(...a))

  console.log('\ncamera on a Topology card')
  // The left quarter: the partner rail sits over the right of the stage.
  const box = await rect(CARD_CANVAS)
  const from = { x: box.left + box.width / 4, y: box.top + box.height / 2 }
  check(framed(await cameraAt(CARD_CANVAS)), 'the first neuron is framed')
  await drag(from, { x: from.x + 60, y: from.y + 40 })
  await sleep(400)
  const turned = await cameraAt(CARD_CANVAS)
  check(!framed(turned), 'a drag turns the camera off its framing')

  await switchTo(true, OVERLAY_CANVAS)
  check(same(turned, await cameraAt(OVERLAY_CANVAS)), 'the overlay keeps the turned camera')
  await switchTo(false, CARD_CANVAS)

  await inStore(`S.getState().setParam(${VIEW}, 'page', 1)`)
  // The next neuron's skeleton arrives after a fetch, and the canvas is gone while it loads.
  let paged = null
  for (let i = 0; i < 300 && !framed(paged); i++) {
    await sleep(100)
    paged = await cameraAt(CARD_CANVAS)
  }
  check(framed(paged), 'paging to the next neuron frames the camera on it')
}

/*
 * The other half of the contract: what nobody is looking at is released, not held for ever. Opening
 * the dashboard unmounts the canvas and the card with it, and this node is on no cell — so what it held
 * should sit parked for the grace period, then be gone. `rebuilt` says whether a fresh one was built
 * on the way back, which is a different question for a renderer and for a frame.
 */
async function checkRelease(cardSelector, rebuilt) {
  const PARKED = `document.querySelector('[data-persistent-roots]')?.children.length ?? 0`
  console.log('\nrelease')
  await inStore(`S.getState().setDashboardOpen(true)`)
  await sleep(1000)
  const parked = await evaluate(PARKED)
  check(parked === 1, `parked while nothing shows the node (${parked} held)`)
  await sleep(GRACE_MS + 500)
  const released = await evaluate(PARKED)
  check(released === 0, `released after the grace period (${released} held)`)
  await evaluate(`window.__probe.reset(); true`)
  await inStore(`S.getState().setDashboardOpen(false)`)
  await waitForSelector(cardSelector, 'the card after the dashboard')
  const [ok, line] = await rebuilt()
  check(ok, line)
}

async function endProbe() {
  close()
  await sleep(500)
  finish('See the note at the top of this file.')
  process.exit(0)
}

if (cycles > 0) {
  await checkRelease(CARD_CANVAS, async () => {
    await sleep(1500)
    const contexts = await evaluate(`window.__probe.contexts`)
    return [
      contexts === 1,
      `a fresh renderer built when the card came back (${contexts} context${contexts === 1 ? '' : 's'})`,
    ]
  })
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
for (const direction of ['card → overlay', 'overlay → card']) {
  const set = results.filter((r) => r.label.endsWith(direction))
  if (set.length === 0) continue
  console.log(
    `\nmedian ${direction}: busy ${median(set.map((r) => r.busyUntil)).toFixed(0)} ms, ` +
      `long tasks ${median(set.map((r) => r.taskMs)).toFixed(0)} ms, ` +
      `longest ${median(set.map((r) => r.longest)).toFixed(0)} ms`,
  )
}

await endProbe()
