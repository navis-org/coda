// @vitest-environment jsdom

/**
 * An error message a reader can act on.
 *
 * `linkify.test.ts` covers where the links are; this is the half that only exists once something
 * renders them, and it is the half that was reported. A CAVE datastack refuses with the
 * terms-of-service form that would lift the refusal, and on a node card that URL was 10px of
 * text that could be neither clicked nor selected — a remedy somebody had to retype into a
 * browser by eye.
 *
 * The card case is driven the whole way from the refusal rather than by rendering the component
 * into a band: what broke was a *message* reaching a *surface*, so a test that supplies its own
 * message tests neither half of that.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../App'
import { IssueText } from './IssueText'
import { CaveSource } from '../data/cave/CaveSource'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import { resetCredentials, setToken } from '../data/cave/credentials'
import { resetCaveState } from '../data/cave/tables'
import { useGraphStore } from '../store/graphStore'
import { installRefusingCaveFetch, TOS_FORM_URL } from '../test/caveStubs'
import { clearStorage, installJsdomStubs } from '../test/jsdomStubs'

/** The form `missing_tos` names — the link this whole feature exists to make followable. */
const TOS = TOS_FORM_URL

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  resetCaveState()
  resetCredentials()
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().newGraph()
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetCredentials()
  resetCaveState()
})

/**
 * The reported session: an account that may see `minnie65_public` and has not accepted its terms.
 *
 * CAVE's listing filters with `ignore_tos=True`, so the datastack is offered and then refuses —
 * which is what puts a URL into a node's error in the first place. The routes are
 * `caveStubs.ts`', shared with the data-layer suite: two copies of that table had already started
 * to differ over *which* request refuses.
 */
function installRefusingCave(): void {
  setToken('a-working-token')
  installRefusingCaveFetch()
  registerSource(new CaveSource())
}

describe('a refusal that names the page which lifts it, on the card', () => {
  it('reaches the card as a link whose text is where it goes', async () => {
    installRefusingCave()
    render(<App />)
    let id = ''
    act(() => {
      id = useGraphStore.getState().addNode('dataset.minnie65', { x: 200, y: 200 })
    })
    await act(async () => {
      await useGraphStore.getState().runAll()
    })

    const link = await waitFor(() => {
      const found = document
        .querySelector(`.react-flow__node[data-id="${id}"]`)
        ?.querySelector<HTMLAnchorElement>('.coda-node__issue a')
      if (!found) throw new Error('no link in the issue band')
      return found
    })
    expect(link.getAttribute('href')).toBe(TOS)
    /*
     * The full stop that ends the sentence is not part of the URL. A link to `/accept.` 404s on
     * the one page that would have fixed the problem, and reads as Coda naming the wrong URL.
     */
    expect(link.textContent).toBe(TOS)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    // And the sentence it sits in survives, including the part that stops somebody signing in
    // again for a refusal no sign-in can lift.
    const band = link.closest('.coda-node__issue')!
    expect(band.textContent).toContain('MICrONS Data Use')
    expect(band.textContent).toContain('signing in again will not help')
  })

  it('marks the text selectable and undraggable, which React Flow otherwise forbids', async () => {
    installRefusingCave()
    render(<App />)
    act(() => {
      useGraphStore.getState().addNode('dataset.minnie65', { x: 200, y: 200 })
    })
    await act(async () => {
      await useGraphStore.getState().runAll()
    })

    /*
     * `user-select: none` on every node is React Flow's own, right for a card you drag, and the
     * reason the message could not be copied at all. `nodrag` is the other half: without it the
     * drag that starts a selection moves the node instead. The stylesheet carries the selection
     * rule — jsdom performs no layout, so `nodrag` is the half a test can see.
     */
    const text = await waitFor(() => {
      const found = document.querySelector('.coda-node__issue .issue__text')
      if (!found) throw new Error('no message')
      return found
    })
    expect(text.classList.contains('nodrag')).toBe(true)
  })
})

describe('the copy button, where there is room for one', () => {
  it('puts the whole message on the clipboard and says so', async () => {
    const written: string[] = []
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: (t: string) => {
          written.push(t)
          return Promise.resolve()
        },
      },
    })
    const message = `Accept MICrONS Data Use at ${TOS}. Your token is fine.`
    const { getByRole, findByText } = render(<IssueText message={message} copyable />)

    act(() => {
      getByRole('button', { name: 'Copy this message' }).click()
    })
    // The sentence, not the link: what somebody pastes to a colleague has to say what went wrong.
    expect(written).toEqual([message])
    expect(await findByText('Copied')).toBeTruthy()
  })

  it('is absent unless asked for, because a card cannot spare the width', () => {
    const { queryByRole } = render(<IssueText message="something went wrong" />)
    expect(queryByRole('button')).toBeNull()
  })
})
