// @vitest-environment jsdom

/**
 * The split gallery's overlay (`SplitGalleryHost.tsx`) with the 3D tiles stood in for — jsdom has
 * no WebGL, and the tiles' drawing is a browser's to check. Pinned: the status says what is
 * happening; a tile picked is enlarged with Back and Accept; Accept writes through faked servers
 * (never a chunkedgraph), holds the gallery while it is out, and offers Undo after.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfirmedSplit, EditOutcome } from '../../data/cave/edits'
import { parseGrapheneSource } from '../../data/cave/graphene'
import {
  FANC_LAYOUT,
  MANY_SPLITS,
  toy,
  withNodeIds,
} from '../../packs/seam/__fixtures__/splitToy'
import type { SplitWriteServices } from '../../packs/seam/splitWrite'
import { settle, SPLIT_INPUT, SPLIT_ROOT, toyServices } from './__fixtures__/splitServices'
import { resetSplitAcceptForTests } from './splitAccept'
import type { SplitTilesProps } from './SplitTiles'
import { useGraphStore } from '../../store/graphStore'
import { SplitGalleryHost } from './SplitGalleryHost'
import { closeSplit, resetSplitSessionForTests, splitSession, startSplit } from './splitSession'

vi.mock('./SplitTiles', () => ({
  KEPT_HEX: '#000000',
  TAKEN_HEX: '#ffffff',
  SplitTiles: ({ candidates, selected, onSelect, caption }: SplitTilesProps) => (
    <ol>
      {candidates.map((candidate, i) =>
        selected === undefined || selected === i ? (
          <li key={i}>
            <button type="button" onClick={() => onSelect(i)}>
              {caption(candidate, i)}
            </button>
          </li>
        ) : null,
      )}
    </ol>
  ),
}))

/** The toy with chunkedgraph ids on an https table, as a write needs. */
const NUMBERED = withNodeIds(SPLIT_INPUT)
const GRAPHENE = parseGrapheneSource(
  'graphene://https://cave.example.org/segmentation/table/t',
)!

beforeEach(() => {
  resetSplitSessionForTests({
    ...toyServices(),
    chunkedgraph: () =>
      Promise.resolve({
        graphene: GRAPHENE,
        layout: FANC_LAYOUT,
        base: 'gs://toy',
      }),
    box: () => Promise.resolve(NUMBERED),
    // A mesh that never arrives: the tiles draw chunk points meanwhile.
    mesh: () => new Promise(() => undefined),
  })
})

afterEach(() => {
  cleanup()
  resetSplitAcceptForTests()
  act(() => closeSplit())
  resetSplitSessionForTests()
})

/** Servers that split as asked, with the send held until `release`. */
function writeServers(
  answer: EditOutcome = { kind: 'done', operationId: '9', newRootIds: ['111', '222'] },
) {
  let release: () => void = () => undefined
  const sent: ConfirmedSplit[] = []
  const services: SplitWriteServices = {
    permission: () => Promise.resolve({ dataset: 'toy', mayEdit: true, termsPending: false }),
    latest: () => Promise.resolve([true]),
    // A one-edge cut: sent as it is, so no preview is asked.
    preview: () => Promise.reject(new Error('no preview for one edge')),
    roots: (_, svs) => {
      const sources = new Set(sent.flatMap((s) => s.sources.map((end) => end.supervoxel)))
      return Promise.resolve(svs.map((sv) => (sources.has(sv) ? '111' : '222')))
    },
    send: vi.fn((split: ConfirmedSplit): Promise<EditOutcome> => {
      sent.push(split)
      return new Promise((resolve) => {
        release = () => resolve(answer)
      })
    }),
    undo: vi.fn((): Promise<EditOutcome> =>
      Promise.resolve({ kind: 'done', operationId: '10', newRootIds: ['333'] }),
    ),
  }
  return { services, release: () => release() }
}

async function press(): Promise<void> {
  await act(async () => {
    startSplit({
      deployment: 'd',
      datastack: 'toy',
      root: SPLIT_ROOT,
      pointNm: [2000, 250, 0],
    })
    await settle()
  })
}

describe('SplitGalleryHost', () => {
  it('draws nothing without a session', () => {
    const { container } = render(<SplitGalleryHost />)
    expect(container.textContent).toBe('')
  })

  it('offers the splits, and while the mesh is on its way says the tiles draw chunks', async () => {
    render(<SplitGalleryHost />)
    await press()
    expect(screen.getByRole('status').textContent).toMatch(/near the point, nearest first/)
    expect(screen.getByRole('status').textContent).toMatch(/level-2 chunks until the mesh/)
    expect(screen.getAllByRole('button', { name: /takes off/ }).length).toBeGreaterThan(0)
  })

  it('enlarges a picked tile, with Back and Accept', async () => {
    render(<SplitGalleryHost />)
    await press()
    fireEvent.click(screen.getAllByRole('button', { name: /takes off/ })[0]!)
    expect(screen.getAllByRole('button', { name: /takes off/ })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Accept' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: 'Back to all' }))
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
  })

  it('steps back on Escape: from an enlarged tile to all of them, then closes', async () => {
    render(<SplitGalleryHost />)
    await press()
    const count = screen.getAllByRole('button', { name: /takes off/ }).length
    fireEvent.click(screen.getAllByRole('button', { name: /takes off/ })[0]!)
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(splitSession()).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.getAllByRole('button', { name: /takes off/ })).toHaveLength(count)
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(splitSession()).toBeUndefined()
  })

  it('takes no Escape back to all while a split is being written', async () => {
    const { services, release } = writeServers()
    resetSplitAcceptForTests(services)
    render(<SplitGalleryHost />)
    await press()
    fireEvent.click(screen.getAllByRole('button', { name: /takes off/ })[0]!)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
      await settle()
    })
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    // Still on the split being written, as Back is off.
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy()
    await act(async () => {
      release()
      await settle()
    })
  })

  it('writes on Accept, holds the gallery while it is out, then closes once split', async () => {
    const { services, release } = writeServers()
    resetSplitAcceptForTests(services)
    render(<SplitGalleryHost />)
    await press()
    fireEvent.click(screen.getAllByRole('button', { name: /takes off/ })[0]!)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
      await settle()
    })
    expect(services.send).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/splitting/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Accept' })).toHaveProperty('disabled', true)
    // Held: neither Close nor a new press moves the gallery off the split being written.
    const shown = splitSession()
    act(() => closeSplit())
    expect(splitSession()).toBe(shown)

    await act(async () => {
      release()
      await settle()
    })
    // Split and read back apart: nothing left to choose, so the gallery is gone; the answer is on
    // the status bar.
    expect(splitSession()).toBeUndefined()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(useGraphStore.getState().notice).toMatch(/Split \(operation 9\)/)
  })

  /** The server's silent edit: one new root, the neuron still whole — the gallery stays, with Undo. */
  it('stays open with Undo where the split left the neuron one piece', async () => {
    const { services, release } = writeServers({
      kind: 'done',
      operationId: '9',
      newRootIds: ['111'],
    })
    resetSplitAcceptForTests(services)
    render(<SplitGalleryHost />)
    await press()
    fireEvent.click(screen.getAllByRole('button', { name: /takes off/ })[0]!)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
      await settle()
      release()
      await settle()
    })
    expect(screen.getByText(/still one piece/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      await settle()
    })
    expect(services.undo).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Undone \(operation 10\)/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    act(() => closeSplit())
    expect(splitSession()).toBeUndefined()
  })

  it('regenerates: the next set of splits each time, until there are no more', async () => {
    resetSplitSessionForTests({
      ...toyServices(),
      box: () => Promise.resolve(toy(MANY_SPLITS)),
      mesh: () => new Promise(() => undefined),
    })
    render(<SplitGalleryHost />)
    await press()
    const tiles = () =>
      screen.getAllByRole('button', { name: /takes off/ }).map((b) => b.textContent)
    const first = tiles()
    expect(first).toHaveLength(6)
    const regenerate = () =>
      act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
        await settle()
      })
    await regenerate()
    expect(screen.getByRole('status').textContent).toMatch(
      /6 other splits near the point.*set 2/,
    )
    expect(tiles()).toHaveLength(6)
    await regenerate()
    expect(tiles()).toHaveLength(1)
    await regenerate()
    // Nothing more: the last set stays, and the button says why it is off.
    expect(tiles()).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toMatch(/these are the last found/)
    expect(screen.getByRole('button', { name: 'Regenerate' })).toHaveProperty('disabled', true)
  })

  /** A position in the old set names another split in the new one: the split shown is the one written. */
  it('picks no tile while a Regenerate looks, and enlarges nothing in the set it brings', async () => {
    resetSplitSessionForTests({
      ...toyServices(),
      box: () => Promise.resolve(toy(MANY_SPLITS)),
      mesh: () => new Promise(() => undefined),
    })
    render(<SplitGalleryHost />)
    await press()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    })
    act(() => {
      fireEvent.click(screen.getAllByRole('button', { name: /takes off/ })[2]!)
    })
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    await act(settle)
    expect(screen.getByRole('status').textContent).toMatch(/set 2/)
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    expect(screen.getAllByRole('button', { name: /takes off/ })).toHaveLength(6)
  })

  it('offers no Regenerate with a tile enlarged', async () => {
    render(<SplitGalleryHost />)
    await press()
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /takes off/ })[0]!)
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull()
  })
})
