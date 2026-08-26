/**
 * One turn: what is on the canvas plus what the user asked, in — a plan, out.
 *
 * The seam is deliberate. This asks for a plan and hands it back; it never applies one. The
 * store is what commits, because only the store can make it a single undo step, and a module
 * that both called the network and mutated the document would have no point at which a user
 * could be shown what is about to happen.
 */

import type { CodaGraph } from '../core/graph'
import type { ApplyOk, ApplyResult } from './apply'
import type { InferenceResult } from '../core/inference'
import { inferGraph, nodeTypes } from '../core/inference'
import { changedParams, configurableParams } from '../core/node'
import { getNodeDef } from '../core/registry'
import type { CompletionResult, Usage } from '../data/ai/types'
import { complete } from '../data/ai/registry'
import { errorMessage } from '../core/errors'
import type { CatalogueDetail } from './catalogue'
import { buildSystemPrompt, carriesLines } from './catalogue'
import type { AssistantPlan } from './planShape'
import { parsePlan, planJsonSchema } from './plan'

export interface AssistantTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface PlanRequest {
  graph: CodaGraph
  /**
   * The editor's own inference of that graph, where the caller has one.
   *
   * Must be the inference *of this graph*, read at the same moment — see `describeGraph`, which
   * falls back to inferring for itself when it is absent.
   */
  inference?: InferenceResult | undefined
  /** How much of each param the catalogue prints. See `CatalogueDetail`. */
  detail?: CatalogueDetail | undefined
  /** The conversation so far, oldest first. The last entry is normally the user's request. */
  messages: readonly AssistantTurn[]
  signal?: AbortSignal | undefined
  apiKey?: string | undefined
  model?: string | undefined
  baseUrl?: string | undefined
}

export type PlanOutcome =
  { ok: true; plan: AssistantPlan; usage: Usage; model: string } | { ok: false; error: string }

/**
 * The canvas, as the model sees it.
 *
 * Only params that differ from their default are listed. A neuron table's node carries a dozen
 * settings nobody touched, and printing all of them on every turn would spend most of the user
 * turn restating the definitions the cached catalogue already gave — and, worse, bury the two
 * values somebody actually chose.
 */
export function describeGraph(
  graph: CodaGraph,
  inference?: InferenceResult | undefined,
): string {
  if (graph.nodes.length === 0) return 'The canvas is empty.'

  /*
   * The resolved types, so each node can say which columns it is actually carrying.
   *
   * Without this the model cannot fill in a column param even when the answer is knowable:
   * a Connectivity node advertises `preId, preType, postId, postType, weight, hop, direction`
   * at edit time, and a Bar Chart wired to one arrived with its category and value unset
   * purely because nothing had said so.
   *
   * **Take the editor's pass when there is one.** Inferring here from the graph alone is not
   * the same answer: `inferGraph` accepts an `observedSchemas` map — the schemas that nodes
   * declaring `observesOutputSchema` actually produced — and a Pivot or a raw Cypher publishes
   * *no* columns without it, because what they emit depends on the data rather than on the
   * params. The store keeps that map and re-infers with it on every commit; this function
   * asked for a bare inference and so was told nothing, on a canvas where the answer was
   * already sitting one call away. The rules then instructed the model to give up and leave
   * the picker at its default — advice that was correct only because of the omission.
   *
   * The fallback is a real fallback rather than a courtesy: `assistant/live.test.ts` and the
   * headless tests have no store, and a graph nobody has run has nothing observed anyway.
   */
  const resolved = inference ?? inferGraph(graph)

  const lines: string[] = ['Nodes:']
  for (const node of graph.nodes) {
    const def = getNodeDef(node.type)
    const label = node.title ? ` "${node.title}"` : ''
    const bits: string[] = [`  ${node.id}  ${node.type}${label}`]

    for (const line of carriesLines(nodeTypes(resolved, node.id).outputs)) {
      bits.push(`    ${line}`)
    }

    if (def) {
      /*
       * The card's own rule for "was this a decision?", not a second copy of it. Two
       * subtractions matter here and both come free: a nonce a widget writes is not a setting,
       * and a param the node's current values have switched off is not one either — printing
       * `topLabel` on a Stack that names no source column would tell the model the node is
       * configured in a way the user cannot see on screen, and its next plan would "correct" a
       * setting nobody made.
       */
      const changed = changedParams(configurableParams(def, node.params), node.params).map(
        (p) => {
          const value = node.params[p.id]
          return `${p.id}=${Array.isArray(value) ? `[${value.join(',')}]` : String(value)}`
        },
      )
      if (changed.length) bits.push(`    set: ${changed.join('  ')}`)
    } else {
      bits.push('    (unknown type — this graph was saved by a different build)')
    }
    if (node.disabled) bits.push('    (muted)')
    lines.push(bits.join('\n'))
  }

  if (graph.edges.length) {
    lines.push('Wires:')
    for (const edge of graph.edges) {
      lines.push(`  ${edge.source}:${edge.sourceHandle} → ${edge.target}:${edge.targetHandle}`)
    }
  } else {
    lines.push('Wires: none.')
  }

  return lines.join('\n')
}

/** The user turn: the graph, then the request. */
function userContent(
  graph: CodaGraph,
  request: string,
  inference: InferenceResult | undefined,
): string {
  return `Current graph:\n${describeGraph(graph, inference)}\n\nRequest:\n${request}`
}

/**
 * Ask for a plan.
 *
 * The graph is attached to the *last* user turn rather than to the system prompt, and that is
 * the whole of why the catalogue caches: the system prompt has to be byte-identical between
 * calls, and the graph changes on every one.
 */
export async function requestPlan(request: PlanRequest): Promise<PlanOutcome> {
  const turns = [...request.messages]
  const last = turns.pop()
  if (!last || last.role !== 'user') {
    return { ok: false, error: 'The last message must be the user’s request.' }
  }

  const messages = [
    ...turns.map((t) => ({ role: t.role, content: t.content })),
    {
      role: 'user' as const,
      content: userContent(request.graph, last.content, request.inference),
    },
  ]

  let result: CompletionResult
  try {
    result = await complete({
      system: buildSystemPrompt(request.detail),
      messages,
      schema: planJsonSchema(),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.apiKey ? { apiKey: request.apiKey } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return { ok: false, error: errorMessage(error) }
  }

  const parsed = parsePlan(result.text)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  return { ok: true, plan: parsed.plan, usage: result.usage, model: result.model }
}

/**
 * What to send back when `applyPlan` refused, so the model can repair rather than start again.
 *
 * Phrased as the outcome of its own plan, not as a fresh instruction: the errors name the plan
 * elements (`connect[2]`) it just wrote, which is the shortest path from the refusal to the fix.
 */
export function repairPrompt(errors: readonly string[]): string {
  return [
    'That plan was refused, so nothing was applied. Problems:',
    ...errors.map((e) => `- ${e}`),
    '',
    'Send a corrected plan.',
  ].join('\n')
}

/**
 * How many times a refusal is handed back before the caller is told about it.
 *
 * One, and measured rather than guessed: across five live cases and three model tiers the only
 * repairs ever needed were caused by a defect in our own prompt, and both were fixed by the
 * first retry. A refusal is a conversation — `repairPrompt` names the plan elements the model
 * just wrote — so one round is worth spending silently; a second would mostly be spending the
 * user's money to watch the same mistake.
 */
export const REPAIR_ROUNDS = 1

export type TurnOutcome =
  /** `applied` carries what the edit left for the user — see `ApplyOk.warnings`. */
  | { ok: true; plan: AssistantPlan; applied: ApplyOk; usage: Usage; model: string }
  /** Nothing was applied. `errors` is present when a plan came back and was refused. */
  | { ok: false; error: string; errors?: string[] }

export interface TurnRequest {
  /**
   * Read fresh each round rather than passed once: a repair asks about the graph as it stands,
   * and between rounds nothing has changed it — but the caller owning the read is what lets a
   * second surface pass a store getter without this module knowing there is a store.
   */
  graph: () => CodaGraph
  /**
   * The editor's inference of that graph, read in the same breath as `graph` above.
   *
   * Optional because the headless callers have no store to read it from. Supplying it is what
   * lets the listing name the columns a Pivot or a raw Cypher actually produced — see
   * `describeGraph`.
   */
  inference?: (() => InferenceResult) | undefined
  /** How much of each param the catalogue prints. See `CatalogueDetail`. */
  detail?: CatalogueDetail | undefined
  /** Applies a plan, or refuses it. The store's `applyAssistantPlan`, or a bare `applyPlan`. */
  apply: (plan: AssistantPlan) => ApplyResult
  request: string
  signal?: AbortSignal | undefined
}

/**
 * One question, through as many repair rounds as it takes — the whole conversation protocol.
 *
 * Here rather than in the panel because it is assistant policy, not React: how many rounds are
 * spent, what a repair turn replays, and that a refusal costs no commit. The tell was
 * `repairPrompt`, a function this module exported for something else to feed back to it — so
 * the loop it belongs to lived in a `useCallback` and could only be tested by mounting a panel.
 *
 * Only what was *said* is replayed. The transcript's own summaries are not: the graph goes with
 * every turn anyway (`describeGraph`), so state is carried by the thing that is authoritative
 * about it rather than by a paraphrase of an earlier edit.
 */
export async function runTurn(turn: TurnRequest): Promise<TurnOutcome> {
  const messages: AssistantTurn[] = [{ role: 'user', content: turn.request }]

  for (let round = 0; round <= REPAIR_ROUNDS; round += 1) {
    const outcome = await requestPlan({
      graph: turn.graph(),
      messages,
      // Read here, beside the graph, so the two cannot describe different moments.
      inference: turn.inference?.(),
      detail: turn.detail,
      ...(turn.signal ? { signal: turn.signal } : {}),
    })
    if (!outcome.ok) return { ok: false, error: outcome.error }

    const result = turn.apply(outcome.plan)
    if (result.ok) {
      return {
        ok: true,
        plan: outcome.plan,
        applied: result,
        usage: outcome.usage,
        model: outcome.model,
      }
    }
    if (round === REPAIR_ROUNDS) {
      return {
        ok: false,
        error: 'That did not fit the graph, so nothing was changed.',
        errors: result.errors,
      }
    }
    messages.push(
      { role: 'assistant', content: JSON.stringify(outcome.plan) },
      { role: 'user', content: repairPrompt(result.errors) },
    )
  }
  // Unreachable: the loop returns on every path. Present so the signature needs no assertion.
  return { ok: false, error: 'No answer.' }
}
