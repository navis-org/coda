/**
 * A node this build does not have: kept as a placeholder, and written back as itself.
 *
 * The property that matters is the round trip — a file passing through a build that lacks one of
 * its types comes out able to run again in the build that made it. Everything else here is what
 * the placeholder has to be for that to be true: ports from the wires, an error on the card
 * before anybody runs it, and invisibility to everything that lists the registry.
 */

import { describe, expect, it } from 'vitest'

import '../nodes'
import { exportNotebook } from '../export/python/emit'
import { fragmentBody, subgraphOf } from './clipboard'
import { deserializeGraph, serializeGraph } from './graph'
import type { CodaGraph } from './graph'
import { inferGraph } from './inference'
import { MISSING_TYPE, documentNode, missingTypeOf } from './missing'
import { inputPorts, outputPorts } from './ports'
import { allNodeDefs, getNodeDef, listableNodeDefs, requireNodeDef } from './registry'
import { sourcelessScheduler } from '../test/scheduler'

/** filter → ghost → filter, the ghost carrying params no build of this one could type. */
function fileWithGhost(ghost: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    nodes: [
      { id: 'up', type: 'core.filterTable', position: { x: 0, y: 0 }, params: {} },
      {
        id: 'ghost',
        type: 'light:reader.tiff',
        position: { x: 200, y: 40 },
        params: { path: 'a.tif', channels: ['r', 'g'], nested: { depth: 2 } },
        title: 'My reader',
        ...ghost,
      },
      { id: 'down', type: 'core.filterTable', position: { x: 400, y: 0 }, params: {} },
    ],
    edges: [
      { id: 'e1', source: 'up', sourceHandle: 'out', target: 'ghost', targetHandle: 'stack' },
      { id: 'e2', source: 'ghost', sourceHandle: 'volume', target: 'down', targetHandle: 'in' },
    ],
  })
}

const ghostOf = (graph: CodaGraph) => graph.nodes.find((n) => n.id === 'ghost')!

describe('loading a node this build does not have', () => {
  it('keeps it, with both wires, and says so', () => {
    const { graph, warnings } = deserializeGraph(fileWithGhost())
    expect(ghostOf(graph).type).toBe(MISSING_TYPE)
    expect(missingTypeOf(ghostOf(graph))).toBe('light:reader.tiff')
    expect(graph.edges.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(warnings).toEqual([
      'Kept unknown node type "light:reader.tiff" (ghost) as a placeholder',
    ])
  })

  it('gives it the ports its wires name, and keeps their identity while its params do', () => {
    // The card and the selectors ask on every store publish; a fresh array each time would be a
    // fresh snapshot each time (invariant 7).
    const ghost = ghostOf(deserializeGraph(fileWithGhost()).graph)
    const def = requireNodeDef(ghost.type)
    expect(inputPorts(def, ghost.params).map((p) => p.id)).toEqual(['stack'])
    expect(outputPorts(def, ghost.params).map((p) => p.id)).toEqual(['volume'])
    expect(inputPorts(def, ghost.params)).toBe(inputPorts(def, ghost.params))
  })

  it('reads a handle an old file left out as the historical default', () => {
    const raw = JSON.parse(fileWithGhost())
    delete raw.edges[1].sourceHandle
    const { graph } = deserializeGraph(JSON.stringify(raw))
    const ghost = ghostOf(graph)
    expect(outputPorts(requireNodeDef(ghost.type), ghost.params).map((p) => p.id)).toEqual([
      'out',
    ])
    expect(graph.edges.find((e) => e.id === 'e2')?.sourceHandle).toBe('out')
  })
})

describe('writing it back', () => {
  it('spells it as the file did, with the edits the card allows applied', () => {
    const loaded = deserializeGraph(fileWithGhost({ captionOf: 'up' })).graph
    const moved: CodaGraph = {
      ...loaded,
      nodes: loaded.nodes.map((n) =>
        n.id === 'ghost' ? { ...n, position: { x: 10, y: 20 }, title: 'Renamed' } : n,
      ),
    }
    const saved = JSON.parse(serializeGraph(moved))
    const ghost = saved.nodes.find((n: { id: string }) => n.id === 'ghost')
    expect(ghost).toEqual({
      id: 'ghost',
      type: 'light:reader.tiff',
      position: { x: 10, y: 20 },
      params: { path: 'a.tif', channels: ['r', 'g'], nested: { depth: 2 } },
      title: 'Renamed',
      captionOf: 'up',
    })
    expect(saved.edges).toEqual(JSON.parse(fileWithGhost()).edges)
  })

  it('reaches the same file however many times it passes through', () => {
    const once = serializeGraph(deserializeGraph(fileWithGhost()).graph)
    const twice = serializeGraph(deserializeGraph(once).graph)
    const strip = (text: string) => ({ ...JSON.parse(text), meta: undefined })
    expect(strip(twice)).toEqual(strip(once))
  })

  it('restores a placeholder some writer saved as one, to whatever this build can make of it', () => {
    // A writer that forgot `documentNode` costs an uglier file, never the node.
    const loaded = deserializeGraph(fileWithGhost()).graph
    const leaked = JSON.stringify({ ...loaded, nodes: loaded.nodes })
    expect(missingTypeOf(ghostOf(deserializeGraph(leaked).graph))).toBe('light:reader.tiff')

    // And a type this build *does* have loads as that node, not as a placeholder of it — which is
    // what reviving a placeholder once its pack arrives will be.
    const stored = {
      id: 'n',
      type: MISSING_TYPE,
      position: { x: 0, y: 0 },
      params: { type: 'core.filterTable', stored: '{"params":{}}', inputs: [], outputs: [] },
    }
    const revived = deserializeGraph(JSON.stringify({ version: 1, nodes: [stored], edges: [] }))
    expect(revived.graph.nodes[0]!.type).toBe('core.filterTable')
    expect(revived.warnings).toEqual([])
  })

  it('stays a placeholder in memory — a duplicate is not a document', () => {
    // `subgraphOf` is what duplicate and the group peek read; only the text the clipboard writes
    // spells the original, or a duplicate would put an unregistered type on the canvas.
    const loaded = deserializeGraph(fileWithGhost()).graph
    expect(subgraphOf(loaded, ['ghost'])!.nodes[0]!.type).toBe(MISSING_TYPE)
    expect(fragmentBody(loaded, ['ghost'])!.nodes[0]!.type).toBe('light:reader.tiff')
  })

  it("keeps a group's promoted param on it, which this build cannot check", () => {
    // Its own build may declare the param, and one left at its default is not stored either.
    const raw = JSON.parse(fileWithGhost())
    raw.groups = [{ id: 'g', nodeIds: ['ghost'], exposed: [{ node: 'ghost', param: 'gain' }] }]
    const once = serializeGraph(deserializeGraph(JSON.stringify(raw)).graph)
    expect(JSON.parse(once).groups[0].exposed).toEqual([{ node: 'ghost', param: 'gain' }])
  })

  it('leaves every other node alone, by identity', () => {
    const up = deserializeGraph(fileWithGhost()).graph.nodes[0]!
    expect(documentNode(up)).toBe(up)
  })
})

describe('on the canvas and in a run', () => {
  it('is an error before anybody runs it, naming the pack it came from', () => {
    const { graph } = deserializeGraph(fileWithGhost())
    const issues = inferGraph(graph).nodes['ghost']!.issues
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('error')
    expect(issues[0]!.message).toMatch(/"light:reader.tiff" from the light pack/)
  })

  it('is an error too when the type it stood in for was lost from the file', () => {
    const stored = {
      id: 'n',
      type: MISSING_TYPE,
      position: { x: 0, y: 0 },
      params: { stored: '{}', inputs: [7, 'in'], outputs: [] },
    }
    const { graph } = deserializeGraph(
      JSON.stringify({ version: 1, nodes: [stored], edges: [] }),
    )
    const node = graph.nodes[0]!
    expect(inferGraph(graph).nodes['n']!.issues[0]!.message).toMatch(/"core.missing"/)
    // Only a string names a port.
    expect(inputPorts(requireNodeDef(node.type), node.params).map((p) => p.id)).toEqual(['in'])
  })

  it('names a built-in type without inventing a pack for it', () => {
    const raw = JSON.parse(fileWithGhost())
    raw.nodes[1].type = 'future.node'
    const { graph } = deserializeGraph(JSON.stringify(raw))
    const message = inferGraph(graph).nodes['ghost']!.issues[0]!.message
    expect(message).toMatch(/"future.node", a node this build of Coda does not have/)
    expect(message).not.toMatch(/pack/)
  })

  it('never runs, and nothing downstream waits on it', async () => {
    const { graph } = deserializeGraph(fileWithGhost())
    const scheduler = sourcelessScheduler()
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.info('ghost').state).toBe('error')
    expect(scheduler.info('down').state).not.toBe('done')
  })

  it('exports as a comment naming the type the file named', () => {
    const { graph } = deserializeGraph(fileWithGhost())
    const result = exportNotebook(graph)
    if (!result.ok) throw new Error(result.reason)
    expect(result.warnings.join(' ')).toContain('Unknown node type "light:reader.tiff"')
    expect(result.todos.map((t) => t.label)).toContain('My reader')
  })
})

describe('the registry', () => {
  it('answers for it on lookup and never lists it', () => {
    expect(getNodeDef(MISSING_TYPE)?.type).toBe(MISSING_TYPE)
    expect(allNodeDefs().map((d) => d.type)).not.toContain(MISSING_TYPE)
    expect(listableNodeDefs().map((d) => d.type)).not.toContain(MISSING_TYPE)
  })
})
