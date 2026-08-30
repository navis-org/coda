// @vitest-environment jsdom

/**
 * The Data & Privacy dialog.
 *
 * "It renders" is not what is worth pinning here. Two things are.
 *
 * The **citation half has to survive an edit that is only trying to shorten the dialog.** It is
 * the half a reader acquires an obligation from, and it is also the half that looks most like
 * padding to somebody trimming prose — so the claims are asserted rather than the layout, and
 * `Description` is asserted by name because it is the pointer that makes the rest actionable.
 *
 * The **privacy half must not overclaim.** "Nothing leaves your browser" is the sentence this
 * dialog is forever one careless edit away from, and it is false: every dataset node fetches,
 * and the AI assistant sends the graph to a third party. A privacy notice that is wrong in the
 * reassuring direction is worse than none, because it is believed. So the assertion is that
 * fetching and the assistant are both still disclosed.
 *
 * Reached through the `?` menu rather than by rendering the dialog directly — the store request
 * and the menu row are the two halves that can break independently, and a test that calls
 * `requestPrivacy()` itself would pass with no way to open it.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs, installStorageStub } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 1200, height: 800 })
  registerSource(new MockSource())
})

beforeEach(() => {
  installStorageStub()
  clearStorage()
})

afterEach(() => {
  cleanup()
  clearStorage()
})

/** Open the `?` menu and click a row by its bold label. */
function openHelpItem(label: string) {
  fireEvent.click(screen.getByTitle('Help'))
  const row = screen.getByText(label).closest('button')
  expect(row, `no "${label}" row in the ? menu`).toBeTruthy()
  act(() => {
    fireEvent.click(row as HTMLButtonElement)
  })
}

function dialog() {
  return screen.getByRole('dialog', { name: /data and privacy/i })
}

describe('the Data & Privacy dialog', () => {
  beforeEach(() => {
    render(<App />)
    // The start page sits over the toolbar on a fresh store.
    act(() => useGraphStore.getState().closeStartPage())
  })

  it('opens from the ? menu', () => {
    expect(screen.queryByRole('dialog', { name: /data and privacy/i })).toBeNull()
    openHelpItem('Data & Privacy')
    expect(dialog()).toBeTruthy()
  })

  it('closes on Escape, like the other canvas dialogs', () => {
    openHelpItem('Data & Privacy')
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByRole('dialog', { name: /data and privacy/i })).toBeNull()
  })

  describe('the citation notice', () => {
    beforeEach(() => openHelpItem('Data & Privacy'))

    /*
     * The obligation itself. Asserted as "cite" plus "publication", because that pairing is the
     * claim — a dialog that mentions citation only in passing, without saying when it binds,
     * has said nothing a reader has to act on.
     */
    it('states that a publication using a dataset must cite its original sources', () => {
      const text = dialog().textContent ?? ''
      expect(text).toMatch(/publication/i)
      expect(text).toMatch(/cite its original sources/i)
    })

    /*
     * The trap this is really guarding. Coda is the tool, not the data, and "I cited the
     * software" is the specific wrong conclusion available to somebody who read half of this.
     */
    it('says outright that citing Coda is not citing the data', () => {
      expect(dialog().textContent ?? '').toMatch(/citing coda is not citing the data/i)
    })

    /*
     * What makes the rest actionable. The dialog deliberately lists no papers — the publisher's
     * own text does, on the Description node — so losing this pointer turns a real obligation
     * into one with nowhere to go and no way to notice.
     */
    it('points at the Description node for who to cite', () => {
      const cite = dialog().querySelector('.privacy__cite')
      expect(cite).toBeTruthy()
      expect(within(cite as HTMLElement).getByText('Description')).toBeTruthy()
    })
  })

  describe('the data notice', () => {
    beforeEach(() => openHelpItem('Data & Privacy'))

    it('says credentials stay on this machine and are never sent to us', () => {
      const text = dialog().textContent ?? ''
      expect(text).toMatch(/local storage/i)
      expect(text).toMatch(/never sent to us/i)
    })

    /*
     * The overclaim guard. Both of these are things that *do* leave the machine, and a notice
     * that has quietly stopped disclosing either has become reassuring and wrong.
     */
    it('still discloses that data is fetched from publishers and that the assistant sends the graph', () => {
      const text = dialog().textContent ?? ''
      expect(text, 'fetching from the publishers must stay disclosed').toMatch(
        /fetched straight from the publisher/i,
      )
      // Two loose matches rather than one tight one: the sentence spans JSX lines, so a
      // whitespace-sensitive pattern would fail the next time prettier rewraps this file.
      expect(text, 'the assistant sending the graph must stay disclosed').toMatch(
        /graph on your canvas/i,
      )
      expect(text, 'where the assistant sends it must stay disclosed').toMatch(
        /straight to the provider/i,
      )
    })

    it('links the public analytics dashboard rather than describing it', () => {
      const link = within(dialog()).getByRole('link', { name: /dashboard is public/i })
      expect(link.getAttribute('href')).toBe('https://coda-science.goatcounter.com/')
    })
  })
})
