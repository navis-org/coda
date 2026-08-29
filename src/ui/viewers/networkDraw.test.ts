// @vitest-environment jsdom
/**
 * Vector drawing for the network viewer.
 *
 * This is the only part of that viewer that can be checked without a GPU, and it is
 * load-bearing for two features: the SVG/PNG export, and the reciprocal-link separation
 * (whose geometry the WebGL path shares). So the geometry is pinned down here — where the
 * arrow points, which way each of a reciprocal pair bends — rather than left to the shader.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { serializeSvg } from '../export'
import { markPath } from './scatterDraw'
import type { NetworkSvgSpec, SvgEdge, SvgNode } from './networkDraw'
import {
  RECIPROCAL_CURVATURE,
  arrowHead,
  assignCurvatures,
  curveControlPoint,
  curvePoint,
  edgePath,
  networkToSvg,
  splitAlpha,
} from './networkDraw'

const NODE_SCHEMA = tableSchema(column('id', 'str'))
const EDGE_SCHEMA = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('weight', 'f64'),
)

function network(edges: Array<[string, string]>, directed = true): NetworkValue {
  const ids = [...new Set(edges.flat())]
  return {
    kind: 'network',
    directed,
    nodes: tableFromRows(
      NODE_SCHEMA,
      ids.map((id) => ({ id })),
    ),
    edges: tableFromRows(
      EDGE_SCHEMA,
      edges.map(([source, target]) => ({ source, target, weight: 1 })),
    ),
  }
}

describe('assignCurvatures', () => {
  it('leaves a one-way link straight', () => {
    expect(assignCurvatures(network([['a', 'b']]))).toEqual([0])
  })

  it('bows both halves of a reciprocal pair', () => {
    const curvatures = assignCurvatures(
      network([
        ['a', 'b'],
        ['b', 'a'],
        ['a', 'c'],
      ]),
    )
    expect(curvatures).toEqual([RECIPROCAL_CURVATURE, RECIPROCAL_CURVATURE, 0])
  })

  it('gives the pair the SAME curvature, which is what separates them', () => {
    // The control point is offset along the perpendicular of (target - source), and that
    // perpendicular flips with the direction of travel. Equal curvature therefore puts the
    // two arcs on opposite sides; opposite curvature would stack them again.
    const value = network([
      ['a', 'b'],
      ['b', 'a'],
    ])
    const [forward, back] = assignCurvatures(value)
    const a = { x: 0, y: 0 }
    const b = { x: 100, y: 0 }
    expect(forward).toBe(back)
    const there = curveControlPoint(a, b, forward!)
    const backAgain = curveControlPoint(b, a, back!)
    expect(Math.sign(there.y - 0)).toBe(-Math.sign(backAgain.y - 0))
  })

  it('ignores self-loops', () => {
    expect(assignCurvatures(network([['a', 'a']]))).toEqual([0])
  })

  it('leaves an undirected network alone — BuildNetwork already merged the pairs', () => {
    const value = network(
      [
        ['a', 'b'],
        ['b', 'a'],
      ],
      false,
    )
    expect(assignCurvatures(value)).toEqual([0, 0])
  })
})

describe('edge geometry', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 100, y: 0 }

  it('draws a straight link as a line and a bowed one as a quadratic', () => {
    expect(edgePath(a, b, 0)).toBe('M0,0 L100,0')
    expect(edgePath(a, b, 0.25)).toMatch(/^M0,0 Q50,-25 100,0$/)
  })

  it('offsets the control point perpendicular to the link', () => {
    const control = curveControlPoint(a, { x: 0, y: 100 }, 0.25)
    // A vertical link bows sideways, not along itself.
    expect(control.y).toBeCloseTo(50, 5)
    expect(control.x).toBeCloseTo(25, 5)
  })

  it('puts the midpoint of a bowed link off the straight line', () => {
    const straight = curvePoint(a, b, 0, 0.5)
    const bowed = curvePoint(a, b, 0.25, 0.5)
    expect(straight).toEqual({ x: 50, y: 0 })
    expect(bowed.x).toBeCloseTo(50, 5)
    expect(bowed.y).toBeCloseTo(-12.5, 5)
  })

  it('lands the arrow tip on the target rim, not its centre', () => {
    const [tip] = arrowHead(a, b, 0, 8, 1)
    expect(tip.x).toBeCloseTo(92, 5)
    expect(tip.y).toBeCloseTo(0, 5)
  })

  it('points the arrow along the curve tangent, not the chord', () => {
    const [tip, left, right] = arrowHead(a, b, 0.25, 0, 1)
    // The tangent at the end of the bow comes in from above, so the head is tilted: its
    // base straddles the tip in y as well as x.
    expect(tip).toEqual({ x: 100, y: 0 })
    expect(left.y).not.toBeCloseTo(right.y, 1)
  })

  it('scales the head with the link width so a thick link keeps a visible arrow', () => {
    const thin = arrowHead(a, b, 0, 0, 1)
    const thick = arrowHead(a, b, 0, 0, 6)
    const span = (head: ReturnType<typeof arrowHead>) =>
      Math.hypot(head[1].x - head[2].x, head[1].y - head[2].y)
    expect(span(thick)).toBeGreaterThan(span(thin))
  })
})

function spec(overrides: Partial<NetworkSvgSpec> = {}): NetworkSvgSpec {
  const nodes: SvgNode[] = [
    { id: 'a', x: 20, y: 40, radius: 6, color: '#3987e5', label: 'LC4' },
    { id: 'b', x: 180, y: 40, radius: 9, color: '#d95926', label: 'DNp02' },
  ]
  const edges: SvgEdge[] = [
    { source: 0, target: 1, width: 2, color: '#2c2c2a', curvature: 0, label: '137' },
  ]
  return {
    width: 200,
    height: 100,
    nodes,
    edges,
    arrows: true,
    background: '#1a1a19',
    nodeLabelColor: '#c3c2b7',
    edgeLabelColor: '#898781',
    font: 'system-ui, sans-serif',
    ...overrides,
  }
}

describe('networkToSvg', () => {
  it('draws one disc per node and one path per link', () => {
    const svg = networkToSvg(spec())
    expect(svg.querySelectorAll('circle')).toHaveLength(2)
    expect(svg.querySelectorAll('path')).toHaveLength(1)
  })

  it('draws arrowheads only when the network is directed', () => {
    expect(networkToSvg(spec()).querySelectorAll('polygon')).toHaveLength(1)
    expect(networkToSvg(spec({ arrows: false })).querySelectorAll('polygon')).toHaveLength(0)
  })

  it('carries node and link labels into the file', () => {
    const labels = [...networkToSvg(spec()).querySelectorAll('text')].map((t) => t.textContent)
    expect(labels).toContain('LC4')
    expect(labels).toContain('DNp02')
    expect(labels).toContain('137')
  })

  it('haloes labels in the background colour so they stay readable over a link', () => {
    const label = networkToSvg(spec()).querySelector('text')
    expect(label?.getAttribute('stroke')).toBe('#1a1a19')
    expect(label?.getAttribute('paint-order')).toBe('stroke')
  })

  it('paints the background, because a transparent PNG of a dark chart is unreadable', () => {
    const rect = networkToSvg(spec()).querySelector('rect')
    expect(rect?.getAttribute('fill')).toBe('#1a1a19')
  })

  it('grows by a legend strip, and never ships colour without a key', () => {
    const legend = {
      kind: 'categorical' as const,
      column: 'type',
      entries: [
        { label: 'LC4', color: '#3987e5' },
        { label: 'DNp02', color: '#d95926' },
      ],
      truncated: false,
    }
    const plain = networkToSvg(spec())
    const keyed = networkToSvg(spec({ legend }))
    expect(Number(plain.getAttribute('height'))).toBe(100)
    expect(Number(keyed.getAttribute('height'))).toBeGreaterThan(100)
    const labels = [...keyed.querySelectorAll('text')].map((t) => t.textContent)
    expect(labels).toContain('LC4')
  })

  it('renders a colour bar with its domain for a sequential encoding', () => {
    const svg = networkToSvg(
      spec({
        legend: {
          kind: 'sequential',
          column: 'weight',
          domain: [3, 240],
          stops: ['#111', '#222', '#333'],
        },
      }),
    )
    const labels = [...svg.querySelectorAll('text')].map((t) => t.textContent)
    expect(labels).toContain('weight')
    expect(labels).toContain('3')
    expect(labels).toContain('240')
  })

  it('names itself, so the export is not an anonymous image', () => {
    const svg = networkToSvg(spec({ title: 'Network — 2 nodes, 1 links' }))
    expect(svg.querySelector('title')?.textContent).toBe('Network — 2 nodes, 1 links')
  })

  it('clips to the plot area, so a panned-off node cannot bleed into the legend', () => {
    const svg = networkToSvg(
      spec({ nodes: [{ id: 'far', x: 900, y: 40, radius: 5, color: '#fff' }], edges: [] }),
    )
    expect(svg.querySelector('clipPath')).not.toBeNull()
    expect(svg.querySelector('g[clip-path]')).not.toBeNull()
  })

  it('skips a link whose endpoints are missing rather than drawing to nowhere', () => {
    const svg = networkToSvg(
      spec({ edges: [{ source: 0, target: 7, width: 1, color: '#000', curvature: 0 }] }),
    )
    expect(svg.querySelectorAll('path')).toHaveLength(0)
  })

  it('survives serialisation as a standalone file, with the font inlined', () => {
    const text = serializeSvg(networkToSvg(spec()))
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"')
    // The screen inherits its font from a CSS variable; the file cannot.
    expect(text).toContain('system-ui')
    expect(text).toContain('<circle')
  })
})

describe('networkToSvg carries the new channels', () => {
  /*
   * Everything the screen draws has to reach the file, or an export silently stops being a
   * picture of what was on screen. Borders and link opacity are both new; both are here.
   */

  it('outlines a node inward from its radius, matching the shader', () => {
    const svg = networkToSvg(
      spec({
        nodes: [{ id: 'a', x: 20, y: 40, radius: 6, color: '#3987e5', borderWidth: 2 }],
        edges: [],
        nodeBorderColor: '#1a1a19',
      }),
    )
    const disc = svg.querySelector('circle')!
    expect(disc.getAttribute('stroke')).toBe('#1a1a19')
    expect(disc.getAttribute('stroke-width')).toBe('2')
    // Centred half a width inside the radius, so the outline eats in rather than growing out.
    expect(disc.getAttribute('r')).toBe('5')
  })

  it('draws no outline when the width is zero, rather than a hairline', () => {
    const svg = networkToSvg(spec({ nodeBorderColor: '#1a1a19' }))
    expect(svg.querySelector('circle')?.getAttribute('stroke')).toBeNull()
  })

  it('writes link opacity as stroke-opacity rather than an eight-digit hex', () => {
    const svg = networkToSvg(
      spec({
        edges: [{ source: 0, target: 1, width: 2, color: '#89878180', curvature: 0 }],
      }),
    )
    const link = svg.querySelector('path')!
    expect(link.getAttribute('stroke')).toBe('#898781')
    // `element` rounds attributes to two places, which is ample for an opacity.
    expect(link.getAttribute('stroke-opacity')).toBe('0.5')
  })

  it('fades an arrowhead with the link it belongs to', () => {
    const svg = networkToSvg(
      spec({
        edges: [{ source: 0, target: 1, width: 2, color: '#89878180', curvature: 0 }],
      }),
    )
    const head = svg.querySelector('polygon')!
    expect(head.getAttribute('fill')).toBe('#898781')
    expect(head.getAttribute('fill-opacity')).toBe('0.5')
  })

  it('omits the opacity attributes entirely for an opaque link', () => {
    const link = networkToSvg(spec()).querySelector('path')!
    expect(link.getAttribute('stroke-opacity')).toBeNull()
  })
})

describe('networkToSvg draws the shape a node was rendered with', () => {
  it('draws a circle as a circle, not as a polygon of one', () => {
    // The one mark with its own SVG primitive. Going through `markPath` would approximate it,
    // and a circle is both the default and the commonest node on screen.
    const svg = networkToSvg(
      spec({ nodes: [{ id: 'a', x: 20, y: 40, radius: 6, color: '#3987e5' }], edges: [] }),
    )
    expect(svg.querySelectorAll('circle').length).toBe(1)
    expect(svg.querySelectorAll('path[fill="#3987e5"]').length).toBe(0)
  })

  it('draws every other mark through the scatter’s own path', () => {
    // One definition of what a diamond is, so an exported network and an exported scatter
    // cannot disagree about it.
    const svg = networkToSvg(
      spec({
        nodes: [
          { id: 'a', x: 20, y: 40, radius: 6, color: '#3987e5', shape: 'diamond' },
          { id: 'b', x: 60, y: 40, radius: 6, color: '#e5a339', shape: 'cross' },
        ],
        edges: [],
      }),
    )
    expect(svg.querySelectorAll('circle').length).toBe(0)
    const paths = [...svg.querySelectorAll('path')].filter((p) =>
      ['#3987e5', '#e5a339'].includes(p.getAttribute('fill') ?? ''),
    )
    expect(paths.length).toBe(2)
    expect(paths[0]?.getAttribute('d')).toBe(markPath('diamond', 20, 40, 6))
  })

  it('keeps the outline eating inward, as the shader does', () => {
    const svg = networkToSvg(
      spec({
        nodes: [{ id: 'a', x: 20, y: 40, radius: 6, color: '#3987e5', shape: 'square', borderWidth: 2 }],
        edges: [],
        nodeBorderColor: '#000',
      }),
    )
    const path = [...svg.querySelectorAll('path')].find((p) => p.getAttribute('stroke') === '#000')
    expect(path?.getAttribute('d')).toBe(markPath('square', 20, 40, 5))
  })
})

describe('splitAlpha', () => {
  it('separates an eight-digit hex into a colour and an opacity', () => {
    expect(splitAlpha('#3987e580')).toEqual({ color: '#3987e5', opacity: 0.502 })
  })

  it('leaves an opaque colour untouched, with no opacity to write', () => {
    expect(splitAlpha('#3987e5')).toEqual({ color: '#3987e5', opacity: undefined })
  })

  it('passes through anything it does not recognise', () => {
    expect(splitAlpha('rebeccapurple').color).toBe('rebeccapurple')
  })
})
