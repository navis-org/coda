/**
 * 3D morphology viewer node.
 *
 * Four typed inputs — skeletons, meshes, synapse points, neuropil volumes — each with its own
 * colour encoding, so you can colour neurons by cell type while colouring their synapses by
 * polarity, inside the region they innervate.
 *
 * Only `skeletons` is required; a scene of meshes alone is legitimate, so the requirement
 * sits on validation rather than on the ports (see `validate`).
 *
 * The three colour encodings are deliberately peers — same factory, same modes, none of them
 * `advanced`. Mesh colour used to be a constant grey tucked into the advanced panel, which
 * made "colour these by cell type" a thing skeletons could do and meshes could not, for no
 * reason either socket knows about.
 */

import type { InferContext, ParamDef } from '../../core/node'
import { registerNode } from '../../core/registry'
import type { TableSchema } from '../../core/types'
import { T, attributeSchema, column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { isMeshesValue, isPointsValue, isSkeletonsValue, makeTable } from '../../core/values'
import { colorParams } from '../lib/encodingParams'
import { rowsWithIds } from '../lib/tableOps'

const FALLBACK_SCHEMA: TableSchema = tableSchema(column('neuronId', 'i64'))

/**
 * The whole-channel switch, one per socket.
 *
 * A peer of the legend's per-key eye rather than a duplicate of it. The legend can only
 * address what its encoding has keys for — a constant colour has none, which is exactly the
 * state neuropil shells ship in, so "hide the volumes" was reachable through nothing at all.
 * This asks a coarser question and always has an answer: is this socket drawn.
 *
 * Presentational for the same reason the hidden-keys list is. What is drawn changes; what the
 * `Selected` port carries does not, so nothing downstream goes stale for a scene being turned
 * down to look at what is behind it.
 */
function showParam(id: string, label: string, group: string, help: string): ParamDef {
  return {
    id,
    kind: 'boolean',
    label,
    default: true,
    presentational: true,
    advanced: true,
    group,
    help,
  }
}

/** The attribute table the selection is drawn from — skeletons first, then meshes. */
function selectionSourceSchema(ctx: InferContext): TableSchema {
  return (
    attributeSchema(ctx.inputs.skeletons) ??
    attributeSchema(ctx.inputs.meshes) ??
    FALLBACK_SCHEMA
  )
}

export const viewer3dNode = registerNode({
  type: 'out.viewer3d',
  label: '3D View',
  category: 'visualisation',
  description: 'Render skeletons, meshes and synapses in 3D, with data-driven colour.',
  guide:
    'Skeletons, meshes, synapse points and neuropil volumes in one 3D scene, each with its own colour encoding — so neurons can be coloured by cell type while their synapses are coloured by polarity, inside the region they innervate. Only one socket needs filling. Everything arrives in nanometres, so geometry from different queries lines up.',
  cost: 'cheap',
  /*
   * Big, because a card's preview gets what the params leave it and this node has three
   * colour encodings to declare. Measured on the morphology example: at 480 the scene had
   * 125px of card to live in — enough to tell a skeleton from a mesh, not enough to tell one
   * arbour from another — and the legend and caption were pushed out of the bottom entirely.
   * At 620 the canvas gets ~265px and everything fits with the strip still on screen.
   */
  defaultSize: { width: 600, height: 620 },
  inputs: [
    { id: 'skeletons', label: 'Skeletons', type: T.skeletons(), required: false },
    { id: 'meshes', label: 'Meshes', type: T.meshes(), required: false },
    { id: 'points', label: 'Points', type: T.points(), required: false },
    /*
     * A second meshes socket, and the duplication is the point.
     *
     * A neuropil shell and a neuron are the same *type* and never the same *mark*: one is an
     * opaque object somebody is looking at, the other is faint context around it. Sharing the
     * `Meshes` socket would mean one opacity and one colour encoding for both, so drawing a
     * neuron inside a region would either bury the neuron or turn it to glass along with the
     * region. Two sockets is what lets each keep its own.
     */
    { id: 'volumes', label: 'Volumes', type: T.meshes(), required: false },
  ],
  outputs: [{ id: 'selected', label: 'Selected', type: T.neurons() }],
  /*
   * A tab per socket, plus one for the scene itself.
   *
   * The overlay's flat rail could not carry this node. Fourteen presentational params drawn as
   * a horizontal strip is a band of pickers across the top of the picture, and the strip has no
   * way to say that `Mesh colour` and `Mesh colour opacity` are about the *same socket* as
   * `Show meshes` — they were simply adjacent, in an order nothing enforced. The sockets are
   * the node's own structure, so the tabs are that structure rather than a taxonomy invented
   * for the panel; `out.network` groups by Node/Link/Layout for the same reason.
   *
   * The second thing this buys is the one the flat rail never had: a tabbed panel comes with
   * the header's `Style` toggle, so the controls can be put away entirely and the scene gets
   * the whole window. A rail has no such control, which is why it is always in the way.
   *
   * None of them is `affectsData` — every param here is presentational, and `selection` (which
   * is not) is excluded from the panel by that same rule rather than by a group.
   */
  paramGroups: [
    { id: 'skeletons', label: 'Skeletons' },
    { id: 'meshes', label: 'Meshes' },
    { id: 'points', label: 'Points' },
    { id: 'volumes', label: 'Volumes' },
    { id: 'scene', label: 'Scene' },
  ],
  params: [
    showParam(
      'showSkeletons',
      'Show skeletons',
      'skeletons',
      'Draw the Skeletons socket. Off removes the geometry rather than hiding it, so it costs nothing and cannot be clicked.',
    ),
    ...colorParams({
      prefix: 'skeleton',
      allowLiteral: true,
      allowHash: true,
      from: 'skeletons',
      label: 'Skeleton colour',
      rowLabel: 'Colour',
      group: 'skeletons',
      /*
       * One colour per neuron, from the id — and it is the same colour neuroglancer gives that
       * neuron, because it is neuroglancer's hash (see `ui/segmentColor.ts`).
       *
       * This was `categorical` on `neuronId`, which is the palette answering a question it was
       * not built for: eight validated slots and a grey `Other`, so a scene of twenty neurons
       * drew twelve of them identically grey. Colour here is identity, not category — `by
       * category` is one click away for the times it is genuinely a group.
       */
      defaultMode: 'hash',
      /*
       * Named rather than left to "first compatible column", which happens to resolve here and
       * would stop the day a source publishes a different first column.
       */
      defaultColumn: 'neuronId',
      advanced: true,
      legend: true,
    }),
    {
      group: 'skeletons',
      id: 'skeletonWidth',
      kind: 'number',
      label: 'Line width',
      default: 1,
      min: 1,
      max: 8,
      step: 0.5,
      presentational: true,
      advanced: true,
      help: 'Above 1 the skeletons are drawn as camera-facing quads instead of hairlines, which costs more per segment.',
    },
    showParam(
      'showMeshes',
      'Show meshes',
      'meshes',
      'Draw the Meshes socket. Useful with skeletons on the same neurons: turn the surfaces off to see the arbour inside them.',
    ),
    ...colorParams({
      prefix: 'mesh',
      allowLiteral: true,
      allowHash: true,
      from: 'meshes',
      label: 'Mesh colour',
      rowLabel: 'Colour',
      group: 'meshes',
      // Same rule as skeletons, and it has to be the same rule: a neuron wired to both sockets
      // would otherwise be one colour as a surface and another as a wire frame.
      defaultMode: 'hash',
      defaultColumn: 'neuronId',
      advanced: true,
      legend: true,
      /*
       * Opaque by default, and that is a reversal.
       *
       * A mesh used to arrive grey at 0.25 — a ghost the skeletons showed through, which reads
       * as context around a wire frame rather than as the neuron itself. But a mesh set is far
       * more often the *whole* scene than a backdrop for one, and a whole scene of ghosts
       * looks like a renderer that has not finished loading. Turn it down for the backdrop
       * case; the slider is in the colour's own row and the surface is real until you do.
       */
      alpha: {
        default: 1,
        help: 'Below 1 the surfaces turn translucent, so skeletons and synapses inside them show through.',
      },
    }),
    showParam(
      'showPoints',
      'Show points',
      'points',
      'Draw the Points socket. A synapse cloud is often what is in the way of the morphology under it.',
    ),
    ...colorParams({
      prefix: 'point',
      allowLiteral: true,
      allowHash: true,
      from: 'points',
      label: 'Point colour',
      rowLabel: 'Colour',
      group: 'points',
      /*
       * Categorical, unlike its two neighbours, because a synapse table's useful columns are
       * *groups*: polarity, partner type, region. Hashing those would spend the mode's one
       * advantage — a colour per individual — on a column with four values in it, in exchange
       * for four unvalidated hues.
       */
      defaultMode: 'categorical',
      defaultColor: '1',
      advanced: true,
      legend: true,
    }),
    showParam(
      'showVolumes',
      'Show volumes',
      'volumes',
      'Draw the Volumes socket. The one channel with no per-key eye to reach it — a constant colour has no legend keys — which is what this row is for.',
    ),
    ...colorParams({
      prefix: 'volume',
      allowLiteral: true,
      allowHash: true,
      from: 'volumes',
      label: 'Volume colour',
      rowLabel: 'Colour',
      group: 'volumes',
      /*
       * Constant grey, unlike its three peers, and the asymmetry is the role rather than an
       * oversight. A categorical encoding over 63 neuropils is eight hues and a grey `Other`,
       * which reads as a claim that eight of them are special. Context should be one quiet
       * colour until somebody has a reason to say otherwise — and `by category` on `roi` is
       * one picker away when they do.
       */
      defaultMode: 'constant',
      defaultColor: 'muted',
      advanced: true,
      legend: true,
      /*
       * Faint by default, where a mesh is opaque. Same control, opposite job: a shell is drawn
       * so that something else can be seen *inside* it, and at 1 it is an opaque bag with the
       * neurons hidden in it.
       */
      alpha: {
        default: 0.12,
        help: 'Neuropil shells are context, so they start nearly transparent. Raise it to make the region the subject.',
      },
    }),
    {
      group: 'points',
      id: 'pointSize',
      kind: 'number',
      label: 'Point size',
      default: 60,
      min: 5,
      max: 500,
      step: 5,
      presentational: true,
      advanced: true,
      help: 'Diameter of a synapse dot, in nanometres — so it scales with the scene rather than staying a fixed number of pixels.',
    },
    {
      /*
       * Re-frame the camera whenever the scene's extent changes, instead of framing once.
       *
       * **Off by default, and the default is the considered position.** `CameraRig`'s own note
       * records the rule this opts out of: a camera that re-frames on a bounds change was thrown
       * away by every upstream re-run and by expanding the card to the overlay, which is the bug
       * that rule exists to fix. Nothing about that has changed.
       *
       * What has changed is that a `For Each` can now put four hundred different neurons through
       * one viewer, one at a time, capturing each. Under the fixed camera every image after the
       * first is framed on the *first* neuron — which is exactly right for a contact sheet meant
       * to be compared at one scale, and useless when the elements sit far apart in the volume.
       * Neither answer is right for both, so it is a switch rather than a new rule.
       *
       * Presentational: it decides where the camera goes, and `evaluate` returns the selection
       * table whatever it says.
       */
      group: 'scene',
      id: 'refit',
      kind: 'boolean',
      label: 'Frame each',
      default: false,
      presentational: true,
      advanced: true,
      help: 'Re-frame the camera whenever what is on screen changes. Off keeps one camera, which is what you want for a set of images meant to be compared — and on is what you want when a For Each steps through neurons that are nowhere near each other.',
    },
    {
      group: 'scene',
      id: 'background',
      kind: 'enum',
      label: 'Background',
      default: 'theme',
      presentational: true,
      advanced: true,
      help: 'Pin the canvas light or dark instead of following the app. A figure for a paper usually wants light whatever the editor is set to.',
      options: [
        { value: 'theme', label: 'follow theme' },
        { value: 'dark', label: 'dark' },
        { value: 'light', label: 'light' },
        // Not the same as `dark`, which is the theme's `#1a1a19`. This one is the figure's
        // black — the background a rendered neuron is usually cut out of.
        { value: 'black', label: 'black' },
      ],
    },
    {
      /*
       * Advanced like everything else here, which leaves the card with no rows at all.
       *
       * That is the point and it is a reversal: the note on `out.network` records that a card
       * with no rows loses its `☰` fold and reads as a node with nothing to set. On a viewer
       * whose whole face is the picture, the trade goes the other way — twelve rows of pickers
       * above a scene is a settings panel with a thumbnail attached. Everything is one click
       * away in the inspector, the legend does the colour work in place, and the caption
       * already says how many are selected, which is what this row otherwise reported.
       */
      advanced: true,
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'neurons',
      default: [],
      help: 'Set by clicking neurons in the viewer. Feeds the Selected output.',
    },
  ],

  inferOutputs: (ctx) => ({ selected: T.neurons(selectionSourceSchema(ctx)) }),

  validate: (ctx) => {
    const hasAny =
      ctx.inputs.skeletons ?? ctx.inputs.meshes ?? ctx.inputs.points ?? ctx.inputs.volumes
    if (!hasAny) return ['Connect skeletons, meshes, points or volumes to see anything']
    return []
  },

  evaluate: (ctx) => {
    const skeletons = ctx.input('skeletons')
    const meshes = ctx.input('meshes')
    const points = ctx.input('points')
    const volumes = ctx.input('volumes')

    if (
      !isSkeletonsValue(skeletons) &&
      !isMeshesValue(meshes) &&
      !isPointsValue(points) &&
      !isMeshesValue(volumes)
    ) {
      throw new Error('Nothing connected to render')
    }

    // Selection resolves against whichever attribute table has one row per neuron. Points and
    // volumes are excluded on purpose: their rows are synapses and regions, not neurons.
    const attributes: TableValue | undefined = isSkeletonsValue(skeletons)
      ? skeletons.attributes
      : isMeshesValue(meshes)
        ? meshes.attributes
        : undefined

    if (!attributes) {
      return { selected: makeTable(FALLBACK_SCHEMA, { neuronId: [] }, 'neurons') }
    }
    return { selected: rowsWithIds(attributes, ctx.params.selection) }
  },
})
