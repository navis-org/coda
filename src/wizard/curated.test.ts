/**
 * The hand-written demos, run for real.
 *
 * They exist because the searched demos type-checked and showed nothing — Split Neurons with no
 * rule sent every neuron to Rest — so type-checking is not the standard here. Each synthetic one
 * is run and its focus card must produce something on every output; one on a published dataset
 * cannot be run here, and is held to its declarations instead. Inference is
 * `demo.test.ts`', which reaches these through `demoGraph`, and overlap `placeGuards.test.ts`'.
 */

import { describe, expect, it } from 'vitest'

import '../nodes'
import { findParam } from '../core/node'
import { listableNodeDefs, requireNodeDef } from '../core/registry'
import type { Value } from '../core/values'
import { registerBuiltinSources } from '../data/builtins'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import { elementCount, isIterableValue } from '../nodes/lib/iterables'
import { mockScheduler } from '../test/scheduler'
import { CURATED, curatedGraph, exampleGraph, isSynthetic } from './curated'
import { demoGraph } from './demo'

registerBuiltinSources()
// The synthetic source waits ~220 ms per call to feel like a network; nothing here is about that.
const source = new MockSource({ latencyMs: 0 })
registerSource(source)

/** How much a value holds, for asking whether an output came out empty. */
function sizeOf(v: Value | undefined): number {
  if (isIterableValue(v)) return elementCount(v)
  if (v?.kind === 'matrix') return v.rowLabels.length * v.colLabels.length
  if (v?.kind === 'points') return v.positions.length / 3
  return v ? 1 : 0
}

describe('curated demos', () => {
  it('answer only for listable node types, each once', () => {
    const listable = new Set(listableNodeDefs().map((def) => def.type))
    const types = CURATED.flatMap((spec) => spec.types)
    for (const type of types) expect(listable.has(type), type).toBe(true)
    expect(new Set(types).size).toBe(types.length)
  })

  it.each(CURATED.flatMap((spec) => spec.types))('%s opens its curated workflow', (type) => {
    expect(demoGraph(type)?.meta?.name).toBe(curatedGraph(type)?.meta?.name)
  })

  /*
   * A param a card sets that its node no longer declares is dropped by `normalizeParams` in
   * silence, and the example then opens on the default — plausible, and not the example.
   */
  it('sets only params its cards declare', () => {
    for (const spec of CURATED) {
      for (const card of spec.cards) {
        const def = requireNodeDef(card.type)
        for (const param of Object.keys(card.params ?? {})) {
          expect(findParam(def, param), `${spec.title}: ${card.type}.${param}`).toBeDefined()
        }
      }
    }
  })

  it.each(CURATED.filter(isSynthetic))(
    '$title runs, and its focus produces something',
    async (spec) => {
      const sched = mockScheduler(source)
      await sched.run(exampleGraph(spec), { mode: 'full' })
      expect(sched.info(spec.focus).state, spec.focus).toBe('ok')
      const outputs = sched.outputs(spec.focus) ?? {}
      expect(Object.keys(outputs).length).toBeGreaterThan(0)
      for (const [port, value] of Object.entries(outputs)) {
        expect(sizeOf(value), `${spec.focus}.${port} is empty`).toBeGreaterThan(0)
      }
    },
  )
})
