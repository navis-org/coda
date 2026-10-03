/**
 * The See Also relation.
 *
 * Everything here is a property of the table rather than a snapshot of it — which pairs are worth
 * relating is editorial and will change, and a golden file would only record what somebody
 * thought in the week it was written. What must not change is that the relation is symmetric,
 * that every entry opens something, and that no document is a dead end, since a dead end is the
 * complaint the feature exists to answer.
 */

import { describe, expect, it } from 'vitest'

import '../nodes'
import { allNodeDefs } from '../core/registry'
import { helpTypes } from './registry'
import { SEE_ALSO_GROUPS, seeAlsoFor } from './seeAlso'

const REGISTERED = new Set(allNodeDefs().map((def) => def.type))

describe('coverage', () => {
  /*
   * The claim the feature rests on. Find Neurons' document links nothing and four documents link
   * to it — the hub nodes were exactly the ones a reader could not leave, which is what made the
   * prose cross-references the wrong source for this.
   */
  it('leaves no documented node without somewhere to go next', () => {
    for (const type of helpTypes()) {
      expect(seeAlsoFor(type), type).not.toHaveLength(0)
    }
  })

  it('relates the two ways of choosing neurons to each other', () => {
    expect(seeAlsoFor('neuron.explore')).toContain('neuron.findNeurons')
    expect(seeAlsoFor('neuron.findNeurons')).toContain('neuron.explore')
  })

  /*
   * Groups may name a node with no document; the overlay lists it without a link. What the list
   * may not hold is a type the registry has never heard of, which is a typo.
   */
  it('names only real node types', () => {
    for (const group of SEE_ALSO_GROUPS) {
      for (const type of group) {
        expect(REGISTERED.has(type), type).toBe(true)
      }
    }
  })

  it('has no group too small to be a relation', () => {
    for (const group of SEE_ALSO_GROUPS) expect(group.length, group.join()).toBeGreaterThan(1)
  })
})

describe('the relation itself', () => {
  it('is symmetric, which is the whole reason it is a table', () => {
    for (const type of helpTypes()) {
      for (const other of seeAlsoFor(type)) {
        expect(seeAlsoFor(other), `${other} → ${type}`).toContain(type)
      }
    }
  })

  it('never relates a node to itself', () => {
    for (const type of helpTypes()) expect(seeAlsoFor(type), type).not.toContain(type)
  })

  /* A group is a clique, so a careless group relates nodes nobody would read together. This was
     the case that made it obvious: Skeletons under Neuroglancer, Neuroglancer Source missing. */
  it('relates Neuroglancer to its source and not to Skeletons', () => {
    expect(seeAlsoFor('out.neuroglancer')).toContain('dataset.ngsource')
    expect(seeAlsoFor('out.neuroglancer')).not.toContain('neuron.skeletons')
  })

  /*
   * A ceiling rather than a count. Eight is where it sits today; a document whose See Also runs
   * to twenty is a list nobody reads, and the fix then is a smaller group rather than a bigger
   * number here.
   */
  it('keeps a list short enough to read', () => {
    for (const type of helpTypes())
      expect(seeAlsoFor(type).length, type).toBeLessThanOrEqual(10)
  })

  it('sorts by whatever the caller calls things', () => {
    const byLabel = seeAlsoFor('neuron.skeletons', (type) => type.split('.')[1] ?? type)
    expect([...byLabel]).toEqual(
      [...byLabel].sort((a, b) => (a.split('.')[1] ?? a).localeCompare(b.split('.')[1] ?? b)),
    )
  })
})
