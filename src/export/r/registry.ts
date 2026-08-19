/** R emitter and helper registries. Same mechanism as the Python side, separate contents. */

import type { ParamValues } from '../../core/node'
import type { Emitter, HelperSpec } from './types'

const emitters = new Map<string, Emitter>()
const helpers = new Map<string, HelperSpec>()

export function registerEmitter<P extends ParamValues>(type: string, emit: Emitter<P>): void {
  if (emitters.has(type)) throw new Error(`Duplicate R emitter for node type "${type}"`)
  emitters.set(type, emit as Emitter)
}

export function getEmitter(type: string): Emitter | undefined {
  return emitters.get(type)
}

export function registeredEmitterTypes(): string[] {
  return [...emitters.keys()].sort()
}

export function registerHelper(spec: HelperSpec): void {
  if (helpers.has(spec.name)) throw new Error(`Duplicate R helper "${spec.name}"`)
  helpers.set(spec.name, spec)
}

/** A helper's transitive closure, dependency first, deterministic. */
export function resolveHelpers(names: Iterable<string>): HelperSpec[] {
  const out: HelperSpec[] = []
  const seen = new Set<string>()
  const visit = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    const spec = helpers.get(name)
    if (!spec) throw new Error(`Unknown R helper "${name}"`)
    for (const dep of spec.needs ?? []) visit(dep)
    out.push(spec)
  }
  for (const name of [...names].sort()) visit(name)
  return out
}
