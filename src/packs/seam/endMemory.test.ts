/**
 * Find Merge Candidates' memory of finished ends.
 *
 * The node's `evaluate` cannot run under vitest — it needs a token, a segmentation and a GPU —
 * so what it does with the memory is `recalled`, which takes the search as a function. What is
 * pinned here is what fails without a word: a key that leaves out something an end's answer
 * depends on (a fast run of the wrong answers), an order that differs from an unremembered
 * run's (other rows in the published tables), and a refused end kept for the session.
 */

import { describe, expect, it } from 'vitest'

import type { EndMemory, RunIdentity } from './endMemory'
import { endKey, endMemory, forgetStale, heldEnds, neuronKey, recalled } from './endMemory'
import type { PublishedEnd, TipRow } from './searchTips'

const RUN: RunIdentity = {
  ranker: 'trees',
  assessor: 'none',
  top: 0,
  deployment: 'https://global.example',
  datastack: 'stack',
  moment: 1_794_903_754_257,
}

const tip = (x: number, eTip?: number, row = 0): TipRow => ({
  neuronId: '720',
  endUid: row,
  nm: [x, 0, 0],
  eTip,
  row,
})

/** A finished end with `rows` candidates, recognisable by its first candidate's root. */
function finished(
  mark: number,
  options: { rows?: number; row?: number; refusal?: string; scoreRefusal?: string } = {},
): PublishedEnd {
  const rows = options.rows ?? 2
  return {
    end: {
      rows,
      candRoot: BigUint64Array.from({ length: rows }, (_, at) => BigInt(mark * 100 + at)),
      repSupervoxel: new BigUint64Array(rows),
      tipSupervoxel: undefined,
      columns: { min_dist_um: new Float64Array(rows) },
      tip: options.row ?? 0,
      missingQuery: false,
      pooled: rows,
      tooFar: 0,
      anothersTip: 0,
      ...(options.refusal ? { refusal: options.refusal } : {}),
    },
    order: Int32Array.from({ length: rows }, (_, at) => at),
    ...(options.scoreRefusal
      ? {
          scores: {
            columns: {},
            filled: [],
            refusal: options.scoreRefusal,
            tip: {} as NonNullable<PublishedEnd['scores']>['tip'],
          },
        }
      : {}),
  }
}

const markOf = (end: PublishedEnd) => Number(end.end.candRoot[0]! / 100n)

/** Ends named by a number, searched by a function that records what it was asked for. */
function setUp(memory: EndMemory = endMemory()) {
  const asked: number[][] = []
  /** The clock a measured end is stamped with; a test moves it. */
  const clock = { now: 1000 }
  const run = async (ends: number[], options: { refresh?: boolean; rowBase?: number } = {}) => {
    // As the node does it: forgotten for the whole run, before any of it is measured.
    const keys = ends.map((end) => `end-${end}`)
    forgetStale(memory, keys, { refresh: options.refresh ?? false })
    const held = heldEnds(memory, keys)
    const out: Array<{
      mark: number
      fresh: boolean
      row: number
      at: number
      waits: boolean
    }> = []
    for await (const got of recalled(ends, {
      memory,
      held,
      keyOf: (end) => `end-${end}`,
      rowOf: (end) => (options.rowBase ?? 0) + end,
      now: () => clock.now,
      measure: async function* (missing) {
        asked.push([...missing])
        // Numbered within the neuron, as the search leaves them: the row is `recalled`'s to write.
        for (const end of missing) yield finished(end, { row: -1 })
      },
    })) {
      out.push({
        mark: markOf(got.end),
        fresh: got.fresh,
        row: got.end.end.tip,
        at: got.at,
        waits: got.thenWaits,
      })
    }
    return out
  }
  return { memory, asked, run, clock }
}

describe('a run answered from memory', () => {
  it('measures every end the first time, and none the second', async () => {
    const { asked, run } = setUp()
    const first = await run([1, 2, 3])
    expect(first.every((end) => end.fresh)).toBe(true)
    const second = await run([1, 2, 3])
    // The property the phase is for: the node's key moved, it ran again, and it read no box.
    expect(asked).toEqual([[1, 2, 3]])
    expect(second.map((end) => end.mark)).toEqual([1, 2, 3])
    expect(second.some((end) => end.fresh)).toBe(false)
  })

  it('is handed only the ends it does not hold, and yields in the order asked for', async () => {
    const { asked, run } = setUp()
    await run([2, 4])
    asked.length = 0
    // 2 and 4 remembered, between ends that are not: the tables are built in arrival order, so a
    // run answered half from memory has to publish the rows a run answered from none would.
    const got = await run([1, 2, 3, 4, 5])
    expect(asked).toEqual([[1, 3, 5]])
    expect(got.map((end) => end.mark)).toEqual([1, 2, 3, 4, 5])
    expect(got.map((end) => end.fresh)).toEqual([true, false, true, false, true])
  })

  it('writes every end’s row itself — a measured one, and a remembered one at its row now', async () => {
    // The same tips, listed further down a table the second time. Carried over, the old row
    // would fold this end's first candidate onto another tip.
    const { run } = setUp()
    const first = await run([1, 2], { rowBase: 0 })
    expect(first.map((end) => end.row)).toEqual([1, 2])
    const moved = await run([1, 2], { rowBase: 40 })
    expect(moved.map((end) => end.row)).toEqual([41, 42])
  })

  it('says when each end was measured, which is the age the card shows', async () => {
    const { run, clock } = setUp()
    await run([1])
    clock.now = 5000
    const got = await run([1, 2])
    // The remembered end keeps the moment it was measured; only the new one is from now.
    expect(got.map((end) => end.at)).toEqual([1000, 5000])
  })

  it('says when the next end is one to wait for, so what is held back is shown first', async () => {
    const { run } = setUp()
    await run([1, 2, 4])
    const got = await run([1, 2, 3, 4, 5])
    // 2 is the last remembered end before a measured one; 4 likewise; 5 is the last of all.
    expect(got.map((end) => end.waits)).toEqual([false, true, false, true, false])
  })

  it('forgets every end of a refreshed run before any is measured, so a stopped one leaves nothing old', async () => {
    // Clear Cache over two neurons, then Cancel during the first. The flag is spent when the run
    // starts; forgotten as the loop reached each neuron, the second would go on answering from
    // before the Clear Cache on the next run.
    const memory = endMemory()
    for (const end of [1, 2, 3, 4]) memory.set(`end-${end}`, finished(end), 0)
    forgetStale(memory, ['end-1', 'end-2', 'end-3', 'end-4'], { refresh: true })
    const firstNeuron = recalled([1, 2], {
      memory,
      held: heldEnds(memory, ['end-1', 'end-2']),
      keyOf: (end) => `end-${end}`,
      rowOf: (end) => end,
      measure: async function* (missing) {
        for (const end of missing) yield finished(end)
      },
    })
    for await (const got of firstNeuron) {
      void got
      break
    }
    // The second neuron (3, 4) was never reached, and holds nothing old.
    expect([1, 2, 3, 4].map((end) => memory.has(`end-${end}`))).toEqual([
      true,
      false,
      false,
      false,
    ])
  })

  it('forgets only what is past a chosen lifetime, so the run reports nothing older than it', () => {
    // The scheduler runs a node again, whole, when it reports data past its lifetime. Left to
    // that, the ends this pass had just measured would be measured twice.
    const memory = endMemory()
    memory.set('old', finished(1), 1_000)
    memory.set('recent', finished(2), 9_000)
    forgetStale(memory, ['old', 'recent', 'never held'], {
      refresh: false,
      maxAgeMs: 5_000,
      now: 10_000,
    })
    expect([memory.has('old'), memory.has('recent')]).toEqual([false, true])
    // And with no lifetime chosen, nothing is too old.
    memory.set('old', finished(1), 1_000)
    forgetStale(memory, ['old'], { refresh: false })
    expect(memory.has('old')).toBe(true)
  })

  it('reads nothing on a refresh, and remembers what it then measures', async () => {
    const { asked, run } = setUp()
    await run([1, 2])
    const again = await run([1, 2], { refresh: true })
    expect(asked).toEqual([
      [1, 2],
      [1, 2],
    ])
    expect(again.every((end) => end.fresh)).toBe(true)
    // The run after a Clear Cache is the one that pays; the one after that does not.
    await run([1, 2])
    expect(asked).toHaveLength(2)
  })

  it('keeps nothing of an end the run was stopped before', async () => {
    const memory = endMemory()
    const seen: number[] = []
    let stopped = false
    const stream = recalled([1, 2, 3], {
      memory,
      held: heldEnds(memory, ['end-1', 'end-2', 'end-3']),
      keyOf: (end) => `end-${end}`,
      rowOf: (end) => end,
      measure: async function* (missing) {
        try {
          for (const end of missing) yield finished(end)
        } finally {
          stopped = true
        }
      },
    })
    for await (const got of stream) {
      seen.push(markOf(got.end))
      // A Cancel after the first end.
      break
    }
    expect(seen).toEqual([1])
    expect(memory.size).toBe(1)
    expect(memory.has('end-2')).toBe(false)
    // And the search was told to stop, rather than left running with nobody reading it.
    expect(stopped).toBe(true)
  })

  it('does not fail a run that stopped because the search failed while being stopped', async () => {
    // The search runs one end ahead, so it can well fail as it is told to stop. A caller that
    // left by its own choice would otherwise be handed that failure as if it were the run's.
    const stream = recalled([1, 2], {
      memory: endMemory(),
      held: new Map(),
      keyOf: (end) => `end-${end}`,
      rowOf: (end) => end,
      measure: async function* (missing) {
        try {
          for (const end of missing) yield finished(end)
        } finally {
          // eslint-disable-next-line no-unsafe-finally -- the failure under test
          throw new Error('the search, failing as it stops')
        }
      },
    })
    const seen: number[] = []
    const consume = async () => {
      for await (const got of stream) {
        seen.push(markOf(got.end))
        break
      }
    }
    await expect(consume()).resolves.toBeUndefined()
    expect(seen).toEqual([1])
  })

  it('answers from what was held at the start, whatever the run then pushes out of the memory', async () => {
    // A memory with room for one end, holding the second neuron's. Measuring the first neuron's
    // end pushes it out — and it is the very next one wanted. Read from the memory as the loop
    // reached each neuron, a run larger than the budget would measure nearly all of itself again.
    const each = 512 + 100 * 28
    const memory = endMemory(each)
    memory.set('end-2', finished(2, { rows: 100 }), 0)
    const held = heldEnds(memory, ['end-1', 'end-2'])
    const asked: number[][] = []
    const got: Array<[number, boolean]> = []
    // Two neurons, one end each, as the node's loop comes to them.
    for (const neuron of [[1], [2]]) {
      for await (const one of recalled(neuron, {
        memory,
        held,
        keyOf: (end) => `end-${end}`,
        rowOf: (end) => end,
        measure: async function* (missing) {
          asked.push([...missing])
          for (const end of missing) yield finished(end, { rows: 100 })
        },
      })) {
        got.push([markOf(one.end), one.fresh])
      }
    }
    // The memory itself no longer holds it, which is the point.
    expect(memory.has('end-2')).toBe(false)
    expect(asked).toEqual([[1]])
    expect(got).toEqual([
      [1, true],
      [2, false],
    ])
  })

  it('refuses a search that answers for fewer ends than it was asked', async () => {
    const stream = recalled([1, 2], {
      memory: endMemory(),
      held: new Map(),
      keyOf: (end) => `end-${end}`,
      rowOf: (end) => end,
      measure: async function* () {
        yield finished(1)
      },
    })
    const drain = async () => {
      for await (const got of stream) void got
    }
    await expect(drain()).rejects.toThrow(/before every end it was asked for/)
  })
})

describe('what is kept', () => {
  it('does not keep an end the search or the assessor refused', () => {
    // A refusal is a request that failed for this end; kept, a moment's network trouble would
    // be the answer for the rest of the session.
    const memory = endMemory()
    memory.set('searched', finished(1, { refusal: 'chunk counts: 503' }), 0)
    memory.set('scored', finished(2, { scoreRefusal: 'patch box: failed' }), 0)
    expect(memory.size).toBe(0)
    // And a refusal replaces what was there, rather than leaving an older answer standing.
    memory.set('searched', finished(1), 0)
    memory.set('searched', finished(1, { refusal: 'again' }), 0)
    expect(memory.has('searched')).toBe(false)
  })

  it('keeps an end whose box held no voxel of its neuron — a fact, not a failure', () => {
    const memory = endMemory()
    const empty = finished(1, { rows: 0 })
    memory.set('k', { ...empty, end: { ...empty.end, missingQuery: true } }, 0)
    expect(memory.has('k')).toBe(true)
  })

  it('drops the end used longest ago once it is over its budget', () => {
    // Each end here is 512 + 100 x (8 + 8 + 8 + 4) bytes: its roots, contact supervoxels, gaps
    // and order.
    const each = 512 + 100 * 28
    const memory = endMemory(each * 2)
    memory.set('a', finished(1, { rows: 100 }), 0)
    memory.set('b', finished(2, { rows: 100 }), 0)
    expect(memory.bytes).toBe(each * 2)
    // A read is a use: `a` is now the newer of the two.
    memory.get('a')
    memory.set('c', finished(3, { rows: 100 }), 0)
    expect([memory.has('a'), memory.has('b'), memory.has('c')]).toEqual([true, false, true])
    expect(memory.bytes).toBe(each * 2)
  })

  it('does not count pricing a run as a use', () => {
    const each = 512 + 100 * 20
    const memory = endMemory(each * 2)
    memory.set('a', finished(1, { rows: 100 }), 0)
    memory.set('b', finished(2, { rows: 100 }), 0)
    memory.has('a')
    memory.set('c', finished(3, { rows: 100 }), 0)
    expect(memory.has('a')).toBe(false)
  })

  it('does not empty itself for one end larger than the whole budget', () => {
    const memory = endMemory(1024)
    memory.set('small', finished(1, { rows: 1 }), 0)
    memory.set('huge', finished(2, { rows: 1000 }), 0)
    expect([memory.has('small'), memory.has('huge')]).toEqual([true, false])
  })
})

describe('the key', () => {
  const tips = [tip(100, 0.5, 0), tip(200, 0.25, 1), tip(300, undefined, 2)]
  const base = endKey(neuronKey(RUN, '720', tips), tips[0]!)

  it('is the same for the same question', () => {
    expect(endKey(neuronKey({ ...RUN }, '720', [...tips]), { ...tips[0]! })).toBe(base)
  })

  it('does not depend on where the tip is listed', () => {
    // A row is where the tip happened to be in the table, which is why `recalled` writes it again.
    const lower = tips.map((one) => ({ ...one, row: one.row + 40, endUid: one.endUid + 40 }))
    expect(endKey(neuronKey(RUN, '720', lower), lower[0]!)).toBe(base)
  })

  // Each of these is a different question; leaving one out is a fast run of the wrong answers.
  it.each<[string, Partial<RunIdentity>]>([
    ['the forest', { ranker: 'other-trees' }],
    ['the assessor', { assessor: 'n3_mal_mask_s0' }],
    ['how many candidates the assessor is given', { top: 10 }],
    ['the deployment', { deployment: 'https://other.example' }],
    ['the datastack', { datastack: 'other' }],
    ['the moment', { moment: 1_794_903_754_258 }],
  ])('moves with %s', (_what, change) => {
    expect(endKey(neuronKey({ ...RUN, ...change }, '720', tips), tips[0]!)).not.toBe(base)
  })

  it('moves with the neuron', () => {
    expect(endKey(neuronKey(RUN, '721', tips), tips[0]!)).not.toBe(base)
  })

  it('reads the other tips as exactly as it reads its own', () => {
    // Past 2^24 nm a float32 cannot tell neighbouring nanometres apart; a key built on one would
    // serve an end measured against a tip that has since moved.
    const far = [tip(100, 0.5, 0), tip(40_000_000, 0.25, 1)]
    const moved = [tip(100, 0.5, 0), tip(40_000_001, 0.25, 1)]
    expect(neuronKey(RUN, '720', far)).not.toBe(neuronKey(RUN, '720', moved))
  })

  it('moves with the other tips of the neuron, which the own-tip rule measures against', () => {
    // Filter the table to two ends and a candidate that belonged to the third is now kept.
    expect(endKey(neuronKey(RUN, '720', tips.slice(0, 2)), tips[0]!)).not.toBe(base)
    const nudged = [tips[0]!, tips[1]!, tip(301, undefined, 2)]
    expect(endKey(neuronKey(RUN, '720', nudged), tips[0]!)).not.toBe(base)
  })

  it('moves with the end’s own position and with its e_tip', () => {
    const inNeuron = neuronKey(RUN, '720', tips)
    expect(endKey(inNeuron, tips[1]!)).not.toBe(base)
    expect(endKey(inNeuron, { ...tips[0]!, eTip: 0.6 })).not.toBe(base)
    // No score and a score of nothing are two things: the first floors `p_tip`.
    expect(endKey(inNeuron, { ...tips[0]!, eTip: undefined })).not.toBe(base)
  })
})
