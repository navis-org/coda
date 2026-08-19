// @vitest-environment jsdom

/**
 * The network viewer's React surface.
 *
 * The canvas itself needs WebGL and cannot render here — the dynamic `sigma` import fails
 * under jsdom and the component reports it through `onError`. What *can* be checked is
 * everything around it, and in particular the caption, which is where the viewer admits
 * what it is not showing. Silence about label culling is precisely what makes a renderer
 * look unreliable: labels come and go with zoom and pan and nothing explains why.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'
import type { NetworkViewerProps } from './NetworkViewer'
import { NetworkViewer } from './NetworkViewer'

beforeAll(() => installJsdomStubs({ width: 800, height: 400 }))
afterEach(cleanup)

const NODE_SCHEMA = tableSchema(column('id', 'str'), column('type', 'str'), column('w', 'f64'))
const EDGE_SCHEMA = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('weight', 'f64'),
)

function build(count: number, fanout: number): NetworkValue {
  const ids = Array.from({ length: count }, (_, i) => `n${i}`)
  const edges: Array<{ source: string; target: string; weight: number }> = []
  for (let i = 0; i < count; i++) {
    for (let step = 1; step <= fanout; step++) {
      edges.push({ source: ids[i]!, target: ids[(i + step) % count]!, weight: i + 1 })
    }
  }
  return {
    kind: 'network',
    directed: true,
    nodes: tableFromRows(
      NODE_SCHEMA,
      ids.map((id, i) => ({ id, type: i % 2 === 0 ? 'LC4' : 'DNp02', w: i + 1 })),
    ),
    edges: tableFromRows(EDGE_SCHEMA, edges),
  }
}

/** A ring: one link per node. */
const ring = (count: number) => build(count, 1)

function draw(network: NetworkValue, extra: Partial<NetworkViewerProps> = {}) {
  render(
    <NetworkViewer
      network={network}
      layout="circular"
      iterations={10}
      nodeColor={{ mode: 'constant', column: undefined, constant: '0' }}
      nodeSize={{ column: undefined, min: 4, max: 18 }}
      edgeColor={{ mode: 'constant', column: undefined, constant: 'muted' }}
      edgeSize={{ column: undefined, min: 0.5, max: 6 }}
      showLabels
      selection={[]}
      {...extra}
    />,
  )
}

describe('NetworkViewer caption', () => {
  it('reports the size of what it is drawing', () => {
    draw(ring(3))
    expect(screen.getByText(/3 nodes · 3 links/)).toBeTruthy()
  })

  it('counts a selection', () => {
    draw(ring(3), { selection: ['n0', 'n1'] })
    expect(screen.getByText(/2 selected/)).toBeTruthy()
  })

  it('stays quiet while every label still fits', () => {
    draw(ring(3))
    expect(screen.queryByText('labels thinned')).toBeNull()
  })

  it('admits it when there are too many node labels to draw them all', () => {
    draw(ring(400))
    expect(screen.getByText('labels thinned')).toBeTruthy()
  })

  it('says nothing about culling when labels are switched off', () => {
    draw(ring(400), { showLabels: false })
    expect(screen.queryByText('labels thinned')).toBeNull()
  })

  it('tracks link labels against their own cap, not the node one', () => {
    // 30 nodes is well inside the node cap; 870 links is well outside the link cap.
    draw(build(30, 29), { showLabels: false, edgeLabels: true })
    expect(screen.getByText('labels thinned')).toBeTruthy()
  })

  it('refuses a graph too large to lay out, and says what to do instead', () => {
    const huge: NetworkValue = {
      ...ring(3),
      nodes: tableFromRows(
        NODE_SCHEMA,
        Array.from({ length: 20_001 }, (_, i) => ({ id: `n${i}` })),
      ),
    }
    draw(huge)
    expect(screen.getByText(/Aggregate upstream/)).toBeTruthy()
    expect(screen.queryByText('labels thinned')).toBeNull()
  })

  it('offers a download menu, because this viewer has more than one export format', () => {
    draw(ring(3), { baseName: 'demo_network' })
    expect(screen.getByLabelText('Download')).toBeTruthy()
  })
})

describe('the caption admits what the filter removed', () => {
  /*
   * A graph that is simply smaller than the data, with nothing on screen saying why, is the
   * failure `labels thinned` already exists to avoid. The node filters its own output, so the
   * only way the viewer can know is by comparing against what arrived.
   */

  it('says nothing when nothing was removed', () => {
    draw(ring(4), { sourceCounts: { nodes: 4, links: 4 } })
    expect(screen.queryByText(/filtered/)).toBeNull()
  })

  it('reports removed nodes and links', () => {
    draw(ring(4), { sourceCounts: { nodes: 10, links: 25 } })
    expect(screen.getByText('6 nodes, 21 links filtered')).toBeTruthy()
  })

  it('names only the half that actually shrank', () => {
    draw(ring(4), { sourceCounts: { nodes: 4, links: 9 } })
    expect(screen.getByText('5 links filtered')).toBeTruthy()
  })

  it('stays quiet with no source to compare against', () => {
    draw(ring(4))
    expect(screen.queryByText(/filtered/)).toBeNull()
  })
})

describe('NetworkLegend', () => {
  /*
   * Four channels can be live at once and every one needs a key. Before this the screen drew
   * categorical swatches only — a sequential ramp had no key at all, and neither size channel
   * had one anywhere but in the exported file.
   */

  it('keys a categorical node colour', () => {
    draw(ring(4), {
      nodeColor: { mode: 'categorical', column: 'type', constant: '0' },
    })
    expect(screen.getByText('LC4')).toBeTruthy()
    expect(screen.getByText('DNp02')).toBeTruthy()
  })

  it('draws a colour bar for a sequential node colour, which had no on-screen key at all', () => {
    draw(ring(4), {
      nodeColor: { mode: 'sequential', column: 'w', constant: '0' },
    })
    const bar = document.body.querySelector('.colorbar')!
    expect(bar.querySelector('.colorbar__ramp')).toBeTruthy()
    // Ends labelled, so the ramp means something. The label text brackets the ramp element,
    // hence reading the group's text rather than querying for a standalone node.
    expect(bar.textContent).toBe('14')
    expect(screen.getByText('w')).toBeTruthy()
  })

  it('keys node size with discs and the range they stand for', () => {
    draw(ring(4), { nodeSize: { column: 'w', min: 4, max: 18 } })
    expect(screen.getByText('size w')).toBeTruthy()
    expect(document.body.querySelectorAll('.legend__disc').length).toBe(2)
  })

  it('names the link channels, and leaves the node ones unlabelled', () => {
    draw(ring(4), {
      nodeColor: { mode: 'categorical', column: 'type', constant: '0' },
      edgeSize: { column: 'weight', min: 0.5, max: 6 },
    })
    expect(screen.getByText('link width weight')).toBeTruthy()
    expect(screen.queryByText(/^nodes /)).toBeNull()
  })

  it('keeps identity in a card but stands the magnitude ramps down', () => {
    draw(ring(4), {
      compact: true,
      nodeColor: { mode: 'categorical', column: 'type', constant: '0' },
      nodeSize: { column: 'w', min: 4, max: 18 },
    })
    // Colour is identity — without its key it says nothing, so it survives `compact`.
    expect(screen.getByText('LC4')).toBeTruthy()
    // Size is a comparison the reader can make by eye; its key costs a row of a 150px card.
    expect(screen.queryByText('size w')).toBeNull()
  })

  it('renders no strip at all when nothing is encoded', () => {
    draw(ring(4))
    expect(document.body.querySelector('.legend')).toBeNull()
  })
})

describe('the action strip', () => {
  /*
   * Verbs, not settings: fit, re-layout, freeze and find have no value to store, so they
   * cannot live in the styling panel beside the params. Only `find` writes to the graph, and
   * only when you press Enter.
   */

  it('offers the actions that have no home in the params panel', () => {
    draw(ring(4))
    expect(screen.getByLabelText('Fit to view')).toBeTruthy()
    expect(screen.getByLabelText('Re-run layout')).toBeTruthy()
    expect(screen.getByLabelText('Find nodes')).toBeTruthy()
  })

  it('stays out of a card preview, where it would cost more than it gives', () => {
    draw(ring(4), { compact: true })
    expect(screen.queryByLabelText('Find nodes')).toBeNull()
  })

  it('offers no freeze or skip control for a layout that does not move', () => {
    /*
     * Only the force layout keeps settling — and only above `FORCE_SYNC_BELOW`, since a small
     * graph is settled synchronously and arrives finished. Freezing a circular layout, or one
     * that has already stopped, means nothing.
     */
    draw(ring(4))
    expect(screen.queryByLabelText('Freeze layout')).toBeNull()
    expect(screen.queryByLabelText('Resume layout')).toBeNull()
    expect(screen.queryByLabelText('Skip to settled layout')).toBeNull()
  })

  it('counts what a search matches', () => {
    draw(ring(12))
    fireEvent.change(screen.getByLabelText('Find nodes'), { target: { value: 'n1' } })
    // n1, n10, n11 — a substring match, not an exact one.
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('matches the label column as well as the id', () => {
    draw(ring(4), { labelColumn: 'type' })
    fireEvent.change(screen.getByLabelText('Find nodes'), { target: { value: 'DNp02' } })
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('writes nothing until Enter, and then writes the matches as a selection', () => {
    const onSelectionChange = vi.fn()
    draw(ring(12), { onSelectionChange })

    const find = screen.getByLabelText('Find nodes')
    fireEvent.change(find, { target: { value: 'n1' } })
    expect(onSelectionChange).not.toHaveBeenCalled()

    fireEvent.keyDown(find, { key: 'Enter' })
    expect(onSelectionChange).toHaveBeenCalledWith(['n1', 'n10', 'n11'])
  })

  it('does not select an empty result', () => {
    const onSelectionChange = vi.fn()
    draw(ring(4), { onSelectionChange })
    const find = screen.getByLabelText('Find nodes')
    fireEvent.change(find, { target: { value: 'nothing-here' } })
    fireEvent.keyDown(find, { key: 'Enter' })
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('clears on Escape', () => {
    draw(ring(4))
    const find = screen.getByLabelText('Find nodes') as HTMLInputElement
    fireEvent.change(find, { target: { value: 'n1' } })
    fireEvent.keyDown(find, { key: 'Escape' })
    expect(find.value).toBe('')
  })
})
