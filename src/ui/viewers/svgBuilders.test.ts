// @vitest-environment jsdom

/**
 * What every synthesised export must be, whichever builder made it.
 *
 * This exists because the duplicate-`xmlns` bug was invisible to the suite it broke.
 * `networkDraw.test.ts` asserts `toContain('xmlns="…"')`, which passes just as happily when the
 * attribute is written **twice** — and twice is a fatal XML error, so the file it describes
 * opens in nothing. Re-adding `xmlns: SVG_NS` to any builder left all 43 of those tests green.
 *
 * So the check is on the finished document rather than on the string: push each builder's output
 * through the real `serializeSvg` and parse it as XML. A builder that reintroduces the attribute,
 * or drops its font, fails here and is named.
 */

import { describe, expect, it } from 'vitest'

import { CHART_INK, chartSurface } from '../colors'
import { serializeSvg } from '../export'
import { makeMatrix } from '../../core/values'
import { buildHeatmapSpec, rampColors } from './heatmapPlot'
import { heatmapToSvg } from './heatmapDraw'
import { networkToSvg } from './networkDraw'
import { scatterToSvg } from './scatterDraw'
import { buildScatter } from './scatterPlot'

const INK = CHART_INK.dark
const SURFACE = chartSurface('dark')
const FONT = 'Inter, system-ui'

function heatmap(): SVGSVGElement {
  const matrix = makeMatrix(
    ['LC4', 'LC6'],
    ['DNp02', 'DNp11'],
    Float64Array.from([0.7, 0.2, 0.1, 0.4]),
  )
  const spec = buildHeatmapSpec({
    matrix,
    scale: 'sequential',
    width: 400,
    height: 300,
    showLabels: true,
  })
  return heatmapToSvg({
    spec,
    ramp: rampColors('sequential', 'dark'),
    ink: INK,
    background: SURFACE,
    width: 400,
    height: 300,
    font: FONT,
    values: matrix.values,
    showValues: true,
    title: 'Heatmap',
    barLow: '0',
    barHigh: '1',
  })
}

function scatter(): SVGSVGElement {
  const xs = Array.from({ length: 12 }, (_, i) => i)
  const spec = buildScatter({
    xValues: xs,
    yValues: xs.map((x) => x * 2),
    length: xs.length,
    xScale: 'linear',
    yScale: 'linear',
    plot: { x: 40, y: 10, width: 320, height: 240 },
    trendColor: '#ffffff',
    style: { colorAt: () => '#3987e5', radiusAt: () => 3, shapeAt: () => 'circle' },
  })
  return scatterToSvg({
    spec,
    width: 400,
    height: 300,
    background: SURFACE,
    ink: INK,
    font: FONT,
    opacity: 1,
    xLabel: 'x',
    yLabel: 'y',
    title: 'Scatter',
  })
}

function network(): SVGSVGElement {
  return networkToSvg({
    nodes: [
      { id: 'a', x: 10, y: 10, radius: 5, color: '#3987e5', label: 'a' },
      { id: 'b', x: 90, y: 60, radius: 5, color: '#e34948', label: 'b' },
    ],
    edges: [{ source: 0, target: 1, color: '#898781', width: 1, curvature: 0 }],
    width: 400,
    height: 300,
    background: SURFACE,
    nodeLabelColor: INK.secondary,
    edgeLabelColor: INK.muted,
    font: FONT,
    arrows: true,
    title: 'Network',
  })
}

const BUILDERS: Array<[string, () => SVGSVGElement]> = [
  ['heatmapToSvg', heatmap],
  ['scatterToSvg', scatter],
  ['networkToSvg', network],
]

describe.each(BUILDERS)('%s', (_name, build) => {
  it('serialises to a well-formed XML document', () => {
    const text = serializeSvg(build())
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg')
  })

  it('declares the SVG namespace exactly once', () => {
    // Twice is what `setAttribute('xmlns', …)` produces, and it is unrecoverable rather than
    // untidy — `svgRoot` has no parameter for it, and this is the tripwire under that.
    const text = serializeSvg(build())
    expect(text.split('xmlns="http://www.w3.org/2000/svg"')).toHaveLength(2)
  })

  it('carries exactly one font declaration, and it is the real one', () => {
    // A synthesised root is detached, so `getComputedStyle` in `serializeSvg` resolves nothing.
    // Two `<style>` blocks meant the surviving font was decided by document order.
    const text = serializeSvg(build())
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
    const styles = [...doc.querySelectorAll('style')]
    expect(styles).toHaveLength(1)
    expect(styles[0]!.textContent).toContain(FONT)
  })
})
