// @vitest-environment jsdom

/**
 * The Plugins dialog and the shortcuts: one environment, with each pack at its own default until a
 * switch — the reader's, or a shortcut's on their behalf — says otherwise.
 *
 * A test pack that starts switched off is registered here, since no real pack does yet: it is the
 * case a shortcut exists for.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerPack } from '../../core/registry'
import { T } from '../../core/types'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { loadPackChoices } from '../../store/persistence'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'
import { applyShortcut, resetPackSwitchesForTest, switchPack } from '../packSwitches'
import { PluginsDialog } from './PluginsDialog'

vi.mock('../../packs/shortcuts', () => ({
  shortcut: (id: string) =>
    id === 'optin'
      ? { id, packs: ['optin'] }
      : id === 'dependent'
        ? { id, packs: ['dependent'] }
        : undefined,
}))

registerPack({
  id: 'optin',
  label: 'Opt-in tools',
  description: 'Only for the readers who ask for it.',
  defaultOn: false,
  nodes: [
    {
      type: 'optin:thing',
      label: 'Thing',
      category: 'utility',
      cost: 'cheap',
      outputs: [{ id: 'out', type: T.number() }],
      evaluate: () => ({ out: { kind: 'number', value: 1 } }),
    },
  ],
})

/** A pair for the dependency rules: `dependent` needs `needed`, and both start off. */
const tinyNode = (type: string) => ({
  type,
  label: type,
  category: 'utility' as const,
  cost: 'cheap' as const,
  outputs: [{ id: 'out', type: T.number() }],
  evaluate: () => ({ out: { kind: 'number' as const, value: 1 } }),
})
registerPack({
  id: 'needed',
  label: 'Needed',
  description: 'What the other one builds on.',
  defaultOn: false,
  nodes: [tinyNode('needed:thing')],
})
registerPack({
  id: 'dependent',
  label: 'Dependent',
  description: 'Builds on Needed.',
  defaultOn: false,
  requires: ['needed'],
  nodes: [tinyNode('dependent:thing')],
})

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  installStorageStub()
})

beforeEach(() => {
  clearStorage()
  resetPackSwitchesForTest()
  act(() => useGraphStore.getState().setNotice(undefined))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function openDialog() {
  act(() => useGraphStore.getState().openPlugins())
  render(<PluginsDialog />)
}

const box = (name: RegExp) => screen.getByRole('switch', { name }) as HTMLInputElement

describe('the Plugins dialog', () => {
  it('lists every pack with what it adds, each at its own default', () => {
    openDialog()
    expect(box(/ZapBench/).checked).toBe(true)
    expect(box(/Opt-in tools/).checked).toBe(false)
    expect(screen.getByText('Only for the readers who ask for it.')).toBeTruthy()
    // Named by the pack alone, with the rest as its description.
    const zapbench = screen.getByRole('switch', { name: 'ZapBench' })
    expect(zapbench.getAttribute('aria-describedby')).toBeTruthy()
  })

  it("names each pack's nodes, so a switch says what it hides", () => {
    openDialog()
    const zapbench = screen.getByRole('switch', { name: /ZapBench/ }).closest('label')!
    expect(zapbench.textContent).toContain('ZapBench Traces')
    expect(zapbench.textContent).toContain('ZapBench to Neurons')
  })

  it('marks a pack the open workflow uses, and no other — with every pack switched on too', () => {
    // Every pack on is the case the filter's own walk skips, which is where this badge was lost.
    act(() => switchPack('optin', true))
    act(() =>
      useGraphStore.getState().loadGraph({
        version: 1,
        nodes: [{ id: 'zt', type: 'zapbench:traces', position: { x: 0, y: 0 }, params: {} }],
        edges: [],
      }),
    )
    openDialog()
    const row = (name: RegExp) => screen.getByRole('switch', { name }).closest('label')!
    expect(row(/ZapBench/).textContent).toContain('used here')
    expect(row(/Opt-in tools/).textContent).not.toContain('used here')
  })

  it('remembers a switch the reader flips, and only that one', () => {
    openDialog()
    fireEvent.click(box(/Opt-in tools/))
    expect(box(/Opt-in tools/).checked).toBe(true)
    expect(loadPackChoices()).toEqual({ optin: true })
  })

  it("keeps a switch another tab flipped since, rather than writing this tab's copy over it", () => {
    openDialog()
    // Another tab switches ZapBench off after this one read the switches, and says so.
    localStorage.setItem('coda.packChoices.v1', JSON.stringify({ zapbench: false }))
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'coda.packChoices.v1' }))
    })
    fireEvent.click(box(/Opt-in tools/))
    expect(loadPackChoices()).toEqual({ zapbench: false, optin: true })
  })

  it('hears a switch flipped in another tab', () => {
    openDialog()
    expect(box(/ZapBench/).checked).toBe(true)
    localStorage.setItem('coda.packChoices.v1', JSON.stringify({ zapbench: false }))
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'coda.packChoices.v1' }))
    })
    expect(box(/ZapBench/).checked).toBe(false)
  })

  it('closes', () => {
    openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useGraphStore.getState().pluginsOpen).toBe(false)
  })
})

describe('following a shortcut', () => {
  it('switches its packs on for good, says which, and takes the notice away after a while', () => {
    vi.useFakeTimers()
    act(() => applyShortcut('optin'))
    expect(loadPackChoices()).toEqual({ optin: true })
    expect(useGraphStore.getState().notice).toMatch(/Switched on for you: Opt-in tools/)
    act(() => vi.advanceTimersByTime(10_000))
    expect(useGraphStore.getState().notice).toBeUndefined()
  })

  it('says nothing to a reader whose packs are already on', () => {
    vi.useFakeTimers()
    act(() => applyShortcut('optin'))
    act(() => useGraphStore.getState().setNotice(undefined))
    act(() => applyShortcut('optin'))
    expect(useGraphStore.getState().notice).toBeUndefined()
  })

  it('leaves a notice alone that something else has put up since', () => {
    vi.useFakeTimers()
    act(() => applyShortcut('optin'))
    act(() => useGraphStore.getState().setNotice('Saved'))
    act(() => vi.advanceTimersByTime(10_000))
    expect(useGraphStore.getState().notice).toBe('Saved')
  })

  it('does nothing for a shortcut this build does not know', () => {
    act(() => applyShortcut('nowhere'))
    expect(useGraphStore.getState().notice).toBeUndefined()
    expect(loadPackChoices()).toEqual({})
  })
})

describe('a pack that needs another', () => {
  it('switches what it needs on with it, and refuses to let that go while it is on', () => {
    openDialog()
    fireEvent.click(box(/^Dependent/))
    expect(box(/^Needed/).checked).toBe(true)
    expect(box(/^Needed/).disabled).toBe(true)
    expect(screen.getByText(/Needed by Dependent, so it stays on/)).toBeTruthy()
    act(() => switchPack('needed', false))
    expect(box(/^Needed/).checked).toBe(true)
    // Once nothing needs it, it can go.
    fireEvent.click(box(/^Dependent/))
    fireEvent.click(box(/^Needed/))
    expect(box(/^Needed/).checked).toBe(false)
  })

  it('holds a requirement on even when the stored switches disagree', () => {
    act(() => switchPack('dependent', true))
    // As if written by an older build: the requirement off beneath its dependant.
    localStorage.setItem(
      'coda.packChoices.v1',
      JSON.stringify({ dependent: true, needed: false }),
    )
    resetPackSwitchesForTest()
    openDialog()
    expect(box(/^Needed/).checked).toBe(true)
  })

  it("brings a shortcut's requirements along, and names them in the notice", () => {
    vi.useFakeTimers()
    act(() => applyShortcut('dependent'))
    expect(loadPackChoices()).toEqual({ dependent: true, needed: true })
    expect(useGraphStore.getState().notice).toMatch(/Needed, Dependent|Dependent, Needed/)
  })
})

describe('a pack and its parts', () => {
  it("nests the parts, and greys a part's switch while its parent is off, keeping what it says", () => {
    openDialog()
    const row = (name: RegExp) => screen.getByRole('switch', { name }).closest('label')!
    expect(row(/^neuPrint/).dataset.part).toBe('true')
    act(() => switchPack('connectome', false))
    expect(box(/^neuPrint/).disabled).toBe(true)
    expect(box(/^neuPrint/).checked).toBe(true)
    expect(row(/^neuPrint/).textContent).toContain('Off while Connectome is off.')
    act(() => switchPack('connectome', true))
    expect(box(/^neuPrint/).disabled).toBe(false)
  })
})
