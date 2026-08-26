/**
 * The `neuroglancer_segment_properties` sidecar: what a source calls its segments.
 *
 * It is the thing that turns a bucket of eighteen-digit keys into something a person can pick
 * from, and it is what makes three otherwise impossible answers possible on a precomputed source:
 * a region *name* for the ROI Meshes picker, a browsable neuron index for Explore, and a
 * `findNeurons` that can be filtered by anything the sidecar publishes.
 *
 * ## One document, and it is not small
 *
 * The whole thing is inline in one `info`: hemibrain's segmentation publishes 22,706 ids with a
 * `label` each, and its ROI source publishes 63. So this is **not** read by the probe — that runs
 * from an edit-time peek, and downloading half a megabyte because somebody typed a URL is
 * invariant 6's hazard. It is read on first *ask*, memoised per URL, by whichever of the three
 * callers above got there first.
 *
 * ## Every property becomes a column, and the type decides which
 *
 * `label`, `description` and `string` are text; `number` carries its own `data_type`; `tags` is an
 * index list into a shared vocabulary and is folded to one text cell with `JOIN_SEPARATOR`, which
 * is the separator the Explore widget splits back into chips. A property this does not recognise
 * is skipped rather than guessed at — a column of the wrong dtype is worse than an absent one,
 * because every picker downstream offers it.
 *
 * The id column is `neuronId` and it is **text**, like every id crossing this seam (invariant 8).
 * The sidecar publishes them as strings already; nothing here puts one through a number.
 */

import type { ColumnData, TableValue } from '../../core/values'
import { JOIN_SEPARATOR, makeTable } from '../../core/values'
import type { DType } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import { ID_COLUMN_NAME } from '../../core/ids'
import { fetchJson } from './transport'

interface RawProperty {
  id?: string
  type?: string
  data_type?: string
  values?: unknown[]
  /** `tags` only: the vocabulary the per-segment index lists point into. */
  tags?: string[]
}

interface RawSegmentProperties {
  '@type'?: string
  inline?: { ids?: unknown[]; properties?: RawProperty[] }
}

/** Neuroglancer's numeric property types, as Coda dtypes. */
const NUMBER_DTYPES: Readonly<Record<string, DType>> = {
  int8: 'i64',
  uint8: 'i64',
  int16: 'i64',
  uint16: 'i64',
  int32: 'i64',
  uint32: 'i64',
  float32: 'f64',
  float64: 'f64',
}

/**
 * The sidecar as a table, one row per segment.
 *
 * No memo of its own: `PrecomputedSource` reads this through `loadCachedTable`, which dedupes
 * concurrent callers, persists across sessions and honours Clear Cache. A second memo here would
 * be a copy the cached path could never invalidate — and a peek served from it would keep
 * answering after the store had been dropped.
 */
export async function readSegmentProperties(
  url: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<TableValue> {
  const base = url.replace(/\/+$/, '')
  /*
   * `fetchJson`, not `fetchInfo`. That memo exists for the small directory `info` that three
   * callers read in a row; this document is read once and is the largest thing here — hemibrain
   * publishes 22,706 rows — so holding the raw parse for the session *as well as* the table built
   * from it would retain two copies of it for nothing.
   */
  const raw = await fetchJson<RawSegmentProperties>(
    `${base}/info`,
    options.signal ? { signal: options.signal } : {},
  )
  if (raw['@type'] !== 'neuroglancer_segment_properties') {
    throw new Error(`${base} is not a segment-property source`)
  }
  return tableFrom(raw)
}

/** The inline block as a table. Exported for the decode tests; `readSegmentProperties` is the API. */
export function tableFrom(raw: RawSegmentProperties): TableValue {
  const ids = (raw.inline?.ids ?? []).map((id) => String(id))
  const columns = [column(ID_COLUMN_NAME, 'str')]
  const data: Record<string, ColumnData> = { [ID_COLUMN_NAME]: ids }

  for (const property of raw.inline?.properties ?? []) {
    const decoded = decode(property, ids.length)
    if (!decoded) continue
    // First writer wins: a sidecar naming two properties `label` would otherwise have the second
    // silently replace the first, and `makeTable` would still be handed a consistent table.
    if (data[decoded.name] !== undefined) continue
    columns.push(column(decoded.name, decoded.dtype))
    data[decoded.name] = decoded.values
  }
  return makeTable(tableSchema(...columns), data)
}

/**
 * One property as a named column, or undefined for a type this does not read.
 *
 * The `values` length is checked against the id count rather than trusted: these are somebody
 * else's bytes, and a short array would silently shift every label onto the wrong segment —
 * which is a table that looks perfectly well-formed and names the wrong neurons.
 */
function decode(
  property: RawProperty,
  count: number,
): { name: string; dtype: DType; values: ColumnData } | undefined {
  const name = nameFor(property)
  if (!name) return undefined
  const values = property.values
  if (!Array.isArray(values) || values.length !== count) return undefined

  if (property.type === 'tags') {
    const vocabulary = property.tags ?? []
    return {
      name,
      dtype: 'str',
      values: values.map((entry) =>
        Array.isArray(entry)
          ? entry.map((at) => vocabulary[Number(at)] ?? '').filter(Boolean).join(JOIN_SEPARATOR)
          : null,
      ),
    }
  }

  if (property.type === 'number') {
    const dtype = NUMBER_DTYPES[property.data_type ?? '']
    // An unknown width is not a number this can name a dtype for, and guessing `f64` would
    // advertise a column whose values may not be numbers at all.
    if (!dtype) return undefined
    return {
      name,
      dtype,
      values: values.map((v) => (v === null || v === undefined ? null : Number(v))),
    }
  }

  return {
    name,
    dtype: 'str',
    values: values.map((v) => (v === null || v === undefined ? null : String(v))),
  }
}

/**
 * What to call a property's column.
 *
 * `label` and `description` are *types* rather than names in the format — the id of a label
 * property is conventionally `label` but need not be — so the type wins for those two, which is
 * what lets a picker downstream expect a column called `label` on every source that publishes
 * one. Everything else is named by its own id.
 */
function nameFor(property: RawProperty): string | undefined {
  if (property.type === 'label') return 'label'
  if (property.type === 'description') return 'description'
  if (property.type === 'string' || property.type === 'number' || property.type === 'tags') {
    return property.id || undefined
  }
  return undefined
}

/**
 * Segment ids for a set of labels, in the order the labels were asked for.
 *
 * The lookup the ROI Meshes node needs: a picker names regions and a mesh fetch wants ids. Built
 * per call rather than cached beside the table because the table is the cached thing and this is
 * one pass over a column of at most a few thousand.
 *
 * A label naming no segment is simply absent from the result — the caller reports which, because
 * only it knows whether that is worth a sentence.
 */
export function idsForLabels(
  properties: TableValue,
  labels: readonly string[],
): Array<{ label: string; id: string }> {
  const byLabel = labelIndex(properties)
  return labels
    .map((label) => ({ label, id: byLabel.get(label) }))
    .filter((hit): hit is { label: string; id: string } => hit.id !== undefined)
}

/**
 * One collator for every label sort.
 *
 * `sort((a, b) => a.localeCompare(b))` re-derives collation state per comparison, which is
 * ~330,000 of them on hemibrain's 22,706 labels — on a graph-mutation path, since this runs from
 * the peek that fills the region picker.
 */
const COLLATOR = new Intl.Collator()

/**
 * The label → segment id map, built once per table.
 *
 * Keyed on the table's identity, which is the cached and identity-stable thing — the same
 * argument its own memo makes, turned around. Without it every ROI fetch walks 22,706 rows and
 * builds a 22,706-entry map again.
 */
const LABEL_INDEX = new WeakMap<TableValue, Map<string, string>>()

function labelIndex(properties: TableValue): Map<string, string> {
  const held = LABEL_INDEX.get(properties)
  if (held) return held
  const byLabel = new Map<string, string>()
  const ids = properties.data[ID_COLUMN_NAME] ?? []
  const names = properties.data['label'] ?? []
  for (let i = 0; i < properties.length; i++) {
    const name = names[i]
    if (name === null || name === undefined) continue
    // First wins, so a duplicate label resolves to the same segment every run.
    if (!byLabel.has(String(name))) byLabel.set(String(name), String(ids[i]))
  }
  LABEL_INDEX.set(properties, byLabel)
  return byLabel
}

/** Every label the sidecar publishes, sorted for a picker. Empty when it publishes none. */
export function labelsOf(properties: TableValue): string[] {
  const names = properties.data['label']
  if (!names) return []
  const unique = new Set<string>()
  for (const name of names) {
    if (name !== null && name !== undefined) unique.add(String(name))
  }
  return [...unique].sort(COLLATOR.compare)
}
