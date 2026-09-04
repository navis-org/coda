/**
 * Nodes that draw their own body instead of a list of param fields.
 *
 * The generic node body — sockets, then one row per param — is right for the procedural nodes,
 * and wrong for a node whose purpose is to be *looked at*. Explore needs a search bar, a list
 * and a pager; expressing that as params would produce a form, not a browser.
 *
 * Registered here rather than on the `NodeDefinition` itself, because a node definition lives in
 * `src/nodes` and must stay headless — a React component in it would break the boundary that
 * keeps a non-browser consumer possible. The registry is the UI's own lookup, keyed by node type,
 * exactly as `ValuePreview` dispatches viewers.
 *
 * A body is rendered in two places and must handle both: inside the node card (`compact`) and in
 * the full-size overlay. Same prop bundle for both, so a body cannot ship working in one and
 * broken in the other.
 */

import type { ComponentType } from 'react'

import type { GraphNode } from '../../core/graph'
import { getNodeDef } from '../../core/registry'
import { FALLBACK_NODE_SIZE } from '../../layout/elkGraph'
import type { Value } from '../../core/values'
import type { InferContext, ParamValue } from '../../core/node'
import { DATASET_FAMILIES } from '../../nodes/lib/datasetFamilies'
import { ExploreBody } from '../explore/ExploreBody'
import { CaveTableInfoBody } from './CaveTableInfoBody'
import { DatasetBody } from './DatasetBody'
import { DescriptionBody } from './DescriptionBody'
import { DownloadBody } from './DownloadBody'
import { IdsFromLabelBody } from './IdsFromLabelBody'
import { InputIdsBody } from './InputIdsBody'
import { LabelsToNeuronsBody } from './LabelsToNeuronsBody'
import { PathsBody } from './PathsBody'
import { FindNeuronsBody } from './FindNeuronsBody'
import { EditTableBody } from './EditTableBody'
import { RenameBody } from './RenameBody'
import { SelectOneBody } from './SelectOneBody'
import { ForEachBody } from './ForEachBody'
import { UploadBody } from './UploadBody'

export interface NodeBodyProps {
  node: GraphNode
  /** Resolves the node's column params and carries its resolved input types. */
  ctx: InferContext
  /**
   * The values on this node's input ports, where a run has produced them.
   *
   * The same thing `ValuePreview` is handed, and for a related reason — a body that draws data
   * rather than configuration needs what actually arrived, not only its type. Explore is the case
   * that forced it: a `DatasetValue` carries the annotation chain's *table*, where the dataset
   * *type* carries only its schema, and on a datastack that publishes no neuron table that table
   * is the neuron list. Undefined per port until whatever feeds it has run.
   */
  inputValues?: Record<string, Value | undefined>
  /** True inside the node card, false in the full-size overlay. */
  compact: boolean
  setParam: (paramId: string, value: ParamValue) => void
  onError: (message: string) => void
}

export interface NodeBodyEntry {
  Component: ComponentType<NodeBodyProps>
  /**
   * Card width in px. The default node is 232 and a preview-bearing one 360; a body that holds a
   * list of neurons needs considerably more, and gets it before anyone opens it full size.
   */
  width?: number
  /**
   * Whether the node offers the full-size overlay.
   *
   * Off by default: a body earns an expand button by having something that benefits from room.
   * A dataset node's body is a preview and two fields — expanding it fills the screen with
   * whitespace, and its button sits where a viewer's would, so the two get confused.
   */
  expandable?: boolean
}

/**
 * The dataset card's width, shared with the Description card that hangs under it.
 *
 * One constant rather than two equal numbers: the two stack vertically, and a card an inch wider
 * than the one above it reads as a mistake long before anyone measures it.
 */
/**
 * What a viewer's card grows to once it has something to draw.
 *
 * The number itself is `.coda-node--wide` in `editor.css`, which is where it is applied — this is
 * the declaration for anything that has to *reason* about how wide a card ends up, and the
 * comment on `NodeBodyEntry.width` above already names it. `src/ui/tour/build.ts` lays a chain of
 * cards out left to right and needs it: a viewer declares neither a `defaultSize` nor a
 * `NODE_BODIES.width`, so without this its slot is sized for a 232px card and the 360px one it
 * actually draws overlaps its neighbour.
 */
export const WIDE_CARD_WIDTH = 360

/**
 * The widest a card of this type can draw, from every source that can decide it.
 *
 * A fixed column pitch does not work, because these cards are not one width: the default is
 * `FALLBACK_NODE_SIZE.width`, `NODE_BODIES` gives Find Neurons 360 for its filter rows and the
 * dataset card 248, and a **viewer** declares neither yet still reaches `WIDE_CARD_WIDTH` the
 * moment it has a value to draw, because `showPreview` puts `.coda-node--wide` on it. Missing
 * that third source is what had the Table card, which declares nothing at all and renders at
 * 360, sitting 38px inside Group By. Measured in a browser.
 *
 * Here rather than in a graph builder because three of them ask now — "Learn to Build" laying out
 * its chain, the Workflow Wizard spacing several viewers, and `placeGuards.test.ts` checking that
 * neither overlaps — and this module is where two of the three width sources already live. The
 * fourth (`defaultSize`) is on the definition, and `isViewer` is `category === 'visualisation'`,
 * spelled out rather than imported so this file keeps its one-way dependency on the registry.
 */
export function cardWidth(type: string): number {
  const def = getNodeDef(type)
  return Math.max(
    def?.defaultSize?.width ?? 0,
    NODE_BODIES[type]?.width ?? 0,
    def?.category === 'visualisation' ? WIDE_CARD_WIDTH : 0,
    FALLBACK_NODE_SIZE.width,
  )
}

const DATASET_CARD_WIDTH = 248

export const NODE_BODIES: Record<string, NodeBodyEntry> = {
  'neuron.explore': { Component: ExploreBody, width: 520, expandable: true },
  /*
   * Wider than a default card because the Labels field is a paste target — a list of cell types
   * wrapped into a 232px box is unreadable — and because the unmatched line names labels rather
   * than counting them. Not `expandable`: the readout is one line and the fields are three, so
   * an overlay of it would be whitespace, and its button would sit where a viewer's does.
   */
  'neuron.idsFromLabel': { Component: IdsFromLabelBody, width: 300 },
  /*
   * The same width as its sibling above, and for the same reason: the IDs field is a paste
   * target, and a list of neuron ids wrapped into a 232px box is unreadable. Not `expandable` —
   * the readout is one line and the fields are two.
   */
  'neuron.inputIds': { Component: InputIdsBody, width: 300 },
  /*
   * Both clustering bridges, one component: they are one operation under two names, and a
   * second copy of the readout is how the two come to report differently on the same failure.
   * Wide enough for two column pickers and for "N matched nothing" to sit beside the counts.
   */
  'cluster.selectedToNeurons': { Component: LabelsToNeuronsBody, width: 300 },
  'cluster.clustersToNeurons': { Component: LabelsToNeuronsBody, width: 300 },
  /*
   * Wide enough for a filename field and for the auto-run warning to read as a sentence — that
   * line is the whole reason somebody does not end up with four hundred files. Not `expandable`:
   * four fields, a button and a line of filenames gain nothing from a fullscreen panel.
   */
  'out.download': { Component: DownloadBody, width: 300 },
  // Every dataset node draws the same body; they differ only in the family table's data. Built
  // from that table rather than listed, so adding a dataset stays a one-line change there.
  ...Object.fromEntries(
    DATASET_FAMILIES.map((family) => [
      `dataset.${family.key}`,
      { Component: DatasetBody, width: DATASET_CARD_WIDTH } satisfies NodeBodyEntry,
    ]),
  ),
  'dataset.neuprint': { Component: DatasetBody, width: 268 },
  /*
   * The dataset card's width exactly, because it sits directly underneath one and the pair reads
   * as a column. That is narrow for prose, which is what the expand button is for: the datasets
   * publishing two paragraphs and a nested list of citations do not fit any card worth putting
   * on a canvas, and the overlay is where they are actually read.
   */
  'dataset.description': {
    Component: DescriptionBody,
    width: DATASET_CARD_WIDTH,
    expandable: true,
  },
  /*
   * Wide enough for the two counts and their labels to share one line, since the whole point of
   * showing both is that they can be compared at a glance. `expandable` for `dataset.description`'s
   * reason and the same source of prose: FlyWire's `nuclei_v1` publishes six paragraphs of
   * provenance, which fits no card worth putting on a canvas, and the overlay is where a table's
   * caveats are actually read. The permissions and modified rows appear only there.
   */
  'cave.tableInfo': { Component: CaveTableInfoBody, width: 300, expandable: true },
  /*
   * The search's four settings and a caption under them. The settings are here because a body
   * replaces the param band outright, and a path query with no reachable `Max hops` is a card
   * whose own empty readout tells you to raise a control that is not on it. Wide enough for the
   * `Collapse types` label and a number field to share a line — see `.paths-body` in the
   * stylesheet, which widens the shared label column for it.
   *
   * Not `expandable`: there is nothing here that benefits from room, and an expand button on a
   * query node would sit exactly where a viewer's does; the routes themselves are a table, and
   * the Table node is what opens full size.
   */
  'neuron.paths': { Component: PathsBody, width: 260 },
  /*
   * Wider than a default card because the status line is a sentence — the "not in this browser"
   * state has to be readable without a tooltip, since it is what a colleague opening a shared
   * graph sees. `expandable`, and the overlay earns its button by adding the column/type
   * listing: a file's schema is the thing you actually want to check after importing it, and
   * twenty rows of it do not belong on a canvas.
   */
  'core.uploadTable': { Component: UploadBody, width: 300, expandable: true },
  /*
   * Wide enough for the pager and the commit button to share one line — `‹ › 5 / 271  DNp01
   * [Use this]` wrapped onto two lines reads as two controls rather than one. Not `expandable`:
   * the whole widget is a row of buttons and a checkbox, so an overlay of it is whitespace, and
   * what is worth looking at full size is whatever the Item port is wired to.
   */
  'core.selectOne': { Component: SelectOneBody, width: 300 },
  // Wider than Select One's: this card carries a progress bar with an element's name in it, and
  // a neuron name wrapping mid-loop is a card that changes height on every pass.
  'flow.forEach': { Component: ForEachBody, width: 320 },
  /*
   * The only card here whose configuration is a list somebody grows, so it is the only one that
   * could not have been a param band. Wide enough for a column picker, an arrow and a name
   * field to share one line — stacked, a rename stops reading as one act. Not `expandable`: the
   * rows are the whole widget and a fullscreen panel of four of them is whitespace.
   */
  'core.rename': { Component: RenameBody, width: 320 },
  /*
   * Wider than Rename's, because a filter is three controls on a line rather than two: a field,
   * an operator and a value. Not `expandable` for Rename's reason — the rows are the whole
   * widget, and a fullscreen panel of four of them is whitespace.
   */
  'neuron.findNeurons': { Component: FindNeuronsBody, width: 360 },
  /*
   * The widest of the list cards, because a rule is three fields on a line rather than two or
   * one: a filter, a column and a value. Measured in a browser rather than guessed, since a
   * six-track grid is exactly what jsdom cannot see — at 400px the filter field is 134px and
   * `type==LC4 status==Traced` cuts to `type==LC4 status==Tra`, so the card is 440 and all
   * three fields carry their value in a `title`. Truncation is not avoidable at any width a
   * canvas can hold, which is why the tooltip is the fix and the extra 40px only makes the
   * common case fit. Not `expandable`, for Rename's reason: the rows are the whole widget and
   * a fullscreen panel of four of them is whitespace.
   */
  'core.editTable': { Component: EditTableBody, width: 440 },
}

export function nodeBody(type: string): NodeBodyEntry | undefined {
  return NODE_BODIES[type]
}
