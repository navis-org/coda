/**
 * Which synapses belong to the partners somebody has lit.
 *
 * Pure and headless so the count is a thing a test can assert. That matters here more than it
 * looks: the first version of this decided colour by handing `resolveColor` an override for every
 * value it found in the partner column, and it was wrong in a way no test could see and no
 * screenshot could either — it lit hundreds of synapses, the same ones every time, whatever was
 * selected.
 *
 * ## The bug this module exists to make impossible
 *
 * `resolveColor` keys a categorical channel through its own `cellKey`, which maps a null cell to
 * `'—'`. The override map was built with `String(v ?? '')`, so every synapse whose partner has no
 * cell type missed its entry and fell through to `cycleColor(index)` — a bright palette colour.
 * Measured on `male-cns:v1.0` body 10003: the partner-resolved cloud is 57,034 rows and
 * **13,621 of them name an untyped partner** — every one permanently lit, and the same ones every
 * time, because being untyped is a property of the data rather than of the selection. The partner
 * actually picked, AN10B021, has 38.
 *
 * The repair is not to copy `cellKey`'s null rule into a second place — that is the same bug
 * waiting for the next divergence. It is to stop colouring by a column whose vocabulary belongs
 * to the data at all. This builds a column whose vocabulary is *ours*: a selected partner's own
 * name, or one sentinel. Nine values at most, every one a plain string we wrote, so nothing
 * downstream can disagree about how a null or a number is spelled.
 *
 * ## Polarity is half the answer
 *
 * A partner is selected *in a direction* — the list is showing inputs or outputs — and a synapse
 * carries the polarity of the queried neuron's own side. Matching on the partner alone lights an
 * output synapse when an input partner was picked, whenever a type name appears on both sides.
 * That was a second, independent bug in the same expression.
 */

import { idText } from '../../core/ids'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { getColumn } from '../../core/values'
import { findColumn } from '../../core/types'
import { markLabel } from '../../nodes/lib/chartSelection'
import type { PartnerGrouping } from '../../nodes/lib/profileStats'
import { partnerKey } from '../../nodes/lib/profileStats'

/**
 * The derived column's name.
 *
 * Prefixed, because it is written onto a copy of a source's attribute table and must not collide
 * with a column a backend publishes. `codaHighlight` is not a name any connectome uses.
 */
export const HIGHLIGHT_COLUMN = 'codaHighlight'

/**
 * The two columns a cloud can name its partner with.
 *
 * `partnerType` is the canonical one and what `type` grouping reads directly. `partnerId` is what
 * CAVE publishes *instead* — its synapse table carries a root id on each side and no type — and
 * what every per-neuron grouping needs whatever the source. Named here because
 * `partnerLabelColumn` and the card's own "can this dataset highlight at all" test are two
 * readers of one fact.
 */
export const PARTNER_COLUMN = 'partnerType'
export const PARTNER_ID_COLUMN = 'partnerId'

/** Whether a cloud with this schema can name its partners at all, either way. */
export function namesPartners(schema: TableValue['schema']): boolean {
  return (
    findColumn(schema, PARTNER_COLUMN) !== undefined ||
    findColumn(schema, PARTNER_ID_COLUMN) !== undefined
  )
}

/** Everything not lit. One key, so the whole remainder takes one muted colour. */
export const HIGHLIGHT_OTHER = 'other'

/**
 * A partner cell as the partner *list* names it.
 *
 * `markLabel` from `nodes/lib/chartSelection.ts`, re-exported rather than restated — which this
 * module of all modules has no business doing twice. It exists because the null-cell label was
 * spelled `''` here and `'—'` in `resolveColor`; writing a third `'—'` inline was the same
 * mistake one layer up, and `MISSING_LABEL` is where that character already lives.
 */
export { markLabel as partnerLabel } from '../../nodes/lib/chartSelection'

/** Which polarity of the queried neuron's synapses a direction is about. */
export function polarityFor(direction: string): 'pre' | 'post' {
  // `inputs` means somebody synapses *onto* this neuron, so the row we want is its postsynaptic
  // density. Getting this backwards lights the right count of the wrong synapses.
  return direction === 'inputs' ? 'post' : 'pre'
}

export interface HighlightColumn {
  /** One entry per synapse row: a lit partner's name, or `HIGHLIGHT_OTHER`. */
  readonly values: ColumnData
  /** How many rows are lit. Shown on the card, so a wrong answer is visible rather than implied. */
  readonly lit: number
}

/**
 * Label every synapse row with the partner it belongs to, or `other`.
 *
 * `partnerColumn` is the column naming each synapse's partner — `partnerType` today. Rows are lit
 * only when **both** the partner is selected and the polarity matches the direction being shown.
 *
 * A cloud with no polarity column matches on the partner alone rather than lighting nothing: a
 * source that publishes partners but not sides is degraded, not broken, and refusing there would
 * turn a missing column into a feature that silently does nothing — which is the failure this
 * whole module is a response to.
 */
export function highlightColumn(
  attributes: TableValue,
  partnerColumn: ColumnData,
  options: { partners: readonly string[]; direction: string },
): HighlightColumn {
  const selected = new Set(options.partners)
  const wanted = polarityFor(options.direction)
  const polarity = findColumn(attributes.schema, 'polarity')
    ? getColumn(attributes, 'polarity')
    : undefined

  const values: ColumnData = new Array<CellValue>(attributes.length)
  let lit = 0
  for (let i = 0; i < attributes.length; i++) {
    const name = markLabel(partnerColumn[i])
    const matches = selected.has(name) && (!polarity || polarity[i] === wanted)
    if (matches) lit++
    values[i] = matches ? name : HIGHLIGHT_OTHER
  }
  return { values, lit }
}

/**
 * The column naming each synapse's partner, in the same vocabulary the partner list uses.
 *
 * Headless and here rather than in two `useMemo`s inside the card, for the reason this module
 * exists at all: it is the vocabulary the list and the arbour share, and a disagreement between
 * them lights nothing while looking perfectly clickable. Fifty lines of column arithmetic whose
 * only test route was a three-second jsdom render of a WebGL card is fifty lines nobody checks.
 *
 * **Two routes, and which one runs is a fact about the data plus the grouping.**
 *
 * - The cloud names the partner's *type* and `type` grouping wants exactly that: the column is
 *   handed back as it stands, no copy.
 * - Otherwise the cloud's `partnerId` is joined against the connectivity tables, which carry the
 *   type for each partner — on CAVE resolved through `typeLookup`, i.e. through whatever
 *   annotations are wired to the dataset node. `cave/schema.ts` narrows the synapse schema to
 *   four columns because a CAVE synapse table has a root id on each side and no type at all.
 *
 * A partner in neither table comes back `null`, which `markLabel` spells `—` — the same bucket
 * `partnerTypes` files it under. So the two agree about what is unnamed by construction.
 *
 * The map holds the partner's **type**, not its key: the key is `partnerKey`'s answer and depends
 * on the grouping, so keying the map by it made `neuron` grouping build fifteen thousand entries
 * of `id → id` and re-walk both tables on every change of a control that could not move them.
 */
export function partnerLabelColumn(
  attributes: TableValue,
  tables: ReadonlyArray<TableValue | undefined>,
  grouping: PartnerGrouping,
): ColumnData | undefined {
  const hasType = findColumn(attributes.schema, PARTNER_COLUMN) !== undefined
  if (hasType && grouping === 'type') return getColumn(attributes, PARTNER_COLUMN)
  if (!findColumn(attributes.schema, PARTNER_ID_COLUMN)) {
    // Nothing to join on. A type column alone cannot answer a per-neuron grouping.
    return hasType && grouping !== 'neuron' ? getColumn(attributes, PARTNER_COLUMN) : undefined
  }

  const typeById = new Map<string, CellValue>()
  for (const table of tables) {
    if (!table || !findColumn(table.schema, PARTNER_ID_COLUMN)) continue
    const ids = getColumn(table, PARTNER_ID_COLUMN)
    const types = findColumn(table.schema, PARTNER_COLUMN)
      ? getColumn(table, PARTNER_COLUMN)
      : undefined
    for (let i = 0; i < table.length; i++) {
      // `idText` on both sides of the join — invariant 8, and the two columns are declared `str`
      // on CAVE and `i64` on the canonical schema, so this is the seam.
      const id = idText(ids[i] ?? null)
      if (id) typeById.set(id, types?.[i] ?? null)
    }
  }

  const ids = getColumn(attributes, PARTNER_ID_COLUMN)
  const labels: ColumnData = new Array<CellValue>(attributes.length)
  for (let i = 0; i < attributes.length; i++) {
    const id = idText(ids[i] ?? null)
    // `has`, not a truthy value: a partner *known* to be untyped is not the same as one this
    // neuron has no connection row for, and only the second may fall out of the vocabulary.
    labels[i] =
      id !== null && typeById.has(id) ? partnerKey(grouping, typeById.get(id), id) : null
  }
  return labels
}
