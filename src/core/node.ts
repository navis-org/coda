/**
 * The node contract.
 *
 * A node definition is declarative data plus two pure-ish functions:
 *
 *   inferOutputs(ctx)  — edit time, no data, no network. Runs on every graph mutation,
 *                        so it must be fast and must never throw. Produces output types
 *                        (including column schemas) that drive link validation and the
 *                        column pickers in the UI.
 *   evaluate(ctx)      — run time. Receives realised input values, returns output values.
 *
 * Keeping these separate is what lets the editor feel responsive and knowledgeable
 * before a single query has been sent.
 */

import type { DataSource } from '../data/source'
import type { CompanionSpec } from './companion'
import type { AttributePart, CodaType, DType, TableSchema } from './types'
import { attributeSchema, columnsOfType, schemaOf } from './types'
import type { Value } from './values'

/**
 * Cheap nodes re-run automatically while you drag a slider. Expensive nodes go stale
 * and wait for an explicit Run — they hit the network or chew serious CPU, and we are
 * pointed at a shared production Neo4j.
 */
export type NodeCost = 'cheap' | 'expensive'

/**
 * Node categories, in palette order.
 *
 * `transform` rather than `table` because a "Table" category next to a `Table` *type* reads
 * as the same thing and isn't; `visualisation` rather than `output` because those nodes are
 * viewers that also pass data through, so "output" implied a dead end.
 */
export type NodeCategory =
  'dataset' | 'query' | 'transform' | 'analysis' | 'visualisation' | 'utility'

export interface PortDef {
  id: string
  label?: string
  /** Declared type. For outputs this is the fallback when `inferOutputs` says nothing. */
  type: CodaType
  /** Inputs only. Unconnected required inputs block execution. Defaults to true. */
  required?: boolean
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface EnumOption {
  value: string
  label: string
}

interface ParamBase {
  id: string
  label: string
  /** Tooltip / inspector help text. */
  help?: string
  /** Hide from the compact in-node body; show only in the inspector. */
  advanced?: boolean
  /**
   * Machinery rather than a setting: a value some widget writes, which nobody sets by hand.
   *
   * The nonces (`refresh`, bumped by a reload button — see invariant 4) and the pagers (`page`,
   * written by a pager as you browse). It stays a real param, saved and reachable in the
   * inspector, because the escape hatch is sanctioned; what the flag buys is that nothing
   * *advertises* it. Without it a dataset card reads `… 1 more` about a nonce, and turning a
   * page in Profile makes its card claim a parameter was changed.
   *
   * Not a synonym for `advanced`. `Rows per page` sits beside `page` and is inspector-only for
   * space, but it is somebody's preference and stays countable.
   */
  internal?: boolean
  /** Conditional visibility, evaluated against the node's current params. */
  visibleIf?: (params: ParamValues) => boolean
  /**
   * Affects only how a result is *displayed*, never what `evaluate` returns.
   *
   * Excluded from the provenance key, so changing a heatmap's colour scale or a table's
   * page size does not mark the node stale — and, more importantly, does not invalidate
   * everything downstream of it. Setting this on a param that does change the output would
   * mean stale results silently surviving an edit, so only mark viewer knobs.
   */
  presentational?: boolean
  /**
   * Which tab of a grouped styling panel this param belongs to, naming an entry in the node's
   * `paramGroups`. Opt-in per node: a definition declaring no groups keeps the flat list, so
   * adding this changed nothing for any node that has not asked for it.
   */
  group?: string
  /** Marks this param as one facet of a composite visual property. See `CompositeRef`. */
  composite?: CompositeRef
}

/**
 * One facet of a composite visual property.
 *
 * An encoding arrives as several params — a colour is a mapping mode, a column and a constant
 * — because that is what the graph has to *store*. On screen it is one property with one
 * label, which is how every styling panel worth using presents it. `key` binds the facets
 * together; `role` says which control of the row each one becomes.
 *
 *  - `primary` — how the property is driven: colour's mapping enum, size's column picker, a
 *    label's on/off switch.
 *  - `value` — what it is driven *by*. Several params may claim this and be separated by
 *    `visibleIf`, which is exactly how a colour offers a column picker or a swatch but never
 *    both at once.
 *  - `extra` — modifiers belonging to the property without defining it, like a size range.
 *
 * This is metadata about how params relate, not about how they are drawn, which is why it
 * lives on the definition rather than in a UI-side registry: deriving it from the
 * `<prefix>ColorMode` naming convention would be string-matching a factory's output, and rots
 * the first time an encoding is written by hand.
 */
export interface CompositeRef {
  key: string
  role: 'primary' | 'value' | 'extra'
  /** Row label. Read from the `primary` member; a fallback is taken from any other. */
  label?: string
  /** Short label for this one control inside the row, e.g. "min". Mostly for extras. */
  facet?: string
}

/** A tab in a grouped styling panel. */
export interface ParamGroup {
  id: string
  label: string
  /**
   * The params in this tab change what the node *returns*, not merely how it is drawn.
   *
   * A grouped panel otherwise shows presentational params only, which is what makes it safe
   * to touch — restyling never invalidates a result. A tab that breaks that promise has to
   * say so, and this is what a panel reads to say it: editing these marks the node stale and
   * re-runs everything downstream.
   */
  affectsData?: boolean
}

export interface NumberParam extends ParamBase {
  kind: 'number' | 'int'
  default: number
  min?: number
  max?: number
  step?: number
}

export interface StringParam extends ParamBase {
  kind: 'string'
  default: string
  placeholder?: string
  multiline?: boolean
}

export interface BooleanParam extends ParamBase {
  kind: 'boolean'
  default: boolean
}

export interface EnumParam extends ParamBase {
  kind: 'enum'
  default: string
  /** Static list, or derived from resolved input types (e.g. aggregations per dtype). */
  options: EnumOption[] | ((ctx: InferContext) => EnumOption[])
}

/**
 * Where a column picker's options come from, when the input port's own type does not carry
 * them.
 *
 * Almost every column param reads `attributeSchema` off the type at `from`, which is why this
 * is optional. Two kinds of node cannot: a *dataset* socket carries a source id and a dataset
 * id, and turning those into a schema needs the data-source registry, which `src/core` must not
 * import; and an *upload* holds its table outside the graph entirely, so the schema is found
 * from the node's own params rather than from any port. Hence both arguments — the second is
 * what lets a node with no inputs at all have a working column picker.
 *
 * Must stay synchronous and network-free for the same reason `inferOutputs` must: this runs on
 * every graph mutation. Returning a schema rather than a list of names is deliberate — the
 * `dtypes` filter, the validation and the picker all keep working unchanged.
 */
export type ColumnSchemaSource = (
  inputs: Readonly<Record<string, CodaType | undefined>>,
  params: ParamValues,
) => TableSchema | undefined

/** Single column reference, populated from the schema arriving at input `from`. */
export interface ColumnParam extends ParamBase {
  kind: 'column'
  /** Input port whose schema supplies the options. */
  from: string
  /** Which attribute table to read when the input carries more than one (Network). */
  part?: AttributePart
  /** Restrict to these dtypes. Undefined = any dtype. */
  dtypes?: DType[]
  /** Overrides how the schema is found; `from` still says which port must be connected. */
  schemaFrom?: ColumnSchemaSource
  /** Empty string means "first compatible column", resolved consistently at both stages. */
  default: string
  /** Allow an explicit "none" choice — used by optional encodings. */
  optional?: boolean
}

/** Ordered multi-column reference (group-by keys, selected columns). */
export interface ColumnsParam extends ParamBase {
  kind: 'columns'
  from: string
  part?: AttributePart
  dtypes?: DType[]
  schemaFrom?: ColumnSchemaSource
  default: string[]
  /**
   * An empty selection is a legitimate state, so having nothing to offer is not an issue.
   *
   * Group-by keys need at least one column and say so; a decorative picker like Profile's
   * "Tags" does not — it means "decide for me" when empty, and a table whose schema is not
   * yet known (a raw Cypher result, say) would otherwise raise a warning about a control
   * nobody has touched.
   */
  optional?: boolean
}

/**
 * Opaque list of selected ids, written by a viewer rather than typed by hand. Not
 * presentational: a viewer's selection feeds a downstream output, so it belongs in the
 * provenance key and in the saved file.
 */
export interface IdsParam extends ParamBase {
  kind: 'ids'
  default: string[]
  /** Noun for the summary widget, e.g. "neurons". */
  noun?: string
}

export type ParamDef =
  NumberParam | StringParam | BooleanParam | EnumParam | ColumnParam | ColumnsParam | IdsParam

export type ParamValue = number | string | boolean | string[]
export type ParamValues = Record<string, ParamValue>

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/** Edit-time context: types only, never values. */
export interface InferContext<P extends ParamValues = ParamValues> {
  params: P
  /** Resolved type on each input port; undefined when unconnected. */
  inputs: Readonly<Record<string, CodaType | undefined>>
  /** Shorthand for the table schema on an input port. */
  schema(portId: string): TableSchema | undefined
  /** Attribute schema for any type that carries one (Network, Skeletons, Points…). */
  attributes(portId: string, part?: AttributePart): TableSchema | undefined
  /** Resolve a `column`/`columns` param against the live schema. See `resolveColumn`. */
  column(paramId: string): string | undefined
  columns(paramId: string): string[]
  /**
   * The table schema this node's last successful run actually produced.
   *
   * Only populated for nodes that set `observesOutputSchema`, and only after a run — it is
   * runtime state, not part of the saved graph. It exists for the one case inference cannot
   * otherwise reach: a node whose output shape is decided by the backend (Raw Cypher). Any
   * node whose shape is derivable from inputs and params must derive it instead, because
   * this is empty until you press Run and empty again after a reload.
   */
  observed?: TableSchema | undefined
}

export interface EvalContext<P extends ParamValues = ParamValues> {
  params: P
  /** Realised value on an input port, or undefined when unconnected. */
  input(portId: string): Value | undefined
  /** Same resolution as `InferContext.column`, so infer and eval never disagree. */
  column(paramId: string): string | undefined
  columns(paramId: string): string[]
  /** Look up a registered data source by id (from a DatasetValue). */
  resolveSource(sourceId: string): DataSource
  /** Aborted when the run is superseded or cancelled. Long loops should check it. */
  signal: AbortSignal
  /** Report 0..1 progress for the node's status bar. */
  progress(fraction: number, note?: string): void
}

export interface NodeDefinition<P extends ParamValues = ParamValues> {
  /** Stable id, namespaced: "core.filter", "neuron.findNeurons". Persisted in files. */
  type: string
  label: string
  category: NodeCategory
  description?: string
  cost: NodeCost
  /**
   * Tabs for a grouped styling panel, in display order; a param's `group` names one.
   *
   * Declared rather than inferred from the params, so the order is deliberate and a tab can
   * exist while everything currently in it is hidden by `visibleIf`.
   */
  paramGroups?: ParamGroup[]
  /**
   * Card size a fresh node opens at, when the default is too small to be useful — an
   * embedded viewer, mainly. Only a starting point: `GraphNode.size` overrides it the moment
   * anyone drags a corner, and reading it as a fallback rather than stamping it at creation
   * means every path that makes a node (palette, browser, examples, starters, a loaded file)
   * gets it without knowing about it.
   */
  defaultSize?: { width: number; height: number }
  /**
   * A second node created alongside this one, already wired to it.
   *
   * For a node that is incomplete on its own in a way a user cannot be expected to know about:
   * a dataset arrives with the credit and citation card its publisher asks for. Applied only
   * when someone *adds* the node, never when a saved graph loads, and the companion is an
   * ordinary deletable node afterwards. See `core/companion.ts`.
   */
  companion?: CompanionSpec
  inputs?: readonly PortDef[]
  outputs?: readonly PortDef[]
  params?: readonly ParamDef[]
  /**
   * This node annotates the canvas rather than computing on it.
   *
   * An annotation carries no data: no ports, nothing upstream, nothing downstream, and
   * `evaluate` is never called. The scheduler skips it outright, which is the point — a text
   * note that reported "needs run", counted towards the stale badge and offered a Run button
   * would be claiming to take part in a pipeline it is not in.
   *
   * It is still an ordinary `GraphNode`, and deliberately so: position, selection, undo,
   * autosave, the saved file, duplication and the minimap all come for free, and every one of
   * them would otherwise have to be re-implemented against a second document array for a
   * feature whose entire content is a string. What makes it "not a node" is the absence of
   * dataflow and its own card on the canvas, not a separate storage model.
   */
  annotation?: boolean
  /**
   * Keep the type working but out of the add-node surfaces.
   *
   * For a node that has been superseded: a saved graph must keep loading — an unregistered type
   * renders as "Unknown node" and drops its params — while nobody should be offered it for
   * something new. Registration is what makes a file load; listing is a separate question.
   */
  hidden?: boolean
  /**
   * Output types given input types and params. Omit for nodes whose outputs are fully
   * described by their static `outputs[].type`. Must not throw — return the static type
   * when inputs are missing or inconsistent.
   */
  inferOutputs?(ctx: InferContext<P>): Record<string, CodaType>
  /**
   * Feed this node's last observed output schema back into `inferOutputs` via
   * `ctx.observed`. Set it only when the shape genuinely cannot be known before running —
   * it costs a re-inference each time the node's result changes shape.
   */
  observesOutputSchema?: boolean
  /** Edit-time problems shown on the node (missing column, incompatible dtype, ...). */
  validate?(ctx: InferContext<P>): string[]
  evaluate(ctx: EvalContext<P>): Promise<Record<string, Value>> | Record<string, Value>
}

// ---------------------------------------------------------------------------
// Param helpers
// ---------------------------------------------------------------------------

export function defaultParams(def: NodeDefinition): ParamValues {
  const params: ParamValues = {}
  for (const p of def.params ?? []) {
    params[p.id] = Array.isArray(p.default) ? [...p.default] : p.default
  }
  return params
}

export function findParam(def: NodeDefinition, paramId: string): ParamDef | undefined {
  return (def.params ?? []).find((p) => p.id === paramId)
}

/**
 * The params that apply to these values and are somebody's to set.
 *
 * Two subtractions, and both are about not counting something as a decision. `visibleIf` first:
 * a param the current values have switched off is not a param this node has right now, and
 * counting it makes a number move as unrelated modes are chosen. Then `internal`: a nonce or a
 * pager is a value a widget writes, so counting it would have a dataset card advertise its
 * refresh nonce and a Profile report a change every time somebody turned a page.
 *
 * The denominator for "are the hidden ones all there is", and the set `hiddenParams` filters.
 */
export function configurableParams(def: NodeDefinition, values: ParamValues): ParamDef[] {
  return (def.params ?? []).filter(
    (p) => p.internal !== true && (!p.visibleIf || p.visibleIf(values)),
  )
}

/**
 * Params this node has that its card does not draw: the `advanced` ones, i.e. inspector-only.
 *
 * The card is the whole of what most people read, and a node's advanced params are invisible on
 * it — a Skeletons node has exactly one param and it is advanced, so the card shows an empty
 * body and no hint that there is anything to set. Taken from `configurableParams`, so neither a
 * param the current values have switched off nor a nonce some button writes is counted.
 *
 * Deliberately **not** the rows the card is merely not drawing at this moment. A folded band
 * already has the header's `☰` in its pressed state saying so, and a node with a body of its own
 * renders controls nothing here can enumerate — Explore's search box is on the card, whatever
 * this function can tell about it.
 */
export function hiddenParams(def: NodeDefinition, values: ParamValues): ParamDef[] {
  return configurableParams(def, values).filter((p) => p.advanced === true)
}

/**
 * Of `params`, those carrying a value somebody chose.
 *
 * The second, quieter channel on the same readout: *how many* are hidden is a fact about the
 * node type and never changes, so on its own it says nothing about this particular node. How
 * many were **set** does — a default was never a decision, which is the same call
 * `validateColumnParams` makes about an optional picker still holding the value its definition
 * declared.
 *
 * An absent value is not a change. Loading does not fill missing params with defaults, so a
 * graph saved before a param existed simply has no key for it; comparing that against the
 * declared default would report a change on every older file.
 */
export function changedParams(params: readonly ParamDef[], values: ParamValues): ParamDef[] {
  return params.filter((p) => differsFromDefault(values[p.id], p.default))
}

function differsFromDefault(value: ParamValue | undefined, fallback: ParamValue | undefined) {
  if (value === undefined) return false
  if (Array.isArray(value) || Array.isArray(fallback)) {
    const a = Array.isArray(value) ? value : []
    const b = Array.isArray(fallback) ? fallback : []
    return a.length !== b.length || a.some((item, i) => item !== b[i])
  }
  return value !== fallback
}

/**
 * Resolve a `column` param.
 *
 * Three answers, in order, and the middle one is the whole of it:
 *
 * 1. The stored name, when the schema lists it. The ordinary case.
 * 2. **The stored name anyway, when somebody chose it and the schema does not list it.**
 * 3. The first compatible column, for a param still holding the value its definition
 *    declared — an empty default meaning "decide for me", or a named one like `out.scatter`'s
 *    `pre`, which is a suggestion rather than a decision.
 *
 * Rule 2 replaced a fallback to the first column, and the reasoning is worth keeping because
 * the old behaviour reads as helpful. A schema that does not list a column is very often a
 * schema that has not *arrived*: neuPrint publishes only the canonical seven neuron properties
 * until per-dataset discovery lands, so on a fresh session every discovered property looks
 * deleted. Substituting there does not keep a graph runnable — it quietly computes something
 * else. It cost a real failure: a Pivot whose Columns field named `somaSide` had it replaced
 * by the first column, which its Rows field had already taken, and the node pivoted a
 * 15,000-value field against itself.
 *
 * A name that is genuinely gone now reaches `evaluate` and fails there, naming the column and
 * listing what the table does have. That is the trade, taken deliberately: a loud failure
 * about the column you picked beats a quiet success on one you did not.
 *
 * `optional` still answers *off*, and before rule 2 — that is what optional means, and a
 * decoration pointed at a missing column has a sensible nothing to do.
 */
export function resolveColumn(
  param: ColumnParam,
  params: ParamValues,
  inputs: Readonly<Record<string, CodaType | undefined>>,
): string | undefined {
  const available = availableColumns(param, inputs, params)
  const stored = params[param.id]
  const chosen = typeof stored === 'string' ? stored : ''
  if (chosen && available.includes(chosen)) return chosen
  if (param.optional) return undefined
  if (chosen && chosen !== param.default) return chosen
  // Undefined when there is nothing to offer, which every caller already handles.
  return available[0]
}

/**
 * The plural, and it has the singular's rule 2 in the one form that fits it.
 *
 * A schema this picker cannot even *see* is not a schema without these columns in it — it is a
 * schema that has not arrived. `core.pivot` publishes none until it has run and none again after
 * a reload, and Raw Cypher never declares one at all; dropping the stored names there answers a
 * question nobody asked with a list nobody chose, and it does so **in the provenance key**.
 *
 * What that cost, before this: `Pivot → Select` with two of eight wide columns picked emitted
 * *all eight* on the first run after a reload, because the resolved list was empty and empty
 * means "everything" to the Select node. The store then re-inferred against the schema the pivot
 * had just published, the key changed, the node went stale, and a second Run gave the right
 * answer — the "runs twice, answers differently" signature that also produced the dataset-listing
 * bug in invariant 2.
 *
 * Note the two cases stay distinct, which is the whole reason `columnSchemaFor` answers
 * `undefined` separately from an empty schema. A schema that *is* known and lacks a column still
 * drops it: that is a column genuinely gone, `validateColumnParams` reports it, and keeping it
 * would send a name into `evaluate` that the table cannot honour.
 */
export function resolveColumns(
  param: ColumnsParam,
  params: ParamValues,
  inputs: Readonly<Record<string, CodaType | undefined>>,
): string[] {
  const stored = params[param.id]
  if (!Array.isArray(stored)) return []
  if (!columnSchemaFor(param, inputs, params)) return stored
  const available = availableColumns(param, inputs, params)
  return stored.filter((name) => available.includes(name))
}

/**
 * The schema a column picker reads from, or undefined when the port carries none.
 *
 * Reads through `attributeSchema`, so the same picker works on Table, Neurons, Network (node
 * or edge attributes), Skeletons, Meshes and Points. A param that names a socket carrying no
 * schema of its own — a Dataset — supplies its own lookup instead.
 *
 * Split out of `availableColumns` because undefined here means **not known**, never *empty*,
 * and `validateColumnParams` is the one caller that has to tell those apart. Flattening both
 * to an empty list is what had it warning about tables nobody had seen yet.
 */
export function columnSchemaFor(
  param: ColumnParam | ColumnsParam,
  inputs: Readonly<Record<string, CodaType | undefined>>,
  params: ParamValues,
): TableSchema | undefined {
  return param.schemaFrom
    ? param.schemaFrom(inputs, params)
    : attributeSchema(inputs[param.from], param.part ?? 'nodes')
}

export function availableColumns(
  param: ColumnParam | ColumnsParam,
  inputs: Readonly<Record<string, CodaType | undefined>>,
  params: ParamValues,
): string[] {
  const schema = columnSchemaFor(param, inputs, params)
  if (!schema) return []
  const cols = param.dtypes ? columnsOfType(schema, param.dtypes) : schema.columns
  return cols.map((c) => c.name)
}

/**
 * Standard `validate` fragment: report column params that no longer point at the column
 * the user chose. Node definitions can spread this into their own validate().
 */
export function validateColumnParams(def: NodeDefinition, ctx: InferContext): string[] {
  const issues: string[] = []
  for (const p of def.params ?? []) {
    if (p.kind !== 'column' && p.kind !== 'columns') continue
    if (p.visibleIf && !p.visibleIf(ctx.params)) continue
    const upstream = ctx.inputs[p.from]
    // Unconnected input is reported by the port itself; don't double up.
    if (!upstream) continue
    /*
     * Nor is a schema that has not arrived the same as one with nothing in it.
     *
     * `core.pivot` declares `observesOutputSchema` because its wide columns *are* the distinct
     * values of its Columns field — so it publishes none until it has run, and none again
     * after a reload; a raw Cypher result never declares them at all. Reporting "no columns
     * available" there is a claim about a table nobody has seen, and it lands on every column
     * param downstream at once, which is how a real issue further down the list stops being
     * read. It also suppresses the "is gone" branch below, and deliberately: a stored column
     * is most likely still correct, and inviting someone to re-pick from an empty list is
     * worse advice than silence.
     */
    if (!columnSchemaFor(p, ctx.inputs, ctx.params)) continue
    const available = availableColumns(p, ctx.inputs, ctx.params)
    if (available.length === 0) {
      // An optional picker is allowed to have nothing to offer — that is what optional means.
      // Reporting it puts a warning badge on a node whose control nobody has touched, which
      // is how a genuine issue further down the list stops being read.
      if (p.optional) continue
      const restriction = p.dtypes ? ` of type ${p.dtypes.join('/')}` : ''
      issues.push(`No columns${restriction} available for "${p.label}"`)
      continue
    }
    if (p.kind === 'column') {
      const stored = ctx.params[p.id]
      if (typeof stored === 'string' && stored && !available.includes(stored)) {
        /*
         * Each branch says what `resolveColumn` is about to do, which is the only thing that
         * keeps this message true when that changes.
         *
         * An optional picker answers *off*, so naming a fallback would be a false statement
         * rather than merely a loud one — and a stored value still equal to the definition's
         * own default was never a decision anybody made, so there is no drift to report.
         * `out.scatter` declares `bodyId` so a neuron table needs no configuring; on a table
         * without one it means row positions, which is the node working.
         *
         * A name somebody chose is now *kept* rather than substituted, so the singular says
         * what the plural has always said: this column is missing. It reaches `evaluate` and
         * fails there naming the column, which beats a quiet success on a different one.
         */
        if (p.optional) {
          if (stored !== p.default) issues.push(`Column "${stored}" is gone`)
        } else if (stored !== p.default) {
          issues.push(`Missing column: ${stored}`)
        } else {
          issues.push(`Column "${stored}" is gone — using "${available[0]}"`)
        }
      }
    } else {
      const stored = ctx.params[p.id]
      if (Array.isArray(stored)) {
        const missing = stored.filter((n) => !available.includes(n))
        if (missing.length) issues.push(`Missing column(s): ${missing.join(', ')}`)
      }
    }
  }
  return issues
}

/** Build an InferContext. Shared by the inference pass and the UI's widget layer. */
export function makeInferContext<P extends ParamValues = ParamValues>(
  def: NodeDefinition,
  params: P,
  inputs: Readonly<Record<string, CodaType | undefined>>,
  observed?: TableSchema | undefined,
): InferContext<P> {
  return {
    params,
    inputs,
    observed,
    schema: (portId) => schemaOf(inputs[portId]),
    attributes: (portId, part) => attributeSchema(inputs[portId], part),
    column: (paramId) => {
      const p = findParam(def, paramId)
      return p && p.kind === 'column' ? resolveColumn(p, params, inputs) : undefined
    },
    columns: (paramId) => {
      const p = findParam(def, paramId)
      return p && p.kind === 'columns' ? resolveColumns(p, params, inputs) : []
    },
  }
}
