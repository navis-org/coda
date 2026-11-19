#!/usr/bin/env node
/**
 * Suggest Merges, run as a node in Chrome over real open ends — the timing a reader's own run
 * reports, taken the same way every time.
 *
 *   pnpm dev --port 5193 --strictPort           # in another terminal
 *   pnpm probe:suggest-merges                   # needs a CAVE token
 *   pnpm probe:suggest-merges -- --ends 40 --neuron 648518347585551219 --runs 2
 *
 * ## Why this exists
 *
 * Every figure in `docs/seam-suggestions-plan.md`'s "Where an end's time goes" came from a
 * reader running the workflow and pasting the node's timing line. That is the right number —
 * it is the node, not a copy of its sequence — but it cannot be taken again on demand, so a
 * change could only be judged by asking for another run. `pnpm probe:candidate-search` and
 * `pnpm probe:seam-tip-boxes` drive pieces of the sequence; nothing drove the node.
 *
 * This runs the workflow's chain — Dataset, Input IDs, Meshes, Clean Meshes twice, Find Open
 * Ends, Sample — and then `seam:suggestMerges` with the assessor, uncapped, on a `Scheduler` of
 * its own. Only the last node's report is read: `runClock` starts where the search begins, so
 * the chain above and the 133 MB model download are not in it.
 *
 * ## What makes two readings comparable
 *
 * - **A fresh browser per run.** `l2ChunkCounts` memoises across runs in a session and the node
 *   remembers finished ends (`endMemory.ts`), so a second run in one page measures neither.
 *   `launchChrome` wipes the profile, which also means the weights are fetched every run.
 * - **The same ends.** The chain is deterministic for a root at its moment, and `Sample` takes
 *   the first `--ends` in Find Open Ends' own order, as the reader's runs did.
 * - **Not the server's warmth.** The chunkedgraph caches what it was just asked. The first run
 *   of a session pays for that and later ones do not, so `--runs 2` or more and read the later
 *   ones — or interleave two builds, which is the only fair comparison of a change.
 *
 * Chrome with a real GPU (`--use-angle=metal`), since headless Chrome otherwise falls back to
 * SwiftShader. Firefox is not driven: probes here launch Chrome (`browserProbe.mjs`).
 *
 * Reads only. Nothing here writes to CAVE: the Review port is left unwired, so no piece is
 * extended and no verdict is sent.
 */

import {
  APP_MODULE,
  deleteProfileOnExit,
  handCaveToken,
  launchChrome,
  probeArgs,
  requireCaveToken,
} from './lib/browserProbe.mjs'
import { extendChain } from './lib/seamExtendChain.mjs'

const args = probeArgs()
const url = args.value('--url') ?? 'http://localhost:5193/'
/** The neuron of the reader's own Chrome profile (2026-11-15), searched at the present. */
const neuron = args.value('--neuron') ?? '648518347585551219'
/**
 * 40, not the 25 the first readings used: since the search went three deep a 25-end run takes
 * under the 60 s below which the node stays quiet about time (`TIMING_WORTH_REPORTING_SECONDS`).
 */
const ends = Number(args.value('--ends') ?? 40)
const runs = Number(args.value('--runs') ?? 1)
const PROFILE = '/tmp/coda-suggest-merges-profile'
const token = requireCaveToken()

/**
 * The extend probes' chain above `Tips` (`seamExtendChain.mjs`), so a number from here compares
 * with theirs, then Sample in place of the reader's choice of ends, and the node.
 */
function chain() {
  const above = extendChain(neuron)
  const nodes = [
    ...above.nodes,
    { id: 'some', type: 'core.sample', position: { x: 1500, y: 0 }, params: { mode: 'head', count: ends } },
    // The assessor is filled in the page, from the build's own model list.
    {
      id: 'suggest',
      type: 'seam:suggestMerges',
      position: { x: 1800, y: 0 },
      params: { download: true, assessTop: 0 },
    },
  ]
  const edges = [
    ...above.edges,
    ...[
      ['ends', 'tips', 'some', 'in'],
      ['some', 'out', 'suggest', 'tips'],
      ['ds', 'dataset', 'suggest', 'dataset'],
    ].map(([source, sourceHandle, target, targetHandle], at) => ({
      id: `e${above.edges.length + at}`,
      source,
      sourceHandle,
      target,
      targetHandle,
    })),
  ]
  return { version: 1, nodes, edges }
}

/** The latest browser's `close`: the exit handler is registered once, whatever `--runs` is. */
let closeLatest = () => {}
deleteProfileOnExit(PROFILE, () => closeLatest())

async function once(run) {
  const { waitFor, send, close } = await launchChrome({
    port: 9367,
    profile: PROFILE,
    args: ['--use-angle=metal', '--enable-gpu', '--enable-unsafe-webgpu'],
  })
  closeLatest = close
  await send('Page.navigate', { url })
  await waitFor('Boolean(document.querySelector("#root"))', 'the app')
  if (!(await handCaveToken(send, token))) {
    console.error('the page did not take the CAVE token')
    process.exit(2)
  }
  await send('Page.reload')
  await waitFor('Boolean(document.querySelector("#root"))', 'the app')

  const script = `(async () => {
    const load = ${APP_MODULE}
    const [builtins, registry, graphMod, schedMod, models] = await Promise.all([
      load('/src/data/builtins.ts'),
      load('/src/data/source.ts'),
      load('/src/core/graph.ts'),
      load('/src/core/scheduler.ts'),
      load('/src/packs/seam/models.ts'),
    ])
    await load('/src/nodes/index.ts')
    builtins.registerBuiltinSources()
    // The node's whole split goes to \`console.info\` beside its one-sentence warning
    // (\`TimingReport.detail\`), so the probe listens there rather than parsing the sentence.
    const said = []
    const info = console.info
    console.info = (...parts) => { said.push(parts.join(' ')); info(...parts) }
    const loaded = graphMod.deserializeGraph(${JSON.stringify(JSON.stringify(chain()))})
    const graph = {
      ...loaded.graph,
      nodes: loaded.graph.nodes.map((node) =>
        node.id === 'suggest'
          ? { ...node, params: { ...node.params, assessor: models.MERGE_ASSESSOR_MODELS[0].id } }
          : node,
      ),
    }
    const scheduler = new schedMod.Scheduler({ resolveSource: (id) => registry.getSource(id) })
    await scheduler.run(graph, { mode: 'full', targets: ['some'] })
    const tips = scheduler.output('some', 'out')
    const started = performance.now()
    await scheduler.run(graph, { mode: 'full', targets: ['suggest'] })
    const seconds = (performance.now() - started) / 1000
    const ids = graph.nodes.map((node) => node.id)
    // Which candidates, in which order, with which score: equal across two builds means the
    // change moved time and not answers. Logits to 1e-4, since the GPU's last bits may differ.
    const table = scheduler.output('suggest', 'candidates')
    const col = (name) => Array.from(table?.data?.[name] ?? [], String)
    const logits = Array.from(table?.data?.['logit'] ?? [], (v) => (v == null ? '' : Number(v).toFixed(4)))
    const text = JSON.stringify([col('candidateId'), col('geo_rank'), logits])
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    const fingerprint = Array.from(new Uint8Array(digest).slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('')
    return {
      tips: tips?.length ?? 0,
      seconds,
      errors: ids.flatMap((id) => {
        const one = scheduler.info(id)
        return one.state === 'ok' ? [] : [id + ' is ' + one.state + ': ' + (one.error ?? '')]
      }),
      warning: scheduler.warning('suggest') ?? '',
      detail: said.find((line) => line.startsWith('Suggest Merges:')) ?? '',
      candidates: table?.length ?? 0,
      fingerprint,
    }
  })()`
  const reply = await send('Runtime.evaluate', {
    expression: script,
    awaitPromise: true,
    returnByValue: true,
    timeout: 3_600_000,
  })
  close()
  if (reply.result?.exceptionDetails || !reply.result?.result) {
    console.error(JSON.stringify(reply.result?.exceptionDetails ?? reply, null, 2))
    process.exit(1)
  }
  const got = reply.result.result.value
  console.log(
    `\nrun ${run}: ${got.tips} ends, ${got.seconds.toFixed(1)} s for the node, ` +
      `${got.candidates} candidates, answer ${got.fingerprint}`,
  )
  for (const error of got.errors) console.log(`  ✗ ${error}`)
  if (got.warning) console.log(`  warning: ${got.warning}`)
  console.log(`  ${got.detail || '(no timing line: the run measured nothing)'}`)
}

for (let run = 1; run <= runs; run++) await once(run)
process.exit(0)
