// @vitest-environment jsdom

/**
 * The memory readout and its dialog, reached the way a reader reaches them: through the status bar.
 *
 * What is pinned is the split between the two sources of truth. jsdom has no
 * `performance.memory`, which is exactly Firefox and Safari's position, so the default case here
 * is the one those readers get: an estimate marked `≈`, no meter (there is no limit to draw one
 * against), and a dialog that says the browser does not report — rather than a zero, which would
 * read as "plenty of room". Chrome's case is stubbed, and the assertion there is the one the
 * readout exists for: near the limit, it says so.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { emptyGraph } from '../../core/graph'
import { cacheSet, resetCache } from '../../data/cache'
import { resetLibrary, saveWorkflow } from '../../store/library'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  registerSource(new MockSource())
})

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetCache()
  resetLibrary()
  installStorageStub()
  clearStorage()
})

afterEach(() => {
  cleanup()
  clearStorage()
  delete (performance as { memory?: unknown }).memory
})

function readout(): HTMLElement {
  return screen.getByRole('button', { name: /^Memory/ })
}

describe('memory readout', () => {
  it('gives an estimate, with no meter, where the browser reports nothing', () => {
    render(<App />)
    expect(readout().textContent).toMatch(/^Memory ≈ /)
    expect(readout().querySelector('.memory__meter')).toBeNull()
    expect(readout().getAttribute('title')).toMatch(/does not report/)
  })

  it('opens a dialog that says what this browser cannot tell it', () => {
    render(<App />)
    act(() => {
      fireEvent.click(readout())
    })
    const dialog = screen.getByRole('dialog', { name: 'Memory' })
    expect(within(dialog).getByText(/does not report how much memory/)).toBeTruthy()
    // One row per open workflow, and nothing to drop on a graph that has not run.
    const drop = within(dialog).getByRole('button', { name: 'Drop results' })
    expect((drop as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog).getByText('No results held')).toBeTruthy()
    expect(within(dialog).getByText('Python runtime')).toBeTruthy()
    // What no browser lets a page measure is said, rather than silently missing from the sums.
    expect(
      within(dialog).getByText(/3D View, Neuroglancer and other viewers can’t be measured/),
    ).toBeTruthy()
  })

  it("shows Chrome's measurement, and says when it is near the limit", () => {
    Object.defineProperty(performance, 'memory', {
      configurable: true,
      value: { usedJSHeapSize: 3.8 * 1024 ** 3, jsHeapSizeLimit: 4 * 1024 ** 3 },
    })
    render(<App />)
    expect(readout().textContent).toBe('Memory 3.80 GB')
    expect(readout().getAttribute('data-level')).toBe('critical')
    act(() => {
      fireEvent.click(readout())
    })
    const dialog = screen.getByRole('dialog', { name: 'Memory' })
    expect(within(dialog).getByRole('meter').getAttribute('aria-valuenow')).toBe('95')
    expect(within(dialog).getByText(/Drop results you no longer need/)).toBeTruthy()
  })
})

describe('storage tab', () => {
  function openStorage(): HTMLElement {
    act(() => {
      fireEvent.click(readout())
    })
    const dialog = screen.getByRole('dialog', { name: 'Memory' })
    act(() => {
      fireEvent.click(within(dialog).getByRole('tab', { name: 'Storage' }))
    })
    return dialog
  }

  it('lists what Coda keeps, and clears only the downloaded data', async () => {
    await cacheSet('neurons:test', { ids: ['1', '2'] })
    await saveWorkflow(emptyGraph('Kept'))
    render(<App />)
    const dialog = openStorage()
    const clear = await within(dialog).findByRole('button', { name: 'Clear' })
    const row = (name: string) => within(dialog).getByText(name).closest('li')!
    expect(within(row('Downloaded data')).getByText(/^1 item\./)).toBeTruthy()
    // Somebody's work reports where it is managed, and carries no button here.
    expect(
      within(row('Saved workflows')).getByText(
        '1 workflow. Manage them under Open ▸ Saved in this browser.',
      ),
    ).toBeTruthy()
    expect(within(dialog).getAllByRole('button', { name: 'Clear' })).toHaveLength(1)

    act(() => {
      fireEvent.click(clear)
    })
    await waitFor(() => {
      expect(within(row('Downloaded data')).getByText('None yet.')).toBeTruthy()
    })
    expect(
      (within(dialog).getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    // The library is untouched by a clear.
    expect(within(row('Saved workflows')).getByText(/^1 workflow\./)).toBeTruthy()
  })
})
