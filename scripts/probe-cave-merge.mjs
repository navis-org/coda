/**
 * The live test of the chunkedgraph writer, on the CAVE sandbox only (`docs/seam-merge-plan.md`,
 * phase 7). **This script writes** — one merge and its undo — and is run only after the user has
 * approved the exact pair, every time.
 *
 *   pnpm probe:cave-merge -- --pair N,C --contact x,y,z              # pre-flight only: reads
 *   pnpm probe:cave-merge -- --pair N,C --contact x,y,z --i-asked N,C   # merge, check, undo, check
 *
 * `N` and `C` are two current root ids on `fanc_sandbox` that touch at `contact` (absolute nm);
 * `pnpm probe:sandbox-pair` finds some. `--i-asked` must repeat the pair, so a command recalled
 * from history with a different pair stops before writing.
 *
 * Held to the sandbox three ways: the datastack is a constant here and its graphene source must be
 * the sandbox table; `fenceWrites` refuses, at `fetch`, any write that is not a merge or undo on
 * that table, and any third write; and the writer itself sends only what `confirmMerge` was given.
 *
 * Every root read asks at the server's own now (`Instant` `'server'` in `rootIds.ts`), not this
 * machine's: a clock behind the server's would ask about a moment before the merge and see the old
 * roots. The permission check and those reads are the shipped ones (`permissions.ts`,
 * `rootIds.ts`); the rest of the pre-flight is this script's own — a test of the writer alone.
 * `probe-cave-merge-chain.mjs` runs the shipped pre-flight and the shipped batch.
 */

import { CaveError } from '../src/data/cave/client.ts'
import { confirmMerge, mergeSupervoxels, undoMerge } from '../src/data/cave/edits.ts'
import { isNodeId } from '../src/data/cave/graphLayout.ts'
import { editPermission } from '../src/data/cave/permissions.ts'
import { isLatestRoots, l2ChunkCounts, rootsAtInstant } from '../src/data/cave/rootIds.ts'
import { anchorMerge, openAnchorVolume } from '../src/packs/seam/mergeAnchors.ts'
import { FENCE_REFUSED, SANDBOX, fenceWrites } from '../src/test/sandboxWrites.ts'
import { AEDES_DEPLOYMENT, probeArgs, probeReport, requireCaveToken } from './lib/browserProbe.mjs'

// First, before anything can send: one merge and one undo, on the sandbox table, and no more.
const written = fenceWrites({ merge: 1, undo: 1 })

const args = probeArgs()
const options = { deployment: AEDES_DEPLOYMENT, token: requireCaveToken() }
const report = probeReport()

const pairArg = args.value('--pair')
const asked = args.value('--i-asked')
const [neuronRoot, candidateRoot, ...extra] = pairArg?.split(',') ?? []
// An empty part is refused, not read as 0 (`Number('')`), which would look for the pair at the origin.
const contactNm = (args.value('--contact')?.split(',') ?? []).map((part) =>
  part.trim() === '' ? Number.NaN : Number(part),
)
if (
  !isNodeId(neuronRoot ?? '') ||
  !isNodeId(candidateRoot ?? '') ||
  extra.length > 0 ||
  neuronRoot === candidateRoot ||
  contactNm.length !== 3 ||
  !contactNm.every(Number.isFinite)
) {
  console.error(
    'Usage: --pair NEURON,CANDIDATE --contact X,Y,Z [--i-asked NEURON,CANDIDATE]\n' +
      'Two different root ids, and a contact in nanometres.',
  )
  process.exit(2)
}
if (asked !== undefined && asked !== pairArg) {
  console.error(`--i-asked ${asked} is not the pair ${pairArg}; nothing was sent.`)
  process.exit(2)
}

/**
 * A merge that may stand in the sandbox: what any ending must say out loud, with what it takes to
 * undo it by hand. Set **before** the merge is sent (`maybe`), since from then on a failure of any
 * kind — a lost reply, a read that throws — may leave one; made definite when the roots or the
 * reply show it; cleared only when the roots show the pieces apart after an undo, or a refusal
 * shows nothing was written.
 */
let standing

async function main() {
  const at = Date.now()
  const volume = await openAnchorVolume(SANDBOX.datastack, at, options)
  const { graphene } = volume
  // The datastack record decides the table; it has to be the sandbox's, or nothing goes further.
  if (graphene.server !== SANDBOX.server || graphene.table !== SANDBOX.table) {
    throw new Error(`${SANDBOX.datastack} resolved to ${graphene.base}, not the sandbox table.`)
  }
  console.log(`${SANDBOX.datastack}: ${graphene.server}, table ${graphene.table}\n`)

  /** Whether each root is current, at the server's now. */
  const latestNow = (roots) => isLatestRoots(graphene, roots, 'server', options)
  /** Level-2 chunks per root, in the order given. */
  const sizesOf = async (roots) => {
    const sizes = await l2ChunkCounts(graphene, roots, options)
    return roots.map((root) => sizes.get(root))
  }

  // Pre-flight: permission, current roots, sizes, anchors, and the anchors' roots asked again.
  const permission = await editPermission(graphene, options)
  report.check(
    permission.mayEdit,
    `this token may edit ${permission.dataset}` +
      (permission.termsPending ? ' (no: its terms of service are not accepted)' : ''),
  )
  const latest = await latestNow([neuronRoot, candidateRoot])
  report.check(latest[0] && latest[1], `both roots are current (${latest.join(', ')})`)
  const sizesBefore = await sizesOf([neuronRoot, candidateRoot])
  const anchors = await anchorMerge(
    volume,
    { neuronRoot, candidateRoot, contactNm, minDistUm: 0 },
    options,
  )
  if (!anchors.ok) {
    report.check(false, `anchored: ${anchors.reason} — ${anchors.message}`)
    return
  }
  const { neuron, candidate } = anchors
  /** The two anchor supervoxels' roots, at the server's now. */
  const anchorRoots = async () => {
    const ids = BigUint64Array.from([neuron.supervoxel, candidate.supervoxel], BigInt)
    return [...(await rootsAtInstant(graphene, 'server', ids, options))].map(String)
  }
  const before = await anchorRoots()
  report.check(
    before[0] === neuronRoot && before[1] === candidateRoot,
    `supervoxels ${neuron.supervoxel} / ${candidate.supervoxel} belong to the pair now`,
  )
  console.log(
    `\nsizes ${sizesBefore.join(' / ')} level-2 chunks` +
      `\nwould merge ${neuron.supervoxel} @ ${neuron.positionNm.join(', ')} nm` +
      `\n      with ${candidate.supervoxel} @ ${candidate.positionNm.join(', ')} nm`,
  )
  if (report.failures > 0) {
    console.log('\nThe pre-flight failed; nothing was sent.')
    return
  }
  if (asked === undefined) {
    console.log('\nPre-flight only (no --i-asked); nothing was sent.')
    return
  }

  /**
   * After a write that did not come back `done`: whether the pieces are together now. A refusal —
   * the server's, or the fence's before sending — wrote nothing. An `unknown` may have happened,
   * and may still: a merge the client stopped waiting for can land after this read.
   */
  const together = async (what, outcome) => {
    if (outcome.kind === 'unknown' && outcome.message.includes(FENCE_REFUSED)) {
      console.log(`${what} was refused by the fence before sending; nothing was sent.`)
    }
    const now = await anchorRoots()
    const joined = now[0] === now[1] && now[0] !== '0'
    console.log(`roots now: ${now.join(' / ')} — the pieces are ${joined ? 'MERGED' : 'apart'}`)
    return joined ? now[0] : undefined
  }

  // The merge.
  standing = { maybe: true, root: `of ${neuronRoot} and ${candidateRoot}`, operation: 'not known' }
  const merged = await mergeSupervoxels(confirmMerge(graphene, neuron, candidate), options)
  console.log(`\nmerge: ${JSON.stringify(merged)}`)
  if (merged.kind !== 'done') {
    const root = await together('The merge', merged)
    if (root) standing = { root, operation: 'not known — the merge did not answer' }
    else if (merged.kind === 'refused' || merged.message.includes(FENCE_REFUSED)) standing = undefined
    // Otherwise still `maybe`: apart now, and it may yet land.
    report.check(false, `the merge was done (it was ${merged.kind}); no undo was sent`)
    return
  }
  const [newRoot] = merged.newRootIds
  standing = { root: newRoot, operation: merged.operationId }

  // The checks, caught: whatever they find or throw, the undo below is sent.
  try {
    const joined = await anchorRoots()
    report.check(
      joined[0] === newRoot && joined[1] === newRoot,
      `both supervoxels belong to the reply's new root ${newRoot} (${joined.join(' / ')})`,
    )
    const old = await latestNow([neuronRoot, candidateRoot])
    report.check(!old[0] && !old[1], `neither old root is current any more (${old.join(', ')})`)
  } catch (error) {
    report.check(false, `the checks after the merge ran (${error.message})`)
  }

  // The undo.
  const undone = await undoMerge(merged, options)
  console.log(`\nundo: ${JSON.stringify(undone)}`)
  if (undone.kind !== 'done') {
    const root = await together('The undo', undone)
    if (!root) standing = undefined
    report.check(false, `the undo was done (it was ${undone.kind})`)
    return
  }
  // Cleared only once the roots show the pieces apart, not on the undo's word — which, until then,
  // makes the merge one that may stand rather than one that does.
  standing = { ...standing, maybe: true }
  const apart = await anchorRoots()
  if (apart[0] !== apart[1] && !apart.includes('0')) standing = undefined
  report.check(
    standing === undefined && apart.every((root) => undone.newRootIds.includes(root)),
    `the supervoxels are apart, in the undo's own new roots (${apart.join(' / ')})`,
  )
  const [mergedNow] = await latestNow([newRoot])
  report.check(!mergedNow, `the merged root ${newRoot} is no longer current`)
  const sizesAfter = await sizesOf(apart)
  report.check(
    sizesAfter.every((size, i) => size !== undefined && size === sizesBefore[i]),
    `each piece is its old size again (${sizesAfter.join(' / ')} level-2 chunks, ` +
      `was ${sizesBefore.join(' / ')})`,
  )
  console.log(
    `\nbefore: ${neuronRoot} / ${candidateRoot}` +
      `\nafter:  ${apart.join(' / ')}` +
      (apart[0] === neuronRoot && apart[1] === candidateRoot
        ? ' (the old ids came back)'
        : ' (new ids: an undo makes new roots, it does not revive the old ones)'),
  )
  console.log(`\n${written()} write(s) sent.`)
}

try {
  await main()
} catch (error) {
  console.error(
    `\nStopped: ${error instanceof CaveError ? `${error.message} (${error.status})` : error.stack}`,
  )
  console.error(`${written()} write(s) had been sent.`)
  process.exitCode = 1
} finally {
  if (standing) {
    console.error(
      `\nA MERGE ${standing.maybe ? 'MAY BE' : 'IS'} STANDING in ${SANDBOX.datastack}: root ` +
        `${standing.root}, operation ${standing.operation}. It was not undone` +
        (standing.maybe ? ', and the pair\'s roots must be read again to know.' : '.') +
        ' Undo it by hand (caveclient `chunkedgraph.undo_operation`) once the user has agreed.',
    )
    process.exitCode = 1
  }
}
// Last: `finish` exits, and nothing above may be cut short — above all the standing-merge warning.
report.finish()
