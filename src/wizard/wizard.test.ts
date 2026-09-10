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
import { findParam } from '../core/node'
import { getNodeDef, isAnnotation, requireNodeDef } from '../core/registry'
import { ROW_TRACKS } from '../core/dashboard'
import { Scheduler } from '../core/scheduler'
import { isMatrixValue, isTableValue } from '../core/values'
import { registerBuiltinSources } from '../data/builtins'
import { requireSource } from '../data/source'
import { DATASET_FAMILIES, datasetFamily, starterFamilies } from '../nodes/lib/datasetFamilies'
import { STACK_MAX_INPUTS, stackLabelParamId } from '../nodes/lib/stackParams'
import type { BuildOptions } from './build'
import { CROSS_SETS, GROWING_CROSS_SETS } from '../test/crossSets'
import { parseMarkdown } from '../ui/markdown'
import '../nodes'
import { DEMO_DATASET, buildWorkflow, demoWorkflow } from './build'
import type { AnalysisId, VisualisationId, WizardAnswers, WizardOption } from './options'
import {
  MULTI_DATASET,
  STACK_SOURCE_COLUMN,
  analysisOption,
  analysisOptions,
  everyCombination,
  familyBridges,
  glyphNodeOf,
  maxWizardDatasets,
  multiDatasetOptions,
  resolveVisualisations,
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
  return `${answers.datasets.join('+')} / ${answers.start} / ${answers.analysis} / ${answers.visualisations.join('+')}`
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
      for (const answers of everyCombination([family.key])) {
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
    const mock = visualisationOptions([DEMO_DATASET], 'neurons').map((o) => o.id)
    expect(mock).toContain('table')
    expect(mock).not.toContain('neuroglancer')

    // And a published one does offer it, or the gate is refusing everything.
    const published = starterFamilies().find((f) => !f.synthetic)
    expect(published, 'no published family to check the gate against').toBeTruthy()
    expect(
      visualisationOptions([published!.key], 'neurons').map((o) => o.id),
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
      const analyses = analysisOptions([key]).map((o) => o.id)
      expect(
        analyses,
        `${key}: skeletons are per dataset, and every CAVE family has them`,
      ).toEqual(expect.arrayContaining(['morphology', 'nblast']))
      expect(analyses, `${key}: CAVE aggregates no hop server-side`).not.toContain('paths')
    }
  })

  it('never offers a question with nothing in it', () => {
    /*
     * The third question is the one exception and it is the cross-dataset path's: two connectomes
     * that share no capability share no analysis, so `analysisOptions` can legitimately come back
     * empty there. That is a refusal the dialog makes on Continue rather than a question it
     * opens, which is why this rule is asked of the *viewers* on both paths and of the analyses
     * on the single one.
     */
    for (const datasets of [...starterFamilies().map((f) => [f.key]), ...CROSS_SETS]) {
      const label = datasets.join('+')
      expect(startOptions(datasets).length, label).toBeGreaterThan(0)
      if (datasets.length === 1)
        expect(analysisOptions(datasets).length, label).toBeGreaterThan(0)
      for (const analysis of analysisOptions(datasets)) {
        expect(
          visualisationOptions(datasets, analysis.id).length,
          `${label} / ${analysis.id}`,
        ).toBeGreaterThan(0)
      }
    }
  })
})

/**
 * What the fourth question arrives with ticked.
 *
 * The default is **everything the analysis offers**, and what is remembered is the reader's
 * *refusals* — so these assert the two things an allow-list would get wrong, plus the floor the
 * set has always had.
 */
describe('the viewers a question opens with', () => {
  const viewsFor = (analysis: AnalysisId) => visualisationOptions([DEMO_DATASET], analysis)

  it('ticks every viewer the analysis offers, for a reader who has said nothing', () => {
    for (const analysis of analysisOptions([DEMO_DATASET])) {
      const options = viewsFor(analysis.id)
      expect(resolveVisualisations(options, []), analysis.id).toEqual(
        options.map((option) => option.id),
      )
    }
  })

  it('drops the ones turned off and keeps the rest in offer order', () => {
    const options = viewsFor('partners')
    expect(options.map((o) => o.id)).toEqual(['table', 'bar', 'pie'])
    expect(resolveVisualisations(options, ['bar'])).toEqual(['table', 'pie'])
    // Order is the option list's, not the off-list's — a re-ticked viewer comes back where it
    // was rather than on the end, which is also where its card is placed.
    expect(resolveVisualisations(options, ['table'])).toEqual(['bar', 'pie'])
  })

  /*
   * The case an allow-list gets wrong, and the reason the stored half is the refusals. A reader
   * who ticks everything under one analysis has said nothing; a remembered `[table, bar, pie]`
   * would still narrow the matrix question to its table, because that is the one member the two
   * lists share. An empty off-list says the same nothing under every analysis.
   */
  it('carries a refusal between analyses and carries nothing else', () => {
    expect(resolveVisualisations(viewsFor('matrix'), [])).toEqual(['heatmap', 'table'])
    expect(resolveVisualisations(viewsFor('matrix'), ['pie', 'bar'])).toEqual([
      'heatmap',
      'table',
    ])
    expect(resolveVisualisations(viewsFor('matrix'), ['heatmap'])).toEqual(['table'])
  })

  /*
   * The floor, and the only way to reach it: the dialog refuses to untick the last box, so an
   * off-list cannot empty the question it was made in — but it accumulates across questions, and
   * two analyses each giving up one viewer can between them cover everything a third offers.
   */
  it('falls back to everything rather than to nothing', () => {
    const options = viewsFor('cluster')
    expect(options.map((o) => o.id)).toEqual(['dendrogram', 'heatmap'])
    expect(resolveVisualisations(options, ['dendrogram', 'heatmap'])).toEqual([
      'dendrogram',
      'heatmap',
    ])
  })

  it('builds a graph with no type errors when every viewer is ticked', () => {
    for (const analysis of analysisOptions([DEMO_DATASET])) {
      const answers: WizardAnswers = {
        datasets: [DEMO_DATASET],
        start: 'search',
        analysis: analysis.id,
        visualisations: resolveVisualisations(viewsFor(analysis.id), []),
        notes: true,
        dashboard: false,
      }
      expect(answers.visualisations.length).toBeGreaterThan(0)
      expect(errorsIn(answers), label(answers)).toEqual([])
    }
  })
})

/**
 * The picture on every answer's row.
 *
 * A glyph fails **silently and upwards**: a type that is not in the registry falls through
 * `glyphShapes` to the drawing for its category, which is a picture, so the row looks finished
 * and merely says the wrong thing. Two answers that name the same node fail the same way — the
 * icons are all there, and none of them tells the two apart. So both are asserted rather than
 * looked at, and the two halves of `glyphNodeOf` are pinned to what the builder actually does.
 */
describe('the glyph on an answer', () => {
  /** Every answer of every question, on every dataset the wizard offers. */
  function everyOption(): { question: string; option: WizardOption<string> }[] {
    const all: { question: string; option: WizardOption<string> }[] = []
    /*
     * Both paths, and the third question's two lists are **separate questions** for the purpose
     * of the rule below: they are disjoint sets shown on different screens, so `neuron.nblast`
     * naming both `nblast` and `xnblast` is one node answering one question on each path rather
     * than two answers drawn alike. The lists themselves are asserted disjoint elsewhere.
     */
    for (const datasets of [...starterFamilies().map((f) => [f.key]), ...CROSS_SETS]) {
      const question = datasets.length > 1 ? 'analysis/cross' : 'analysis'
      all.push(...startOptions(datasets).map((option) => ({ question: 'start', option })))
      for (const analysis of analysisOptions(datasets)) {
        all.push({ question, option: analysis })
        all.push(
          ...visualisationOptions(datasets, analysis.id).map((option) => ({
            question: `views/${analysis.id}`,
            option,
          })),
        )
      }
    }
    return all
  }

  it('names a node that exists, for every answer of every question', () => {
    const options = everyOption()
    for (const { question, option } of options) {
      const type = glyphNodeOf(option)
      expect(type, `${question} / ${option.id} draws nothing`).toBeTruthy()
      // `getNodeDef`, not `requireNodeDef`: the point is to name the offender, and a throw from
      // inside the loop names the assertion instead.
      expect(getNodeDef(type!), `${question} / ${option.id} → ${type}`).toBeTruthy()
    }
    expect(options.length).toBeGreaterThan(60)
  })

  /*
   * An icon that does not tell two answers apart is not an icon. Per *question* rather than
   * across the whole wizard: the viewer question is asked once per analysis, and a viewer meaning
   * the same node under two analyses is the property `VIEWS_BY_ID` is built on.
   */
  it('draws no two answers to one question alike', () => {
    const seen = new Map<string, Map<string, string>>()
    for (const { question, option } of everyOption()) {
      const drawn = seen.get(question) ?? new Map<string, string>()
      seen.set(question, drawn)
      const type = glyphNodeOf(option)!
      const first = drawn.get(type)
      expect(
        first ?? option.id,
        `${question}: ${first} and ${option.id} both draw ${type}`,
      ).toBe(option.id)
      drawn.set(type, option.id)
    }
  })

  /*
   * The second question's answers *are* cards, so this is exact: the glyph is the head that
   * answer builds. The one place in the wizard where a declared drawing can be checked against
   * the graph rather than merely against the registry.
   */
  it('names the head card the second question builds', () => {
    for (const option of startOptions([DEMO_DATASET])) {
      const graph = buildWorkflow({
        datasets: [DEMO_DATASET],
        start: option.id,
        analysis: 'neurons',
        visualisations: ['table'],
        notes: false,
        dashboard: false,
      })
      // Everything but the dataset node and the viewer the answer ends on.
      const head = graph.nodes.find(
        (node) => !node.type.startsWith('dataset.') && !node.type.startsWith('out.'),
      )
      expect(head?.type, option.id).toBe(glyphNodeOf(option))
    }
  })

  /*
   * The third question's answers are chains, so the claim is weaker and still worth pinning: the
   * card the label names is one of the cards the arm builds. Stated as "an analysis that builds
   * anything of its own", which is what excuses `neurons` — it builds no analysis node at all,
   * and draws as the table it hands on. A named exemption would have to be revisited by whoever
   * adds the tenth analysis; this rule answers for them.
   */
  it('names a card the third question builds, wherever it builds one', () => {
    for (const analysis of analysisOptions([DEMO_DATASET])) {
      const own = new Set<string>()
      for (const view of visualisationOptions([DEMO_DATASET], analysis.id)) {
        for (const node of buildWorkflow({
          datasets: [DEMO_DATASET],
          start: 'search',
          analysis: analysis.id,
          visualisations: [view.id],
          notes: false,
          dashboard: false,
        }).nodes) {
          // The head and the viewers belong to the other two questions; annotations to neither.
          if (
            node.id === 'ds' ||
            node.id === 'find' ||
            node.id.startsWith('view') ||
            isAnnotation(node.type)
          ) {
            continue
          }
          own.add(node.type)
        }
      }
      if (!own.size) continue
      expect([...own], analysis.id).toContain(glyphNodeOf(analysis))
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
const RUNNABLE = everyCombination([DEMO_DATASET]).filter(
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
      datasets: [DEMO_DATASET],
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
      datasets: [DEMO_DATASET],
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
    expect(visualisationOptions([DEMO_DATASET], 'morphology').map((o) => o.id)).toContain(
      'topology',
    )
    expect(visualisationOptions([DEMO_DATASET], 'neurons').map((o) => o.id)).toContain(
      'topology',
    )
    // Not off a chain that has turned neurons into something else.
    expect(visualisationOptions([DEMO_DATASET], 'partners').map((o) => o.id)).not.toContain(
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
      datasets: [DEMO_DATASET],
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
    .flatMap((family) => everyCombination([family.key]))
    .map((answers) => buildWorkflow(answers))

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
      datasets: [DEMO_DATASET],
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

describe('a dataset that needs an annotation chain', () => {
  /*
   * `DatasetFamily.annotationChain`. A CAVE datastack keeps its cell typing in a table rather
   * than on the neuron, so a wizard workflow that opened on the bare dataset node opened on a
   * list of eighteen-digit root ids — while `New ▸ FlyWire FAFB` and `New ▸ BANC public`, both
   * building the *same* declarations through `examples/starters.ts`, opened them typed. One graph
   * answering one question two ways depending on which menu you came through.
   *
   * **Asked of every family that declares one**, rather than of FlyWire: the two differ in size
   * by a factor of six — six cards in two arms against one — and the rules below are about the
   * mechanism, so a third family gets them free and a rule that only holds for the big one fails
   * here rather than in a browser.
   */
  const chained = DATASET_FAMILIES.filter((family) => family.annotationChain)

  /** One workflow, varying only the dataset and the build options the demo path passes. */
  const build = (dataset: string, options?: BuildOptions) =>
    buildWorkflow(
      {
        datasets: [dataset],
        start: 'browse',
        analysis: 'partners',
        visualisations: ['table'],
        notes: true,
      } as never,
      options,
    )

  it('covers more than one family, or these rules are one dataset’s', () => {
    expect(chained.map((family) => family.key).sort()).toEqual(['banc', 'flywire'])
  })

  it.each(chained)('builds $key’s chain and wires it into the annotations port', (family) => {
    const chain = family.annotationChain!
    const graph = build(family.key)
    const byId = new Map(graph.nodes.map((n) => [n.id, n.type]))
    for (const entry of chain.nodes) {
      expect(byId.get(entry.id), `${entry.id} is on the canvas`).toBe(entry.type)
    }
    const ds = graph.nodes.find((n) => n.type === `dataset.${family.key}`)!
    const wired = graph.edges.find(
      (e) => e.target === ds.id && e.targetHandle === 'annotations',
    )
    expect(byId.get(wired?.source ?? '')).toBe(
      chain.nodes.find((n) => n.id === chain.output.id)?.type,
    )
  })

  it.each(chained)(
    'takes $key’s dataset as a reference on every member that needs it',
    (family) => {
      // Reference edges, or each pair would be a cycle. See `PortDef.reference`.
      const graph = build(family.key)
      const ds = graph.nodes.find((n) => n.type === `dataset.${family.key}`)!
      for (const id of family.annotationChain!.datasetRefs) {
        expect(
          graph.edges.some(
            (e) => e.source === ds.id && e.target === id && e.targetHandle === 'dataset',
          ),
          `${id} reads the datastack`,
        ).toBe(true)
      }
    },
  )

  it.each(chained)(
    'arrives on $key with nothing to complain about but a late schema',
    (family) => {
      /*
       * FlyWire's one warning is `Column "join_tag" is gone` — `NodeIssue.aboutColumns`, since the
       * fold's output schema is not known until a run, which is the "unknown, never none" case the
       * column rules are built around. The **starter carries the identical warning**, which is what
       * says this is the chain's ordinary state rather than something the wizard does differently.
       * Anything else would be a badge on a workflow the reader did not build.
       */
      const issues = Object.values(inferGraph(build(family.key)).nodes).flatMap((n) => n.issues)
      expect(issues.filter((issue) => !issue.aboutColumns)).toEqual([])
    },
  )

  it.each(chained)('leaves $key’s chain off a demo build', (family) => {
    /*
     * `BuildOptions.annotationChain`. More cards are more ports for the demo search to find a
     * clean fit on, so the best-typed candidate for `core.filterTable` became a FlyWire workflow
     * — and opening that link downloads a 139k-row file, reads a CAVE table of about a million
     * rows and asks for a token, to demonstrate filtering a table.
     */
    const bare = build(family.key, { annotationChain: false })
    expect(bare.groups ?? []).toHaveLength(0)
    expect(bare.edges.some((e) => e.targetHandle === 'annotations')).toBe(false)
    expect(bare.nodes.length).toBeLessThan(build(family.key).nodes.length)
  })

  it('folds a chain of several cards and leaves a single card alone', () => {
    /*
     * `foldChain`'s rule. Six cards of plumbing are the biggest thing on the canvas and none of
     * them is what the reader asked for; one card in a frame hides nothing and costs a click to
     * open, replacing a card whose title says what it does with a box that says roughly the same.
     */
    const flywire = datasetFamily('flywire')!.annotationChain!
    expect(flywire.nodes.length).toBeGreaterThan(1)
    const group = build('flywire').groups?.find((g) => g.title === flywire.title)
    expect(group?.collapsed).toBe(true)
    expect([...(group?.nodeIds ?? [])].sort()).toEqual(flywire.nodes.map((n) => n.id).sort())

    expect(datasetFamily('banc')!.annotationChain!.nodes).toHaveLength(1)
    expect(build('banc').groups ?? []).toHaveLength(0)
  })

  it('points Explore at the column the fold produces, where there is one', () => {
    /*
     * Otherwise the wizard builds the fold and the Join and then draws no tag row — half
     * FlyWire's second arm doing nothing visible. It follows the chain that was *built*, not the
     * family's, so a demo build does not name a column nothing produces. BANC declares no
     * `tagColumn`, and its Explore is left at the default.
     */
    const chain = datasetFamily('flywire')!.annotationChain!
    const explore = (graph: CodaGraph) => graph.nodes.find((n) => n.type === 'neuron.explore')
    expect(explore(build('flywire'))?.params.tagColumn).toBe(chain.tagColumn)
    expect(explore(build('flywire', { annotationChain: false }))?.params.tagColumn).toBe('')
    expect(explore(build('banc'))?.params.tagColumn).toBe('')
    // No chain, but a source publishing its tags as a column of their own: the starter's answer,
    // which `New ▸ CATMAID` gave and the wizard did not.
    expect(explore(build('catmaid.fafb'))?.params.tagColumn).toBe('annotations')
    expect(explore(build('catmaid.l1'))?.params.tagColumn).toBe('annotations')
  })

  it('leaves every family without one exactly as it was', () => {
    const graph = build('malecns')
    expect(graph.groups ?? []).toHaveLength(0)
    expect(graph.edges.some((e) => e.targetHandle === 'annotations')).toBe(false)
  })
})

/**
 * The cross-dataset path: the first question's fifth kind of answer, and the four arms behind it.
 *
 * The same standing the rest of this file has, asked of a shape the rest of it cannot reach —
 * every one of these arms puts two to four dataset nodes, two to four heads and a variadic node
 * in one graph, and three of the failures that shape can have are silent. A chain's node ids are
 * local to the chain, so two datasets carrying one mint two nodes with the same id and
 * `assembleGraph` cannot notice. `Stack Neurons` throws on a source column that already exists,
 * which is a run-time error a build cannot see. And an analysis one dataset cannot serve is a
 * card refusing in the middle of a chain, two screens after the question that offered it.
 */
describe('the cross-dataset path', () => {
  const answersFor = (
    datasets: string[],
    analysis: AnalysisId,
    visualisations: VisualisationId[],
  ): WizardAnswers => ({
    datasets,
    start: 'search',
    analysis,
    visualisations,
    notes: false,
    dashboard: false,
  })

  it('builds a graph with no type errors, for every reachable combination', () => {
    let checked = 0
    for (const datasets of CROSS_SETS) {
      for (const answers of everyCombination(datasets)) {
        expect(errorsIn(answers), label(answers)).toEqual([])
        checked++
      }
    }
    // The guard the single-dataset rule carries, for the same reason: a gate that started
    // answering `false` everywhere would make this pass by checking nothing.
    expect(checked).toBeGreaterThan(40)
  })

  /*
   * The two lists are disjoint, which is what makes one `AnalysisId` union safe: `bodyOf` has one
   * arm per id and the note above the chain looks one up without knowing which path built it, so
   * an id on both lists would be an arm that means two different things.
   */
  it('offers a disjoint set of analyses from the single-dataset path', () => {
    const single = new Set(analysisOptions(['hemibrain']).map((o) => o.id))
    const cross = analysisOptions(['hemibrain', 'malecns']).map((o) => o.id)
    expect(cross.length).toBeGreaterThan(0)
    expect(cross.filter((id) => single.has(id))).toEqual([])
    // And every cross answer is reachable, or one of the four arms is dead code.
    expect(cross.sort()).toEqual(['coclust', 'compare', 'xmorphology', 'xnblast'])
  })

  /*
   * The intersection, not the union — an analysis one of the chosen datasets cannot serve builds
   * a chain with a refusing card in it. The synthetic dataset is the case that shows it: it has
   * skeletons but no registration into the shared template space, so the two geometry arms have
   * nothing to fit and drop out while the two connectivity ones stay.
   */
  it('narrows an analysis against every chosen dataset, not just the first', () => {
    expect(
      familyBridges('mock.opticlobe'),
      'the synthetic dataset gained a template space',
    ).toBe(false)
    expect(familyBridges('hemibrain')).toBe(true)

    const both = analysisOptions(['mock.opticlobe', 'hemibrain']).map((o) => o.id)
    expect(both).toContain('compare')
    expect(both).not.toContain('xmorphology')
    expect(both).not.toContain('xnblast')

    // And the same pair without the synthetic side does offer them, or the gate refuses
    // everything and this test would pass on a broken build.
    expect(analysisOptions(['hemibrain', 'malecns']).map((o) => o.id)).toContain('xnblast')
  })

  it('offers only the families that can answer something across datasets', () => {
    const offered = multiDatasetOptions().map((family) => family.key)
    expect(offered.length).toBeGreaterThan(1)
    for (const key of offered) {
      expect(analysisOptions([key, key]).length, `${key} can answer nothing`).toBeGreaterThan(0)
    }
  })

  /*
   * The other direction, and the one that fails silently: the datasets question is gated on what
   * `CROSS_ANALYSES` declares, so an analysis whose gate no family on that question can satisfy is
   * simply unreachable — no error, no empty screen, just an answer nobody is ever offered. The
   * gate being asked through `available` rather than restated is what makes this checkable at all.
   */
  it('leaves every cross-dataset analysis reachable from some pair it offers', () => {
    const offered = multiDatasetOptions().map((family) => family.key)
    const reachable = new Set<AnalysisId>()
    for (const a of offered) {
      for (const b of offered) {
        if (a === b) continue
        for (const option of analysisOptions([a, b])) reachable.add(option.id)
      }
    }
    expect([...reachable].sort()).toEqual(['coclust', 'compare', 'xmorphology', 'xnblast'])
  })

  /*
   * The ceiling is the arity the nodes declare, read off them rather than restated — a wizard
   * offering a fifth dataset would build a `Match Cell Types` with a port it does not have.
   */
  it('caps the dataset count at what the nodes accept', () => {
    const max = maxWizardDatasets()
    for (const type of ['compare.matchTypes', 'compare.connectivity']) {
      const param = findParam(requireNodeDef(type), 'datasetCount')
      expect(param && 'max' in param ? param.max : undefined, type).toBe(max)
    }
    expect(
      CROSS_SETS.some((set) => set.length === max),
      'nothing exercises the ceiling',
    ).toBe(true)
  })

  /*
   * Every id minted once. The failure this catches is entirely silent: `assembleGraph` keys nodes
   * by id, so a chain contributing a second `join` replaces the first and both sets of wires end
   * up on whichever survived — a graph that looks smaller than it should and is wired wrong.
   */
  it.each(CROSS_SETS.map((datasets) => [datasets.join(' + '), datasets] as const))(
    'mints every node id once across %s',
    (_label, datasets) => {
      for (const answers of everyCombination(datasets)) {
        const ids = buildWorkflow(answers).nodes.map((node) => node.id)
        expect(new Set(ids).size, `${label(answers)}: ${ids.join(' ')}`).toBe(ids.length)
      }
    },
  )

  it('prefixes the second dataset’s annotation chain and leaves the first’s alone', () => {
    const graph = buildWorkflow(answersFor(['flywire', 'banc'], 'compare', ['table']))
    const typeAt = (id: string) => graph.nodes.find((node) => node.id === id)?.type
    // FlyWire is first, so its cards keep the bare ids a single-dataset workflow has always had.
    for (const node of datasetFamily('flywire')!.annotationChain!.nodes) {
      expect(typeAt(node.id), `flywire's ${node.id}`).toBe(node.type)
    }
    /*
     * BANC is second, so its card is prefixed with the dataset node it feeds — and these two
     * chains are exactly the collision the prefix exists for: both declare a node called
     * `annotations`, of two different types. Asserting the *type* at each id is what says which
     * chain won, where asserting the id's mere presence cannot.
     */
    for (const node of datasetFamily('banc')!.annotationChain!.nodes) {
      expect(typeAt(`ds2-${node.id}`), `banc's ${node.id}`).toBe(node.type)
    }
    expect(typeAt('annotations'), 'the bare id belongs to the first chain').toBe(
      'core.tableFromUrl',
    )
    // Each chain still reaches its own dataset's Annotations port, and no other.
    const annotations = graph.edges.filter((edge) => edge.targetHandle === 'annotations')
    expect(annotations.map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual([
      'ds2-annotations->ds2',
      'join->ds',
    ])
    // One folded frame: `foldChain` leaves BANC's single card alone rather than boxing it.
    expect((graph.groups ?? []).map((group) => group.title)).toEqual(['FlyWire annotations'])
  })

  /*
   * Decision 4 in `docs/comparative.md`, asserted where a wizard could quietly get it wrong: the
   * mapper reads each dataset's *whole* annotation table, so it takes the Dataset nodes and not
   * the neuron tables the heads produce. Wired to a selection it would give a different answer
   * for the same two neurons depending on what else the graph happened to query.
   */
  it('wires the mapper to the dataset nodes and pre-fills each one’s type columns', () => {
    const datasets = ['hemibrain', 'malecns']
    for (const analysis of ['compare', 'coclust'] as const) {
      const graph = buildWorkflow(answersFor(datasets, analysis, ['table', 'dendrogram']))
      const match = graph.nodes.find((node) => node.type === 'compare.matchTypes')
      expect(match, analysis).toBeTruthy()
      expect(match!.params.datasetCount).toBe(datasets.length)

      const wires = graph.edges
        .filter((edge) => edge.target === match!.id)
        .map((edge) => `${edge.source}.${edge.sourceHandle}->${edge.targetHandle}`)
        .sort()
      expect(wires, analysis).toEqual(['ds.dataset->dataset1', 'ds2.dataset->dataset2'])

      datasets.forEach((key, index) => {
        expect(match!.params[`types${index + 1}`], `${analysis} / ${key}`).toEqual(
          datasetFamily(key)!.typeColumns,
        )
      })
    }
  })

  /*
   * The mapper's own `validate` refuses an empty type-column picker by name, so a family that
   * declares columns must produce a card with none of those issues on it. This is the assertion
   * that `DatasetFamily.typeColumns` is doing its job rather than being a field nobody reads.
   */
  it('leaves the mapper with nothing to complain about, where the families declare columns', () => {
    const graph = buildWorkflow(answersFor(['hemibrain', 'malecns'], 'compare', ['table']))
    const issues = inferGraph(graph).nodes.match?.issues ?? []
    expect(issues.filter((issue) => /pick at least one column/i.test(issue.message))).toEqual(
      [],
    )
  })

  it('qualifies each dataset’s ids with its own family key before the tables meet', () => {
    const datasets = ['hemibrain', 'malecns']
    const graph = buildWorkflow(answersFor(datasets, 'coclust', ['dendrogram']))
    const qualifiers = graph.nodes.filter((node) => node.type === 'core.qualifyIds')
    expect(qualifiers.map((node) => node.params.prefix)).toEqual(datasets)
    // The feature axis is the shared label space, which is the other half of the same decision.
    const labels = graph.edges.filter((edge) => edge.targetHandle === 'labels')
    expect(labels.length).toBe(datasets.length)
    for (const edge of labels) expect(edge.source).toBe('match')
  })

  /*
   * Both stack nodes take exactly two inputs, so N datasets are N−1 cards. The rule that is not
   * obvious is the source column: `stackTables` **throws** where the column it is adding already
   * exists in either input, so a chain naming them all alike builds a graph that refuses on Run —
   * a failure no amount of inference can see.
   */
  it('never asks a stack for more inputs than it has sockets', () => {
    /*
     * Both ceilings are derived — `maxWizardDatasets()` off the two comparison nodes, the stack's
     * off its own param — and nothing else makes them agree. Raise a comparison node past the
     * stack and `buildWorkflow` emits an `inputCount` that `countIn` clamps, so the last datasets
     * a reader ticked reach no socket and the graph stacks the wrong set with nothing on screen
     * to say so.
     */
    expect(maxWizardDatasets()).toBeLessThanOrEqual(STACK_MAX_INPUTS)
  })

  it('folds every dataset onto one stack, with one source column', () => {
    /*
     * One card at every arity, which is what the `Inputs` spinner bought. The chain it replaced
     * needed a *distinct* column per level — a stack refuses to add one an input already has —
     * so only the outermost partitioned the whole collection and the scene had to be pointed at
     * whichever that was. Here there is one column and it names every dataset.
     */
    for (const datasets of GROWING_CROSS_SETS) {
      const graph = buildWorkflow(answersFor([...datasets], 'xmorphology', ['viewer3d']))
      const stacks = graph.nodes.filter((node) => node.type === 'neuron.stack')
      expect(stacks.length, datasets.join('+')).toBe(1)

      const stack = stacks[0]!
      expect(stack.params.inputCount, datasets.join('+')).toBe(datasets.length)
      expect(stack.params.sourceColumn).toBe(STACK_SOURCE_COLUMN)

      // A label per dataset, all of them distinct — the whole point of the column.
      const labels = datasets.map((_key, i) => stack.params[stackLabelParamId(i + 1)])
      expect(new Set(labels).size, `${datasets.join('+')}: ${labels.join(', ')}`).toBe(
        datasets.length,
      )

      // Every dataset's transform reaches its own socket, so nothing is dropped by a wire that
      // silently replaced another — input ports take one edge each.
      const wired = graph.edges.filter((edge) => edge.target === stack.id)
      expect(new Set(wired.map((edge) => edge.targetHandle)).size).toBe(datasets.length)

      const view = graph.nodes.find((node) => node.id === 'view')!
      expect(view.params.skeletonColorBy, datasets.join('+')).toBe(STACK_SOURCE_COLUMN)
    }
  })

  it('leaves the table stack unlabelled, the dataset being in the qualified id', () => {
    const graph = buildWorkflow(answersFor(['hemibrain', 'malecns'], 'coclust', ['dendrogram']))
    for (const node of graph.nodes.filter((n) => n.type === 'core.stack')) {
      expect(node.params.sourceColumn).toBe('')
    }
  })

  it('caps every dataset’s search on the two geometry arms', () => {
    for (const analysis of ['xmorphology', 'xnblast'] as const) {
      const views: VisualisationId[] = analysis === 'xnblast' ? ['dendrogram'] : ['viewer3d']
      const graph = buildWorkflow(answersFor(['hemibrain', 'malecns'], analysis, views))
      const searches = graph.nodes.filter((node) => node.type === 'neuron.findNeurons')
      expect(searches.length, analysis).toBe(2)
      for (const node of searches) expect(node.params.limit, analysis).toBe(30)
    }
  })

  /*
   * One hint per stage, not one per dataset: four identical boxes down the left of a canvas is
   * the failure the stage notes had, and a stage growing a second card does not make it a
   * different stage.
   */
  it('docks the start hint on the first head only', () => {
    const graph = buildWorkflow({
      ...answersFor(['hemibrain', 'malecns'], 'compare', ['table']),
      notes: true,
    })
    const heads = graph.nodes.filter((node) => node.type === 'neuron.findNeurons')
    expect(heads.map((node) => node.hints?.length ?? 0)).toEqual([1, 0])
  })

  it('names every dataset in the graph’s own name and description', () => {
    const graph = buildWorkflow(answersFor(['hemibrain', 'malecns'], 'compare', ['table']))
    for (const named of ['Hemibrain', 'MaleCNS']) {
      expect(graph.meta?.name, 'name').toContain(named)
      expect(graph.meta?.description, 'description').toContain(named)
    }
  })

  /*
   * The first question's extra row is an answer like any other, so it carries its own copy and
   * draws a registered node — the two rules `options.ts` states for every option there is.
   */
  it('gives the first question’s extra row copy and a drawing of its own', () => {
    expect(MULTI_DATASET.label.trim()).toBeTruthy()
    expect(MULTI_DATASET.blurb.trim()).toBeTruthy()
    expect(getNodeDef(glyphNodeOf(MULTI_DATASET)!), MULTI_DATASET.glyph).toBeTruthy()
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
      datasets: [published.key],
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
      datasets: [published.key],
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
