// @vitest-environment jsdom

/**
 * The dataset node's body in the real editor.
 *
 * The wiring is what fails silently here: a body that is not registered renders as a bare header,
 * and nothing throws. The caption is the other half — "Latest" is only an honest label while the
 * version it resolves to is visible beside it.
 */

import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { deserializeGraph } from '../../core/graph'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
})

afterEach(cleanup)

function openStarter(nodeType = 'dataset.mock.opticlobe') {
  render(<App />)
  act(() => {
    useGraphStore.getState().loadStarter({ nodeType, label: 'Demo Data' })
  })
}

function datasetCard(): HTMLElement {
  const card = document.querySelector('.dataset-body')?.closest('.coda-node')
  if (!card) throw new Error('no dataset node rendered')
  return card as HTMLElement
}

describe('dataset node body', () => {
  it('renders a preview slot above the fields', async () => {
    openStarter()
    await waitFor(() => expect(document.querySelector('.dataset-preview')).toBeTruthy())
    const body = document.querySelector('.dataset-body')!
    const preview = body.querySelector('.dataset-preview')!
    const fields = body.querySelector('.dataset-body__fields')!
    // Placeholder art for now, but its position is the contract a real rendering inherits.
    expect(
      preview.compareDocumentPosition(fields) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('offers a version dropdown that names what Latest resolves to', async () => {
    openStarter()
    const card = await waitFor(datasetCard)
    const select = within(card).getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('')
    expect([...select.options].map((o) => o.textContent)[0]).toMatch(/Latest \(.+\)/)
  })

  it('shows the resolved dataset id, so the node says what it is about', async () => {
    openStarter()
    const card = await waitFor(datasetCard)
    expect(within(card).getByTitle('optic-lobe-mini')).toBeTruthy()
  })

  it('pins a version when one is picked, and keeps it in the graph', async () => {
    openStarter()
    const card = await waitFor(datasetCard)
    const select = within(card).getByRole('combobox') as HTMLSelectElement
    const pinned = [...select.options].find((o) => o.value)!
    fireEvent.change(select, { target: { value: pinned.value } })

    await waitFor(() => {
      const node = useGraphStore
        .getState()
        .graph.nodes.find((n) => n.type === 'dataset.mock.opticlobe')
      expect(node?.params.version).toBe(pinned.value)
    })
  })

  it('offers no expand button, since there is nothing to enlarge', async () => {
    // A dataset body is a preview and two fields; expanding it fills the screen with whitespace,
    // and its button would sit exactly where a viewer's does.
    const card = await waitFor(() => {
      openStarter()
      return datasetCard()
    })
    expect(within(card).queryByLabelText('Expand output')).toBeNull()
  })

  it('gives the custom node a server field alongside the dataset', async () => {
    openStarter('dataset.neuprint')
    const card = await waitFor(datasetCard)
    expect(within(card).getByTitle(/neuPrint deployment URL/)).toBeTruthy()
    const inputs = card.querySelectorAll('input[type="text"]')
    // Server and dataset, both free text — the escape hatch for a deployment the table has
    // never heard of.
    expect(inputs.length).toBeGreaterThanOrEqual(2)
  })

  describe('the edge-data button', () => {
    it('is the indicator, because an attached edge set has no wire', async () => {
      openStarter()
      await waitFor(() => expect(datasetCard()).toBeTruthy())
      const button = within(datasetCard()).getByRole('button', { name: /Edge data/ })
      expect(button.getAttribute('aria-pressed')).toBe('false')

      const id = useGraphStore
        .getState()
        .graph.nodes.find((n) => n.type.startsWith('dataset.'))!.id
      act(() => {
        useGraphStore.getState().attachEdgeSet(id, { id: 'abc123', name: 'FlyWire 783' })
      })

      /*
       * Pressed, and carrying the set's own name. A card that looked the same either way would be
       * a dataset silently answering connectivity from a file — which is the whole reason this
       * control is an indicator rather than only a way in.
       */
      await waitFor(() => {
        const pressed = within(datasetCard()).getByRole('button', { name: /FlyWire 783/ })
        expect(pressed.getAttribute('aria-pressed')).toBe('true')
      })
    })

    it('opens the panel on the node it belongs to', async () => {
      openStarter()
      await waitFor(() => expect(datasetCard()).toBeTruthy())
      const id = useGraphStore
        .getState()
        .graph.nodes.find((n) => n.type.startsWith('dataset.'))!.id
      fireEvent.click(within(datasetCard()).getByRole('button', { name: /Edge data/ }))
      expect(useGraphStore.getState().edgePanelNode).toBe(id)
    })

    it('is absent on a backend that does not offer one', async () => {
      // CATMAID, by `DatasetBackend.edgeSets` — not a capability gap, a control nobody there is
      // expected to reach for. The button follows the param rather than a second list.
      openStarter('dataset.catmaid.fafb')
      await waitFor(() => expect(datasetCard()).toBeTruthy())
      expect(within(datasetCard()).queryByRole('button', { name: /Edge data/ })).toBeNull()
    })
  })

  it('does not draw a body for a node that has none', async () => {
    openStarter()
    await waitFor(datasetCard)
    const table = [...document.querySelectorAll('.coda-node')].find((n) =>
      n.querySelector('.coda-node__title')?.textContent?.includes('Table'),
    )
    expect(table?.querySelector('.dataset-body')).toBeFalsy()
  })
})

/**
 * What the card says about the population, and what it deliberately does not draw.
 *
 * The checkboxes are `advanced`, so they live in the inspector; the card carries one line naming
 * the filters that are being *applied*. Three things fail silently here. A card that drew nothing
 * would hide the one fact a dataset node exists to state — which neurons everything downstream is
 * about. A line naming a ticked-but-dropped filter would be a false claim about those neurons. And
 * a line built off `param.default` rather than the stored value would report a filter on a graph
 * saved before these params existed, which asked for every `:Neuron`.
 */
describe('the population summary', () => {
  /** A stored hemibrain graph, through the same reader a file or a share link goes through. */
  function hemibrainGraph(params: Record<string, unknown>) {
    return deserializeGraph(
      JSON.stringify({
        version: 1,
        nodes: [{ id: 'ds', type: 'dataset.hemibrain', position: { x: 40, y: 40 }, params }],
        edges: [],
      }),
    ).graph
  }

  async function open(params: Record<string, unknown>): Promise<HTMLElement> {
    render(<App />)
    act(() => {
      useGraphStore.getState().loadGraph(hemibrainGraph({ version: 'v1.2.1', ...params }))
    })
    return waitFor(datasetCard)
  }

  function line(card: HTMLElement): string | undefined {
    return card.querySelector('.dataset-body__population')?.textContent ?? undefined
  }

  it('draws no checkbox on the card — they are inspector-only', async () => {
    const card = await open({ typedOnly: true })
    for (const label of ['Traced only', 'Typed only', 'Superclass only']) {
      expect(within(card).queryByLabelText(label)).toBeNull()
    }
  })

  it('names the filters being applied', async () => {
    expect(line(await open({ typedOnly: true }))).toBe('Using Typed only')
  })

  it('names several, so a reader can see the whole population at a glance', async () => {
    expect(line(await open({ tracedOnly: true, typedOnly: true }))).toBe(
      'Using Traced only · Typed only',
    )
  })

  it('says nothing at all when nothing is narrowing', async () => {
    expect(line(await open({ typedOnly: false }))).toBeUndefined()
  })

  /*
   * What is applied, not what is ticked. hemibrain publishes no `superclass`, so the filter is
   * dropped before the query is built and a card reporting it would be claiming neurons the run
   * does not return. The node's own warning is that box's honest channel.
   */
  it('omits a ticked filter the dataset cannot answer', async () => {
    await open({ superclassOnly: true })
    // Reported until discovery says otherwise — a schema that has not arrived is not a schema
    // without `superclass` in it — and dropped once it lands.
    await waitFor(() => expect(line(datasetCard())).toBeUndefined())
    // The warning naming that box is the node's job rather than the card's, and is pinned in
    // `nodes/dataset/dataset.test.ts`: a *family* node stays quiet until the dataset listing has
    // arrived, and this source has no token.
  })

  /*
   * The half that only breaks on somebody else's file. `deserializeGraph` writes `absentMeans`
   * in, so by the time the card sees the node the third state is gone — without it the line would
   * report `Typed only`, whose declared default on this family is *on*, for a graph that asked
   * for every neuron.
   */
  it('reports nothing for a graph saved before the params existed', async () => {
    render(<App />)
    act(() => {
      useGraphStore.getState().loadGraph(hemibrainGraph({ version: '', refresh: 0 }))
    })
    expect(line(await waitFor(datasetCard))).toBeUndefined()
  })
})
