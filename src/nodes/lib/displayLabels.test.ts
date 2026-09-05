/**
 * The annotation lookup that names a dendrogram's leaves.
 *
 * The join itself is `labelsByNeuron`'s and is covered by `typeMapping.test.ts`; what belongs
 * here is the guard around it — the four ways of having nothing to look anything up in, which
 * that function answers by throwing and this one has to answer with a drawing.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { displayLabels } from './displayLabels'

function neurons(rows: Array<{ neuronId: string; type: string | null }>): TableValue {
  return tableFromRows(tableSchema(column('neuronId', 'str'), column('type', 'str')), rows)
}

const THREE = neurons([
  { neuronId: '101', type: 'LC4' },
  { neuronId: '102', type: 'LPLC2' },
  { neuronId: '103', type: 'LC6' },
])

describe('displayLabels', () => {
  it('names a leaf from the annotation column matched on its own label', () => {
    const names = displayLabels(THREE, 'neuronId', 'type')!
    expect(names.get('101')).toBe('LC4')
    expect(names.size).toBe(3)
  })

  it('says nothing about a label the table does not cover', () => {
    // The caller turns that into "keep the leaf's own label", which inverts `core.relabel`'s
    // `Unmatched` default on purpose: a blank leaf is worse than the id it replaced.
    expect(displayLabels(THREE, 'neuronId', 'type')!.get('999')).toBeUndefined()
  })

  it('answers nothing in every state that has nothing to look up in', () => {
    // All five are one answer on purpose: the caller draws the value's own labels for each.
    // The last two are why this wrapper exists at all — `labelsByNeuron` reads through
    // `getColumn`, which throws, and a viewer is asked to draw whatever is on the wire.
    expect(displayLabels(undefined, 'neuronId', 'type')).toBeUndefined()
    expect(displayLabels(THREE, undefined, 'type')).toBeUndefined()
    expect(displayLabels(THREE, 'neuronId', undefined)).toBeUndefined()
    expect(displayLabels(THREE, 'neuronId', 'missing')).toBeUndefined()
    expect(displayLabels(THREE, 'missing', 'type')).toBeUndefined()
  })

  it('inherits the join rules rather than restating them', () => {
    /*
     * Spot checks, not a second copy of `typeMapping.test.ts`: what matters here is that this
     * really is `labelsByNeuron` and therefore cannot answer differently from `Partner Vectors`
     * or `Compare Connectivity` — or from the notebook, which reaches the same rules through
     * `coda_relabel`.
     *
     * A blank is no label, and the **first non-blank** row wins a repeated id. That last one
     * is what the emitted `filter` + `coda_relabel` pair does, so the canvas and both exports
     * agree on a table that disagrees with itself.
     */
    const table = neurons([
      { neuronId: '101', type: null },
      { neuronId: '102', type: '' },
      { neuronId: '104', type: 'LPLC2' },
      { neuronId: '104', type: 'SOMETHING ELSE' },
    ])
    const names = displayLabels(table, 'neuronId', 'type')!
    expect(names.get('101')).toBeUndefined()
    expect(names.get('102')).toBeUndefined()
    expect(names.get('104')).toBe('LPLC2')
  })

  it('drops an id that was already rounded, rather than naming the wrong neuron', () => {
    // `idText`'s rule, i.e. invariant 8: an 18-digit root id read off an `i64` column is a
    // float64 and has lost the digits that identified it. The node's `validate` is what says so
    // out loud, since here it is indistinguishable from an unannotated tree.
    // Through `Number(...)`, which is how `typeMapping.test.ts` writes the same case: the
    // literal would not survive the parser, which is the whole point being made.
    const lossy = tableFromRows(tableSchema(column('neuronId', 'i64'), column('type', 'str')), [
      { neuronId: Number('720575940623374218'), type: 'LC4' },
    ])
    expect(displayLabels(lossy, 'neuronId', 'type')!.size).toBe(0)
  })
})
