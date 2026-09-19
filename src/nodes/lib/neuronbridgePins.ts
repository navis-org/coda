/**
 * The NeuronBridge card's pins: what a ☆ writes, and the table the `Pinned` port emits from it.
 *
 * **The whole record is in the param**, not an id to look up again. That is what keeps the node
 * `cheap` with a live widget, Neuron Profile's split: `evaluate` builds this table from params
 * alone and never touches the network, so a pin costs no request at Run and a re-run cannot come
 * back different because the bucket moved on. The version a match was read from travels with it
 * (`nbVersion`), for the same reason a dataset node's `Latest (v1.2.3)` names its version.
 *
 * The param is `ids`-kind — an opaque `string[]` a bespoke surface owns — one JSON object per
 * entry. JSON rather than a delimited string because a line name is free text a release may put
 * anything in; an entry that does not decode is dropped rather than failing the node, since the
 * param is also hand-editable in the inspector.
 *
 * Schema and value sit side by side (invariant 3), and `neuronbridgePins.test.ts` asserts they
 * agree.
 */

import type { NeuronId } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { CellValue, TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'

/** One pinned match. Every field a string or number, so it survives JSON unchanged. */
export interface NbPin {
  /** The EM neuron the match was found for — the page's neuron, as text (invariant 8). */
  readonly neuronId: NeuronId
  /** The LM line, e.g. `SS02800`. */
  readonly line: string
  /** The LM library as published, e.g. `FlyLight Split-GAL4 Drivers`. */
  readonly collection: string
  readonly method: 'cds' | 'pppm'
  /** CDS's normalised score, or PPPM's score. */
  readonly score: number | null
  /** PPPM's rank, 0 best. Null under CDS. */
  readonly pppmRank: number | null
  /** CDS only. */
  readonly matchingPixels: number | null
  readonly mirrored: boolean
  /** `Brain` or `VNC`. */
  readonly area: string
  readonly slideCode: string
  readonly objective: string
  /** NeuronBridge's id for the matched LM image — what makes two pins of one line distinct. */
  readonly lmImageId: string
  /** The EM library the neuron was matched in, e.g. `FlyEM_Hemibrain_v1.2.1`. */
  readonly emLibrary: string
  /** The NeuronBridge data version the match was read from, e.g. `v3_10_0`. */
  readonly nbVersion: string
}

/** What makes a pin the same pin: the neuron, the method and the LM image. */
export function pinKey(pin: Pick<NbPin, 'neuronId' | 'method' | 'lmImageId'>): string {
  return `${pin.neuronId}|${pin.method}|${pin.lmImageId}`
}

export function encodePin(pin: NbPin): string {
  return JSON.stringify(pin)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A stored entry as a pin, or undefined for anything that is not one. */
export function decodePin(entry: string): NbPin | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(entry)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const neuronId = str(r.neuronId)
  const line = str(r.line)
  const lmImageId = str(r.lmImageId)
  const method = r.method === 'pppm' ? 'pppm' : r.method === 'cds' ? 'cds' : undefined
  if (!neuronId || !/^\d+$/.test(neuronId) || !line || !lmImageId || !method) return undefined
  return {
    neuronId: neuronId as NeuronId,
    line,
    collection: str(r.collection) ?? '',
    method,
    score: num(r.score),
    pppmRank: num(r.pppmRank),
    matchingPixels: num(r.matchingPixels),
    mirrored: r.mirrored === true,
    area: str(r.area) ?? '',
    slideCode: str(r.slideCode) ?? '',
    objective: str(r.objective) ?? '',
    lmImageId,
    emLibrary: str(r.emLibrary) ?? '',
    nbVersion: str(r.nbVersion) ?? '',
  }
}

/** The stored param, decoded, with repeats of one pin kept once (the first). */
export function readPins(stored: unknown): NbPin[] {
  if (!Array.isArray(stored)) return []
  const seen = new Set<string>()
  const pins: NbPin[] = []
  for (const entry of stored) {
    if (typeof entry !== 'string') continue
    const pin = decodePin(entry)
    if (!pin || seen.has(pinKey(pin))) continue
    seen.add(pinKey(pin))
    pins.push(pin)
  }
  return pins
}

/** The `Pinned` port's schema. A constant: nothing about the input changes its shape. */
export const PINNED_SCHEMA: TableSchema = tableSchema(
  column('neuronId', 'str'),
  column('line', 'str'),
  column('collection', 'str'),
  column('method', 'str'),
  column('score', 'f64'),
  column('pppmRank', 'i64'),
  column('matchingPixels', 'i64'),
  column('mirrored', 'bool'),
  column('area', 'str'),
  column('slideCode', 'str'),
  column('objective', 'str'),
  column('lmImageId', 'str'),
  column('emLibrary', 'str'),
  column('nbVersion', 'str'),
)

export function pinnedTable(pins: readonly NbPin[]): TableValue {
  // A pin *is* a row: `NbPin`'s fields are exactly `PINNED_SCHEMA`'s columns, and every one of them
  // is a cell value — which the agreement test holds.
  return tableFromRows(
    PINNED_SCHEMA,
    pins.map((pin): Record<string, CellValue> => ({ ...pin })),
  )
}
