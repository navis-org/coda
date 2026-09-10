/**
 * Edge properties in the R document — the notebook suite's twin, for the same three nodes.
 *
 * neuprintr's connection table and adjacency matrix return the weight and nothing else about a
 * connection, so a chosen property runs the canvas's own query through `neuprint_fetch_custom`.
 * One difference from the notebook is worth pinning: the library route here refuses the region
 * options outright, and this route exports them, because the query text states them itself.
 */

import { describe, expect, it } from 'vitest'

import type { CodaGraph } from '../../core/graph'
import type { ParamValues } from '../../core/node'
import '../../nodes'
import { findChainGraph as graphWith } from '../fixture'
import { exportRmd } from './exporter'

const OPTIONS = { now: '2026-01-01', appVersion: '0.0.0-test' }

function rmdText(graph: CodaGraph): string {
  const result = exportRmd(graph, OPTIONS)
  if (!result.ok) throw new Error(result.reason)
  return result.source
}

function connectivityChunk(params: ParamValues): string {
  return rmdText(
    graphWith(
      'neuron.connectivity',
      { direction: 'outputs', hops: 1, minWeight: 1, ...params },
      { dataset: 'dataset', neurons: 'neurons' },
    ),
  )
}

describe('Connectivity with edge properties', () => {
  it("runs the canvas's own query, the id list filled when the chunk runs", () => {
    const text = connectivityChunk({ edgeProperties: ['weightAxonDendrite'] })
    expect(text).toContain('.down <- neuprint_fetch_custom(')
    expect(text).toContain('sub("{ids}", .ids,')
    expect(text).toContain("w['weightAxonDendrite']")
    expect(text).not.toContain('coda_edge_list(')
  })

  it('names the columns by position, then reorients them', () => {
    const text = connectivityChunk({ edgeProperties: ['weightAxonDendrite'] })
    expect(text).toContain(
      'names(.down) <- c("neuronId", "neuronType", "partnerId", "partnerType", "weight", "weightAxonDendrite")',
    )
    expect(text).toContain('rename(preId = neuronId, preType = neuronType, postId = partnerId')
  })

  it('exports the region options on this route, where the library route refuses them', () => {
    const text = connectivityChunk({ edgeProperties: ['weightAxonDendrite'], splitByRoi: true })
    expect(text).not.toContain('The region options are not translated')
    expect(text).toContain('part.e0 AS e0, part.roi AS roi')
  })

  it('splits over the primary set when none is chosen, the list the canvas resolves', () => {
    const text = connectivityChunk({ edgeProperties: ['weightAxonDendrite'], splitByRoi: true })
    expect(text).toContain('neuprint_ROIs(superLevel = FALSE, conn = hemibrain_neuprint)')
    expect(text).toContain('sub("{rois}", .rois, sub("{ids}", .ids,')
    const named = connectivityChunk({
      edgeProperties: ['weightAxonDendrite'],
      splitByRoi: true,
      rois: ['LAL(L)'],
    })
    // A list somebody chose is written into the query and needs nothing fetched.
    expect(named).not.toContain('.rois <-')
    expect(named).toContain("[r IN ['LAL(L)'] WHERE")
  })

  it('still refuses Normalize, and anything past one hop', () => {
    expect(connectivityChunk({ edgeProperties: ['weightHP'], normalize: true })).toContain(
      'Normalize is not translated',
    )
    expect(connectivityChunk({ edgeProperties: ['weightHP'], hops: 2 })).toContain(
      'exported for one hop',
    )
  })

  it('exports the chunk it always did when no property is chosen', () => {
    const text = connectivityChunk({})
    expect(text).toContain('coda_edge_list(')
    expect(text).not.toContain('neuprint_fetch_custom(')
  })
})

describe('Adjacency by an edge property', () => {
  const ports = { dataset: 'dataset', sources: 'neurons', targets: 'neurons' } as const

  it('folds the property into a matrix over the ids asked about', () => {
    const text = rmdText(graphWith('neuron.adjacency', { weight: 'weightAxonDendrite' }, ports))
    expect(text).toContain("RETURN a.bodyId, a.type, b.bodyId, b.type, w['weightAxonDendrite']")
    expect(text).toContain('xtabs(weight ~ pre + post, data = .conn)')
    expect(text).not.toContain('neuprint_get_adjacency_matrix(')
  })

  it('keeps neuprint_get_adjacency_matrix for the weight', () => {
    const text = rmdText(graphWith('neuron.adjacency', {}, ports))
    expect(text).toContain('neuprint_get_adjacency_matrix(')
  })
})

describe('Neuron Profile counted by an edge property', () => {
  const ports = { dataset: 'dataset', neurons: 'neurons' } as const

  it('passes the property to coda_profile', () => {
    const text = rmdText(graphWith('out.profile', { countBy: 'weightAxonDendrite' }, ports))
    // The canvas's own queries, keyed by `side` — the helper fills in the ids and nothing else.
    expect(text).toContain('  property_queries = list(PRE = "MATCH (p:Neuron)')
    expect(text).toContain("w['weightAxonDendrite']")
    expect(text).toContain('coda_partners_by <- function(')
  })

  it('passes nothing for the weight', () => {
    expect(rmdText(graphWith('out.profile', {}, ports))).not.toContain(
      '  property_queries = list(',
    )
  })
})
