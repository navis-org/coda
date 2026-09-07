/**
 * One set of wizard answers into a working graph.
 *
 * This is what replaced the four bundled examples. They were hand-written graphs on synthetic
 * data, and they had two jobs: show somebody the shape a pipeline takes, and serve as
 * end-to-end fixtures. The first job they did badly for anyone who wanted their *own* dataset —
 * the answer was always "load this and swap the dataset node", which is a lesson about the app
 * rather than an answer to the question somebody arrived with. The second job survives here:
 * `wizard.test.ts` walks every combination this file can produce and holds it to what
 * `examples.test.ts` held four graphs to.
 *
 * ## The chain is assembled, not templated
 *
 * Each answer contributes nodes and wires to one list, and the four questions compose: the head
 * (dataset plus however the neurons are chosen) is shared by every analysis, and every analysis
 * hands its result to whichever viewer the last question named. That composition is the reason
 * the option space in `options.ts` can be a product rather than a list of blessed recipes — and
 * it is why `visualisationOptions` and the arms below have to agree about what each analysis
 * produces. They are checked against each other by running `inferGraph` over every reachable
 * combination.
 *
 * ## Two decisions that are not obvious
 *
 * **Node ids are short and meaningful** (`ds`, `find`, `conn`, `view`) rather than generated.
 * A share link carries the whole graph in the URL fragment, so every id is paid for twice — and
 * a saved file that reads as `conn → group → sort` is one somebody can edit by hand.
 *
 * **A search against a real dataset arrives with a row limit.** Auto-run is on by default, so a
 * generated Find Neurons with no filters and no limit would fire a whole-connectome query at a
 * shared production server the moment the graph lands. The synthetic dataset is 401 neurons and
 * gets none. The note beside it says the limit is there, because a truncation nobody mentions is
 * the failure this project keeps recording.
 */

import type { CodaGraph, GraphNode, NodeHint } from '../core/graph'
import {
  DEFAULT_COLUMNS,
  MIN_COLUMNS,
  ROW_TRACKS,
  addCells,
  setColumns,
  setSpan,
  setViewOpen,
} from '../core/dashboard'
import type { Link } from '../examples/assemble'
import { assembleGraph, graphNode } from '../examples/assemble'
import { COL_WIDTH, GRID_ORIGIN, ROW_HEIGHT } from '../layout/place'
import { NODE_BODIES, cardWidth } from '../ui/nodes/nodeBodies'
import { noteNode } from '../examples/notes'
import type { DatasetFamily } from '../nodes/lib/datasetFamilies'
import { datasetFamily } from '../nodes/lib/datasetFamilies'
import { ID_COLUMN_NAME } from '../core/ids'
import { encodeRows } from '../data/filterRows'
import { inputPorts, portIdAt } from '../core/ports'
import { repeatParamId } from '../nodes/lib/repeatParams'
import { getNodeDef } from '../core/registry'
import type { AnnotationChain } from '../nodes/lib/annotationChain'
import {
  chainGrid,
  chainLinks,
  chainWidth,
  foldChain,
  prefixChain,
} from '../nodes/lib/annotationChain'
import type { AnalysisId, VisualisationId, WizardAnswers, WizardHint } from './options'
import {
  STACK_SOURCE_COLUMN,
  VIEWS,
  VIEWS_BY_ID,
  analysisOption,
  familyCan,
  startOption,
  visualisationOption,
} from './options'

/**
 * How many neurons a search on a published dataset comes back with until somebody says
 * otherwise. Big enough to be a real look at a cell type, small enough that the query behind it
 * is not a whole connectome.
 */
const SEARCH_LIMIT = 100

/**
 * How many neurons the morphology arm's search comes back with.
 *
 * On the **search**, not on the geometry nodes, and that is the correction worth recording: a
 * skeleton node's `Limit` is a *warn-above* threshold and not a cap — guard rails warn, they do
 * not refuse (`docs/limits.md`) — so setting it to 30 while the search returned everything
 * produced a graph that fetched 401 skeletons and 4,404 synapses and papered both cards with a
 * warning about how long it would take. Seen in a browser on the synthetic dataset. Capping the
 * search caps the work; the geometry nodes keep their own thresholds, which then fire only if
 * somebody widens the search themselves.
 */
const GEOMETRY_LIMIT = 30

/** The analyses whose search is capped whatever was ticked — see `searchLimit`. */
const GEOMETRY_ANALYSES: ReadonlySet<AnalysisId> = new Set<AnalysisId>([
  'nblast',
  'xnblast',
  'xmorphology',
])

/**
 * Whether a viewer fetches its own geometry, asked of the node rather than listed by id.
 *
 * The give-away is a `dataset` input: a viewer that takes one is a card that goes and gets what
 * it draws — Neuroglancer's published scene, Neuron Topology's one skeleton — where an ordinary
 * viewer reads whatever the arm upstream produced. That difference decides which wires it gets,
 * and it was a `visualisation === 'neuroglancer'` test until there were two of them.
 *
 * Derived, because the alternative is a list that has to be remembered: a self-fetching viewer
 * added without its id in that test is wired to a port it does not have, which `inferGraph`
 * catches in the wizard's own suite — but only because that suite walks every pair. Asking the
 * registry means there is nothing to forget.
 */
function selfFetching(visualisation: VisualisationId): boolean {
  const view = VIEWS_BY_ID.get(visualisation)
  if (!view) return false
  const def = getNodeDef(view.type)
  // Through `inputPorts` rather than `def.inputs`, which may hold a `PortGroupDef` that expands
  // to a run — the one reader in the codebase that iterates the raw list is the one that gets a
  // group's template where a port was meant.
  // Empty params: no viewer here sizes a port group off one, and passing the spec's own params
  // would mean typing them as `ParamValues` for a question that does not read them.
  return def ? inputPorts(def, {}).some((port) => port.id === 'dataset') : false
}

interface Placement {
  id: string
  type: string
  /** Column index; converted to an x offset. */
  col: number
  /** Row offset within the column, in node heights. */
  row?: number
  /**
   * Extra pixels to the right of that column, for the several viewers that share one. A column
   * index cannot express it: they are stepped by each card's own width, not by the grid.
   */
  dx?: number
  params?: Record<string, unknown>
}

/**
 * Where a column starts.
 *
 * The Explore card is wider than a grid column, so a workflow that browses would have its second
 * node sitting inside the first. Everything downstream of the head shifts right by the overrun
 * rather than the grid changing: a note lining up with column 2 has to move with it.
 */
function xOf(col: number, shift: number): number {
  return GRID_ORIGIN.x + col * COL_WIDTH + (col >= 2 ? shift : 0)
}

/**
 * How far the tail moves when the head is the Explore card.
 *
 * **Measured off the card's own declared width**, not a constant of ours. `place.ts` says at
 * length that `COL_WIDTH` cannot be right for every graph and that the real fix is to advance
 * each column by the widest node in it; until that exists, a wizard reading `NODE_BODIES` gets
 * the same answer that file would, and a card that changes width takes its clearance with it.
 * A hand-tuned 160 would not.
 */
/** Clear space between the widened card and the next column. `builder.ts` uses the same 90. */
const CARD_GAP = 90

const EXPLORE_SHIFT = Math.max(
  0,
  (NODE_BODIES['neuron.explore']?.width ?? 0) + CARD_GAP - COL_WIDTH,
)

// ---------------------------------------------------------------------------

/**
 * The graph, from one set of answers.
 *
 * Deterministic for a synthetic dataset and not quite for a published one: a dataset node with a
 * `companion` mints its Description card with a generated id. That is `addNodeWithCompanion`'s
 * doing and it is wanted — a starter, an example and a hand-added node all open with the credit
 * card, and a wizard has no better claim to be the exception.
 */
/**
 * What a caller other than the wizard needs to turn off.
 *
 * One member, and it exists because of a failure the type system cannot see. The node guide's
 * demo links search for the workflow that best *demonstrates* a node, ranking candidates by
 * inference issues — and a FlyWire workflow carrying its annotation chain is genuinely better
 * typed than a synthetic one, because six more cards mean six more ports for the search to find
 * a clean fit on. So `core.filterTable`'s "Open in a workflow" link silently moved from the
 * synthetic dataset to FlyWire, where opening it downloads a 139k-row file from GitHub, reads a
 * CAVE table of about a million rows, does a supervoxel lookup per neuron, and asks for a token
 * — for a demo of *filtering a table*.
 *
 * Scoring cannot know that, because cost is not an inference issue. `demo.ts` already narrows
 * this search once for a neighbouring reason (`scorable`, because `inferGraph` peeks); this is
 * the same narrowing on the other axis.
 */
export interface BuildOptions {
  /** `false` to leave off `DatasetFamily.annotationChain`. Absent means build it. */
  annotationChain?: boolean
}

export function buildWorkflow(answers: WizardAnswers, options: BuildOptions = {}): CodaGraph {
  const keys = answers.datasets
  const shift = answers.start === 'browse' ? EXPLORE_SHIFT : 0

  const nodes: Placement[] = []
  const links: Link[] = []
  const chains: AnnotationChain[] = []
  const heads: Head[] = []

  /*
   * One band per dataset: its node, whatever it needs in front of it, and the card the neurons
   * are chosen on. A single-dataset workflow is the one-iteration case of this loop and comes
   * out byte-identical to what it always did — `ds`, `find`, the chain's own ids — which is what
   * `suffixed` and the empty prefix below are for.
   */
  keys.forEach((key, index) => {
    const which = index + 1
    const family = datasetFamily(key)
    const dsId = suffixed('ds', which)
    const row = index * DATASET_ROW
    nodes.push({ id: dsId, type: `dataset.${key}`, col: 0, row })

    /*
     * What this dataset needs in front of it before its neurons have names.
     *
     * `DatasetFamily.annotationChain`, which the starter graph also builds — one declaration, two
     * builders, because the wizard opened every FlyWire workflow on a list of eighteen-digit root
     * ids while `New ▸ FlyWire FAFB` opened the same dataset fully typed. That is the same graph
     * answering the same question two ways depending on which menu you came through.
     *
     * Placed in the columns *before* the dataset, and folded, for the reason the starter folds it:
     * six cards of plumbing that has to be right and never has to be touched are the biggest thing
     * on the canvas and none of them is what the reader asked the wizard for. The negative columns
     * are only a starting arrangement — a generated workflow asks the canvas for one ELK pass on
     * arrival, and that is what decides where any of this actually sits.
     *
     * **Prefixed past the first**, because a chain's ids are local to the chain: two datasets
     * each carrying one would mint two nodes called `join` in one graph, which `assembleGraph`
     * has no way to notice — the second silently replaces the first and both sets of wires point
     * at whichever survived. The first keeps its bare ids so a single-dataset graph is unchanged.
     *
     * It is built for every dataset in a comparison and not only the first, which is what makes
     * the cross-dataset connectivity arms work at all: `Match Cell Types` takes a **Dataset**
     * and reads its whole annotation table, and a CAVE datastack's typing arrives through this
     * chain — so a FlyWire node without one has no type column for the mapper to match on.
     */
    const declared = options.annotationChain === false ? undefined : family?.annotationChain
    const chain = declared ? prefixChain(declared, which === 1 ? '' : `${dsId}-`) : undefined
    if (chain) {
      const width = chainWidth(chain)
      for (const cell of chainGrid(chain)) {
        nodes.push({
          id: cell.node.id,
          type: cell.node.type,
          // Right-to-left from the dataset at column 0, so the last card of the widest row is the
          // one beside it. The row is the chain's own (`ChainNode.row`), not this file's guess.
          col: cell.col - width,
          row: row + cell.row,
          ...(cell.node.params ? { params: cell.node.params } : {}),
        })
      }
      links.push(...chainLinks(chain, dsId))
      chains.push(chain)
    }

    // --- the head: whichever way the neurons are chosen ---------------------
    const head = headOf(answers, family, which, dsId, row, chain)
    nodes.push(head.node)
    links.push(...head.links)
    heads.push(head)
  })

  /*
   * A second head on the *first* dataset, for the one analysis whose question has two ends. It is
   * built here rather than inside the arm because it is a *head*: which card it is, and whether
   * its search is capped, are the first question's answers and not the third's. `paths` is a
   * single-dataset analysis, so its suffix `2` can never collide with a second dataset's.
   */
  const target =
    answers.analysis === 'paths'
      ? headOf(answers, datasetFamily(keys[0] ?? ''), 2, 'ds', ARM_ROW, chains[0])
      : undefined
  if (target) {
    nodes.push(target.node)
    links.push(...target.links)
  }

  // --- the analysis, and the viewer that ends it ----------------------------
  const body = bodyOf(answers, heads, target?.port)
  nodes.push(...body.nodes)
  links.push(...body.links)

  /*
   * The three stage hints, each docked to the card it is about.
   *
   * **Anchored to a node id rather than to a column**, which is the whole of what moving them off
   * the canvas bought: the old stage notes were placed at `stageNote(col, …)` and had to be kept
   * clear of each other and of the deepest row of cards, and the arithmetic for that had already
   * been wrong once — the y was a constant chosen when every chain was a single row, and a paths
   * query's second head landed on top of it.
   *
   * `nodes[0]` is the analysis head at column 2 in every arm that has one. Two arms make that
   * read oddly and both are right: `neurons` has no analysis and is skipped, and morphology with
   * only a Neuroglancer cell ticked has the *viewer* as its column-2 node — so the analysis hint
   * and the view hint land on the same card and stack, which is what the two notes did when they
   * shared a column, minus the stacking arithmetic.
   *
   * One hint per stage even when several viewers were ticked: the first of them, for the reason
   * the note had — a stack of boxes down the side of a row of cards is not three times as useful.
   */
  const hints = new Map<string, NodeHint[]>()
  let overview: GraphNode | undefined
  if (answers.notes) {
    overview = overviewNote(answers)
    const dock = (nodeId: string | undefined, hint: WizardHint | undefined) => {
      if (!nodeId || !hint?.text.trim()) return
      // Spread, not rebuilt field by field: `WizardHint` is `NodeHint` minus `side`, so a field
      // added to one arrives here rather than being silently dropped by a hand-written copy.
      hints.set(nodeId, [...(hints.get(nodeId) ?? []), { ...hint }])
    }
    /*
     * The start hint on the **first** head only, even where a comparison built four. Every one of
     * them is the same card asking the same thing, and four identical boxes down the left of a
     * canvas is the failure the stage notes had — one hint per stage is the rule, and "per
     * stage" does not become "per dataset" because a stage grew a second card.
     */
    dock(heads[0]?.node.id, startOption(answers.start)?.hint)
    if (answers.analysis !== 'neurons') {
      dock(body.nodes[0]?.id, analysisOption(answers.analysis)?.hint)
    }
    dock(body.viewId, visualisationOption(answers.visualisations[0] ?? 'table')?.hint)
  }

  const graph = assemble(answers, nodes, overview, links, shift, hints)
  // One frame per chain, folded in the order the datasets were chosen. `foldChain` leaves a
  // single-card chain alone, which is BANC's — so a FlyWire/BANC comparison gets one frame and
  // one bare card rather than a box around nothing.
  const folded = chains.reduce((graph, chain) => foldChain(graph, chain), graph)
  return dashboardFor(
    folded,
    answers,
    heads.map((head) => head.node.id),
  )
}

/**
 * The dashboard layout, when the reader asked to be handed the grid rather than the canvas.
 *
 * **The cells are the control and the viewers**, in that order — the composition "Build a
 * Dashboard" teaches, and the only one a generated workflow can know is right: one widget chooses
 * and the others follow. The head is that widget whichever it is (an Explore card to tick in, a
 * Find Neurons card to change the filter on, a box to paste ids into), so a dashboard built from
 * these cells can be *steered* rather than only read. Everything between them is the plumbing,
 * and a grid of plumbing is a canvas with worse ergonomics.
 *
 * **Two columns unless there is one cell**, and the heights follow from that: cells that fit on a
 * single row get the whole height, and anything more falls back to the half `DEFAULT_ROW_SPAN`
 * gives them, which is a 2 × n grid. One rule rather than a table of compositions, so a fourth
 * viewer cannot land somewhere nobody has looked at.
 *
 * `setViewOpen` is composed *around* the mutators rather than called after them, which is the
 * arrangement `core/dashboard.ts` asks for: the layout and the flag saying it is the view arrive
 * together, so there is no moment where the graph has a dashboard that does not know it is being
 * looked at.
 */
function dashboardFor(
  graph: CodaGraph,
  answers: WizardAnswers,
  /** Every head, in dataset order — a comparison has one per connectome. */
  headIds: readonly string[],
): CodaGraph {
  if (!answers.dashboard) return graph
  const viewers = graph.nodes
    .filter((node) => node.id === 'view' || /^view\d+$/.test(node.id))
    .map((node) => node.id)
  const cells = [...headIds, ...viewers]
  const columns = cells.length > 1 ? DEFAULT_COLUMNS : MIN_COLUMNS
  const placed = setColumns(addCells(graph, cells), columns)
  const full = cells.length <= columns
  return setViewOpen(
    full ? cells.reduce((g, id) => setSpan(g, id, { h: ROW_TRACKS }), placed) : placed,
    true,
  )
}

// ---------------------------------------------------------------------------

/**
 * How many neurons a generated search asks for.
 *
 * Three answers, and each is about what the *rest* of the chain will do with them. Morphology
 * downloads geometry per neuron, so it is capped tightly whatever the dataset. A published
 * dataset is capped because auto-run is on by default, and the *first filter the reader types*
 * can perfectly well be `type is not empty` — the cap is no longer about what the node does on
 * arrival, since an unfiltered Find Neurons now returns nothing and fires no query at all, but
 * it is still the thing between one impatient row and a whole-connectome download. The synthetic
 * dataset is 401 neurons that never leave the browser, so it gets the whole of itself.
 */
function searchLimit(answers: WizardAnswers, synthetic: boolean): number {
  /*
   * Always for the arms that fetch a skeleton per neuron *and* compare every pair: the work grows
   * with the square of the set, so an uncapped search here is the one answer in the wizard that
   * can spend minutes before it draws anything. Sharper across datasets than within one, since
   * the all-by-all runs over the *combined* set — two uncapped searches square their sum rather
   * than each other. `xmorphology` is here rather than below because its only viewer is the 3D
   * scene, so there is no ticked set that downloads nothing.
   */
  if (GEOMETRY_ANALYSES.has(answers.analysis)) return GEOMETRY_LIMIT
  /*
   * And only when something is actually going to fetch geometry — a single-dataset morphology
   * workflow whose one ticked viewer is Neuroglancer downloads nothing.
   */
  if (answers.analysis === 'morphology' && answers.visualisations.includes('viewer3d')) {
    return GEOMETRY_LIMIT
  }
  return synthetic ? 0 : SEARCH_LIMIT
}

/**
 * How far apart two head cards sit, in node heights.
 *
 * Measured rather than chosen: the clearance an Explore card needs from the one under it. One
 * reader — the paths query's second end, which is a second head on the *same* dataset. "Which
 * neurons?" is answered once and the second card starts empty, because a wizard that asked twice
 * would be asking a reader who has not yet been told there are two ends.
 */
const ARM_ROW = 2

/**
 * How far apart two **datasets** sit, in node heights — larger than `ARM_ROW`, and the extra row
 * is a card neither builder places.
 *
 * A published dataset node arrives with its Description companion, which `addNodeWithCompanion`
 * puts 300px below it (`NodeDefinition.companion.offset`) — so a band that only cleared the head
 * cards put the first dataset's credit card on top of the second dataset's node, at the same x
 * and 80px apart. Found by `placeGuards.test.ts` at four datasets and invisible at two, because
 * two bands is one gap and the clash needs a *following* dataset to land in.
 *
 * Two constants rather than one raised to cover both, because they measure different things: a
 * second head is a second card of the same kind, and a second dataset is a card plus everything
 * the dataset drags along with it. Raising `ARM_ROW` to match would space a paths query's two
 * searches for a companion neither of them has.
 */
const DATASET_ROW = 3

/**
 * The dataset node's id for the nth dataset, and every other per-dataset card's suffix rule.
 *
 * `ds`, `ds2`, `ds3` — the first keeps the name every single-dataset workflow has always had, so
 * a saved file, a share link and the thirty test files that name `ds` all go on meaning the same
 * node when somebody picks a second dataset. `viewNode` follows the same rule for `view`, and it
 * is the same rule again for `find`/`find2` inside `headOf`.
 */
function suffixed(base: string, which: number): string {
  return which === 1 ? base : `${base}${which}`
}

/** The node the neurons come from, what its outgoing port is called, and where it reads from. */
interface Head {
  node: Placement
  port: [string, string]
  links: Link[]
  /**
   * The dataset node this head reads from.
   *
   * Carried rather than re-derived, because `bodyOf` needs it for every per-dataset card it
   * wires and the only other way to get it is to mirror `buildWorkflow`'s id-minting loop. Two
   * facts about one dataset — which node holds it and which port carries its neurons — should
   * not be one carried and one reconstructed by convention: change the suffix rule and the
   * reconstruction addresses a node that does not exist, which `assembleGraph` drops silently.
   */
  datasetId: string
}

/**
 * One dataset's head card.
 *
 * `which` is the id suffix; `datasetId` is passed separately rather than derived from it, because
 * the two come apart in exactly one place — a paths query's second head is `find2` on dataset
 * `ds`, the same dataset asked a second question. Deriving one from the other would wire that
 * card to a dataset node that does not exist.
 *
 * The family is passed resolved rather than looked up again: every caller is holding it already,
 * and `datasetFamily` is a scan of the table.
 */
function headOf(
  answers: WizardAnswers,
  /** This head's family, already resolved. `undefined` for a key the table does not know. */
  family: DatasetFamily | undefined,
  which: number,
  /** The dataset node this head reads from. */
  datasetId: string,
  /** The band this dataset's arm is laid out on, in node heights. */
  row: number,
  /** The chain actually being built, or undefined — never the family's, see `BuildOptions`. */
  chain?: AnnotationChain | undefined,
): Head {
  const synthetic = Boolean(family?.synthetic)
  const id = (base: string) => suffixed(base, which)
  if (answers.start === 'browse') {
    /*
     * `Additional tags`, where the dataset's chain folds community text into a column of its own.
     * Without it the wizard built `foldTags` and the Join and then drew no tag row — half the
     * chain's second arm doing nothing visible, which is the failure `AnnotationChain.tagColumn`
     * exists to stop and which the starter had always avoided by setting this by hand.
     */
    return {
      node: {
        id: id('explore'),
        type: 'neuron.explore',
        col: 1,
        row,
        ...(chain?.tagColumn ? { params: { tagColumn: chain.tagColumn } } : {}),
      },
      // `selected`, not `hits`: an empty search is the whole dataset, and a workflow whose first
      // Run pushes 165,000 rows into a viewer teaches the wrong thing about what to wire.
      port: [id('explore'), 'selected'],
      links: [[datasetId, 'dataset', id('explore'), 'dataset']],
      datasetId,
    }
  }
  if (answers.start === 'ids') {
    return {
      node: { id: id('ids'), type: 'neuron.inputIds', col: 1, row },
      port: [id('ids'), 'neurons'],
      links: [[datasetId, 'dataset', id('ids'), 'dataset']],
      datasetId,
    }
  }
  const limit = searchLimit(answers, synthetic)
  // One object rather than a conditional `params` key: `graphNode` spreads it over
  // `defaultParams`, so `{}` and absent are the same arrival.
  const params = { ...(limit ? { limit } : {}), ...seedFilters(synthetic) }
  return {
    node: { id: id('find'), type: 'neuron.findNeurons', col: 1, row, params },
    port: [id('find'), 'neurons'],
    links: [[datasetId, 'dataset', id('find'), 'dataset']],
    datasetId,
  }
}

/**
 * The one filter row a generated search arrives carrying — **on the synthetic dataset only**.
 *
 * A Find Neurons with no filters returns no neurons (`nodes/lib/findNeuronsRows.ts`), so a
 * generated Structured Search would otherwise arrive drawing empty cards all the way down. That
 * is the right answer for a published dataset and the wrong one here, and the asymmetry is about
 * who is looking: the synthetic dataset is what the tour walks, what the start page opens and
 * what a node guide's demo link builds, and every one of those is somebody being *shown* the
 * shape of a workflow rather than asking a question of their own. An empty chain shows nothing.
 * Against hemibrain the same card is a question nobody has asked yet, and the start's own hint
 * says so.
 *
 * `neuronId is not empty` rather than a type: it is exactly "everything", so the demo returns the
 * 401 neurons it always did — the seeding changes what is *written on the card*, not what comes
 * back. And it is a real row on a real card, so the first thing the reader can do to it is what
 * they will have to do on a published dataset: edit it, or delete it and write their own.
 * `ID_COLUMN_NAME` rather than the literal, for invariant 8's reason.
 */
function seedFilters(synthetic: boolean): { filters?: string[] } {
  if (!synthetic) return {}
  return { filters: encodeRows([{ field: ID_COLUMN_NAME, op: 'notEmpty', values: [] }]) }
}

/**
 * The node one chosen viewer ends on, read from the one table that pairs a viewer with an
 * analysis.
 *
 * `VIEWS` is `options.ts`'s, and it is what the dialog offered from — so the viewer built here
 * cannot be one the reader was not shown, and its params cannot disagree with the claim that made
 * the pair legal. This used to be a nested ternary per arm; see `VIEWS` for how those drifted.
 *
 * **Ids are `view`, then `view2`, `view3`** in the order they were ticked. The first keeps the
 * name every one-viewer workflow has always had, so a saved file, a share link and a test that
 * names `view` all go on meaning the same node when somebody ticks a second box.
 */
function viewNode(
  answers: WizardAnswers,
  visualisation: VisualisationId,
  index: number,
  col: number,
  row: number,
  dx: number,
): Placement {
  const spec = VIEWS[answers.analysis][visualisation]
  return {
    id: index === 0 ? 'view' : `view${index + 1}`,
    type: spec?.type ?? 'out.table',
    col,
    row,
    dx,
    ...(spec?.params ? { params: spec.params } : {}),
  }
}

/**
 * The `Match Cell Types` card every cross-dataset connectivity arm is built around.
 *
 * Two arms build it and they must build the *same* one: a mapping is not composable — a
 * three-dataset correspondence is not two two-dataset ones chained, which is what the variadic
 * ports are for — so a second spelling here would be a second mapping with no way to tell which
 * one a workflow was read off.
 *
 * **It takes the Dataset nodes, not the neuron tables.** Decision 4 in `docs/comparative.md`: the
 * evidence that `A_a` and `A_b` split from `X` very often sits entirely outside the neurons you
 * selected, so a mapper fed a selection gives a different answer for the same two neurons
 * depending on what else the graph happened to query. That is also why the annotation chain is
 * built for every dataset in a comparison — the chain is where a CAVE datastack's typing comes
 * from, and this node reads the dataset's whole annotated table.
 *
 * The type columns come from `DatasetFamily.typeColumns`, because the node's own pickers are
 * empty by default and `validate` refuses an empty one by name. A family that declares none
 * leaves its picker empty and the card says which dataset to pick columns for — which is the
 * honest answer where nobody has made that judgement, and better than a guessed column that is
 * silently dropped for not existing.
 */
function mapperNode(
  bands: readonly Band[],
  col: number,
  row: number,
): { node: Placement; links: Link[] } {
  const params: Record<string, unknown> = { datasetCount: bands.length }
  bands.forEach((band, index) => {
    const columns = datasetFamily(band.key)?.typeColumns
    if (columns?.length) params[repeatParamId('types', index + 1)] = [...columns]
  })
  return {
    node: { id: 'match', type: 'compare.matchTypes', col, row, params },
    links: bands.map((band, index): Link => [
      band.id,
      'dataset',
      'match',
      portIdAt('dataset', index + 1),
    ]),
  }
}

/**
 * One dataset in a cross-dataset workflow: which family it is, and which node on the canvas holds
 * it. The two facts every per-dataset card needs, carried together rather than one of them
 * re-minted from an index — see `Head.datasetId`.
 */
interface Band {
  id: string
  key: string
}

/**
 * Two to four collections folded into one, through a chain of two-input stacks.
 *
 * Both stack nodes take exactly two inputs and say so — `Stack Neurons`' own header records that
 * three collections are a chain — so N datasets are N−1 cards, each taking what the last one
 * produced. At two, which is the case anybody is actually building, it is one card.
 *
 * **Each level needs its own source column, and that is a rule of the node rather than a choice
 * here**: `stackTables` throws where the column it is about to add already exists in either
 * input, so a chain that named them all `dataset` would build a graph that refuses on Run. So
 * level 2 writes the name it was given and each level above writes that name suffixed, with its
 * top label naming everything accumulated so far. The *outermost* column is therefore the one
 * that partitions the whole collection, and it is what the 3D scene is pointed at; the inner
 * ones are still there, one click away in the colour picker, and split the earlier datasets
 * apart again.
 *
 * `sourceColumn` absent adds none, which is what the table side wants: a co-clustering has
 * already been through `Qualify Ids`, so its rows carry their dataset *in the id* — which is the
 * whole of decision 1, and a second column saying the same thing would be a second key.
 */
interface StackChain {
  nodes: Placement[]
  links: Link[]
  /** What the fold produced: the last stack's output, or the lone input where there was one. */
  out: [string, string]
  /** How many columns it consumed, so the caller can place what comes after it. */
  cols: number
  /** The column that partitions the whole result, or undefined where none was added. */
  sourceColumn?: string
}

/**
 * How `Similarity Matrix` reads what `Partner Vectors` wrote.
 *
 * These are that node's **output column names**, so the two arms that go through it — the
 * single-dataset `cluster` and the cross-dataset `coclust` — must agree, and a rename upstream
 * has to reach both. Written out twice, a rename fixes whichever arm somebody was looking at and
 * leaves the other pointing at columns that do not exist.
 *
 * A long table already *is* the matrix, in the coordinate form every sparse library starts
 * from — see `docs/nodes.md`.
 */
const VECTOR_SIMILARITY = {
  layout: 'long',
  observations: 'neuronId',
  features: 'feature',
  value: 'weight',
} as const

/**
 * The Connectivity both clustering arms open on.
 *
 * **Both directions**, because a neuron that *receives* from a type and one that projects to it
 * are not alike for it — Partner Vectors keeps the two apart with its `out:`/`in:` prefix, and
 * asking for one direction throws half the evidence away before it can.
 */
const VECTOR_CONNECTIVITY = { direction: 'both', minWeight: 3 } as const

/** Level 2 writes the name it was given; each level above suffixes it with its own level. */
function levelColumn(base: string, level: number): string {
  return level === 2 ? base : `${base}${level}`
}

function stackChain(spec: {
  type: 'core.stack' | 'neuron.stack'
  /** `[nodeId, port]` per dataset, in the order they were chosen. */
  inputs: readonly [string, string][]
  /** What each dataset is called in the source column. Ignored where none is added. */
  labels: readonly string[]
  col: number
  row: number
  sourceColumn?: string
}): StackChain {
  const nodes: Placement[] = []
  const links: Link[] = []
  let out = spec.inputs[0] ?? (['ds', 'dataset'] as [string, string])
  let column: string | undefined

  spec.inputs.slice(1).forEach((input, offset) => {
    const level = offset + 2
    const id = suffixed('stack', level)
    column = spec.sourceColumn ? levelColumn(spec.sourceColumn, level) : undefined
    nodes.push({
      id,
      type: spec.type,
      col: spec.col + offset,
      row: spec.row + offset * 0.5,
      params: column
        ? {
            sourceColumn: column,
            // Everything already folded in on one side, the newly arriving dataset on the other.
            // At two datasets — the case this is nearly always built for — that is just the two
            // names.
            topLabel: spec.labels.slice(0, level - 1).join(' + '),
            bottomLabel: spec.labels[level - 1] ?? `Dataset ${level}`,
          }
        : {},
    })
    links.push([out[0], out[1], id, 'top'], [input[0], input[1], id, 'bottom'])
    out = [id, 'out']
  })

  return {
    nodes,
    links,
    out,
    cols: Math.max(0, spec.inputs.length - 1),
    ...(column ? { sourceColumn: column } : {}),
  }
}

/**
 * Everything downstream of the head: the analysis, and every viewer that was ticked.
 *
 * One arm per analysis. Each arm builds the chain its analysis needs *once* and then hangs the
 * chosen viewers off it — several, because the fourth question takes a set: a table and a bar
 * chart of the same ranked partners is two nodes on one port, not two workflows. They stack down
 * the same column, `VIEW_PITCH` apart.
 *
 * `viewId` comes back because the closing hint docks to the first viewer, and only the arm knows
 * which node that is.
 */
function bodyOf(
  answers: WizardAnswers,
  /** One head per dataset, in the order they were chosen. */
  heads: readonly Head[],
  targets?: [string, string],
): { nodes: Placement[]; links: Link[]; viewId: string | undefined } {
  /**
   * The nth dataset's neurons. The fallback is reachable: the dialog previews a graph while the
   * datasets question is still open, which is `datasets: []` and so no heads at all.
   */
  const neuronsAt = (index: number, to: string, toPort: string): Link => {
    const [from, port] = heads[index]?.port ?? ['ds', 'dataset']
    return [from, port, to, toPort]
  }
  const neurons = (to: string, toPort: string): Link => neuronsAt(0, to, toPort)
  /** The nth dataset node — read off the head rather than re-minted. See `Head.datasetId`. */
  const datasetAt = (index: number) => heads[index]?.datasetId ?? 'ds'
  /**
   * The two wires every per-dataset card in a cross-dataset arm opens with: the dataset it
   * belongs to, and that dataset's own neurons. Written out three times before this, once per
   * arm, each spelling the index twice.
   */
  const opensOn = (index: number, to: string, toPort = 'neurons'): Link[] => [
    [datasetAt(index), 'dataset', to, 'dataset'],
    neuronsAt(index, to, toPort),
  ]
  const keys = answers.datasets
  /** Each dataset's family and its node on the canvas, paired once. */
  const bands: Band[] = keys.map((key, index) => ({ id: datasetAt(index), key }))
  /**
   * The row a card shared by every dataset sits on: halfway down the band of arms.
   *
   * Zero at one dataset, so every single-dataset arm below is unchanged. The arms run down and
   * the chain runs right, which is what keeps a four-dataset comparison the same *shape* as a
   * two-dataset one — and it is only a starting arrangement in any case, since a generated
   * workflow asks the canvas for one ELK pass on arrival.
   */
  const mid = ((keys.length - 1) * DATASET_ROW) / 2
  /** The far end of a paths query, which is the only analysis that has one. */
  const targetNeurons = (to: string, toPort: string): Link =>
    targets ? [targets[0], targets[1], to, toPort] : neurons(to, toPort)
  const chosen = answers.visualisations

  /**
   * The ticked viewers, placed down one column, and a wire per viewer from whoever feeds it.
   *
   * `wire` is the arm's answer to "what feeds a viewer of this kind" — usually one port for all
   * of them, but `matrix` feeds its table and its heatmap from different places, which is the
   * whole reason this takes a function rather than a port.
   */
  const views = (
    col: number,
    baseRow: number,
    wire: (visualisation: VisualisationId, id: string) => Link[],
  ): { nodes: Placement[]; links: Link[]; viewId: string | undefined } => {
    /*
     * **Side by side, and stepped by each card's real width** rather than stacked.
     *
     * Stacked was the first shape and it was wrong the moment the graph ran: a viewer's height is
     * its *content*, so an unrun Table card is short and a run one is 387px (a Bar Chart, 428) —
     * measured in a browser, against a pitch chosen for an ordinary node. The two cards overlapped
     * as soon as the reader pressed Run, which is the one moment they are looking at them.
     * A width is declared and does not move: `cardWidth` reads the three places it can be said,
     * and stepping by it is what `placeGuards.test.ts` already checks the whole graph for.
     */
    let dx = 0
    const nodes = chosen.map((visualisation, index) => {
      const node = viewNode(answers, visualisation, index, col, baseRow, dx)
      dx += Math.max(COL_WIDTH, cardWidth(node.type) + CARD_GAP)
      return node
    })
    return {
      nodes,
      links: nodes.flatMap((node, index) => wire(chosen[index]!, node.id)),
      /*
       * The first viewer's id rather than the column. The closing hint docks to that card, and a
       * column no longer says which node it is — several viewers share one column, stepped by
       * `dx`, and the arm is the only thing that knows their ids. Singular because only the first
       * is ever docked to: one hint per stage, for the reason the note it replaced had.
       */
      viewId: nodes[0]?.id,
    }
  }

  /*
   * The two wires a **self-fetching** viewer takes: the dataset and the neuron ids, and nothing
   * else. A Neuroglancer cell draws the published scene; a Neuron Topology card pulls the one
   * skeleton it is showing. Neither wants geometry an arm fetched for somebody else.
   *
   * `VIEWS` is what stops either being reachable from an analysis that does not offer it.
   */
  const scene = (id: string): Link[] => [
    ['ds', 'dataset', id, 'dataset'],
    neurons(id, 'neurons'),
  ]

  /**
   * What a chain ending on `cluster.linkage` hands each viewer: the dendrogram reads the tree,
   * the heatmap reads the matrix **reordered by** that tree — the pairing that makes a cluster
   * visible as a block rather than a scatter.
   *
   * Three arms end this way (`cluster`/`nblast`, `coclust`, `xnblast`) and each had written it
   * out, one of them without the sentence above. One rule, one spelling.
   */
  const fromLinkage = (visualisation: VisualisationId, id: string): Link[] =>
    visualisation === 'dendrogram'
      ? [['linkage', 'tree', id, 'in']]
      : [['linkage', 'ordered', id, 'in']]

  switch (answers.analysis) {
    case 'partners': {
      const tail = views(5, 0, (_visualisation, id) => [['sort', 'out', id, 'in']])
      return {
        nodes: [
          {
            id: 'conn',
            type: 'neuron.connectivity',
            col: 2,
            params: { direction: 'outputs', minWeight: 3 },
          },
          {
            id: 'group',
            type: 'core.groupBy',
            col: 3,
            params: { by: ['postType'], agg: 'sum', value: ['weight'] },
          },
          {
            id: 'sort',
            type: 'core.sort',
            col: 4,
            params: { column: 'sum_weight', descending: true, limit: 0 },
          },
          ...tail.nodes,
        ],
        links: [
          ['ds', 'dataset', 'conn', 'dataset'],
          neurons('conn', 'neurons'),
          ['conn', 'connections', 'group', 'in'],
          ['group', 'out', 'sort', 'in'],
          ...tail.links,
        ],
        viewId: tail.viewId,
      }
    }

    case 'matrix': {
      /*
       * Both axes come off the same set, which is what makes this one question rather than two:
       * "how do these connect to each other". The `links` output is a table, so the table viewer
       * takes that rather than the matrix — a matrix is not a table and the wire would not make.
       * The row-normalise is the heatmap's own, so it is built only when a heatmap was ticked.
       */
      const normalised = chosen.includes('heatmap')
      const tail = views(normalised ? 4 : 3, 0, (visualisation, id) =>
        visualisation === 'heatmap'
          ? [['norm', 'out', id, 'in']]
          : [['adj', 'links', id, 'in']],
      )
      return {
        nodes: [
          { id: 'adj', type: 'neuron.adjacency', col: 2, params: { groupByType: true } },
          ...(normalised
            ? [{ id: 'norm', type: 'core.normalize', col: 3, params: { mode: 'row' } }]
            : []),
          ...tail.nodes,
        ],
        links: [
          ['ds', 'dataset', 'adj', 'dataset'],
          neurons('adj', 'sources'),
          neurons('adj', 'targets'),
          ...(normalised ? ([['adj', 'matrix', 'norm', 'in']] as Link[]) : []),
          ...tail.links,
        ],
        viewId: tail.viewId,
      }
    }

    case 'influence': {
      /*
       * `Per query neuron` belongs to the **heatmap**, which is `matrix`'s row-normalise rule one
       * arm over: a queries x influencers picture needs the scores before they are summed across
       * the neurons somebody wired in, and a reader who only ticked the table has no use for one
       * row per pair. So the control follows the viewer rather than the analysis.
       *
       * Which makes the table's own upstream conditional on the *other* viewer, and that is the
       * one thing here worth reading twice. Ticked alone, the table reads the ranking straight
       * off the node. Ticked beside a heatmap, the node is emitting pairs, so a `Group By` puts
       * it back — the round trip the port is designed for, and the reason the totals are not a
       * second output.
       */
      const perQuery = chosen.includes('heatmap')
      const regroup = perQuery && chosen.includes('table')
      const viewCol = 3 + (perQuery ? 1 : 0) + (regroup ? 2 : 0)
      const tail = views(viewCol, 0, (visualisation, id) =>
        visualisation === 'heatmap'
          ? [['piv', 'matrix', id, 'in']]
          : [regroup ? ['sort', 'out', id, 'in'] : ['inf', 'influence', id, 'in']],
      )
      return {
        nodes: [
          {
            id: 'inf',
            type: 'neuron.influence',
            col: 2,
            params: { perQuery },
          },
          ...(perQuery
            ? [
                {
                  id: 'piv',
                  type: 'core.pivot',
                  col: 3,
                  // Type against type: a search over a whole dataset returns a mix, so this is
                  // the picture somebody can read. `queryId` on the columns keeps every query
                  // neuron as its own column, which is one edit away on the card.
                  params: {
                    rows: 'type',
                    columns: 'queryType',
                    value: 'influence',
                    agg: 'sum',
                  },
                },
              ]
            : []),
          ...(regroup
            ? [
                {
                  id: 'group',
                  type: 'core.groupBy',
                  col: 3,
                  row: 1,
                  params: { by: ['neuronId', 'type'], agg: 'sum', value: ['influence'] },
                },
                {
                  id: 'sort',
                  type: 'core.sort',
                  col: 4,
                  row: 1,
                  params: { column: 'sum_influence', descending: true, limit: 0 },
                },
              ]
            : []),
          ...tail.nodes,
        ],
        links: [
          ['ds', 'dataset', 'inf', 'dataset'],
          neurons('inf', 'neurons'),
          ...(perQuery ? ([['inf', 'influence', 'piv', 'in']] as Link[]) : []),
          ...(regroup
            ? ([
                ['inf', 'influence', 'group', 'in'],
                ['group', 'out', 'sort', 'in'],
              ] as Link[])
            : []),
          ...tail.links,
        ],
        viewId: tail.viewId,
      }
    }

    case 'paths': {
      /*
       * The one arm with two heads. `paths` answers with a network *and* a layout for it, and the
       * network viewer takes both — a path graph laid out by force is a hairball where the hop
       * count is the whole point, so the geometry the query already knows is handed over rather
       * than recomputed. The table viewer takes the `paths` port, which is one row per path.
       */
      const tail = views(3, 0, (visualisation, id) =>
        visualisation === 'network'
          ? [
              ['paths', 'network', id, 'in'],
              ['paths', 'layout', id, 'layout'],
            ]
          : [['paths', 'paths', id, 'in']],
      )
      return {
        nodes: [{ id: 'paths', type: 'neuron.paths', col: 2, row: 1 }, ...tail.nodes],
        links: [
          ['ds', 'dataset', 'paths', 'dataset'],
          neurons('paths', 'sources'),
          targetNeurons('paths', 'targets'),
          ...tail.links,
        ],
        viewId: tail.viewId,
      }
    }

    case 'cluster':
    case 'nblast': {
      /*
       * Two routes to the same place: a square matrix of how alike every pair is, through Linkage
       * and out to a tree. What differs is only how the matrix is made — partner vectors and a
       * similarity metric for the wiring, an all-by-all NBLAST over skeletons for the shape — so
       * the tail is shared and the two heads of the chain are the arm.
       *
       * `Similarity Matrix → Linkage` needs nothing configured: the matrix carries its `measure`,
       * and Linkage inverts a similarity and leaves a distance alone by reading exactly that.
       */
      const shape = answers.analysis === 'nblast'
      const tail = views(shape ? 5 : 6, 0, fromLinkage)
      const upstream: Placement[] = shape
        ? [
            { id: 'skel', type: 'neuron.skeletons', col: 2 },
            { id: 'nblast', type: 'neuron.nblast', col: 3 },
          ]
        : [
            { id: 'conn', type: 'neuron.connectivity', col: 2, params: VECTOR_CONNECTIVITY },
            { id: 'vectors', type: 'neuron.partnerVectors', col: 3 },
            { id: 'sim', type: 'core.similarity', col: 4, params: VECTOR_SIMILARITY },
          ]
      return {
        nodes: [
          ...upstream,
          /*
           * Its own column, never stacked under the node that feeds it. Stacking it under NBLAST
           * was the first shape and the two cards overlapped once the graph ran — an NBLAST card
           * carrying its result is taller than a row — which is the same lesson the viewers
           * taught: heights are content and only widths are declared.
           */
          { id: 'linkage', type: 'cluster.linkage', col: shape ? 4 : 5 },
          ...tail.nodes,
        ],
        links: shape
          ? [
              ['ds', 'dataset', 'skel', 'dataset'],
              neurons('skel', 'neurons'),
              ['skel', 'skeletons', 'nblast', 'query'],
              ['nblast', 'scores', 'linkage', 'in'],
              ...tail.links,
            ]
          : [
              ['ds', 'dataset', 'conn', 'dataset'],
              neurons('conn', 'neurons'),
              ['conn', 'connections', 'vectors', 'in'],
              // The `Neurons` port says outright which end of each edge was the query, which the
              // derived route can only work out at hop 1.
              neurons('vectors', 'neurons'),
              ['vectors', 'out', 'sim', 'in'],
              ['sim', 'matrix', 'linkage', 'in'],
              ...tail.links,
            ],
        viewId: tail.viewId,
      }
    }

    case 'network': {
      const tail = views(5, 0, (_visualisation, id) => [['net', 'network', id, 'in']])
      return {
        nodes: [
          {
            id: 'conn',
            type: 'neuron.connectivity',
            col: 2,
            params: { direction: 'outputs', minWeight: 5 },
          },
          {
            id: 'group',
            type: 'core.groupBy',
            col: 3,
            // Both ends, because a network's edges are (source, target) pairs — grouping by the
            // partner alone would collapse every query neuron into one node.
            params: { by: ['preType', 'postType'], agg: 'sum', value: ['weight'] },
          },
          {
            id: 'net',
            type: 'net.build',
            col: 4,
            params: {
              source: 'preType',
              target: 'postType',
              weight: 'sum_weight',
              directed: true,
              aggregate: true,
            },
          },
          ...tail.nodes,
        ],
        links: [
          ['ds', 'dataset', 'conn', 'dataset'],
          neurons('conn', 'neurons'),
          ['conn', 'connections', 'group', 'in'],
          ['group', 'out', 'net', 'edges'],
          ...tail.links,
        ],
        viewId: tail.viewId,
      }
    }

    case 'morphology': {
      /*
       * The geometry queries belong to the 3D viewer, not to the analysis: a workflow whose only
       * ticked viewer is Neuroglancer wants the published scene and no download at all. Ticking
       * both gets one set of skeletons and both viewers.
       */
      const drawn = chosen.includes('viewer3d')
      // `familyCan`, the same reading `options.ts` gates the questions with: this is the *offer*
      // half of one decision, and a builder asking a different question from the dialog that
      // offered it is how a workflow comes to be built without a node it was shown with.
      const withSynapses = drawn && keys.every((key) => familyCan(key, 'synapses'))
      const tail = views(drawn ? 3 : 2, drawn ? 0.5 : 0, (visualisation, id) =>
        visualisation === 'viewer3d'
          ? [
              ['skel', 'skeletons', id, 'skeletons'],
              ...(withSynapses ? ([['syn', 'points', id, 'points']] as Link[]) : []),
            ]
          : scene(id),
      )
      return {
        nodes: [
          ...(drawn
            ? [
                {
                  id: 'skel',
                  type: 'neuron.skeletons',
                  col: 2,
                  row: withSynapses ? 0 : 0.5,
                },
              ]
            : []),
          ...(withSynapses
            ? [
                {
                  id: 'syn',
                  type: 'neuron.synapses',
                  col: 2,
                  row: 1.1,
                  params: { polarity: '', minWeight: 10 },
                },
              ]
            : []),
          ...tail.nodes.map((node) =>
            node.type === 'out.viewer3d'
              ? {
                  ...node,
                  /*
                   * The point channel only where there are synapse points to draw. `VIEWS` carries
                   * what the 3D viewer needs for the skeletons, which is true of every source;
                   * this arm adds what is true only when the second query is there.
                   */
                  params: {
                    ...(node.params ?? {}),
                    ...(withSynapses
                      ? {
                          pointColorMode: 'categorical',
                          pointColorBy: 'polarity',
                          pointSize: 90,
                        }
                      : {}),
                  },
                }
              : node,
          ),
        ],
        links: [
          ...(drawn
            ? ([['ds', 'dataset', 'skel', 'dataset'], neurons('skel', 'neurons')] as Link[])
            : []),
          ...(withSynapses
            ? ([['ds', 'dataset', 'syn', 'dataset'], neurons('syn', 'neurons')] as Link[])
            : []),
          ...tail.links,
        ],
        viewId: tail.viewId,
      }
    }

    case 'compare': {
      /*
       * The cross-dataset headline: one connectivity query per dataset, one mapping over all of
       * them, and a card that puts the same type pair's weight side by side. Five columns whatever
       * the arity — the arms are rows, not columns, which is what keeps a four-dataset comparison
       * the same shape as a two-dataset one.
       *
       * `Compare Connectivity` is **cheap**, so re-asking the question with a different `Min
       * weight` costs a pass over an edge list and nothing on anybody's server. The mapper above
       * it is `expensive` and reads every dataset's whole annotation table, which is why nothing
       * here re-fetches when that threshold moves.
       */
      const mapper = mapperNode(bands, 3, mid)
      const tail = views(5, mid, (_visualisation, id) => [['cmp', 'comparison', id, 'in']])
      return {
        nodes: [
          ...keys.map((_key, index): Placement => ({
            id: suffixed('conn', index + 1),
            type: 'neuron.connectivity',
            col: 2,
            row: index * DATASET_ROW,
            // Outputs, so every row is presynaptic → postsynaptic and the two ends the
            // comparison reads are `preId`/`postId` — which are `Compare Connectivity`'s own
            // declared defaults, so its three column pickers need nothing said here.
            params: { direction: 'outputs', minWeight: 3 },
          })),
          mapper.node,
          {
            id: 'cmp',
            type: 'compare.connectivity',
            col: 4,
            row: mid,
            params: { datasetCount: keys.length },
          },
          ...tail.nodes,
        ],
        links: [
          ...keys.flatMap((_key, index): Link[] => {
            const conn = suffixed('conn', index + 1)
            const slot = index + 1
            return [
              ...opensOn(index, conn),
              [conn, 'connections', 'cmp', portIdAt('edges', slot)],
              ['match', portIdAt('labels', slot), 'cmp', portIdAt('labels', slot)],
            ]
          }),
          ...mapper.links,
          ...tail.links,
        ],
        viewId: tail.viewId,
      }
    }

    case 'coclust': {
      /*
       * `cluster`'s chain with two cards inserted, and those two cards are the whole feature.
       *
       * **The feature axis is the shared label space**: `Match Cell Types`' output goes into each
       * `Partner Vectors`, so a partner is counted as the label both connectomes agree on rather
       * than as its own dataset's type — a feature outside that space can only exist in one of
       * them, so it can neither make two neurons alike nor tell them apart.
       *
       * **The observation axis is dataset-qualified**: `Qualify Ids` rewrites each id to
       * `dataset:id` before the tables meet, which is decision 1 in `docs/comparative.md` — a
       * composite key would need every join, dedupe and group-by downstream to carry a second
       * column, and forgetting it merges two different neurons in silence. The qualified form is
       * rejected by `isNeuronId`, so anything that would query it refuses loudly instead.
       *
       * Which is also why the Stack Tables below adds no source column: the dataset is in the id.
       */
      const mapper = mapperNode(bands, 3, mid)
      const stacks = stackChain({
        type: 'core.stack',
        inputs: keys.map((_key, index): [string, string] => [
          suffixed('qual', index + 1),
          'out',
        ]),
        labels: keys,
        col: 6,
        row: mid,
      })
      const simCol = 6 + stacks.cols
      const tail = views(simCol + 2, mid, fromLinkage)
      return {
        nodes: [
          ...keys.flatMap((key, index): Placement[] => {
            const which = index + 1
            const row = index * DATASET_ROW
            return [
              {
                id: suffixed('conn', which),
                type: 'neuron.connectivity',
                col: 2,
                row,
                params: VECTOR_CONNECTIVITY,
              },
              { id: suffixed('vectors', which), type: 'neuron.partnerVectors', col: 4, row },
              {
                id: suffixed('qual', which),
                type: 'core.qualifyIds',
                col: 5,
                row,
                // The family key, which is already the short name this param asks for — and the
                // one string that identifies the dataset everywhere else in the app.
                params: { prefix: key },
              },
            ]
          }),
          mapper.node,
          ...stacks.nodes,
          {
            id: 'sim',
            type: 'core.similarity',
            col: simCol,
            row: mid,
            params: VECTOR_SIMILARITY,
          },
          { id: 'linkage', type: 'cluster.linkage', col: simCol + 1, row: mid },
          ...tail.nodes,
        ],
        links: [
          ...keys.flatMap((_key, index): Link[] => {
            const which = index + 1
            const conn = suffixed('conn', which)
            const vectors = suffixed('vectors', which)
            return [
              ...opensOn(index, conn),
              [conn, 'connections', vectors, 'in'],
              // The `Neurons` port says outright which end of each edge was the query, which the
              // derived route can only work out at hop 1.
              neuronsAt(index, vectors, 'neurons'),
              ['match', portIdAt('labels', which), vectors, 'labels'],
              [vectors, 'out', suffixed('qual', which), 'in'],
            ]
          }),
          ...mapper.links,
          ...stacks.links,
          [stacks.out[0], stacks.out[1], 'sim', 'in'],
          ['sim', 'matrix', 'linkage', 'in'],
          ...tail.links,
        ],
        viewId: tail.viewId,
      }
    }

    case 'xmorphology':
    case 'xnblast': {
      /*
       * The other axis, and the one that needs no cell types at all: put every dataset's arbours
       * in one coordinate frame and then either draw them or compare their shapes.
       *
       * `Transform Neurons` per dataset, straight into `JRC2018U` — one hop each, rather than a
       * path found between two brain spaces — and then `Stack Neurons`, which **refuses** two
       * collections in unrelated spaces. That refusal is the reason both arms are gated on
       * `requiresTemplateSpace` two screens back: it is exactly the error a wizard must not walk
       * a reader into.
       */
      const shape = answers.analysis === 'xnblast'
      const stacks = stackChain({
        type: 'neuron.stack',
        inputs: keys.map((_key, index): [string, string] => [suffixed('xf', index + 1), 'out']),
        labels: keys.map((key) => datasetFamily(key)?.label ?? key),
        col: 4,
        row: mid,
        sourceColumn: STACK_SOURCE_COLUMN,
      })
      const after = 4 + stacks.cols
      const tail = views(shape ? after + 2 : after, mid, (visualisation, id) =>
        shape
          ? fromLinkage(visualisation, id)
          : [[stacks.out[0], stacks.out[1], id, 'skeletons']],
      )
      return {
        nodes: [
          ...keys.flatMap((_key, index): Placement[] => {
            const which = index + 1
            const row = index * DATASET_ROW
            return [
              { id: suffixed('skel', which), type: 'neuron.skeletons', col: 2, row },
              // No params: `Target` already defaults to the shared template and `Space` to
              // whatever the geometry arrived carrying, which is the pair the dataset stamped.
              { id: suffixed('xf', which), type: 'neuron.xform', col: 3, row },
            ]
          }),
          ...stacks.nodes,
          ...(shape
            ? [
                { id: 'nblast', type: 'neuron.nblast', col: after, row: mid },
                { id: 'linkage', type: 'cluster.linkage', col: after + 1, row: mid },
              ]
            : []),
          ...tail.nodes.map((node) =>
            node.type === 'out.viewer3d' && stacks.sourceColumn
              ? {
                  ...node,
                  /*
                   * The **outermost** stack's column, which is the one that partitions the whole
                   * collection — at two datasets that is `STACK_SOURCE_COLUMN` and `VIEWS`'
                   * declared value is already right; above two it is the suffixed one, for the
                   * reason `stackChain` records.
                   */
                  params: { ...(node.params ?? {}), skeletonColorBy: stacks.sourceColumn },
                }
              : node,
          ),
        ],
        links: [
          ...keys.flatMap((_key, index): Link[] => {
            const which = index + 1
            const skel = suffixed('skel', which)
            return [...opensOn(index, skel), [skel, 'skeletons', suffixed('xf', which), 'in']]
          }),
          ...stacks.links,
          ...(shape
            ? ([
                [stacks.out[0], stacks.out[1], 'nblast', 'query'],
                ['nblast', 'scores', 'linkage', 'in'],
              ] as Link[])
            : []),
          ...tail.links,
        ],
        viewId: tail.viewId,
      }
    }

    case 'neurons':
    default: {
      // No analysis: the neuron table straight into whatever was ticked, except the viewers that
      // fetch for themselves — those take the dataset too. Asked of the node rather than listed
      // by id; see `selfFetching`.
      const tail = views(2, 0, (visualisation, id) =>
        selfFetching(visualisation) ? scene(id) : [neurons(id, 'in')],
      )
      return tail
    }
  }
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * The four answers as the words that name them.
 *
 * One reader is the note above the chain and the other is the graph's own name and description;
 * each composed the same sentence from the same three option lookups, so rewording one moved the
 * canvas and the saved file apart.
 */
/** `a`, `a and b`, `a, b and c` — several viewers read as a sentence rather than a list. */
function listed(items: string[]): string {
  if (items.length < 2) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function answered(answers: WizardAnswers): {
  dataset: string
  start: string
  analysis: string
  view: string
} {
  return {
    /*
     * Every dataset, read as a sentence — `listed` is the same helper the viewers use, so a
     * comparison's name, description and overview note all say "FlyWire FAFB public and
     * Hemibrain" rather than three different abbreviations of it.
     */
    dataset: listed(answers.datasets.map((key) => datasetFamily(key)?.label ?? key)),
    start: startOption(answers.start)?.label.toLowerCase() ?? '',
    /*
     * Not lowercased, unlike the two beside it: these labels name *techniques* rather than
     * describe them, so "NBLAST clustering" would come out as "nblast clustering" — a term
     * spelled wrong in the graph's own name, its description and the note above the chain.
     */
    analysis: analysisOption(answers.analysis)?.label ?? '',
    view: listed(
      answers.visualisations.map((id) => visualisationOption(id)?.label.toLowerCase() ?? ''),
    ),
  }
}

/**
 * The one Text note a generated workflow still carries: the overview, above the chain.
 *
 * There used to be three more — one per stage, under the head, the analysis and the viewer. They
 * are hints now, docked to the cards they were about (`NodeHint`), which is where a sentence
 * saying "search and tick neurons **here**" always wanted to be: a note under column 2 has to be
 * read, matched to a card by its horizontal position, and then dismissed by deleting it. The
 * overview stays a note because it is about the *graph* rather than about any one card, and
 * because it is a paragraph with a heading — the length a note is for and a hint is not.
 *
 * So it is placed here rather than through a `Note` record and a stacking pass: with one note
 * left there is no column to line up, nothing to stack against and no id to derive from an index.
 * Its four numbers are literals because they always were — the geometry that had to be computed
 * belonged to the stage notes, and went with them.
 *
 * Built from the same option copy the dialog showed, so the canvas repeats the answers the reader
 * gave rather than describing them again in different words.
 */
function overviewNote(answers: WizardAnswers): GraphNode {
  const { dataset, start, analysis, view } = answered(answers)
  /*
   * Said where **any** dataset is synthetic, and the sentence is about the numbers rather than
   * about the workflow — so a comparison with one synthetic side is exactly the case a reader
   * most needs it for.
   */
  const synthetic = answers.datasets.some((key) => datasetFamily(key)?.synthetic)
    ? '\n\n*The dataset is synthetic, generated in your browser from a seed. The pipeline is the point; the numbers are not a finding.*'
    : ''
  return noteNode({
    id: 'note-overview',
    x: xOf(0, 0),
    y: GRID_ORIGIN.y - 230,
    width: 720,
    height: 200,
    text: `### ${dataset} · ${analysis}

    Built by the Workflow Wizard from four answers: **${dataset}**, neurons chosen by **${start}**, showing **${analysis}** as **${view}**.

    Read it left to right — each node takes what is on its left and hands something new to its right. Press Run, or ⇧R, to evaluate the chain. Every node here is an ordinary one: change anything, add anything, delete what you do not need.${synthetic}`,
  })
}

// ---------------------------------------------------------------------------

function place(
  { id, type, col, row = 0, dx = 0, params }: Placement,
  shift: number,
): GraphNode {
  return graphNode(
    id,
    type,
    { x: xOf(col, shift) + dx, y: GRID_ORIGIN.y + row * ROW_HEIGHT },
    params,
  )
}

/**
 * Nodes, the overview note and wires into a graph.
 *
 * The graph itself is `assembleGraph`, shared with the starters — see `assemble.ts`. What is here
 * is the wizard's own layout: placing a `Placement` on the grid, and docking each card's hints.
 *
 * **The hints are applied here rather than inside `place`**, which stays a pure Placement → grid
 * coordinates function. Two concerns threaded through one helper is how the second one comes to
 * be passed down two levels to be used once.
 */
function assemble(
  answers: WizardAnswers,
  nodes: Placement[],
  overview: GraphNode | undefined,
  links: Link[],
  shift: number,
  hints: ReadonlyMap<string, NodeHint[]>,
): CodaGraph {
  const { dataset, start, analysis, view } = answered(answers)
  const name = `${dataset} · ${analysis}`
  const description = `Built by the Workflow Wizard: ${dataset}, neurons chosen by ${start}, showing ${analysis} as ${view}.`

  const placed: GraphNode[] = nodes.map((spec) => {
    const node = place(spec, shift)
    const docked = hints.get(node.id)
    // Absent rather than empty, like every other optional field on a node: a `hints: []` in a
    // saved file is a key that says nothing, and a share link pays for it in the fragment.
    return docked?.length ? { ...node, hints: docked } : node
  })
  if (overview) placed.push(overview)
  return assembleGraph(name, description, placed, links)
}

// ---------------------------------------------------------------------------

/** The dataset every generated graph in a test runs on: synthetic, offline, deterministic. */
export const DEMO_DATASET = 'mock.opticlobe'

/**
 * A workflow on the synthetic dataset, for the places that need *a graph* rather than a
 * particular one: the Guided Tour's empty-canvas fallback, and the tests that want a realistic
 * pipeline on the canvas.
 *
 * It is the wizard's own output rather than a fixture beside it, which is the whole point of
 * where it lives: the graph the tests exercise is the graph the app ships.
 */
export function demoWorkflow(analysis: AnalysisId = 'partners', notes = true): CodaGraph {
  /*
   * The viewer this analysis offers first, read off `VIEWS` rather than listed. It was a third
   * table saying "the first one that analysis offers" and naming a different one; see `VIEWS`.
   */
  const [visualisation] = Object.keys(VIEWS[analysis]) as VisualisationId[]
  return buildWorkflow({
    datasets: [DEMO_DATASET],
    start: 'search',
    analysis,
    visualisations: [visualisation ?? 'table'],
    notes,
    // The demos are canvas graphs: the tour points at cards and the suites read node state.
    dashboard: false,
  })
}
