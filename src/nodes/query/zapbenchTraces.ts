/**
 * ZapBench Traces: the calcium-imaging trace of every neuron in a fish2 table that has one.
 *
 * fish2's EM bodies carry a `zapbenchId` where somebody matched them to a cell in the ZapBench
 * light-sheet recording, and *some but not all* of them do. So the node's job is a join across
 * two modalities of one specimen, and the two things that make it interesting are both about
 * the seam rather than about the fetch.
 *
 * **The id is off by one and nothing on either side says so.** `traceColumnOf` in
 * `data/zapbench/traces.ts` is the one statement of the subtraction, and its header records the
 * measurement behind it — the segmentation label is `column + 1` for all 71,721 rows, and the
 * geometry fit that settled which way round. Choosing wrongly does not fail: it
 * returns the *neighbouring cell's* trace, which is a real trace of a real neuron and looks
 * entirely plausible on a heatmap. That is why `evaluate` refuses on an id set inconsistent
 * with the configured base instead of trusting the column it was handed.
 *
 * **The picker cannot be trusted either, for a reason that is `resolveColumn`'s rule 3.** A
 * required picker still holding its declared default falls back to *the first compatible
 * column* when the schema lacks the name — so on a table with no `zapbenchId` at all, `ZapBench
 * ID` silently resolves to whatever comes first and the node would fetch traces at indices
 * derived from body ids. `excludeIds` keeps `neuronId` out of that draw, and the range check
 * below is what catches the rest: a fish2 bodyId is around 10^8 against a ceiling of 71,721, so
 * the numbers themselves give it away. `validate` says the same thing at edit time, where it is
 * cheaper to read.
 *
 * ## One output, and what the second one cost
 *
 * `Matrix` only. The Heatmap is the *only* view for a trace population — there is no line chart
 * in the registry — and a matrix is what it takes.
 *
 * There **was** a second port emitting the same values long (`label, zapbenchId, t, value`),
 * because `core.similarity` takes a table rather than a matrix and no matrix→table node exists.
 * It was removed, and the reason is that a trace matrix is **dense**: the long form is one row
 * per neuron *per timestep*, so it carried the same numbers in four boxed `CellValue[]` columns
 * against the matrix's one `Float64Array` — four times the memory, built on **every** run
 * whether or not anything was wired to it, and it was what set this node's refusal ceiling
 * (`cells * 32` against the matrix's `cells * 8`, so about 2,000 neurons over the whole
 * recording rather than 8,000).
 *
 * That was a real capability removed, not a tidy-up, and both halves of it belonged one level up
 * rather than here. One has arrived: **`core.reduceMatrix`** takes any matrix to one table row
 * per line, which is the per-neuron statistic this node's output had no route to and what a
 * colour-by-activity chain reads. The other has not — **nothing downstream of a `Matrix`
 * computes a correlation**; `Normalize` and `Embed` take a matrix, and `Linkage` takes one but
 * reads it as *distances*, which a trace matrix is not. That is a matrix layout on
 * `core.similarity`, which for dense feature vectors is cheaper than either of its existing
 * layouts rather than a relocation of this cost. See docs/nodes.md.
 *
 * ## Why `Condition` is not a convenience
 *
 * Neurons sit on the array's contiguous axis, so cost is *blocks touched × timesteps* and a
 * time window is the only thing that reduces it — the header of the data module has the
 * arithmetic and the measurement. The whole recording is ~16 MiB per 512-neuron block; `flash`
 * is 1.28 MiB. The default is still the whole recording, because that is the honest answer to
 * "the traces for these neurons" and the cost is said out loud rather than pre-empted by
 * picking a stimulus condition on somebody's behalf.
 */

import { refuseIfOverCrashFloor } from '../../core/limits'
import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { getColumn, isTableValue, makeMatrix } from '../../core/values'
import type { CellValue } from '../../core/values'
import type { TraceCost } from '../../data/zapbench/traces'
import {
  TRACE_COLUMNS,
  TRACE_PRODUCTS,
  WHOLE_RECORDING_ID,
  conditionWindow,
  fetchTraces,
  readProduct,
  traceColumnOf,
  windowLength,
} from '../../data/zapbench/traces'
import { numericCell } from '../lib/chartSelection'
import {
  CONDITION_OPTIONS,
  ZAPBENCH_ID_COLUMN,
  noSuchCondition,
  stepLabels,
  traceCostWarning,
  traceValueLabel,
} from '../lib/zapbenchCells'

/**
 * What becomes of a neuron the release has no trace for.
 *
 * The spellings are `Relabel`'s: `tableOps.ts` exports `UnmatchedMode = 'null' | 'keep' | 'drop'`
 * and ships it under a param also called `unmatched`, so calling this idea `blank` would be one
 * vocabulary in two spellings — in a **stored param value**, where the param system offers no
 * per-value migration. `keep` is not offered because there is no original value to keep: a
 * neuron with no id has no trace.
 *
 * This lived in `nodes/lib/traceTable.ts` while the node also emitted a long table, because the
 * choice then had two spellings — `NaN` for the matrix and `null` for a table cell — and wanted
 * one owner. With the table gone there is one spelling and one consumer, so it comes back here.
 */
type TraceUnmatched = 'drop' | 'null' | 'zero'

const TRACE_UNMATCHED_OPTIONS = [
  { value: 'drop', label: 'Drop them' },
  { value: 'null', label: 'Keep, with no values' },
  { value: 'zero', label: 'Keep, as zeros' },
]

function readTraceUnmatched(value: unknown): TraceUnmatched {
  return value === 'null' || value === 'zero' ? value : 'drop'
}

/**
 * What a kept row's cells hold in the matrix.
 *
 * `NaN` is the house spelling for "no cell here" — `tableOps`' line totals write it and
 * `heatmapPlot` skips non-finite cells rather than reading them as zero — so a kept-but-unmeasured
 * neuron draws as a gap and aggregates as absent. `0` is offered because some downstream work
 * wants it, and it is the dangerous one: a manufactured measurement among real ones, afterwards
 * indistinguishable from a neuron that was recorded and did nothing.
 */
function matrixFill(unmatched: TraceUnmatched): number {
  return unmatched === 'zero' ? 0 : Number.NaN
}

/**
 * The unset-picker refusal, worded once. Its sibling for an unknown condition is
 * `noSuchCondition` in `nodes/lib/zapbenchCells.ts`, shared with ZapBench Recording.
 *
 * Said at edit time *and* refused at run time is the right shape — a card should not wait for a
 * Run to say its picker is unset — but written out at both stages the same sentence existed
 * twice with different wording, which is how one gets improved and the other does not.
 */
function noIdColumn(available?: string): string {
  return (
    'No ZapBench ID column selected. On fish2 that column is "zapbenchId"' +
    (available === undefined ? '.' : `; this table has: ${available || '(none)'}`)
  )
}

/**
 * A cell as a whole number, or `undefined` for one that is not.
 *
 * `numericCell` is the existing reader for "this cell as a number" — it already handles the
 * null/blank/boolean cases and the numeric-string one, which is what nothing says a backend does
 * not publish an integer property as. What is added here is only the *whole number* rule.
 *
 * Deliberately **not** `core/ids.ts`' `idText`/`numericId`: those are the one definition of a
 * *neuron* id, and a ZapBench cell index is not one. Borrowing them would say it was, which is
 * the second-spelling hazard invariant 8 is about, pointed the other way.
 */
function readId(cell: CellValue): number | undefined {
  const value = numericCell(cell)
  return value !== undefined && Number.isInteger(value) ? value : undefined
}

registerNode({
  type: 'zapbench.traces',
  label: 'ZapBench Traces',
  category: 'query',
  description:
    'Calcium-imaging traces from ZapBench for the fish2 neurons that carry a zapbenchId.',
  guide:
    'Reads the released ZapBench activity traces for whichever neurons in the input table carry a zapbenchId — some but not all of fish2 does — and hands them on as a matrix for the Heatmap and the same values long for Similarity Matrix, which takes a table rather than a matrix. The thing to know is what a request costs: neurons sit on the contiguous axis of the published array, so the bill is set by how many 512-neuron blocks your selection lands in rather than by how many neurons you asked for, at roughly 16 MiB a block over the whole recording. Narrowing Condition to one of the nine stimulus blocks is the only thing that makes it cheaper — subsampling time does not, because a chunk already spans 512 timesteps.',
  cost: 'expensive',
  // The session cache in `data/zapbench/traces.ts` is in memory, not `loadCachedTable`'s
  // IndexedDB layer, so this deliberately does not declare `dataCache`: the Clear Cache button
  // names a persistent copy there is none of. `ctx.refresh` is still honoured.

  inputs: [{ id: 'in', label: 'Neurons', type: T.table() }],
  outputs: [{ id: 'traces', label: 'Matrix', type: T.matrix() }],

  params: [
    {
      id: 'idColumn',
      kind: 'column',
      label: 'ZapBench ID',
      from: 'in',
      default: ZAPBENCH_ID_COLUMN,
      /*
       * `ColumnParam.excludeIds` is documented for a picker that wants a *label*; this is a
       * third use of it — blocking rule 3's likeliest substitution on a picker that wants
       * numeric ids, `neuronId` being the first `str` column on every neuron schema. It only
       * blocks that one, which is why the range refusal below is the guard that actually
       * catches a wrong column.
       */
      excludeIds: true,
      help: 'The column holding each neuron’s ZapBench cell id. On fish2 that is zapbenchId, and only some neurons have one — the rest are left out and counted.',
    },
    {
      id: 'labelColumn',
      kind: 'column',
      label: 'Label by',
      from: 'in',
      default: 'neuronId',
      help: 'What names each row of the matrix. Data rather than decoration: it is what a Heatmap filter matches and what Similarity Matrix groups by.',
    },
    {
      id: 'condition',
      kind: 'enum',
      label: 'Condition',
      default: WHOLE_RECORDING_ID,
      options: CONDITION_OPTIONS,
      help: 'Which stimulus block to read, trimmed one timestep at each end exactly as zapbench’s own get_condition_bounds trims it. The whole recording costs about 16 MiB per 512-neuron block; a single condition costs a fraction of that.',
    },
    {
      id: 'unmatched',
      kind: 'enum',
      label: 'Unmatched neurons',
      default: 'drop',
      options: TRACE_UNMATCHED_OPTIONS,
      help: 'Most of fish2 carries no ZapBench id. Drop them for a matrix of real measurements; keep them to hold the input’s row order and count, which is what a downstream join or colour channel needs. “No values” is the honest keep — nothing downstream will mistake it for a measurement. Zeros are easier to feed to code that cannot handle gaps, and are indistinguishable afterwards from a neuron that was recorded and did nothing.',
    },
    {
      id: 'product',
      kind: 'enum',
      label: 'Values',
      default: 'traces',
      advanced: true,
      // Spread because `EnumOption[]` is mutable and the table is readonly; the extra `unit`
      // key rides along harmlessly, which is the point of the table carrying it.
      options: [...TRACE_PRODUCTS],
      help: 'Which released array to read. Both have identical shape and chunking.',
    },
  ],

  /*
   * Both exact before anything runs. A matrix carries no schema, and the long table's columns
   * are named here rather than by the data — so nothing downstream waits for a run.
   */
  // Exact before anything runs: a matrix carries no schema, so nothing downstream waits on a run.
  inferOutputs: () => ({ traces: T.matrix() }),

  validate: (ctx) => {
    const issues: string[] = []
    const idColumn = ctx.column('idColumn')
    /*
     * Nothing here about an *unset* picker: `validateColumnParams` runs for every node on every
     * graph mutation and already says `No columns available for "ZapBench ID"`, and for the
     * substitution case it even names what rule 3 picked (`Column "zapbenchId" is gone — using
     * "type"`). What it cannot say is the case below, where the resolved column exists and is
     * simply not the one this node is about — a column somebody chose by hand.
     */
    if (idColumn && idColumn !== ZAPBENCH_ID_COLUMN) {
      issues.push(
        `Reading ZapBench ids from "${idColumn}", not "zapbenchId". ` +
          `Check that is the column you meant.`,
      )
    }
    const condition = String(ctx.params.condition)
    if (!conditionWindow(condition)) issues.push(noSuchCondition(condition))
    return issues
  },

  evaluate: async (ctx) => {
    const input = ctx.input('in')
    if (!isTableValue(input)) throw new Error('Neurons input is not a table')

    const idColumnName = ctx.column('idColumn')
    if (!idColumnName) {
      throw new Error(noIdColumn(input.schema.columns.map((c) => c.name).join(', ')))
    }
    const conditionName = String(ctx.params.condition)
    const window = conditionWindow(conditionName)
    if (!window) throw new Error(noSuchCondition(conditionName))

    const ids = getColumn(input, idColumnName)
    const labelColumnName = ctx.column('labelColumn')
    const labels = labelColumnName ? getColumn(input, labelColumnName) : undefined

    /*
     * One pass, one array. A row without an id is a neuron nobody matched to the functional
     * recording — the ordinary state of most of fish2 — so what happens to it is the
     * `Unmatched neurons` decision rather than a fixed rule; a row whose value is not a whole
     * number is counted *separately* either way, because that says the column is not what it
     * looks like rather than that a match is missing.
     *
     * `lo`/`hi` are tracked here rather than derived afterwards because they are only wanted for
     * the refusal below, and `Math.min(...ids)` over a 70,000-row fish2 table is a spread
     * argument list.
     */
    const unmatched = readTraceUnmatched(ctx.params.unmatched)
    const fill = matrixFill(unmatched)
    /*
     * One pass, one array, and the fetch slot pushed onto the entry as it is made. `columns` is
     * the request and `at` is where that row's values land in the reply — which is no longer the
     * output's row order once unmatched rows sit between them. Derived in a second walk this was
     * a `Map` keyed by a dense array index and a `matched` counter that nothing tied to
     * `columns.length`.
     */
    const selected: Array<{ id: number | null; label: string; at?: number }> = []
    const columns: number[] = []
    let unparsed = 0
    for (let row = 0; row < ids.length; row++) {
      const cell = ids[row]!
      const id = readId(cell)
      const text = labels?.[row]
      const label = text === null || text === undefined ? '' : String(text)
      if (id === undefined) {
        if (cell !== null && cell !== '') unparsed += 1
        if (unmatched === 'drop') continue
        /*
         * No id to fall back to, so the row number stands in — a blank would collide with every
         * other blank on an axis the Heatmap filters, which is the same reason the matched
         * branch below falls back at all. One-based, because it names a row of the input table
         * as a reader would count it.
         */
        selected.push({ id: null, label: label || `row ${row + 1}` })
        continue
      }
      const column = traceColumnOf(id)
      /*
       * The refusal `traces.ts`' header argues for, and it is a refusal rather than a skip: an
       * id this cannot place means the wrong column was wired, not one bad row. Both numbers are
       * named because that is the whole diagnosis — a fish2 bodyId is around 10^8 against a
       * ceiling of 71,721, four orders of magnitude, which the reader can see at a glance.
       *
       * The range is measured here, off the hot path, rather than carried as a running min/max
       * on every row — and it reports the **whole column's** range rather than a prefix of it.
       *
       * **Unaffected by `Unmatched neurons`, deliberately.** An out-of-range integer is a wrong
       * column, not a missing match, so folding it into the kept branch would turn wiring
       * `bodyId` into a silent matrix of nothing — the exact failure the check exists for.
       */
      if (column === undefined) {
        let lo = Infinity
        let hi = -Infinity
        for (const other of ids) {
          const value = readId(other)
          if (value === undefined) continue
          lo = Math.min(lo, value)
          hi = Math.max(hi, value)
        }
        throw new Error(
          `"${idColumnName}" holds values from ${lo.toLocaleString()} to ` +
            `${hi.toLocaleString()}, which are not ZapBench cell ids — this release has ` +
            `${TRACE_COLUMNS.toLocaleString()} cells, numbered 1 to ` +
            `${TRACE_COLUMNS.toLocaleString()}. On fish2 the column is "zapbenchId"; a bodyId ` +
            `will not do.`,
        )
      }
      // A blank label would collide with every other blank on an axis the Heatmap filters, so
      // the id is the fallback rather than an empty string.
      selected.push({ id, label: label || String(id), at: columns.length })
      columns.push(column)
    }

    /*
     * Thrown whatever `Unmatched neurons` says: with nothing matched there is no trace data
     * behind the answer at all, and a matrix of nothing but gaps is not a result to hand on.
     */
    if (columns.length === 0) {
      throw new Error(
        `No neuron in this table carries a ZapBench id in "${idColumnName}". ` +
          `Only some of fish2 does — filter for rows that have one, or check the column.`,
      )
    }

    const steps = windowLength(window)
    const cells = selected.length * steps

    /*
     * One flat `Float64Array`. This used to be priced at four times the shape, because the node
     * also built a long table of four `CellValue[]` columns and that was always the binding
     * constraint; with the table gone the ceiling is the matrix's own and about four times
     * further out.
     */
    refuseIfOverCrashFloor(`A ${selected.length} × ${steps} trace matrix`, cells * 8)

    // Priced by the reader, which alone knows the layout; worded by `traceCostWarning`.
    const announceCost = (cost: TraceCost) => {
      const warning = traceCostWarning(columns.length, cost)
      if (warning) ctx.warn(warning)
    }

    /*
     * One sentence, because two counted the same rows twice: the total without an id *includes*
     * the unparseable ones, so a table with one `n/a` used to raise both "1 row holds something
     * that is not a whole number" and "1 of 3 neurons have no ZapBench id".
     *
     * Said whichever way the param goes — keeping them is not a reason to stop mentioning them.
     * A kept-and-blank matrix looks exactly like a matrix of measurements until somebody
     * aggregates it, and a kept-and-zero one does not even look different then.
     */
    // `columns.length >= 1` by here — the throw above guarantees it.
    const without = ids.length - columns.length
    if (without > 0) {
      const tail =
        unmatched === 'drop'
          ? 'and are left out'
          : unmatched === 'null'
            ? 'and are kept with no values'
            : 'and are kept as zeros, which nothing downstream can tell from a measurement'
      ctx.warn(
        `${without.toLocaleString()} of ${ids.length.toLocaleString()} neurons carry no ` +
          `ZapBench id in "${idColumnName}" ${tail}` +
          (unparsed > 0
            ? ` (${unparsed.toLocaleString()} hold something that is not a whole number)`
            : '') +
          `; ${columns.length.toLocaleString()} have one.`,
      )
    }

    const product = readProduct(ctx.params.product)
    const result = await fetchTraces({
      product,
      columns,
      window,
      signal: ctx.signal,
      onProgress: ctx.progress,
      onCost: announceCost,
      refresh: ctx.refresh,
    })

    /*
     * Scattered per row rather than `set` wholesale, because unmatched rows sit between the
     * fetched ones and the fetched block is in request order. A `Float64Array` starts zeroed, so
     * `zero` is the absence of work and only `blank` writes anything into a gap.
     */
    const values = new Float64Array(cells)
    for (let row = 0; row < selected.length; row++) {
      const at = selected[row]!.at
      if (at === undefined) {
        // A `Float64Array` starts zeroed, so `zero` is the absence of work.
        if (fill !== 0) values.fill(fill, row * steps, (row + 1) * steps)
        continue
      }
      values.set(result.values.subarray(at * steps, (at + 1) * steps), row * steps)
    }

    return {
      traces: makeMatrix(
        selected.map((entry) => entry.label),
        stepLabels(window),
        values,
        traceValueLabel(product, conditionName),
      ),
    }
  },
})
