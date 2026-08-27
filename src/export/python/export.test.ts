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
import { caveGraph, everythingGraph } from '../fixture'
import { getEmitter } from './registry'
import { serializeNotebook } from './notebook'

const GOLDEN = new URL('./__fixtures__/everything.ipynb', import.meta.url).pathname
const CAVE_GOLDEN = new URL('./__fixtures__/cave.ipynb', import.meta.url).pathname

/** Fixed, so the golden file does not change every time it is written. */
const OPTIONS = { now: '2026-01-01', appVersion: '0.0.0-test' }

function exportFixture(graph = everythingGraph()): string {
  const result = exportNotebook(graph, OPTIONS)
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return serializeNotebook(result.notebook)
}

/** Both fixture graphs, since the CAVE half is its own for the reason `fixture.ts` records. */
const FIXTURES = [everythingGraph, caveGraph]

describe('the fixture itself', () => {
  /*
   * An edge pointing at a port that does not exist is silently dropped by nothing — `addEdge`
   * takes the handle it is given — so the fixture happily "wired" the 3D viewer to a socket it
   * has never had, every export of it said "nothing is wired", and the golden file recorded
   * that as correct. A fixture whose coverage is a claim rather than a fact is worse than no
   * fixture, because it is the thing everything else is checked against.
   */
  it('wires only ports the definitions declare', () => {
    const bad: string[] = []
    for (const build of FIXTURES) {
      const graph = build()
      const byId = new Map(graph.nodes.map((n) => [n.id, n]))
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
    }
    expect(bad).toEqual([])
  })

  it('reaches every emitting node type', () => {
    const covered = new Set(FIXTURES.flatMap((build) => build().nodes.map((n) => n.type)))
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

  it('matches the golden CAVE notebook', () => {
    const actual = exportFixture(caveGraph())
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(CAVE_GOLDEN, actual)
      return
    }
    expect(actual).toEqual(readFileSync(CAVE_GOLDEN, 'utf-8'))
  })

  /*
   * The third way a node fails to translate, and the one the backend declaration exists for: a
   * graph that is perfectly well wired, on a backend nobody has written *that node's* cell for.
   * Without it Find Neurons would emit `fetch_neurons(..., client=<a CAVEclient>)`, which is
   * valid Python, plausible reading, and an AttributeError at best.
   */
  it('refuses a neuPrint cell on a CAVE dataset, naming the backend', () => {
    const source = exportFixture(caveGraph())
    expect(source).toContain('wired to a CAVE dataset')
    // And nothing anywhere in the document reaches for neuprint-python.
    expect(source).not.toContain('NeuronCriteria')
    expect(source).not.toContain('fetch_neurons')
  })

  it('refuses a graph holding a synthetic dataset', () => {
    let g = emptyGraph('mock')
    g = addNode(g, {
      id: 'm',
      type: 'dataset.mock.opticlobe',
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

  /*
   * Every reason a cell comes out as a TODO is reported the same way, because a surface warning
   * about them wants the count and the names rather than the taxonomy. The unknown-type branch
   * is the one that had to be added by hand: it `continue`s before the ordinary TODO channel,
   * and it is the worst case there is — nothing is bound, so everything downstream is blocked.
   */
  it('reports every step that came out as a TODO, unknown types included', () => {
    let g = emptyGraph('mixed')
    g = addNode(g, {
      id: 'ds',
      type: 'dataset.hemibrain',
      position: { x: 0, y: 0 },
      params: { version: 'v1.2.1' },
    })
    g = addNode(g, {
      id: 'alien',
      type: 'from.the.future',
      position: { x: 260, y: 0 },
      params: {},
    })
    const result = exportNotebook(g, OPTIONS)
    if (!result.ok) throw new Error(result.reason)
    expect(result.todos.map((t) => t.nodeId)).toEqual(['alien'])

    // And on the fixture, where the gaps are registered nodes refusing on their own terms: every
    // report names a node that is really in the graph, and names it as the canvas does — a
    // warning listing a label nobody can find on screen is worse than no warning.
    const graph = everythingGraph()
    const fixture = exportNotebook(graph, OPTIONS)
    if (!fixture.ok) throw new Error(fixture.reason)
    expect(fixture.todos.length).toBeGreaterThan(0)
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    for (const todo of fixture.todos) {
      const node = byId.get(todo.nodeId)
      expect(node).toBeTruthy()
      expect(todo.label).toBe(node?.title || requireNodeDef(node!.type).label)
    }
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
