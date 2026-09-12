/**
 * What the model is told Coda can do — read straight off the node registry.
 *
 * The registry is already a complete, self-describing catalogue: every listable definition
 * carries a label, a category, a description, typed ports and typed params, and two thirds of
 * the params carry `help`. So there is no hand-written tool schema here and there must never
 * be one — a second list of what the nodes are would be wrong the first time somebody adds a
 * node, and wrong silently, since nothing would fail to compile.
 *
 * The rendering is line-oriented rather than JSON because it is the same information either
 * way and this is the half a human has to read when the model gets something wrong.
 *
 * **It must stay byte-identical between calls.** It is the cached prefix (see `client.ts`), so
 * anything per-request — the current graph, a timestamp — belongs in the user turn instead.
 *
 * **It is 44,735 characters at the default `lean` detail, and 112,682 at `full` — re-measured,
 * because the figure here was written at 77 nodes and there are now 102.** The split matters
 * more than it used to: `lean` is what ships (see `DEFAULT_DETAIL`), and it omits every param's
 * `help`, so a node's `description` is the *only* prose the model gets about it. Ollama's
 * earlier count was 16,587 tokens for a 65,076-character rendering; a Claude tokenizer reads
 * higher, since identifiers (`edgeWeightInfluence`, `countDistinct`) tokenize far worse than
 * prose. Inside the catalogue, across 560 plannable params of which 175 are `presentational`:
 *
 *  - param `help` text is 66.6k chars, **59% of `full`** — by far the largest single component,
 *    and the whole of the difference between the two detail levels
 *  - eight of the hundred-and-two nodes are **33%** of that: `out.viewer3d` (37 params),
 *    `out.network` (41), `out.topology` (17), `out.heatmap` (16), `neuron.connectivity`,
 *    `neuron.influence`, `neuron.cleanMeshes` and `neuron.paths`
 *  - `presentational` params carry 16.6k of the help, **15% of `full`**
 *  - node descriptions are 7.0k, and the rest is ports, `carries:` lines and enum options
 *
 * What each trim is worth, rendered and counted rather than reasoned about (±3%, the model of
 * the renderer used to measure them is not this one). **These were measured against `full` at 77
 * nodes**, so read them as ratios rather than as today's absolute token counts — the first is
 * what `lean` already does:
 *
 *  - drop `help` on `presentational` params: **-13%**, to ~14.7k tokens
 *  - drop presentational params outright: **-20%** — but `plannableParams` has to refuse them
 *    too, or the model is refused for using a param it was never shown, and the assistant loses
 *    "colour the network by type" entirely
 *  - drop all `help`: **-55%**, to ~8.1k, and goes too far: `help` is what says `minWeight`
 *    prunes edges rather than filtering neurons
 *  - name, description and ports only — an index, no params: **-75%**, to ~5k
 *
 * **Do not make the catalogue per-request, and do not fetch it in pieces.** The reason is
 * stronger than the Anthropic cache discount that first motivated byte-identity. Measured
 * against Ollama on one machine: the first question of a session pays 120 s of prompt
 * evaluation, and *every question after it pays 4.4 s* — a 27x drop, because llama.cpp reuses
 * the KV cache for the longest common prefix and only the user turn is new. A catalogue that
 * varied per request would re-pay the 120 s on every turn. An index-plus-lookup design keeps
 * the reuse only if the index stays the prefix and the detail is appended after it, and it
 * still costs an extra generation round trip — which on a local model is minutes, against a
 * prefill that is already amortised to seconds. The size is worth trimming for the KV memory
 * and the first-turn cost, not for per-turn speed.
 *
 * See `_TODOs.md`.
 */

import type { ParamDef } from '../core/node'
import type { PortDef } from '../core/node'
import type { NodeDefinition } from '../core/node'
import type { CodaGraph } from '../core/graph'
import { GRAPH_FORMAT_VERSION } from '../core/graph'
import { inferGraph, nodeTypes } from '../core/inference'
import type { EnumOption, ParamValue, ParamValues } from '../core/node'
import { configurableParams, defaultParams, makeInferContext } from '../core/node'
import { getNodeDef, nodeDefsByCategory } from '../core/registry'
import { defaultInputPorts, defaultOutputPorts } from '../core/ports'
import type { AttributePart, CodaType } from '../core/types'
import { socketLabel } from '../core/sockets'
import { attributeSchema, columnNames } from '../core/types'
import { plannableParams } from './planShape'

/**
 * `dataset (Dataset)` — the port id first, the type in parentheses.
 *
 * Written this way after a live run: the previous form was `out: dataset:Dataset`, and a model
 * read the *label* `out` as the port id and tried to wire from it. Twice, on a node whose only
 * output is called `dataset`. Anything that can be mistaken for a port id has to not sit where
 * a port id goes.
 */
function renderPort(port: PortDef, side: 'in' | 'out'): string {
  const optional = side === 'in' && port.required === false ? '?' : ''
  /*
   * `socketLabel`, so a port declared `T.any()` for a union prints the union's name. Not
   * measured as a prompt change and not claimed as one — it is here because the alternative is
   * the catalogue being the one surface still saying `Any` where five others say `Geometries`,
   * and this file's own note is that a fact stated two ways is worse than either.
   */
  return `${port.id}${optional} (${socketLabel(port)})`
}

/**
 * `labelColumn column default=type (reads the annotations input)` — where a picker's column
 * names come from, when that input is one the node can run without.
 *
 * **Measured, and the failure is a plan that looks finished.** Asked to label a dendrogram's
 * leaves by cell type, a model set `labelColumn` and wired nothing: "Configure the dendrogram to
 * use the 'type' column for leaf labels" — `0 added, 0 wired, 1 set`. The param is real, the
 * value is right, and the picker is inert because `annotations` is empty. Nothing refuses it,
 * because an unwired optional port is an ordinary half-built graph.
 *
 * The information was in the definition all along — `ColumnParam.from` names the port — and
 * simply was not rendered, so under `lean` all the model saw was `labelColumn column`.
 *
 * **Only for an *optional* port**, which is the whole asymmetry: 97 column params read a
 * required input, and there the model has to wire it to use the node at all, so saying so costs
 * 2.4k characters to repeat what the port list already forces. Sixteen read an optional one, and
 * those are exactly the params that can be set while the port stays empty.
 */
function readsFrom(param: ParamDef, optionalInputs: ReadonlySet<string>): string {
  const from = 'from' in param ? param.from : undefined
  return typeof from === 'string' && optionalInputs.has(from)
    ? ` (reads the ${from} input — wire it, or this does nothing)`
    : ''
}

/**
 * The values a param can be flipped through to see what it gates, or `undefined` for one that
 * cannot be enumerated.
 *
 * Static enums and booleans only. A dynamic `options` function is skipped for
 * `optionsWithoutPeek`'s reason — asking it may start a request — and a `multiEnum`'s value is a
 * subset, so probing it means enumerating a power set. A `string` or `column` gate is nearly
 * always "is it set at all" (`core.stack`'s labels appear once its source column is named), so
 * those get exactly the two cases that distinguishes, and the sentinel never reaches the page.
 */
function probeValues(param: ParamDef): ParamValue[] | undefined {
  if (param.kind === 'boolean') return [true, false]
  if (param.kind === 'enum' && Array.isArray(param.options)) {
    return param.options.map((o) => o.value)
  }
  if (param.kind === 'string' || param.kind === 'column') return ['', 'set']
  return undefined
}

/**
 * `(not with agg=count)` — the other setting on this node that switches this param off.
 *
 * **Measured, and the failure is a refused plan rather than a bad one.** Building a chart from
 * scratch, a model set `core.groupBy`'s `agg: 'count'` *and* its `value: ['weight']` — count the
 * rows, and also aggregate a column. `value` is `visibleIf: (params) => params.agg !== 'count'`,
 * so `applyPlan` refuses the whole plan ("setting it would do nothing"), correctly: dropping the
 * param quietly is the silent success that module is arranged to avoid. The repair round was
 * handed the exact error and made the same mistake again. ~1 run in 10.
 *
 * **Derived by probing the predicate, never transcribed.** `visibleIf` is an arbitrary function,
 * so there is nothing to read — but there is something to *ask*: hold every other param at its
 * default, flip one through its own declared values, and see whether this param's visibility
 * moves. What comes out cannot drift from the gate `configurableParams` enforces, because it is
 * that gate answering. A hand-written phrase beside the predicate is the second spelling this
 * codebase keeps a rule about.
 *
 * 137 params carry a `visibleIf` and 93 answer to a single flip. The rest — gates needing two
 * params set together, or reading something this cannot enumerate — stay silent, which is the
 * same "unknown, never none" the missing `carries:` line means.
 *
 * Never throws: a predicate handed a combination it did not expect must not take the prompt down.
 */
export function gateNote(def: NodeDefinition, param: ParamDef): string {
  const gate = param.visibleIf
  if (!gate) return ''
  const base = defaultParams(def)
  const notes: string[] = []

  for (const other of def.params ?? []) {
    if (other.id === param.id || notes.length >= GATE_NOTES) continue
    const values = probeValues(other)
    if (!values) continue

    const shown: ParamValue[] = []
    const hidden: ParamValue[] = []
    for (const value of values) {
      let visible: boolean
      try {
        visible = gate({ ...base, [other.id]: value })
      } catch {
        return ''
      }
      ;(visible ? shown : hidden).push(value)
    }
    // Flipping it changed nothing, so it is not a gate on this param.
    if (shown.length === 0 || hidden.length === 0) continue

    /*
     * A `string`/`column` gate is about being set at all, so it says that rather than printing
     * the sentinel — and the shorter of the two lists wins elsewhere, since both are exact and
     * `not with agg=count` beats naming the five values that do work. Ties go to the positive,
     * which is the actionable direction for a boolean.
     */
    if (other.kind === 'string' || other.kind === 'column') {
      notes.push(
        hidden.includes('') ? `only with ${other.id} set` : `only with ${other.id} unset`,
      )
    } else if (hidden.length < shown.length) {
      notes.push(`not with ${other.id}=${hidden.join('|')}`)
    } else {
      notes.push(`only with ${other.id}=${shown.join('|')}`)
    }
  }
  return notes.length > 0 ? ` (${notes.join(', ')})` : ''
}

function renderParam(
  def: NodeDefinition,
  param: ParamDef,
  detail: CatalogueDetail,
  optionalInputs: ReadonlySet<string>,
): string {
  const bits: string[] = [param.id, param.kind]

  if (param.kind === 'enum' || param.kind === 'multiEnum') {
    bits.push(
      typeof param.options === 'function'
        ? '(options depend on the input)'
        : `(${param.options.map((o) => o.value).join(' | ')})`,
    )
  }
  // What empty means, for the kind where empty is a choice rather than an omission. Without it
  // a model reads `[]` as "unset" and fills the list in to be helpful.
  if (param.kind === 'multiEnum' && param.emptyLabel) bits.push(`(empty = ${param.emptyLabel})`)

  if (param.kind === 'number' || param.kind === 'int') {
    // Printed because `validateParamValue` enforces them: a bound the model cannot see is a
    // refusal it cannot avoid.
    if (param.min !== undefined) bits.push(`min=${param.min}`)
    if (param.max !== undefined) bits.push(`max=${param.max}`)
  }

  const value = (param as { default?: unknown }).default
  if (Array.isArray(value)) {
    if (value.length) bits.push(`default=[${value.join(',')}]`)
  } else if (value !== undefined && value !== '') {
    bits.push(`default=${String(value)}`)
  }

  const line = bits.join(' ') + readsFrom(param, optionalInputs) + gateNote(def, param)
  /*
   * `lean` keeps the name, the kind, the bounds and the enum options — everything a plan can be
   * *refused* for getting wrong — and drops only the prose. See `CatalogueDetail`.
   *
   * `catalogueNote` survives it, which is the one asymmetry: `help` says what a setting means,
   * and a plan is not refused for not knowing that. A note says how the value is *written*, and
   * without it the param cannot be set at all — a lean catalogue that dropped it would list a
   * control nothing can reach. It goes on its own indented lines because the ones that need one
   * are grammars rather than sentences.
   */
  const noted = param.catalogueNote
    ? [
        line,
        ...param.catalogueNote
          .trim()
          .split('\n')
          .map((l) => `    ${l}`),
      ].join('\n')
    : line
  return detail === 'full' && param.help ? `${noted} — ${param.help}` : noted
}

/**
 * The columns a node produces on its own, with nothing wired to it.
 *
 * Asked by inferring a one-node graph rather than by building a context by hand: it is the
 * same pass the editor runs, so this cannot disagree with what the canvas will say, and
 * `inferOutputs` is forbidden to throw (invariant 2) so a node pack cannot break the prompt.
 *
 * Only some nodes answer. A `Filter` derives its columns from an input it does not have, so it
 * says nothing; a `Connectivity` builds the same seven whatever it is given, so it says all of
 * them — which is the case that matters, because a bar chart's category comes from exactly
 * there. Where a dataset would add more (a discovered neuron property), this under-reports and
 * `describeGraph` corrects it the moment the node is on the canvas.
 */
/**
 * The columns a port carries, as `[label, names]` — one entry for a table, two for a network.
 *
 * `schemaOf` covers only `table` and `neurons`, and using it alone was a real gap: a Network
 * port advertised no columns at all, so a model configuring the viewer reached for a *neuron*
 * column name and produced `Column "post" is gone` on the card. Network, Skeletons, Meshes and
 * Points all pair their geometry with an ordinary attribute table — that is the whole point of
 * the value model — so `attributeSchema` is the function that answers for all of them.
 */
export function portColumns(type: CodaType): Array<[string, string[]]> {
  if (type.kind === 'network') {
    const parts: Array<[string, AttributePart]> = [
      ['nodes', 'nodes'],
      ['links', 'edges'],
    ]
    return parts
      .map(([label, part]): [string, string[]] => [
        label,
        columnNames(attributeSchema(type, part)),
      ])
      .filter(([, names]) => names.length > 0)
  }
  const names = columnNames(attributeSchema(type))
  return names.length ? [['', names]] : []
}

/**
 * How many of a param's live options are printed before the rest are counted.
 *
 * Twelve: `core.filterTable`'s nine operators fit whole, which is the case this exists for, and
 * a Connectivity node's ROI list runs to hundreds — where naming twelve tells the model the
 * shape of the vocabulary without spending the whole user turn on region names.
 */
const OPTION_VALUES = 12

/**
 * How many gates one param's note may name.
 *
 * Two. A param answering to three flips is describing a mode system rather than a gate, and the
 * line stops being readable before it stops being true.
 */
const GATE_NOTES = 2

/**
 * `op = eq | ne | contains | …` — what a param's options actually are on *this* node.
 *
 * The counterpart to the `(options depend on the input)` that `renderParam` prints one screen
 * up, and it belongs beside it: the catalogue describes a node *type*, so it genuinely cannot
 * know: `core.filterTable`'s operators depend on the dtype of the column somebody picked. The
 * canvas can. So the type gets the apology and the graph listing gets the answer.
 *
 * **Measured, not anticipated.** Asked to filter a table to its commonest partner type, both
 * `qwen3.8` locally and a cloud model wrote `op: "is"` — which is the *label* of the `eq`
 * option, from `tableOps.ts`. Nothing refuses it: `validateParamValue` skips dynamic options
 * by design, so the plan applies and the node carries `"is" does not apply to a str column`
 * where the user has to find it.
 *
 * **Only `optionsWithoutPeek` params are resolved, and that is a safety property rather than a
 * filter.** `dataset.*.version` reads `peekDatasets`, which starts the fetch it cannot answer —
 * so resolving every dynamic param here would fire a dataset listing per dataset node, at two
 * CATMAID servers and CAVE, because somebody asked a question. See the flag's own comment.
 *
 * Never throws, for `inferOutputs`' reason one file over: this runs on a graph the user is
 * holding, and a node pack whose options function is unhappy must not take the prompt down.
 */
export function optionLines(
  def: NodeDefinition,
  params: ParamValues,
  inputs: Readonly<Record<string, CodaType | undefined>>,
): string[] {
  const lines: string[] = []
  const ctx = makeInferContext(def, params, inputs)
  // `configurableParams` rather than `plannableParams`: a param the node's own values have
  // switched off is one a plan may not set, so naming its options would be an invitation.
  for (const param of configurableParams(def, params)) {
    if (param.kind !== 'enum' && param.kind !== 'multiEnum') continue
    if (typeof param.options !== 'function' || param.optionsWithoutPeek !== true) continue

    let options: EnumOption[]
    try {
      options = param.options(ctx)
    } catch {
      continue
    }
    if (options.length === 0) continue

    /*
     * `""` rather than a word like `(empty)`. Four of these params default to the empty option
     * — Automatic, or none — so it is the commonest *correct* answer, and a model writes what it
     * is shown: `(empty)` goes into the plan verbatim and is refused, where `""` is the value.
     */
    const shown = options.slice(0, OPTION_VALUES).map((o) => (o.value === '' ? '""' : o.value))
    const rest = options.length - shown.length
    // The fold is counted, the digest's rule: a list read as complete is a value silently ruled
    // out. Here it is worse than in the digest, because an unlisted value is simply refused.
    lines.push(`${param.id} = ${shown.join(' | ')}${rest > 0 ? ` … and ${rest} more` : ''}`)
  }
  return lines
}

/**
 * `labels1 comes from compare.matchTypes (Match Cell Types): …` — which node fills this port.
 *
 * `PortDef.producedBy`, rendered. The fact is invisible to everything else the catalogue
 * prints: `isAssignable` ignores schema, so both ends of the pair read `Table{?}` and nothing
 * says they are a pair.
 *
 * **The wording is the measurement.** Asked for a three-dataset comparison, a model wired each
 * Connectivity's neuron table into `Compare Connectivity`'s Labels ports and never added the
 * mapper — `0/5`, five runs against `gemma4:31b-cloud` on an empty canvas. Three cheaper
 * spellings of the same fact were tried, five runs each, and the ranking is not the one the
 * sizes suggest:
 *
 *  - declare the port as `Table{neuronId, label}` so the type line names the shape: **0/5**, and
 *    it made things worse — the model started hand-rolling `core.select` and `core.rename` to
 *    manufacture something label-shaped rather than reaching for the node that already emits it
 *  - render `def.guide`, whose first sentence is *"plus its labels from Match Cell Types"*:
 *    **1/5**, for +35k characters — a 62% larger prompt at `lean`, all 102 nodes
 *  - a tag inside the port list, `labels1 (Table{?}) [from compare.matchTypes]`: **0/5**
 *  - this: a whole sentence, on its own line, in the `carries:` family, saying what to *do*:
 *    **7/10**
 *
 * So it is not an information gap — the fact was on the page, on the very port, and was ignored
 * nine times in ten. What the model reads is the line-per-fact block under the ports, which
 * `RULES` teaches it to read for `carries:`. The ceiling is `3/3`: naming the node in the
 * request has always worked, so this was discovery, never capability.
 *
 * Rendered at `lean` as well as `full`, per that level's rule — it is a fact a plan can be
 * wrong about, not what a setting means.
 */
function producerLines(inputs: readonly PortDef[]): string[] {
  const lines: string[] = []
  for (const port of inputs) {
    if (!port.producedBy) continue
    const { type, port: source = port.id } = port.producedBy
    const def = getNodeDef(type)
    lines.push(
      `${port.id} comes from ${type}${def ? ` (${def.label})` : ''}: ` +
        `add one and wire its ${source} output here.`,
    )
  }
  return lines
}

/**
 * `wire exactly one of: matrix, features, neighbours` — ports that are alternatives.
 *
 * `PortDef.exclusiveGroup`, rendered, and it borrows `producerLines`' proven shape rather than
 * inventing one: a whole sentence on its own line, in the block `RULES` teaches the model to
 * read, saying what to *do* rather than stating a property.
 *
 * **Unlike `producerLines`, this has not been measured**, and the distinction is worth keeping
 * rather than letting the neighbouring docstring's numbers rub off on it. One node declares a
 * group today, so a five-runs-per-side comparison would be measuring one prompt line against
 * the noise of a single case. What makes it worth shipping unmeasured is that there is already
 * a backstop: `applyPlan` type-checks a plan and would accept two of these wired, but `runTurn`
 * previews it and hands back `ApplyOk.warnings` — which is where this node's own `validate`
 * says which port to disconnect. This is the cheaper half of that loop, not the only one.
 */
function exclusiveLines(inputs: readonly PortDef[]): string[] {
  const groups = new Map<string, string[]>()
  for (const port of inputs) {
    if (!port.exclusiveGroup) continue
    groups.set(port.exclusiveGroup, [...(groups.get(port.exclusiveGroup) ?? []), port.id])
  }
  return [...groups.values()]
    .filter((ports) => ports.length > 1)
    .map((ports) => `wire exactly one of: ${ports.join(', ')} — they are alternatives.`)
}

/** `connections carries: a, b` — or `network carries (links): …` where a port has two tables. */
export function carriesLines(outputs: Readonly<Record<string, CodaType>>): string[] {
  const lines: string[] = []
  for (const [portId, type] of Object.entries(outputs)) {
    for (const [label, names] of portColumns(type)) {
      lines.push(`${portId} carries${label ? ` (${label})` : ''}: ${names.join(', ')}`)
    }
  }
  return lines
}

function producedColumns(def: NodeDefinition): string[] {
  const probe: CodaGraph = {
    version: GRAPH_FORMAT_VERSION,
    nodes: [
      { id: 'probe', type: def.type, position: { x: 0, y: 0 }, params: defaultParams(def) },
    ],
    edges: [],
  }
  return carriesLines(nodeTypes(inferGraph(probe), 'probe').outputs)
}

function renderNode(def: NodeDefinition, detail: CatalogueDetail): string {
  const lines: string[] = []
  lines.push(`## ${def.type} — ${def.label} (${def.category}, ${def.cost})`)
  if (def.description) lines.push(def.description)

  // No params: the catalogue describes a node *type*, so a variadic node is listed at the
  // arity a fresh one opens at. The assistant sets the count param like any other.
  const inputs = defaultInputPorts(def)
  const outputs = defaultOutputPorts(def)
  const list = (ports: readonly PortDef[], side: 'in' | 'out') =>
    ports.length ? ports.map((p) => renderPort(p, side)).join('  ') : 'none'
  lines.push(`inputs:  ${list(inputs, 'in')}`)
  lines.push(`outputs: ${list(outputs, 'out')}`)

  lines.push(...producerLines(inputs))
  lines.push(...exclusiveLines(inputs))
  lines.push(...producedColumns(def))
  // See `NodeDefinition.catalogueNote`: what this node needs *around* it, which nothing else
  // printed here can say. After the ports and columns, in the line-per-fact block the rules
  // teach the model to read.
  if (def.catalogueNote) lines.push(`note: ${def.catalogueNote}`)

  const params = plannableParams(def)
  if (params.length) {
    // The optional ones only — see `readsFrom`. `inputs` is already in hand from the port list.
    const optionalInputs = new Set(inputs.filter((p) => p.required === false).map((p) => p.id))
    lines.push('params:')
    for (const param of params) {
      lines.push(`  ${renderParam(def, param, detail, optionalInputs)}`)
    }
  }
  return lines.join('\n')
}

/**
 * How much of each param is printed.
 *
 * `full` is everything. `lean` drops the `help` prose and keeps the name, kind, bounds and enum
 * options — which is to say it keeps everything a plan can be *refused* for getting wrong, and
 * drops only what a setting means. That is 52% of the catalogue: 62.1k characters against 28.9k.
 *
 * As a whole system prompt that is 31,984 characters against 65,230. Ollama counts **9,167
 * tokens against 16,643**; Anthropic reads the same text higher and counts **15,036 against
 * 25,935**, mean over eighteen turns each. Either way it is a 42–45% cut in what every request
 * carries.
 *
 * It does **not** buy a smaller `num_ctx`, though that was the first thing assumed of it — see
 * `data/ai/ollama.ts`, where the measurement is.
 *
 * **`lean` is the default, and that was measured rather than argued.** Three full-suite reps at
 * each level against Sonnet 5 and three against `qwen3.8:latest`: **15/15 and 15/15** on Sonnet,
 * 39/40 lean against 37/40 full locally, zero refusals either way. The case `help` prose should
 * matter most for — finding `neuron.paths` rather than assembling a chain of Connectivity nodes
 * by hand — produced the *identical* six-node graph on all six Sonnet runs, lean and full alike.
 * Nothing measurable was lost with half the prompt gone.
 *
 * `full` stays because that comparison has to remain runnable: a catalogue that grows a new kind
 * of prose, or a different default model, re-opens the question. `live.test.ts` runs either level
 * — see `CODA_ASSISTANT_CATALOGUE` there, and `scripts/compare-catalogue.sh`, which is the whole
 * experiment in one command.
 *
 * Carried as an argument rather than as a module-level setting, and that is the same decision
 * `PlanRequest.inference` makes one file over: a knob a caller chooses per request needs no
 * mutable global, and a global would be reachable by anything, at any time, to invalidate every
 * cached prefix — Anthropic's and the local KV cache both. Choosing a level *once* is not what
 * the header above forbids; varying the catalogue *per request* is, and a caller passing a
 * constant does neither.
 */
export type CatalogueDetail = 'full' | 'lean'

const DEFAULT_DETAIL: CatalogueDetail = 'lean'

/** Every node a plan may name, grouped by the categories the add menu already uses. */
export function catalogueText(detail: CatalogueDetail = DEFAULT_DETAIL): string {
  const sections: string[] = []
  for (const { category, defs } of nodeDefsByCategory()) {
    sections.push(`# ${category}`)
    for (const def of defs) sections.push(renderNode(def, detail))
  }
  return sections.join('\n\n')
}

/**
 * The rules half of the system prompt.
 *
 * Everything here is a fact about *this* editor that the catalogue does not state and the
 * model cannot infer — the ref/id split, what a plan may not decide, and the two places where
 * doing the obviously helpful thing produces a graph that is wrong in a way nobody would spot.
 */
const RULES = `
You are an assistant inside Coda, a node-graph editor for connectome analysis. You answer by
emitting a *plan*: a description of an edit to the graph on the canvas. Something else applies
it, atomically, after checking every wire — so a plan is either applied whole or refused whole,
and you get the refusal back with every problem named. Getting it right first time is cheaper
than being clever.

How a plan is written:
- \`add\` creates nodes. Each carries a \`ref\` — a short handle you invent, unique in the plan
  — which \`connect\` and \`setParams\` use to refer to it. It is not a graph id and never
  appears on the canvas.
- Existing nodes are named by the id shown in the current-graph listing. A ref must not be one
  of those ids.
- \`connect\` wires an output to an input, naming ports by the ids in the catalogue above.
  Input ports take one wire: connecting to an occupied input re-points it rather than failing.
- \`disconnect\` cuts a wire, named by its *input* end.
- \`remove\` deletes existing nodes, and takes their wires with them.
- Positions are not yours to set. Nodes are laid out for you.

What makes a plan fail:
- A node type that is not in the catalogue above, a port that node does not have, a param that
  node does not have, or a value of the wrong kind.
- A param value written in the wrong JSON type. The catalogue names each param's kind right
  after its id: a \`number\` or \`int\` takes \`3\`, not \`"3"\`; a \`boolean\` takes \`true\`, not
  \`"true"\`; an \`enum\` takes one of its listed options *exactly as written*, quoted even when
  the option looks like a number; a \`multiEnum\` takes a list of them.
- A wire the type system refuses. Read the port types: an output only fits an input of a type
  it is assignable to, and \`any\` accepts anything.
- A wire that would make a cycle.

Column params — set them when you can, and you often can:
- A \`carries:\` line says which columns a port holds. Use those names. A Bar Chart fed by a
  Connectivity node should name its category and value, not be left blank.
- The current-graph listing carries the same line per node, and it is the authoritative one:
  a dataset adds properties the catalogue above cannot know about.
- An \`options:\` line lists what a param whose catalogue entry says *options depend on the
  input* actually offers on **that** node, as it is wired right now. Where one is present it is
  the only correct source: write the value exactly as listed. \`… and N more\` means the list was
  cut, so a value you cannot see may still be legal — but one you invent will be refused.
- When no \`carries:\` line covers what you need, leave the param at its default and say so in
  your reply. Guessing a column name that does not exist fails at run time. A Pivot or a raw
  Cypher is the usual case: what it emits depends on the data, so it publishes nothing until
  the graph has been run — and once it has, its real columns are in the listing like any
  other's. A missing line means unknown, never none.

What a run tells you, where the graph has been run:
- A \`ran:\` line reports what a node produced, and it is only there when the node's *current*
  settings are the ones that produced it. Use what is in it — an actual value for a filter, an
  actual range for a threshold — rather than guessing one.
- A value list reading \`61 distinct, 8 commonest:\` shows eight of sixty-one. **It is not the
  set of values.** Do not conclude that anything is absent from a column because it is absent
  from that line, and do not write a filter whose correctness depends on the list being complete.
- Numeric columns give a range and a median rather than a list, because a threshold is chosen
  from the spread. Id columns give a count and no values at all.
- \`(same columns as n3:out)\` means this port holds a table that summarises identically to that
  one — a Sort or a viewer passing rows through. It is a fact worth having, not an omission.
- No \`ran:\` line means the node has not run, or its settings have moved since it did. That is
  unknown, never none — the same rule as a missing \`carries:\` line.

What is fine, and should not stop you:
- A column you genuinely cannot know yet, per the above.
- A required input left unwired, when the user has not said what should feed it.
- An empty canvas. Add every node the request needs, the Dataset included — there is nothing
  to wait for and nothing that has to be there first.
- Not knowing the data. You cannot see it: whether a type exists, how many rows there are, what
  a column holds. Build the pipeline that would answer the question, and never report a lookup
  you did not make.

Two things to be careful about:
- Query nodes hit a shared production database. Do not add more of them than the request needs,
  and leave limits at their defaults unless asked.
- Dataset nodes: there is one type per published dataset. An empty \`version\` means the latest,
  which is what you want unless the user pinned one. Most query nodes need a Dataset wired to
  their dataset input.

Answer with a plan and nothing else. If the request needs no edit — a question about the graph,
or something no node in the catalogue does — return an empty plan whose \`summary\` says so in one
sentence. Being unsure how to build something is not one of those cases: attempt it.
`.trim()

const cachedPrompt = new Map<CatalogueDetail, string>()

/**
 * The cached prefix: the rules, then the catalogue.
 *
 * Memoised, and not for the 0.1ms — for the byte-identity. This string is the thing the
 * request marks as its cache breakpoint, so a single character differing between turns costs
 * a full re-prefill of ~7k tokens. Built once, it is identical by construction rather than by
 * `nodeDefsByCategory` happening to iterate in a stable order.
 *
 * Lazy rather than a module-level `const`: this module does not import `../nodes`, so building
 * it at import time would freeze whatever half of the registry had registered by then. The
 * registry is append-only and `registerNode` throws on a duplicate, so nothing can invalidate
 * it afterwards.
 */
export function buildSystemPrompt(detail: CatalogueDetail = DEFAULT_DETAIL): string {
  const held = cachedPrompt.get(detail)
  if (held !== undefined) return held
  const built = `${RULES}\n\n---\n\nThe node catalogue. Every type a plan may name is here.\n\n${catalogueText(detail)}`
  cachedPrompt.set(detail, built)
  return built
}
