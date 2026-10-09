import { describe, expect, it } from 'vitest'

import { radialLayout, rectangularLayout } from '../../nodes/lib/arborLayout'
import {
  buildArbor,
  keyTree,
  landmarkDistances,
  orientPlacement,
  projectSynapses,
  pruneTwigs,
} from '../../nodes/lib/arborOps'
import { ySkeleton } from '../../nodes/lib/__fixtures__/ySkeleton'
import {
  PLOT_PAD,
  arborPointAt,
  fitTransform,
  panBy,
  pickPiece,
  pieceGeometry,
  placeOnPiece,
  subSegments,
  synapseMarks,
  toLayout,
  toScreen,
  zoomAbout,
} from './arborPlot'

/** The shared Y, rooted at 0: landmarks 0, 2, 3 (1 µm below 2) and 5 (2 µm below 2). */
function y() {
  const skeleton = ySkeleton()
  const arbor = buildArbor(skeleton, 0)
  const tree = keyTree(arbor)
  return { skeleton, arbor, tree, d: landmarkDistances(tree, arbor.geodesic) }
}

describe('fitTransform', () => {
  it('keeps a radial drawing round and fits each axis of a rectangular one on its own', () => {
    const { tree, d } = y()
    const radial = fitTransform(radialLayout(tree, d), 400, 200)
    expect(radial.sx).toBe(radial.sy)
    const rect = fitTransform(rectangularLayout(tree, d), 400, 200)
    expect(rect.sx).not.toBe(rect.sy)
    // The drawing's far corner lands inside the padding, not past it.
    const [right] = toScreen(rect, 4000, 0.5)
    expect(right).toBeCloseTo(400 - PLOT_PAD, 6)
  })
})

describe('zoomAbout and panBy', () => {
  it('keeps the layout point under the pointer where it was', () => {
    const { tree, d } = y()
    const shape = rectangularLayout(tree, d)
    const before = fitTransform(shape, 400, 200)
    const anchor = toLayout(before, 120, 80)
    const after = fitTransform(shape, 400, 200, zoomAbout(before, 0.5, 120, 80))
    expect(after.zoom).toBeCloseTo(2, 9)
    const [px, py] = toScreen(after, anchor[0], anchor[1])
    expect(px).toBeCloseTo(120, 6)
    expect(py).toBeCloseTo(80, 6)
  })

  it('never zooms out past the fit', () => {
    const { tree, d } = y()
    const t = fitTransform(rectangularLayout(tree, d), 400, 200)
    expect(zoomAbout(t, 4, 10, 10).zoom).toBe(1)
  })

  it('moves the drawing with the drag', () => {
    const { tree, d } = y()
    const shape = rectangularLayout(tree, d)
    const t = fitTransform(shape, 400, 200)
    const moved = fitTransform(shape, 400, 200, panBy(t, 30, -10))
    const [x0, y0] = toScreen(t, 2000, 1)
    const [x1, y1] = toScreen(moved, 2000, 1)
    expect(x1 - x0).toBeCloseTo(30, 6)
    expect(y1 - y0).toBeCloseTo(-10, 6)
  })
})

describe('clicking a piece', () => {
  it('finds the skeleton point a click on a drawn piece stands for, and draws it back there', () => {
    const { arbor, tree, d } = y()
    const shape = rectangularLayout(tree, d)
    const t = fitTransform(shape, 400, 200)
    const leaf5 = tree.nodes.indexOf(5)
    // Three quarters of the way along the segment 2 → 5, which is 2 µm: 1.5 µm past the branch.
    const [ax, ay] = toScreen(t, shape.x0[leaf5]!, shape.y0[leaf5]!)
    const [bx, by] = toScreen(t, shape.x1[leaf5]!, shape.y1[leaf5]!)
    const pieces = pieceGeometry(shape, t)
    const picked = pickPiece(pieces, ax + 0.75 * (bx - ax), ay + 0.75 * (by - ay))
    expect(picked?.piece).toBe(leaf5)
    const point = arborPointAt(arbor, tree, d, arbor.geodesic, picked!.piece, picked!.along)
    // 3,500 nm from the root lies on the edge 4 → 5, half way along it.
    expect(point.node).toBe(5)
    expect(point.t).toBeCloseTo(0.5, 6)
    // And back: the same piece, the same share of it.
    const drawn = placeOnPiece(tree, d, arbor, arbor.geodesic, point)!
    expect(drawn.piece).toBe(leaf5)
    expect(drawn.along).toBeCloseTo(0.75, 6)
  })

  it('picks nothing far from every piece', () => {
    const { tree, d } = y()
    const shape = rectangularLayout(tree, d)
    const t = fitTransform(shape, 400, 200)
    expect(pickPiece(pieceGeometry(shape, t), 200, -50)).toBeUndefined()
  })
})

describe('synapseMarks', () => {
  const sites = [
    { x: 2400, y: 100, z: 0, polarity: 'post' }, // on the twig to 3
    { x: 2050, y: 1500, z: 0, polarity: 'pre' }, // on the branch to 5
  ]

  it('marks each synapse on its piece, outputs and inputs on opposite sides', () => {
    const { skeleton, arbor, tree, d } = y()
    const placement = orientPlacement(arbor, projectSynapses(skeleton, sites))
    const marks = synapseMarks(
      tree,
      d,
      arbor,
      arbor.geodesic,
      placement,
      (s) => sites[s]!.polarity,
    )
    expect(marks.piece[0]).toBe(tree.nodes.indexOf(3))
    // 400 nm along the 1 µm segment 2 → 3.
    expect(marks.along[0]).toBeCloseTo(0.4, 6)
    expect(marks.side[0]).toBe(-1)
    expect(marks.side[1]).toBe(1)
    expect(marks.onHiddenTwigs).toBe(0)
  })

  it('counts a synapse on a hidden twig rather than moving it', () => {
    const { skeleton, arbor, tree, d } = y()
    const pruned = pruneTwigs(tree, d, 1500)
    const shown = landmarkDistances(pruned.tree, arbor.geodesic)
    const placement = orientPlacement(arbor, projectSynapses(skeleton, sites))
    const marks = synapseMarks(
      pruned.tree,
      shown,
      arbor,
      arbor.geodesic,
      placement,
      (s) => sites[s]!.polarity,
    )
    expect(marks.piece[0]).toBe(-1)
    expect(marks.onHiddenTwigs).toBe(1)
    expect(marks.piece[1]).toBe(1)
  })
})

describe('subSegments', () => {
  it('files every skeleton edge under its drawn piece, as a stretch of it', () => {
    const { arbor, tree, d } = y()
    const sub = subSegments(arbor, tree, d, arbor.geodesic)
    // Five edges, every node but the root.
    expect(sub.node.length).toBe(5)
    const at = Array.from(sub.node).indexOf(4)
    // 2 → 4 is the first half of the 2 µm piece ending at 5.
    expect(sub.piece[at]).toBe(tree.nodes.indexOf(5))
    expect(sub.f0[at]).toBeCloseTo(0, 6)
    expect(sub.f1[at]).toBeCloseTo(0.5, 6)
  })
})
