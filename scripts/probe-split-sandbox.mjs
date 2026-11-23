/**
 * The live test of the split gallery's write, on the CAVE sandbox only
 * (`docs/split-gallery-plan.md`, phase 4). **This script writes** — one split and its undo — and
 * is run only after the user has approved it, every time.
 *
 *   pnpm probe:split-sandbox -- --root R --point x,y,z                 # reads: lists the splits
 *   pnpm probe:split-sandbox -- --root R --point x,y,z --pick N        # reads: shows split N and its code
 *   pnpm probe:split-sandbox -- --root R --point x,y,z --pick N --i-asked R:N:CODE   # split, check, undo, check
 *
 * `R` is a current root on `fanc_sandbox`, `point` a place on it (absolute nm), `N` a split as the
 * gallery numbers them (1 = first). `CODE` is a fingerprint of split N's exact edges, printed by
 * the read-only run: `--i-asked` must repeat `R:N:CODE`, so a command recalled from history with
 * another root, point or split — or a box that reads differently now — stops before writing.
 *
 * Everything between the reads and the server is the shipped code: the gallery's reads
 * (`readSplitNeuron`, `readSplitBox`), its candidates (`splitCandidates`), and the write with its
 * checks (`writeSplit`, `LIVE_SPLIT_WRITE`). Held to the sandbox three ways: the datastack is a
 * constant here and its graphene source must be the sandbox table; `fenceWrites` refuses, at
 * `fetch`, any write that is not one split and one undo on that table; and the writer sends only
 * what `confirmSplit` was given. A one-edge split goes with the min-cut off; a longer one as the
 * server's min-cut, after its read-only preview has agreed with the tile edge for edge
 * (`splitWrite.ts`).
 *
 * **Once the split may have been made, the undo is always tried** — whatever the checks between
 * find or throw — and whatever is left at the end is said, with the operation id to undo by hand.
 */

import { createHash } from 'node:crypto'

import { requestOptionsOf } from '../src/data/cave/edits.ts'
import { within } from '../src/data/cave/editWaits.ts'
import { cellBox, chunkOf, isBoxable } from '../src/data/cave/graphLayout.ts'
import { readLevelTwoGraph } from '../src/data/cave/l2.ts'
import { isLatestRoots, l2ChunkCounts, supervoxelRoots } from '../src/data/cave/rootIds.ts'
import { findSupervoxels } from '../src/data/cave/volumes.ts'
import { splitCandidates } from '../src/packs/seam/splitGallery.ts'
import { readSplitBox, readSplitNeuron } from '../src/packs/seam/splitGalleryRun.ts'
import { LIVE_SPLIT_WRITE, writeSplit } from '../src/packs/seam/splitWrite.ts'
import { FENCE_REFUSED, SANDBOX, fenceWrites } from '../src/test/sandboxWrites.ts'
import { AEDES_DEPLOYMENT, probeArgs, probeReport, requireCaveToken } from './lib/browserProbe.mjs'

// First, before anything can send: one split and one undo, on the sandbox table, and no more.
const written = fenceWrites({ split: 1, undo: 1 })

/** How long a split still out after the writer's own limit is waited for: as long as the gallery. */
const LATE_MS = 10 * 60_000

const args = probeArgs()
const options = { deployment: AEDES_DEPLOYMENT, token: requireCaveToken() }
const readAs = requestOptionsOf(options)
const report = probeReport()

const root = args.value('--root') ?? ''
const pointNm = (args.value('--point')?.split(',') ?? []).map((part) =>
  part.trim() === '' ? Number.NaN : Number(part),
)
const pickArg = args.value('--pick')
const pick = pickArg === undefined ? undefined : Number(pickArg)
const asked = args.value('--i-asked')
if (
  !/^[1-9][0-9]*$/.test(root) ||
  pointNm.length !== 3 ||
  !pointNm.every(Number.isFinite) ||
  (pick !== undefined && !(Number.isInteger(pick) && pick >= 1)) ||
  (asked !== undefined && pick === undefined)
) {
  console.error('Usage: --root R --point X,Y,Z [--pick N [--i-asked R:N:CODE]]')
  process.exit(2)
}

/** A split's exact edges, as eight hex digits: what `--i-asked` must name. */
const codeOf = (cut) =>
  createHash('sha256')
    .update(
      cut
        .map((e) => [e.source, e.sink].sort().join('-'))
        .sort()
        .join(','),
    )
    .digest('hex')
    .slice(0, 8)

/**
 * What may stand in the sandbox: what any ending must say out loud, with what it takes to undo it
 * by hand. Set before the split is sent, since from then on any failure may leave one; cleared
 * only where nothing was sent, or the roots show the neuron whole again after the undo.
 */
let standing

/**
 * The gallery's read of the neuron — or, where the sandbox has no level-2 cache (it has none:
 * "Dataset mar2021_test does not have an L2 Cache.", 2026-11-23), the same read with each chunk
 * placed at its grid cell's centre. The points only order the splits by distance and are logged
 * with the edit; the cut, its check and the write are the same either way.
 */
async function neuronOf(graphene, layout) {
  try {
    return await readSplitNeuron(graphene, layout, root, readAs)
  } catch (error) {
    if (!(error instanceof Error && /does not have an L2 Cache/.test(error.message))) throw error
    console.log('  no level-2 cache: chunks placed at their grid cells’ centres')
  }
  const { chunks, edges } = await readLevelTwoGraph(graphene, root, readAs)
  const cells = new Map()
  const positions = new Map()
  for (const chunk of chunks) {
    const cell = chunkOf(layout, BigInt(chunk))
    if (!cell) continue
    cells.set(chunk, cell)
    const [lo, hi] = cellBox(layout, cell, cell)
    positions.set(
      chunk,
      lo.map((v, a) => ((v + hi[a] + 1) / 2) * layout.baseResolutionNm[a]),
    )
  }
  return { root, chunks, links: edges, positions, cells }
}

async function main() {
  const { graphene, layout } = await findSupervoxels(SANDBOX.datastack, options)
  // The datastack record decides the table; it has to be the sandbox's, or nothing goes further.
  if (graphene.server !== SANDBOX.server || graphene.table !== SANDBOX.table) {
    throw new Error(`${SANDBOX.datastack} resolved to ${graphene.base}, not the sandbox table.`)
  }
  if (!isBoxable(layout)) throw new Error('The sandbox publishes no chunk grid.')
  console.log(`${SANDBOX.datastack}: ${graphene.server}, table ${graphene.table}\n`)

  const [current] = await isLatestRoots(graphene, [root], 'server', readAs)
  report.check(current === true, `${root} is current`)
  if (!current) return

  const neuron = await neuronOf(graphene, layout)
  const input = await readSplitBox(graphene, layout, neuron, pointNm, readAs)
  const candidates = [...splitCandidates(input)].filter(Boolean)
  console.log(
    `${root}: ${neuron.chunks.length} level-2 chunks; ${candidates.length} splits near the point`,
  )
  candidates.forEach((c, i) => {
    const taken = Math.min(c.sizes.a, c.sizes.b)
    console.log(
      `  ${i + 1}. takes off ${taken} of ${c.sizes.a + c.sizes.b} chunks, ` +
        `${(c.alongNm / 1000).toFixed(1)} µm along; cut of ${c.cut.length} edge(s), code ${codeOf(c.cut)}`,
    )
  })
  if (pick === undefined) return
  const candidate = candidates[pick - 1]
  if (!candidate) {
    report.check(false, `split ${pick} is on offer`)
    return
  }
  const code = codeOf(candidate.cut)
  const ends = [...new Set(candidate.cut.flatMap((e) => [e.source, e.sink]))]
  console.log(`\nSplit ${pick} (code ${code}): ${candidate.cut.map((e) => `${e.source}–${e.sink}`).join(', ')}`)
  if (asked === undefined) {
    console.log(`\nReads only: nothing was sent. To split and undo: --i-asked ${root}:${pick}:${code}`)
    return
  }
  if (asked !== `${root}:${pick}:${code}`) {
    report.check(false, `--i-asked ${asked} names this split (${root}:${pick}:${code}); nothing was sent`)
    return
  }

  // The write, as Accept makes it: every check before and after is the shipped one.
  standing = `maybe a split of ${root}, operation id unknown: read the roots of its cut's ends`
  const result = await writeSplit(
    { graphene, root, input, candidate },
    options,
    (step) => console.log(`  … ${step}`),
    LIVE_SPLIT_WRITE,
  )
  console.log(`\nResult: ${JSON.stringify({ ...result, late: undefined })}`)
  const fenced = 'message' in result && result.message?.includes(FENCE_REFUSED)
  report.check(!fenced, 'the fence let the split through')
  let done = 'done' in result ? result.done : undefined
  if (!done && result.kind === 'unknown' && result.late) {
    // Still out: wait for its answer, so its operation id is known (and undone) rather than lost.
    console.log(`  waiting up to ${LATE_MS / 60_000} minutes for the split's answer…`)
    const answer = await within(result.late, LATE_MS)
    console.log(`  late answer: ${JSON.stringify(answer ?? 'none')}`)
    if (answer?.kind === 'done') done = answer
    else if (answer?.kind === 'refused') standing = undefined
  }
  if (result.kind === 'not-sent' || result.kind === 'refused' || (fenced && !done)) {
    standing = undefined
  }
  if (!done) return
  standing = `split operation ${done.operationId} on ${root}, not undone: undo it by that id`

  // The checks between the split and the undo: whatever they find or throw, the undo is sent.
  try {
    report.check(
      result.kind === 'split' && result.kept !== undefined && result.message === undefined,
      `the server split the neuron, the sides apart when read back` +
        (result.message ? ` (${result.message})` : ''),
    )
    const [stillCurrent] = await isLatestRoots(graphene, [root], 'server', readAs)
    report.check(stillCurrent === false, `${root} is no longer current`)
    const sizes = await l2ChunkCounts(graphene, done.newRootIds, readAs)
    console.log(
      `  new roots: ${done.newRootIds.map((id) => `${id} (${sizes.get(id)} L2)`).join(', ')}; ` +
        `the gallery said ${candidate.sizes.a} + ${candidate.sizes.b}`,
    )
  } catch (error) {
    report.check(false, `the checks after the split: ${error instanceof Error ? error.message : error}`)
  }

  // Undo, through the same services Undo uses, and read the cut's ends back.
  let undone
  try {
    undone = await within(LIVE_SPLIT_WRITE.undo(done, options), LATE_MS)
  } catch (error) {
    undone = { kind: 'unknown', message: error instanceof Error ? error.message : String(error) }
  }
  console.log(`\nUndo: ${JSON.stringify(undone ?? 'no answer')}`)
  report.check(undone?.kind === 'done', 'the undo was made')
  if (undone?.kind !== 'done') {
    // Never "undo it by that id" for an undo that may have landed: a second undo is another edit.
    standing =
      undone?.kind === 'refused'
        ? `split operation ${done.operationId} on ${root}; its undo was refused (${undone.message}): undo it by that id`
        : `split operation ${done.operationId} on ${root}; its undo was sent and its result is not known: ` +
          `read the roots of the cut's ends (${ends.join(', ')}) before anything else`
    return
  }
  standing =
    `split operation ${done.operationId} on ${root}, undone by operation ${undone.operationId}, ` +
    `not yet confirmed: read the roots of the cut's ends (${ends.join(', ')})`
  const after = await supervoxelRoots(graphene, ends, 'server', readAs)
  const together = new Set(after)
  const [whole] = together
  report.check(
    together.size === 1 && undone.newRootIds.includes(whole),
    `every end of the cut is back under one root (${[...together].join(', ')})`,
  )
  if (together.size !== 1) return
  standing = undefined
  const [latest] = await isLatestRoots(graphene, [whole], 'server', readAs)
  const sizes = await l2ChunkCounts(graphene, [whole], readAs)
  report.check(latest === true, `${whole} is current`)
  console.log(`  ${whole}: ${sizes.get(whole)} L2 (was ${neuron.chunks.length})`)
}

try {
  await main()
} catch (error) {
  report.check(false, `stopped: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  console.log(`\nWrites sent: ${written()}`)
  if (standing) console.log(`\n!! STILL IN THE SANDBOX: ${standing}`)
}
// Last: `finish` exits, and nothing above may be cut short — above all the standing line.
report.finish()
