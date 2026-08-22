/**
 * Starter graphs — what "New ▸ hemibrain" builds.
 *
 * An empty canvas is a poor first screen: it asks the newcomer to know both which nodes exist
 * and which dataset they want, before they have seen a single neuron. A starter answers the
 * second question from the menu and the first by example, and lands you somewhere you can
 * immediately look around.
 *
 * The smallest arrangement that teaches the shape of the tool:
 *
 *   Dataset ─┬─▸ Explore ──(Selected)─┬─▸ Table
 *            └────────────────────────┴─▸ Neuroglancer
 *
 * Two viewers off one selection, because that is the answer to "what did I just tick?" in both
 * the forms people want it: the numbers, and the neurons. The Neuroglancer node appears only
 * where the source publishes a scene — the mock generates its geometry in the browser and has
 * no bucket for an external viewer to read, so on a mock starter it would open as a node that
 * can only ever warn.
 *
 * A published dataset also opens with the Description card its dataset node comes with anywhere
 * else — see `core/companion.ts`. It is built here through the same helper rather than placed by
 * hand, so a starter cannot end up being the one surface where the credit is missing.
 *
 * The Table is wired to `Selected` rather than `Hits` on purpose. `Hits` with an empty search is
 * the entire dataset — 165,122 rows for male-CNS — and a starter graph whose first Run pushes
 * that into a table viewer would teach the wrong lesson about what to connect. `Selected` starts
 * empty, fills as you tick rows, and shows the browse-then-act flow the widget exists for.
 *
 * Built programmatically from each node's own defaults, exactly like the examples, so a starter
 * cannot drift out of sync with a node's param set.
 *
 * **One family opts out of all of that** — see `BESPOKE` at the foot of the file. A datastack
 * whose cell typing does not live in the connectome needs the chain that fetches it, and no
 * arrangement of the generic shape can express that.
 */

import type { CodaGraph, GraphNode } from '../core/graph'
import { addNodeWithCompanion } from '../core/companion'
import { addEdge, emptyGraph } from '../core/graph'
import type { ParamValues } from '../core/node'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { capabilityOf, getSource } from '../data/source'
import { noteNode } from './notes'

export interface StarterSpec {
  /** Dataset node type to open with, e.g. `dataset.malecns`. */
  nodeType: string
  /** Display label, used for the graph's name. */
  label: string
  /** Which registered source it belongs to, so the starter can ask what that source can do. */
  sourceId?: string
  /** Params for the dataset node — a pinned version, or a custom server and dataset. */
  params?: Record<string, unknown>
}

/** Explore is 520px wide, so columns are spaced for it rather than for a default node. */
const COLUMNS = [60, 340, 940]

type Link = [from: string, fromPort: string, to: string, toPort: string]

/** A node at an absolute position, its params being the definition's own plus any overrides. */
function node(
  id: string,
  type: string,
  position: { x: number; y: number },
  params?: Record<string, unknown>,
  size?: { width: number; height: number },
): GraphNode {
  const def = requireNodeDef(type)
  return {
    id,
    type,
    position,
    params: { ...defaultParams(def), ...params } as ParamValues,
    ...(size ? { size } : {}),
  }
}

/** The same, on the generic starter's three-column grid. */
function place(
  id: string,
  type: string,
  column: number,
  params?: Record<string, unknown>,
  y = 90,
): GraphNode {
  return node(id, type, { x: COLUMNS[column] ?? 60, y }, params)
}

/**
 * Nodes and wires into a graph.
 *
 * Every node goes in through `addNodeWithCompanion`, so a dataset node here opens with its
 * Description card exactly as it does when somebody adds one by hand. A starter is the first
 * graph most people see, which makes it the least defensible place to leave the credit out.
 */
function assemble(
  name: string,
  description: string,
  nodes: GraphNode[],
  links: Link[],
): CodaGraph {
  let graph = emptyGraph(name)
  graph = { ...graph, meta: { ...graph.meta, name, description } }
  for (const spec of nodes) graph = addNodeWithCompanion(graph, spec)
  for (const [source, sourceHandle, target, targetHandle] of links) {
    graph = addEdge(graph, { source, sourceHandle, target, targetHandle })
  }
  return graph
}

function genericStarter(spec: StarterSpec): CodaGraph {
  /*
   * No dataset id: a starter is a node type and some params, and which dataset that resolves to
   * is not known until the node runs. So this gets the source-level answer, which is the honest
   * one here — through `capabilityOf` rather than `capabilities.viewerScene` so it picks up a
   * per-dataset override the day a starter can name its dataset.
   */
  const withScene = spec.sourceId
    ? capabilityOf(getSource(spec.sourceId), undefined, 'viewerScene')
    : false

  return assemble(
    spec.label,
    `Browsing ${spec.label}. Search in the Explore node, tick neurons, then Run.`,
    [
      place('dataset', spec.nodeType, 0, spec.params),
      place('explore', 'neuron.explore', 1),
      place('picked', 'out.table', 2),
      ...(withScene ? [place('ngl', 'out.neuroglancer', 2, undefined, 430)] : []),
    ],
    [
      ['dataset', 'dataset', 'explore', 'dataset'],
      ['explore', 'selected', 'picked', 'in'],
      ...(withScene
        ? ([
            ['dataset', 'dataset', 'ngl', 'dataset'],
            ['explore', 'selected', 'ngl', 'neurons'],
          ] as Link[])
        : []),
    ],
  )
}

// ---------------------------------------------------------------------------
// FlyWire FAFB
// ---------------------------------------------------------------------------

/**
 * The published FlyWire annotations, as their maintainers serve them.
 *
 * `raw.githubusercontent.com` rather than the `github.com/.../raw/...` address the repository's
 * own UI hands you: that one answers `302` with an **empty** `access-control-allow-origin`, and a
 * browser CORS-checks every hop of a redirect chain, so it never reaches the host that would have
 * allowed it. The target answers `200` with `*` and gzips. See `core.tableFromUrl`.
 */
const FLYWIRE_ANNOTATIONS =
  'https://raw.githubusercontent.com/flyconnectome/flywire_annotations/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv'

/**
 * Two rows: the labels the dataset is browsed *by* on top, the community tags underneath.
 *
 * The tag chain is second because it is the optional half — pull the Join and the top row is a
 * complete FlyWire workspace on its own.
 */
const MAIN_ROW = 0
const TAG_ROW = 200

/**
 * FlyWire FAFB, opening with its cell typing already wired in.
 *
 * The generic starter is a dataset and a browser, which works because a neuPrint dataset carries
 * its cell typing as properties on the neuron. A CAVE datastack does not: the labels live in a
 * table, so "browse FlyWire" without an annotation chain is browsing a list of root ids. Hence
 * the five nodes in front of the dataset, which is the whole reason this family cannot be built
 * from `genericStarter` with different arguments.
 *
 *   Table from URL ▸ Combine Columns ▸ Update root IDs ─┐
 *                                                        ├─▸ Join ─▸ Dataset ▸ Annotations
 *   CAVE table (neuron_information_v2) ─────────────────┘
 *
 * Each step is there for a reason somebody would otherwise have to discover:
 *
 *  - **Combine Columns** because the type has to arrive in a column *called* `type` before
 *    anything reads it in words: the connectivity tables, Explore's chips and Profile's roll-ups
 *    all address it by literal name — see `annotationColumn`. Which columns feed it is a call
 *    about **nomenclature** rather than coverage, and the file says so: `cell_type` covers
 *    137,720 of 139,248 neurons, `hemibrain_type` 33,271, and only *two* neurons have the second
 *    without the first.
 *  - **Update root IDs** because the published file is a snapshot and a root id is retired by any
 *    proofreading edit; without it the rows whose ids have moved on join to nothing, and the
 *    dataset merely reads as under-annotated.
 *  - **The Join** because the two sources answer different questions about one neuron —
 *    structured fields on the left, free-form community text on the right — and a chain would
 *    make the later one *win* a collision rather than sit beside it. `left`, so a neuron nobody
 *    has tagged still comes through.
 *  - **`Columns: pt_root_id, tag`** on the CAVE table, because everything else in
 *    `neuron_information_v2` is bookkeeping — a point, a supervoxel, a user id, a timestamp —
 *    that would arrive in every neuron table and in every column picker downstream.
 *
 * Explore reads those tags through `Additional tags: tag`, which draws them as a muted row of
 * their own, apart from the fields above. Note what the wiring buys and what it does not: a
 * `Join` takes the **first** matching row, so a neuron carrying several community tags shows one
 * of them. A `Group By ▸ join text` between the CAVE table and the Join is what folds all of them
 * into one cell, at the cost of a sixth node on a first screen.
 *
 * The Table hangs off `All` rather than `Selected`, unlike every other starter: what this graph
 * is *about* is the annotated neuron table, and a Table showing nothing until something is ticked
 * would hide the one thing worth looking at.
 *
 * Everything else opens empty. `selection` and `page` are both written by the Explore *widget*,
 * so a starter carrying either would be shipping whoever exported the graph's browsing position —
 * and a Neuroglancer panel opening on a neuron nobody chose reads as the app having decided
 * something. `defaultParams` supplies both, so this is a matter of not overriding them.
 */
function flywireStarter(spec: StarterSpec): CodaGraph {
  return assemble(
    spec.label,
    `${spec.label} with the published cell annotations and the community tags wired in as its labels. Search in the Explore node, tick neurons, then Run.`,
    [
      node(
        'annotations',
        'core.tableFromUrl',
        { x: 0, y: MAIN_ROW },
        {
          url: FLYWIRE_ANNOTATIONS,
          idColumn: 'root_id',
        },
      ),
      node(
        'combine',
        'core.combineColumns',
        { x: 262, y: MAIN_ROW },
        {
          columns: ['cell_type', 'hemibrain_type'],
        },
      ),
      node('repair', 'cave.updateRootIds', { x: 530, y: MAIN_ROW }),
      node('dataset', spec.nodeType, { x: 790, y: MAIN_ROW }, spec.params),
      node('explore', 'neuron.explore', { x: 1070, y: MAIN_ROW }, { tagColumn: 'tag' }),
      node('ngl', 'out.neuroglancer', { x: 1610, y: MAIN_ROW }, undefined, {
        width: 633,
        height: 839,
      }),

      noteNode({
        id: 'sourceNote',
        x: 0,
        y: TAG_ROW,
        width: 227,
        height: 219,
        text: `
        Hierarchical annotations loaded from [github.com/flyconnectome/flywire_annotations](https://github.com/flyconnectome/flywire_annotations).

        Initial set of annotations reported in [Schlegel _et al._, Nature (2024)](https://doi.org/10.1038/s41586-024-07686-5). Now incorporates optic lobe annotations from [Matsliah _et al._, Nature (2024)](https://www.nature.com/articles/s41586-024-07981-1), and general updates from [Berg _et al._, Cell (2026)](https://www.biorxiv.org/content/10.1101/2025.10.09.680999v1).`,
      }),
      node(
        'tags',
        'annotation.caveTable',
        { x: 262, y: TAG_ROW },
        {
          table: 'neuron_information_v2',
          columns: 'pt_root_id, tag',
        },
      ),
      node('join', 'core.join', { x: 530, y: TAG_ROW }, { leftKey: 'neuronId' }),
      noteNode({
        id: 'tagsNote',
        x: 262,
        y: 420,
        width: 230,
        height: 86,
        text: `Community annotations are added as separate "tags" (as opposed to the more structured "fields").`,
      }),
      node(
        'picked',
        'out.table',
        { x: 1070, y: 505 },
        { showFilters: true },
        { width: 522, height: 341 },
      ),
    ],
    [
      ['annotations', 'out', 'combine', 'in'],
      ['combine', 'out', 'repair', 'in'],
      // A *reference*, so neither pair below is a cycle: `Update root IDs` and the CAVE table both
      // read the datastack's identity out of the dataset they are about to feed. See
      // `PortDef.reference`.
      ['dataset', 'dataset', 'repair', 'dataset'],
      ['dataset', 'dataset', 'tags', 'dataset'],
      ['repair', 'out', 'join', 'left'],
      ['tags', 'annotations', 'join', 'right'],
      ['join', 'out', 'dataset', 'annotations'],
      ['dataset', 'dataset', 'explore', 'dataset'],
      ['dataset', 'dataset', 'ngl', 'dataset'],
      ['explore', 'all', 'picked', 'in'],
      ['explore', 'selected', 'ngl', 'neurons'],
    ],
  )
}

/**
 * Families whose starter is not the generic shape.
 *
 * Keyed by node type rather than by family key, because that is what a `StarterSpec` carries and
 * what a saved graph would name. One entry today; the table exists so a second cannot become a
 * second `if` inside `buildStarter`.
 */
const BESPOKE: Record<string, (spec: StarterSpec) => CodaGraph> = {
  'dataset.flywire': flywireStarter,
}

export function buildStarter(spec: StarterSpec): CodaGraph {
  return (BESPOKE[spec.nodeType] ?? genericStarter)(spec)
}
