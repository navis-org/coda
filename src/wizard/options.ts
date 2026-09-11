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
import { compareDatasetName } from '../nodes/analysis/compareConnectivity'
import { findParam } from '../core/node'
import { getNodeDef } from '../core/registry'
import { spaceForDataset } from '../data/transforms/spaces'
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

/**
 * What the workflow works out about them.
 *
 * Two disjoint sets, and which one the third question offers is decided by the *first* answer:
 * the nine single-dataset techniques, and the four that only mean anything with more than one
 * connectome in the graph. They are one type because everything downstream of the question —
 * `VIEWS`, `bodyOf`, the graph's own name — reads an analysis without caring which list it came
 * off, and a second union would be a second `VIEWS`.
 */
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
  // Cross-dataset. See `CROSS_ANALYSES`.
  | 'compare'
  | 'coclust'
  | 'xmorphology'
  | 'xnblast'

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
  | 'scatter'

/**
 * One complete set of answers — everything `buildWorkflow` needs.
 *
 * `notes` is the only one that is not a question: it is a checkbox on the summary and a
 * remembered preference, because it is a statement about how somebody likes their canvas rather
 * than about the workflow they are building.
 */
export interface WizardAnswers {
  /**
   * The dataset family keys, e.g. `mock.opticlobe`. `dataset.<key>` is the node type.
   *
   * **A list at every arity, and the multi-dataset mode is derived from its length** rather
   * than carried beside it as a flag. A second field saying "this is a comparison" is a second
   * answer to a question the list already answers, and the two come apart the moment a path
   * writes one without the other — a `multi: true` beside one key builds a Match Cell Types
   * with a single input, which is a node refusing to run for a reason two screens back.
   *
   * `isMulti` is the one reader of that rule. Order is the order the reader ticked them, and it
   * is load-bearing: it is dataset 1..N on every variadic port, the `A`/`B`/`C`/`D` suffix on
   * `Compare Connectivity`'s output columns, and the row each arm is laid out on.
   */
  datasets: string[]
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
   * The node whose drawing names this answer, for the row's icon.
   *
   * An answer here is a *chain* rather than a node, so the field says which card in that chain
   * the answer is **about** — the one somebody would point at to name the technique. For the
   * second question that is the head the answer builds, pinned exactly by `wizard.test.ts`; for
   * the third it is the node the label names, which is not always the first one the arm builds
   * (three arms open on a Connectivity, and drawing three answers alike is drawing none of
   * them). `neurons` is the one answer that builds no node of its own, and names the table it
   * hands on.
   *
   * Absent on a viewer, and that is the point: a viewer **is** a node and `VIEWS` already says
   * which, so `glyphNodeOf` reads it there rather than having it written twice. See that
   * function for the whole rule.
   */
  glyph?: string
  /**
   * The source capability this answer needs, if any.
   *
   * Declared on the option rather than tested at each question, which is where it started: three
   * `option.id !== '<literal>' || familyCan(dataset, '<literal>')` filters, one per question, each
   * pairing an id with a capability somewhere other than where the option is written. A gated
   * option added without its filter is offered and then builds a graph nobody can fetch.
   */
  requires?: keyof SourceCapabilities
  /**
   * Whether this answer needs the dataset to have a registration into the shared template space.
   *
   * Not a `SourceCapabilities` key, and it cannot be made into one: a template space is a fact
   * about *coordinates*, bound to a dataset id in `data/transforms/spaces.ts` and deliberately
   * not on `DatasetFamily` — a source cannot see the node layer, and a hand-named Custom
   * datastack carries coordinates exactly as a shipped one does. So it is a second gate rather
   * than a second spelling of the first, in the same place and read by the same filter.
   *
   * The two cross-dataset geometry arms need it: without a route into `JRC2018U`, `Transform
   * Neurons` has nothing to fit and `Stack Neurons` refuses two collections in unrelated spaces
   * — which is the refusal that node was built to make, and not one a wizard should walk into.
   */
  requiresTemplateSpace?: boolean
}

/**
 * The options of a question **every** chosen dataset's source can answer.
 *
 * The intersection rather than the union, and at one dataset the two are the same thing — which
 * is why this generalised rather than growing a second function. A cross-dataset workflow runs
 * one arm over all of its datasets, so an analysis one of them cannot serve is an analysis that
 * builds a chain with a refusing card in the middle of it. Same rule as at arity one, asked once
 * per dataset.
 */
function available<Id extends string>(
  datasets: readonly string[],
  options: readonly WizardOption<Id>[],
): WizardOption<Id>[] {
  return options.filter((option) => {
    const capability = option.requires
    return (
      (!capability || datasets.every((key) => familyCan(key, capability))) &&
      (!option.requiresTemplateSpace || datasets.every(familyBridges))
    )
  })
}

/**
 * Whether a workflow is the cross-dataset kind — **the one place `datasets.length` is read as a
 * mode**, which is what keeps the mode derived rather than stored. See `WizardAnswers.datasets`.
 */
function isMulti(datasets: readonly string[]): boolean {
  return datasets.length > 1
}

/**
 * How many connectomes one generated workflow may span — **read off the nodes, not restated**.
 *
 * `Match Cell Types` and `Compare Connectivity` each declare a `datasetCount` with a `max`, and
 * `compareConnectivity.ts` says outright that its number is the mapper's on purpose: a
 * comparison is read off a mapping, so a fifth dataset there would be a fifth column of a table
 * the mapper cannot produce. A third copy of `4` here is the copy that survives whichever of
 * them changes, and the wizard would then offer a dataset the graph it builds cannot take.
 *
 * The **minimum** of the two, because a chain is bounded by its narrowest card. A function
 * rather than a module const for the reason `docs/gotchas.md` records about module init order:
 * `registerBuiltinNodes` runs as a side effect of importing `../nodes`, and a constant evaluated
 * at import time here would read an empty registry from whichever module happened to load first.
 * The fallback is the value both nodes declare today, so an unregistered registry degrades to
 * the right answer rather than to zero datasets.
 */
export function maxWizardDatasets(): number {
  const declared = ['compare.matchTypes', 'compare.connectivity'].flatMap((type) => {
    const def = getNodeDef(type)
    const param = def && findParam(def, 'datasetCount')
    return param && 'max' in param && typeof param.max === 'number' ? [param.max] : []
  })
  return declared.length ? Math.min(...declared) : 4
}

/**
 * Whether a family's coordinates can be moved into the shared template space.
 *
 * `familyCan`'s sibling for the gate that is not a capability — see
 * `WizardOption.requiresTemplateSpace`. The lookup is keyed on a **dataset id**, so a family
 * hands over its `family` half: a version pins a reconstruction, never a coordinate frame, which
 * is the same split `spaceForDataset` makes internally.
 *
 * An unknown family reads as "yes", which is `familyCan`'s rule and is the right one at this
 * layer: the wizard is asking whether an answer is worth offering, and `Transform Neurons` is
 * still the card that says so on the canvas where it genuinely cannot fit.
 */
export function familyBridges(key: string): boolean {
  const family = familyOf(key)
  if (!family) return true
  return Boolean(spaceForDataset(family.sourceId, family.family))
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

/**
 * The extra row on the first question, which is not a dataset.
 *
 * The copy is here rather than in the dialog, which is this file's rule for every other answer
 * and matters more for this one: it is the only row on that screen whose consequence is *another
 * question* rather than a node, so what it promises has to be written where the questions are.
 *
 * `glyph` is the node the path is about — the mapper is the card every cross-dataset arm but the
 * geometry pair is built around, and it is the one that could not exist in a single-dataset
 * workflow at all.
 */
export const MULTI_DATASET = {
  id: 'multiple',
  label: 'Multiple datasets',
  blurb:
    'Compare two or more connectomes: matched cell types, co-clustering, or their morphology in one space.',
  glyph: 'compare.matchTypes',
} as const

/**
 * The families a cross-dataset workflow can be built from.
 *
 * `datasetOptions()` minus the ones that can answer none of the four cross-dataset analyses,
 * applied one question earlier than the other gates because here it is the *answer* rather than
 * the option that would go on to build a broken chain.
 *
 * **Asked of `available`, never restated.** The disjunction this needs — a neuron index, or
 * skeletons and a template space — is exactly the union of what `CROSS_ANALYSES` already
 * declares, and writing it out here is the fourth hand-paired `id`-and-capability filter that
 * `WizardOption.requires` was introduced to delete. A fifth analysis gated on anything else
 * would otherwise strike every family that can answer it off this question, silently, with the
 * analysis unreachable and no test able to see it.
 *
 * Deliberately **not** narrowed against what is already ticked. Two datasets that share no
 * analysis are possible and the third question is where that is said, with the list of what each
 * one can do — narrowing here would make rows disappear as boxes are ticked, which is the one
 * shape of gating that reads as a bug rather than as a decision.
 */
export function multiDatasetOptions(): DatasetFamily[] {
  return datasetOptions().filter((family) => available([family.key], CROSS_ANALYSES).length > 0)
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
  return sourceCan(family.sourceId, capability)
}

/**
 * `familyCan`'s ceiling asked of a source rather than a family.
 *
 * The starters' reader (`starters.ts`): a starter names a node type and a source, and a custom
 * dataset node — `dataset.neuprint`, `dataset.cave`, `dataset.catmaid` — is no family but still
 * has a source whose ceiling decides whether a Neuroglancer cell is worth putting in the graph.
 * One spelling of the reading, so the menu and the wizard cannot come to ask it two ways again.
 * `false` with no source at all, where `familyCan` says `true` for a key it does not know: that
 * one gates *offers*, and a starter with nothing to ask should not gain a viewer that can only warn.
 */
export function sourceCan(
  sourceId: string | undefined,
  capability: keyof SourceCapabilities,
): boolean {
  return sourceId ? capabilityAnywhere(getSource(sourceId), capability) : false
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
    glyph: 'neuron.explore',
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
    glyph: 'neuron.findNeurons',
    hint: {
      text: '**Set a filter here**, then Run \u2014 with none set this node returns no neurons, since these run against a live server. A type like `LC.*` is a regex, anchored the way the backend anchors it.',
      tone: 'tip',
    },
  },
  {
    id: 'ids',
    label: 'Paste IDs',
    blurb: 'Copy a list of body or root ids you already have into Coda.',
    glyph: 'neuron.inputIds',
    hint: {
      text: '**Paste body ids here**, one per line, then Run. Ids are text, never numbers — an 18-digit root id does not survive being parsed as one.',
      tone: 'tip',
    },
  },
]

export function startOptions(datasets: readonly string[]): WizardOption<StartId>[] {
  return available(datasets, STARTS)
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
    glyph: 'neuron.connectivity',
    hint: {
      text: 'Connectivity → group → sort, the chain most connectivity questions are built from. `Min weight` drops the weak pairs at the server rather than after the download.',
    },
  },
  {
    id: 'matrix',
    label: 'Adjacency matrix',
    blurb:
      'All-by-all connectivity. Can feed into heatmap, clustering or network visualization/analysis.',
    glyph: 'neuron.adjacency',
    hint: {
      text: 'Adjacency between the same set on both axes. Row-normalising makes each row sum to 1, so rows with very different totals can still be compared.',
    },
  },
  {
    id: 'influence',
    label: 'Influence score',
    blurb:
      'Influence → Pivot: how strongly every neuron drives your set, summed over every path rather than along one route.',
    glyph: 'neuron.influence',
    hint: {
      text: 'The influence score of Bates et al., bounded to a few hops. Scores are a lower bound and the card says how much it left out. Press `?` for what the number means.',
    },
  },
  {
    id: 'paths',
    requires: 'paths',
    label: 'Shortest paths',
    blurb: 'Paths from one neuron set to another, a few hops deep. Two searches.',
    glyph: 'neuron.paths',
    hint: {
      text: 'This node needs two inputs - `Sources` & `Targets` - which is why we have two searches on the left. `Max hops` and `Min weight` keep the traversal bounded.',
    },
  },
  {
    id: 'network',
    label: 'Network graph + stats',
    blurb: 'Type-level edges as a node-link network graph and/or the graph metrics over it.',
    glyph: 'net.build',
    hint: {
      text: 'Grouping by both ends turns neuron-to-neuron rows into the type-level edge list a network is built from.',
    },
  },
  {
    id: 'cluster',
    label: 'Connectivity similarity',
    blurb: 'Partner Vectors → Similarity Matrix → Linkage, over the shared partners.',
    glyph: 'neuron.partnerVectors',
    hint: {
      text: 'Partner Vectors makes one vector per neuron. There is deliberately no Pivot in this chain — that is what keeps it from being a hundred million cells.',
    },
  },
  {
    id: 'morphology',
    requires: 'skeletons',
    label: 'View morphology in 3D',
    blurb: 'Skeletons and synapse locations, drawn in one scene.',
    glyph: 'neuron.skeletons',
    hint: {
      text: 'Two queries off one search: the arbours and the synapse points, drawn in the same scene.',
    },
  },
  {
    id: 'nblast',
    requires: 'skeletons',
    label: 'NBLAST clustering',
    blurb: 'All-by-all NBLAST over their skeletons → Linkage.',
    glyph: 'neuron.nblast',
    hint: {
      text: 'NBLAST is all-by-all, so the work grows with the **square** of the set. The search above is capped for that reason; widen it deliberately.',
      tone: 'warning',
    },
  },
  {
    id: 'neurons',
    label: 'Neuron table only',
    blurb: 'No analysis, just the data. Build on it with your own queries and viewers.',
    glyph: 'out.table',
    hint: {
      text: 'No analysis yet. Add nodes to the right of this one — press Tab for the node browser.',
    },
  },
]

/**
 * The four answers that only mean anything with more than one connectome on the canvas.
 *
 * A separate list rather than four entries in `ANALYSES` behind a flag, because the two sets are
 * **disjoint**: not one single-dataset technique is offered here and not one of these is offered
 * there. `Connectivity partners` over two datasets is two workflows, and `Compare Connectivity`
 * with one input is a node refusing to run. A `mode` field on the option would be a filter every
 * reader of `ANALYSES` has to remember; two lists and one `if` is the same statement with
 * nothing to forget.
 *
 * The blurbs are the chain, as in `ANALYSES` and for the same reason — but here the chain is the
 * only way to see what separates the two connectivity answers, which produce a side-by-side
 * table and a mixed dendrogram from the same starting point.
 *
 * The two geometry arms carry `requiresTemplateSpace` as well as `skeletons`: shape can only be
 * compared once both brains are in one coordinate frame, and that is a fact about the dataset
 * rather than about its source. See that field.
 */
const CROSS_ANALYSES: WizardOption<AnalysisId>[] = [
  {
    id: 'compare',
    requires: 'neuronIndex',
    label: 'Compare connectivity',
    blurb:
      'Match Cell Types → Compare Connectivity: the same type-to-type connection counted in each connectome, side by side.',
    glyph: 'compare.connectivity',
    hint: {
      text: '**Check the type columns on the mapper** — they are pre-filled from what each dataset usually publishes, and a cross-reference column written in the other dataset’s namespace is what a match is made of. Read the `present` columns before the weights: 0 is a real absence, empty means the type is missing there.',
      tone: 'tip',
    },
  },
  {
    id: 'coclust',
    requires: 'neuronIndex',
    label: 'Co-cluster neurons',
    blurb:
      'Partner Vectors → Qualify Ids → Stack Tables → Similarity Matrix → Linkage: both connectomes’ neurons on one tree, matched by who they wire with.',
    glyph: 'core.qualifyIds',
    hint: {
      text: 'Every neuron is a vector over the **shared** label space, which is what the mapper is wired into Partner Vectors for — a partner outside it can only exist in one dataset, so it is dropped rather than counted as a difference. A mixed clade is a matched group.',
      tone: 'tip',
    },
  },
  {
    id: 'xmorphology',
    requires: 'skeletons',
    requiresTemplateSpace: true,
    label: 'Morphology in one space',
    blurb:
      'Transform Neurons into JRC2018U → Stack Neurons: every dataset’s arbours drawn in one scene.',
    glyph: 'neuron.xform',
    hint: {
      text: 'One landmark transform per dataset, straight into the shared template. The scene colours by the column Stack Neurons adds, which is what lets you tell the brains apart.',
    },
  },
  {
    id: 'xnblast',
    requires: 'skeletons',
    requiresTemplateSpace: true,
    label: 'NBLAST across datasets',
    blurb:
      'Transform → Stack → NBLAST → Linkage: which neurons are the same shape in both brains.',
    glyph: 'neuron.nblast',
    hint: {
      text: 'NBLAST is all-by-all over the **combined** set, so the work grows with the square of every dataset’s search put together. Each search above is capped for that reason; widen them deliberately.',
      tone: 'warning',
    },
  },
]

/**
 * The third question's answers: the cross-dataset four where more than one dataset was chosen,
 * the nine single-dataset techniques otherwise.
 *
 * The list is decided by the first answer and then narrowed by `available` against **every**
 * dataset in it — so a comparison between one connectome with skeletons and one without offers
 * the two connectivity answers and neither geometry one, which is the honest reading of what
 * those two brains can be asked together.
 *
 * It can come back **empty**, which no single-dataset call can do: two datasets that share no
 * capability share no analysis. The dialog says so and refuses to continue rather than opening a
 * question with nothing in it — the alternative is offering an answer one of the two cannot
 * serve, which is the thing this whole file exists to prevent.
 */
export function analysisOptions(datasets: readonly string[]): WizardOption<AnalysisId>[] {
  return available(datasets, isMulti(datasets) ? CROSS_ANALYSES : ANALYSES)
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
    id: 'scatter',
    label: 'A scatter plot',
    blurb: 'One point per type pair, each dataset’s count on an axis.',
    hint: {
      text: 'A pair on the diagonal is wired the same in both; one far off it is the asymmetry. Both axes are log, because synapse counts span orders of magnitude — a pair absent from one dataset has no logarithm and the caption says how many were dropped.',
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
/**
 * The column `Stack Neurons` writes to say which dataset each neuron came from.
 *
 * One name, read by the params of the stack that adds it and by the 3D scene that colours by it
 * — the two halves of the co-visualisation gesture, and a viewer pointed at a column the stack
 * did not write draws one flat colour and nothing to say why.
 */
export const STACK_SOURCE_COLUMN = 'dataset'

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
  /*
   * The comparison is **wide** — `preLabel`, `postLabel`, then two columns per dataset — which is
   * what makes both of these readable off one row. The scatter names the first two datasets'
   * weight columns because those are the two that always exist; a third and fourth are two clicks
   * on the card, and there is no pair of axes that could have been right for all four.
   */
  compare: {
    table: { type: 'out.table' },
    scatter: {
      type: 'out.scatter',
      params: {
        x: `weight_${compareDatasetName(1)}`,
        y: `weight_${compareDatasetName(2)}`,
        xLog: true,
        yLog: true,
      },
    },
  },
  /*
   * `cluster`'s tail exactly, and that is the finding rather than a shortcut: by the time either
   * arm reaches Linkage it is the same thing — a square matrix of how alike every pair is — and
   * what makes this one cross-dataset happened four cards upstream, in the qualified ids and the
   * shared feature axis. See `bodyOf`.
   */
  coclust: {
    dendrogram: { type: 'out.dendrogram' },
    heatmap: { type: 'out.heatmap', params: { scale: 'sequential' } },
  },
  xmorphology: {
    viewer3d: {
      type: 'out.viewer3d',
      /*
       * By the column `Stack Neurons` adds, not by `type` — which is the whole difference from
       * the single-dataset morphology arm. Two brains in one scene are only worth looking at if
       * you can tell which is which, and the source column is what a colour encoding reads.
       */
      params: { skeletonColorMode: 'categorical', skeletonColorBy: STACK_SOURCE_COLUMN },
    },
  },
  xnblast: {
    dendrogram: { type: 'out.dendrogram' },
    heatmap: { type: 'out.heatmap', params: { scale: 'sequential' } },
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

/**
 * Every viewer's node spec, by id — `VIEWS` inverted once rather than searched per lookup.
 *
 * A viewer means the same node whichever analysis offers it, which is the property that makes
 * this safe to flatten: `out.neuroglancer` under `morphology` and under `neurons` are the same
 * entry. Built at module scope because the answer is a fact about the table, not about a graph.
 *
 * Two readers, and they want it for opposite halves of one node: `build.ts` asks the registry
 * whether the type has a `dataset` port, and `glyphNodeOf` asks what it draws as.
 */
export const VIEWS_BY_ID: ReadonlyMap<VisualisationId, ViewSpec> = new Map(
  Object.values(VIEWS).flatMap(
    (byView) => Object.entries(byView) as [VisualisationId, ViewSpec][],
  ),
)

/**
 * The node whose drawing names an answer — the icon on its row.
 *
 * **Declared for a start or an analysis, derived for a viewer**, and the split is not a
 * convenience. A viewer *is* a node and `VIEWS` already says which, so writing it a second time
 * on the option is how the row comes to show one node and the chain to end on another. A start
 * or an analysis is a *chain*, and which card in it names the answer is a judgement — three arms
 * open on a Connectivity, so deriving it from the first node an arm builds would draw three
 * different answers identically, which is drawing none of them.
 *
 * `wizard.test.ts` holds both halves: every answer the wizard offers names a registered type (a
 * typo otherwise falls through to the category drawing in silence, which is a picture and so
 * looks like it worked), no two answers to one question draw alike, the second question's glyph
 * is exactly the head that answer builds, and an analysis that builds anything of its own draws
 * as one of the nodes it builds. `neurons` is the answer that builds nothing of its own — the
 * rule excuses it by saying so rather than by naming it — and draws as the table it hands on.
 *
 * Takes only the two fields it reads, so the one answer here that is not a `WizardOption` — the
 * first question's "Multiple datasets" row, which answers by replacing the question — draws
 * through the same function rather than through a hand-written second lookup.
 */
export function glyphNodeOf(option: { id: string; glyph?: string }): string | undefined {
  return option.glyph ?? VIEWS_BY_ID.get(option.id as VisualisationId)?.type
}

/** The viewers this analysis can end on, in offer order, minus what the source cannot do. */
export function visualisationOptions(
  datasets: readonly string[],
  analysis: AnalysisId,
): WizardOption<VisualisationId>[] {
  const offered = Object.keys(VIEWS[analysis]) as VisualisationId[]
  return available(
    datasets,
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

/**
 * Which viewers the fourth question arrives with ticked.
 *
 * **Everything the analysis offers, minus what this reader has turned off** — so a first visit
 * gets every way of looking at the answer and finds out what they are, and somebody who has said
 * "not the pie chart" is not told again. The refusals are the remembered half rather than the
 * picks, for the reason `loadWizardViewsOff` records: this question's options change with the
 * analysis, so a remembered *allow*-list means something different every time it is read, and a
 * reader who ticked everything under one analysis would silently narrow the next one.
 *
 * The floor is the rule the set has always had, restated for the new default: **never none.**
 * The dialog refuses to untick the last box, so the off-list can never empty the question it was
 * made in — but it accumulates across questions, and two analyses each giving up one viewer can
 * between them cover every viewer a third one offers. Everything, then, rather than nothing: an
 * empty question builds a chain with no end on it, and a reader who wants that wants a different
 * analysis.
 *
 * Headless and here rather than in the dialog, which is `resolveOption`'s reason a few lines
 * down: applied on the way *out* of the state, so no path can forget it.
 */
export function resolveVisualisations(
  options: readonly WizardOption<VisualisationId>[],
  off: readonly VisualisationId[],
): VisualisationId[] {
  const kept = options.filter((option) => !off.includes(option.id)).map((option) => option.id)
  return kept.length ? kept : options.map((option) => option.id)
}

export const startOption = (id: StartId): WizardOption<StartId> | undefined =>
  STARTS.find((o) => o.id === id)
/**
 * Both lists, flattened once at module scope — `VIEWS_BY_ID`'s rule a few functions up, and for
 * the same reason: the answer is a fact about the tables rather than about a graph.
 *
 * A lookup by id is asked *after* the question has been answered and the caller no longer has
 * the dataset count to hand — the note above the chain and the graph's own name both read an
 * analysis without knowing which list it came off. The two are disjoint by construction, which
 * `wizard.test.ts` pins, so a single `find` across both cannot be ambiguous.
 */
const ALL_ANALYSES: readonly WizardOption<AnalysisId>[] = [...ANALYSES, ...CROSS_ANALYSES]

export const analysisOption = (id: AnalysisId): WizardOption<AnalysisId> | undefined =>
  ALL_ANALYSES.find((o) => o.id === id)
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
export function everyCombination(datasets: readonly string[]): WizardAnswers[] {
  const answers: WizardAnswers[] = []
  for (const start of startOptions(datasets)) {
    for (const analysis of analysisOptions(datasets)) {
      for (const visualisation of visualisationOptions(datasets, analysis.id)) {
        answers.push({
          datasets: [...datasets],
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
