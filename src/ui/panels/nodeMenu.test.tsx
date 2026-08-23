// @vitest-environment jsdom

/**
 * The node's right-click menu, and the two caches it can clear.
 *
 * There are two, and until now only one had a control. **Invalidate Results** drops the
 * scheduler's own result for a node and everything downstream, so `evaluate` runs again;
 * **Clear Cache** reaches the second layer, `loadCachedTable`'s IndexedDB store, which is keyed
 * by what was fetched rather than by the graph and is kept for a month.
 *
 * Conflating them is what made the first look broken: the menu item said "Invalidate cache" and
 * its tooltip claimed it forced a re-fetch, and on a FlyTable node the card cleared and the
 * re-run came back instantly with the same 79 MB of rows. Rendered directly, for
 * `edgeMenu.test.tsx`'s reason.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MockSource } from '../../data/mock/MockSource'
import { registerSource } from '../../data/source'
import '../../nodes'
import { useGraphStore } from '../../store/graphStore'
import { clearStorage } from '../../test/jsdomStubs'
import { NodeContextMenu } from './NodeContextMenu'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  useGraphStore.getState().newGraph()
})

afterEach(cleanup)

function menuOn(type: string): void {
  const id = useGraphStore.getState().addNode(type, { x: 0, y: 0 })
  render(
    <NodeContextMenu nodeId={id} screenPosition={{ x: 0, y: 0 }} onClose={() => undefined} />,
  )
}

describe('the node menu’s two caches', () => {
  it('says Results, not "cache", for the layer it actually drops', () => {
    menuOn('core.filter')
    expect(screen.getByText('Invalidate Results')).toBeTruthy()
    // The old wording. It was on every node and claimed a re-fetch none of them performed.
    expect(screen.queryByText('Invalidate cache')).toBeNull()
  })

  it('offers Clear Cache on a node that reads through one', () => {
    menuOn('annotation.flyTable')
    expect(screen.getByText('Clear Cache')).toBeTruthy()
  })

  it('withholds it on a node that has nothing to clear', () => {
    /*
     * Gated on the node's own `dataCache`, which is one declaration meaning two things: the
     * button appears, and `evaluate` honours `ctx.refresh`. A button on a Filter would promise a
     * re-fetch there is no fetch behind — the same false claim in the other direction.
     */
    menuOn('core.filter')
    expect(screen.queryByText('Clear Cache')).toBeNull()
  })
})
