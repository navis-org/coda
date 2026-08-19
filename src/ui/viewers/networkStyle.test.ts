/**
 * The parts of the network viewer's drawing that survive having no GPU.
 *
 * jsdom has no WebGL, so sigma never renders in this suite and the pixels themselves stay
 * unverified. What is checkable is everything the renderer is *handed*: which nodes a focus
 * covers, what a dimmed colour comes out as, and what a tooltip decides to say. Those are
 * where this viewer's bugs have actually been.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { CHART_INK, chartSurface, mixHex, withAlpha } from '../colors'
import {
  DIM_EDGE,
  DIM_NODE,
  MAX_TIP_ROWS,
  NO_FOCUS,
  describeEdgeTip,
  describeNodeTip,
  dimColor,
  edgeInFocus,
  focusSets,
  tipColumns,
} from './networkStyle'

/** a — b — c, plus d hanging off c; e is unconnected. */
const NEIGHBOURS: Record<string, string[]> = {
  a: ['b'],
  b: ['a', 'c'],
  c: ['b', 'd'],
  d: ['c'],
  e: [],
}
const lookup = (id: string) => NEIGHBOURS[id] ?? []

describe('focusSets', () => {
  it('treats no anchors as no focus at all, so nothing dims', () => {
    expect(focusSets(lookup, [])).toBe(NO_FOCUS)
    expect(focusSets(lookup, []).focus.size).toBe(0)
  })

  it('covers the anchor and its neighbours', () => {
    const sets = focusSets(lookup, ['b'])
    expect([...sets.focus].sort()).toEqual(['a', 'b', 'c'])
    expect([...sets.anchors]).toEqual(['b'])
  })

  it('unions the neighbourhoods of several anchors', () => {
    const sets = focusSets(lookup, ['a', 'd'])
    expect([...sets.focus].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps an isolated anchor focused, rather than focusing nothing', () => {
    const sets = focusSets(lookup, ['e'])
    expect([...sets.focus]).toEqual(['e'])
  })

  it('tolerates an anchor the lookup has never heard of', () => {
    // A selection outlives the node it named whenever upstream data changes.
    const sets = focusSets(lookup, ['ghost'])
    expect([...sets.focus]).toEqual(['ghost'])
  })
})

describe('edgeInFocus', () => {
  const sets = focusSets(lookup, ['b'])

  it('lights a link touching an anchor', () => {
    expect(edgeInFocus(sets, 'a', 'b')).toBe(true)
    expect(edgeInFocus(sets, 'b', 'c')).toBe(true)
  })

  it('leaves a link between two focused neighbours dim', () => {
    // Both ends are in focus, neither is the anchor. Lighting these would redraw the whole
    // neighbourhood's internal structure the moment you hovered a hub.
    const wide = focusSets(lookup, ['b', 'c'])
    expect(wide.focus.has('a')).toBe(true)
    expect(wide.focus.has('d')).toBe(true)
    expect(edgeInFocus({ anchors: new Set(['b']), focus: wide.focus }, 'a', 'd')).toBe(false)
  })

  it('leaves a link touching neither anchor dim', () => {
    expect(edgeInFocus(sets, 'c', 'd')).toBe(false)
  })
})

describe('dimColor', () => {
  it('travels a mark towards the surface it is drawn on, keeping its hue', () => {
    const dimmed = dimColor('#3987e5', 'dark', DIM_NODE)
    expect(dimmed).toBe(mixHex('#3987e5', chartSurface('dark'), DIM_NODE))
    // Blue, not grey: the categorical encoding survives being de-emphasised.
    const channels = [dimmed.slice(1, 3), dimmed.slice(3, 5), dimmed.slice(5, 7)]
    const [r, g, b] = channels.map((h) => parseInt(h, 16))
    expect(b).toBeGreaterThan(r!)
    expect(b).toBeGreaterThan(g!)
  })

  it('recedes links further than nodes', () => {
    expect(DIM_EDGE).toBeGreaterThan(DIM_NODE)
  })

  it('flips direction with the theme, because the surface does', () => {
    expect(dimColor('#3987e5', 'dark', DIM_NODE)).not.toBe(dimColor('#3987e5', 'light', DIM_NODE))
  })

  it('falls back to muted ink rather than painting nothing when handed no colour', () => {
    expect(dimColor('', 'dark', DIM_NODE)).toBe(
      mixHex(CHART_INK.dark.muted, chartSurface('dark'), DIM_NODE),
    )
  })

  it('leaves a colour it cannot parse alone, so a mark never vanishes', () => {
    expect(dimColor('rebeccapurple', 'dark', DIM_NODE)).toBe('rebeccapurple')
  })
})

describe('withAlpha', () => {
  it('folds an alpha byte into the colour, which is what sigma parses', () => {
    expect(withAlpha('#3987e5', 0.5)).toBe('#3987e580')
    expect(withAlpha('#3987e5', 0.1)).toBe('#3987e51a')
  })

  it('leaves a fully opaque colour as six digits, so every other consumer still reads it', () => {
    expect(withAlpha('#3987e5', 1)).toBe('#3987e5')
  })

  it('leaves a colour it cannot parse alone', () => {
    expect(withAlpha('rebeccapurple', 0.5)).toBe('rebeccapurple')
  })
})

describe('mixHex with alpha', () => {
  it('carries an alpha byte through a blend untouched', () => {
    // Dimming a translucent link must not make it opaque — that is backwards.
    expect(mixHex('#3987e580', '#1a1a19', 0.5)).toBe(`${mixHex('#3987e5', '#1a1a19', 0.5)}80`)
  })

  it('dims a translucent link, which is the path the focus view takes', () => {
    const dimmed = dimColor('#89878180', 'dark', DIM_EDGE)
    expect(dimmed.endsWith('80')).toBe(true)
    expect(dimmed).not.toBe('#89878180')
  })
})

const NODE_SCHEMA = tableSchema(
  column('id', 'str'),
  column('type', 'str'),
  column('degreeIn', 'i64'),
  column('degreeOut', 'i64'),
  column('weightIn', 'f64'),
  column('weightOut', 'f64'),
)
const EDGE_SCHEMA = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('weight', 'f64'),
  column('edges', 'i64'),
)

const network: NetworkValue = {
  kind: 'network',
  directed: true,
  nodes: tableFromRows(NODE_SCHEMA, [
    { id: 'LC4', type: 'LC4', degreeIn: 2, degreeOut: 7, weightIn: 40, weightOut: 1234 },
    { id: 'LPLC2', type: null, degreeIn: 0, degreeOut: 1, weightIn: 0, weightOut: 5 },
  ]),
  edges: tableFromRows(EDGE_SCHEMA, [{ source: 'LC4', target: 'LPLC2', weight: 40, edges: 3 }]),
}

describe('tipColumns', () => {
  it('puts the encoded columns first — they are what the picture is saying', () => {
    expect(tipColumns(NODE_SCHEMA, ['type', 'weightOut'])).toEqual([
      'type',
      'weightOut',
      'degreeIn',
      'degreeOut',
      'weightIn',
    ])
  })

  it('never names a column the schema does not have', () => {
    const sparse = tableSchema(column('id', 'str'), column('type', 'str'))
    expect(tipColumns(sparse, ['type', 'hemilineage'])).toEqual(['type'])
  })

  it('drops the id, which the title already carries', () => {
    expect(tipColumns(NODE_SCHEMA, ['id'])).not.toContain('id')
  })

  it('does not repeat a column encoded twice', () => {
    const both = tipColumns(NODE_SCHEMA, ['weightOut', 'weightOut'])
    expect(both.filter((name) => name === 'weightOut')).toHaveLength(1)
  })

  it('stays a glance rather than a table', () => {
    expect(tipColumns(NODE_SCHEMA, ['type']).length).toBeLessThanOrEqual(MAX_TIP_ROWS)
  })

  it('has nothing to say without a schema', () => {
    expect(tipColumns(undefined, ['type'])).toEqual([])
  })
})

describe('describeNodeTip', () => {
  it('reports the encoded values a reader cannot recover from the drawing', () => {
    const tip = describeNodeTip(network, 0, ['type', 'weightOut'])
    expect(tip.title).toBe('LC4')
    expect(tip.lines).toEqual(['type LC4', 'weightOut 1,234'])
  })

  it('pairs a label with its id, and does not print the id twice', () => {
    expect(describeNodeTip(network, 0, [], 'LC4').title).toBe('LC4')
    expect(describeNodeTip(network, 0, [], 'lobula columnar 4').title).toBe(
      'lobula columnar 4 · LC4',
    )
  })

  it('shows a missing value as a dash rather than as zero', () => {
    expect(describeNodeTip(network, 1, ['type']).lines).toEqual(['type —'])
  })
})

describe('describeEdgeTip', () => {
  it('reads the direction off the network', () => {
    expect(describeEdgeTip(network, 0).title).toBe('LC4 → LPLC2')
    expect(describeEdgeTip({ ...network, directed: false }, 0).title).toBe('LC4 – LPLC2')
  })

  it('keeps the weight and the merged-link count', () => {
    expect(describeEdgeTip(network, 0).lines).toEqual(['weight 40', 'edges 3'])
  })
})
