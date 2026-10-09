/**
 * Which of a selection's neurons a target answers for, and under what id.
 *
 * A selection says which dataset a neuron is from in one of two ways, and the Annotate card takes
 * both: a **qualified id** (`flywire:7205…`, `core/ids.ts`' `qualifyId`) where two datasets met in
 * one table, or a **dataset column** beside a plain id — a BigClust project's meta, whose `id` is
 * plain and whose `dataset` says FlyWire, hemibrain or the male CNS. A target says which datasets
 * it **serves**; empty serves every neuron, which is the ordinary single-dataset case.
 *
 * A neuron the target does not serve is *skipped*, not guessed at: a hemibrain body id written to
 * FlyWire's table is a different neuron, or none, and either way the wrong row. The card counts
 * what no target serves, so a selection that silently lost half its neurons cannot look complete.
 */

import { qualifiedDataset, unqualifyId } from '../../core/ids'
import { listEntries } from '../../core/node'

/** The datasets a target serves, from what somebody typed: comma-separated, case ignored. */
export function servedDatasets(text: string): string[] {
  return listEntries(text).map((name) => name.toLowerCase())
}

/**
 * Each target's share of a selection, and how many neurons no target serves — one pass, so "which
 * dataset is this row from" is said once. A neuron is someone's if any target serves every dataset
 * or names its own.
 */
export function routeToTargets(
  ids: readonly (string | null)[],
  datasets: readonly (string | null)[] | undefined,
  serves: readonly (readonly string[])[],
): {
  /** Each target's ids to ask about, unqualified, in first-seen order, each once. */
  routes: string[][]
  unserved: number
} {
  const targets = serves.map((list) => ({
    served: new Set(list),
    seen: new Set<string>(),
    routed: [] as string[],
  }))
  let unserved = 0
  ids.forEach((raw, row) => {
    if (raw === null) return
    const dataset = (qualifiedDataset(raw) ?? datasets?.[row] ?? '').toLowerCase()
    const id = unqualifyId(raw)
    let anyone = false
    for (const { served, seen, routed } of targets) {
      if (served.size > 0 && !served.has(dataset)) continue
      anyone = true
      if (seen.has(id)) continue
      seen.add(id)
      routed.push(id)
    }
    if (!anyone) unserved++
  })
  return { routes: targets.map((t) => t.routed), unserved }
}
