/**
 * What the network viewer's context menu selects.
 *
 * The walk itself is `networkOps`' and is pinned there; what is asked here is the part this
 * module adds, and each of these is a way a menu command could quietly pick the wrong nodes:
 * which anchors a right-click acts on, that the four scopes mean four different things, and
 * that the answer comes back in the network's own order rather than a Set's.
 *
 * That last one is not tidiness. The result goes into an `ids` param, which lives in the saved
 * file and takes part in the provenance key — so an order that depended on which node somebody
 * clicked first would re-key every downstream node for no change in what was selected.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { expandedSelection, orderByNode, seedsFor } from './networkSelect'

const NODE_SCHEMA = tableSchema(column('id', 'str'))
const EDGE_SCHEMA = tableSchema(column('source', 'str'), column('target', 'str'))

/**
 * `a → b → c`, a separate `d → e`, and an unattached `lone`.
 *
 * Two components plus an isolate is the smallest fixture where "connected", "the component"
 * and "everything" are three different answers.
 */
function net(directed: boolean): NetworkValue {
  return {
    kind: 'network',
    directed,
    nodes: makeTable(NODE_SCHEMA, { id: ['a', 'b', 'c', 'd', 'e', 'lone'] }),
    edges: makeTable(EDGE_SCHEMA, { source: ['a', 'b', 'd'], target: ['b', 'c', 'e'] }),
  }
}

const DIRECTED = net(true)
const UNDIRECTED = net(false)

describe('seedsFor', () => {
  it('acts on the whole selection when the mark is part of it', () => {
    expect(seedsFor('a', new Set(['a', 'c'])).sort()).toEqual(['a', 'c'])
  })

  it('acts on one mark when it is not selected, and does not select it', () => {
    // The gesture must not redefine what is selected — that is what the click is for.
    expect(seedsFor('b', new Set(['a', 'c']))).toEqual(['b'])
  })
})

describe('expandedSelection', () => {
  it('reaches one hop either way for connected', () => {
    expect(expandedSelection(DIRECTED, ['b'], 'connected')).toEqual(['a', 'b', 'c'])
  })

  it('follows links forwards for downstream', () => {
    expect(expandedSelection(DIRECTED, ['b'], 'downstream')).toEqual(['b', 'c'])
  })

  it('follows links backwards for upstream', () => {
    expect(expandedSelection(DIRECTED, ['b'], 'upstream')).toEqual(['a', 'b'])
  })

  it('takes the whole component regardless of direction', () => {
    expect(expandedSelection(DIRECTED, ['c'], 'component')).toEqual(['a', 'b', 'c'])
  })

  it('leaves an isolate as itself', () => {
    expect(expandedSelection(DIRECTED, ['lone'], 'component')).toEqual(['lone'])
  })

  it('always contains its anchors, so repeating a scope grows the selection', () => {
    const once = expandedSelection(DIRECTED, ['a'], 'connected')
    expect(once).toEqual(['a', 'b'])
    // Which is why there is no "within N hops" asking for a number: press it again.
    expect(expandedSelection(DIRECTED, once, 'connected')).toEqual(['a', 'b', 'c'])
  })

  it('ignores direction on an undirected network', () => {
    // `source`/`target` are an arbitrary order there, so honouring them would walk half of
    // each pair by construction order. The menu hides these two rows for the same reason.
    expect(expandedSelection(UNDIRECTED, ['b'], 'downstream')).toEqual(['a', 'b', 'c'])
  })

  it('answers in node order, not in the order the anchors arrived', () => {
    expect(expandedSelection(DIRECTED, ['e', 'd'], 'connected')).toEqual(['d', 'e'])
  })

  it('drops an anchor the network does not have', () => {
    // A selection outlives its nodes; an id filtered out upstream is ordinary, not an error.
    expect(expandedSelection(DIRECTED, ['a', 'gone'], 'connected')).toEqual(['a', 'b'])
  })
})

describe('orderByNode', () => {
  it('follows the attribute table and drops what is not in it', () => {
    expect(orderByNode(DIRECTED, new Set(['lone', 'gone', 'a']))).toEqual(['a', 'lone'])
  })
})
