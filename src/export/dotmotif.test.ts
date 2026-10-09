import { describe, expect, it } from 'vitest'

import { addEdge, addNode } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import '../nodes'
import { everythingGraph } from './fixture'
import { exportNotebook } from './python/exporter'
import { exportRmd } from './r/exporter'

const QUERY = 'A -> B [weight >= 5]\nA.type = "two  spaces"\n# Keep \\ and "quotes"'

function graphWithMotifOutputs() {
  let graph = everythingGraph()
  graph = {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === 'dotmotif'
        ? { ...node, params: { ...node.params, query: QUERY, maxMatches: 17 } }
        : node,
    ),
  }
  for (const [id, type, sourceHandle] of [
    ['motifTable', 'out.table', 'matches'],
    ['motifNetwork', 'out.network', 'network'],
  ] as const) {
    graph = addNode(graph, {
      id,
      type,
      params: defaultParams(requireNodeDef(type)),
      position: { x: 2600, y: 900 },
    })
    graph = addEdge(graph, {
      source: 'dotmotif',
      sourceHandle,
      target: id,
      targetHandle: 'in',
    })
  }
  return graph
}

describe('DotMotif export gaps', () => {
  it.each(['python', 'r'] as const)(
    '%s preserves the query while marking both downstream outputs blocked',
    (language) => {
      const graph = graphWithMotifOutputs()
      const result = language === 'python' ? exportNotebook(graph) : exportRmd(graph)
      if (!result.ok) throw new Error(result.reason)
      const text =
        'notebook' in result
          ? (result.notebook.cells as Array<{ source: string[] }>)
              .map((cell) => cell.source.join(''))
              .join('\n')
          : result.source

      expect(text).toContain('DotMotif 0.19.0')
      expect(text).toContain('https://github.com/aplbrain/dotmotif/releases/tag/v0.19.0')
      expect(text).toContain('matchId/variable/nodeId')
      expect(text).toContain(`# DotMotif query (JSON string): ${JSON.stringify(QUERY)}`)
      expect(text).toContain('# Max matches: 17')
      expect(result.todos).toContainEqual({ nodeId: 'dotmotif', label: 'DotMotif' })
      for (const nodeId of ['motifTable', 'motifNetwork']) {
        expect(result.todos).toContainEqual(expect.objectContaining({ nodeId, blocked: true }))
      }
    },
  )
})
