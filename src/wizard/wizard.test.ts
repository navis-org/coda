/**
 * The Workflow Wizard's output, held to what the bundled examples were held to.
 *
 * This file is where `examples.test.ts` went. The four examples doubled as end-to-end fixtures —
 * if one stopped inferring cleanly or stopped running, something in the engine, the node set or
 * the mock source had regressed — and that standing is worth more here, because the wizard can
 * produce **every** combination and a reader gets whichever one they asked for. A broken example
 * was one bad graph; a broken arm of this is a bad graph handed to somebody who cannot tell that
 * it is the tool rather than their answers.
 *
 * Three tiers, and the split is not arbitrary:
 *
 *  - **Every combination on every dataset** is checked for *inference*, which needs no network:
 *    a wire that cannot be made and a param that names a column nobody publishes both show up
 *    here. This is what pins `visualisationOptions` against the arms of `bodyOf` — the two halves
 *    of "which viewer can end this chain", written in different files.
 *  - **Every combination on the synthetic dataset** is *run*, except the two starts that wait for
 *    the reader. Explore's `selected` is empty until somebody ticks a row and Input IDs is empty
 *    until somebody pastes one, so a graph built on either correctly produces nothing — asserting
 *    it produced something would be asserting the opposite of what those answers mean.
 *  - **The demo workflows** get the round-trip and the numbers, because they are also what the
 *    tour and half the UI suites put on the canvas.
 */

import { describe, expect, it } from 'vitest'

import type { CodaGraph } from '../core/graph'
import { deserializeGraph, serializeGraph } from '../core/graph'
import { inferGraph } from '../core/inference'
import { isAnnotation, requireNodeDef } from '../core/registry'
import { ROW_TRACKS } from '../core/dashboard'
import { Scheduler } from '../core/scheduler'
import { isMatrixValue, isTableValue } from '../core/values'
import { registerBuiltinSources } from '../data/builtins'
import { requireSource } from '../data/source'
import { starterFamilies } from '../nodes/lib/datasetFamilies'
import { parseMarkdown } from '../ui/markdown'
import '../nodes'
import { DEMO_DATASET, buildWorkflow, demoWorkflow } from './build'
import type { AnalysisId, VisualisationId, WizardAnswers } from './options'
import {
  analysisOption,
  analysisOptions,
  everyCombination,
  startOptions,
  visualisationOption,
  visualisationOptions,
} from './options'

/*
 * At module scope, not in `beforeAll`, and that is not a style choice.
 *
 * The option space is gated on `capabilityOf`, which answers **true** for a source that is not
 * registered — deliberately, so an unknown backend is not silently stripped of every feature. So
 * a `describe.each` built from `everyCombination` at collection time, before a `beforeAll` has
 * run, enumerates combinations the wizard would never offer: this file first "ran" a Neuroglancer
 * cell against the synthetic dataset, which publishes no scene, and reported it as a broken arm
 * of the builder. Registering here is what makes the collected list the list a reader can reach.
 */
registerBuiltinSources({ mockLatencyMs: 0 })

function scheduler(): Scheduler {
  return new Scheduler({ resolveSource: (id) => requireSource(id) })
}

function errorsIn(answers: WizardAnswers): string[] {
  const inference = inferGraph(buildWorkflow(answers))
  return Object.entries(inference.nodes).flatMap(([nodeId, node]) =>
    node.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => `${nodeId}: ${issue.message}`),
  )
}

function label(answers: WizardAnswers): string {
  return `${answers.dataset} / ${answers.start} / ${answers.analysis} / ${answers.visualisations.join('+')}`
}

describe('the option space', () => {
  /*
   * The wizard's promise in one test: whatever four answers somebody gives, the graph is one the
   * app can type-check. Every family, not only the synthetic one, because the gating is
   * per-source — a family whose source cannot browse must not be offered Explore, and the way
   * that mistake surfaces is an unmade wire rather than an exception.
   */
  it('builds a graph with no type errors, for every reachable combination', () => {
    let checked = 0
    for (const family of starterFamilies()) {
      for (const answers of everyCombination(family.key)) {
        expect(errorsIn(answers), label(answers)).toEqual([])
        checked++
      }
    }
    // A guard against the loop quietly emptying — a capability read that started answering
    // `false` everywhere would make this file pass by checking nothing.
    expect(checked).toBeGreaterThan(60)
  })

  it('offers only what the source can do', () => {
    // The synthetic source generates geometry in the browser and publishes no scene for an
    // external viewer to read, which is the one capability difference worth pinning by name.
    const mock = visualisationOptions(DEMO_DATASET, 'neurons').map((o) => o.id)
    expect(mock).toContain('table')
    expect(mock).not.toContain('neuroglancer')

    // And a published one does offer it, or the gate is refusing everything.
    const published = starterFamilies().find((f) => !f.synthetic)
    expect(published, 'no published family to check the gate against').toBeTruthy()
    expect(
      visualisationOptions(published!.key, 'neurons').map((o) => o.id),
      'the scene gate is refusing every family',
    ).toContain('neuroglancer')
  })

  /*
   * The second half of the gate, on the backend that needed it.
   *
   * The test above checks both directions already — but for **one capability on one family**:
   * `viewerScene`, on whichever published family comes first, which is a neuPrint one. Nothing
   * pinned `skeletons` on CAVE, and that is the gap the wizard shipped through: it hid "View
   * morphology in 3D" and "NBLAST clustering" for every CAVE family, all three of which have
   * skeletons. Worth its own test rather than a broadened one because an over-refusal is the
   * *silent* direction — an over-offer lands a message on the Skeletons card, where this left a
   * reader looking at a question two answers short with nothing to see.
   *
   * `paths` is the control, and it matters as much as the first assertion: a ceiling that raised
   * every flag rather than the one that genuinely varies would ship a workflow the Paths node
   * correctly refuses, and nothing downstream of here would notice. CAVE aggregates no hop
   * server-side at any datastack.
   */
  it('offers the skeleton workflows on CAVE, and still not the paths one', () => {
    // Derived, so a fourth CAVE datastack is covered the day it is specced rather than the day
    // somebody remembers this list. The skeletons are real but arrive by different routes:
    // FlyWire's are the bucket published beside materialization 783, BANC's and minnie65's are
    // built from the level-2 cache.
    const cave = starterFamilies().filter((family) => family.sourceId === 'cave')
    expect(cave.length, 'no CAVE family to check the gate against').toBeGreaterThan(0)
    for (const { key } of cave) {
      const analyses = analysisOptions(key).map((o) => o.id)
      expect(
        analyses,
        `${key}: skeletons are per dataset, and every CAVE family has them`,
      ).toEqual(expect.arrayContaining(['morphology', 'nblast']))
      expect(analyses, `${key}: CAVE aggregates no hop server-side`).not.toContain('paths')
    }
  })

  it('never offers a question with nothing in it', () => {
    for (const family of starterFamilies()) {
      expect(startOptions(family.key).length, family.key).toBeGreaterThan(0)
      for (const analysis of analysisOptions(family.key)) {
        expect(
          visualisationOptions(family.key, analysis.id).length,
          `${family.key} / ${analysis.id}`,
        ).toBeGreaterThan(0)
      }
    }
  })
})

/**
 * Two reasons a combination is not run here, and neither is a gap in the builder.
 *
 * Only `search` runs unattended: the other two starts are *waiting* for the reader, and a graph
 * that produced rows without them would mean the wizard had guessed a selection somebody never
 * made.
 *
 * And the two clusterings run their arithmetic in **Pyodide**, which is loaded into a module
 * worker and therefore needs a browser — `neuron.nblast` and `cluster.linkage` both answer "this
 * needs a browser" outside one, which is a fact about the runner and not about the chain. Their
 * *inference* is checked like everything else above, which is what catches a wire that cannot be
 * made or a param naming a column nobody publishes; the chains themselves were driven in Chrome.
 * See `docs/python-pyodide.md`.
 */
const NEEDS_A_BROWSER = new Set<AnalysisId>(['cluster', 'nblast'])
const RUNNABLE = everyCombination(DEMO_DATASET).filter(
  (a) => a.start === 'search' && !NEEDS_A_BROWSER.has(a.analysis),
)

describe.each(RUNNABLE.map((a) => [label(a), a] as const))('runs: %s', (_name, answers) => {
  it('runs to completion and produces output at every terminal node', async () => {
    const graph = buildWorkflow(answers)
    const sched = scheduler()
    const summary = await sched.run(graph, { mode: 'full' })

    expect(summary.failed).toEqual([])
    expect(summary.cancelled).toBe(false)

    /*
     * Annotations are excluded on both counts, and the exclusion is the assertion: a text note is
     * not work, so it must appear in neither `executed` nor `deferred`. Counting one here would
     * be counting the comments in a program as statements.
     */
    const dataflow = graph.nodes.filter((n) => !isAnnotation(n.type))
    expect(summary.executed.length).toBe(dataflow.length)

    const consumed = new Set(graph.edges.map((e) => e.source))
    for (const node of dataflow.filter((n) => !consumed.has(n.id))) {
      const outputs = sched.outputs(node.id)
      expect(outputs, `${node.id} produced no outputs`).toBeDefined()
      const [portId, value] = Object.entries(outputs!)[0]!
      expect(value, `${node.id} output is empty`).toBeDefined()

      // A viewer's `selected` port is empty until somebody clicks in it — the correct state for a
      // freshly run graph, not a failure.
      if (portId === 'selected') continue
      if (isTableValue(value)) {
        expect(value.length, `${node.id} returned an empty table`).toBeGreaterThan(0)
      } else if (isMatrixValue(value)) {
        expect(value.rowLabels.length, `${node.id} returned an empty matrix`).toBeGreaterThan(0)
        expect(
          [...value.values].some((v) => v > 0),
          `${node.id} matrix is all zeros`,
        ).toBe(true)
      }
    }
  })
})

/**
 * The fourth question takes a set, and `everyCombination` walks it one viewer at a time — the
 * power set is a different order of magnitude for no more coverage. What a second viewer changes
 * is the *shape*, so that is pinned here directly: one chain, several nodes on the end of it.
 */
describe('several viewers', () => {
  const both = (analysis: AnalysisId, visualisations: VisualisationId[]) =>
    buildWorkflow({
      dataset: DEMO_DATASET,
      start: 'search',
      analysis,
      visualisations,
      notes: false,
      dashboard: false,
    })

  it('hangs them off the same port, and names the first one `view`', () => {
    const graph = both('partners', ['table', 'bar'])
    expect(graph.nodes.map((n) => n.id)).toEqual([
      'ds',
      'find',
      'conn',
      'group',
      'sort',
      'view',
      'view2',
    ])
    // Both fed by the sort, so the chain is built once. `view` keeps the id every single-viewer
    // workflow has had, which is what a saved file and a share link go on meaning.
    const feeds = graph.edges.filter((e) => e.source === 'sort').map((e) => e.target)
    expect(feeds).toEqual(['view', 'view2'])
    expect(graph.nodes.find((n) => n.id === 'view')?.type).toBe('out.table')
    expect(graph.nodes.find((n) => n.id === 'view2')?.type).toBe('out.barChart')
  })

  /*
   * Side by side on one row, stepped by each card's own width — not stacked. A viewer's *height*
   * is its content, so two stacked viewers overlapped the moment the graph ran (a run Table card
   * is 387px against a pitch of 209, measured in a browser); a width is declared and does not
   * move. `placeGuards.test.ts` is what checks the clearance, over every combination; this pins
   * the shape.
   */
  it('sets the viewers side by side, on one row', () => {
    const graph = both('partners', ['table', 'bar', 'pie'])
    const views = ['view', 'view2', 'view3'].map(
      (id) => graph.nodes.find((n) => n.id === id)!.position,
    )
    expect(new Set(views.map((p) => p.y)).size, 'one row').toBe(1)
    expect(views[1]!.x).toBeGreaterThan(views[0]!.x)
    expect(views[2]!.x).toBeGreaterThan(views[1]!.x)
  })

  /*
   * The three arms where a viewer brings its own upstream node, which is what a second viewer can
   * get wrong: the row-normalise belongs to the heatmap, and the geometry queries belong to the
   * 3D scene. Ticking both viewers must build each of those once, and ticking only the other one
   * must not build them at all.
   */
  it('builds a viewer’s own upstream once, and only when that viewer is ticked', () => {
    const heatOnly = both('matrix', ['heatmap'])
    const tableOnly = both('matrix', ['table'])
    const bothViews = both('matrix', ['heatmap', 'table'])
    expect(heatOnly.nodes.filter((n) => n.id === 'norm')).toHaveLength(1)
    expect(tableOnly.nodes.filter((n) => n.id === 'norm')).toHaveLength(0)
    expect(bothViews.nodes.filter((n) => n.id === 'norm')).toHaveLength(1)
    // And each viewer is fed from where it belongs, not from one shared port.
    const from = (graph: typeof bothViews, target: string) =>
      graph.edges.find((e) => e.target === target)?.source
    expect(from(bothViews, 'view')).toBe('norm')
    expect(from(bothViews, 'view2')).toBe('adj')
  })

  it('fetches geometry for the 3D scene and not for a Neuroglancer cell alone', () => {
    const scene = both('morphology', ['neuroglancer'])
    expect(scene.nodes.map((n) => n.type)).not.toContain('neuron.skeletons')
    // …and the search is uncapped, because nothing is downloading a skeleton.
    expect(scene.nodes.find((n) => n.id === 'find')?.params.limit).toBe(0)

    const drawn = both('morphology', ['viewer3d', 'neuroglancer'])
    expect(drawn.nodes.filter((n) => n.type === 'neuron.skeletons')).toHaveLength(1)
    expect(drawn.edges.filter((e) => e.source === 'skel').map((e) => e.target)).toEqual([
      'view',
    ])
    // The scene takes the dataset and the ids, never the geometry.
    expect(
      drawn.edges
        .filter((e) => e.target === 'view2')
        .map((e) => e.sourceHandle)
        .sort(),
    ).toEqual(['dataset', 'neurons'])
  })

  /*
   * The influence arm is the third of those and the only one where a viewer's upstream depends on
   * *another* viewer: `Per query neuron` belongs to the heatmap, and once it is on the node emits
   * one row per (query, influencer) — so the table, which wants the ranking, needs a Group By to
   * put it back. Ticked alone it reads the node directly and no such node exists.
   */
  it('turns Per query neuron on for the heatmap, and regroups for the table beside it', () => {
    const tableOnly = both('influence', ['table'])
    expect(tableOnly.nodes.find((n) => n.id === 'inf')?.params.perQuery).toBe(false)
    expect(tableOnly.nodes.map((n) => n.id)).not.toContain('group')
    // Straight off the node: the ranking is what it already emits.
    expect(tableOnly.edges.find((e) => e.target === 'view')?.source).toBe('inf')

    const heatOnly = both('influence', ['heatmap'])
    expect(heatOnly.nodes.find((n) => n.id === 'inf')?.params.perQuery).toBe(true)
    expect(heatOnly.nodes.map((n) => n.id)).not.toContain('group')

    const bothViews = both('influence', ['heatmap', 'table'])
    expect(bothViews.nodes.find((n) => n.id === 'inf')?.params.perQuery).toBe(true)
    // One Influence node feeding both halves — the pairs to the pivot, and back through a Group
    // By for the ranking. Two Influence nodes would be two walks over the same connectome.
    expect(bothViews.nodes.filter((n) => n.type === 'neuron.influence')).toHaveLength(1)
    expect(
      bothViews.edges
        .filter((e) => e.source === 'inf')
        .map((e) => e.target)
        .sort(),
    ).toEqual(['group', 'piv'])
    expect(bothViews.edges.find((e) => e.target === 'view')?.source).toBe('piv')
    expect(bothViews.edges.find((e) => e.target === 'view2')?.source).toBe('sort')
  })

  it('is still inference-clean with two viewers on the end', () => {
    for (const [analysis, views] of [
      ['partners', ['table', 'bar', 'pie']],
      ['matrix', ['heatmap', 'table']],
      ['influence', ['heatmap', 'table']],
      ['network', ['network', 'metrics']],
      ['morphology', ['viewer3d', 'neuroglancer']],
      ['neurons', ['table', 'neuroglancer']],
    ] as [AnalysisId, VisualisationId[]][]) {
      const inference = inferGraph(both(analysis, views))
      const errors = Object.entries(inference.nodes).flatMap(([nodeId, node]) =>
        node.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => `${nodeId}: ${issue.message}`),
      )
      expect(errors, `${analysis} / ${views.join('+')}`).toEqual([])
    }
  })
})

/**
 * "Open as a dashboard" writes a `DashboardLayout` into the document rather than switching a view,
 * which is what makes the answer survive a save and a share link. So what is worth pinning is the
 * layout: which nodes got cells, that the flag saying it is the view rode along with them, and
 * that a graph nobody asked this of carries nothing at all.
 */
/**
 * The Neuron Topology card, which is the wizard's first **self-fetching** viewer that is not
 * Neuroglancer — and the reason `selfFetching` in `build.ts` asks the registry rather than
 * testing an id.
 */
describe('the Neuron Topology viewer', () => {
  const build = (analysis: AnalysisId, visualisations: VisualisationId[]) =>
    buildWorkflow({
      dataset: DEMO_DATASET,
      start: 'search',
      analysis,
      visualisations,
      notes: false,
      dashboard: false,
    })

  /** Which port on `target` each incoming wire lands on, sorted. */
  const portsInto = (graph: CodaGraph, target: string) =>
    graph.edges
      .filter((e) => e.target === target)
      .map((e) => e.targetHandle)
      .sort()

  it('takes the dataset and the neuron table, and no geometry', () => {
    /*
     * Wired like an ordinary viewer — one link into a port called `in` — this card has no such
     * port. Checked by reverting `selfFetching` to the id test it replaced: three tests fail,
     * this one and the two blanket sweeps (`no type errors, for every reachable combination` and
     * the runnable pass). So the sweeps do cover it, which makes this one about *saying which
     * wires are right* rather than about catching the break — the sweeps report a broken arm of
     * the builder without saying what the arm was supposed to produce.
     */
    const graph = build('neurons', ['topology'])
    expect(portsInto(graph, 'view')).toEqual(['dataset', 'neurons'])
    // And nothing was fetched on its behalf: it does its own.
    expect(graph.nodes.map((n) => n.type)).not.toContain('neuron.skeletons')
    expect(graph.nodes.map((n) => n.type)).not.toContain('neuron.synapses')
  })

  it('sits beside the 3D scene rather than replacing it, each fed from its own place', () => {
    const graph = build('morphology', ['viewer3d', 'topology'])
    // The scene reads the arm's geometry…
    expect(portsInto(graph, 'view').sort()).toEqual(['points', 'skeletons'])
    // …and the Topology card reads the search, which is what makes ticking both worth doing.
    expect(portsInto(graph, 'view2')).toEqual(['dataset', 'neurons'])
    expect(graph.nodes.filter((n) => n.type === 'neuron.skeletons')).toHaveLength(1)
  })

  it('is offered wherever a neuron table survives to the end of the chain', () => {
    // Under `morphology` because it is a way of looking at morphology, and under `neurons`
    // because it needs no analysis at all — those are the two chains that still carry neurons.
    expect(visualisationOptions(DEMO_DATASET, 'morphology').map((o) => o.id)).toContain('topology')
    expect(visualisationOptions(DEMO_DATASET, 'neurons').map((o) => o.id)).toContain('topology')
    // Not off a chain that has turned neurons into something else.
    expect(visualisationOptions(DEMO_DATASET, 'partners').map((o) => o.id)).not.toContain(
      'topology',
    )
  })

  it('carries the skeleton requirement on the viewer, because `neurons` cannot carry it', () => {
    /*
     * The gate travels with the *viewer* here rather than with the analysis, which is the one
     * structural thing about this option: `morphology` already declares `skeletons`, but
     * `neurons` declares nothing, so without it a source with no skeletons would be offered a
     * Topology card that can never draw.
     *
     * Asserted on the declaration rather than by building a graph, and that is a limitation
     * worth stating: every family in `starterFamilies` currently answers `true` for `skeletons`,
     * so there is no dataset here that would exercise the filter. A test that looked for one
     * would pass by finding nothing, which is the vacuous shape this file's own header warns
     * about. What is checked is that the requirement exists and that `available` reads it —
     * `offers only what the source can do` covers the reading itself.
     */
    expect(visualisationOption('topology')?.requires).toBe('skeletons')
    expect(analysisOption('morphology')?.requires).toBe('skeletons')
  })
})

describe('opening as a dashboard', () => {
  const built = (analysis: AnalysisId, visualisations: VisualisationId[], dashboard: boolean) =>
    buildWorkflow({
      dataset: DEMO_DATASET,
      start: 'browse',
      analysis,
      visualisations,
      notes: false,
      dashboard,
    })

  it('carries no layout at all when it was not asked for', () => {
    // Not an empty one: a graph without this feature must serialise exactly as it did before the
    // feature existed, which is `withDashboard`'s own rule.
    expect(built('partners', ['table'], false).dashboard).toBeUndefined()
  })

  it('places the control and the viewers, in that order, and says it is the view', () => {
    const graph = built('partners', ['table', 'bar'], true)
    expect(graph.dashboard?.cells.map((cell) => cell.nodeId)).toEqual([
      'explore',
      'view',
      'view2',
    ])
    // The flag `loadGraph` reads to land in the grid rather than on the canvas.
    expect(graph.dashboard?.open).toBe(true)
    // Everything between the control and the viewers is plumbing, and a grid of plumbing is a
    // canvas with worse ergonomics.
    const placed = new Set(graph.dashboard?.cells.map((c) => c.nodeId))
    expect(placed.has('conn')).toBe(false)
    expect(placed.has('sort')).toBe(false)
  })

  it('gives a single row the whole height, and falls back to halves past that', () => {
    const two = built('neurons', ['table'], true)
    expect(two.dashboard?.columns).toBe(2)
    expect(two.dashboard?.cells.map((c) => c.h)).toEqual([ROW_TRACKS, ROW_TRACKS])

    // Three cells is a 2 × 2 grid with a gap, so the heights go back to the default half.
    const three = built('partners', ['table', 'bar'], true)
    expect(three.dashboard?.cells.every((c) => c.h === undefined)).toBe(true)
  })

  it('is a layout the loader accepts, cells and all', () => {
    // The same gate a hand-edited file goes through — a generated layout has no more standing
    // than one somebody typed.
    const graph = built('morphology', ['viewer3d', 'neuroglancer'], true)
    const { graph: loaded, warnings } = deserializeGraph(serializeGraph(graph))
    expect(warnings).toEqual([])
    expect(loaded.dashboard).toEqual(graph.dashboard)
  })
})

describe('the notes it writes', () => {
  it('parses as markdown, and opens on a heading', () => {
    const notes = demoWorkflow('partners')
      .nodes.filter((n) => isAnnotation(n.type))
      .map((n) => String(n.params.text ?? ''))
    /*
     * One, and it used to be four. The three stage notes are hints docked to their cards now —
     * see the block below — and the overview is the only thing left that is *about the graph*
     * rather than about a card, which is what a note is for.
     */
    expect(notes).toHaveLength(1)

    for (const text of notes) {
      const blocks = parseMarkdown(text)
      expect(blocks.length).toBeGreaterThan(0)
      /*
       * The dedent trap: the parser recognises a heading or a bullet only at the *start* of a
       * line, so a note left at its source indentation degrades to paragraphs beginning with
       * three hashes. It renders, it looks wrong, and nothing else notices.
       */
      for (const block of blocks) {
        if (block.kind !== 'paragraph') continue
        const [first] = block.children
        expect(first?.kind === 'text' ? first.text.trimStart() : '').not.toMatch(/^[#*-] /)
      }
    }
    expect(parseMarkdown(notes[0]!)[0]?.kind).toBe('heading')
  })

  it('leaves the canvas clean when they are turned off', () => {
    const graph = demoWorkflow('partners', false)
    expect(graph.nodes.filter((n) => isAnnotation(n.type))).toEqual([])
    expect(graph.nodes.flatMap((n) => n.hints ?? [])).toEqual([])
    // And the pipeline is otherwise the same graph.
    expect(graph.nodes.map((n) => n.id)).toEqual([
      'ds',
      'find',
      'conn',
      'group',
      'sort',
      'view',
    ])
  })
})

/**
 * The hints, which is where the three stage notes went.
 *
 * What is worth pinning is the *anchoring*, because that is the whole of what the move bought and
 * none of it type-checks: a hint on the wrong card is prose pointing at a node it is not about,
 * which reads as a wizard bug and is a one-line arithmetic slip in `bodyOf`.
 */
describe('the hints it docks', () => {
  /*
   * Every graph the wizard can build, on every family, built **once** for the whole block.
   *
   * Every family rather than the synthetic one alone, for the reason the type-error test above
   * gives: the arms differ by what the source can do, and the anchor `bodyOf` hands back is the
   * first node of whatever was actually built. Hoisted because two of the cases below walk the
   * same set, and building each workflow twice is the wizard's whole option space run twice.
   */
  const graphs: CodaGraph[] = starterFamilies()
    .flatMap((family) => everyCombination(family.key))
    .map(buildWorkflow)

  /** Every hint in a graph, as `nodeId → texts`. */
  function docked(graph: CodaGraph): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const node of graph.nodes) {
      if (node.hints?.length) out[node.id] = node.hints.map((h) => h.text)
    }
    return out
  }

  it('puts one on the head, one on the analysis and one on the first viewer', () => {
    const graph = demoWorkflow('partners')
    expect(Object.keys(docked(graph))).toEqual(['find', 'conn', 'view'])
    expect(graph.nodes.find((n) => n.id === 'find')?.hints?.[0]?.tone).toBe('tip')
  })

  it('names a node that exists, on every combination the wizard can build', () => {
    for (const graph of graphs) {
      const ids = new Set(graph.nodes.map((n) => n.id))
      for (const id of Object.keys(docked(graph))) expect(ids.has(id)).toBe(true)
      /*
       * Never on a note or on the dataset card. The dataset is column 0 and no question is about
       * it; a note carrying a hint would be a box docked to a box.
       */
      for (const node of graph.nodes) {
        if (node.hints?.length) expect(isAnnotation(node.type)).toBe(false)
        if (node.hints?.length) expect(node.id).not.toBe('ds')
      }
    }
  })

  it('stacks both on one card where the analysis and the viewer are the same node', () => {
    /*
     * Morphology with only a Neuroglancer cell ticked builds no geometry queries at all, so the
     * viewer *is* the column-2 node. Two notes sharing a column used to be stacked by arithmetic
     * in `assemble`; two hints on one card stack because they are a list on that card.
     */
    const graph = buildWorkflow({
      dataset: DEMO_DATASET,
      start: 'search',
      analysis: 'morphology',
      visualisations: ['neuroglancer'],
      notes: true,
      dashboard: false,
    })
    const stacked = Object.values(docked(graph)).filter((texts) => texts.length > 1)
    expect(stacked).toHaveLength(1)
    expect(stacked[0]).toHaveLength(2)
  })

  it('parses as markdown and stays short enough for a card-width box', () => {
    const seen = new Set<string>()
    for (const graph of graphs) {
      for (const node of graph.nodes) {
        for (const hint of node.hints ?? []) {
          if (seen.has(hint.text)) continue
          seen.add(hint.text)
          expect(parseMarkdown(hint.text).length).toBeGreaterThan(0)
          /*
           * A ceiling rather than a style rule. The box is the card's width and sits over bare
           * canvas; past roughly this length it is a Text note that has been drawn in the wrong
           * place, which is exactly what these replaced. Measured against the longest that read
           * well in a browser, with room to spare.
           */
          expect(hint.text.length).toBeLessThanOrEqual(220)
        }
      }
    }
    // Every option's hint is reachable, so nothing above passed by never being built.
    expect(seen.size).toBeGreaterThan(12)
  })
})

describe('the demo workflows', () => {
  it('survives a save/load round trip unchanged', () => {
    const original = demoWorkflow('partners')
    const { graph, warnings } = deserializeGraph(serializeGraph(original))
    expect(warnings).toEqual([])
    expect(graph.nodes).toEqual(original.nodes)
    expect(
      graph.edges.map((e) => `${e.source}:${e.sourceHandle}→${e.target}:${e.targetHandle}`),
    ).toEqual(
      original.edges.map((e) => `${e.source}:${e.sourceHandle}→${e.target}:${e.targetHandle}`),
    )
  })

  /*
   * The one numeric assertion, kept from `examples.test.ts`: it is what says the chain computed
   * something rather than merely ran. The partners of an LC neuron are decided by the mock
   * generator's rules, so the *set* is guaranteed by the wiring where any particular ranking is
   * not.
   */
  it('aggregates outputs onto partner types, ranked by weight', async () => {
    const sched = scheduler()
    await sched.run(demoWorkflow('partners'), { mode: 'full' })

    const table = sched.output('view', 'out')
    if (!isTableValue(table)) throw new Error('expected a table')

    const weights = table.data.sum_weight as number[]
    expect(weights.length).toBeGreaterThan(2)
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]!).toBeLessThanOrEqual(weights[i - 1]!)
    }
    // `n` (rows per group) always travels with the aggregate.
    expect(table.schema.columns.map((c) => c.name)).toEqual(['postType', 'n', 'sum_weight'])
  })

  it('row-normalises the adjacency matrix to sum to 1 per row', async () => {
    const sched = scheduler()
    await sched.run(demoWorkflow('matrix'), { mode: 'full' })

    const matrix = sched.output('norm', 'out')
    if (!isMatrixValue(matrix)) throw new Error('expected a matrix')

    const cols = matrix.colLabels.length
    for (let r = 0; r < matrix.rowLabels.length; r++) {
      let total = 0
      for (let c = 0; c < cols; c++) total += matrix.values[r * cols + c] ?? 0
      // A row of all zeros stays zero; anything else must normalise to 1.
      expect(
        total === 0 || Math.abs(total - 1) < 1e-9,
        `row ${matrix.rowLabels[r]} = ${total}`,
      ).toBe(true)
    }
  })

  /*
   * A published dataset gets the Description card, and a wizard graph is the least defensible
   * place to drop the credit — the same rule `starters.ts` records.
   */
  it('opens a published dataset with its Description card', () => {
    const published = starterFamilies().find((f) => !f.synthetic)!
    const graph = buildWorkflow({
      dataset: published.key,
      start: 'search',
      analysis: 'neurons',
      visualisations: ['table'],
      notes: false,
      dashboard: false,
    })
    expect(graph.nodes.some((n) => n.type === 'dataset.description')).toBe(true)
  })

  /*
   * Auto-run is on by default, so a generated search with no filters and no limit would fire a
   * whole-connectome query at a shared production server the moment the graph lands. The
   * synthetic dataset is 401 neurons and wants the whole of it.
   */
  it('caps a morphology search on any dataset, geometry being the cost', () => {
    // On the *search*, not on the geometry nodes: a skeleton node's `Limit` is a warn-above
    // threshold rather than a cap, so setting it there fetched everything and warned about it.
    const graph = demoWorkflow('morphology', false)
    expect(graph.nodes.find((n) => n.id === 'find')?.params.limit).toBeGreaterThan(0)
    expect(graph.nodes.find((n) => n.id === 'skel')?.params.limit).toBe(
      // Whatever the node's own default is — the point is that the wizard does not touch it.
      requireNodeDef('neuron.skeletons').params?.find((p) => p.id === 'limit')?.default,
    )
  })

  it('limits a search against a published dataset, and not against the synthetic one', () => {
    const published = starterFamilies().find((f) => !f.synthetic)!
    const real = buildWorkflow({
      dataset: published.key,
      start: 'search',
      analysis: 'neurons',
      visualisations: ['table'],
      notes: false,
      dashboard: false,
    })
    expect(real.nodes.find((n) => n.id === 'find')?.params.limit).toBeGreaterThan(0)
    expect(demoWorkflow('neurons').nodes.find((n) => n.id === 'find')?.params.limit).toBe(0)
  })
})
