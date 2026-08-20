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
 * map — so every value is inlined and therefore must be escaped here. `escapeString` and
 * `numberList` are the only sanctioned ways to get a value into a query.
 */

import type {
  AdjacencyRequest,
  ConnectivityRequest,
  FindNeuronsRequest,
  LabelMatch,
  PathStepRequest,
  RoiCountsRequest,
  SynapseRequest,
} from '../source'
import { CORE_NEURON_COLUMNS } from './schema'

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
 * A list literal of numbers. Anything non-finite is dropped rather than emitted as `NaN`,
 * which Cypher does not parse — a bad id should not take the whole query down with it.
 */
export function numberList(values: readonly number[]): string {
  return `[${values.filter((v) => Number.isFinite(v)).join(',')}]`
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
const NEURON_COLUMNS = CORE_NEURON_COLUMNS.map((c) => `n.${c.name}`)

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
  const prop = `n.${escapeIdentifier(match.field)}`
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

export function findNeuronsCypher(
  req: FindNeuronsRequest,
  extraProperties: string[] = [],
): string {
  const where: string[] = []
  // `=~` anchors at both ends, so a bare `LC.*` matches `LC4` but not `LPLC1`. `MockSource`
  // reproduces that deliberately; don't "fix" either side.
  if (req.typePattern) where.push(`n.type =~ ${escapeString(req.typePattern)}`)
  if (req.instancePattern) where.push(`n.instance =~ ${escapeString(req.instancePattern)}`)
  // Empty values matches nothing, so the caller is expected not to send one — see `LabelMatch`.
  if (req.labels && req.labels.values.length > 0) where.push(labelClause(req.labels))
  /*
   * `numberList`, never `stringList`: `bodyId` is an integer property, and `1 IN ['1']` is false
   * in Cypher — a string list here returns an empty result with no error to explain it.
   *
   * Present-and-empty produces `IN []`, which matches nothing. Deliberately unlike the label
   * clause above, which skips itself when empty and so reads an empty set as "no filter". That
   * is safe there only because the node guards it; relying on a caller's guard for a clause that
   * would otherwise return the entire dataset is not a trade worth repeating.
   */
  if (req.bodyIds) where.push(`n.bodyId IN ${numberList(req.bodyIds)}`)
  if (req.statuses?.length) where.push(`n.status IN ${stringList(req.statuses)}`)
  if (req.minSize && req.minSize > 0) where.push(`n.size >= ${Math.floor(req.minSize)}`)
  // A neuron carries one boolean property per ROI it innervates, so presence is the test.
  // `IS NOT NULL` rather than `exists(...)`: the latter was removed for properties in
  // Neo4j 5, and neuPrint's servers are not all on the same major version.
  if (req.roi) where.push(`n.${escapeIdentifier(req.roi)} IS NOT NULL`)

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
 */
export function connectivityCypher(req: ConnectivityRequest): string {
  const ids = numberList(req.bodyIds)
  const pattern =
    req.direction === 'outputs'
      ? `MATCH (n:Neuron)-[w:ConnectsTo]->(p)\nWHERE n.bodyId IN ${ids}`
      : `MATCH (p)-[w:ConnectsTo]->(n:Neuron)\nWHERE n.bodyId IN ${ids}`

  const where =
    req.minWeight && req.minWeight > 0 ? `\nAND w.weight >= ${Math.floor(req.minWeight)}` : ''
  return [
    pattern + where,
    'RETURN n.bodyId, n.type, p.bodyId, p.type, w.weight',
    'ORDER BY w.weight DESC',
  ].join('\n')
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
  if (req.bodyIds?.length) clauses.push(`a.bodyId IN ${numberList(req.bodyIds)}`)
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
    `WHERE a.bodyId IN ${numberList(req.sourceIds)} AND b.bodyId IN ${numberList(req.targetIds)}`,
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
    `WHERE n.bodyId IN ${numberList(req.bodyIds)}`,
    'RETURN n.bodyId, n.type, n.roiInfo',
    'ORDER BY n.bodyId',
  ].join('\n')
}

export function synapsesCypher(req: SynapseRequest): string {
  const where = [`n.bodyId IN ${numberList(req.bodyIds)}`]
  if (req.polarity) where.push(`s.type = ${escapeString(req.polarity)}`)
  if (req.minWeight && req.minWeight > 0) where.push(`s.confidence >= ${req.minWeight}`)
  return [
    'MATCH (n:Neuron)-[:Contains]->(:SynapseSet)-[:Contains]->(s:Synapse)',
    `WHERE ${where.join(' AND ')}`,
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
