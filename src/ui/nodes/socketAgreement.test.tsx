// @vitest-environment jsdom

/**
 * A wire and the two sockets it joins agree about what is flowing.
 *
 * This is one property said once, and it exists because saying it twice is how it broke. A
 * wire takes the *inferred* type of the output it leaves; an output socket did too; an input
 * socket took the port's **declared** type. Every port typed `any` therefore drew grey while
 * everything around it drew the colour of what was actually in it — Skeletons out of a
 * Skeletons card (green) into a `Neurons` input (grey), out of `Matching` (green), into
 * `Input 2` (grey). No single socket was wrong and the chain was unreadable.
 *
 * Asserted over every edge of a real graph rather than over the pair that was reported, since
 * the next `any` port will be somebody else's node. jsdom performs no layout and applies no
 * CSS, so what is read is `data-family` and `data-shape` — which is the whole of what the
 * stylesheet is handed, and `socketStyle.test.ts` holds the other half of the mapping.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { demoWorkflow } from '../../wizard/build'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 420, height: 300 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().closeStartPage()
    // The geometry chain: a Dataset, a search, Skeletons, a 3D View. Geometry is where this
    // failed, because it is where `any` ports are — the type system cannot say "skeletons,
    // meshes or points", so those nodes declare `any` and let validation refuse.
    useGraphStore.getState().loadGraph(demoWorkflow('morphology'))
  })
})

afterEach(cleanup)

/** `{ family, shape }` for one end of one wire, read off the rendered handle. */
function socketOf(nodeId: string, portId: string, side: 'source' | 'target') {
  const node = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)
  const handle = node?.querySelector(
    `.socket.react-flow__handle-${side === 'source' ? 'right' : 'left'}[data-handleid="${portId}"]`,
  ) as HTMLElement | null
  if (!handle) return undefined
  return { family: handle.dataset.family, shape: handle.dataset.shape }
}

/**
 * The three nodes whose ports are declared `any`, hung off the demo's Skeletons card.
 *
 * The morphology demo alone cannot show any of this: every port in it declares exactly the type
 * it gets, so the whole file passes with the bug in place. These are the nodes the report named,
 * and they are `any` because the type system cannot say "skeletons, meshes or points" — they
 * refuse in `validate` instead. Returns the ids, in the order they were added.
 */
function appendAnyChain(): { skeletons: string; added: [string, string][] } {
  const skeletons = useGraphStore
    .getState()
    .graph.nodes.find((n) => n.type === 'neuron.skeletons')
  if (!skeletons) throw new Error('no Skeletons card in the morphology demo')
  const added: [string, string][] = []
  act(() => {
    let y = 600
    for (const [type, port] of [
      ['neuron.splitNeurons', 'in'],
      ['neuron.mirror', 'in'],
      ['neuron.stack', 'in1'],
    ] as const) {
      const id = useGraphStore.getState().addNode(type, { x: 900, y: (y += 220) })
      useGraphStore.getState().connect({
        source: skeletons.id,
        sourceHandle: 'skeletons',
        target: id,
        targetHandle: port,
      })
      added.push([id, port])
    }
  })
  return { skeletons: skeletons.id, added }
}

describe('the two ends of a wire', () => {
  it('are drawn as the same type, on every wire in the graph', async () => {
    // Built onto the demo rather than over it bare: without an `any` port in the graph this
    // assertion is true whatever the card does, which is how it would come to pass for the
    // wrong reason.
    appendAnyChain()
    render(<App />)
    const { graph } = useGraphStore.getState()
    expect(graph.edges.length).toBeGreaterThan(0)

    await waitFor(() => {
      if (!document.querySelector('.socket')) throw new Error('no sockets yet')
    })

    const seen: string[] = []
    for (const edge of graph.edges) {
      const from = socketOf(edge.source, edge.sourceHandle, 'source')
      const to = socketOf(edge.target, edge.targetHandle, 'target')
      // A card can be off-screen or folded; only compare the pairs actually drawn.
      if (!from || !to) continue
      seen.push(`${edge.source}.${edge.sourceHandle} -> ${edge.target}.${edge.targetHandle}`)
      expect(to, seen.at(-1)).toEqual(from)
    }
    expect(seen.length, 'no wire had both ends drawn').toBeGreaterThan(0)
  })

  /*
   * The reported chain, and the only shape that can show this: three nodes whose ports are
   * declared `any`, because the type system cannot say "skeletons, meshes or points" and they
   * refuse in `validate` instead. The morphology demo above has none — every port in it
   * declares the type it gets — so it passes either way and cannot stand in for this.
   */
  it('draws an `any` port as the geometry reaching it, not as the `any` it declares', async () => {
    // The reported chain exactly: Skeletons into Split Neurons, Mirror Neurons and Stack
    // Neurons, all three of which type that port `any`.
    const { skeletons, added } = appendAnyChain()
    render(<App />)
    await waitFor(() => {
      for (const [id, port] of added)
        if (!socketOf(id, port, 'target')) throw new Error('drawing')
    })

    // Green circle to green circle. `geometry` rather than `dataset`: the two share a hue by
    // `colors.ts`' decision, and `familyColorVar` is where that is said, not here.
    const geometry = { family: 'geometry', shape: 'circle' }
    expect(socketOf(skeletons, 'skeletons', 'source')).toEqual(geometry)
    for (const [id, port] of added) expect(socketOf(id, port, 'target'), id).toEqual(geometry)
  })

  /*
   * The fallback half, and what it draws changed once the declaration had something to say.
   *
   * It used to be the grey ring, which is `any`'s — correct while `any` was the whole of what
   * `Stack Neurons` could declare, and a claim the node does not make now that `PortDef.kinds`
   * exists: this socket takes skeletons, meshes or points and nothing else. A violet **ring**,
   * so the family reads across the card while the shape still says nothing has arrived — a
   * violet *circle* is Skeletons, which is a different statement.
   *
   * The ring is the one shape the geometry family had not spent, which is why `Geometries` cost
   * no seventh hue; `socketStyle.ts` carries that argument and `theme.css` carries the
   * measurement behind it.
   */
  it('draws an unwired port as the family it accepts, which is the whole of the fallback', async () => {
    // Nothing is flowing into `in2`, so there is nothing to report and the declaration stands.
    // Without this the rule reads as "inputs are inferred", which would leave an unwired port
    // with no type at all.
    appendAnyChain()
    render(<App />)
    const stack = useGraphStore.getState().graph.nodes.find((n) => n.type === 'neuron.stack')!
    await waitFor(() => {
      if (!socketOf(stack.id, 'in2', 'target')) throw new Error('drawing')
    })
    expect(socketOf(stack.id, 'in2', 'target')).toEqual({ family: 'geometry', shape: 'ring' })
  })
})
