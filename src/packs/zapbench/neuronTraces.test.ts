/**
 * The Neurons to ZapBench Traces node.
 *
 * The byte arithmetic is `data/zapbench/traces.test.ts`'; what belongs here is the **seam**,
 * which is where every way of getting a plausible wrong answer lives:
 *
 * - a `zapbenchId` column that is not one, handed over by `resolveColumn`'s rule 3;
 * - the off-by-one between a segmentation label and a trace column;
 * - a row that carries no id at all, which most of fish2 does not.
 *
 * Each of the three fails *quietly* if it fails at all — a neighbouring cell's trace, or a
 * shorter matrix — so the assertions name cells and counts rather than checking that something
 * came back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultParams } from '../../core/node'
import { defaultOutputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { column, tableSchema } from '../../core/types'
import type { MatrixValue, TableValue, Value } from '../../core/values'
import { isMatrixValue, tableFromRows } from '../../core/values'
import { resetTransport } from '../../data/precomputed/transport'
import {
  WHOLE_RECORDING_ID,
  resetSortingCheck,
  resetTraceCache,
} from '../../data/zapbench/traces'
import { CHUNK, cellValue, serveTraceChunks } from '../../test/zapbenchStubs'
import '../../nodes'

const def = requireNodeDef('zapbench:neuronTraces')

const NEURON_SCHEMA = tableSchema(
  column('neuronId', 'str'),
  column('type', 'str'),
  column('zapbenchId', 'i64'),
)

/** A fish2-shaped neuron table: an id, a type, and a ZapBench match for some rows. */
/** A table whose id column holds body ids — the rule-3 substitution this node must refuse. */
function bodyIds(): TableValue {
  return tableFromRows(
    tableSchema(column('neuronId', 'str'), column('bodyId', 'i64')),
    [{ neuronId: '110913816', bodyId: 110913816 }],
    'neurons',
  )
}

function neurons(rows: Array<[string, string, number | null]>): TableValue {
  return tableFromRows(
    NEURON_SCHEMA,
    rows.map(([neuronId, type, zapbenchId]) => ({ neuronId, type, zapbenchId })),
    'neurons',
  )
}

interface RunResult {
  traces: MatrixValue
  warnings: string[]
}

async function run(
  input: Value | undefined,
  params: Record<string, unknown> = {},
): Promise<RunResult> {
  const warnings: string[] = []
  const merged = { ...defaultParams(def), ...params }
  const out = await def.evaluate!({
    params: merged,
    input: () => input,
    inputs: { in: input },
    // Every picker resolves to its own stored value: these tables have the columns the
    // defaults name, so rule 3 has nothing to substitute. The substitution case is asserted
    // through `validate` and through an explicitly repointed picker instead.
    column: (id: string) => ((merged as Record<string, unknown>)[id] as string) || undefined,
    columns: () => [],
    progress: () => {},
    warn: (message: string) => warnings.push(message),
    reportFetched: () => {},
    refresh: false,
    signal: undefined,
  } as never)
  if (!isMatrixValue(out.traces)) throw new Error('traces is not a matrix')
  return { traces: out.traces, warnings }
}

/** Six neurons, one per 512-neuron block — a scattered selection, the expensive shape. */
function sixBlocks(): Array<[string, string, number]> {
  return Array.from({ length: 6 }, (_, block) => [`n${block}`, 'x', block * CHUNK + 1])
}

function validateWith(inputs: Record<string, unknown>, params: Record<string, unknown> = {}) {
  const merged = { ...defaultParams(def), ...params }
  return def.validate!({
    params: merged,
    inputs,
    schema: () => undefined,
    attributes: () => undefined,
    column: (id: string) => ((merged as Record<string, unknown>)[id] as string) || undefined,
    columns: () => [],
    inputPorts: () => [],
    outputPorts: () => [],
  } as never)
}

beforeEach(() => {
  resetTraceCache()
  // The session's verdict on the transposed copy is deliberately sticky (`keep: 'resolved'`),
  // so without this the first case's "no sorted copy here" answer holds for the whole file and
  // every later case silently reads the row-major route.
  resetSortingCheck()
  resetTransport()
  // Every case here reads traces; serving the store once beats it being the first line of
  // eleven of twelve.
  serveTraceChunks()
})
afterEach(() => vi.unstubAllGlobals())

describe('the node’s shape', () => {
  /*
   * One port. There was a second emitting the same values long, for `core.similarity`; it was
   * removed because a trace matrix is dense, so the long form carried the same numbers in four
   * boxed columns and was built on every run whether anything read it or not.
   */
  it('emits a matrix and nothing else', () => {
    expect(defaultOutputPorts(def).map((port) => port.id)).toEqual(['traces'])
  })
})

describe('reading traces for a neuron table', () => {
  /*
   * The off-by-one, at the one place a user can see it. `zapbenchId: 1` is the segmentation
   * label of the *first* cell, which is trace column 0 — so the value at t=0 must be
   * `cellValue(0, 0)` and not `cellValue(0, 1)`. Both are real traces of real neurons, which
   * is exactly why this is asserted by cell rather than by shape.
   */
  it('reads the trace column a segmentation label names, not the label', async () => {
    const { traces } = await run(neurons([['100', 'LC4', 1]]), { condition: 'flash' })
    expect(traces.values[0]).toBe(cellValue(2423, 0))
    expect(traces.rowLabels).toEqual(['100'])
    // `flash` is [2423, 3077), so the axis carries absolute timesteps of the full recording.
    expect(traces.colLabels[0]).toBe('2423')
    expect(traces.colLabels.at(-1)).toBe('3076')
    expect(traces.colLabels).toHaveLength(654)
  })

  it('keeps the input’s row order and labels rows by the Label by column', async () => {
    const { traces } = await run(
      neurons([
        ['100', 'LC4', 10],
        ['200', 'LC6', 3],
      ]),
      { condition: 'gain', labelColumn: 'type' },
    )
    expect(traces.rowLabels).toEqual(['LC4', 'LC6'])
    // `gain` is [1, 648), so 647 steps — the stride is read off the axis rather than typed,
    // which is what caught this assertion naming `flash`'s 654 while the node was right.
    const steps = traces.colLabels.length
    expect(steps).toBe(647)
    expect(traces.values[0]).toBe(cellValue(1, 9))
    expect(traces.values[steps]).toBe(cellValue(1, 2))
  })

  /*
   * "Some but not all" is the ordinary state of fish2, so an unmatched row is dropped and
   * counted rather than being an error — but the count has to be said, or a matrix silently
   * shorter than the table it came from reads as a fetch that half worked.
   */
  it('drops rows with no ZapBench id and says how many', async () => {
    const { traces, warnings } = await run(
      neurons([
        ['100', 'LC4', 5],
        ['200', 'LC6', null],
        ['300', 'LC9', 7],
      ]),
      { condition: 'dark' },
    )
    expect(traces.rowLabels).toEqual(['100', '300'])
    expect(warnings.some((w) => /1 of 3 neurons carry no ZapBench id/.test(w))).toBe(true)
  })

  it('refuses when nothing in the table carries an id', async () => {
    await expect(run(neurons([['100', 'LC4', null]]))).rejects.toThrow(
      /No neuron in this table/,
    )
  })

  it('falls back to the id for a row whose label is blank', async () => {
    const { traces } = await run(neurons([['', 'LC4', 42]]), { condition: 'dark' })
    // A blank would collide with every other blank on an axis the Heatmap filters on.
    expect(traces.rowLabels).toEqual(['42'])
  })
})

describe('a column that is not a ZapBench id', () => {
  /*
   * `resolveColumn`'s rule 3 is the trap: a required picker still on its declared default falls
   * back to the first compatible column, so a table with no `zapbenchId` sends body ids into
   * the fetch. Nothing about the *shape* of that is wrong, so the values are what has to
   * refuse — and a fish2 bodyId is four orders of magnitude past the ceiling.
   */
  it('refuses a body id, naming the range it expected', async () => {
    await expect(run(bodyIds(), { idColumn: 'bodyId' })).rejects.toThrow(/71,721/)
  })

  it('warns at edit time when the picker is not on zapbenchId', () => {
    expect(validateWith({ in: undefined }, { idColumn: 'bodyId' })).toEqual([
      expect.stringContaining('Reading ZapBench ids from "bodyId"'),
    ])
    expect(validateWith({ in: undefined }, { idColumn: 'zapbenchId' })).toEqual([])
  })

  /*
   * Deliberately nothing here about an unset picker: `validateColumnParams` runs for every node
   * and already reports it — and for the rule-3 case even names the column it substituted. A
   * second sentence from this node would be the same badge twice.
   */
  it('says nothing at edit time about an unset picker, which the framework reports', () => {
    expect(validateWith({ in: undefined }, { idColumn: '' })).toEqual([])
  })

  it('refuses a condition this release does not have, at both stages', async () => {
    expect(validateWith({ in: undefined }, { condition: 'looming' })).toEqual([
      expect.stringContaining('No ZapBench condition called "looming"'),
    ])
    await expect(run(neurons([['100', 'LC4', 1]]), { condition: 'looming' })).rejects.toThrow(
      /No ZapBench condition/,
    )
  })

  /*
   * A string-typed id column is the same column: nothing says which of `i64` and `str` a
   * backend publishes an integer property as.
   */
  it('reads an id published as text', async () => {
    const table = tableFromRows(
      tableSchema(column('neuronId', 'str'), column('zapbenchId', 'str')),
      [{ neuronId: '100', zapbenchId: '4' }],
      'neurons',
    )
    const { traces } = await run(table, { condition: 'dark' })
    expect(traces.values[0]).toBe(cellValue(7280, 3))
  })

  it('leaves out a value that is not a whole number, and counts it', async () => {
    const table = tableFromRows(
      tableSchema(column('neuronId', 'str'), column('zapbenchId', 'str')),
      [
        { neuronId: '100', zapbenchId: 'n/a' },
        { neuronId: '200', zapbenchId: '4' },
      ],
      'neurons',
    )
    const { traces, warnings } = await run(table, { condition: 'dark' })
    expect(traces.rowLabels).toEqual(['200'])
    /*
     * One sentence, not two: the total left out includes the unparseable rows, so counting them
     * in a warning of their own said "1 row" and "1 of 2 neurons" about the same row.
     */
    const drop = warnings.find((w) => /carry no ZapBench id/.test(w))
    expect(drop).toMatch(/1 of 2 neurons/)
    expect(drop).toMatch(/1 hold something that is not a whole number/)
  })
})

describe('cost', () => {
  /*
   * The warning is the node's whole answer to a fetch that can run to hundreds of megabytes,
   * and `ctx.warn`'s rule is that it is raised at the top — before the wait, beside a live
   * Cancel. Asserted by content because the number is the useful part.
   */
  it('warns about the blocks a scattered selection lands in, not the neuron count', async () => {
    // Three neurons, three different 512-neuron blocks, whole recording: ~48 MiB... so spread
    // them wider to cross the threshold the node warns at.
    const rows = sixBlocks()
    const { warnings } = await run(neurons(rows), { condition: WHOLE_RECORDING_ID })
    const cost = warnings.find((w) => /512-neuron blocks/.test(w))
    expect(cost).toMatch(/6 of the array’s 512-neuron blocks/)
    expect(cost).toMatch(/narrowing Condition is what makes it smaller/)
    /*
     * Bytes as a formatted size, never the raw count. Routed through `warnOverThreshold` this
     * read announced "580,902,912 bytes to read is past the size a ZapBench read is worth
     * mentioning (67,108,864)" — so the assertion is that a reader sees megabytes and no
     * nine-digit number anywhere in the sentence.
     */
    expect(cost).toMatch(/about \d+ MB\./)
    expect(cost).not.toMatch(/\d{9}/)
    expect(cost).toMatch(/Reading it anyway/)
  })

  /*
   * The transposed copy reads a few kilobytes where the row-major one reads hundreds of
   * megabytes, so the warning has to price the plan that will actually run — computed from the
   * row-major shape it announced "about 554 MB" for a read that fetched 1.1 MiB.
   */
  it('says nothing about cost when the transposed route makes the read small', async () => {
    vi.unstubAllGlobals()
    serveTraceChunks({ sorted: true })
    const rows = sixBlocks()
    const { warnings } = await run(neurons(rows), { condition: WHOLE_RECORDING_ID })
    expect(warnings.filter((w) => /MB/.test(w))).toEqual([])
  })

  it('stays quiet about cost for a selection in one block over one condition', async () => {
    const { warnings } = await run(neurons([['100', 'LC4', 1]]), { condition: 'flash' })
    expect(warnings.filter((w) => /512-neuron blocks/.test(w))).toEqual([])
  })
})

describe('keeping neurons that have no ZapBench id', () => {
  /*
   * The reason the param exists: most of fish2 carries no id, so dropping silently changes both
   * the row count and the row *order* relative to the input — which is fine for a heatmap and
   * wrong the moment the result is joined back onto the table it came from, or read as a colour
   * channel. So the assertion is about position, not just presence.
   */
  it('holds the input’s row order and count', async () => {
    const { traces } = await run(
      neurons([
        ['100', 'LC4', 5],
        ['200', 'LC6', null],
        ['300', 'LC9', 9],
      ]),
      { condition: 'dark', unmatched: 'null' },
    )
    expect(traces.rowLabels).toEqual(['100', '200', '300'])
    const steps = traces.colLabels.length
    expect(traces.values[0]).toBe(cellValue(7280, 4))
    expect(Number.isNaN(traces.values[steps]!)).toBe(true)
    // The row *after* the gap still holds its own measurement, which is what a shifted fill
    // would break while leaving the count right.
    expect(traces.values[2 * steps]).toBe(cellValue(7280, 8))
  })

  /*
   * `NaN` in the matrix and `null` in the table is the one asymmetry here, and it is deliberate:
   * a `Float64Array` has no other spelling for absence, a table column does, and every table op
   * in the tree already understands null.
   */
  /*
   * `NaN` rather than `0`, and the distinction is the whole point of the option: a gap draws as
   * a gap on the Heatmap and aggregates as absent, where a zero is a manufactured measurement
   * among real ones.
   */
  it('writes no-value as NaN, and the whole row of it', async () => {
    const { traces } = await run(
      neurons([
        ['100', 'LC4', 5],
        ['200', 'LC6', null],
      ]),
      { condition: 'dark', unmatched: 'null' },
    )
    const steps = traces.colLabels.length
    expect(traces.values[0]).toBe(cellValue(7280, 4))
    expect(Number.isNaN(traces.values[steps]!)).toBe(true)
    expect(Number.isNaN(traces.values[2 * steps - 1]!)).toBe(true)
  })

  it('writes zeros when asked for zeros', async () => {
    const { traces } = await run(
      neurons([
        ['100', 'LC4', 5],
        ['200', 'LC6', null],
      ]),
      { condition: 'dark', unmatched: 'zero' },
    )
    const steps = traces.colLabels.length
    expect(traces.values[steps]).toBe(0)
    expect(traces.values[2 * steps - 1]).toBe(0)
  })

  it('names an unmatched row by its label, or by its position when it has none', async () => {
    const { traces } = await run(
      tableFromRows(
        tableSchema(column('neuronId', 'str'), column('zapbenchId', 'i64')),
        [
          { neuronId: '', zapbenchId: null },
          { neuronId: 'named', zapbenchId: null },
          { neuronId: '300', zapbenchId: 5 },
        ],
        'neurons',
      ),
      { condition: 'dark', unmatched: 'null' },
    )
    // A blank would collide with every other blank on an axis the Heatmap filters.
    expect(traces.rowLabels).toEqual(['row 1', 'named', '300'])
  })

  /*
   * The one that must not bend. An out-of-range integer means the wrong column was wired, not a
   * missing match — folding it into the kept-and-blank branch would turn a `bodyId` into a
   * silent matrix of nothing, which is the exact failure the range check exists for.
   */
  it('still refuses a body id rather than keeping it as an empty row', async () => {
    const table = tableFromRows(
      tableSchema(column('neuronId', 'str'), column('bodyId', 'i64')),
      [{ neuronId: '110913816', bodyId: 110913816 }],
      'neurons',
    )
    await expect(run(table, { idColumn: 'bodyId', unmatched: 'null' })).rejects.toThrow(
      /71,721/,
    )
    await expect(run(table, { idColumn: 'bodyId', unmatched: 'zero' })).rejects.toThrow(
      /71,721/,
    )
  })

  it('still refuses a table where nothing matched at all', async () => {
    // Keeping them would give a matrix of nothing but gaps, which is not a result.
    await expect(run(neurons([['100', 'LC4', null]]), { unmatched: 'null' })).rejects.toThrow(
      /No neuron in this table/,
    )
  })

  it('says they were kept, and says what zeros cost', async () => {
    const rows: Array<[string, string, number | null]> = [
      ['100', 'LC4', 5],
      ['200', 'LC6', null],
    ]
    const blank = await run(neurons(rows), { condition: 'dark', unmatched: 'null' })
    expect(blank.warnings.find((w) => /carry no ZapBench id/.test(w))).toMatch(
      /kept with no values/,
    )
    const zero = await run(neurons(rows), { condition: 'dark', unmatched: 'zero' })
    expect(zero.warnings.find((w) => /carry no ZapBench id/.test(w))).toMatch(
      /nothing downstream can tell from a measurement/,
    )
  })

  it('fetches nothing for a kept row', async () => {
    const calls = serveTraceChunks()
    const chunkReads = () => calls.filter((call) => call.url.includes('/c/')).length

    const start = chunkReads()
    const one = await run(neurons([['100', 'LC4', 5]]), { condition: 'dark' })
    const alone = chunkReads() - start

    /*
     * The cache has to go between the two runs, or the second answers entirely from memory and
     * reads nothing whatever the param does — which is this assertion passing for the wrong
     * reason rather than for the right one.
     */
    resetTraceCache()
    const mark = chunkReads()
    const withGaps = await run(
      neurons([
        ['100', 'LC4', 5],
        ['200', 'LC6', null],
        ['300', 'LC9', null],
      ]),
      { condition: 'dark', unmatched: 'null' },
    )
    // Three rows out, one neuron fetched — exactly the reads the one-row case needed.
    expect(withGaps.traces.rowLabels).toHaveLength(3)
    expect(chunkReads() - mark).toBe(alone)
    expect(alone).toBeGreaterThan(0)
    expect(withGaps.traces.values[0]).toBe(one.traces.values[0])
  })
})
