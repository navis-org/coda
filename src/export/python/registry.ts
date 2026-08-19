/**
 * Emitter and helper registries.
 *
 * Keyed by node type, mirroring `core/registry.ts` — and deliberately separate from it, so
 * a build that never imports the exporter carries none of this.
 */

import type { Emitter, HelperSpec } from './types'
import type { ParamValues } from '../../core/node'

const emitters = new Map<string, Emitter>()
const helpers = new Map<string, HelperSpec>()

export function registerEmitter<P extends ParamValues>(type: string, emit: Emitter<P>): void {
  if (emitters.has(type)) {
    throw new Error(`Duplicate Python emitter for node type "${type}"`)
  }
  emitters.set(type, emit as Emitter)
}

export function getEmitter(type: string): Emitter | undefined {
  return emitters.get(type)
}

export function registeredEmitterTypes(): string[] {
  return [...emitters.keys()].sort()
}

export function registerHelper(spec: HelperSpec): void {
  if (helpers.has(spec.name)) {
    throw new Error(`Duplicate Python helper "${spec.name}"`)
  }
  helpers.set(spec.name, spec)
}

/**
 * A helper's transitive closure, in a deterministic order.
 *
 * Depth-first with the dependency emitted before its dependent, so the helper cell is valid
 * Python read top to bottom — a function calling one defined below it is fine at runtime,
 * but a reader scrolling a generated cell should not have to know that.
 */
export function resolveHelpers(names: Iterable<string>): HelperSpec[] {
  const out: HelperSpec[] = []
  const seen = new Set<string>()

  const visit = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    const spec = helpers.get(name)
    if (!spec) throw new Error(`Unknown Python helper "${name}"`)
    for (const dep of spec.needs ?? []) visit(dep)
    out.push(spec)
  }

  for (const name of [...names].sort()) visit(name)
  return out
}
