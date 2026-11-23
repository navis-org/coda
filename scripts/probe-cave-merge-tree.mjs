/**
 * The live test of a batch that merges **from the tips in, side by side** (`docs/seam-merge-plan.md`,
 * "Merging a tree from its tips"), on the CAVE sandbox only. **This script writes** — three merges
 * and their three undos — and is run only after the user has approved it, every time.
 *
 *   pnpm probe:cave-merge-tree -- --tree N,A,B,C --contacts "na;ab;nc"                    # reads
 *   pnpm probe:cave-merge-tree -- --tree N,A,B,C --contacts "na;ab;nc" --i-asked N,A,B,C  # writes
 *
 * `N`, `A`, `B`, `C` are four current roots on `fanc_sandbox`: `A` and `C` touch `N`, `B` touches
 * `A` (each contact `x,y,z` in absolute nm). `pnpm probe:sandbox-pair -- --tree` finds some.
 * `--i-asked` must repeat the tree, so a command recalled from history with another one stops
 * before writing.
 *
 * ## What it is a test of
 *
 * A neuron grown piece by piece: `A` and `C` accepted on tips of `N`, `B` on a tip of `A`. It runs
 * **the shipped pre-flight and the shipped batch**, twice, as two Submits:
 *
 *  1. The batch is stopped after its first round. **B onto A and C onto N go out together** — on
 *     roots nothing else uses — and A, whose root B's merge holds, waits. So the stop leaves B
 *     joined to A short of the neuron, and C in it.
 *  2. The next plan, from that record, reads A and B as one piece at their root (`joined`,
 *     `pieceRoot`), and its batch takes them into the neuron in one merge.
 *
 * Then it undoes all three, last first, and checks the four pieces are apart again.
 *
 * Held to the sandbox as `probe-cave-merge.mjs` is: the datastack is a constant and must resolve
 * to the sandbox table; `fenceWrites` refuses, at `fetch`, any write that is not a merge or undo
 * on that table, and any fourth of either.
 */

import { CaveError } from '../src/data/cave/client.ts'
import { mergeSupervoxels, undoEdit } from '../src/data/cave/edits.ts'
import { isNodeId } from '../src/data/cave/graphLayout.ts'
import { isLatestRoots, l2ChunkCounts, supervoxelRoots } from '../src/data/cave/rootIds.ts'
import { READ_TIMEOUT_MS } from '../src/data/cave/editWaits.ts'
import { prepareMerges } from '../src/packs/seam/mergeBatch.ts'
import { planMerges } from '../src/packs/seam/mergePlan.ts'
import { mergedSoFar } from '../src/packs/seam/mergeRecord.ts'
import { verdictKey } from '../src/packs/seam/pieces.ts'
import { FENCE_REFUSED, SANDBOX, fenceWrites } from '../src/test/sandboxWrites.ts'
import { AEDES_DEPLOYMENT, probeArgs, probeReport, requireCaveToken } from './lib/browserProbe.mjs'

// First, before anything can send: three merges and three undos, on the sandbox table, no more.
const written = fenceWrites({ merge: 3, undo: 3 })

const args = probeArgs()
const options = { deployment: AEDES_DEPLOYMENT, token: requireCaveToken() }
const report = probeReport()

const treeArg = args.value('--tree')
const asked = args.value('--i-asked')
const tree = treeArg?.split(',') ?? []
const number = (part) => (part.trim() === '' ? Number.NaN : Number(part))
const contacts = (args.value('--contacts')?.split(';') ?? []).map((one) => one.split(',').map(number))
if (
  tree.length !== 4 ||
  !tree.every(isNodeId) ||
  new Set(tree).size !== 4 ||
  contacts.length !== 3 ||
  !contacts.every((nm) => nm.length === 3 && nm.every(Number.isFinite))
) {
  console.error(
    'Usage: --tree NEURON,A,B,C --contacts "NA;AB;NC" [--i-asked NEURON,A,B,C]\n' +
      'Four different root ids: A and C touch the neuron, B touches A; each contact X,Y,Z in nm.',
  )
  process.exit(2)
}
if (asked !== undefined && asked !== treeArg) {
  console.error(`--i-asked ${asked} is not the tree ${treeArg}; nothing was sent.`)
  process.exit(2)
}
const [N, A, B, C] = tree

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
  // The queue a reader would have: A and C accepted on tips of N, B on a tip of A.
  const request = (record) => ({
    datastack: SANDBOX.datastack,
    queue: [
      tip(N, 0, candidate(A, contacts[0])),
      tip(A, 0, candidate(B, contacts[1])),
      tip(N, 1, candidate(C, contacts[2])),
    ],
    reviewedRoot: N,
    verdicts: new Map([
      [verdictKey(N, A), 'accept'],
      [verdictKey(A, B), 'accept'],
      [verdictKey(N, C), 'accept'],
    ]),
    record,
  })
  const plan = await planMerges(request([]), options)
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

  // ── The first plan: A, C, then B; B's end on A ──────────────────────────────────────────────
  for (const refused of plan.rejected) {
    console.log(`refused ${refused.candidateRoot}: ${refused.reason} — ${refused.message}`)
  }
  const order = plan.merges.map((m) => m.candidateRoot).join()
  report.check(order === `${A},${C},${B}`, `the plan lists A, C, then B (${order || 'nothing'})`)
  if (plan.merges.length !== 3) return
  const byRoot = new Map(plan.merges.map((m) => [m.candidateRoot, m]))
  report.check(
    byRoot.get(B).parent === A && byRoot.get(B).needs === A,
    `B is made onto A (parent ${byRoot.get(B).parent}, needs ${byRoot.get(B).needs})`,
  )
  // Every supervoxel a merge names, in plan order, neuron end first.
  const ends = plan.merges.flatMap((m) => [m.neuron.supervoxel, m.candidate.supervoxel])
  const before = await rootsNow(ends)
  report.check(
    before.join() === [N, A, N, C, A, B].join(),
    `the six supervoxels belong to N A / N C / A B now (${before.join(' / ')})`,
  )
  const sizesBefore = await sizesOf(tree)
  console.log(`\nsizes N ${sizesBefore.join(' / ')} level-2 chunks (N, A, B, C)`)
  for (const merge of plan.merges) {
    console.log(
      `would merge ${merge.candidateRoot}: ${merge.neuron.supervoxel} @ ${merge.neuron.positionNm.join(', ')} nm` +
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

  // ── The shipped batch, with the shipped writer, its answers kept for the undos ──────────────
  const done = []
  let out = 0
  let most = 0
  const services = {
    roots: (_on, supervoxels) => rootsNow(supervoxels),
    send: async (merge) => {
      standing.unshift({ maybe: true, what: `a merge onto ${N}'s tree`, operation: 'not known' })
      const slot = standing[0]
      most = Math.max(most, ++out)
      try {
        const outcome = await mergeSupervoxels(merge, options)
        const at = standing.indexOf(slot)
        if (outcome.kind === 'done') {
          done.push(outcome)
          standing[at] = { root: outcome.newRootIds[0], operation: outcome.operationId }
        } else if (outcome.kind === 'refused' || outcome.message.includes(FENCE_REFUSED)) {
          // The server's refusal, or the fence's before sending: nothing was written.
          standing.splice(at, 1)
        }
        return outcome
      } finally {
        out -= 1
      }
    },
  }
  const record = []
  const runBatch = async (made, stopAfterFirstRound) => {
    let passes = 0
    const result = await prepareMerges(made, made.merges, options, services).run({
      progress: () => {},
      record: (entry) => record.push(entry),
      // Asked once a pass: the first starts the round, the second stops what is left.
      stopRequested: () => stopAfterFirstRound && passes++ >= 1,
      stillOut: () => {},
    })
    console.log(`\nbatch: ${JSON.stringify(result)}`)
    return result
  }
  const said = (entries) =>
    entries
      .map(
        (e) =>
          `  ${e.candidateRoot}: ${e.outcome} onto ${e.neuronRoot}` +
          (e.candidateRootAt ? ` (piece at ${e.candidateRootAt})` : '') +
          (e.outcome === 'merged' ? ` → ${e.newRoot} (operation ${e.operationId})` : '') +
          (e.message ? ` — ${e.message}` : ''),
      )
      .join('\n')

  // The checks, caught: whatever they find or throw, the undos below are sent.
  try {
    // ── Submit 1, stopped after its first round ─────────────────────────────────────────────
    const first = await runBatch(plan, true)
    console.log(said(record))
    const outcome = Object.fromEntries(record.map((e) => [e.candidateRoot, e]))
    report.check(most === 2, `two merges were out at once (most ${most})`)
    report.check(first.state === 'stopped', `the batch stopped (${first.state})`)
    report.check(
      record.length === 2 && outcome[B]?.outcome === 'merged' && outcome[C]?.outcome === 'merged',
      'B and C were merged in the first round, and nothing else',
    )
    report.check(outcome[B]?.neuronRoot === A, `B was checked against A's root (${outcome[B]?.neuronRoot})`)
    const G = outcome[B]?.newRoot
    const N1 = outcome[C]?.newRoot
    report.check(first.currentRoot === N1, `the neuron is at C's merge's root ${N1}`)
    const so = mergedSoFar(record, N, { deployment: options.deployment, datastack: SANDBOX.datastack })
    report.check(
      so.currentRoot === N1 && so.joined.get(A) === G && so.joined.get(B) === G && so.pieces.has(C),
      `the record reads A and B joined at ${G}, C in the neuron at ${N1}`,
    )
    const mid = await rootsNow(ends)
    report.check(
      mid.join() === [N1, G, N1, N1, G, G].join(),
      `the server agrees: N and C under ${N1}, A and B under ${G} (${mid.join(' / ')})`,
    )

    // ── Submit 2, from that record ──────────────────────────────────────────────────────────
    const again = await planMerges(request([...record]), options)
    if (!again.ok) throw new Error(`the second plan was not made (${again.message})`)
    const reasons = Object.fromEntries(again.rejected.map((r) => [r.candidateRoot, r.reason]))
    console.log(
      `\nsecond plan: merges ${again.merges.map((m) => `${m.candidateRoot} at ${m.pieceRoot ?? 'its own root'}`).join(', ')}; ` +
        `refused ${again.rejected.map((r) => `${r.candidateRoot} (${r.reason})`).join(', ')}`,
    )
    report.check(
      again.merges.length === 1 && again.merges[0].candidateRoot === A && again.merges[0].pieceRoot === G,
      `it merges A alone, at A and B's root ${G}`,
    )
    report.check(
      reasons[B] === 'joined' && reasons[C] === 'already-merged',
      `B is joined already, C merged already (${reasons[B]}, ${reasons[C]})`,
    )
    const from = record.length
    const second = await runBatch(again, false)
    console.log(said(record.slice(from)))
    const last = record[from]
    report.check(
      second.state === 'done' && last?.outcome === 'merged' && last.candidateRootAt === G,
      `A went in with B, checked at ${G}`,
    )
    const joined = await rootsNow(ends)
    report.check(
      new Set(joined).size === 1 && joined[0] === second.currentRoot,
      `all six supervoxels are under the neuron's last root ${second.currentRoot} (${[...new Set(joined)].join(' / ')})`,
    )
    const old = await latestNow(tree)
    report.check(old.every((current) => !current), `none of the four old roots is current (${old.join(', ')})`)
  } catch (error) {
    report.check(false, `the checks after the batches ran (${error.message})`)
  }

  // ── The undos, last made first ───────────────────────────────────────────────────────────────
  // A merge whose outcome is not known may be standing on top of an earlier one, and has no
  // operation to undo it by: nothing is undone from under it. All stay, said below.
  const unknown = standing.some((one) => one.operation === 'not known')
  if (unknown) report.check(false, 'every merge has a known outcome, so the undos can be sent')
  for (const merged of unknown ? [] : [...done].reverse()) {
    const undone = await undoEdit(merged, options)
    console.log(`undo of operation ${merged.operationId}: ${JSON.stringify(undone)}`)
    const at = standing.findIndex((one) => one.operation === merged.operationId)
    if (undone.kind !== 'done') {
      report.check(false, `the undo of operation ${merged.operationId} was done (it was ${undone.kind})`)
      if (at >= 0 && undone.kind !== 'refused') standing[at] = { ...standing[at], maybe: true }
      break
    }
    // Sent and answered: cleared below, once the roots show the pieces apart — not on its word.
    if (at >= 0) standing[at] = { ...standing[at], maybe: true, undone: true }
  }
  // Plan order: N A / N C / A B — the neuron's two ends one root, A's two ends another.
  const apart = await rootsNow(ends)
  const [n1, a1, n2, c1, a2, b1] = apart
  const areApart =
    n1 === n2 && a1 === a2 && new Set([n1, a1, b1, c1]).size === 4 && !apart.includes('0')
  if (areApart) {
    for (let i = standing.length - 1; i >= 0; i--) if (standing[i].undone) standing.splice(i, 1)
  }
  report.check(
    areApart && standing.length === 0,
    `the four pieces are apart again (${apart.join(' / ')})`,
  )
  const sizesAfter = await sizesOf([n1, a1, b1, c1])
  report.check(
    sizesAfter.every((size, i) => size !== undefined && size === sizesBefore[i]),
    `each piece is its old size again (${sizesAfter.join(' / ')} level-2 chunks, was ${sizesBefore.join(' / ')})`,
  )
  console.log(`\nbefore: ${tree.join(' / ')}\nafter:  ${[n1, a1, b1, c1].join(' / ')}`)
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
