/**
 * Emitter and helper registries.
 *
 * Keyed by node type, mirroring `core/registry.ts` — and deliberately separate from it, so
 * a build that never imports the exporter carries none of this.
 */

import type { Emitter, HelperSpec } from './types'
import type { ParamValues } from '../../core/node'

/**
 * Which dataset backends an emitter's code is actually written against.
 *
 * Default `neuprint`, because that is what every emitter here was until caveclient arrived, and
 * because the *safe* default is the narrow one: a new emitter that forgets to declare a backend
 * refuses a dataset it has not been tested against rather than emitting neuprint-python calls
 * against a `CAVEclient`, which is valid Python, plausible reading, and an `AttributeError` at
 * best.
 *
 * Declared here rather than guarded inside each emitter, which is the same call `emit.ts` makes
 * about unwired ports: seventeen emitters take a Dataset, and seventeen hand-written
 * `if (backend !== 'neuprint') return ctx.todo(...)` guards is seventeen chances to forget one —
 * with nothing failing when somebody does.
 */
export interface EmitterOptions {
  /** Source-id families this emitter can be handed, e.g. `['neuprint', 'cave']`. */
  backends?: readonly string[]
}

const NEUPRINT_ONLY: readonly string[] = ['neuprint']

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
  emitterBackendsByType.set(type, options.backends ?? NEUPRINT_ONLY)
}

export function getEmitter(type: string): Emitter | undefined {
  return emitters.get(type)
}

/** The backends this type's emitter declared, or neuPrint where it declared none. */
export function emitterBackends(type: string): readonly string[] {
  return emitterBackendsByType.get(type) ?? NEUPRINT_ONLY
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
