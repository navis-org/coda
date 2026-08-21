/**
 * A neuroglancer scene for a CAVE datastack, built rather than fetched.
 *
 * neuPrint publishes a curated state per dataset — the EM volume, the ROI shells, the synapse
 * layers, a camera somebody framed — and `fetchNgState` edits it. CAVE publishes no such
 * document, which is why this source reported "publishes no neuroglancer scene". But it does
 * publish every *part* of one, in the datastack's own info record: an image source, a
 * segmentation source, the viewer's voxel size and which deployment to open. So the scene is
 * assembled from those.
 *
 * **Two layers and nothing else, deliberately.** What a published state adds beyond this is
 * curation — region meshes, synapse layers, a framing — and inventing any of it would be
 * claiming the datastack said something it did not. The EM and the segmentation are exactly what
 * the record names.
 *
 * `layout` and `showSlices` are left off on purpose: `buildScene` supplies them when absent, so
 * a CAVE scene opens the same way a neuPrint one does rather than by a second rule here.
 */

import type { NgScene } from '../neuroglancer/scene'
import type { DatastackInfo } from './api'

/**
 * `middleauth+` on a graphene source, which is what makes the segmentation load at all.
 *
 * CAVE's segmentation is behind its auth, and a spelunker-flavoured neuroglancer authenticates
 * through the `middleauth+` prefix. Transcribed from `caveclient`'s `format_verbose_graphene`
 * and checked against it on both FlyWire's and Aedes' real sources: `graphene://https://host/p`
 * becomes `graphene://middleauth+https://host/p`, which is an insertion rather than the
 * reparse the Python does — `urlparse` reads that URL as `netloc='https:'`, and rebuilding it
 * from the parts only happens to work.
 */
function grapheneSource(raw: string): string {
  const prefix = 'graphene://'
  if (!raw.startsWith(prefix)) return raw
  const rest = raw.slice(prefix.length)
  return rest.startsWith('middleauth+') ? raw : `${prefix}middleauth+${rest}`
}

/**
 * The image source, used as published.
 *
 * Deliberately **not** `caveclient`'s formatter, which answers `None` for exactly the value
 * every datastack here publishes: `format_cave_explorer` routes a `precomputed://` scheme to
 * `format_precomputed_neuroglancer`, which handles `gs://`, `http://` and `https://` and falls
 * through to `None` for a URL that already carries its scheme. Checked by running it —
 * `precomputed://gs://flywire_em/aligned/v1` in, `None` out. The raw value is already what
 * neuroglancer wants, so it is passed through and only a bare `gs://` is prefixed.
 */
function imageSource(raw: string): string {
  return raw.includes('://') && !raw.startsWith('gs://') ? raw : `precomputed://${raw}`
}

/**
 * `viewer_resolution_*` is nanometres per voxel; neuroglancer's dimensions are metres.
 *
 * Absent on a datastack that does not publish it, and then the dimensions are left out
 * entirely rather than guessed — neuroglancer reads them off the sources, where a wrong scale
 * would silently misplace everything.
 */
function dimensionsOf(info: DatastackInfo): Record<string, [number, string]> | undefined {
  const nm = [info.viewer_resolution_x, info.viewer_resolution_y, info.viewer_resolution_z]
  if (!nm.every((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    return undefined
  }
  const [x, y, z] = nm as [number, number, number]
  // Divided, not multiplied by 1e-9: `45 * 1e-9` is 4.5000000000000006e-8 in float64 and that
  // artefact would be serialised into the URL verbatim. `45 / 1e9` is exactly 4.5e-8. Same for
  // 50; 16, 4, 40 and 8 are unaffected either way, which is why it survived the first reading.
  return { x: [x / 1e9, 'm'], y: [y / 1e9, 'm'], z: [z / 1e9, 'm'] }
}

/**
 * The scene, or undefined where the datastack names no segmentation.
 *
 * The segmentation is the one part that cannot be missing: it is the layer neuron ids are
 * written into, so without it there is nothing for the Neuroglancer node to do. An image source
 * is optional — a scene of segmentation alone is odd to look at but perfectly valid.
 */
export function caveScene(datastack: string, info: DatastackInfo): NgScene | undefined {
  if (!info.segmentation_source) return undefined
  const dimensions = dimensionsOf(info)
  const image = info.aligned_volume?.image_source

  return {
    ...(dimensions ? { dimensions } : {}),
    layers: [
      ...(image ? [{ type: 'image', name: 'EM', source: imageSource(image) }] : []),
      {
        type: 'segmentation',
        // Named after the datastack because `segmentationLayerIndex` finds the neuron layer by
        // name — it matches the dataset id's family, which for CAVE is the datastack. A layer
        // called anything else would be found only by the "first segmentation layer" fallback,
        // which is luck rather than a rule.
        name: datastack,
        source: grapheneSource(info.segmentation_source),
        segments: [] as string[],
      },
    ],
  }
}
