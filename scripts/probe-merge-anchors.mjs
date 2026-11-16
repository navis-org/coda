/**
 * Phase 1 of `docs/seam-merge-plan.md` against live data: anchor real suggestions.
 *
 *   pnpm probe:merge-anchors                         # every rank-1 row of the fixture
 *   pnpm probe:merge-anchors -- --rows 5             # the first five
 *   pnpm probe:merge-anchors -- --neuron 648518347622603652
 *
 * **Reads only.** It reads supervoxels from the public bucket and asks the chunkedgraph which
 * root each belongs to now (`roots_binary`). Nothing here — and nothing it imports — can write
 * to CAVE; the merge writer does not exist yet, and when it does this file must not import it.
 *
 * The rows are `src/packs/seam/__fixtures__/candidates.parquet`, a slice of SEAM's published set
 * at its 2026-11-04 snapshot, read through the app's own reader and field list
 * (`CANDIDATE_FIELDS`), against the datastack its own `fixture.json` names. Neurons edited since
 * are expected to come back `neuron-absent` or `candidate-absent`, and that is the anchor
 * working: a merge decided on the snapshot is refused where the snapshot is no longer true.
 *
 * The one check that needs the live server: each chosen supervoxel's root, asked again
 * separately from the box read, is the root it was chosen for. Everything else about an anchor —
 * the voxel centres, the chunk limit — is pinned by `mergeAnchors.test.ts`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { blobBytes } from '../src/data/files/bytes.ts'
import { openTableFile } from '../src/data/files/read.ts'
import { rootsAtInstant } from '../src/data/cave/rootIds.ts'
import { NM_PER_UM } from '../src/data/units.ts'
import { anchorMerge, openAnchorVolume } from '../src/packs/seam/mergeAnchors.ts'
import { readFields } from '../src/packs/seam/suggestionRead.ts'
import { CANDIDATES_FILE, parseSuggestionSet } from '../src/packs/seam/suggestionSet.ts'
import { CANDIDATE_FIELDS } from '../src/packs/seam/suggestionTables.ts'
import { AEDES_DEPLOYMENT, probeArgs, probeReport, requireCaveToken } from './lib/browserProbe.mjs'

const args = probeArgs()
const ROWS = Number(args.value('--rows') ?? Infinity)
const NEURON = args.value('--neuron')
const DIR = join(new URL('..', import.meta.url).pathname, 'src/packs/seam/__fixtures__')

const options = { deployment: AEDES_DEPLOYMENT, token: requireCaveToken() }
const report = probeReport()

async function main() {
  const set = parseSuggestionSet(
    JSON.parse(readFileSync(join(DIR, 'fixture.json'), 'utf8')),
    'file://fixture.json',
  )
  const reader = await openTableFile(blobBytes(new Blob([readFileSync(join(DIR, CANDIDATES_FILE))])))
  // Keyed by the file's own column names (`Field.from`), which is what `readFields` returns.
  const { data, rows: count } = await readFields(reader, CANDIDATE_FIELDS, CANDIDATES_FILE)
  const rows = Array.from({ length: count }, (_, i) => i)
    .filter((i) => Number(data.rank[i]) === 1 && (!NEURON || data.neuron[i] === NEURON))
    .slice(0, ROWS)
  console.log(`${rows.length} rank-1 suggestions from the fixture, on ${set.datastack}\n`)

  const at = Date.now()
  const t0 = performance.now()
  const volume = await openAnchorVolume(set.datastack, at, options)
  console.log(
    `volume ${volume.base} at scale ${volume.scale.key} (graph base mip ${volume.layout.baseMip}), ` +
      `opened in ${(performance.now() - t0).toFixed(0)} ms\n`,
  )

  const outcomes = new Map()
  for (const i of rows) {
    const pair = {
      neuronRoot: data.neuron[i],
      candidateRoot: data.cand_root[i],
      contactNm: [data.contact_x_nm[i], data.contact_y_nm[i], data.contact_z_nm[i]],
      minDistUm: data.min_dist_um[i] ?? undefined,
    }
    const start = performance.now()
    let got
    try {
      got = await anchorMerge(volume, pair, options)
    } catch (error) {
      // A throw is about the datastack, true of every row (`anchorMerge`): say it, and stop.
      report.check(false, `anchoring threw, which stops every row: ${error.message}`)
      break
    }
    const ms = (performance.now() - start).toFixed(0)
    const label = `end ${data.end_uid[i]} ${pair.neuronRoot} ← ${pair.candidateRoot}`
    const outcome = got.ok ? 'anchored' : got.reason
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1)
    if (!got.ok) {
      console.log(`· ${label}: ${got.reason} (${ms} ms) — ${got.message}`)
      continue
    }
    const gap = Math.hypot(
      ...got.neuron.positionNm.map((nm, a) => nm - got.candidate.positionNm[a]),
    )
    const said =
      pair.minDistUm === undefined ? 'no gap' : (pair.minDistUm * NM_PER_UM).toFixed(0)
    console.log(
      `· ${label}: anchored in ${ms} ms, gap ${gap.toFixed(0)} nm ` +
        `(search said ${said}), ${got.chunks} chunk(s)`,
    )
    const again = await rootsAtInstant(
      volume.graphene,
      at,
      BigUint64Array.from([BigInt(got.neuron.supervoxel), BigInt(got.candidate.supervoxel)]),
      options,
    )
    report.check(
      String(again[0]) === pair.neuronRoot && String(again[1]) === pair.candidateRoot,
      `  supervoxels ${got.neuron.supervoxel} / ${got.candidate.supervoxel} belong to the pair now`,
    )
  }
  console.log(`\n${[...outcomes].map(([k, n]) => `${k}: ${n}`).join(', ')}`)
  report.finish()
}

await main()
