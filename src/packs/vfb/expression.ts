/**
 * VFB Load Expression: driver-line images as points, for a 3D View beside EM neurons.
 *
 * Reads the `obj` column Expression Images adds: VFB's `volume.obj` for a light-microscopy image,
 * which is a point cloud of the voxels VFB kept, with an intensity on each (`data/vfb/pointCloud.ts`).
 * Images registered to JRC2018U brain come out in Coda's common space, in nm, so `Transform` an EM
 * dataset's skeletons to JRC2018U and wire both into one 3D View.
 *
 * Four decisions, from what was measured on 2026-10-14.
 *
 * **A point cap per image, on by default.** A cloud is 16,508 to 482,191 points (0.95 to 28 MB):
 * Janelia's 20x split images are small, the VT GAL4 lines large. `Points per image` thins each to an
 * even stride, so a dozen lines still draws; 0 keeps every point. The size guard is the shared
 * `nodes/lib/pointsSize.ts` — a warning past five million points, a refusal at the crash floor —
 * and the downloads stop once the running total reaches the floor (`docs/limits.md`).
 *
 * **No intensity floor by default.** VFB has thresholded the clouds already (the lowest intensity
 * was 0.07 to 0.34 depending on the collection), so `Min intensity` starts at 0.
 *
 * **Only VFB's own file server is fetched.** The column is a picker over any table, so
 * `fetchPointCloud` checks each URL where it fetches, not only where Expression Images produced it.
 *
 * **A failed image is a counted gap** (`mapWithConcurrency`).
 */

import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import { getColumn, isTableValue, optionalColumn } from '../../core/values'
import { mapWithConcurrency } from '../../data/concurrency'
import { nonEmpty, vfbUrl } from '../../data/vfb/common'
import { capPoints, fetchPointCloud } from '../../data/vfb/pointCloud'
import { vfbTemplate } from '../../data/vfb/templates'
import { checkPointsSize, pointsOverCrashFloor } from '../../nodes/lib/pointsSize'
import { formatBytes, plural } from '../../style/format'
import type { LoadedCloud } from './ops'
import {
  EXPRESSION_SCHEMA,
  IMAGE_ID_COLUMN,
  LINE_COLUMN,
  IMAGE_COLUMNS,
  expressionPoints,
  pickedColumn,
  vfbColumnParam,
} from './ops'

/** Files in flight at once: polite to a shared file server, and most of a download's wait. */
const CONCURRENT_DOWNLOADS = 4

export const expressionNode = packNode({
  type: 'vfb:expression',
  label: 'VFB Load Expression',
  category: 'query',
  description: 'Load driver-line images as points, for a 3D View beside EM neurons.',
  guide:
    'Downloads each image’s point cloud from Virtual Fly Brain, so driver-line expression can be ' +
    'drawn in a 3D View. Wire it after VFB Expression Images. Images registered to JRC2018U ' +
    'brain land in Coda’s common space, so EM skeletons transformed to JRC2018U line up with ' +
    'them; each image is thinned to `Points per image`, since a single cloud can hold half a ' +
    'million points.',
  cost: 'expensive',

  inputs: [{ id: 'images', label: 'Images', type: T.table() }],
  outputs: [{ id: 'out', label: 'Points', type: T.points(EXPRESSION_SCHEMA) }],

  params: [
    vfbColumnParam({
      id: 'objColumn',
      label: 'Point cloud column',
      from: 'images',
      default: IMAGE_COLUMNS.obj,
      help: 'Which column holds the point-cloud URLs, such as the obj column VFB Expression Images adds.',
    }),
    {
      id: 'pointsPerImage',
      kind: 'int',
      label: 'Points per image',
      help: 'Thin each image to at most this many points, evenly. 0 keeps every point.',
      default: 50_000,
      min: 0,
      step: 10_000,
    },
    {
      id: 'minIntensity',
      kind: 'number',
      label: 'Min intensity',
      help: 'Drop points below this intensity (0 to 1). VFB has already thresholded the images, so 0 keeps what VFB kept.',
      default: 0,
      min: 0,
      max: 1,
      step: 0.05,
    },
  ],

  inferOutputs: () => ({ out: T.points(EXPRESSION_SCHEMA) }),

  evaluate: async (ctx) => {
    const table = ctx.input('images')
    if (!isTableValue(table)) throw new Error('Images input is not a table')
    const objColumn = pickedColumn(ctx, 'objColumn', 'point-cloud URLs')
    if (!objColumn) return { out: expressionPoints([]) }
    const imageIds = optionalColumn(table, IMAGE_ID_COLUMN)
    const lines = optionalColumn(table, LINE_COLUMN)
    const templates = optionalColumn(table, IMAGE_COLUMNS.template)

    const found: { url: string; imageId: string; line: string | null; template?: string }[] = []
    let skipped = 0
    getColumn(table, objColumn).forEach((cell, i) => {
      // Counted here; `fetchPointCloud` checks the URL again where it fetches.
      const url = vfbUrl(cell)
      if (!url) {
        skipped += 1
        return
      }
      found.push({
        url,
        imageId: nonEmpty(imageIds?.[i]) ?? url,
        line: nonEmpty(lines?.[i]) ?? null,
        template: nonEmpty(templates?.[i]),
      })
    })
    if (skipped > 0) {
      ctx.warn(
        `${plural(skipped, 'row is', 'rows are')} left out: no point cloud on Virtual Fly ` +
          `Brain's file server.`,
      )
    }

    // A points value has one space. Where any image is in a template Coda can place, those are
    // drawn and the others are counted out, so a brain scene stays in line with transformed EM;
    // where none is, everything is drawn without a space.
    const placeable = new Set(
      found.flatMap((j) => (j.template && vfbTemplate(j.template)?.space ? [j.template] : [])),
    )
    const only = placeable.size === 1 ? [...placeable][0] : undefined
    const space = vfbTemplate(only)?.space
    const jobs = only ? found.filter((j) => j.template === only) : found
    const unplaced = found.length - jobs.length
    if (unplaced > 0) {
      ctx.warn(
        `${plural(unplaced, 'image is', 'images are')} left out: registered to a template ` +
          `Coda has no frame for yet (the nerve cord's, for one), so ${unplaced === 1 ? 'it' : 'they'} ` +
          `would not line up with the rest.`,
      )
    } else if (!only && new Set(found.map((j) => j.template)).size > 1) {
      ctx.warn(
        'The images are registered to different templates, so no space is set on the points.',
      )
    }

    const cap = Number(ctx.params.pointsPerImage)
    const floor = Number(ctx.params.minIntensity)
    const columns = EXPRESSION_SCHEMA.columns.length
    const what = ` from ${plural(jobs.length, 'image')}`
    const lever = 'Lower Points per image, or load fewer images.'
    // The size is known only as the clouds arrive, so the remaining downloads stop the moment the
    // running total passes the crash floor rather than after every image has been fetched.
    const overFloor = new AbortController()
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, overFloor.signal])
      : overFloor.signal
    let done = 0
    let bytes = 0
    let thinned = 0
    let points = 0
    let loaded: Array<LoadedCloud | undefined>
    try {
      loaded = await mapWithConcurrency(
        jobs,
        CONCURRENT_DOWNLOADS,
        async (job): Promise<LoadedCloud> => {
          const read = await fetchPointCloud(job.url, floor, signal)
          bytes += read.bytes
          const cloud = capPoints(read.cloud, cap)
          if (cloud !== read.cloud) thinned += 1
          points += cloud.intensity.length
          if (pointsOverCrashFloor(points, columns)) overFloor.abort()
          ctx.progress(++done / Math.max(1, jobs.length), `${done} of ${jobs.length} images`)
          return { imageId: job.imageId, line: job.line, cloud }
        },
      )
    } catch (error) {
      // Refused in the shared words, with the total reached so far.
      if (overFloor.signal.aborted && !ctx.signal?.aborted) {
        checkPointsSize(ctx, points, columns, what, lever)
      }
      throw error
    }
    const clouds = loaded.filter((c) => c !== undefined)
    const failed = jobs.length - clouds.length
    if (failed > 0)
      ctx.warn(`${plural(failed, 'image is', 'images are')} left out: the download failed.`)
    if (thinned > 0) {
      ctx.warn(
        `${plural(thinned, 'image was', 'images were')} thinned to ${plural(cap, 'point')} ` +
          `(${formatBytes(bytes)} downloaded). Raise Points per image to draw more.`,
      )
    }
    checkPointsSize(ctx, points, columns, what, lever)
    return { out: expressionPoints(clouds, space) }
  },
})
