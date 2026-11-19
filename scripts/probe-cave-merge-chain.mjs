/**
 * The live test of a merge **made onto a piece that is merged first**, on the CAVE sandbox only
 * (`docs/seam-extend-plan.md`, phase 6). **This script writes** — two merges and their two undos —
 * and is run only after the user has approved the exact chain, every time.
 *
 *   pnpm probe:cave-merge-chain -- --chain N,A,B --contacts "x,y,z;x,y,z"                  # reads
 *   pnpm probe:cave-merge-chain -- --chain N,A,B --contacts "x,y,z;x,y,z" --i-asked N,A,B  # writes
 *
 * `N`, `A` and `B` are three current root ids on `fanc_sandbox`: `A` touches `N` at the first
 * contact and `B` touches `A` at the second (absolute nm). `pnpm probe:sandbox-pair -- --chain`
 * finds some. `--i-asked` must repeat the chain, so a command recalled from history with another
 * one stops before writing.
 *
 * ## What it is a test of
 *
 * A neuron grown piece by piece: `A` accepted on a tip of `N`, `B` on a tip of `A`, nothing
 * merged before Submit. It runs **the shipped pre-flight and the shipped batch** — `planMerges`
 * over a queue that says exactly that, then `prepareMerges(...).run` — so what is checked on a
 * real chunkedgraph is the code a reader's Submit runs:
 *
 *  - the plan lists `A` before `B`, and `B`'s neuron end is a supervoxel of **`A`**, not of `N`;
 *  - the batch merges `A`, then finds that end under the root that merge made and merges `B`;
 *  - the record says which piece `B` was accepted on.
 *
 * Then it undoes both, last first, and checks the three pieces are apart again.
 *
 * Held to the sandbox as `probe-cave-merge.mjs` is: the datastack is a constant and must resolve
 * to the sandbox table; `fenceWrites` refuses, at `fetch`, any write that is not a merge or undo
 * on that table, and any third of either; the batch sends only what `confirmMerge` was given.
 */

import { CaveError } from '../src/data/cave/client.ts'
import { mergeSupervoxels, undoMerge } from '../src/data/cave/edits.ts'
import { isNodeId } from '../src/data/cave/graphLayout.ts'
import { isLatestRoots, l2ChunkCounts, supervoxelRoots } from '../src/data/cave/rootIds.ts'
import { READ_TIMEOUT_MS, prepareMerges } from '../src/packs/seam/mergeBatch.ts'
import { planMerges } from '../src/packs/seam/mergePlan.ts'
import { verdictKey } from '../src/packs/seam/pieces.ts'
import { FENCE_REFUSED, SANDBOX, fenceWrites } from '../src/test/sandboxWrites.ts'
import { AEDES_DEPLOYMENT, probeArgs, probeReport, requireCaveToken } from './lib/browserProbe.mjs'

// First, before anything can send: two merges and two undos, on the sandbox table, and no more.
const written = fenceWrites({ merge: 2, undo: 2 })

const args = probeArgs()
const options = { deployment: AEDES_DEPLOYMENT, token: requireCaveToken() }
const report = probeReport()

const chainArg = args.value('--chain')
const asked = args.value('--i-asked')
const chain = chainArg?.split(',') ?? []
const number = (part) => (part.trim() === '' ? Number.NaN : Number(part))
const contacts = (args.value('--contacts')?.split(';') ?? []).map((one) => one.split(',').map(number))
if (
  chain.length !== 3 ||
  !chain.every(isNodeId) ||
  new Set(chain).size !== 3 ||
  contacts.length !== 2 ||
  !contacts.every((nm) => nm.length === 3 && nm.every(Number.isFinite))
) {
  console.error(
    'Usage: --chain NEURON,PIECE,BEYOND --contacts "X,Y,Z;X,Y,Z" [--i-asked NEURON,PIECE,BEYOND]\n' +
      'Three different root ids, and where the second touches the first and the third the second (nm).',
  )
  process.exit(2)
}
if (asked !== undefined && asked !== chainArg) {
  console.error(`--i-asked ${asked} is not the chain ${chainArg}; nothing was sent.`)
  process.exit(2)
}
const [N, A, B] = chain

/** A merge that may stand in the sandbox, last made first: what any ending must say out loud. */
const standing = []

/** A candidate as the review queue holds one, with nothing in it but what the plan reads. */
const candidate = (candidateId, contactNm) => ({
  candidateId,
  rank: 1,
  geoRank: undefined,
  volumeUm3: undefined,
  l2Chunks: undefined,
  minDistUm: 0,
  contactNm,
  pCand: undefined,
  conf: undefined,
  shown: true,
})
/** A tip on `root`, of the neuron `N`, listing one candidate. */
const tip = (root, endUid, listed) => ({
  endUid,
  neuronId: root,
  seed: N,
  junction: false,
  search: 'done',
  kind: 'tip',
  tipNm: listed.contactNm,
  r: undefined,
  q: undefined,
  pTip: undefined,
  shown: true,
  candidates: [listed],
})

async function main() {
  // The queue a reader would have: A accepted on a tip of N, B on a tip of A.
  const request = {
    datastack: SANDBOX.datastack,
    queue: [tip(N, 0, candidate(A, contacts[0])), tip(A, 0, candidate(B, contacts[1]))],
    reviewedRoot: N,
    verdicts: new Map([
      [verdictKey(N, A), 'accept'],
      [verdictKey(A, B), 'accept'],
    ]),
    record: [],
  }
  const plan = await planMerges(request, options)
  if (!plan.ok) {
    report.check(false, `the plan was made (${plan.message})`)
    return
  }
  const { graphene } = plan
  // The datastack record decides the table; it has to be the sandbox's, or nothing goes further.
  if (graphene.server !== SANDBOX.server || graphene.table !== SANDBOX.table) {
    throw new Error(`${SANDBOX.datastack} resolved to ${graphene.base}, not the sandbox table.`)
  }
  console.log(`${SANDBOX.datastack}: ${graphene.server}, table ${graphene.table}\n`)

  // With the batch's own time limit: a read that hangs must not keep the endings from being said.
  const rootsNow = (supervoxels) =>
    supervoxelRoots(graphene, supervoxels, 'server', {
      ...options,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })
  const latestNow = (roots) => isLatestRoots(graphene, roots, 'server', options)
  const sizesOf = async (roots) => {
    const sizes = await l2ChunkCounts(graphene, roots, options)
    return roots.map((root) => sizes.get(root))
  }

  // ── The plan: A then B, and B's neuron end on A ─────────────────────────────────────────────
  for (const refused of plan.rejected) {
    console.log(`refused ${refused.candidateRoot}: ${refused.reason} — ${refused.message}`)
  }
  report.check(
    plan.merges.map((m) => m.candidateRoot).join() === `${A},${B}`,
    `the plan merges the piece, then the piece beyond it (${plan.merges.map((m) => m.candidateRoot).join(', ') || 'nothing'})`,
  )
  if (plan.merges.length !== 2) return
  const [first, second] = plan.merges
  report.check(
    first.parent === undefined && first.needs === undefined,
    'the first is made onto the neuron as it stands',
  )
  report.check(
    second.parent === A && second.needs === A,
    `the second is made onto the first piece (parent ${second.parent}, needs ${second.needs})`,
  )
  const ends = [first.neuron, first.candidate, second.neuron, second.candidate].map(
    (end) => end.supervoxel,
  )
  const before = await rootsNow(ends)
  report.check(
    before.join() === [N, A, A, B].join(),
    `the four supervoxels belong to ${N} / ${A} / ${A} / ${B} now (${before.join(' / ')})`,
  )
  const sizesBefore = await sizesOf(chain)
  console.log(`\nsizes ${sizesBefore.join(' / ')} level-2 chunks`)
  for (const merge of plan.merges) {
    console.log(
      `would merge ${merge.neuron.supervoxel} @ ${merge.neuron.positionNm.join(', ')} nm` +
        `\n      with ${merge.candidate.supervoxel} @ ${merge.candidate.positionNm.join(', ')} nm`,
    )
  }
  if (report.failures > 0) {
    console.log('\nThe pre-flight failed; nothing was sent.')
    return
  }
  if (asked === undefined) {
    console.log('\nPre-flight only (no --i-asked); nothing was sent.')
    return
  }

  // ── The batch: the shipped one, with the shipped writer, its answers kept for the undo ──────
  const done = []
  const batch = prepareMerges(plan, plan.merges, options, {
    roots: (_on, supervoxels) => rootsNow(supervoxels),
    send: async (merge) => {
      standing.unshift({ maybe: true, what: `a merge onto ${N}'s tree`, operation: 'not known' })
      const outcome = await mergeSupervoxels(merge, options)
      if (outcome.kind === 'done') {
        done.push(outcome)
        standing[0] = { root: outcome.newRootIds[0], operation: outcome.operationId }
      } else if (outcome.kind === 'refused' || outcome.message.includes(FENCE_REFUSED)) {
        // The server's refusal, or the fence's before sending: nothing was written.
        standing.shift()
      }
      return outcome
    },
  })
  const record = []
  const result = await batch.run({
    progress: () => {},
    record: (entry) => record.push(entry),
    stopRequested: () => false,
    stillOut: () => {},
  })
  console.log(`\nbatch: ${JSON.stringify(result)}`)
  for (const entry of record) {
    console.log(
      `  ${entry.candidateRoot}: ${entry.outcome}` +
        (entry.outcome === 'merged' ? ` → ${entry.newRoot} (operation ${entry.operationId})` : '') +
        (entry.message ? ` — ${entry.message}` : ''),
    )
  }

  // The checks, caught: whatever they find or throw, the undos below are sent.
  try {
    report.check(
      record.map((e) => `${e.candidateRoot}:${e.outcome}`).join() === `${A}:merged,${B}:merged`,
      'both merges were made, the piece first',
    )
    report.check(
      record[1]?.neuronRoot === (record[0]?.outcome === 'merged' ? record[0].newRoot : undefined),
      'the second was checked against the root the first made',
    )
    report.check(
      record[0]?.parentRoot === undefined && record[1]?.parentRoot === A,
      `the record says the second was accepted on the first piece (${record[1]?.parentRoot})`,
    )
    const joined = await rootsNow(ends)
    report.check(
      new Set(joined).size === 1 && joined[0] === result.currentRoot,
      `all four supervoxels are under the batch's last root ${result.currentRoot} (${[...new Set(joined)].join(' / ')})`,
    )
    const old = await latestNow(chain)
    report.check(old.every((current) => !current), `none of the three old roots is current (${old.join(', ')})`)
  } catch (error) {
    report.check(false, `the checks after the batch ran (${error.message})`)
  }

  // ── The undos, last made first ───────────────────────────────────────────────────────────────
  // A merge whose outcome is not known may be standing on top of an earlier one, and has no
  // operation to undo it by: the earlier one is not undone from under it. All stay, said below.
  const unknown = standing.some((one) => one.operation === 'not known')
  if (unknown) report.check(false, 'every merge has a known outcome, so the undos can be sent')
  for (const merged of unknown ? [] : [...done].reverse()) {
    const undone = await undoMerge(merged, options)
    console.log(`undo of operation ${merged.operationId}: ${JSON.stringify(undone)}`)
    const at = standing.findIndex((one) => one.operation === merged.operationId)
    if (undone.kind !== 'done') {
      report.check(false, `the undo of operation ${merged.operationId} was done (it was ${undone.kind})`)
      // A refusal undid nothing; anything else may have. The earlier merge is not undone past
      // one that may still stand, so the rest stay as they are: standing.
      if (at >= 0 && undone.kind !== 'refused') standing[at] = { ...standing[at], maybe: true }
      break
    }
    // Sent and answered: cleared below, once the roots show the pieces apart — not on its word.
    if (at >= 0) standing[at] = { ...standing[at], maybe: true, undone: true }
  }
  const apart = await rootsNow(ends)
  const three = new Set(apart)
  const areApart = three.size === 3 && apart[1] === apart[2] && !apart.includes('0')
  /*
   * Only what was undone is cleared, and only on the roots' word. A merge whose reply was lost
   * has no undo and may still land after this read, so it stays "may be standing" whatever the
   * roots show now.
   */
  if (areApart) {
    for (let i = standing.length - 1; i >= 0; i--) if (standing[i].undone) standing.splice(i, 1)
  }
  report.check(
    areApart && standing.length === 0,
    `the pieces are apart again, the middle one whole (${apart.join(' / ')})`,
  )
  const sizesAfter = await sizesOf([apart[0], apart[1], apart[3]])
  report.check(
    sizesAfter.every((size, i) => size !== undefined && size === sizesBefore[i]),
    `each piece is its old size again (${sizesAfter.join(' / ')} level-2 chunks, was ${sizesBefore.join(' / ')})`,
  )
  console.log(`\nbefore: ${chain.join(' / ')}\nafter:  ${apart[0]} / ${apart[1]} / ${apart[3]}`)
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
  for (const one of standing) {
    console.error(
      `\nA MERGE ${one.maybe ? 'MAY BE' : 'IS'} STANDING in ${SANDBOX.datastack}: ` +
        `${one.root ? `root ${one.root}` : one.what}, operation ${one.operation}. It was not undone` +
        (one.maybe ? ', and the roots must be read again to know.' : '.') +
        ' Undo it by hand (caveclient `chunkedgraph.undo_operation`) once the user has agreed.',
    )
    process.exitCode = 1
  }
}
// Last: `finish` exits, and nothing above may be cut short — above all the standing-merge warning.
report.finish()
