/**
 * Clean Meshes: make an EM surface into something that can be drawn, measured or skeletonised.
 *
 * `Clean Skeletons`' counterpart, and the same argument for being one node: four operations
 * that compose in one order, where each changes what the next one sees.
 *
 * 1. **Drop internal membrane.** The one here that is not cosmetic. A neuron mesh out of EM
 *    segmentation carries an enormous amount of *invaginated* surface — membrane folded into
 *    the cell rather than bounding it — so any surface area taken from it is wrong by a lot
 *    and any volume is wrong by more. This fires rays off every face, keeps the ones that
 *    escape, and caps what that opens. It goes first because it is the only step that reads
 *    the *original* geometry: a decimated or smoothed mesh answers "does this ray escape"
 *    differently. It is also, by a wide margin, the expensive one.
 * 2. **Fill holes.** Cap whatever boundary rings are left — a neurite truncated at the edge of
 *    the dataset, a fragment that was never closed. After (1), which already caps what it cut.
 * 3. **Downsample.** Quadric decimation to a fraction of the faces. This is the control that
 *    makes a scene of fifty neurons draw.
 * 4. **Smooth.** Taubin by default, which is the filter that does *not* shrink the mesh.
 *    Last, because it moves vertices and changes neither count — so on the decimated mesh it
 *    costs a fraction of the work for the same result.
 *
 * ## Winding, which is the failure that does not announce itself
 *
 * Dropping internals fires each ray into the hemisphere its face's normal points into, so a
 * mesh wound *inward* reads as entirely buried and comes back empty, and one wound
 * *inconsistently* fails quietly — the faces that disagree read as buried and are cut out of
 * healthy membrane. Coda's meshes arrive outward-wound from every source, and the one
 * operation that reverses winding (`Mirror Neurons`) reverses each triple straight back. There
 * is nothing cheap to check this against, so nothing checks it; the node says so instead.
 *
 * ## What it does not do
 *
 * **It never changes how many meshes there are** — `Clean Skeletons`' rule, for the same
 * reason: the attribute table is index-aligned with the items, so a mesh that decimated away
 * to nothing stays in the collection as an empty one and the node says how many did.
 *
 * **It drops the level-of-detail caption** wherever the face count could have moved. That
 * caption reads *"this source publishes one level of detail, so meshes were simplified on
 * arrival to fit the triangle budget"*, every clause of which is false about a mesh somebody
 * decimated here on purpose. See `meshesFromResult`.
 */

import { registerNode } from '../../core/registry'
import { T, attributeSchema } from '../../core/types'
import { isMeshesValue, meshTriangleCount } from '../../core/values'
import { runCleanMeshes } from '../../pyodide/meshes'
import {
  changesFaces,
  checkDropInternalsSize,
  emptiedItems,
  isMeshNoOp,
  meshCleanParamsFrom,
  meshRequestFrom,
  meshesFromResult,
} from '../lib/cleanOps'

export const cleanMeshesNode = registerNode({
  type: 'neuron.cleanMeshes',
  label: 'Clean Meshes',
  category: 'transform',
  description: 'Strip internal membrane, cap holes, decimate and smooth mesh surfaces.',
  guide:
    'Four repairs an EM mesh usually wants, in the order they compose: strip the invaginated ' +
    'membrane folded into the cell, cap what is left open, decimate to a fraction of the ' +
    'faces, and smooth. Stripping internals is the one that changes a number rather than a ' +
    'picture — a raw segmentation mesh has far more surface inside it than around it, so any ' +
    'area or volume measured from one is wrong until this has run. It is also by far the ' +
    'slowest, being a ray cast per face.',
  cost: 'expensive',
  inputs: [{ id: 'in', label: 'Meshes', type: T.meshes() }],
  outputs: [{ id: 'out', label: 'Meshes', type: T.meshes() }],
  params: [
    {
      id: 'dropInternals',
      kind: 'boolean',
      label: 'Drop internal membrane',
      default: false,
      help:
        'Cut away the surface that is folded inside the cell rather than bounding it, and cap ' +
        'what that opens. This is what makes a surface area or a volume mean anything on a ' +
        'segmentation mesh. Off by default because it is the expensive one: a ray cast per ' +
        'face per pass, single-threaded.',
    },
    {
      id: 'openness',
      kind: 'number',
      label: 'Openness cutoff',
      default: 0.05,
      min: 0.01,
      max: 0.5,
      step: 0.01,
      advanced: true,
      visibleIf: (params) => params.dropInternals === true,
      help:
        'A face is cut when this fraction or fewer of the rays leaving it escape the mesh. ' +
        'Barely a tuning parameter: outer membrane lands at 0.5–1.0 and pocket wall at exactly ' +
        '0, so anything in 0.05–0.10 finds the same faces. Above about 0.1 the cut starts ' +
        'eating real membrane.',
    },
    {
      id: 'rays',
      kind: 'int',
      label: 'Rays per face',
      default: 16,
      min: 4,
      max: 64,
      step: 4,
      advanced: true,
      visibleIf: (params) => params.dropInternals === true,
      help:
        'The signal is bimodal, so this only has to tell “none got out” from “some did”. 8 ' +
        'halves the cost for no measured difference; 4 is visibly past the edge.',
    },
    {
      id: 'passes',
      kind: 'int',
      label: 'Passes',
      default: 3,
      min: 1,
      max: 6,
      step: 1,
      advanced: true,
      visibleIf: (params) => params.dropInternals === true,
      help:
        'Capping a pocket mouth turns a partly-open neighbour into a fully buried one, so this ' +
        'repeats. It converges fast — 18.7% of faces buried on the first pass, 0.5% on the ' +
        'second, 0.2% on the third.',
    },
    {
      id: 'fillHoles',
      kind: 'boolean',
      label: 'Fill holes',
      default: false,
      help:
        'Triangulate every boundary ring, including the ones the mesh arrived with — a ' +
        'neurite cut off at the edge of the dataset, say. Needed before anything asks the ' +
        'mesh for an enclosed volume, since an open surface does not have one.',
    },
    {
      id: 'ratio',
      kind: 'number',
      label: 'Keep faces',
      default: 1,
      min: 0.01,
      max: 1,
      step: 0.05,
      help:
        'Fraction of the triangles to keep, collapsing whichever edge costs least at each ' +
        'step. 1 leaves the mesh alone. This is the control that makes a large scene draw; ' +
        'note that a small disconnected fragment can be consumed entirely at a tight budget, ' +
        'because nothing is reserved per piece.',
    },
    {
      id: 'smooth',
      kind: 'int',
      label: 'Smoothing passes',
      default: 0,
      min: 0,
      max: 50,
      step: 1,
      help:
        'How many passes of the filter below. 0 leaves the vertices alone. Vertex count, face ' +
        'array and vertex order all come back unchanged, so anything indexed by vertex is ' +
        'still attached to the vertex it was attached to.',
    },
    {
      id: 'method',
      kind: 'enum',
      label: 'Filter',
      default: 'taubin',
      options: [
        { value: 'taubin', label: 'Taubin — does not shrink' },
        { value: 'laplacian', label: 'Laplacian — plain, shrinks' },
        { value: 'humphrey', label: 'Humphrey (HC) — gentle on detail' },
      ],
      advanced: true,
      visibleIf: (params) => Number(params.smooth ?? 0) > 0,
      help:
        'Taubin alternates a shrink and an inflate pass tuned to cancel, which is why it is ' +
        'the default. Plain Laplacian is the one to be careful with: at five passes a neuron ' +
        'mesh loses most of its enclosed volume, so reach for it when the mesh is a means to ' +
        'an end rather than when its volume means something.',
    },
    {
      id: 'volumeCorrection',
      kind: 'boolean',
      label: 'Correct volume',
      default: false,
      advanced: true,
      visibleIf: (params) => Number(params.smooth ?? 0) > 0,
      help:
        'Rescale the smoothed mesh about its own centroid so the enclosed volume matches what ' +
        'went in. Worth turning on with Laplacian and rarely needed with Taubin. A mesh with ' +
        'no usable volume — a flat sheet — comes back smoothed and unscaled.',
    },
  ],

  // Kind and schema straight through: this changes the surface and touches no column.
  inferOutputs: (ctx) => ({ out: T.meshes(attributeSchema(ctx.inputs.in, 'nodes')) }),

  validate: (ctx) => {
    const params = meshCleanParamsFrom(ctx.params)
    const issues: string[] = []
    if (isMeshNoOp(params)) {
      issues.push('Nothing is switched on, so this passes the meshes through')
    }
    if (params.smooth > 0 && params.method === 'laplacian' && !params.volumeCorrection) {
      // The one combination that quietly changes a measurement rather than a picture.
      issues.push('Laplacian shrinks — turn Correct volume on if the volume matters')
    }
    return issues
  },

  evaluate: async (ctx) => {
    const value = ctx.input('in')
    if (!isMeshesValue(value)) throw new Error('Clean Meshes takes a set of meshes.')
    if (value.items.length === 0) throw new Error('No meshes on the input')

    const params = meshCleanParamsFrom(ctx.params)
    // A pass-through rather than a refusal, `neuron.cleanSkeletons`' call: every control here
    // defaults to off, so a freshly wired node is the ordinary state rather than an error.
    if (isMeshNoOp(params)) return { out: value }

    checkDropInternalsSize(ctx, value, params)

    ctx.progress(
      0.01,
      `${value.items.length} meshes · ${meshTriangleCount(value).toLocaleString()} tris`,
    )
    const result = await runCleanMeshes(meshRequestFrom(value, params), {
      onProgress: ctx.progress,
      signal: ctx.signal,
    })

    const empty = emptiedItems(result.faceOffsets)
    if (empty > 0) {
      ctx.warn(
        `${empty} of ${value.items.length} meshes came back with no faces. They are still in ` +
          'the collection, so the attribute table still lines up. A mesh wound inward reads ' +
          'as entirely internal to Drop internal membrane, which is the usual cause.',
      )
    }
    return { out: meshesFromResult(value, result, !changesFaces(params)) }
  },
})
