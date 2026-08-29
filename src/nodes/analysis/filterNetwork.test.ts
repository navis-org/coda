/**
 * Filter Network: the subgraph around a selection.
 *
 * Two halves worth pinning separately. The walk itself is `networkOps` — hop counts, direction,
 * components, and the induced-subgraph rule that a link needs *both* ends kept. The node around
 * it is the seed union: a condition on node attributes, a wired table of ids, and the fact that
 * neither overrides the other.
 *
 * The fixture is a small path graph with a branch, small enough that every expected answer can
 * be read off by eye — which is what a walk test needs, since an assertion computed the same way
 * as the code proves nothing.
 */

import { describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { EvalContext, ParamValues } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { CodaType } from '../../core/types'
import type { NetworkValue, TableValue, Value } from '../../core/values'
import { getColumn, makeTable, tableFromRows } from '../../core/values'
import { expandSelection, induceSubnetwork } from '../lib/networkOps'
import '../index'

const NODE_SCHEMA = tableSchema(
  column('id', 'str'),
  column('kind', 'str'),
  column('nNeurons', 'i64'),
)
const EDGE_SCHEMA = tableSchema(column('source', 'str'), column('target', 'str'), column('weight', 'i64'))

/**
 * `a → b → c → d`, plus `b → x` hanging off, plus an unattached `lone`.
 *
 * Directed, so `direction` has something to say; `lone` is what makes "the whole component"
 * different from "everything".
 */
const NET: NetworkValue = {
  kind: 'network',
  directed: true,
  nodes: makeTable(NODE_SCHEMA, {
    id: ['a', 'b', 'c', 'd', 'x', 'lone'],
    kind: ['label', 'neurons', 'label', 'neurons', 'label', 'label'],
    nNeurons: [1, 2, 3, 4, 5, 6],
  }),
  edges: makeTable(EDGE_SCHEMA, {
    source: ['a', 'b', 'c', 'b'],
    target: ['b', 'c', 'd', 'x'],
    weight: [1, 2, 3, 4],
  }),
}

const ids = (net: NetworkValue) => getColumn(net.nodes, 'id').map(String).sort()
const links = (net: NetworkValue) => {
  const targets = getColumn(net.edges, 'target')
  return getColumn(net.edges, 'source').map((s, i) => `${String(s)}→${String(targets[i])}`)
}

const walk = (seeds: string[], over: Partial<Parameters<typeof expandSelection>[1]> = {}) =>
  [...expandSelection(NET, {
    seeds: new Set(seeds),
    expand: 'hops',
    hops: 1,
    direction: 'any',
    ...over,
  })].sort()

describe('expanding a selection', () => {
  it('keeps only the seeds when asked for nothing more', () => {
    expect(walk(['b'], { expand: 'none' })).toEqual(['b'])
  })

  /* A seed that is not in the graph is an ordinary state — usually a row filtered out upstream. */
  it('drops a seed the network does not have', () => {
    expect(walk(['b', 'nope'], { expand: 'none' })).toEqual(['b'])
  })

  it('walks both ways along a link by default', () => {
    expect(walk(['b'])).toEqual(['a', 'b', 'c', 'x'])
    expect(walk(['b'], { hops: 2 })).toEqual(['a', 'b', 'c', 'd', 'x'])
  })

  it('follows the arrows when asked to', () => {
    expect(walk(['b'], { direction: 'downstream' })).toEqual(['b', 'c', 'x'])
    expect(walk(['b'], { direction: 'upstream' })).toEqual(['a', 'b'])
  })

  /*
   * A component is undirected by definition, and `direction` is ignored rather than applied — a
   * component that respected arrows is a *reachable set*, which is a different answer under the
   * same name. `lone` is what shows it is a component and not simply everything.
   */
  it('takes the whole component regardless of direction, and no further', () => {
    for (const direction of ['any', 'downstream', 'upstream'] as const) {
      expect(walk(['d'], { expand: 'component', direction })).toEqual(['a', 'b', 'c', 'd', 'x'])
    }
    expect(walk(['lone'], { expand: 'component' })).toEqual(['lone'])
  })

  it('runs out rather than looping, however many hops are asked for', () => {
    expect(walk(['a'], { hops: 99 })).toEqual(['a', 'b', 'c', 'd', 'x'])
  })

  /*
   * `direction` is meaningless on an undirected network — `source` and `target` are an arbitrary
   * order there — and the *walk* is what has to know, because `visibleIf` is handed `ParamValues`
   * and cannot see what is wired. `Match Cell Types` emits `directed: false`, so this is the
   * graph the node was built for; both emitters ignore direction on one for free, and a canvas
   * that honoured it would disagree with its own notebook on exactly that input.
   */
  it('ignores direction on an undirected network', () => {
    const undirected = { ...NET, directed: false }
    const reach = (direction: 'any' | 'downstream' | 'upstream') =>
      [...expandSelection(undirected, {
        seeds: new Set(['b']),
        expand: 'hops',
        hops: 1,
        direction,
      })].sort()
    for (const direction of ['any', 'downstream', 'upstream'] as const) {
      expect(reach(direction)).toEqual(['a', 'b', 'c', 'x'])
    }
    // And it is genuinely the network's answer, not a constant: directed, it still differs.
    expect(walk(['b'], { direction: 'downstream' })).toEqual(['b', 'c', 'x'])
  })
})

describe('inducing the subgraph', () => {
  /*
   * Nothing dropped, nothing rebuilt — identity, not merely an equal value. `net.filter` is
   * `cheap` and `expand` defaults to `component`, so on a connectivity graph (normally one giant
   * component) the node's *default* state keeps everything: 278 ms rebuilt against 1.3 ms for
   * this test, measured at 50,000 nodes and 1,000,000 edges.
   */
  it('hands the input straight back when nothing was dropped', () => {
    const all = new Set(getColumn(NET.nodes, 'id').map(String))
    expect(induceSubnetwork(NET, all)).toBe(NET)
  })

  /*
   * Both ends, not either. A link to a node that is not drawn is an arrow into nothing, which is
   * the difference between a subgraph and a fringe.
   */
  it('keeps a link only when both of its ends survive', () => {
    const cut = induceSubnetwork(NET, new Set(['a', 'b', 'x']))
    expect(ids(cut)).toEqual(['a', 'b', 'x'])
    expect(links(cut)).toEqual(['a→b', 'b→x'])
  })

  it('carries the node attributes through', () => {
    const cut = induceSubnetwork(NET, new Set(['c', 'd']))
    expect(cut.nodes.data['nNeurons']).toEqual([3, 4])
    expect(cut.directed).toBe(true)
  })

  /*
   * The roll-ups describe the *graph*, so on a different graph they are a different number. A
   * node still claiming its old `degreeOut` is driving a size encoding that says something untrue
   * about the picture beside it.
   */
  it('recomputes the degree columns against the surviving links', () => {
    const rolled: NetworkValue = {
      ...NET,
      nodes: makeTable(
        tableSchema(column('id', 'str'), column('degreeOut', 'i64'), column('weightOut', 'i64')),
        { id: ['a', 'b', 'c', 'd', 'x', 'lone'], degreeOut: [1, 2, 1, 0, 0, 0], weightOut: [1, 6, 3, 0, 0, 0] },
      ),
    }
    const cut = induceSubnetwork(rolled, new Set(['a', 'b', 'c']))
    // `b → x` is gone with `x`, so b is down to one link out and weight 2.
    expect(cut.nodes.data['degreeOut']).toEqual([1, 1, 0])
    expect(cut.nodes.data['weightOut']).toEqual([1, 2, 0])
  })
})

// ---------------------------------------------------------------------------

describe('the node around it', () => {
  const def = requireNodeDef('net.filter')

  const run = (params: ParamValues, seed?: TableValue): NetworkValue => {
    const inputs: Record<string, Value | undefined> = { in: NET, seed }
    const ctx = {
      params: { ...defaultParams(def), ...params },
      input: (id: string) => inputs[id],
      column: (id: string) => {
        const raw = String({ ...defaultParams(def), ...params }[id] ?? '')
        return raw || undefined
      },
      warn: () => {},
    } as unknown as EvalContext
    return (def.evaluate!(ctx) as { out: NetworkValue }).out
  }

  it('seeds from a condition on the node attributes', () => {
    const out = run({ column: 'kind', op: 'eq', value: 'neurons', expand: 'none' })
    expect(ids(out)).toEqual(['b', 'd'])
  })

  /* The same operator table `Filter Table` uses, because it is the same function. */
  it('reads a numeric column numerically', () => {
    const out = run({ column: 'nNeurons', op: 'ge', value: '4', expand: 'none' })
    expect(ids(out)).toEqual(['d', 'lone', 'x'])
  })

  it('seeds from a wired table of ids', () => {
    const seed = tableFromRows(tableSchema(column('node', 'str')), [{ node: 'c' }])
    const out = run({ seedColumn: 'node', expand: 'none' }, seed)
    expect(ids(out)).toEqual(['c'])
  })

  /*
   * Unioned, never one overriding the other: both are things somebody asked for, and a node that
   * ignored the filter the moment a wire arrived would look broken in the way that takes longest
   * to notice.
   */
  it('unions the two rather than letting either win', () => {
    const seed = tableFromRows(tableSchema(column('node', 'str')), [{ node: 'lone' }])
    const out = run(
      { column: 'id', op: 'eq', value: 'a', seedColumn: 'node', expand: 'none' },
      seed,
    )
    expect(ids(out)).toEqual(['a', 'lone'])
  })

  it('expands from the union, not from one half of it', () => {
    const seed = tableFromRows(tableSchema(column('node', 'str')), [{ node: 'lone' }])
    const out = run(
      { column: 'id', op: 'eq', value: 'c', seedColumn: 'node', expand: 'component' },
      seed,
    )
    expect(ids(out)).toEqual(['a', 'b', 'c', 'd', 'lone', 'x'])
  })
})

// ---------------------------------------------------------------------------

describe('what it says on the card', () => {
  const def = requireNodeDef('net.filter')
  const issues = (params: ParamValues, inputs: Record<string, CodaType | undefined>) =>
    def.validate!(makeInferContext(def, { ...defaultParams(def), ...params }, inputs))

  const network = T.network(NODE_SCHEMA, EDGE_SCHEMA)

  it('says so when nothing selects anything', () => {
    expect(issues({}, { in: network }).join(' ')).toMatch(/Nothing selects any nodes/)
  })

  it('says nothing once a column is picked', () => {
    expect(issues({ column: 'kind', op: 'eq', value: 'label' }, { in: network })).toEqual([])
  })

  /* A wired table nobody has pointed at is the one reading of "empty" nobody intends. */
  it('says so when a Seed table is wired but no column is chosen', () => {
    const found = issues(
      { column: 'kind', op: 'eq', value: 'label' },
      { in: network, seed: T.table(tableSchema(column('node', 'str'))) },
    )
    expect(found.join(' ')).toMatch(/Seed: pick the column/)
  })

  it('refuses an operator the column type does not offer', () => {
    expect(issues({ column: 'nNeurons', op: 'contains', value: 'x' }, { in: network }).join(' '))
      .toMatch(/does not apply to a i64 column/)
  })

  /*
   * `Filter Table`'s second check, which this node was missing. Not decoration: `makePredicate`
   * *throws* on a non-numeric value against a numeric column, so without it the node goes red at
   * Run with a raw error where its sibling says the same thing on the card while there is still
   * something to change.
   */
  it('says a non-numeric value on a numeric column will not do, before Run', () => {
    expect(issues({ column: 'nNeurons', op: 'ge', value: 'abc' }, { in: network }).join(' '))
      .toMatch(/"abc" is not a number/)
    expect(issues({ column: 'nNeurons', op: 'ge', value: '4' }, { in: network })).toEqual([])
    // On a text column the same value is an ordinary comparison, not a problem.
    expect(issues({ column: 'kind', op: 'eq', value: 'abc' }, { in: network })).toEqual([])
  })

  it('still asks for a value when the operator needs one', () => {
    expect(issues({ column: 'kind', op: 'eq', value: '' }, { in: network }).join(' '))
      .toMatch(/Comparison value is empty/)
  })

  /* Filtering is a subgraph, so both schemas come through unchanged and a picker downstream
   * can be answered before anything has run. */
  it('publishes the input schemas on the output', () => {
    const ctx = makeInferContext(def, defaultParams(def), { in: network })
    expect(def.inferOutputs!(ctx)).toEqual({ out: network })
  })
})
