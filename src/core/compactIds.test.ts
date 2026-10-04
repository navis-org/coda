import { describe, expect, it } from 'vitest'

import '../nodes'
import { fragmentFrom, readFragment } from './clipboard'
import { node } from '../test/graph'
import { compactParams, expandParams } from './compactIds'
import type { CodaGraph } from './graph'
import { addNode, deserializeGraph, emptyGraph, serializeGraph } from './graph'
import { hashValue } from './hash'
import { readRecipe, recipeFrom, recipeText } from './recipes'

/** Eighteen-digit CAVE root ids, past a double's integers, in no particular order. */
const caveIds = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    String(864691135000000000n + BigInt((i * 7_368_791) % 999_983) * 1_000_003n),
  )

function scatterWith(selection: string[]): CodaGraph {
  return addNode(
    emptyGraph('t'),
    node('sc', 'out.scatter', { selection, idColumn: 'neuronId' }),
  )
}

interface CompactShape {
  compactIds: string
  prefixes?: string[]
}

/** A list through the document's spelling and back. */
function roundTrip(ids: string[]): unknown {
  const written = compactParams({ ids })
  return expandParams(JSON.parse(JSON.stringify(written)) as Record<string, unknown>).ids
}

describe('a long list of integer ids in a document', () => {
  it('decodes to exactly the list encoded, order and all', () => {
    const pad = Array.from({ length: 64 }, (_, i) => String(i * 3))
    for (const ids of [
      caveIds(500),
      // Each side of 2^53, both directions, and back from the BigInt path to small ids.
      [
        ...pad,
        '0',
        '1',
        '9007199254740991',
        '9007199254740993',
        '5',
        '18446744073709551615',
        '7',
      ],
      Array.from({ length: 300 }, (_, i) => String(720_575_940_000_000_000n - BigInt(i))),
      Array.from({ length: 300 }, (_, i) => String(999_999_999_999_999 - i * 1_000_003)),
    ]) {
      expect(compactParams({ ids }).ids).toHaveProperty('compactIds')
      expect(roundTrip(ids)).toEqual(ids)
    }
  })

  it('refuses text it did not write rather than reading a shorter list', () => {
    const { compactIds } = compactParams({ ids: caveIds(100) }).ids as unknown as CompactShape
    expect(expandParams({ ids: { compactIds: compactIds.slice(0, -1) } })).toEqual({})
    expect(expandParams({ ids: { compactIds: `${compactIds}!` } })).toEqual({})
  })

  it('keeps a short list, an entry ending in no digit, and a list it would not shorten', () => {
    const short = caveIds(63)
    const unsplittable = [...caveIds(100), 'T4a']
    // A prefix per entry: written once each, the prefixes alone are as long as the list.
    const labels = Array.from(
      { length: 100 },
      (_, i) => `type${String.fromCharCode(65 + (i % 26))}${i}x${i}`,
    )
    const params = { a: short, b: unsplittable, c: labels, d: 'x' }
    expect(compactParams(params)).toBe(params)
  })

  it('splits an entry exactly, leading zeros and all', () => {
    const ids = [...caveIds(100), '007', '0', 'LC4', 'x00']
    expect(compactParams({ ids }).ids).toHaveProperty('prefixes')
    expect(roundTrip(ids)).toEqual(ids)
  })

  it('compacts qualified ids, each dataset stepping through its own', () => {
    // Interleaved, as a stacked table of two connectomes sorted by type would put them.
    const ids = caveIds(5000).flatMap((id, i) => [
      `flywire:${id}`,
      `hemibrain:${1_000_000_000 + i * 37}`,
    ])
    const written = compactParams({ ids }).ids as unknown as CompactShape
    expect(written.prefixes).toEqual(['flywire:', 'hemibrain:'])
    expect(JSON.stringify(written).length).toBeLessThan(JSON.stringify(ids).length / 2)
    expect(roundTrip(ids)).toEqual(ids)
  })

  it('refuses a prefix index with nothing after it, or one past the table', () => {
    const { compactIds, prefixes } = compactParams({
      ids: caveIds(100).map((id) => `fw:${id}`),
    }).ids as unknown as CompactShape
    expect(expandParams({ ids: { compactIds: `${compactIds}A`, prefixes } })).toEqual({})
    expect(expandParams({ ids: { compactIds: `B${compactIds.slice(1)}`, prefixes } })).toEqual(
      {},
    )
  })

  it('round-trips a selection through a file to the identical array and the same key', () => {
    const ids = caveIds(5000)
    const g = scatterWith(ids)
    const text = serializeGraph(g)
    expect(text).toContain('"compactIds"')
    expect(text.length).toBeLessThan(JSON.stringify(ids).length / 2)
    const loaded = deserializeGraph(text).graph.nodes[0]!.params.selection
    expect(loaded).toEqual(ids)
    expect(hashValue(loaded)).toBe(hashValue(ids))
  })

  it('writes only params declared as id lists compactly, the rest as somebody typed them', () => {
    const columns = Array.from({ length: 500 }, (_, i) => `n${i + 1}`)
    const g = addNode(emptyGraph('t'), node('sel', 'core.select', { columns }))
    expect(serializeGraph(g)).not.toContain('"compactIds"')
    expect(deserializeGraph(serializeGraph(g)).graph.nodes[0]!.params.columns).toEqual(columns)
  })

  it('still opens a file holding the plain list', () => {
    const ids = caveIds(5000)
    const plain = JSON.stringify({ ...scatterWith(ids), version: 1 })
    expect(deserializeGraph(plain).graph.nodes[0]!.params.selection).toEqual(ids)
  })

  it('drops a compacted value that does not decode, so the param reads as its default', () => {
    const params = expandParams({ selection: { compactIds: '!!' }, idColumn: 'neuronId' })
    expect(params).toEqual({ idColumn: 'neuronId' })
  })

  it('writes a clipboard fragment and a recipe compactly, and reads both back whole', () => {
    const ids = caveIds(5000)
    const g = scatterWith(ids)
    const fragment = fragmentFrom(g, ['sc'])!
    expect(fragment).toContain('"compactIds"')
    expect(readFragment(fragment)!.graph.nodes[0]!.params.selection).toEqual(ids)

    const recipe = recipeFrom(g, ['sc'], { name: 'r' })!
    // In memory a recipe keeps the plain list; only its text is compacted.
    expect(recipe.graph.nodes[0]!.params.selection).toBe(ids)
    const text = recipeText(recipe)
    expect(text).toContain('"compactIds"')
    expect(readRecipe(text)!.recipe.graph.nodes[0]!.params.selection).toEqual(ids)
  })
})

describe('the key of a long list', () => {
  it('stands in a digest, which still tells two lists one id apart', () => {
    const ids = caveIds(5000)
    const other = [...ids]
    other[2500] = '1'
    expect(hashValue({ selection: ids })).not.toBe(hashValue({ selection: other }))
    expect(hashValue({ selection: ids })).toBe(hashValue({ selection: [...ids] }))
  })
})
