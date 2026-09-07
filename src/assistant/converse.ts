/**
 * One turn: what is on the canvas plus what the user asked, in — a plan, out.
 *
 * The seam is deliberate. This asks for a plan and hands it back; it never applies one. The
 * store is what commits, because only the store can make it a single undo step, and a module
 * that both called the network and mutated the document would have no point at which a user
 * could be shown what is about to happen.
 */

import type { CodaGraph } from '../core/graph'
import type { ApplyOk, ApplyResult, ApplyWarning } from './apply'
import { applyPlan } from './apply'
import type { InferenceResult } from '../core/inference'
import { inferGraph, nodeTypes } from '../core/inference'
import { changedParams, configurableParams } from '../core/node'
import { getNodeDef } from '../core/registry'
import type { CompletionResult, Usage } from '../data/ai/types'
import { complete } from '../data/ai/registry'
import { errorMessage } from '../core/errors'
import type { CatalogueDetail } from './catalogue'
import { buildSystemPrompt, carriesLines, optionLines } from './catalogue'
import type { ResultReader } from './digest'
import { digestState, resultLines } from './digest'
import type { AssistantPlan } from './planShape'
import { isEmptyPlan } from './planShape'
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
  /**
   * What the graph's nodes last produced, where the caller can read it.
   *
   * Absent for every headless caller, and the fallback is a listing with no `ran:` lines — which
   * is the honest answer for a graph nobody has run, and the same shape `inference` takes one
   * field up.
   */
  results?: ResultReader | undefined
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
export interface GraphContext {
  /**
   * The editor's own inference of that graph, where the caller has one.
   *
   * Must be the inference *of this graph*, read at the same moment — see below, which falls
   * back to inferring for itself when it is absent.
   */
  inference?: InferenceResult | undefined
  /** What the graph's nodes last produced, where the caller can read it. */
  results?: ResultReader | undefined
}

export function describeGraph(graph: CodaGraph, ctx: GraphContext = {}): string {
  const { inference, results } = ctx
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

  const digest = digestState()
  const lines: string[] = ['Nodes:']
  for (const node of graph.nodes) {
    const def = getNodeDef(node.type)
    const label = node.title ? ` "${node.title}"` : ''
    const types = nodeTypes(resolved, node.id)
    const bits: string[] = [`  ${node.id}  ${node.type}${label}`]

    for (const line of carriesLines(types.outputs)) {
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

      /*
       * What this node's dynamic enums actually offer, which the catalogue could only call
       * `(options depend on the input)`. Here rather than there because the answer depends on
       * what is wired: `core.filterTable`'s operators follow the dtype of the chosen column.
       */
      for (const line of optionLines(def, node.params, types.inputs)) {
        bits.push(`    options: ${line}`)
      }
    } else {
      bits.push('    (unknown type — this graph was saved by a different build)')
    }
    if (node.disabled) bits.push('    (muted)')
    bits.push(...resultLines(node.id, types.outputs, results, digest))
    lines.push(bits.join('\n'))
  }
  const short = digest.skipped()
  if (short > 0) {
    lines.push(
      `(column detail left out for ${short} more node${short === 1 ? '' : 's'} that have` +
        ' results, to keep this short.)',
    )
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
function userContent(graph: CodaGraph, request: string, ctx: GraphContext): string {
  return `Current graph:\n${describeGraph(graph, ctx)}\n\nRequest:\n${request}`
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
      content: userContent(request.graph, last.content, {
        ...(request.inference ? { inference: request.inference } : {}),
        ...(request.results ? { results: request.results } : {}),
      }),
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
 * The complaints a plan would leave on the cards, as lines for the model.
 *
 * **The gap this closes is that a legal plan can be a wrong one.** `applyPlan` checks types,
 * ports, params and cycles, and `isAssignable` ignores schema — so `Table{?} → Table{?}` is
 * accepted whatever the two tables are. Asked for a three-dataset comparison, a model wired each
 * dataset's own neuron table into `Compare Connectivity`'s Labels ports on five runs out of
 * five: structurally perfect, semantically meaningless, and nothing refused it. Meanwhile the
 * node's own `validate` had the exact sentence — *"wire the matching Labels table from Match
 * Cell Types"* — and nothing in this directory read node issues at all.
 *
 * **The list is `ApplyOk.warnings`, not a second walk.** That was the shape this started in — a
 * before/after diff of two bare `inferGraph` passes — and every part of it already existed:
 * `collectWarnings` runs the inference once inside the `applyPlan` this function's caller has
 * just made, and scopes to the nodes the plan *touched*, which is the precise version of what
 * the diff was approximating. Its header even makes the same argument. Two rules follow from
 * reusing it rather than restating it. The scoping is **touch, not diff**, so a node the plan
 * wired into is reported even for a complaint it was already making — right, because the plan is
 * about that node. And the user's warning list and the model's are now the same list, where two
 * walks had already drifted on how a node is named (`collectWarnings` prefers `node.title`) and
 * on whether `severity` survives.
 *
 * The one thing added on top: **column issues are dropped**. See `NodeIssue.aboutColumns` — the
 * model has already been told a column it cannot know yet is fine, so raising them again
 * contradicts the system prompt, and on a live build there were four to six of them around the
 * one actionable line, which is how the actionable line gets ignored.
 */
export function concernsFrom(warnings: readonly ApplyWarning[]): string[] {
  return warnings
    .filter((warning) => !warning.aboutColumns)
    .map((warning) => `${warning.nodeId} (${warning.label}): ${warning.message}`)
}

/**
 * What to send back when a plan applied but left the cards complaining.
 *
 * **Not `repairPrompt`, and the difference is the whole of it.** A refusal means nothing
 * happened and a corrected plan is the only way forward. This is a *warning*: the plan is
 * legal, it is held, and it will be applied whatever comes back — so the model has to be told
 * that doing nothing is a legitimate answer, or it invents an edit to justify the round. Hence
 * the empty-plan escape hatch, which is the same one `RULES` already gives for a request that
 * needs no edit.
 *
 * It also has to say the graph is *unchanged*, because the plan has not been applied yet: a
 * model told its edit landed would send a diff against a graph that does not exist.
 */
export function concernPrompt(concerns: readonly string[]): string {
  return [
    'Your plan is valid and is being held — nothing has been applied yet, so the graph is',
    'still the one in the listing. Applying it as written would leave these cards complaining:',
    ...concerns.map((c) => `- ${c}`),
    '',
    'These are warnings, not refusals. Some are fine — a column that cannot be known yet, or an',
    'input the request never said what to feed. Send a complete replacement plan if any of them',
    'is something you can fix, remembering that it replaces the held one rather than adding to',
    'it. If they are all fine as they are, reply with an empty plan and your held plan is used.',
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
  /**
   * What the graph's nodes last produced. Optional for the headless callers, exactly as
   * `inference` is — and for the same reason, since a graph nobody has run has nothing to read.
   *
   * A reader rather than a snapshot: the two questions it answers are asked per node, and only
   * for the nodes that turn out to have something. Building a record of every result up front
   * would summarise a hundred nodes to print eight.
   */
  results?: ResultReader | undefined
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
  /*
   * A plan that previewed clean and was sent back for a second look anyway — see
   * `concernPrompt`. Held rather than applied, so the whole turn is still one commit and one
   * undo step; and kept rather than dropped, so an advisory round can never leave the user with
   * less than they would have had. Everything after it falls back to this.
   */
  let held: { plan: AssistantPlan; usage: Usage; model: string } | undefined

  /** The one place a plan is committed, so the fallback and the ordinary path cannot diverge. */
  const commit = (
    plan: AssistantPlan,
    usage: Usage,
    model: string,
  ): TurnOutcome | undefined => {
    const result = turn.apply(plan)
    return result.ok ? { ok: true, plan, applied: result, usage, model } : undefined
  }

  /**
   * Give the held plan its chance before reporting a failure.
   *
   * An advisory round must never leave the user with less than they would have had: the plan we
   * chose to question was valid, and losing it to a failed follow-up spends their turn on our
   * own second thoughts. `tried` because on the last round the follow-up may *be* the held plan
   * — an empty answer resolves to it — and re-committing it can only fail the same way twice.
   */
  let tried: AssistantPlan | undefined
  const giveUp = (error: string, errors?: string[]): TurnOutcome =>
    (held && held.plan !== tried ? commit(held.plan, held.usage, held.model) : undefined) ?? {
      ok: false,
      error,
      ...(errors ? { errors } : {}),
    }

  for (let round = 0; round <= REPAIR_ROUNDS; round += 1) {
    const outcome = await requestPlan({
      graph: turn.graph(),
      messages,
      // Read here, beside the graph, so the three cannot describe different moments.
      inference: turn.inference?.(),
      results: turn.results,
      detail: turn.detail,
      ...(turn.signal ? { signal: turn.signal } : {}),
    })
    if (!outcome.ok) return giveUp(outcome.error)

    /*
     * An empty plan answering the advisory round means "they are all fine" — `concernPrompt`
     * offers exactly that, so it is an answer rather than a failure to produce one.
     */
    const plan = held && isEmptyPlan(outcome.plan) ? held.plan : outcome.plan

    /*
     * Preview before committing. `applyPlan` is pure and is what the store's applier calls, so
     * this predicts the commit faithfully — the one thing it cannot see is the canvas lock,
     * which `turn.apply` reports either way. Its `warnings` are the advisory list, already
     * scoped to what the plan touched; see `concernsFrom`.
     */
    const preview = applyPlan(turn.graph(), plan)
    if (preview.ok) {
      // Asked once, and only while there is a round left to ask in — `held` is redundant at
      // today's `REPAIR_ROUNDS` of 1 and is what keeps this honest if that is ever raised.
      if (!held && round < REPAIR_ROUNDS) {
        const concerns = concernsFrom(preview.warnings)
        if (concerns.length > 0) {
          held = { plan, usage: outcome.usage, model: outcome.model }
          messages.push(
            { role: 'assistant', content: JSON.stringify(plan) },
            { role: 'user', content: concernPrompt(concerns) },
          )
          continue
        }
      }
      const done = commit(plan, outcome.usage, outcome.model)
      if (done) return done
      // It previewed clean and `turn.apply` still refused it — the canvas lock. Recorded so
      // `giveUp` does not offer the same plan a second time.
      tried = plan
    }

    const errors = preview.ok ? ['The canvas would not take this plan.'] : preview.errors
    if (round === REPAIR_ROUNDS) {
      return giveUp('That did not fit the graph, so nothing was changed.', errors)
    }
    messages.push(
      { role: 'assistant', content: JSON.stringify(plan) },
      { role: 'user', content: repairPrompt(errors) },
    )
  }
  // Unreachable: the loop returns on every path. Present so the signature needs no assertion.
  return { ok: false, error: 'No answer.' }
}
