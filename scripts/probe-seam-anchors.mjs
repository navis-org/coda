#!/usr/bin/env node
/**
 * Where Submit's check spends its time: the anchor of each accepted piece (`mergeAnchors.ts`),
 * which `planMerges` finds `ANCHORS_IN_FLIGHT` pieces at a time.
 *
 *   pnpm probe:seam-anchors                       # needs a CAVE token
 *   pnpm probe:seam-anchors -- --pieces 120 --flights 1,6 --order place --no-apart
 *
 * A reader with 200 accepted pieces waited minutes on "Checking…" (user, 2026-11-20). Each
 * anchor reads a box of segmentation around the contact at the chunkedgraph's base scale (16 nm
 * on Aedes) and asks the chunkedgraph each supervoxel's root at the server's now. This times the
 * two apart, one anchor after another, and then the whole of `anchorMerge` with several anchors
 * in flight through `slots`, the pool the plan uses, each mode on a volume of its own so no mode
 * inherits another's cache.
 *
 * The contacts are real open ends of one neuron (`__fixtures__/ownTipNeuron.json`), spread over
 * it — every `n`th — as a neuron's accepted pieces are: the plan takes them in tree order, not in
 * order of place. The candidate is a made-up root, so every anchor is refused as absent; what it
 * costs is the box and its roots, which are read before anything is chosen.
 *
 * Reads only. Nothing here writes to CAVE.
 */

import { slots } from '../src/data/concurrency.ts'
import { readLabelBox, boxAround } from '../src/data/precomputed/volume.ts'
import { NM_PER_UM } from '../src/data/units.ts'
import {
  ANCHOR_MARGIN_NM,
  anchorMerge,
  anchorReachNm,
  openAnchorVolume,
} from '../src/packs/seam/mergeAnchors.ts'
import { resolveRoots } from '../src/packs/seam/rootedBox.ts'
import { AEDES_DEPLOYMENT, probeArgs, requireCaveToken } from './lib/browserProbe.mjs'
import { lcg, readRepoFile } from './lib/pyodideProbe.mjs'

const args = probeArgs()
const DATASTACK = 'wclee_aedes_brain'
const PIECES = Number(args.value('--pieces') ?? 40)
/** Half a 1 µm gap plus `ANCHOR_MARGIN_NM`: a typical accepted pair. */
const REACH_NM = Number(args.value('--reach-nm') ?? 1000)
// The plan's own `ANCHORS_IN_FLIGHT` among them, and either side of it.
const FLIGHTS = (args.value('--flights') ?? '1,6,16').split(',').map(Number)
const neuron = JSON.parse(readRepoFile('src/packs/seam/__fixtures__/ownTipNeuron.json'))
const every = Math.max(1, Math.floor(neuron.tipsNm.length / PIECES))
/**
 * `--order`: `tips`, the fixture's own (end_uid, close to an arbor at a time); `shuffled`, as a
 * plan's tree order meets them — accepted as the queue sorted them, by score; `place`, by the
 * 4 µm cell each contact falls in, which is what a plan could take them in.
 */
const ORDER = args.value('--order') ?? 'shuffled'
const random = lcg(1)
const spread = neuron.tipsNm.filter((_, i) => i % every === 0).slice(0, PIECES)
const cell = (at) => at.map((nm) => Math.floor(nm / 4096))
const contacts =
  ORDER === 'tips'
    ? spread
    : ORDER === 'place'
      ? [...spread].sort((a, b) => {
          const [p, q] = [cell(a), cell(b)]
          return p[2] - q[2] || p[1] - q[1] || p[0] - q[0]
        })
      : spread
          .map((at) => ({ at, key: random() }))
          .sort((a, b) => a.key - b.key)
          .map(({ at }) => at)
const options = { deployment: AEDES_DEPLOYMENT, token: requireCaveToken() }
// The gap whose reach is `REACH_NM`, and that reach as `anchorMerge` works it out, for both modes.
const minDistUm = (2 * (REACH_NM - ANCHOR_MARGIN_NM)) / NM_PER_UM
const reachNm = anchorReachNm(minDistUm)
if (reachNm === undefined) {
  console.error(`--reach-nm ${REACH_NM} is past the furthest an anchor is looked for`)
  process.exit(2)
}
const CANDIDATE = '648518347622603653'

const ms = (t) => `${(t / 1000).toFixed(1)} s`

async function apart() {
  const volume = await openAnchorVolume(DATASTACK, 'server', options)
  console.log(
    `scale ${volume.scale.key}, chunk ${volume.scale.chunkSize.join(' x ')} voxels, ` +
      `sharded ${volume.scale.sharding ? 'yes' : 'no'}`,
  )
  let read = 0
  let roots = 0
  let labels = 0
  for (const at of contacts) {
    const box = boxAround(volume.scale, at, reachNm)
    const t0 = performance.now()
    const got = await readLabelBox(volume.base, volume.scale, box, {
      ...options,
      info: volume.info,
      chunks: volume.chunks,
    })
    const t1 = performance.now()
    const before = volume.memo.roots.size
    await resolveRoots(volume, got.labels, options)
    const t2 = performance.now()
    read += t1 - t0
    roots += t2 - t1
    labels += volume.memo.roots.size - before
  }
  const cache = volume.chunks
  console.log(
    `\none at a time, ${contacts.length} anchors at ${reachNm} nm reach:\n` +
      `  voxels  ${ms(read)}  (${(read / contacts.length).toFixed(0)} ms an anchor; ` +
      `chunks ${cache.hits}/${cache.asked} from cache)\n` +
      `  roots   ${ms(roots)}  (${(roots / contacts.length).toFixed(0)} ms an anchor; ` +
      `${labels} supervoxels, ${(labels / contacts.length).toFixed(0)} an anchor)`,
  )
}

async function inFlight(flight) {
  const volume = await openAnchorVolume(DATASTACK, 'server', options)
  const pool = slots(flight)
  const t0 = performance.now()
  await Promise.all(
    contacts.map((at) =>
      pool.run(() =>
        anchorMerge(
          volume,
          { neuronRoot: neuron.neuron, candidateRoot: CANDIDATE, contactNm: at, minDistUm },
          options,
        ),
      ),
    ),
  )
  const t = performance.now() - t0
  console.log(
    `  ${String(flight).padStart(2)} in flight: ${ms(t)}, ${(t / contacts.length).toFixed(0)} ms an anchor` +
      ` (chunks ${volume.chunks.hits}/${volume.chunks.asked} from cache)`,
  )
}

console.log(`order: ${ORDER}`)
if (!args.all.includes('--no-apart')) await apart()
console.log('\nanchorMerge whole, a fresh volume each:')
for (const flight of FLIGHTS) await inFlight(flight)
