/**
 * Which synapses light up.
 *
 * Every case here is one the shipped version got wrong. The two that matter most cannot be seen
 * in a screenshot — an untyped partner drawn in a palette colour looks exactly like a partner
 * that *is* lit, and an output synapse lit for an input partner looks like a real connection.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { HIGHLIGHT_OTHER, highlightColumn, partnerLabel, polarityFor } from './synapseHighlight'

const SCHEMA = tableSchema(
  column('neuronId', 'str'),
  column('partnerId', 'str'),
  column('partnerType', 'str'),
  column('polarity', 'str'),
)

function cloud(rows: Array<{ partnerType: string | null; polarity: string }>) {
  return tableFromRows(
    SCHEMA,
    rows.map((r, i) => ({
      neuronId: '10003',
      partnerId: String(1000 + i),
      partnerType: r.partnerType,
      polarity: r.polarity,
    })),
  )
}

function partnerTypes(table: ReturnType<typeof cloud>) {
  return table.data['partnerType']!
}

describe('partnerLabel', () => {
  it('names an untyped partner the way the list does', () => {
    /*
     * The whole of the original bug in one assertion. `resolveColor` spells a null `—`; the
     * override map spelled it `''`; the two never met, so every untyped partner kept a bright
     * palette colour on every render. 565 of body 10003's 3,016 input partners are untyped.
     */
    expect(partnerLabel(null)).toBe('—')
    expect(partnerLabel(undefined)).toBe('—')
    expect(partnerLabel('AN10B021')).toBe('AN10B021')
  })
})

describe('polarityFor', () => {
  it('maps a direction to the queried neuron’s own side', () => {
    // Backwards, this lights the right *number* of the wrong synapses — which is the hardest
    // kind of wrong to notice.
    expect(polarityFor('inputs')).toBe('post')
    expect(polarityFor('outputs')).toBe('pre')
  })
})

describe('highlightColumn', () => {
  it('lights only the selected partner, in the selected direction', () => {
    const table = cloud([
      { partnerType: 'AN10B021', polarity: 'post' },
      { partnerType: 'AN10B021', polarity: 'post' },
      { partnerType: 'Tm3', polarity: 'post' },
      // Same type name on the other side. Matching on the partner alone lights this too.
      { partnerType: 'AN10B021', polarity: 'pre' },
    ])
    const out = highlightColumn(table, partnerTypes(table), {
      partners: ['AN10B021'],
      direction: 'inputs',
    })
    expect(out.lit).toBe(2)
    expect(out.values).toEqual(['AN10B021', 'AN10B021', HIGHLIGHT_OTHER, HIGHLIGHT_OTHER])
  })

  it('leaves untyped partners unlit rather than colouring them', () => {
    /*
     * The reported symptom, reduced: hundreds of synapses lit across the arbour, the same ones
     * whatever was selected, because "untyped" is a constant property of the data.
     */
    const table = cloud([
      { partnerType: null, polarity: 'post' },
      { partnerType: null, polarity: 'post' },
      { partnerType: 'AN10B021', polarity: 'post' },
    ])
    const out = highlightColumn(table, partnerTypes(table), {
      partners: ['AN10B021'],
      direction: 'inputs',
    })
    expect(out.lit).toBe(1)
    expect(out.values).toEqual([HIGHLIGHT_OTHER, HIGHLIGHT_OTHER, 'AN10B021'])
  })

  it('can light the untyped bucket when that is what was picked', () => {
    // `—` is a selectable row in the list like any other, so it has to work as one.
    const table = cloud([
      { partnerType: null, polarity: 'post' },
      { partnerType: 'Tm3', polarity: 'post' },
    ])
    const out = highlightColumn(table, partnerTypes(table), {
      partners: ['—'],
      direction: 'inputs',
    })
    expect(out.lit).toBe(1)
    expect(out.values[0]).toBe('—')
  })

  it('lights nothing when the selection matches nothing', () => {
    const table = cloud([{ partnerType: 'Tm3', polarity: 'post' }])
    const out = highlightColumn(table, partnerTypes(table), {
      partners: ['DNp02'],
      direction: 'inputs',
    })
    expect(out.lit).toBe(0)
    expect(out.values).toEqual([HIGHLIGHT_OTHER])
  })

  it('keeps several partners apart', () => {
    const table = cloud([
      { partnerType: 'Tm3', polarity: 'pre' },
      { partnerType: 'DNp02', polarity: 'pre' },
      { partnerType: 'LT1', polarity: 'pre' },
    ])
    const out = highlightColumn(table, partnerTypes(table), {
      partners: ['Tm3', 'LT1'],
      direction: 'outputs',
    })
    expect(out.lit).toBe(2)
    expect(out.values).toEqual(['Tm3', HIGHLIGHT_OTHER, 'LT1'])
  })

  it('matches on the partner alone when the cloud has no polarity', () => {
    // Degraded, not broken: a source that names partners but not sides still highlights.
    const schema = tableSchema(column('neuronId', 'str'), column('partnerType', 'str'))
    const table = tableFromRows(schema, [
      { neuronId: '1', partnerType: 'Tm3' },
      { neuronId: '1', partnerType: 'LT1' },
    ])
    const out = highlightColumn(table, table.data['partnerType']!, {
      partners: ['Tm3'],
      direction: 'inputs',
    })
    expect(out.lit).toBe(1)
  })

  it('produces a vocabulary of its own, never the data’s', () => {
    /*
     * The invariant the module exists for: however odd the partner column is, the derived column
     * holds only names that were selected plus one sentinel. Nothing downstream then depends on
     * how a null, a number or an empty string gets stringified.
     */
    const table = cloud([
      { partnerType: null, polarity: 'post' },
      { partnerType: '', polarity: 'post' },
      { partnerType: 'Tm3', polarity: 'post' },
    ])
    const out = highlightColumn(table, partnerTypes(table), {
      partners: ['Tm3'],
      direction: 'inputs',
    })
    expect(new Set(out.values)).toEqual(new Set(['Tm3', HIGHLIGHT_OTHER]))
  })
})
