/**
 * Skeletonize Meshes: one skeleton per mesh, by skeletor's wavefront method.
 *
 * A wave spreads across each mesh from a seed vertex; vertices it reaches at the same step and
 * that touch each other form a ring, and each ring collapses to its centre, with a radius from
 * how far its vertices sit from that centre. A spanning tree weighted by radius and straightness
 * turns the rings into a tree, keeping the backbone and cutting at thin, crooked side branches.
 * The implementation is `pyodide/skeletonize.py`, which gives skeletor's own answer node for
 * node; see that file for what was cut and why.
 *
 * ## Fragments
 *
 * A segmented mesh is often in pieces, and each piece becomes a tree of its own, so a neuron can
 * come out as a skeleton with several roots. That is skeletor's answer and the default here. `Min
 * fragment size` removes pieces below a vertex count *before* skeletonizing, which is what keeps
 * the rest identical to skeletor run on the mesh without them; joining what is left is Clean
 * Skeletons' `Heal`, a separate decision.
 *
 * ## Tidying up after
 *
 * Both of skeletor's main callers clean its answer before handing it on, and the node offers the
 * same: `Shave` is navis' `mesh2skeleton` bristle pass or fafbseg's `skeletonize_neuron` thorough
 * one (which ends with the bristle pass, so the two nest), and `Fix zero radii` is navis' fix for
 * the radius-0 nodes the wavefront leaves at tips. Both default on, as they do in navis; switched
 * off, with no soma from the source, the answer is skeletor's. The thorough shave's long-edge
 * cutoff and the soma radius are the card's distances, so either in use is refused on voxel
 * coordinates.
 *
 * ## The soma
 *
 * Where the source says where a neuron's soma is (`MeshGeometry.soma`: neuPrint's `somaLocation`,
 * a CAVE nucleus table), the node labels the nearest node as the soma — SWC code 1, the form
 * every consumer that roots at a soma reads — and roots that skeleton there, unasked. `Clean up
 * soma` goes further: it drops the mesh pieces lying wholly inside the soma radius (the nuclear
 * envelope, on FlyWire), collapses the soma region before nodes are formed, then shaves the
 * debris around it; measured on six FlyWire neurons that turns the soma hairball into a soma
 * node with two to eight exits, at the price of short real twigs within about three soma radii.
 * `Detect soma` labels the widest node where the source says nothing — measured 2–8 µm from the
 * nucleus, so beside the soma rather than in it, and never collapsed around. The detected label
 * is a computed one, unlike every other `compartments` code in Coda; the user chose it, opt-in.
 *
 * ## What it does not do
 *
 * **It never changes how many items there are** — Clean Meshes' rule. A mesh whose every piece
 * was under the threshold comes back as an empty skeleton in its place, and the node says how
 * many did.
 *
 * **It does not decimate.** The wait is linear in vertices and is said in seconds before it
 * starts; the controls that shorten it are upstream, on Clean Meshes and the Meshes node.
 */

import { registerNode } from '../../core/registry'
import { T, attributeSchema } from '../../core/types'
import { isMeshesValue } from '../../core/values'
import { runSkeletonize } from '../../pyodide/skeletonize'
import { checkCleanUnits, micrometreMixup } from '../lib/cleanOps'
import {
  RADIUS_AGGS,
  SHAVES,
  emptiedMeshes,
  skeletonizeParamsFrom,
  skeletonizeRequestFrom,
  skeletonsFromMeshes,
  somaCounts,
  usesDistance,
  usesShaveCutoff,
  warnSkeletonizeWait,
} from '../lib/skeletonizeOps'
import { geometryPointCount } from '../lib/transformOps'

registerNode({
  type: 'neuron.skeletonize',
  label: 'Skeletonize Meshes',
  category: 'transform',
  description: 'Turn neuron meshes into skeletons, using the wavefront method.',
  guide:
    "Skeletonizes each mesh with skeletor's wavefront method, then shaves off the one-node " +
    'twigs it leaves along the backbone, as navis does. Where the dataset knows where the soma ' +
    'is, the soma is labelled and each skeleton rooted there; `Clean up soma` also clears the ' +
    'tangle the method leaves inside it. A mesh in several disconnected pieces becomes a ' +
    'skeleton with several roots; `Min fragment size` drops small pieces first, and Clean ' +
    'Skeletons can heal the rest into one tree.',
  cost: 'expensive',
  inputs: [{ id: 'in', label: 'Meshes', type: T.meshes() }],
  outputs: [{ id: 'out', label: 'Skeletons', type: T.skeletons() }],
  params: [
    {
      id: 'waves',
      kind: 'int',
      label: 'Waves',
      default: 1,
      min: 1,
      max: 10,
      step: 1,
      advanced: true,
      help: 'How many waves to run from different seeds and average. More waves give more nodes but also more noise. Each one adds to the run time.',
    },
    {
      id: 'stepSize',
      kind: 'int',
      label: 'Step size',
      default: 1,
      min: 1,
      max: 20,
      step: 1,
      help: 'How many mesh edges each ring spans. Values above 1 merge neighbouring rings, giving fewer, smoother nodes.',
    },
    {
      id: 'minFragment',
      kind: 'int',
      label: 'Min fragment size',
      default: 0,
      min: 0,
      step: 10,
      help: 'Disconnected mesh pieces with fewer vertices than this are removed before skeletonizing. 0 keeps every piece.',
    },
    {
      id: 'shave',
      kind: 'enum',
      label: 'Shave',
      default: 'bristles',
      options: SHAVES,
      help: 'Remove the short side twigs the wavefront leaves along the backbone. Bristles removes one-node twigs, as navis does; Thorough also removes short twigs and ones with a long edge, repeating until none are left, as fafbseg does.',
    },
    {
      id: 'shaveCutoff',
      kind: 'number',
      label: 'Long edge (µm)',
      default: 1,
      min: 0.01,
      step: 0.1,
      advanced: true,
      visibleIf: usesShaveCutoff,
      help: 'A terminal twig with an edge this long or longer is removed, by the Thorough shave and by Clean up soma around the soma. fafbseg uses 1 µm, tuned on fly neurons.',
    },
    {
      id: 'fixZeroRadii',
      kind: 'boolean',
      label: 'Fix zero radii',
      default: true,
      help: 'Give nodes with a radius of 0, mostly at the tips, half their parent’s radius, as navis does.',
    },
    {
      id: 'somaCleanup',
      kind: 'boolean',
      label: 'Clean up soma',
      default: false,
      help: 'Drop disconnected mesh pieces lying wholly inside the soma, such as the nuclear envelope, merge the soma into one node before the skeleton is built, then remove the short twigs left around it. Needs a soma position from the source. Short real twigs within about three soma radii are removed too.',
    },
    {
      id: 'somaRadius',
      kind: 'number',
      label: 'Soma radius (µm)',
      default: 3,
      min: 0.5,
      step: 0.5,
      advanced: true,
      help: 'How far the soma extends around the position the source gives. Used both to find the soma node and, with Clean up soma, as the region merged into it.',
    },
    {
      id: 'detectSoma',
      kind: 'boolean',
      label: 'Detect soma',
      default: false,
      help: 'Where the source gives no soma position, label the widest node as the soma and root the skeleton there. A guess: it is often near the soma rather than in it.',
    },
    {
      id: 'minSomaRadius',
      kind: 'number',
      label: 'Min soma radius (µm)',
      default: 1,
      min: 0,
      step: 0.1,
      advanced: true,
      visibleIf: (params) => params.detectSoma === true,
      help: 'A mesh whose widest node is narrower than this gets no detected soma.',
    },
    {
      id: 'radiusAgg',
      kind: 'enum',
      label: 'Radius',
      default: 'mean',
      options: RADIUS_AGGS,
      advanced: true,
      help: 'How each node’s radius is taken from the distances of its ring’s vertices to the ring’s centre.',
    },
  ],

  // The attribute table rides through: a skeleton made from a neuron's mesh is that neuron.
  inferOutputs: (ctx) => ({ out: T.skeletons(attributeSchema(ctx.inputs.in, 'nodes')) }),

  validate: (ctx) => {
    const params = skeletonizeParamsFrom(ctx.params)
    // A cutoff this long is nearly always nanometres typed into a micrometre field, and would
    // quietly mark no edge as long.
    const issues: string[] = []
    if (usesShaveCutoff(ctx.params) && params.shaveCutoff > 50) {
      issues.push(micrometreMixup('Long edge (µm)', params.shaveCutoff))
    }
    // A soma this wide is nearly always nanometres too, and would swallow most of the neuron.
    if (params.somaRadius > 50)
      issues.push(micrometreMixup('Soma radius (µm)', params.somaRadius))
    return issues
  },

  evaluate: async (ctx) => {
    const value = ctx.input('in')
    if (!isMeshesValue(value)) throw new Error('Skeletonize Meshes takes a set of meshes.')
    if (value.items.length === 0) throw new Error('No meshes on the input')

    const params = skeletonizeParamsFrom(ctx.params)
    checkCleanUnits(value, usesDistance(params))
    warnSkeletonizeWait(ctx, value, params.waves)

    ctx.progress(
      0.01,
      `${value.items.length} meshes · ${geometryPointCount(value).toLocaleString()} vertices`,
    )
    const result = await runSkeletonize(skeletonizeRequestFrom(value, params), {
      onProgress: ctx.progress,
      signal: ctx.signal,
    })

    // Said only where something asked for was not done: a cleanup needs the source's position,
    // and a detected soma is never collapsed around (`_skeleton_with_soma`).
    // From the meshes rather than the request, whose buffers the bridge detached on the call.
    const { placed, detected } = somaCounts(value, result)
    const unplaced = value.items.filter((item) => item.indices.length > 0).length - placed
    if (params.somaCleanup && unplaced > 0) {
      ctx.warn(
        `${unplaced} of ${value.items.length} meshes have no soma position from the source, so ` +
          'their soma was not cleaned up' +
          (detected > 0
            ? `; ${detected} of them had one detected, which is labelled but never merged.`
            : '.'),
      )
    }

    const emptied = emptiedMeshes(value, result)
    if (emptied > 0) {
      ctx.warn(
        `${emptied} of ${value.items.length} meshes had no piece of ` +
          `${params.minFragment.toLocaleString()} vertices or more, and came back as empty ` +
          'skeletons. They stay in the collection so the attribute table lines up; lower ' +
          '`Min fragment size` to keep them.',
      )
    }
    return { out: skeletonsFromMeshes(value, result) }
  },
})
