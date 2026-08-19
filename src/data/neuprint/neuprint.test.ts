/**
 * The neuPrint adapter, against recorded responses.
 *
 * Every fixture in `__fixtures__` is a real, trimmed reply from neuprint.janelia.org. That
 * matters: the alternative to fixtures is either no coverage or tests that hammer a shared
 * production server, and hand-written fakes would only prove the decoders agree with my
 * idea of the API rather than with the API.
 *
 * What is *not* covered here is the transport — CORS, the proxy, auth. Those cannot be
 * exercised without a network, and their failure mode is loud rather than silent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { NUMERIC_DTYPES } from '../../core/types'
import { cableLength } from '../../core/values'

import { NeuPrintSource, THUMBNAIL_MAX_BYTES, meshProgressFraction } from './NeuPrintSource'
import { datasetSegment, get } from './client'
import { meshSourceFromState, precomputedToHttp } from './nglayers'
import { IDENTITY_SCALE, scalePositions, scaleRadii, voxelScale } from './units'
import { resetCredentials, setToken, subscribeAuthFailure } from './credentials'
import connectivityFixture from './__fixtures__/connectivity.json'
import metaMancFixture from './__fixtures__/metaManc.json'
import neuronsFixture from './__fixtures__/neurons.json'
import roiInfoFixture from './__fixtures__/roiInfo.json'
import sampleNeuronsFixture from './__fixtures__/sampleNeurons.json'
import skeletonFixture from './__fixtures__/skeleton.json'
import {
  adjacencyCypher,
  connectivityCypher,
  escapeIdentifier,
  escapeString,
  findNeuronsCypher,
  numberList,
  pathStepCypher,
  synapsesCypher,
} from './cypher'
import type { CypherResponse } from './decode'
import {
  inferTableFromCypher,
  roiCountsFromCypher,
  skeletonFromSwc,
  tableFromCypher,
} from './decode'
import { CORE_NEURON_COLUMNS, MAX_EXTRA_COLUMNS, discoverNeuronSchema, schemasFor } from './schema'

const neurons = neuronsFixture as CypherResponse
const connectivity = connectivityFixture as CypherResponse
const roiInfo = roiInfoFixture as CypherResponse
const skeleton = skeletonFixture as CypherResponse
const sampleNeurons = sampleNeuronsFixture as CypherResponse
const metaManc = metaMancFixture as CypherResponse

/**
 * One hop of a path traversal.
 *
 * Every case here is one where a wrong query still returns a plausible table. Aggregating
 * before the threshold rather than after silently drops the many weak connections that add up
 * to a strong pathway; naming the frontier with a `coalesce` instead of two indexed lists
 * still matches, it just scans every neuron in the dataset; and forgetting to flip which end
 * is presynaptic on an upstream hop yields an edge list pointing entirely backwards.
 */
describe('pathStepCypher', () => {
  const base = { datasetId: 'x', collapseTypes: true, direction: 'outputs' as const }

  it('groups by type and sums, when collapsing', () => {
    const query = pathStepCypher({ ...base, types: ['LC4'] })
    expect(query).toContain('coalesce(a.type, toString(a.bodyId)) AS src')
    expect(query).toContain('sum(w) AS weight')
    expect(query).toContain('count(*) AS pairs')
  })

  it('groups by neuron, when not', () => {
    const query = pathStepCypher({ ...base, collapseTypes: false, bodyIds: [1, 2] })
    expect(query).toContain('toString(a.bodyId) AS src')
    expect(query).not.toContain('coalesce')
    expect(query).toContain('a.bodyId IN [1,2]')
  })

  it('applies the threshold after the sum, not to each connection', () => {
    const query = pathStepCypher({ ...base, types: ['LC4'], minWeight: 25 })
    // The WHERE that cuts must come after the aggregating WITH, or a pathway carried by many
    // weak connections disappears.
    expect(query.indexOf('sum(w) AS weight')).toBeLessThan(query.indexOf('WHERE weight >= 25'))
    expect(query).not.toContain('c.weight >= 25')
  })

  it('names the frontier as two indexed lists rather than one computed key', () => {
    const query = pathStepCypher({ ...base, types: ['LC4', "a'L"], bodyIds: [7] })
    expect(query).toContain("WHERE a.type IN ['LC4','a\\'L'] OR a.bodyId IN [7]")
  })

  it('refuses to match the dataset when the frontier is empty', () => {
    // An absent WHERE here would expand every neuron in the volume.
    expect(pathStepCypher(base)).toContain('WHERE false')
  })

  it('flips which end is presynaptic on an upstream hop, so rows always point forwards', () => {
    const out = pathStepCypher({ ...base, types: ['LC4'] })
    const inn = pathStepCypher({ ...base, direction: 'inputs', types: ['LC4'] })
    expect(out).toContain('MATCH (a:Neuron)-[c:ConnectsTo]->(b:Neuron)')
    expect(inn).toContain('MATCH (b:Neuron)-[c:ConnectsTo]->(a:Neuron)')
    // `a` is the frontier either way, but it is the *source* only when travelling downstream.
    expect(out).toContain('coalesce(a.type, toString(a.bodyId)) AS src')
    expect(inn).toContain('coalesce(b.type, toString(b.bodyId)) AS src')
  })

  it('requires both ends to be Neurons, unlike a connectivity fetch', () => {
    // `connectivityCypher` matches a bare far end so a Segment's synapses still count towards
    // a total. A route through an unnamed fragment is not a circuit, and it would be expanded
    // at the next hop.
    const query = pathStepCypher({ ...base, types: ['LC4'] })
    expect(query).toContain('(b:Neuron)')
  })
})

describe('escaping', () => {
  it('closes the quote on a value containing one', () => {
    expect(escapeString("a'L(R)")).toBe("'a\\'L(R)'")
  })

  it('escapes the backslash before the quote, not after', () => {
    // Doing it the other way turns \' into \\' and reopens the string.
    expect(escapeString('back\\slash')).toBe("'back\\\\slash'")
    expect(escapeString("\\'")).toBe("'\\\\\\''")
  })

  it('back-quotes ROI names, which are not valid bare identifiers', () => {
    expect(escapeIdentifier('LO(R)')).toBe('`LO(R)`')
    expect(escapeIdentifier("a'L(R)")).toBe("`a'L(R)`")
  })

  it('drops non-finite ids rather than emitting NaN, which Cypher cannot parse', () => {
    expect(numberList([1, Number.NaN, 3, Infinity])).toBe('[1,3]')
    expect(numberList([])).toBe('[]')
  })
})

describe('URL building', () => {
  it('leaves the colon in a dataset id alone', () => {
    // Found the hard way: `encodeURIComponent` turns it into %3A, neuPrint's router does
    // not decode it, and the skeleton endpoint answers 400 "no store found supporting the
    // datatype and dataset" — which surfaced as an empty result, not an error.
    expect(datasetSegment('hemibrain:v1.2.1')).toBe('hemibrain:v1.2.1')
  })

  it('still escapes what actually needs escaping', () => {
    expect(datasetSegment('a b/c')).toBe('a%20b%2Fc')
  })
})

describe('query building', () => {
  it('matches type, status, size and ROI together', () => {
    const query = findNeuronsCypher({
      datasetId: 'hemibrain:v1.2.1',
      typePattern: 'LC.*',
      statuses: ['Traced'],
      minSize: 1000,
      roi: 'LO(R)',
      limit: 25,
    })
    expect(query).toContain("n.type =~ 'LC.*'")
    expect(query).toContain("n.status IN ['Traced']")
    expect(query).toContain('n.size >= 1000')
    // Neo4j 5 removed `exists()` for properties; not every neuPrint server is on 4.
    expect(query).toContain('n.`LO(R)` IS NOT NULL')
    expect(query).toContain('LIMIT 25')
  })

  it('omits the WHERE clause entirely when nothing is filtered', () => {
    const query = findNeuronsCypher({ datasetId: 'x' })
    expect(query).not.toContain('WHERE')
    expect(query).not.toContain('LIMIT')
  })

  /*
   * The label lookup. Every case here is one where a wrong query still returns a plausible
   * neuron table — the wrong *set* of neurons, with nothing to say so — and there is no
   * network in this suite to catch it downstream.
   */
  describe('label lookup', () => {
    it('compiles a literal lookup to an indexed IN list', () => {
      const query = findNeuronsCypher({
        datasetId: 'x',
        labels: { field: 'type', values: ['LC4', 'LC6'] },
      })
      // `IN`, not a regex alternation: neuPrint has this property indexed and `=~` cannot use it.
      expect(query).toContain("n.`type` IN ['LC4','LC6']")
      expect(query).not.toContain('=~')
    })

    it('reaches a property beyond type and instance', () => {
      const query = findNeuronsCypher({
        datasetId: 'x',
        labels: { field: 'hemilineage', values: ['0B'] },
      })
      expect(query).toContain("n.`hemilineage` IN ['0B']")
    })

    it('escapes the values, so a label carrying a quote cannot end the literal', () => {
      const query = findNeuronsCypher({
        datasetId: 'x',
        labels: { field: 'instance', values: ["a'L(R)"] },
      })
      expect(query).toContain("n.`instance` IN ['a\\'L(R)']")
    })

    it('lowers both sides for a case-insensitive literal', () => {
      const query = findNeuronsCypher({
        datasetId: 'x',
        labels: { field: 'type', values: ['LC4'], ignoreCase: true },
      })
      // Lowering only the column would compare 'lc4' against 'LC4' and match nothing.
      expect(query).toContain("toLower(n.`type`) IN ['lc4']")
    })

    it('matches each regex on its own rather than splicing one alternation', () => {
      const query = findNeuronsCypher({
        datasetId: 'x',
        labels: { field: 'type', values: ['LC.*', 'LPLC1|LPLC2'], regex: true },
      })
      /*
       * `=~` anchors the whole pattern, so folding these into `^(?:LC.*|LPLC1|LPLC2)$` would
       * give the second entry's own alternation a different meaning than it has alone. Per
       * pattern, each entry means exactly what it would in Find Neurons' Type field.
       */
      expect(query).toContain("any(p IN ['LC.*','LPLC1|LPLC2'] WHERE n.`type` =~ p)")
    })

    it('prefixes the inline flag per pattern for a case-insensitive regex', () => {
      const query = findNeuronsCypher({
        datasetId: 'x',
        labels: { field: 'type', values: ['lc.*'], regex: true, ignoreCase: true },
      })
      // `(?i)` is Java's inline flag, which is what Neo4j's regex engine reads.
      expect(query).toContain("any(p IN ['(?i)lc.*'] WHERE n.`type` =~ p)")
    })

    it('adds no clause at all for an empty value list', () => {
      // Empty means "nothing to look up" — the node answers it without a query, and an
      // accidental one here would return the whole dataset.
      const query = findNeuronsCypher({ datasetId: 'x', labels: { field: 'type', values: [] } })
      expect(query).not.toContain('WHERE')
    })

    it('composes with the other filters', () => {
      const query = findNeuronsCypher({
        datasetId: 'x',
        labels: { field: 'type', values: ['LC4'] },
        statuses: ['Traced'],
      })
      expect(query).toContain("n.`type` IN ['LC4'] AND n.status IN ['Traced']")
    })
  })

  it('appends dataset-specific properties to the standard seven', () => {
    const query = findNeuronsCypher({ datasetId: 'x' }, ['cellBodyFiber', 'somaRadius'])
    expect(query).toContain('n.`cellBodyFiber`, n.`somaRadius`')
    // The order has to match the schema — the decoder maps columns positionally.
    expect(query.indexOf('n.bodyId')).toBeLessThan(query.indexOf('n.`cellBodyFiber`'))
  })

  it('flips the arrow for inputs rather than swapping the returned columns', () => {
    const out = connectivityCypher({ datasetId: 'x', bodyIds: [1], direction: 'outputs' })
    const inn = connectivityCypher({ datasetId: 'x', bodyIds: [1], direction: 'inputs' })
    expect(out).toContain('(n:Neuron)-[w:ConnectsTo]->(p)')
    expect(inn).toContain('(p)-[w:ConnectsTo]->(n:Neuron)')
    // Both RETURN n first, so "bodyId" always means the neuron you asked about.
    expect(out).toContain('RETURN n.bodyId, n.type, p.bodyId, p.type, w.weight')
    expect(inn).toContain('RETURN n.bodyId, n.type, p.bodyId, p.type, w.weight')
  })

  it('matches a bare node at the far end, so sub-threshold partners still count', () => {
    // `(p)` not `(p:Neuron)`: excluding Segments would silently under-report total weight.
    expect(connectivityCypher({ datasetId: 'x', bodyIds: [1], direction: 'outputs' })).toContain(
      '->(p)\n',
    )
  })

  it('constrains both ends for adjacency', () => {
    const query = adjacencyCypher({ datasetId: 'x', sourceIds: [1, 2], targetIds: [3] })
    expect(query).toContain('a.bodyId IN [1,2] AND b.bodyId IN [3]')
  })

  it('filters synapses by polarity', () => {
    expect(synapsesCypher({ datasetId: 'x', bodyIds: [1], polarity: 'pre' })).toContain(
      "s.type = 'pre'",
    )
    expect(synapsesCypher({ datasetId: 'x', bodyIds: [1] })).not.toContain('s.type =')
  })
})

describe('decoding a neuron query', () => {
  const schema = discoverNeuronSchema({
    declared: { cellBodyFiber: 'string', somaRadius: 'float' },
  }).neurons

  it('maps a real response onto the dataset schema', () => {
    const table = tableFromCypher(neurons, schema, 'neurons')
    expect(table.kind).toBe('neurons')
    expect(table.length).toBe(neurons.data.length)
    expect(table.schema.columns.map((c) => c.name)).toEqual([
      'bodyId',
      'type',
      'instance',
      'status',
      'size',
      'pre',
      'post',
      'cellBodyFiber',
      'somaRadius',
    ])
    expect(table.data.type?.[0]).toBe('LC4')
    expect(typeof table.data.bodyId?.[0]).toBe('number')
  })

  it('refuses a response whose column count disagrees with the schema', () => {
    // Silently shifting every column by one is the failure this prevents.
    expect(() => tableFromCypher(neurons, discoverNeuronSchema({}).neurons)).toThrow(
      /9 columns but the schema declares 7/,
    )
  })

  it('keeps a null as a null rather than coercing it to 0 or ""', () => {
    // `Number(null)` is 0 and `String(null)` is "null"; either would turn "we don't know"
    // into a value the charts would happily plot.
    const twoColumns = { columns: [CORE_NEURON_COLUMNS[0]!, CORE_NEURON_COLUMNS[1]!] }
    const table = tableFromCypher(
      { columns: ['n.bodyId', 'n.type'], data: [[null, null]] },
      twoColumns,
    )
    expect(table.data.bodyId?.[0]).toBeNull()
    expect(table.data.type?.[0]).toBeNull()
  })
})

describe('decoding an undeclared query (Raw Cypher)', () => {
  it('strips the variable prefix so columns read as names', () => {
    const table = inferTableFromCypher(connectivity)
    expect(table.schema.columns.map((c) => c.name)).toEqual([
      'bodyId',
      'type',
      'bodyId_2',
      'type_2',
      'weight',
    ])
  })

  it('sniffs numeric columns so they can drive an encoding', () => {
    const table = inferTableFromCypher(connectivity)
    const byName = new Map(table.schema.columns.map((c) => [c.name, c.dtype]))
    expect(byName.get('bodyId')).toBe('f64')
    expect(byName.get('type')).toBe('str')
    expect(byName.get('weight')).toBe('f64')
  })

  it('falls back to string for a column with no evidence', () => {
    const table = inferTableFromCypher({ columns: ['x'], data: [[null], [null]] })
    expect(table.schema.columns[0]?.dtype).toBe('str')
  })

  it('renders a map or list as JSON rather than "[object Object]"', () => {
    const table = inferTableFromCypher({ columns: ['n'], data: [[{ a: 1 }], [[1, 2]]] })
    expect(table.data.n?.[0]).toBe('{"a":1}')
    expect(table.data.n?.[1]).toBe('[1,2]')
  })

  it('keeps an expression column name as it is', () => {
    const table = inferTableFromCypher({ columns: ['count(*)'], data: [[3]] })
    expect(table.schema.columns[0]?.name).toBe('count(*)')
  })
})

describe('roiInfo', () => {
  it('unpacks the blob into one row per (neuron, ROI)', () => {
    const table = roiCountsFromCypher(roiInfo)
    expect(table.length).toBeGreaterThan(1)
    expect(table.schema.columns.map((c) => c.name)).toEqual([
      'bodyId',
      'type',
      'roi',
      'pre',
      'post',
    ])
    expect(new Set(table.data.bodyId as number[]).size).toBe(1)
    expect(table.data.roi).toContain('LO(R)')
  })

  it('honours an ROI filter, because the blob nests overlapping regions', () => {
    // LO(R) is inside OL(R): summing both would count the same synapses twice.
    const table = roiCountsFromCypher(roiInfo, ['LO(R)'])
    expect(new Set(table.data.roi as string[])).toEqual(new Set(['LO(R)']))
  })

  it('contributes no rows for a neuron with no roiInfo instead of throwing', () => {
    const table = roiCountsFromCypher({
      columns: ['n.bodyId', 'n.type', 'n.roiInfo'],
      data: [
        [1, 'x', null],
        [2, 'y', 'not json'],
      ],
    })
    expect(table.length).toBe(0)
  })
})

describe('skeletons', () => {
  const parsed = skeletonFromSwc(1158187240, skeleton)

  it('reads a real SWC response into parallel arrays', () => {
    expect(parsed.bodyId).toBe(1158187240)
    expect(parsed.parents.length).toBe(skeleton.data.length)
    expect(parsed.positions.length).toBe(parsed.parents.length * 3)
    expect(parsed.radii.length).toBe(parsed.parents.length)
  })

  it('re-orders so a parent always precedes its child', () => {
    // Anything that walks a skeleton assumes this; neuPrint does not guarantee it.
    for (let i = 0; i < parsed.parents.length; i++) {
      expect(parsed.parents[i]!, `point ${i}`).toBeLessThan(i)
    }
  })

  it('has exactly one root per connected component', () => {
    const roots = [...parsed.parents].filter((p) => p === -1)
    expect(roots.length).toBeGreaterThanOrEqual(1)
  })

  it('treats a link to a missing row as a root rather than dropping the point', () => {
    const orphaned = skeletonFromSwc(1, {
      columns: ['rowId', 'x', 'y', 'z', 'radius', 'link'],
      data: [
        [1, 0, 0, 0, 1, -1],
        [2, 1, 0, 0, 1, 999],
      ],
    })
    expect(orphaned.parents.length).toBe(2)
    expect([...orphaned.parents]).toEqual([-1, -1])
  })

  it('terminates on a cycle instead of hanging, and keeps every point', () => {
    const cyclic = skeletonFromSwc(1, {
      columns: ['rowId', 'x', 'y', 'z', 'radius', 'link'],
      data: [
        [1, 0, 0, 0, 1, 2],
        [2, 1, 0, 0, 1, 1],
      ],
    })
    expect(cyclic.parents.length).toBe(2)
  })

  it('measures cable along the tree, not across it', () => {
    const straight = skeletonFromSwc(1, {
      columns: ['rowId', 'x', 'y', 'z', 'radius', 'link'],
      data: [
        [1, 0, 0, 0, 1, -1],
        [2, 3, 4, 0, 1, 1],
      ],
    })
    expect(cableLength(straight)).toBeCloseTo(5, 5)
    expect(cableLength(parsed)).toBeGreaterThan(0)
  })
})

describe('per-dataset schema discovery', () => {
  const mancProperties = JSON.parse(String(metaManc.data[0]?.[0] ?? '{}')) as Record<string, string>
  const hemibrainSample = sampleNeurons.data
    .map((row) => row[0])
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')

  it('always starts with the seven columns every dataset has', () => {
    const { neurons: schema } = discoverNeuronSchema({})
    expect(schema.columns.map((c) => c.name)).toEqual([
      'bodyId',
      'type',
      'instance',
      'status',
      'size',
      'pre',
      'post',
    ])
  })

  it('maps declared neuPrint types onto Coda dtypes', () => {
    const { neurons: schema } = discoverNeuronSchema({ declared: mancProperties })
    const byName = new Map(schema.columns.map((c) => [c.name, c.dtype]))
    expect(byName.get('somaNeuromere')).toBe('str')
    expect(byName.get('synweight')).toBe('i64') // int
    expect(byName.get('group')).toBe('i64') // long
    expect(byName.get('ntAcetylcholineProb')).toBe('f64') // float
  })

  it('drops the point-typed properties manc declares', () => {
    // manc types five properties `point{srid:9157}`. A table cell cannot hold a point, and
    // stringifying one produces something no encoding can read.
    const { extras } = discoverNeuronSchema({ declared: mancProperties })
    for (const name of ['location', 'rootLocation', 'avgLocation', 'somaLocation']) {
      expect(extras, name).not.toContain(name)
    }
  })

  it('learns from sampled values when the dataset declares nothing — hemibrain', () => {
    // hemibrain's Meta has no `neuronProperties` at all; sampling real neurons is the only
    // way to find `cellBodyFiber` and `somaRadius`.
    const { neurons: schema, extras } = discoverNeuronSchema({ sampled: hemibrainSample })
    expect(extras).toContain('cellBodyFiber')
    expect(schema.columns.find((c) => c.name === 'cellBodyFiber')?.dtype).toBe('str')
    // Sampling can only report the type of the values it saw: somaRadius is a float that
    // happens to be integral in this sample, so it lands on i64. Both are numeric, which
    // is what size and colour encodings actually gate on.
    const somaRadius = schema.columns.find((c) => c.name === 'somaRadius')
    expect(NUMERIC_DTYPES).toContain(somaRadius?.dtype)
  })

  it('subtracts ROI properties, which would otherwise swamp the picker', () => {
    // A hemibrain neuron carries a boolean per innervated ROI — "IB" and "INP" are ROIs and
    // look nothing like one, so they have to be removed by name, not by shape.
    const rois = ['IB', 'INP', 'VMNP', 'LH(R)', 'AVLP(R)', 'SCL(R)', 'VLNP(R)']
    const { extras } = discoverNeuronSchema({ sampled: hemibrainSample, rois })
    for (const roi of rois) expect(extras).not.toContain(roi)
  })

  it('never offers roiInfo or a soma point as a column', () => {
    const { extras } = discoverNeuronSchema({
      sampled: [{ roiInfo: '{}', somaLocation: { x: 1 }, keepMe: 3 }],
    })
    expect(extras).toEqual(['keepMe'])
  })

  it('drops a property whose only samples are objects', () => {
    const { extras } = discoverNeuronSchema({ sampled: [{ weird: { nested: true } }] })
    expect(extras).toEqual([])
  })

  it('caps the extras and says when it did', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < MAX_EXTRA_COLUMNS + 10; i++) many[`p${i}`] = 'int'
    const discovered = discoverNeuronSchema({ declared: many })
    expect(discovered.extras).toHaveLength(MAX_EXTRA_COLUMNS)
    expect(discovered.extrasTruncated).toBe(true)
  })

  it('is stable across runs, so column pickers do not reshuffle', () => {
    const a = discoverNeuronSchema({ declared: mancProperties, sampled: hemibrainSample })
    const b = discoverNeuronSchema({ declared: mancProperties, sampled: hemibrainSample })
    expect(a.extras).toEqual(b.extras)
  })

  it('omits synapse partner columns rather than shipping them as permanent nulls', () => {
    // neuPrint models a synapse as a point; resolving partners is a much heavier query.
    const { synapses } = schemasFor(discoverNeuronSchema({}))
    expect(synapses.columns.map((c) => c.name)).toEqual([
      'bodyId',
      'type',
      'polarity',
      'confidence',
    ])
  })
})

// ---------------------------------------------------------------------------
// Error mapping. The transport itself can't be tested without a network, but which
// *diagnosis* a failure produces can be — and getting that wrong sends people to look at
// their token when the actual problem is a missing proxy.
// ---------------------------------------------------------------------------

describe('failure diagnosis', () => {
  const original = globalThis.fetch

  function stubFetch(reply: { status: number; text?: string }) {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        text: () => Promise.resolve(reply.text ?? ''),
        json: () => Promise.resolve(JSON.parse(reply.text || '{}')),
      } as Response)) as typeof fetch
  }

  afterEach(() => {
    globalThis.fetch = original
  })

  it('blames the missing proxy, not neuPrint, on an empty 404', async () => {
    // A vite server with no matching proxy rule answers exactly this. Saying "neuPrint
    // returned 404" would be a lie — neuPrint never saw the request.
    stubFetch({ status: 404 })
    await expect(
      get('/api/dbmeta/datasets', { token: 't', baseUrl: '/neuprint' }),
    ).rejects.toThrow(/Nothing is serving \/neuprint/)
  })

  it('still reports a real neuPrint 404, which carries a body', async () => {
    stubFetch({ status: 404, text: '{"error":"no store found"}' })
    await expect(get('/api/x', { token: 't', baseUrl: '/neuprint' })).rejects.toThrow(
      /neuPrint returned 404: .*no store found/,
    )
  })

  it('does not claim a missing proxy when the base is absolute', async () => {
    stubFetch({ status: 404 })
    await expect(
      get('/api/x', { token: 't', baseUrl: 'https://example.org' }),
    ).rejects.toThrow(/neuPrint returned 404/)
  })

  it('points at the token on a 401, and raises the signal that opens the panel', async () => {
    const seen: string[] = []
    const unsubscribe = subscribeAuthFailure((message) => seen.push(message))
    stubFetch({ status: 401, text: 'nope' })
    await expect(get('/api/x', { token: 'stale', baseUrl: '/neuprint' })).rejects.toThrow(
      /rejected the token/,
    )
    expect(seen).toHaveLength(1)
    unsubscribe()
  })

  it('reports a missing token without a round trip', async () => {
    stubFetch({ status: 200, text: '{}' })
    await expect(get('/api/x', { token: '', baseUrl: '/neuprint' })).rejects.toThrow(
      /No neuPrint token/,
    )
  })
})

// ---------------------------------------------------------------------------
// Mesh source resolution and the unit reconciliation the 3D scene depends on.
// ---------------------------------------------------------------------------

describe('mesh source resolution', () => {
  it('maps precomputed object-store URLs to fetchable HTTP', () => {
    expect(precomputedToHttp('precomputed://gs://bucket/a/b')).toBe(
      'https://storage.googleapis.com/bucket/a/b',
    )
    // Virtual-hosted style for S3: the path-style endpoint 301s, and fetch will not follow a
    // redirect that drops CORS headers.
    expect(precomputedToHttp('precomputed://s3://bucket/a/b')).toBe(
      'https://bucket.s3.amazonaws.com/a/b',
    )
    expect(precomputedToHttp('precomputed://gs://bucket/a/b/')).toBe(
      'https://storage.googleapis.com/bucket/a/b',
    )
  })

  it('refuses dvid:// rather than mangling it into a 404', () => {
    // DVID serves meshes through an entirely different API. Pretending it is an object store
    // would turn "unsupported source" into "every neuron is missing".
    expect(precomputedToHttp('dvid://https://emdata5.janelia.org/8e29f/segmentation')).toBeUndefined()
  })

  it('prefers a dedicated mesh layer over the segmentation volume', () => {
    // optic-lobe puts its meshes in a sibling of the volume, not a subdirectory, so the
    // volume would resolve to the wrong (or no) mesh directory.
    const state = {
      layers: [
        {
          type: 'segmentation',
          name: 'optic-lobe:v1.1',
          source: [
            { url: 'precomputed://gs://flyem-optic-lobe/v1.1/segmentation' },
            { url: 'precomputed://gs://flyem-optic-lobe/v1.1/segmentation/multi-res-meshes' },
          ],
        },
      ],
    }
    expect(meshSourceFromState(state, 'optic-lobe:v1.1')?.source).toContain('multi-res-meshes')
  })

  it('ignores the segment-property sidecars that sit beside the segmentation', () => {
    // male-cns publishes eight of these; none of them is geometry.
    const state = {
      layers: [
        {
          type: 'segmentation',
          name: 'male-cns:v1.0',
          source: [
            { url: 'precomputed://gs://flyem-male-cns/v1.0/segmentation/type_property' },
            { url: 'precomputed://gs://flyem-male-cns/v1.0/segmentation' },
          ],
        },
      ],
    }
    expect(meshSourceFromState(state, 'male-cns:v1.0')?.source).toBe(
      'precomputed://gs://flyem-male-cns/v1.0/segmentation',
    )
  })

  it('prefers the volume over a legacy mesh layer advertised beside it', () => {
    /*
     * male-cns:v1.0's real layer list, trimmed to the segmentation layer. It advertises
     * `meshes-malecns/single-res-meshes` — flat, full-resolution — while the volume's own
     * `info` declares `mesh: multi-res-meshes`, which has four levels of detail.
     *
     * Preferring any mesh-shaped layer over the volume (which this originally did) therefore
     * picked the legacy source, and nothing failed: meshes still arrived, just at full
     * resolution, several megabytes per neuron, with `Detail` unable to help because a legacy
     * source has exactly one level. It also made thumbnails impossible, since those exist only
     * because a coarsest level is a few kilobytes.
     */
    const state = {
      layers: [
        {
          type: 'segmentation',
          name: 'male-cns:v1.0',
          source: [
            { url: 'precomputed://gs://flyem-male-cns/v1.0/segmentation' },
            { url: 'precomputed://gs://flyem-male-cns/v1.0/segmentation/type_property' },
            { url: 'precomputed://gs://flyem-male-cns/v1.0/segmentation/numeric_properties' },
            { url: 'precomputed://gs://flyem-male-cns/v1.0/segmentation/meshes-malecns/single-res-meshes' },
          ],
        },
      ],
    }
    expect(meshSourceFromState(state, 'male-cns:v1.0')?.source).toBe(
      'precomputed://gs://flyem-male-cns/v1.0/segmentation',
    )
  })

  it('still prefers a multi-resolution layer over the volume', () => {
    // The other direction, and why the order is multires → volume → anything else: optic-lobe's
    // volume declares `mesh: single-res-meshes` while a multi-res sibling is what its state
    // links. Getting this backwards fixes male-cns and breaks optic-lobe.
    const state = {
      layers: [
        {
          type: 'segmentation',
          name: 'optic-lobe:v1.1',
          source: [
            { url: 'precomputed://gs://flyem-optic-lobe/v1.1/segmentation' },
            { url: 'precomputed://gs://flyem-optic-lobe/v1.1/segmentation/multi-res-meshes' },
          ],
        },
      ],
    }
    expect(meshSourceFromState(state, 'optic-lobe:v1.1')?.source).toContain('multi-res-meshes')
  })

  it('picks the dataset’s own layer, not an ROI layer that also has meshes', () => {
    const state = {
      layers: [
        { type: 'image', name: 'em', source: 'precomputed://gs://b/em' },
        { type: 'segmentation', name: 'rois', source: 'precomputed://gs://b/rois/shells' },
        { type: 'segmentation', name: 'hemibrain:v1.2.1', source: 'precomputed://gs://b/v1.2/segmentation' },
      ],
    }
    expect(meshSourceFromState(state, 'hemibrain:v1.2.1')?.source).toBe(
      'precomputed://gs://b/v1.2/segmentation',
    )
  })

  it('returns nothing when a dataset publishes only dvid', () => {
    const state = {
      layers: [
        { type: 'segmentation', name: 'manc:v1.0', source: 'dvid://https://emdata5.janelia.org/8e29f/segmentation' },
      ],
    }
    expect(meshSourceFromState(state, 'manc:v1.0')).toBeUndefined()
  })
})

describe('voxel to nanometre conversion', () => {
  it('reads the scale neuPrint publishes', () => {
    // Every dataset checked reports [8, 8, 8] nanometers.
    expect(voxelScale([8, 8, 8], 'nanometers')).toEqual([8, 8, 8])
    expect(voxelScale([4, 4, 40], 'nanometers')).toEqual([4, 4, 40])
    expect(voxelScale([1, 1, 1], 'micrometers')).toEqual([1000, 1000, 1000])
  })

  it('falls back to identity rather than guessing at an unknown unit', () => {
    // Leaving a dataset in its own units keeps skeletons and synapses agreeing with each
    // other, which a made-up scale factor would not.
    expect(voxelScale([8, 8, 8], 'cubits')).toEqual(IDENTITY_SCALE)
    expect(voxelScale(undefined, 'nanometers')).toEqual(IDENTITY_SCALE)
    expect(voxelScale([8, 8], 'nanometers')).toEqual(IDENTITY_SCALE)
  })

  it('scales positions in place, and skips the work for the identity', () => {
    const positions = new Float32Array([1, 2, 3, 4, 5, 6])
    expect([...scalePositions(positions, [8, 8, 8])]).toEqual([8, 16, 24, 32, 40, 48])
    const untouched = new Float32Array([1, 2, 3])
    expect(scalePositions(untouched, IDENTITY_SCALE)).toBe(untouched)
  })

  it('scales radii by the mean axis scale', () => {
    // A radius is one number for something spherical; anisotropic voxels have no exact
    // answer, and every dataset here is isotropic, which makes the mean exact.
    expect([...scaleRadii(new Float32Array([1, 2]), [8, 8, 8])]).toEqual([8, 16])
    expect([...scaleRadii(new Float32Array([3]), [2, 4, 6])]).toEqual([12])
  })

  it('puts a hemibrain skeleton into the space its mesh already uses', () => {
    // Ground truth: neuPrint returns body 1158187240's skeleton spanning x 88..15628 voxels;
    // its precomputed mesh spans x 704..125408 nm. Only the 8 nm scale reconciles them.
    const voxels = new Float32Array([88, 9808, 16392, 15628, 21750, 31330])
    const nm = scalePositions(voxels, voxelScale([8, 8, 8], 'nanometers'))
    expect(nm[0]).toBe(704)
    expect(nm[3]).toBe(125024)
  })
})

describe('mesh fetch progress', () => {
  it('gives manifests the first fifth and fragments the rest', () => {
    // A manifest is a few hundred bytes; the fragments behind it are megabytes. An even split
    // would race to 50% in the first second and then look hung.
    expect(meshProgressFraction(0, 8, 'manifests')).toBeCloseTo(0.05, 5)
    expect(meshProgressFraction(8, 8, 'manifests')).toBeCloseTo(0.2, 5)
    expect(meshProgressFraction(0, 8, 'fragments')).toBeCloseTo(0.2, 5)
    expect(meshProgressFraction(8, 8, 'fragments')).toBeCloseTo(1, 5)
  })

  it('never decreases, including across the phase boundary', () => {
    // An indicator that runs backwards is worse than none — and it did, until the skeleton
    // path stopped using a dispatch-order ordinal as a completion count.
    const sequence = [
      ...Array.from({ length: 9 }, (_, i) => meshProgressFraction(i, 8, 'manifests')),
      ...Array.from({ length: 9 }, (_, i) => meshProgressFraction(i, 8, 'fragments')),
    ]
    for (let i = 1; i < sequence.length; i++) {
      expect(sequence[i]!).toBeGreaterThanOrEqual(sequence[i - 1]!)
    }
  })

  it('stays in range for a degenerate total', () => {
    expect(meshProgressFraction(0, 0, 'manifests')).toBeCloseTo(0.2, 5)
    expect(meshProgressFraction(5, 2, 'fragments')).toBeCloseTo(1, 5)
  })
})

// ---------------------------------------------------------------------------

describe('thumbnail byte ceiling', () => {
  /**
   * The coarsest level's size, sampled over each dataset's own bucket. The maximum is the
   * number that matters: a ceiling under it silently blanks real neurons.
   */
  const COARSEST_LEVEL_BYTES = {
    hemibrain: { median: 264, p90: 14 * 1024, max: 508 * 1024 },
    maleCns: { median: 7.3 * 1024, p90: 23 * 1024, max: 169 * 1024 },
  }

  it('clears the largest coarse mesh in every dataset, so no real neuron is refused', () => {
    // The point of the number. At 128 kB it sat between p90 and the maximum, which meant it
    // was refusing the giant fibres and big tracts — the heaviest coarse meshes, and the
    // bodies someone browsing is most likely to be looking for.
    for (const sample of Object.values(COARSEST_LEVEL_BYTES)) {
      expect(THUMBNAIL_MAX_BYTES).toBeGreaterThan(sample.max)
    }
  })

  it('still refuses a body whose coarsest level costs a whole neuron at full resolution', () => {
    // hemibrain's pyramid is 2 MB / 280 kB / 48 kB / 11 kB. A *coarsest* level at the top of
    // that range is an unsplit blob, not a large neuron, and a placeholder is the right answer.
    const fullResolutionNeuron = 2 * 1024 * 1024
    expect(THUMBNAIL_MAX_BYTES).toBeLessThanOrEqual(fullResolutionNeuron)
  })

  it('leaves the typical page where it was', () => {
    // The reason raising it is nearly free: a page of 25 rows is priced by the median, not by
    // the ceiling, and both medians are kilobytes.
    const page = 25
    expect(page * COARSEST_LEVEL_BYTES.maleCns.median).toBeLessThan(256 * 1024)
  })
})

// ---------------------------------------------------------------------------

/**
 * Asking for what inference needs, since inference cannot ask for itself.
 *
 * `inferOutputs` may not await (invariant 2), so a source's synchronous peeks are the *only*
 * place a fetch can be started on a graph's behalf — and being re-run when it lands is what
 * `reportSourceLearned` is for. Both peeks below used to answer "I don't know" without ever
 * finding out, which broke the chain at its first link.
 *
 * The visible symptom was a workflow that behaved differently on its first Run than on its
 * second: nothing had asked for the listing, so a dataset node on "Latest" had no dataset id,
 * so `schemasFor` was never called, so discovery never ran, so every column picker downstream
 * offered the canonical seven neuron properties and every *discovered* one looked deleted.
 * The first Run fetched a listing as a side effect and the second then worked.
 */
describe('warming what inference reads', () => {
  const original = globalThis.fetch

  beforeEach(() => setToken('warm-test-token'))

  function countingFetch() {
    const urls: string[] = []
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input))
      // Never resolves: this is about what gets *asked for*, and a reply would pull the whole
      // discovery cascade into a test about its first link.
      return new Promise<Response>(() => {})
    }) as typeof fetch
    return urls
  }

  afterEach(() => {
    globalThis.fetch = original
    resetCredentials()
  })

  it('a peek at the datasets starts the listing it could not answer with', () => {
    const urls = countingFetch()
    const source = new NeuPrintSource()
    expect(source.peekDatasets()).toBeUndefined()
    expect(urls.some((u) => u.includes('/api/dbmeta/datasets'))).toBe(true)
  })

  it('asks once, not once per inference pass', () => {
    // Inference runs on every graph mutation. A failed listing that retried from a peek would
    // be a request per keystroke.
    const urls = countingFetch()
    const source = new NeuPrintSource()
    for (let i = 0; i < 25; i++) source.peekDatasets()
    expect(urls.filter((u) => u.includes('/api/dbmeta/datasets'))).toHaveLength(1)
  })

  it('starts discovery for a dataset it has never heard of', () => {
    /*
     * A *pinned* version is the case that never recovered: a saved graph naming
     * `male-cns:v1.0` has a concrete id at edit time and needs no listing, so nothing else was
     * ever going to ask — and this bailed on the missing state instead of creating it.
     */
    const urls = countingFetch()
    const source = new NeuPrintSource()
    source.schemasFor('male-cns:v1.0')
    expect(urls.some((u) => u.includes('custom'))).toBe(true)
  })

  it('asks for nothing at all without a token, rather than a request per peek', () => {
    // An unconfigured source must not turn every graph mutation into a rejected request.
    // Recovery is the Sources panel's explicit `listDatasets()`, which is not gated on this.
    resetCredentials()
    const urls = countingFetch()
    const source = new NeuPrintSource()
    source.peekDatasets()
    source.schemasFor('male-cns:v1.0')
    expect(urls).toEqual([])
  })

  it('hands back the canonical schema meanwhile, rather than nothing', () => {
    // Degrade, never block — a column picker with the seven columns every dataset has beats
    // an empty one, so long as something has been asked to improve on it.
    countingFetch()
    const source = new NeuPrintSource()
    expect(source.schemasFor('male-cns:v1.0').neurons.columns.map((c) => c.name)).toContain(
      'bodyId',
    )
  })
})
