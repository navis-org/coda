/**
 * The ZapBench Recording node.
 *
 * The reader's arithmetic is `data/zapbench/recording.test.ts`'. What belongs here is what the
 * card decides: which cells a typed list names and in what order, what a downsampled row's label
 * says, and that a matrix no tab can hold is said on the card before anybody presses Run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultParams } from '../../core/node'
import { defaultInputPorts, defaultOutputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import type { MatrixValue } from '../../core/values'
import { isMatrixValue } from '../../core/values'
import { resetTransport } from '../../data/precomputed/transport'
import { resetLevelChecks } from '../../data/zapbench/recording'
import { resetSortingCheck, resetTraceCache } from '../../data/zapbench/traces'
import {
  cellValue,
  defaultSorting,
  levelCellValue,
  serveTraceChunks,
} from '../../test/zapbenchStubs'
import '../index'

const def = requireNodeDef('zapbench.recording')

async function run(params: Record<string, unknown> = {}) {
  const warnings: string[] = []
  const merged = { ...defaultParams(def), ...params }
  const out = await def.evaluate!({
    params: merged,
    input: () => undefined,
    inputs: {},
    column: () => undefined,
    columns: () => [],
    progress: () => {},
    warn: (message: string) => warnings.push(message),
    reportFetched: () => {},
    refresh: false,
    signal: undefined,
  } as never)
  if (!isMatrixValue(out.traces)) throw new Error('traces is not a matrix')
  return { traces: out.traces as MatrixValue, warnings }
}

function validate(params: Record<string, unknown> = {}) {
  return def.validate!({ params: { ...defaultParams(def), ...params }, inputs: {} } as never)
}

beforeEach(() => {
  resetTraceCache()
  resetSortingCheck()
  resetLevelChecks()
  resetTransport()
})
afterEach(() => vi.unstubAllGlobals())

describe('the node’s shape', () => {
  it('takes nothing and emits a matrix', () => {
    expect(defaultInputPorts(def)).toEqual([])
    expect(defaultOutputPorts(def).map((port) => port.type.kind)).toEqual(['matrix'])
  })
})

describe('cells somebody lists', () => {
  it('reads each listed cell’s trace, not its neighbour’s, in the order typed', async () => {
    serveTraceChunks()
    const { traces } = await run({ cells: 'list', ids: '600\n5, 10-11', condition: 'gain' })
    expect(traces.rowLabels).toEqual(['600', '5', '10', '11'])
    const steps = traces.colLabels.length
    expect(traces.colLabels[0]).toBe('1')
    // Cell 5 is trace column 4.
    expect(traces.values[1 * steps]).toBe(cellValue(1, 4))
    expect(traces.values[0]).toBe(cellValue(1, 599))
  })

  it('reads a repeated cell once and says so', async () => {
    serveTraceChunks()
    const { traces, warnings } = await run({
      cells: 'list',
      ids: '5, 5, 4-6',
      condition: 'gain',
    })
    expect(traces.rowLabels).toEqual(['5', '4', '6'])
    expect(warnings).toEqual(['2 repeated cell ids are read once.'])
  })

  it('is an empty matrix, fetching nothing, when nothing is listed', async () => {
    const calls = serveTraceChunks()
    const { traces } = await run({ cells: 'list', ids: '' })
    expect(traces.rowLabels).toEqual([])
    expect(calls).toEqual([])
  })

  it('names what it cannot read on the card and refuses it at a Run', async () => {
    const params = { cells: 'list', ids: '5, twelve, 0' }
    expect(validate(params)).toEqual([
      'Not cell ids: twelve. List whole numbers, ranges like 100-200, or row labels from ' +
        'ZapBench Recording.',
      'No ZapBench cell is numbered 0 — this release numbers its 71,721 cells from 1.',
    ])
    await expect(run(params)).rejects.toThrow(/Not cell ids: twelve/)
  })
})

describe('every cell', () => {
  it('names each quarter-scale row by the cells it averages, in activity order', async () => {
    serveTraceChunks({ sorted: true })
    const sorting = defaultSorting()
    const { traces, warnings } = await run({ condition: 'position' })
    expect(traces.rowLabels).toHaveLength(17931)
    expect(traces.rowLabels[0]).toBe(
      sorting
        .slice(0, 4)
        .map((c) => c + 1)
        .join('+'),
    )
    expect(traces.rowLabels[17930]).toBe(String(sorting[71720]! + 1))
    // `position` is [5048, 5637): s2 steps 1262 to 1409, all inside one chunk row.
    expect(traces.colLabels[0]).toBe('5048')
    expect(traces.colLabels).toHaveLength(147)
    expect(traces.values[0]).toBeCloseTo(levelCellValue(1262, 0, 4), 0)
    expect(traces.valueLabel).toBe('df/f — position, mean of 4 × 4')
    // 36 reads of about a megabyte: under the size worth mentioning.
    expect(warnings).toEqual([])
  })

  it('says what a read costs once it crosses the size worth mentioning', async () => {
    serveTraceChunks({ sorted: true })
    // `turning` at s2 spans two chunk rows, so twice the reads of `position`.
    const { warnings } = await run({ condition: 'turning' })
    expect(warnings).toEqual([
      expect.stringMatching(/^Every cell comes to about \d+ MB in 72 reads\./),
    ])
  })

  it('refuses a downsampled read it cannot name', async () => {
    serveTraceChunks()
    await expect(run({ condition: 'position' })).rejects.toThrow(/Set Scale to Full/)
  })

  it('says on the card that a matrix no tab can hold will be refused', () => {
    expect(validate({ scale: '1' })).toEqual([
      expect.stringMatching(/71,721 × 7,879 matrix of every cell would allocate 4\.2 GB/),
    ])
    expect(validate({ scale: '2' })).toEqual([expect.stringMatching(/would allocate 1\.1 GB/)])
    expect(validate()).toEqual([])
    expect(validate({ scale: '1', condition: 'flash' })).toEqual([])
  })

  it('says a product with no downsampled copy needs full scale', () => {
    expect(validate({ product: 'stimulus_evoked_response' })).toEqual([
      'Stimulus-evoked response has no downsampled copy in this release — only Activity does. ' +
        'Set Scale to Full.',
    ])
  })

  it('does not hold a listed read to the whole-population ceiling', () => {
    expect(validate({ cells: 'list', scale: '1', ids: '5' })).toEqual([])
  })
})
