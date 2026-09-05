/**
 * The arithmetic behind the Profile widget.
 *
 * Headless and pure, because everything interesting about a profile is a roll-up and none of
 * it needs a DOM: partner tables collapsed to types, ROI counts collapsed to regions and a
 * hemisphere, a transmitter call read out of whatever columns a dataset happens to publish.
 * Keeping it here rather than inside the viewer is what makes it testable at all — jsdom has
 * no canvas and no WebGL, so anything living only inside the component is unverified.
 *
 * These produce *view models*, not Coda tables, which is why they do not come in the
 * `*Schema`/`*Table` pairs `tableOps.ts` requires (invariant 3): nothing downstream consumes
 * them, so there is no schema for a value to disagree with.
 */

import type { NeuronId } from '../../core/ids'
import { ID_COLUMN_NAME, compareIds, idText } from '../../core/ids'
import type { CellValue, TableValue } from '../../core/values'
import { getColumn, selectRows } from '../../core/values'
import { valueLabel } from './datasetStats'

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/**
 * How finely a partner list is rolled up.
 *
 * Three settings and not two booleans, because the obvious pair — "split untyped" and "don't
 * group" — has a fourth state that means nothing: with grouping off, every partner is already
 * its own row and there is no lump left to split. An ordered scale says that in the type.
 *
 * - `type` rolls every partner up by cell type and files the untyped under one `null` bucket.
 *   That bucket is a real answer on a dense neuron — 13,621 of male-cns body 10003's synapses
 *   name an untyped partner — and it is also the thing you cannot see inside.
 * - `typed` keeps the typed buckets and gives each *untyped* partner its own row, keyed by id.
 * - `neuron` groups nothing: one row per partner neuron.
 */
export type PartnerGrouping = 'type' | 'typed' | 'neuron'

/**
 * What a partner is called under a grouping — **the one place that decides**, because two
 * readers have to agree about it.
 *
 * The partner list is built from a connectivity table and the highlight is a column written onto
 * a synapse cloud, and a partner that is spelled differently in the two is a partner that lights
 * nothing while looking perfectly clickable. `synapseHighlight.ts` records what that costs: the
 * first version of the highlight keyed nulls as `''` where `resolveColor` keys them `'—'`, and
 * 13,621 synapses stayed lit whatever was selected.
 *
 * Returns `null` only where the grouping genuinely has nothing to call this partner — the `type`
 * bucket for an untyped one — which is what `markLabel` renders as `—`. Everywhere else the key
 * is an id, through `idText` because that is invariant 8's cell → id.
 */
export function partnerKey(
  grouping: PartnerGrouping,
  type: CellValue | undefined,
  id: CellValue | undefined,
): string | null {
  if (grouping !== 'neuron') {
    const named = asType(type)
    if (named !== null) return named
    // `type` lumps; `typed` splits the lump by id, which is the whole difference between them.
    if (grouping === 'type') return null
  }
  return idText(id ?? null)
}

/** One row of the "top input/output types" list. */
export interface PartnerTypeRow {
  /**
   * What this row is called: a cell type, a neuron id, or `null` for the untyped bucket under
   * `type` grouping. See `partnerKey` — the name is historical, the value is the *key*.
   */
  type: string | null
  /**
   * The cell type of the neuron this row is keyed by, where the key is an id and a type is
   * known. Absent otherwise — a row keyed by type already says it.
   *
   * Never part of the key, because two neurons of one type must stay two rows once the reader
   * has asked for neurons. Named for what it *is* rather than for where a viewer puts it: this
   * type is headless and shared with Neuron Profile, and `subtitle` named a slot in one card's
   * layout that the other card has no equivalent of.
   */
  partnerType?: string
  synapses: number
  /** Distinct partner neurons of this type. */
  partners: number
  /** Share of all synapses in this direction, 0..1. */
  synapseShare: number
  /** Share of all partners in this direction, 0..1. */
  partnerShare: number
}

/** One row of the "top partners" list — an individual neuron, not a type. */
export interface PartnerRow {
  /**
   * Text, never a number. Invariant 8: `toNumber` here rounded an eighteen-digit CAVE root id,
   * so the widget printed a partner that does not exist and the tie-break sorted two adjacent
   * ids as equal. neuPrint's are exact as doubles, which is why it read as correct.
   */
  neuronId: NeuronId
  type: string | null
  weight: number
  /** Share of all synapses in this direction, 0..1. */
  share: number
}

export interface ConnectivitySummary {
  /** Total synapses across every partner passing the threshold. */
  synapses: number
  /** Distinct partner neurons passing the threshold. */
  partners: number
}

export interface PartnerOptions {
  /** Drop connections weaker than this. 1 keeps everything the fetch returned. */
  minWeight?: number
  /** Keep at most this many rows. 0 or undefined keeps all of them. */
  topN?: number
  /** How finely to roll up. Defaults to `type`, which is what every existing caller wants. */
  grouping?: PartnerGrouping
}

/**
 * Which rows of a connectivity table clear the threshold.
 *
 * Filtered here rather than in the query on purpose: the threshold is presentational — it
 * changes what the widget draws and nothing that leaves the node — so raising it must not
 * cost a round trip. One fetch at weight 1 serves every threshold above it.
 */
function passingRows(table: TableValue, minWeight: number): number[] {
  const weight = getColumn(table, 'weight')
  const rows: number[] = []
  for (let row = 0; row < table.length; row++) {
    if (toNumber(weight[row]) >= minWeight) rows.push(row)
  }
  return rows
}

export function connectivitySummary(
  table: TableValue | undefined,
  options: PartnerOptions = {},
): ConnectivitySummary {
  if (!table) return { synapses: 0, partners: 0 }
  const minWeight = Math.max(1, options.minWeight ?? 1)
  const weight = getColumn(table, 'weight')
  const partnerId = getColumn(table, 'partnerId')
  const seen = new Set<string>()
  let synapses = 0
  for (const row of passingRows(table, minWeight)) {
    synapses += toNumber(weight[row])
    seen.add(String(partnerId[row]))
  }
  return { synapses, partners: seen.size }
}

/**
 * Partners rolled up by type.
 *
 * One pass accumulating a synapse total *and* a set of distinct partner ids per type —
 * `groupByTable` does one aggregate at a time and this needs both at once. Untyped partners
 * keep their own bucket rather than folding into a neighbour: on male-CNS a large share of a
 * neuron's partners are untyped, and merging them silently would put a fictitious type at the
 * top of the list.
 */
export function partnerTypes(
  table: TableValue | undefined,
  options: PartnerOptions = {},
): PartnerTypeRow[] {
  if (!table) return []
  const minWeight = Math.max(1, options.minWeight ?? 1)
  const rows = passingRows(table, minWeight)
  const weight = getColumn(table, 'weight')
  const partnerId = getColumn(table, 'partnerId')
  const partnerType = getColumn(table, 'partnerType')

  const grouping = options.grouping ?? 'type'
  const buckets = new Map<
    string | null,
    { synapses: number; ids: Set<string>; partnerType?: string }
  >()
  let totalSynapses = 0
  const allPartners = new Set<string>()

  for (const row of rows) {
    // A Map keyed by `string | null` rather than by a string sentinel: a dataset is free to
    // have a type literally called "untyped", and a sentinel would merge the two.
    const key = partnerKey(grouping, partnerType[row], partnerId[row])
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { synapses: 0, ids: new Set() }
      /*
       * Only when the key is an id — that is what `partnerType` is for, and asking `key !== type`
       * is how the row knows which it was keyed by without a second flag. A row keyed by its
       * type has nothing to add; a row keyed by an id carries the type as something to read and
       * to filter on, never as part of its identity.
       */
      const named = asType(partnerType[row])
      if (named !== null && key !== named) bucket.partnerType = named
      buckets.set(key, bucket)
    }
    const w = toNumber(weight[row])
    const id = String(partnerId[row])
    bucket.synapses += w
    bucket.ids.add(id)
    totalSynapses += w
    allPartners.add(id)
  }

  const out: PartnerTypeRow[] = [...buckets.entries()]
    .map(([type, bucket]) => ({
      type,
      // Plain, not a conditional spread: `exactOptionalPropertyTypes` is off, so the two read
      // identically, and the spread allocated a throwaway object per row — fifteen thousand of
      // them on a dense cell's ungrouped list.
      partnerType: bucket.partnerType,
      synapses: bucket.synapses,
      partners: bucket.ids.size,
      synapseShare: totalSynapses > 0 ? bucket.synapses / totalSynapses : 0,
      partnerShare: allPartners.size > 0 ? bucket.ids.size / allPartners.size : 0,
    }))
    /*
     * `compareIds` where the key is an id, `collate` where it is a type. Ties are what this
     * decides, and an id compared by locale is `topPartners`' recorded mistake one function
     * down: ids are wider than a double, so lexicographic order puts `1000` before `999`.
     * `partnerType` is present only on an id-keyed row, which is what tells the two apart
     * without a second flag.
     */
    .sort(
      (a, b) =>
        b.synapses - a.synapses ||
        (grouping === 'type'
          ? collate(a.type, b.type)
          : compareIds(a.type ?? '', b.type ?? '')),
    )

  return capped(out, options.topN)
}

/** Individual partner neurons, strongest first. */
export function topPartners(
  table: TableValue | undefined,
  options: PartnerOptions = {},
): PartnerRow[] {
  if (!table) return []
  const minWeight = Math.max(1, options.minWeight ?? 1)
  const rows = passingRows(table, minWeight)
  const weight = getColumn(table, 'weight')
  const partnerId = getColumn(table, 'partnerId')
  const partnerType = getColumn(table, 'partnerType')

  let total = 0
  for (const row of rows) total += toNumber(weight[row])

  const out: PartnerRow[] = rows
    .map((row) => {
      const w = toNumber(weight[row])
      return {
        // `idText`, the cell-level rule — so a `str` id column and an `i64` one produce the
        // same text, and an unreadable cell is empty rather than 0.
        neuronId: idText(partnerId[row]) ?? '',
        type: asType(partnerType[row]),
        weight: w,
        share: total > 0 ? w / total : 0,
      }
    })
    // `compareIds`, which is length-then-lexicographic: `Number(a) - Number(b)` reports two
    // adjacent wide ids as equal, so the tie-break stopped being one.
    .sort((a, b) => b.weight - a.weight || compareIds(a.neuronId, b.neuronId))

  return capped(out, options.topN)
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

export interface RegionRow {
  roi: string
  pre: number
  post: number
  /** pre + post, which is what the bars are scaled by. */
  total: number
}

export interface RegionOptions {
  /**
   * The dataset's non-overlapping ROI list. Anything not in it is dropped.
   *
   * Optional in the type only. `roiInfo` nests — a synapse in `LO(R)` is also counted in its
   * parent `OL(R)` — so summing the raw blob double counts, and the decoder's own comment
   * says as much. `undefined` means "the primary list has not arrived yet", and the caller is
   * expected to say so rather than present the totals as though they were sound.
   */
  primaryRois?: readonly string[] | undefined
  topN?: number
}

export function regionRows(
  table: TableValue | undefined,
  options: RegionOptions = {},
): RegionRow[] {
  if (!table) return []
  const wanted = options.primaryRois?.length ? new Set(options.primaryRois) : undefined
  const roi = getColumn(table, 'roi')
  const pre = getColumn(table, 'pre')
  const post = getColumn(table, 'post')

  const merged = new Map<string, RegionRow>()
  for (let row = 0; row < table.length; row++) {
    const name = roi[row]
    if (name === null || name === undefined) continue
    const key = String(name)
    if (wanted && !wanted.has(key)) continue
    const entry = merged.get(key) ?? { roi: key, pre: 0, post: 0, total: 0 }
    entry.pre += toNumber(pre[row])
    entry.post += toNumber(post[row])
    entry.total = entry.pre + entry.post
    merged.set(key, entry)
  }

  const out = [...merged.values()]
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total || a.roi.localeCompare(b.roi))
  return capped(out, options.topN)
}

export type Hemisphere = 'L' | 'R' | 'center'

/**
 * Which side of the animal an ROI sits on.
 *
 * One rule, not a per-dataset table: every neuPrint dataset checked writes the side as a
 * trailing parenthesis — `LO(R)`, `ADMN(L)`, `HTct(UTct-T3)(L)` — and names without one
 * (`ANm`, `CV`, `AbNT`) are genuinely unlateralised rather than unlabelled. So anything not
 * ending in `(L)` or `(R)` is `center`, which is a statement about the anatomy rather than a
 * failure to parse.
 *
 * Reads the *last* parenthesis deliberately: `HTct(UTct-T3)(L)` has two, and anchoring on the
 * first would report every leg neuropil as unsided.
 */
export function roiSide(roi: string): Hemisphere {
  const match = /\((L|R)\)\s*$/.exec(roi)
  return match ? (match[1] as 'L' | 'R') : 'center'
}

export interface HemisphereSplit {
  left: number
  right: number
  center: number
  total: number
}

/** Synapses per side, over the same primary-ROI filtered rows the region bars use. */
export function hemisphereSplit(rows: readonly RegionRow[]): HemisphereSplit {
  const split: HemisphereSplit = { left: 0, right: 0, center: 0, total: 0 }
  for (const row of rows) {
    const side = roiSide(row.roi)
    if (side === 'L') split.left += row.total
    else if (side === 'R') split.right += row.total
    else split.center += row.total
    split.total += row.total
  }
  return split
}

// ---------------------------------------------------------------------------
// Neurotransmitter
// ---------------------------------------------------------------------------

export interface TransmitterProbability {
  /** Display label — `ACh`, `GABA`, `Glu`, or the raw name title-cased. */
  label: string
  /** The column it came from, for the tooltip. */
  column: string
  value: number
}

/**
 * Columns holding a transmitter *call*, most authoritative first.
 *
 * `consensusNt` is the curated answer and `predictedNt` the model's, so a dataset carrying
 * both shows the curated one. Matched by name against whatever schema discovery found,
 * exactly as `rowFields.ts` does — a dataset publishing none of these has no transmitter tile
 * rather than a tile full of dashes.
 */
const CALL_COLUMNS = [
  'consensusNt',
  'predictedNt',
  'celltypePredictedNt',
  'neurotransmitter',
  'nt',
]

const CONFIDENCE_COLUMNS = ['predictedNtProb', 'celltypePredictedNtConfidence', 'ntConfidence']

/**
 * Long neuPrint names shortened to what the literature uses.
 *
 * MANC publishes `ntAcetylcholineProb` where male-CNS publishes `ntAchProb`, and a bar
 * labelled "Acetylcholine" is four times the width of one labelled "ACh" for no extra
 * information. Anything unlisted is title-cased, so a transmitter added later reads sensibly
 * without a code change.
 */
const NT_LABELS: Record<string, string> = {
  acetylcholine: 'ACh',
  ach: 'ACh',
  gaba: 'GABA',
  glutamate: 'Glu',
  glu: 'Glu',
  dopamine: 'DA',
  da: 'DA',
  octopamine: 'OA',
  oct: 'OA',
  serotonin: '5-HT',
  ser: '5-HT',
  histamine: 'His',
  hist: 'His',
  tyramine: 'Tyr',
  tyr: 'Tyr',
  unknown: 'unknown',
}

/**
 * `ntAchProb` / `ntAcetylcholineProb` and friends.
 *
 * Anchored at both ends so `predictedNtProb` — the *confidence in the call*, not a
 * per-transmitter probability — is not swept in. Getting that wrong puts a bar labelled
 * "Predicted" beside the real transmitters and makes the set sum past one.
 */
const PROBABILITY_PATTERN = /^nt([A-Za-z0-9]+)Prob$/

/**
 * Which column holds this row's transmitter call, most authoritative first.
 *
 * Extracted because there are two readers — one row at a time and a whole subject at a time —
 * and a call column resolved differently by the two is a card that names one transmitter for a
 * neuron and another for the cell type it belongs to. That is the exact drift the subject layer
 * exists to prevent, and it was live here for one pass: the grouped path had this line inlined
 * under a comment claiming it did not.
 */
function callColumnOf(row: Record<string, CellValue>): string | undefined {
  return CALL_COLUMNS.find((name) => isPresent(row[name]))
}

/**
 * Which column holds the confidence in this row's call, where the dataset publishes one apart
 * from the per-transmitter probabilities. One owner, for `callColumnOf`'s reason.
 */
function confidenceColumnOf(row: Record<string, CellValue>): string | undefined {
  return CONFIDENCE_COLUMNS.find(
    (name) => isPresent(row[name]) && Number.isFinite(Number(row[name])),
  )
}

/**
 * A probability column's display label, or undefined where the name is not one.
 *
 * The other half of the same argument: `PROBABILITY_PATTERN` is anchored at both ends so
 * `predictedNtProb` — the confidence in the *call*, not a per-transmitter probability — is not
 * swept in beside the transmitters, which would make the set sum past one.
 */
function probabilityLabel(column: string): string | undefined {
  const match = PROBABILITY_PATTERN.exec(column)
  return match ? ntLabel(match[1] ?? '') : undefined
}

function ntLabel(raw: string): string {
  const known = NT_LABELS[raw.toLowerCase()]
  if (known) return known
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function capped<T>(rows: T[], topN: number | undefined): T[] {
  return topN && topN > 0 ? rows.slice(0, topN) : rows
}

/** Missing and unparseable both mean "no synapses here", which is 0. */
function toNumber(cell: CellValue | undefined): number {
  const value = Number(cell)
  return Number.isFinite(value) ? value : 0
}

function isPresent(cell: CellValue | undefined): boolean {
  return cell !== null && cell !== undefined && cell !== ''
}

/** An empty type string is the same absence as a null one, and both stay distinguishable. */
function asType(cell: CellValue | undefined): string | null {
  if (cell === null || cell === undefined || cell === '') return null
  return String(cell)
}

/** Untyped partners sort last among equals rather than colliding on an empty string. */
function collate(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a.localeCompare(b)
}

// ---------------------------------------------------------------------------
// Subjects: one neuron, or every neuron sharing a value
// ---------------------------------------------------------------------------

/**
 * What a profile is *about*.
 *
 * A single neuron by default, and every neuron sharing a column's value when the widget is
 * grouped — a cell type, a hemilineage, a cluster id from `Cut Tree`, a shared label from
 * `Match Cell Types`. The whole of the difference between the two modes is `members.length`,
 * which is why every roll-up below takes a subject rather than a mode flag: a single neuron is
 * a subject of one, its mean is its value and its spread is unknown, and the tiles need no
 * second code path to say so.
 *
 * `rows` and `members` are not the same length in general — a table may carry a neuron twice
 * (a Stack of two searches), and a row whose id is unreadable has no member to contribute. The
 * roll-ups count *members*, because the denominator of a mean over a cell type is how many
 * cells it has.
 */
export interface ProfileSubject {
  /**
   * Stable identity, for the pager and for the fetch cache.
   *
   * The group's value, or the neuron's id when ungrouped. Distinct from `label` only in that a
   * group with no value has a key of `''` and prints as `—`.
   */
  key: string
  /** What the header prints. */
  label: string
  /** Row indices of the incoming table this subject covers, in the table's own order. */
  rows: number[]
  /**
   * The neurons this is a profile of, deduplicated, in first-appearance order.
   *
   * This is what a pin writes to the node's `selection` param, which is why grouping can stay
   * presentational: the group is resolved to ids at pin time, so `evaluate` never learns that
   * grouping exists and the `Current` port keeps meaning exactly what it meant.
   */
  members: NeuronId[]
  /**
   * Whether this subject is a *group* rather than a row.
   *
   * On the subject rather than derived by the caller from `groupBy`, because the answer is not
   * `Boolean(groupBy)`: a picker naming a column the schema does not have falls back to one
   * neuron per row (below), and a caller re-deciding on the param alone would then label a single
   * neuron "Mean ± sd across 1 neuron" and add a member count beside it. One decision, made where
   * the fallback is.
   */
  grouped: boolean
}

/**
 * The table split into what the profile can be about.
 *
 * Ungrouped, one subject per row — today's behaviour, and the pager pages rows. Grouped,
 * subjects come out in **first-appearance order** rather than sorted: an upstream `Sort` is
 * then what decides the paging order, where a private alphabetical rule here would quietly
 * override it and leave nothing to change.
 *
 * A missing or blank group value is its own subject rather than being dropped, for
 * `partnerTypes`' reason one level up: on a real dataset the untyped neurons are a large and
 * genuinely interesting group, and folding them into a neighbour invents a cell type.
 *
 * Deliberately **not** `iterables.ts`' `groupKeys`/`groupOf`, which group a column the same way
 * and even record the same first-appearance argument. Two things differ. That index names the
 * blank bucket `(none)`, a string a dataset is free to use as a real cell type — here the blank
 * key is `''`, which no `asType` result can collide with, which is `partnerTypes`' rule about a
 * type literally called "untyped". And a subject needs its deduplicated *member ids*, which a
 * row-index grouping does not carry. Its `WeakMap` memo would buy nothing besides: the viewer
 * already memoises this on the table and the column.
 */
export function profileSubjects(
  table: TableValue | undefined,
  groupBy?: string | undefined,
): ProfileSubject[] {
  if (!table || table.length === 0) return []
  const ids = getColumn(table, ID_COLUMN_NAME)

  if (!groupBy || !table.schema.columns.some((col) => col.name === groupBy)) {
    return Array.from({ length: table.length }, (_, row) => {
      const id = idText(ids[row])
      return {
        key: id ?? `#${row}`,
        label: id ?? '—',
        rows: [row],
        members: id === null ? [] : [id],
        grouped: false,
      }
    })
  }

  const group = getColumn(table, groupBy)
  // The `Set` rides on the bucket rather than in a second map keyed the same way: two maps that
  // must agree are two maps that can stop agreeing, and it costs a lookup per row besides.
  const byKey = new Map<string, { subject: ProfileSubject; seen: Set<string> }>()
  for (let row = 0; row < table.length; row++) {
    const value = asType(group[row])
    const key = value ?? ''
    let bucket = byKey.get(key)
    if (!bucket) {
      bucket = {
        subject: { key, label: value ?? '—', rows: [], members: [], grouped: true },
        seen: new Set(),
      }
      byKey.set(key, bucket)
    }
    bucket.subject.rows.push(row)
    const id = idText(ids[row])
    // Deduplicated, because a Stack of two searches can carry one neuron twice and a mean
    // whose denominator counts it twice is not a mean over the cell type.
    if (id !== null && !bucket.seen.has(id)) {
      bucket.seen.add(id)
      bucket.subject.members.push(id)
    }
  }
  return [...byKey.values()].map((bucket) => bucket.subject)
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/**
 * One measurement across a subject's members.
 *
 * Every number the grouped tiles draw is one of these, including on a subject of one — that is
 * what keeps the widget free of a second code path, and what makes "profile of a cell type"
 * the same picture as "profile of a neuron" rather than a different card.
 */
export interface Aggregate {
  /**
   * Mean across **every** member, a member with no matching row counted as 0.
   *
   * That inverts `groupByTable`'s rule deliberately, and the inversion is the whole reason
   * `present` exists beside it. There, a group holding no number is *unmeasured*, so a mean
   * over it is null. Here the fetch enumerated every partner of every member, so a member with
   * no row for a partner type has been measured and the measurement is zero — dropping it from
   * the denominator would report the mean over the members that happen to connect and call it
   * the mean over the type.
   */
  mean: number
  /**
   * Sample standard deviation (n − 1), or null for a subject of one.
   *
   * Null rather than 0: the spread of a single measurement is unknown, not zero, and "12 ± 0"
   * is a claim about reproducibility that one neuron cannot support.
   */
  sd: number | null
  /** Sum across members. Equal to `mean` for a subject of one. */
  total: number
  /**
   * Members with a non-zero value, out of `n`.
   *
   * Printed beside every mean, because a mean of 4.2 across thirty members where two connect is
   * a different fact from one where all thirty do, and the mean alone cannot tell them apart.
   */
  present: number
  /** Members in the subject — the denominator. */
  n: number
}

/**
 * Mean and spread from the sums one pass over the members produced.
 *
 * The one place the arithmetic lives, because there are three callers and a second spelling of
 * `n - 1` is a second thing that can be wrong about a group of one. `ss` is the sum of squared
 * deviations over the members that *held* a value; the ones that did not each contribute a full
 * `(0 - mean)²`, which is the `n - counted` term.
 */
function aggregateOf(
  sum: number,
  ss: number,
  present: number,
  counted: number,
  n: number,
): Aggregate {
  const mean = n > 0 ? sum / n : 0
  const spread = ss + (n - counted) * mean * mean
  return {
    mean,
    sd: n > 1 ? Math.sqrt(Math.max(0, spread) / (n - 1)) : null,
    total: sum,
    present,
    n,
  }
}

/** A plain list of per-member values — every member present, so `counted` is `n`. */
function foldValues(values: readonly number[]): Aggregate {
  const n = values.length
  let sum = 0
  let present = 0
  for (const value of values) {
    sum += value
    if (value !== 0) present += 1
  }
  const mean = n > 0 ? sum / n : 0
  let ss = 0
  for (const value of values) ss += (value - mean) * (value - mean)
  return aggregateOf(sum, ss, present, n, n)
}

/**
 * Fold one per-member measurement per key into an aggregate per key.
 *
 * Two passes over the per-member maps rather than the `Σx²−(Σx)²/n` shortcut: synapse counts
 * reach 10⁴ over a hundred members, where that difference is taken between two numbers around
 * 10¹¹ and loses most of its significant digits.
 *
 * **Both passes walk the entries, never the keys × members grid.** The obvious second pass asks
 * every member for every key, which is fine while the data is dense and quadratic where it is
 * not: `subjectTopPartners` keys by partner *neuron*, so fifty members against twenty thousand
 * distinct partners is a million lookups for the hundred thousand values that exist. Walking the
 * entries again is `O(nnz)`, and the members holding nothing for a key are folded in afterwards
 * as one `(n - counted)` term rather than one lookup each.
 */
interface Accumulator {
  sum: number
  present: number
  counted: number
  /** Settled between the two passes; meaningless before. */
  mean: number
  /** Sum of squared deviations over the members that held a value. */
  ss: number
}

function foldMembers(
  perMember: ReadonlyArray<Map<string | null, number>>,
): Map<string | null, Aggregate> {
  const n = perMember.length
  const sums = new Map<string | null, Accumulator>()
  for (const member of perMember) {
    for (const [key, value] of member) {
      let entry = sums.get(key)
      if (!entry) {
        entry = { sum: 0, present: 0, counted: 0, mean: 0, ss: 0 }
        sums.set(key, entry)
      }
      entry.sum += value
      entry.counted += 1
      if (value !== 0) entry.present += 1
    }
  }

  if (n > 1) {
    // The mean is settled before any deviation is taken, and it is kept on the entry: the second
    // pass then costs one lookup per value rather than a lookup in each of two maps plus a
    // division, on a loop that runs once per non-zero cell.
    for (const entry of sums.values()) entry.mean = entry.sum / n
    for (const member of perMember) {
      for (const [key, value] of member) {
        const entry = sums.get(key)
        if (entry) entry.ss += (value - entry.mean) * (value - entry.mean)
      }
    }
  }

  const out = new Map<string | null, Aggregate>()
  for (const [key, entry] of sums) {
    out.set(key, aggregateOf(entry.sum, entry.ss, entry.present, entry.counted, n))
  }
  return out
}

/** One subject's members, each as the rows of the fetched table that belong to it. */
export type SubjectPartition = ReadonlyArray<TableValue | undefined>

/**
 * The fetched table split by the neuron it was asked about — a **subject partition**.
 *
 * Members with no rows come back `undefined`, which every single-neuron roll-up already reads as
 * "no data", and that is what makes a zero a *measurement* rather than a gap: the fold runs over
 * the partition, so a neuron of the type that connects to nothing still contributes its 0 to
 * every mean.
 *
 * Both tables this is used on are query-relative — `neuronId` is the neuron that was asked
 * about, whichever way the synapse points — so this partitions by subject member and never by
 * partner.
 *
 * **Exported, and the caller holds the result.** Three roll-ups read the same partition of the
 * same table, and `selectRows` copies every column, so computing it per roll-up re-copied a
 * whole direction of connectivity three times over. The obvious fix was a `WeakMap` here keyed on
 * `(table, members)` identity — and that quietly made a pure module depend on the *viewer's*
 * `useMemo` for its hit rate, invisibly degrading to a full re-partition for any other caller,
 * while pinning a second copy of every cached table for as long as the cache held it, which
 * `keyedCache`'s row budget does not count. Passing the partition in says the same thing in the
 * type, holds for every caller, and lets the memo that owns the lifetime be the one that can see
 * it.
 */
export function partitionByMember(
  table: TableValue | undefined,
  members: readonly NeuronId[],
): SubjectPartition {
  // No table, no partition, and no walk of `members` — which matters because the subject most
  // likely to have none is the one whose fetch was deferred for having tens of thousands of
  // them. Every reader of the result is behind `Loadable`, so an empty partition is never drawn.
  if (!table) return []

  const ids = getColumn(table, ID_COLUMN_NAME)
  const rowsById = new Map<string, number[]>()
  for (let row = 0; row < table.length; row++) {
    const id = idText(ids[row])
    if (id === null) continue
    const bucket = rowsById.get(id)
    if (bucket) bucket.push(row)
    else rowsById.set(id, [row])
  }
  return members.map((id) => {
    const rows = rowsById.get(id)
    return rows ? selectRows(table, rows) : undefined
  })
}

// ---------------------------------------------------------------------------
// Subject roll-ups
// ---------------------------------------------------------------------------

/**
 * Every subject roll-up is the single-neuron one, run per member and folded.
 *
 * Not reimplemented over a grouped table, which was the obvious reach and is how the two modes
 * come to disagree: the untyped bucket, the `>= minWeight` boundary, the distinct-partner count
 * and the nested-ROI filter are each a decision made once above, and a second implementation
 * gets one of them wrong in a way that still produces a plausible bar.
 *
 * The partition arrives ready-made, so an empty one — a subject whose fetch has not run, or was
 * deferred — costs nothing here whatever its member count.
 */
function perMember<T>(
  parts: SubjectPartition,
  rollUp: (part: TableValue | undefined) => T,
): T[] {
  return parts.map(rollUp)
}

/**
 * The shape every roll-up below shares: per-member rows, one key and one number off each row.
 *
 * Written once because it was retyped five times, differing only in which field was the key and
 * which the value — and a `new Map(rows.map(...))` that names the wrong field still folds
 * perfectly happily.
 */
function foldOn<R>(
  perMemberRows: ReadonlyArray<readonly R[]>,
  key: (row: R) => string | null,
  value: (row: R) => number,
): Map<string | null, Aggregate> {
  return foldMembers(
    perMemberRows.map((rows) => {
      // A plain loop rather than `new Map(rows.map(...))`, which allocates an array of
      // two-element arrays per member — a hundred thousand throwaway tuples on a partner-id key.
      const map = new Map<string | null, number>()
      for (const row of rows) map.set(key(row), value(row))
      return map
    }),
  )
}

export interface SubjectConnectivity {
  synapses: Aggregate
  partners: Aggregate
}

/** Synapses and distinct partners in one direction, per member of the subject. */
export function subjectConnectivity(
  parts: SubjectPartition,
  options: PartnerOptions = {},
): SubjectConnectivity {
  const summaries = perMember(parts, (part) => connectivitySummary(part, options))
  // `foldValues` rather than the keyed fold: every member has both numbers, so there is no
  // sparsity to exploit and no key to carry.
  return {
    synapses: foldValues(summaries.map((summary) => summary.synapses)),
    partners: foldValues(summaries.map((summary) => summary.partners)),
  }
}

/**
 * One row of the grouped "top input/output types" list.
 *
 * Deliberately narrower than `PartnerTypeRow`, which it otherwise mirrors: there is no
 * `partnerType` and no `partnerShare` because nothing draws them. Both are trivially derivable
 * here if a second reader ever wants them — the point of leaving them out is that an unread
 * field is a field nothing keeps honest.
 */
export interface SubjectTypeRow {
  /** `partnerTypes`' key: a cell type, a neuron id, or null for the untyped bucket. */
  type: string | null
  /** Synapses to this partner type, per member. */
  synapses: Aggregate
  /** Distinct partner neurons of this type, per member. */
  partners: Aggregate
  /** Share of the subject's synapses in this direction, 0..1. */
  synapseShare: number
}

export function subjectPartnerTypes(
  parts: SubjectPartition,
  options: PartnerOptions = {},
): SubjectTypeRow[] {
  const grouping = options.grouping ?? 'type'
  // `topN` deliberately dropped for the per-member pass: capping each member's list first would
  // rank the types by how often they reach somebody's top ten rather than by how strong they are.
  const uncapped = { ...options, topN: 0 }
  const perMemberRows = perMember(parts, (part) => partnerTypes(part, uncapped))

  const synapses = foldOn(
    perMemberRows,
    (row) => row.type,
    (row) => row.synapses,
  )
  const partners = foldOn(
    perMemberRows,
    (row) => row.type,
    (row) => row.partners,
  )

  let totalSynapses = 0
  for (const agg of synapses.values()) totalSynapses += agg.total

  const out: SubjectTypeRow[] = [...synapses.entries()].map(([type, agg]) => ({
    type,
    synapses: agg,
    partners: partners.get(type) ?? empty(parts.length),
    synapseShare: totalSynapses > 0 ? agg.total / totalSynapses : 0,
  }))

  // `partnerTypes`' tie-break exactly, one level up: an id key compared by locale puts `1000`
  // before `999`, and `partnerType` is what says which kind of key this row carries.
  out.sort(
    (a, b) =>
      b.synapses.mean - a.synapses.mean ||
      (grouping === 'type' ? collate(a.type, b.type) : compareIds(a.type ?? '', b.type ?? '')),
  )
  return capped(out, options.topN)
}

/** One row of the grouped "top partners" list — an individual partner neuron. */
export interface SubjectPartnerRow {
  neuronId: NeuronId
  type: string | null
  /** Synapses onto this partner, per member of the subject. */
  weight: Aggregate
  /** Share of the subject's synapses in this direction, 0..1. */
  share: number
}

export function subjectTopPartners(
  parts: SubjectPartition,
  options: PartnerOptions = {},
): SubjectPartnerRow[] {
  const uncapped = { ...options, topN: 0 }
  const perMemberRows = perMember(parts, (part) => topPartners(part, uncapped))

  // The one roll-up that also carries a label out of the rows, so it keeps its own loop.
  const types = new Map<string, string | null>()
  for (const rows of perMemberRows) {
    for (const row of rows) {
      if (!types.has(row.neuronId) || types.get(row.neuronId) === null) {
        types.set(row.neuronId, row.type)
      }
    }
  }
  const folded = foldOn(
    perMemberRows,
    (row) => row.neuronId,
    (row) => row.weight,
  )

  let total = 0
  for (const agg of folded.values()) total += agg.total

  const out: SubjectPartnerRow[] = [...folded.entries()].map(([id, agg]) => ({
    neuronId: id ?? '',
    type: types.get(id ?? '') ?? null,
    weight: agg,
    share: total > 0 ? agg.total / total : 0,
  }))
  out.sort((a, b) => b.weight.mean - a.weight.mean || compareIds(a.neuronId, b.neuronId))
  return capped(out, options.topN)
}

/** One row of the grouped region list. */
export interface SubjectRegionRow {
  roi: string
  pre: Aggregate
  post: Aggregate
  /** Mean pre + mean post — what the bars are scaled by. */
  total: number
}

export interface SubjectRegions {
  /** Every region, strongest first. The caller caps; the sides below use all of them. */
  rows: SubjectRegionRow[]
  left: Aggregate
  right: Aggregate
  center: Aggregate
  /** Mean synapses across every side. Zero where nothing was measured. */
  total: number
}

export function subjectRegions(
  parts: SubjectPartition,
  options: RegionOptions = {},
): SubjectRegions {
  const uncapped = { ...options, topN: 0 }
  const perMemberRows = perMember(parts, (part) => regionRows(part, uncapped))

  const pre = foldOn(
    perMemberRows,
    (row) => row.roi,
    (row) => row.pre,
  )
  const post = foldOn(
    perMemberRows,
    (row) => row.roi,
    (row) => row.post,
  )
  const sides = foldMembers(
    perMemberRows.map((rows) => {
      const split = hemisphereSplit(rows)
      return new Map<string | null, number>([
        ['L', split.left],
        ['R', split.right],
        ['center', split.center],
      ])
    }),
  )

  const rows: SubjectRegionRow[] = [...pre.keys()].map((roi) => {
    const p = pre.get(roi) ?? empty(parts.length)
    const q = post.get(roi) ?? empty(parts.length)
    return { roi: roi ?? '', pre: p, post: q, total: p.mean + q.mean }
  })
  rows.sort((a, b) => b.total - a.total || a.roi.localeCompare(b.roi))

  const left = sides.get('L') ?? empty(parts.length)
  const right = sides.get('R') ?? empty(parts.length)
  const center = sides.get('center') ?? empty(parts.length)
  return { rows, left, right, center, total: left.mean + right.mean + center.mean }
}

/**
 * A measurement nobody had a row for: zero across the whole subject.
 *
 * `sd` is 0 rather than null above one member, and that is not the same call `Aggregate.sd`
 * makes for a subject of one. Every member here was measured and every measurement was zero, so
 * the spread genuinely *is* zero; a lone member's spread is unknown.
 */
function empty(n: number): Aggregate {
  return aggregateOf(0, 0, 0, n, n)
}

// ---------------------------------------------------------------------------
// What a subject's own rows say about it
// ---------------------------------------------------------------------------

/** One column read across a subject's rows. */
export interface Consensus {
  /** The single value the rows agree on, or null where they do not — or have none. */
  value: CellValue | null
  /** How many distinct non-blank values the rows carry. */
  distinct: number
}

/**
 * What a subject's members agree on, for every column at once.
 *
 * A group has no single row, so the identity tile cannot simply read one. Reporting the first
 * member's value would be the obvious reach and is a quiet lie: `instance` differs per neuron by
 * construction, so a cell type would be labelled with whichever of its members happened to sort
 * first. `distinct` is what lets the caller print "30 values" instead, which is a fact about the
 * group rather than a fact about one of its cells wearing the group's name.
 *
 * Every column in one traversal rather than a per-column entry point called in a loop, which is
 * what this replaced: a neuPrint table publishes sixty columns, so a five-thousand-member group
 * was sixty passes and sixty `Set`s over the same rows on every subject change. A caller wanting
 * one column passes one name.
 */
export function subjectConsensus(
  rows: ReadonlyArray<Record<string, CellValue>>,
  names: readonly string[],
): Map<string, Consensus> {
  const seen = names.map(() => new Set<string>())
  const first: Array<CellValue | null> = names.map(() => null)
  for (const row of rows) {
    for (let i = 0; i < names.length; i++) {
      const cell = row[names[i] as string]
      /*
       * `valueLabel`, not the local `isPresent`, and the difference is a whitespace-only cell.
       * Its doc gives the reason and it is exactly this surface: neuPrint publishes `null`, `''`
       * and padded strings for the same absence, so counting `"  "` as an answer would make the
       * Identity tile say "2 values" for a column the Dataset Summary an inch away reports as
       * having one. `isPresent` stays what the *other* functions here use — `asType` keys the
       * partner buckets by it and changing that would re-bucket a partner list, which is a
       * different question from what a group agrees on.
       */
      const text = valueLabel(cell)
      if (text === null) continue
      const bucket = seen[i] as Set<string>
      if (bucket.has(text)) continue
      if (bucket.size === 0) first[i] = cell ?? null
      bucket.add(text)
    }
  }
  return new Map(
    names.map((name, i) => [
      name,
      {
        value: (seen[i] as Set<string>).size === 1 ? (first[i] ?? null) : null,
        distinct: (seen[i] as Set<string>).size,
      },
    ]),
  )
}

/** A transmitter call read across a subject's members. */
export interface SubjectTransmitter {
  /** Every call made, commonest first. One entry for a settled type, more for a split one. */
  calls: Array<{ label: string; count: number }>
  /**
   * Mean probability per transmitter, over the members that **publish** one.
   *
   * The denominator is deliberately not `n`, which inverts `Aggregate`'s rule a few functions
   * up, and the two really do differ. A member with no row for a partner type has been measured
   * and the measurement is zero. A member with no `ntAchProb` has not been measured at all, and
   * averaging that in as zero would report a type as less cholinergic the more of its neurons
   * the model declined to score.
   */
  probabilities: TransmitterProbability[]
  /**
   * Confidence in the call, where the dataset publishes one — averaged over the members that do.
   *
   * `undefined` where none does, which is what keeps the row off the tile rather than showing it
   * as a dash. Same denominator rule as `probabilities` and for the same reason: a member the
   * model declined to score has not been measured, so counting it as zero would make a type look
   * less confident the more of its neurons went unscored.
   */
  confidence: Aggregate | undefined
  /** How many members were read. */
  n: number
}

export function subjectTransmitter(
  rows: ReadonlyArray<Record<string, CellValue>>,
): SubjectTransmitter {
  const calls = new Map<string, number>()
  const sums = new Map<string, { column: string; sum: number; count: number }>()
  const confidences: number[] = []

  /*
   * The probability columns resolved once, off the first row, rather than rediscovered per row.
   * They are a property of the schema — every row of one table carries the same keys — so the
   * per-row version ran `Object.entries` and a regex per column per row: three hundred thousand
   * regex executions for a five-thousand-member group, on the page turn.
   */
  // Column *and* label, resolved together: the label is a pure function of the name, so deriving
  // it inside the row loop re-ran a regex and a `toLowerCase` per row per column to produce the
  // same half-dozen strings.
  const probColumns: Array<{ column: string; label: string }> = []
  for (const column of Object.keys(rows[0] ?? {})) {
    const label = probabilityLabel(column)
    if (label !== undefined) probColumns.push({ column, label })
  }

  for (const row of rows) {
    // The call goes through `callColumnOf`, the one place that decides which column holds it —
    // so a grouped tile and a single-neuron tile cannot name different transmitters.
    const call = callColumnOf(row)
    if (call !== undefined) {
      const named = String(row[call])
      calls.set(named, (calls.get(named) ?? 0) + 1)
    }
    const confidence = confidenceColumnOf(row)
    if (confidence !== undefined) confidences.push(Number(row[confidence]))
    for (const { column, label } of probColumns) {
      const cell = row[column]
      // Presence before `Number()`: `Number(null)` is 0, which is finite, so a dataset that
      // publishes the column but not the value would otherwise average in a confident zero.
      if (!isPresent(cell)) continue
      const value = Number(cell)
      if (!Number.isFinite(value)) continue
      const entry = sums.get(label) ?? { column, sum: 0, count: 0 }
      entry.sum += value
      entry.count += 1
      sums.set(label, entry)
    }
  }

  const probabilities = [...sums.entries()]
    .map(([label, entry]) => ({
      label,
      column: entry.column,
      value: entry.count > 0 ? entry.sum / entry.count : 0,
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))

  return {
    calls: [...calls.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    confidence: confidences.length > 0 ? foldValues(confidences) : undefined,
    probabilities,
    n: rows.length,
  }
}

/**
 * A numeric column of the *incoming table*, averaged across a subject's members.
 *
 * `size`, `pre`, `post` and anything else the neuron rows already carry — no fetch involved,
 * which is why this is separate from the roll-ups above rather than another fold beside them.
 *
 * **The denominator is the members that publish a value**, not the subject's size, and that is
 * the opposite of `Aggregate`'s usual rule for the reason `subjectTransmitter` records: a neuron
 * with no `size` has not been measured, where a neuron with no row for a partner type has been
 * measured at zero. So `n` here counts who answered — and `undefined` comes back when nobody
 * did, which is what keeps a tile absent rather than full of dashes.
 *
 * Deduplicated by neuron, because a table can carry one neuron twice and an attribute of a cell
 * counted twice is not an attribute of the cell type.
 */
export function subjectNumeric(
  rows: ReadonlyArray<Record<string, CellValue>>,
  names: readonly string[],
): Map<string, Aggregate> {
  const seen = new Set<string>()
  const values = names.map<number[]>(() => [])
  for (const row of rows) {
    const id = idText(row[ID_COLUMN_NAME] ?? null)
    // Deduplicated once for all the columns rather than once per column: the member set is the
    // same whichever attribute is being averaged.
    if (id === null || seen.has(id)) continue
    seen.add(id)
    for (let i = 0; i < names.length; i++) {
      const cell = row[names[i] as string]
      // `valueLabel` for `subjectConsensus`' reason, and one of its own: `Number('  ')` is 0,
      // which is finite, so a padded cell would average in as a confident zero against this
      // function's stated rule that an unmeasured member is not in the denominator.
      if (valueLabel(cell) === null) continue
      const value = Number(cell)
      if (Number.isFinite(value)) (values[i] as number[]).push(value)
    }
  }
  const out = new Map<string, Aggregate>()
  names.forEach((name, i) => {
    const measured = values[i] as number[]
    // Absent from the map where nobody published one, which is what keeps a fact off the tile
    // rather than showing it as a dash.
    if (measured.length > 0) out.set(name, foldValues(measured))
  })
  return out
}
