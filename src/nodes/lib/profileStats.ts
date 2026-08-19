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

import type { CellValue, TableValue } from '../../core/values'
import { getColumn } from '../../core/values'

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/** One row of the "top input/output types" list. */
export interface PartnerTypeRow {
  /** Partner type, or `null` for partners the dataset has not typed. */
  type: string | null
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
  bodyId: number
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

  const buckets = new Map<string | null, { synapses: number; ids: Set<string> }>()
  let totalSynapses = 0
  const allPartners = new Set<string>()

  for (const row of rows) {
    // A Map keyed by `string | null` rather than by a string sentinel: a dataset is free to
    // have a type literally called "untyped", and a sentinel would merge the two.
    const type = asType(partnerType[row])
    let bucket = buckets.get(type)
    if (!bucket) {
      bucket = { synapses: 0, ids: new Set() }
      buckets.set(type, bucket)
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
      synapses: bucket.synapses,
      partners: bucket.ids.size,
      synapseShare: totalSynapses > 0 ? bucket.synapses / totalSynapses : 0,
      partnerShare: allPartners.size > 0 ? bucket.ids.size / allPartners.size : 0,
    }))
    .sort((a, b) => b.synapses - a.synapses || collate(a.type, b.type))

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
        bodyId: toNumber(partnerId[row]),
        type: asType(partnerType[row]),
        weight: w,
        share: total > 0 ? w / total : 0,
      }
    })
    .sort((a, b) => b.weight - a.weight || a.bodyId - b.bodyId)

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
const CALL_COLUMNS = ['consensusNt', 'predictedNt', 'celltypePredictedNt', 'neurotransmitter', 'nt']

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
