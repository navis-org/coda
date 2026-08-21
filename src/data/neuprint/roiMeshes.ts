/**
 * neuPrint's neuropil shells.
 *
 * One request per region against `/api/roimeshes/mesh/<dataset>/<roi>`, which answers OBJ text.
 * The sibling of `roiSummary.ts`: that one fetches the numbers about a region, this one fetches
 * its shape.
 *
 * ## What the endpoint actually does, checked rather than assumed
 *
 * Every rule here came out of `scripts/probe-roimeshes.mjs` run against the live server, and
 * three of them would each have produced a plausible wrong result:
 *
 *  - **It 404s on `HEAD` and 200s on `GET`.** The probe's first version asked with HEAD and
 *    reported every dataset as having no meshes at all, directly above the megabytes of OBJ its
 *    own GETs had just printed. Nothing here uses HEAD.
 *  - **Coordinates are dataset voxels**, like skeletons and synapses and unlike the precomputed
 *    meshes, which arrive in nanometres. Unscaled, the shells sit a whole factor away from any
 *    neuron drawn beside them — with nothing failing, because both sets are internally
 *    consistent. `units.ts` is the same conversion `fetchSkeletons` applies.
 *  - **The OBJ dialect differs by dataset.** hemibrain writes bare `f 1 2 3` with no normals;
 *    male-CNS, MANC and optic-lobe write `f 1//1 2//2 3//3`. `parseObj` handles both, and a
 *    parser assuming the first would read normal indices as vertex indices on three datasets out
 *    of four without failing.
 *
 * ## A missing mesh is an answer
 *
 * Four of the thirteen datasets — banc, fib19, mushroombody, wasp3 — refuse every region with a
 * 400, which is what `capabilities.roiMeshes` exists to declare. Within a dataset that does
 * publish them, male-CNS refuses exactly five: `CentralBrain-unspecified`, `VNC-unspecified` and
 * their siblings, which collect synapses not assigned to a named neuropil and are not shapes. So
 * a refusal for one region is skipped and counted rather than failing the batch, and the widget
 * says `139 of 144`.
 *
 * ## It is large, and that is the caller's problem to state
 *
 * 29 MB gzipped for hemibrain's 63 regions, 62 MB for male-CNS's 139; the median region is under
 * a megabyte and the largest is 11.5 MB. Meshes are decimated on arrival so that what is *kept*
 * is roughly a sixteenth of that, but the download is the download — which is why the widget
 * asks before starting it rather than fetching on mount.
 */

import { mapWithConcurrency } from '../concurrency'
import { objProblem, parseObj } from '../obj'
import { decimateMesh } from '../meshDecimate'
import type { MeshGeometry } from '../../core/values'
import type { RequestOptions } from './client'
import { NeuPrintError, getText } from './client'
import type { VoxelScale } from './units'
import { scalePositions } from './units'

/**
 * How many region requests are in flight at once.
 *
 * Lower than the geometry fetches' concurrency, because these are far larger per request: six
 * simultaneous multi-megabyte transfers against a shared production server is not neighbourly,
 * and the wall-clock gain over four is inside the noise on a link that is already saturated.
 */
const ROI_MESH_CONCURRENCY = 4

/**
 * The path for one region's mesh.
 *
 * The dataset id is **not** percent-encoded past its colon: every id has one and neuPrint's
 * router matches the raw segment, so `%3A` gets a 400. The region name *is* encoded — `a'L(R)`
 * and `ME(R)` carry characters that are not path-safe.
 */
export function roiMeshPath(datasetId: string, roi: string): string {
  const dataset = encodeURIComponent(datasetId).replace(/%3A/gi, ':')
  return `/api/roimeshes/mesh/${dataset}/${encodeURIComponent(roi)}`
}

export interface RoiMeshResult {
  /** One mesh per region that answered, in request order. */
  items: MeshGeometry[]
  /** Regions that were asked for and published nothing. */
  missing: string[]
  /** Bytes of OBJ text that arrived, for a caption that can say what it cost. */
  bytes: number
}

/**
 * Fetch and decode the shells for a list of regions.
 *
 * Progress is reported per region as it lands rather than once at the end: this is the slowest
 * thing in the app by a wide margin, and only the code doing the fanning out knows how far along
 * it is.
 */
export async function fetchRoiMeshSet(
  datasetId: string,
  rois: readonly string[],
  scale: VoxelScale,
  options: RequestOptions & { onProgress?: (fraction: number, note?: string) => void } = {},
): Promise<RoiMeshResult> {
  const missing: string[] = []
  let bytes = 0
  let done = 0

  const results = await mapWithConcurrency<string, MeshGeometry | undefined>(
    rois,
    ROI_MESH_CONCURRENCY,
    async (roi) => {
      let text: string
      try {
        text = await getText(roiMeshPath(datasetId, roi), options)
      } catch (error) {
        /*
         * A 400 or a 404 for one region means this dataset publishes no shape for it, which is a
         * fact rather than a failure — see the `-unspecified` buckets above. Anything else is a
         * real problem and is rethrown, so `mapWithConcurrency`'s "every item failed" rule can
         * still tell a patchy dataset from a broken request.
         */
        if (error instanceof NeuPrintError && (error.status === 400 || error.status === 404)) {
          missing.push(roi)
          done++
          options.onProgress?.(done / Math.max(1, rois.length), roi)
          return undefined
        }
        throw error
      }

      bytes += text.length
      const mesh = parseObj(text)
      const problem = objProblem(mesh, text, `The mesh for ${roi}`)
      if (problem) {
        // A 200 that is not a mesh is overwhelmingly an error page. Counting it as missing rather
        // than throwing keeps one bad region from losing the other sixty-two, and the caller
        // reports the count.
        missing.push(roi)
        done++
        options.onProgress?.(done / Math.max(1, rois.length), roi)
        return undefined
      }

      /*
       * Decimate before the mesh is held, not after the batch. Full resolution is 32 MB of typed
       * array for hemibrain and 75 MB for male-CNS, and the outline tracer rasterises to a
       * 512-pixel grid where a few thousand vertices per region is already more than the picture
       * can express.
       */
      const reduced = decimateMesh(mesh.positions, mesh.indices)
      done++
      options.onProgress?.(done / Math.max(1, rois.length), roi)
      return {
        id: roi,
        // In place: `decimateMesh` returned a fresh array unless it had nothing to merge, and in
        // that case the array is the parse's own and equally ours to scale.
        positions: scalePositions(reduced.positions, scale),
        indices: reduced.indices,
      } satisfies MeshGeometry
    },
  )

  return {
    items: results.filter((item): item is MeshGeometry => item !== undefined),
    // Request order, so a caption listing them reads the way the dataset lists them.
    missing: rois.filter((roi) => missing.includes(roi)),
    bytes,
  }
}
