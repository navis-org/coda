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
 * **Two families opt out of all of that** — see `BESPOKE` at the foot of the file, and note the
 * two do it differently. A CAVE datastack keeps its cell typing in a table rather than on the
 * neuron, so the generic four nodes open on a list of root ids: FlyWire needs a graph of its own
 * because its labels are a published file that has to be fetched and repaired first — six cards,
 * which is why they ship folded into one frame and the first screen is still the usual four —
 * while BANC's are already in the datastack and its starter is the generic shape *plus one node*,
 * composed rather than copied.
 */

import type { CodaGraph, GraphNode } from '../core/graph'
import { addNodeWithCompanion } from '../core/companion'
import { addEdge } from '../core/graph'
import { createGroup } from '../core/groups'
import type { Link } from './assemble'
import { assembleGraph as assemble, graphNode as node } from './assemble'
import { ID_COLUMN_NAME } from '../core/ids'
import { findColumn } from '../core/types'
import { aggColumnName } from '../nodes/lib/tableOps'
import { capabilityAnywhere, getSource } from '../data/source'
import { COLLAPSED_SIZE } from '../layout/collapse'
import { GROUP_PADDING } from '../layout/groupBounds'
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

/** The same node helper on the generic starter's three-column grid. */
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
 * The column Explore's `Additional tags` opens on, or none.
 *
 * A source that publishes a column *named* `annotations` is publishing the thing that control
 * exists for: several free-form labels per neuron in one cell, joined with `JOIN_SEPARATOR`.
 * CATMAID is the only one that does — a neuron there has exactly one name and any number of
 * annotations, and the annotations are where the lineages, the hemisphere, the clusterings and
 * the papers live — so both its datasets would otherwise open with that whole bag drawn nowhere,
 * because `tagColumn` is `optional` and an optional picker never takes its declared default
 * (`resolveColumn`: on an optional picker empty is a *choice*). Setting it there instead of
 * changing the default is what keeps that rule intact.
 *
 * Read off the schema rather than keyed on the backend, which is the same shape `withScene` uses
 * above and for the same reason: it is a fact about what the source publishes, and a backend
 * that starts publishing one gets this without an edit here. It is a *column name* doing that
 * work rather than anything declared, which is the honest weakness of it — `ColumnSchema` is
 * `{name, dtype, unit}` and a "these are joined tags" flag would have exactly one declarer. The picker is still filtered
 * against the live schema downstream, so naming it costs nothing where the column is absent.
 */
function tagColumnFor(sourceId: string | undefined): string | undefined {
  const neurons = sourceId ? getSource(sourceId)?.schemas.neurons : undefined
  return findColumn(neurons, 'annotations') ? 'annotations' : undefined
}

function genericStarter(spec: StarterSpec): CodaGraph {
  /*
   * No dataset id: a starter is a node type and some params, and which dataset that resolves to
   * is not known until the node runs. So this is an *offer* question — is a scene cell worth
   * putting in the graph — and it takes the ceiling, exactly as the wizard's own gating does.
   *
   * It read `capabilityOf(…, undefined, …)` on the theory that it would pick up a per-dataset
   * override the day a starter could name its dataset. That day cannot arrive through this call:
   * with no id, `capabilityOf` never consults `capabilitiesFor` at all, so it was the source-level
   * answer spelled the long way. Nothing observable changes here today — no source declares a
   * `viewerScene` ceiling — but two surfaces asking one question two ways is what put the wizard
   * two answers short of what CAVE can do.
   */
  const withScene = spec.sourceId
    ? capabilityAnywhere(getSource(spec.sourceId), 'viewerScene')
    : false
  const tagColumn = tagColumnFor(spec.sourceId)

  return assemble(
    spec.label,
    `Browsing ${spec.label}. Search in the Explore Dataset node, tick neurons, then Run.`,
    [
      place('dataset', spec.nodeType, 0, spec.params),
      place('explore', 'neuron.explore', 1, tagColumn ? { tagColumn } : undefined),
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
 * The annotation chain's two rows and the column it starts in: the published cell typing on top,
 * the community tags underneath, meeting at the Join.
 *
 * The whole chain ships **folded** into one frame (see `flywireStarter`), so these coordinates
 * decide two things at once — where the six cards land when somebody opens the frame, and, through
 * the frame's own top-left corner, where the folded box sits on the first screen.
 */
const CHAIN_X = 492
const CHAIN_TOP = 210
const CHAIN_BOTTOM = 410

/** Column spacing inside the chain, wide enough for its widest card. */
const CHAIN_STEP = 268

/**
 * Where the folded frame draws, derived rather than written down.
 *
 * `collapsedView` puts the box at the frame's own corner — `union` of the members plus
 * `GROUP_PADDING` — and nothing stores it, for `groupBox`'s reason. So the note below it is
 * placed off the same arithmetic and off `COLLAPSED_SIZE`: a starter that hard-coded the corner
 * would drift the day either constant moves, and it would drift *silently*, into a note
 * overlapping the box it annotates.
 */
const FOLDED_X = CHAIN_X - GROUP_PADDING
const FOLDED_Y = CHAIN_TOP - GROUP_PADDING

/** The chain's six cards, in the order they run. What the frame holds. */
const CHAIN_NODES = ['annotations', 'combine', 'repair', 'tags', 'foldTags', 'join']

/** The column of `neuron_information_v2` holding the free-form text. */
const TAG_SOURCE_COLUMN = 'tag'

/**
 * The column the fold produces, which Explore's `Additional tags` has to be pointed at.
 *
 * Through `aggColumnName` rather than the literal `join_tag`, because that is the rule and a
 * second spelling of it is how the two halves come to disagree — silently, since a wrong
 * `Additional tags` does not fail, it just draws no tag row.
 */
const TAG_COLUMN = aggColumnName('join', TAG_SOURCE_COLUMN)

/**
 * FlyWire FAFB, opening with its cell typing already wired in.
 *
 * The generic starter is a dataset and a browser, which works because a neuPrint dataset carries
 * its cell typing as properties on the neuron. A CAVE datastack does not: the labels live in a
 * table, so "browse FlyWire" without an annotation chain is browsing a list of root ids. Hence
 * the six nodes in front of the dataset, which is the whole reason this family cannot be built
 * from `genericStarter` with different arguments.
 *
 *   Table from URL ▸ Combine Columns ▸ Update root IDs ──────────┐
 *                                                                 ├─▸ Join ─▸ Dataset
 *   CAVE table (neuron_information_v2) ▸ Group By (join text) ───┘        ▸ Annotations
 *
 * Two sources answering two different questions about one neuron: structured fields down the
 * top, free-form community text along the bottom. Each step is there for a reason somebody would
 * otherwise have to discover:
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
 *  - **Group By, folding `tag` with `join text`**, because `neuron_information_v2` is one row per
 *    (neuron, tag) and every way of consuming it downstream wants one row per neuron. It is not a
 *    tidy-up: `joinTables` takes the **first** matching row for a repeated key — deliberately, so
 *    a many-to-many join cannot multiply the table being annotated — so without this fold a
 *    neuron carrying eight community tags would show exactly one of them, with nothing saying so.
 *    The aggregation is distinct and in first-appearance order, which is what a table two people
 *    have annotated the same way needs.
 *  - **The Join rather than an annotation chain**, because a chain makes the later source *win* a
 *    collision rather than sit beside it. `left`, so a neuron nobody has tagged still comes
 *    through.
 *  - **`Columns: pt_root_id, tag`** on the CAVE table, because everything else in
 *    `neuron_information_v2` is bookkeeping — a point, a supervoxel, a user id, a timestamp —
 *    that would arrive in every neuron table and in every column picker downstream.
 *
 * **All six ship folded into one frame**, which is the one thing here that is about the *first
 * screen* rather than about the data. Six cards in two rows are the biggest thing on the canvas
 * and none of them is what a newcomer came to do: they are plumbing that has to be right and
 * never has to be touched. Folded, the starter reads as the four nodes every other one has —
 * labels, dataset, browser, views — with the chain as a single box anybody can open. `collapsed`
 * lives in the document precisely so a graph can *arrive* this way (see `GraphGroup.collapsed`),
 * and the frame is built through `createGroup`, the same call ⌘G makes, so a starter cannot be
 * the one surface where a group is assembled by hand.
 *
 * Nothing is `exposed` onto the box: an exposed param is a control worth driving without
 * unfolding, and every param down this chain is a wiring decision made once. The note beside it
 * says the frame is worth opening; a promoted control would say the opposite.
 *
 * Explore reads the folded column through `Additional tags`, which draws them as a muted row of
 * their own, apart from the fields above. The name is **`join_tag`** rather than `tag` because
 * `groupByTable` writes `<agg>_<column>`, and the two halves have to agree: `Additional tags`
 * splits on `JOIN_SEPARATOR`, which is what that aggregation joined them with.
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
  const graph = assemble(
    spec.label,
    `${spec.label} with the published cell annotations and the community tags wired in as its labels. Search in the Explore Dataset node, tick neurons, then Run.`,
    [
      // One note where the two rows used to have one each: folded, they are one box, and two
      // captions pointing at it from different sides would be describing a thing that is no
      // longer two things. Directly under the box and the same width as it, so it reads as that
      // box's caption rather than as loose text on the canvas.
      noteNode({
        id: 'sourceNote',
        x: FOLDED_X,
        y: FOLDED_Y + COLLAPSED_SIZE.height + 16,
        width: COLLAPSED_SIZE.width,
        height: 300,
        text: `
        Hierarchical annotations loaded from [github.com/flyconnectome/flywire_annotations](https://github.com/flyconnectome/flywire_annotations).

        Initial set of annotations reported in [Schlegel _et al._, Nature (2024)](https://doi.org/10.1038/s41586-024-07686-5). Now incorporates optic lobe annotations from [Matsliah _et al._, Nature (2024)](https://www.nature.com/articles/s41586-024-07981-1), and general updates from [Berg _et al._, Cell (2026)](https://www.biorxiv.org/content/10.1101/2025.10.09.680999v1).

        Community annotations are added as separate "tags" (as opposed to the more structured "fields").

        Open the group for details.`,
      }),
      node(
        'annotations',
        'core.tableFromUrl',
        { x: CHAIN_X, y: CHAIN_TOP },
        {
          url: FLYWIRE_ANNOTATIONS,
          idColumn: 'root_id',
        },
      ),
      node(
        'combine',
        'core.combineColumns',
        { x: CHAIN_X + CHAIN_STEP, y: CHAIN_TOP },
        {
          columns: ['cell_type', 'hemibrain_type'],
        },
      ),
      node('repair', 'cave.updateRootIds', { x: CHAIN_X + 2 * CHAIN_STEP, y: CHAIN_TOP }),

      node(
        'tags',
        'annotation.caveTable',
        { x: CHAIN_X, y: CHAIN_BOTTOM },
        {
          table: 'neuron_information_v2',
          columns: 'pt_root_id, tag',
        },
      ),
      node(
        'foldTags',
        'core.groupBy',
        { x: CHAIN_X + CHAIN_STEP, y: CHAIN_BOTTOM },
        {
          by: [ID_COLUMN_NAME],
          agg: 'join',
          value: ['tag'],
        },
      ),
      node(
        'join',
        'core.join',
        { x: CHAIN_X + 2 * CHAIN_STEP, y: CHAIN_BOTTOM },
        { leftKey: ID_COLUMN_NAME },
      ),

      // Beside the folded box rather than after the two rows it would have to clear: the dataset
      // is the card the four visible nodes hang off, so it sits at the box's own height.
      node('dataset', spec.nodeType, { x: 790, y: FOLDED_Y }, spec.params),
      node('explore', 'neuron.explore', { x: 1070, y: 0 }, { tagColumn: TAG_COLUMN }),
      node('ngl', 'out.neuroglancer', { x: 1610, y: 0 }, undefined, {
        width: 633,
        height: 839,
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
      ['tags', 'annotations', 'foldTags', 'in'],
      // A *reference*, so neither pair below is a cycle: `Update root IDs` and the CAVE table both
      // read the datastack's identity out of the dataset they are about to feed. See
      // `PortDef.reference`.
      ['dataset', 'dataset', 'repair', 'dataset'],
      ['dataset', 'dataset', 'tags', 'dataset'],
      ['repair', 'out', 'join', 'left'],
      ['foldTags', 'out', 'join', 'right'],
      ['join', 'out', 'dataset', 'annotations'],
      ['dataset', 'dataset', 'explore', 'dataset'],
      ['dataset', 'dataset', 'ngl', 'dataset'],
      ['explore', 'all', 'picked', 'in'],
      ['explore', 'selected', 'ngl', 'neurons'],
    ],
  )

  return createGroup(graph, CHAIN_NODES, { title: 'FlyWire annotations', collapsed: true })
}

// ---------------------------------------------------------------------------
// BANC
// ---------------------------------------------------------------------------

/**
 * BANC, opening with its Codex annotations wired in.
 *
 * The same problem FlyWire's starter solves and a much smaller answer, which is why this one is
 * **`genericStarter` plus a chain** rather than a graph of its own: a CAVE datastack keeps its
 * cell typing in a table, so the generic four nodes open on a list of eighteen-digit root ids.
 * Everything downstream of the dataset is unchanged, so composing says that where a copy of the
 * generic body would merely happen to agree with it.
 *
 *   CAVE table (codex_annotations) ─▸ Dataset ▸ Annotations
 *
 * One node, where FlyWire needs six, and the difference is where the labels live rather than a
 * difference in ambition. FlyWire's are a published TSV that has to be fetched, coalesced and
 * root-id-repaired before it can be joined; BANC's are already *in* the datastack, so the CAVE
 * table node reads them directly and the chain is the node itself.
 *
 * **Why this is a starter and not a spec entry.** `DatastackSpec.annotations` is how FlyWire's
 * built-in labels are configured, and it cannot express this one: that spec joins through the
 * spec's own `neurons.table`, and `codex_annotations` is a reference table into
 * `cell_representative_point` — not BANC's `backbone_proofread`. So the wiring is on the canvas,
 * where it is also visible, and the Description card says the same thing in words ("Annotations —
 * none configured").
 *
 * **`Pivot on` is the whole configuration.** `codex_annotations` is long-format — one row per
 * (neuron, `classification_system`, `cell_type`) — so the distinct values of
 * `classification_system` become the columns. Measured: 1,994,371 rows across 32 kinds folding to
 * 158,250 neurons, read as one query per kind because a single query for the lot is over some
 * deployments' row cap. `cell_type` arrives renamed to `type`, which is the column Explore's
 * chips, the connectivity tables and Profile's roll-ups all address by literal name.
 *
 * `idColumn` is left at its default `pt_root_id` deliberately, even though on a reference table
 * that names a column of the *referenced* table. It is the same field holding the same default,
 * and overriding it here would suggest it needed to be different.
 */
function bancStarter(spec: StarterSpec): CodaGraph {
  let graph = genericStarter(spec)
  graph = {
    ...graph,
    meta: {
      ...graph.meta,
      description: `${spec.label} with the Codex annotations wired in as its labels. Search in the Explore Dataset node, tick neurons, then Run.`,
    },
  }

  // A column in front of the generic grid, which starts at `COLUMNS[0]`. The note sits under the
  // node it is about rather than beside it: there is no second row here to form a margin against.
  const CHAIN_X = -240
  const extra = [
    node(
      'annotations',
      'annotation.caveTable',
      { x: CHAIN_X, y: 90 },
      {
        table: 'codex_annotations',
        pivotOn: 'classification_system',
        valueColumn: 'cell_type',
      },
    ),
    noteNode({
      id: 'annotationsNote',
      x: CHAIN_X,
      y: 310,
      width: 260,
      height: 150,
      text: `
      The BANC's [Codex](https://banc.community) annotations live in a CAVE table rather than in the connectome, so they are wired in by hand.

      \`codex_annotations\` is long-format — one row per (neuron, kind, value) — which **Pivot on** folds into a column per kind.`,
    }),
  ]
  for (const one of extra) graph = addNodeWithCompanion(graph, one)

  const links: Link[] = [
    // A *reference*, so this pair is not a cycle: the CAVE table reads the datastack's identity
    // out of the dataset it is about to feed. See `PortDef.reference`.
    ['dataset', 'dataset', 'annotations', 'dataset'],
    ['annotations', 'annotations', 'dataset', 'annotations'],
  ]
  for (const [source, sourceHandle, target, targetHandle] of links) {
    graph = addEdge(graph, { source, sourceHandle, target, targetHandle })
  }
  return graph
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
  'dataset.banc': bancStarter,
}

export function buildStarter(spec: StarterSpec): CodaGraph {
  return (BESPOKE[spec.nodeType] ?? genericStarter)(spec)
}
