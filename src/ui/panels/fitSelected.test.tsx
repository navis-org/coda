// @vitest-environment jsdom

/**
 * Fit Selected: the rail button, the `§` key and the palette command, in the real editor.
 *
 * jsdom performs no layout, so the framing itself cannot be observed here — what is observable,
 * and what the three surfaces have to agree on, is *which nodes* React Flow is asked to frame.
 * So `fitView` is mocked and the argument is the assertion.
 *
 * The load-bearing case is the empty one. `fitView({ nodes })` intersects the ids with the nodes
 * it has measured, and an empty intersection fits a zero-sized box at the flow origin — the
 * camera ends up nowhere near the graph. So no surface may ever pass an empty list: the button is
 * disabled, and the `§` key frames the *whole graph* instead, which is a fit with no `nodes` at
 * all rather than a fit of nothing.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type * as ReactFlow from '@xyflow/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Typed with the options parameter, because the options are the whole assertion here.
const fitView = vi.hoisted(() =>
  vi.fn((_options?: { nodes?: { id: string }[]; maxZoom?: number }) => Promise.resolve(true)),
)

vi.mock('@xyflow/react', async (importOriginal) => {
  const real = await importOriginal<typeof ReactFlow>()
  return { ...real, useReactFlow: () => ({ ...real.useReactFlow(), fitView }) }
})

const { App } = await import('../../App')
const { MockSource } = await import('../../data/mock/MockSource')
const { registerSource } = await import('../../data/source')
const { useGraphStore } = await import('../../store/graphStore')
const { demoWorkflow } = await import('../../wizard/build')
const { clearStorage, installJsdomStubs, installStorageStub } =
  await import('../../test/jsdomStubs')
const { buildCommandItems } = await import('./paletteItems')
const { FIT_VIEW_OPTIONS } = await import('../fitView')

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  installStorageStub()
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  fitView.mockClear()
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(demoWorkflow('partners'))
    useGraphStore.getState().setSelection([])
  })
})

afterEach(cleanup)

const fitSelectedButton = () => screen.getByRole('button', { name: 'Fit Selected' })

/** The ids of the cards, in document order. */
function nodeIds(): string[] {
  return useGraphStore.getState().graph.nodes.map((n) => n.id)
}

/** The nth card's id, or a failure that names the reason rather than an `undefined` downstream. */
function nodeId(index: number): string {
  const id = nodeIds()[index]
  if (!id) throw new Error(`no node at ${index}`)
  return id
}

/** The options the one recorded `fitView` call was made with. */
function fitOptions() {
  expect(fitView).toHaveBeenCalledTimes(1)
  return fitView.mock.calls[0]?.[0]
}

function select(ids: string[]) {
  act(() => useGraphStore.getState().setSelection(ids))
}

describe('the Fit Selected button', () => {
  it('sits in the canvas rail, beside zoom and fit', () => {
    render(<App />)
    expect(document.querySelector('.react-flow__controls')?.contains(fitSelectedButton())).toBe(
      true,
    )
  })

  it('frames exactly what is selected', () => {
    render(<App />)
    const [first, second] = [nodeId(0), nodeId(1)]
    select([first, second])
    fitView.mockClear()
    fireEvent.click(fitSelectedButton())
    const options = fitOptions()
    expect(options?.nodes?.map((n) => n.id)).toEqual([first, second])
    // The shared framing, asserted against the constant rather than against its numbers: the
    // padding and the zoom ceiling are a tuning knob, and what has to hold is that all three
    // fits read the same one.
    expect(options).toMatchObject(FIT_VIEW_OPTIONS)
  })

  it('is disabled with nothing selected, and says why', () => {
    render(<App />)
    expect((fitSelectedButton() as HTMLButtonElement).disabled).toBe(true)
    expect(fitSelectedButton().getAttribute('title')).toMatch(/select a node first/i)
    select(nodeIds().slice(0, 1))
    expect((fitSelectedButton() as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('the § key', () => {
  it('frames the selection', () => {
    render(<App />)
    const first = nodeId(0)
    select([first])
    fitView.mockClear()
    fireEvent.keyDown(window, { key: '§', code: 'Backquote' })
    expect(fitOptions()?.nodes?.map((n) => n.id)).toEqual([first])
  })

  it('frames the whole graph with nothing selected', () => {
    render(<App />)
    fitView.mockClear()
    fireEvent.keyDown(window, { key: '§', code: 'Backquote' })
    // No `nodes` key at all — the one thing that must never be passed here is an empty list,
    // which frames the origin rather than the graph.
    expect(fitOptions()?.nodes).toBeUndefined()
    expect(fitOptions()?.maxZoom).toBe(FIT_VIEW_OPTIONS.maxZoom)
  })

  it('leaves a field being typed in alone', () => {
    render(<App />)
    select(nodeIds().slice(0, 1))
    fitView.mockClear()
    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: '§', code: 'Backquote' })
    expect(fitView).not.toHaveBeenCalled()
    input.remove()
  })
})

describe('the § badge in the palette', () => {
  /*
   * The key runs whichever fit the selection calls for, so the badge has to sit on the row that
   * would actually run. A badge that stayed on Fit Selected would advertise a disabled row.
   */
  const fitRow = (id: string) =>
    buildCommandItems({
      store: useGraphStore.getState(),
      fitView: () => {},
      fitSelected: () => {},
    }).find((i) => i.id === id)

  it('sits on Fit View while nothing is selected', () => {
    expect(fitRow('cmd:fit')?.shortcut).toBe('§')
    expect(fitRow('cmd:fit-selected')?.shortcut).toBeUndefined()
  })

  it('moves to Fit Selected as soon as something is', () => {
    render(<App />)
    select(nodeIds().slice(0, 1))
    expect(fitRow('cmd:fit-selected')?.shortcut).toBe('§')
    expect(fitRow('cmd:fit')?.shortcut).toBeUndefined()
  })
})

describe('the palette command', () => {
  it('is offered, and disabled exactly while nothing is selected', () => {
    const item = () =>
      buildCommandItems({
        store: useGraphStore.getState(),
        fitView: () => {},
        fitSelected: () => {},
      }).find((i) => i.id === 'cmd:fit-selected')

    expect(item()?.label).toBe('Fit Selected')
    expect(item()?.disabled).toBe(true)
    select(nodeIds().slice(0, 1))
    expect(item()?.disabled).toBe(false)
  })
})
