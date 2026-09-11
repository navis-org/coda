/**
 * The stack export's decision, asked of the plan directly — on the real definitions, since which
 * sockets exist is the thing it must not re-derive.
 *
 * The fixture takes one branch per node: a named source column over two or three inputs. What it
 * cannot show is a blank source column, an unnamed input's label, or a neuron stack whose first
 * input is points.
 */

import { describe, expect, it } from 'vitest'

import type { CodaType } from '../../core/types'
import { stackLabelAt } from '../../nodes/lib/tableOps'
import { stackPlan } from './stack'
import { fakeNeutralContext } from './testContext'

const POINTS = { kind: 'points' } as CodaType
const SKELETONS = { kind: 'skeletons' } as CodaType
const WIRES = { in1: 'a', in2: 'b' }

describe('stackPlan', () => {
  it('adds no source column for a blank name, and labels an unnamed input as the node does', () => {
    const blank = stackPlan(
      fakeNeutralContext({ type: 'core.stack', params: { sourceColumn: '  ' }, wires: WIRES }),
      false,
    )
    expect(blank).toEqual({ as: 'frames', inputs: ['a', 'b'] })

    const named = stackPlan(
      fakeNeutralContext({
        type: 'core.stack',
        params: { sourceColumn: 'origin', label1: 'Direct', label2: '' },
        wires: WIRES,
      }),
      false,
    )
    expect(named.source).toEqual({ column: 'origin', labels: ['Direct', stackLabelAt([], 2)] })
  })

  it('reads every socket the stored arity declares, wired or not', () => {
    const plan = stackPlan(
      fakeNeutralContext({ type: 'core.stack', params: { inputCount: 3 }, wires: WIRES }),
      false,
    )
    expect(plan.inputs).toEqual(['a', 'b', 'unwired_in3'])
  })

  it('stacks neurons as objects, except when the first input is points', () => {
    const as = (types: Record<string, CodaType>) =>
      stackPlan(fakeNeutralContext({ type: 'neuron.stack', wires: WIRES, types }), true).as
    expect(as({ in1: POINTS, in2: SKELETONS })).toBe('frames')
    expect(as({ in1: SKELETONS, in2: POINTS })).toBe('neurons')
    // Unknown takes the neuron branch, which is what the node is overwhelmingly used for.
    expect(as({})).toBe('neurons')
  })
})
