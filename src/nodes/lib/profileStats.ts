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
import { compareIds, idText } from '../../core/ids'
import type { CellValue, TableValue } from '../../core/values'
import { getColumn } from '../../core/values'

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

export interface TransmitterReading {
  /** The dataset's own call, e.g. `acetylcholine`. Undefined where none is published. */
  call: string | undefined
  /** Which column the call came from. */
  callColumn: string | undefined
  /** Confidence in the call, where the dataset publishes one separately. */
  confidence: number | undefined
  /** Per-transmitter probabilities, strongest first. */
  probabilities: TransmitterProbability[]
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

export function transmitterReading(row: Record<string, CellValue>): TransmitterReading {
  const call = CALL_COLUMNS.find((name) => isPresent(row[name]))
  const confidenceColumn = CONFIDENCE_COLUMNS.find(
    (name) => isPresent(row[name]) && Number.isFinite(Number(row[name])),
  )

  const probabilities: TransmitterProbability[] = []
  for (const [name, value] of Object.entries(row)) {
    const match = PROBABILITY_PATTERN.exec(name)
    if (!match) continue
    // The presence check has to come first: `Number(null)` is 0, which is finite, so a
    // dataset that publishes the column but not the value would otherwise draw a confident
    // zero-length bar rather than leaving the transmitter out. Same trap `numeric()` exists
    // for in the encoding layer.
    if (!isPresent(value)) continue
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) continue
    probabilities.push({ label: ntLabel(match[1] ?? ''), column: name, value: numeric })
  }
  probabilities.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))

  return {
    call: call ? String(row[call]) : undefined,
    callColumn: call,
    confidence: confidenceColumn ? Number(row[confidenceColumn]) : undefined,
    probabilities,
  }
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
