// @vitest-environment jsdom

/**
 * The Data sources dialog: its tabs, and the promise it makes about credentials.
 *
 * Two things are worth pinning here. A tab bar that renders but does not *switch* looks
 * finished from a screenshot, so the mock's copy has to be absent until its tab is picked.
 * And the privacy note is the answer to "where does my token go?" — it is stated above the
 * field that asks for one, so its position is part of what it says.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { MockSource } from '../../data/mock/MockSource'
import { reportAuthFailure, resetCredentials } from '../../data/neuprint/credentials'
import { registerSource } from '../../data/source'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { SourcesPanel } from './SourcesPanel'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

afterEach(() => {
  cleanup()
  resetCredentials()
})

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Sources' }))
const tab = (name: string) => screen.getByRole('tab', { name })
const tokenField = () => screen.queryByRole('textbox', { name: /Token/ })
const privacy = () => document.querySelector('.sources__privacy')

describe('source tabs', () => {
  it('shows one tab per source and opens on neuPrint', () => {
    render(<SourcesPanel />)
    open()

    expect(screen.getAllByRole('tab').map((el) => el.textContent)).toEqual([
      'neuPrint',
      'Mock connectome',
    ])
    expect(tab('neuPrint').getAttribute('aria-selected')).toBe('true')
    expect(tokenField()).not.toBeNull()
  })

  it('switches panels rather than only restyling the bar', () => {
    render(<SourcesPanel />)
    open()

    fireEvent.click(tab('Mock connectome'))
    expect(tab('Mock connectome').getAttribute('aria-selected')).toBe('true')
    // The credential form belongs to the tab that was left, not to the dialog.
    expect(tokenField()).toBeNull()
    expect(screen.getByRole('tabpanel').textContent).toMatch(/no token, no network/i)

    fireEvent.click(tab('neuPrint'))
    expect(tokenField()).not.toBeNull()
  })

  it('lands on the tab an auth failure is about, even when already open elsewhere', () => {
    render(<SourcesPanel />)
    open()
    fireEvent.click(tab('Mock connectome'))

    act(() => reportAuthFailure('neuPrint rejected the token (401)'))

    expect(tab('neuPrint').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText(/rejected the token/)).not.toBeNull()
    // The reason is worth nothing without the field that answers it.
    expect(tokenField()).not.toBeNull()
  })

  it('opens itself on an auth failure', () => {
    render(<SourcesPanel />)
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => reportAuthFailure('neuPrint rejected the token (401)'))

    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(tab('neuPrint').getAttribute('aria-selected')).toBe('true')
  })
})

describe('the credential promise', () => {
  it('states where a token is kept, and where it is not', () => {
    render(<SourcesPanel />)
    open()

    const text = privacy()?.textContent ?? ''
    expect(text).toMatch(/local storage/i)
    expect(text).toMatch(/never written into a saved graph/i)
    expect(text).toMatch(/third party/i)
  })

  it('is above the tabs, so it is read before a source is chosen', () => {
    render(<SourcesPanel />)
    open()

    const note = privacy()
    const tabs = document.querySelector('.sources__tabs')
    expect(note).not.toBeNull()
    expect(note?.compareDocumentPosition(tabs as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('is not repeated inside the tab that asks for the token', () => {
    // It was per-source copy before; two statements of the same promise is how one of them
    // goes stale without anyone noticing.
    render(<SourcesPanel />)
    open()

    expect(screen.getByRole('tabpanel').textContent).not.toMatch(/local storage/i)
  })
})
