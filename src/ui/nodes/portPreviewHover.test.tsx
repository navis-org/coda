// @vitest-environment jsdom

/**
 * The hover itself: which sockets offer a preview, when, and the four ways it goes away.
 *
 * Driven through the real editor rather than against the component, because three of the
 * properties here are about the card it is on — that an *input* socket offers nothing, that a
 * port with no cached value offers nothing, and that a press (which on a socket is a wire drag
 * starting) takes the panel away and keeps it away.
 *
 * jsdom performs no layout, so where the panel lands is not asserted here; that is
 * `hoverPlacement.test.ts`, which is why the arithmetic is a pure function in the first place.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { searchFor } from '../../test/findNeurons'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().newGraph()
  })
})

afterEach(cleanup)

function panel() {
  return document.querySelector('.port-preview')
}

/** `pointerenter` is delegated off `pointerover` by React, which is what a real mouse sends. */
function pointer(target: Element, type: 'pointerover' | 'pointerout' | 'pointerdown') {
  const event = new MouseEvent(type, { bubbles: true })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  fireEvent(target, event)
}

/** The side of a port row carrying one named socket. */
function side(nodeId: string, portId: string, kind: 'in' | 'out') {
  const handle = document.querySelector(
    `.react-flow__node[data-id="${nodeId}"] .socket[data-handleid="${portId}"]`,
  )
  return handle?.closest(`.port-row__side--${kind}`) ?? undefined
}

/** A Dataset → Find Neurons chain, run, so both cards hold a real cached value. */
async function ranChain() {
  const ds = useGraphStore.getState().addNode('neuron.dataset', { x: 0, y: 0 })
  const find = useGraphStore.getState().addNode('neuron.findNeurons', { x: 240, y: 0 })
  act(() => {
    const s = useGraphStore.getState()
    s.setParam(ds, 'dataset', 'optic-lobe-mini')
    s.connect({ source: ds, sourceHandle: 'dataset', target: find, targetHandle: 'dataset' })
    // Find Neurons asking nothing answers nothing, so the card is given a row to ask.
    s.setParam(find, 'filters', searchFor({ type: 'LC.*' }).filters)
  })
  await act(async () => {
    await useGraphStore.getState().runAll()
  })
  return { ds, find }
}

describe('the output port preview', () => {
  it('opens on an output socket after a rest, and draws the rows on the wire', async () => {
    render(<App />)
    const { find } = await ranChain()
    const out = await waitFor(() => {
      const found = side(find, 'neurons', 'out')
      if (!found) throw new Error('no output socket yet')
      return found
    })

    pointer(out, 'pointerover')
    // Not immediately: a pointer crossing the eight sockets down a card's side must not open
    // eight panels on the way past.
    expect(panel()).toBeNull()

    await waitFor(() => expect(panel()).not.toBeNull())
    const text = panel()!.textContent ?? ''
    // The port it belongs to, the line the card's own footer draws, and real column names.
    expect(text).toContain('Neurons')
    expect(text).toContain('rows')
    expect(text).toContain('neuronId')
    // And real data under those headers — the whole point of the feature, and the half a schema
    // readout has never been able to answer.
    expect(panel()!.querySelectorAll('.port-preview__table tbody tr').length).toBeGreaterThan(0)

    pointer(out, 'pointerout')
    await waitFor(() => expect(panel()).toBeNull())
  })

  it('says nothing at all where the node has not run', async () => {
    /*
     * The decision the whole component is shaped around. A port's value exists only once its
     * node has run, and hovering may not cause one — a panel that fetched, or that offered a Run
     * button beside every socket, is a request per hover at a shared production server. So the
     * hover is silent and the socket's own `title` is what the reader gets.
     */
    render(<App />)
    const find = useGraphStore.getState().addNode('neuron.findNeurons', { x: 0, y: 0 })
    const out = await waitFor(() => {
      const found = side(find, 'neurons', 'out')
      if (!found) throw new Error('no output socket yet')
      return found
    })

    pointer(out, 'pointerover')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(panel()).toBeNull()
    // And the tooltip that was there before this feature is still there.
    const socket = out.querySelector('.socket')
    expect(socket?.getAttribute('title')).toContain('Neurons')
  })

  it('offers nothing on an input socket', async () => {
    // Outputs only: an input's value is the upstream output's, which is one socket away and
    // already answered there.
    render(<App />)
    const { find } = await ranChain()
    const input = await waitFor(() => {
      const found = side(find, 'dataset', 'in')
      if (!found) throw new Error('no input socket yet')
      return found
    })

    pointer(input, 'pointerover')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(panel()).toBeNull()
  })

  it('gets out of the way of a wire drag, and stays out until the pointer leaves', async () => {
    render(<App />)
    const { find } = await ranChain()
    const out = await waitFor(() => {
      const found = side(find, 'neurons', 'out')
      if (!found) throw new Error('no output socket yet')
      return found
    })

    pointer(out, 'pointerover')
    await waitFor(() => expect(panel()).not.toBeNull())

    // A press on a socket is a connection starting. The panel goes...
    pointer(out, 'pointerdown')
    expect(panel()).toBeNull()

    // ...and does not come back while the pointer is still on this socket, which is where it
    // would sit over the port being dragged to.
    pointer(out, 'pointerover')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(panel()).toBeNull()

    // Leaving re-arms it.
    pointer(out, 'pointerout')
    pointer(out, 'pointerover')
    await waitFor(() => expect(panel()).not.toBeNull())
  })

  it('closes on a right-click, which would otherwise open a menu underneath it', async () => {
    render(<App />)
    const { find } = await ranChain()
    const out = await waitFor(() => {
      const found = side(find, 'neurons', 'out')
      if (!found) throw new Error('no output socket yet')
      return found
    })
    pointer(out, 'pointerover')
    await waitFor(() => expect(panel()).not.toBeNull())

    fireEvent.contextMenu(document.body)
    await waitFor(() => expect(panel()).toBeNull())
  })
})
