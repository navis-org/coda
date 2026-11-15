#!/usr/bin/env node
/**
 * Where a tip's seconds go in `seam:suggestMerges`, and what a chunk cache would be worth.
 *
 *   pnpm probe:seam-tip-boxes                                      # needs a CAVE token
 *   pnpm probe:seam-tip-boxes -- --tips 12 --budget-mb 24          # small enough to force eviction
 *   pnpm probe:seam-tip-boxes -- --tips 12 --budget-mb 24 --plan 0 # the same, policy off
 *
 * A run reads segmentation twice per tip: a 6 µm box for the search (stages 4-5) and, once the
 * list is ranked, a second box covering every candidate's contact for the assessor's patches
 * (stage 6, "about 2.8 times the volume" — `patchBox.ts`). Both are at 32 nm, nothing between
 * them caches a chunk, and the chunks are **256 x 256 x 64 voxels — 8.2 x 8.2 x 2.9 µm**, which
 * is wider in xy than either box. So the question is not only how much of the patch box the
 * search box already fetched, but how much of the *next tip's* boxes this tip's already did.
 *
 * It walks real consecutive tips of one neuron (`__fixtures__/ownTipNeuron.json`, 505 of them in
 * SEAM's own order) and reports, per tip and cumulatively:
 *
 * - the voxel read and the supervoxel -> root lookup **timed apart**, since they are different
 *   servers and only one of them is already memoised across ends;
 * - chunks fetched against chunks a cache holding everything seen so far would have answered.
 *
 * The patch box is the **maximal** one: contacts sit within `own_um` of the tip (the own-tip
 * rule) and a patch reaches `PATCH_REACH_NM` past its centre, so no list can produce a wider
 * box. A tip with few candidates gets a smaller one — the fixture's nine-candidate end measured
 * 4 chunks against this bound's 16 — so the chunk counts here are a ceiling, which is the right
 * side to be on when sizing a cache.
 *
 * At the default budget nothing is ever evicted on a handful of tips, so the eviction policy is
 * idle and the run measures the cache's reach alone. `BUDGET_MB` small enough to force eviction
 * is what exercises the policy, and `PLAN=0` turns it off for the comparison: measured over 12
 * tips at 24 MB, least-recently-used answered 62 of 140 reads and furthest-next-use 73, with
 * the voxel time falling from 7.8 s to 6.6 s.
 *
 * Reads only. Nothing here writes to CAVE, and the voxels are a public bucket: the token is for
 * the datastack record and the chunkedgraph lookups alone.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { rootsAtInstant } from '../src/data/cave/rootIds.ts'
import {
  boxAround,
  boxAroundAll,
  chunkKeyOf,
  chunksCovering,
  readLabelBox,
} from '../src/data/precomputed/volume.ts'
import { PATCH_REACH_NM, patchScaleFrom, widestPatchReach } from '../src/packs/seam/patchBox.ts'
import { openSearchVolume } from '../src/packs/seam/searchVolume.ts'
import { AEDES_DEPLOYMENT, probeArgs, probeReport, requireCaveToken } from './lib/browserProbe.mjs'

const args = probeArgs()

const DATASTACK = 'wclee_aedes_brain'
/** The ranker's own `cutout_half_width_um` for this configuration. */
const HALF_WIDTH_UM = 3
/**
 * The ranker's own `cutout_xy_nm` — the **resolution** the search box is read at, not its width.
 *
 * `openSearchVolume` passes this to `scaleNear`, so a width here picks the coarsest scale in the
 * pyramid and every chunk and byte figure below is then about a volume the node never reads.
 * Aedes publishes one scale so the mistake was invisible on it; the numbers that size
 * `DEFAULT_CHUNK_BUDGET` came from this script, so it is worth being exact.
 */
const XY_NM = 32
const TIPS = Number(args.value('--tips') ?? 6)
/** A budget small enough to force eviction, so the policy is exercised rather than idle. */
const BUDGET_MB = Number(args.value('--budget-mb') ?? 512)
/** `--plan 0` leaves the cache least-recently-used, which is what the policy is measured against. */
const PLAN = args.value('--plan') !== '0'
const ROOT = new URL('..', import.meta.url).pathname

const neuron = JSON.parse(
  readFileSync(join(ROOT, 'src/packs/seam/__fixtures__/ownTipNeuron.json'), 'utf8'),
)

const options = { deployment: AEDES_DEPLOYMENT, token: requireCaveToken() }

const extent = (box) => [
  box.hi[0] - box.lo[0],
  box.hi[1] - box.lo[1],
  box.hi[2] - box.lo[2],
]

/**
 * The keys a box's chunks are cached under — **`chunkKeyOf`'s, not the chunk's name.**
 *
 * The name alone is not an identity: the search box and the patch box are read at different
 * scales, so one name can occur at both and a simulation keyed on it counts a hit the real
 * cache would never have given. `chunkKeyOf` is the one spelling the reader and the plan share
 * (`volume.ts` says why), and this probe exists to measure what that cache would do — a second
 * spelling here measures a different cache.
 */
const keys = (base, scale, box) =>
  chunksCovering(scale, box).map((chunk) => chunkKeyOf(base, scale, chunk))

/** How many of these chunks a cache holding `seen` would answer, adding the rest to it. */
function against(seen, chunks) {
  let hits = 0
  for (const name of chunks) {
    if (seen.has(name)) hits += 1
    else seen.add(name)
  }
  return hits
}

/** The live cache's own tally, which is what the simulation above is checked against. */
const cacheLine = (cache) =>
  `${cache.hits}/${cache.asked} hit, ${(cache.bytes / 1e6).toFixed(0)} MB`

async function main() {
  const volume = await openSearchVolume(
    DATASTACK,
    XY_NM,
    { boundary: Date.now() },
    options,
    { chunkBytes: BUDGET_MB * 1024 * 1024 },
  )
  const patchScale = patchScaleFrom(volume.info)
  console.log(`neuron ${neuron.neuron}, ${neuron.tipsNm.length} tips, first ${TIPS}`)
  console.log(`  scale ${volume.scale.key}, chunk ${volume.scale.chunkSize.join(' x ')} voxels`)
  console.log(`  own_um ${neuron.own_um}, patch reach ${PATCH_REACH_NM} nm`)
  console.log(`  sharded: ${volume.scale.sharding ? 'yes' : 'no'}`)

  /*
   * **Network against decode, on one chunk.** The two want different caches: raw bytes are
   * small and save only the fetch, a decoded chunk saves both and costs several times the
   * memory. Measured rather than guessed, with one extra request.
   */
  {
    const first = chunksCovering(
      volume.scale,
      boxAround(volume.scale, neuron.tipsNm[0], HALF_WIDTH_UM * 1000),
    )[0]
    // The unsharded address, which on this volume is also the cache key; `chunkKeyOf` says why
    // the two are not the same thing in general.
    const url = `${volume.base}/${volume.scale.key}/${first.name}`
    const at = performance.now()
    const bytes = await (await fetch(url)).arrayBuffer()
    console.log(
      `  one chunk: ${(bytes.byteLength / 1e6).toFixed(2)} MB over the wire in ` +
        `${(performance.now() - at).toFixed(0)} ms`,
    )
  }
  console.log('')

  /*
   * **The plan, in the order the walk will take them** — the same call the node makes per
   * neuron, so what is measured below is the policy the run actually uses rather than a
   * simulation of it.
   */
  const walk = []
  for (let i = 0; i < TIPS; i++) walk.push(neuron.tipsNm[i])
  if (PLAN) {
    volume.planEnds(walk, {
      halfWidthNm: HALF_WIDTH_UM * 1000,
      patchScale,
      patchReachNm: widestPatchReach(neuron.own_um),
    })
  }
  console.log(`  budget ${BUDGET_MB} MB, policy ${PLAN ? 'furthest next use' : 'LRU'}\n`)

  const seen = new Set()
  let voxelMs = 0
  let patchVoxelMs = 0
  let rootMs = 0
  let fetched = 0
  let saved = 0

  for (let i = 0; i < TIPS; i++) {
    const tip = neuron.tipsNm[i]
    const searchBox = boxAround(volume.scale, tip, HALF_WIDTH_UM * 1000)
    // The widest box this tip's list can produce: every contact is within `own_um` of it.
    const patchBox = boxAroundAll(patchScale, [tip], widestPatchReach(neuron.own_um))
    const chunks = [
      ...keys(volume.base, volume.scale, searchBox),
      ...keys(volume.base, patchScale, patchBox),
    ]
    if (i === 0) {
      console.log(
        `  search box ${extent(searchBox).join('x')} voxels, ` +
          `patch box up to ${extent(patchBox).join('x')}\n`,
      )
    }
    const hits = against(seen, chunks)
    fetched += chunks.length - hits
    saved += hits

    const voxelAt = performance.now()
    const read = await readLabelBox(volume.base, volume.scale, searchBox, {
      ...options,
      info: volume.info,
      chunks: volume.chunks,
    })
    const ms = performance.now() - voxelAt
    voxelMs += ms

    const unknown = new BigUint64Array([...read.labels].filter((id) => !volume.roots.has(id)))
    const rootAt = performance.now()
    if (unknown.length > 0) {
      const found = await rootsAtInstant(volume.graphene, volume.at, unknown, options)
      for (let k = 0; k < unknown.length; k++) volume.roots.set(unknown[k], found[k])
    }
    const lookupMs = performance.now() - rootAt
    rootMs += lookupMs

    /*
     * **The second read of the same tip**, which is the saving a cache is supposed to make
     * without any help from the walk's order: the patch box is drawn around contacts that lie
     * inside the search box, so its chunks are a superset of the ones just fetched. Read here
     * with the maximal box, since the real one needs contacts the search has not produced in
     * this probe — same chunks, bounded the same way the plan bounds it.
     */
    const askedBefore = volume.chunks.asked
    const hitsBefore = volume.chunks.hits
    const patchAt = performance.now()
    await readLabelBox(volume.base, patchScale, patchBox, {
      ...options,
      info: volume.info,
      chunks: volume.chunks,
    })
    const patchMs = performance.now() - patchAt
    patchVoxelMs += patchMs
    const patchAsked = volume.chunks.asked - askedBefore
    const patchHits = volume.chunks.hits - hitsBefore

    // One end off the plan, exactly as the node does it.
    volume.endSearched()

    console.log(
      `  tip ${String(i).padStart(2)}  search ${ms.toFixed(0).padStart(5)} ms  ` +
        `roots ${lookupMs.toFixed(0).padStart(5)} ms  ` +
        `patch ${patchMs.toFixed(0).padStart(5)} ms ` +
        `(${patchHits}/${patchAsked} of its chunks already held)  ` +
        `cache ${cacheLine(volume.chunks)}`,
    )
  }

  const total = voxelMs + patchVoxelMs + rootMs
  console.log(
    `\n  ${TIPS} tips: search ${(voxelMs / 1000).toFixed(1)} s, ` +
      `patch ${(patchVoxelMs / 1000).toFixed(1)} s, roots ${(rootMs / 1000).toFixed(1)} s`,
  )
  console.log(`  per tip: ${(total / TIPS / 1000).toFixed(2)} s of reading, before the GPU`)
  console.log(
    `  chunks: ${fetched} fetched, ${saved} a run-wide cache would have answered ` +
      `(${((100 * saved) / (fetched + saved)).toFixed(0)}%)`,
  )
  console.log(`  cache would hold ${seen.size} chunks for these ${TIPS} tips`)
  console.log(
    `  the run's own cache: ${volume.chunks.hits} of ${volume.chunks.asked} asks answered, ` +
      `${(volume.chunks.bytes / 1e6).toFixed(0)} MB held`,
  )
  /*
   * **A verdict, not only a reading.** The whole premise of the cache is that neighbouring ends
   * of one neuron want the same chunks, and `SECONDS_PER_PATCH_BOX` is priced from it — so a
   * walk whose boxes stopped overlapping is the thing worth failing on, rather than a number
   * nobody compares against anything.
   */
  report.check(
    volume.chunks.hits > volume.chunks.asked / 2,
    `most of a walk's chunk reads are answered from the cache ` +
      `(${volume.chunks.hits} of ${volume.chunks.asked})`,
  )
}

const report = probeReport()
await main()
report.finish('A walk along one neuron is re-fetching chunks it already had.')
