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
import { defaultParams } from '../core/node'
import { nodeDefsByCategory } from '../core/registry'
import { defaultInputPorts, defaultOutputPorts } from '../core/ports'
import type { AttributePart, CodaType } from '../core/types'
import { attributeSchema, columnNames, typeLabel } from '../core/types'
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
  return `${port.id}${optional} (${typeLabel(port.type)})`
}

function renderParam(param: ParamDef, detail: CatalogueDetail): string {
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

  const line = bits.join(' ')
  // `lean` keeps the name, the kind, the bounds and the enum options — everything a plan can be
  // *refused* for getting wrong — and drops only the prose. See `CatalogueDetail`.
  return detail === 'full' && param.help ? `${line} — ${param.help}` : line
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

  lines.push(...producedColumns(def))

  const params = plannableParams(def)
  if (params.length) {
    lines.push('params:')
    for (const param of params) lines.push(`  ${renderParam(param, detail)}`)
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
- When no \`carries:\` line covers what you need, leave the param at its default and say so in
  your reply. Guessing a column name that does not exist fails at run time. A Pivot or a raw
  Cypher is the usual case: what it emits depends on the data, so it publishes nothing until
  the graph has been run — and once it has, its real columns are in the listing like any
  other's. A missing line means unknown, never none.

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
