// @vitest-environment jsdom
/**
 * Laminar Profile, rendered: it draws once its box is measured — the case that shipped broken for
 * a round, the empty state standing in for the unmeasured one and so never getting measured — a
 * panel per facet, and a click stores the depth range within the panel it was made in.
 *
 * jsdom lays out nothing, so geometry is the browser probe's; what is here is the wiring.
 */

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { makeTable } from '../../core/values'
import { frameFor } from '../../packs/cortex/frames'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { LaminarProfileViewer } from './LaminarProfileViewer'

beforeAll(() => installJsdomStubs({ width: 800, height: 500 }))
afterEach(cleanup)

const MINNIE = frameFor('cave', 'minnie65_public:1822')!
const TABLE = makeTable(
  tableSchema(column('neuronId', 'str'), column('partnerType', 'str'), column('depth', 'f64')),
  {
    neuronId: ['a', 'a', 'a', 'b', 'b'],
    partnerType: ['BC', null, 'MC', 'BC', 'BC'],
    depth: [30, 35, 250, 120, 410],
  },
)
const titles = (container: HTMLElement) =>
  [...container.querySelectorAll('svg text[font-weight="600"]')].map(
    (t) => t.textContent?.split(' · ')[0],
  )

describe('the laminar profile', () => {
  it('draws its bars once measured, rather than settling on the empty state', () => {
    const { container, queryByText } = render(
      <LaminarProfileViewer
        table={TABLE}
        depthColumn="depth"
        seriesColumn="partnerType"
        frame={MINNIE}
        binUm={20}
        normalize="count"
      />,
    )
    expect(queryByText(/Nothing to plot/)).toBeNull()
    expect(container.querySelectorAll('svg.chart').length).toBe(1)
    // The untyped partner is named as an absence in the legend, not as a type called "—".
    expect(container.querySelector('.legend')?.textContent).toContain('no partnerType')
  })

  it('draws once there is something to draw, having first mounted with nothing', () => {
    // The ordering `useElementSize` used to miss: mounted on the empty state, whose tree has no
    // measured box, then handed a table that draws — with no remount in between.
    const empty = makeTable(tableSchema(column('depth', 'f64')), { depth: [null] })
    const props = {
      depthColumn: 'depth',
      frame: MINNIE,
      binUm: 20,
      normalize: 'count' as const,
    }
    const { container, rerender, queryByText } = render(
      <LaminarProfileViewer table={empty} {...props} />,
    )
    expect(queryByText(/Nothing to plot/)).toBeTruthy()
    rerender(<LaminarProfileViewer table={TABLE} {...props} />)
    expect(container.querySelectorAll('svg.chart').length).toBe(1)
  })

  it('draws a panel per facet, the largest first', () => {
    const { container } = render(
      <LaminarProfileViewer
        table={TABLE}
        depthColumn="depth"
        facetColumn="neuronId"
        frame={MINNIE}
        binUm={20}
        normalize="percent"
      />,
    )
    expect(titles(container)).toEqual(['a', 'b'])
  })

  it('stores a click as a depth range within the panel it was made in', () => {
    const onSelectionChange = vi.fn()
    const { container } = render(
      <LaminarProfileViewer
        table={TABLE}
        depthColumn="depth"
        facetColumn="neuronId"
        frame={MINNIE}
        binUm={20}
        normalize="count"
        selection={[]}
        onSelectionChange={onSelectionChange}
      />,
    )
    const bar = container.querySelector('svg.chart g[style*="pointer"]')!
    fireEvent.click(bar)
    expect(onSelectionChange).toHaveBeenCalledWith(['20:40|neuronId|a'])
  })

  it('says the depths cannot be drawn, where none can be read', () => {
    const empty = makeTable(tableSchema(column('depth', 'f64')), { depth: [null] })
    const { getByText } = render(
      <LaminarProfileViewer table={empty} depthColumn="depth" binUm={20} normalize="count" />,
    )
    expect(getByText(/no depths in "depth"/)).toBeTruthy()
  })
})
