/**
 * A runnable workflow for one node type — what the node guide's "Open in a workflow" opens.
 *
 * The node guide describes every node in the registry; this answers the question a description
 * cannot, which is *what does a graph with this node in it look like*. See `docs/pages.md` for
 * why the obvious alternative — packing 102 graphs into the guide as share fragments — was
 * measured and rejected: 75 kB of base64 in a page whose static appendix is the half a crawler
 * and a language model actually read.
 *
 * It lives beside the wizard because that is what it is made of: `plansFor` is a projection of
 * `everyCombination`, `demoStart` is `resolveOption`, and the whole search is over the wizard's
 * own answer space.
 *
 * ## One rule, and the wizard does most of the work
 *
 * There is no table of demo graphs and no fixture directory. For a node type, walk the wizard's
 * own workflows in the order it offers them and take the first that can host the node:
 *
 *  1. **the workflow already containing it** — 37 of the 102 listable types are wizard nodes, and
 *     for those the demo *is* the graph the wizard would build, notes and all;
 *  2. **the first workflow that can feed it** — the node is appended to a port already carrying a
 *     compatible value, and a viewer is hung off whatever it produces.
 *
 * So a demo is always a real pipeline with a dataset at one end and something to look at at the
 * other, and it cannot drift: a node whose ports change gets wired differently the next time the
 * guide is built, with nothing to regenerate. `demo.test.ts` runs `inferGraph` over all 102,
 * which is the same standing `wizard.test.ts` holds every combination to.
 *
 * ## The search runs at build time; the link carries its answer
 *
 * `demoPlan` searches and `demoGraph` replays, and the split is not an optimisation — it is what
 * keeps a click on the guide from talking to three connectomes nobody asked about.
 *
 * The search scores candidates with `inferGraph`, and `inferOutputs` on a dataset node *peeks*:
 * it starts the listing it cannot answer synchronously, once per source, which is the contract
 * every source here keeps. Perfectly correct for a node somebody put on a canvas, and quite
 * wrong for forty speculative graphs — clicking "Open in a workflow" on **Filter Table** fired
 * project listings at two CATMAID servers and a datastack listing at CAVE, and the CAVE one has
 * no token, so a Connections dialog demanding one opened over a workflow about filtering a
 * table. Seen in a browser; jsdom reaches none of it, and neither does a Node-side probe that
 * only counts inference issues.
 *
 * So the plan — dataset, analysis, viewer, and which rank of the wiring search won — travels in
 * the link, about forty characters of it, and the app builds exactly one workflow: the one it is
 * about to show, whose single dataset node peeks its own source and nothing else. A bare
 * `demo://<type>` with no plan still works, for a link somebody typed, and falls back to the
 * synthetic dataset alone — where the same search costs no request at all.
 *
 * ## A dataset node is its own workflow
 *
 * Asked about `dataset.hemibrain`, this builds a *hemibrain* workflow rather than a synthetic one
 * with a hemibrain node bolted on — `buildWorkflow` already caps a search against a published
 * server, so the graph that opens is the one the wizard would have produced had somebody answered
 * its first question that way. Everything else demos on `DEMO_DATASET`, which is synthetic, runs
 * in the browser and needs no credential.
 *
 * ## Where the wiring rule bites
 *
 * **The first compatible port in node order wins, exact kinds ahead of widened ones.** Graph
 * order is the order the wizard placed the chain, so "first" means "furthest upstream", which is
 * what makes the choice read correctly rather than merely type-check: a Filter lands on the
 * connections a Connectivity just produced, not on the sorted table five nodes later, and a node
 * wanting `neurons` gets the query's own set rather than the partner set that also satisfies it.
 * Preferring an exact kind is what keeps a `neurons` port off a plain `table`, which
 * `isAssignable` allows in that direction and which would hand a Neuron ID column picker a table
 * that has no ids in it.
 */

import type { CodaGraph, GraphNode, NodeHint } from '../core/graph'
import { addEdge, nodePorts, updateNode } from '../core/graph'
import { addNodeWithCompanion } from '../core/companion'
import type { Socket } from '../core/sockets'
import { socketAccepts, socketOriginates } from '../core/sockets'
import type { CodaType } from '../core/types'
import { uniqueName } from '../core/types'
import { inferGraph, nodeTypes } from '../core/inference'
import { getNodeDef, listableNodeDefs } from '../core/registry'
import { defaultInputPorts, defaultOutputPorts } from '../core/ports'
import type { NodeDefinition, ResolvedPort } from '../core/node'
import { familyForNodeType } from '../nodes/lib/datasetFamilies'
import type { DemoPlanRef } from '../data/share/fragment'
import { DEMO_DATASET, buildWorkflow } from './build'
import type { AnalysisId, StartId, VisualisationId } from './options'
import { datasetOptions, everyCombination, resolveOption, startOptions } from './options'
import { CARD_GAP } from '../layout/columns'
import { boundsOf } from '../layout/place'
import { graphNode } from './assemble'

/** A place a wire can come from: a node already in the graph, and one of its output ports. */
interface Source {
  node: string
  port: string
  /** What that port carries, so `sourcesFor` can rank without asking the registry twice. */
  type: CodaType
}

/**
 * A plan whose names have been checked against what the wizard offers.
 *
 * The shape itself is `DemoPlanRef`, declared once in `data/share/fragment.ts` because that is
 * where it is parsed out of a link — this only narrows the two strings the builder has resolved.
 * `rank` is absent when the workflow already contains the node, which is the difference between
 * "the wizard would have built you this" and "this is the shortest chain that can feed it".
 */
export interface DemoPlan extends DemoPlanRef {
  analysis: AnalysisId
  view: VisualisationId
}

/**
 * Search for the workflow that shows this node type off, or undefined for one nothing can host.
 *
 * Run at build time — by `src/nodeguide/data.ts`, and by `demo.test.ts` — never on a click. See
 * the module note for why: scoring candidates means inferring over graphs whose dataset nodes
 * belong to every backend, and inference peeks.
 *
 * `undefined` is reachable in principle: a node whose required input is a type no wizard
 * workflow produces and no other node can make from one. `demo.test.ts` asserts that no listable
 * node reaches it today. It stays a return value rather than a throw because the node guide has
 * to decide whether to draw a link at all.
 */
export const demoPlan = keyed((type: string): DemoPlan | undefined => search(type)?.plan)

/**
 * Build the workflow a plan names, and put the node in it. What a `demo://` link opens, and what
 * the in-app `?` overlay's "Open in a workflow" builds.
 *
 * Deterministic and cheap with a plan: one `buildWorkflow`, and one wiring pass. Without one —
 * a link somebody typed, or the overlay, which has no guide build behind it — it searches, and
 * the two arguments to that search are what keep the click free of requests: **every dataset may
 * be built, only the synthetic one may be scored.** Building a workflow costs nothing, so the
 * containment half reaches the same answer the guide did for every node a wizard workflow
 * already holds — `out.neuroglancer` on MaleCNS included. Scoring runs `inferGraph`, which peeks
 * at a dataset node's source, so the append half stays on the mock connectome.
 *
 * What that costs is the handful of nodes that are *about* a backend and have to be appended —
 * Raw Cypher, the CAVE table nodes — where the guide's link opens a CAVE or neuPrint workflow
 * and this opens a synthetic one carrying the node's own "connect a neuPrint dataset" warning.
 * Three of the 64 documented nodes, against a `?` button that would otherwise fire listings at
 * three connectomes on being pressed.
 */
export function demoGraph(type: string, plan?: DemoPlanRef): CodaGraph | undefined {
  const graph =
    (plan && replay(type, plan)) ?? search(type, demoDatasets(), [DEMO_DATASET])?.graph
  return graph && withSwapHint(graph)
}

/**
 * Build exactly what a plan names, or nothing.
 *
 * **A plan that will not build is dropped, not refused** — the same policy `parseDemoRef` states
 * one layer down, for the same reason: the node type is the address and the plan is a fact about
 * the guide's build. A link made against last month's registry can name a rank a wiring rule has
 * since moved, or an analysis a dataset has stopped offering, and the reader who clicked it asked
 * to see *this node*. Falling back to the search costs them the exact workflow the guide
 * previewed; refusing costs them the feature. The one failure left is a node this build does not
 * have, which is the only thing `useShareLink` then has to say.
 */
function replay(type: string, plan: DemoPlanRef): CodaGraph | undefined {
  const def = getNodeDef(type)
  const graph = def && workflow(plan, ownDataset(type, plan.dataset))
  if (!graph) return undefined
  if (plan.rank === undefined) {
    return graph.nodes.some((node) => node.type === type) ? graph : undefined
  }
  return append(graph, def, plan.rank)?.graph
}

/**
 * The search itself: which workflow, and the graph it produced.
 *
 * Both halves come back because both callers want one of them and the append pass has already
 * built the graph — `demoPlan` throws the graph away at build time, and `demoGraph` with no plan
 * would otherwise re-run `workflow` and a second wiring pass to arrive at what it just had.
 */
function search(
  type: string,
  /** Datasets whose workflows may be *built*. Free: `buildWorkflow` asks nothing of a server. */
  buildable = demoDatasets(),
  /** Datasets whose candidates may be *scored*. `inferGraph` peeks, so a caller may narrow it. */
  scorable = buildable,
): { plan: DemoPlan; graph: CodaGraph } | undefined {
  const def = getNodeDef(type)
  if (!def) return undefined

  /*
   * A dataset node demos on itself. `familyForNodeType` is the one place that reads the
   * `dataset.<key>` prefix back, so this is the family's own key going straight into the
   * wizard's first answer — and it is found in the first workflow built, because every workflow
   * opens on its dataset.
   */
  const own = familyForNodeType(type)?.key
  const held = contains(type, own ? [own, ...buildable] : buildable)
  if (held) {
    const graph = workflow(held, ownDataset(type, held.dataset))
    if (graph) return { plan: held, graph }
  }
  return bestAppend(def, scorable)
}

/**
 * The hint on the synthetic dataset card: this is not a connectome, and here is what to do.
 *
 * **A hint rather than a note, because it is about one card.** `NodeHint` docks to the node and
 * travels with it — see `core/graph.ts` — and dismissing it is `localStorage` keyed on the text,
 * so a reader who has read it once does not read it again on the next forty demos. That keying
 * is also why the copy is written once here and not per node: reworded copy comes back for
 * everybody.
 *
 * **Only where the reader did not choose the dataset.** A wizard workflow on Demo Data was
 * *asked for* — the dialog offered every connectome and this is the answer somebody gave — where
 * a demo link hands over synthetic data to somebody who clicked "Open in a workflow" on Filter
 * Table and was thinking about filtering tables. The wizard's own overview note already says the
 * numbers are not a finding; what it does not say is that the card is replaceable, which is the
 * half a reader arriving from the node guide needs.
 *
 * Added after the node is appended rather than through `buildWorkflow`'s `hints` map, because
 * this is not one of the wizard's three stage hints and putting it there would attach it to
 * every workflow the dialog builds.
 */
function withSwapHint(graph: CodaGraph): CodaGraph {
  /*
   * Asked of the family's `synthetic` flag rather than matched against one node type, because
   * that flag *is* this question — it is what `build.ts` keys its own "the numbers are not a
   * finding" sentence on, and what `options.ts` sorts the dataset list by. The search walks every
   * family, so pinning the hint to one string would have been a coincidence holding.
   */
  const synthetic = graph.nodes.find((node) => familyForNodeType(node.type)?.synthetic)
  if (!synthetic) return graph
  // Through the generic node patch, which also prunes dangling edges — the rule every other
  // write to a node in this codebase goes by.
  return updateNode(graph, synthetic.id, { hints: [...(synthetic.hints ?? []), SWAP_HINT] })
}

/**
 * Two sentences, which is the ceiling — and here the ceiling is lower than it looks.
 *
 * A hint's box is its card's width, and a dataset card is one of the narrowest on the canvas, so
 * the first draft wrapped to six lines under it. Seen in a browser. It says the synthetic half
 * itself rather than leaning on the wizard's overview note, since a reader looking at the card is
 * not necessarily reading the note.
 *
 * Markdown subset, the same one the Text note renders, so the emphasis is real emphasis. `tip`
 * rather than `note`, because it names something to do.
 */
const SWAP_HINT: NodeHint = {
  text:
    '**The data here is synthetic.** Swap this card for a real connectome — Hemibrain, ' +
    'FlyWire, MaleCNS — and run the same chain against it.',
  tone: 'tip',
}

/**
 * The first workflow that already holds this node, per dataset, indexed once.
 *
 * **Asked across every family rather than only the synthetic one, and asked before anything is
 * appended.** Both halves are one finding. `out.neuroglancer` is a wizard viewer, but only where
 * the source publishes a scene, which the synthetic dataset does not — so a search that stopped
 * at `DEMO_DATASET` fell through to the append pass and produced a Neuroglancer card reading
 * "this data source publishes no neuroglancer scene", which is a demo of the refusal rather than
 * of the node. Every capability-gated viewer has that shape.
 *
 * `DEMO_DATASET` comes first in `demoDatasets`, so a node the synthetic dataset can host still
 * demos on it — which is what keeps most of the guide's links opening something that runs in the
 * browser with no credential.
 *
 * An index rather than a scan per node: the question is asked once per listable type, and
 * walking every dataset's workflows for each of them is 102 × 173 × the nodes in a graph to
 * learn something that is a property of the workflows alone. Built lazily and per dataset, so
 * `contains(type, [own])` for a dataset node pays for that family and no other.
 */
const hostsIn = keyed((dataset: string): ReadonlyMap<string, DemoPlan> => {
  const found = new Map<string, DemoPlan>()
  for (const plan of plansFor(dataset)) {
    for (const node of workflow(plan)?.nodes ?? []) {
      if (!found.has(node.type)) found.set(node.type, plan)
    }
  }
  return found
})

function contains(type: string, datasets: readonly string[]): DemoPlan | undefined {
  for (const dataset of datasets) {
    const plan = hostsIn(dataset).get(type)
    if (plan) return plan
  }
  return undefined
}

/**
 * The wiring the type checker likes best, over every workflow and every choice of source.
 *
 * **Candidates are built and scored, not reasoned about.** Half the ports this has to fill are
 * declared `any` — Mirror, Transform, Stack Neurons, For Each, Select One — and `any` says
 * nothing about what the node *wants*: Mirror accepts anything and works on geometry alone, so
 * a first-compatible rule handed it the neuron table and its demo opened saying "Mirror takes
 * skeletons, meshes or points — not a table." Ranking the sources and taking the arrangement
 * with the fewest inference issues finds the skeletons in the morphology workflow instead, and
 * keeps finding the right one for a node written next year that this file has never heard of.
 *
 * `rank` walks every port's candidate list together rather than enumerating the product: a node
 * with three ambiguous ports is asking one question — *how far down the list of things this
 * graph carries do I have to go* — and the product is a search where a diagonal is an answer.
 *
 * A clean candidate ends it, which is what keeps the common case at one `inferGraph` call.
 */
function bestAppend(
  def: NodeDefinition,
  datasets: readonly string[],
): { plan: DemoPlan; graph: CodaGraph } | undefined {
  let best: { plan: DemoPlan; graph: CodaGraph; score: number } | undefined
  for (const dataset of datasets) {
    for (const partial of firstViewerPerAnalysis(dataset)) {
      const graph = workflow(partial)
      if (!graph) continue
      for (let rank = 0; ; rank++) {
        const built = append(graph, def, rank)
        if (!built) break
        const found = { plan: { ...partial, rank }, graph: built.graph }
        const score = issueScore(built.graph, built.id)
        if (score === 0) return found
        if (!best || score < best.score) best = { ...found, score }
      }
    }
  }
  return best
}

/**
 * One plan per analysis, for the append search.
 *
 * The containment index wants each analysis crossed with every viewer it offers, because a
 * viewer is exactly the kind of node only one of them reaches. This search wants the opposite:
 * which viewer ends a chain has no bearing on whether that chain can feed something new, so
 * scoring all of them is the same answer several times over.
 */
function firstViewerPerAnalysis(dataset: string): DemoPlan[] {
  const byAnalysis = new Map<string, DemoPlan>()
  for (const plan of plansFor(dataset)) {
    if (!byAnalysis.has(plan.analysis)) byAnalysis.set(plan.analysis, plan)
  }
  return [...byAnalysis.values()]
}

/**
 * The datasets to try, synthetic first.
 *
 * **A node can be about a backend, and then no synthetic workflow is a demo of it.** List CAVE
 * Tables, CAVE Table, Update Root IDs and Raw Cypher all open on a card saying what they are not
 * — "a mock dataset names no CAVE datastack", "Mock connectome has no query engine" — because
 * they *are* backend-specific and say so in their own `validate`. Since the scoring already
 * reads that sentence, the fix is to let the search leave the synthetic dataset rather than to
 * teach this file which node belongs to which backend.
 *
 * `DEMO_DATASET` stays first and a clean candidate ends the search, so nothing that can demo in
 * the browser gets moved onto a server that wants a credential.
 */
const demoDatasets = once(() => [
  ...new Set([DEMO_DATASET, ...datasetOptions().map((family) => family.key)]),
])

/**
 * How wrong a candidate is. Three weights, and the middle one is the one that matters.
 *
 * An error outweighs any number of warnings: it is a port whose value the node cannot accept,
 * which makes the demo useless, where a warning is often a node saying it has a setting nobody
 * has filled in — the honest state of a fresh Upload Table and not a defect at all.
 *
 * **A warning on the node being demonstrated outweighs one anywhere else**, because the demo is
 * about that node and about nothing else on the canvas. Without that weight Mirror kept the
 * first workflow it fitted, where it warned "Mirror takes skeletons, meshes or points — not a
 * table", over the morphology workflow where it was wired to real skeletons and the only
 * complaint left was a column picker on the viewer downstream. Both scored 1; the first won on
 * arrival order, and the demo was of the refusal.
 */
function issueScore(graph: CodaGraph, subject: string): number {
  let score = 0
  for (const [id, types] of Object.entries(inferGraph(graph).nodes)) {
    for (const issue of types.issues) {
      score += issue.severity === 'error' ? 1000 : id === subject ? 10 : 1
    }
  }
  return score
}

/**
 * Every plan a dataset offers, in the order the wizard offers them.
 *
 * Projected from `everyCombination`, which is the wizard's own enumerator and already the one
 * `nodeguide/data.ts` and `wizard.test.ts` read — a second cross product here would be a second
 * statement of which analyses a source can answer, and the two would have to keep agreeing for a
 * hand-edited `demo://` link to fail the way `demo.test.ts` expects.
 *
 * The start is filtered rather than carried: the three differ in how neurons are *chosen* and
 * nothing downstream can tell, so the plan names one fewer thing. Which start is `demoStart`.
 *
 * Memoised because it is asked once per dataset by the index and again by the append search.
 */
const plansFor = keyed((dataset: string): DemoPlan[] => {
  const start = demoStart(dataset)
  return everyCombination([dataset])
    .filter((answers) => answers.start === start)
    .map((answers) => ({
      dataset,
      analysis: answers.analysis,
      view: answers.visualisations[0] as VisualisationId,
    }))
})

/**
 * One plan, built.
 *
 * Memoised on the plan's three fields, which is what makes the containment index affordable: it
 * asks for the same 173 graphs the append search then asks for again, and `buildWorkflow` is
 * cheap but not free (173 graphs, measured at 4 ms). Keyed by value rather than held in a
 * `WeakMap`, since a plan is minted fresh every time it is read out of a link.
 *
 * A plan that names a combination its dataset does not offer builds **nothing**, which is how a
 * hand-edited link fails: with no graph rather than a broken one. Asked of `plansFor`, so the
 * "would the wizard build this" question has one answer rather than an enumerator and a
 * validator that must agree.
 */
const workflowFor = keyed((key: string): CodaGraph | undefined => {
  const [dataset = '', analysis = '', view = '', chained = ''] = key.split('/')
  const offers = plansFor(dataset).find(
    (candidate) => candidate.analysis === analysis && candidate.view === view,
  )
  if (!offers) return undefined
  return buildWorkflow(
    {
      datasets: [dataset],
      start: demoStart(dataset),
      analysis: offers.analysis,
      visualisations: [offers.view],
      // Notes on: a demo is read before it is run, and the wizard's own sentences are what say
      // which card is doing what. The same choice `demoWorkflow` makes for the tour.
      notes: true,
      // A canvas graph, not a dashboard: the point is the chain, and a grid hides the wiring.
      dashboard: false,
    },
    {
      /*
       * Without the dataset's annotation preamble. A demo is about *one node*, and a family that
       * declares a chain would otherwise hand every link landing on it a large download and a
       * credential prompt — see `BuildOptions`. It also un-rigs the search: six more cards are
       * six more ports to find a clean fit on, so the best-typed candidate for `core.filterTable`
       * — a node with nothing to do with FlyWire — was becoming a FlyWire workflow.
       */
      annotationChain: chained === 'chain',
    },
  )
})

/**
 * One workflow, with or without its dataset's annotation chain.
 *
 * **A dataset node demos on itself, and there the chain is the point.** `demo.ts`'s own rule is
 * that the graph which opens is the one the wizard would have produced had somebody answered its
 * first question that way — so turning the chain off everywhere made `dataset.flywire`'s link
 * open a bare card, on the very page whose prose says the wizard opens this dataset with the
 * full setup in front of it. A page contradicting its own demo link.
 *
 * Everywhere else it is off, and the reason is in `BuildOptions`: the append search ranks by
 * inference issues, six more cards are six more ports to fit cleanly on, and a node with nothing
 * to do with FlyWire was being drawn into a workflow that costs a credential and three large
 * fetches. That argument is about the *append* branch; on the containment branch the node has
 * everything to do with it.
 */
function workflow(plan: DemoPlanRef, chained = false): CodaGraph | undefined {
  return workflowFor(`${plan.dataset}/${plan.analysis}/${plan.view}/${chained ? 'chain' : ''}`)
}

/** Whether this type is the dataset node of the family the plan opens on. */
function ownDataset(type: string, dataset: string): boolean {
  return familyForNodeType(type)?.key === dataset
}

/**
 * How a demo chooses its neurons: a structured search wherever the dataset offers one.
 *
 * **Not the first option the wizard offers**, which for anything with a neuron index is
 * `browse` — an Explore card that opens with *nothing ticked*. That is right in the dialog,
 * where somebody has just been told to tick things, and wrong here: the Paths demo opened on
 * two empty Explore cards, auto-run fired, and the first thing on screen was a red card reading
 * "No neuronIds in the incoming Sources table". Seen in a browser. A demo is looked at before it
 * is touched, so it wants the start that produces rows on its own.
 *
 * Still read off `startOptions` rather than assumed, so a source that cannot answer a structured
 * search falls back to what it does offer instead of building a chain the wizard would refuse.
 */
function demoStart(dataset: string): StartId {
  return resolveOption(startOptions([dataset]), 'search', 'search')
}

function append(
  graph: CodaGraph,
  def: NodeDefinition,
  rank: number,
): { graph: CodaGraph; id: string } | undefined {
  let out = graph
  let fresh = rank === 0
  const wires = new Map<string, Source>()
  /*
   * Ports that are alternatives rather than a set that composes — see `PortDef.exclusiveGroup`.
   * Every wiring pass here reads optional ports as additive, which is right for the Connectivity
   * node's `neurons` and `labels` and wrong for `core.embed`, whose three inputs are three ways
   * of arriving at one k-NN graph: all three were wired from the same neuron table and the demo
   * opened on the node's own refusal. First wired wins, which is declaration order — the node
   * lists its routes in the order its own message names them.
   */
  const claimed = new Set<string>()
  for (const port of defaultInputPorts(def)) {
    if (port.exclusiveGroup && claimed.has(port.exclusiveGroup)) continue
    const candidates = sourcesFor(out, port)
    // Clamped rather than wrapped: past the end of a short list the port keeps its last
    // candidate while a longer list beside it goes on being explored. `fresh` is what ends the
    // rank loop — once every port is clamped, the next rank would wire exactly what this one
    // did, so there is nothing left to score.
    if (rank < candidates.length) fresh = true
    let source = candidates[Math.min(rank, candidates.length - 1)]
    if (!source && port.required !== false) {
      const grown = grow(out, port.type)
      if (!grown) return undefined
      out = grown.graph
      source = grown.source
    }
    if (source) {
      wires.set(port.id, source)
      if (port.exclusiveGroup) claimed.add(port.exclusiveGroup)
    }
  }
  if (!fresh) return undefined

  const added = attach(out, def, wires)
  out = added.graph

  /*
   * Something to look at. A node in the middle of a chain with nothing downstream of it runs and
   * shows a state bar, which is a demonstration of the scheduler rather than of the node — so a
   * non-viewer that produces anything gets a viewer, chosen by the same rule as everything else
   * here. A node that produces nothing (a Download, a viewer of its own) is already the end.
   */
  const named =
    (def.category === 'visualisation' ? undefined : addViewer(out, def, added.id)) ?? out
  return {
    graph: {
      ...named,
      meta: {
        ...named.meta,
        description:
          `${named.meta?.description ?? ''} ${def.label} is on the end of the chain.`.trim(),
      },
    },
    id: added.id,
  }
}

/**
 * Mint a node, place it, and wire the sources given. The one statement of that sequence.
 *
 * Three passes add a node here — the subject, its viewer, and a producer `grow` puts in front of
 * it — and each had written the same four steps: `freshId`, `place`, `addNodeWithCompanion`, a
 * loop of `addEdge`. That is four places to touch the day a companion or a placement rule
 * changes, and two of the three had grown a dead `if (!source) return` inside the loop because
 * they paired ports with sources by index.
 *
 * `addNodeWithCompanion` rather than `addNode`, so a dataset node arrives with the Description
 * card its publisher asks to be cited by — the rule `wizard/assemble.ts` states for graphs
 * built from scratch, which a graph built by appending has no less reason to keep.
 */
function attach(
  graph: CodaGraph,
  def: NodeDefinition,
  wires: ReadonlyMap<string, Source>,
): { graph: CodaGraph; id: string } {
  const id = freshId(graph, def.type)
  // Beside whichever card feeds it first — see `place`.
  let out = addNodeWithCompanion(
    graph,
    place(graph, id, def.type, [...wires.values()][0]?.node),
  )
  for (const [port, source] of wires) {
    out = addEdge(out, {
      source: source.node,
      sourceHandle: source.port,
      target: id,
      targetHandle: port,
    })
  }
  return { graph: out, id }
}

/**
 * Every required input this graph can fill, or undefined if it cannot fill one.
 *
 * The other half of the sequence above, and the reason it is a map rather than two arrays: the
 * copies it replaces paired `needs[i]` with `sources[i]` and then had to guard a lookup they had
 * already proved could not fail.
 */
function requiredWires(
  graph: CodaGraph,
  ports: readonly ResolvedPort[],
): Map<string, Source> | undefined {
  const wires = new Map<string, Source>()
  for (const port of ports) {
    const source = sourcesFor(graph, port)[0]
    if (!source) return undefined
    wires.set(port.id, source)
  }
  return wires
}

/**
 * A viewer for whatever the node just added produces, appended and wired.
 *
 * Derived rather than a kind-to-viewer table, for the reason every other list in this file is
 * derived: a viewer added next month is offered here without an edit. The preference is the one
 * a reader would apply — a viewer whose own first input is *exactly* this kind, before one that
 * merely accepts it — and registry order breaks the remaining tie.
 *
 * **The type asked for is the inferred one, not the declared one**, which is the whole reason
 * this takes the wired graph rather than the definition. Mirror, Transform, Stack and every
 * other passthrough *declares* `any` and produces whatever it was given, so reading the
 * declaration put a Table viewer on the end of a Mirror carrying skeletons — an error, and one
 * that scored the correct wiring worse than the wrong one it was meant to beat. `inferOutputs`
 * is what knows, so it is what is asked.
 */
function addViewer(graph: CodaGraph, def: NodeDefinition, from: string): CodaGraph | undefined {
  const declared = defaultOutputPorts(def)[0]
  if (!declared) return undefined
  const produced = nodeTypes(inferGraph(graph), from).outputs[declared.id] ?? declared.type

  const all = viewers()
  const exact = all.filter((d) => defaultInputPorts(d)[0]?.type.kind === produced.kind)
  for (const viewer of [...exact, ...all]) {
    const ports = defaultInputPorts(viewer)
    const port = ports.find((p) => socketAccepts({ type: produced }, p))
    if (!port) continue
    /*
     * Only viewers whose *other* required inputs the graph can already answer — Neuroglancer and
     * Neuron Topology fetch their own geometry and take a `dataset` beside the thing they draw,
     * which every workflow here has, while a viewer needing something this chain never made is
     * skipped rather than added half-wired.
     */
    const wires = requiredWires(
      graph,
      ports.filter((p) => p.id !== port.id && p.required !== false),
    )
    if (!wires) continue
    wires.set(port.id, { node: from, port: declared.id, type: produced })
    return attach(graph, viewer, wires).graph
  }
  return undefined
}

/**
 * Every port in the graph this type will accept, best first.
 *
 * The order is the whole of the heuristic, and `bestAppend` is what stops it having to be right
 * first time: exact kind before a widened one, and a port declared `any` last of all. Both
 * orderings were put here by a wrong demo.
 *
 * - **A `table` port takes a `neurons` output ahead of a plain `table`.** Both type-check, and
 *   the connection list an analysis just produced sits earlier in the graph than the neuron table
 *   does — so Neuron Profile and Neuron Topology were handed a table of `preId`/`postId` and drew
 *   their "needs a neuronId column" refusal.
 * - **A port whose own type is `any` accepts anything, including the Dataset that opens every
 *   workflow.** Download and Select One were wired to it, and the viewer hung off them then
 *   failed its own type check — the only *error* the first pass produced, and it read as a bug in
 *   Download.
 *
 * Within a kind, node order is chain order — see the module note.
 */
function sourcesFor(graph: CodaGraph, into: Socket): Source[] {
  /*
   * One walk and a stable sort, not four passes with a dedupe set. The accepts test is kind-based
   * and reflexive, so each "exact kind" pass was already a subset of the assignable one and the
   * set existed only to undo that overlap. A stable sort keeps chain order within a tier, which
   * is the other half of the ordering.
   *
   * **`socketAccepts`, and it takes the port rather than its type**, which is what makes the
   * `any` bullet above stop being a heuristic. A port declared `T.any()` for a union `CodaType`
   * cannot spell — `Mirror Neurons`' `in`, and eight more — passed `isAssignable` for *every*
   * output in the graph, and `tierOf` then ranked a `neurons` output top, so the tier ladder was
   * carrying a question `PortDef.kinds` now answers outright. The module note above records the
   * same failure being papered over with scoring, on the grounds that "half these ports are
   * `any`, which says nothing about what the node wants" — a sentence the declaration has since
   * falsified.
   */
  const found: Source[] = []
  for (const node of graph.nodes) {
    for (const port of nodePorts(node, 'output')) {
      if (socketAccepts(port, into)) {
        found.push({ node: node.id, port: port.id, type: port.type })
      }
    }
  }
  return found.sort((a, b) => tierOf(a.type, into.type) - tierOf(b.type, into.type))
}

/**
 * Lower is better. See `sourcesFor` for what each tier is doing there.
 *
 * **Not `core/sockets.ts`' `socketTier`, and the two invert on purpose.** That one ranks the
 * *port* against a fixed wire and puts an exact kind first; this ranks the *source* against a
 * fixed port and puts `neurons` ahead of `table` for a `table` port — because there the more
 * specific end is the candidate, and a neuron table is what a `neuronId` picker downstream
 * needs. One says "which node should I offer for this wire", the other "which wire should I
 * give this node", and they are answered from opposite ends.
 */
function tierOf(from: CodaType, want: CodaType): number {
  if (want.kind === 'any' || want.kind === 'table') {
    if (from.kind === 'neurons') return 0
    if (from.kind === 'table') return 1
  } else if (from.kind === want.kind) {
    return 0
  }
  // A passthrough's declared output accepts and produces anything, so it is the last thing to
  // reach for — which is what keeps the Dataset opening every workflow out of an `any` port.
  // `socketOriginates`' rule, asked of a bare type because this ranks what a *source* carries.
  return from.kind === 'any' ? 3 : 2
}

/**
 * Grow the graph a node so it can answer for a type nothing in it produces.
 *
 * One level, and only from nodes whose own required inputs the graph can already fill — which
 * is what keeps this from being a planner. It exists for exactly one case today: no wizard
 * workflow fetches meshes, so `Clean Meshes` had no demo at all until the search could put a
 * `Meshes` node in front of it. The same shape covers anything else the wizard never reaches.
 *
 * Two orderings, and the second was put here by a demo that was merely *valid*. Queries first,
 * because a query is where a value nothing upstream produces comes from — that is also what
 * stops a `skeletons` port being answered by a Clean Skeletons which would itself need feeding.
 * Then **the producer that consumes the most of the chain**: ROI Meshes and Meshes both make
 * meshes and both are queries, but ROI Meshes takes only a dataset, so Clean Meshes was demoed
 * on a side branch that ignored the neurons the workflow had just found. A node wired to more of
 * what is already there is continuing the pipeline rather than starting a second one.
 */
function grow(
  graph: CodaGraph,
  want: CodaType,
): { graph: CodaGraph; source: Source } | undefined {
  for (const def of producers()) {
    /*
     * The kind itself, never `isAssignable`. `any` is assignable to everything, so asking that
     * question makes Select One a producer of Linkage — and Cut Tree's demo came back with a
     * Neurons table wired into its `Tree` port, which is the one *error* this whole pass
     * produced. A node that passes its input through does not make anything.
     */
    const port = defaultOutputPorts(def).find(
      (p) => socketOriginates(p) && p.type.kind === want.kind,
    )
    if (!port) continue
    const wires = requiredWires(graph, defaultInputPorts(def))
    if (!wires) continue
    const added = attach(graph, def, wires)
    return { graph: added.graph, source: { node: added.id, port: port.id, type: port.type } }
  }
  return undefined
}

/**
 * The nodes that can make a value, in the order to try them. A fact about the registry.
 *
 * Memoised, because `grow` is called from inside the rank loop inside the dataset loop and the
 * sort's comparator resolves ports. A definition is frozen once `registerNode` returns and
 * nothing re-registers, which is what `core/ports.ts` memoises on one layer down.
 */
const producers = once((): NodeDefinition[] => {
  const order: NodeDefinition['category'][] = ['query', 'transform', 'analysis']
  const needed = (def: NodeDefinition): number =>
    defaultInputPorts(def).filter((port) => port.required !== false).length
  return listableNodeDefs()
    .filter((def) => order.includes(def.category))
    .sort(
      (a, b) => order.indexOf(a.category) - order.indexOf(b.category) || needed(b) - needed(a),
    )
})

/** Every viewer, memoised on `producers`' reasoning: `addViewer` runs once per scored candidate. */
const viewers = once(() => listableNodeDefs().filter((def) => def.category === 'visualisation'))

/**
 * A node id that is not taken, derived from the type so a saved demo reads as itself.
 *
 * The wizard's ids are short and meaningful for a measured reason — a share link pays for every
 * one of them twice — and a demo is opened through exactly that mechanism, so `filterTable`
 * beats a generated id here for the same reason it does there.
 */
function freshId(graph: CodaGraph, type: string): string {
  // `uniqueName` is core's one statement of the collision rule — the newcomer keeps the name and
  // a clash is suffixed rather than overwritten — and it is what every other namer in the
  // codebase goes through. It mutates the set it is handed, so the set is minted here.
  const taken = new Set(graph.nodes.map((node) => node.id))
  return uniqueName(taken, type.slice(type.indexOf('.') + 1))
}

/**
 * One column to the right of everything, on the row of the card that feeds it.
 *
 * Clear of `boundsOf` by `CARD_GAP`: `boundsOf` reads each card's declared width through
 * `resolveSize`, so an appended card lands clear of a wide Explore card rather than on it. The row
 * is `near` rather than the topmost card, because the topmost in every one of these graphs is the
 * overview note above the chain.
 */
function place(graph: CodaGraph, id: string, type: string, near?: string): GraphNode {
  const bounds = boundsOf(graph.nodes)
  const row = graph.nodes.find((node) => node.id === near)
  return graphNode(id, type, {
    x: bounds ? bounds.x + bounds.width + CARD_GAP : 0,
    y: row?.position.y ?? 0,
  })
}

/**
 * The plan for every listable type, asked once.
 *
 * What `src/nodeguide/data.ts` calls at build time to write the links. Memoised, like
 * `demoPlan` itself: the search shares one set of built workflows across all 102 questions, and
 * asking them separately rebuilt it each time — ~250 ms for the set, measured, against the
 * ~250 ms the registry dump already costs a build. Both memos matter, and the per-type one is
 * the load-bearing half: `demo.test.ts` asks `demoPlan` for a handful of types *and* calls
 * `demoPlans`, which without it paid for the whole search twice in one file.
 */
export const demoPlans = once((): ReadonlyMap<string, DemoPlan> => {
  const found = new Map<string, DemoPlan>()
  for (const def of listableNodeDefs()) {
    const plan = demoPlan(def.type)
    if (plan) found.set(def.type, plan)
  }
  return found
})

// ---------------------------------------------------------------------------
// Memoising
// ---------------------------------------------------------------------------

/*
 * Everything above is a pure function of a frozen registry, and several are worth remembering —
 * the search asks each one once per node type and there are 102 of those. They had each written
 * the same four-line frame around a `Map` or a `let`, in three different spellings, and the
 * module-level bindings that went with them are what let `bestAppend`'s local `built` shadow the
 * `built` memo. Two helpers instead: the cache has no name, so nothing can shadow it and nothing
 * else can write to it.
 *
 * `has`/`get` rather than `??=`, because one of these answers `undefined` for a real question —
 * "this dataset does not offer that combination" — and a frame keyed on truthiness would rebuild
 * the graph that is not there on every ask.
 */
function keyed<V>(compute: (key: string) => V): (key: string) => V {
  const cache = new Map<string, V>()
  return (key) => {
    if (!cache.has(key)) cache.set(key, compute(key))
    return cache.get(key) as V
  }
}

function once<V>(compute: () => V): () => V {
  let cache: { value: V } | undefined
  return () => (cache ??= { value: compute() }).value
}
