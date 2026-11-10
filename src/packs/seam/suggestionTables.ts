/**
 * What `seam:suggestions` publishes, as the schema/value pairs invariant 3 asks for — except
 * that here the two halves are not written twice.
 *
 * ## One field table, both halves
 *
 * Each output is a list of `Field`s saying the column's name in SEAM's parquet, its name here,
 * its dtype and its unit. `schemaOf` builds the schema half from that list and `tableOf` builds
 * the value half from the same list, so a column renamed on one side is renamed on both and the
 * failure invariant 3 exists to catch cannot happen. The agreement test checks the derivation
 * rather than two hand-written lists.
 *
 * It also decides the read: the reader asks the file for exactly `from`, so a file missing a
 * column is a sentence naming it rather than a table with a silently absent picker.
 *
 * ## The schema is a contract, not a discovery
 *
 * `inferOutputs` may not fetch (invariant 2), so the columns have to be known before a byte is
 * read. That is the right way round anyway: a suggestion set whose columns are not these is a
 * different thing, and the node should say so rather than publish whatever arrived.
 *
 * ## Why only the ids are renamed
 *
 * SEAM's names are kept — `p_tip`, `geo_rank`, `min_dist_um` — because a reader of this table is
 * reading SEAM's own documents beside it, and `pTip` buys nothing for the cost of a lookup. The
 * exceptions are the two id columns, which become `neuronId` and `candidateId`: `isIdentifierColumn`
 * keys off a name ending in `id`, and that predicate is what the rest of Coda uses to keep a root
 * id out of a float (invariant 8). `top_cand_root` would not be recognised by it.
 *
 * The coordinates are the other exception: `x_nm` becomes `x` with the unit `nm` in the schema,
 * where Coda's unit machinery can see it, rather than in the name where only a human can.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { DType, TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { CellValue, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'

/** One published column: where it comes from, what it is called here, and what it is. */
export interface Field {
  /** The column's name in SEAM's parquet. */
  readonly from: string
  /** The column's name in the published table. */
  readonly name: string
  readonly dtype: DType
  readonly unit?: string
  /**
   * Read, but **not published**: a column the loader checks something against.
   *
   * `top_cand_root` is the case. It is the tips file's own copy of a fact the candidates table
   * already holds, and a duplicated 18-digit id is what this set got wrong once (see
   * `TIP_FIELDS`). Carrying it into the output would offer a reader two columns that must agree
   * and no way to tell which to trust; checking it and saying nothing when it agrees is the
   * whole of what it is worth.
   */
  readonly check?: true
}

const f = (from: string, name: string, dtype: DType, unit?: string): Field =>
  unit === undefined ? { from, name, dtype } : { from, name, dtype, unit }

/** A column read only so the loader can check it. Never reaches a published table. */
const check = (from: string, dtype: DType): Field => ({ from, name: from, dtype, check: true })

/**
 * The `from` of the one published column that does **not** come from the tips file.
 *
 * A field list drives the read, so a column the reader must not ask the file for needs a name
 * the file does not have. This one is filled in afterwards, from the candidates table.
 */
export const FIRST_CANDIDATE = '(first candidate)'

/**
 * The tips table: one row per tip, and the queue a reader works through.
 *
 * `shown` is SEAM's absolute cutoff applied (invariant 14) and `r` is the calibrated chance the
 * first candidate is right. Both are columns rather than a filter, so narrowing is a `Filter
 * Table` somebody can see.
 *
 * The verdict columns at the end are **SEAM's own review of rv2**, carried so a new round can be
 * compared against it. They are not Coda's: `seam:review` writes its own, under its own names, so
 * the two can never be mistaken for each other. `belongs`/`not_belongs` are `;`-joined candidate
 * ids, empty for "judged, none", and **null for a tip nobody judged** — a distinction worth
 * keeping, since 2,331 of the 2,708 tips were never looked at.
 */
export const TIP_FIELDS: readonly Field[] = [
  f('neuron', ID_COLUMN_NAME, 'str'),
  f('end_uid', 'end_uid', 'i64'),
  f('kind', 'kind', 'str'),
  f('x_nm', 'x', 'f64', 'nm'),
  f('y_nm', 'y', 'f64', 'nm'),
  f('z_nm', 'z', 'f64', 'nm'),
  f('e_tip', 'e_tip', 'f64'),
  f('segclr', 'segclr', 'f64'),
  f('p_tip', 'p_tip', 'f64'),
  /*
   * **Read and checked, never published.** `tips.parquet` carries its own copy of the first
   * candidate's root id, and in the set as first published that copy had been through a float64:
   * 2,661 of its 2,691 values named a different segment, and the 30 that survived were exactly
   * the ids that are multiples of 128. SEAM fixed it at the export (their `bccb484`) and now
   * checks it before writing; the loader checks it too, because a column that was wrong once in
   * a way nothing downstream could see is worth asking about on every read.
   *
   * The published id is joined from `candidates.parquet`, which is where it is authoritative. A
   * denormalised id is a copy of a fact, and this is what a copy of an 18-digit fact costs
   * (invariant 8).
   */
  check('top_cand_root', 'str'),
  f('top_vol_um3', 'vol_um3', 'f64', 'µm³'),
  f('top_geo_rank', 'geo_rank', 'f64'),
  f('top_min_dist_um', 'min_dist_um', 'f64', 'µm'),
  f('top_contact_x_nm', 'contact_x', 'f64', 'nm'),
  f('top_contact_y_nm', 'contact_y', 'f64', 'nm'),
  f('top_contact_z_nm', 'contact_z', 'f64', 'nm'),
  f('p_top', 'p_top', 'f64'),
  // Filled from the candidates file's rank-1 row, not from the column above. See `TIP_FIELDS`.
  f(FIRST_CANDIDATE, 'candidateId', 'str'),
  f('q', 'q', 'f64'),
  f('shown', 'shown', 'bool'),
  f('r', 'r', 'f64'),
  f('page', 'seam_page', 'str'),
  f('tip_verdict', 'seam_verdict', 'str'),
  f('belongs', 'seam_belongs', 'str'),
  f('not_belongs', 'seam_not_belongs', 'str'),
  f('first_right', 'seam_first_right', 'f64'),
]

/**
 * The candidates table: one row per candidate the own-tip rule kept, which is the ranked list a
 * reader sees as *context* beside a suggestion.
 *
 * The tip's own columns (`kind`, `p_tip`, the tip's position) are in the file and deliberately
 * not republished here: they are the tip's, they are already in `Tips`, and a join on `end_uid`
 * is how the two meet. At 103,375 rows a duplicated column is a hundred thousand repeated cells.
 *
 * `rank` is renumbered *within the kept list* — the own-tip rule runs before scoring and `ref`
 * reads the renumbered rank — so it is not `geo_rank`, which is the search's own order and is
 * kept beside it.
 */
export const CANDIDATE_FIELDS: readonly Field[] = [
  f('neuron', ID_COLUMN_NAME, 'str'),
  f('end_uid', 'end_uid', 'i64'),
  f('cand_root', 'candidateId', 'str'),
  f('rank', 'rank', 'i64'),
  f('geo_rank', 'geo_rank', 'i64'),
  f('vol_um3', 'vol_um3', 'f64', 'µm³'),
  f('min_dist_um', 'min_dist_um', 'f64', 'µm'),
  f('contact_x_nm', 'contact_x', 'f64', 'nm'),
  f('contact_y_nm', 'contact_y', 'f64', 'nm'),
  f('contact_z_nm', 'contact_z', 'f64', 'nm'),
  f('logit', 'logit', 'f64'),
  f('p_cand', 'p_cand', 'f64'),
  f('conf', 'conf', 'f64'),
  f('score_s0', 'score_s0', 'f64'),
  f('score_s1', 'score_s1', 'f64'),
  f('score_s2', 'score_s2', 'f64'),
  f('logit_s0', 'logit_s0', 'f64'),
  f('logit_s1', 'logit_s1', 'f64'),
  f('logit_s2', 'logit_s2', 'f64'),
  f('filled', 'filled', 'bool'),
  f('shown', 'shown', 'bool'),
]

/** The schema half, from a field list. */
export function schemaOf(fields: readonly Field[]): TableSchema {
  return tableSchema(...published(fields).map((f) => column(f.name, f.dtype, f.unit)))
}

/** The fields that reach a table. A `check` field is read and left out. */
export function published(fields: readonly Field[]): readonly Field[] {
  return fields.filter((field) => !field.check)
}

/**
 * The value half, from the same field list and a read's columns **keyed by their file names**.
 *
 * A missing column is an error here rather than an absent key, because the alternative is a table
 * whose schema promises a column that no picker downstream will ever be offered — invariant 3's
 * exact failure, arriving through the back door of a file rather than a mismatched pair.
 */
export function tableOf(
  fields: readonly Field[],
  read: Readonly<Record<string, CellValue[]>>,
  kind: TableValue['kind'] = 'table',
): TableValue {
  const data: Record<string, CellValue[]> = {}
  for (const field of published(fields)) {
    const cells = read[field.from]
    if (!cells) throw new Error(`The suggestion set's file has no \`${field.from}\` column.`)
    data[field.name] = cells
  }
  return makeTable(schemaOf(fields), data, kind)
}

/** The per-neuron summary's columns, folded onto the neurons this set covers. */
const NEURON_SUMMARY = [
  column('tips', 'i64'),
  column('shown', 'i64'),
  // Not a count: the handoff's own reading of r, which is a probability per tip, so its sum over
  // a neuron is how many of that neuron's shown firsts are expected to be right.
  column('expectedRight', 'f64'),
]

export function neuronsSchema(): TableSchema {
  return tableSchema(column(ID_COLUMN_NAME, 'str'), ...NEURON_SUMMARY)
}

/** What one neuron's tips came to. */
export interface NeuronTips {
  readonly tips: number
  readonly shown: number
  readonly expectedRight: number
}

/**
 * Fold the tips into one row per neuron, in the manifest's own neuron order.
 *
 * The manifest's order rather than the file's, so a set whose tips happen to be sorted by score
 * does not reorder the neuron list, and so a neuron the set names but has no tips for still gets
 * a row — zero tips is an answer, and an absent row is not.
 */
export function neuronsTable(
  neurons: readonly string[],
  perNeuron: ReadonlyMap<string, NeuronTips>,
): TableValue {
  const ids: CellValue[] = []
  const tips: CellValue[] = []
  const shown: CellValue[] = []
  const expected: CellValue[] = []
  for (const id of neurons) {
    const got = perNeuron.get(id)
    ids.push(id)
    tips.push(got?.tips ?? 0)
    shown.push(got?.shown ?? 0)
    expected.push(got?.expectedRight ?? 0)
  }
  return makeTable(
    neuronsSchema(),
    { [ID_COLUMN_NAME]: ids, tips, shown, expectedRight: expected },
    'neurons',
  )
}
