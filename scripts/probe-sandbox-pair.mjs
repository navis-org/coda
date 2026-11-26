/**
 * Find a pair of touching segments in the CAVE sandbox for the merge test to propose
 * (`docs/seam-merge-plan.md`, phase 7).
 *
 *   pnpm probe:sandbox-pair                            # around the middle of the volume
 *   pnpm probe:sandbox-pair -- --at 10752,28222,2205   # around a voxel at the base scale
 *   pnpm probe:sandbox-pair -- --chain                  # three in a row, for the chain test
 *   pnpm probe:sandbox-pair -- --tree                   # a chain and a second piece on its neuron
 *
 * **Reads only**, and held to it: it does not import the writer, and it runs behind
 * `fenceWrites({})`, which refuses any chunkedgraph write at `fetch`. It reads one box of the
 * sandbox's supervoxels from the public bucket, asks the chunkedgraph each one's root
 * (`roots_binary`), whether those roots are current at the server's now (`is_latest_roots`) and
 * how big they are (`get_leaves_many`, level 2), and anchors the chosen pairs the way the merge
 * would (phase 1). It prints proposals; the merge itself is `scripts/probe-cave-merge.mjs`, run
 * only after the user approves that exact pair.
 *
 * Small pieces are preferred: a merge of two large segments locks and remeshes more of the
 * graph, which is cost on a shared server for no extra evidence.
 */

import { isLatestRoots, l2ChunkCounts } from '../src/data/cave/rootIds.ts'
import { anchorMerge, openAnchorVolume } from '../src/packs/seam/mergeAnchors.ts'
import { labelledBox } from '../src/packs/seam/rootedBox.ts'
import { SANDBOX, fenceWrites } from '../src/test/sandboxWrites.ts'
import { AEDES_DEPLOYMENT, probeArgs, requireCaveToken } from './lib/browserProbe.mjs'

fenceWrites({})

/** The box read, in base-scale voxels: about 1.1 × 1.1 × 0.7 µm at 17.2 × 17.2 × 45 nm. */
const BOX = [64, 64, 16]
/** Touching voxel faces a pair needs: a real boundary, not a corner. */
const MIN_FACES = 20
/** How many pairs to anchor and show, smallest first. */
const SHOWN = 5

const args = probeArgs()
const options = { deployment: AEDES_DEPLOYMENT, token: requireCaveToken() }

async function main() {
  const volume = await openAnchorVolume(SANDBOX.datastack, Date.now(), options)
  const { scale, graphene } = volume
  const at = args.value('--at')
  const centre = at
    ? at.split(',').map((part) => (part.trim() === '' ? Number.NaN : Number(part)))
    : scale.size.map((n, a) => Math.floor(scale.voxelOffset[a] + n / 2))
  if (centre.length !== 3 || !centre.every(Number.isInteger)) {
    console.error('Usage: --at X,Y,Z — a voxel at the base scale, three whole numbers.')
    process.exit(2)
  }
  const lo = centre.map((c, a) => c - Math.floor(BOX[a] / 2))
  const box = { lo, hi: lo.map((v, a) => v + BOX[a]) }
  console.log(
    `${SANDBOX.datastack}: ${graphene.server}, table ${graphene.table}, scale ${scale.key}; ` +
      `box ${box.lo.join(',')} – ${box.hi.join(',')} voxels\n`,
  )

  const read = await labelledBox(volume, scale, box, options)
  const size = read.size
  const rootAt = (i) => read.roots[read.index[i]]
  const steps = [1, size[0], size[0] * size[1]]

  // Touching faces between different roots, counted per pair, with one face kept for its midpoint.
  const pairs = new Map()
  for (let z = 0; z < size[2]; z++) {
    for (let y = 0; y < size[1]; y++) {
      for (let x = 0; x < size[0]; x++) {
        const i = x + size[0] * (y + size[1] * z)
        const here = rootAt(i)
        if (here === 0n) continue
        const voxel = [x, y, z]
        for (let axis = 0; axis < 3; axis++) {
          if (voxel[axis] + 1 === size[axis]) continue
          const there = rootAt(i + steps[axis])
          if (there === 0n || there === here) continue
          const [p, q] = (here < there ? [here, there] : [there, here]).map(String)
          const key = `${p},${q}`
          const entry = pairs.get(key) ?? { p, q, faces: 0, voxel, axis }
          entry.faces++
          pairs.set(key, entry)
        }
      }
    }
  }
  const touching = [...pairs.values()].filter((e) => e.faces >= MIN_FACES)
  console.log(
    `${read.labels.length} supervoxels, ${pairs.size} touching root pairs in the box, ` +
      `${touching.length} with ≥ ${MIN_FACES} faces`,
  )
  if (touching.length === 0) return console.log('Nothing touches enough here; try another --at.')

  // Asked only about pairs that could be proposed, at the server's now, not the box's moment —
  // a root read at a moment is always current at that same moment.
  const roots = [...new Set(touching.flatMap((e) => [e.p, e.q]))]
  const latest = await isLatestRoots(graphene, roots, 'server', options)
  const current = new Set(roots.filter((_, i) => latest[i]))
  const live = touching.filter((e) => current.has(e.p) && current.has(e.q))
  const sizes = await l2ChunkCounts(graphene, [...new Set(live.flatMap((e) => [e.p, e.q]))], options)
  const sizeOf = (root) => sizes.get(root) ?? Infinity
  const ranked = live
    .map((e) => ({ ...e, size: Math.max(sizeOf(e.p), sizeOf(e.q)) }))
    .sort((a, b) => a.size - b.size || b.faces - a.faces)
  console.log(`${ranked.length} of them with both roots current\n`)

  // The face's midpoint, in absolute nanometres: half a voxel past the lower voxel's centre.
  const contactOf = (e) =>
    e.voxel.map((v, a) => (box.lo[a] + v + 0.5 + (a === e.axis ? 0.5 : 0)) * scale.resolution[a])

  if (args.all.includes('--chain')) return chains(ranked)
  if (args.all.includes('--tree')) return trees(ranked)

  for (const e of ranked.slice(0, SHOWN)) {
    const contactNm = contactOf(e)
    const pair = { neuronRoot: e.p, candidateRoot: e.q, contactNm, minDistUm: 0 }
    const anchors = await anchorMerge(volume, pair, options)
    console.log(
      `${e.p} (${sizeOf(e.p)} L2) + ${e.q} (${sizeOf(e.q)} L2): ${e.faces} faces, ` +
        `contact ${contactNm.map((n) => n.toFixed(1)).join(',')} nm`,
    )
    console.log(
      anchors.ok
        ? `    anchors ${anchors.neuron.supervoxel} @ ${anchors.neuron.positionNm.join(', ')} / ` +
            `${anchors.candidate.supervoxel} @ ${anchors.candidate.positionNm.join(', ')}`
        : `    not anchored: ${anchors.reason} — ${anchors.message}`,
    )
  }

  /**
   * `--chain`: three roots in a row, N – A – B, for the test of a merge made onto a piece that is
   * merged first (`docs/seam-extend-plan.md`, phase 6; `scripts/probe-cave-merge-chain.mjs`). A
   * touches both; N and B do not have to touch each other. Anchored the way that merge is: A onto
   * N, then B onto N **and A read as one side**, which has to land on A.
   */
  /**
   * `--tree`: a chain N – A – B and a fourth root C touching N too, for the test of a batch that
   * merges from the tips in (`scripts/probe-cave-merge-tree.mjs`): B onto A and C onto N go side
   * by side, on roots nothing else uses. C touches neither A nor B.
   */
  async function trees(pairs) {
    const partners = new Map()
    const touch = new Set()
    for (const e of pairs) {
      touch.add(`${e.p},${e.q}`).add(`${e.q},${e.p}`)
      for (const [one, other] of [
        [e.p, e.q],
        [e.q, e.p],
      ]) {
        partners.set(one, [...(partners.get(one) ?? []), { other, e }])
      }
    }
    const found = []
    for (const [n, onN] of partners) {
      for (const { other: a, e: na } of onN) {
        for (const { other: b, e: ab } of partners.get(a) ?? []) {
          if (b === n || touch.has(`${b},${n}`)) continue
          for (const { other: c, e: nc } of onN) {
            if (c === a || c === b || touch.has(`${c},${a}`) || touch.has(`${c},${b}`)) continue
            found.push({
              n, a, b, c, na, ab, nc,
              size: Math.max(...[n, a, b, c].map(sizeOf)),
            })
          }
        }
      }
    }
    found.sort((x, y) => x.size - y.size)
    console.log(`${found.length} trees of four\n`)
    for (const t of found.slice(0, SHOWN)) {
      const contacts = [contactOf(t.na), contactOf(t.ab), contactOf(t.nc)]
      const a = await anchorMerge(
        volume,
        { neuronRoot: t.n, candidateRoot: t.a, contactNm: contacts[0], minDistUm: 0 },
        options,
      )
      const b = await anchorMerge(
        volume,
        { neuronRoot: t.n, alsoNeuron: [t.a], candidateRoot: t.b, contactNm: contacts[1], minDistUm: 0 },
        options,
      )
      const c = await anchorMerge(
        volume,
        { neuronRoot: t.n, candidateRoot: t.c, contactNm: contacts[2], minDistUm: 0 },
        options,
      )
      console.log(
        `${t.n} (${sizeOf(t.n)} L2): A ${t.a} (${sizeOf(t.a)}), B ${t.b} (${sizeOf(t.b)}) on A, ` +
          `C ${t.c} (${sizeOf(t.c)})`,
      )
      console.log(
        `    --tree ${t.n},${t.a},${t.b},${t.c} --contacts "${contacts
          .map((nm) => nm.map((v) => v.toFixed(1)).join(','))
          .join(';')}"`,
      )
      console.log(
        `    A ${a.ok ? 'anchors' : `not anchored (${a.reason})`}; B ` +
          (b.ok
            ? `anchors on ${b.onRoot === t.a ? 'A' : `root ${b.onRoot}`}`
            : `not anchored (${b.reason})`) +
          `; C ${c.ok ? 'anchors' : `not anchored (${c.reason})`}`,
      )
    }
  }

  async function chains(pairs) {
    const partners = new Map()
    for (const e of pairs) {
      for (const [mid, other] of [
        [e.p, e.q],
        [e.q, e.p],
      ]) {
        partners.set(mid, [...(partners.get(mid) ?? []), { other, e }])
      }
    }
    const found = []
    for (const [mid, list] of partners) {
      for (const first of list) {
        for (const second of list) {
          if (first.other >= second.other) continue
          found.push({
            n: first.other,
            a: mid,
            b: second.other,
            na: first.e,
            ab: second.e,
            size: Math.max(sizeOf(first.other), sizeOf(mid), sizeOf(second.other)),
          })
        }
      }
    }
    found.sort((x, y) => x.size - y.size)
    console.log(`${found.length} chains of three\n`)
    for (const c of found.slice(0, SHOWN)) {
      const contacts = [contactOf(c.na), contactOf(c.ab)]
      const onto = await anchorMerge(
        volume,
        { neuronRoot: c.n, candidateRoot: c.a, contactNm: contacts[0], minDistUm: 0 },
        options,
      )
      const beyond = await anchorMerge(
        volume,
        { neuronRoot: c.n, alsoNeuron: [c.a], candidateRoot: c.b, contactNm: contacts[1], minDistUm: 0 },
        options,
      )
      console.log(
        `${c.n} (${sizeOf(c.n)} L2) – ${c.a} (${sizeOf(c.a)} L2) – ${c.b} (${sizeOf(c.b)} L2)`,
      )
      console.log(
        `    --chain ${c.n},${c.a},${c.b} --contacts "${contacts
          .map((nm) => nm.map((n) => n.toFixed(1)).join(','))
          .join(';')}"`,
      )
      console.log(
        `    first: ${onto.ok ? 'anchors' : `not anchored (${onto.reason})`}; second: ` +
          (beyond.ok
            ? `anchors on ${beyond.onRoot === c.a ? 'the middle piece' : `root ${beyond.onRoot}`}`
            : `not anchored (${beyond.reason})`),
      )
    }
  }
}

await main()
