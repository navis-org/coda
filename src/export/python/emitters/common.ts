/**
 * Expressions more than one emitter needs.
 *
 * Small, but each of these was written out three or four times before it lived here — and a
 * second copy of "how do I get the neuron ids out of a frame" is how two cells end up disagreeing
 * about which column that is.
 */

import type { PopulationFilter, TableSchema } from '../../../core/types'
import { datasetRef } from '../../../core/types'
import { TRACED_STATUS, populationColumns } from '../../../data/neuronFilter'
import { pyIdList, pyStr } from '../py'
import type { EmitContext } from '../types'

/**
 * The neuron ids a Neurons input stands for.
 *
 * Coda passes a whole collection between nodes and pulls `neuronId` out at the seam
 * (`idColumn`), so the Python has to do the same — a DataFrame is not a criteria object, and
 * handing one to `NeuronCriteria` fails at a point far from the cause.
 */
export function neuronIds(frame: string): string {
  return `${frame}['neuronId'].tolist()`
}

/**
 * The same ids, as the **integers a backend library's parameter takes**.
 *
 * The two exist because the notebook has two vocabularies in it and only one of them is Coda's.
 * A Coda column is text — invariant 8, and `coda_neurons` casts it as it renames — so `isin`,
 * a join, a `groupby` and every helper in this exporter compare text. But
 * `NeuronCriteria(bodyId=…)` and `neu.fetch_skeletons(…)` are neuprint-python's, and neuPrint's
 * `bodyId` is an integer: hand it strings and the Cypher it builds quotes them, matching
 * nothing and raising nothing.
 *
 * So the rule for a reader — and for the next emitter — is that the cast marks the boundary.
 * `neuronIds` inside the document, `neuronIdInts` at the moment it leaves for a library, and a
 * cell that mixes them up fails loudly at the call rather than quietly in a comparison.
 *
 * `int64` rather than Python's `int` because it is a pandas cast on a column: a CAVE root id is
 * eighteen digits and fits (int64 tops out around 9.2 × 10^18), where the float64 that a plain
 * `astype(float)` or a JSON round trip would give it does not.
 *
 * `limit` takes the node's `Limit` cap, because Skeletons and Meshes fetch a capped list and
 * were otherwise respelling `.astype('int64').tolist()` by hand — which is the one thing a
 * function whose whole purpose is to own that string must not leave to a call site. `head`
 * before the cast, so the cast runs over the rows that will be used rather than the whole column.
 */
export function neuronIdInts(frame: string, limit = 0): string {
  const head = limit > 0 ? `.head(${limit})` : ''
  return `${frame}['neuronId']${head}.astype('int64').tolist()`
}

/**
 * A viewer's `ids` selection param, as **exact decimal text**.
 *
 * `kind: 'ids'` params are written by widgets and live in the saved file, so the value is
 * whatever was last stored — an array normally, and absent on a graph saved before the param
 * existed.
 *
 * It used to answer `number[]`, which is invariant 8 at a seam nobody had looked at: a stored id
 * is a string of digits, and `Number('720575940628857210')` is `720575940628857216` — a
 * different neuron, written into a notebook with nothing to say so. Harmless while every
 * exportable dataset was neuPrint, whose nine-to-eleven-digit ids are exact as doubles, and live
 * the moment a CAVE selection can be exported at all. Emit with `pySelection`, which quotes the
 * digits to match the `str` id column every source publishes — and with `decodeIndices`
 * (`nodes/lib/chartSelection.ts`) instead where the param holds leaf positions rather than ids.
 */
export function selectionIds(ctx: EmitContext, paramId = 'selection'): string[] {
  const raw = ctx.params[paramId]
  return Array.isArray(raw) ? raw.map((id) => String(id).trim()).filter(Boolean) : []
}

/**
 * A selection as a Python list literal, wrapped if long.
 *
 * Paired with `selectionIds` deliberately, the way `codaNeurons` pairs a declaration with its
 * call: the ids come back as **text** so no digit is lost, and the literal has to match the
 * column it is compared against. Nothing type-checks that pairing, so it is one function rather
 * than five call sites remembering.
 *
 * It emits **quoted** ids, and it used to emit unquoted integers. Every one of these five sites
 * compares a selection against a *Coda* column — `isin`, or a frame built to be joined — and a
 * Coda id column is text on every source now (invariant 8). `isin([1001])` against a string
 * column matches nothing at all and says nothing, which is the same silent shape the previous
 * spelling avoided in the other direction: `isin(['1001'])` against an `i64` column. A neuPrint
 * *library* parameter still takes integers and still goes through `pyLongIntList`; the two
 * literals are `neuronIds` and `neuronIdInts` one level down, and for the same reason.
 */
export function pySelection(ids: readonly string[]): string {
  return pyIdList(ids).join('\n')
}

/**
 * Normalise a frame that has just come back from neuprint-python.
 *
 * The library publishes `bodyId`; every Coda table calls the id column `neuronId`, so an
 * unrenamed frame meets the next generated cell — a Filter, a Group By, anything carrying a
 * column param — addressing a column it does not have.
 *
 * **It declares the helper and emits the call together**, which is the whole point of it being
 * a function. Those are two separate acts at a call site — `ctx.helper('coda_neurons')` in one
 * place and the assignment line in another — and `resolveHelpers` only writes out helpers that
 * were asked for, so a site that emits the call and forgets the declaration produces a notebook
 * referring to a function nothing defines. That is invisible to the golden file, which only
 * looks right because *some other* node in the fixture happened to request it; `neuron.roiCounts`
 * had already lost the pairing that way.
 */
export function codaNeurons(ctx: EmitContext, frame: string): string {
  ctx.helper('coda_neurons')
  return `${frame} = coda_neurons(${frame})`
}

/**
 * The same declare-and-call pairing for `coda_ids`, wherever an emitter *mints* a Coda id column.
 *
 * `codaNeurons` covers the frames that arrive from neuprint-python; this covers the ones the
 * document builds itself — an edge list renamed out of `bodyId_pre`, a label column read as ids.
 * Those were being typed by hand, and each hand-typed one picked a different answer:
 * `astype('int64')` in `cluster.selectedToNeurons`, nothing at all elsewhere. A Coda id column is
 * text on every source, so a notebook that types one as an integer disagrees with the canvas
 * about the column everything joins by, and `merge` then matches nothing without erroring.
 *
 * The helper is idempotent (a `string` column is cast straight through), so a frame that reaches
 * two of these seams pays a no-op rather than needing anyone to work out which one owns it.
 *
 * **The rule, rather than the list of sites it was found at:** an emitter that produces a column
 * named by `ID_COLUMN_NAME` — or renames one onto it — ends in this. It is written that way
 * because enumerating the seams is what missed two of them, both of which sat in a regenerated
 * golden looking plausible: `shapingLines` renamed an uploaded column onto `neuronId` without
 * retyping it, and the unwired `Input IDs` branch built a frame from an integer list. Where a
 * rename is involved the retype belongs *with* it, since that is how `uploadShapeSchema` states
 * the same thing on the canvas.
 */
export function codaIds(ctx: EmitContext, frame: string, ...columns: string[]): string {
  ctx.helper('coda_ids')
  return `${frame} = coda_ids(${frame}, ${columns.map(pyStr).join(', ')})`
}

/**
 * The same pairing for a synapse frame: `coda_synapses` renames neuprint-python's `type`
 * (which means pre or post) onto Coda's `polarity`.
 *
 * Its own function rather than an argument to `codaNeurons`, because the two are applied to
 * one frame in turn and each is guarded on a different column — one helper taking a rename map
 * would carry both guards and read as one rule where there are two.
 */
export function codaSynapses(ctx: EmitContext, frame: string): string {
  ctx.helper('coda_synapses')
  return `${frame} = coda_synapses(${frame})`
}

/**
 * Is the dataset on this port a CAVE datastack?
 *
 * Read off the resolved *type*, which carries the source id — the same thing the walk's backend
 * guard reads, so an emitter branching on this and the guard letting it through cannot disagree
 * about which backend a node is on.
 *
 * An emitter that asks this has to declare `backends: ['neuprint', 'cave']`, or the guard turns
 * it into a TODO before the branch is ever reached.
 */
export function isCaveDataset(ctx: EmitContext, portId = 'dataset'): boolean {
  return datasetRef(ctx.inputType(portId))?.sourceId === 'cave'
}

/**
 * The neuron table a CAVE dataset labels its neurons with — Coda's index, one row per neuron.
 *
 * `CodaCaveDataset.labels`, which is fetched on first use and is exactly what `CaveSource`
 * builds: the datastack's neuron table joined to its annotations, or whatever an Annotations
 * source supplied instead. Every node that would otherwise download an index goes through this,
 * so a graph with three of them pays for one.
 */
export function caveLabels(dataset: string): string {
  return `${dataset}.labels`
}

/**
 * The population as a pandas mask over a fetched frame, or no lines at all.
 *
 * **A mask rather than criteria, and that is forced.** `NeuronCriteria` ANDs its keyword
 * arguments and has no null test at all, so it can express exactly one of these — a lone
 * `traced`, which `emitFindNeurons` pushes instead of coming here. Everything else is either a
 * non-empty test it cannot say or an OR it would turn into an AND, which is a smaller set of
 * neurons under a cell that looks right.
 *
 * `.notna() & != ''` rather than `.astype(bool)`: the two disagree on the string `'0'`, and Coda
 * counts a value somebody entered as present whatever it says.
 */
export function pyPopulationMask(
  frame: string,
  filters: readonly PopulationFilter[],
  schema: TableSchema | undefined,
): string[] {
  const parts: string[] = []
  for (const filter of filters) {
    for (const name of populationColumns(filter, schema)) {
      const col = `${frame}[${pyStr(name)}]`
      parts.push(
        filter === 'traced'
          ? `(${col} == ${pyStr(TRACED_STATUS)})`
          : `(${col}.notna() & (${col} != ''))`,
      )
    }
  }
  return pyMaskFrame(frame, parts, '|')
}

/**
 * `frame = frame[…]` over a list of masks, on one line or wrapped.
 *
 * Shared with `maskLines`, which does the same for a node's own filter rows and differs only in
 * joining with `&`. Each mask is already parenthesised by its builder and stays that way here:
 * Python binds `&` tighter than `|`, so the unbracketed form happens to group correctly today
 * and stops doing so the first time somebody edits a clause — and in a notebook nobody
 * re-derives operator precedence before trusting a row count.
 */
export function pyMaskFrame(
  frame: string,
  masks: readonly string[],
  join: '&' | '|',
): string[] {
  if (masks.length === 0) return []
  if (masks.length === 1) return [`${frame} = ${frame}[${masks[0]}]`]
  return [
    `${frame} = ${frame}[`,
    ...masks.map((mask, i) => `    ${i === 0 ? '' : `${join} `}${mask}`),
    ']',
  ]
}
