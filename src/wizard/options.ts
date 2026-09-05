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
 * which the synthetic source has no bucket for.
 *
 * Those are `SourceCapabilities` questions, asked through **`capabilityAnywhere`** — the ceiling
 * rather than the floor, because this is the one surface with no dataset id to ask about. See
 * `familyCan` for what asking the floor cost.
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

import type { NodeHint } from '../core/graph'
import type { SourceCapabilities } from '../data/source'
import { capabilityAnywhere, getSource } from '../data/source'
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
  | 'influence'
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
  | 'topology'
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

/**
 * A hint an answer docks to the card it built.
 *
 * **Derived from `NodeHint` rather than declared beside it**, which is what actually stops the
 * two drifting — an independent interface with the same three fields is exactly how `tone` comes
 * to be optional in one place and required in the other, and it also forces `build.ts` to rebuild
 * the object field by field on the way out. `Omit` states the one real difference: the wizard
 * never picks a `side`, because the overview note sits above the chain and a top-docked hint on
 * the head card is drawn into it.
 */
export type WizardHint = Omit<NodeHint, 'side'>

export interface WizardOption<Id extends string> {
  id: Id
  label: string
  /** One line, shown under the label in the dialog. */
  blurb: string
  /**
   * The box docked to the card this answer built — see `NodeHint`.
   *
   * It replaced a Text note placed under the same stage, and the move is what set the length: a
   * note is a card of its own and could be a paragraph, where a hint is the width of the card it
   * points at and goes away once it has been read. So the copy leads with what to *do* here and
   * keeps one caveat, and anything longer than that belongs in the node's `?` document, which is
   * one press away on the same card.
   *
   * `tone` defaults to `note`. `tip` is for the three head cards, which are the only answers here
   * that ask the reader to do something before anything will run; `warning` is for the one that
   * costs real time if it is widened without thinking.
   *
   * No `side`: every wizard hint docks under its card, because the overview note sits above the
   * chain and a top-docked hint on the head would land in it.
   */
  hint: WizardHint
  /**
   * The source capability this answer needs, if any.
   *
   * Declared on the option rather than tested at each question, which is where it started: three
   * `option.id !== '<literal>' || familyCan(dataset, '<literal>')` filters, one per question, each
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
  return options.filter((option) => !option.requires || familyCan(dataset, option.requires))
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

/**
 * Whether the source behind a family can do something. Unknown family reads as "yes".
 *
 * Exported because `build.ts` asks it too — whether to build the synapse-points node on the
 * morphology arm is the same question with the same three steps, and it was written out longhand
 * there. Two spellings of one question is how the two halves of the wizard came to disagree about
 * which reading they wanted, with nothing type-checking the pair.
 */
export function familyCan(key: string, capability: keyof SourceCapabilities): boolean {
  const family = familyOf(key)
  if (!family) return true
  /*
   * `capabilityAnywhere`, not `capabilityOf` with an undefined dataset id, and the difference is
   * the whole reason that function exists.
   *
   * A wizard answer is a *family*: which dataset it resolves to is not known until the node runs,
   * and the version dropdown defaults to "Latest" off a listing that has not landed when this
   * dialog opens. So the question here is not "can this dataset do X" but "is X worth offering
   * for this source at all" — the ceiling rather than the floor.
   *
   * Asking `capabilityOf(source, undefined, …)` gave the floor, which is `source.capabilities`,
   * and CAVE's is a deliberately safe `false` for `skeletons` — the right answer for a datastack
   * nothing is known about, and the wrong one here. It hid "View morphology in 3D" and "NBLAST
   * clustering" for all three CAVE families, every one of which has skeletons. The floor is still
   * what the Skeletons node's own `validate` reads, which is why a dataset that really has none
   * says so on the card rather than being silently un-offered two screens earlier.
   */
  return capabilityAnywhere(getSource(family.sourceId), capability)
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
    blurb:
      'Uses the `Explore Dataset` node: free-form search the full neuron table in the browser, tick the ones you want.',
    hint: {
      text: '**Search and tick neurons here**, then Run. Everything downstream reads the ticked set — a card further along saying it has no neurons is the graph waiting for you, not a mistake.',
      tone: 'tip',
    },
  },
  {
    id: 'search',
    label: 'Structured Search',
    blurb:
      'Uses the `Find Neurons` node: filter by type, status or region. Best when you already know what to ask for.',
    hint: {
      text: '**Set a filter here**, then Run. A type like `LC.*` is a regex, anchored the way the backend anchors it.',
      tone: 'tip',
    },
  },
  {
    id: 'ids',
    label: 'Paste IDs',
    blurb: 'Copy a list of body or root ids you already have into Coda.',
    hint: {
      text: '**Paste body ids here**, one per line, then Run. Ids are text, never numbers — an 18-digit root id does not survive being parsed as one.',
      tone: 'tip',
    },
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
 * The guidance on the canvas is unchanged in kind: it is read *after* the choice, beside the node
 * it is about, which is where the prose belongs. Where it *sits* did change — see `hint`.
 */
const ANALYSES: WizardOption<AnalysisId>[] = [
  {
    id: 'partners',
    label: 'Connectivity partners',
    blurb:
      'Fetch up- and/or downstream partners → aggregate by type and sort such that strongest partners appear first.',
    hint: {
      text: 'Connectivity → group → sort, the chain most connectivity questions are built from. `Min weight` drops the weak pairs at the server rather than after the download.',
    },
  },
  {
    id: 'matrix',
    label: 'Adjacency matrix',
    blurb:
      'All-by-all connectivity. Can feed into heatmap, clustering or network visualization/analysis.',
    hint: {
      text: 'Adjacency between the same set on both axes. Row-normalising makes each row sum to 1, so rows with very different totals can still be compared.',
    },
  },
  {
    id: 'influence',
    label: 'Influence score',
    blurb:
      'Influence → Pivot: how strongly every neuron drives your set, summed over every path rather than along one route.',
    hint: {
      text: 'The influence score of Bates et al., bounded to a few hops. Scores are a lower bound and the card says how much it left out. Press `?` for what the number means.',
    },
  },
  {
    id: 'paths',
    requires: 'paths',
    label: 'Shortest paths',
    blurb: 'Paths from one neuron set to another, a few hops deep. Two searches.',
    hint: {
      text: 'This node needs two inputs - `Sources` & `Targets` - which is why we have two searches on the left. `Max hops` and `Min weight` keep the traversal bounded.',
    },
  },
  {
    id: 'network',
    label: 'Network graph + stats',
    blurb: 'Type-level edges as a node-link network graph and/or the graph metrics over it.',
    hint: {
      text: 'Grouping by both ends turns neuron-to-neuron rows into the type-level edge list a network is built from.',
    },
  },
  {
    id: 'cluster',
    label: 'Connectivity similarity',
    blurb: 'Partner Vectors → Similarity Matrix → Linkage, over the shared partners.',
    hint: {
      text: 'Partner Vectors makes one vector per neuron. There is deliberately no Pivot in this chain — that is what keeps it from being a hundred million cells.',
    },
  },
  {
    id: 'morphology',
    requires: 'skeletons',
    label: 'View morphology in 3D',
    blurb: 'Skeletons and synapse locations, drawn in one scene.',
    hint: {
      text: 'Two queries off one search: the arbours and the synapse points, drawn in the same scene.',
    },
  },
  {
    id: 'nblast',
    requires: 'skeletons',
    label: 'NBLAST clustering',
    blurb: 'All-by-all NBLAST over their skeletons → Linkage.',
    hint: {
      text: 'NBLAST is all-by-all, so the work grows with the **square** of the set. The search above is capped for that reason; widen it deliberately.',
      tone: 'warning',
    },
  },
  {
    id: 'neurons',
    label: 'Neuron table only',
    blurb: 'No analysis, just the data. Build on it with your own queries and viewers.',
    hint: {
      text: 'No analysis yet. Add nodes to the right of this one — press Tab for the node browser.',
    },
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
    hint: {
      text: 'A table to inspect the data in a familiar way: filter, sort, double click to expand.',
    },
  },
  {
    id: 'bar',
    label: 'A bar chart',
    blurb: 'One bar per partner type, tallest first.',
    hint: { text: 'The bars read the grouped table: one category column, one value column.' },
  },
  {
    id: 'pie',
    label: 'A pie chart',
    blurb: 'Shares of the total, with the tail folded into one slice.',
    hint: {
      text: 'Everything past the eighth slice folds into “Other” — a pie with forty slices is a colour key, not a chart.',
    },
  },
  {
    id: 'dendrogram',
    label: 'A dendrogram',
    blurb: 'The clustering as a tree, with every neuron on a leaf.',
    hint: {
      text: 'Click a branch to select what is under it. The selection is an output, so it can feed the rest of the graph.',
    },
  },
  {
    id: 'heatmap',
    label: 'A heatmap',
    blurb:
      'The matrix drawn as cells, one colour ramp. Expand for additional options (palette, filters, sorting, etc).',
    hint: {
      text: 'Sequential colour, because these values have a zero and only go up. Turn values on to read the numbers off the cells.',
    },
  },
  {
    id: 'network',
    label: 'A network diagram',
    blurb: 'Nodes and links, laid out feed-forward.',
    hint: {
      text: 'Node colour is the type, size is total outgoing weight, link width is the synapse count. Drag a node to move it; right-click for the neighbourhood.',
    },
  },
  {
    id: 'metrics',
    label: 'Graph metrics',
    blurb: 'Density, components, degree distribution — the numbers rather than the picture.',
    hint: {
      text: 'Every measure here is O(V + E), so the card is live as you edit. Centrality is a separate node, because it is not.',
    },
  },
  {
    id: 'viewer3d',
    label: 'A 3D scene',
    blurb: 'Skeletons and synapses, rendered in the browser.',
    hint: {
      text: 'Skeletons coloured by type, synapse points by polarity. Scroll to zoom, drag to orbit.',
    },
  },
  {
    id: 'topology',
    /*
     * `skeletons`, where the 3D scene above it needs none — and that is not an oversight in the
     * other entry. `viewer3d` draws whatever the *arm* fetched for it, so the analysis is what
     * carries the requirement; this node fetches for itself off nothing but the neuron table, so
     * the requirement travels with the viewer. That is what lets it be offered under `neurons`,
     * where there is no geometry arm to gate.
     */
    requires: 'skeletons',
    label: 'Neuron Topology',
    blurb:
      'One neuron at a time: its arbour in 3D, its morphometrics, and where a chosen partner synapses onto it.',
    hint: {
      text: 'Page through the neurons with ‹ ›. Pick a partner in the rail to light up exactly where it connects. The Morphometrics port carries the numbers for the whole set.',
    },
  },
  {
    id: 'neuroglancer',
    requires: 'viewerScene',
    label: 'Neuroglancer',
    blurb: 'The published scene, with the chosen neurons loaded.',
    hint: {
      text: 'Neuroglancer scene with the selected neurons loaded into it.',
    },
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
   * The heatmap is the reason `Per query neuron` exists: it needs the scores *before* they are
   * summed over the neurons somebody wired in, which is one row per (query, influencer) and a
   * `Pivot` away from a matrix. The table takes the ranking — off a `Group By` when the heatmap
   * has already turned the pairs on, and off the node itself when it has not. See `bodyOf`.
   */
  influence: {
    table: { type: 'out.table' },
    heatmap: { type: 'out.heatmap', params: { scale: 'sequential' } },
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
    /*
     * A whole set in one scene, or one neuron examined closely — the two halves of "look at the
     * morphology", which is why they sit under the same analysis rather than needing a fifth
     * question. Ticking both is the useful combination: the scene for where the cells are, the
     * Topology card for what one of them measures.
     */
    topology: { type: 'out.topology' },
    neuroglancer: { type: 'out.neuroglancer' },
  },
  neurons: {
    table: { type: 'out.table' },
    /*
     * Offered with no analysis at all, because it *is* one: it takes the neuron table and the
     * dataset and does its own fetching, so `dataset → search → Neuron Topology` is a complete
     * workflow. `requires: 'skeletons'` on the option is what keeps it off a source that has
     * none — there is no arm here to carry that gate.
     */
    topology: { type: 'out.topology' },
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
