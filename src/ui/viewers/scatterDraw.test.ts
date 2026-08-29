// @vitest-environment jsdom

/**
 * Marker geometry and the vector export.
 *
 * The canvas pass and the SVG pass read one spec, so the export *is* the picture on screen —
 * which is what makes testing the SVG here worth something: it is the only handle on the
 * drawing available without a GPU, exactly as `networkDraw.test.ts` is for the network.
 */

import { describe, expect, it } from 'vitest'

import { CHART_INK } from '../colors'
import { markPath, scatterToSvg } from './scatterDraw'
import type { MarkerShape } from '../encoding'
import { MARKER_SHAPES, OTHER_SHAPE } from '../encoding'
import type { ScatterSpec } from './scatterPlot'
import { buildScatter } from './scatterPlot'

const PLOT = { x: 40, y: 10, width: 240, height: 160 }
const INK = CHART_INK.dark

function spec(options: Partial<Parameters<typeof buildScatter>[0]> = {}): ScatterSpec {
  const xs = Array.from({ length: 40 }, (_, i) => i)
  const ys = xs.map((x) => x * 2)
  return buildScatter({
    xValues: xs,
    yValues: ys,
    length: xs.length,
    xScale: 'linear',
    yScale: 'linear',
    plot: PLOT,
    trendColor: '#ffffff',
    style: {
      colorAt: (row) => (row % 2 === 0 ? '#3987e5' : '#d95926'),
      radiusAt: () => 3,
      shapeAt: () => 'circle',
    },
    ...options,
  })
}

function svg(overrides: Partial<Parameters<typeof scatterToSvg>[0]> = {}) {
  return scatterToSvg({
    spec: spec(),
    width: 320,
    height: 200,
    background: '#1a1a19',
    ink: INK,
    font: 'sans-serif',
    opacity: 0.8,
    xLabel: 'pre',
    yLabel: 'post',
    ...overrides,
  })
}

describe('marker paths', () => {
  const shapes: MarkerShape[] = [...MARKER_SHAPES, OTHER_SHAPE]

  it('closes every mark, so a single fill covers it', () => {
    for (const shape of shapes) {
      const d = markPath(shape, 10, 10, 4)
      expect(d.length, shape).toBeGreaterThan(0)
      expect(d.endsWith('Z'), shape).toBe(true)
    }
  })

  it('draws every shape distinctly', () => {
    // Two shapes with the same outline are one shape with two legend entries.
    const paths = shapes.map((shape) => markPath(shape, 10, 10, 4))
    expect(new Set(paths).size).toBe(shapes.length)
  })

  it('sizes a square by area, not by radius', () => {
    // A square drawn at the circle's radius is 27% larger, so shape would start encoding
    // magnitude by accident.
    const d = markPath('square', 0, 0, 10)
    const xs = [...d.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]))
    const half = Math.max(...xs)
    expect(half).toBeCloseTo((Math.sqrt(Math.PI) / 2) * 10, 1)
  })

  it('scales with the radius it is given', () => {
    const small = markPath('diamond', 0, 0, 2)
    const large = markPath('diamond', 0, 0, 8)
    expect(small).not.toBe(large)
  })
})

describe('the SVG export', () => {
  it('batches marks by colour and shape rather than emitting one element per point', () => {
    // Forty points, two colours: an SVG with a hundred and sixty thousand elements opens in
    // nothing, where the same subpaths in a handful of elements opens anywhere.
    const marks = svg().querySelector('g[clip-path]')!
    const paths = marks.querySelectorAll('path')
    expect(paths).toHaveLength(2)
    expect([...paths].map((p) => p.getAttribute('fill')).sort()).toEqual(['#3987e5', '#d95926'])
  })

  it('clips the marks to the plot rect, so a zoom does not spill over the axes', () => {
    const element = svg()
    expect(element.querySelector('clipPath rect')?.getAttribute('width')).toBe(
      String(PLOT.width),
    )
    expect(element.querySelector('g[clip-path]')).toBeTruthy()
  })

  it('carries the opacity as a group attribute rather than baking it into the colours', () => {
    // An eight-digit hex would be a colour no other consumer of the palette understands.
    expect(svg().querySelector('g[clip-path]')?.getAttribute('fill-opacity')).toBe('0.8')
  })

  it('labels both axes and draws their ticks', () => {
    const text = [...svg().querySelectorAll('text')].map((t) => t.textContent)
    expect(text).toContain('pre')
    expect(text).toContain('post')
    // Tick labels come off the scale, so there are more than the two axis titles.
    expect(text.length).toBeGreaterThan(4)
  })

  it("draws one trend line per colour group, in that group's colour", () => {
    // The fixture paints alternate rows two colours, so the default per-group fit is two
    // lines — and each takes the colour of the points it describes, which is what makes it
    // readable against a legend rather than needing its own key.
    const grouped = svg({ spec: spec({ trend: 'linear' }) })
    const lines = [...grouped.querySelectorAll('g[clip-path] line')]
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.getAttribute('stroke')).sort()).toEqual(['#3987e5', '#d95926'])

    const pooled = svg({ spec: spec({ trend: 'linear', trendPerGroup: false }) })
    expect(pooled.querySelectorAll('g[clip-path] line')).toHaveLength(1)
  })

  it('grows a legend strip only when there are keys to put in it', () => {
    const bare = svg()
    expect(bare.getAttribute('height')).toBe('200')

    const keyed = svg({ legend: [{ label: 'LC4', color: '#3987e5' }] })
    expect(Number(keyed.getAttribute('height'))).toBeGreaterThan(200)
    expect([...keyed.querySelectorAll('text')].map((t) => t.textContent)).toContain('LC4')
  })

  it('draws a shape key as the mark itself, not as a swatch', () => {
    // A legend that approximated its own marks would be the one place on screen where what
    // is drawn and what it says are allowed to differ — and shape is the fallback channel
    // for exactly the readers a colour key cannot serve.
    const keyed = svg({ legend: [{ label: 'KCg', shape: 'triangle' }] })
    const strip = keyed.lastElementChild!
    const mark = strip.querySelector('path')!
    // Three vertices: the triangle from `markPath`, rather than the rounded rect a colour
    // entry gets.
    expect((mark.getAttribute('d')?.match(/L/g) ?? []).length).toBe(2)
    expect(strip.querySelector('rect')).toBeNull()
  })

  it('renders a colour bar for a sequential encoding instead of swatches', () => {
    const keyed = svg({
      ramp: { label: 'weight', stops: ['#000', '#fff'], low: '1', high: '900' },
    })
    expect(keyed.querySelector('linearGradient')).toBeTruthy()
    const text = [...keyed.querySelectorAll('text')].map((t) => t.textContent)
    expect(text).toContain('weight')
    expect(text).toContain('900')
  })

  it('names the plot in a title, so a downloaded file says what it is', () => {
    expect(svg({ title: 'post against pre' }).querySelector('title')?.textContent).toBe(
      'post against pre',
    )
  })
})
