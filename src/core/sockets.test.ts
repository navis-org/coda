/**
 * `PortDef.kinds`: the mechanism, what registration refuses, and the one sweep over the real
 * registry that keeps the declarations from drifting away from the predicates they came from.
 *
 * Everything about the *mechanism* is driven through test-only registrations, on
 * `ports.test.ts`' reasoning — these are properties of the field rather than of whichever node
 * uses it. The sweep at the bottom is the exception and has to be: the whole failure this field
 * fixes was a set of ports whose real answer lived only in a `validate` nobody had connected to
 * the socket, and a new `T.any()` port added next month reintroduces it in silence.
 */

import { describe, expect, it } from 'vitest'

import '../nodes'
import type { CodaGraph } from './graph'
import { addEdge, addNode, emptyGraph } from './graph'
import { node } from '../test/graph'
import { checkConnection, inferGraph } from './inference'
import { resolvedSocket, socketAccepts, socketLabel, socketTier } from './sockets'
import { GEOMETRY_KINDS, T } from './types'
import { listableNodeDefs, registerNode, requireNodeDef } from './registry'
import { allInputPorts, allOutputPorts } from './ports'

const GEOMETRY = { type: T.any(), kinds: GEOMETRY_KINDS }
const SPLIT = { type: T.any(), kinds: ['skeletons', 'meshes'] as const }

/**
 * The rule three readers dropped, in the one place it now lives.
 *
 * `outputTypesFor` seeds a port's inferred type from its *declaration* before asking
 * `inferOutputs`, and a passthrough's declaration is `T.any()` — so an unwired `Mirror Neurons`
 * publishes a perfectly **truthy** `any`, and `resolved ?? declaration` keeps the wrong one. That
 * cost three separate bugs from one line of reasoning: the wire check let it onto a `Dataset`
 * socket, the in-flight wire drew grey, and the backwards drag dimmed nothing. Two were reported
 * together; the third was found reading the fix.
 *
 * Asserted here rather than through the three callers because two of them need a live React Flow
 * drag, which jsdom cannot produce — this is the whole of what they share, and each is one line
 * over it.
 */
describe('resolvedSocket', () => {
  it('keeps the declaration when inference answers `any`, which is not an answer', () => {
    expect(resolvedSocket(GEOMETRY, T.any())).toEqual(GEOMETRY)
    expect(resolvedSocket(GEOMETRY, undefined)).toEqual(GEOMETRY)
  })

  it('hands over to a resolved kind the moment there is one', () => {
    expect(resolvedSocket(GEOMETRY, T.skeletons())).toEqual({ type: T.skeletons() })
  })

  it('answers Any for a socket that declares nothing, rather than an absent type', () => {
    expect(resolvedSocket(undefined, undefined)).toEqual({ type: T.any() })
    expect(resolvedSocket({ type: T.any() }, T.any())).toEqual({ type: T.any() })
  })

  // The composition the two dimming arms and `checkConnection` each make.
  it('is what makes a passthrough output refuse a socket it cannot feed', () => {
    expect(socketAccepts(resolvedSocket(GEOMETRY, T.any()), { type: T.dataset() })).toBe(false)
    expect(socketAccepts(resolvedSocket(GEOMETRY, T.any()), { type: T.skeletons() })).toBe(true)
  })
})

describe('socketAccepts', () => {
  it('refuses a kind outside the declared set, which `isAssignable` waves through', () => {
    expect(socketAccepts({ type: T.linkage() }, GEOMETRY)).toBe(false)
    expect(socketAccepts({ type: T.skeletons() }, GEOMETRY)).toBe(true)
  })

  it('lets an unresolved wire through — unknown is not a refusal', () => {
    expect(socketAccepts({ type: T.any() }, GEOMETRY)).toBe(true)
  })

  /*
   * Both ends may declare. Dragging backwards out of a geometry port and dropping on canvas asks
   * this question with the *set* on the left, and a `Split Neurons` output overlaps it in two of
   * three kinds — which is an overlap, not a subset, and has to be enough.
   */
  it('asks for an overlap when both ends declare, not containment', () => {
    expect(socketAccepts(SPLIT, GEOMETRY)).toBe(true)
    expect(socketAccepts(GEOMETRY, SPLIT)).toBe(true)
    expect(socketAccepts({ type: T.any(), kinds: ['table'] }, GEOMETRY)).toBe(false)
  })

  it('never admits a pair `isAssignable` refuses', () => {
    expect(socketAccepts({ type: T.matrix() }, { type: T.table() })).toBe(false)
    // Nor does a declared set rescue one: the kind relation is still the floor.
    expect(socketAccepts({ type: T.matrix() }, { type: T.table(), kinds: ['matrix'] })).toBe(
      false,
    )
  })

  /*
   * The rule a declaration can get wrong with nothing failing: the set is intersected with what
   * the wire carries *before* `isAssignable`'s widening, so a set meaning "anything tabular" has
   * to name `neurons` as well as `table`. `ITERABLE_KINDS` does; a set that did not would refuse
   * every neuron table at a socket built to step through one.
   */
  it('matches the kind as it arrives, never as the port would widen it', () => {
    const tables = { type: T.any(), kinds: ['table'] as const }
    expect(socketAccepts({ type: T.neurons() }, tables)).toBe(false)
    expect(
      socketAccepts({ type: T.neurons() }, { type: T.any(), kinds: ['table', 'neurons'] }),
    ).toBe(true)
  })
})

describe('socketTier', () => {
  it('ranks the kind itself, then a widening, then a named union, then a bare any', () => {
    const wire = { type: T.neurons() }
    expect(socketTier({ type: T.neurons() }, wire)).toBe(0)
    expect(socketTier({ type: T.table() }, wire)).toBe(1)
    expect(socketTier({ type: T.any(), kinds: ['table', 'neurons'] }, wire)).toBe(2)
    expect(socketTier({ type: T.any() }, wire)).toBe(3)
  })

  /*
   * A wire whose own type is `any` still ranks, off its declared set — which is what a backwards
   * drag out of a geometry port is. Without this the six producers it can reach come back in
   * registry order with a Skeletons node no better placed than a passthrough.
   */
  it('ranks against a declared set on the wire, not just on the port', () => {
    expect(socketTier({ type: T.skeletons() }, GEOMETRY)).toBe(0)
    expect(socketTier({ type: T.table() }, GEOMETRY)).toBe(1)
  })
})

describe('socketLabel', () => {
  it('names a set that has a name, and only a set that has one', () => {
    expect(socketLabel(GEOMETRY)).toBe('Geometries')
    // Split Neurons declines points and still says Geometries: a subset draws as the whole.
    expect(socketLabel(SPLIT)).toBe('Geometries')
    // For Each steps through tables too, so no family names it and the honest answer is Any.
    expect(
      socketLabel({ type: T.any(), kinds: ['table', 'neurons', 'skeletons', 'meshes'] }),
    ).toBe('Any')
    expect(socketLabel({ type: T.any() })).toBe('Any')
  })

  /*
   * The clause that is easy to leave out. An unwired *input* has no resolved type; an unwired
   * output on a passthrough has one and it is `T.any()`, because `inferOutputs` hands back an
   * input type that is not there. Keyed on `resolved !== undefined`, a Mirror card would read
   * Geometries on the left and Any on the right.
   */
  it('treats a resolved `any` as unresolved, which is what a passthrough output is', () => {
    expect(socketLabel(GEOMETRY, T.any())).toBe('Geometries')
    expect(socketLabel(GEOMETRY, T.skeletons())).toBe('Skeletons')
  })
})

describe('registration', () => {
  let n = 0
  const attempt = (port: Record<string, unknown>) => () =>
    registerNode({
      type: `test.kinds${n++}`,
      label: 'Kinds',
      category: 'transform',
      cost: 'cheap',
      inputs: [{ id: 'in', ...port }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

  it('refuses a set beside a concrete type, which would be a second statement that disagrees', () => {
    expect(attempt({ type: T.skeletons(), kinds: ['meshes'] })).toThrow(/only on/)
  })

  it('refuses an empty set, which reads two ways to the two guards beside it', () => {
    expect(attempt({ type: T.any(), kinds: [] })).toThrow(/Omit the field/)
  })

  it('refuses `any` inside the set, which cancels the declaration', () => {
    expect(attempt({ type: T.any(), kinds: ['skeletons', 'any'] })).toThrow(/cancels/)
  })

  it('refuses a repeat', () => {
    expect(attempt({ type: T.any(), kinds: ['skeletons', 'skeletons'] })).toThrow(/repeats/)
  })

  it('refuses `anyKind` beside a concrete type, or beside a kind set', () => {
    expect(attempt({ type: T.skeletons(), anyKind: true })).toThrow(/already says/)
    expect(attempt({ type: T.any(), anyKind: true, kinds: ['skeletons'] })).toThrow(/both/)
  })
})

/**
 * The wire itself, which is where this was reported.
 *
 * `PortDef.kinds` shipped as a declaration and not a constraint — narrow what the palette offers,
 * dim the socket, and leave a hand-drawn wire to the node's own `validate`. That lasted one
 * round: `Mirror Neurons`' output draws as a violet **Geometries** ring and could be dropped
 * straight onto a `Dataset` socket, which is a promise the picture makes and the behaviour broke.
 *
 * The half that made it invisible is the first case below. An unwired passthrough's
 * `inferOutputs` hands back a perfectly truthy `T.any()`, so every reader that took the inferred
 * type and stopped there threw away the only declaration that knew anything — which is why the
 * fix is `resolvedSocket` at the seam rather than a clause in `checkConnection`.
 */
describe('checkConnection reads the declaration, not just the inferred type', () => {
  // `node()` rather than an inline literal: it applies `defaultParams`, so a variadic node
  // resolves the port set it would have on a real canvas rather than at zero arity.
  const graphWith = (...nodes: Array<[string, string]>) =>
    nodes.reduce((g, [id, type]) => addNode(g, node(id, type)), emptyGraph('sockets-test'))
  const check = (g: CodaGraph, from: [string, string], to: [string, string]) =>
    checkConnection(
      g,
      inferGraph(g),
      { nodeId: from[0], portId: from[1] },
      { nodeId: to[0], portId: to[1] },
    )

  it('refuses a geometry passthrough onto a Dataset socket, and says which two', () => {
    const g = graphWith(['m', 'neuron.mirror'], ['sk', 'neuron.skeletons'])
    const refusal = check(g, ['m', 'out'], ['sk', 'dataset'])
    expect(refusal.ok).toBe(false)
    // Not "Any does not fit Dataset": the message names the socket, which is what the card draws.
    expect(refusal.reason).toBe('Geometries does not fit Dataset')
  })

  it('refuses the other direction too', () => {
    const g = graphWith(['cut', 'cluster.cut'], ['m', 'neuron.mirror'])
    expect(check(g, ['cut', 'tree'], ['m', 'in']).reason).toBe(
      'Linkage does not fit Geometries',
    )
  })

  it('still allows the wire the port is for, and the one port that takes anything', () => {
    const g = graphWith(
      ['sk', 'neuron.skeletons'],
      ['m', 'neuron.mirror'],
      ['dl', 'out.download'],
    )
    expect(check(g, ['sk', 'skeletons'], ['m', 'in']).ok).toBe(true)
    expect(check(g, ['m', 'out'], ['dl', 'in']).ok).toBe(true)
  })

  /*
   * Once something real arrives the inferred type takes over, so this stops being about the
   * declaration at all — and the message says `Skeletons`, not `Geometries`.
   */
  it('hands back to the inferred type as soon as one exists', () => {
    let g = graphWith(
      ['sk', 'neuron.skeletons'],
      ['m', 'neuron.mirror'],
      ['sk2', 'neuron.skeletons'],
    )
    g = addEdge(g, { source: 'sk', sourceHandle: 'skeletons', target: 'm', targetHandle: 'in' })
    expect(check(g, ['m', 'out'], ['sk2', 'dataset']).reason).toBe(
      'Skeletons does not fit Dataset',
    )
  })
})

/**
 * The sweep, and the reason it is a sweep rather than four assertions.
 *
 * Nine ports across six nodes were declared `T.any()` because `CodaType` cannot spell their
 * real answer, and every one of them had that answer written down already — as the predicate its
 * own `validate` refuses on. Nothing connected the two, so the palette offered `Mirror Neurons`
 * as the first thing a `Linkage` could feed and the card lit its socket for the drag. A new
 * `T.any()` port added later reintroduces exactly that, and it looks like nothing.
 *
 * The exemption is `PortDef.anyKind` and not an allow-list here, which was the first shape and
 * put a node fact in a test file with an unenforced prose twin in `download.ts`: you could
 * delete the `kinds` off `Mirror Neurons`, add its name to the list, and ship a green build.
 * One node holds it — Download, whose input takes whatever is wired and whose output passes
 * whatever it was given.
 */
describe('every `any` port in the registry says what it means', () => {
  it('declares a kind set, or declares that anything is meant', () => {
    const bare: string[] = []
    for (const def of listableNodeDefs()) {
      for (const port of [...allInputPorts(def), ...allOutputPorts(def)]) {
        if (port.type.kind !== 'any' || port.kinds?.length || port.anyKind) continue
        bare.push(`${def.type}.${port.id}`)
      }
    }
    expect(bare).toEqual([])
  })

  // One node, so a second `anyKind` is a decision somebody makes rather than one that drifts in.
  it('has exactly one node meaning `any` literally', () => {
    const holders = listableNodeDefs()
      .filter((def) =>
        [...allInputPorts(def), ...allOutputPorts(def)].some((port) => port.anyKind),
      )
      .map((def) => def.type)
    expect(holders).toEqual(['out.download'])
  })

  it('draws the four geometry passthroughs as Geometries on both sides', () => {
    for (const type of [
      'neuron.mirror',
      'neuron.xform',
      'neuron.stack',
      'neuron.splitNeurons',
    ]) {
      const def = requireNodeDef(type)
      const any = [...allInputPorts(def), ...allOutputPorts(def)].filter(
        (p) => p.type.kind === 'any',
      )
      expect(any.length, type).toBeGreaterThan(0)
      for (const port of any) expect(socketLabel(port), `${type}.${port.id}`).toBe('Geometries')
    }
  })
})
