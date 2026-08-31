/**
 * Qualify Ids — the node that mints the qualified form and takes it off again.
 *
 * What is worth pinning is decision 1's bargain: the tagged value is deliberately **not** a
 * neuron id, so everything that would query it refuses loudly rather than fetching the wrong
 * neuron. That property is the whole reason the qualified form was chosen over a second
 * `dataset` column, so it is asserted here rather than assumed.
 */

import { describe, expect, it } from 'vitest'

import { isNeuronId, qualifiedDataset, qualifyId, unqualifyId } from '../../core/ids'
import { defaultParams, makeInferContext, resolveColumn } from '../../core/node'
import type { ColumnParam, ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, columnNames, schemaOf, tableSchema } from '../../core/types'
import type { CodaType } from '../../core/types'
import { tableFromRows } from '../../core/values'
import type { TableValue } from '../../core/values'
import '../index'

const NEURONS = tableSchema(column('neuronId', 'str'), column('type', 'str'))
const table = (rows: Array<[string | null, string]>): TableValue =>
  tableFromRows(
    NEURONS,
    rows.map(([neuronId, type]) => ({ neuronId, type })),
    'neurons',
  )

const def = requireNodeDef('core.qualifyIds')
const inputs: Record<string, CodaType | undefined> = { in: T.neurons(NEURONS) }

function run(params: ParamValues, input = table([['720575940623374218', 'LC4']])) {
  const all = { ...defaultParams(def), ...params }
  const ctx = {
    params: all,
    input: () => input,
    column: (id: string) =>
      resolveColumn(def.params?.find((p) => p.id === id) as ColumnParam, all, inputs),
  }
  return (def.evaluate as (c: unknown) => { out: TableValue })(ctx).out
}

describe('the grammar', () => {
  it('produces something isNeuronId rejects, which is the point', () => {
    /*
     * Decision 1's whole bargain. A composite key would have been more honest and sorted
     * properly; it was declined because a forgotten `dataset` column silently merges two
     * different neurons. This form cannot be spliced into a query by accident.
     */
    const qualified = qualifyId('flywire', '720575940623374218')
    expect(qualified).toBe('flywire:720575940623374218')
    expect(isNeuronId('720575940623374218')).toBe(true)
    expect(isNeuronId(qualified)).toBe(false)
  })

  it('round-trips, which is what makes the pair a pair', () => {
    const qualified = qualifyId('hemibrain', '1234567')
    expect(unqualifyId(qualified)).toBe('1234567')
    expect(qualifiedDataset(qualified)).toBe('hemibrain')
  })

  it('passes an unqualified id through unchanged rather than emptying the column', () => {
    // The honest answer on a graph where somebody wired the strip one step too early.
    expect(unqualifyId('1234567')).toBe('1234567')
    expect(qualifiedDataset('1234567')).toBeUndefined()
  })

  it('splits on the first separator, so the dataset is ours to name and the id is not', () => {
    expect(qualifiedDataset('flywire:a:b')).toBe('flywire')
    expect(unqualifyId('flywire:a:b')).toBe('a:b')
  })
})

describe('the node', () => {
  it('tags and strips, and publishes the schema it produces', () => {
    const params = { direction: 'add', prefix: 'flywire' }
    const out = run(params)
    expect(out.data.neuronId).toEqual(['flywire:720575940623374218'])
    const inferred = def.inferOutputs?.(makeInferContext(def, params as never, inputs))
    expect(schemaOf(inferred?.out)?.columns).toEqual(out.schema.columns)

    const back = run({ direction: 'remove' }, out)
    expect(back.data.neuronId).toEqual(['720575940623374218'])
  })

  it('keeps the dataset in its own column when asked, so a filter can still tell them apart', () => {
    const tagged = run({ direction: 'add', prefix: 'flywire' })
    const back = run({ direction: 'remove', into: 'dataset' }, tagged)
    expect(columnNames(back.schema)).toEqual(['neuronId', 'type', 'dataset'])
    expect(back.data.dataset).toEqual(['flywire'])
  })

  it('leaves a null id null rather than inventing a neuron called flywire:null', () => {
    const out = run({ direction: 'add', prefix: 'flywire' }, table([[null, 'LC4']]))
    expect(out.data.neuronId).toEqual([null])
  })

  it('says out loud that what it produced can no longer be queried', () => {
    // Not a refusal — it is the intended output. But a neuron table whose ids stopped working
    // is exactly the thing somebody needs told while they can still see the node.
    const issues = def.validate?.(
      makeInferContext(
        def,
        { ...defaultParams(def), direction: 'add', prefix: 'flywire' },
        inputs,
      ),
    )
    expect(issues?.join(' ')).toMatch(/not a valid neuron id/)
  })

  it('warns rather than tagging nothing when no dataset is named', () => {
    const issues = def.validate?.(
      makeInferContext(def, { ...defaultParams(def), direction: 'add' }, inputs),
    )
    expect(issues?.join(' ')).toMatch(/No dataset name/)
    expect(run({ direction: 'add', prefix: '' }).data.neuronId).toEqual(['720575940623374218'])
  })

  it('stays a neuron table, because that is what Stack Tables downstream needs', () => {
    /*
     * Decision 1's other half: the *type* does not change, so the refusal happens at fetch time
     * rather than at edit time. Demoting the kind would break the Stack this exists to feed.
     */
    expect(run({ direction: 'add', prefix: 'flywire' }).kind).toBe('neurons')
  })
})
