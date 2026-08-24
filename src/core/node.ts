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
  /**
   * Inputs only. This port names a node rather than consuming its output.
   *
   * **It creates no ordering dependency**, so it is excluded from `topoSort` and from
   * `wouldCreateCycle`, and the scheduler never waits on it. That is what lets a node sit
   * *between* a dataset and itself — `CAVE table → Dataset` needs to know which datastack to
   * read out of, and wiring the dataset in makes two edges between one pair in opposite
   * directions, which is a cycle at node granularity even though nothing circular is being
   * computed.
   *
   * **What makes it sound is a property of the upstream node, not a promise from this one**: a
   * dataset node's *identity* is a function of its params alone — `T.dataset(family.sourceId,
   * resolveDatasetId(family, params.version), …)` — and only the annotations *schema* comes from
   * an input. So the thing a reference reads is knowable without running, or even inferring,
   * anything downstream of it. Inference resolves the type by inferring the source node **with no
   * inputs of its own**, which cannot recurse and yields exactly the identity, without the
   * annotations schema. That is the honest answer as well as the terminating one: a node cannot
   * read the annotations it is about to supply.
   *
   * So it is deliberately **narrow — a Dataset socket that takes the identity only**, not a
   * general "information edge". Synthesising a value from a type is defensible only because we
   * know what a dataset identity is; there is no second kind asking for it.
   *
   * `evaluate` receives a `DatasetValue` built from that type, carrying no annotations, and the
   * provenance key takes the type's hash in place of the upstream node's key — so changing the
   * dataset's version re-keys this node and changing its annotations does not, which is right
   * because this node never reads them.
   */
  reference?: boolean
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
  /**
   * Draw it as a range slider rather than as a number field.
   *
   * Opt-in, and only sensible where the number is a *proportion* somebody adjusts by feel and
   * watches the result of — an opacity, not a limit or a budget. A slider needs both bounds to
   * mean anything, so one without `min` and `max` falls back to the field.
   */
  slider?: boolean
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
  /**
   * Restrict to these dtypes. Undefined = any dtype.
   *
   * A function where the restriction depends on the node's other params — Group By's value
   * picker is numeric for every aggregation except `join`, which takes text. `schemaFrom` is
   * already function-valued for the same reason; before this was, the only way to express it
   * was two stored params made exclusive by `visibleIf`, which is a second param in the saved
   * document and a branch at every reader.
   */
  dtypes?: DType[] | ((params: ParamValues) => DType[] | undefined)
  /** Overrides how the schema is found; `from` still says which port must be connected. */
  schemaFrom?: ColumnSchemaSource
  /** Empty string means "first compatible column", resolved consistently at both stages. */
  default: string
  /** Allow an explicit "none" choice — used by optional encodings. */
  optional?: boolean
}

/**
 * Several values chosen from a list the node supplies — the multi-valued `enum`.
 *
 * `enum` : `multiEnum` :: `column` : `columns`, and the parallel is worth taking literally:
 * the options come from the same place, the widget is the same chips-plus-add control the
 * `columns` picker uses, and empty means whatever the node says it means rather than "invalid".
 *
 * It exists because the alternatives for "pick some regions" were all worse. A single `enum`
 * cannot say two of them. An `ids` param is read-only in the inspector by design — its whole
 * premise is that no generic widget could edit it, which is false here, since the source
 * publishes the list. And a free-text `string` would have somebody typing `ME(R), LO(R)` by
 * hand, exactly, parentheses included, with a silent empty result for a typo.
 */
export interface MultiEnumParam extends ParamBase {
  kind: 'multiEnum'
  default: string[]
  /** Static, or derived from the resolved input types the way `enum`'s is. */
  options: EnumOption[] | ((ctx: InferContext) => EnumOption[])
  /**
   * What an empty selection means, in words, shown where the chips would be.
   *
   * Required in spirit: on a picker whose options are supplied rather than typed, empty is a
   * *decision the node interprets* — "every region", "the primary set" — and a control that
   * shows nothing for it is a control whose most common state says nothing.
   */
  emptyLabel?: string
  /** Word for one entry, for the add control's labels. Defaults to "option". */
  noun?: string
}

/** Ordered multi-column reference (group-by keys, selected columns). */
export interface ColumnsParam extends ParamBase {
  kind: 'columns'
  from: string
  part?: AttributePart
  /** As `ColumnParam.dtypes`. */
  dtypes?: DType[] | ((params: ParamValues) => DType[] | undefined)
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
 * An opaque `string[]` that a bespoke surface owns, rather than a value a generic widget edits.
 *
 * Two shapes use it, and the second is why this says "opaque" rather than "ids": a **viewer's
 * selection** (`out.scatter`, `out.network`, Explore), and a **list somebody grows** whose
 * length is not known when the definition is written — `out.table`'s per-column filter clauses
 * and `core.rename`'s remappings, both `[a, b]` entries encoded by `paramPairs.ts`. What makes
 * something eligible is that no generic widget could meaningfully edit it, so the node brings
 * its own card or viewer; `IdsField` is the read-and-clear fallback the inspector shows.
 *
 * Neither of those two shapes is ever presentational: what a viewer selected and what a card
 * configured both feed a downstream output, so they belong in the provenance key and in the
 * saved file. There is now a **third** shape that is — the 3D viewer's per-channel list of
 * hidden legend keys — and it is worth saying why it does not break the rule rather than
 * leaving the exception to look like a mistake. That list is read by the *drawing* and by
 * nothing else; `evaluate` never sees it, so no downstream result can go stale behind it. The
 * test is what reads the param, not what kind it is.
 */
export interface IdsParam extends ParamBase {
  kind: 'ids'
  default: string[]
  /** Noun for the summary widget, e.g. "neurons". */
  noun?: string
}

export type ParamDef =
  | NumberParam
  | StringParam
  | BooleanParam
  | EnumParam
  | MultiEnumParam
  | ColumnParam
  | ColumnsParam
  | IdsParam

/**
 * The `refresh` nonce a node carries when its data can change under fixed params.
 *
 * Cache keys are provenance, so nothing downstream can see that a server's rows changed. This is
 * the sanctioned escape hatch, and it is `internal` because bumping it by hand is not the point —
 * `hiddenParams.test.tsx` asserts every `refresh` in the registry carries that flag, so a copy
 * that dropped it fails in a file about something else.
 *
 * `help` differs per node because what "changed" means differs — a dataset listing against an
 * annotation base edited daily — so it is an argument rather than a fixed string.
 */
export function refreshParam(help: string) {
  return {
    id: 'refresh',
    kind: 'int',
    label: 'Refresh',
    help,
    default: 0,
    min: 0,
    advanced: true,
    internal: true,
  } as const
}

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
  /**
   * The provenance key of what arrived on a port — undefined when nothing is wired.
   *
   * For a node that has to publish an *identity* for a value it passes on, so something further
   * down can key a cache by it. The chain of annotation sources is the case: what identifies an
   * annotation table is no longer the refs that fetched it, because a Filter may sit in between,
   * and the honest answer is the same one the scheduler already computed to decide this node
   * should run at all — `hash(type, params, upstream)`, which is provenance rather than content
   * (invariant 4) and changes exactly when the table would.
   *
   * Not the node's *own* key, which would fold in params of this node that have nothing to do
   * with the value on that port.
   */
  inputKey(portId: string): string | undefined
  /** Same resolution as `InferContext.column`, so infer and eval never disagree. */
  column(paramId: string): string | undefined
  columns(paramId: string): string[]
  /** Look up a registered data source by id (from a DatasetValue). */
  resolveSource(sourceId: string): DataSource
  /**
   * This run was asked to ignore any persistent data cache for this node.
   *
   * Set by **Clear Cache** on the node, and read by whatever `evaluate` does its fetching
   * through — `loadCachedTable`'s `refresh`, in practice. It is a fact about *this run* rather
   * than about the document, which is the whole difference from the `refresh` nonce it replaced:
   * a nonce had to live in the saved graph and take part in the provenance key, so re-fetching
   * was an edit, it travelled to whoever you sent the file to, and every node wanting the
   * ability grew its own param.
   *
   * Only nodes declaring `dataCache` read it, and the flag is what makes the button appear —
   * one statement, so a node cannot offer Clear Cache and quietly ignore it.
   */
  refresh: boolean
  /** Aborted when the run is superseded or cancelled. Long loops should check it. */
  signal: AbortSignal
  /** Report 0..1 progress for the node's status bar. */
  progress(fraction: number, note?: string): void
  /**
   * Say when the data behind this result was actually read from a server.
   *
   * For a node declaring `dataCache`: a run that answers from `loadCachedTable` is
   * indistinguishable from one that reached the network, so the card cannot say "this is a
   * month-old copy of a base somebody edits daily" unless it is told.
   *
   * Reported rather than inferred, and kept in the scheduler's **cache entry** rather than in
   * `NodeRunInfo`, which is what makes it survive a result being restored instead of recomputed —
   * the distinction `unmatchedLabels` and `PathsBody` both work around by deriving from the
   * result. There is nothing to derive here: an age is not in the rows.
   *
   * The **oldest** report of a run wins, so a node making several fetches says how old the
   * stalest thing behind its answer is. Ignore it and the card simply says nothing, which is the
   * honest state for a node that did not fetch.
   */
  reportFetched(at: number): void
}

export interface NodeDefinition<P extends ParamValues = ParamValues> {
  /** Stable id, namespaced: "core.filter", "neuron.findNeurons". Persisted in files. */
  type: string
  label: string
  category: NodeCategory
  /** One line, sized for a palette row and the node browser. Kept terse on purpose. */
  description?: string
  /**
   * Two or three sentences for the node guide (`nodes.html`) — what the node is for, what it
   * hands on, and the one thing that surprises people about it.
   *
   * Separate from `description` rather than a longer version of it, because the two are read
   * in different places at different moments: a palette row has one line of space and somebody
   * scanning it already knows roughly what they want, where a guide page is read by somebody
   * deciding whether this is the node at all. Collapsing them would make one of the two wrong —
   * a palette row wrapping to four lines, or a guide entry that says nothing.
   *
   * Prose, not markdown: the guide renders it as a paragraph, and a subset parser there would
   * be a second copy of `ui/markdown.ts` on a page that deliberately imports nothing.
   */
  guide?: string
  cost: NodeCost
  /**
   * `evaluate` reads through a persistent data cache, so a run may answer from storage rather
   * than from the server.
   *
   * Two things at once, deliberately paired. It puts **Clear Cache** on the node's menu and in
   * the inspector, and it declares that `evaluate` honours `ctx.refresh` — a node offering the
   * button and ignoring the flag is a control that does nothing, which is exactly what the
   * `refresh` nonce's absence used to look like from the outside ("Invalidate" cleared the
   * result and the re-run came back instantly from IndexedDB).
   *
   * Not the scheduler's own result cache, which every node has and `Invalidate Results` covers.
   * This is the second layer: `loadCachedTable`'s IndexedDB store, kept for a month and keyed by
   * what was fetched rather than by the graph.
   */
  dataCache?: boolean
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
 * Is this a value the param could hold? `undefined` when it is, otherwise the sentence saying
 * why not, naming the param.
 *
 * Here rather than in the caller that needed it first, for two reasons. It mirrors the
 * `ParamDef` union, and a mirror belongs beside the thing it reflects — the `default` arm
 * assigns to `never`, so adding an eighth param kind fails to compile here instead of falling
 * silently through a switch somewhere else. And it has more than one consumer waiting:
 * anything that accepts params it did not write — a plan from an assistant, a `.coda.json` from
 * another build, a future non-browser executor over the same graph JSON — needs exactly this
 * check and cannot reach into `src/ui` for it.
 *
 * It answers about the *value* alone. Whether the param applies at all is `configurableParams`,
 * because that depends on the node's other values and this cannot see them.
 */
export function validateParamValue(param: ParamDef, value: ParamValue): string | undefined {
  const got = Array.isArray(value) ? 'a list' : `a ${typeof value}`
  const wrongType = (want: string) => `"${param.id}" wants ${want}, got ${got}.`

  switch (param.kind) {
    case 'number':
    case 'int': {
      const whole = param.kind === 'int'
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return wrongType(whole ? 'a whole number' : 'a number')
      }
      if (whole && !Number.isInteger(value))
        return `"${param.id}" wants a whole number, got ${value}.`
      // The definition declares these and the number input honours them, so anything writing a
      // param without going through that input has to honour them too or it is the one route
      // that can store a value the UI would have refused.
      if (param.min !== undefined && value < param.min) {
        return `"${param.id}" must be at least ${param.min}, got ${value}.`
      }
      if (param.max !== undefined && value > param.max) {
        return `"${param.id}" must be at most ${param.max}, got ${value}.`
      }
      return undefined
    }
    case 'string':
      return typeof value === 'string' ? undefined : wrongType('a string')
    case 'boolean':
      return typeof value === 'boolean' ? undefined : wrongType('true or false')
    case 'enum': {
      if (typeof value !== 'string') return wrongType('one of its options')
      /*
       * Options can be a function of the resolved input types (aggregations per dtype, say).
       * Those cannot be listed without an inference context, and building one here would let
       * this disagree with the picker about what is on offer — so a dynamic enum takes any
       * string and the node's own `validate` has the last word.
       */
      if (typeof param.options === 'function') return undefined
      if (param.options.some((o) => o.value === value)) return undefined
      return `"${param.id}" has no option "${value}". Options: ${param.options
        .map((o) => o.value)
        .join(', ')}.`
    }
    case 'column':
      return typeof value === 'string' ? undefined : wrongType('a column name')
    case 'multiEnum': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        return wrongType('a list of strings')
      }
      // Same rule as `enum`, for the same reason: options derived from the inputs cannot be
      // checked without them, and a plan that names a region this dataset does not publish is
      // the node's own `validate` to refuse, with a sentence about the dataset.
      if (typeof param.options === 'function') return undefined
      const allowed = new Set(param.options.map((o) => o.value))
      const stray = (value as string[]).find((v) => !allowed.has(v))
      return stray === undefined
        ? undefined
        : `"${param.id}" has no option "${stray}". Options: ${param.options
            .map((o) => o.value)
            .join(', ')}.`
    }
    case 'columns':
    case 'ids':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? undefined
        : wrongType('a list of strings')
    default: {
      const unreachable: never = param
      return `"${(unreachable as ParamDef).id}" has a param kind nothing can validate.`
    }
  }
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
 *
 * **Rule 3 is skipped entirely when the schema is unknown**, which is `resolveColumns`' guard in
 * the form that fits the singular and was missing here. "The first compatible column" is an
 * answer computed from a list, and a port carrying no schema at all has an *empty* list — so a
 * picker still holding its declared default resolved to **nothing** until the schema landed, and
 * to the right column afterwards. That is the runs-twice-answers-differently signature, in the
 * provenance key.
 *
 * Reported on `Table from URL → Combine Columns → Update root IDs`: `Table from URL` remembers
 * its schema per URL in a session-scoped map, so on a fresh session it publishes none, and
 * `Update root IDs` — whose `ID column` sits on its declared default `neuronId` — failed with
 * "Pick an ID column and a supervoxel ID column" over a picker the card was drawing as empty.
 * Note the asymmetry that hides it: a value *differing* from the default survives by rule 2, so
 * this only ever bites a picker nobody has touched.
 *
 * The guard can only ever *add* an answer, never change one: it fires exactly when `available`
 * is empty, where `available[0]` was already `undefined`.
 *
 * **An unset required picker means the declared default**, which is the other half. A required
 * picker has no "none", so an empty stored value is *unset* rather than a choice — and unset is
 * what `defaultParams` fills with the default at creation. Reading it that way is what keeps the
 * unknown-schema answer and the known-schema one the same: without it, a default naming a real
 * column resolves to that column once the schema arrives and to nothing before, which is the very
 * disagreement above. Inert wherever the default is `''`, which is most pickers — `out.barChart`'s
 * `Category` still means "decide for me".
 */
export function resolveColumn(
  param: ColumnParam,
  params: ParamValues,
  inputs: Readonly<Record<string, CodaType | undefined>>,
): string | undefined {
  const available = availableColumns(param, inputs, params)
  const stored = params[param.id]
  const saved = typeof stored === 'string' ? stored : ''
  /*
   * Unset falls through to the declared default — but only for a *required* picker, which has
   * no "none" to mean. On an optional one an empty value is a choice, and `out.scatter`'s
   * `idColumn: ''` is exactly that: "identify points by row index, not by neuron id". Reading
   * it as unset would hand back `neuronId` and quietly undo it.
   */
  const chosen = saved || (param.optional ? '' : (param.default ?? ''))
  if (chosen && available.includes(chosen)) return chosen
  if (param.optional) return undefined
  if (chosen && chosen !== param.default) return chosen
  // A schema this picker cannot see is not a schema without this column in it, so there is
  // nothing here to pick a first compatible column *from*.
  if (!columnsKnown(param, inputs, params)) return chosen || undefined
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
  if (!columnsKnown(param, inputs, params)) return stored
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

/**
 * Whether the port this picker reads carries a schema *at all*.
 *
 * The unknown-versus-empty question, which `resolveColumn`, `resolveColumns`,
 * `validateColumnParams` and both column widgets all ask — and which is the distinction
 * `columnSchemaFor` answers `undefined` separately from an empty schema for. Named because
 * `!== undefined` at five sites is a rule nobody can grep for.
 */
export function columnsKnown(
  param: ColumnParam | ColumnsParam,
  inputs: Readonly<Record<string, CodaType | undefined>>,
  params: ParamValues,
): boolean {
  return columnSchemaFor(param, inputs, params) !== undefined
}

/** The dtype restriction for these params, whether it was declared as a list or a rule. */
export function dtypesOf(
  param: ColumnParam | ColumnsParam,
  params: ParamValues,
): DType[] | undefined {
  return typeof param.dtypes === 'function' ? param.dtypes(params) : param.dtypes
}

export function availableColumns(
  param: ColumnParam | ColumnsParam,
  inputs: Readonly<Record<string, CodaType | undefined>>,
  params: ParamValues,
): string[] {
  const schema = columnSchemaFor(param, inputs, params)
  if (!schema) return []
  const dtypes = dtypesOf(param, params)
  const cols = dtypes ? columnsOfType(schema, dtypes) : schema.columns
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
    if (!columnsKnown(p, ctx.inputs, ctx.params)) continue
    const available = availableColumns(p, ctx.inputs, ctx.params)
    if (available.length === 0) {
      // An optional picker is allowed to have nothing to offer — that is what optional means.
      // Reporting it puts a warning badge on a node whose control nobody has touched, which
      // is how a genuine issue further down the list stops being read.
      if (p.optional) continue
      const dtypes = dtypesOf(p, ctx.params)
      const restriction = dtypes ? ` of type ${dtypes.join('/')}` : ''
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
         * `out.scatter` declares `neuronId` so a neuron table needs no configuring; on a table
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
