/**
 * The loop against the real API. **Skipped unless `ANTHROPIC_API_KEY` is set.**
 *
 * Everything else in this directory is tested against a stubbed `fetch`, which proves the
 * plumbing and proves nothing about the only question that matters: whether a model, given
 * this catalogue and these rules, emits plans the applier accepts and a person would recognise
 * as what they asked for. That cannot be stubbed, so it lives behind a key and stays out of CI
 * — the same standing `scripts/check-export.py` has when navis is not installed.
 *
 * Run it:
 *
 *   ANTHROPIC_API_KEY=sk-… pnpm vitest run src/assistant/live.test.ts
 *
 * The key env var keeps its name whichever provider is chosen — see `PROVIDER` below.
 *
 * It spends real tokens: seven requests, a few cents. What it prints is the point — the plan's
 * summary, what the applier said, and the token cost per turn — so read the output rather than
 * the pass/fail. A green run means every plan applied; it does not mean the graphs were *good*,
 * which is a judgement to make by eye.
 */

/*
 * The printed transcript is this file's entire output — a pass only says the plans applied,
 * not that the graphs were any good, and judging that means reading them.
 */
/* eslint-disable no-console */

import { beforeAll, describe, expect, it } from 'vitest'

import '../nodes'
import { setKey, setModel, setProviderId } from '../data/ai/credentials'
import type { CodaGraph } from '../core/graph'
import { emptyGraph } from '../core/graph'
import { applyPlan } from './apply'
import { describeGraph, requestPlan, runTurn } from './converse'
import { countPlanParams } from './planShape'

const KEY = process.env.ANTHROPIC_API_KEY
const PROVIDER = process.env.CODA_ASSISTANT_PROVIDER ?? 'anthropic'
const MODEL = process.env.CODA_ASSISTANT_MODEL

/*
 * Configured the way a user would, through the credential store, rather than by threading
 * overrides down through `runTurn`. That keeps the loop's signature about the conversation —
 * and it means this file can drive *any* provider, not just the one it was written against:
 *
 *   CODA_ASSISTANT_PROVIDER=openai ANTHROPIC_API_KEY=sk-… pnpm vitest run src/assistant/live.test.ts
 */
beforeAll(() => {
  if (!KEY) return
  setProviderId(PROVIDER)
  setKey(PROVIDER, KEY)
  if (MODEL) setModel(PROVIDER, MODEL)
})

/**
 * Ask, through the *shipped* loop.
 *
 * `runTurn` is the thing the panel calls, so this measures the composition that actually runs
 * rather than a re-creation of it — the point of a live test being to catch what the stubs
 * cannot, which includes the loop itself having changed.
 */
async function ask(graph: CodaGraph, request: string): Promise<CodaGraph> {
  let next = graph
  const outcome = await runTurn({
    request,
    graph: () => next,
    apply: (plan) => {
      const result = applyPlan(next, plan)
      if (result.ok) next = result.graph
      return result
    },
  })

  if (!outcome.ok) {
    console.log(`  REFUSED: ${outcome.error}`)
    if (outcome.errors) console.log(outcome.errors.map((e) => `    ${e}`).join('\n'))
    expect.fail(outcome.error)
  }

  const { plan, usage, applied } = outcome
  const cost = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  console.log(
    `\n  “${plan.summary}”\n` +
      `  ${plan.add.length} added, ${plan.connect.length} wired, ` +
      `${countPlanParams(plan)} set, ${plan.remove.length} removed\n` +
      `  tokens: ${cost} in (${usage.cacheReadTokens} cached) / ${usage.outputTokens} out`,
  )
  for (const warning of applied.warnings) {
    console.log(`  left for the user — ${warning.label}: ${warning.message}`)
  }
  return next
}

describe.skipIf(!KEY)('against the real API', () => {
  it('builds a pipeline from scratch', async () => {
    const graph = await ask(
      emptyGraph(),
      'Using the mini hemibrain dataset, find the LC4 neurons, get what they connect to, ' +
        'and chart the strongest partner types.',
    )
    console.log(`\n${describeGraph(graph)}\n`)
    expect(graph.nodes.length).toBeGreaterThan(2)
  }, 120_000)

  it('edits a graph it did not build', async () => {
    const start = await ask(
      emptyGraph(),
      'Give me the mini hemibrain dataset wired to Find Neurons.',
    )
    const graph = await ask(start, 'Add a table showing the results, and limit the query to 50.')
    console.log(`\n${describeGraph(graph)}\n`)
    expect(graph.nodes.some((n) => n.type === 'out.table')).toBe(true)
  }, 120_000)

  it('reaches for the specialised node instead of assembling one by hand', async () => {
    /*
     * The discriminator the easy cases cannot be: "how does A reach B" has a node — `neuron.paths`,
     * which takes sources *and* targets and does a bidirectional search on the type-collapsed
     * graph. A chain of Connectivity nodes is structurally valid, applies cleanly, and answers a
     * different question, so the applier will never object. Finding it means having read past
     * the handful of node types every other case needs.
     *
     * A failure here is a finding about the model, not a bug in the code.
     */
    const graph = await ask(
      emptyGraph(),
      'On the mini hemibrain, how do the LC4 neurons reach DNp01? Show me the routes.',
    )
    console.log(`\n  chose: ${graph.nodes.map((n) => n.type).join(', ')}\n`)
    expect(graph.nodes.some((n) => n.type === 'neuron.paths')).toBe(true)
  }, 120_000)

  it('removes and rewires, not only adds', async () => {
    // `remove` and `disconnect` are unit-tested and have never been exercised by a real model.
    // A plan that only ever appends would pass every other case here.
    const built = await ask(
      emptyGraph(),
      'On the mini hemibrain, find LC4 neurons, get their connections, and bar-chart them.',
    )
    const graph = await ask(
      built,
      'Drop the bar chart — show the connections in a table instead.',
    )
    console.log(`\n${describeGraph(graph)}\n`)
    expect(graph.nodes.some((n) => n.type === 'out.barChart')).toBe(false)
    expect(graph.nodes.some((n) => n.type === 'out.table')).toBe(true)
  }, 180_000)

  it('declines rather than inventing, when asked for something Coda cannot do', async () => {
    // The interesting failure is a plan full of plausible node types that do not exist. An
    // empty plan with a sentence saying so is the right answer.
    const outcome = await requestPlan({
      graph: emptyGraph(),
      messages: [{ role: 'user', content: 'Run a t-test between two groups of neurons.' }],
    })
    if (!outcome.ok) expect.fail(outcome.error)
    console.log(`\n  “${outcome.plan.summary}”`)

    const result = applyPlan(emptyGraph(), outcome.plan)
    // Whatever it proposes must at least be applicable — inventing a node type is the failure.
    if (!result.ok) expect.fail(`invented something: ${result.errors.join(' ')}`)
  }, 120_000)
})
