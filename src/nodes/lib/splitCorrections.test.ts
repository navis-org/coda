/**
 * Hand corrections to a split: how one is stored, where it lands, and what it reassigns.
 *
 * On the arbour tests' Y (`ySkeleton`), rooted at node 0, with the branch at 2 and leaves at 3 and
 * 5, so every subtree can be read off the picture in `__fixtures__/ySkeleton.ts`.
 */

import { describe, expect, it } from 'vitest'

import { CODE_AXON, CODE_DENDRITE, CODE_LINKER } from '../../core/values'
import { ySkeleton } from './__fixtures__/ySkeleton'
import type { SplitCorrection } from './splitCorrections'
import {
  SNAP_NM,
  applyCorrections,
  readCorrections,
  snapToNode,
  splitArbor,
  writeCorrection,
} from './splitCorrections'

const D = CODE_DENDRITE
const A = CODE_AXON
const L = CODE_LINKER
const allDendrite = () => Uint8Array.from([D, D, D, D, D, D])

/** A correction anchored on node `n` of the Y. */
function at(
  n: number,
  scope: SplitCorrection['scope'],
  to: SplitCorrection['to'],
): SplitCorrection {
  const p = ySkeleton().positions
  return { neuron: 'y', at: [p[n * 3]!, p[n * 3 + 1]!, p[n * 3 + 2]!], scope, to }
}

describe('stored corrections', () => {
  it('round-trip, and anything malformed is dropped rather than half-read', () => {
    const good = at(4, 'distal', 'axon')
    const stored = [
      writeCorrection(good),
      'not json',
      JSON.stringify({ ...good, scope: 'sideways' }),
      JSON.stringify({ ...good, at: [1, 2] }),
      JSON.stringify({ ...good, neuron: '' }),
    ]
    expect(readCorrections(stored)).toEqual([good])
    expect(readCorrections(undefined)).toEqual([])
  })

  it('keeps the root a correction was made against, and refuses a malformed one', () => {
    const rooted = { ...at(4, 'distal', 'axon'), root: [2000, 2000, 0] as const }
    expect(readCorrections([writeCorrection(rooted)])).toEqual([rooted])
    expect(readCorrections([JSON.stringify({ ...rooted, root: [1, 2] })])).toEqual([])
  })
})

describe('snapToNode', () => {
  it('finds the node an anchor sits on, and a moved copy within the slack', () => {
    expect(snapToNode(ySkeleton(), [2000, 1000, 0])).toBe(4)
    expect(snapToNode(ySkeleton(), [2000, 1000, SNAP_NM / 2])).toBe(4)
  })

  it('refuses an anchor further than the slack from every node', () => {
    expect(snapToNode(ySkeleton(), [2000, 1000, SNAP_NM * 2])).toBe(-1)
  })
})

describe('applyCorrections', () => {
  it('reassigns everything outward of the picked node, the node included', () => {
    const { labels, applied } = applyCorrections(ySkeleton(), allDendrite(), [
      at(4, 'distal', 'axon'),
    ])
    expect([...labels]).toEqual([D, D, D, D, A, A])
    expect(applied).toBe(1)
  })

  it('reassigns everything else for the proximal side', () => {
    const { labels } = applyCorrections(ySkeleton(), allDendrite(), [at(4, 'proximal', 'axon')])
    expect([...labels]).toEqual([A, A, A, A, D, D])
  })

  it('applies in order, so a later correction wins where two overlap', () => {
    const { labels } = applyCorrections(ySkeleton(), allDendrite(), [
      at(2, 'distal', 'axon'),
      at(5, 'distal', 'linker'),
    ])
    expect([...labels]).toEqual([D, D, A, A, A, L])
  })

  it('never edits the labels it was handed, and hands them back when there is nothing to do', () => {
    const input = allDendrite()
    applyCorrections(ySkeleton(), input, [at(4, 'distal', 'axon')])
    expect([...input]).toEqual([D, D, D, D, D, D])
    expect(applyCorrections(ySkeleton(), input, []).labels).toBe(input)
  })

  it('skips a correction whose anchor lands on no node, or on another fragment', () => {
    // Node 4 cut off from the root: a forest, so "outward of 4" means nothing from 0.
    const forest = ySkeleton(undefined, [-1, 0, 1, 2, -1, 4])
    const far: SplitCorrection = { ...at(4, 'distal', 'axon'), at: [9e6, 9e6, 9e6] }
    const result = applyCorrections(forest, allDendrite(), [far, at(4, 'distal', 'axon')])
    expect(result.applied).toBe(0)
    expect([...result.labels]).toEqual([D, D, D, D, D, D])
  })

  it('measures away from the root a correction carries, whatever the default would be', () => {
    // Rooted at the leaf 5, the subtree of 2 is 2, 1, 0 and 3: the arbour turned around.
    const fromFive = { ...at(2, 'distal', 'axon'), root: [2000, 2000, 0] as const }
    const { labels, applied } = applyCorrections(ySkeleton(), allDendrite(), [fromFive])
    expect([...labels]).toEqual([A, A, A, A, D, D])
    expect(applied).toBe(1)
  })

  it('places nothing when its root lands on no node', () => {
    const lost = { ...at(2, 'distal', 'axon'), root: [9e9, 9e9, 9e9] as const }
    expect(applyCorrections(ySkeleton(), allDendrite(), [lost]).applied).toBe(0)
  })

  it('measures away from the soma where one is labelled, the default root', () => {
    // Soma at the leaf 5: "outward of 2" is then towards 0 and 3.
    const somaAt5 = { ...ySkeleton(), compartments: Uint8Array.from([0, 0, 0, 0, 0, 1]) }
    expect(splitArbor(somaAt5).root).toBe(5)
    const { labels } = applyCorrections(somaAt5, allDendrite(), [at(2, 'distal', 'axon')])
    expect([...labels]).toEqual([A, A, A, A, D, D])
  })
})

describe('splitArbor', () => {
  it('is one arbour per geometry, so a re-labelled copy of the item does not rebuild it', () => {
    // What every re-run hands the editor: a new item object around the same arrays.
    const skeleton = ySkeleton()
    const relabelled = { ...skeleton, split: Uint8Array.from([D, D, A, A, A, A]) }
    expect(splitArbor(relabelled)).toBe(splitArbor(skeleton))
    // Moved positions are a different tree to measure over, even with the same parents.
    const mirrored = { ...skeleton, positions: skeleton.positions.map((v) => -v) }
    expect(splitArbor(mirrored)).not.toBe(splitArbor(skeleton))
  })

  it('is rebuilt when the soma moves over the same arrays, the key not covering the labels', () => {
    const skeleton = ySkeleton()
    expect(splitArbor(skeleton).root).toBe(0)
    const somaAt3 = { ...skeleton, compartments: Uint8Array.from([0, 0, 0, 1, 0, 0]) }
    expect(splitArbor(somaAt3).root).toBe(3)
  })
})
