/**
 * `withDefaults`: what a node's code reads for a param nothing stored.
 *
 * The one place that answer is spelled, so the provenance key, `validate`/`inferOutputs` and
 * `evaluate` cannot disagree about it. Before it, each read wrote the default a second time —
 * `ctx.params.count ?? 0` beside a declared `100` — and the copies drifted.
 */

import { describe, expect, it } from 'vitest'

import { addNode, emptyGraph } from './graph'
import type { CodaGraph } from './graph'
import type { ParamValues } from './node'
import { visibleParams, withDefaults } from './node'
import { registerNode } from './registry'
import { Scheduler } from './scheduler'
import { T, column, tableSchema } from './types'
import { tableFromRows } from './values'

const seen: ParamValues[] = []

const def = registerNode({
  type: 'test.withDefaults',
  label: 'With defaults',
  category: 'utility',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'In', type: T.table(), required: false }],
  outputs: [{ id: 'out', label: 'Out', type: T.table() }],
  params: [
    { id: 'count', kind: 'int', label: 'Count', default: 100 },
    {
      id: 'mode',
      kind: 'enum',
      label: 'Mode',
      default: 'head',
      options: [
        { value: 'head', label: 'head' },
        { value: 'tail', label: 'tail' },
      ],
    },
    // Visible only under the default mode, so the key has to decide it over the filled view.
    { id: 'seed', kind: 'int', label: 'Seed', default: 1, visibleIf: (p) => p.mode === 'head' },
    { id: 'pick', kind: 'column', label: 'Pick', from: 'in', default: 'type', optional: true },
    { id: 'need', kind: 'column', label: 'Need', from: 'in', default: 'type' },
    { id: 'legacy', kind: 'boolean', label: 'Legacy', default: true, absentMeans: false },
  ],
  inferOutputs: () => ({ out: T.table() }),
  evaluate: (ctx) => {
    seen.push(ctx.params)
    return {
      out: tableFromRows(tableSchema(column('x', 'i64')), [{ x: Number(ctx.params.count) }]),
    }
  },
})

const DEFAULTS = { count: 100, mode: 'head', seed: 1, pick: '', need: 'type', legacy: true }

function graphWith(params: ParamValues): CodaGraph {
  return addNode(emptyGraph('defaults'), {
    id: 'n',
    type: def.type,
    position: { x: 0, y: 0 },
    params,
  })
}

describe('withDefaults', () => {
  it('fills a declared param nothing stored, and leaves a stored one alone', () => {
    expect(withDefaults(def, { count: 5 })).toEqual({ ...DEFAULTS, count: 5 })
  })

  it('reads null as absent, as the `??` it replaced did', () => {
    const stored = { count: null } as unknown as ParamValues
    expect(withDefaults(def, stored).count).toBe(100)
  })

  it('fills a column picker with what `resolveColumn` reads its absence as', () => {
    const filled = withDefaults<ParamValues>(def, {})
    // Optional: empty, which is a choice, never the declared default. Required: the default.
    expect(filled.pick).toBe('')
    expect(filled.need).toBe('type')
  })

  it('asks `visibleIf` of the filled params, as the key does', () => {
    const ids = (params: ParamValues) => visibleParams(def, params).map((p) => p.id)
    expect(ids({})).toContain('seed')
    expect(ids({ mode: 'tail' })).not.toContain('seed')
  })

  it('does not consult `absentMeans`, which describes a stored document and the loader applies', () => {
    expect(withDefaults<ParamValues>(def, {}).legacy).toBe(true)
  })

  it('hands back the stored object when nothing is missing, and one stable copy when something is', () => {
    const complete: ParamValues = { ...DEFAULTS }
    expect(withDefaults(def, complete)).toBe(complete)

    const partial: ParamValues = { count: 5 }
    const filled = withDefaults(def, partial)
    expect(filled).not.toBe(partial)
    // Stable, so a memo keyed on `ctx.params`' identity keeps hitting across inference passes.
    expect(withDefaults(def, partial)).toBe(filled)
    expect(partial).toEqual({ count: 5 })
  })
})

describe('a node stored without its keys', () => {
  it('is evaluated with the declared defaults, and keyed exactly as one carrying them', async () => {
    const scheduler = new Scheduler({
      resolveSource: (id) => {
        throw new Error(`this node must not reach a source (asked for ${id})`)
      },
    })
    seen.length = 0
    await scheduler.run(graphWith({}), { mode: 'full' })
    expect(seen.at(-1)).toMatchObject(DEFAULTS)

    // Same key: nothing to re-run. Before, `visibleIf` read the raw params, found no `mode`, hid
    // `seed` — and the two graphs hashed differently for one and the same computation.
    const carrying = graphWith({ ...DEFAULTS })
    scheduler.refreshStates(carrying)
    expect(scheduler.info('n').state).toBe('ok')
    expect((await scheduler.run(carrying, { mode: 'full' })).executed).toEqual([])
  })
})
