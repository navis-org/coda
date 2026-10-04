#!/usr/bin/env node
/**
 * What one pan frame of the Scatter viewer costs at embedding scale, in a real browser.
 * `pnpm probe:scatter-scale` (needs `pnpm dev --port 5177`, or pass `--url`).
 *
 * ## Why this exists
 *
 * A whole-dataset embedding — a BigClust project, fish2's 129,325 neurons — is what the Scatter
 * node is for, and whether it pans is a fact about a browser's raster that jsdom cannot reach.
 * This is the measurement `CIRCLES_MAX` rests on, and the check that the pixel pass above it
 * still holds a frame.
 *
 * It times the viewer's own functions, not a stand-in, and times **every stage a pan re-runs**:
 * a change of `view` builds a frame of the marks (`buildScatter` projects every mark's stored
 * coordinates and culls to the plot) and repaints (`drawScatter`: paths up to `CIRCLES_MAX`
 * visible marks, the GPU above it, which moves a view uniform over marks it uploaded once). The
 * marks themselves — cells read, encodings resolved, buckets, trend — are `buildMarks`, built
 * once per table and encoding and timed once, as `marks` on the scenario's line. The hit index
 * is not timed: it is built on the first hover, which a pan never makes.
 *
 * Canvas commands are deferred, so `draw` is what the main thread spends issuing them and `flush`
 * is a 1-pixel `getImageData` forcing the raster — an upper bound on the raster, the readback
 * adding a GPU sync of its own. `frame` is the honest number: the interval between animation
 * frames while every frame runs the whole pipeline, which is what a pan feels like.
 *
 * ## What was measured before the pixel pass existed
 *
 * M3 Max, devicePixelRatio 2, fish2's NBLAST embedding, a path of antialiased circles for every
 * mark (median rAF interval, full-size viewer): 10,000 marks 16.7 ms, 50,000 117 ms (the old
 * `Max points` default, so not smooth either), 129,325 420 ms. Issuing took 21 ms of that and the
 * spec 3.4 ms; the rest was Skia's raster, ~3.4 µs a mark, worse on a card where marks overlap
 * more. Zoomed tenfold with 4,261 marks in view it was still 50 ms, nothing being culled. Three
 * alternatives over all 129,325 marks: a sprite `drawImage` per mark 150 ms; pixels stamped into
 * an `ImageData` 16.7 ms (8.7 ms of main thread); WebGL `gl.POINTS` 16.7 ms (6.7 ms). The
 * `ImageData` number was wrong — its stamps were ~2 device pixels where a mark is 6 — and built
 * properly the CPU raster took 67 ms, so the pass is one shared WebGL context (`scatterGl.ts`)
 * with the CPU raster as its fallback and the export path. `docs/viewers.md` has the account.
 *
 * ## Data
 *
 * `--project <dir>` reads a BigClust project's first embedding (`embeddings_0.parquet`, or the
 * file `info` names) and `meta.parquet`'s `type` for a categorical colour. Without it the probe
 * makes 130k points in Gaussian blobs, with 400 types — the shape of an embedding without needing
 * anybody's data.
 *
 * Runs on the GPU (`--use-angle=metal --enable-gpu`) because headless Chrome otherwise rasterises
 * in software; `--software` measures that instead.
 */

import { readFirstEmbedding } from './lib/bigclustProject.mjs'
import { APP_MODULE, launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5177/'
const project = args.value('--project')
const software = args.all.includes('--software')
const FRAMES = 40

// ── data ────────────────────────────────────────────────────────────────────────────────────────

/** Seeded, so two runs draw the same picture. */
function synthetic(n = 130_000, types = 400) {
  let s = 1
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand())
  const centres = Array.from({ length: types }, () => [rand() * 20, rand() * 20, 0.1 + rand() * 0.5])
  const x = new Array(n)
  const y = new Array(n)
  const type = new Array(n)
  for (let i = 0; i < n; i++) {
    const t = Math.floor(rand() ** 2 * types)
    const [cx, cy, sd] = centres[t]
    x[i] = cx + gauss() * sd
    y[i] = cy + gauss() * sd
    type[i] = `type_${t}`
  }
  return { source: `synthetic (${n} points, ${types} types)`, x, y, type }
}

const data = project ? await readFirstEmbedding(project, 'type') : synthetic()
console.log(`data: ${data.source}, ${data.x.length.toLocaleString()} rows`)

// ── browser ─────────────────────────────────────────────────────────────────────────────────────

const { send, evaluate, waitFor, screenshot, close } = await launchChrome({
  port: 9437,
  profile: '/tmp/coda-probe-scatter-scale',
  width: 1600,
  height: 1000,
  args: software ? [] : ['--use-angle=metal', '--enable-gpu'],
})

await send('Page.navigate', { url })
await waitFor(`document.readyState === 'complete'`, 'the app to load')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 2,
  mobile: false,
})

const renderer = await evaluate(`(() => {
  const gl = document.createElement('canvas').getContext('webgl')
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no WebGL'
})()`)
console.log(`renderer: ${renderer}, devicePixelRatio 2`)

// Handed over in one evaluation: a few MB of JSON, well inside what DevTools carries.
await evaluate(`window.__scatterData = ${JSON.stringify(data)}; true`)

/**
 * One scenario, run in the page: `n` rows, a canvas of `width`×`height` CSS pixels, a colour
 * mode, and a zoom. Returns medians and p95s per stage over `FRAMES` pan steps.
 */
const run = (scenario) =>
  evaluate(`(async () => {
  const load = ${APP_MODULE}
  const plotMod = await load('/src/ui/viewers/scatterPlot.ts')
  const drawMod = await load('/src/ui/viewers/scatterDraw.ts')
  const enc = await load('/src/ui/encoding.ts')
  const c2d = await load('/src/ui/viewers/canvas2d.ts')
  const colors = await load('/src/ui/colors.ts')
  const s = ${JSON.stringify(scenario)}
  const d = window.__scatterData
  const n = Math.min(s.n, d.x.length)
  const table = {
    kind: 'table',
    schema: { columns: [
      { name: 'x', dtype: 'f64' }, { name: 'y', dtype: 'f64' }, { name: 'type', dtype: 'str' },
    ] },
    data: { x: d.x.slice(0, n), y: d.y.slice(0, n), type: d.type.slice(0, n) },
    length: n,
  }
  const mode = 'dark'
  const color = enc.resolveColor(table, {
    mode: s.color, column: s.color === 'constant' ? undefined : 'type', constant: '',
  }, mode)
  const size = enc.resolveSize(table, { column: undefined, min: 3, max: 3 })
  const shape = enc.resolveShape(table, { mode: 'constant', column: undefined, constant: 'circle' })
  const style = { colorAt: color.at, radiusAt: size.at, shapeAt: shape.at }

  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:99999'
  const ctx = c2d.prepareCanvas(canvas, s.width, s.height)
  const plot = { x: 44, y: 12, width: s.width - 56, height: s.height - 52 }
  const ink = colors.CHART_INK[mode]
  const surface = colors.chartSurface(mode)
  const m0 = performance.now()
  const marks = plotMod.buildMarks({
    xValues: table.data.x, yValues: table.data.y, length: n, xScale: 'linear', yScale: 'linear',
    style, trendColor: ink.primary,
  })
  const marksMs = performance.now() - m0
  const common = { marks, plot, aspect: 'equal' }

  const base = plotMod.buildScatter(common)
  // Zoom about a point (the centre unless given), then pan a twentieth of the span per frame.
  const cx = s.at ? s.at[0] : (base.view.x.min + base.view.x.max) / 2
  const cy = s.at ? s.at[1] : (base.view.y.min + base.view.y.max) / 2
  const hx = (base.view.x.max - base.view.x.min) / 2 / s.zoom
  const hy = (base.view.y.max - base.view.y.min) / 2 / s.zoom
  const viewAt = (f) => {
    const dx = (hx / 10) * Math.sin(f / 6)
    return { x: { min: cx - hx + dx, max: cx + hx + dx }, y: { min: cy - hy, max: cy + hy } }
  }

  const frame = (f, flush) => {
    const t0 = performance.now()
    const spec = plotMod.buildScatter({ ...common, view: viewAt(f) })
    const t2 = performance.now()
    drawMod.drawScatter(ctx, {
      spec, ink, background: surface, opacity: 0.8, width: s.width, height: s.height,
      xLabel: 'x', yLabel: 'y', selected: new Set(), compact: false,
    })
    const t3 = performance.now()
    if (flush) ctx.getImageData(0, 0, 1, 1)
    const t4 = performance.now()
    return { build: t2 - t0, draw: t3 - t2, flush: t4 - t3, visible: spec.visible.length }
  }

  // Warm-up, so the JIT is not in the numbers.
  for (let f = 0; f < 5; f++) frame(f, true)

  const stages = []
  for (let f = 0; f < ${FRAMES}; f++) stages.push(frame(f, true))

  // The whole pipeline once per animation frame, no forced readback: what a pan feels like.
  const stamps = []
  await new Promise((resolve) => {
    let f = 0
    const tick = (now) => {
      stamps.push(now)
      if (f >= ${FRAMES}) return resolve()
      frame(f++, false)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  frame(0, true)
  if (!s.keep) canvas.remove()

  const stat = (xs) => {
    const sorted = [...xs].sort((a, b) => a - b)
    return { med: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)] }
  }
  return {
    build: stat(stages.map((x) => x.build)),
    draw: stat(stages.map((x) => x.draw)),
    flush: stat(stages.map((x) => x.flush)),
    frame: stat(stamps.slice(2).map((t, i) => t - stamps[i + 1])),
    visible: stages[0].visible,
    pixels: stages[0].visible > plotMod.CIRCLES_MAX,
    marksMs,
    buckets: new Set(Array.from({ length: n }, (_, i) => color.at(i))).size,
  }
})()`)

const report = probeReport()
const n = data.x.length
const sizes = [10_000, 50_000, n].filter((v, i, a) => v <= n && a.indexOf(v) === i)
const scenarios = []
for (const [width, height, label] of [
  [1200, 800, 'full'],
  [420, 300, 'card'],
]) {
  for (const count of sizes) {
    for (const color of ['constant', 'categorical']) {
      scenarios.push({ label, width, height, n: count, color, zoom: 1 })
    }
  }
  // Zoomed far enough in that the circles take over again.
  scenarios.push({ label, width, height, n, color: 'categorical', zoom: 10 })
}

const f = (s) => `${s.med.toFixed(1).padStart(6)} / ${s.p95.toFixed(1).padStart(6)}`
console.log(
  '\nmedian / p95, ms per pan frame\n' +
    'surface  rows     visible  pass     colour        zoom |   build      |   draw issue |   flush      |   FRAME (rAF interval)',
)
for (const scenario of scenarios) {
  const r = await run(scenario)
  console.log(
    `${scenario.label.padEnd(8)} ${String(scenario.n).padEnd(8)} ${String(r.visible).padEnd(8)} ${(r.pixels ? 'pixels' : 'paths').padEnd(8)} ` +
      `${(scenario.color + ` (${r.buckets})`).padEnd(13)}${String(scenario.zoom).padStart(4)}x | ` +
      `${f(r.build)} | ${f(r.draw)} | ${f(r.flush)} | ${f(r.frame)}   (marks once: ${r.marksMs.toFixed(0)} ms)`,
  )
  // One 60 Hz frame plus a little: anything slower than this is not keeping up with a pan.
  if (scenario.n === n) {
    report.check(
      r.frame.med <= 20,
      `${scenario.label}, all ${n.toLocaleString()} rows at ${scenario.zoom}x: a pan frame in ${r.frame.med.toFixed(1)} ms (${r.pixels ? 'pixels' : 'paths'})`,
    )
  }
}

// The two passes have to agree on a mark, or the cloud changes as a zoom crosses CIRCLES_MAX. One
// isolated mark, drawn once beside a pile big enough to send the frame to the pixel pass and once
// beside one small enough to keep it on paths; the pile sits far away, so only the mark is read.
const parity = await evaluate(`(async () => {
  const load = ${APP_MODULE}
  const plotMod = await load('/src/ui/viewers/scatterPlot.ts')
  const drawMod = await load('/src/ui/viewers/scatterDraw.ts')
  const c2d = await load('/src/ui/viewers/canvas2d.ts')
  const colors = await load('/src/ui/colors.ts')
  const W = 600, H = 400
  const plot = { x: 44, y: 12, width: W - 56, height: H - 52 }
  const ink = colors.CHART_INK.dark, surface = colors.chartSurface('dark')
  // \`offset\` shifts every coordinate and the view alike: the picture must not change, which
  // it would if the GPU's float32 positions were absolute rather than relative to the centre.
  const read = (pile, offset = 0) => {
    const view = { x: { min: offset, max: offset + 100 }, y: { min: offset, max: offset + 100 } }
    const xs = [offset + 50.3], ys = [offset + 50.7]
    for (let i = 0; i < pile; i++) { xs.push(offset + 2 + (i % 7) * 0.01); ys.push(offset + 2) }
    const marks = plotMod.buildMarks({
      xValues: xs, yValues: ys, length: xs.length, xScale: 'linear', yScale: 'linear',
      style: { colorAt: () => '#3987e5', radiusAt: () => 4, shapeAt: () => 'circle' }, trendColor: '#fff',
    })
    const spec = plotMod.buildScatter({ marks, plot, view })
    const canvas = document.createElement('canvas')
    const ctx = c2d.prepareCanvas(canvas, W, H)
    drawMod.drawScatter(ctx, { spec, ink, background: surface, opacity: 0.8, width: W, height: H,
      xLabel: 'x', yLabel: 'y', selected: new Set([0]), compact: false })
    const R = devicePixelRatio
    const cx = Math.round(spec.px[0] * R), cy = Math.round(spec.py[0] * R), half = Math.ceil(12 * R)
    const box = ctx.getImageData(cx - half, cy - half, 2 * half, 2 * half).data
    const bg = [0x1a, 0x1a, 0x19]
    let ink_ = 0
    for (let k = 0; k < box.length; k += 4)
      ink_ += Math.abs(box[k] - bg[0]) + Math.abs(box[k + 1] - bg[1]) + Math.abs(box[k + 2] - bg[2])
    const centre = ctx.getImageData(cx, cy, 1, 1).data
    return { pixels: spec.visible.length > plotMod.CIRCLES_MAX, ink: ink_, centre: [...centre].slice(0, 3) }
  }
  const gl = !!document.createElement('canvas').getContext('webgl2')
  return {
    gl,
    paths: read(9000),
    pixels: read(plotMod.CIRCLES_MAX + 500),
    far: read(plotMod.CIRCLES_MAX + 500, 1e7),
  }
})()`)
console.log(`\nparity, one isolated mark with its selection ring (WebGL2 ${parity.gl ? 'available' : 'absent'}):`)
console.log(`  paths  centre ${parity.paths.centre} ink ${parity.paths.ink}`)
console.log(`  pixels centre ${parity.pixels.centre} ink ${parity.pixels.ink}`)
report.check(!parity.paths.pixels && parity.pixels.pixels, 'the two scenes land either side of CIRCLES_MAX')
report.check(
  parity.paths.centre.every((c, k) => Math.abs(c - parity.pixels.centre[k]) <= 6),
  `an isolated mark's centre is the same colour in both passes (${parity.paths.centre} vs ${parity.pixels.centre})`,
)
report.check(
  parity.far.centre.every((c, k) => Math.abs(c - parity.pixels.centre[k]) <= 6) &&
    Math.abs(parity.far.ink / Math.max(1, parity.pixels.ink) - 1) < 0.02,
  `and the pixel pass draws it identically with every coordinate offset by 10,000,000 (${parity.far.centre}, ink ${parity.far.ink})`,
)
const footprint = parity.pixels.ink / Math.max(1, parity.paths.ink)
report.check(
  footprint > 0.9 && footprint < 1.1,
  `and the same footprint, mark plus ring, within 10% (${(footprint * 100).toFixed(1)}%)`,
)

// The export past CIRCLES_MAX: the plot area as one embedded PNG, everything else vector, and a
// file small enough to open. jsdom can only stub `toDataURL`, so this is the one real encode.
const exported = await evaluate(`(async () => {
  const load = ${APP_MODULE}
  const plotMod = await load('/src/ui/viewers/scatterPlot.ts')
  const drawMod = await load('/src/ui/viewers/scatterDraw.ts')
  const colors = await load('/src/ui/colors.ts')
  const d = window.__scatterData
  const plot = { x: 50, y: 10, width: 1136, height: 750 }
  const marks = plotMod.buildMarks({
    xValues: d.x, yValues: d.y, length: d.x.length, xScale: 'linear', yScale: 'linear',
    style: { colorAt: () => '#3987e5', radiusAt: () => 3, shapeAt: () => 'circle' }, trendColor: '#fff',
  })
  const spec = plotMod.buildScatter({ marks, plot, aspect: 'equal' })
  const one = (vectorMarks) => {
    const t0 = performance.now()
    const svg = drawMod.scatterToSvg({ spec, width: 1200, height: 800, background: '#1a1a19',
      ink: colors.CHART_INK.dark, font: 'sans-serif', opacity: 0.8, xLabel: 'x', yLabel: 'y', vectorMarks })
    const text = new XMLSerializer().serializeToString(svg)
    return { ms: performance.now() - t0, bytes: text.length, image: !!svg.querySelector('image[href^="data:image/png"]') }
  }
  return { raster: one(false), vector: one(true) }
})()`)
console.log(
  `\nexport, all ${n.toLocaleString()} rows: embedded image ${(exported.raster.bytes / 1e6).toFixed(1)} MB in ${exported.raster.ms.toFixed(0)} ms; ` +
    `every mark vector ${(exported.vector.bytes / 1e6).toFixed(1)} MB in ${exported.vector.ms.toFixed(0)} ms`,
)
report.check(exported.raster.image, 'the export embeds the marks as a PNG past CIRCLES_MAX')
report.check(!exported.vector.image, 'and writes every mark as a shape when Vector marks is ticked')

// What the two passes look like either side of the threshold, for a person to compare: the whole
// cloud (pixels) and a zoom into its middle with fewer than CIRCLES_MAX marks in view (paths).
for (const [zoom, name] of [
  [1, 'scatter-scale-pixels'],
  [12, 'scatter-scale-paths'],
]) {
  await run({ label: 'shot', width: 1200, height: 800, n, color: 'categorical', zoom, keep: true })
  console.log(`screenshot: ${await screenshot(name)}`)
  await evaluate(`document.querySelectorAll('canvas').forEach((c) => c.remove()); true`)
}

close()
report.finish()
