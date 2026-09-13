/**
 * Choosing a layout, and the byte arithmetic behind it.
 *
 * Pure over numbers, so everything here is exact rather than approximate — which is the point:
 * the two layouts are transposes of each other, so an error in one plan's offsets produces
 * values of entirely plausible magnitude taken from the wrong neuron or the wrong timestep.
 *
 * The **module-scope import check** at the bottom belongs here rather than anywhere obvious: the
 * sorted path is built from the release base across a module boundary, and building it the
 * natural way produced `"undefined/traces_rastermap_sorted"` with every other test still green.
 */

import { describe, expect, it } from 'vitest'

import {
  REQUEST_BYTES_EQUIVALENT,
  chooseTracePlan,
  planPlainRead,
  planSortedRead,
} from './readPlan'
import { SORTED_TRACES, TRACE_TIMESTEPS, ZAPBENCH_RELEASE } from './traces'

const WHOLE = { start: 0, end: TRACE_TIMESTEPS }
const ROW_BYTES = 512 * 4

/** Identity permutation: sorted position equals the original column. */
const identity = (column: number) => column

describe('the row-major plan', () => {
  it('reads a chunk row whole, because a chunk row cannot be cut along the neuron axis', () => {
    const plan = planPlainRead([3], { start: 0, end: 4 })
    expect(plan.reads).toHaveLength(1)
    const [read] = plan.reads
    expect([read!.from, read!.to]).toEqual([0, 4 * ROW_BYTES - 1])
    // 512 neurons' worth of bytes to collect one neuron's four values.
    expect(read!.to - read!.from + 1).toBe(4 * ROW_BYTES)
    expect(read!.picks).toEqual([{ column: 3, start: 3, stride: 512 }])
  })

  it('costs one read per block per chunk row, however many neurons of the block are wanted', () => {
    const one = planPlainRead([0], { start: 0, end: 512 })
    const many = planPlainRead([0, 1, 2, 511], { start: 0, end: 512 })
    expect(many.bytes).toBe(one.bytes)
    expect(many.reads).toHaveLength(one.reads.length)
  })
})

describe('the transposed plan', () => {
  it('reads one neuron as a contiguous run, not a stride', () => {
    const plan = planSortedRead([3], identity, { start: 0, end: 4 })
    expect(plan.reads).toHaveLength(1)
    const [read] = plan.reads
    // Neuron 3's own 512-value block, offset to the window's first timestep.
    expect(read!.from).toBe(3 * 512 * 4)
    expect(read!.to).toBe(3 * 512 * 4 + 4 * 4 - 1)
    expect(read!.to - read!.from + 1).toBe(16)
    expect(read!.picks).toEqual([{ column: 3, start: 0, stride: 1 }])
  })

  /*
   * The measured reason this node exists: 36 scattered neurons over the whole recording cost
   * 576 MiB row-major and 1.1 MiB transposed, at the same request count.
   */
  it('costs orders of magnitude less for scattered neurons over a wide window', () => {
    const scattered = Array.from({ length: 36 }, (_, i) => Math.floor((i * 71721) / 36) + 3)
    const plain = planPlainRead(scattered, WHOLE)
    const sorted = planSortedRead(scattered, identity, WHOLE)
    expect(plain.reads.length).toBe(sorted.reads.length)
    expect(plain.bytes / sorted.bytes).toBeGreaterThan(400)
    expect(chooseTracePlan(scattered, WHOLE, identity).layout).toBe('sorted')
  })

  /*
   * And the case that stops this being a constant naming a winner: row-major is exactly the
   * right shape for a narrow window over many neurons, where the transposed read would bridge
   * hundreds of unwanted neurons to collect a handful of timesteps each.
   */
  it('loses to row-major on a narrow window over a whole block, and the choice notices', () => {
    const dense = Array.from({ length: 512 }, (_, i) => i)
    const narrow = { start: 0, end: 4 }
    const plain = planPlainRead(dense, narrow)
    const sorted = planSortedRead(dense, identity, narrow)
    expect(sorted.bytes).toBeGreaterThan(plain.bytes)
    expect(chooseTracePlan(dense, narrow, identity).layout).toBe('plain')
  })

  it('bridges a small gap into one read and splits on a large one', () => {
    // Two neighbours: bridging costs one neuron's 2 kB, far under a request.
    expect(planSortedRead([10, 11], identity, WHOLE).reads.length).toBe(
      planSortedRead([10], identity, WHOLE).reads.length,
    )
    // Far apart within one block: bridging would cost more than the request it saves.
    const far = planSortedRead([0, 500], identity, { start: 0, end: 512 })
    expect(far.reads).toHaveLength(2)
    const bridged = (500 - 0 - 1) * 512 * 4
    expect(bridged).toBeGreaterThan(REQUEST_BYTES_EQUIVALENT)
  })

  it('keeps each pick addressable inside a bridged run', () => {
    const plan = planSortedRead([10, 12], identity, { start: 0, end: 8 })
    expect(plan.reads).toHaveLength(1)
    const [read] = plan.reads
    expect(read!.picks).toEqual([
      { column: 10, start: 0, stride: 1 },
      // Two neuron-blocks along, in float32s — 12 is bridged over 11.
      { column: 12, start: 2 * 512, stride: 1 },
    ])
  })
})

describe('choosing', () => {
  it('falls back to row-major when there is no permutation', () => {
    expect(chooseTracePlan([1, 2], WHOLE, undefined).layout).toBe('plain')
  })

  it('prices requests as well as bytes, so a plan is not chosen on bytes alone', () => {
    const plan = planPlainRead([0], { start: 0, end: 1 })
    expect(plan.cost).toBe(plan.bytes + plan.reads.length * REQUEST_BYTES_EQUIVALENT)
  })
})

/*
 * A cycle between `traces.ts` and `sorting.ts` is safe only while every read is inside a
 * function. This pins the one that is not: the sorted base is built at module scope, and built
 * from the wrong side it silently became the string "undefined/traces_rastermap_sorted" with the
 * whole suite still passing.
 */
describe('module initialisation', () => {
  it('builds the sorted path from a real release base', () => {
    // The one that guards the incident: built from the wrong side this was the literal string
    // "undefined/traces_rastermap_sorted", with the whole suite green.
    expect(SORTED_TRACES).not.toContain('undefined')
    expect(SORTED_TRACES).toBe(`${ZAPBENCH_RELEASE}/traces_rastermap_sorted`)
  })
})
