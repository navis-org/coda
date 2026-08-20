/**
 * The exporter, against the everything graph.
 *
 * Golden files are the primary check: the notebook is written to `__fixtures__` and compared,
 * so any change to any emitter shows up as a readable diff rather than as a passing test. What
 * a golden file cannot see is whether the Python is *valid* — that is `scripts/check-export.py`,
 * which parses every cell and is where a runtime-only mistake (an import that does not expose
 * what it looks like it exposes) actually gets caught.
 *
 * Regenerate with `pnpm export:golden` after an intentional change, and read the diff.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { addNode, emptyGraph } from '../../core/graph'
import { allNodeDefs, requireNodeDef } from '../../core/registry'
import '../../nodes'
import { exportNotebook } from './exporter'
import { everythingGraph } from '../fixture'
import { getEmitter } from './registry'
import { serializeNotebook } from './notebook'

const GOLDEN = new URL('./__fixtures__/everything.ipynb', import.meta.url).pathname

/** Fixed, so the golden file does not change every time it is written. */
const OPTIONS = { now: '2026-01-01', appVersion: '0.0.0-test' }

function exportFixture(): string {
  const result = exportNotebook(everythingGraph(), OPTIONS)
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return serializeNotebook(result.notebook)
}

describe('the fixture itself', () => {
  /*
   * An edge pointing at a port that does not exist is silently dropped by nothing — `addEdge`
   * takes the handle it is given — so the fixture happily "wired" the 3D viewer to a socket it
   * has never had, every export of it said "nothing is wired", and the golden file recorded
   * that as correct. A fixture whose coverage is a claim rather than a fact is worse than no
   * fixture, because it is the thing everything else is checked against.
   */
  it('wires only ports the definitions declare', () => {
    const graph = everythingGraph()
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const bad: string[] = []

    for (const edge of graph.edges) {
      const source = byId.get(edge.source)
      const target = byId.get(edge.target)
      const outputs = (source ? requireNodeDef(source.type).outputs : []) ?? []
      const inputs = (target ? requireNodeDef(target.type).inputs : []) ?? []
      if (!outputs.some((p) => p.id === edge.sourceHandle)) {
        bad.push(`${edge.source} has no output "${edge.sourceHandle}"`)
      }
      if (!inputs.some((p) => p.id === edge.targetHandle)) {
        bad.push(`${edge.target} has no input "${edge.targetHandle}"`)
      }
    }
    expect(bad).toEqual([])
  })

  it('reaches every emitting node type', () => {
    const covered = new Set(everythingGraph().nodes.map((n) => n.type))
    const missed = allNodeDefs()
      .map((d) => d.type)
      .filter((t) => getEmitter(t) && !covered.has(t))
    expect(missed).toEqual([])
  })
})

describe('notebook export', () => {
  it('matches the golden notebook', () => {
    const actual = exportFixture()
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(GOLDEN, actual)
      return
    }
    expect(actual).toEqual(readFileSync(GOLDEN, 'utf-8'))
  })

  it('refuses a graph holding a synthetic dataset', () => {
    let g = emptyGraph('mock')
    g = addNode(g, {
      id: 'm',
      type: 'dataset.mock.hemibrain',
      position: { x: 0, y: 0 },
      params: {},
    })
    const result = exportNotebook(g)
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The refusal has to name what to do about it, or it reads as the feature being broken.
    expect(result.detail).toMatch(/[Rr]eplace them with a real dataset/)
  })

  it('says a muted node was muted rather than omitting it', () => {
    const source = exportFixture()
    expect(source).toContain('Muted step')
    expect(source).toContain('Muted on the canvas')
  })

  /*
   * The walk detects an unwired required port for every node, which is what let ~25 emitters
   * drop a hand-written `if (!ctx.input('in')) return ctx.todo(…)` — each of which hardcoded a
   * port id as a string, and one of which had the id wrong for months.
   */
  it('names the unwired ports of a node, by their labels', () => {
    let g = emptyGraph('unfinished')
    g = addNode(g, {
      id: 'c',
      type: 'neuron.connectivity',
      position: { x: 0, y: 0 },
      params: {},
    })
    const result = exportNotebook(g, OPTIONS)
    if (!result.ok) throw new Error(result.reason)
    const text = (result.notebook.cells as Array<{ source: string[] }>)
      .map((c) => c.source.join(''))
      .join('\n')
    expect(text).toContain('"Dataset" and "Neurons" are not wired')
  })

  it('refuses an empty graph rather than writing an empty notebook', () => {
    const result = exportNotebook(emptyGraph('nothing'))
    expect(result.ok).toBe(false)
  })

  it('binds nothing for a node it could not translate', () => {
    // Paths with Collapse types on has no equivalent, so everything downstream must report
    // being blocked rather than referring to a variable that was never assigned.
    const result = exportNotebook(everythingGraph(), OPTIONS)
    if (!result.ok) throw new Error(result.reason)
    const cells = result.notebook.cells as Array<{ source: string[] }>
    const text = cells.map((c) => c.source.join('')).join('\n')
    expect(text).not.toMatch(/^\s*paths\b/m)
  })
})
