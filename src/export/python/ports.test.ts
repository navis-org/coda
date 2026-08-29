/**
 * Every port id an emitter names must exist on the node it emits.
 *
 * This is the failure mode the emitter registry invites and the one `coverage.test.ts` cannot
 * see: an emitter is keyed by node type but addresses its ports by *string*, so a definition's
 * port called `neurons` read as `in` type-checks, lints, produces valid Python, and reports
 * "nothing is wired to this Profile" for a node that is plainly wired on the canvas. Nothing
 * fails; the cell is just quietly wrong for every graph ever exported.
 *
 * So the emitters are run against a context that records what they ask for and answers every
 * request, which drives each one past its own not-wired guards and into the body where the
 * output ports are named.
 */

import { describe, expect, it } from 'vitest'

import { allNodeDefs } from '../../core/registry'
import { defaultParams } from '../../core/node'
import '../../nodes'
import './exporter'
import { getEmitter } from './registry'
import type { EmitContext } from './types'
import { allInputPorts, allOutputPorts } from '../../core/ports'

describe('emitter port ids', () => {
  it('names only ports the definition declares', () => {
    const wrong: string[] = []

    for (const def of allNodeDefs()) {
      const emit = getEmitter(def.type)
      if (!emit) continue

      // At `max`: an emitter naming a port that only exists at a higher arity is still
      // naming a real port, and this check is about typos rather than about one node's count.
      const inputs = new Set(allInputPorts(def).map((p) => p.id))
      const outputs = new Set(allOutputPorts(def).map((p) => p.id))
      const askedIn: string[] = []
      const askedOut: string[] = []

      const ctx: EmitContext = {
        node: { id: 'n', type: def.type, position: { x: 0, y: 0 }, params: {} },
        def,
        params: defaultParams(def),
        name: 'node',
        // Answer everything: a guard that short-circuits hides the rest of the body, which is
        // exactly where the output ports get named.
        input: (portId) => {
          askedIn.push(portId)
          return 'upstream'
        },
        wired: (portId) => {
          askedIn.push(portId)
          return 'upstream'
        },
        output: (portId) => {
          askedOut.push(portId)
          return 'result'
        },
        inputType: () => undefined,
        schema: () => undefined,
        attributes: () => undefined,
        column: (paramId) => {
          const p = (def.params ?? []).find((q) => q.id === paramId)
          return p && p.kind === 'column' ? 'someColumn' : undefined
        },
        columns: () => ['someColumn'],
        require: () => {},
        helper: () => {},
        todo: () => [],
        note: () => [],
      }

      try {
        emit(ctx)
      } catch {
        // A throw is the walk's problem, not this test's; the ids asked for before it still
        // count and are checked below.
      }

      for (const id of askedIn) {
        if (!inputs.has(id)) {
          wrong.push(
            `${def.type}: reads input "${id}", which it does not have ` +
              `(has ${[...inputs].map((i) => `"${i}"`).join(', ') || 'no inputs'})`,
          )
        }
      }
      for (const id of askedOut) {
        if (!outputs.has(id)) {
          wrong.push(
            `${def.type}: writes output "${id}", which it does not have ` +
              `(has ${[...outputs].map((o) => `"${o}"`).join(', ') || 'no outputs'})`,
          )
        }
      }
    }

    expect(wrong).toEqual([])
  })
})
