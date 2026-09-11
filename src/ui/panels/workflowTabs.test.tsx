// @vitest-environment jsdom

/**
 * The switcher's right-click menu.
 *
 * The store half — what a duplicate carries, how a background rename undoes — is
 * `store/documents.test.ts`'. What is left here is which workflow a menu is *about*: a row's
 * right-click names that row's document, the header's names the one on screen, and each action
 * reaches the document it named rather than the active one.
 */

import { ReactFlowProvider } from '@xyflow/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { namedGraph } from '../../test/graph'
import { clearStorage } from '../../test/jsdomStubs'
import { resetDocuments } from '../../test/storeReset'
import type * as ExportModule from '../export'
import { downloadGraph } from '../export'
import { WorkflowTabs } from './WorkflowTabs'

vi.mock('../export', async (original) => ({
  ...(await original<typeof ExportModule>()),
  downloadGraph: vi.fn(),
}))

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  resetDocuments()
  if (!useGraphStore.getState().panels.workflows)
    useGraphStore.getState().togglePanel('workflows')
  vi.mocked(downloadGraph).mockClear()
})

afterEach(cleanup)

const store = () => useGraphStore.getState()
const names = () => store().tabs.map((tab) => tab.name)

/** Two workflows, the second on screen. Returns the first's id. */
function twoWorkflows(): string {
  store().openDocument(namedGraph('First'))
  const first = store().activeTabId
  store().openDocument(namedGraph('Second'))
  return first
}

function mount() {
  return render(
    <ReactFlowProvider>
      <WorkflowTabs />
    </ReactFlowProvider>,
  )
}

function rightClickRow(name: string) {
  const row = screen.getByRole('button', { name }).closest('li')!
  fireEvent.contextMenu(row, { clientX: 20, clientY: 20 })
}

describe('the workflow menu', () => {
  it('duplicates the row it was opened on, not the one on screen', () => {
    twoWorkflows()
    mount()
    rightClickRow('First')
    expect(screen.getByRole('menu', { name: 'Workflow First' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    expect(names()).toEqual(['First', 'First (copy)', 'Second'])
    expect(store().graph.meta?.name).toBe('First (copy)')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('downloads a background workflow without switching to it', () => {
    const first = twoWorkflows()
    mount()
    rightClickRow('First')
    fireEvent.click(screen.getByRole('button', { name: 'Download .coda.json' }))

    expect(vi.mocked(downloadGraph)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(downloadGraph).mock.calls[0]![0].meta?.name).toBe('First')
    expect(store().activeTabId).not.toBe(first)
  })

  it('renames in place, on Enter', () => {
    twoWorkflows()
    mount()
    rightClickRow('First')
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    const field = screen.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement
    expect(field.value).toBe('First')
    fireEvent.change(field, { target: { value: 'Atlas' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(names()).toEqual(['Atlas', 'Second'])
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('abandons a rename on Escape', () => {
    twoWorkflows()
    mount()
    rightClickRow('First')
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    const field = screen.getByRole('textbox', { name: 'Workflow name' })
    fireEvent.change(field, { target: { value: 'Atlas' } })
    fireEvent.keyDown(field, { key: 'Escape' })

    expect(names()).toEqual(['First', 'Second'])
  })

  it('is about the workflow on screen when opened on the header', () => {
    twoWorkflows()
    mount()
    fireEvent.contextMenu(screen.getByRole('button', { name: /Workflows/ }), {
      clientX: 20,
      clientY: 20,
    })
    expect(screen.getByRole('menu', { name: 'Workflow Second' })).toBeTruthy()
  })
})
