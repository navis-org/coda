/**
 * The two colour modes only a network can answer.
 *
 * Both are invisible when wrong in the way this viewer's failures always are — a picture that
 * looks like a picture and says something untrue. Colouring by component is only worth
 * anything if two components never share a slot and one component never splits across two; a
 * link coloured by its upstream node is only worth anything if it is *the same colour* as that
 * node, which is exactly what a second palette pass would break.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { makeTable } from '../../core/values'
import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { CHART_INK } from '../colors'
import { resolveNetworkEdgeColor, resolveNetworkNodeColor } from './networkColor'

const NODE_SCHEMA = tableSchema(column('id', 'str'), column('type', 'str'))
const EDGE_SCHEMA = tableSchema(column('source', 'str'), column('target', 'str'))

/**
 * Two components and an isolate: `a → b → c`, `d → e`, and `lone`.
 *
 * Sized 3, 2, 1 on purpose, so "numbered by size" has something to get wrong.
 */
const NET: NetworkValue = {
  kind: 'network',
  directed: true,
  nodes: makeTable(NODE_SCHEMA, {
    id: ['a', 'b', 'c', 'd', 'e', 'lone'],
    type: ['LC4', 'LC4', 'DNp02', 'LC6', 'LC6', 'LT1'],
  }),
  edges: makeTable(EDGE_SCHEMA, {
    source: ['a', 'b', 'd'],
    target: ['b', 'c', 'e'],
  }),
}

const spec = (extra: Partial<ColorSpec> = {}): ColorSpec => ({
  mode: 'categorical',
  column: 'type',
  constant: '0',
  ...extra,
})

describe('colour by connected component', () => {
  const resolved = resolveNetworkNodeColor(NET, spec({ mode: 'component' }), 'dark')

  it('gives one colour per component and the same one throughout it', () => {
    const at = (row: number) => resolved.at(row)
    expect(at(0)).toBe(at(1))
    expect(at(1)).toBe(at(2))
    expect(at(3)).toBe(at(4))
    expect(at(0)).not.toBe(at(3))
    expect(at(0)).not.toBe(at(5))
    expect(at(3)).not.toBe(at(5))
  })

  it('keys the legend by ordinal, largest component first', () => {
    // Numbered by size in `connectedComponents`, ranked by frequency in `resolveColor`: two
    // orderings that agree by construction rather than by coincidence, which is what makes
    // the strip read left to right in the same order as the sizes.
    const legend = resolved.legend
    expect(legend?.kind).toBe('categorical')
    expect(legend?.kind === 'categorical' && legend.entries.map((e) => e.label)).toEqual([
      '1',
      '2',
      '3',
    ])
  })

  it('paints the largest component in the leading slot', () => {
    const legend = resolved.legend
    const leading = legend?.kind === 'categorical' ? legend.entries[0]?.color : undefined
    expect(resolved.at(0)).toBe(leading)
  })

  it('ignores the column picker, which has nothing to offer it', () => {
    // `component` is dataless: the mode derives its own values, so a stale column left in the
    // params from a previous mode must not reach the answer.
    const other = resolveNetworkNodeColor(NET, spec({ mode: 'component', column: 'type' }), 'dark')
    expect(other.at(0)).toBe(other.at(1))
    // …which `type` would not give, since a and b are LC4 but c is DNp02.
    expect(other.at(1)).toBe(other.at(2))
  })

  it('leaves every other mode to the shared resolver', () => {
    const byType = resolveNetworkNodeColor(NET, spec(), 'dark')
    expect(byType.at(0)).toBe(byType.at(1))
    expect(byType.at(0)).not.toBe(byType.at(2))
  })
})

describe('colour a link by the node at one of its ends', () => {
  const nodes = resolveNetworkNodeColor(NET, spec(), 'dark')

  it('gives a link its source node’s exact colour', () => {
    const edges = resolveNetworkEdgeColor(NET, spec({ mode: 'sourceNode' }), 'dark', nodes)
    // a → b, b → c, d → e
    expect(edges.at(0)).toBe(nodes.at(0))
    expect(edges.at(1)).toBe(nodes.at(1))
    expect(edges.at(2)).toBe(nodes.at(3))
  })

  it('gives a link its target node’s exact colour the other way round', () => {
    const edges = resolveNetworkEdgeColor(NET, spec({ mode: 'targetNode' }), 'dark', nodes)
    expect(edges.at(0)).toBe(nodes.at(1))
    expect(edges.at(1)).toBe(nodes.at(2))
    expect(edges.at(2)).toBe(nodes.at(4))
  })

  it('draws no legend of its own', () => {
    // The node key already names every colour on screen; a second strip repeating those
    // swatches under the word "links" says nothing the first did not.
    const edges = resolveNetworkEdgeColor(NET, spec({ mode: 'sourceNode' }), 'dark', nodes)
    expect(edges.legend).toBeUndefined()
  })

  it('is still addressable by the key its endpoint belongs to', () => {
    const edges = resolveNetworkEdgeColor(NET, spec({ mode: 'sourceNode' }), 'dark', nodes)
    expect(edges.labelAt?.(0)).toBe(nodes.labelAt?.(0))
  })

  it('borrows whatever the node was painted, override included', () => {
    // Not the node's *spec* but its resolution, so a hand-picked colour reaches the links
    // without the rule being written down twice.
    const overridden = resolveNetworkNodeColor(
      NET,
      spec({ overrides: { LC4: '#123456' } }),
      'dark',
    )
    const edges = resolveNetworkEdgeColor(
      NET,
      spec({ mode: 'sourceNode' }),
      'dark',
      overridden,
    )
    expect(edges.at(0)).toBe('#123456')
  })

  it('falls back to link ink for an end the node table does not have', () => {
    const orphaned: NetworkValue = {
      ...NET,
      edges: makeTable(EDGE_SCHEMA, { source: ['gone'], target: ['a'] }),
    }
    const edges = resolveNetworkEdgeColor(
      orphaned,
      spec({ mode: 'sourceNode' }),
      'dark',
      nodes,
    )
    expect(edges.at(0)).toBe(CHART_INK.dark.muted)
  })

  it('leaves every other mode to the shared resolver, over the edge table', () => {
    const edges = resolveNetworkEdgeColor(
      NET,
      spec({ mode: 'categorical', column: 'source' }),
      'dark',
      nodes,
    )
    expect(edges.legend?.kind).toBe('categorical')
  })
})
