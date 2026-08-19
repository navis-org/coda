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
import type { InferContext, ParamValue } from '../../core/node'
import { DATASET_FAMILIES } from '../../nodes/lib/datasetFamilies'
import { ExploreBody } from '../explore/ExploreBody'
import { DatasetBody } from './DatasetBody'
import { DescriptionBody } from './DescriptionBody'
import { IdsFromLabelBody } from './IdsFromLabelBody'
import { InputIdsBody } from './InputIdsBody'
import { PathsBody } from './PathsBody'
import { UploadBody } from './UploadBody'

export interface NodeBodyProps {
  node: GraphNode
  /** Resolves the node's column params and carries its resolved input types. */
  ctx: InferContext
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
   * target, and a list of body ids wrapped into a 232px box is unreadable. Not `expandable` —
   * the readout is one line and the fields are two.
   */
  'neuron.inputIds': { Component: InputIdsBody, width: 300 },
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
   * A caption, not a widget — so no `expandable`. There is nothing here that benefits from
   * room, and an expand button on a query node would sit exactly where a viewer's does; the
   * routes themselves are a table, and the Table node is what opens full size.
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
}

export function nodeBody(type: string): NodeBodyEntry | undefined {
  return NODE_BODIES[type]
}
