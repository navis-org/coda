import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isDatasetValue } from '../../core/values'
import { sourceLabel, sourceSupports } from '../lib/datasetParam'

/**
 * Where is this, and how well is it traced?
 *
 * Explore answers "which neuron?", Profile "what is this cell?", Dataset Summary "what is in
 * here?" — and all three are about *cells*. This one is about the space they sit in: the
 * neuropil shells of a whole dataset drawn together, with each region's tracing completeness
 * attached to the shape rather than to a row in a table.
 *
 * It is the only surface in Coda that can answer "where in the brain is `LO(R)`, and how much of
 * it can I trust", which is otherwise two lookups and a mental model of fly anatomy.
 *
 * ## Shape: a Dataset Summary, not a 3D View
 *
 * The obvious sibling is `out.viewer3d`, since both draw meshes, and it is the wrong one. That
 * node takes geometry *on a wire* and something upstream fetched it. This takes a Dataset and
 * fetches for itself — which is exactly `out.datasetSummary`'s arrangement, down to having no
 * outputs at all and needing an entry in `SELF_DRAWING_NODE_TYPES` to earn its resize handles
 * and its overlay.
 *
 * **`cheap`, despite the widget downloading a great deal.** `evaluate` confirms the input is a
 * dataset and returns nothing; it touches no network. The region meshes are the *widget's*
 * request, issued and cached on its own terms, exactly as Profile's three-per-neuron fetches
 * are. What a viewer fetches for itself is not what the scheduler has to reason about.
 *
 * **Every param is therefore presentational**, which here is trivially true and still worth
 * stating: `evaluate` returns nothing, so nothing can change what it returns. Unlike Dataset
 * Summary there is no `Status`-shaped exception, because nothing here counts neurons.
 *
 * ## No outputs
 *
 * `dataset.description`'s call and for the same reason: this is an annotation hanging off a
 * dataset node, and a socket would invite wiring a pipeline through a map. A `Selected regions`
 * output is the obvious later addition and would move no existing socket — but it would have to
 * take `selection` out of the presentational set the same day, or a stale downstream result
 * survives a pick.
 */

/**
 * What the fill colour says.
 *
 * Completeness is the default because it is the reason to draw regions rather than to look them
 * up: a connectivity result out of a region that is 39% traced means something different from
 * one out of a region that is 91%. Postsynaptic before presynaptic, matching Dataset Summary,
 * because it is the figure that bounds what a connectivity query can see — a connection is only
 * found when the *receiving* neuron is reconstructed.
 *
 * `region` gives each neuropil its own hue, with a left/right pair sharing one because they are
 * one structure seen twice. It is deliberately **not** a categorical encoding — 63 to 152 regions
 * against a palette of 8, and no legend could list them — so the hue means only "this shape is
 * not that shape", which is the job neuroglancer's segment colours do. `side` is the categorical
 * one, and it is the only grouping every dataset agrees on, since no source here publishes a
 * parent-neuropil hierarchy to fold regions into.
 */
const COLOR_MODES = [
  { value: 'postCompleteness', label: 'Completeness (post)' },
  { value: 'preCompleteness', label: 'Completeness (pre)' },
  { value: 'region', label: 'Region' },
  { value: 'side', label: 'Side' },
  { value: 'flat', label: 'Flat' },
] as const

const VIEWS = [
  { value: 'frontal', label: 'Frontal' },
  { value: 'dorsal', label: 'Dorsal' },
  { value: 'lateral', label: 'Lateral' },
] as const

export const roisNode = registerNode({
  type: 'out.rois',
  label: 'ROI Viewer',
  category: 'visualisation',
  description:
    "The dataset's neuropils drawn together in a named anatomical plane, coloured by how completely each is traced.",
  guide:
    'Neuropils drawn together on a fixed anatomical plane — frontal, dorsal or lateral — that can be exploded to separate overlapping regions. Various coloring options including reconstruction completeness.',
  cost: 'cheap',
  // Landscape, unlike Profile's and Dataset Summary's portrait boxes: a fly brain is wider than
  // it is tall in every one of the three planes, so a portrait card wastes the axis the picture
  // does not use.
  defaultSize: { width: 620, height: 460 },
  inputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  outputs: [],
  params: [
    {
      /*
       * Inspector-only, like every one of `out.neuroglancer`'s, and for the same reason: the
       * map draws its own control bar, so a stack of generic rows above it would be the same
       * four controls twice, spending a fifth of a 460px card to do it.
       *
       * They stay `presentational`, so they are still offered in the expanded view's styling
       * rail — a control that vanished when the card grew would be the odd one out.
       */
      /*
       * Three named planes and no free camera, which is what lets the whole dataset's geometry
       * be flattened once and thrown away — see `roiProjection.ts`. It also means every view is
       * reproducible: "frontal" is a claim anyone can check against the picture, where a camera
       * that happens to be pointing that way is a pair of angles nobody can read off one.
       */
      id: 'view',
      kind: 'enum',
      label: 'View',
      help: 'Which anatomical plane to project down.',
      default: 'frontal',
      options: VIEWS.map((v) => ({ value: v.value, label: v.label })),
      presentational: true,
      advanced: true,
    },
    {
      /*
       * Not a radial push from the centroid, which is the obvious rule and does not work:
       * scaling every centre about one point is a uniform scale of the arrangement, the shapes
       * do not scale with it, and once the frame refits the only perceptible change is the
       * regions getting smaller. `relaxShifts` un-stacks instead. See `roiProjection.ts`.
       */
      id: 'explode',
      kind: 'number',
      label: 'Explode',
      help: 'Slide overlapping regions apart until they separate. 100% is just separated.',
      default: 0,
      min: 0,
      max: 100,
      step: 1,
      presentational: true,
      advanced: true,
    },
    {
      id: 'colorBy',
      kind: 'enum',
      label: 'Colour',
      help: 'What the fill says. Completeness is traced synapses over the synapses present.',
      default: 'postCompleteness',
      options: COLOR_MODES.map((m) => ({ value: m.value, label: m.label })),
      presentational: true,
      advanced: true,
    },
    {
      id: 'labels',
      kind: 'enum',
      label: 'Labels',
      help: 'Auto names as many regions as fit and says when it has thinned them.',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'all', label: 'All' },
        { value: 'off', label: 'Off' },
      ],
      presentational: true,
      advanced: true,
    },
    {
      /*
       * The published region list *nests* — hemibrain returns 230 regions of which 63 tile the
       * volume, male-CNS 5,619 of which 144. Drawing them all would stack every sub-region
       * inside its parent, so this is on by default; off is for somebody comparing the
       * sub-compartments of one neuropil, which is a real thing to want and a terrible default.
       */
      id: 'primaryOnly',
      kind: 'boolean',
      label: 'Primary regions only',
      help: 'Keep only the regions that tile the volume. The published list nests, so the rest are drawn inside their parents.',
      default: true,
      presentational: true,
      advanced: true,
    },
    {
      /*
       * Which groups of the region hierarchy to draw. Empty means all of them, the `chips`
       * idiom — so a dataset that publishes no hierarchy, and one where nothing has been
       * unticked, are the same stored value and the same picture.
       *
       * `ids` rather than an `enum`, because the options are per-dataset: hemibrain groups its
       * regions into `CX` and `INP`, male-CNS into something else entirely, and an enum's
       * options would have to be a list this file cannot know. Written by the widget's dropdown;
       * the inspector shows it as the plain string list it is.
       */
      id: 'superRois',
      kind: 'ids',
      label: 'Region groups',
      help: "Which groups of the dataset's region hierarchy to draw. Empty draws every one.",
      default: [],
      presentational: true,
      advanced: true,
    },
    {
      id: 'hemisphere',
      kind: 'enum',
      label: 'Hemisphere',
      help: 'Read from the (L)/(R) suffix. A dataset that names no sides is unaffected.',
      default: 'both',
      options: [
        { value: 'both', label: 'Both' },
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
      ],
      presentational: true,
      advanced: true,
    },
    {
      id: 'opacity',
      kind: 'number',
      label: 'Fill',
      help: 'How strongly a region is filled inside its outline. 0 draws outlines only.',
      default: 0.12,
      min: 0,
      max: 0.6,
      step: 0.01,
      presentational: true,
      advanced: true,
    },
    {
      id: 'refresh',
      kind: 'int',
      label: 'Refresh',
      help: "Bumped by the card's reload button. Re-downloads the region meshes instead of reading the cached copy.",
      default: 0,
      min: 0,
      presentational: true,
      advanced: true,
      // Machinery a widget writes, not a setting — so the card's `… N more` hint does not
      // announce it and turning it does not read as a parameter somebody changed.
      internal: true,
    },
  ],

  inferOutputs: () => ({}),

  /*
   * Reported at edit time, because a source with no region meshes draws nothing and the card
   * would otherwise be indistinguishable from one still loading. Four of the thirteen datasets
   * neuPrint serves publish none at all, so this is the common case rather than the odd one.
   */
  validate: (ctx) => {
    if (!sourceSupports(ctx, 'roiMeshes')) {
      const label = sourceLabel(ctx.inputs.dataset) ?? 'This source'
      return [`${label} does not publish region meshes`]
    }
    return []
  },

  /*
   * Nothing is fetched here and nothing is returned.
   *
   * The check still earns its place: a Dataset socket wired to something that is not a dataset
   * should be a node error rather than a card that silently draws an empty brain, and it is the
   * only thing about this node the scheduler can usefully report.
   */
  evaluate: async (ctx) => {
    if (!isDatasetValue(ctx.input('dataset'))) throw new Error('Input is not a dataset')
    return {}
  },
})
