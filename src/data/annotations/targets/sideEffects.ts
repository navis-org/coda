/**
 * What a write writes besides the cells somebody edited — BigClust's side effects, each switched on
 * per target and off by default. One today:
 *
 * - **Clio's `instance` kept in step with `type`**: `{type}_{side}`, the side being `soma_side`
 *   or, where a body has none, `root_side`; just `{type}` with neither; cleared with the type.
 *   `ClioBackend._write_annotations`' rule, read off the record before writing.
 *
 * A derived change is `unchecked` — the card never showed its cell, so there is no `before` to
 * hold it against — and the write records what it replaced, so Undo restores it with the rest.
 * A change somebody made by hand to the derived field in the same batch wins.
 */

import type { AnnotationTarget, FieldValue, TargetChange } from './types'

export interface SideEffects {
  instanceFromType?: boolean
}

export async function withSideEffects(
  target: AnnotationTarget,
  changes: readonly TargetChange[],
  effects: SideEffects,
  signal?: AbortSignal,
): Promise<TargetChange[]> {
  const given = new Set(changes.map((c) => `${c.key}\u0000${c.field}`))
  const extra: TargetChange[] = []
  const add = (key: string, field: string, value: FieldValue) => {
    const id = `${key}\u0000${field}`
    if (given.has(id)) return
    given.add(id)
    extra.push({ key, field, value, before: null, unchecked: true })
  }

  const types = effects.instanceFromType ? changes.filter((c) => c.field === 'type') : []
  if (types.length) {
    // A Clio record's key is its body id, so the keys are what to ask about.
    const read = await target.read(
      types.map((c) => c.key),
      ['soma_side', 'root_side'],
      signal,
    )
    const sides = new Map(
      read.records.map((r) => [r.key, r.values.soma_side ?? r.values.root_side ?? null]),
    )
    for (const change of types) {
      const side = sides.get(change.key)
      const type = change.value === null ? null : String(change.value)
      add(
        change.key,
        'instance',
        type === null ? null : side ? `${type}_${String(side)}` : type,
      )
    }
  }

  return [...changes, ...extra]
}
