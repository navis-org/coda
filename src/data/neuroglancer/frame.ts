/**
 * A scene's opening frame, read off its first volume — for a scene whose layers may not give
 * neuroglancer one.
 *
 * Neuroglancer takes its frame from whichever layer's coordinate space arrives first, and a
 * mesh-only directory (`neuroglancer_legacy_mesh`) arrives with no bounds: BigClust's own example,
 * the male CNS volume beside FlyWire's and hemibrain's transformed meshes, opened at the origin
 * with nothing on screen — whatever order the layers were in, measured in both builds. So the
 * scene says what neuroglancer works out for the volume alone — its finest resolution as the
 * dimensions, the middle of its box as the position — and its longest side as the 3D zoom, where
 * neuroglancer rounds that up to a power of two and leaves the brain a thumbnail in a card.
 *
 * Apart from `scene.ts` because it reads the network and that module is pure. A scene that already
 * says where to open, or in what units, is left as it is; so is one with no readable volume.
 */

import { isVolumeInfo } from '../precomputed/index'
import type { InfoKind } from '../precomputed/index'
import { fetchInfo } from '../precomputed/transport'
import type { NgScene } from './scene'
import { layerSourceUrl, nanometreDimensions } from './scene'
import { PRECOMPUTED, parseNgSource } from './sourceUrl'

/** What a volume's `info` says of its finest scale, which sets the frame. */
interface VolumeInfo extends InfoKind {
  scales?: readonly { resolution?: number[]; size?: number[]; voxel_offset?: number[] }[]
}

export async function framedScene(scene: NgScene, signal?: AbortSignal): Promise<NgScene> {
  if (scene.position !== undefined || scene.dimensions !== undefined) return scene
  const urls = ((scene.layers ?? []) as readonly Record<string, unknown>[])
    // A layer naming its segments is context (a brain shell), never what the neurons are drawn in.
    .filter((layer) => !(layer.segments as readonly string[] | undefined)?.length)
    .map((layer) => parseNgSource(layerSourceUrl(layer.source) ?? ''))
    .flatMap((ref) => (ref?.scheme === PRECOMPUTED && ref.url ? [ref.url] : []))
  // All asked at once, answered in layer order: the first volume wins without waiting on the rest.
  const infos = urls.map((url) =>
    fetchInfo<VolumeInfo>(url, { signal }).catch((error: unknown) => {
      if (signal?.aborted) throw error
      return undefined
    }),
  )
  for (const pending of infos) {
    const info = await pending
    if (!info || !isVolumeInfo(info)) continue
    const scale = info.scales?.[0]
    const dimensions = nanometreDimensions(scale?.resolution ?? [])
    const size = scale?.size
    if (!dimensions || size?.length !== 3) continue
    const offset = scale!.voxel_offset ?? [0, 0, 0]
    return {
      ...scene,
      dimensions,
      position: size.map((side, i) => (offset[i] ?? 0) + side / 2),
      projectionScale: Math.max(...size),
    }
  }
  return scene
}
