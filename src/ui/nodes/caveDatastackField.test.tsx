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

const rows = (card: HTMLElement) =>
  [...card.querySelectorAll('.param .param__label')].map((l) => l.textContent)

/** The Datastack field, and the options of whatever list it points at. */
function datastackField(card: HTMLElement): {
  input: HTMLInputElement
  completions: string[]
} {
  const input = card.querySelector<HTMLInputElement>('input[aria-label="Datastack"]')
  if (!input) throw new Error(`no Datastack field; card asks ${rows(card).join(', ')}`)
  const list = input.getAttribute('list')
  // Found by id rather than by selector: `useId` spells one `:r3:`, which is a valid id and not
  // a valid selector without escaping.
  const options = list ? [...(document.getElementById(list)?.children ?? [])] : []
  return {
    input,
    completions: options.map((o) => o.getAttribute('value') ?? ''),
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
     * is an ordinary configuration, and its whole consequence is that Connectivity declines.
     */
    expect(rows(card)).toEqual(['Datastack', 'Materialization', 'Neuron table', 'ID column'])
  })

  it('completes the datastack name once a token can list them', async () => {
    setToken('test-token')
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
    setToken('test-token')
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
     * A `datalist` with no options renders as a field with an arrow onto nothing, which claims
     * the set is empty where the truth is that nobody has signed in. And the request itself is
     * withheld: `client.ts` reports an auth failure for a tokenless call, which would put "No
     * CAVE token" in the status bar at somebody who has only dragged a node onto the canvas.
     */
    expect(datastackField(card).input.getAttribute('list')).toBeNull()
    expect(card.querySelector('datalist')).toBeNull()
    expect(calls.filter((c) => c.url.endsWith('/datastacks'))).toEqual([])
  })
})
