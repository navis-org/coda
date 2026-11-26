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
import { resetWeightStore } from '../../ml/weights'
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
  resetWeightStore()
  installStorageStub()
  clearStorage()
})

afterEach(() => {
  cleanup()
  clearStorage()
  delete (performance as { memory?: unknown }).memory
})

/**
 * A cached model as `ml/weights.ts` writes one — body and meta together — through a raw
 * connection, since the only public writer is a verified download.
 */
async function putModel(key: string, body: Uint8Array): Promise<void> {
  await new Promise<void>((settle, fail) => {
    const open = indexedDB.open('coda-models', 2)
    open.onupgradeneeded = () => {
      open.result.createObjectStore('weights')
      open.result.createObjectStore('meta')
    }
    open.onerror = () => fail(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['weights', 'meta'], 'readwrite')
      tx.objectStore('weights').put(body.buffer, key)
      tx.objectStore('meta').put({ bytes: body.byteLength }, key)
      tx.oncomplete = () => {
        db.close()
        settle()
      }
      tx.onerror = () => fail(tx.error)
    }
  })
}

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

  function rowOf(dialog: HTMLElement, name: string): HTMLElement {
    return within(dialog).getByText(name).closest('li')!
  }

  function clearIn(row: HTMLElement): HTMLButtonElement {
    return within(row).getByRole('button', { name: 'Clear' }) as HTMLButtonElement
  }

  it('lists what Coda keeps, and clears only the downloaded data', async () => {
    await cacheSet('neurons:test', { ids: ['1', '2'] })
    await saveWorkflow(emptyGraph('Kept'))
    render(<App />)
    const dialog = openStorage()
    await within(dialog).findAllByRole('button', { name: 'Clear' })
    const row = (name: string) => rowOf(dialog, name)
    expect(within(row('Downloaded data')).getByText(/^1 item\./)).toBeTruthy()
    // Somebody's work reports where it is managed, and carries no button here.
    expect(
      within(row('Saved workflows')).getByText(
        '1 workflow. Manage them under Open ▸ Saved in this browser.',
      ),
    ).toBeTruthy()
    // The two download caches, and nothing else, can be cleared.
    expect(within(dialog).getAllByRole('button', { name: 'Clear' })).toHaveLength(2)

    act(() => {
      fireEvent.click(clearIn(row('Downloaded data')))
    })
    await waitFor(() => {
      expect(within(row('Downloaded data')).getByText('None yet.')).toBeTruthy()
    })
    expect(clearIn(row('Downloaded data')).disabled).toBe(true)
    // The library is untouched by a clear.
    expect(within(row('Saved workflows')).getByText(/^1 workflow\./)).toBeTruthy()
  })

  it('lists downloaded models, and clears them without touching the data cache', async () => {
    await cacheSet('neurons:test', { ids: ['1', '2'] })
    await putModel('affinity/mixed/encoder', new Uint8Array(3 * 1024 * 1024))
    render(<App />)
    const dialog = openStorage()
    const row = (name: string) => rowOf(dialog, name)
    await waitFor(() => {
      expect(within(row('Downloaded models')).getByText(/^1 model file\./)).toBeTruthy()
    })
    expect(within(row('Downloaded models')).getByText('≈ 3.0 MB')).toBeTruthy()

    act(() => {
      fireEvent.click(clearIn(row('Downloaded models')))
    })
    await waitFor(() => {
      expect(within(row('Downloaded models')).getByText('None yet.')).toBeTruthy()
    })
    expect(clearIn(row('Downloaded models')).disabled).toBe(true)
    expect(within(row('Downloaded data')).getByText(/^1 item\./)).toBeTruthy()
  })
})
