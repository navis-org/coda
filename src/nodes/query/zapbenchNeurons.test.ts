/**
 * The ZapBench to Neurons node, against a fake source that records what it was asked.
 *
 * The assertions are about the request as much as the answer: an integer lookup spelled as text
 * returns no neurons with no error, and a population filter on it reports every narrowed body as a
 * cell nobody matched — both plausible, both wrong.
 */

import { describe, expect, it, vi } from 'vitest'

import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { column, tableSchema } from '../../core/types'
import type { DatasetValue, TableValue, Value } from '../../core/values'
import { getColumn, isTableValue, tableFromRows } from '../../core/values'
import type { FindNeuronsRequest } from '../../data/source'
import '../index'

const def = requireNodeDef('zapbench.neurons')

const NEURONS = tableSchema(
  column('neuronId', 'str'),
  column('type', 'str'),
  column('zapbenchId', 'i64'),
)

const DATASET: DatasetValue = {
  kind: 'dataset',
  sourceId: 'fake',
  datasetId: 'fish2',
  label: 'fish2',
  population: [{ field: 'status', op: 'is', values: ['Traced'] }],
} as never

/** A fish2-shaped source: cells 3, 7 and 12 are matched, everything else is not. */
function fakeSource(schema = NEURONS) {
  const matched: Record<number, string> = { 3: '300', 7: '700', 12: '1200' }
  const findNeurons = vi.fn(async (req: FindNeuronsRequest) => {
    const wanted = new Set(req.labels!.values.map(Number))
    // Answered in the source's own order — descending — so the node's reordering is visible.
    const rows = Object.entries(matched)
      .filter(([cell]) => wanted.has(Number(cell)))
      .reverse()
      .map(([cell, neuronId]) => ({ neuronId, type: 'x', zapbenchId: Number(cell) }))
    return tableFromRows(schema, rows, 'neurons')
  })
  return { source: { id: 'fake', schemas: { neurons: schema }, findNeurons }, findNeurons }
}

function selection(labels: Array<string | null>): TableValue {
  return tableFromRows(
    tableSchema(column('label', 'str'), column('index', 'i64')),
    labels.map((label, index) => ({ label, index })),
  )
}

async function run(
  params: Record<string, unknown>,
  cells: Value | undefined,
  source = fakeSource().source,
) {
  const warnings: string[] = []
  const merged = { ...defaultParams(def), ...params }
  const inputs: Record<string, Value | undefined> = { dataset: DATASET, cells }
  const out = await def.evaluate!({
    params: merged,
    input: (id: string) => inputs[id],
    inputs,
    column: (id: string) => {
      const name = (merged as Record<string, unknown>)[id] as string
      return isTableValue(cells) && cells.schema.columns.some((c) => c.name === name)
        ? name
        : undefined
    },
    columns: () => [],
    progress: () => {},
    warn: (message: string) => warnings.push(message),
    resolveSource: () => source,
    signal: undefined,
  } as never)
  return { neurons: out.neurons as TableValue, warnings }
}

describe('looking cells up', () => {
  it('reads a downsampled row label as every cell it averages', async () => {
    const { source, findNeurons } = fakeSource()
    await run({}, selection(['3+4', '7']), source)
    expect(findNeurons).toHaveBeenCalledTimes(1)
    const request = findNeurons.mock.calls[0]![0]
    expect(request.labels).toEqual({
      field: 'zapbenchId',
      values: ['3', '4', '7'],
    })
    // A cell id names a body already; the Dataset card's population must not narrow it.
    expect(request).not.toHaveProperty('population')
  })

  it('returns neurons in the order their cells were selected, and counts the unmatched', async () => {
    const { neurons, warnings } = await run({}, selection(['12', '3+4', '7']))
    expect(getColumn(neurons, 'neuronId')).toEqual(['1200', '300', '700'])
    expect(neurons.kind).toBe('neurons')
    expect(warnings).toEqual(['1 of 4 cells have no EM neuron on fish2; 3 do.'])
  })

  it('combines typed cells with the wired column, each cell once', async () => {
    const { source, findNeurons } = fakeSource()
    await run({ ids: '7, 12' }, selection(['7']), source)
    expect(findNeurons.mock.calls[0]![0].labels!.values).toEqual(['7', '12'])
  })

  it('asks in batches rather than one list of every cell', async () => {
    const { source, findNeurons } = fakeSource()
    await run({ ids: '1-12000' }, undefined, source)
    expect(findNeurons.mock.calls.map((call) => call[0].labels!.values.length)).toEqual([
      5000, 5000, 2000,
    ])
  })

  it('is empty, asking nothing, when no cell is named', async () => {
    const { source, findNeurons } = fakeSource()
    const { neurons } = await run({}, selection([null]), source)
    expect(findNeurons).not.toHaveBeenCalled()
    expect(neurons.length).toBe(0)
    expect(neurons.schema).toBe(NEURONS)
  })
})

describe('a column that is not cells', () => {
  it('refuses neuron ids and says what reads them', async () => {
    await expect(run({}, selection(['720575940612345678']))).rejects.toThrow(
      /look like neuron ids — Selected to Neurons/,
    )
  })

  it('refuses a column holding no cell ids at all', async () => {
    await expect(run({}, selection(['LC4', 'LC6']))).rejects.toThrow(
      /"label" holds no ZapBench cell ids/,
    )
  })

  it('refuses a dataset whose neurons carry no zapbenchId', async () => {
    const bare = tableSchema(column('neuronId', 'str'), column('type', 'str'))
    await expect(run({}, selection(['3']), fakeSource(bare).source)).rejects.toThrow(
      /fish2 publishes no zapbenchId/,
    )
  })

  it('names unreadable typed cells on the card', () => {
    expect(
      def.validate!({ params: { ...defaultParams(def), ids: '3, abc' }, inputs: {} } as never),
    ).toEqual([
      'Not cell ids: abc. List whole numbers, ranges like 100-200, or row labels from ZapBench ' +
        'Recording.',
    ])
  })
})
