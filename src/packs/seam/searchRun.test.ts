/**
 * The sequence, over fakes.
 *
 * `assessorRun.test.ts`' arrangement and for its reason: the steps are injected, so what is
 * testable here is the **order** they run in and what is carried between them — which is where
 * this stage's failures live, and all of them are quiet. The arithmetic belongs to
 * `treeRanker.test.ts` and `rankPool.test.ts`; the agreement with SEAM's published lists to
 * `pnpm probe:candidate-search`, which drives this same function against a real end.
 */

import { describe, expect, it, vi } from 'vitest'

import type {
  CandidatePool,
  CandidatePoolRequest,
  PoolSizes,
  PoolSizesRequest,
} from '../../pyodide/cutoutSummary'
import { countsInPoolOrder, searchEnds } from './searchRun'
import type { SearchedEnd } from './searchRun'
import type { SearchSteps } from './searchRun'
import { parseTreeRanker } from './treeRanker'

/** A forest that ranks on `x` alone: above the split scores 100, so **high `x` ranks first**. */
const RANKER = parseTreeRanker(
  [
    'tree',
    'version=v4',
    'num_class=1',
    'num_tree_per_iteration=1',
    'max_feature_idx=2',
    'objective=lambdarank',
    '',
    'Tree=0',
    'num_leaves=2',
    'split_feature=0',
    'threshold=10',
    'decision_type=2',
    'left_child=-1',
    'right_child=-2',
    'leaf_value=0 100',
    '',
  ].join('\n'),
  ['x', 'l2c', 'l2x'],
)

/** Two tips 10 µm apart, so a contact can plainly belong to one or the other. */
const TIPS = Float32Array.from([0, 0, 0, 10_000, 0, 0])

const endAt = (tip: number, queryRoot: bigint) => ({
  tip,
  queryRoot,
  box: async () => boxFor(queryRoot),
})

const boxFor = (queryRoot: bigint): CandidatePoolRequest =>
  ({
    labels: new BigUint64Array(0),
    index: new Uint16Array(0),
    size: [1, 1, 1],
    roots: new BigUint64Array(0),
    queryRoot,
    resolutionNm: [32, 32, 45],
    loVoxels: [0, 0, 0],
    endNm: [0, 0, 0],
  }) as unknown as CandidatePoolRequest

/**
 * A pool of `x` values, with each candidate's contact placed at `contactNm` so the own-tip rule
 * has something real to decide about.
 */
const poolOf = (x: readonly number[], contacts: readonly number[][]): CandidatePool => ({
  rows: x.length,
  missingQuery: false,
  candRoot: BigUint64Array.from(x.map((_, i) => 648518347608843326n + BigInt(i))),
  columns: {
    x: Float64Array.from(x),
    contact_x_nm: Float64Array.from(contacts.map((c) => c[0]!)),
    contact_y_nm: Float64Array.from(contacts.map((c) => c[1]!)),
    contact_z_nm: Float64Array.from(contacts.map((c) => c[2]!)),
  },
  ms: 1,
})

const stepsFor = (
  pools: readonly CandidatePool[],
  counts: Map<string, number>,
): SearchSteps => ({
  measure: vi.fn(async (request: CandidatePoolRequest) => {
    const at = Number(request.queryRoot - 1n)
    return pools[at]!
  }),
  sizes: vi.fn(async (request: PoolSizesRequest): Promise<PoolSizes> => ({
    l2c: Float64Array.from(request.candCount, (c) => Math.log10(Math.max(c, 1))),
    l2x: Float64Array.from(request.candCount, () => 1),
  })),
  counts: vi.fn(async () => counts),
})

/** Everything the generator yields, in order — what the old array-returning form handed back. */
async function collect(ends: AsyncIterable<SearchedEnd>): Promise<SearchedEnd[]> {
  const out: SearchedEnd[] = []
  for await (const end of ends) out.push(end)
  return out
}

/** Every root in both pools, plus the two query roots. */
const countsFor = (pools: readonly CandidatePool[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const pool of pools) for (const root of pool.candRoot) out.set(String(root), 40)
  out.set('1', 9000)
  out.set('2', 9000)
  return out
}

describe('searchEnds', () => {
  const near = [0, 0, 0]
  const far = [9000, 0, 0]

  it('ranks, cuts and then applies the own-tip rule — in that order', async () => {
    const pool = poolOf([1, 50, 2], [near, near, near])
    const steps = stepsFor([pool], countsFor([pool]))
    const [one] = await collect(
      searchEnds(TIPS, [endAt(0, 1n)], { ranker: RANKER, topK: 2, ownUm: 2 }, steps),
    )
    // Cut to two of three by rank, and the rule keeps both. 50 is above the split so it ranks
    // first; 1 and 2 tie on the key and hold the pool's own order.
    expect(one!.pooled).toBe(3)
    expect(one!.rows).toBe(2)
    expect([...one!.columns['x']!]).toEqual([50, 1])
  })

  /**
   * The order that fails silently. The rule run *before* the cut would thin the list first and
   * the cut would then keep `top_k` of what was left — a different set, every row of it
   * believable. Here the two best by rank are both too far, so a rule-first ordering would keep
   * the near one and this would come back with a row instead of none.
   */
  it('cuts before the rule, so a cut-away candidate cannot be rescued by it', async () => {
    const pool = poolOf([50, 60, 1], [far, far, near])
    const steps = stepsFor([pool], countsFor([pool]))
    const [one] = await collect(
      searchEnds(TIPS, [endAt(0, 1n)], { ranker: RANKER, topK: 2, ownUm: 2 }, steps),
    )
    expect(one!.rows).toBe(0)
    expect(one!.tooFar).toBe(2)
  })

  it('renumbers geo_rank from one over what the rule kept', async () => {
    const pool = poolOf([1, 2, 3], [far, near, near])
    const steps = stepsFor([pool], countsFor([pool]))
    const [one] = await collect(
      searchEnds(TIPS, [endAt(0, 1n)], { ranker: RANKER, topK: 100, ownUm: 2 }, steps),
    )
    // Rank 1 was dropped, so what is left is renumbered rather than keeping 2 and 3.
    expect([...one!.columns['geo_rank']!]).toEqual([1, 2])
    expect([...one!.columns['x']!]).toEqual([2, 3])
    expect(one!.tooFar).toBe(1)
  })

  /**
   * The rule is a per-neuron pass, so a contact nearer the *other* tip is that tip's — and the
   * end it was searched at loses it. A per-end loop could not see this at all.
   */
  it('gives a contact to the tip that is nearest it, across ends', async () => {
    const mine = poolOf([1], [near])
    const theirs = poolOf([1], [near])
    const pools = [mine, theirs]
    const steps = stepsFor(pools, countsFor(pools))
    const [, second] = await collect(
      searchEnds(
        TIPS,
        [endAt(0, 1n), endAt(1, 2n)],
        { ranker: RANKER, topK: 100, ownUm: 20 },
        steps,
      ),
    )
    // Tip 1 sits 10 µm away, so its own candidate's contact at the origin is tip 0's.
    expect(second!.rows).toBe(0)
    expect(second!.anothersTip).toBe(1)
  })

  /**
   * One call per end, asking only about that end — which is what streaming costs. The batching
   * that was lost is not the saving it looks like: `l2ChunkCounts` memoises by root on the
   * node's side, so a root a neighbouring end already bought is not fetched again, and only the
   * request count rises at the margin where a batch of fifty is not full.
   */
  it('asks for each end’s counts as that end is reached, and for its query', async () => {
    const pools = [poolOf([1], [near]), poolOf([2], [near])]
    const steps = stepsFor(pools, countsFor(pools))
    await collect(
      searchEnds(
        TIPS,
        [endAt(0, 1n), endAt(1, 2n)],
        { ranker: RANKER, topK: 100, ownUm: 2 },
        steps,
      ),
    )
    expect(steps.counts).toHaveBeenCalledTimes(2)
    // Each call carries its own end's query root and not the other end's.
    const first = [...vi.mocked(steps.counts).mock.calls[0]![0]]
    const second = [...vi.mocked(steps.counts).mock.calls[1]![0]]
    expect(first).toContain('1')
    expect(first).not.toContain('2')
    expect(second).toContain('2')
    expect(second).not.toContain('1')
  })

  /**
   * The property that makes streaming honest: an end is yielded only once it is final. The rule
   * reads the *tip positions*, which are known before any box is read, so a later end cannot
   * change an earlier one — a draft that moved under the reader would be worse than no
   * streaming at all.
   */
  it('yields each end finished, before the next is measured', async () => {
    const pools = [poolOf([1], [near]), poolOf([2], [near])]
    const steps = stepsFor(pools, countsFor(pools))
    const seen: number[] = []
    for await (const end of searchEnds(
      TIPS,
      [endAt(0, 1n), endAt(1, 2n)],
      { ranker: RANKER, topK: 100, ownUm: 2 },
      steps,
    )) {
      seen.push(end.tip)
      // Only this end's box has been asked for: the next is measured after this one is yielded.
      expect(steps.measure).toHaveBeenCalledTimes(seen.length)
    }
    expect(seen).toEqual([0, 1])
  })

  it('survives a step that transfers the ids it was given', async () => {
    const pool = poolOf([1, 2], [near, near])
    const steps = stepsFor([pool], countsFor([pool]))
    const transferring: SearchSteps = {
      ...steps,
      sizes: async (request) => {
        // What the worker does to the buffer it is posted.
        structuredClone(request.candRoot, { transfer: [request.candRoot.buffer] })
        return {
          l2c: Float64Array.from({ length: 2 }, () => 1),
          l2x: Float64Array.from({ length: 2 }, () => 1),
        }
      },
    }
    const [one] = await collect(
      searchEnds(TIPS, [endAt(0, 1n)], { ranker: RANKER, topK: 100, ownUm: 2 }, transferring),
    )
    expect(one!.rows).toBe(2)
    expect([...one!.candRoot]).toHaveLength(2)
  })

  /** Not an error: a tip whose neuron does not reach its own cutout is one to look at. */
  it('answers an end whose query is missing from its box with an empty list', async () => {
    const empty: CandidatePool = {
      rows: 0,
      missingQuery: true,
      candRoot: new BigUint64Array(0),
      columns: {},
      ms: 1,
    }
    const steps = stepsFor([empty], new Map([['1', 9000]]))
    const [one] = await collect(
      searchEnds(TIPS, [endAt(0, 1n)], { ranker: RANKER, topK: 100, ownUm: 2 }, steps),
    )
    expect(one!.missingQuery).toBe(true)
    expect(one!.rows).toBe(0)
    expect(steps.sizes).not.toHaveBeenCalled()
  })
})

describe('countsInPoolOrder', () => {
  const roots = BigUint64Array.from([11n, 22n, 33n])

  it('puts the counts in the pool’s order', () => {
    const counts = new Map([
      ['33', 3],
      ['11', 1],
      ['22', 2],
    ])
    expect([...countsInPoolOrder(roots, counts)]).toEqual([1, 2, 3])
  })

  /**
   * The refusal that has to be here. `l2ChunkCounts` leaves a root the graph does not list out
   * of its answer rather than calling it zero, so this is where absence becomes a hole — and one
   * step later the root's name is gone and `log10(max(NaN, 1))` would be an ordinary number.
   */
  it('refuses a root with no count, by name', () => {
    expect(() => countsInPoolOrder(roots, new Map([['11', 1]]))).toThrow(/22, 33/)
  })
})

describe('an end that cannot be sized', () => {
  // Each end's candidate sits by its own tip, so the own-tip rule keeps both.
  const near = [0, 0, 0]
  const far = [9000, 0, 0]

  /**
   * A root the chunkedgraph does not list is a fact about one object beside one open end. The
   * refusal belongs where the hole is created (`countsInPoolOrder`), and surviving it belongs
   * here: a neuron is hundreds of ends and the expensive half is already spent by the time this
   * is known, so a throw would cost the whole run to say something about one of them.
   */
  it('comes back refused, by name, and the run goes on', async () => {
    const pools = [poolOf([1], [near]), poolOf([2], [far])]
    const counts = countsFor(pools)
    // The first end's own query root has no count; the second end's is untouched. (The two
    // fakes share a candidate root, so dropping that would refuse both and prove nothing.)
    counts.delete('1')
    const ends = await collect(
      searchEnds(
        TIPS,
        [endAt(0, 1n), endAt(1, 2n)],
        { ranker: RANKER, topK: 100, ownUm: 2 },
        stepsFor(pools, counts),
      ),
    )
    expect(ends).toHaveLength(2)
    expect(ends[0]!.rows).toBe(0)
    expect(ends[0]!.refusal).toMatch(/query root 1 has no level-2 chunk count/)
    // Not a missing query: that is a different state and the node says so differently.
    expect(ends[0]!.missingQuery).toBe(false)
    expect(ends[1]!.rows).toBeGreaterThan(0)
    expect(ends[1]!.refusal).toBeUndefined()
  })
})
