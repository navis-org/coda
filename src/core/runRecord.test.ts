/**
 * A record a run keeps in a param (`ParamBase.runRecord`): relayed by the scheduler to its host,
 * only for a param declared as one, never for a cancelled run — and emptied by the ⟳
 * (`emptyRecords`), which touches nothing else.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { CodaGraph } from './graph'
import { addNode, emptyGraph } from './graph'
import { node } from '../test/graph'
import { registerNode } from './registry'
import { emptyRecords } from './runRecord'
import { Scheduler } from './scheduler'
import { T } from './types'

/** What the running node asks to record, set per test. */
let toRecord: { param: string; value: string } | undefined
/** What the node's `evaluate` waits on before it records: resolved, unless a test holds it. */
let hold: Promise<void> = Promise.resolve()
/** Set as `evaluate` starts, so a test can act on a run that is really in flight. */
let started = false
/** `ctx.params.at` as the node read it after recording, and a spread of its context read it. */
let readBack: unknown[] = []

beforeAll(() => {
  registerNode({
    type: 'test.record.moment',
    label: 'moment',
    category: 'analysis',
    cost: 'expensive',
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    params: [
      {
        id: 'at',
        kind: 'string',
        label: 'At',
        default: '',
        runRecord: true,
        presentational: true,
        unrecorded: true,
        internal: true,
      },
      { id: 'other', kind: 'string', label: 'Other', default: '' },
    ],
    inferOutputs: () => ({ out: T.table() }),
    // Decided as the run starts, as Suggest Merges decides its moments, and recorded after.
    evaluate: async (ctx) => {
      started = true
      const decided = toRecord
      await hold
      if (decided) ctx.record?.(decided.param, decided.value)
      readBack = [ctx.params['at'], { ...ctx, refresh: true }.params['at']]
      return {}
    },
  })
})

function graph(params: Record<string, string> = {}): CodaGraph {
  return addNode(emptyGraph(), node('n', 'test.record.moment', params))
}

function scheduler(recorded: unknown[][]) {
  return new Scheduler({
    resolveSource: (id) => {
      throw new Error(`no source here (asked for ${id})`)
    },
    onRecord: (...args) => recorded.push(args),
  })
}

describe('a record a run keeps', () => {
  it('is handed to the host, which owns the document', async () => {
    const recorded: unknown[][] = []
    toRecord = { param: 'at', value: '1=2026-11-17T08:40:12.000Z' }
    await scheduler(recorded).run(graph(), { mode: 'full' })
    expect(recorded).toEqual([['n', 'at', '1=2026-11-17T08:40:12.000Z']])
  })

  /**
   * The lifetime backstop runs `evaluate` again on a spread of the same context. Reading the
   * record as it was before the first pass, the second would decide afresh what the first had
   * just recorded.
   */
  it('is read back by the evaluation that recorded it, and by a spread of its context', async () => {
    toRecord = { param: 'at', value: '1=2026-11-17T08:40:12.000Z' }
    await scheduler([]).run(graph(), { mode: 'full' })
    expect(readBack).toEqual(['1=2026-11-17T08:40:12.000Z', '1=2026-11-17T08:40:12.000Z'])
  })

  it('refuses a param not declared a record, so nothing else can be written this way', async () => {
    const recorded: unknown[][] = []
    toRecord = { param: 'other', value: 'x' }
    const s = scheduler(recorded)
    await s.run(graph(), { mode: 'full' })
    expect(s.info('n').state).toBe('error')
    expect(s.info('n').error).toMatch(/not a run record/)
    expect(recorded).toEqual([])
  })

  it('drops what a cancelled run would have recorded', async () => {
    const recorded: unknown[][] = []
    toRecord = { param: 'at', value: 'late' }
    let release!: () => void
    hold = new Promise((resolve) => (release = resolve))
    const s = scheduler(recorded)
    started = false
    const run = s.run(graph(), { mode: 'full' })
    await vi.waitFor(() => expect(started).toBe(true))
    s.cancel()
    release()
    await run.catch(() => undefined)
    hold = Promise.resolve()
    expect(recorded).toEqual([])
  })

  /**
   * The ⟳ empties the record, which is out of the key. Without `renewNode` a run already in
   * flight keeps its key, the next walk adopts it, and its answer — decided on the old record —
   * is the result.
   */
  it('stops a run in flight when the node is renewed, rather than letting the next adopt it', async () => {
    const recorded: unknown[][] = []
    toRecord = { param: 'at', value: 'old' }
    let release!: () => void
    hold = new Promise((resolve) => (release = resolve))
    const s = scheduler(recorded)
    const g = graph()
    started = false
    const first = s.run(g, { mode: 'full' })
    await vi.waitFor(() => expect(started).toBe(true))
    s.renewNode(g, 'n')
    hold = Promise.resolve()
    toRecord = { param: 'at', value: 'new' }
    const second = s.run(g, { mode: 'full' })
    release()
    await Promise.all([first.catch(() => undefined), second])
    expect(recorded).toEqual([['n', 'at', 'new']])
    expect(s.info('n').state).toBe('ok')
  })

  it('is refused at registration without the three flags it rests on', () => {
    expect(() =>
      registerNode({
        type: 'test.record.keyed',
        label: 'keyed',
        category: 'analysis',
        cost: 'expensive',
        inputs: [],
        outputs: [],
        params: [
          {
            id: 'at',
            kind: 'string',
            label: 'At',
            default: '',
            runRecord: true,
            internal: true,
          },
        ],
        inferOutputs: () => ({}),
        evaluate: () => ({}),
      }),
    ).toThrow(/runRecord.*presentational/)
  })

  it('is emptied by the ⟳, and nothing beside it', () => {
    const g = graph({ at: '1=2026-11-17T08:40:12.000Z', other: 'kept' })
    const out = emptyRecords(g, 'n')
    expect(out.nodes[0]!.params).toEqual({ at: '', other: 'kept' })
    // Already empty, absent, or another node: the graph itself.
    expect(emptyRecords(out, 'n')).toBe(out)
    const absent = graph()
    delete (absent.nodes[0]!.params as Record<string, unknown>)['at']
    expect(emptyRecords(absent, 'n')).toBe(absent)
    expect(emptyRecords(g, 'nobody')).toBe(g)
  })
})
