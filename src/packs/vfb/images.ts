/**
 * VFB Expression Images: the registered light-microscopy images of each driver line.
 *
 * Reads the `lineId` column Driver Lines adds. One row per image, with its specimen, the template
 * it is registered to, its dataset and licence, and the URLs of its files — the thumbnail, the
 * point cloud Load Expression reads, and the NRRD stack.
 *
 * Two decisions. **Whole-line images by default**, fragments (63x tiles and single-neuron images
 * of the line) behind a tick box, since they multiply the rows several-fold. **An image without a
 * point cloud is listed and counted**: 56% of the registrations measured on 2026-10-14 had only an
 * NRRD stack, which the 3D path cannot draw yet (`docs/vfb-plan.md`, the volume phase).
 */

import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import { getColumn, isTableValue, optionalColumn } from '../../core/values'
import { fetchLineImages } from '../../data/vfb/bridge'
import { JRC2018U_BRAIN, JRC2018U_VNC, VFB_TEMPLATES } from '../../data/vfb/templates'
import { nonEmpty } from '../../data/vfb/common'
import { plural } from '../../style/format'
import {
  IMAGES_SCHEMA,
  LINE_COLUMN,
  LINE_ID_COLUMN,
  imagesTable,
  pickedColumn,
  vfbColumnParam,
} from './ops'

export const imagesNode = packNode({
  type: 'vfb:images',
  label: 'VFB Expression Images',
  category: 'query',
  description: 'The registered light-microscopy images of each driver line, with their files.',
  guide:
    'Lists the registered images Virtual Fly Brain holds for each driver line, one row per ' +
    'image, with its template, dataset, licence and file URLs. Wire it after VFB Driver Lines, ' +
    'and on to VFB Load Expression to draw the images in a 3D View. Only images registered to ' +
    'JRC2018U brain line up with EM neurons transformed to that space.',
  cost: 'expensive',

  inputs: [{ id: 'lines', label: 'Lines', type: T.table() }],
  outputs: [{ id: 'out', label: 'Images', type: T.table(IMAGES_SCHEMA) }],

  params: [
    vfbColumnParam({
      id: 'lineColumn',
      label: 'Line id column',
      from: 'lines',
      default: LINE_ID_COLUMN,
      help: 'Which column holds VFB expression-pattern ids, such as the lineId column VFB Driver Lines adds.',
    }),
    {
      id: 'templates',
      kind: 'multiEnum',
      label: 'Templates',
      help: 'Which templates to list images in. A line imaged in the brain and the nerve cord has a registration in each. Only JRC2018U brain lines up with EM neurons transformed into Coda’s common space.',
      default: [JRC2018U_BRAIN, JRC2018U_VNC],
      options: VFB_TEMPLATES.map((t) => ({ value: t.id, label: t.label })),
      optionsWithoutPeek: true,
      emptyLabel: 'None — nothing is listed',
      noun: 'template',
    },
    {
      id: 'fragments',
      kind: 'boolean',
      label: 'Include fragments',
      help: 'Also list partial images of each line: high-magnification tiles and single-neuron images.',
      default: false,
    },
  ],

  inferOutputs: () => ({ out: T.table(IMAGES_SCHEMA) }),

  evaluate: async (ctx) => {
    const table = ctx.input('lines')
    if (!isTableValue(table)) throw new Error('Lines input is not a table')
    const lineColumn = pickedColumn(ctx, 'lineColumn', 'VFB line ids')
    if (!lineColumn) return { out: imagesTable([], [], new Map()) }
    // Each line once, with the short name the input gave it if it has a `line` column.
    const ids = getColumn(table, lineColumn)
    const names = optionalColumn(table, LINE_COLUMN)
    const nameOf = new Map<string, string>()
    ids.forEach((cell, i) => {
      const id = nonEmpty(cell)
      if (!id || nameOf.has(id)) return
      nameOf.set(id, nonEmpty(names?.[i]) ?? id)
    })
    const lineIds = [...nameOf.keys()]
    ctx.progress(0.1, `reading images for ${plural(lineIds.length, 'line')}`)
    const images = await fetchLineImages(
      lineIds,
      ctx.params.templates as string[],
      ctx.params.fragments as boolean,
      ctx.signal,
    )
    const unimaged = lineIds.length - new Set(images.map((i) => i.lineId)).size
    if (unimaged > 0) {
      ctx.warn(
        `${plural(unimaged, 'line has', 'lines have')} no image in the chosen templates.`,
      )
    }
    const flat = images.filter((i) => !i.obj).length
    if (flat > 0) {
      ctx.warn(
        `${plural(flat, 'image has', 'images have')} no point cloud, only an image stack, ` +
          `and cannot be drawn by VFB Load Expression yet.`,
      )
    }
    ctx.progress(1, plural(images.length, 'image'))
    return { out: imagesTable(lineIds, images, nameOf) }
  },
})
