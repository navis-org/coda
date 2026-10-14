/**
 * Which FBbt class a neuron *is*, given everything VFB asserts about it.
 *
 * A VFB individual is `INSTANCEOF` several classes at once. MBON01 in male-cns carries
 * `mushroom body output neuron 1` beside `adult cholinergic neuron`-style classes inferred from its
 * transmitter (252,336 such edges over 166,693 male-cns individuals, measured 2026-10-14). A
 * generic class cites papers about every neuron of that transmitter and contains a third of the
 * brain, so picking it is the wrong answer that still looks like one.
 *
 * **The rule: a neuron's type is the most specific class, at or above its asserted classes, that
 * some connectome names.** FBbt records curated per-dataset names as synonyms
 * (`fbbt#name_in_hemibrain`, `name_in_banc`, `name_in_male-cns`, …). A class somebody named in a
 * connectome is a cell type by construction, and `adult cholinergic neuron` is named in none. It
 * also climbs correctly where the asserted class is finer than any dataset's typing: hemibrain's
 * PFNa neurons are asserted to eight per-glomerulus classes that no dataset names, and the walk
 * lands on `FBbt_00111396`, which hemibrain, BANC, male-cns and FlyWire all name "PFNa".
 *
 * `VFB_SYMBOL` is a synonym type too, and deliberately **not** a dataset name: it is VFB's own
 * short label, given to generic classes as readily as to cell types.
 *
 * Everything here is pure over a `ClassGraph` handed in; `bridge.ts` fetches one.
 */

/** The FBbt synonym-type prefix that marks a dataset's own name for a class. */
export const NAME_IN_PREFIX = 'http://purl.obolibrary.org/obo/fbbt#name_in_'

/** The dataset a synonym type names the class in — `male-cns` for `…#name_in_male-cns` — or none. */
export const nameInKey = (type: string): string | undefined =>
  type.startsWith(NAME_IN_PREFIX) ? type.slice(NAME_IN_PREFIX.length) || undefined : undefined

/** The part of FBbt the rule needs: labels, direct parents, and per-dataset names. */
export interface ClassGraph {
  readonly labels: ReadonlyMap<string, string>
  /** Direct `SUBCLASSOF` parents, for every class reached. */
  readonly parents: ReadonlyMap<string, readonly string[]>
  /** Class → dataset name key (`hemibrain`, `banc`, …) → that dataset's names for it. */
  readonly names: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>
}

export interface TypeAnswer {
  /** The chosen class, or `undefined` when no named class was found or two tie. */
  readonly classId: string | undefined
  /** How many `SUBCLASSOF` steps above an asserted class it sits. 0 means asserted directly. */
  readonly climbed: number
  /** The asserted classes no other asserted class is below. */
  readonly finest: readonly string[]
  /** Named classes that tied, when there is more than one. Empty otherwise. */
  readonly tied: readonly string[]
}

/** How far up a walk goes before giving up. FBbt neuron types sit a few levels below `neuron`. */
export const MAX_CLIMB = 12

function isNamed(graph: ClassGraph, classId: string): boolean {
  return (graph.names.get(classId)?.size ?? 0) > 0
}

/**
 * A class and its ancestors, one `SUBCLASSOF` level at a time: level 0 is the class itself, and the
 * walk stops after `MAX_CLIMB` steps. A class reached twice (FBbt has multiple inheritance) is
 * yielded at the first level it appears on.
 */
function* levels(graph: ClassGraph, start: string): Generator<readonly string[]> {
  const seen = new Set([start])
  let level = [start]
  for (let depth = 0; depth <= MAX_CLIMB && level.length > 0; depth++) {
    yield level
    const next: string[] = []
    for (const id of level) {
      for (const parent of graph.parents.get(id) ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent)
          next.push(parent)
        }
      }
    }
    level = next
  }
}

/** Ancestor sets, built once per class per graph: a run over thousands of neurons shares classes. */
const ancestorMemo = new WeakMap<ClassGraph, Map<string, ReadonlySet<string>>>()

/** Every ancestor of a class within `MAX_CLIMB` steps, excluding the class itself. */
export function ancestorsOf(graph: ClassGraph, classId: string): ReadonlySet<string> {
  let memo = ancestorMemo.get(graph)
  if (!memo) ancestorMemo.set(graph, (memo = new Map()))
  let out = memo.get(classId)
  if (!out) {
    const found = new Set<string>()
    for (const level of levels(graph, classId)) for (const id of level) found.add(id)
    found.delete(classId)
    memo.set(classId, (out = found))
  }
  return out
}

/** The ids no other id in the list sits below: the most specific readings of one neuron. */
function mostSpecific(graph: ClassGraph, ids: readonly string[]): string[] {
  if (ids.length < 2) return [...ids]
  return ids.filter(
    (id) => !ids.some((other) => other !== id && ancestorsOf(graph, other).has(id)),
  )
}

/** The neuron's type under the rule above. */
export function typeClass(graph: ClassGraph, asserted: readonly string[]): TypeAnswer {
  const finest = mostSpecific(graph, [...new Set(asserted)])

  // Each finest class contributes the named classes on the first level of its walk that has any.
  const candidates = new Map<string, number>()
  for (const id of finest) {
    let depth = 0
    for (const level of levels(graph, id)) {
      const named = level.filter((c) => isNamed(graph, c))
      if (named.length > 0) {
        for (const c of named) candidates.set(c, Math.min(candidates.get(c) ?? depth, depth))
        break
      }
      depth++
    }
  }
  // A named class above another candidate is the coarser reading of the same neuron: drop it.
  const kept = mostSpecific(graph, [...candidates.keys()])

  if (kept.length === 1) {
    return { classId: kept[0], climbed: candidates.get(kept[0]!)!, finest, tied: [] }
  }
  return { classId: undefined, climbed: 0, finest, tied: kept.sort() }
}
