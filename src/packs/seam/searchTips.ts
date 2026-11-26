/**
 * The table layer around `searchRun.ts`: a `Tips` table in, `Tips` and `Candidates` back out.
 *
 * `searchRun.ts` knows about ends, pools and rules and nothing about Coda's tables; this is the
 * one place that reads SEAM's published column names out of a value and writes them back. Keeping
 * it apart is what lets `searchRun.test.ts` fake the three bridge steps with plain arrays.
 *
 * ## It publishes what the run measured, and nothing else
 *
 * Stages 4 and 5 answer **where** a candidate is and **how the forest ranks it**. They say
 * nothing about how likely the merge is to be right: `p_cand`, `conf`, `logit`, `filled`, `q`
 * and `shown` are stage 6 and later, and they are published only where an `Assessor` actually
 * ran — `candidateFields` and `tipFields` are the two lists, and the node's `assessed` flag
 * picks between them in `inferOutputs` as well as in `evaluate`, so a column picker below sees
 * the choice before anything is measured.
 *
 * On a geometry-only run those columns are **absent, not null**. An earlier draft published the
 * full shape
 * `seam:loadMergeCandidates` reads, with eleven nulls, so the two nodes' tables matched column for
 * column. That coupling is gone deliberately (2026-11-15, user): `seam:loadMergeCandidates` is modelled
 * on an earlier SEAM pipeline and its output is going to change, so pinning this node's shape to
 * it would pin it to something that is about to move. A column picker offered `p_cand` on a node
 * that can never fill it is worse than not being offered it.
 *
 * `seam:proofreadMerges` takes either, because it reads every column by name through an accessor that
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
import type { LoadedManifest } from '../../ml/manifest'
import type { CellValue, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { foldColumns } from '../../nodes/lib/tableOps'
import type { SearchedEnd } from './searchRun'
import type { Field } from './suggestionTables'
import {
  MODEL_SOURCE_PREFIX,
  SOURCE_COLUMN,
  field,
  numberAt,
  published,
  schemaOf,
  tableOf,
} from './suggestionTables'

/** One row of an incoming `Tips` table, as the search needs it. */
export interface TipRow {
  /** The neuron the end belongs to — the root the box is about. */
  readonly neuronId: string
  /** The tip's own id within that neuron, carried onto every candidate row. */
  readonly endUid: number
  /** Where the end is, in nanometres. */
  readonly nm: readonly [number, number, number]
  /**
   * Model E's score near the end, where the table carries one — stage 3's `e_tip`.
   *
   * Nothing in the search reads it: it is `p_tip`'s second feature, so it only matters to a run
   * with an assessor, and `undefined` there means "no cell was found near this tip", for which
   * `decideTip` substitutes the fit's own floor. The **column** being absent is a different
   * thing: the column is required of an assessed run's table and refused by name, rather
   * than every tip being quietly floored — see `needed`.
   */
  readonly eTip: number | undefined
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
  /**
   * The neuron this tip's root is being extended *into*, where that is not the root itself —
   * a tip of an accepted piece (`pieces.ts`). Absent on a neuron's own tips.
   */
  readonly seed?: string
}

/**
 * One candidate row, as this node publishes it.
 *
 * `rank` and `geo_rank` are the same number, and that is not a coincidence waiting to break:
 * SEAM's published lists are post-own-tip and numbered `1..n`, and `searchRun.ts` renumbers
 * `geo_rank` over the kept list for exactly that reason. `rank` is that renumbering under the
 * name `seam:proofreadMerges` reads.
 */
export const SEARCH_CANDIDATE_FIELDS: readonly Field[] = [
  field('neuron', ID_COLUMN_NAME, 'str'),
  /*
   * The neuron the tip belongs to once the reader's accepted pieces are counted in: the tip's
   * own root for a neuron's tips, and the neuron being extended for a piece's. `ID` cannot say
   * it — it has to stay the root the tip is on, which is what a verdict and a merge are about.
   */
  field('seed', 'seed', 'str'),
  field('end_uid', 'end_uid', 'i64'),
  field('cand_root', 'candidateId', 'str'),
  /*
   * **The candidate's supervoxel nearest the neuron** — its side of the contact, SEAM's own
   * `rep_svid` from the cutout summary, carried rather than measured again. Text, as every id
   * (invariant 8). Followed through a split as `tip_sv` is (`TIP_SUPERVOXEL_FIELD`): after the
   * candidate is split, its root is the part that touches the neuron. Candidates only.
   */
  field('cand_sv', 'cand_sv', 'str'),
  field('rank', 'rank', 'i64'),
  field('geo_rank', 'geo_rank', 'i64'),
  field('vol_um3', 'vol_um3', 'f64', 'µm³'),
  /*
   * **How big the whole piece is, where `vol_um3` is how much of it is near the tip.**
   *
   * `vol_um3` is the candidate's voxels *inside the search box* — the 6 µm cube around the end —
   * so a long neurite passing through counts only for the part in view, and two candidates with
   * the same number can be a whole fragment and the tail of something large. The level-2 chunk
   * count is of the **object**, wherever it reaches: it is the chunkedgraph's own decomposition,
   * so it is coarse (a chunk is a fixed box of the volume) and it does not stop at the box.
   * That makes it the better proxy for "is this a fragment or a piece of a neuron", which is
   * the question a reader triaging a queue is actually asking — `seam:proofreadMerges` sorts and filters
   * on it.
   *
   * It is already fetched: the search asks `l2ChunkCounts` for every root in the pool because
   * two of the ranker's eleven features read it. `l2c` is `log10` of this and is the feature;
   * this is the number.
   */
  field('n_l2', 'n_l2', 'i64'),
  field('min_dist_um', 'min_dist_um', 'f64', 'µm'),
  field('contact_x_nm', 'contact_x', 'f64', 'nm'),
  field('contact_y_nm', 'contact_y', 'f64', 'nm'),
  field('contact_z_nm', 'contact_z', 'f64', 'nm'),
  /*
   * **The organelle flag** (SEAM, 2026-11-14): the share of the candidate's surface, inside the
   * search box, that faces its single largest neighbour — SEAM's `enclosed`, measured by its own
   * `seam/enclosure.py` on the box the search already read (vendored, `cutoutSummary.py`). A
   * mitochondrion or a vesicle sits wrapped in one cell, so nearly all of it faces that cell; a
   * neurite's continuation meets the neuron at one end and other objects along its length.
   * `organelle` is that at or above `ORGANELLE_CUT`. **A flag for the reader, never a rank**: it
   * changes no order, `q` or `shown` — SEAM's own rule — and `seam:proofreadMerges` can leave flagged
   * pieces out of its list.
   */
  field('enclosed', 'organelle_score', 'f64'),
  field('organelle', 'organelle', 'bool'),
]

/**
 * Where `organelle` starts: SEAM's `ORGANELLE_CUT` (`scripts/pilots/tip_pipeline.py`).
 *
 * Measured, not chosen here: two blind eye checks of 90 candidates found 39 of the 40 at or above
 * it to be organelles (22 mitochondria, 17 others), and 2 of the 50 below it (tiny fragments) —
 * precision and recall about 0.99. So about one flagged piece in a hundred is not an organelle,
 * which is why the review card leaves them out by choice and says how many.
 */
export const ORGANELLE_CUT = 0.5

/**
 * Whether the search's row `at` is flagged as an organelle — `null` where it was not measured.
 *
 * Read in two places — the candidate rows and the tip's first candidate — so the cut is applied
 * here and nowhere else.
 */
function organelleAt(
  columns: Readonly<Record<string, Float64Array>>,
  at: number,
): boolean | null {
  const score = cell(columns['enclosed'], at)
  return score === null ? null : score >= ORGANELLE_CUT
}

/**
 * A search cell by its column name: the pool's own, or `organelle`, worked out from it. Also how
 * Auto-extend reads an end's first candidate (`suggestMerges.ts`), as the tables publish it.
 */
export function searchCell(
  columns: Readonly<Record<string, Float64Array>>,
  name: string,
  at: number,
): CellValue {
  return name === 'organelle' ? organelleAt(columns, at) : cell(columns[name], at)
}

/**
 * What stage 6 adds to a candidate row, where an assessor ran.
 *
 * SEAM's own names, from `candidates.parquet` of the configuration these come from. Three of them
 * are the same number read at three widths and all three are published, because that is what the
 * review card and a reader plotting the list each reach for: `score_s0` is the checkpoint's raw
 * logit, `logit` is ref's fit of it together with `-geo_rank` and `log vol`, and `p_cand` is that
 * logit's share of the tip's list. `conf` is `p_tip × p_cand` — the candidate's own chance,
 * rather than its share among its rivals.
 *
 * **A second list rather than nullable columns on the first.** The node publishes one or the
 * other whole: with no assessor picked these columns are absent, which is the decision
 * `seam:openEnds` took the same day and for the same reason — a picker offered `p_cand` on a run
 * that can never fill it is worse than not being offered it.
 */
export const ASSESSED_CANDIDATE_FIELDS: readonly Field[] = [
  field('score_s0', 'score_s0', 'f64'),
  field('logit', 'logit', 'f64'),
  field('p_cand', 'p_cand', 'f64'),
  field('conf', 'conf', 'f64'),
  /*
   * **Why this candidate carries the floor, not whether it does.** SEAM's `filled` is a boolean
   * over one cause — no patch could be cut — and a run here has a second, the reader's own cap.
   * A boolean would put the two under one word and a reader comparing against a published set
   * would find more of them with nothing to say why.
   */
  field('filled', 'filled', 'str'),
]

/**
 * What stage 6 and the stages after it add to a **tip** row.
 *
 * `q` and `shown` are the decision: in this configuration there is no split stage, so SEAM's `q`
 * is `p_tip × p_top` and its cutoff was fitted against that number (`stages.ts`' `decideTip`
 * reads the absence of a split block and says so). `r` is the isotonic staircase — the share of
 * shown firsts that are right at this score — and SEAM states it is untested on held-out tips.
 */
export const ASSESSED_TIP_FIELDS: readonly Field[] = [
  field('segclr', 'segclr', 'f64'),
  field('p_tip', 'p_tip', 'f64'),
  field('p_top', 'p_top', 'f64'),
  field('q', 'q', 'f64'),
  field('r', 'r', 'f64'),
  field('shown', 'shown', 'bool'),
]

/**
 * Why a candidate carries the checkpoint's floor instead of a score — SEAM's `filled`, told apart.
 *
 * **The published words, not codes mapped to words later.** They are what the `filled` column
 * holds and what the run's tally counts, and the first draft had them as three numbers converted
 * to text one layer up: rewording the text then silently zeroed the tally, because the counter
 * was string-matching the display form. A union type is the whole fix — both readers are checked
 * against the same three words.
 *
 * `''` is a candidate that really was scored. SEAM's own `filled` is a boolean over one cause;
 * a run here has two, fixed by different things (a param somebody set, against the segmentation
 * near the contact), so the cause is published rather than the fact.
 */
export type WhyFilled = '' | 'capped' | 'no patch'

/** What one end's candidates scored. */
export interface AssessedEnd {
  /**
   * The assessor's logit per candidate of the **whole** list, in the list's own order.
   *
   * A raw logit, not a probability, and not yet ref's: `scoreList` is what turns it into one,
   * with the fits the checkpoint's own manifest carries. Every unscored candidate holds
   * `missingPatchScore`.
   */
  readonly score: Float64Array
  /** Per candidate, why it carries the floor, or `''` where it was scored. */
  readonly filled: readonly WhyFilled[]
  /**
   * Why this end has no scores at all, where it has none — `undefined` when it was assessed.
   *
   * An end can fail on its own without the run being wrong: its contacts may lie at the edge of
   * the volume, where no box can be cut. Carried per end so the node counts them and says so
   * once, rather than a throw taking down a run of several hundred after the expensive ends have
   * been paid for. `SearchedEnd.refusal` is the same decision one stage earlier.
   */
  readonly refusal?: string
}

/**
 * The tip's own half of an assessed run, **by the names `ASSESSED_TIP_FIELDS` publishes**.
 *
 * Declared here rather than beside the code that computes it (`scoreEnds.ts`) because this is
 * where the columns are declared, and the two halves of one table have to sit together —
 * invariant 3, applied inside one feature. It was a list of `[name, value]` pairs for one round,
 * which meant six names written out in a second file with nothing checking them against these
 * six: a name only one side changed was an all-null column with a perfectly good schema, or a
 * `TypeError` in the middle of a run. `assessedFieldsAgree` in the tests holds the two lists
 * equal, and the compiler holds every writer to this shape.
 *
 * `null` where SEAM has no answer rather than a number: `q` and `r` on a tip with no first
 * candidate, and `shown` where the configuration published no cutoff for the quantity this tip
 * could reach — which `seam:proofreadMerges` draws as "no verdict" rather than as a rejection.
 */
export interface AssessedTip {
  readonly segclr: number
  readonly p_tip: number
  readonly p_top: number
  readonly q: number | null
  readonly r: number | null
  readonly shown: boolean | null
}

/** The candidate columns a run publishes, with or without an assessor. */
export function candidateFields(assessed: boolean): readonly Field[] {
  return assessed
    ? [...SEARCH_CANDIDATE_FIELDS, ...ASSESSED_CANDIDATE_FIELDS]
    : SEARCH_CANDIDATE_FIELDS
}

/**
 * Whether this run searched this tip — **the one tip column that is about the run** rather than
 * about a candidate, and the only one with three states.
 *
 * - `true`: searched. Its candidates are in `Candidates`, and an empty list there is an answer.
 * - `false`: this run will not search it. Its box lies outside the segmentation volume, or its
 *   row carries no position, no `end_uid` or a neuron that is not a chunkedgraph id. The node
 *   warns about both, and the column is where a reader finds *which* rows it meant.
 * - `null`: not yet. Only ever seen on a partial, which is exactly what makes it worth
 *   publishing — `seam:proofreadMerges` counts the nulls to say how many tips are still to come, and that
 *   count reaches zero because the rows that will never be searched are `false` rather than
 *   left empty.
 *
 * Without it the two ends of that distinction are written identically: a searched tip whose box
 * held no candidate gets no row in `Candidates`, and on a geometry-only run no tip-level score
 * either, so it is indistinguishable from a tip the run has not reached. `tipsWithFirsts`'
 * header already says that clearing the first-candidate columns is what makes such a tip "say
 * so" — this is what it says it with.
 */
export const SEARCHED_FIELD: Field = field('searched', 'searched', 'bool')

/**
 * Which ranker and assessor a searched tip's numbers come from (`SOURCE_COLUMN`), so a verdict on
 * it can be read against the right fits. Written on every row this run searched, assessed or not.
 */
export const RUN_SOURCE_FIELD: Field = field(SOURCE_COLUMN, SOURCE_COLUMN, 'str')

/**
 * **The tip's own supervoxel**: the query's voxel nearest the tip, at the search's moment
 * (`SearchedEnd.tipSupervoxel`). A split never changes a supervoxel, so after the neuron is
 * split this one's root says which part the tip went with — how a review card drops the tips on
 * a part cut off (`docs/seam-split-review-plan.md`). Text, as every id; null where no voxel of
 * the query lay within reach of the tip, and on a row this run has not searched.
 */
export const TIP_SUPERVOXEL_FIELD: Field = field('tip_sv', 'tip_sv', 'str')

/** How much of a manifest's SHA-256 a `source` carries: enough to tell versions apart. */
const DIGEST_CHARS = 12

/**
 * A model as a run read it: its id and its manifest's digest (`LoadedManifest.digest`), the
 * whole digest unless told otherwise. What the memory of finished ends is keyed on, and — cut
 * short — what `source` says, so the two name one version.
 */
export function modelVersion(loaded: LoadedManifest, chars?: number): string {
  return `${loaded.manifest.id}@${loaded.digest.slice(0, chars)}`
}

/**
 * A live run's `source`: `model:<ranker>@<digest>/<assessor>@<digest>`, or `/none` where no
 * assessor ran. **By digest, not only by id**: a model is republished under the same id when SEAM
 * refits it (`r` was, on 2026-11-18), and what a `q` means changes with the fits. Anybody holding
 * the published manifest can match the digest with `sha256sum`.
 */
export function runSource(
  ranker: LoadedManifest,
  assessor: LoadedManifest | undefined,
): string {
  const assessed = assessor ? modelVersion(assessor, DIGEST_CHARS) : 'none'
  return `${MODEL_SOURCE_PREFIX}${modelVersion(ranker, DIGEST_CHARS)}/${assessed}`
}

/**
 * Where a tip sits in a neuron being extended piece by piece (`pieces.ts`).
 *
 * `ID` stays the root the tip is on — an accepted piece's own, which a verdict and a merge are
 * about — so **`seed` is the neuron**: a node below that groups on `ID` sees each piece as its
 * own neuron. `junction` marks the end a piece joins the neuron by, published and never searched.
 *
 * Declared here beside the function that writes them (`tipsWithFirsts`), which is the only one
 * that does — invariant 3. They were written by a second function for a round, ahead of the
 * fold, and came out in another order than `tipsSchema` promises a picker.
 */
export const LINEAGE_FIELDS: readonly Field[] = [
  field('seed', 'seed', 'str'),
  /*
   * Not `parent` and `depth`. These four are written over whatever the incoming tips carried
   * under the same name, on every run, and those two are names a reader may well have joined on
   * above this node — a skeleton's parent node, a depth in the arbour.
   */
  field('parent', 'accepted_on', 'str'),
  field('depth', 'steps', 'i64'),
  field('junction', 'junction', 'bool'),
]

/** One row's lineage, by the names `LINEAGE_FIELDS` publishes. */
export interface Lineage {
  readonly seed: string
  /** What the row's root was accepted on; `null` for a neuron's own tip. */
  readonly parent: string | null
  /** Steps from the neuron; 0 for its own tips. */
  readonly depth: number
  readonly junction: boolean
}

/** The tip columns a run publishes. The first candidate's, plus the tip's own where scored. */
export function tipFields(assessed: boolean): readonly Field[] {
  return [
    ...SEARCH_TIP_FIELDS,
    ...(assessed ? ASSESSED_TIP_FIELDS : []),
    TIP_SUPERVOXEL_FIELD,
    RUN_SOURCE_FIELD,
    SEARCHED_FIELD,
  ]
}

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
  // `seed` is the tip's own too — one of `LINEAGE_FIELDS`, and never a first candidate's. And the
  // organelle *score* stays on `Candidates`: SEAM's tips file carries the first candidate's flag
  // only (`top_organelle`), so `Tips` holds `organelle` alone, the same from either node.
  (one) => !['neuron', 'seed', 'end_uid', 'rank', 'enclosed', 'cand_sv'].includes(one.from),
)

/**
 * The columns a `Tips` table must have, for the run it is about to feed.
 *
 * **One list, computed from one flag**, because there were two doors into this question for a
 * round and nothing made a caller open both: the search's columns were checked inside the
 * reader, and `e_tip` by a separate exported refusal the node had to remember to call three
 * statements later. A third requirement — arm B reads EM around the tip and may want something
 * the search does not — would have written a third.
 *
 * `e_tip` is needed **only where an assessor runs**, and then it really is needed: `p_tip` is
 * fitted on it, with about the weight it puts on `segclr`. A tip Model E found no cell near has
 * a null `e_tip` and takes the fit's own floor, which is designed; a missing *column* floors
 * every tip, so the whole run comes out underconfident and shows a fraction of what it should,
 * with nothing anywhere saying why.
 */
function needed(assessing: boolean): readonly string[] {
  return assessing
    ? [ID_COLUMN_NAME, 'end_uid', 'x', 'y', 'z', 'e_tip']
    : [ID_COLUMN_NAME, 'end_uid', 'x', 'y', 'z']
}

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
export function tipsFromTable(
  table: TableValue,
  assessing = false,
): { rows: TipRow[]; dropped: number } {
  const missing = needed(assessing).filter((name) => !table.data[name])
  if (missing.length > 0) {
    throw new Error(
      `The Tips table has no \`${missing.join('`, `')}\` column, so there is no open end to ` +
        `search${missing.includes('e_tip') ? ' and nothing to score a tip with' : ''}. ` +
        'Wire this to Find Open Ends or Load Merge Candidates.',
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
    rows.push({ neuronId, endUid, nm: [x, y, z], eTip: numberAt(table, 'e_tip', i), row: i })
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
const FROM_SEARCH: readonly string[] = SEARCH_CANDIDATE_FIELDS.filter(
  // Written rather than copied, by `candidatesTable` itself. From the candidate fields, not the
  // tip fields: a measurement only `Candidates` carries (`organelle_score`) is one all the same.
  (one) =>
    !['neuron', 'seed', 'end_uid', 'cand_root', 'cand_sv', 'rank', 'geo_rank'].includes(
      one.from,
    ),
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
 * One end as it is published: the search's answer, and stage 6's where an assessor ran.
 *
 * **Three fields rather than more columns on `SearchedEnd`**, because the two halves are made by
 * different things at different times and only the first is always there. The search yields its
 * end finished; the assessor is a separate read, a separate model and a reader's separate choice.
 *
 * `order` is what makes the pair one table. SEAM ranks a published list by `logit`, which is the
 * assessor's answer, while `geo_rank` keeps the forest's — so the row order of the table and the
 * order the search produced are the same list read two ways, and the node states which rather
 * than either half assuming.
 */
export interface PublishedEnd {
  readonly end: SearchedEnd
  /**
   * Which row of the end's list to publish first, second…: indices into `end.columns`.
   *
   * The search's own order (`0, 1, 2…`) where no assessor ran, and the assessor's ranking where
   * one did. Also the **length** of the published list, which is why a tip with no candidates is
   * an empty array rather than a flag.
   */
  readonly order: Int32Array
  /** Stage 6 and after, where they ran. */
  readonly scores?: EndScores
}

/** What stage 6 and the stages after it measured for one end. */
export interface EndScores {
  /** The assessed candidate columns by SEAM's own names, in the **list's** order, not `order`'s. */
  readonly columns: Readonly<Record<string, Float64Array>>
  /** Why each candidate carries the floor, or `''` where it does not. Same order. */
  readonly filled: readonly WhyFilled[]
  /** The tip's own numbers. Written even for an empty list — see `tipsWithFirsts`. */
  readonly tip: AssessedTip
  /**
   * Why **the assessor** could not score this end, where it could not — `undefined` when it did.
   *
   * A second refusal channel beside `SearchedEnd.refusal` because they are two stages failing at
   * two different things: the search's is a root the chunkedgraph does not list, this one is a
   * patch box that clamps to nothing at the edge of the volume. An end can have either, both or
   * neither, and a run that reported them as one would tell a reader to look in the wrong place.
   * Every candidate of such an end carries the checkpoint's floor, which is a published answer
   * and not a hole.
   */
  readonly refusal?: string
}

/**
 * An end published exactly as the search left it: the forest's order, and no stage 6.
 *
 * The shape of every row of a geometry-only run, and the base an assessed one is built on — so
 * "which order is the list in" has one answer in one place rather than a `?? at + 1` at each of
 * the two table writers.
 */
export function searchOnly(end: SearchedEnd): PublishedEnd {
  return { end, order: Int32Array.from({ length: end.rows }, (_, at) => at) }
}

/**
 * The ranked lists of every searched end, as one `Candidates` table.
 *
 * `ends` are `searchEnds`' answers and `tips` the rows they were built from, **in the same
 * order** — `SearchedEnd.tip` indexes `tips`, as `ownTipRule` means it.
 */
export function candidatesTable(
  ends: readonly PublishedEnd[],
  tips: readonly TipRow[],
  assessed: boolean,
): TableValue {
  const fields = candidateFields(assessed)
  const read: Record<string, CellValue[]> = {}
  for (const one of published(fields)) read[one.from] = []
  for (const { end, order, scores } of ends) {
    const tip = tips[end.tip]
    if (!tip) continue
    for (let place = 0; place < order.length; place++) {
      const at = order[place]!
      read['neuron']!.push(tip.neuronId)
      read['seed']!.push(tip.seed ?? tip.neuronId)
      read['end_uid']!.push(tip.endUid)
      read['cand_root']!.push(String(end.candRoot[at]!))
      read['cand_sv']!.push(idOrNull(end.repSupervoxel[at]))
      // **The place in `order`, not the row's index.** With an assessor the two differ — the
      // list is published in the assessor's ranking and `geo_rank` keeps the forest's.
      read['rank']!.push(place + 1)
      read['geo_rank']!.push(cell(end.columns['geo_rank'], at) ?? at + 1)
      for (const from of FROM_SEARCH) read[from]!.push(searchCell(end.columns, from, at))
      if (!assessed) continue
      for (const from of FROM_ASSESSOR) read[from]!.push(cell(scores?.columns[from], at))
      read['filled']!.push(scores?.filled[at] ?? null)
    }
  }
  return tableOf(fields, read)
}

/** The assessed candidate columns carried straight through, by their name in SEAM's files. */
const FROM_ASSESSOR: readonly string[] = ASSESSED_CANDIDATE_FIELDS.filter(
  (one) => one.from !== 'filled',
).map((one) => one.from)

/** A 64-bit id as text, or null for none (`0`, or no id at all). */
function idOrNull(id: bigint | undefined): string | null {
  return id === undefined || id === 0n ? null : String(id)
}

function cell(column: Float64Array | undefined, at: number): number | null {
  const value = column?.[at]
  return value === undefined || !Number.isFinite(value) ? null : value
}

/**
 * The tips table with each end's **first candidate** written onto it.
 *
 * `seam:loadMergeCandidates` publishes a tips table carrying its first candidate's columns, because the
 * queue a reader works through is one row per tip, and `seam:proofreadMerges` reads them from there. This
 * writes the same columns from the search's own answer.
 *
 * **Written over, never beside** (`foldColumns`' rule): the incoming table from `seam:openEnds`
 * already declares every one of these, null. A second `min_dist_um` column would give a picker
 * downstream two answers to one question, and the stale one first.
 *
 * A tip nobody searched — one the filter left out, or one whose box held no candidate — keeps
 * whatever the incoming table said, which for Find Open Ends' is null. Except the columns about
 * this run, which are always written: `searched`, the lineage, and `tip_sv` (null where this run
 * did not measure it).
 */
export function tipsWithFirsts(
  table: TableValue,
  ends: readonly PublishedEnd[],
  tips: readonly TipRow[],
  assessed: boolean,
  /**
   * The **rows this run will attempt**, by their index in `table` — not the rows it has reached.
   *
   * Required rather than optional, because the honest default is the one nobody would pick: a
   * caller that said nothing would publish every row as `false`, claiming about a tip still in
   * the queue that this run is not going to search it. Stated, it is a set the node already
   * holds (`fits`), and every row outside it is a row the node has already warned about.
   */
  attempting: ReadonlySet<number>,
  /**
   * Each row's lineage, by its index in `table` — given for the rows of an accepted piece, and
   * left out for a neuron's own, which are their own seed. By row and not on `tips`, because a
   * piece's row that could not be searched is still that piece's.
   */
  lineage: readonly (Lineage | undefined)[] = [],
  /**
   * What this run's numbers come from (`runSource`), written on every row it searched. Null
   * where a caller does not say, which the review card reads as "not to be sent": a verdict
   * labelled with the wrong fits is worse for SEAM than one never sent.
   */
  source: string | null = null,
): TableValue {
  const data: Record<string, CellValue[]> = {}
  const schema = tipsSchema(table.schema, assessed)
  const length = table.data[ID_COLUMN_NAME]?.length ?? 0
  for (const column of schema.columns) {
    const held = table.data[column.name]
    data[column.name] = held ? [...held] : new Array<CellValue>(length).fill(null)
  }
  /*
   * **Written from this run's own answer, never carried through.** An incoming `Tips` table may
   * already hold a `searched` column — a `seam:loadMergeCandidates` set, or this node's own output fed
   * back round — and that one is another run's statement about another box and another filter.
   * Left in place it would say "searched" about rows this run is still queueing, which is the
   * one cell in the table a reader is counting on.
   */
  /*
   * The lineage, for every row and from this run alone — written over whatever the incoming
   * table carried under these names, for the reason `searched` is just below.
   */
  const ids = table.data[ID_COLUMN_NAME] ?? []
  for (let row = 0; row < length; row++) {
    const own = lineage[row]
    data['seed']![row] = own?.seed ?? idText(ids[row] ?? null)
    data['accepted_on']![row] = own?.parent ?? null
    data['steps']![row] = own?.depth ?? 0
    data['junction']![row] = own?.junction ?? false
  }
  const searched = data[SEARCHED_FIELD.name]!
  searched.fill(false)
  // This run's measurement or nothing, as `searched` is: another run's anchor is not this one's.
  data[TIP_SUPERVOXEL_FIELD.name]!.fill(null)
  for (const row of attempting) if (row < length) searched[row] = null
  for (const { end, order, scores } of ends) {
    const tip = tips[end.tip]
    if (!tip || tip.row >= length) continue
    const at = tip.row
    searched[at] = true
    /*
     * **Cleared first, so a searched tip with no candidates says so.** The incoming table may
     * already carry a first candidate — a `Tips` table from `seam:loadMergeCandidates` does — and that
     * one belongs to another run. Left in place beside this node's own `Candidates`, the tip
     * would name a `candidateId` that has no row in the published list, which is the one
     * inconsistency `seam:proofreadMerges` cannot see: it reads the two tables separately.
     */
    // Guarded, because `p_top` is only there when the incoming table brought it.
    for (const name of FIRST_CANDIDATE_COLUMNS) if (data[name]) data[name]![at] = null
    data[SOURCE_COLUMN]![at] = source
    data[TIP_SUPERVOXEL_FIELD.name]![at] = idOrNull(end.tipSupervoxel)
    /*
     * **The tip's own numbers are written even where its list is empty**, and the candidate's are
     * not. That is SEAM's shape rather than a convenience: a tip with no candidates still has a
     * `segclr` (its floor), a `p_tip`, a `q` of zero and a verdict of withheld — it is a real
     * answer about a real tip, and dropping it would leave the row looking unsearched.
     */
    if (scores) for (const [name, value] of Object.entries(scores.tip)) data[name]![at] = value
    if (order.length === 0) continue
    const first = order[0]!
    data['candidateId']![at] = String(end.candRoot[first]!)
    data['geo_rank']![at] = cell(end.columns['geo_rank'], first) ?? 1
    for (const [name, column] of FIRST_ON_TIP) {
      data[name]![at] = searchCell(end.columns, column, first)
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
 * candidates say so. **Derived from the two field lists**, so it covers whatever this node can
 * publish and whatever an incoming table may be carrying from another run — the search's first
 * candidate and, where an assessor ran, the calibrated columns beside it.
 *
 * SEAM's own verdict columns (`seam_*`) are deliberately **not** here. They are a review of the
 * tip rather than a measurement of its first candidate, and `suggestionTables.ts` carries them
 * so a new round can be compared against the old one.
 */
const FIRST_CANDIDATE_COLUMNS: readonly string[] = [
  'candidateId',
  'geo_rank',
  ...FIRST_ON_TIP.map(([name]) => name),
  /*
   * **Every stage-6 column, derived rather than listed.** A geometry-only run publishes none of
   * these and an assessed one publishes all of them — and in both cases an incoming `Tips` table
   * from `seam:loadMergeCandidates` may already carry them from *another* run over *another* candidate
   * list. `p_top`, `q`, `r` and `shown` are that run's reading of that run's first candidate;
   * `segclr` and `p_tip` are its reading of that run's whole list, which this node has just
   * replaced. Left in place beside this run's `candidateId` every one of them reads as
   * describing it, and `seam:proofreadMerges` sorts and filters on three of them.
   *
   * Hand-listing four of the six was the version before this: the two it left out were the two
   * that are about the list rather than its first row, which is exactly the distinction a reader
   * of a cleared row cannot make.
   */
  ...ASSESSED_TIP_FIELDS.map((one) => one.name),
  // Which fits those were: a published set's label must not stay on a row this run rewrote.
  SOURCE_COLUMN,
]

/**
 * The published tips shape, with the incoming table's own columns kept beside it.
 *
 * `foldColumns`' two rules are exactly the ones wanted here — a name is written over rather than
 * added beside, and a column keeps its position — so this is that function and not a second
 * spelling of it. The position rule is the one that bites: a reader who folded a column of their
 * own onto the tips would otherwise watch it move to the end every time this node ran.
 */
export function tipsSchema(incoming: TableSchema | undefined, assessed: boolean): TableSchema {
  // The lineage last, so a run nobody extended keeps its columns where they were and gains four.
  const wanted = schemaOf([...tipFields(assessed), ...LINEAGE_FIELDS])
  return incoming ? foldColumns(incoming, wanted.columns) : wanted
}
