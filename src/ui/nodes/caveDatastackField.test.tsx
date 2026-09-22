// @vitest-environment jsdom

/**
 * The Custom CAVE card: which questions it asks on its face, and how the Datastack field is
 * answered.
 *
 * The node-level tests beside `dataset/index.ts` assert the completions callback and which params
 * are `advanced`; this is the half that only exists once something renders them, and it is the
 * half the feature was asked for. Two facts:
 *
 *  - **The field completes from the datastacks the token can see** — `/info/api/v2/datastacks` is
 *    permission-filtered, so signing in is what fills it — while staying a *text* field. A
 *    `select` would be wrong three separate ways here: a private datastack need not be in any
 *    listing, a login token expires in a week, and the reply has not landed on the first render
 *    of any session.
 *  - **The neuron table and its id column are on the card**, because `validate` asks for the
 *    first of them by name and the inspector is closed by default.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { resetCredentials, setToken } from '../../data/cave/credentials'
import { resetCaveState } from '../../data/cave/tables'
import { useGraphStore } from '../../store/graphStore'
import { installCaveFetch } from '../../test/caveStubs'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'
import { DEFAULT_CAVE_SERVER } from '../../data/cave/deployments'

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

async function customCaveCard(): Promise<HTMLElement> {
  let id = ''
  act(() => {
    id = useGraphStore.getState().addNode('dataset.cave', { x: 200, y: 200 })
  })
  return waitFor(() => {
    const card = document
      .querySelector(`.react-flow__node[data-id="${id}"]`)
      ?.querySelector('.coda-node')
    if (!card) throw new Error('no Custom CAVE card')
    return card as HTMLElement
  })
}

/*
 * The questions on the card's face, as the **dataset body** draws them.
 *
 * Deliberately not the generic band's `.param` rows as well: this card drew those for as long as
 * it had no `NODE_BODIES` entry, which is how it silently lost the whole foot — the resolved
 * dataset id, the refresh and the Edge data button — while this assertion stayed green. A
 * selector matching both spellings would let that happen again.
 */
const rows = (card: HTMLElement) =>
  [...card.querySelectorAll('.dataset-body__field .param__label')].map((l) => l.textContent)

/**
 * The Datastack field, and the options its list offers once opened.
 *
 * Opened by focusing it, which is what somebody clicking into the field does. The list is
 * portalled to the body, so it is found through `aria-controls` rather than inside the card.
 */
function datastackField(card: HTMLElement): {
  input: HTMLInputElement
  completions: string[]
} {
  const input = card.querySelector<HTMLInputElement>('input[aria-label="Datastack"]')
  if (!input) throw new Error(`no Datastack field; card asks ${rows(card).join(', ')}`)
  act(() => {
    fireEvent.focus(input)
  })
  const list = input.getAttribute('aria-controls')
  // Found by id rather than by selector: `useId` spells one `:r3:`, which is a valid id and not
  // a valid selector without escaping.
  const options = list
    ? [...(document.getElementById(list)?.querySelectorAll('[role="option"]') ?? [])]
    : []
  return {
    input,
    completions: options.map((o) => o.textContent ?? ''),
  }
}

describe('the Custom CAVE card', () => {
  it('asks for the neuron table and its id column on the card, and the rest in the inspector', async () => {
    render(<App />)
    const card = await customCaveCard()

    /*
     * The card's own `validate` says "name a table listing this datastack's neurons" — so with
     * that field in the inspector, which is closed by default, the card was asking for something
     * it did not show. The connection view is deliberately still inspector-only: not naming one
     * is an ordinary configuration, and its whole consequence is that Connectivity declines. So
     * is the global server: nearly every datastack is on the default deployment, so on the card it
     * would be a row that almost never changes.
     */
    expect(rows(card)).toEqual(['Datastack', 'Materialization', 'Neuron table', 'ID column'])
  })

  it('completes the datastack name once a token can list them', async () => {
    setToken(DEFAULT_CAVE_SERVER, 'test-token')
    installCaveFetch()
    render(<App />)
    const card = await customCaveCard()

    // `reportSourceLearned` is what gets it here: the peek cannot answer the first render, so
    // the listing lands, re-inference runs, and the field grows its popup a beat later.
    await waitFor(() => expect(datastackField(card).completions).toContain('wclee_aedes_brain'))
    // Everything the info service lists, not the three `spec.ts` wires: this node is for the
    // datastack Coda ships no spec for, and `validate` is what says so about the others.
    expect(datastackField(card).completions).toHaveLength(13)
  })

  it('stays a text field, so a datastack no listing mentions can still be named', async () => {
    setToken(DEFAULT_CAVE_SERVER, 'test-token')
    installCaveFetch()
    render(<App />)
    const card = await customCaveCard()
    await waitFor(() => expect(datastackField(card).completions).toHaveLength(13))

    const { input } = datastackField(card)
    act(() => {
      fireEvent.change(input, { target: { value: 'nobodys_private_stack' } })
      fireEvent.blur(input)
    })

    const node = useGraphStore.getState().graph.nodes.find((n) => n.type === 'dataset.cave')
    expect(node?.params.datastack).toBe('nobodys_private_stack')
  })

  it('draws no popup at all before there is a token', async () => {
    const calls = installCaveFetch()
    render(<App />)
    const card = await customCaveCard()

    /*
     * A list with no options would be a field with an arrow onto nothing, which claims the set
     * is empty where the truth is that nobody has signed in. And the request itself is withheld:
     * `client.ts` reports an auth failure for a tokenless call, which would put "No CAVE token"
     * in the status bar at somebody who has only dragged a node onto the canvas.
     */
    const { input } = datastackField(card)
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.classList.contains('field--combo')).toBe(false)
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(calls.filter((c) => c.url.endsWith('/datastacks'))).toEqual([])
  })
})
