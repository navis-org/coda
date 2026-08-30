// @vitest-environment jsdom

/**
 * The Skeletons card saying where its skeletons come from.
 *
 * The node-level tests beside `morphology.ts` assert the option list and the refusal; this is the
 * half that only exists once something renders it, and it is the half the feature was asked for.
 * Two facts, and both are visible on the card rather than in the inspector:
 *
 *  - **Before a run**, the `Source` dropdown names the route Automatic will take. On a
 *    single-route dataset that is the whole of what the control does, and it is why it is not
 *    `advanced` — a blank "Automatic" is a provenance question mark on every graph anyone shares.
 *  - **After a run**, the footer names the route that answered, through
 *    `SkeletonsValue.provenance` and `describeValue`.
 *
 * The mock is the dataset on purpose: it has exactly one route, which is the configuration every
 * other backend also has most of the time, and it is the one where a control that said nothing
 * would look most reasonable.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 900, height: 600 })
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadExample('morphology')
  })
})

afterEach(cleanup)

function skeletonsCard(): Promise<HTMLElement> {
  const id = useGraphStore.getState().graph.nodes.find((n) => n.type === 'neuron.skeletons')?.id
  if (!id) throw new Error('no Skeletons node in the example')
  return waitFor(() => {
    const card = document
      .querySelector(`.react-flow__node[data-id="${id}"]`)
      ?.querySelector('.coda-node')
    if (!card) throw new Error('no card')
    return card as HTMLElement
  })
}

describe('the Skeletons card', () => {
  it('names the route Automatic will take, on the card rather than in the inspector', async () => {
    render(<App />)
    const card = await skeletonsCard()
    const select = await waitFor(() => {
      const found = card.querySelector('select')
      if (!found) throw new Error('no Source dropdown on the card')
      return found
    })
    // The mock has one route, so the dropdown is one settled entry naming it — not an empty
    // control, which reads as broken, and not a bare "Automatic", which names nothing.
    expect([...select.options].map((o) => o.textContent)).toEqual(['Automatic (synthetic)'])
    expect(select.value).toBe('')
  })

  it('names the route that answered once the fetch has run', async () => {
    render(<App />)
    await act(async () => {
      await useGraphStore.getState().runAll()
    })
    const card = await skeletonsCard()
    // `describeValue`'s footer. Ahead of the space and the units, which are the same whichever
    // route answered — this is the one part of the line a count cannot imply.
    await waitFor(() => expect(card.textContent).toContain('synthetic'))
    expect(card.textContent).toMatch(/skeletons · .* pts · synthetic/)
  })
})
