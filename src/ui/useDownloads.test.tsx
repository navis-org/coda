// @vitest-environment jsdom

/**
 * The Download node's side effect, in the real editor.
 *
 * Everything interesting about this feature lives here rather than in the node, because the node
 * is a pass-through by design. What has to be true:
 *
 *  - a Run that actually executed the node writes the file, and a Run over an unchanged graph
 *    writes nothing — that second half is the whole of what bounds "on every run";
 *  - `On run` off makes the button the only trigger;
 *  - the button still works when the node did *not* re-execute, which is the case that matters
 *    because every param here is presentational and so changing one re-runs nothing;
 *  - and the driver survives a remount without re-firing a run it already handled, which is the
 *    `paletteRequest` idiom and would otherwise write a file because a panel was toggled.
 */

import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../App'
import { addEdge, addNode, emptyGraph } from '../core/graph'
import type { CodaGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { MockSource } from '../data/mock/MockSource'
import { mockDatasetIds } from '../data/mock/generate'
import { registerSource } from '../data/source'
import '../nodes'
import { useGraphStore } from '../store/graphStore'
import type { CapturedDownload } from '../test/jsdomStubs'
import { clearStorage, installDownloadCapture, installJsdomStubs } from '../test/jsdomStubs'

const DATASET = mockDatasetIds()[0]!

let downloads: CapturedDownload[]
let restore: () => void

beforeAll(() => {
  installJsdomStubs({ width: 1000, height: 700 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  const capture = installDownloadCapture()
  downloads = capture.downloads
  restore = capture.restore
})

afterEach(() => {
  restore()
  cleanup()
})

function node(id: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type,
    position: { x: id === 'ds' ? 0 : 320, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...extra } as never,
  }
}

/** dataset → find(LC4) → download */
function graphWith(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('sweep')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC4', status: 'Traced' }))
  g = addNode(g, node('dl', 'out.download', params))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, { source: 'find', sourceHandle: 'neurons', target: 'dl', targetHandle: 'in' })
  return g
}

async function open(params: Record<string, unknown> = {}) {
  render(<App />)
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(graphWith(params))
  })
  return await waitFor(() => {
    // Via its own button rather than by taking the first `.list-body` on the page: several cards
    // share that class — Find Neurons is one, and it is upstream of the Download in this graph,
    // so it comes first in the DOM. `renameBody.test.tsx` and `selectOneBody.test.tsx` reach
    // theirs the same way.
    const body = document.querySelector('.download-body__go')?.closest('.list-body')
    if (!body) throw new Error('no Download body rendered')
    return body as HTMLElement
  })
}

async function run() {
  await act(async () => {
    await useGraphStore.getState().runAll()
  })
}

describe('downloading on a run', () => {
  it('writes the file when the node actually executed', async () => {
    await open()
    await run()
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]!.filename).toBe('sweep_download.csv')
    // The pass-through value, as CSV — `auto` on a neuron table.
    await expect(downloads[0]!.text()).resolves.toContain('neuronId')
  })

  it('writes nothing for a second Run over an unchanged graph', async () => {
    // The provenance key is what bounds "on every run": nothing re-executed, so nothing is
    // written. Without this the node would write a file every time anybody pressed Run.
    await open()
    await run()
    await waitFor(() => expect(downloads).toHaveLength(1))
    await run()
    expect(downloads).toHaveLength(1)
  })

  it('honours the filename and the format', async () => {
    await open({ filename: 'lc4-sweep', format: 'json' })
    await run()
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]!.filename).toBe('lc4-sweep.json')
  })

  it('appends a timestamp when asked, so repeated runs do not collide', async () => {
    await open({ filename: 'lc4', timestamp: true })
    await run()
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]!.filename).toMatch(/^lc4-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/)
  })

  it('writes nothing at all with On run switched off', async () => {
    await open({ onRun: false })
    await run()
    // Waited on rather than asserted immediately: the driver is async, so an eager assertion
    // would pass even if it were about to write.
    await new Promise((r) => setTimeout(r, 20))
    expect(downloads).toHaveLength(0)
  })
})

describe('the button', () => {
  it('writes on demand, including when nothing re-ran', async () => {
    // The case that matters: every param here is presentational, so changing the filename
    // re-executes nothing and a Run would write nothing. The button is the answer to that.
    const body = await open({ filename: 'first' })
    await run()
    await waitFor(() => expect(downloads).toHaveLength(1))

    act(() => {
      useGraphStore.getState().setParam('dl', 'filename', 'second')
    })
    await run()
    expect(downloads).toHaveLength(1)

    fireEvent.click(within(body).getByRole('button', { name: /Download now/ }))
    await waitFor(() => expect(downloads).toHaveLength(2))
    expect(downloads[1]!.filename).toBe('second.csv')
  })

  it('is disabled before there is anything to write', async () => {
    const body = await open()
    const button = within(body).getByRole('button', {
      name: /Download now/,
    }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(body.textContent).toContain('Not run yet')
  })

  it('names the files it would write once there are some', async () => {
    const body = await open({ filename: 'lc4' })
    await run()
    await waitFor(() => expect(body.textContent).toContain('lc4.csv'))
  })
})

describe('the auto-run warning', () => {
  it('appears only when auto-run and On run are both on', async () => {
    // The one thing only the card can say: a node definition cannot read the store, so this
    // cannot live in `validate` — and it is what stops somebody ending up with four hundred
    // files from a burst of edits. Auto-run is on by default, so the warning is what a fresh
    // profile sees; both directions are driven here because either one alone would pass against
    // a card that ignored the store.
    const body = await open()
    await waitFor(() => expect(body.textContent).toContain('Auto-run is on'))

    act(() => {
      useGraphStore.getState().setAutoRun(false)
    })
    await waitFor(() => expect(body.textContent).not.toContain('Auto-run is on'))

    act(() => {
      useGraphStore.getState().setAutoRun(true)
    })
    await waitFor(() => expect(body.textContent).toContain('Auto-run is on'))

    act(() => {
      useGraphStore.getState().setParam('dl', 'onRun', false)
    })
    await waitFor(() => expect(body.textContent).not.toContain('Auto-run is on'))
  })
})
