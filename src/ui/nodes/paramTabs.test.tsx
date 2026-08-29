// @vitest-environment jsdom

/**
 * The tab strip on a card whose param band grows with an arity param.
 *
 * `compare.connectivity` carries four settings per dataset, so four datasets is sixteen rows on
 * a card that has to sit beside the graph it belongs to. The strip makes the height constant in
 * the arity rather than linear in it.
 *
 * The arrangement itself — which param lands in which tab — is `paramGroups.test.ts`, headless.
 * What is only answerable with a card mounted is here: that the strip appears at all, that
 * pressing a tab swaps the rows, and above all that no control is *lost* behind it, which is the
 * failure mode a tab strip has and a flat band does not.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

beforeAll(() => {
  installJsdomStubs({ width: 420, height: 300 })
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

async function cardFor(nodeId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const wrapper = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`)
    const card = wrapper?.querySelector('.coda-node')
    if (!card) throw new Error(`no card for ${nodeId}`)
    return card as HTMLElement
  })
}

const tabs = (card: HTMLElement) =>
  [...card.querySelectorAll('.coda-node__tab')].map((t) => t.textContent)
const rows = (card: HTMLElement) =>
  [...card.querySelectorAll('.param .param__label')].map((l) => l.textContent)
const press = (card: HTMLElement, label: string) => {
  const tab = [...card.querySelectorAll('.coda-node__tab')].find((t) => t.textContent === label)
  if (!tab) throw new Error(`no tab "${label}" in ${tabs(card).join(', ')}`)
  act(() => {
    fireEvent.click(tab)
  })
}

/** A fresh Compare Connectivity on the canvas, at the given arity. */
async function compareCard(datasetCount = 2): Promise<HTMLElement> {
  let id = ''
  act(() => {
    id = useGraphStore.getState().addNode('compare.connectivity', { x: 400, y: 400 })
  })
  if (datasetCount !== 2) act(() => useGraphStore.getState().setParam(id, 'datasetCount', datasetCount))
  return cardFor(id)
}

describe('the card of a node with declared param groups', () => {
  it('draws one tab per group, the shared one first', async () => {
    render(<App />)
    expect(tabs(await compareCard(3))).toEqual([
      'Settings',
      'Dataset 1',
      'Dataset 2',
      'Dataset 3',
    ])
  })

  /*
   * The point of the exercise. Four datasets is sixteen per-dataset rows flat; behind tabs the
   * band never draws more than one dataset's worth, whatever the arity is.
   */
  it('draws one tab, not the whole band, however many datasets there are', async () => {
    render(<App />)
    const card = await compareCard(4)
    expect(tabs(card)).toHaveLength(5)
    expect(rows(card)).toEqual(['Datasets', 'Min weight'])
    press(card, 'Dataset 4')
    expect(rows(card)).toEqual(['Name 4', 'Pre 4', 'Post 4', 'Weight 4'])
  })

  /*
   * Nothing is lost: the union over the tabs is exactly the band a flat card would have drawn.
   * A tab strip's failure mode is a control that is on screen nowhere, and it looks like a
   * card that simply has fewer settings than it used to.
   */
  it('reaches every row a flat band would have shown', async () => {
    render(<App />)
    const card = await compareCard(3)
    const seen = new Set<string>()
    for (const label of tabs(card)) {
      press(card, label!)
      for (const row of rows(card)) seen.add(row!)
    }
    expect([...seen].sort()).toEqual(
      [
        'Datasets',
        'Min weight',
        'Name 1',
        'Name 2',
        'Name 3',
        'Post 1',
        'Post 2',
        'Post 3',
        'Pre 1',
        'Pre 2',
        'Pre 3',
        'Weight 1',
        'Weight 2',
        'Weight 3',
      ].sort(),
    )
  })

  /*
   * Turning the arity down takes its tab with it. Held as an id rather than an index, the
   * selection would survive as a tab that no longer exists — a strip with nothing selected and
   * no rows under it.
   */
  it('falls back to the first tab when the selected one leaves', async () => {
    render(<App />)
    let id = ''
    act(() => {
      id = useGraphStore.getState().addNode('compare.connectivity', { x: 400, y: 400 })
    })
    act(() => useGraphStore.getState().setParam(id, 'datasetCount', 4))
    const card = await cardFor(id)
    press(card, 'Dataset 4')
    expect(rows(card)).toEqual(['Name 4', 'Pre 4', 'Post 4', 'Weight 4'])

    act(() => useGraphStore.getState().setParam(id, 'datasetCount', 2))
    expect(tabs(card)).toEqual(['Settings', 'Dataset 1', 'Dataset 2'])
    expect(rows(card)).toEqual(['Datasets', 'Min weight'])
  })

  /*
   * The rule that keeps the strip off cards nobody asked for: past two tabs only. A node with
   * no groups keeps the flat band it always had.
   */
  it('leaves an ungrouped node flat', async () => {
    render(<App />)
    let id = ''
    act(() => {
      id = useGraphStore.getState().addNode('core.sort', { x: 400, y: 500 })
    })
    const card = await cardFor(id)
    expect(card.querySelector('.coda-node__tabs')).toBeNull()
    expect(rows(card).length).toBeGreaterThan(0)
  })
})
