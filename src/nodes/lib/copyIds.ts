/**
 * What the Copy IDs node puts on the clipboard, and the vocabulary its controls are written in.
 *
 * Here rather than beside the button, for the reason `UNIT_LABELS` is one table: the node's
 * `Separator` enum, the function that joins with it and the two exporters that emit the same
 * text are the same decision written four times if they live apart, and the failure is a card
 * offering an option the copy does not honour — invisible until somebody pastes.
 *
 * So **every reader comes through `copyIdsSettings`**, which is `heatmapPaletteOf`'s arrangement
 * two imports up from both emitters: a headless `*Of(params)` resolver shared by the node, the
 * card and both languages. It is what makes the fallback rule below exist once. The node reads
 * `SEPARATOR_OPTIONS` for its enum; nothing else needs to know the table is a table.
 *
 * Headless (`src/nodes/lib`), so the joining rule is unit-tested without a DOM. Nothing here
 * writes to a clipboard; `evaluate` is a pass-through and the write is `ui/export.ts`'s
 * `copyText`, exactly as a Download's file is `ui/useDownloads.ts`'s.
 */

import { idColumn } from './tableOps'
import type { TableValue } from '../../core/values'

/**
 * The separators, keyed by the value stored in the param.
 *
 * Keyed by a name rather than holding the character itself, because the character is what the
 * *param* would then store — `'\n'` and `', '` in a saved graph file, where a diff shows an
 * escape and a reader has to work out which control it belongs to. A name survives adding a
 * sixth, and a stored graph naming one that has since gone falls back in `copyIdsSettings`
 * rather than joining with `undefined`.
 */
export const SEPARATORS = {
  newline: { label: 'New line', text: '\n' },
  comma: { label: 'Comma', text: ',' },
  commaSpace: { label: 'Comma + space', text: ', ' },
  tab: { label: 'Tab', text: '\t' },
  space: { label: 'Space', text: ' ' },
} as const satisfies Record<string, { label: string; text: string }>

export type SeparatorId = keyof typeof SEPARATORS

/** The node's declared default, so its definition cannot name one this table does not have. */
export const DEFAULT_SEPARATOR: SeparatorId = 'newline'

/** The node's enum options, in declaration order, so nothing can list a sixth of its own. */
export const SEPARATOR_OPTIONS = Object.entries(SEPARATORS).map(([value, { label }]) => ({
  value,
  label,
}))

export interface CopyIdsSettings {
  /** Already the character(s), so no reader repeats the fallback below. */
  separator: string
  /** Collapse repeats, keeping first-seen order. */
  dedupe: boolean
  /** Wrap each id in double quotes, for a Python or R list. */
  quoted: boolean
}

/**
 * The node's three params, resolved.
 *
 * The one place a stored `separator` becomes a character, which is what keeps the card, the
 * notebook and the knitted document agreeing: written per surface, a removed separator or a
 * changed fallback fails *silently* in the two exporters, whose goldens compare emitted text and
 * would keep passing on either answer.
 *
 * `params` is `ParamValues` from a node or `EmitContext.params` from an exporter — the latter
 * already has the definition's defaults filled in, and the `!== false` / `=== true` readings
 * below give the same answer for an absent key either way.
 */
export function copyIdsSettings(params: Record<string, unknown>): CopyIdsSettings {
  const named = SEPARATORS[String(params.separator ?? '') as SeparatorId]
  return {
    separator: (named ?? SEPARATORS[DEFAULT_SEPARATOR]).text,
    dedupe: params.dedupe !== false,
    quoted: params.quoted === true,
  }
}

/**
 * The ids a Copy IDs node would copy, in table order.
 *
 * `idColumn` is what reads them, so the id crosses as **text** and an eighteen-digit CAVE root
 * id is the id it was rather than the float64 nearest it (invariant 8). It also drops nulls,
 * which is what a left-joined `Neuron Set` row is: a body the backend published nothing about
 * has no id to paste, and a blank line in the middle of a pasted list is a query for nothing.
 *
 * Deduplication keeps **first-seen order** rather than sorting: a Sort upstream is a decision,
 * and a copy that reordered it would quietly discard it.
 */
export function copyIds(table: TableValue, dedupe: boolean): string[] {
  const ids = idColumn(table)
  return dedupe ? [...new Set(ids)] : ids
}

/**
 * Those ids as the one string that goes on the clipboard.
 *
 * Takes the ids rather than the table, which is what lets the Network viewer's own **Copy ids**
 * use it — that action has a list in hand and no table anywhere — and what lets the card count
 * and copy from one array instead of walking the column twice.
 *
 * Quoting is applied to each id rather than to the joined result, because the two are only the
 * same thing for a one-element list and the difference is a paste that looks right until it is
 * the whole list in one string.
 */
export function joinIds(
  ids: readonly string[],
  {
    separator = SEPARATORS[DEFAULT_SEPARATOR].text,
    quoted = false,
  }: Partial<CopyIdsSettings> = {},
): string {
  return (quoted ? ids.map((id) => `"${id}"`) : ids).join(separator)
}
