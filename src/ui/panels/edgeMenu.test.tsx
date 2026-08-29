// @vitest-environment jsdom

/**
 * The link's right-click menu.
 *
 * Rendered directly rather than reached through the canvas: React Flow draws no wires for nodes
 * jsdom never measured, so there is nothing to right-click in a mounted editor. What that leaves
 * testable is the part that carries the risk anyway — a menu whose only item is destructive has
 * to be about the link the user meant, and on a dense graph the wire under the pointer often is
 * not. Hence the header, and hence these assertions on it.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage } from '../../test/jsdomStubs'
import { EdgeContextMenu } from './EdgeContextMenu'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

/** find → filter, the link under test being the one into the filter. */
function twoNodes() {
  const store = useGraphStore.getState()
  const find = store.addNode('neuron.findNeurons', { x: 0, y: 0 })
  const filter = store.addNode('core.filterTable', { x: 200, y: 0 })
  store.connect({ source: find, sourceHandle: 'neurons', target: filter, targetHandle: 'in' })
  return { find, filter, link: useGraphStore.getState().graph.edges[0]! }
}

beforeEach(() => {
  clearStorage()
  useGraphStore.getState().newGraph()
})

afterEach(cleanup)

describe('EdgeContextMenu', () => {
  it('names both ends of the link it is about', () => {
    const { link } = twoNodes()
    render(
      <EdgeContextMenu screenPosition={{ x: 10, y: 10 }} edgeId={link.id} onClose={() => {}} />,
    )

    // Node labels, so the menu reads as "this wire" rather than "some wire".
    expect(screen.getByText('Find Neurons')).toBeTruthy()
    expect(screen.getByText('Filter Table')).toBeTruthy()
    // Port labels, which is what distinguishes two wires between the same pair of nodes.
    expect(screen.getByText('Neurons')).toBeTruthy()
  })

  it('follows a renamed node, since that is the name on screen', () => {
    const { find, link } = twoNodes()
    useGraphStore.getState().renameNode(find, 'LC4 sweep')
    render(
      <EdgeContextMenu screenPosition={{ x: 10, y: 10 }} edgeId={link.id} onClose={() => {}} />,
    )

    expect(screen.getByText('LC4 sweep')).toBeTruthy()
    expect(screen.queryByText('Find Neurons')).toBeNull()
  })

  it('deletes the link and closes', () => {
    const { link } = twoNodes()
    let closed = false
    render(
      <EdgeContextMenu
        screenPosition={{ x: 10, y: 10 }}
        edgeId={link.id}
        onClose={() => {
          closed = true
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Delete link/ }))

    expect(useGraphStore.getState().graph.edges).toHaveLength(0)
    expect(useGraphStore.getState().graph.nodes).toHaveLength(2)
    expect(closed).toBe(true)
  })

  /**
   * The store outlives the menu — an undo elsewhere, or a node deleted while the menu is open,
   * takes the edge with it. Rendering nothing beats rendering a Delete button for a link that
   * is already gone.
   */
  it('renders nothing once its link no longer exists', () => {
    const { link } = twoNodes()
    useGraphStore.getState().deleteEdges([link.id])
    const { container } = render(
      <EdgeContextMenu screenPosition={{ x: 10, y: 10 }} edgeId={link.id} onClose={() => {}} />,
    )

    expect(container.querySelector('.context-menu')).toBeNull()
  })
})
