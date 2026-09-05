// @vitest-environment jsdom

/**
 * The Network Metrics card: which value reaches it, and what it says about a graph.
 *
 * The routing is the part that has shipped broken here before. This card draws from the node's
 * *input* rather than from its own output — `networkMetrics` is memoised on the network object
 * and `evaluate` was handed the input, so reading the input is a cache hit and reading the output
 * is a second triangle count on every render — which means the branch has to sit **above**
 * `ValuePreview`'s `!value` guard. `out.datasetSummary` shipped below that guard once and showed
 * "No result yet" permanently, with a green suite, because every test rendered its viewer
 * directly and so never reached the dispatcher. So this renders through `ValuePreview`, with no
 * value, exactly as a card does before the node itself has run.
 *
 * The other half is the controls, which are on the card rather than in the param band — every
 * one of this node's params is `advanced`, so the tile headings are the *only* place they can be
 * reached from the canvas. A control that writes the wrong param id, or one that reports a
 * column the node is not holding, is invisible to a type check and to the eye.
 *
 * jsdom performs no layout, so nothing about how the tiles *look* is testable here — the bars
 * have no width and the scatter has no size. What is testable is which numbers were computed,
 * which plots decided they had something to draw, and what the pickers offer and write.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ParamValue, ParamValues } from '../../core/node'
import { defaultParams, makeInferContext } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { ValuePreview } from './ValuePreview'
import '../../nodes'

beforeAll(() => installJsdomStubs({ width: 620, height: 620 }))
afterEach(cleanup)

const NODE_SCHEMA = tableSchema(column('id', 'str'))
const EDGE_SCHEMA = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('weight', 'f64'),
)

function network(
  ids: string[],
  links: Array<[string, string, number]>,
  directed = true,
): NetworkValue {
  return {
    kind: 'network',
    directed,
    nodes: tableFromRows(
      NODE_SCHEMA,
      ids.map((id) => ({ id })),
    ),
    edges: tableFromRows(
      EDGE_SCHEMA,
      links.map(([source, target, weight]) => ({ source, target, weight })),
    ),
  }
}

/** A triangle, a pendant and an island: enough for every tile to have something to say. */
function sample(): NetworkValue {
  return network(
    ['a', 'b', 'c', 'd', 'lonely'],
    [
      ['a', 'b', 10],
      ['b', 'c', 20],
      ['c', 'a', 30],
      ['a', 'd', 40],
    ],
  )
}

function draw(
  value: NetworkValue | undefined,
  params: Record<string, ParamValue> = {},
  onParamChange?: (id: string, value: ParamValue) => void,
) {
  const def = requireNodeDef('net.metrics')
  const merged: ParamValues = { ...defaultParams(def), ...params }
  const inputs = { in: T.network(NODE_SCHEMA, EDGE_SCHEMA) }
  return render(
    <ValuePreview
      node={{ id: 'm', type: 'net.metrics', position: { x: 0, y: 0 }, params: merged } as never}
      // Deliberately `undefined`: the card has to draw before this node's own output exists,
      // which is the whole reason its branch sits above `ValuePreview`'s `!value` guard.
      value={undefined}
      ctx={makeInferContext(def, merged, inputs)}
      inputValues={value ? { in: value } : {}}
      {...(onParamChange ? { onParamChange } : {})}
      compact
    />,
  )
}

describe('the Network Metrics card', () => {
  it('draws from the input, with no output value of its own', () => {
    draw(sample())
    expect(screen.queryByText(/No result yet/)).toBeNull()
    expect(screen.getByText('Graph')).toBeTruthy()
  })

  it('says "no result yet" when nothing is wired, rather than an empty grid', () => {
    draw(undefined)
    expect(screen.getByText(/No result yet/)).toBeTruthy()
  })

  it('names the graph in the caption, directedness included', () => {
    draw(sample())
    // The caption is the one place the numbers are stated rather than drawn, so it is the one
    // thing jsdom can check about what was measured.
    expect(screen.getByText(/5 nodes · 4 links · directed · 2 components/)).toBeTruthy()
  })

  it('keeps degree and weight as numbers whatever the histogram is pointed at', () => {
    // The reason those two tiles exist: the histogram used to be three fixed plots, and the
    // mean degree lived on one of them. Pointed at `clustering`, that number would have gone
    // with it — a figure a reader compares across graphs, gone because a plot changed.
    draw(sample(), { histColumn: 'nodes:clustering' })
    for (const label of ['Degree', 'Link weight', 'Components', 'Structure']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('draws both plots, and names the scatter’s axes', () => {
    draw(sample())
    expect(screen.getByText('Scatter')).toBeTruthy()
    expect(screen.getByText('Distribution')).toBeTruthy()
    // The scatter names its axes, so a picker left on a column the network lost is visible
    // rather than silently drawing something else.
    expect(screen.getByText('clustering × degree')).toBeTruthy()
  })

  it('says the scatter has nothing to place rather than drawing an empty box', () => {
    // Two leaves on one link: neither has a pair of neighbours, so `clustering` is null for
    // both — which is a point with no position, not a point at zero.
    draw(network(['a', 'b'], [['a', 'b', 1]]))
    expect(screen.getByText('No node has both')).toBeTruthy()
  })

  it('drops the tiles that would say nothing on an undirected graph', () => {
    // `reciprocity` is 1 by construction without arrows, so the Structure tile shows the facts
    // that apply rather than an em-dash where a number would be.
    draw(
      network(
        ['a', 'b', 'c'],
        [
          ['a', 'b', 1],
          ['b', 'c', 1],
        ],
        false,
      ),
    )
    expect(screen.getByText('undirected')).toBeTruthy()
    expect(screen.queryByText('reciprocity')).toBeNull()
  })

  it('survives a network with no links at all', () => {
    draw(network(['a', 'b'], []))
    expect(screen.getByText(/2 nodes · 0 links/)).toBeTruthy()
    expect(screen.getByText('Distribution')).toBeTruthy()
  })
})

describe('the controls on the tiles', () => {
  it('offers every numeric node column on both scatter axes', () => {
    draw(sample())
    const x = screen.getByLabelText('Scatter x axis') as HTMLSelectElement
    const offered = [...x.options].map((option) => option.value)
    // The metrics, not the incoming network's columns — the whole point of `schemaFrom` on the
    // param, asserted here against the table the card actually holds.
    expect(offered).toContain('degree')
    expect(offered).toContain('clustering')
    expect(offered).toContain('coreness')
    // `id` is a string column and never an axis.
    expect(offered).not.toContain('id')
    expect(x.value).toBe('degree')
  })

  it('writes the axis a reader picks back onto the node', () => {
    const onParamChange = vi.fn()
    draw(sample(), {}, onParamChange)
    fireEvent.change(screen.getByLabelText('Scatter y axis'), { target: { value: 'coreness' } })
    expect(onParamChange).toHaveBeenCalledWith('plotY', 'coreness')
  })

  it('offers all three tables to the histogram, prefixed where the names would collide', () => {
    draw(sample())
    const picker = screen.getByLabelText('Distribution column') as HTMLSelectElement
    const offered = [...picker.options].map((option) => option.value)
    // `weight` is a node column *and* a link column on this card, which is why one of them is
    // prefixed and neither is a bare column name.
    expect(offered).toContain('nodes:degree')
    expect(offered).toContain('links:weight')
    expect(offered).toContain('components:size')
    expect(picker.value).toBe('nodes:degree')
  })

  it('writes the histogram’s column and its bin count', () => {
    const onParamChange = vi.fn()
    draw(sample(), {}, onParamChange)
    fireEvent.change(screen.getByLabelText('Distribution column'), {
      target: { value: 'links:weight' },
    })
    expect(onParamChange).toHaveBeenCalledWith('histColumn', 'links:weight')

    fireEvent.change(screen.getByLabelText('Bin count'), { target: { value: '25' } })
    expect(onParamChange).toHaveBeenCalledWith('bins', 25)
  })

  it('takes 0 as the automatic rule rather than as no bars', () => {
    // The sentinel, and the one thing about it that could be wrong in silence: 0 reaching
    // `binScan` as a fixed count would clamp to one bar and look like a degenerate column.
    draw(sample(), { bins: 0 })
    expect(screen.getByText('Distribution')).toBeTruthy()
    expect(screen.queryByText('Nothing to bin')).toBeNull()
  })

  /*
   * The two shapes share one row set, so what is asserted is which primitive drew it —
   * `tile__bar` against `tile__column-track`. jsdom performs no layout, so nothing about how
   * either *looks* is reachable from here; that was driven in a browser.
   */
  it('draws horizontal rows by default', () => {
    const { container } = draw(sample())
    expect(container.querySelectorAll('.tile__bar').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.tile__column-track')).toHaveLength(0)
    expect((screen.getByLabelText('Vertical bars') as HTMLInputElement).checked).toBe(false)
  })

  it('draws columns when the box is ticked', () => {
    const { container } = draw(sample(), { histVertical: true })
    expect(container.querySelectorAll('.tile__column-track').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.tile__bar')).toHaveLength(0)
    expect((screen.getByLabelText('Vertical bars') as HTMLInputElement).checked).toBe(true)
  })

  it('writes the orientation back onto the node', () => {
    const onParamChange = vi.fn()
    draw(sample(), {}, onParamChange)
    fireEvent.click(screen.getByLabelText('Vertical bars'))
    expect(onParamChange).toHaveBeenCalledWith('histVertical', true)
  })

  it('keeps a stored column the network does not have, and says it is missing', () => {
    /*
     * A schema without a column is very often a schema that has not arrived, so the card keeps
     * what was chosen — substituting is how a picker quietly starts answering a different
     * question. What it must not do is show `degree` while the node holds something else.
     */
    draw(sample(), { histColumn: 'nodes:betweenness' })
    const picker = screen.getByLabelText('Distribution column') as HTMLSelectElement
    expect(picker.value).toBe('nodes:betweenness')
    expect(screen.getByText(/betweenness.*missing/)).toBeTruthy()
    expect(screen.getByText('No betweenness column')).toBeTruthy()
  })

  it('draws the controls with no way to write them, rather than dropping them', () => {
    // The dashboard and the inspector both pass a writer; a surface that does not still has to
    // show which column is on screen.
    draw(sample())
    expect((screen.getByLabelText('Distribution column') as HTMLSelectElement).disabled).toBe(
      true,
    )
  })
})
