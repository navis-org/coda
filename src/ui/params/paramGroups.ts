/**
 * Turns a node's flat param list into the tabs a styling panel or a node card draws.
 *
 * Two reshapings happen here, and both are decided by the node definition rather than by
 * this module: params are bucketed by `group` into tabs (`bucketParams`), and params sharing a
 * `composite.key` collapse into one row (`groupParams`, which builds on it). The renderer
 * downstream only lays out what these return, which is what makes the arrangement testable
 * without mounting anything.
 *
 * **Two consumers, one bucketing.** The styling panel wants rows, because a colour is three
 * params and one property. The node card wants the buckets raw: it has no composite row to
 * draw and its own field markup, and it tabs only to stop a param band growing without limit —
 * `compare.matchTypes` and `compare.connectivity` size theirs by an arity param, so four
 * datasets is sixteen rows. Splitting the two apart is fine; having each answer "which tab is
 * this param in" for itself is not, which is why that half is one function.
 *
 * Nothing is invented and nothing is dropped. A param the definition forgot to group still
 * reaches the surface, in a trailing tab that names the omission rather than swallowing it —
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

/** One tab's worth of params, before anything decides how to draw them. */
export interface ParamBucket {
  id: string
  label: string
  /** Carried through from the group: editing this tab re-runs the graph. */
  affectsData?: boolean
  params: ParamDef[]
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
export function bucketParams(
  def: NodeDefinition,
  params: ParamValues,
  filter: (param: ParamDef) => boolean = () => true,
): ParamBucket[] {
  const declared = def.paramGroups ?? []
  const visible = (def.params ?? []).filter(
    (param) => filter(param) && (!param.visibleIf || param.visibleIf(params)),
  )

  const known = new Set(declared.map((group) => group.id))
  const buckets = new Map<string, ParamBucket>()
  // The spread carries `affectsData` onto the tab, which is how the panel knows to warn.
  for (const group of declared) buckets.set(group.id, { ...group, params: [] })

  for (const param of visible) {
    const groupId = param.group && known.has(param.group) ? param.group : UNGROUPED_TAB
    let bucket = buckets.get(groupId)
    if (!bucket) {
      bucket = { id: UNGROUPED_TAB, label: 'Other', params: [] }
      buckets.set(UNGROUPED_TAB, bucket)
    }
    bucket.params.push(param)
  }

  return [...buckets.values()].filter((bucket) => bucket.params.length > 0)
}

/**
 * Bucket a node's params into tabs of rows.
 *
 * `filter` is applied *before* grouping, so a tab whose every param is filtered out does not
 * appear. The overlay passes the presentational test through it, which is what keeps the
 * panel the safe surface its rail predecessor was — widened by `paramsForPanel` to admit the
 * params of a group that has declared itself as changing data.
 *
 * The bucketing half is `bucketParams`; only the collapsing of composites into rows is here.
 * The node card wants the buckets and not the rows — it has no composite row to draw, and its
 * own field markup — and two implementations of "which tab is this param in" would be two
 * answers the moment one of them learned about a new kind of group.
 */
export function groupParams(
  def: NodeDefinition,
  params: ParamValues,
  filter: (param: ParamDef) => boolean = () => true,
): ParamTab[] {
  const tabs: ParamTab[] = []

  for (const bucket of bucketParams(def, params, filter)) {
    const { params: members, ...rest } = bucket
    const tab: ParamTab = { ...rest, rows: [] }
    tabs.push(tab)

    // Rows are created on first sight of a visible member, so ordering follows the definition
    // and a composite whose members are all hidden produces no row at all. Keyed per tab: two
    // groups could reasonably reuse a name, and merging them would move a control into a tab it
    // does not belong to.
    const composites = new Map<string, CompositeRow>()

    for (const param of members) {
      const ref = param.composite
      if (!ref) {
        tab.rows.push({ kind: 'single', param })
        continue
      }

      let row = composites.get(ref.key)
      if (!row) {
        row = {
          kind: 'composite',
          key: ref.key,
          label: ref.label ?? ref.key,
          primary: undefined,
          value: undefined,
          extras: [],
        }
        composites.set(ref.key, row)
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
  }

  return tabs
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
  const dataGroups = new Set(
    (def.paramGroups ?? []).filter((g) => g.affectsData).map((g) => g.id),
  )
  return (param) =>
    param.presentational === true || (!!param.group && dataGroups.has(param.group))
}

/**
 * The params `ViewerSurface`'s flat rail draws for a node.
 *
 * Here rather than inline in the component because it is the whole of a policy decision and the
 * component is a hundred lines of frame around it — and because a rule that can be read without
 * mounting a WebGL canvas is a rule a test can hold. `ViewerSurface` renders three surfaces (the
 * expanded overlay, the pinned dock, a dashboard cell) and this is the same answer in all three.
 *
 * Two rules, and the first is the interesting one:
 *
 * - **A node that draws its own controls gets none.** `NodeDefinition.ownControls` says the
 *   body is already a control surface, and the rail would then be the same knobs a second time
 *   a few pixels away. Neuron Topology is the case: seventeen presentational params, every one
 *   of them drawn by its pager, its stage toolbar or one of its three tabs.
 * - **Presentational only**, and only where `visibleIf` admits it. Anything that changes what
 *   the node *returns* belongs on the node, where changing it marks the graph stale — a rail
 *   that could edit `Min weight` would restyle a result into being wrong.
 */
export function railParams(def: NodeDefinition, params: ParamValues): ParamDef[] {
  if (def.ownControls) return []
  return (def.params ?? []).filter(
    (param) => param.presentational === true && (!param.visibleIf || param.visibleIf(params)),
  )
}

/**
 * The tabbed styling sidebar's buckets, or none.
 *
 * `railParams`' other half, and here for the same reason: `ownControls` was read once inside that
 * function and once again by hand at `ViewerSurface`'s tab expression, so the flag meant two
 * things in two places and only one of them was where the doc said the policy lived — and only
 * one had a test. The combination is unreachable today (no node declares both `paramGroups` and
 * `ownControls`), which is exactly why it is cheap to state now rather than after one does.
 *
 * `controls` is the frame's half of the decision: a dashboard cell asks for the flat rail however
 * the node is declared, because a 268px sidebar in a sixth of a window is the panel plus a strip
 * and no view.
 */
export function panelTabs(
  def: NodeDefinition,
  params: ParamValues,
  controls: 'auto' | 'rail' | 'hidden',
): ReturnType<typeof groupParams> {
  if (controls !== 'auto' || def.ownControls || !def.paramGroups?.length) return []
  return groupParams(def, params, paramsForPanel(def))
}
