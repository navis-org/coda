/**
 * The For Each node's own contract, without a scheduler driving it.
 *
 * `core/scheduler.test.ts` covers the loop — how many passes, in what order, what settles. What
 * is tested here is the half a loop cannot see: that `loopPlan` and `evaluate` agree about which
 * element pass *n* means, and that grouping divides a collection the way the card says it does.
 *
 * The two halves agreeing is the whole risk. `loopPlan` says "412 passes, and pass 7 is LC4";
 * `evaluate` independently works out what pass 7 emits. If they part company, the progress line
 * and the filename name one neuron while the file holds another — and nothing anywhere would
 * say so.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams } from '../../core/node'
import type { EvalContext, LoopIteration } from '../../core/node'
import { registerNode, requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { TableValue, Value } from '../../core/values'
import { isTableValue, tableFromRows } from '../../core/values'
import '../index'

const SCHEMA = tableSchema(column('neuronId', 'str'), column('type', 'str'))

const NEURONS = tableFromRows(SCHEMA, [
  { neuronId: '1', type: 'LC4' },
  { neuronId: '2', type: 'LC6' },
  { neuronId: '3', type: 'LC4' },
  { neuronId: '4', type: '' },
])

const def = requireNodeDef('flow.forEach')

/**
 * A context with only what this node reads.
 *
 * Hand-built rather than driven through a `Scheduler`, so a failure points at the node instead
 * of at the executor — `scheduler.test.ts` already owns the other direction.
 */
function ctx(
  input: Value | undefined,
  params: Record<string, unknown> = {},
  iteration?: LoopIteration,
): EvalContext {
  const merged = { ...defaultParams(def), ...params }
  return {
    params: merged,
    refresh: false,
    input: () => input,
    inputKey: () => undefined,
    // The real resolver falls back to the first compatible column; here the tests always name
    // one, so passing the param through is the same answer by a shorter route.
    column: (id) => String(merged[id] ?? '') || undefined,
    columns: () => [],
    resolveSource: () => {
      throw new Error('not needed')
    },
    signal: new AbortController().signal,
    progress: () => {},
    warn: () => {},
    publish: () => {},
    reportFetched: () => {},
    ...(iteration ? { iteration } : {}),
  } as EvalContext
}

function ids(value: Value | undefined): string[] {
  return isTableValue(value) ? (value as TableValue).data['neuronId']!.map(String) : []
}

function emit(params: Record<string, unknown>, index: number): string[] {
  const plan = def.loopPlan!(ctx(NEURONS, params))
  const iteration = {
    index,
    count: plan.count,
    label: plan.label(index),
    size: plan.size(index),
  }
  return ids(def.evaluate(ctx(NEURONS, params, iteration) as never)['item' as never] as Value)
}

describe('For Each, element by element', () => {
  /**
   * Named by the **id**, not by the cell type, and this was a real defect caught end to end.
   *
   * A loop over the mock optic lobe's `LC.*` returns six neurons of one type, so
   * `elementLabel` — which prefers a name column, correctly, for `Select One`'s card — said
   * `LC11` for all six. That is a progress line that never changes and six files told apart only
   * by their ordinal. `elementIdentity` is the split that fixes it.
   */
  it('plans one pass per element and names each by its id', () => {
    const plan = def.loopPlan!(ctx(NEURONS))
    expect(plan.count).toBe(4)
    expect([0, 1].map(plan.label)).toEqual(['1', '2'])
  })

  it('falls back to a name where there is no id to use', () => {
    const clusters = tableFromRows(tableSchema(column('label', 'str')), [{ label: 'cluster-a' }])
    // An uploaded CSV of clusters has no `neuronId`, and a name beats a bare ordinal there.
    expect(def.loopPlan!(ctx(clusters)).label(0)).toBe('cluster-a')
  })

  it('emits the element the plan named', () => {
    expect(emit({}, 0)).toEqual(['1'])
    expect(emit({}, 3)).toEqual(['4'])
  })

  /*
   * `Select One`'s rule, and it matters more here: a loop asked for a pass past the end has been
   * re-keyed by something upstream shrinking the collection, and clamping would emit the last
   * neuron repeatedly under four hundred different filenames.
   */
  it('emits nothing past the end rather than the nearest element', () => {
    expect(emit({}, 9)).toEqual([])
  })

  it('stops at First N', () => {
    expect(def.loopPlan!(ctx(NEURONS, { limit: 2 })).count).toBe(2)
    // A limit larger than the collection is not an error and does not pad it.
    expect(def.loopPlan!(ctx(NEURONS, { limit: 99 })).count).toBe(4)
  })

  it('plans no passes for something it cannot iterate', () => {
    expect(def.loopPlan!(ctx(undefined)).count).toBe(0)
    expect(def.loopPlan!(ctx({ kind: 'scalar', value: 1 } as unknown as Value)).count).toBe(0)
  })
})

describe('For Each, in batches', () => {
  /**
   * The whole point: every backend already fetches concurrently — `mapWithConcurrency`, six in
   * flight on neuPrint, eight on CATMAID — and a loop asking for one neuron per pass reduces
   * that to one. A batch hands the run down whole and gets the concurrency back.
   */
  it('divides the collection into runs, not elements', () => {
    const plan = def.loopPlan!(ctx(NEURONS, { batch: 2 }))
    expect(plan.count).toBe(2)
    expect(emit({ batch: 2 }, 0)).toEqual(['1', '2'])
    expect(emit({ batch: 2 }, 1)).toEqual(['3', '4'])
  })

  it('leaves the last batch short rather than padding it', () => {
    const plan = def.loopPlan!(ctx(NEURONS, { batch: 3 }))
    // Four elements at three a time is two passes: three, then one.
    expect(plan.count).toBe(2)
    expect([0, 1].map(plan.size)).toEqual([3, 1])
    expect(emit({ batch: 3 }, 1)).toEqual(['4'])
  })

  it('names a batch by its first element and how many follow', () => {
    // There is no one name for twenty neurons, and this is what a progress line can use.
    expect(def.loopPlan!(ctx(NEURONS, { batch: 2 })).label(0)).toBe('1 +1')
    // A batch of one is still an element, so it keeps the plain name.
    expect(def.loopPlan!(ctx(NEURONS, { batch: 1 })).label(0)).toBe('1')
  })

  /*
   * `First N` counts elements, not passes — "try it on the first ten" means ten neurons whatever
   * the batch size, which is what somebody who set both of them means.
   */
  it('applies First N to elements, so the two settings compose', () => {
    const plan = def.loopPlan!(ctx(NEURONS, { batch: 2, limit: 3 }))
    expect(plan.count).toBe(2)
    expect([0, 1].map(plan.size)).toEqual([2, 1])
    expect(emit({ batch: 2, limit: 3 }, 1)).toEqual(['3'])
  })

  it('is ignored in group mode, where a group is already many elements', () => {
    // Two divisions of one collection, with nothing on screen to tell them apart.
    const plan = def.loopPlan!(ctx(NEURONS, { mode: 'group', groupBy: 'type', batch: 3 }))
    expect(plan.count).toBe(3)
  })

  it('treats a nonsensical batch as one at a time rather than dividing by zero', () => {
    expect(def.loopPlan!(ctx(NEURONS, { batch: 0 })).count).toBe(4)
    expect(def.loopPlan!(ctx(NEURONS, { batch: -5 })).count).toBe(4)
  })

  it('reports how many elements each pass carries', () => {
    // Read by the progress line and by the filename stem — see `LoopIteration.size`.
    expect(def.loopPlan!(ctx(NEURONS)).size(0)).toBe(1)
    expect(def.loopPlan!(ctx(NEURONS, { mode: 'group', groupBy: 'type' })).size(0)).toBe(2)
  })
})

describe('For Each, group by group', () => {
  const params = { mode: 'group', groupBy: 'type' }

  it('plans one pass per distinct value, in first-appearance order', () => {
    const plan = def.loopPlan!(ctx(NEURONS, params))
    // Three, not four: two neurons share LC4, and the blank one is its own group.
    expect(plan.count).toBe(3)
    expect([0, 1, 2].map(plan.label)).toEqual(['LC4', 'LC6', '(none)'])
  })

  it('emits every element of the group, not one of them', () => {
    expect(emit(params, 0)).toEqual(['1', '3'])
    expect(emit(params, 1)).toEqual(['2'])
  })

  it('gathers the elements with no value into one group', () => {
    // One group rather than one group per null, which is what an unhandled null would produce —
    // and "the neurons with no type" is a set somebody means.
    expect(emit(params, 2)).toEqual(['4'])
  })

  it('plans nothing until a column is picked', () => {
    expect(def.loopPlan!(ctx(NEURONS, { mode: 'group' })).count).toBe(0)
  })

  it('refuses to evaluate without a column rather than guessing one', () => {
    expect(() => def.evaluate(ctx(NEURONS, { mode: 'group' }) as never)).toThrow(/group by/)
  })
})

describe('For Each, wiring', () => {
  it('passes its input type straight through, so pickers below it stay filled', () => {
    const inferred = def.inferOutputs!({
      params: defaultParams(def),
      inputs: { in: { kind: 'neurons', schema: SCHEMA } },
      schema: () => SCHEMA,
      attributes: () => undefined,
      column: () => undefined,
      columns: () => [],
    } as never)
    expect(inferred['item']).toEqual({ kind: 'neurons', schema: SCHEMA })
  })

  /*
   * `expensive` is a safety property here rather than a cost one — see the node's header. A
   * `cheap` loop would run four hundred backend queries and write four hundred files on the
   * 180ms pass after every keystroke.
   */
  it('is expensive, so no keystroke can start a loop', () => {
    expect(def.cost).toBe('expensive')
  })

  it('declares itself a loop begin, which is what the scheduler matches on', () => {
    expect(def.loop).toBe('begin')
    expect(requireNodeDef('flow.collect').loop).toBe('end')
  })

  /*
   * Half a loop fails silently and asymmetrically: the scheduler runs the node once, while the
   * region walk still derives a region and the canvas still draws a frame captioned "for each"
   * around nodes that will run exactly once. Refused at registration, so it fails when the node
   * pack is imported rather than the first time somebody presses Run.
   */
  it('refuses a node that declares only half a loop', () => {
    const half = {
      type: 'test.loop.halfBegin',
      label: 'half',
      category: 'utility',
      cost: 'cheap',
      loop: 'begin',
      inputs: [],
      outputs: [{ id: 'out', label: 'Out', type: T.any() }],
      evaluate: () => ({ out: NEURONS }),
    } as const
    expect(() => registerNode(half as never)).toThrow(/without `loopPlan`/)
    // And the other way round: a plan on a node the scheduler will never ask for one.
    expect(() =>
      registerNode({
        ...half,
        type: 'test.loop.halfPlan',
        loop: undefined,
        loopPlan: () => ({ count: 0, label: () => '' }),
      } as never),
    ).toThrow(/without `loop/)
  })
})
