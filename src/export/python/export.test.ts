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
import type { ParamValues } from '../../core/node'
import { allNodeDefs, requireNodeDef } from '../../core/registry'
import '../../nodes'
import { exportNotebook } from './exporter'
import { caveGraph, everythingGraph, pathsGraph, twoNodeGraph } from '../fixture'
import { getEmitter } from './registry'
import { serializeNotebook } from './notebook'
import { inputPorts, outputPorts } from '../../core/ports'

const GOLDEN = new URL('./__fixtures__/everything.ipynb', import.meta.url).pathname
const CAVE_GOLDEN = new URL('./__fixtures__/cave.ipynb', import.meta.url).pathname

/** Fixed, so the golden file does not change every time it is written. */
const OPTIONS = { now: '2026-01-01', appVersion: '0.0.0-test' }

/** Every code cell of an export, joined — what the assertions below search. */
function notebookText(graph: Parameters<typeof exportNotebook>[0]): string {
  const result = exportNotebook(graph, OPTIONS)
  if (!result.ok) throw new Error(result.reason)
  return (result.notebook.cells as Array<{ source: string[] }>)
    .map((cell) => cell.source.join(''))
    .join('\n')
}

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
        const outputs = source ? outputPorts(requireNodeDef(source.type), source.params) : []
        const inputs = target ? inputPorts(requireNodeDef(target.type), target.params) : []
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

/*
 * The population is a property of the *dataset* node, and every query cell below it has to say so.
 *
 * The failure this catches is the one an export can make that nothing else can: a notebook that
 * runs cleanly and returns a different set of neurons from the canvas it came from. On hemibrain
 * that is 186,061 rows against a fraction of them, which reads as a fact about the dataset rather
 * than as a gap in the translation — so it is checked per emitter rather than once.
 */
/**
 * The region and normalisation options, which the two exporters answer differently.
 *
 * The Python one translates the region half onto three arguments of the `fetch_adjacencies`
 * call the cell was already making, and refuses normalisation because neuprint-python has no
 * equivalent of the reconstructed-partners-only denominator. Both halves are worth pinning:
 * `omit_rois` flipping the wrong way is the failure the existing comment on it describes —
 * one row per ROI per pair, double counted by everything downstream — and a refusal that
 * quietly became an emission would put a different number in the notebook from the canvas.
 */
describe('the region and normalisation options', () => {
  function connectivityCell(params: ParamValues): string {
    let g = emptyGraph('regions')
    g = addNode(g, {
      id: 'ds',
      type: 'dataset.hemibrain',
      position: { x: 0, y: 0 },
      params: { version: 'v1.2.1' },
    })
    g = addNode(g, {
      id: 'find',
      type: 'neuron.findNeurons',
      position: { x: 260, y: 0 },
      params: { typePattern: 'LC4' },
    })
    g = addNode(g, { id: 'c', type: 'neuron.connectivity', position: { x: 520, y: 0 }, params })
    g = {
      ...g,
      edges: [
        {
          id: 'e1',
          source: 'ds',
          sourceHandle: 'dataset',
          target: 'find',
          targetHandle: 'dataset',
        },
        {
          id: 'e2',
          source: 'ds',
          sourceHandle: 'dataset',
          target: 'c',
          targetHandle: 'dataset',
        },
        {
          id: 'e3',
          source: 'find',
          sourceHandle: 'neurons',
          target: 'c',
          targetHandle: 'neurons',
        },
      ],
    }
    return notebookText(g)
  }

  /*
   * `Include fragments`, and the finding behind it: `fetch_adjacencies` turns a `None` far end into
   * `NeuronCriteria()`, whose label is `Neuron` — read off the installed neuprint-python 0.6.3 —
   * so this cell has always restricted the far end where the node until now did not. The default
   * is therefore *unchanged text* that is now correct, and the other setting is what needed
   * writing.
   */
  it('leaves the far end unconstrained for published neurons, which is what None means', () => {
    const text = connectivityCell({ direction: 'outputs', hops: 1, minWeight: 1 })
    expect(text).toContain('fetch_adjacencies(\n    NeuronCriteria(bodyId=')
    expect(text).not.toContain("label='Segment'")
  })

  it('names Segment on the far end for every partner', () => {
    const text = connectivityCell({
      direction: 'outputs',
      hops: 1,
      minWeight: 1,
      includeFragments: true,
    })
    expect(text).toContain("NeuronCriteria(label='Segment', client=hemibrain_neuprint)")
  })

  it('carries it into the traversal helper, which is where the frontier is bounded', () => {
    const restricted = connectivityCell({ direction: 'outputs', hops: 2, minWeight: 1 })
    expect(restricted).toContain('all_segments=False')
    const every = connectivityCell({
      direction: 'outputs',
      hops: 2,
      minWeight: 1,
      includeFragments: true,
    })
    expect(every).toContain('all_segments=True')
    expect(every).toContain('far = NeuronCriteria(label="Segment", client=client)')
  })

  /*
   * The `Neuron Set` port, which is emitted whether or not anything downstream reads it — an
   * emitter cannot see which of its outputs the graph consumes, and a port left unassigned is
   * a NameError in somebody's notebook rather than a cell that is merely longer.
   */
  it('binds the Neuron Set port from the edge list and the seeds', () => {
    const text = connectivityCell({ direction: 'outputs', hops: 1, minWeight: 1 })
    expect(text).toContain('def coda_endpoint_neurons(')
    expect(text).toContain(
      "connectivity_neuron_set = coda_endpoint_neurons(connectivity_connections, find_neurons['neuronId'].tolist())",
    )
    // The derived form binds the port directly; only `full` needs a lookup in between.
    expect(text).not.toContain('_endpoints = ')
  })

  it('looks the rows up for full, and says what that call cannot answer for', () => {
    const text = connectivityCell({
      direction: 'outputs',
      hops: 1,
      minWeight: 1,
      neuronRows: 'full',
    })
    expect(text).toContain('_endpoints = coda_endpoint_neurons(')
    expect(text).toContain('connectivity_neuron_set, _ = fetch_neurons(')
    expect(text).toContain("bodyId=_endpoints['neuronId'].tolist()")
    expect(text).toContain('connectivity_neuron_set = coda_neurons(connectivity_neuron_set)')
    expect(text).toContain("below the dataset's neuron threshold")
  })

  it('keeps omit_rois on when no region option is set', () => {
    const text = connectivityCell({ direction: 'outputs', hops: 1, minWeight: 1 })
    expect(text).toContain('omit_rois=True')
  })

  it('turns omit_rois off to split, and leaves the primary default alone', () => {
    const text = connectivityCell({
      direction: 'outputs',
      hops: 1,
      minWeight: 1,
      splitByRoi: true,
    })
    expect(text).not.toContain('omit_rois=True')
    // fetch_adjacencies restricts to the primary set by default, which is the node's default
    // too — so the faithful translation of "Primary regions only: on" is no argument at all.
    expect(text).not.toContain('include_nonprimary')
  })

  it('adds the region to the dedupe key, so a `both` split keeps every part', () => {
    // Only the `both` branch dedupes — one direction of fetch_adjacencies returns unique rows.
    // Keyed on the pair alone, an edge internal to the seed set would keep whichever region
    // arrived first and drop the rest of the connection: a table that looks fine and is short.
    const split = connectivityCell({
      direction: 'both',
      hops: 1,
      minWeight: 1,
      splitByRoi: true,
    })
    expect(split).toContain("drop_duplicates(subset=['bodyId_pre', 'bodyId_post', 'roi'])")
    const whole = connectivityCell({ direction: 'both', hops: 1, minWeight: 1 })
    expect(whole).toContain("drop_duplicates(subset=['bodyId_pre', 'bodyId_post'])")
  })

  it('asks for the non-primary regions only when the toggle is off', () => {
    const text = connectivityCell({
      direction: 'outputs',
      hops: 1,
      minWeight: 1,
      splitByRoi: true,
      primaryRoisOnly: false,
    })
    expect(text).toContain('include_nonprimary=True')
  })

  it('names the regions and sums them back when Split by region is off', () => {
    const text = connectivityCell({
      direction: 'outputs',
      hops: 1,
      minWeight: 1,
      rois: ['LO(R)', 'ME(R)'],
    })
    expect(text).toContain("rois=['LO(R)', 'ME(R)']")
    // Restricting is fetch_adjacencies' argument; totalling across the named regions is ours,
    // because it has no mode that does both.
    expect(text).toContain("groupby(['bodyId_pre', 'bodyId_post'], as_index=False)['weight']")
    // And the one place the two genuinely disagree is said in the cell rather than left to be
    // discovered from a row count.
    expect(text).toContain('min_total_weight across every ROI')
  })

  it('refuses normalisation rather than emitting the reachable half of it', () => {
    const text = connectivityCell({
      direction: 'outputs',
      hops: 1,
      minWeight: 1,
      normalize: true,
      normalizeBasis: 'connected',
    })
    expect(text).toContain('TODO')
    expect(text).toMatch(/no neuprint-python equivalent/)
    // The refusal has to say what to write instead, or it reads as the feature being broken.
    expect(text).toContain('upstream/downstream')
  })
})

/**
 * The Paths node's own refusal, which is one reason past `Connectivity`'s.
 *
 * Neither library has a group-level denominator, and neither has anything for `Min fraction` —
 * which prunes the frontier as the search grows. So an export without them would not be the same
 * routes missing two columns; it would be a different walk. Asserted at **neuron level**, so what
 * is being pinned is the normalisation refusal rather than the collapse one that would fire first.
 */
describe('a normalised Paths node', () => {
  it('is refused, because an export without it walks a different graph', () => {
    const text = notebookText(pathsGraph({ collapseTypes: false, normalize: true }))
    expect(text).toContain('TODO')
    expect(text).toMatch(/no neuprint-python equivalent/)
    expect(text).toContain('Min fraction')
    // The neuron-level node without it still emits, or the test above says nothing.
    expect(notebookText(pathsGraph({ collapseTypes: false }))).toContain('fetch_paths(')
  })
})

describe('the population filters', () => {
  const graphWith = (params: ParamValues, query: string, queryParams: ParamValues = {}) =>
    twoNodeGraph('dataset.hemibrain', params, query, queryParams)

  const NONE = { tracedOnly: false, typedOnly: false, superclassOnly: false }

  const QUERIES: [string, ParamValues][] = [
    ['neuron.findNeurons', { typePattern: 'LC.*' }],
    ['neuron.idsFromLabel', { labels: ['LC4'], status: '' }],
    ['neuron.explore', {}],
  ]

  /*
   * A lone `traced` is the one filter `NeuronCriteria` can express, and it is worth pushing: it
   * narrows at the server, so the cell downloads the traced subset rather than every row.
   * `IDs from Label` carries its own `Status` param, so the off case has to clear it — what is
   * under test is the *dataset's* contribution, not that node's.
   */
  it.each(QUERIES.slice(0, 2))('pushes a lone traced into the %s criteria', (type, params) => {
    const on = exportFixture(graphWith({ ...NONE, tracedOnly: true }, type, params))
    expect(on).toMatch(/status=\[?'Traced'\]?/)
    expect(exportFixture(graphWith(NONE, type, params))).not.toContain("'Traced'")
  })

  /*
   * Explore is the exception, and deliberately: its `All` port *is* the whole index, so the
   * frame this narrows is the one the node itself holds and the mask is the node's own
   * `narrowPopulation` written in pandas. Pushing here would work for a lone `traced` and would
   * then need the mask anyway for every other combination.
   */
  it('masks rather than pushes on Explore, whose All port is the index itself', () => {
    const source = exportFixture(graphWith({ ...NONE, tracedOnly: true }, 'neuron.explore', {}))
    expect(source).toContain("== 'Traced'")
    expect(source).not.toContain('status=')
    expect(exportFixture(graphWith(NONE, 'neuron.explore', {}))).not.toContain("'Traced'")
  })

  /*
   * Everything else is a mask on the result, and that is forced rather than chosen.
   * `NeuronCriteria` ANDs its keyword arguments and has no null test at all, so it can say
   * neither "type is not empty" nor an OR — and pushing half an OR into the criteria while
   * masking the rest would AND the two halves and quietly return fewer neurons than the canvas.
   */
  it.each(QUERIES)('masks a filter NeuronCriteria cannot express, in %s', (type, params) => {
    const source = exportFixture(graphWith({ ...NONE, typedOnly: true }, type, params))
    expect(source).toContain('.notna() & (')
    expect(source).toContain("['type']")
    // An empty string is absent, the same rule the `notEmpty` operator applies — so a checkbox
    // and the equivalent filter row cannot answer two different sets.
    expect(source).toContain("!= ''")
  })

  it('ORs the disjuncts, each parenthesised so precedence cannot decide it', () => {
    const source = exportFixture(
      graphWith({ ...NONE, tracedOnly: true, typedOnly: true }, 'neuron.explore', {}),
    )
    expect(source).toContain('| (')
    // A lone traced would have gone into the criteria; with a second filter it must not.
    expect(source).not.toContain('status=')
  })

  /*
   * The precedence, as on the canvas: a status row is the more specific statement and removes
   * the `traced` disjunct. Emitting both would compile `status=['Assign', 'Traced']`, which is
   * an empty result for a value nobody chose.
   */
  it('lets an explicit status row win rather than emitting both', () => {
    const source = exportFixture(
      graphWith({ ...NONE, tracedOnly: true }, 'neuron.findNeurons', {
        typePattern: 'LC.*',
        status: 'Assign',
      }),
    )
    expect(source).toContain("status=['Assign']")
    expect(source).not.toContain("'Traced'")
  })
})

describe('Table from URL', () => {
  /*
   * The rewrite is `rawFileUrl`'s and tested there; what matters here is that the *emitter*
   * asks. `pd.read_csv` on a github.com file page does not fail — it returns a frame of HTML —
   * so a notebook carrying the pasted link reproduces the silent version of the bug outside
   * Coda, where nothing at all is left to explain it.
   */
  function urlCell(url: string): string {
    let g = emptyGraph('from-url')
    g = addNode(g, {
      id: 'u',
      type: 'core.tableFromUrl',
      position: { x: 0, y: 0 },
      params: { url },
    })
    return notebookText(g)
  }

  it('reads the raw file behind a GitHub file link, and says that it did', () => {
    const page = 'https://github.com/o/r/blob/main/annotations.csv'
    const text = urlCell(page)
    expect(text).toContain(
      "pd.read_csv('https://raw.githubusercontent.com/o/r/main/annotations.csv')",
    )
    // The note names the pasted link, so the emitted address does not read as a typo beside
    // the one on the card — which keeps showing what was typed.
    expect(text).toContain(page)
    expect(text).not.toContain(`pd.read_csv('${page}`)
  })

  it('leaves an ordinary URL alone, with nothing to explain', () => {
    const text = urlCell('https://example.org/annotations.csv')
    expect(text).toContain("pd.read_csv('https://example.org/annotations.csv')")
    expect(text).not.toContain('GitHub')
  })
})
