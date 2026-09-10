/**
 * Edge properties in the notebook, on the three nodes that have them.
 *
 * `fetch_adjacencies` returns the weight and nothing else about a connection, so a property has no
 * library route and the cell runs the canvas's own query instead. What is pinned here is that it
 * does — the builder's text, not a hand-written second copy — that the two things an exporter
 * changes about that text are the only things changed, and that a graph which never chose a
 * property exports exactly the cell it always did.
 */

import { describe, expect, it } from 'vitest'

import type { CodaGraph } from '../../core/graph'
import type { ParamValues } from '../../core/node'
import '../../nodes'
import { findChainGraph as graphWith } from '../fixture'
import { exportNotebook } from './exporter'

const OPTIONS = { now: '2026-01-01', appVersion: '0.0.0-test' }

function notebookText(graph: CodaGraph): string {
  const result = exportNotebook(graph, OPTIONS)
  if (!result.ok) throw new Error(result.reason)
  return (result.notebook.cells as Array<{ source: string[] }>)
    .map((cell) => cell.source.join(''))
    .join('\n')
}

const CONNECTIVITY_PORTS = { dataset: 'dataset', neurons: 'neurons' } as const

function connectivityCell(params: ParamValues): string {
  return notebookText(
    graphWith(
      'neuron.connectivity',
      { direction: 'outputs', hops: 1, minWeight: 1, ...params },
      CONNECTIVITY_PORTS,
    ),
  )
}

describe('Connectivity with edge properties', () => {
  it("runs the canvas's own query, since fetch_adjacencies cannot return a property", () => {
    const text = connectivityCell({ edgeProperties: ['weightAxonDendrite'] })
    expect(text).toContain('_down = fetch_custom(')
    expect(text).toContain("w['weightAxonDendrite']")
    expect(text).not.toContain('fetch_adjacencies(')
  })

  it('fills the id list from the upstream frame, when the cell runs', () => {
    const text = connectivityCell({ edgeProperties: ['weightAxonDendrite'] })
    expect(text).toContain("_ids = str(find_neurons['neuronId'].astype('int64').tolist())")
    expect(text).toContain('WHERE n.bodyId IN {ids}')
    expect(text).toContain('""".replace(\'{ids}\', _ids),')
  })

  it('labels the far end the way fetch_adjacencies would, and follows Include fragments', () => {
    expect(connectivityCell({ edgeProperties: ['weightHP'] })).toContain('->(p:Neuron)')
    const all = connectivityCell({ edgeProperties: ['weightHP'], includeFragments: true })
    expect(all).toContain('->(p)\n')
    expect(all).not.toContain('(p:Neuron)')
  })

  it('names the columns by position and reorients them the way the synapse points', () => {
    const text = connectivityCell({ edgeProperties: ['weightAxonDendrite', 'weightHP'] })
    expect(text).toContain(
      "_down.columns = ['neuronId', 'neuronType', 'partnerId', 'partnerType', 'weight', 'weightAxonDendrite', 'weightHP']",
    )
    expect(text).toContain("'neuronId': 'preId', 'neuronType': 'preType',")
  })

  it('carries the region options in the query text, dedupe key included, for a split both ways', () => {
    const text = connectivityCell({
      edgeProperties: ['weightAxonDendrite'],
      direction: 'both',
      splitByRoi: true,
    })
    expect(text).toContain('_up = fetch_custom(')
    expect(text).toContain('part.e0 AS e0, part.roi AS roi')
    expect(text).toContain("drop_duplicates(subset=['preId', 'postId', 'roi'])")
  })

  it('splits over the primary set when none is chosen, the list the canvas resolves', () => {
    // Without it the query splits over `keys(ri)` — every region a connection mentions, and
    // they nest, so the parts would add up to several times the weight.
    const text = connectivityCell({ edgeProperties: ['weightAxonDendrite'], splitByRoi: true })
    expect(text).toContain('_rois = str(list(fetch_primary_rois(client=hemibrain_neuprint)))')
    expect(text).toContain('[r IN {rois} WHERE')
    expect(text).toContain(".replace('{ids}', _ids).replace('{rois}', _rois),")
    // …and not when the toggle says every region, which is `keys(ri)` on the canvas too.
    const nested = connectivityCell({
      edgeProperties: ['weightAxonDendrite'],
      splitByRoi: true,
      primaryRoisOnly: false,
    })
    expect(nested).not.toContain('fetch_primary_rois(')
    expect(nested).toContain('[r IN keys(ri) WHERE')
  })

  it('refuses past one hop rather than walking a traversal written twice', () => {
    const text = connectivityCell({ edgeProperties: ['weightHP'], hops: 2 })
    expect(text).toContain('exported for one hop')
    expect(text).not.toContain('fetch_custom(')
  })

  it('exports the cell it always did when no property is chosen', () => {
    const text = connectivityCell({})
    expect(text).toContain('fetch_adjacencies(')
    expect(text).not.toContain('fetch_custom(')
  })
})

describe('Adjacency by an edge property', () => {
  const ports = { dataset: 'dataset', sources: 'neurons', targets: 'neurons' } as const

  it("fetches the property through the canvas's query, under fetch_adjacencies' own names", () => {
    const text = notebookText(
      graphWith('neuron.adjacency', { weight: 'weightAxonDendrite' }, ports),
    )
    expect(text).toContain("RETURN a.bodyId, a.type, b.bodyId, b.type, w['weightAxonDendrite']")
    expect(text).toContain(
      "_conn.columns = ['bodyId_pre', 'type_pre', 'bodyId_post', 'type_post', 'weight']",
    )
    // …so the rest of the cell is unchanged.
    expect(text).toContain('connection_table_to_matrix(_conn,')
    expect(text).not.toContain('fetch_adjacencies(')
  })

  it('keeps fetch_adjacencies for the weight', () => {
    const text = notebookText(graphWith('neuron.adjacency', { weight: 'weight' }, ports))
    expect(text).toContain('fetch_adjacencies(')
    expect(text).not.toContain('fetch_custom(')
  })
})

describe('Neuron Profile counted by an edge property', () => {
  const ports = { dataset: 'dataset', neurons: 'neurons' } as const

  it('passes the property to coda_profile, which asks neuPrint for it', () => {
    const text = notebookText(
      graphWith('out.profile', { countBy: 'weightAxonDendrite' }, ports),
    )
    // The canvas's own query, handed over whole — the helper fills in the ids and nothing else.
    expect(text).toContain('    property_queries={\n        \'upstream\': r"""')
    expect(text).toContain(
      "RETURN n.bodyId, n.type, p.bodyId, p.type, w.weight, w['weightAxonDendrite']",
    )
    expect(text).toContain('def _coda_connectivity_by(')
  })

  it('passes nothing for the weight', () => {
    const text = notebookText(graphWith('out.profile', {}, ports))
    // An argument, not the parameter: the helper's own signature names it either way.
    expect(text).not.toContain('    property_queries={')
  })
})
