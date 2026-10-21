/**
 * Emitter and helper registries.
 *
 * Keyed by node type, mirroring `core/registry.ts` — and deliberately separate from it, so
 * a build that never imports the exporter carries none of this.
 */

import type { Emitter, HelperSpec } from './types'
import type { ParamValues } from '../../core/node'
import type { EmitterOptions } from '../backends'
import { DEFAULT_BACKENDS } from '../backends'
import { helperClosure } from '../trimHelpers'

const emitters = new Map<string, Emitter>()
const emitterBackendsByType = new Map<string, readonly string[]>()
const helpers = new Map<string, HelperSpec>()

export function registerEmitter<P extends ParamValues>(
  type: string,
  emit: Emitter<P>,
  options: EmitterOptions = {},
): void {
  if (emitters.has(type)) {
    throw new Error(`Duplicate Python emitter for node type "${type}"`)
  }
  emitters.set(type, emit as Emitter)
  emitterBackendsByType.set(type, options.backends ?? DEFAULT_BACKENDS)
}

export function getEmitter(type: string): Emitter | undefined {
  return emitters.get(type)
}

/** The backends this type's emitter declared, or neuPrint where it declared none. */
export function emitterBackends(type: string): readonly string[] {
  return emitterBackendsByType.get(type) ?? DEFAULT_BACKENDS
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

/** A helper's transitive closure, dependency first: `helperClosure`'s walk over this registry. */
export function resolveHelpers(names: Iterable<string>): HelperSpec[] {
  return helperClosure(helpers, names, 'Python')
}

/** Every registered helper, for `assembleHelpers`. */
export function helperRegistry(): ReadonlyMap<string, HelperSpec> {
  return helpers
}
