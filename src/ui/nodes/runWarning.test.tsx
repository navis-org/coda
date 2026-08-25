// @vitest-environment jsdom

/**
 * What a node says about a result it produced anyway.
 *
 * Coda's guard rails used to be refusals: past the ceiling there was no result, and the message
 * explaining that took the card's issue line. Nearly all of them are warnings now
 * (`core/limits.ts`), which needed a channel that did not exist — `evaluate` could only return
 * or throw, and `validate`'s warnings are edit-time and cannot see a row count.
 *
 * Three things are worth pinning about it, and none of them is visible in a type:
 *
 * - the warning reaches the **card**, in the place the refusal used to occupy;
 * - a run **error still wins**, because a node with no result has nothing to caveat;
 * - it reaches the **inspector** too, above the edit-time issues, since that is where somebody
 *   looks after noticing the badge.
 *
 * The scheduler half — raised while running, kept with the cached result, deduped — is pinned in
 * `core/scheduler.test.ts`.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../../App'
import { nodeIssues } from './nodeIssues'
import { registerNode } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage, installJsdomStubs } from '../../test/jsdomStubs'

/** Flipped per test: the same node warns, or warns and then fails. */
let alsoFails = false

beforeAll(() => {
  installJsdomStubs({ width: 420, height: 300 })
  registerSource(new MockSource({ latencyMs: 0 }))
  registerNode({
    type: 'test.warns',
    label: 'Warns',
    category: 'utility',
    cost: 'cheap',
    inputs: [],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: (ctx) => {
      // At the top, before the expensive part — the contract `EvalContext.warn` states, and the
      // whole reason the warning is worth anything while a fetch is still in flight.
      ctx.warn('40,000 neurons is about twenty minutes.')
      if (alsoFails) throw new Error('the server said no')
      return { out: tableFromRows(tableSchema(column('x', 'i64')), [{ x: 1 }]) }
    },
  })
})

beforeEach(() => {
  clearStorage()
  alsoFails = false
  act(() => {
    useGraphStore.getState().closeStartPage()
    useGraphStore.getState().newGraph()
  })
})

afterEach(cleanup)

async function runOne(): Promise<HTMLElement> {
  render(<App />)
  const id = useGraphStore.getState().addNode('test.warns', { x: 0, y: 0 })
  await act(async () => {
    useGraphStore.getState().setSelection([id])
    await useGraphStore.getState().runAll()
  })
  return waitFor(() => {
    const card = document
      .querySelector(`.react-flow__node[data-id="${id}"]`)
      ?.querySelector('.coda-node')
    if (!card) throw new Error('no card')
    return card as HTMLElement
  })
}

const issueOf = (card: HTMLElement) => card.querySelector('.coda-node__issue')

describe('a run warning on the card', () => {
  it('says what the node did anyway, in the line a refusal used to take', async () => {
    const card = await runOne()
    await waitFor(() => expect(issueOf(card)?.textContent).toContain('twenty minutes'))
    expect(issueOf(card)?.getAttribute('data-severity')).toBe('warning')
    // The half that makes it a warning rather than an error: there is a result under it.
    expect(card.querySelector('.coda-node')?.getAttribute('data-state')).not.toBe('error')
  })

  it('stands aside for a run error, which is about there being no result at all', async () => {
    alsoFails = true
    const card = await runOne()
    await waitFor(() => expect(issueOf(card)?.textContent).toContain('the server said no'))
    expect(issueOf(card)?.getAttribute('data-severity')).toBe('error')
  })

  it('reaches the inspector, where the reason is read rather than glimpsed', async () => {
    await runOne()
    // Closed by default, so a card badge is what sends somebody here in the first place.
    act(() => useGraphStore.getState().togglePanel('inspector'))
    await waitFor(() => {
      const issues = [...document.querySelectorAll('.inspector .issue')].map(
        (el) => el.textContent ?? '',
      )
      expect(issues.join(' ')).toContain('twenty minutes')
    })
  })
})

/**
 * The ranking itself, where the card and the inspector both read it from.
 *
 * Worth its own case because the two surfaces disagreed while each held its own copy: the card
 * put a run warning below an inference error and the inspector put it above one, so the same
 * node's first line said two different things depending on where you read it.
 */
describe('the order the three sources are ranked in', () => {
  const inferred = [
    { severity: 'warning' as const, message: 'edit-time warning' },
    { severity: 'error' as const, message: 'type error' },
  ]

  it('puts both errors above both warnings, and the run ahead of inference within each', () => {
    const ranked = nodeIssues({ state: 'error', error: 'run error' }, inferred, 'run warning')
    expect(ranked.map((i) => i.message)).toEqual([
      'run error',
      'type error',
      'run warning',
      'edit-time warning',
    ])
  })

  it('is empty for a node with nothing to say, so no surface draws a blank row', () => {
    expect(nodeIssues({ state: 'ok' }, [], undefined)).toEqual([])
  })

  it('reads a run error only while the node is in that state', () => {
    // `NodeRunInfo.error` outlives nothing, but a node re-run to `ok` keeps no stale message.
    expect(nodeIssues({ state: 'ok', error: 'stale' }, [], undefined)).toEqual([])
  })
})
