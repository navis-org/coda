/**
 * Edge properties at the data layer: the query text, what discovery reads off a sample, and the
 * schema a source builds. The funnels' refusals are `queries.test.ts`', beside the region ones.
 *
 * Query text is asserted because, as with the region arm, every way of getting this wrong
 * compiles and returns a plausible table. The one that matters most is the split: a property read
 * off the connection instead of out of each region's breakdown repeats the connection's whole value
 * on every region's row, and a Build Network downstream then sums it several times over. The forms
 * asserted here were run against fish2 before they were written down.
 */

import { describe, expect, it } from 'vitest'

import { CANONICAL_SCHEMAS, connectivitySchemaWithEdgeProperties } from '../source'
import { adjacencyCypher, connectivityCypher } from './cypher'
import { discoverEdgeProperties } from './schema'

const PROPS = ['weightAxonDendrite', 'weightHP']

describe('connectivityCypher with edge properties', () => {
  it('returns each property after the weight, by string key', () => {
    const query = connectivityCypher({
      datasetId: 'x',
      neuronIds: ['1'],
      direction: 'outputs',
      edgeProperties: PROPS,
    })
    expect(query).toContain(
      "RETURN n.bodyId, n.type, p.bodyId, p.type, w.weight, w['weightAxonDendrite'], w['weightHP']",
    )
  })

  it('escapes a name as a string, since it arrives from a server', () => {
    const query = connectivityCypher({
      datasetId: 'x',
      neuronIds: ['1'],
      direction: 'outputs',
      edgeProperties: ["it's"],
    })
    expect(query).toContain("w['it\\'s']")
  })

  it('leaves the plain query exactly as it was when nothing is asked for', () => {
    const plain = connectivityCypher({ datasetId: 'x', neuronIds: ['1'], direction: 'outputs' })
    const empty = connectivityCypher({
      datasetId: 'x',
      neuronIds: ['1'],
      direction: 'outputs',
      edgeProperties: [],
    })
    expect(empty).toBe(plain)
  })

  describe('under the region options', () => {
    const split = connectivityCypher({
      datasetId: 'x',
      neuronIds: ['1'],
      direction: 'outputs',
      splitByRoi: true,
      edgeProperties: PROPS,
    })
    const restricted = connectivityCypher({
      datasetId: 'x',
      neuronIds: ['1'],
      direction: 'outputs',
      rois: ['LAL(L)'],
      edgeProperties: PROPS,
    })

    it("reads each region's own value out of its breakdown, never the connection's", () => {
      expect(split).toContain("coalesce(ri[r]['weightAxonDendrite'], 0)")
      // The whole connection's value appears only as a guard, never as a part's value.
      expect(split).not.toMatch(/e0: w\['weightAxonDendrite'\]/)
    })

    it('answers null for a connection whose breakdown never names the property', () => {
      // `has[i]` is asked once per connection: a region entry omits a zero, so an absent key is
      // 0 only where the breakdown mentions the property somewhere.
      expect(split).toContain(
        "any(q IN keys(ri) WHERE ri[q]['weightAxonDendrite'] IS NOT NULL)",
      )
      expect(split).toContain(
        "WHEN has[0] THEN coalesce(ri[r]['weightAxonDendrite'], 0) ELSE null END",
      )
      expect(split).toContain("WHEN has[1] THEN coalesce(ri[r]['weightHP'], 0) ELSE null END")
    })

    it('returns the properties between the weight and the region, the schema order', () => {
      expect(split).toContain(
        'RETURN n.bodyId, n.type, p.bodyId, p.type, part.weight AS weight, part.e0 AS e0, part.e1 AS e1, part.roi AS roi',
      )
    })

    it('re-totals each property over the regions kept when not splitting', () => {
      expect(restricted).toContain('reduce(t = 0, x IN parts | t + x.e0) AS e0')
      expect(restricted).toContain('RETURN n.bodyId, n.type, p.bodyId, p.type, weight, e0, e1')
      // …and does not bother when the parts are returned as they are.
      expect(split).not.toContain('reduce(t = 0')
    })

    it('keeps Min weight on the weight, before the split', () => {
      const query = connectivityCypher({
        datasetId: 'x',
        neuronIds: ['1'],
        direction: 'outputs',
        splitByRoi: true,
        minWeight: 5,
        edgeProperties: PROPS,
      })
      expect(query.indexOf('WHERE weight >= 5')).toBeLessThan(query.indexOf('UNWIND parts'))
    })
  })

  it("renders an exporter's placeholder and far-end label without touching the rest", () => {
    const req = {
      datasetId: 'x',
      neuronIds: ['1'],
      direction: 'inputs' as const,
      edgeProperties: PROPS,
    }
    const rendered = connectivityCypher(req, { ids: '{ids}', partnerLabel: 'Neuron' })
    expect(rendered).toContain(
      'MATCH (p:Neuron)-[w:ConnectsTo]->(n:Neuron)\nWHERE n.bodyId IN {ids}',
    )
    // Everything after the MATCH is the canvas's query, character for character.
    const tail = (q: string) => q.slice(q.indexOf('\n', q.indexOf('WHERE')))
    expect(tail(rendered)).toBe(tail(connectivityCypher(req)))
  })

  it('takes the region list as a placeholder too, for the primary set the canvas resolved', () => {
    const rendered = connectivityCypher(
      { datasetId: 'x', neuronIds: ['1'], direction: 'outputs', splitByRoi: true },
      { ids: '{ids}', rois: '{rois}' },
    )
    expect(rendered).toContain('[r IN {rois} WHERE coalesce(ri[r].post, 0) > 0')
    expect(rendered).not.toContain('keys(ri) WHERE coalesce')
  })
})

describe('adjacencyCypher', () => {
  it('fills the matrix from the chosen property, keeping it the fifth column', () => {
    const query = adjacencyCypher({
      datasetId: 'x',
      sourceIds: ['1'],
      targetIds: ['2'],
      weight: 'weightAxonDendrite',
    })
    expect(query).toContain(
      "RETURN a.bodyId, a.type, b.bodyId, b.type, w['weightAxonDendrite']",
    )
  })

  it('reads the weight itself for the default, spelled as it always was', () => {
    for (const weight of [undefined, 'weight']) {
      const query = adjacencyCypher({
        datasetId: 'x',
        sourceIds: ['1'],
        targetIds: ['2'],
        ...(weight ? { weight } : {}),
      })
      expect(query).toContain('RETURN a.bodyId, a.type, b.bodyId, b.type, w.weight')
    }
  })
})

describe('discovering edge properties', () => {
  // The shape fish2 answered with, trimmed.
  const sampled = [
    ['roiInfo', '{"Midbrain":{"post":1}}'],
    ['weight', 1],
    ['weightHP', 1],
    ['weightAxonDendrite', 1],
    ['weightAxonAxon', 0],
    ['weightNested', { a: 1 }],
  ] as const
  const regionKeys = ['post', 'weightAxonDendrite', 'weightAxonAxon']

  it('offers everything but the weight and the region blob, alphabetically', () => {
    const found = discoverEdgeProperties(sampled, regionKeys)
    expect(found.map((p) => p.name)).toEqual([
      'weightAxonAxon',
      'weightAxonDendrite',
      'weightHP',
    ])
  })

  it('leaves out a value that is not a scalar, as a neuron property would be', () => {
    const found = discoverEdgeProperties(sampled, regionKeys)
    expect(found.some((p) => p.name === 'weightNested')).toBe(false)
  })

  it('marks what the region breakdown carries, and reads a zero as an integer', () => {
    const found = Object.fromEntries(
      discoverEdgeProperties(sampled, regionKeys).map((p) => [p.name, p]),
    )
    expect(found.weightAxonDendrite).toEqual({
      name: 'weightAxonDendrite',
      dtype: 'i64',
      perRegion: true,
    })
    expect(found.weightAxonAxon?.dtype).toBe('i64')
    expect(found.weightHP?.perRegion).toBe(false)
  })

  it('does not take `post` for a property: it is the region entry’s name for the weight', () => {
    const found = discoverEdgeProperties([['post', 3]], ['post'])
    expect(found).toEqual([{ name: 'post', dtype: 'i64', perRegion: false }])
  })
})

describe('the schema a source builds', () => {
  it('puts the properties after the weight and before the region, the query order', () => {
    const base = connectivitySchemaWithEdgeProperties(
      CANONICAL_SCHEMAS.connectivity,
      [{ name: 'weightHP', dtype: 'f64', perRegion: false }],
      ['weightHP', 'unseen'],
    )
    expect(base.columns.map((c) => [c.name, c.dtype])).toEqual([
      ['neuronId', 'str'],
      ['neuronType', 'str'],
      ['partnerId', 'str'],
      ['partnerType', 'str'],
      ['weight', 'i64'],
      // Typed from discovery where it answered, `i64` where it did not.
      ['weightHP', 'f64'],
      ['unseen', 'i64'],
    ])
  })

  it('hands the schema back untouched when nothing is chosen', () => {
    const schema = CANONICAL_SCHEMAS.connectivity
    expect(connectivitySchemaWithEdgeProperties(schema, undefined, [])).toBe(schema)
  })
})
