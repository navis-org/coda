/**
 * The VFB pack's tables: each node's schema half beside its value half (invariant 3).
 *
 * Kept apart from the node modules so the pairs can be tested against each other without a node,
 * and so the column names every node and help document reads are declared once — with the column
 * param and its warning the VFB nodes share, and the option lists a node and its viewer both read
 * (`GALLERY_VIEWS`).
 */

import type { ColumnParam, EvalContext } from '../../core/node'
import type { ColumnData, PointsValue, TableValue, TemplateSpaceId } from '../../core/values'
import {
  boundsOf,
  makeTable,
  optionalColumn,
  selectRows,
  tableFromRows,
} from '../../core/values'
import { column, tableSchema } from '../../core/types'
import type { TableSchema } from '../../core/types'
import type { VfbLine, VfbLineImage, VfbReference } from '../../data/vfb/bridge'
import type { PointCloud } from '../../data/vfb/pointCloud'
import { DRIVER_KINDS, REFERENCE_ROLES } from '../../data/vfb/bridge'
import { templateRank } from '../../data/vfb/templates'
import { groupBy } from '../../core/collections'
import { rowsMatching } from '../../nodes/lib/rowIds'
import { foldColumns } from '../../nodes/lib/tableOps'

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * A picker for a column holding one of VFB's own values — an FBbt id, a line id, a file URL — that
 * an earlier VFB node adds under a known name.
 *
 * `optional`, so a table without that column reads as unset instead of `resolveColumn`'s rule 3
 * substituting its first text column: a neuron id read as an FBbt id or a URL finds nothing and
 * says nothing (ZapBench's trap, CLAUDE.md). `excludeIds` keeps neuron ids out of the options,
 * since none of these columns is one.
 */
export function vfbColumnParam(
  spec: Pick<ColumnParam, 'id' | 'label' | 'from' | 'help'> & { default: string },
): ColumnParam {
  return { kind: 'column', dtypes: ['str'], optional: true, excludeIds: true, ...spec }
}

/** The picked column, or a warning in the same words on every VFB node and `undefined`. */
export function pickedColumn(
  ctx: EvalContext,
  param: string,
  what: string,
): string | undefined {
  const name = ctx.column(param)
  if (!name) ctx.warn(`Pick the column holding ${what}; nothing was looked up.`)
  return name
}

/** A text column of VFB ids, drawn as links to VFB's page for each (`ui/columnLinks.ts`). */
const vfbIdColumn = (name: string) => ({ ...column(name, 'str'), link: 'vfb' as const })

// ---------------------------------------------------------------------------
// VFB Neurons
// ---------------------------------------------------------------------------

/** The individual's own id, e.g. `VFB_fw000040`. */
const VFB_ID_COLUMN = 'vfbId'
/** The neuron's type, as an FBbt class id: the column Publications and Driver Lines read. */
export const FBBT_ID_COLUMN = 'fbbtId'

/** The FBbt type column Publications and Driver Lines both read off VFB Neurons' table. */
export const TYPE_COLUMN_PARAM: ColumnParam = vfbColumnParam({
  id: 'typeColumn',
  label: 'FBbt type column',
  from: 'types',
  default: FBBT_ID_COLUMN,
  help: 'Which column holds FBbt type ids, such as the fbbtId column VFB Neurons adds.',
})
const FBBT_LABEL_COLUMN = 'fbbtLabel'
/** How many `SUBCLASSOF` steps above VFB's asserted class the type was found; 0 is asserted. */
const FBBT_CLIMBED_COLUMN = 'fbbtClimbed'

const VFB_NEURON_COLUMNS = [
  vfbIdColumn(VFB_ID_COLUMN),
  vfbIdColumn(FBBT_ID_COLUMN),
  column(FBBT_LABEL_COLUMN, 'str'),
  column(FBBT_CLIMBED_COLUMN, 'i64'),
]

/** What VFB knows about one neuron. `undefined` fields are null cells. */
export interface NeuronAnswer {
  readonly vfbId: string
  readonly fbbtId?: string
  readonly fbbtLabel?: string
  readonly climbed?: number
}

/**
 * VFB Neurons' schema half: the wired table with the four columns folded in — written over a
 * column of the same name in its slot, appended otherwise (`foldColumns`' two rules).
 */
export function vfbNeuronsSchema(schema: TableSchema | undefined): TableSchema {
  return foldColumns(schema ?? tableSchema(), VFB_NEURON_COLUMNS)
}

/**
 * The value half. `ids` is each row's neuron id as text (null where the row has none), and a row
 * VFB does not hold keeps every cell it had, with nulls in the four columns: a lookup annotates,
 * it never drops a row.
 */
export function vfbNeuronsTable(
  table: TableValue,
  ids: readonly (string | null)[],
  answers: ReadonlyMap<string, NeuronAnswer>,
): TableValue {
  const rows = ids.map((id) => (id === null ? undefined : answers.get(id)))
  const cells = (pick: (a: NeuronAnswer) => string | number | undefined): ColumnData =>
    rows.map((answer) => (answer ? (pick(answer) ?? null) : null))
  return makeTable(
    vfbNeuronsSchema(table.schema),
    {
      ...table.data,
      [VFB_ID_COLUMN]: cells((a) => a.vfbId),
      [FBBT_ID_COLUMN]: cells((a) => a.fbbtId),
      [FBBT_LABEL_COLUMN]: cells((a) => a.fbbtLabel),
      [FBBT_CLIMBED_COLUMN]: cells((a) => a.climbed),
    },
    table.kind,
  )
}

// ---------------------------------------------------------------------------
// Publications
// ---------------------------------------------------------------------------

/**
 * One row per (type, paper). `doi` and `pmid` hold the bare identifiers, so they join and export
 * as themselves; the columns' `link` is what makes a table draw them as links.
 */
export const PUBLICATIONS_SCHEMA: TableSchema = tableSchema(
  vfbIdColumn(FBBT_ID_COLUMN),
  column(FBBT_LABEL_COLUMN, 'str'),
  column('neurons', 'i64'),
  column('citation', 'str'),
  column('title', 'str'),
  column('year', 'i64'),
  { ...column('doi', 'str'), link: 'doi' },
  { ...column('pmid', 'str'), link: 'pmid' },
  column('reference', 'str'),
  column('roles', 'str'),
)

/**
 * Publications' value half. Rows follow the order the types first appear in the input; within a
 * type, the strongest role first and then the newest paper.
 */
export function publicationsTable(
  types: readonly { readonly id: string; readonly neurons: number }[],
  references: readonly VfbReference[],
): TableValue {
  const byClass = groupBy(references, (r) => r.classId)
  // `roles` arrive in `REFERENCE_ROLES` order, strongest first, so the first is the strongest.
  const strongest = (r: VfbReference) => REFERENCE_ROLES.indexOf(r.roles[0]!)
  const rows = types.flatMap((type) =>
    (byClass.get(type.id) ?? [])
      .sort((a, b) => strongest(a) - strongest(b) || (b.year ?? 0) - (a.year ?? 0))
      .map((r) => ({
        [FBBT_ID_COLUMN]: type.id,
        [FBBT_LABEL_COLUMN]: r.classLabel,
        neurons: type.neurons,
        citation: r.citation,
        title: r.title ?? null,
        year: r.year ?? null,
        doi: r.doi ?? null,
        pmid: r.pmid ?? null,
        reference: r.pubId,
        roles: r.roles.join(', '),
      })),
  )
  return tableFromRows(PUBLICATIONS_SCHEMA, rows)
}

// ---------------------------------------------------------------------------
// Driver Lines
// ---------------------------------------------------------------------------

/** The expression pattern's VFB id: the column Expression Images reads. */
export const LINE_ID_COLUMN = 'lineId'
/** The line's short name, `MB074C`. */
export const LINE_COLUMN = 'line'

export const LINES_SCHEMA: TableSchema = tableSchema(
  vfbIdColumn(FBBT_ID_COLUMN),
  column(FBBT_LABEL_COLUMN, 'str'),
  column(LINE_COLUMN, 'str'),
  column('driver', 'str'),
  column('targets', 'i64'),
  column('images', 'i64'),
  column('construct', 'str'),
  vfbIdColumn(LINE_ID_COLUMN),
)

/**
 * Driver Lines' value half. Types in the order they first appear; within a type, split lines
 * first, then the lines labelling fewest other types, then the best-imaged.
 */
export function linesTable(typeIds: readonly string[], lines: readonly VfbLine[]): TableValue {
  const byClass = groupBy(lines, (l) => l.classId)
  const rows = typeIds.flatMap((id) =>
    (byClass.get(id) ?? [])
      .sort(
        (a, b) =>
          DRIVER_KINDS.indexOf(a.kind) - DRIVER_KINDS.indexOf(b.kind) ||
          a.targets - b.targets ||
          b.images - a.images,
      )
      .map((l) => ({
        [FBBT_ID_COLUMN]: id,
        [FBBT_LABEL_COLUMN]: l.classLabel,
        [LINE_COLUMN]: l.line,
        driver: l.kind,
        targets: l.targets,
        images: l.images,
        construct: l.construct,
        [LINE_ID_COLUMN]: l.lineId,
      })),
  )
  return tableFromRows(LINES_SCHEMA, rows)
}

// ---------------------------------------------------------------------------
// Expression Images
// ---------------------------------------------------------------------------

/** The image's VFB id; Load Expression's points carry it. */
export const IMAGE_ID_COLUMN = 'imageId'

/** Expression Images' columns by name: the schema, the rows and the gallery all read these. */
export const IMAGE_COLUMNS = {
  line: LINE_COLUMN,
  imageId: IMAGE_ID_COLUMN,
  specimen: 'specimen',
  part: 'part',
  template: 'template',
  dataset: 'dataset',
  license: 'license',
  thumbnail: 'thumbnail',
  /** The point cloud's URL: the column Load Expression reads. */
  obj: 'obj',
  nrrd: 'nrrd',
  lineId: LINE_ID_COLUMN,
} as const

const C = IMAGE_COLUMNS
export const IMAGES_SCHEMA: TableSchema = tableSchema(
  column(C.line, 'str'),
  vfbIdColumn(C.imageId),
  column(C.specimen, 'str'),
  column(C.part, 'str'),
  column(C.template, 'str'),
  column(C.dataset, 'str'),
  column(C.license, 'str'),
  column(C.thumbnail, 'str'),
  column(C.obj, 'str'),
  column(C.nrrd, 'str'),
  vfbIdColumn(C.lineId),
)

/**
 * Expression Images' value half: one row per registered image, lines in the order given, whole-
 * line images before fragments, then by template in `VFB_TEMPLATES`' order (the brain's first).
 * `names` maps a line id to the short name the input table gave it.
 */
export function imagesTable(
  lineIds: readonly string[],
  images: readonly VfbLineImage[],
  names: ReadonlyMap<string, string>,
): TableValue {
  const order = new Map(lineIds.map((id, i) => [id, i]))
  const rows = images
    .slice()
    .sort(
      (a, b) =>
        (order.get(a.lineId) ?? 0) - (order.get(b.lineId) ?? 0) ||
        Number(a.part === 'fragment') - Number(b.part === 'fragment') ||
        templateRank(a.template) - templateRank(b.template) ||
        a.label.localeCompare(b.label),
    )
    .map((i) => ({
      [C.line]: names.get(i.lineId) ?? null,
      [C.imageId]: i.imageId,
      [C.specimen]: i.label,
      [C.part]: i.part,
      [C.template]: i.template,
      [C.dataset]: i.dataset ?? null,
      [C.license]: i.license ?? null,
      [C.thumbnail]: i.thumbnail ?? null,
      [C.obj]: i.obj ?? null,
      [C.nrrd]: i.nrrd ?? null,
      [C.lineId]: i.lineId,
    }))
  return tableFromRows(IMAGES_SCHEMA, rows)
}

/** The Line Gallery's large view, in the order its switch shows them: the param and the switch. */
export const GALLERY_VIEWS = [
  { id: 'projection', label: 'Projection', title: 'Maximum projection, at full resolution' },
  { id: 'slices', label: 'Slices', title: 'Slices through the image stack (downloads it)' },
] as const
export type GalleryView = (typeof GALLERY_VIEWS)[number]['id']

// ---------------------------------------------------------------------------
// Load Expression
// ---------------------------------------------------------------------------

/** One row per point. */
export const EXPRESSION_SCHEMA: TableSchema = tableSchema(
  column(IMAGE_ID_COLUMN, 'str'),
  column(LINE_COLUMN, 'str'),
  column('intensity', 'f64'),
)

/** One image's cloud and what its points carry. */
export interface LoadedCloud {
  readonly imageId: string
  readonly line: string | null
  readonly cloud: PointCloud
}

/**
 * Load Expression's value half: every cloud's points concatenated, each carrying its image and
 * line. `space` is set only when every cloud is in the same template Coda has a space for.
 */
export function expressionPoints(
  clouds: readonly LoadedCloud[],
  space?: TemplateSpaceId,
): PointsValue {
  const total = clouds.reduce((n, c) => n + c.cloud.intensity.length, 0)
  const positions = new Float32Array(total * 3)
  const imageIds = new Array<string>(total)
  const lines = new Array<string | null>(total)
  const intensity = new Array<number>(total)
  let at = 0
  for (const { imageId, line, cloud } of clouds) {
    positions.set(cloud.positions, at * 3)
    const n = cloud.intensity.length
    imageIds.fill(imageId, at, at + n)
    lines.fill(line, at, at + n)
    for (let i = 0; i < n; i++) intensity[at + i] = cloud.intensity[i]!
    at += n
  }
  return {
    kind: 'points',
    positions,
    attributes: makeTable(EXPRESSION_SCHEMA, {
      [IMAGE_ID_COLUMN]: imageIds,
      [LINE_COLUMN]: lines,
      intensity,
    }),
    bounds: boundsOf([positions]),
    units: 'nm',
    ...(space ? { space } : {}),
  }
}

// ---------------------------------------------------------------------------
// Line Gallery
// ---------------------------------------------------------------------------

/**
 * The gallery's `Pinned` port: the input's rows whose image is pinned, in the input's order, with
 * the input's columns — so `Gallery → Load Expression` reads it exactly as it reads Expression
 * Images' own output.
 */
export function pinnedImagesTable(table: TableValue, pins: readonly string[]): TableValue {
  const ids = optionalColumn(table, IMAGE_ID_COLUMN)
  return ids
    ? rowsMatching(table, (row) => String(ids[row] ?? ''), pins)
    : selectRows(table, [])
}
