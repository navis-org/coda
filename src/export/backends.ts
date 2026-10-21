/**
 * Which dataset backend a node's emitter was written against, and what a document says when it is
 * wired to another — the guard both walks apply before calling an emitter.
 *
 * Shared rather than copied with the walks: none of it holds a language, only the rule, and the
 * rule is the one both documents must agree on. Each walk passes the backends its own registry
 * declared and the noun for one of its steps.
 */

import type { NodeDefinition, ParamValues } from '../core/node'
import { listed } from '../core/prose'
import { inputPorts } from '../core/ports'
import type { CodaType } from '../core/types'
import { datasetRef } from '../core/types'
import { backendOf } from '../data/source'
import { backendName } from '../nodes/lib/datasetFamilies'

/**
 * Which dataset backends an emitter's code is actually written against.
 *
 * Default `neuprint` (`DEFAULT_BACKENDS`), because that is what every emitter was until caveclient
 * arrived, and because the *safe* default is the narrow one: a new emitter that forgets to declare
 * a backend refuses a dataset it has not been tested against rather than emitting neuprint calls
 * against another client — valid code, plausible reading, and an error at the reader's console at
 * best.
 *
 * Declared at the registration rather than guarded inside each emitter, which is the same call
 * the walks make about unwired ports: a hand-written `if (backend !== 'neuprint')` per emitter is
 * one chance per emitter to forget one, with nothing failing when somebody does.
 */
export interface EmitterOptions {
  /** Source-id families this emitter can be handed, e.g. `['neuprint', 'cave']`. */
  backends?: readonly string[]
}

export const DEFAULT_BACKENDS: readonly string[] = ['neuprint']

/**
 * The backend of a resolved dataset type, or undefined while it is unresolved — which is the
 * ordinary state before a listing lands (invariant 2), and refuses nothing.
 */
export function datasetBackendOf(type: CodaType | undefined): string | undefined {
  const sourceId = datasetRef(type)?.sourceId
  return sourceId ? backendOf(sourceId) : undefined
}

/**
 * The backend of the dataset on an emitter's input port, or `''` while it is unresolved — one
 * function for both languages' emitters, since either context answers `inputType`. An emitter
 * branching on this and the walk's guard read the same thing, so they cannot disagree.
 */
export function datasetBackend(
  ctx: { inputType(portId: string): CodaType | undefined },
  portId = 'dataset',
): string {
  return datasetBackendOf(ctx.inputType(portId)) ?? ''
}

/**
 * A dataset backend this node's emitter was not written against, or undefined.
 *
 * Read off `def.inputs` rather than by asking for a port called `dataset`, which is the bug class
 * `ports.test.ts` exists for. Every dataset-shaped port is checked, reference ports included.
 */
export function unsupportedBackend(
  def: NodeDefinition,
  params: ParamValues,
  inputTypes: Readonly<Record<string, CodaType | undefined>>,
  supported: readonly string[],
): string | undefined {
  for (const port of inputPorts(def, params)) {
    if (port.type.kind !== 'dataset') continue
    const backend = datasetBackendOf(inputTypes[port.id])
    if (backend && !supported.includes(backend)) return backend
  }
  return undefined
}

/**
 * What a document says about a node wired to a backend its step was not written for: a graph
 * perfectly well wired, so said apart from an unwired or blocked one, or the reader is sent to
 * the canvas to check a wire that is already there. `step` is the document's noun for one —
 * "notebook cell", "R chunk".
 */
export function unsupportedBackendText(
  label: string,
  backend: string,
  supported: readonly string[],
  step: string,
): { warning: string; todo: string } {
  const named = backendName(backend)
  return {
    warning: `${label} has no ${named} equivalent yet.`,
    todo:
      `"${label}" is wired to a ${named} dataset, but its ${step} has only been written for ` +
      `${listed(supported.map(backendName))}. The dataset is bound above, so fill this step in ` +
      `by hand.`,
  }
}
