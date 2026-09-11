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
 * **What a body does not carry is its width**, which is `NodeDefinition.cardWidth`: the headless
 * layers place cards by width and may not import this table.
 *
 * A body is rendered in two places and must handle both: inside the node card (`compact`) and in
 * the full-size overlay. Same prop bundle for both, so a body cannot ship working in one and
 * broken in the other.
 */

import type { ComponentType } from 'react'

import type { GraphNode } from '../../core/graph'
import type { Value } from '../../core/values'
import type { InferContext, ParamValue } from '../../core/node'
import { DATASET_FAMILIES } from '../../nodes/lib/datasetFamilies'
import { ExploreBody } from '../explore/ExploreBody'
import { EXPLORE_MAP_SPOTS } from '../explore/exploreMap'
import type { MapSpot } from '../tour/mapSpots'
import { CaveTableInfoBody } from './CaveTableInfoBody'
import { DatasetBody } from './DatasetBody'
import { DescriptionBody } from './DescriptionBody'
import { CopyIdsBody } from './CopyIdsBody'
import { DownloadBody } from './DownloadBody'
import { IdsFromLabelBody } from './IdsFromLabelBody'
import { InputIdsBody } from './InputIdsBody'
import { LabelsToNeuronsBody } from './LabelsToNeuronsBody'
import { PathsBody } from './PathsBody'
import { FindNeuronsBody } from './FindNeuronsBody'
import { EditTableBody } from './EditTableBody'
import { RenameBody } from './RenameBody'
import { SelectOneBody } from './SelectOneBody'
import { SplitNeuronsBody } from './SplitNeuronsBody'
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
   * Whether the node offers the full-size overlay.
   *
   * Off by default: a body earns an expand button by having something that benefits from room.
   * A dataset node's body is a preview and two fields — expanding it fills the screen with
   * whitespace, and its button sits where a viewer's would, so the two get confused.
   */
  expandable?: boolean
  /**
   * What this body's screen map labels, if it has one — a header button on every full-size
   * surface drawing it. See `NodeMap.tsx`. Only for a body with enough controls that "what is all
   * of this" is a real question; a map of two fields is a tooltip with a scrim.
   */
  screenMap?: readonly MapSpot[]
}

export const NODE_BODIES: Record<string, NodeBodyEntry> = {
  'neuron.explore': {
    Component: ExploreBody,
    expandable: true,
    screenMap: EXPLORE_MAP_SPOTS,
  },
  /*
   * Not `expandable`: the readout is one line and the fields are three, so an overlay of it would
   * be whitespace, and its button would sit where a viewer's does.
   */
  'neuron.idsFromLabel': { Component: IdsFromLabelBody },
  // Not `expandable` — the readout is one line and the fields are two.
  'neuron.inputIds': { Component: InputIdsBody },
  /*
   * Both clustering bridges, one component: they are one operation under two names, and a
   * second copy of the readout is how the two come to report differently on the same failure.
   */
  'cluster.selectedToNeurons': { Component: LabelsToNeuronsBody },
  'cluster.clustersToNeurons': { Component: LabelsToNeuronsBody },
  /*
   * Not `expandable`: four fields, a button and a line of filenames gain nothing from a
   * fullscreen panel.
   */
  'out.download': { Component: DownloadBody },
  // Not `expandable`, for Download's reason.
  'out.copyIds': { Component: CopyIdsBody },
  // Every dataset node draws the same body; they differ only in the family table's data. Built
  // from that table rather than listed, so adding a dataset stays a one-line change there.
  ...Object.fromEntries(
    DATASET_FAMILIES.map((family) => [
      `dataset.${family.key}`,
      { Component: DatasetBody } satisfies NodeBodyEntry,
    ]),
  ),
  'dataset.neuprint': { Component: DatasetBody },
  /*
   * `expandable`, because the card is the dataset card's width and that is narrow for prose: the
   * datasets publishing two paragraphs and a nested list of citations do not fit any card worth
   * putting on a canvas, and the overlay is where they are actually read.
   */
  'dataset.description': { Component: DescriptionBody, expandable: true },
  /*
   * `expandable` for `dataset.description`'s reason and the same source of prose: FlyWire's
   * `nuclei_v1` publishes six paragraphs of provenance, which fits no card worth putting on a
   * canvas, and the overlay is where a table's caveats are actually read. The permissions and
   * modified rows appear only there.
   */
  'cave.tableInfo': { Component: CaveTableInfoBody, expandable: true },
  /*
   * The search's four settings and a caption under them. The settings are here because a body
   * replaces the param band outright, and a path query with no reachable `Max hops` is a card
   * whose own empty readout tells you to raise a control that is not on it.
   *
   * Not `expandable`: there is nothing here that benefits from room, and an expand button on a
   * query node would sit exactly where a viewer's does; the routes themselves are a table, and
   * the Table node is what opens full size.
   */
  'neuron.paths': { Component: PathsBody },
  /*
   * `expandable`, and the overlay earns its button by adding the column/type listing: a file's
   * schema is the thing you actually want to check after importing it, and twenty rows of it do
   * not belong on a canvas.
   */
  'core.uploadTable': { Component: UploadBody, expandable: true },
  /*
   * Not `expandable`: the whole widget is a row of buttons and a checkbox, so an overlay of it is
   * whitespace, and what is worth looking at full size is whatever the Item port is wired to.
   */
  'core.selectOne': { Component: SelectOneBody },
  'flow.forEach': { Component: ForEachBody },
  /*
   * The only card here whose configuration is a list somebody grows, so it is the only one that
   * could not have been a param band. Not `expandable`: the rows are the whole widget and a
   * fullscreen panel of four of them is whitespace.
   */
  'core.rename': { Component: RenameBody },
  // Not `expandable`, for Rename's reason.
  'neuron.findNeurons': { Component: FindNeuronsBody },
  // The same editor as Find Neurons — `FilterRowsEditor` draws both cards.
  'neuron.splitNeurons': { Component: SplitNeuronsBody },
  // Not `expandable`, for Rename's reason: the rows are the whole widget.
  'core.editTable': { Component: EditTableBody },
}

export function nodeBody(type: string): NodeBodyEntry | undefined {
  return NODE_BODIES[type]
}
