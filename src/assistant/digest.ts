/**
 * What a run produced, in lines for the user turn.
 *
 * The other half of the answer `describeGraph` already gives. Inference says what a port
 * *carries* — the column names — and that closed the half of "can the assistant inspect
 * results" that needed no tool. This closes the other half, and it needed no tool either,
 * because of what the remaining questions turn out to be: which value to filter on, what a
 * threshold should be, why a table came back empty, whether a `Limit` is reasonable. Every one
 * of those is an **aggregate**. None of them is a row. Aggregates can be pushed into the
 * prompt; rows would have had to be asked for.
 *
 * That is the whole design. A tool loop would need `tools` and `format` phase-separated (they
 * cannot be sent together — the grammar wins from token 0 and a model narrates the call instead
 * of making it), a second prompt shape and prefill, and a loop across four provider APIs that
 * disagree. This costs an extra pass over cached data and nothing on the wire.
 *
 * **It reads only what is already in memory.** Nothing here fetches, and nothing here may ever
 * fetch: query nodes hit a shared production database, and a summariser that could reach one
 * would be invariant 6's `cheap`/`expensive` decision handed to a model. What has not been run
 * has no line, which is the same thing a missing `carries:` line means.
 *
 * ## Three rules that keep it from being confidently wrong
 *
 * **A folded list is not the set of values.** Eight of sixty-one cell types, printed bare, is an
 * invitation to write a filter that silently excludes fifty-three — so the count is in the line
 * (`61 distinct, 8 commonest:`) and `RULES` says what that means. Same rule as `+N more` on a
 * legend and `colours repeat` in a caption: where a fold happens, its cost is said out loud.
 *
 * **Values are only printed for columns a value can be written into.** A numeric column gets a
 * range and never a list, which falls out of `describeOps`' own `isQuantitative` and takes
 * invariant 8 with it: an 18-digit root id in a float64 cell is already a different neuron, so
 * listing one as a value the model could copy is the one way this module could invent a
 * neuron. The id column gets a distinct count and nothing else, which is `describeOps`' rule
 * for the same reason, one layer up.
 *
 * Its limit, stated because it is deliberate: `ID_COLUMN_NAME` is the *only* column known to
 * hold ids, so Connectivity's `preId`/`postId` come out as an ordinary numeric range — the same
 * range `out.describe` prints for them on the card. Catching those would mean a second answer
 * to "which column is an id", spelled as a name pattern, and invariant 8's whole point is that
 * there is one definition and no second spelling of it. A range is also not a value a plan can
 * copy, which is the harm the rule above is actually about.
 *
 * **The arithmetic is `describeOps`', not a second copy of it.** `describeTable` already decides
 * what counts as absent (`valueLabel`), what `unique` deduplicates on, and which of the nine
 * quantile definitions a median is — and it memoises. Two implementations of that would let the
 * Describe node and the assistant quote different medians of the same column, which is a
 * disagreement nobody would think to look for. Only the value *counts* are added here, being
 * the one thing a summary of columns does not carry.
 */

import { ID_COLUMN_NAME } from '../core/ids'
import type { CodaType } from '../core/types'
import type { CellValue, TableValue, Value } from '../core/values'
import { isTableValue } from '../core/values'
import { statsFor } from '../nodes/lib/datasetStats'
import { describeTable } from '../nodes/lib/describeOps'

/**
 * How many distinct values are printed for one column.
 *
 * Eight because that is how many a reader — human or not — can hold as a set while reading the
 * next line, and because past it the line stops being a list and becomes a paragraph. It is
 * deliberately *not* tied to `MAX_SERIES`, which is a palette's capacity and a fact about
 * colour rather than about text.
 */
const TOP_VALUES = 8

/**
 * Cells above which a table is counted and not summarised.
 *
 * `describeOps` has a threshold of its own at 2,000,000, and it is the wrong one to borrow: that
 * is where a node somebody *added* starts warning, and this runs unasked on every question. A
 * digest that spent four seconds sorting a 400k-row table before a model had seen the request
 * would be a hang with no cause on screen — the failure this whole panel keeps having.
 *
 * `describeTable` memoises per value, so the cost is paid once per result rather than per
 * question; the ceiling is for the first one.
 */
const CELLS_MAX = 250_000

/**
 * Columns above which the rest are counted rather than described.
 *
 * A ceiling on the *text*, where `CELLS_MAX` is one on the work, and it is not the same
 * question: `core.pivot` emits one column per distinct value of the column it pivots on, so a
 * pivot over cell type is a table with hundreds of narrow columns and very few cells. It would
 * pass the cell ceiling and then spend the whole graph's budget in one node.
 *
 * Twenty-four because the widest thing a query node produces is well under it — `Connectivity`
 * is seven, a fully-annotated neuron table around fifteen — so this only ever fires on a table
 * whose columns *are* the data, which is the case where naming twenty-four of them says as much
 * as naming all of them.
 */
const COLUMNS_MAX = 24

/**
 * How much of the user turn the whole digest may take.
 *
 * A ceiling on the graph rather than on a node: one big table is worth more than twelve small
 * ones and a per-node cap could not express that. Roughly a third of what the graph listing
 * itself costs on a large canvas — enough for every node on an ordinary one, and on a large one
 * the nodes that lose their detail are counted rather than dropped in silence.
 */
const BUDGET_CHARS = 3500

/** Where the values live. Supplied by the store, which is the only thing that knows both. */
export interface ResultReader {
  /**
   * Whether this node's cached result is the answer to the graph *as it now stands*.
   *
   * The load-bearing half. A cache entry is keyed by provenance, so a node whose params moved
   * still holds the numbers its previous settings produced — and a digest built from those
   * describes a graph that no longer exists, in a line that reads exactly like a current one.
   * The store answers this from the run state, which is the same comparison `refreshStates`
   * makes.
   */
  fresh(nodeId: string): boolean
  output(nodeId: string, portId: string): Value | undefined
}

/**
 * What the walk over a graph has to remember: how much is left, and what it has already said.
 *
 * A tiny object rather than a running integer threaded through five signatures, because what
 * callers need is the *decision* — "is there room for a pass over this table" — and a number
 * leaves each of them to make it.
 *
 * **`sameAs` is the half that was measured rather than designed in.** A passthrough chain
 * summarises to the same lines at every step — a Sort reorders rows and changes no per-column
 * aggregate, a Table viewer's `out` and `filtered` are the same table with no filter set — so
 * the wizard's own seven-node demo emitted one four-line block **four times**, 2,257 characters
 * of which about six hundred said anything. Naming the port it matches is better than dropping
 * it, because "these two are the same table" is itself worth knowing and costs one line.
 */
export interface DigestState {
  /** Is there room left for the pass a column summary costs? */
  room(): boolean
  /** Record what was emitted, and return it, so nothing can be printed without being counted. */
  emit(lines: readonly string[]): string[]
  /** Nodes that got a headline and no detail, so the shortfall can be said out loud. */
  skipped(): number
  skip(): void
  /** Where these exact lines were first emitted, or `undefined` — which records them. */
  sameAs(where: string, lines: readonly string[]): string | undefined
}

export function digestState(): DigestState {
  let spent = 0
  let short = 0
  const seen = new Map<string, string>()
  return {
    room: () => spent < BUDGET_CHARS,
    emit: (lines) => {
      for (const line of lines) spent += line.length + 1
      return [...lines]
    },
    skipped: () => short,
    skip: () => {
      short += 1
    },
    sameAs: (where, lines) => {
      if (lines.length === 0) return undefined
      const key = lines.join('\n')
      const first = seen.get(key)
      if (first) return first
      seen.set(key, where)
      return undefined
    },
  }
}

/** `4,252` — thousands separated, because a run's row count is read rather than computed. */
function count(n: number): string {
  return n.toLocaleString('en-US')
}

/** `1 … 187` — a number as a person reads it, not as JSON prints it. */
function num(value: CellValue): string {
  if (typeof value !== 'number') return String(value)
  if (Number.isInteger(value)) return count(value)
  // Three significant figures: a fraction's fourth digit is never what a threshold turns on.
  return String(Number(value.toPrecision(3)))
}

/**
 * What this value *is* — one line, and no pass over the data.
 *
 * Separate from `valueColumns` so the budget can be checked before anything is computed: a
 * headline is free, and the pass behind the detail is the only cost in this file.
 *
 * Total: what to *say* is this function's job, and whether to say anything is `saysNothingNew`'s
 * one line below. Splitting them keeps a formatter that always formats.
 */
function valueHeadline(value: Value): string {
  switch (value.kind) {
    case 'table':
    case 'neurons':
      return `${count(value.length)} rows`
    case 'matrix':
      return `${count(value.rowLabels.length)} × ${count(value.colLabels.length)} matrix${
        value.measure ? ` of ${value.measure}` : ''
      }`
    case 'network':
      return `network — ${count(value.nodes.length)} nodes, ${count(value.edges.length)} links`
    case 'number':
    case 'string':
    case 'boolean':
      return `value ${JSON.stringify(value.value)}`
    case 'dataset':
      return `dataset ${value.datasetId}`
    case 'transform':
      return 'a transform'
    case 'skeletons':
      return `${count(value.items.length)} skeletons`
    case 'meshes':
      return `${count(value.items.length)} meshes`
    case 'points':
      return `${count(value.positions.length / 3)} points`
    case 'layout':
      return `${count(Object.keys(value.positions).length)} placed nodes`
    case 'linkage':
      return `linkage over ${count(value.labels.length)} leaves`
    case 'layers':
      return `${count(value.items.length)} layers`
    default: {
      // A new `Value` kind fails to compile here rather than reaching the model as nothing.
      const unhandled: never = value
      return String(unhandled)
    }
  }
}

/**
 * A value whose content its node's own params already decided, so a run is not news about it.
 *
 * A Dataset node printed `ran: dataset — dataset optic-lobe-mini` under a line already reading
 * `dataset.mock.opticlobe` — the node's own type restated at the top of the largest per-request
 * block in the prompt. A Transform is the same shape. Found by a test written to check
 * something else, which is the only way a line like that gets noticed.
 *
 * A predicate rather than a `undefined` out of `valueHeadline`, because it is a claim about
 * these two kinds and not about the absence of text: here it can be read, and it leaves the
 * formatter total.
 */
function saysNothingNew(value: Value): boolean {
  return value.kind === 'dataset' || value.kind === 'transform'
}

/**
 * `ran:` — what a node's ports last produced, when that is still what its settings ask for.
 *
 * **Only a fresh node answers**, and that is the whole of what makes the lines safe to act on. A
 * cache entry is keyed by provenance, so a node whose params moved is still holding the numbers
 * its *previous* settings produced — and those describe a graph that no longer exists in a line
 * indistinguishable from a current one. Absence is the fallback, which the rules already give a
 * meaning to: unknown, never none.
 *
 * Here rather than in `describeGraph`, so that everything about the ceilings lives with the
 * ceilings: emitting a line *is* spending against the budget (`emit` returns what it counted),
 * where a caller holding the state had to write each line twice — once to the accountant and
 * once to the output — and a branch that forgot the first would disable `BUDGET_CHARS` in
 * silence.
 *
 * The headline is free and the detail costs a pass, so the budget is asked *between* the two —
 * a node past the ceiling still says how many rows it has, which is the half most answers need.
 */
export function resultLines(
  nodeId: string,
  outputs: Readonly<Record<string, CodaType>>,
  results: ResultReader | undefined,
  state: DigestState,
): string[] {
  if (!results?.fresh(nodeId)) return []

  const lines: string[] = []
  for (const portId of Object.keys(outputs)) {
    const value = results.output(nodeId, portId)
    if (!value || saysNothingNew(value)) continue

    const block = [`    ran: ${portId} — ${valueHeadline(value)}`]
    if (state.room()) {
      /*
       * A repeat is named rather than repeated. A passthrough chain summarises identically at
       * every step — a Sort changes no per-column aggregate — so the wizard's own demo emitted
       * one block four times. Saying which port it matches keeps the fact that they are the
       * same table, which is worth more than the fourth copy of the numbers.
       */
      const columns = valueColumns(value)
      const first = state.sameAs(`${nodeId}:${portId}`, columns)
      block.push(
        ...(first ? [`      (same columns as ${first})`] : columns.map((l) => `      ${l}`)),
      )
    } else {
      state.skip()
    }
    lines.push(...state.emit(block))
  }
  return lines
}

/**
 * Per-column detail, for the values that have columns.
 *
 * Everything that is not table-shaped answers with an empty list rather than with a second kind
 * of line: its headline already said the only thing there is to say about it, and a matrix's
 * cells are not a column anybody can name in a param.
 */
function valueColumns(value: Value): string[] {
  if (isTableValue(value)) return tableColumns(value)
  if (value.kind === 'network') {
    return [
      ...tableColumns(value.nodes).map((line) => `nodes ${line}`),
      ...tableColumns(value.edges).map((line) => `links ${line}`),
    ]
  }
  /*
   * A geometry value pairs its drawing with an ordinary attribute table — that is the whole
   * point of the value model — and the table is the half a param can name. So the columns of a
   * Skeletons value are as worth reporting as those of a plain one, and reporting them here is
   * what stops `carries:` and `ran:` disagreeing about a value that has both.
   */
  if (value.kind === 'skeletons' || value.kind === 'meshes' || value.kind === 'points') {
    return tableColumns(value.attributes)
  }
  return []
}

const MEMO = new WeakMap<TableValue, string[]>()

function tableColumns(table: TableValue): string[] {
  const held = MEMO.get(table)
  if (held) return held
  const built = summarise(table)
  MEMO.set(table, built)
  return built
}

function summarise(table: TableValue): string[] {
  if (table.length === 0) return []
  if (table.length * table.schema.columns.length > CELLS_MAX) {
    return ['(too large to summarise here)']
  }

  /*
   * The Describe node's own summary, read back by column name. Indexing a table of statistics
   * is clumsier than recomputing them and is the point: the median a plan is built on and the
   * median the card shows are then the same number by construction.
   */
  const stats = describeTable(table)
  const at = (name: string, row: number): CellValue => stats.data[name]?.[row] ?? null

  const lines: string[] = []
  const shown = table.schema.columns.slice(0, COLUMNS_MAX)
  for (const [row, col] of shown.entries()) {
    const nulls = Number(at('nulls', row) ?? 0)
    const unique = Number(at('unique', row) ?? 0)
    const tail = nulls > 0 ? `, ${count(nulls)} null` : ''
    const head = `${col.name} (${col.dtype})`

    /*
     * The id column is counted and never shown, which is `describeOps`' rule reaching one layer
     * further: it refuses to *measure* an id, and a digest that listed one would be offering a
     * float64-rounded root id as a value to write into a filter. Invariant 8, from the one
     * direction that has no type to stop it.
     */
    if (col.name === ID_COLUMN_NAME) {
      lines.push(`${head} ${count(unique)} distinct ids${tail}`)
      continue
    }

    const min = at('min', row)
    if (min !== null) {
      // Numeric: a range and a middle, never a list. A value list is for a column a filter can
      // name a value in; a threshold is chosen from the spread instead.
      lines.push(
        `${head} ${num(min)} … ${num(at('max', row))}, median ${num(at('median', row))}${tail}`,
      )
      continue
    }

    // Nothing recorded anywhere: `unique` is already in hand, so say so rather than walking
    // up to `CELLS_MAX` cells to find out.
    lines.push(`${head} ${unique === 0 ? 'no values' : categorical(table, col.name)}${tail}`)
  }

  const rest = table.schema.columns.length - shown.length
  // Counted, not dropped: the `carries:` line above already named every one of them, so a
  // silent stop here would leave the model reading a list that contradicts it.
  if (rest > 0) lines.push(`(and ${count(rest)} more columns, not summarised)`)
  return lines
}

/**
 * `61 distinct, 8 commonest: LC4 (2104), …` — or the whole set, when it is the whole set.
 *
 * The two spellings are the point. A list that *is* every value says nothing about folding,
 * because there was none; a folded one names the total first, so the eight cannot be read as
 * the set. Getting this backwards is the failure this module is most likely to cause: a plan
 * whose filter excludes fifty-three types nobody was told about, which applies cleanly and
 * looks like an answer.
 *
 * **The counting is `statsFor`'s**, not a second copy of it. That function already walks the
 * column by `valueLabel`, ranks by count with a tie broken on the label, and caps — and its
 * tie-break is load-bearing rather than cosmetic (`datasetStats.ts` states it, and its test
 * pins it: two values of equal count would otherwise come out in row order, so an unrelated
 * Sort upstream would reorder them). A second ranking here spelled that tie-break with
 * `localeCompare`, so the Dataset Summary chart and this text could already order the same
 * column differently — and this one locale-dependently, in text that goes on the wire.
 *
 * It is also the cheaper call: `statsFor` memoises the uncapped walk on the `TableValue` and
 * shares it with the Summary widget, where the private version re-counted every time and sorted
 * every distinct value to keep eight.
 */
function categorical(table: TableValue, name: string): string {
  const { values, distinct } = statsFor(table, name, { topN: TOP_VALUES })
  if (values.length === 0) return 'no values'

  /*
   * A key column drops the counts and the word "commonest", both of which would be lies about
   * it. Downstream of a `Group By` every value appears exactly once, so `AOTU008 (1), Dm8 (1)`
   * spends a third of the line on the number 1 and calls an arbitrary eight the commonest —
   * measured on the wizard's own demo, where the whole chain past the grouping is like this.
   * Ranked descending, so the leader being 1 settles it for all of them.
   */
  const key = values[0]!.count === 1
  const listed = values
    .map((v) =>
      key ? truncate(String(v.value)) : `${truncate(String(v.value))} (${count(v.count)})`,
    )
    .join(', ')

  if (distinct <= values.length) return `${count(distinct)} distinct: ${listed}`
  return `${count(distinct)} distinct, ${values.length} ${key ? 'of them' : 'commonest'}: ${listed}`
}

/**
 * A cell that is prose rather than a label.
 *
 * A `str` column is not always a category — a Text note, a URL, a Cypher query — and one cell of
 * it can be longer than everything else in the digest put together. Cut rather than skipped,
 * because the first forty characters still say *what kind of thing* the column holds, which is
 * what the model is reading the line for.
 */
function truncate(label: string): string {
  return label.length > 40 ? `${label.slice(0, 39)}…` : label
}
