/**
 * Neuropil shells on a wire.
 *
 * The one fetch node whose geometry is not a neuron. Everything else under `neuron.roi*` asks
 * about regions and answers with a *table* — counts, completeness, region-to-region weights —
 * and this answers with their shapes, so a scene can put an arbour inside the volume it
 * innervates instead of floating in the dark.
 *
 * ## Why a node, when the ROI Viewer already fetches these
 *
 * `out.rois` fetches for itself and draws its own 2D projection; nothing it downloads can leave
 * it. That is right for what it answers — "where in the brain is `LO(R)`, and how well is it
 * traced" — and useless for putting a shell behind somebody's neurons. A wire is the whole
 * difference: this node's output is an ordinary `MeshesValue`, so the 3D View's `Volumes`
 * socket takes it, `Download` writes it as OBJ, and a Filter upstream chooses which regions.
 *
 * ## `expensive`, and not marginally
 *
 * A region mesh is a separate request each, and a dataset's whole primary set is 29–62 MB —
 * four to nine times Explore's whole-dataset neuron index. The ROI Viewer gates that behind an
 * explicit Load button; here the `expensive` cost does the same job, since nothing expensive
 * runs without a Run.
 *
 * The type id sits in the `neuron.` namespace with the other three region nodes rather than
 * opening a `roi.` one for a single node. It is a namespace, not a claim about what the node
 * takes.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { ROI_MESH_SCHEMA } from '../../data/source'
import { datasetInfoFromType, datasetRequest, requireDataset, sourceSupports } from '../lib/datasetParam'

/**
 * Ceiling on an explicit region list.
 *
 * It bounds the *typed* selection only — an empty list means the source's primary set, which is
 * 63 regions on hemibrain and 144 on male-CNS, and which the source picks precisely because it
 * knows better than a number here would. What this refuses is somebody chipping a hundred
 * regions into the picker one at a time and then wondering why the tab is unresponsive.
 */
export const MAX_REGIONS = 60

export const roiMeshesNode = registerNode({
  type: 'neuron.roiMeshes',
  label: 'ROI Meshes',
  category: 'query',
  description: 'Fetch the 3D shells of a dataset’s neuropil regions.',
  guide:
    'The 3D shape of the dataset’s neuropils, as meshes on a wire — so the 3D View can draw an arbour inside the region it innervates. Pick regions by name, or leave the picker empty for the set that tiles the volume. Each shell is a separate request and a whole primary set runs to tens of megabytes, so this waits for an explicit Run.',
  cost: 'expensive',
  inputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  outputs: [{ id: 'meshes', label: 'Volumes', type: T.meshes(ROI_MESH_SCHEMA) }],
  params: [
    {
      id: 'rois',
      kind: 'multiEnum',
      label: 'Regions',
      noun: 'region',
      /*
       * Empty means the primary set, matching `RoiMeshRequest.rois` exactly rather than
       * re-deciding here. The reason lives at that seam: the published list *nests*, so "every
       * region" is thousands of requests drawing each shell inside another one, and only the
       * source knows which of its regions tile.
       */
      emptyLabel: 'the primary set',
      help: 'Which neuropils to fetch. Empty means the set that tiles the volume — the regions that do not sit inside one another.',
      default: [],
      options: (ctx) => {
        const info = datasetInfoFromType(ctx.inputs.dataset)
        /*
         * Alphabetical, overriding the source's own order.
         *
         * `DatasetInfo.rois` arrives "in a sensible display order", which is the right default
         * for a list somebody *reads* — it groups a hierarchy the way the dataset thinks about
         * it. This is a list somebody *searches*, one name at a time, in a dropdown of 144, and
         * the only order that helps there is the one the eye can binary-search.
         */
        return [...(info?.rois ?? [])]
          .sort((a, b) => a.localeCompare(b))
          .map((roi) => ({ value: roi, label: roi }))
      },
    },
  ],

  /*
   * Fixed and known before anything runs, like `roiCompleteness`'s: `ROI_MESH_SCHEMA` is the
   * same two columns from every source that can answer at all, so a colour picker downstream
   * populates the moment the wire is made rather than after the first Run.
   */
  inferOutputs: () => ({ meshes: T.meshes(ROI_MESH_SCHEMA) }),

  validate: (ctx) => {
    const issues: string[] = []
    if (ctx.inputs.dataset && !sourceSupports(ctx, 'roiMeshes')) {
      issues.push('This dataset publishes no region meshes')
    }

    /*
     * A region named here that the dataset does not publish is worth saying *before* a run
     * rather than after one: the source answers a missing region with nothing, so the failure
     * is a shell quietly absent from a scene, which reads as a rendering problem.
     */
    const known = datasetInfoFromType(ctx.inputs.dataset)?.rois
    const chosen = asNames(ctx.params.rois)
    if (known?.length) {
      const missing = chosen.filter((roi) => !known.includes(roi))
      if (missing.length > 0) {
        issues.push(`This dataset has no region called ${missing.join(', ')}`)
      }
    }
    if (chosen.length > MAX_REGIONS) {
      issues.push(`${chosen.length} regions exceeds this node's limit of ${MAX_REGIONS}`)
    }
    return issues
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchRoiMeshes) {
      throw new Error(`${source.label} does not provide region meshes`)
    }

    const rois = asNames(ctx.params.rois)
    if (rois.length > MAX_REGIONS) {
      throw new Error(
        `${rois.length} regions exceeds this node's limit of ${MAX_REGIONS}. Each shell is a ` +
          `separate request. Choose fewer, or empty the picker for the primary set.`,
      )
    }

    ctx.progress(0.02, rois.length > 0 ? `${rois.length} regions` : 'the primary set')
    const meshes = await source.fetchRoiMeshes({
      ...datasetRequest(dataset),
      // Omitted rather than empty: the two mean different things at this seam, and an empty
      // array asks a source for no regions at all.
      ...(rois.length > 0 ? { rois } : {}),
      onProgress: ctx.progress,
      signal: ctx.signal,
    })
    return { meshes }
  },
})

function asNames(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}
