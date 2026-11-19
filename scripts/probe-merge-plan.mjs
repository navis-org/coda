/**
 * Phase 3 of `docs/seam-merge-plan.md` against live data: the Submit pre-flight, on real rows.
 *
 *   pnpm probe:merge-plan                          # the fixture's first neuron
 *   pnpm probe:merge-plan -- --neuron 648518347622603652
 *
 * **Reads only.** It imports nothing that writes (the writer is out of `mergePlan.ts`' reach), and
 * in case anything ever does, it refuses every chunkedgraph write route at `fetch` before sending.
 *
 * The queue is the card's own: the fixture (`src/packs/seam/__fixtures__`, SEAM's published set at
 * its 2026-11-04 snapshot) read by `readSuggestions` and folded by `buildQueue`, on the datastack
 * its `fixture.json` names, with **every rank-1 candidate of one neuron accepted** — the plan a
 * reader who accepted everything would be shown.
 * A neuron edited since the snapshot comes back refused whole (`neuron-outdated`), which is the
 * pre-flight working.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { blobBytes } from '../src/data/files/bytes.ts'
import { openTableFile } from '../src/data/files/read.ts'
import { planMerges } from '../src/packs/seam/mergePlan.ts'
import {
  acceptedPieces,
  buildQueue,
  pickedNeuron,
  tipsOf,
} from '../src/packs/seam/reviewQueue.ts'
import { verdictKey } from '../src/packs/seam/pieces.ts'
import { parseSuggestionSet } from '../src/packs/seam/suggestionSet.ts'
import { readSuggestions } from '../src/packs/seam/suggestions.ts'
import { isChunkedgraphEdit, requestUrl } from '../src/test/sandboxWrites.ts'
import { AEDES_DEPLOYMENT, probeArgs, probeReport, requireCaveToken } from './lib/browserProbe.mjs'

// Before anything can send: no chunkedgraph write, anywhere.
const real = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = requestUrl(input)
  if (isChunkedgraphEdit(url)) throw new Error(`Refused a write: ${url}`)
  return real(input, init)
}

const args = probeArgs()
const DIR = join(new URL('..', import.meta.url).pathname, 'src/packs/seam/__fixtures__')
const options = { deployment: AEDES_DEPLOYMENT, token: requireCaveToken() }
const report = probeReport()

async function main() {
  const set = parseSuggestionSet(
    JSON.parse(readFileSync(join(DIR, 'fixture.json'), 'utf8')),
    'file://fixture.json',
  )
  const openLocal = (file) => openTableFile(blobBytes(new Blob([readFileSync(join(DIR, file))])))
  const built = await readSuggestions(set, openLocal)
  const queue = buildQueue(built.tips, built.candidates)
  const asked = args.value('--neuron')
  // Asked for by name, it must be there: `pickedNeuron`'s quiet fallback is the card's, not a probe's.
  if (asked !== undefined && !queue.some((tip) => tip.neuronId === asked)) {
    console.error(`--neuron ${asked} is not in the fixture's queue.`)
    process.exit(2)
  }
  const neuron = pickedNeuron(queue, asked ?? '')
  if (neuron === undefined) throw new Error('The fixture holds no tips.')
  const tips = tipsOf(queue, neuron)
  const verdicts = new Map()
  for (const tip of tips) {
    for (const c of tip.candidates) {
      if (c.rank === 1) verdicts.set(verdictKey(tip.endUid, c.candidateId), 'accept')
    }
  }
  const accepted = acceptedPieces(tips, verdicts)
  console.log(
    `${set.datastack}: neuron ${neuron}, ${tips.length} tips, ${accepted.size} pieces accepted\n`,
  )

  const start = performance.now()
  const plan = await planMerges(
    { datastack: set.datastack, queue, reviewedRoot: neuron, verdicts, record: [] },
    options,
  )
  const seconds = ((performance.now() - start) / 1000).toFixed(1)
  if (!plan.ok) {
    report.check(false, `planned (${seconds} s): ${plan.message}`)
    return report.finish()
  }
  console.log(`planned in ${seconds} s on ${plan.graphene.table}; neuron now ${plan.currentRoot}`)
  for (const m of plan.merges) {
    console.log(
      `  merge  ${m.candidateRoot} at end ${m.used.endUid}: ${m.neuron.supervoxel} + ${m.candidate.supervoxel}`,
    )
  }
  const reasons = new Map()
  for (const r of plan.rejected) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1)
  for (const r of plan.rejected.slice(0, 5)) {
    console.log(`  refuse ${r.candidateRoot}: ${r.reason} — ${r.message}`)
  }
  console.log(
    `\n${plan.merges.length} to merge, ${plan.rejected.length} refused` +
      (reasons.size ? ` (${[...reasons].map(([k, n]) => `${k}: ${n}`).join(', ')})` : ''),
  )
  report.check(
    plan.merges.length + plan.rejected.length === accepted.size,
    'every accepted piece is either planned or refused, once',
  )
  report.finish()
}

await main()
