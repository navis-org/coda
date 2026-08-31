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

import type { InferContext, ParamDef, ParamValues } from '../../core/node'
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

/**
 * Spelled out rather than imported from `viewer3dScene.ts`, which is the viewer's `SkeletonWidthMode`
 * — `src/nodes` has no business reaching into `src/ui`, and `viewer3d.test.ts` pins the two lists
 * against each other through the param's own options.
 */
type WidthMode = 'uniform' | 'radius' | 'world'

/**
 * The stored width mode, defaulting the way a graph saved before the mode existed needs.
 *
 * One reading of the param, used by the three `visibleIf`s and by `ValuePreview`'s coercion —
 * it was written out four times, and the `'uniform'` in it has to stay in step with
 * `skeletonWidthMode`'s own `default`. It also removes a small divergence: written inline, a
 * nonsense stored value showed *no* width control at all while the viewer drew it as uniform.
 */
function widthModeOf(params: ParamValues): WidthMode {
  const mode = String(params.skeletonWidthMode ?? 'uniform')
  return mode === 'radius' || mode === 'world' ? mode : 'uniform'
}

/**
 * One of the three `Line width` values, which differ only in their range and their prose.
 *
 * They cannot be one *param* — the docs and the tests both record why: "3 pixels everywhere",
 * "3 pixels at the thickest" and "3× the recorded radius" are different numbers and cannot
 * share a default, so a mode that reinterpreted a stored width would reopen a saved graph
 * looking different. But everything around the number is identical, including the rule that
 * exactly one of them is visible, and that rule is the part worth writing once.
 */
function widthParam(
  mode: WidthMode,
  spec: { id: string; default: number; min: number; max: number; step: number; help: string },
): ParamDef {
  return {
    group: 'skeletons',
    kind: 'number',
    label: 'Line width',
    presentational: true,
    advanced: true,
    visibleIf: (params) => widthModeOf(params) === mode,
    composite: { key: 'skeletonLineWidth', role: 'value' },
    ...spec,
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
    /*
     * Line width is one property with two ways of being driven, so it is one composite row —
     * the same shape a colour has, and for the same reason: a mode plus whichever value that
     * mode takes, never both at once. The alternative was a width setting that silently means
     * two different things, since "3 pixels everywhere" and "3 pixels at the thickest" are not
     * the same number and cannot share a default.
     */
    {
      group: 'skeletons',
      id: 'skeletonWidthMode',
      kind: 'enum',
      label: 'Line width',
      default: 'uniform',
      options: [
        { value: 'uniform', label: 'one width' },
        { value: 'radius', label: 'by radius' },
        { value: 'world', label: 'to scale' },
      ],
      presentational: true,
      advanced: true,
      composite: { key: 'skeletonLineWidth', role: 'primary', label: 'Line width' },
      help:
        'By radius and To scale both draw each neurite at the calibre it was traced or ' +
        'segmented at, which is what makes a primary neurite read as one. They differ in the ' +
        'unit: by radius is in pixels and looks the same at every zoom, to scale is in ' +
        'nanometres and thickens as you zoom in. Sources that publish no radii fall back to ' +
        'one width.',
    },
    widthParam('uniform', {
      id: 'skeletonWidth',
      default: 1,
      min: 1,
      max: 8,
      step: 0.5,
      help: 'Above 1 the skeletons are drawn as camera-facing quads instead of hairlines, which costs more per segment.',
    }),
    widthParam('radius', {
      /*
       * Expressed as the width of the *thickest* neurites rather than of the median, because
       * that is the end of the distribution somebody can see. Its default is 4 where the
       * uniform width's is 1, and the two are separate params precisely so that can be true:
       * at a scale of 1 every node below the reference clamps to the one-pixel floor and the
       * taper this mode exists for is not visible at all.
       */
      id: 'skeletonRadiusWidth',
      default: 4,
      min: 1,
      max: 16,
      step: 0.5,
      help:
        'How wide the thickest neurites are drawn, in pixels. Everything thinner is drawn in ' +
        'proportion, down to a one-pixel floor — so this sets the top of the range rather ' +
        'than a width every node gets.',
    }),
    widthParam('world', {
      /*
       * A multiplier, where both other modes take a width — because in this mode the width is
       * already decided, by the source. There is no p95 to calibrate against and nothing to
       * clamp: 1 is the arbour at its published calibre, and anything else is a deliberate
       * exaggeration of it. Defaulting to 1 rather than to something flattering is the whole
       * point of offering the mode.
       */
      id: 'skeletonWorldWidth',
      default: 1,
      min: 0.25,
      max: 8,
      step: 0.25,
      help:
        'Multiplies the recorded radius. At 1 a 200 nm neurite is drawn 200 nm across, so the ' +
        'picture is to scale and a neurite thickens as you zoom into it. Nodes whose source ' +
        'recorded no radius stay a hairline rather than disappearing.',
    }),
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
      max: 2000,
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
      /*
       * Overall scene lighting, as one multiplier over both lights.
       *
       * It exists because of a debt rather than as a preference control: `<Canvas flat>` had to
       * drop ACES tone mapping so ambient occlusion would stop moving the background, and the
       * curve's shoulder had been carrying the midtones a rough dielectric spends its range in.
       * The default pair was raised 50% to pay that back; this is the slider for the rest.
       *
       * One number and not two, because the *ratio* between the fill and the key is what
       * decides how much shape a surface shows and it was chosen once, against the palette.
       * See `sceneLights`.
       *
       * Presentational: it changes how a surface is lit, not what the `Selected` table says.
       */
      group: 'scene',
      id: 'lightIntensity',
      kind: 'number',
      label: 'Light intensity',
      default: 1,
      /*
       * Floored at 0.25 rather than at 0, which is the difference from the occlusion slider
       * above: 0 there is a well-defined "no darkening" and 0 here is a black canvas — a
       * setting that looks exactly like a viewer that failed to load, reachable by dragging a
       * handle to its end.
       *
       * The top is where the ceiling starts to matter. `NoToneMapping` clips at 1.0 where a
       * curve would roll off, so light past the point a channel saturates does not brighten a
       * surface — it desaturates it toward white and walks it out of the validated palette.
       * Measured on four opaque optic-lobe meshes, as the share of surface pixels with a
       * saturated channel: **0% everywhere up to 1.4** (the brightest channel reaches 252 of
       * 255 there, so it is close), then 1.7% at 1.5, 12.9% at 1.75 and 23.1% at 2.
       *
       * The range still runs to 2 — a limit warns, it does not refuse, and a blown highlight is
       * a look somebody may want — but a quarter of the surface is a real cost and the help
       * says so. Note the headroom is a property of *this* scene's albedos: a paler palette
       * saturates sooner, so 1.4 is where these meshes stop being safe rather than a constant.
       *
       * Worth carrying: mean luminance only goes 105 to 135 across 1 → 2, because the
       * framebuffer is sRGB-encoded and the renderer works in linear light. Doubling the light
       * is about 28% more pixel, which is why the top of this slider buys less than it looks
       * like it should and costs more.
       */
      min: 0.25,
      max: 2,
      step: 0.05,
      slider: true,
      presentational: true,
      advanced: true,
      help: 'Brightness of the scene lighting, over both the fill and the key light together. 1 is the calibrated default. Past about 1.4 the brightest surfaces start to clip — at 2 roughly a quarter of the visible surface is white rather than its own colour, which is a look rather than more light.',
    },
    {
      /*
       * Screen-space ambient occlusion over the opaque surfaces in the scene.
       *
       * Full strength by default, and what licenses that is `wantsAmbientOcclusion` rather
       * than the pass being free: it is only *mounted* where there is something for it to
       * occlude, and a strength of 0 does not mount it either.
       * `GTAOPass` hides every line and point before rendering its normal buffer — three's own
       * comment says so — so a skeleton scene, which is most of them, would otherwise pay four
       * passes and three render targets to multiply the image by 1. A scene that does mount one
       * was measured at 60fps either way: 21 meshes, 2× device scale, ANGLE Metal on an M3 Max.
       *
       * Presentational: it changes the shading and not the `Selected` table.
       */
      group: 'scene',
      id: 'ambientOcclusion',
      kind: 'number',
      label: 'Ambient occlusion',
      default: 1,
      min: 0,
      max: 2,
      step: 0.05,
      /*
       * A slider rather than a field, on `NumberParam.slider`'s own rule: it is a proportion
       * somebody sets by feel and watches the result of, like an opacity, not a limit or a
       * budget. It is also `GTAOPass.blendIntensity` unchanged — `mix(vec3(1.), ao, intensity)`
       * — so 0 really is "no darkening" rather than a small amount of it, which is what lets
       * the number carry the off state instead of a second control.
       *
       * The range runs past 1 to 2, which octarine's `intensity` does not. 1 is where a fully
       * occluded pixel goes black; past it the mix extrapolates — `2*ao - 1` at the top — so
       * anything less than half occluded crushes to black too — measured at 9% of the surface
       * pixels on the mock arbours, against near zero at 1. That is a real look and not a bug,
       * and it is well defined: the blend is multiply, so a negative result clamps at the
       * framebuffer rather than producing NaN (three selects the linear branch of the sRGB
       * transfer with a `bvec`, which is a select and not a lerp, so the `pow` of a negative
       * never reaches the output).
       */
      slider: true,
      presentational: true,
      advanced: true,
      help: 'How strongly creases, cavities and the places surfaces meet are darkened — 0 turns the effect off entirely, and the pass is not run at all. Only opaque meshes and volumes can cast it; a scene of skeletons alone has no surface to occlude.',
    },
    {
      /*
       * Whether a click in the scene selects, and it is **off by default**.
       *
       * The reversal is deliberate. Picking is the one gesture here that writes a param taking
       * part in the provenance key, so a stray click while turning a scene is not a cosmetic
       * accident — it marks everything downstream stale and re-runs it. A trackball has no
       * click-free way to say "I was only looking", `DRAG_SLOP` catches a drag but not a click
       * that merely landed on a neurite, and the cost of the false positive is far higher than
       * the cost of switching this on when selecting is what you came to do.
       *
       * It gates the *scene*, not the legend: a legend label is an unambiguous request to
       * select something named, where a click into a tangle of arbours is a guess about which
       * of them was under the cursor. Turning this off leaves the deliberate route working.
       *
       * Presentational, like everything else here. It decides whether a gesture can write
       * `selection`; it does not change what `evaluate` returns for the selection there is.
       */
      group: 'scene',
      id: 'selectByClick',
      kind: 'boolean',
      label: 'Select by clicking',
      default: false,
      presentational: true,
      advanced: true,
      help: 'Let a click in the scene select the neuron under it. Off by default, because a selection is a real output — a stray click while turning the view re-runs everything downstream of this node. Legend labels select either way.',
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
