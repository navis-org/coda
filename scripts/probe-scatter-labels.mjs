#!/usr/bin/env node
/**
 * Point labels on a real embedding, in a real browser: what jsdom cannot say — whether the text
 * reads, whether the boxes measured are the boxes drawn, and what a placement costs.
 *
 * fish2's NBLAST embedding coloured and labelled by BigClust's own `label` column (its cell type, `untyped` where it has none), zoomed about a dense typed spot until a
 * few hundred points are in view (the default `Label up to` is 400), labels placed exactly as
 * `ScatterViewer` places them (`scatterLabels.ts`) and drawn by `drawScatter`. Reports, per zoom,
 * how many points are in view, how many labels were placed, and the placement time; screenshots
 * each into the temp directory for looking at — the one property no assertion here covers.
 *
 *   pnpm dev --port 5177 &
 *   pnpm probe:scatter-labels --project ~/Downloads/bigclust-projects/fish2-connectivity2
 */

import { readFirstEmbedding } from './lib/bigclustProject.mjs'
import { APP_MODULE, launchChrome, probeArgs, probeReport } from './lib/browserProbe.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5177/'
const project = args.value('--project')
if (!project) throw new Error('--project <bigclust project dir> is required')

const data = await readFirstEmbedding(project, 'label')
console.log(`data: ${data.source}, ${data.x.length.toLocaleString()} rows`)

const { send, evaluate, waitFor, screenshot, close } = await launchChrome({
  port: 9438,
  profile: '/tmp/coda-probe-scatter-labels',
  width: 1300,
  height: 900,
})
await send('Page.navigate', { url })
await waitFor(`document.readyState === 'complete'`, 'the app to load')
await evaluate(`window.__labelData = ${JSON.stringify(data)}; true`)

const run = (zoom) =>
  evaluate(`(async () => {
  const load = ${APP_MODULE}
  const plotMod = await load('/src/ui/viewers/scatterPlot.ts')
  const drawMod = await load('/src/ui/viewers/scatterDraw.ts')
  const labelsMod = await load('/src/ui/viewers/scatterLabels.ts')
  const enc = await load('/src/style/encoding.ts')
  const c2d = await load('/src/ui/viewers/canvas2d.ts')
  const colors = await load('/src/style/colors.ts')
  const d = window.__labelData
  const n = d.x.length
  const table = {
    kind: 'table',
    schema: { columns: [
      { name: 'x', dtype: 'f64' }, { name: 'y', dtype: 'f64' }, { name: 'type', dtype: 'str' },
    ] },
    data: d, length: n,
  }
  const mode = 'dark'
  const color = enc.resolveColor(table, { mode: 'categorical', column: 'type', constant: '' }, mode)
  const style = { colorAt: color.at, radiusAt: () => 4, shapeAt: () => 'circle' }
  document.querySelectorAll('.__probe').forEach((e) => e.remove())
  const canvas = document.createElement('canvas')
  canvas.className = '__probe'
  document.body.appendChild(canvas)
  canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:99999'
  const width = 1200, height = 800
  const ctx = c2d.prepareCanvas(canvas, width, height)
  const plot = { x: 50, y: 10, width: width - 64, height: height - 50 }
  const ink = colors.CHART_INK[mode]
  const marks = plotMod.buildMarks({
    xValues: d.x, yValues: d.y, length: n, xScale: 'linear', yScale: 'linear', style,
  })
  const base = plotMod.buildScatter({ marks, plot, aspect: 'equal' })
  // A dense typed spot: the median of the typed points, so the labels on screen are names of
  // many lengths rather than one word over and over.
  const typed = []
  for (let i = 0; i < n; i++) if (d.type[i] && d.type[i] !== 'untyped') typed.push(i)
  // A real point rather than the medians of the two axes apart, which can fall in empty space.
  const at = typed.sort((p, q) => d.x[p] - d.x[q])[Math.floor(typed.length / 2)]
  const cx = d.x[at], cy = d.y[at]
  const hx = (base.view.x.max - base.view.x.min) / 2 / ${zoom}
  const hy = (base.view.y.max - base.view.y.min) / 2 / ${zoom}
  const spec = plotMod.buildScatter({
    marks, plot, aspect: 'equal',
    view: { x: { min: cx - hx, max: cx + hx }, y: { min: cy - hy, max: cy + hy } },
  })
  // The viewer's own request builder, so this places labels exactly as the card does.
  const { requests, obstacles } = labelsMod.labelRequests(
    spec,
    (mark) => String(d.type[marks.rows[mark]] ?? ''),
    drawMod.measureLabel,
    () => 1,
  )
  const t0 = performance.now()
  const labels = labelsMod.placePointLabels(requests, {
    bounds: spec.plot, obstacles, leaders: true, unplaced: 'hide',
  })
  const placeMs = performance.now() - t0
  // Measured against the canvas the painter draws on, in the painter's font.
  ctx.font = c2d.canvasFont(drawMod.LABEL_FONT_PX)
  const worst = Math.max(0, ...labels.map((l) => ctx.measureText(l.text).width - l.width))
  drawMod.drawScatter(ctx, {
    spec, ink, background: colors.chartSurface(mode), opacity: 0.8, width, height,
    xLabel: 'x', yLabel: 'y', labels,
  })
  return {
    visible: spec.visible.length,
    requested: requests.length,
    placed: labels.length,
    placeMs: Number(placeMs.toFixed(2)),
    widestOverrun: Number(worst.toFixed(2)),
  }
})()`)

const report = probeReport()
for (const zoom of [10, 20, 40]) {
  const r = await run(zoom)
  const file = await screenshot(`scatter-labels-zoom${zoom}`)
  console.log(
    `zoom ${zoom}x: ${r.visible} points in view, ${r.placed} of ${r.requested} labels placed ` +
      `in ${r.placeMs} ms; measured box short by at most ${r.widestOverrun}px → ${file}`,
  )
  report.check(r.widestOverrun <= 0.5, `zoom ${zoom}: every placed label's box holds its drawn text`)
  if (r.visible <= 400) report.check(r.placeMs < 20, `zoom ${zoom}: placement under 20 ms`)
}
await close()
report.finish()
