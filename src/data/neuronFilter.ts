/**
 * What a `FindNeuronsRequest` means to a source that answers **locally** — from rows it already
 * holds, rather than by compiling a query.
 *
 * Three sources do that: the mock filters its generated connectome, `CaveSource` filters the
 * neuron index it downloads once per datastack (CAVE has no server-side regex worth using and
 * the index is there anyway), and `CatmaidSource` does the same. A second copy of this logic is
 * how two backends come to disagree about whether `LC.*` matches `LPLC1` — which is not an error
 * anywhere, just a different set of neurons.
 *
 * The `rows` half is no longer written out here at all: `preparedRows` hands straight to
 * `filterRows.ts` and `terms.ts`, which are also what Explore's search box and the Table
 * viewer's header cells run on. One matcher rather than three that agree today.
 *
 * The rule it applies is neuPrint's, because neuPrint is the one with a server semantic to
 * match: Neo4j's `=~` matches the **whole** value, so a whole-string pattern is wrapped in
 * `^(?:…)$` (`anchoredPattern`). An unanchored local source would train the wrong intuition and
 * then silently change results the day the same graph is pointed at neuPrint.
 *
 * The other agreement is nulls. Cypher's `WHERE` keeps only *true*, and `null =~ p` is null — so
 * a neuron with no `hemilineage` is not a match for the empty string, or for anything else.
 * Everything below fails an absent value rather than coercing it to `''`.
 */

import type { PopulationFilter, TableSchema } from '../core/types'
import { columnNames, findColumn } from '../core/types'
import type { ColumnData, TableValue } from '../core/values'
import { selectRows } from '../core/values'
import type { FindNeuronsRequest, LabelMatch } from './source'
import { resolveRows } from './filterRows'
import type { PreparedFieldTerm } from './terms'
import { anchoredPattern, prepareFieldTerms } from './terms'

/**
 * Compile one anchored pattern, or say which field it came from.
 *
 * The anchoring itself is `anchoredPattern`, shared with the filter rows and the Cypher
 * compiler; what this adds is the error message, which names the field because an invalid
 * pattern reaches here from a control somebody has to go and fix.
 */
function anchored(pattern: string, field: string, flags = ''): RegExp {
  try {
    return new RegExp(anchoredPattern(pattern), flags)
  } catch (err) {
    throw new Error(`Invalid ${field} pattern /${pattern}/: ${(err as Error).message}`)
  }
}

/**
 * A predicate for `LabelMatch`, over a row read as a plain record.
 *
 * Undefined for an absent or empty match, which is the caller's signal to apply no filter at
 * all. That is *not* the same as the seam's "empty `values` matches nothing" rule: an empty
 * list never reaches here, because a lookup of nothing is answered before a request is built.
 * Keeping the two apart is what stops an unconfigured node returning a whole connectome.
 */
export function compileLabelMatch(
  match: LabelMatch | undefined,
): ((row: Record<string, unknown>) => boolean) | undefined {
  if (!match || match.values.length === 0) return undefined
  const { field, ignoreCase } = match

  let test: (text: string) => boolean
  if (match.regex) {
    const res = match.values.map((v) => anchored(v, field, ignoreCase ? 'i' : ''))
    test = (text) => res.some((re) => re.test(text))
  } else {
    const wanted = new Set(match.values.map((v) => (ignoreCase ? v.toLowerCase() : v)))
    test = (text) => wanted.has(ignoreCase ? text.toLowerCase() : text)
  }

  // The null rule, once: Cypher's `WHERE` keeps only true and `null =~ p` is null, so an absent
  // value fails every mode rather than being coerced to the empty string.
  return (row) => {
    const value = row[field]
    return value !== null && value !== undefined && test(String(value))
  }
}

/**
 * The request's rows, compiled against the index that will answer them.
 *
 * The whole of what a local source needs, in one call, and the reason it is one call is that the
 * three of them had each hand-rolled the same loop — compile `typeRe`, compile `instanceRe`,
 * build a status `Set`, call `compileLabelMatch` — and each got a different corner of it wrong.
 *
 * **An unfilterable row throws rather than matching nothing**, and that is the decision worth
 * defending. `prepareFieldTerms` marks a column the table does not have as `unknown`, which
 * matches no row: correct for the Table viewer, where a stale column name emptying the table
 * reads as a node that has broken and can be seen. Here it would answer a query with nothing at
 * all, which is indistinguishable from a dataset that genuinely holds no such neurons — the
 * exact failure `refuseUnfilterable` was written for one field at a time, when `CaveSource` read
 * `index.data.size` through `Number(undefined ?? 0)` and dropped every row.
 *
 * The message is `resolveRows`', so it names the field as the card labels it — which is what
 * somebody has to go and change. Normally unreachable: Find Neurons' `validate` reports the same
 * problems at edit time, off the same function, because a Dataset socket carries its schema
 * before anything runs. What gets here is a saved graph repointed at another backend.
 */
export function preparedRows(
  index: TableValue,
  req: Pick<FindNeuronsRequest, 'rows'>,
  backend: string,
): PreparedFieldTerm[] {
  const { terms, problems } = resolveRows(index.schema, req.rows ?? [])
  const problem = problems[0]
  if (problem) throw new Error(`${backend}: ${problem.message}`)
  return prepareFieldTerms(index, terms)
}

/**
 * Refuse a region filter a backend has no way to answer.
 *
 * All that is left of `refuseUnfilterable`, and the shrinkage is the point: `minSize` and
 * `statuses` used to need refusing because they were named fields of the request that a card
 * offered whatever the dataset was. They are rows now, and a row can only name a column the
 * dataset's own schema publishes — so `size` on a CAVE datastack is not a filter that gets
 * refused, it is a field that was never in the dropdown.
 *
 * A region cannot follow them, because it is not a column anywhere: in neuPrint a neuron carries
 * one boolean property per ROI it innervates. So this stays, and it stays a *refusal*. CATMAID
 * is the case that makes it necessary: `volumeList` fills `DatasetInfo.rois` with eighty real
 * neuropils so the ROI Viewer can draw them, and `findNeurons` cannot read a single one — a
 * populated dropdown that narrows nothing, whose result is too *large* and looks correct.
 *
 * An empty result and an unnarrowed one both look like answers, which is what makes a refusal
 * the only one of the three that can be acted on. It names the control as the card labels it.
 */
export function refuseUnfilterableRoi(
  req: Pick<FindNeuronsRequest, 'roi'>,
  backend: string,
): void {
  if (req.roi) {
    throw new Error(
      `${backend} cannot filter neurons by region, so "In ROI" cannot narrow this query. ` +
        `Set it back to Any to search this dataset.`,
    )
  }
}

// ---------------------------------------------------------------------------
// The population filters
// ---------------------------------------------------------------------------

/**
 * The neuron property that says how far a body has been reconstructed, and the value meaning
 * "proofread".
 *
 * One pair, because three places have to agree about it and two of them cannot see the third.
 * `findNeuronsCypher` compiles it to a `WHERE` clause the server evaluates; `populationRows`
 * below applies it to a neuron index already in memory; and the export emitters spell it as a
 * `NeuronCriteria(status='Traced')` in somebody's notebook. Three spellings of one string is how
 * a notebook comes to select a different set from the canvas it was exported from — and neither
 * would look wrong on its own.
 *
 * neuPrint's vocabulary, and deliberately not generalised. A backend that spells proofreading
 * some other way does not get this control at all, which is `DatasetBackend.population`'s job
 * rather than this constant's.
 *
 * That is the seam to watch if a second backend ever sets that flag. `PopulationFilter` is
 * backend-neutral *intent* by design, but the column names answering it are one backend's, sitting
 * here as module constants — CAVE spells the same two ideas `super_class` and `cell_type`. The
 * second backend is when this resolution moves onto `DataSource` beside `schemasFor`; doing it
 * now would be an interface method with one implementation and no second case to check it against.
 */
export const STATUS_COLUMN = 'status'
export const TRACED_STATUS = 'Traced'

/**
 * The one column `superclass` means. neuPrint's spelling; FlyWire's `super_class` is a different
 * backend's column and is not reached, for `TRACED_STATUS`' reason.
 */
export const SUPERCLASS_COLUMN = 'superclass'

/**
 * Columns that assign a cell type, matched by name: `type`, or anything **ending** in it.
 *
 * A suffix rather than a substring, and the difference decides whether the filter works at all.
 * Every column that assigns a type is named for what assigns it — `type`, `flywireType`,
 * `hemibrainType`, `mancType` — while the columns that merely *describe* one carry the word in
 * the middle: male-CNS publishes per-cell-type neurotransmitter predictions, and a column like
 * `celltypePredictedNt` is populated for very nearly every neuron. Folded into the OR below,
 * one of those makes "Typed only" pass every row in the dataset. That is the worst shape of
 * failure available here: the control is on, the card says so, and the count does not move.
 *
 * Case-insensitive, because the datasets are not consistent about it and a filter that read
 * `flywireType` and missed `flywire_type` would be a fact about capitalisation.
 *
 * Empty is a real answer — a dataset with no type column at all — and the caller is expected to
 * drop the filter rather than compile a clause matching nothing. See `resolvePopulation`.
 */
export function typeColumns(schema: TableSchema | undefined): string[] {
  return columnNames(schema).filter((name) => /type$/i.test(name))
}

/** Which columns each filter tests, or an empty list where this dataset cannot answer it. */
export function populationColumns(
  filter: PopulationFilter,
  schema: TableSchema | undefined,
): string[] {
  if (filter === 'typed') return typeColumns(schema)
  const name = filter === 'traced' ? STATUS_COLUMN : SUPERCLASS_COLUMN
  return findColumn(schema, name) ? [name] : []
}

/**
 * The filters this dataset can actually answer, in a stable order.
 *
 * A filter naming a column the dataset does not publish is **dropped**, never compiled: the old
 * request-level `Traced` default filtered a CAVE datastack on a field it does not have and
 * returned nothing at all, for a value nobody chose. Dropping errs the other way — too many rows
 * rather than none — which is the direction somebody can see, and the dataset node warns.
 *
 * Order is the declaration order rather than the caller's, so two nodes asking for the same set
 * of filters produce the same clause and the same provenance key whichever way they were ticked.
 */
export const POPULATION_FILTERS: readonly PopulationFilter[] = ['traced', 'typed', 'superclass']

/**
 * The precedence rule: an explicit `status` filter **removes the `traced` disjunct**.
 *
 * Stated once because it is stated in four places otherwise — the Cypher compiler and both
 * emitters, twice each — and every copy is a chance for one of them to AND instead. ANDing turns
 * `status is Assign` under a traced dataset into `n.status = 'Assign' AND n.status = 'Traced'`:
 * zero rows for a value nobody chose, which is the failure that got the old request-level
 * `Traced` default removed.
 *
 * It removes only that disjunct. A dataset also asking for `typed` keeps the rest of the group,
 * and the row simply ANDs with it.
 */
export function withoutStatedStatus(
  population: readonly PopulationFilter[],
  statusStated: boolean,
): PopulationFilter[] {
  return population.filter((f) => !(f === 'traced' && statusStated))
}

export function resolvePopulation(
  population: readonly PopulationFilter[] | undefined,
  schema: TableSchema | undefined,
): PopulationFilter[] {
  if (!population?.length) return []
  return POPULATION_FILTERS.filter(
    (f) => population.includes(f) && populationColumns(f, schema).length > 0,
  )
}

/** Whether one cell counts as a value somebody entered. Null and `''` are both absent. */
function present(cell: unknown): boolean {
  return cell !== null && cell !== undefined && cell !== ''
}

/**
 * Row indices this population keeps, or undefined when there is nothing to narrow by.
 *
 * Undefined rather than "every row" when the list resolves to nothing, and the two are not the
 * same answer: the caller passes the table through untouched, where an empty selection would
 * blank a dataset for a value nobody chose.
 *
 * **The filters are OR-ed** — see `PopulationFilter`. So is `typed` internally, across however
 * many type columns the dataset has: a neuron carrying a `flywireType` and no `type` is a typed
 * neuron. One `some` over a flat list of predicates rather than a nest, because the two levels
 * mean the same thing and writing them as two would invite one of them to become an `every`.
 *
 * Nulls fail every test, matching the comparisons this stands in for at the server: `null =
 * 'Traced'` is null in Cypher and `WHERE` keeps only true.
 */
export function populationRows(
  table: TableValue,
  population: readonly PopulationFilter[] | undefined,
): number[] | undefined {
  return rowsFor(table, resolvePopulation(population, table.schema))
}

/**
 * The scan itself, over filters already resolved against this table's schema.
 *
 * Split from `populationRows` so `narrowPopulation` resolves once rather than twice — it needs
 * the resolved list for its own cache key, and re-resolving inside meant a regex sweep of the
 * schema per filter, done again for nothing.
 *
 * The columns are gathered into two flat arrays rather than a list of predicates, and the scan
 * is an indexed loop. At 165k rows a closure per row is 165k allocations and a megamorphic call
 * per test; this is one comparison per column with nothing allocated. It reads longer than
 * `tests.some(...)` and is the one place in this file where that trade is worth making.
 */
function rowsFor(
  table: TableValue,
  resolved: readonly PopulationFilter[],
): number[] | undefined {
  if (resolved.length === 0) return undefined

  /** Columns tested against `TRACED_STATUS`, and columns tested for a value. */
  const exact: ColumnData[] = []
  const nonEmpty: ColumnData[] = []
  for (const filter of resolved) {
    for (const name of populationColumns(filter, table.schema)) {
      const column = table.data[name]
      if (column) (filter === 'traced' ? exact : nonEmpty).push(column)
    }
  }
  if (exact.length === 0 && nonEmpty.length === 0) return undefined

  const rows: number[] = []
  outer: for (let i = 0; i < table.length; i += 1) {
    for (const column of exact) {
      if (column[i] === TRACED_STATUS) {
        rows.push(i)
        continue outer
      }
    }
    for (const column of nonEmpty) {
      if (present(column[i])) {
        rows.push(i)
        continue outer
      }
    }
  }
  return rows
}

/**
 * Narrowed tables, per index and population.
 *
 * **Not an optimisation — a correctness-of-identity one.** `searchIndexFor` memoises Explore's
 * 24 MB haystack in a `WeakMap` keyed by table *identity*, so a fresh `TableValue` per call
 * meant the node rebuilt that haystack on every Run and the card built a second one beside it,
 * for the same rows. Handing back one object per (index, population) restores the single
 * haystack the shared neuron index had before any of this existed.
 *
 * `WeakMap`, so a dropped index takes its narrowings with it — the entries are views on a 26 MB
 * table and a strong map here would be the cache that never lets one go.
 */
const narrowed = new WeakMap<TableValue, Map<string, TableValue>>()

/**
 * A neuron table narrowed to this population, or the table itself.
 *
 * The whole of what the checkboxes mean once the rows are already in hand, which is the shape
 * the neuron index is always in: the index is downloaded and cached **unfiltered**, so Explore's
 * promise that an empty search box shows the whole dataset is a matter of not calling this, and
 * a dataset read two ways shares the single 26 MB table rather than paying for two of them under
 * two cache keys.
 *
 * Returns the *same object* when there is nothing to do, and the same object each time for a
 * given population. Nodes treat columns as immutable, so sharing is safe, and every consumer
 * downstream is keyed by table identity.
 */
export function narrowPopulation(
  table: TableValue,
  population: readonly PopulationFilter[] | undefined,
): TableValue {
  const resolved = resolvePopulation(population, table.schema)
  if (resolved.length === 0) return table

  const key = resolved.join('\u0001')
  let byPopulation = narrowed.get(table)
  if (!byPopulation) {
    byPopulation = new Map<string, TableValue>()
    narrowed.set(table, byPopulation)
  }
  let result = byPopulation.get(key)
  if (!result) {
    const rows = rowsFor(table, resolved)
    result = rows ? selectRows(table, rows) : table
    byPopulation.set(key, result)
  }
  return result
}
