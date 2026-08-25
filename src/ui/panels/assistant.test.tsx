// @vitest-environment jsdom

/**
 * The assistant drawer, driven end to end against a stubbed API.
 *
 * The whole loop is exercised — ask, reply, `applyPlan`, commit — because the panel's job is
 * exactly to join those, and each seam has a failure that looks like something else. A plan
 * that lands but is not committed reads as the model having done nothing; a refusal that is
 * committed anyway reads as the graph corrupting itself; an Undo offered against a stale
 * message quietly takes back somebody's later work.
 *
 * The network is the only thing faked. The store, the applier and the node registry are real.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyGraph } from '../../core/graph'
import { messagesReply, stubFetch } from '../../data/ai/fixture'
import { resetCredentials, setKey } from '../../data/ai/credentials'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import { resetAssistantChat } from '../assistantChat'
import { AssistantPanel } from './AssistantPanel'

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

/** A plan in the shape the model actually emits it — params as a list of pairs. */
const PIPELINE = JSON.stringify({
  summary: 'Charted the LC4 neurons.',
  add: [
    { ref: 'ds', type: 'dataset.mock.hemibrain', params: [], title: '' },
    {
      ref: 'find',
      type: 'neuron.findNeurons',
      params: [{ param: 'typePattern', value: 'LC4' }],
      title: '',
    },
    { ref: 'table', type: 'out.table', params: [], title: '' },
  ],
  remove: [],
  setParams: [],
  connect: [
    { from: { node: 'ds', port: 'dataset' }, to: { node: 'find', port: 'dataset' } },
    { from: { node: 'find', port: 'neurons' }, to: { node: 'table', port: 'in' } },
  ],
  disconnect: [],
})

/** Structurally valid JSON, but a wire the type system refuses. */
const BAD_WIRE = JSON.stringify({
  summary: 'A pipeline that does not fit.',
  add: [
    { ref: 'ds', type: 'dataset.mock.hemibrain', params: [], title: '' },
    { ref: 'filter', type: 'core.filter', params: [], title: '' },
  ],
  remove: [],
  setParams: [],
  connect: [{ from: { node: 'ds', port: 'dataset' }, to: { node: 'filter', port: 'in' } }],
  disconnect: [],
})

/** Answer each request in turn, so a repair round can be given a different reply. */
function stubReplies(...texts: string[]): { calls: number } {
  const recorded = stubFetch(
    (name, value) => vi.stubGlobal(name, vi.fn(value as never)),
    texts.map(messagesReply),
  )
  return {
    get calls() {
      return recorded.length
    },
  }
}

/**
 * Ask, and wait for the turn to actually finish.
 *
 * One `act` flush is not enough: the panel `await import()`s the converse module, and the very
 * first call in a run pays for that resolution — so an assertion straight after the click saw
 * an unchanged graph, but only in whichever test happened to run first. Waiting on the busy
 * state is the honest signal that the whole loop has completed.
 */
const ask = async (text: string) => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
  })
  await waitFor(() => expect(screen.queryByText('Thinking…')).toBeNull())
}

beforeEach(() => {
  resetAssistantChat()
  resetCredentials()
  setKey('anthropic', 'sk-ant-test')
  useGraphStore.setState({
    graph: emptyGraph(),
    past: [],
    future: [],
    selection: [],
    panels: { inspector: false, minimap: false, assistant: true, style: true },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetAssistantChat()
  resetCredentials()
})

const graph = () => useGraphStore.getState().graph

describe('the drawer', () => {
  it('renders nothing at all when closed, rather than an empty strip', () => {
    // The grid row is `auto`, so an element that merely collapsed would still reserve its
    // borders and padding across the full width.
    act(() => useGraphStore.getState().togglePanel('assistant'))
    const { container } = render(<AssistantPanel />)
    expect(container.querySelector('.assistant')).toBeNull()
  })

  it('says what to do when there is no key, and does not offer the box', () => {
    resetCredentials()
    render(<AssistantPanel />)

    expect(screen.getByText(/Connections/)).not.toBeNull()
    expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(true)
  })
})

describe('asking for a change', () => {
  it('applies the plan to the real graph and reports what it did', async () => {
    stubReplies(PIPELINE)
    render(<AssistantPanel />)

    await ask('chart the LC4 neurons')

    expect(graph().nodes).toHaveLength(3)
    expect(graph().edges).toHaveLength(2)
    await waitFor(() => expect(screen.getByText('Charted the LC4 neurons.')).not.toBeNull())
    // The tally is the account of the edit the canvas cannot give in words.
    expect(screen.getByText(/3 nodes/)).not.toBeNull()
    expect(screen.getByText(/2 wires/)).not.toBeNull()
  })

  it('keeps what was asked in the transcript', async () => {
    stubReplies(PIPELINE)
    render(<AssistantPanel />)
    await ask('chart the LC4 neurons')

    expect(screen.getByText('chart the LC4 neurons')).not.toBeNull()
    // And clears the box, so the next question starts empty.
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
  })

  it('lands as one undo step, and offers it', async () => {
    stubReplies(PIPELINE)
    render(<AssistantPanel />)
    await ask('chart the LC4 neurons')

    expect(useGraphStore.getState().past).toHaveLength(1)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    })
    expect(graph().nodes).toHaveLength(0)
  })

  it('withdraws Undo once the edit is no longer the one on top', async () => {
    /*
     * `undo()` is global. A button left on an older message would take back whatever the user
     * did afterwards, which is the worst kind of destructive: it looks like it is undoing the
     * thing described beside it.
     */
    stubReplies(PIPELINE)
    render(<AssistantPanel />)
    await ask('chart the LC4 neurons')
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeNull()

    act(() => {
      useGraphStore.getState().addNode('core.filter', { x: 0, y: 0 })
    })

    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})

describe('when the plan does not fit', () => {
  it('retries once, silently, and says nothing about the round that failed', async () => {
    // A refusal names the plan elements the model just wrote, so one repair round is worth
    // spending without troubling the user. Measured: repairs are rare and the first one works.
    const counter = stubReplies(BAD_WIRE, PIPELINE)
    render(<AssistantPanel />)

    await ask('build me something')

    expect(counter.calls).toBe(2)
    expect(graph().nodes).toHaveLength(3)
    await waitFor(() => expect(screen.getByText('Charted the LC4 neurons.')).not.toBeNull())
    expect(screen.queryByText(/did not fit/)).toBeNull()
  })

  it('gives up after the retry, changes nothing, and names the problem', async () => {
    const counter = stubReplies(BAD_WIRE, BAD_WIRE)
    render(<AssistantPanel />)

    await ask('build me something')

    expect(counter.calls).toBe(2)
    expect(graph().nodes).toHaveLength(0)
    expect(useGraphStore.getState().past).toHaveLength(0)
    await waitFor(() => expect(screen.getByText(/nothing was changed/)).not.toBeNull())
    expect(screen.getByText(/does not fit/)).not.toBeNull()
  })

  it('reports a reply that was not a plan without touching the graph', async () => {
    stubReplies('I would rather not.')
    render(<AssistantPanel />)

    await ask('do something odd')

    expect(graph().nodes).toHaveLength(0)
    await waitFor(() => expect(screen.getByText(/not JSON/)).not.toBeNull())
  })
})

describe('a wait that has not ended', () => {
  /**
   * A request that hangs until it is called off — which is a local model on a slow machine,
   * near enough. The abort has to survive as a `DOMException` all the way from here to the
   * panel or the cancel is reported as a failure.
   */
  function stubHanging(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            )
          }),
      ),
    )
  }

  it('can be called off, and says nothing was changed', async () => {
    /*
     * The reported symptom was "goes to Thinking and never returns anything" — against a model
     * that would have answered in about five minutes. Whatever else is true of that wait, the
     * only way out of it used to be reloading the page and losing the transcript.
     */
    stubHanging()
    render(<AssistantPanel />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'find LC4 neurons and chart their strongest partners' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    })
    expect(screen.queryByText('Thinking…')).not.toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    })

    await waitFor(() => expect(screen.getByText(/Stopped/)).not.toBeNull())
    expect(graph().nodes).toHaveLength(0)
    // A cancel is not a failure: reporting it in the error tone would have the panel blame the
    // model for something the user did.
    expect(document.querySelector('[data-tone="error"]')).toBeNull()
  })

  it('leaves the composer usable again afterwards', async () => {
    // Busy is what disables Ask, so a stop that did not clear it would lock the panel for good.
    stubHanging()
    render(<AssistantPanel />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'anything' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    })

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'again' } })
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })
})

describe('what the edit left behind', () => {
  it('surfaces an unset picker, since nothing else on screen would', async () => {
    // A Group By downstream of a query cannot have its key chosen before anything has run.
    // That is not a failure — but it is work the user has to finish.
    const withGroupBy = JSON.stringify({
      summary: 'Grouped the connections.',
      add: [
        { ref: 'ds', type: 'dataset.mock.hemibrain', params: [], title: '' },
        { ref: 'find', type: 'neuron.findNeurons', params: [], title: '' },
        { ref: 'g', type: 'core.groupBy', params: [], title: '' },
      ],
      remove: [],
      setParams: [],
      connect: [
        { from: { node: 'ds', port: 'dataset' }, to: { node: 'find', port: 'dataset' } },
        { from: { node: 'find', port: 'neurons' }, to: { node: 'g', port: 'in' } },
      ],
      disconnect: [],
    })
    stubReplies(withGroupBy)
    render(<AssistantPanel />)

    await ask('group the connections')

    await waitFor(() => expect(screen.getByText('Group By')).not.toBeNull())
  })
})

describe('the conversation', () => {
  it('survives the drawer being closed and reopened', async () => {
    // Session-scoped, not component-scoped: a transcript that vanished because you tidied the
    // panel away would not be one.
    stubReplies(PIPELINE)
    const { rerender } = render(<AssistantPanel />)
    await ask('chart the LC4 neurons')

    act(() => useGraphStore.getState().togglePanel('assistant'))
    rerender(<AssistantPanel />)
    expect(screen.queryByText('chart the LC4 neurons')).toBeNull()

    act(() => useGraphStore.getState().togglePanel('assistant'))
    rerender(<AssistantPanel />)
    expect(screen.getByText('chart the LC4 neurons')).not.toBeNull()
  })

  it('clears on request without touching the graph', async () => {
    stubReplies(PIPELINE)
    render(<AssistantPanel />)
    await ask('chart the LC4 neurons')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    })

    expect(screen.queryByText('chart the LC4 neurons')).toBeNull()
    expect(graph().nodes).toHaveLength(3)
  })
})
