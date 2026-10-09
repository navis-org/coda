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

registerNode({
  type: 'neuron.cleanMeshes',
  label: 'Clean Meshes',
  category: 'transform',
  description: 'Remove internal membrane, fill holes, decimate and smooth meshes.',
  guide:
    'Four optional repairs for EM meshes, applied in this order: remove the membrane folded ' +
    'inside the cell, fill the holes that leaves, decimate to a fraction of the faces, and ' +
    'smooth. Remove internal membrane before measuring surface area or volume, since a raw ' +
    'segmentation mesh has more surface inside the cell than around it. It is by far the ' +
    'slowest step.',
  cost: 'expensive',
  inputs: [{ id: 'in', label: 'Meshes', type: T.meshes() }],
  outputs: [{ id: 'out', label: 'Meshes', type: T.meshes() }],
  params: [
    {
      id: 'dropInternals',
      kind: 'boolean',
      label: 'Drop internal membrane',
      default: false,
      help: 'Remove membrane folded inside the cell and cap the openings. Needed for a meaningful surface area or volume. Slow.',
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
      help: 'A face is removed when this fraction or fewer of the rays cast from it escape the mesh. Above about 0.1, real membrane starts being removed.',
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
      help: 'Rays cast per face to test whether it is internal. 8 is about twice as fast with no measured difference; 4 is too few.',
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
      help: 'How many rounds of removal to run, since capping one pocket can bury another. The default is usually enough.',
    },
    {
      id: 'fillHoles',
      kind: 'boolean',
      label: 'Fill holes',
      default: false,
      help: 'Close every hole in the mesh, including any it arrived with. Needed before measuring an enclosed volume.',
    },
    {
      id: 'ratio',
      kind: 'number',
      label: 'Keep faces',
      default: 1,
      min: 0.01,
      max: 1,
      step: 0.05,
      help: 'Fraction of triangles to keep; 1 leaves the mesh alone. Lower values help large scenes draw. At low values, small disconnected fragments can disappear.',
    },
    {
      id: 'smooth',
      kind: 'int',
      label: 'Smoothing passes',
      default: 0,
      min: 0,
      max: 50,
      step: 1,
      help: 'How many smoothing passes to run; 0 leaves the vertices alone. Vertex count and order do not change.',
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
      visibleIf: (params) => Number(params.smooth) > 0,
      help: 'The smoothing filter. "Laplacian — plain, shrinks" loses most of a neuron’s volume within five passes.',
    },
    {
      id: 'volumeCorrection',
      kind: 'boolean',
      label: 'Correct volume',
      default: false,
      advanced: true,
      visibleIf: (params) => Number(params.smooth) > 0,
      help: 'Rescale the smoothed mesh so its volume matches the original. Worth turning on with Laplacian, rarely needed with Taubin.',
    },
  ],

  // Kind and schema straight through: this changes the surface and touches no column.
  inferOutputs: (ctx) => ({ out: T.meshes(attributeSchema(ctx.inputs.in, 'nodes')) }),

  validate: (ctx) => {
    const params = meshCleanParamsFrom(ctx.params)
    const issues: string[] = []
    if (isMeshNoOp(params)) {
      issues.push('No cleaning step is switched on, so the meshes pass through unchanged.')
    }
    if (params.smooth > 0 && params.method === 'laplacian' && !params.volumeCorrection) {
      // The one combination that quietly changes a measurement rather than a picture.
      issues.push(
        'The "Laplacian" filter shrinks meshes. Turn on `Correct volume` if you need the volume to stay accurate.',
      )
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
        `${empty} of ${value.items.length} meshes came back with no faces. They stay in ` +
          `the collection so the attribute table lines up. The usual cause is a mesh wound ` +
          `inside out, which \`Drop internal membrane\` removes as entirely internal.`,
      )
    }
    return { out: meshesFromResult(value, result, !changesFaces(params)) }
  },
})
