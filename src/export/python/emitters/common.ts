/**
 * Expressions more than one emitter needs.
 *
 * Small, but each of these was written out three or four times before it lived here — and a
 * second copy of "how do I get the neuron ids out of a frame" is how two cells end up disagreeing
 * about which column that is.
 */

import type { PopulationFilter, TableSchema } from '../../../core/types'
import { datasetRef } from '../../../core/types'
import { backendOf } from '../../../data/source'
import { TRACED_STATUS, populationColumns } from '../../../data/neuronFilter'
import { ID_COLUMN_NAME } from '../../../core/ids'
import { carryable } from '../../../nodes/lib/carryParams'
import { pyIdList, pyList, pyStr } from '../py'
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
  // The cap goes *before* the cast, which is the one thing not to tidy into `neuronIdKey`
  // below: casting the whole column to reach twenty ids is more rows converted than the cell
  // asked for, and a malformed id past the cap would raise where the fetch never looked.
  return `${idSeries(frame)}${head}.astype('int64').tolist()`
}

/**
 * The same ids as a Cypher list literal, for a query whose id placeholder the cell fills when it
 * runs (`CYPHER_PLACEHOLDERS`). `str` of a list of ints is exactly one: `[1, 2]`.
 */
export function cypherIdList(frame: string): string {
  return `str(${neuronIdInts(frame)})`
}

/**
 * The same ids as an index-shaped Series, for a `set_index` or a `reindex`.
 *
 * Split out when `Carry fields` needed the cast without the `.tolist()` and wrote it by hand two
 * lines below a `neuronIdInts` call — the `'neuronId'` literal in a third place, where a change
 * to the id convention would have missed that cell in silence. The column name is `idSeries`'
 * now; the cast is deliberately spelled in both, since the two differ on where the cap goes.
 */
function neuronIdKey(frame: string, column: string): string {
  return `${idSeries(frame, column)}.astype('int64')`
}

/**
 * The id column of a frame that has been through `coda_neurons`. One spelling of the name.
 *
 * The column is an argument only for `Attach Attributes`, whose key is a picker: the ids it
 * matches on may be under any name (`label` on a Reduce Matrix), while the cast stays the one
 * this file owns — `fetch_skeletons` assigns `n.id = r.bodyId` as an integer, so a `str` key
 * matches nothing and `na='propagate'` fills every neuron with `None`.
 */
function idSeries(frame: string, column = ID_COLUMN_NAME): string {
  return `${frame}[${pyStr(column)}]`
}

/**
 * Attributes navis computes itself, which `set_neuron_attributes` cannot write.
 *
 * **Measured, not recalled**: `setattr` on a `navis.TreeNeuron` was tried for each candidate
 * against navis 2.0.0-rc.1, and these five raise — `type` and `cable_length` an
 * `AttributeError` (read-only properties), `soma` a `ValueError`, `nodes` and `connectors` a
 * `TypeError`. Here rather than in one emitter because two of them turn on the same facts:
 * `Carry fields` skips these names, and `neuron.splitNeurons` refuses partly because
 * `NeuronList.summary()`'s `type` is the neuron *class* (`'navis.Skeleton'`) rather than a cell
 * type. Two copies of a data model measured once is how the two come to disagree.
 *
 * Spelled in navis' snake_case while the names checked against it are Coda columns, so only some
 * are reachable at all: `type` is the one that matters on neuPrint — it is the collision case,
 * since overriding a stale connectome `type` is the commonest reason to carry a colliding name —
 * and `nodes` exists only in CATMAID's schema, which these neuPrint-only emitters never see.
 */
const NAVIS_RESERVED: ReadonlySet<string> = new Set([
  'type',
  'soma',
  'connectors',
  'nodes',
  'cable_length',
])

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
 * **The rule, rather than the list of sites it was found at:** an emitter that *renames* a column
 * onto an id name ends in this, and the retype belongs with the rename rather than after it —
 * which is how `uploadShapeSchema` states the same thing on the canvas. Enumerating the seams is
 * what missed two, both of which sat in a regenerated golden looking plausible: `shapingLines`
 * renamed an uploaded column onto `neuronId` without retyping it, and the unwired `Input IDs`
 * branch built a frame from an integer list.
 *
 * Not `ID_COLUMN_NAME` only — `preId`/`postId` go through it too, which is why it is varargs.
 *
 * **A column *minted* from a literal is the other half, and this cannot state it**: there is no
 * rename to hang on, so the fix is to write the literal already typed (`pd.Series([], dtype=
 * 'string')` in `viewers.ts`) rather than to cast an empty frame afterwards. Casting is for a
 * column that arrived; typing is for one you are writing.
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
  // Any deployment's: `cave` is only the default one's id (`caveSourceId`).
  return backendOf(datasetRef(ctx.inputType(portId))?.sourceId ?? '') === 'cave'
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

/**
 * Columns of a frame written onto a `NeuronList` as per-neuron attributes.
 *
 * Two callers: the `Carry fields` param on Skeletons and Meshes, which passes its own list and
 * the id column, and `neuron.attachAttributes`, which passes a picked list and a picked key. The
 * navis call, the reserved-name refusal and the rules below are the same for both, which is why
 * this is one function and not one per node.
 *
 * The faithful spelling, and it is navis' own: `NeuronList.set_neuron_attributes` takes a
 * `{neuron.id: value}` dict, and `register=True` is what puts the attribute in
 * `NeuronList.summary()` — which is where a reader looks for it and what `plot3d(color_by=)`
 * reads. `na='propagate'` fills `None` for a neuron the dict does not cover, which is exactly
 * Coda's left join: the neuron keeps its geometry and the field is absent. All three arguments
 * were read off the installed signature, and the call was run against a synthetic list.
 *
 * **The dict is keyed by `neuronIdKey`, the same expression that named the bodies.**
 * `fetch_skeletons` assigns `n.id = r.bodyId`, an integer, and `neuronIdInts` is what this cell
 * passed it — so the two are one function now rather than two spellings of a cast. A `str` key
 * would match nothing and `na='propagate'` would fill every neuron with `None`: a cell that runs
 * and carries an empty column, which is the failure shape this exporter minds most.
 *
 * The column filter is **`carryable`**, imported rather than restated: this function had its own
 * weaker filter (the right key only) and so assigned over the geometry's own id whenever a table
 * carried a `neuronId` of its own under `Attach Attributes`' every-column default. Neither golden
 * can discriminate that — no fixture table has both a `neuronId` and a different key — so the
 * predicate's own unit test is the pin. See `carryParams.test.ts`.
 *
 * **`drop_duplicates` before `set_index`, because `to_dict` is last-wins and Coda is first.**
 * `joinTables` deduplicates the side being matched into with the *first* occurrence winning, and
 * the node's own test pins it; a bare `set_index(...).to_dict()` keeps the last, so a neuron
 * listed twice upstream would be annotated from a different row here than on the canvas. Found by
 * reading the two rules against each other rather than by running it, which is why it is written
 * out with the reason attached.
 */
export function carryLines(
  ctx: EmitContext,
  list: string,
  frame: string,
  carry: readonly string[],
  /** The frame column holding the ids, matched against `neuron.id`. */
  keyColumn: string,
): string[] {
  if (carry.length === 0) return []
  const carried = carry.filter((name) => carryable(name, keyColumn))

  const refused = carried.filter((name) => NAVIS_RESERVED.has(name))
  const writable = carried.filter((name) => !NAVIS_RESERVED.has(name))
  const lines: string[] =
    refused.length > 0
      ? ctx.note(
          `This node carries ${refused.map((n) => `\`${n}\``).join(', ')} onto the geometry, ` +
            'and navis computes that attribute itself — `type` is the neuron class, ' +
            '`cable_length` and `soma` are read off the skeleton — so it cannot be set on a ' +
            'neuron and is left out here. Rename the column upstream if the notebook needs it.',
        )
      : []
  if (writable.length === 0) return lines

  const keyed = `${ctx.name}_carry`
  lines.push(
    // Columns subset *before* the dedupe, which is the whole-frame copy: under
    // `Attach Attributes`' every-column default the frame can be a 165k-row neuron table, and
    // the dicts below only ever read these.
    `${keyed} = ${frame}[${pyList([keyColumn, ...writable])}]`,
    `${keyed} = ${keyed}.drop_duplicates(subset=${pyStr(keyColumn)}, keep='first')`,
    `${keyed} = ${keyed}.set_index(${neuronIdKey(keyed, keyColumn)})`,
  )
  for (const name of writable) {
    lines.push(
      `${list}.set_neuron_attributes(`,
      `    ${keyed}[${pyStr(name)}].to_dict(),`,
      `    name=${pyStr(name)},`,
      // Registered, or the attribute is on the neurons and in no summary a reader would see.
      `    register=True,`,
      // Coda's left join: a neuron the table upstream does not mention keeps its geometry.
      `    na='propagate',`,
      `)`,
    )
  }
  return lines
}
