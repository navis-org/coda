/**
 * What the Workflow Wizard asks, and which answers are available.
 *
 * Four questions — dataset, how to choose neurons, what to work out, how to look at it — and the
 * whole option space is this file. `build.ts` turns one set of answers into a graph; nothing
 * there decides what may be asked, and nothing here builds anything.
 *
 * ## Why the options are gated rather than merely offered
 *
 * A wizard that offers every combination and produces a broken graph for some of them is worse
 * than no wizard: the reader has no way to tell a bad answer from a bad tool. So each question
 * narrows against what came before. Browsing needs a source that publishes a whole neuron table
 * (`neuronIndex`); 3D morphology needs skeletons; a Neuroglancer cell needs a published scene,
 * which the synthetic source has no bucket for. Those are `SourceCapabilities` questions, asked
 * through `capabilityOf` so a per-dataset override is picked up the day one exists.
 *
 * The visualisations narrow on the *analysis* instead, and for a harder reason: a heatmap wants a
 * matrix, a network diagram wants a network, and a table wants a table. Which viewer can end a
 * chain is a fact about what the chain produces, so `visualisationOptions` takes the analysis and
 * `build.ts` reads the same pairing back. The two halves must agree, and `wizard.test.ts` walks
 * every reachable combination through `inferGraph` to make sure they do — the same standing the
 * bundled examples used to have, which is what this replaces.
 *
 * ## The copy is here, not in the dialog
 *
 * Every option carries a `label`, a `blurb` for the dialog, and a `note` — the sentence that
 * lands on the canvas when notes are on. Three surfaces would otherwise write their own words for
 * the same thing, which is the drift `TOURS` was introduced to stop.
 */

import type { SourceCapabilities } from '../data/source'
import { capabilityOf, getSource } from '../data/source'
import type { DatasetFamily } from '../nodes/lib/datasetFamilies'
import { datasetFamily, starterFamilies } from '../nodes/lib/datasetFamilies'

/**
 * What the wizard is called, and the one line that says what it does.
 *
 * Four surfaces name it — the dialog's own header, the New menu, the start page's rail and the
 * command palette — and each of them wrote its own words for a while, which is the drift `TOURS`
 * was introduced to stop and which had already produced three different blurbs. The trailing `…`
 * is a menu convention (this row opens a dialog) rather than part of the name, so the one surface
 * that wants it adds it.
 */
export const WIZARD_LABEL = 'Workflow Wizard'
export const WIZARD_BLURB = 'Basic workflows tailored to your question.'

/** How the neurons the workflow is about get chosen. */
export type StartId = 'search' | 'browse' | 'ids'

/** What the workflow works out about them. */
export type AnalysisId =
  | 'partners'
  | 'matrix'
  | 'paths'
  | 'network'
  | 'cluster'
  | 'morphology'
  | 'nblast'
  | 'neurons'

/** How the answer is drawn. */
export type VisualisationId =
  | 'table'
  | 'dendrogram'
  | 'bar'
  | 'pie'
  | 'heatmap'
  | 'network'
  | 'metrics'
  | 'viewer3d'
  | 'neuroglancer'

/**
 * One complete set of answers — everything `buildWorkflow` needs.
 *
 * `notes` is the only one that is not a question: it is a checkbox on the summary and a
 * remembered preference, because it is a statement about how somebody likes their canvas rather
 * than about the workflow they are building.
 */
export interface WizardAnswers {
  /** Dataset family key, e.g. `mock.opticlobe`. `dataset.<key>` is the node type. */
  dataset: string
  start: StartId
  analysis: AnalysisId
  /**
   * How the answer is drawn — **one or more**, because a reader who wants a table and a chart of
   * the same thing wants two viewers off one chain rather than two workflows. Empty is not a
   * legal answer; the dialog keeps at least one ticked.
   */
  visualisations: VisualisationId[]
  notes: boolean
  /**
   * Open the workflow on the **dashboard** rather than the canvas.
   *
   * Like `notes`, not a question: a checkbox on the summary and a remembered preference, because
   * it says how this reader likes to be handed a workflow rather than anything about the workflow
   * itself. It writes a `DashboardLayout` into the document — see `dashboardFor` — so the answer
   * survives a save and a share link, which is the whole difference between this and a view the
   * app happened to be in.
   */
  dashboard: boolean
}

export interface WizardOption<Id extends string> {
  id: Id
  label: string
  /** One line, shown under the label in the dialog. */
  blurb: string
  /** The sentence that goes on the canvas beside what this answer built. */
  note: string
  /**
   * The source capability this answer needs, if any.
   *
   * Declared on the option rather than tested at each question, which is where it started: three
   * `option.id !== '<literal>' || can(dataset, '<literal>')` filters, one per question, each
   * pairing an id with a capability somewhere other than where the option is written. A gated
   * option added without its filter is offered and then builds a graph nobody can fetch.
   */
  requires?: keyof SourceCapabilities
}

/** The options of a question this dataset's source can actually answer. */
function available<Id extends string>(
  dataset: string,
  options: readonly WizardOption<Id>[],
): WizardOption<Id>[] {
  return options.filter((option) => !option.requires || can(dataset, option.requires))
}

// ---------------------------------------------------------------------------
// 1 · Which dataset
// ---------------------------------------------------------------------------

/**
 * The families worth starting from, synthetic ones first.
 *
 * `starterFamilies` rather than a list of our own — the New menu and the start page's dataset
 * rail read the same function, and a wizard offering a different set would be a fourth answer to
 * "which datasets can you start from". The order is the one departure: the synthetic dataset goes
 * first because it is the only one that runs with no account, which is the thing a first-time
 * reader most needs to know and the reason it was written.
 */
export function datasetOptions(): DatasetFamily[] {
  const families = starterFamilies()
  return [...families.filter((f) => f.synthetic), ...families.filter((f) => !f.synthetic)]
}

function familyOf(key: string): DatasetFamily | undefined {
  return datasetFamily(key)
}

/** Whether the source behind a family can do something. Unknown family reads as "yes". */
function can(key: string, capability: keyof SourceCapabilities): boolean {
  const family = familyOf(key)
  if (!family) return true
  /*
   * No dataset id, because a wizard answer is a *family* — which dataset that resolves to is not
   * known until the node runs. `capabilityOf` with `undefined` gives the source-level answer,
   * which is the honest one here and the same call `genericStarter` makes.
   */
  return capabilityOf(getSource(family.sourceId), undefined, capability)
}

// ---------------------------------------------------------------------------
// 2 · Which neurons
// ---------------------------------------------------------------------------

const STARTS: WizardOption<StartId>[] = [
  {
    id: 'browse',
    // Needs a source whose whole neuron table can be fetched and searched locally.
    requires: 'neuronIndex',
    label: 'Interactive Search with Thumbnails',
    blurb: 'Uses the `Explore Dataset` node: free-form search the full neuron table in the browser, tick the ones you want.',
    note: 'Type in the search box, tick a few neurons, then Run. Everything downstream reads the ticked set, so the graph follows what you pick — and until you tick something, a query card further along will say it has no neurons. That is the graph waiting for you rather than a mistake.',
  },
  {
    id: 'search',
    label: 'Structured Search',
    blurb: 'Uses the `Find Neurons` node: filter by type, status or region. Best when you already know what to ask for.',
    note: 'Set a filter here — type matching `LC.*`, say — then Run. The pattern is a regex, anchored the way the backend anchors it.',
  },
  {
    id: 'ids',
    label: 'Paste IDs',
    blurb: 'Copy a list of body or root ids you already have into Coda.',
    note: 'Paste body ids here, one per line, then Run. Ids are text, never numbers — an 18-digit root id does not survive being parsed as one. Until you paste some, a query card further along will say it has no neurons; that is the graph waiting for you rather than a mistake.',
  },
]

export function startOptions(dataset: string): WizardOption<StartId>[] {
  return available(dataset, STARTS)
}

// ---------------------------------------------------------------------------
// 3 · What to work out
// ---------------------------------------------------------------------------

/**
 * The third question's answers, **named as techniques rather than described as questions**.
 *
 * They were written as plain-language questions — "What the wiring looks like", "Which of them
 * are wired alike" — on the theory that a newcomer meets the tool before the vocabulary. The
 * theory was wrong about who is reading: somebody who has opened a connectome analysis tool knows
 * what an adjacency matrix and an NBLAST are, and a paragraph standing where the term should be
 * is one more thing to decode rather than a way in. So the label is the term and the blurb is the
 * chain it builds, which is the other thing that reader wants to know before choosing.
 *
 * The notes on the canvas are unchanged: those are read *after* the choice, beside the nodes they
 * are about, which is where the prose belongs.
 */
const ANALYSES: WizardOption<AnalysisId>[] = [
  {
    id: 'partners',
    label: 'Connectivity partners',
    blurb: 'Connectivity → Group By → Sort: synapses summed per partner type, ranked.',
    note: 'Connectivity → group → sort: the chain most connectivity questions are built from. `Min weight` drops the weak pairs at the server rather than after the download.',
  },
  {
    id: 'matrix',
    label: 'Adjacency matrix',
    blurb: 'The set against itself on both axes, row-normalised.',
    note: 'Adjacency between the same set on both axes. Row-normalising makes each row sum to 1, so rows with very different totals can still be compared.',
  },
  {
    id: 'paths',
    requires: 'paths',
    label: 'Shortest paths',
    blurb: 'Paths from one neuron set to another, a few hops deep. Two searches.',
    note: 'Two searches, because a path has two ends — the second card is where the *targets* go. `Max hops` and `Min weight` are what keep the traversal from opening out into the whole connectome.',
  },
  {
    id: 'network',
    label: 'Network graph + stats',
    blurb: 'Type-level edges as a node-link diagram, or the graph metrics over it.',
    note: 'Grouping by both ends turns neuron-to-neuron rows into a type-level edge list, which is what a network is built from.',
  },
  {
    id: 'cluster',
    label: 'Connectivity similarity',
    blurb: 'Partner Vectors → Similarity Matrix → Linkage, over the shared partners.',
    note: 'Partner Vectors turns the edge list into one vector per neuron — there is deliberately no Pivot in this chain, which is what keeps it from being a hundred million cells. Add a `Cut Tree` after the linkage to turn the dendrogram into cluster labels.',
  },
  {
    id: 'morphology',
    requires: 'skeletons',
    label: 'Morphology in 3D',
    blurb: 'Skeletons and synapse locations, drawn in one scene.',
    note: 'Two queries off one search: the arbours and the synapse points, drawn in the same scene.',
  },
  {
    id: 'nblast',
    requires: 'skeletons',
    label: 'NBLAST clustering',
    blurb: 'All-by-all NBLAST over their skeletons → Linkage.',
    note: 'NBLAST is all-by-all, so the work grows with the *square* of the set — the search above is capped for that reason, and raising it is the one edit here worth thinking about before you press Run. Add a `Cut Tree` after the linkage to turn the dendrogram into cluster labels.',
  },
  {
    id: 'neurons',
    label: 'Neuron table only',
    blurb: 'No analysis yet — the neuron table, and somewhere to build from.',
    note: 'No analysis yet. Add nodes to the right of this one — press Tab for the node browser.',
  },
]

export function analysisOptions(dataset: string): WizardOption<AnalysisId>[] {
  return available(dataset, ANALYSES)
}

// ---------------------------------------------------------------------------
// 4 · How to look at it
// ---------------------------------------------------------------------------

const VISUALISATIONS: WizardOption<VisualisationId>[] = [
  {
    id: 'table',
    label: 'A table',
    blurb: 'Rows and columns, sortable and filterable in place.',
    note: 'A viewer passes its input straight through, so it can sit in the middle of a chain rather than only ending one.',
  },
  {
    id: 'bar',
    label: 'A bar chart',
    blurb: 'One bar per partner type, tallest first.',
    note: 'The bars read the grouped table: one category column, one value column.',
  },
  {
    id: 'pie',
    label: 'A pie chart',
    blurb: 'Shares of the total, with the tail folded into one slice.',
    note: 'Everything past the eighth slice folds into “Other” — a pie with forty slices is a colour key, not a chart.',
  },
  {
    id: 'dendrogram',
    label: 'A dendrogram',
    blurb: 'The clustering as a tree, with every neuron on a leaf.',
    note: 'Click a branch to select what is under it — the selection is an output, so it can feed the rest of the graph.',
  },
  {
    id: 'heatmap',
    label: 'A heatmap',
    blurb: 'The matrix drawn as cells, one colour ramp.',
    note: 'Sequential colour, because these values have a zero and only go up. Turn values on to read the numbers off the cells.',
  },
  {
    id: 'network',
    label: 'A network diagram',
    blurb: 'Nodes and links, laid out feed-forward.',
    note: 'Node colour is the type, size is total outgoing weight, link width is the synapse count. Drag a node to move it; right-click for the neighbourhood.',
  },
  {
    id: 'metrics',
    label: 'Graph metrics',
    blurb: 'Density, components, degree distribution — the numbers rather than the picture.',
    note: 'Every measure here is O(V + E), so the card is live as you edit. Centrality is a separate node, because it is not.',
  },
  {
    id: 'viewer3d',
    label: 'A 3D scene',
    blurb: 'Skeletons and synapses, rendered in the browser.',
    note: 'Skeletons coloured by type, synapse points by polarity. Scroll to zoom, drag to orbit.',
  },
  {
    id: 'neuroglancer',
    requires: 'viewerScene',
    label: 'Neuroglancer',
    blurb: 'The published scene, with the chosen neurons loaded.',
    note: 'The dataset’s own published scene with the selection loaded into it — the segmentation as its authors serve it.',
  },
]

/** The node a chain ends on, and the params that make it draw the thing it was chosen for. */
export interface ViewSpec {
  type: string
  params?: Record<string, unknown>
}

/**
 * Which viewers can end which chain, **and the node each one is** — one table, read by both
 * halves of the wizard.
 *
 * A viewer takes what the analysis produces: a heatmap wants a matrix, a network diagram wants a
 * network, a table wants a table. Offering one that cannot be wired is how a wizard produces a
 * graph with a red node in it.
 *
 * It was two tables — this one holding ids, and a `switch` in `build.ts` re-encoding the same
 * pairing as nested ternaries — with `wizard.test.ts` named as what kept them together. That
 * test runs `inferGraph`, so it catches a pair that cannot be *wired* and says nothing about a
 * pair the two halves disagree about, and by the time it was written they already did: the ids
 * here read heatmap-first for `matrix`, the dialog offered the table first (it filtered the copy
 * table, whose order is its own), and a third table in `build.ts` hardcoded `matrix: 'heatmap'`
 * under a comment claiming it was "the first one that analysis offers". Three tables, two of
 * them wrong. **Insertion order here is the order the dialog offers**, and the demo workflows
 * take the first key rather than restating it.
 *
 * The node type and its params live here rather than in `build.ts` because they are what makes
 * the pairing *true* — `bar` belongs to `partners` precisely because a bar chart can read a
 * `postType`/`sum_weight` table. Splitting the claim from its evidence is what let them drift.
 * What stays in `build.ts` is everything upstream of this node, which is where the analyses
 * genuinely differ.
 */
export const VIEWS: Record<AnalysisId, Partial<Record<VisualisationId, ViewSpec>>> = {
  partners: {
    table: { type: 'out.table' },
    bar: { type: 'out.barChart', params: { category: 'postType', value: 'sum_weight' } },
    pie: { type: 'out.pie', params: { category: 'postType', value: 'sum_weight' } },
  },
  matrix: {
    heatmap: { type: 'out.heatmap', params: { scale: 'sequential', showValues: true } },
    // Off `adj.links` rather than the matrix — see `bodyOf`. A matrix is not a table.
    table: { type: 'out.table' },
  },
  /*
   * A paths query answers with a network *and a layout for it* — the one place a viewer is handed
   * its geometry rather than computing one, since a path graph laid out by force is a hairball
   * where the hop count is the whole point.
   */
  paths: {
    network: {
      type: 'out.network',
      params: {
        nodeColorMode: 'categorical',
        nodeColorBy: 'id',
        edgeSizeBy: 'weight',
        showLabels: true,
      },
    },
    table: { type: 'out.table' },
  },
  network: {
    network: {
      type: 'out.network',
      params: {
        layout: 'layered',
        nodeColorMode: 'categorical',
        nodeColorBy: 'id',
        nodeSizeBy: 'weightOut',
        edgeSizeBy: 'weight',
        showLabels: true,
      },
    },
    metrics: { type: 'net.metrics' },
  },
  /*
   * Both clusterings end the same way, because by the time they get here they are the same thing:
   * a square matrix that has been through Linkage. The dendrogram reads the tree and the heatmap
   * reads the matrix *reordered by* that tree, which is the pairing that makes a cluster visible
   * as a block rather than a scatter.
   */
  cluster: {
    dendrogram: { type: 'out.dendrogram' },
    heatmap: { type: 'out.heatmap', params: { scale: 'sequential' } },
  },
  nblast: {
    dendrogram: { type: 'out.dendrogram' },
    heatmap: { type: 'out.heatmap', params: { scale: 'sequential' } },
  },
  morphology: {
    viewer3d: {
      type: 'out.viewer3d',
      params: { skeletonColorMode: 'categorical', skeletonColorBy: 'type' },
    },
    neuroglancer: { type: 'out.neuroglancer' },
  },
  neurons: {
    table: { type: 'out.table' },
    neuroglancer: { type: 'out.neuroglancer' },
  },
}

/** The viewers this analysis can end on, in offer order, minus what the source cannot do. */
export function visualisationOptions(
  dataset: string,
  analysis: AnalysisId,
): WizardOption<VisualisationId>[] {
  const offered = Object.keys(VIEWS[analysis]) as VisualisationId[]
  return available(
    dataset,
    offered.flatMap((id) => {
      const option = visualisationOption(id)
      return option ? [option] : []
    }),
  )
}

/**
 * The answer to keep, or the first one still available.
 *
 * The wizard's one rule about going back: an answer the new dataset cannot support is *replaced*,
 * never kept, because a kept one builds a graph the wizard never offered and the question that
 * would have shown it is two screens back. Here rather than in the dialog so it is a headless
 * decision the tests can walk.
 */
export function resolveOption<T extends string>(
  options: readonly WizardOption<T>[],
  chosen: T,
  fallback: T,
): T {
  if (options.some((option) => option.id === chosen)) return chosen
  return options[0]?.id ?? fallback
}

export const startOption = (id: StartId): WizardOption<StartId> | undefined =>
  STARTS.find((o) => o.id === id)
export const analysisOption = (id: AnalysisId): WizardOption<AnalysisId> | undefined =>
  ANALYSES.find((o) => o.id === id)
export const visualisationOption = (
  id: VisualisationId,
): WizardOption<VisualisationId> | undefined => VISUALISATIONS.find((o) => o.id === id)

/**
 * Every combination the wizard can reach for one dataset, **one viewer at a time**.
 *
 * The fourth question takes a set, so the reachable answers are its power set — which is a
 * different order of magnitude for no more coverage: a workflow with two viewers is the same
 * chain with a second node hung off the same port, and `wizard.test.ts` pins that shape directly
 * rather than enumerating it. What matters here is that every *pair* of an analysis and a viewer
 * is walked, which the singletons do.
 *
 * Exported for the tests and the node guide rather than for the dialog, which walks the option
 * lists one question at a time. Both readers want the same thing the dialog produces, which is
 * why this is derived from the same three functions instead of being a second table.
 */
export function everyCombination(dataset: string): WizardAnswers[] {
  const answers: WizardAnswers[] = []
  for (const start of startOptions(dataset)) {
    for (const analysis of analysisOptions(dataset)) {
      for (const visualisation of visualisationOptions(dataset, analysis.id)) {
        answers.push({
          dataset,
          start: start.id,
          analysis: analysis.id,
          visualisations: [visualisation.id],
          notes: true,
          dashboard: false,
        })
      }
    }
  }
  return answers
}
