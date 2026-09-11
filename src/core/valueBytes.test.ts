/**
 * The memory readout's estimate.
 *
 * Two halves, and they fail differently. The **cell model** is pinned against the numbers
 * `scripts/probe-memory.mjs` measured in Chrome, so a change to a constant has to be a change to a
 * measurement. The **ledger** is pinned on sharing, because a sum that counts a shared buffer
 * twice looks exactly like a large graph — the failure is a plausible, wrong number.
 */

import { describe, expect, it } from 'vitest'

import type { TableSchema } from './types'
import type { MeshesValue, SkeletonsValue, TableValue } from './values'
import { EMPTY_BOUNDS, makeMatrix, makeTable } from './values'
import { ByteLedger, columnBytes, valueCategory } from './valueBytes'

function table(data: Record<string, unknown[]>): TableValue {
  const schema: TableSchema = {
    columns: Object.keys(data).map((name) => ({ name, dtype: 'f64' as const })),
  }
  return makeTable(schema, data as TableValue['data'])
}

describe('columnBytes', () => {
  it('charges the measured cost of each column shape', () => {
    const n = 1000
    expect(columnBytes(Array.from({ length: n }, (_, i) => i))).toBe(n * 4)
    expect(columnBytes(Array.from({ length: n }, (_, i) => i + 0.5))).toBe(n * 8)
    // One null in four: a slot each, plus a boxed number for each double — 13 B a cell measured.
    const withNulls = Array.from({ length: n }, (_, i) => (i % 4 ? i + 0.5 : null))
    expect(columnBytes(withNulls) / n).toBeCloseTo(13, 0)
    // An 18-digit id as text: 36 B measured, a slot and a 32-byte string.
    const ids = Array.from({ length: n }, (_, i) => String(720575940000000000n + BigInt(i)))
    expect(columnBytes(ids)).toBe(n * 36)
  })

  it('charges a repeated string once, as JSON.parse shares it', () => {
    const n = 1000
    const types = Array.from({ length: n }, (_, i) => ['LC4', 'LC6', 'T4a'][i % 3]!)
    expect(columnBytes(types)).toBe(n * 4 + 3 * 16)
  })

  it('samples a large string column to within a few percent at both ends', () => {
    const n = 200_000
    const unique = Array.from({ length: n }, (_, i) => `neuron-${String(i).padStart(9, '0')}`)
    const exact = n * 4 + n * 32
    expect(Math.abs(columnBytes(unique) - exact) / exact).toBeLessThan(0.05)
    const repeated = Array.from({ length: n }, (_, i) => ['LC4', 'LC6', 'T4a'][i % 3]!)
    expect(columnBytes(repeated)).toBeLessThan(n * 4 + 1024)
  })
})

describe('ByteLedger', () => {
  it('counts a table held twice once', () => {
    const t = table({ a: [1, 2, 3], b: [0.5, 1.5, 2.5] })
    const ledger = new ByteLedger()
    expect(ledger.add(t)).toBe(3 * 4 + 3 * 8)
    expect(ledger.add(t)).toBe(0)
  })

  it('counts a column two tables share once', () => {
    const shared = [0.5, 1.5, 2.5]
    const ledger = new ByteLedger()
    const first = ledger.add(table({ a: shared, b: [1, 2, 3] }))
    // A Select that kept `a`: the same array, handed on by identity.
    expect(ledger.add(table({ a: shared }))).toBe(0)
    expect(first).toBe(3 * 8 + 3 * 4)
  })

  it('charges a view its whole buffer, once, and reports it as buffer storage', () => {
    const backing = new Float64Array(100)
    const ledger = new ByteLedger()
    const matrix = makeMatrix(['a', 'b'], ['c', 'd'], backing.subarray(0, 4))
    const charged = ledger.add(matrix)
    // Two label arrays of two distinct one-letter strings: two slots and two strings each.
    expect(charged).toBe(800 + 2 * (2 * 4 + 2 * 16))
    expect(ledger.buffers).toBe(800)
    expect(ledger.add(makeMatrix(['x'], ['y'], backing.subarray(4, 5)))).toBe(4 + 16 + 4 + 16)
  })

  it('does not charge the geometry cache for buffers a result already holds', () => {
    const item = {
      id: '1',
      positions: new Float32Array(30),
      radii: new Float32Array(10),
      parents: new Int32Array(10),
    }
    const skeletons: SkeletonsValue = {
      kind: 'skeletons',
      items: [item],
      attributes: table({ neuronId: ['1'] }),
      bounds: EMPTY_BOUNDS,
    }
    const ledger = new ByteLedger()
    expect(ledger.add(skeletons)).toBe(120 + 40 + 40 + 4 + (4 + 16))
    expect(ledger.addLoose(item, 200)).toBe(0)
    expect(ledger.buffers).toBe(200)
  })

  it('charges something holding no buffers what the cache recorded, once', () => {
    const manifest = { lods: [0, 1], fragments: ['a', 'b'] }
    const ledger = new ByteLedger()
    expect(ledger.addLoose(manifest, 512)).toBe(512)
    expect(ledger.addLoose(manifest, 512)).toBe(0)
    expect(ledger.buffers).toBe(0)
  })

  it('groups results by what a reader would call them', () => {
    const mesh: MeshesValue = {
      kind: 'meshes',
      items: [],
      attributes: table({}),
      bounds: EMPTY_BOUNDS,
    }
    expect(valueCategory(table({ a: [1] }))).toBe('tables')
    expect(valueCategory(mesh)).toBe('meshes')
    expect(valueCategory({ kind: 'number', value: 1 })).toBe('other')
  })
})
