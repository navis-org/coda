// @vitest-environment jsdom

/**
 * The Edge data panel.
 *
 * Two properties carry most of the weight here, and both are about a control that changes an
 * answer with nothing on the canvas saying so:
 *
 *  - **Attaching is one undo step.** Two params travel together, and a state where the id is set
 *    and the name is not is exactly the state the refusal message reads to name a missing set.
 *  - **The card says which set is attached.** There is no wire, so the button *is* the indicator;
 *    a card that looked the same either way would be the silent result-change this whole feature
 *    is arranged around.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { EdgeSetBuilder } from '../../data/edges/encode'
import { listEdgeSets, resetEdgeSets, saveEdgeSet } from '../../data/edges/store'
import { useGraphStore } from '../../store/graphStore'
import { installJsdomStubs } from '../../test/jsdomStubs'
import '../../nodes'
import { EdgeSetPanel } from './EdgeSetPanel'

const WIDE = '720575940628857210'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

afterEach(cleanup)

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  resetEdgeSets()
  useGraphStore.getState().newGraph()
})

/** A dataset node on the canvas, and the panel opened on it. */
function withNode(): string {
  useGraphStore.getState().addNode('dataset.mock.opticlobe', { x: 0, y: 0 })
  const id = useGraphStore.getState().graph.nodes.find((n) => n.type.startsWith('dataset.'))!.id
  useGraphStore.getState().openEdgePanel(id)
  return id
}

const paramsOf = (id: string) =>
  useGraphStore.getState().graph.nodes.find((n) => n.id === id)!.params

async function importSet(
  name = 'FlyWire 783',
  rows: [string, string, number][] = [[WIDE, '2', 5]],
) {
  const b = new EdgeSetBuilder()
  for (const [pre, post, w] of rows) b.add(pre, post, w)
  const meta = await saveEdgeSet(b.finish(), { name, origin: 'edges.csv' })
  await listEdgeSets()
  return meta
}

describe('the panel', () => {
  it('is absent until a card opens it', () => {
    render(<EdgeSetPanel />)
    expect(screen.queryByRole('dialog')).toBeNull()
    withNode()
    cleanup()
    render(<EdgeSetPanel />)
    expect(screen.getByRole('dialog', { name: 'Edge data' })).toBeTruthy()
  })

  it('lists what is on the shelf, with what the import had to say about it', async () => {
    // Both counted at import and both mean the file was not what somebody thought — a shelf that
    // held them and never showed them would be fields nobody reads.
    await importSet('mixed', [
      [WIDE, '2', 3],
      [WIDE, '2', 4],
      ['LC4', 'DNp01', 5],
    ])
    withNode()
    render(<EdgeSetPanel />)
    await screen.findByText('mixed')
    const row = screen.getByText('mixed').closest('li')!
    expect(within(row).getByText(/2 edges/)).toBeTruthy()
    expect(within(row).getByText(/1 merged/)).toBeTruthy()
    expect(within(row).getByText(/2 ids are not numbers/)).toBeTruthy()
  })

  it('attaches both params in a single undo step', async () => {
    const meta = await importSet()
    const id = withNode()
    render(<EdgeSetPanel />)

    fireEvent.click(await screen.findByRole('radio', { name: /FlyWire 783/ }))
    expect(paramsOf(id).edgeSetId).toBe(meta.id)
    expect(paramsOf(id).edgeSetName).toBe('FlyWire 783')

    /*
     * One undo takes *both* back. Two `setParam` calls would carry two tags and so two entries,
     * leaving the id set and the name empty after this — and that half-attached state is exactly
     * what the refusal message reads to name the set somebody is looking for.
     */
    useGraphStore.getState().undo()
    expect(paramsOf(id).edgeSetId).toBe('')
    expect(paramsOf(id).edgeSetName).toBe('')
  })

  it('detaches back to the dataset’s own connectivity', async () => {
    const meta = await importSet()
    const id = withNode()
    useGraphStore.getState().attachEdgeSet(id, { id: meta.id, name: meta.name })
    render(<EdgeSetPanel />)

    fireEvent.click(await screen.findByRole('radio', { name: /None/ }))
    expect(paramsOf(id).edgeSetId).toBe('')
    expect(paramsOf(id).edgeSetName).toBe('')
  })

  it('renames inline, and the rename reaches the node that holds the name', async () => {
    const meta = await importSet()
    const id = withNode()
    useGraphStore.getState().attachEdgeSet(id, { id: meta.id, name: meta.name })
    render(<EdgeSetPanel />)

    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }))
    const field = screen.getByRole('textbox', { name: /Name for FlyWire 783/ })
    fireEvent.change(field, { target: { value: 'FlyWire 630' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    // The node stores the name for the message it shows when the set is *not* here, so a stale
    // one would have a graph naming a set by a name nothing uses.
    await waitFor(() => expect(paramsOf(id).edgeSetName).toBe('FlyWire 630'))
    expect(paramsOf(id).edgeSetId).toBe(meta.id)
  })

  it('asks before deleting, and detaches what it deleted', async () => {
    const meta = await importSet()
    const id = withNode()
    useGraphStore.getState().attachEdgeSet(id, { id: meta.id, name: meta.name })
    render(<EdgeSetPanel />)

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    // A hundred megabytes and nothing else can reclaim it, so one click is not an answer.
    expect(paramsOf(id).edgeSetId).toBe(meta.id)

    fireEvent.click(screen.getByRole('button', { name: 'Really delete?' }))
    await waitFor(() => expect(paramsOf(id).edgeSetId).toBe(''))
    expect(await listEdgeSets()).toEqual([])
  })

  it('imports a file, maps its columns and attaches the result', async () => {
    withNode()
    render(<EdgeSetPanel />)
    const file = new File([`pre,post,weight\n${WIDE},2,10\n${WIDE},3,4\n`], 'edges.csv')
    fireEvent.change(screen.getByLabelText(/Choose a file/), { target: { files: [file] } })

    // The guess is the point: the panel asks, but it should be right before anybody touches it.
    await screen.findByText('Which column is which')
    expect((screen.getByLabelText('Presynaptic') as HTMLSelectElement).value).toBe('0')
    expect((screen.getByLabelText('Postsynaptic') as HTMLSelectElement).value).toBe('1')
    expect((screen.getByLabelText('Weight') as HTMLSelectElement).value).toBe('2')
    // Named after the file, so the common case needs no typing.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('edges')

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(paramsOf(id0()).edgeSetName).toBe('edges'))
    const sets = await listEdgeSets()
    expect(sets).toHaveLength(1)
    expect(sets[0]!.edges).toBe(2)
  })

  it('refuses to import with both ends on one column', async () => {
    withNode()
    render(<EdgeSetPanel />)
    const file = new File([`pre,post,weight\n${WIDE},2,10\n`], 'edges.csv')
    fireEvent.change(screen.getByLabelText(/Choose a file/), { target: { files: [file] } })
    await screen.findByText('Which column is which')

    fireEvent.change(screen.getByLabelText('Postsynaptic'), { target: { value: '0' } })
    expect(screen.getByText(/every edge would be a self-connection/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('closes on Escape and on a click outside, through one handler', () => {
    // One handler because an import in flight has to be aborted by either — the backdrop used to
    // have its own, which closed the dialog and let the worker run on to write a hundred
    // megabytes and attach the result to something nobody could see.
    withNode()
    render(<EdgeSetPanel />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useGraphStore.getState().edgePanelNode).toBeUndefined()

    cleanup()
    withNode()
    render(<EdgeSetPanel />)
    fireEvent.pointerDown(document.body)
    expect(useGraphStore.getState().edgePanelNode).toBeUndefined()
  })

  it('does not close on a click inside itself', () => {
    withNode()
    render(<EdgeSetPanel />)
    fireEvent.pointerDown(screen.getByRole('dialog', { name: 'Edge data' }))
    expect(useGraphStore.getState().edgePanelNode).toBe(id0())
  })
})

function id0(): string {
  return useGraphStore.getState().graph.nodes.find((n) => n.type.startsWith('dataset.'))!.id
}
