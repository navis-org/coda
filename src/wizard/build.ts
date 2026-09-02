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

import type { CodaGraph, GraphNode } from '../core/graph'
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
import { datasetFamily } from '../nodes/lib/datasetFamilies'
import type { AnalysisId, VisualisationId, WizardAnswers } from './options'
import { VIEWS, analysisOption, familyCan, startOption, visualisationOption } from './options'

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

interface Note {
  /** Column the note lines up with. */
  col: number
  /** Absolute y — notes sit above and below the pipeline, not in its rows. */
  y: number
  width: number
  height: number
  text: string
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
export function buildWorkflow(answers: WizardAnswers): CodaGraph {
  const family = datasetFamily(answers.dataset)
  const synthetic = Boolean(family?.synthetic)
  const shift = answers.start === 'browse' ? EXPLORE_SHIFT : 0

  const nodes: Placement[] = [{ id: 'ds', type: `dataset.${answers.dataset}`, col: 0 }]
  const links: Link[] = []
  const notes: Note[] = []

  // --- the head: whichever way the neurons are chosen ------------------------
  const head = headOf(answers, synthetic)
  nodes.push(head.node)
  links.push(...head.links)

  /*
   * A second one, for the one analysis whose question has two ends. It is built here rather than
   * inside the arm because it is a *head*: which card it is, and whether its search is capped,
   * are the first question's answers and not the third's.
   */
  const target = answers.analysis === 'paths' ? headOf(answers, synthetic, 2) : undefined
  if (target) {
    nodes.push(target.node)
    links.push(...target.links)
  }

  // --- the analysis, and the viewer that ends it ----------------------------
  const body = bodyOf(answers, head.port, target?.port)
  nodes.push(...body.nodes)
  links.push(...body.links)

  if (answers.notes) {
    /*
     * Under the deepest row of cards, rather than at a fixed height. The chains are not all one
     * row: morphology stacks its two geometry queries, and a paths query stacks a second head —
     * which landed exactly on the notes when this was a constant, because the constant had been
     * chosen when every chain was a single row. Derived from the same row numbers the cards were
     * placed at, so a future arm that stacks something takes the notes down with it.
     */
    const notesY =
      GRID_ORIGIN.y + (Math.max(...nodes.map((node) => node.row ?? 0)) + 1.2) * ROW_HEIGHT
    notes.push(overviewNote(answers), stageNote(1, startOption(answers.start)?.note, notesY))
    if (answers.analysis !== 'neurons') {
      notes.push(stageNote(2, analysisOption(answers.analysis)?.note, notesY))
    }
    // One note per column, so several viewers stacked in one column get the first one's note
    // rather than a stack of notes down the side of a stack of cards.
    notes.push(
      stageNote(body.viewColumn, visualisationOption(answers.visualisations[0] ?? 'table')?.note, notesY),
    )
  }

  return dashboardFor(assemble(answers, nodes, links, notes, shift), answers, head.node.id)
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
function dashboardFor(graph: CodaGraph, answers: WizardAnswers, headId: string): CodaGraph {
  if (!answers.dashboard) return graph
  const viewers = graph.nodes
    .filter((node) => node.id === 'view' || /^view\d+$/.test(node.id))
    .map((node) => node.id)
  const cells = [headId, ...viewers]
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
 * dataset is capped because auto-run is on by default and an uncapped search is a
 * whole-connectome query fired at a shared server the moment the graph lands. The synthetic
 * dataset is 401 neurons that never leave the browser, so it gets the whole of itself.
 */
function searchLimit(answers: WizardAnswers, synthetic: boolean): number {
  /*
   * Only when something is actually going to fetch geometry — a morphology workflow whose one
   * ticked viewer is Neuroglancer downloads nothing — and always for NBLAST, which fetches a
   * skeleton per neuron *and* compares every pair: the work grows with the square of the set, so
   * an uncapped search here is the one answer in the wizard that can spend minutes before it
   * draws anything.
   */
  if (answers.analysis === 'nblast') return GEOMETRY_LIMIT
  if (answers.analysis === 'morphology' && answers.visualisations.includes('viewer3d')) {
    return GEOMETRY_LIMIT
  }
  return synthetic ? 0 : SEARCH_LIMIT
}

/**
 * A path has two ends, so the paths analysis gets a second head — the same kind of card as the
 * first, stacked under it.
 *
 * Not two questions: "which neurons?" is answered once and the second card starts empty, because
 * a wizard that asked twice would be asking a reader who has not yet been told there are two ends
 * to fill in. The note under it says which is which. `PATHS_ROW` is measured rather than chosen —
 * see its own note.
 */
const PATHS_ROW = 2

/** The node the neurons come from, and what its outgoing port is called. */
function headOf(
  answers: WizardAnswers,
  synthetic: boolean,
  /** `2` for the second head of a paths query — see `PATHS_ROW`. Ids gain the suffix. */
  which = 1,
): { node: Placement; port: [string, string]; links: Link[] } {
  const id = (base: string) => (which === 1 ? base : `${base}${which}`)
  const row = which === 1 ? 0 : PATHS_ROW
  if (answers.start === 'browse') {
    return {
      node: { id: id('explore'), type: 'neuron.explore', col: 1, row },
      // `selected`, not `hits`: an empty search is the whole dataset, and a workflow whose first
      // Run pushes 165,000 rows into a viewer teaches the wrong thing about what to wire.
      port: [id('explore'), 'selected'],
      links: [['ds', 'dataset', id('explore'), 'dataset']],
    }
  }
  if (answers.start === 'ids') {
    return {
      node: { id: id('ids'), type: 'neuron.inputIds', col: 1, row },
      port: [id('ids'), 'neurons'],
      links: [['ds', 'dataset', id('ids'), 'dataset']],
    }
  }
  const limit = searchLimit(answers, synthetic)
  return {
    node: {
      id: id('find'),
      type: 'neuron.findNeurons',
      col: 1,
      row,
      ...(limit ? { params: { limit } } : {}),
    },
    port: [id('find'), 'neurons'],
    links: [['ds', 'dataset', id('find'), 'dataset']],
  }
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
 * Everything downstream of the head: the analysis, and every viewer that was ticked.
 *
 * One arm per analysis. Each arm builds the chain its analysis needs *once* and then hangs the
 * chosen viewers off it — several, because the fourth question takes a set: a table and a bar
 * chart of the same ranked partners is two nodes on one port, not two workflows. They stack down
 * the same column, `VIEW_PITCH` apart.
 *
 * `viewColumn` comes back because the closing note lines up with the viewers, and only the arm
 * knows how long its chain is.
 */
function bodyOf(
  answers: WizardAnswers,
  [from, port]: [string, string],
  targets?: [string, string],
): { nodes: Placement[]; links: Link[]; viewColumn: number } {
  const neurons = (to: string, toPort: string): Link => [from, port, to, toPort]
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
  ): { nodes: Placement[]; links: Link[]; viewColumn: number } => {
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
      viewColumn: col,
    }
  }

  /*
   * A Neuroglancer cell draws the *published scene*, so it takes the dataset and the neuron ids
   * and nothing else — the same two wires wherever it is offered, and never a reason to fetch
   * geometry nobody looks at. `VIEWS` is what stops it being reachable from an analysis that does
   * not offer it.
   */
  const scene = (id: string): Link[] => [
    ['ds', 'dataset', id, 'dataset'],
    neurons(id, 'neurons'),
  ]

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
        viewColumn: tail.viewColumn,
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
        viewColumn: tail.viewColumn,
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
        viewColumn: tail.viewColumn,
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
        viewColumn: tail.viewColumn,
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
      const tail = views(shape ? 5 : 6, 0, (visualisation, id) =>
        // The dendrogram reads the tree; the heatmap reads the matrix *reordered by* that tree,
        // which is what makes a cluster visible as a block.
        visualisation === 'dendrogram'
          ? [['linkage', 'tree', id, 'in']]
          : [['linkage', 'ordered', id, 'in']],
      )
      const upstream: Placement[] = shape
        ? [
            { id: 'skel', type: 'neuron.skeletons', col: 2 },
            { id: 'nblast', type: 'neuron.nblast', col: 3 },
          ]
        : [
            {
              id: 'conn',
              type: 'neuron.connectivity',
              col: 2,
              // Both directions, because a neuron that *receives* from a type and one that
              // projects to it are not alike for it — Partner Vectors keeps the two apart with
              // its `out:`/`in:` prefix, and asking for one direction throws half the evidence
              // away before it can.
              params: { direction: 'both', minWeight: 3 },
            },
            { id: 'vectors', type: 'neuron.partnerVectors', col: 3 },
            {
              id: 'sim',
              type: 'core.similarity',
              col: 4,
              // The columns Partner Vectors writes. A long table already *is* the matrix, in the
              // coordinate form every sparse library starts from — see `docs/nodes.md`.
              params: {
                layout: 'long',
                observations: 'neuronId',
                features: 'feature',
                value: 'weight',
              },
            },
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
        viewColumn: tail.viewColumn,
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
        viewColumn: tail.viewColumn,
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
      const withSynapses = drawn && familyCan(answers.dataset, 'synapses')
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
                      ? { pointColorMode: 'categorical', pointColorBy: 'polarity', pointSize: 90 }
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
        viewColumn: tail.viewColumn,
      }
    }

    case 'neurons':
    default: {
      // No analysis: the neuron table straight into whatever was ticked.
      const tail = views(2, 0, (visualisation, id) =>
        visualisation === 'neuroglancer' ? scene(id) : [neurons(id, 'in')],
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
    dataset: datasetFamily(answers.dataset)?.label ?? answers.dataset,
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
 * The note above the chain: what this workflow does, and how to run it.
 *
 * Built from the same option copy the dialog showed, so the canvas repeats the answers the reader
 * gave rather than describing them again in different words.
 */
function overviewNote(answers: WizardAnswers): Note {
  const { dataset, start, analysis, view } = answered(answers)
  const family = datasetFamily(answers.dataset)
  const synthetic = family?.synthetic
    ? '\n\n*The dataset is synthetic, generated in your browser from a seed. The pipeline is the point; the numbers are not a finding.*'
    : ''
  return {
    col: 0,
    y: GRID_ORIGIN.y - 230,
    width: 720,
    height: 200,
    text: `### ${dataset} · ${analysis}

    Built by the Workflow Wizard from four answers: **${dataset}**, neurons chosen by **${start}**, showing **${analysis}** as **${view}**.

    Read it left to right — each node takes what is on its left and hands something new to its right. Press Run, or ⇧R, to evaluate the chain. Every node here is an ordinary one: change anything, add anything, delete what you do not need.${synthetic}`,
  }
}

/**
 * A one-paragraph note under the stage it is about. Skipped when the option carries none.
 *
 * **Narrower than a column**, which is the one geometric constraint on it: stage notes sit at
 * adjacent columns — the head, the analysis and the viewer can be columns 1, 2 and 3 — so a note
 * as wide as the 540px ones the examples used would overlap its neighbour. `placeGuards.test.ts`
 * walks every combination for exactly this.
 */
function stageNote(col: number, text: string | undefined, y: number): Note {
  return { col, y, width: COL_WIDTH - 60, height: 150, text: text ?? '' }
}

// ---------------------------------------------------------------------------

function place({ id, type, col, row = 0, dx = 0, params }: Placement, shift: number): GraphNode {
  return graphNode(
    id,
    type,
    { x: xOf(col, shift) + dx, y: GRID_ORIGIN.y + row * ROW_HEIGHT },
    params,
  )
}

/**
 * Nodes, notes and wires into a graph.
 *
 * The graph itself is `assembleGraph`, shared with the starters — see `assemble.ts`. What is
 * here is the wizard's own layout: placing a `Placement` on the grid, and stacking the notes.
 */
function assemble(
  answers: WizardAnswers,
  nodes: Placement[],
  links: Link[],
  notes: Note[],
  shift: number,
): CodaGraph {
  const { dataset, start, analysis, view } = answered(answers)
  const name = `${dataset} · ${analysis}`
  const description = `Built by the Workflow Wizard: ${dataset}, neurons chosen by ${start}, showing ${analysis} as ${view}.`

  const placed: GraphNode[] = nodes.map((spec) => place(spec, shift))
  /*
   * Stacked when two notes want the same column, which happens where a chain is short enough for
   * the analysis and the viewer to be the same stage — morphology drawn in Neuroglancer is one
   * node, not three. Without this the two notes are drawn on top of each other, and since both
   * are `note-<col>` they would also be one id twice. Ids come from the index for the same
   * reason: a note's column is not unique and an id has to be.
   */
  const perColumn = new Map<number, number>()
  notes.forEach((note, index) => {
    if (!note.text.trim()) return
    const stacked = perColumn.get(note.col) ?? 0
    perColumn.set(note.col, stacked + 1)
    placed.push(
      noteNode({
        id: `note-${index}`,
        x: xOf(note.col, shift),
        y: note.y + stacked * (note.height + 20),
        width: note.width,
        height: note.height,
        text: note.text,
      }),
    )
  })
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
    dataset: DEMO_DATASET,
    start: 'search',
    analysis,
    visualisations: [visualisation ?? 'table'],
    notes,
    // The demos are canvas graphs: the tour points at cards and the suites read node state.
    dashboard: false,
  })
}


