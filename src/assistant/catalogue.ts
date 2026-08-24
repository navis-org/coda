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
 * **It is ~12.7k tokens, and that is worth trimming — measured, so nobody has to guess where.**
 * 27.8k chars of catalogue against 2.9k of rules; ~2.4 chars per token, because identifiers
 * (`edgeWeightInfluence`, `countDistinct`) tokenize far worse than the ~4 prose gets, which is
 * why a character count under-estimates this by half. Inside the catalogue:
 *
 *  - param `help` text is 10.8k chars, **39%** — the largest single component
 *  - eight of the forty-nine nodes are **43%** of it, `out.network` alone 11% at 3k chars,
 *    being thirty-three mostly-presentational encoding and layout knobs
 *  - node descriptions are 3.4k, and the rest is ports, `carries:` lines and enum options
 *
 * The cheapest good trade is dropping `help` from `presentational` params (-15%): those are the
 * knobs a user turns in the styling panel, and they are the ones least likely to need prose.
 * Dropping presentational params outright is -24% — but then `plannableParams` has to refuse
 * them too, or the model is refused for using a param it was never shown, and the assistant
 * loses "colour the network by type" entirely. Dropping all help is -39% and goes too far:
 * `help` is what says `minWeight` prunes edges rather than filtering neurons.
 *
 * Not done yet because it is a quality trade against ~25c a session, and the prompt at this
 * size one-shot every plan in the first live run. See `_TODOs.md`.
 */

import type { ParamDef } from '../core/node'
import type { PortDef } from '../core/node'
import type { NodeDefinition } from '../core/node'
import type { CodaGraph } from '../core/graph'
import { GRAPH_FORMAT_VERSION } from '../core/graph'
import { inferGraph, nodeTypes } from '../core/inference'
import { defaultParams } from '../core/node'
import { nodeDefsByCategory } from '../core/registry'
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

function renderParam(param: ParamDef): string {
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
  return param.help ? `${line} — ${param.help}` : line
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

function renderNode(def: NodeDefinition): string {
  const lines: string[] = []
  lines.push(`## ${def.type} — ${def.label} (${def.category}, ${def.cost})`)
  if (def.description) lines.push(def.description)

  const inputs = def.inputs ?? []
  const outputs = def.outputs ?? []
  const list = (ports: readonly PortDef[], side: 'in' | 'out') =>
    ports.length ? ports.map((p) => renderPort(p, side)).join('  ') : 'none'
  lines.push(`inputs:  ${list(inputs, 'in')}`)
  lines.push(`outputs: ${list(outputs, 'out')}`)

  lines.push(...producedColumns(def))

  const params = plannableParams(def)
  if (params.length) {
    lines.push('params:')
    for (const param of params) lines.push(`  ${renderParam(param)}`)
  }
  return lines.join('\n')
}

/** Every node a plan may name, grouped by the categories the add menu already uses. */
export function catalogueText(): string {
  const sections: string[] = []
  for (const { category, defs } of nodeDefsByCategory()) {
    sections.push(`# ${category}`)
    for (const def of defs) sections.push(renderNode(def))
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
- A wire the type system refuses. Read the port types: an output only fits an input of a type
  it is assignable to, and \`any\` accepts anything.
- A wire that would make a cycle.

Column params — set them when you can, and you often can:
- A \`carries:\` line says which columns a port holds. Use those names. A Bar Chart fed by a
  Connectivity Graph node should name its category and value, not be left blank.
- The current-graph listing carries the same line per node, and it is the authoritative one:
  a dataset adds properties the catalogue above cannot know about.
- When no \`carries:\` line covers what you need — anything downstream of a Pivot or a Cypher
  publishes no columns until the graph has been run — leave the param at its default and say
  so in your reply. Guessing a column name that does not exist fails at run time.

What is fine, and should not stop you:
- A column you genuinely cannot know yet, per the above.
- A required input left unwired, when the user has not said what should feed it.

Two things to be careful about:
- Query nodes hit a shared production database. Do not add more of them than the request needs,
  and leave limits at their defaults unless asked.
- Dataset nodes: there is one type per published dataset. An empty \`version\` means the latest,
  which is what you want unless the user pinned one. Most query nodes need a Dataset wired to
  their dataset input.

Answer with a plan and nothing else. If the request needs no edit — a question about the graph,
or something you cannot do — return an empty plan whose \`summary\` says so in one sentence.
`.trim()

let cachedPrompt: string | undefined

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
export function buildSystemPrompt(): string {
  cachedPrompt ??= `${RULES}\n\n---\n\nThe node catalogue. Every type a plan may name is here.\n\n${catalogueText()}`
  return cachedPrompt
}
