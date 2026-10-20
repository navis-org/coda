/**
 * The VFB pack's two nodes, against a stubbed PDB, and their tables' two halves against each other.
 *
 * The stub answers by statement — cross-references, class labels and names, parents, references —
 * so the assertions can be about what the nodes *asked* as well as what they returned: the ids go
 * as parameters and as text, and a type is never read off a general class.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ColumnParam } from '../../core/node'
import { defaultParams, resolveColumn } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, columnNames, tableSchema } from '../../core/types'
import type { DatasetValue, PointsValue, TableValue, Value } from '../../core/values'
import { getColumn, isTableValue, tableFromRows } from '../../core/values'
import '../../nodes'
import { pdbAnswer } from '../../test/vfbStubs'
import {
  FBBT_ID_COLUMN,
  EXPRESSION_SCHEMA,
  IMAGES_SCHEMA,
  LINES_SCHEMA,
  PUBLICATIONS_SCHEMA,
  expressionPoints,
  imagesTable,
  linesTable,
  publicationsTable,
  vfbNeuronsSchema,
  vfbNeuronsTable,
} from './ops'

afterEach(() => vi.unstubAllGlobals())

const NEURONS = tableSchema(column('neuronId', 'str'), column('type', 'str'))

const MALE_CNS: DatasetValue = {
  kind: 'dataset',
  sourceId: 'neuprint',
  datasetId: 'male-cns:v1.0',
  label: 'MaleCNS',
}

/** A PDB that knows one MBON01 and one PFNa neuron, and the papers on MBON01. */
function stubPdb() {
  const statements: { statement: string; parameters: Record<string, unknown> }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      // A file download: a two-point cloud, the second point dim.
      if (url.endsWith('.obj')) {
        return new Response(`# VFB\nv 1 2 3 0.9\nv 4 5 6 0.2\n`)
      }
      const sent = JSON.parse(String(init.body)) as {
        statements: (typeof statements)[number][]
      }
      const { statement, parameters } = sent.statements[0]!
      statements.push({ statement, parameters })
      if (statement.includes('in_register_with')) {
        const obj =
          'http://www.virtualflybrain.org/data/VFB/i/0010/2chl/VFB_00101567/volume.obj'
        return pdbAnswer(
          [
            'lineId',
            'imageId',
            'label',
            'rel',
            'template',
            'obj',
            'thumbnail',
            'nrrd',
            'dataset',
            'license',
          ],
          [
            [
              'exp_split',
              'img_frag',
              'frag 63x',
              'part_of',
              'VFB_00101567',
              null,
              null,
              null,
              'Aso2014',
              'CC-BY_4.0',
            ],
            [
              'exp_split',
              'img_line',
              'whole 20x',
              'INSTANCEOF',
              'VFB_00101567',
              [obj],
              null,
              null,
              'Aso2014',
              'CC-BY_4.0',
            ],
          ],
        )
      }
      if (statement.includes(':Expression_pattern')) {
        return pdbAnswer(
          [
            'classId',
            'classLabel',
            'lineId',
            'symbol',
            'construct',
            'split',
            'targets',
            'images',
          ],
          [
            [
              'mbon01',
              'MBON01',
              'exp_gal4',
              ['R15B01'],
              'P{GMR15B01-GAL4} expression pattern',
              false,
              4,
              2,
            ],
            [
              'mbon01',
              'MBON01',
              'exp_split',
              ['MB074C'],
              'P{a} ∩ P{b} expression pattern',
              true,
              3,
              21,
            ],
            [
              'mbon01',
              'MBON01',
              'exp_lexa',
              ['R15B01L'],
              'P{GMR15B01-lexA} expression pattern',
              false,
              1,
              1,
            ],
          ],
        )
      }
      if (statement.includes('database_cross_reference')) {
        return pdbAnswer(
          ['accession', 'vfbId', 'label', 'classes'],
          [
            [['10013'], 'VFB_jrmc2094', 'MBON01', ['mbon01', 'cholinergic']],
            [['20000'], 'VFB_jrmc0001', 'PFNa', ['pfna-g5']],
            [['30000'], 'VFB_jrmc0002', 'nameless', ['cholinergic']],
          ],
        )
      }
      if (statement.includes('SUBCLASSOF')) {
        const parents: Record<string, string[]> = {
          mbon01: ['neuron'],
          cholinergic: ['neuron'],
          'pfna-g5': ['pfna'],
          pfna: ['neuron'],
        }
        const ids = parameters.ids as string[]
        return pdbAnswer(
          ['child', 'parents'],
          ids.filter((id) => parents[id]).map((id) => [id, parents[id]]),
        )
      }
      if (statement.includes('has_reference') && statement.includes('$prefix')) {
        const named: Record<string, string> = { mbon01: 'MBON01', pfna: 'PFNa' }
        const prefix = parameters.prefix as string
        return pdbAnswer(
          ['id', 'label', 'names'],
          (parameters.ids as string[]).map((id) => [
            id,
            `label of ${id}`,
            named[id] ? [[[named[id]], [`${prefix}hemibrain`]]] : [[null, null]],
          ]),
        )
      }
      if (statement.includes(':pub')) {
        return pdbAnswer(
          [
            'classId',
            'classLabel',
            'pubId',
            'roles',
            'citation',
            'title',
            'doi',
            'pmid',
            'year',
          ],
          [
            [
              'mbon01',
              'MBON01 label',
              'FBrf1',
              ['syn', 'def'],
              ['Aso et al., 2014'],
              ['MB'],
              ['10.7554/eLife.04577'],
              ['25535793'],
              ['2014'],
            ],
            [
              'mbon01',
              'MBON01 label',
              'doi_x',
              ['syn'],
              ['[Berg et al., 2025]'],
              null,
              ['10.1101/x'],
              null,
              null,
            ],
          ],
        )
      }
      throw new Error(`unexpected statement: ${statement}`)
    }),
  )
  return statements
}

async function run(type: string, inputs: Record<string, Value | undefined>, params = {}) {
  const def = requireNodeDef(type)
  const warnings: string[] = []
  const merged = { ...defaultParams(def), ...params } as Record<string, unknown>
  const out = await def.evaluate!({
    params: merged,
    input: (id: string) => inputs[id],
    inputs,
    column: (id: string) => {
      const name = merged[id] as string
      const table = Object.values(inputs).find(isTableValue)
      return table?.schema.columns.some((c) => c.name === name) ? name : undefined
    },
    columns: () => [],
    progress: () => {},
    warn: (message: string) => warnings.push(message),
    signal: undefined,
  } as never)
  return { out: (out as Record<string, Value>).out as TableValue, warnings }
}

describe('VFB Neurons', () => {
  const def = requireNodeDef('vfb:neurons')
  const validate = (datasetId: string) =>
    def.validate!({
      params: defaultParams(def),
      inputs: { dataset: T.dataset('neuprint', datasetId), neurons: T.neurons(NEURONS) },
    } as never)

  it('refuses a release VFB does not hold before anything runs, and accepts one it does', () => {
    expect(validate('male-cns:v0.8')).toEqual([
      expect.stringMatching(/male CNS v0\.9 and male CNS v1\.0/),
    ])
    expect(validate('male-cns:v1.0')).toEqual([])
  })

  it('types each neuron, keeps every row, and counts what VFB lacks', async () => {
    const statements = stubPdb()
    const table = tableFromRows(
      NEURONS,
      ['10013', '20000', '30000', '40000'].map((neuronId) => ({ neuronId, type: 'x' })),
      'neurons',
    )
    const { out, warnings } = await run('vfb:neurons', { dataset: MALE_CNS, neurons: table })

    expect(out.kind).toBe('neurons')
    expect(out.length).toBe(4)
    expect([...getColumn(out, 'vfbId')]).toEqual([
      'VFB_jrmc2094',
      'VFB_jrmc0001',
      'VFB_jrmc0002',
      null,
    ])
    // MBON01 over the transmitter class beside it; PFNa one step above its glomerulus class; the
    // neuron with only a general class gets no type rather than that class.
    expect([...getColumn(out, FBBT_ID_COLUMN)]).toEqual(['mbon01', 'pfna', null, null])
    expect([...getColumn(out, 'fbbtClimbed')]).toEqual([0, 1, null, null])
    expect(warnings).toEqual([
      expect.stringMatching(/^1 neuron is not in Virtual Fly Brain's male CNS v1\.0/),
      expect.stringMatching(/^1 neuron has no cell type VFB names/),
    ])
    // The ids went as a parameter, as text, to the release's own site.
    expect(statements[0]!.parameters).toEqual({
      site: 'male_cns_v1_0',
      ids: ['10013', '20000', '30000', '40000'],
    })
  })
})

describe('VFB Publications', () => {
  it('lists each type’s papers once, defining papers first, with a DOI link and the roles', async () => {
    const statements = stubPdb()
    const types = tableFromRows(tableSchema(column(FBBT_ID_COLUMN, 'str')), [
      { [FBBT_ID_COLUMN]: 'mbon01' },
      { [FBBT_ID_COLUMN]: 'mbon01' },
      { [FBBT_ID_COLUMN]: 'pfna' },
      { [FBBT_ID_COLUMN]: null },
    ])
    const { out, warnings } = await run('vfb:publications', { types })

    expect(columnNames(out.schema)).toEqual(columnNames(PUBLICATIONS_SCHEMA))
    expect([...getColumn(out, 'reference')]).toEqual(['FBrf1', 'doi_x'])
    expect([...getColumn(out, 'roles')]).toEqual(['def, syn', 'syn'])
    expect([...getColumn(out, 'citation')]).toEqual(['Aso et al., 2014', 'Berg et al., 2025'])
    // Bare identifiers in the data; the column's `link` is what draws them as links.
    expect([...getColumn(out, 'doi')]).toEqual(['10.7554/eLife.04577', '10.1101/x'])
    expect(out.schema.columns.find((c) => c.name === 'doi')?.link).toBe('doi')
    expect([...getColumn(out, 'neurons')]).toEqual([2, 2])
    expect(warnings).toEqual(['1 type has no papers cited in the chosen roles (of 2 types).'])
    expect(statements[0]!.parameters).toMatchObject({
      ids: ['mbon01', 'pfna'],
      roles: ['def', 'syn'],
    })
  })
})

describe('VFB Driver Lines, Expression Images and Load Expression', () => {
  const types = () =>
    tableFromRows(tableSchema(column(FBBT_ID_COLUMN, 'str')), [{ [FBBT_ID_COLUMN]: 'mbon01' }])

  it('lists split lines first, then the most specific, and filters by targets', async () => {
    stubPdb()
    const all = await run('vfb:lines', { types: types() })
    expect([...getColumn(all.out, 'line')]).toEqual(['MB074C', 'R15B01', 'R15B01L'])
    expect([...getColumn(all.out, 'driver')]).toEqual(['split', 'GAL4', 'LexA'])
    const specific = await run('vfb:lines', { types: types() }, { maxTargets: 3 })
    expect([...getColumn(specific.out, 'line')]).toEqual(['MB074C', 'R15B01L'])
  })

  it('lists images with https file URLs, whole-line images first, and counts those without a cloud', async () => {
    const statements = stubPdb()
    const lines = (await run('vfb:lines', { types: types() })).out
    const { out, warnings } = await run('vfb:images', { lines }, { fragments: true })
    expect([...getColumn(out, 'imageId')]).toEqual(['img_line', 'img_frag'])
    expect([...getColumn(out, 'line')]).toEqual(['MB074C', 'MB074C'])
    expect(getColumn(out, 'obj')[0]).toMatch(/^https:\/\/www\.virtualflybrain\.org\//)
    expect(warnings).toContain(
      '1 image has no point cloud, only an image stack, and cannot be drawn by VFB Load Expression yet.',
    )
    expect(statements.at(-1)!.parameters).toMatchObject({
      templates: ['VFB_00101567', 'VFB_00200000'],
      fragments: true,
    })
  })

  it('loads the clouds as nm points in JRC2018U, carrying image, line and intensity', async () => {
    stubPdb()
    const lines = (await run('vfb:lines', { types: types() })).out
    const images = (await run('vfb:images', { lines })).out
    const result = await run('vfb:expression', { images }, { minIntensity: 0.5 })
    const out = result.out as unknown as PointsValue
    expect(out).toMatchObject({ kind: 'points', units: 'nm', space: 'JRC2018U' })
    expect([...out.positions]).toEqual([1000, 2000, 3000])
    expect([...getColumn(out.attributes, 'imageId')]).toEqual(['img_line'])
    expect([...getColumn(out.attributes, 'line')]).toEqual(['MB074C'])
  })
})

describe('VFB Load Expression across templates', () => {
  it('draws the images Coda can place and counts the nerve-cord ones out', async () => {
    stubPdb()
    const url = (t: string) => `https://www.virtualflybrain.org/data/VFB/i/x/${t}/volume.obj`
    const images = tableFromRows(
      tableSchema(column('imageId', 'str'), column('template', 'str'), column('obj', 'str')),
      [
        { imageId: 'brain', template: 'VFB_00101567', obj: url('VFB_00101567') },
        { imageId: 'vnc', template: 'VFB_00200000', obj: url('VFB_00200000') },
      ],
    )
    const { out, warnings } = await run('vfb:expression', { images })
    const points = out as unknown as PointsValue
    expect(points.space).toBe('JRC2018U')
    expect([...getColumn(points.attributes, 'imageId')]).toEqual(['brain', 'brain'])
    expect(warnings[0]).toMatch(
      /^1 image is left out: registered to a template Coda has no frame for/,
    )
  })
})

describe('tables', () => {
  it('VFB Neurons: the value half has exactly the schema the schema half promises', () => {
    // An existing fbbtId column is written over in its slot, never duplicated.
    const schema = tableSchema(
      column('neuronId', 'str'),
      column(FBBT_ID_COLUMN, 'str'),
      column('x', 'i64'),
    )
    const table = tableFromRows(schema, [{ neuronId: '1', [FBBT_ID_COLUMN]: 'old', x: 1 }])
    const out = vfbNeuronsTable(table, ['1'], new Map([['1', { vfbId: 'v', fbbtId: 'new' }]]))
    expect(out.schema).toEqual(vfbNeuronsSchema(schema))
    expect(columnNames(out.schema)).toEqual([
      'neuronId',
      FBBT_ID_COLUMN,
      'x',
      'vfbId',
      'fbbtLabel',
      'fbbtClimbed',
    ])
    expect(getColumn(out, FBBT_ID_COLUMN)[0]).toBe('new')
    expect(getColumn(out, 'fbbtLabel')[0]).toBeNull()
  })

  it('Publications, Lines, Images and Expression: an empty answer still has the declared schema', () => {
    expect(publicationsTable([], []).schema).toEqual(PUBLICATIONS_SCHEMA)
    expect(linesTable([], []).schema).toEqual(LINES_SCHEMA)
    expect(imagesTable([], [], new Map()).schema).toEqual(IMAGES_SCHEMA)
    expect(expressionPoints([]).attributes.schema).toEqual(EXPRESSION_SCHEMA)
  })
})

describe('VFB Line Gallery', () => {
  it('emits the pinned images’ rows, in the input’s order, with the input’s columns', async () => {
    const images = tableFromRows(tableSchema(column('imageId', 'str'), column('obj', 'str')), [
      { imageId: 'a', obj: 'x' },
      { imageId: 'b', obj: 'y' },
      { imageId: 'c', obj: 'z' },
    ])
    const def = requireNodeDef('vfb:gallery')
    const result = (await def.evaluate!({
      params: { ...defaultParams(def), pins: ['c', 'a'] },
      input: () => images,
      inputs: { images },
    } as never)) as { out: TableValue; pinned: TableValue }
    expect(result.out).toBe(images)
    expect([...getColumn(result.pinned, 'imageId')]).toEqual(['a', 'c'])
    expect(result.pinned.schema).toEqual(images.schema)
  })
})

describe('VFB Info', () => {
  it('passes its input through and fetches nothing: the card asks VFB for the page on screen', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const terms = tableFromRows(IMAGES_SCHEMA, [{ imageId: 'VFB_a' }])
    const def = requireNodeDef('vfb:info')
    const result = (await def.evaluate!({
      params: defaultParams(def),
      input: () => terms,
      inputs: { terms },
      column: () => 'fbbtId',
      warn: () => {},
    } as never)) as { out: TableValue }
    expect(result.out).toBe(terms)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('VFB Neurons’ id picker', () => {
  it('stays unset on a table without its column, rather than looking up another one', () => {
    const def = requireNodeDef('vfb:neurons')
    const param = def.params!.find((p) => p.id === 'idColumn') as ColumnParam
    const neurons = T.table(
      tableSchema(column('instance', 'str'), column('bodyId', 'i64'), column('weight', 'i64')),
    )
    expect(resolveColumn(param, defaultParams(def), { neurons })).toBeUndefined()
  })
})
