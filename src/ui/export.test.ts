// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest'

import { column, tableSchema } from '../core/types'
import { makeMatrix, tableFromRows } from '../core/values'
import { installJsdomStubs } from '../test/jsdomStubs'
import { exportBaseName, matrixToCsv, serializeSvg, tableToCsv, tableToCsvParts } from './export'

beforeAll(() => installJsdomStubs())

const SCHEMA = tableSchema(
  column('bodyId', 'i64'),
  column('type', 'str'),
  column('weight', 'i64', 'synapses'),
)

describe('tableToCsv', () => {
  it('writes a header row from the schema and one row per record', () => {
    const table = tableFromRows(SCHEMA, [
      { bodyId: 1, type: 'LC4', weight: 34 },
      { bodyId: 2, type: 'LC6', weight: 12 },
    ])
    expect(tableToCsv(table)).toBe('bodyId,type,weight\n1,LC4,34\n2,LC6,12\n')
  })

  it('quotes values containing a comma, quote or newline', () => {
    const table = tableFromRows(SCHEMA, [
      { bodyId: 1, type: 'a,b', weight: 1 },
      { bodyId: 2, type: 'say "hi"', weight: 2 },
      { bodyId: 3, type: 'line\nbreak', weight: 3 },
    ])
    const lines = tableToCsv(table).split('\n')
    expect(lines[1]).toBe('1,"a,b",1')
    expect(lines[2]).toBe('2,"say ""hi""",2')
    // The embedded newline stays inside the quoted field.
    expect(tableToCsv(table)).toContain('"line\nbreak"')
  })

  it('writes nulls as empty fields, not the text "null"', () => {
    const table = tableFromRows(SCHEMA, [{ bodyId: 1, type: null, weight: null }])
    expect(tableToCsv(table)).toBe('bodyId,type,weight\n1,,\n')
  })

  it('handles an empty table', () => {
    expect(tableToCsv(tableFromRows(SCHEMA, []))).toBe('bodyId,type,weight\n')
  })

  it('chunks large tables instead of building one giant string', () => {
    const table = tableFromRows(
      SCHEMA,
      Array.from({ length: 5000 }, (_, i) => ({ bodyId: i, type: 't', weight: i })),
    )
    const parts = tableToCsvParts(table)
    // Header plus ceil(5000 / 2000) chunks.
    expect(parts.length).toBe(4)
    expect(parts.join('').split('\n')).toHaveLength(5002) // 5000 rows + header + trailing
  })
})

describe('matrixToCsv', () => {
  it('writes wide form with a corner cell and labelled rows', () => {
    const matrix = makeMatrix(
      ['LC4', 'LC6'],
      ['DNp02', 'DNp11'],
      Float64Array.from([40, 12, 0, 9]),
      'synapses',
    )
    expect(matrixToCsv(matrix)).toBe(',DNp02,DNp11\nLC4,40,12\nLC6,0,9\n')
  })

  it('keeps full precision and no display formatting', () => {
    const csv = matrixToCsv(
      makeMatrix(['a'], ['x', 'y'], Float64Array.from([0.3333333333333333, 1234567])),
    )
    expect(csv).toBe(',x,y\na,0.3333333333333333,1234567\n')
    // A thousands separator here would split the field and corrupt the file.
    expect(csv).not.toContain('1,234,567')
  })

  it('quotes labels that contain commas', () => {
    const matrix = makeMatrix(['a,b'], ['x'], Float64Array.from([1]))
    expect(matrixToCsv(matrix)).toContain('"a,b",1')
  })
})

describe('exportBaseName', () => {
  it('slugifies the graph and node names', () => {
    expect(exportBaseName('LC outputs by partner type', 'Table')).toBe(
      'lc-outputs-by-partner-type_table',
    )
  })

  it('drops the graph part when there is no name', () => {
    expect(exportBaseName(undefined, 'Heatmap')).toBe('heatmap')
    expect(exportBaseName('', 'Heatmap')).toBe('heatmap')
  })

  it('collapses punctuation and trims separators', () => {
    expect(exportBaseName('LC → DN matrix!', 'Bar Chart')).toBe('lc-dn-matrix_bar-chart')
  })

  it('falls back when the node name has no usable characters', () => {
    expect(exportBaseName('graph', '···')).toBe('graph_output')
  })
})

describe('serializeSvg', () => {
  function makeSvg(): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '400')
    svg.setAttribute('height', '200')
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    rect.setAttribute('fill', '#3987e5')
    svg.append(rect)
    document.body.append(svg)
    return svg
  }

  it('produces a standalone document with namespace and explicit size', () => {
    const output = serializeSvg(makeSvg())
    expect(output).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(output).toContain('width="400"')
    expect(output).toContain('height="200"')
    expect(output).toContain('viewBox="0 0 400 200"')
  })

  it('inlines a font-family so text survives without the app stylesheet', () => {
    const output = serializeSvg(makeSvg())
    expect(output).toMatch(/<style>text\{font-family:.+\}<\/style>/)
  })

  it('keeps literal fill colours, which is what makes vector export free here', () => {
    expect(serializeSvg(makeSvg())).toContain('#3987e5')
  })

  it('does not mutate the on-screen element', () => {
    const svg = makeSvg()
    serializeSvg(svg)
    expect(svg.querySelector('style')).toBeNull()
    expect(svg.getAttribute('xmlns')).toBeNull()
  })
})
