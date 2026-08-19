/**
 * Turns a node's flat param list into the tabs and rows a styling panel draws.
 *
 * Two reshapings happen here, and both are decided by the node definition rather than by
 * this module: params are bucketed by `group` into tabs, and params sharing a
 * `composite.key` collapse into one row. The renderer downstream only lays out what this
 * returns, which is what makes the arrangement testable without mounting anything.
 *
 * Nothing is invented and nothing is dropped. A param the definition forgot to group still
 * reaches the panel, in a trailing tab that names the omission rather than swallowing it —
 * a control that silently disappears is far worse than an untidy tab.
 */

import type { NodeDefinition, ParamDef, ParamValues } from '../../core/node'

export interface SingleRow {
  kind: 'single'
  param: ParamDef
}

/** Several params drawn as one visual property. See `CompositeRef`. */
export interface CompositeRow {
  kind: 'composite'
  key: string
  label: string
  /** How the property is driven — the mapping enum, or the column picker. */
  primary: ParamDef | undefined
  /** What it is driven by. At most one is visible at a time, by `visibleIf`. */
  value: ParamDef | undefined
  /** Modifiers that belong to the property without defining it, e.g. a size range. */
  extras: ParamDef[]
}

export type ParamRow = SingleRow | CompositeRow

export interface ParamTab {
  id: string
  label: string
  /** Carried through from the group: editing this tab re-runs the graph. */
  affectsData?: boolean
  rows: ParamRow[]
}

/** Tab id for params whose definition declared groups but did not place them. */
export const UNGROUPED_TAB = '__ungrouped'

/**
 * Bucket a node's params into tabs of rows.
 *
 * `filter` is applied *before* grouping, so a tab whose every param is filtered out does not
 * appear. The overlay passes the presentational test through it, which is what keeps the
 * panel the safe surface its rail predecessor was — widened by `paramsForPanel` to admit the
 * params of a group that has declared itself as changing data.
 */
export function groupParams(
  def: NodeDefinition,
  params: ParamValues,
  filter: (param: ParamDef) => boolean = () => true,
): ParamTab[] {
  const declared = def.paramGroups ?? []
  const visible = (def.params ?? []).filter(
    (param) => filter(param) && (!param.visibleIf || param.visibleIf(params)),
  )

  const known = new Set(declared.map((group) => group.id))
  const tabs = new Map<string, ParamTab>()
  // The spread carries `affectsData` onto the tab, which is how the panel knows to warn.
  for (const group of declared) tabs.set(group.id, { ...group, rows: [] })

  // Rows are created on first sight of a visible member, so ordering follows the definition
  // and a composite whose members are all hidden produces no row at all.
  const composites = new Map<string, CompositeRow>()

  for (const param of visible) {
    const groupId = param.group && known.has(param.group) ? param.group : UNGROUPED_TAB
    let tab = tabs.get(groupId)
    if (!tab) {
      tab = { id: UNGROUPED_TAB, label: 'Other', rows: [] }
      tabs.set(UNGROUPED_TAB, tab)
    }

    const ref = param.composite
    if (!ref) {
      tab.rows.push({ kind: 'single', param })
      continue
    }

    // Key rows per tab: two groups could reasonably reuse a name, and merging them would
    // move a control into a tab it does not belong to.
    const rowKey = `${groupId}/${ref.key}`
    let row = composites.get(rowKey)
    if (!row) {
      row = { kind: 'composite', key: ref.key, label: ref.label ?? ref.key, primary: undefined, value: undefined, extras: [] }
      composites.set(rowKey, row)
      tab.rows.push(row)
    }
    // The primary carries the row's label; anything else only fills a gap.
    if (ref.role === 'primary' && ref.label) row.label = ref.label

    if (ref.role === 'primary' && !row.primary) row.primary = param
    else if (ref.role === 'value' && !row.value) row.value = param
    // A second visible `value` means two supposedly exclusive controls are both showing.
    // Demote rather than discard: an extra control looks wrong, a missing one is invisible.
    else if (ref.role === 'primary' || ref.role === 'value') row.extras.push(param)
    else row.extras.push(param)
  }

  return [...tabs.values()].filter((tab) => tab.rows.length > 0)
}

/** Short label for one control inside a composite row. */
export function facetLabel(param: ParamDef): string {
  return param.composite?.facet ?? param.label
}

/**
 * The panel's admission rule: presentational params, plus anything in a group that has
 * declared `affectsData`.
 *
 * Presentational-only is what makes a styling panel safe to touch, and it was the flat rail's
 * whole promise. A group opting out of it is a deliberate act by a node definition, and the
 * panel is expected to say so where the user can see it — not to quietly include the params
 * and let a graph go stale for no visible reason.
 */
export function paramsForPanel(def: NodeDefinition): (param: ParamDef) => boolean {
  const dataGroups = new Set((def.paramGroups ?? []).filter((g) => g.affectsData).map((g) => g.id))
  return (param) => param.presentational === true || (!!param.group && dataGroups.has(param.group))
}
