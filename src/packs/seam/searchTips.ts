/**
 * The table layer around `searchRun.ts`: a `Tips` table in, `Tips` and `Candidates` back out.
 *
 * `searchRun.ts` knows about ends, pools and rules and nothing about Coda's tables; this is the
 * one place that reads SEAM's published column names out of a value and writes them back. Keeping
 * it apart is what lets `searchRun.test.ts` fake the three bridge steps with plain arrays.
 *
 * ## It publishes what the search measured, and nothing else
 *
 * Stages 4 and 5 answer **where** a candidate is and **how the forest ranks it**. They say
 * nothing about how likely the merge is to be right: `p_cand`, `conf`, `logit`, the three
 * assessor scores, `filled` and `shown` are stage 6 and later, which needs models Coda cannot
 * run yet.
 *
 * Those columns are **absent, not null**. An earlier draft published the full shape
 * `seam:suggestions` reads, with eleven nulls, so the two nodes' tables matched column for
 * column. That coupling is gone deliberately (2026-11-15, user): `seam:suggestions` is modelled
 * on an earlier SEAM pipeline and its output is going to change, so pinning this node's shape to
 * it would pin it to something that is about to move. A column picker offered `p_cand` on a node
 * that can never fill it is worse than not being offered it.
 *
 * `seam:review` takes either, because it reads every column by name through an accessor that
 * answers `undefined` for one that is not there.
 *
 * ## The field machinery is shared; the lists are not
 *
 * Both outputs go through `suggestionTables.ts`' `Field`/`schemaOf`/`tableOf` — one derivation of
 * the schema half and the value half from one list, which is invariant 3's whole point. What
 * each node declares is its own list.
 */

import { ID_COLUMN_NAME, idText, isSegmentId } from '../../core/ids'
import { groupBy } from '../../core/collections'
import type { TableSchema } from '../../core/types'
import type { CellValue, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { foldColumns } from '../../nodes/lib/tableOps'
import type { SearchedEnd } from './searchRun'
import type { Field } from './suggestionTables'
import { field, numberAt, published, schemaOf, tableOf } from './suggestionTables'

/** One row of an incoming `Tips` table, as the search needs it. */
export interface TipRow {
  /** The neuron the end belongs to — the root the box is about. */
  readonly neuronId: string
  /** The tip's own id within that neuron, carried onto every candidate row. */
  readonly endUid: number
  /** Where the end is, in nanometres. */
  readonly nm: readonly [number, number, number]
  /**
   * Which row of the table it was read from.
   *
   * Carried rather than looked up again. `tipsFromTable` drops rows it could not read, so a
   * tip's position in the list it returns is **not** its row — and the obvious repair, keying
   * both sides on `(neuron, end_uid)`, reads the table twice through different accessors:
   * `idText` here and `String` there, which disagree about `' 720 '` and about an id that has
   * been through a float. The row the reader already measured cannot disagree with itself.
   */
  readonly row: number
}

/**
 * One candidate row, as this node publishes it.
 *
 * `rank` and `geo_rank` are the same number, and that is not a coincidence waiting to break:
 * SEAM's published lists are post-own-tip and numbered `1..n`, and `searchRun.ts` renumbers
 * `geo_rank` over the kept list for exactly that reason. `rank` is that renumbering under the
 * name `seam:review` reads.
 */
export const SEARCH_CANDIDATE_FIELDS: readonly Field[] = [
  field('neuron', ID_COLUMN_NAME, 'str'),
  field('end_uid', 'end_uid', 'i64'),
  field('cand_root', 'candidateId', 'str'),
  field('rank', 'rank', 'i64'),
  field('geo_rank', 'geo_rank', 'i64'),
  field('vol_um3', 'vol_um3', 'f64', 'µm³'),
  field('min_dist_um', 'min_dist_um', 'f64', 'µm'),
  field('contact_x_nm', 'contact_x', 'f64', 'nm'),
  field('contact_y_nm', 'contact_y', 'f64', 'nm'),
  field('contact_z_nm', 'contact_z', 'f64', 'nm'),
]

/**
 * What this node folds onto a tip row: its **first** candidate.
 *
 * The queue a reader works through is one row per tip, so the first candidate's measurements ride
 * on the tip beside the end's own. The rest of its list is in `Candidates`, joined on
 * `(neuronId, end_uid)`.
 *
 * **Derived from the candidate list, not written out beside it.** The two describe the same
 * measurements, and a second literal is how they come to disagree about one column's unit —
 * which would be invariant 3's failure within a single file, between a schema a picker reads and
 * a number somebody plots. What a tip does *not* get is the candidate's identity columns:
 * `neuron` and `end_uid` are already the tip's own, and `rank` is 1 by definition here.
 */
export const SEARCH_TIP_FIELDS: readonly Field[] = SEARCH_CANDIDATE_FIELDS.filter(
  (one) => !['neuron', 'end_uid', 'rank'].includes(one.from),
)

/** The columns a `Tips` table must have before anything can be searched. */
const NEEDED = [ID_COLUMN_NAME, 'end_uid', 'x', 'y', 'z'] as const

/**
 * Read a `Tips` table into the rows the search works from.
 *
 * **Refuses by name, and before any fetch.** A tips table without `x` would otherwise reach
 * `boxAround` as `NaN` and come back as a box somewhere near the origin — full of segmentation,
 * ranked without complaint, and wrong about every end.
 *
 * A row that cannot be searched — no position, no `end_uid`, or a neuron that is not a
 * chunkedgraph id — is dropped rather than refused: a tip nothing could be measured at is an
 * ordinary row in a table somebody filtered or joined, and the count comes back so the node can
 * say so.
 */
export function tipsFromTable(table: TableValue): { rows: TipRow[]; dropped: number } {
  const missing = NEEDED.filter((name) => !table.data[name])
  if (missing.length > 0) {
    throw new Error(
      `The Tips table has no \`${missing.join('`, `')}\` column, so there is no open end to ` +
        'search. Wire this to Find Open Ends or Merge Suggestions.',
    )
  }
  const rows: TipRow[] = []
  let dropped = 0
  const length = table.data[ID_COLUMN_NAME]!.length
  for (let i = 0; i < length; i++) {
    /*
     * **`idText`, not `String(cell)`** — invariant 8's one definition. It answers `null` for a
     * cell that is not a sound id, which is what an 18-digit root that has been through a float64
     * is: `String` would hand back `"7.2e+17"`, which passes every guard below and throws at
     * `BigInt` in the middle of the run, hundreds of boxes in.
     */
    const neuronId = idText(table.data[ID_COLUMN_NAME]?.[i] ?? null)
    const x = numberAt(table, 'x', i)
    const y = numberAt(table, 'y', i)
    const z = numberAt(table, 'z', i)
    /*
     * **`isSegmentId`, as well as `idText`.** `idText` answers "is this a sound id", and a
     * neuron *name* is one — `LC4` is a perfectly good id in a neuPrint table. The search needs
     * a chunkedgraph root, which `BigInt` is about to parse, and a name reaches that as a raw
     * `SyntaxError` after the forest and the volume have been fetched. `isSegmentId` is the
     * narrower grammar for exactly this (`core/ids.ts`), so the row is dropped and counted here
     * with everything else that could not be read.
     *
     * `end_uid` is **not** defaulted to the row number. It is this tip's identity downstream —
     * `reviewQueue` merges a tip with its candidate list on `(neuron, end_uid)` alone — so a
     * row index standing in for a missing one can collide with another row's real `end_uid` and
     * silently merge two tips' lists.
     */
    const endUid = numberAt(table, 'end_uid', i)
    if (
      !neuronId ||
      !isSegmentId(neuronId) ||
      endUid === undefined ||
      x === undefined ||
      y === undefined ||
      z === undefined
    ) {
      dropped += 1
      continue
    }
    rows.push({ neuronId, endUid, nm: [x, y, z], row: i })
  }
  return { rows, dropped }
}

/**
 * Which rows belong to each neuron, in the table's own order.
 *
 * The own-tip rule is per neuron — a candidate is dropped for being nearer *another of this
 * neuron's* ends — so the search runs a neuron at a time. A `Map` keeps the first-seen order, so
 * a table sorted by neuron is searched in the order a reader sees.
 */
export function tipsByNeuron(rows: readonly TipRow[]): Map<string, number[]> {
  return groupBy(rows.keys(), (at) => rows[at]!.neuronId)
}

/**
 * The pool columns a candidate row carries straight through, by their name in SEAM's own files.
 *
 * **Derived, not typed out.** The measurements are what is left of a candidate row once its
 * identity (`neuron`, `cand_root`) and its two numberings (`rank`, `geo_rank`) are taken away —
 * those four are written rather than copied. A measurement added to `SEARCH_CANDIDATE_FIELDS`
 * and forgotten here would leave `candidatesTable` with one empty column beside n-length ones,
 * and `tableOf` hands that to `makeTable` without a length: a ragged table, not a throw. One
 * list, and the two cannot come apart.
 */
const FROM_SEARCH: readonly string[] = SEARCH_TIP_FIELDS.filter(
  (one) => one.from !== 'cand_root' && one.from !== 'geo_rank',
).map((one) => one.from)

/**
 * One neuron's tips as `searchEnds` takes them: `n × 3` nanometres, in the order given.
 *
 * Here rather than in the node because it is the table↔search crossing this module owns, and
 * because `Float32Array` is a decision rather than a detail — a nanometre coordinate in a fly
 * brain is up to ~10⁶, which float32 holds to well under a voxel, and `ownTipRule` compares
 * these against each other rather than against the box.
 */
export function tipPositions(tips: readonly TipRow[]): Float32Array {
  const out = new Float32Array(tips.length * 3)
  for (let i = 0; i < tips.length; i++) out.set(tips[i]!.nm, i * 3)
  return out
}

/**
 * The ranked lists of every searched end, as one `Candidates` table.
 *
 * `ends` are `searchEnds`' answers and `tips` the rows they were built from, **in the same
 * order** — `SearchedEnd.tip` indexes `tips`, as `ownTipRule` means it.
 */
export function candidatesTable(
  ends: readonly SearchedEnd[],
  tips: readonly TipRow[],
): TableValue {
  const read: Record<string, CellValue[]> = {}
  for (const one of published(SEARCH_CANDIDATE_FIELDS)) read[one.from] = []
  for (const end of ends) {
    const tip = tips[end.tip]
    if (!tip) continue
    for (let at = 0; at < end.rows; at++) {
      read['neuron']!.push(tip.neuronId)
      read['end_uid']!.push(tip.endUid)
      read['cand_root']!.push(String(end.candRoot[at]!))
      read['rank']!.push(at + 1)
      read['geo_rank']!.push(cell(end.columns['geo_rank'], at) ?? at + 1)
      for (const from of FROM_SEARCH) read[from]!.push(cell(end.columns[from], at))
    }
  }
  return tableOf(SEARCH_CANDIDATE_FIELDS, read)
}

function cell(column: Float64Array | undefined, at: number): number | null {
  const value = column?.[at]
  return value === undefined || !Number.isFinite(value) ? null : value
}

/**
 * The tips table with each end's **first candidate** written onto it.
 *
 * `seam:suggestions` publishes a tips table carrying its first candidate's columns, because the
 * queue a reader works through is one row per tip, and `seam:review` reads them from there. This
 * writes the same columns from the search's own answer.
 *
 * **Written over, never beside** (`foldColumns`' rule): the incoming table from `seam:openEnds`
 * already declares every one of these, null. A second `min_dist_um` column would give a picker
 * downstream two answers to one question, and the stale one first.
 *
 * A tip nobody searched — one the filter left out, or one whose box held no candidate — keeps
 * whatever the incoming table said, which for Find Open Ends' is null.
 */
export function tipsWithFirsts(
  table: TableValue,
  ends: readonly SearchedEnd[],
  tips: readonly TipRow[],
): TableValue {
  const data: Record<string, CellValue[]> = {}
  const schema = tipsSchema(table.schema)
  const length = table.data[ID_COLUMN_NAME]?.length ?? 0
  for (const column of schema.columns) {
    const held = table.data[column.name]
    data[column.name] = held ? [...held] : new Array<CellValue>(length).fill(null)
  }
  for (const end of ends) {
    const tip = tips[end.tip]
    if (!tip || tip.row >= length) continue
    const at = tip.row
    /*
     * **Cleared first, so a searched tip with no candidates says so.** The incoming table may
     * already carry a first candidate — a `Tips` table from `seam:suggestions` does — and that
     * one belongs to another run. Left in place beside this node's own `Candidates`, the tip
     * would name a `candidateId` that has no row in the published list, which is the one
     * inconsistency `seam:review` cannot see: it reads the two tables separately.
     */
    // Guarded, because `p_top` is only there when the incoming table brought it.
    for (const name of FIRST_CANDIDATE_COLUMNS) if (data[name]) data[name]![at] = null
    if (end.rows === 0) continue
    data['candidateId']![at] = String(end.candRoot[0]!)
    data['geo_rank']![at] = cell(end.columns['geo_rank'], 0) ?? 1
    for (const [name, column] of FIRST_ON_TIP) {
      data[name]![at] = cell(end.columns[column], 0)
    }
  }
  return makeTable(schema, data, table.kind, length)
}

/**
 * Where each of the first candidate's measurements lands on the tip row: the published tip
 * column against the pool column it reads.
 *
 * The same filtered list as `FROM_SEARCH`, paired with its published name — so a column renamed
 * on `SEARCH_CANDIDATE_FIELDS` moves here too, and there is no lookup that could fail to find
 * one. The two are the same word today; the pair is what keeps that from being a thing to
 * remember if a published name ever diverges from SEAM's.
 */
const FIRST_ON_TIP: readonly (readonly [string, string])[] = SEARCH_TIP_FIELDS.filter(
  (one) => one.from !== 'cand_root' && one.from !== 'geo_rank',
).map((one) => [one.name, one.from] as const)

/**
 * Every tip column that describes the **first candidate**, and so is this node's to rewrite.
 *
 * Cleared wholesale before any of it is written, which is what makes a searched tip with no
 * candidates say so. Derived from the field list where it can be, and `p_top` named: it is the
 * first candidate's calibrated confidence, which this node cannot compute (stage 6), so leaving
 * an incoming one would put another run's probability beside this run's `candidateId`.
 *
 * SEAM's own verdict columns (`seam_*`) are deliberately **not** here. They are a review of the
 * tip rather than a measurement of its first candidate, and `suggestionTables.ts` carries them
 * so a new round can be compared against the old one.
 */
const FIRST_CANDIDATE_COLUMNS: readonly string[] = [
  'candidateId',
  'geo_rank',
  /*
   * None of these four is published by this node, and all four are cleared: a `Tips` table from
   * `seam:suggestions` carries them, and every one of them is *that* run's reading of *that*
   * run's first candidate — `p_top` its confidence, `q` and `r` the calibrated chance it is
   * right, `shown` whether it cleared SEAM's cutoff. Beside this node's own `candidateId` they
   * would all read as describing it, and `seam:review` would sort and filter on them.
   */
  'p_top',
  'q',
  'r',
  'shown',
  ...FIRST_ON_TIP.map(([name]) => name),
]

/**
 * The published tips shape, with the incoming table's own columns kept beside it.
 *
 * `foldColumns`' two rules are exactly the ones wanted here — a name is written over rather than
 * added beside, and a column keeps its position — so this is that function and not a second
 * spelling of it. The position rule is the one that bites: a reader who folded a column of their
 * own onto the tips would otherwise watch it move to the end every time this node ran.
 */
export function tipsSchema(incoming: TableSchema | undefined): TableSchema {
  const wanted = schemaOf(SEARCH_TIP_FIELDS)
  return incoming ? foldColumns(incoming, wanted.columns) : wanted
}
