/**
 * The loop against the real API. **Skipped unless `ASSISTANT_LIVE=1`.**
 *
 * Everything else in this directory is tested against a stubbed `fetch`, which proves the
 * plumbing and proves nothing about the only question that matters: whether a model, given
 * this catalogue and these rules, emits plans the applier accepts and a person would recognise
 * as what they asked for. That cannot be stubbed, so it lives behind an opt-in and stays out of
 * CI — the same standing `scripts/check-export.py` has when navis is not installed.
 *
 * Run it:
 *
 *   ASSISTANT_LIVE=1 ANTHROPIC_API_KEY=sk-… pnpm vitest run src/assistant/live.test.ts
 *
 * The key env var keeps its name whichever provider is chosen — see `PROVIDER` below.
 *
 * **The opt-in is separate from the key, and that is the whole point of it.** Every other live
 * test here gates on the credential it needs — `CAVE_TOKEN`, `NEUPRINT_TOKEN`, `SEATABLE_TOKEN`
 * — and that is safe because nobody exports those for any other reason. `ANTHROPIC_API_KEY` is
 * the opposite: it is the standard name, so a developer with any Anthropic tooling configured
 * has it set globally and `pnpm test` would spend their money without ever mentioning it. It
 * did, and the failure does not read as one — an exhausted balance surfaces as five assertion
 * failures in the default suite. So this file takes the shape `catmaid/live.test.ts` already
 * uses for the same reason: a `*_LIVE` gate, with the credential beside it rather than as it.
 *
 * It spends real tokens: seven requests, a few cents. What it prints is the point — the plan's
 * summary, what the applier said, and the token cost per turn — so read the output rather than
 * the pass/fail. A green run means every plan applied; it does not mean the graphs were *good*,
 * which is a judgement to make by eye.
 *
 * **One Node limit to know about before blaming a local model.** Node's `fetch` gives up if no
 * response *headers* arrive within 300 seconds, and there is no knob for it short of adding
 * `undici` as a dependency. Ollama sends nothing until the whole answer is ready, so a model
 * that takes longer than five minutes per question fails here as `UND_ERR_HEADERS_TIMEOUT` —
 * a limit of the runner, not of the setup. Browsers have no such ceiling, so the app itself is
 * unaffected; measured at 5m39s for a 27B model on the first question below, which is close
 * enough to the line to be worth saying.
 */

/*
 * The printed transcript is this file's entire output — a pass only says the plans applied,
 * not that the graphs were any good, and judging that means reading them.
 */
/* eslint-disable no-console */

import { beforeAll, describe, expect, it } from 'vitest'

import '../nodes'
import { setKey, setModel, setProviderId } from '../data/ai/credentials'
import { providerFor } from '../data/ai/registry'
import type { CodaGraph } from '../core/graph'
import { emptyGraph } from '../core/graph'
import { applyPlan } from './apply'
import type { CatalogueDetail } from './catalogue'
import { buildSystemPrompt } from './catalogue'
import { describeGraph, requestPlan, runTurn } from './converse'
import { countPlanParams } from './planShape'

const KEY = process.env.ANTHROPIC_API_KEY
const PROVIDER = process.env.CODA_ASSISTANT_PROVIDER ?? 'anthropic'
const MODEL = process.env.CODA_ASSISTANT_MODEL

/**
 * Which catalogue to run against — `full` unless asked otherwise.
 *
 * The point of the switch is a comparison nobody can make by reasoning: `lean` is 53% smaller
 * and drops what every setting *means*, keeping only what a plan can be refused for. Whether
 * that costs plan quality is a question about seven real answers, not about the diff.
 *
 *   ASSISTANT_LIVE=1 CODA_ASSISTANT_CATALOGUE=lean CODA_ASSISTANT_PROVIDER=ollama \
 *     CODA_ASSISTANT_MODEL=qwen3.8:latest pnpm vitest run src/assistant/live.test.ts
 */
const CATALOGUE = (process.env.CODA_ASSISTANT_CATALOGUE ?? 'full') as CatalogueDetail

/**
 * The opt-in. Nothing in this file runs without it — see the header for why it is not the key.
 *
 * It gates the free Ollama arm too, which is deliberate: cost is not the only reason a suite
 * should not wander into this file. A local 27B model spends three to five minutes per question
 * and there are seven of them, so an un-gated Ollama run turns `pnpm test` into a forty-minute
 * hang that looks exactly like a wedged process.
 */
const LIVE = Boolean(process.env.ASSISTANT_LIVE)

/**
 * Whether there is anything to run against.
 *
 * A key for the providers that need one — and *nothing* for Ollama, which is the whole of what
 * it offers. Requiring `ANTHROPIC_API_KEY` regardless made the one loop that can be run for
 * free the one loop nobody could run, which is how a prompt grew past the context window Ollama
 * was being asked for without any of this noticing.
 *
 *   ASSISTANT_LIVE=1 CODA_ASSISTANT_PROVIDER=ollama CODA_ASSISTANT_MODEL=qwen3.8:latest \
 *     pnpm vitest run src/assistant/live.test.ts
 */
const RUNNABLE = LIVE && (Boolean(KEY) || providerFor(PROVIDER)?.needsKey === false)

/**
 * Per-question ceiling.
 *
 * Cloud answers land in seconds and used to sit under two minutes here. A 27B model on a laptop
 * spends three to five on Coda's prompt — measured at 5m39s for the pipeline question — so the
 * old limit failed a request that was working. Generous rather than tuned: this file is read
 * for what it prints, and a timeout is only here to stop a wedged run forever.
 */
const PER_QUESTION_MS = 900_000

/*
 * Configured the way a user would, through the credential store, rather than by threading
 * overrides down through `runTurn`. That keeps the loop's signature about the conversation —
 * and it means this file can drive *any* provider, not just the one it was written against:
 *
 *   ASSISTANT_LIVE=1 CODA_ASSISTANT_PROVIDER=openai ANTHROPIC_API_KEY=sk-… \
 *     pnpm vitest run src/assistant/live.test.ts
 */
beforeAll(() => {
  if (!RUNNABLE) return
  console.log(
    `\ncatalogue: ${CATALOGUE} — ${buildSystemPrompt(CATALOGUE).length} characters of system prompt\n`,
  )
  setProviderId(PROVIDER)
  if (KEY) setKey(PROVIDER, KEY)
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
    detail: CATALOGUE,
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

describe.skipIf(!RUNNABLE)('against the real API', () => {
  it(
    'builds a pipeline from scratch',
    async () => {
      const graph = await ask(
        emptyGraph(),
        'Using the mini hemibrain dataset, find the LC4 neurons, get what they connect to, ' +
          'and chart the strongest partner types.',
      )
      console.log(`\n${describeGraph(graph)}\n`)
      expect(graph.nodes.length).toBeGreaterThan(2)
    },
    PER_QUESTION_MS,
  )

  it(
    'edits a graph it did not build',
    async () => {
      const start = await ask(
        emptyGraph(),
        'Give me the mini hemibrain dataset wired to Find Neurons.',
      )
      const graph = await ask(
        start,
        'Add a table showing the results, and limit the query to 50.',
      )
      console.log(`\n${describeGraph(graph)}\n`)
      expect(graph.nodes.some((n) => n.type === 'out.table')).toBe(true)
    },
    PER_QUESTION_MS,
  )

  it(
    'reaches for the specialised node instead of assembling one by hand',
    async () => {
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
    },
    PER_QUESTION_MS,
  )

  it(
    'removes and rewires, not only adds',
    async () => {
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
    },
    PER_QUESTION_MS,
  )

  it(
    'declines rather than inventing, when asked for something Coda cannot do',
    async () => {
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
    },
    PER_QUESTION_MS,
  )
})
