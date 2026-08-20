/**
 * The level above the primary regions.
 *
 * neuPrint's `Meta.roiHierarchy` is a nested `{ name, children }` tree covering every region a
 * dataset publishes, and `Meta.primaryRois` marks the subset that tiles the volume. Between them
 * they answer a question neither can alone: **which group does this region belong to** —
 * `EB` and `FB` and `PB` are all `CX`, and on male-CNS a hundred and forty-four regions fall into
 * a handful of groups that are the difference between reading the map and hunting across it.
 *
 * Established against neuprint-python 0.6.3 by introspection rather than recalled, and worth
 * recording that `Client.fetch_roi_hierarchy` **does not exist** — it is `neuprint.fetch_roi_hierarchy`,
 * a module-level function. The same shape as the `navis.interfaces.neuprint` trap: the obvious
 * spelling is a well-bound name and an AttributeError.
 *
 * ## What counts as a super ROI
 *
 * The nearest ancestor of a primary region that is itself **not primary and not the root**.
 *
 * Both exclusions are load-bearing. A primary region nested inside another primary one does not
 * happen in a well-formed hierarchy, but the tree is somebody else's data and the check costs
 * nothing. The root is the dataset itself — hemibrain's tree is rooted at `hemibrain` — and every
 * region is under it, so admitting it would produce one group containing everything, which is a
 * control that does nothing dressed as a control that does something.
 *
 * A primary region whose only ancestor is the root therefore has **no** super ROI, and that is a
 * real answer rather than a gap: hemibrain lists `AL(L)`, `GNG` and others directly under the
 * root, beside groups like `CX` and `INP`.
 */

/** One node of `Meta.roiHierarchy`, as published. */
interface HierarchyNode {
  name?: unknown
  children?: unknown
}

/**
 * Map each primary region to the group above it.
 *
 * Regions with no group are absent from the result rather than mapped to a placeholder, so a
 * caller can tell "this belongs to nothing" from "this belongs to something called nothing".
 *
 * Never throws. The hierarchy arrives as a JSON string from a server this app does not control,
 * and a dataset that publishes a malformed one should lose the grouping control, not the map.
 */
export function superRoisFrom(
  raw: unknown,
  primaryRois: readonly string[],
): Record<string, string> {
  const root = parse(raw)
  if (!root) return {}
  const primary = new Set(primaryRois)
  const groups: Record<string, string> = {}

  /*
   * `group` is the nearest non-primary ancestor below the root — undefined while still at the
   * root, which is what makes a region listed directly under it come out ungrouped.
   */
  const walk = (node: HierarchyNode, group: string | undefined, depth: number): void => {
    const name = typeof node.name === 'string' ? node.name : undefined
    if (!name) return

    if (primary.has(name)) {
      if (group !== undefined) groups[name] = group
      // A primary region's own children are sub-primary: they nest inside it, and this is about
      // the level *above*. Descending would map them to a group they are only indirectly in.
      return
    }

    const children = Array.isArray(node.children) ? node.children : []
    // Depth 0 is the dataset itself. Anything below it that is not primary is a candidate group.
    const next = depth === 0 ? undefined : (group ?? name)
    for (const child of children) {
      if (child && typeof child === 'object') walk(child as HierarchyNode, next, depth + 1)
    }
  }

  walk(root, undefined, 0)
  return groups
}

/**
 * The groups themselves, in the order the hierarchy lists them.
 *
 * Tree order rather than alphabetical, because the hierarchy is somebody's ordering of anatomy
 * and re-sorting it discards that for nothing — the same call `DatasetInfo.rois` makes.
 */
export function superRoiNames(groups: Record<string, string>): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const group of Object.values(groups)) {
    if (seen.has(group)) continue
    seen.add(group)
    names.push(group)
  }
  return names
}

/** Accepts the parsed object or the JSON string Neo4j stores it as. */
function parse(raw: unknown): HierarchyNode | undefined {
  if (typeof raw === 'string') {
    try {
      const value: unknown = JSON.parse(raw)
      return value && typeof value === 'object' ? (value as HierarchyNode) : undefined
    } catch {
      return undefined
    }
  }
  return raw && typeof raw === 'object' ? (raw as HierarchyNode) : undefined
}
