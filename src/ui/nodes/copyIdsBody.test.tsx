// @vitest-environment jsdom

/**
 * The Copy IDs card, in the real editor.
 *
 * Three things here fail without throwing. A custom body replaces the generic param rows
 * outright, so a control this body forgets exists only in the inspector — on screen that is
 * indistinguishable from a control nobody added. The **count** is derived from the value with
 * the same function the button copies with, so a card reading "5 ids" beside a clipboard
 * holding three is the failure to guard, not a missing number. And a press with nothing wired
 * copies an *empty string*, which looks exactly like a press that worked — hence the disabled
 * state is asserted rather than assumed.
 *
 * The joining rule itself is `nodes/lib/copyIds.test.ts`; what is pinned here is that the card
 * copies what it says it will.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph } from '../../core/graph'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { MockSource } from '../../data/mock/MockSource'
import { mockDatasetIds } from '../../data/mock/generate'
import { copyIds } from '../../nodes/lib/copyIds'
import { isTableValue } from '../../core/values'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

const DATASET = mockDatasetIds()[0]!

/**
 * jsdom has no `navigator.clipboard` at all, and `copyText` reports that absence as a sentence
 * rather than throwing past it — so without this stub every press here would be testing the
 * error path. Defined rather than saved-and-restored: there is nothing under it to put back,
 * and the environment is per file, so nothing downstream could see it either way.
 */
const written: string[] = []

beforeAll(() => {
  installJsdomStubs({ width: 1000, height: 700 })
  registerSource(new MockSource({ latencyMs: 0 }))
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        written.push(text)
        return Promise.resolve()
      },
    },
  })
})

beforeEach(() => {
  clearStorage()
  written.length = 0
})

afterEach(cleanup)

function node(id: string, type: string, extra: Record<string, unknown> = {}) {
  const col = { ds: 0, find: 1, copy: 2 }[id] ?? 3
  return {
    id,
    type,
    position: { x: col * 320, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...extra } as never,
  }
}

/** A dataset, a search and the card, or the card on its own with nothing wired. */
function graphWith(params: Record<string, unknown>, wired: boolean): CodaGraph {
  let g = emptyGraph('copy')
  g = addNode(g, node('copy', 'out.copyIds', params))
  if (!wired) return g
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(g, node('find', 'neuron.findNeurons', { limit: 3 }))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'copy',
    targetHandle: 'neurons',
  })
  return g
}

async function open(params: Record<string, unknown> = {}, wired = true) {
  render(<App />)
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().loadGraph(graphWith(params, wired))
  })
  return await waitFor(() => {
    const body = document.querySelector('.list-body')
    if (!body) throw new Error('no Copy IDs body rendered')
    return body as HTMLElement
  })
}

async function run() {
  await act(async () => {
    await useGraphStore.getState().runAll()
  })
}

function button(body: HTMLElement): HTMLButtonElement {
  return body.querySelector('.list-body__go') as HTMLButtonElement
}

/**
 * The ids this card was actually handed, read off its own output.
 *
 * Not a second `MockSource` fetch with the search's `limit` mirrored by hand: that spelling
 * agrees with the card only for as long as somebody keeps the two limits in step, and when it
 * stops agreeing the failure is in the assertion rather than in the code.
 */
function foundIds(): string[] {
  const out = useGraphStore.getState().nodeOutput('copy', 'neurons')
  if (!isTableValue(out)) throw new Error('the card has no neurons on its output')
  return copyIds(out, true)
}

describe('Copy IDs card', () => {
  it('renders every non-advanced param exactly once, in declaration order', async () => {
    // A body owns the whole card area; a control it leaves out is reachable only from the
    // inspector, which on screen reads as a control that was never added.
    const body = await open()
    const labels = [...body.querySelectorAll('.param__label')].map((el) => el.textContent)
    expect(labels).toEqual(['Separator', 'Deduplicate', 'Quote ids'])
  })

  it('refuses the press before a run, and says which of the two states it is in', async () => {
    // A press with nothing to copy writes an empty string, which is indistinguishable from a
    // press that worked — so the button is disabled and the foot says why.
    const body = await open({}, false)
    expect(button(body).disabled).toBe(true)
    expect(body.textContent).toContain('Not run yet')
  })

  it('counts the ids once the graph has run', async () => {
    const body = await open()
    await run()
    await waitFor(() => expect(body.textContent).toContain('3 ids'))
    expect(button(body).disabled).toBe(false)
  })

  it('copies exactly what the settings say, and reports it', async () => {
    const body = await open({ separator: 'commaSpace', quoted: true })
    await run()
    await waitFor(() => expect(button(body).disabled).toBe(false))
    fireEvent.click(button(body))

    const expected = foundIds()
      .map((id) => `"${id}"`)
      .join(', ')
    await waitFor(() => expect(written).toEqual([expected]))
    // The press is invisible otherwise — nothing on the canvas changes, and the clipboard is
    // somewhere else — so the button says so itself.
    await waitFor(() => expect(button(body).textContent).toBe('Copied'))
  })

  it('passes its neurons through, so it can sit mid-chain', async () => {
    // The half of a tap nothing on the card shows: a Copy IDs node that swallowed its input
    // would leave every node below it blocked, and only a longer graph would notice.
    await open()
    await run()
    const out = useGraphStore.getState().nodeOutput('copy', 'neurons')
    expect(out?.kind).toBe('neurons')
  })
})
