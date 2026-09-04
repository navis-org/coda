/**
 * Cypher builders for neuPrint.
 *
 * Pure string construction, kept apart from the HTTP layer so every query this app can send
 * is inspectable and testable without a network or a token. Each builder is paired with a
 * decoder in `decode.ts`; the two are written together because the `RETURN` clause and the
 * column mapping have to agree exactly — neuPrint names its columns after the expressions
 * ("n.bodyId"), so a reordered RETURN silently reshapes the table.
 *
 * neuPrint's `/api/custom/custom` takes only `{cypher, dataset}` — there is no parameter
 * map — so every value is inlined and therefore must be escaped here. `escapeString`,
 * `stringList` and `idList` are the only sanctioned ways to get a value into a query.
 */

import type {
  AdjacencyRequest,
  ConnectionDirection,
  ConnectivityRequest,
  FindNeuronsRequest,
  GroupTotalsRequest,
  LabelMatch,
  PathStepRequest,
  RoiCountsRequest,
  SynapseRequest,
  SynapseTotalsRequest,
} from '../source'
import { isNeuronId } from '../../core/ids'
import { SYNAPSE_UNITS } from '../synapseUnits'
import type { PopulationFilter, TableSchema } from '../../core/types'
import {
  STATUS_COLUMN,
  TRACED_STATUS,
  populationColumns,
  resolvePopulation,
  withoutStatedStatus,
} from '../neuronFilter'
import type { FilterRow } from '../filterRows'
import { anchoredPattern, escapeRegex } from '../terms'
import { CORE_NEURON_COLUMNS, neuprintProperty } from './schema'

/**
 * A Cypher single-quoted string literal.
 *
 * Backslash first, or escaping the quote would then have its own backslash escaped again.
 * Newlines are escaped rather than stripped: a regex is a user's text and silently editing
 * it would change what they asked for.
 */
export function escapeString(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
  return `'${escaped}'`
}

/**
 * A back-quoted identifier, for ROI names — they contain parentheses, quotes and hyphens
 * (`a'L(R)`, `LO(R)`), none of which survive as bare identifiers.
 */
export function escapeIdentifier(name: string): string {
  return `\`${name.replaceAll('`', '``')}\``
}

/**
 * A list literal of ids, emitted as Cypher **integer** literals from their decimal text.
 *
 * Not a numeric list, and not `stringList` either — the two failures are opposite and both
 * silent. `bodyId` is an integer property, so `1 IN ['1']` is false in Cypher and a quoted
 * list matches nothing at all. And routing an id through `Number` first would round any id
 * wider than `Number.MAX_SAFE_INTEGER` before it ever reached the string, which is the whole
 * reason `NeuronId` is text. Splicing the digits through untouched means no float is ever
 * formed, so this builder is exact for an id of any width the server can hold.
 *
 * Anything that is not a bare integer literal is dropped: one malformed id
 * should not take the whole query down with it. Dropping rather than quoting also
 * keeps the injection surface closed — nothing here can leave the digit grammar.
 */
export function idList(values: readonly string[]): string {
  return `[${values.filter(isNeuronId).join(',')}]`
}

function stringList(values: readonly string[]): string {
  return `[${values.map(escapeString).join(',')}]`
}

/**
 * The standard seven, as `RETURN` expressions.
 *
 * Derived from `CORE_NEURON_COLUMNS` rather than retyped: column mapping is positional, so
 * the decoder matches this order against the schema's and throws on a count mismatch — but
 * an *order* change in one list alone would mis-map every row in silence.
 */
const NEURON_COLUMNS = CORE_NEURON_COLUMNS.map((c) => `n.${neuprintProperty(c.name)}`)

/**
 * Extra per-dataset properties appended to the standard seven.
 *
 * Requested by name so the RETURN clause stays predictable; unknown properties come back as
 * null rather than failing, which is what makes a dataset-specific schema safe to apply to
 * a dataset that turns out not to have every column.
 */
/**
 * A `WHERE` fragment accepting neurons whose property carries one of a set of labels.
 *
 * Four shapes, and the split is what the mode is for. The literal forms compile to `IN`,
 * which is index-backed on the properties neuPrint indexes; the regex forms cannot be,
 * whatever they are written as, so they are written for clarity instead.
 *
 * `any(p IN [...] WHERE prop =~ p)` rather than one alternation `^(?:a|b|c)$`, because `=~`
 * anchors the *whole* pattern: a user pattern carrying a top-level `|` would have its own
 * alternation spliced into the surrounding one and quietly match a superset of what it means
 * on its own. Per-pattern matching gives each entry exactly the semantics it would have in
 * Find Neurons' Type field, which is the only comparison anyone can make.
 *
 * Null handling falls out rather than being coded: a neuron with no value for the property
 * yields `null IN [...]` or `null =~ p`, both of which are null, and Cypher's `WHERE` keeps
 * only true. `toLower(null)` is null as well, so the case-insensitive form needs no guard.
 */
function labelClause(match: LabelMatch): string {
  const prop = `n.${escapeIdentifier(neuprintProperty(match.field))}`
  if (match.regex) {
    // `(?i)` is Java's inline flag, which is what Neo4j's regex engine reads. Prefixed per
    // pattern rather than wrapped around a group, so an anchor the user wrote still applies
    // to the whole string.
    const patterns = match.values.map((v) => (match.ignoreCase ? `(?i)${v}` : v))
    return `any(p IN ${stringList(patterns)} WHERE ${prop} =~ p)`
  }
  if (match.ignoreCase) {
    const lowered = match.values.map((v) => v.toLowerCase())
    return `toLower(${prop}) IN ${stringList(lowered)}`
  }
  return `${prop} IN ${stringList(match.values)}`
}

/**
 * One `FilterRow` as a `WHERE` fragment.
 *
 * The counterpart of `toTerm`, and the pair has to agree: the same row runs here against a
 * server and there against an index a source already holds, and a graph that answered two
 * different sets depending on the backend would be the whole point of the row model undone.
 *
 * Three things here are decisions rather than transcription.
 *
 * **`isIn` compiles to `IN`, not to an alternation.** neuPrint indexes the properties people
 * look neurons up by, and `n.type IN ['LC4','LC6']` uses that index where the equivalent
 * `n.type =~ '^(?:LC4|LC6)$'` forces a scan of every `:Neuron` in the dataset. Same set, and the
 * reason `isIn` exists as an operator rather than being left to a regex somebody writes.
 *
 * **`matches` is anchored and the others are not.** Neo4j's `=~` matches the *whole* value, so a
 * `contains` has to be written `.*x.*` explicitly. `anchoredPattern` is the same helper `toTerm`
 * uses, so the `(?:…)` wrapping that stops a user's top-level `|` escaping its own row is
 * decided once rather than twice.
 *
 * **Case rides on the row.** `(?i)` is Java's inline flag, which is what Neo4j's regex engine
 * reads, and `toLower()` on both sides is the literal form's equivalent. Neither is a default:
 * `FieldTerm.ignoreCase` explains why this is per row rather than global.
 */
function rowClause(row: FilterRow): string {
  const prop = `n.${escapeIdentifier(neuprintProperty(row.field))}`
  const value = row.values[0] ?? ''
  // One spelling of the case fold, used by all three of the forms below. Written out three
  // separate times before this, which is a hazard rather than noise: `nullSafeNot` has to wrap
  // *exactly* the positive clause, and two long strings that must stay character-identical is
  // how that stops being true.
  const foldValue = (v: string) => (row.ignoreCase ? v.toLowerCase() : v)
  const fold = (expr: string) => (row.ignoreCase ? `toLower(${expr})` : expr)
  const lit = (v: string) => escapeString(foldValue(v))
  const re = (pattern: string) =>
    `${prop} =~ ${escapeString(row.ignoreCase ? `(?i)${pattern}` : pattern)}`
  // Each pair is built once and negated by the operator, the way `toTerm` takes one `negate`
  // argument rather than writing the positive form out twice.
  const orNull = (clause: string, negate: boolean) => (negate ? nullSafeNot(clause, prop) : clause)

  switch (row.op) {
    case 'is':
    case 'isNot':
      return orNull(`${fold(prop)} = ${lit(value)}`, row.op === 'isNot')
    case 'isIn':
    case 'isNotIn':
      return orNull(
        `${fold(prop)} IN ${stringList(row.values.map(foldValue))}`,
        row.op === 'isNotIn',
      )
    case 'contains':
    case 'notContains':
      return orNull(re(`.*${escapeRegex(value)}.*`), row.op === 'notContains')
    case 'startsWith':
      return re(`${escapeRegex(value)}.*`)
    case 'endsWith':
      return re(`.*${escapeRegex(value)}`)
    case 'matches':
      // Anchored, because the same row is compiled to Neo4j's `=~`, which matches the whole
      // value. An unanchored local match would train the wrong intuition and then change the
      // result the day the graph is pointed at neuPrint.
      return re(anchoredPattern(value))
    case 'gt':
      return `${prop} > ${numberLiteral(value)}`
    case 'ge':
      return `${prop} >= ${numberLiteral(value)}`
    case 'lt':
      return `${prop} < ${numberLiteral(value)}`
    case 'le':
      return `${prop} <= ${numberLiteral(value)}`
    case 'isEmpty':
      return `(${prop} IS NULL OR ${prop} = '')`
    case 'notEmpty':
      return notEmptyClause(prop)
  }
}

/**
 * "This property carries a value somebody entered", as one clause.
 *
 * Named because two callers have to spell it identically: the `notEmpty` operator, and the
 * dataset-level `typed`/`superclass` filters, which are deliberately *not* routed through
 * `rowClause` — see `populationCypher`. Not routing them through the operator switch is the
 * decision; writing the clause out twice was not part of it, and a checkbox and the equivalent
 * filter row answering two different sets is exactly the kind of disagreement nothing catches.
 *
 * `IS NOT NULL` *and* `<> ''`: neuPrint stores an unset annotation both ways depending on the
 * dataset, and a null test alone lets the empty ones through.
 */
function notEmptyClause(prop: string): string {
  return `(${prop} IS NOT NULL AND ${prop} <> '')`
}

/**
 * `NOT (clause)`, written so that a neuron with no value at all survives it.
 *
 * **The sharpest edge in the whole compiler**, and it fails silently in both directions if it is
 * got wrong. Coda's rule — stated once in `terms.ts` and written out the long way in both export
 * compilers — is that a missing value satisfies a negated comparison: `status is not Traced`
 * returns the untraced *and* the unlabelled, which is what somebody auditing a dataset for gaps
 * is asking for.
 *
 * Cypher does not do that. `NOT (n.status = 'Traced')` over a null `status` evaluates to null,
 * and `WHERE` keeps only *true* — so the unlabelled neurons vanish, with no error and no row
 * count to compare against. The `OR … IS NULL` is what makes the server agree with the index.
 */
function nullSafeNot(clause: string, prop: string): string {
  return `(NOT (${clause}) OR ${prop} IS NULL)`
}

/**
 * A numeric literal for a comparison, or the string form when it is not a number.
 *
 * `resolveRows` refuses a non-numeric ordering comparison before it can reach here, so the
 * fallback is unreachable rather than lenient — but emitting an unquoted `NaN` into Cypher would
 * be a syntax error at the server rather than a wrong answer, and this keeps it a wrong answer
 * nobody can reach instead.
 */
function numberLiteral(value: string): string {
  const number = Number(value)
  return Number.isFinite(number) ? String(number) : escapeString(value)
}

/**
 * The dataset's population checkboxes as one parenthesised `WHERE` fragment, or nothing.
 *
 * Three decisions, each of which fails as a wrong count rather than as an error.
 *
 * **The disjuncts are OR-ed and the group is ANDed onto everything else.** `traced` plus `typed`
 * means proofread *or* named — see `PopulationFilter` — so ANDing them here would answer a
 * question neither box asks, and dropping the parentheses would let the OR swallow the query
 * rows beside it and return most of the dataset.
 *
 * **`typed` spreads across every type column** the dataset has, which is what makes a neuron
 * carrying only a `flywireType` a typed neuron. `resolvePopulation` has already dropped any
 * filter this dataset cannot answer, so an empty group here means "no narrowing", never "no
 * rows".
 *
 * **An explicit `status` row removes the `traced` disjunct**, through `withoutStatedStatus` —
 * which is where that precedence is stated, because both exporters have to make the same call
 * and a second copy of the rule is a second chance to AND instead.
 *
 * Emitted directly rather than through `rowClause`, because these are not rows: none of them
 * carries a case fold or a negation, and routing them through the operator switch would make a
 * dataset-level checkbox depend on `FilterRow`'s defaults.
 *
 * Exported because the R exporter's Explore chunk writes its own `MATCH (n:Neuron) … RETURN` by
 * hand and needs the identical fragment. Two hand-written spellings of one OR group is how a
 * knitted document comes to select a different set from the canvas it was exported from.
 */
export function populationCypher(
  population: readonly PopulationFilter[] | undefined,
  schema: TableSchema | undefined,
  statedFields: readonly string[] = [],
): string {
  const filters = withoutStatedStatus(
    resolvePopulation(population, schema),
    statedFields.includes(STATUS_COLUMN),
  )

  const parts: string[] = []
  for (const filter of filters) {
    for (const name of populationColumns(filter, schema)) {
      const prop = `n.${escapeIdentifier(neuprintProperty(name))}`
      parts.push(
        filter === 'traced'
          ? `${prop} = ${escapeString(TRACED_STATUS)}`
          : notEmptyClause(prop),
      )
    }
  }
  if (parts.length === 0) return ''
  // Parenthesised past one disjunct: the group is ANDed onto the rows beside it, and a bare
  // `a OR b` spliced into a chain of `AND`s binds looser than every one of them.
  return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`
}

/**
 * `schema` is the dataset's **own** neuron schema, and only the population clause reads it: which
 * columns answer `typed` is a per-dataset fact, and `extraProperties` beside it is the same fact
 * in the shape the `RETURN` list needs. Optional so the many call sites that pass no population
 * stay as they were; absent, every population filter resolves to nothing and is dropped.
 */
export function findNeuronsCypher(
  req: FindNeuronsRequest,
  extraProperties: string[] = [],
  schema?: TableSchema,
): string {
  const where: string[] = []
  for (const row of req.rows ?? []) where.push(rowClause(row))
  // Empty values matches nothing, so the caller is expected not to send one — see `LabelMatch`.
  if (req.labels && req.labels.values.length > 0) where.push(labelClause(req.labels))
  /*
   * `idList`, never `stringList`: `bodyId` is an integer property, and `1 IN ['1']` is false
   * in Cypher — a string list here returns an empty result with no error to explain it. Note
   * that an id *arrives* as a string and is emitted unquoted; see `idList`.
   *
   * Present-and-empty produces `IN []`, which matches nothing. Deliberately unlike the label
   * clause above, which skips itself when empty and so reads an empty set as "no filter". That
   * is safe there only because the node guards it; relying on a caller's guard for a clause that
   * would otherwise return the entire dataset is not a trade worth repeating.
   */
  if (req.neuronIds) where.push(`n.bodyId IN ${idList(req.neuronIds)}`)
  // A neuron carries one boolean property per ROI it innervates, so presence is the test.
  // `IS NOT NULL` rather than `exists(...)`: the latter was removed for properties in
  // Neo4j 5, and neuPrint's servers are not all on the same major version.
  if (req.roi) where.push(`n.${escapeIdentifier(req.roi)} IS NOT NULL`)
  const population = populationCypher(
    req.population,
    schema,
    (req.rows ?? []).map((row) => row.field),
  )
  if (population) where.push(population)

  const columns = [...NEURON_COLUMNS, ...extraProperties.map((p) => `n.${escapeIdentifier(p)}`)]
  return [
    'MATCH (n:Neuron)',
    where.length ? `WHERE ${where.join(' AND ')}` : '',
    `RETURN ${columns.join(', ')}`,
    'ORDER BY n.bodyId',
    req.limit && req.limit > 0 ? `LIMIT ${Math.floor(req.limit)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Partners of the given bodies.
 *
 * The far end is matched as a bare node rather than `:Neuron` on purpose: a partner may be
 * a `Segment` below the neuron threshold, and excluding those would quietly under-report
 * total output weight.
 *
 * ## The region arm
 *
 * `ConnectsTo` carries its own `roiInfo` — the connection's synapses broken down by region,
 * `{"LAL(L)": {"post": 112}, …}` — so both restricting to regions and splitting by them are
 * answered here rather than by reading synapses. Three things about it are decisions:
 *
 * **The per-region number is `post`.** It is the count of postsynaptic densities in that
 * region, which is what `w.weight` counts for the connection as a whole; hemibrain also writes
 * a `pre` beside it and it is not the same measure. Summing `post` over the primary set
 * reproduces `w.weight` exactly on male-CNS — 400 of 400 sampled edges, and 23,423 over all
 * 11,287 out-edges of body 10005, which is what `n.downstream` publishes — and to within a
 * percent elsewhere, because a few synapses sit in no primary region. The per-dataset numbers
 * are on `ConnectivityRequest.splitByRoi`.
 *
 * **`minWeight` is applied to the restricted total, before the `UNWIND`.** So a split is a pure
 * decomposition of whatever the unsplit query would have returned, and turning the toggle on
 * cannot change which partners a traversal goes on to expand. Applying it per region instead
 * would silently prune the frontier.
 *
 * **`ORDER BY` is dropped on the region arm**, because ordering by the restricted weight would
 * cost a sort over a projection Neo4j cannot serve from the relationship index, and
 * `traverseConnectivity` re-sorts everything it merges anyway.
 *
 * Uses apoc, which every neuPrint deployment checked has installed — its own cached
 * `/api/cached/roiconnectivity` endpoint is built on `apoc.convert.fromJsonMap`.
 */
export function connectivityCypher(req: ConnectivityRequest): string {
  const ids = idList(req.neuronIds)
  const pattern =
    req.direction === 'outputs'
      ? `MATCH (n:Neuron)-[w:ConnectsTo]->(p)\nWHERE n.bodyId IN ${ids}`
      : `MATCH (p)-[w:ConnectsTo]->(n:Neuron)\nWHERE n.bodyId IN ${ids}`

  const min = req.minWeight && req.minWeight > 0 ? Math.floor(req.minWeight) : 0
  if (req.rois?.length || req.splitByRoi) return roiConnectivityCypher(req, pattern, min)

  const where = min > 0 ? `\nAND w.weight >= ${min}` : ''
  return [
    pattern + where,
    'RETURN n.bodyId, n.type, p.bodyId, p.type, w.weight',
    'ORDER BY w.weight DESC',
  ].join('\n')
}

/**
 * The region arm of `connectivityCypher`. Not exported: `rois`/`splitByRoi` is the way in.
 *
 * An empty `rois` with `splitByRoi` set is a caller that wants every region the connection
 * mentions, which is the one shape here that can double count — the node is what decides
 * whether that set tiles, and it warns with a measured ratio when it does not.
 */
function roiConnectivityCypher(req: ConnectivityRequest, pattern: string, min: number): string {
  // `keys(ri)` where no region list was given, so an unrestricted split still sees everything
  // the connection mentions rather than silently answering for nothing.
  const wanted = req.rois?.length ? stringList(req.rois) : 'keys(ri)'
  return [
    pattern,
    'WITH n, p, w, apoc.convert.fromJsonMap(w.roiInfo) AS ri',
    // `coalesce(…, 0)`: a region entry may carry only `pre`, and `null > 0` is null, not false.
    `WITH n, p, [r IN ${wanted} WHERE coalesce(ri[r].post, 0) > 0 | {roi: r, weight: ri[r].post}] AS parts`,
    'WITH n, p, parts, reduce(total = 0, x IN parts | total + x.weight) AS weight',
    `WHERE weight >= ${Math.max(1, min)}`,
    ...(req.splitByRoi
      ? [
          'UNWIND parts AS part',
          'RETURN n.bodyId, n.type, p.bodyId, p.type, part.weight AS weight, part.roi AS roi',
        ]
      : ['RETURN n.bodyId, n.type, p.bodyId, p.type, weight']),
  ].join('\n')
}

/**
 * The property holding a body's published synapse total on one side.
 *
 * Both totals queries read it, so the rule lives here rather than in each. `coalesce(n.upstream,
 * n.post)`: the two are equal wherever both exist, and a dataset publishing only one of them
 * should still answer. There is deliberately **no fallback on the outgoing side** — `n.pre` is
 * the T-bar count rather than the synapses those T-bars drive, 2,837 against 23,423 on male-cns
 * body 10005, so it would put a plausible fraction eight times too large in the column with
 * nothing failing.
 */
function publishedTotal(side: ConnectionDirection): string {
  return side === 'inputs' ? 'coalesce(n.upstream, n.post)' : 'n.downstream'
}

/**
 * How many synapses each of these bodies has, on one side.
 *
 * Two bases, two queries, and the gap between them is the reason the control exists: on
 * male-cns body 10005 the `all` arm answers 23,423 outgoing and the `connected` arm 9,324,
 * because 14,091 of those synapses land on fragments neuPrint never labelled `:Neuron`.
 *
 * **The queried end is `:Segment`, both times.** Every body carries that label — a `:Neuron` is
 * a `:Segment` that cleared the synapse threshold — and `bodyId` is indexed on it, so a fragment
 * that turned up on the far end of somebody's edge still gets a denominator. Matching `:Neuron`
 * here would return no row for it, which reads downstream as "no answer" rather than as "not a
 * neuron", and those are the same thing only by accident.
 *
 * **`all` reads `upstream`/`downstream`, never `post`/`pre`.** `upstream` and `post` are equal on
 * every dataset checked, but `pre` is the *T-bar* count and `downstream` is the number of
 * synapses those T-bars drive: 2,837 against 23,423 on body 10005. Normalising by `pre` would
 * put a plausible fraction eight times too large in the column, with nothing failing.
 */
export function synapseTotalsCypher(req: SynapseTotalsRequest): string {
  const ids = idList(req.neuronIds)
  if (req.basis === 'all') {
    return [
      `MATCH (n:Segment)`,
      `WHERE n.bodyId IN ${ids}`,
      `RETURN n.bodyId, ${publishedTotal(req.side)}`,
    ].join('\n')
  }
  const pattern =
    req.side === 'inputs'
      ? 'MATCH (p:Neuron)-[w:ConnectsTo]->(n:Segment)'
      : 'MATCH (n:Segment)-[w:ConnectsTo]->(p:Neuron)'
  return [pattern, `WHERE n.bodyId IN ${ids}`, 'RETURN n.bodyId, sum(w.weight)'].join('\n')
}

/**
 * The same totals summed per group key — a cell type, or one neuron on its own.
 *
 * One arm per list, and `fetchGroupTotals` sends whichever it has rather than a `UNION`: a
 * collapsed frontier is usually all types, so the id arm is normally not a query at all, and two
 * statements are two things to read where a union of an aggregate and a scalar is one thing to
 * get subtly wrong.
 *
 * **The type arm matches `:Neuron` where `synapseTotalsCypher` matches `:Segment`**, and that is
 * not the inconsistency it looks like. A denominator has to count the same population its
 * numerator came from, and the numerator is `pathStepCypher`'s, which matches `(a:Neuron)` at
 * both ends. Summing every `:Segment` carrying the type would put synapses into the denominator
 * that no hop of this traversal could ever have contributed. The id arm keeps `:Segment` for
 * `synapseTotalsCypher`'s own reason — a lone untyped neuron in a collapsed frontier is still a
 * body, and refusing it a denominator reads downstream as "not published".
 *
 * **The key comes back as text on both arms** (`toString(n.bodyId)`), because that is the
 * vocabulary the traversal groups in — `coalesce(n.type, toString(n.bodyId))` is `pathStepCypher`
 * three functions up, and a key that arrived as a number here would miss every lookup.
 */
export function groupTotalsCypher(req: GroupTotalsRequest): string {
  const byType = Boolean(req.types?.length)
  const property = publishedTotal(req.side)
  const key = byType ? 'n.type' : 'toString(n.bodyId)'
  const where = byType
    ? `n.type IN ${stringList(req.types ?? [])}`
    : `n.bodyId IN ${idList(req.neuronIds ?? [])}`

  if (req.basis === 'all') {
    // The type arm sums over the population; the id arm is one body, so its aggregate is the
    // property itself. `sum` over a single-row group would answer the same thing and read as
    // though a body could appear twice.
    return [
      `MATCH (n:${byType ? 'Neuron' : 'Segment'})`,
      `WHERE ${where}`,
      `RETURN ${key}, ${byType ? `sum(${property})` : property}`,
    ].join('\n')
  }
  const far = byType ? 'Neuron' : 'Segment'
  const pattern =
    req.side === 'inputs'
      ? `MATCH (p:Neuron)-[w:ConnectsTo]->(n:${far})`
      : `MATCH (n:${far})-[w:ConnectsTo]->(p:Neuron)`
  return [pattern, `WHERE ${where}`, `RETURN ${key}, sum(w.weight)`].join('\n')
}

/**
 * One hop of a path traversal, with the grouping done in the database.
 *
 * Three things here are decisions rather than mechanics:
 *
 * **Both ends are `:Neuron`.** `connectivityCypher` deliberately matches the far end as a bare
 * node, because a partner may be a `Segment` below the neuron threshold and excluding those
 * would under-report total output weight. A *path* is the opposite case: a route through an
 * unnamed fragment is not a circuit anyone traced, and the fragment would then be expanded at
 * the next hop. Reporting a total and tracing a route want different sets.
 *
 * **The frontier is two lists, OR-ed.** A neuron with no type stands as its own node, so the
 * frontier is a mix of type names and body ids. Both halves are property lookups neuPrint has
 * indexed; a `coalesce(n.type, toString(n.bodyId)) IN [...]` would express the same thing as
 * one list and force a scan of every `:Neuron` in the dataset.
 *
 * **`minWeight` is applied after the `sum`.** At type level the question is how much traffic
 * runs between two populations, and cutting each synapse group first would discard the many
 * weak connections that are exactly what adds up to a strong pathway. At neuron level the two
 * are the same thing, because each group is its own row.
 */
export function pathStepCypher(req: PathStepRequest): string {
  const outward = req.direction === 'outputs'
  // `a` is always the frontier end and `b` always the far end, whichever way the arrow points.
  const pattern = outward
    ? 'MATCH (a:Neuron)-[c:ConnectsTo]->(b:Neuron)'
    : 'MATCH (b:Neuron)-[c:ConnectsTo]->(a:Neuron)'

  const clauses: string[] = []
  if (req.types?.length) clauses.push(`a.type IN ${stringList(req.types)}`)
  if (req.neuronIds?.length) clauses.push(`a.bodyId IN ${idList(req.neuronIds)}`)
  // No frontier is not a query worth sending, and an absent WHERE would match the dataset.
  if (clauses.length === 0) clauses.push('false')

  // Group key and its body id, per end. At neuron level every neuron is its own group, so the
  // id is always present; collapsed, it is present only for the neurons that have no type.
  const key = (n: string) =>
    req.collapseTypes ? `coalesce(${n}.type, toString(${n}.bodyId))` : `toString(${n}.bodyId)`
  const id = (n: string) =>
    req.collapseTypes
      ? `CASE WHEN ${n}.type IS NULL THEN ${n}.bodyId ELSE null END`
      : `${n}.bodyId`

  // Rows are always presynaptic → postsynaptic, whichever end the frontier was, so the
  // traversal never has to reorient them — the same rule `connectivityOps` arrived at.
  const pre = outward ? 'a' : 'b'
  const post = outward ? 'b' : 'a'
  const min = Math.max(1, Math.floor(req.minWeight ?? 1))

  return [
    pattern,
    `WHERE ${clauses.join(' OR ')}`,
    `WITH ${key(pre)} AS src, ${pre}.type AS srcType, ${id(pre)} AS srcId,`,
    `     ${key(post)} AS dst, ${post}.type AS dstType, ${id(post)} AS dstId,`,
    '     c.weight AS w',
    'WITH src, srcType, srcId, dst, dstType, dstId, sum(w) AS weight, count(*) AS pairs',
    `WHERE weight >= ${min}`,
    'RETURN src, srcType, srcId, dst, dstType, dstId, weight, pairs',
    'ORDER BY weight DESC',
  ].join('\n')
}

export function adjacencyCypher(req: AdjacencyRequest): string {
  return [
    'MATCH (a:Neuron)-[w:ConnectsTo]->(b:Neuron)',
    `WHERE a.bodyId IN ${idList(req.sourceIds)} AND b.bodyId IN ${idList(req.targetIds)}`,
    'RETURN a.bodyId, a.type, b.bodyId, b.type, w.weight',
  ].join('\n')
}

/**
 * Per-ROI synapse counts.
 *
 * One query returning each neuron's `roiInfo` blob, unpacked client-side, rather than one
 * query per ROI. neuPrint stores the whole breakdown on the neuron already, so fanning out
 * would be N round trips at ~500ms each for data that arrives in one.
 */
export function roiCountsCypher(req: RoiCountsRequest): string {
  return [
    'MATCH (n:Neuron)',
    `WHERE n.bodyId IN ${idList(req.neuronIds)}`,
    'RETURN n.bodyId, n.type, n.roiInfo',
    'ORDER BY n.bodyId',
  ].join('\n')
}

/**
 * One neuron set's synapses as points.
 *
 * **`unit` is required, and `sites` is not a tidying pass.** A neuron holds one `SynapseSet` per
 * partner *neuron*, so the bare walk returns a T-bar once per partner it drives: 4,491 rows for
 * 1,015 sites on `male-cns:v1.0` body 10001, 135,652 for 18,420 on hemibrain. `WITH DISTINCT n, s`
 * is what collapses them, and it is neuprint-python's own fix in `queries/synapses.py`, carrying
 * the same comment. `n` stays in the `WITH` because the `RETURN` reads `n.bodyId` and `n.type`.
 * Postsynaptic densities belong to one connection each and are unaffected either way.
 *
 * **`minConfidence` is a fraction here**, 0..1, and absent means no clause. It used to be spelled
 * `minWeight` and default to 1, which compiled to `s.confidence >= 1` — a filter that on MANC and
 * optic-lobe kept no presynaptic site at all and on hemibrain kept 213 rows in 200,000. The
 * dataset has usually applied its own floor already (`Meta.postHighAccuracyThreshold` is 0.5 on
 * male-CNS, which is why nothing in that cloud scores below 0.5004), so this is a control for
 * cutting further, not one anybody needs to set.
 */
export function synapsesCypher(req: SynapseRequest): string {
  const where = [`n.bodyId IN ${idList(req.neuronIds)}`]
  if (req.polarity) where.push(`s.type = ${escapeString(req.polarity)}`)
  const min = req.minConfidence ?? 0
  if (min > 0) where.push(`s.confidence >= ${min}`)
  return [
    'MATCH (n:Neuron)-[:Contains]->(:SynapseSet)-[:Contains]->(s:Synapse)',
    `WHERE ${where.join(' AND ')}`,
    // De-duplicate `s`: a pre synapse appears in more than one SynapseSet.
    ...(req.unit === SYNAPSE_UNITS.sites ? ['WITH DISTINCT n, s'] : []),
    'RETURN n.bodyId, n.type, s.type, s.location.x, s.location.y, s.location.z, s.confidence',
  ].join('\n')
}

/**
 * Dataset metadata in one round trip.
 *
 * `neuronProperties` is absent on some datasets (hemibrain has `objectProperties` instead),
 * so the caller must treat a null here as "fall back to sampling" rather than "no
 * properties".
 */
export function metaCypher(): string {
  return 'MATCH (m:Meta) RETURN m.neuronProperties, m.primaryRois, m.superLevelRois, m.statusDefinitions, m.voxelSize, m.voxelUnits, m.roiHierarchy LIMIT 1'
}

/**
 * A sample of whole neurons, for schema discovery.
 *
 * Returning the node rather than `keys(n)` gets names *and* value types in one round trip,
 * which matters because half the datasets have no `neuronProperties` on their Meta node to
 * read types from. Sampling rather than scanning keeps it to a few hundred milliseconds;
 * the cost is that a property only a handful of neurons carry may be missed, which is an
 * acceptable trade for populating a column picker.
 */
export function sampleNeuronsCypher(sample = 25): string {
  return `MATCH (n:Neuron) WITH n LIMIT ${Math.floor(sample)}\nRETURN n`
}

/** Statuses present, sampled for the same reason — a full DISTINCT is a table scan. */
export function sampleStatusesCypher(sample = 20_000): string {
  return `MATCH (n:Neuron) WITH n LIMIT ${Math.floor(sample)}\nRETURN DISTINCT n.status`
}
