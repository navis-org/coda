// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { rectangularLayout } from '../../nodes/lib/arborLayout'
import {
  buildArbor,
  keyTree,
  landmarkDistances,
  orientPlacement,
  projectSynapses,
  pruneTwigs,
} from '../../nodes/lib/arborOps'
import { ySkeleton } from '../../nodes/lib/__fixtures__/ySkeleton'
import { fitTransform, pieceGeometry, synapseMarks } from './arborPlot'
import type { SceneInput } from './arborScene'
import { blendPieces, buildScene, nearestTick, sceneToSvg } from './arborScene'

const INK = { line: '#888888', text: '#ffffff', accent: '#3b82f6' }

/** The shared Y drawn as a dendrogram in a 400 × 200 box, with an input on 2 → 3 and an output on 2 → 5. */
function scene(over: Partial<SceneInput> = {}) {
  const skeleton = ySkeleton()
  const arbor = buildArbor(skeleton, 0)
  const tree = keyTree(arbor)
  const d = landmarkDistances(tree, arbor.geodesic)
  const shape = rectangularLayout(tree, d)
  const transform = fitTransform(shape, 400, 200)
  const pieces = pieceGeometry(shape, transform)
  const sites = [
    { x: 2400, y: 100, z: 0, polarity: 'post' },
    { x: 2050, y: 1500, z: 0, polarity: 'pre' },
  ]
  const placement = orientPlacement(arbor, projectSynapses(skeleton, sites))
  const marks = synapseMarks(
    tree,
    d,
    arbor,
    arbor.geodesic,
    placement,
    (s) => sites[s]!.polarity,
  )
  const built = buildScene({
    width: 400,
    height: 200,
    background: '#000000',
    title: 'Y',
    ink: INK,
    shape,
    transform,
    pieces,
    settled: true,
    tree,
    lineWidth: 1.2,
    marks,
    ticks: [{ color: '#ff0000', alpha: 1, rows: Int32Array.from([0, 1]) }],
    synapseSize: 5,
    scaleBar: { px: 50, label: '1 µm' },
    ...over,
  })
  return { built, pieces, tree, shape, transform, marks }
}

describe('buildScene', () => {
  it('puts each tick on its branch, inputs and outputs on opposite sides', () => {
    const { built, pieces, tree } = scene()
    const leaf3 = tree.nodes.indexOf(3)
    // The input is 40% along 2 → 3, which the dendrogram draws horizontally.
    const x = pieces.ax[leaf3]! + 0.4 * (pieces.bx[leaf3]! - pieces.ax[leaf3]!)
    // `along` is a float32, so a few parts in ten million.
    expect(built.tickAt[0]).toBeCloseTo(x, 4)
    expect(built.tickAt[1]).toBeCloseTo(pieces.ay[leaf3]!, 6)
    const ticks = built.strokes.find((s) => s.color === '#ff0000')!
    // Two ticks, each 5 px across a horizontal branch — one up, one down.
    const dy0 = ticks.lines[3]! - ticks.lines[1]!
    const dy1 = ticks.lines[7]! - ticks.lines[5]!
    expect(Math.abs(dy0)).toBeCloseTo(5, 6)
    expect(Math.sign(dy0)).toBe(-Math.sign(dy1))
  })

  it('finds the tick under the pointer, and nothing away from every tick', () => {
    const { built } = scene()
    expect(nearestTick(built, built.tickAt[0]! + 2, built.tickAt[1]! + 1)).toBe(0)
    expect(nearestTick(built, 5, 5)).toBeUndefined()
  })

  it('draws plain links rather than bars while the drawing is moving', () => {
    const settled = scene().built
    const moving = scene({ settled: false }).built
    // Settled: the one branch point's bar. Moving: one link per non-root piece to its parent's end.
    const connectors = (b: typeof settled) => b.strokes[1]!.lines.length / 4
    expect(connectors(settled)).toBe(1)
    expect(connectors(moving)).toBe(3)
  })
})

describe('buildScene colouring', () => {
  it('colours a connector by its branch point, not the flat ink', () => {
    const base = scene()
    const tree = base.tree
    const landmarkColor = Array.from(tree.nodes, (v) => (v === 2 ? '#00ff00' : '#0000ff'))
    const { built } = scene({
      branches: {
        sub: {
          node: new Int32Array(0),
          piece: new Int32Array(0),
          f0: new Float32Array(0),
          f1: new Float32Array(0),
        },
        groups: [],
        landmarkColor,
      },
    })
    // The bar at branch point 2 is the one green stroke.
    const green = built.strokes.filter((s) => s.color === '#00ff00')
    expect(green).toHaveLength(1)
    expect(green[0]!.lines).toHaveLength(4)
  })

  it('says a measure that is one value everywhere in words, with no ramp', () => {
    const flat = scene({
      legend: { title: 'Flow centrality', stops: ['#000', '#fff'], hi: '0' },
    }).built
    expect(flat.ramp).toBeUndefined()
    expect(flat.texts.map((t) => t.text)).toContain('all 0')
    const ranged = scene({
      legend: { title: 'Strahler order', stops: ['#000', '#fff'], lo: '1', hi: '4' },
    }).built
    expect(ranged.ramp).toBeDefined()
  })
})

describe('the synapse key', () => {
  it('lists each colour with its value, and says how many more there are', () => {
    const { built } = scene({
      key: {
        entries: [
          { label: 'Tm3', color: '#ff0000' },
          { label: 'DNp02', color: '#00ff00' },
        ],
        more: 5,
      },
    })
    const texts = built.texts.map((t) => t.text)
    expect(texts).toContain('Tm3')
    expect(texts).toContain('DNp02')
    expect(texts).toContain('+5 more')
    expect(built.strokes.some((s) => s.color === '#00ff00')).toBe(true)
  })
})

describe('sceneToSvg', () => {
  it('writes the strokes, dots and text the canvas paints', () => {
    const { built } = scene()
    const svg = sceneToSvg(built, 'sans-serif')
    expect(svg.querySelectorAll('path').length).toBe(built.strokes.length)
    expect(svg.querySelectorAll('circle').length).toBe(built.dots.length)
    expect(svg.querySelector('text')?.textContent).toBe('1 µm')
    expect(svg.querySelector('title')?.textContent).toBe('Y')
  })
})

describe('blendPieces', () => {
  it('slides a piece from where it was, matched by the skeleton node it ends at', () => {
    const { pieces, tree } = scene()
    const moved = {
      ax: pieces.ax.map((v) => v + 100),
      ay: pieces.ay,
      bx: pieces.bx.map((v) => v + 100),
      by: pieces.by,
    }
    const half = blendPieces({ pieces, nodes: tree.nodes }, { pieces: moved, tree }, 0.5)
    for (let k = 0; k < tree.nodes.length; k++) {
      expect(half.ax[k]).toBeCloseTo(pieces.ax[k]! + 50, 6)
      expect(half.bx[k]).toBeCloseTo(pieces.bx[k]! + 50, 6)
    }
  })

  it('grows a piece that was not drawn before out of its parent', () => {
    // Before: the twig to 3 was hidden, so landmark 2 was merged away and 3 had no piece.
    const skeleton = ySkeleton()
    const arbor = buildArbor(skeleton, 0)
    const tree = keyTree(arbor)
    const d = landmarkDistances(tree, arbor.geodesic)
    const before = pruneTwigs(tree, d, 1500).tree
    const beforeShape = rectangularLayout(before, landmarkDistances(before, arbor.geodesic))
    const beforePieces = pieceGeometry(beforeShape, fitTransform(beforeShape, 400, 200))
    const after = pieceGeometry(
      rectangularLayout(tree, d),
      fitTransform(rectangularLayout(tree, d), 400, 200),
    )
    const start = blendPieces(
      { pieces: beforePieces, nodes: before.nodes },
      { pieces: after, tree },
      0,
    )
    const leaf3 = tree.nodes.indexOf(3)
    const branch = tree.nodes.indexOf(2)
    // Landmark 2 was not drawn either, so it grows from the root's end; 3 then grows from 2's start.
    expect(start.ax[leaf3]).toBeCloseTo(start.bx[branch]!, 6)
    expect(start.bx[leaf3]).toBeCloseTo(start.bx[branch]!, 6)
  })
})
