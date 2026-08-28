/**
 * A node's ports, after its port groups have been expanded.
 *
 * `NodeDefinition.inputs` and `.outputs` are lists of *slots*, and a slot may be a
 * `PortGroupDef` — a run of ports repeated as many times as one of the node's params says. This
 * module is the one place that turns slots into ports, and every consumer goes through it.
 *
 * ## Three readings, three names, and no optional argument
 *
 * The expansion is asked for from three layers that cannot all see each other, and each holds a
 * *different amount* of the node:
 *
 * - **`inputPorts(def, params)`** — inference, the scheduler, the card, the inspector, both
 *   exporters. These have a `GraphNode` and want the ports that node actually has.
 * - **`defaultInputPorts(def)`** — the palette, the node browser, the thumbnail, the node guide,
 *   the help figures. These describe a *type*, not an instance, and want the shape a fresh one
 *   opens at.
 * - **`allInputPorts(def)`** — `isReferencePort` during a link drag, `typesWithReferenceInputs`
 *   scanning the registry, the exporter's port audit. These are asked about a port id with no
 *   node in hand at all; expanding at `max` covers every id the node could ever have, and an id
 *   that is not in there cannot exist at any arity.
 *
 * `params` is **required** on the first pair, and the second pair has its own name rather than
 * being that call with the argument left off. An optional argument is how the first and second
 * readings quietly become one call: a caller holding a node omits `node.params`, type-checks,
 * runs, and is wrong only above the default arity — which is to say, wrong exactly where the
 * feature exists. That is not hypothetical. `help/figures.ts` types its params as
 * `Record<string, string>`, which is assignable to `ParamValues`, so a figure declaring a count
 * would have drawn the default number of sockets while looking arity-aware.
 *
 * ## The per-definition cache
 *
 * A `NodeDefinition` is frozen once `registerNode` returns, so "has this any groups?" and "what
 * is every port at max?" are constants. They were being recomputed per call on paths the
 * codebase has already measured and optimised: `inferGraph` walks every node twice per keystroke,
 * and `isReferencePort` runs once per *edge* per pointer move of a link drag. Memoised in a
 * `WeakMap` keyed by the definition object, which needs no invalidation because a definition is
 * never re-registered — the same reasoning as `typesWithReferenceInputs`, one layer down.
 *
 * The cache also holds each group's range and default, resolved once, so the count is arithmetic
 * rather than a linear scan of the node's params on every expansion.
 *
 * ## The identity fast path is load-bearing
 *
 * Almost every node in the registry has no groups at all, so for those this returns **the
 * definition's own array**, allocating nothing — the same trick `dependencyEdges` in `graph.ts`
 * plays for the same measured reason. Anything that mutated a returned array would be mutating
 * the registry, hence `readonly` throughout.
 */

import type {
  NodeDefinition,
  ParamValues,
  PortDef,
  PortGroupDef,
  PortSlot,
  ResolvedPort,
} from './node'

const NONE: readonly ResolvedPort[] = []

/**
 * Whether a slot is a repeated group rather than a single port.
 *
 * Here rather than beside `PortGroupDef` in `node.ts` so that the import between the two files
 * runs one way at runtime: `node.ts` value-imports this module (its contexts hand nodes their
 * own resolved ports), and this module takes only *types* back. An `isPortGroup` living in
 * `node.ts` would have made that a real cycle.
 */
export function isPortGroup(slot: PortSlot): slot is PortGroupDef {
  return 'repeat' in slot
}

/** A group's arity bounds and fresh value, read off the `int` param it repeats on. */
export interface RepeatRange {
  min: number
  max: number
  fresh: number
}

interface PortCache {
  hasGroups: boolean
  ranges: ReadonlyMap<string, RepeatRange>
  allInputs: readonly ResolvedPort[]
  allOutputs: readonly ResolvedPort[]
}

const caches = new WeakMap<NodeDefinition, PortCache>()

/**
 * A group's range, from the `int` param it names.
 *
 * **Declared once, not twice.** `PortGroupDef` used to carry its own `min`/`max` beside the
 * param's, which meant the spinner in the inspector and the expander here read two independently
 * written pairs of numbers with nothing forcing them to agree. `registerNode` refuses a group
 * whose param does not declare both, so by the time anything is expanded these are real.
 *
 * The fallback is for the window before that check has run — `checkPortGroups` itself expands at
 * max to find id collisions — and never survives into a registered definition.
 */
function rangeOf(def: NodeDefinition, repeat: string): RepeatRange {
  const param = def.params?.find((p) => p.id === repeat)
  if (!param || param.kind !== 'int') return { min: 1, max: 1, fresh: 1 }
  const min = typeof param.min === 'number' ? param.min : 1
  const max = typeof param.max === 'number' ? param.max : min
  const fresh = typeof param.default === 'number' ? param.default : min
  return { min, max, fresh }
}

function cacheOf(def: NodeDefinition): PortCache {
  const held = caches.get(def)
  if (held) return held

  const ranges = new Map<string, RepeatRange>()
  for (const slot of [...(def.inputs ?? []), ...(def.outputs ?? [])]) {
    if (isPortGroup(slot) && !ranges.has(slot.repeat)) {
      ranges.set(slot.repeat, rangeOf(def, slot.repeat))
    }
  }
  const cache: PortCache = {
    hasGroups: ranges.size > 0,
    ranges,
    allInputs: expand(def.inputs, ranges, () => undefined),
    allOutputs: expand(def.outputs, ranges, () => undefined),
  }
  caches.set(def, cache)
  return cache
}

/**
 * The id and label one template gets at index `i`.
 *
 * The index is appended to the id and **substituted** into the label where the label says `{n}`,
 * appended otherwise. Appending unconditionally would give "Dataset 1" for `Dataset` and
 * "Labels for dataset 1" only if the author happened to write the label backwards; substitution
 * is what lets a group say `Edges ({n})` or `Labels for dataset {n}` and read properly.
 *
 * A label with no index at all is not offered as an option. Four ports all captioned "Dataset"
 * is a card nobody can wire correctly, and the one time that was the intent — a single-repeat
 * group — the index is 1 and reads fine.
 */
function expandPort(template: PortDef, repeat: string, index: number): ResolvedPort {
  const base = template.label ?? template.id
  return {
    ...template,
    id: `${template.id}${index}`,
    label: base.includes('{n}') ? base.replaceAll('{n}', String(index)) : `${base} ${index}`,
    group: { repeat, index },
  }
}

/**
 * The one expansion. `countOf` is the whole of what separates the three readings above —
 * returning `undefined` means "every port this group could have", i.e. its max. Everything else
 * (the empty case, the identity fast path, the ordering) is shared, which is the point.
 */
function expand(
  slots: readonly PortSlot[] | undefined,
  ranges: ReadonlyMap<string, RepeatRange>,
  countOf: (range: RepeatRange, repeat: string) => number | undefined,
): readonly ResolvedPort[] {
  if (!slots || slots.length === 0) return NONE
  if (!slots.some(isPortGroup)) return slots as readonly ResolvedPort[]

  const ports: ResolvedPort[] = []
  for (const slot of slots) {
    if (!isPortGroup(slot)) {
      ports.push(slot)
      continue
    }
    const range = ranges.get(slot.repeat) ?? { min: 1, max: 1, fresh: 1 }
    const count = countOf(range, slot.repeat) ?? range.max
    // Index-major, so a group repeating a tuple keeps its members adjacent: edges1, labels1,
    // edges2, labels2 — not edges1, edges2, labels1, labels2. See `PortGroupDef.ports`.
    for (let i = 1; i <= count; i++) {
      for (const template of slot.ports) ports.push(expandPort(template, slot.repeat, i))
    }
  }
  return ports
}

/**
 * How many repeats a group has on a node with these params.
 *
 * Clamped rather than trusted, because the value arrives from a saved file that may have been
 * written by a build with a different range, or edited by hand. Clamping is the same call
 * `validSize` and `validGroups` make in `deserializeGraph`: a document is read leniently and then
 * made to mean something.
 */
function countIn(range: RepeatRange, params: ParamValues, repeat: string): number {
  const raw = params[repeat]
  const value = typeof raw === 'number' ? raw : range.fresh
  if (!Number.isFinite(value)) return range.min
  return Math.min(range.max, Math.max(range.min, Math.floor(value)))
}

function resolve(
  def: NodeDefinition,
  slots: readonly PortSlot[] | undefined,
  params: ParamValues,
): readonly ResolvedPort[] {
  const cache = cacheOf(def)
  if (!cache.hasGroups) return slots && slots.length ? (slots as readonly ResolvedPort[]) : NONE
  return expand(slots, cache.ranges, (range, repeat) => countIn(range, params, repeat))
}

/** A node's input ports at these params. */
export function inputPorts(def: NodeDefinition, params: ParamValues): readonly ResolvedPort[] {
  return resolve(def, def.inputs, params)
}

/** A node's output ports at these params. */
export function outputPorts(def: NodeDefinition, params: ParamValues): readonly ResolvedPort[] {
  return resolve(def, def.outputs, params)
}

/** The input ports a *fresh* node of this type opens at — for surfaces describing a type. */
export function defaultInputPorts(def: NodeDefinition): readonly ResolvedPort[] {
  return expand(def.inputs, cacheOf(def).ranges, (r) => r.fresh)
}

/** `defaultInputPorts` for the other side. */
export function defaultOutputPorts(def: NodeDefinition): readonly ResolvedPort[] {
  return expand(def.outputs, cacheOf(def).ranges, (r) => r.fresh)
}

/**
 * Every input port this type could have at any arity — groups expanded at `max`.
 *
 * For structural questions asked with no node in hand: "is this port id a reference?", "does
 * this type declare a reference input at all?". Never for rendering or for execution, where the
 * answer must be about one node's actual arity.
 */
export function allInputPorts(def: NodeDefinition): readonly ResolvedPort[] {
  return cacheOf(def).allInputs
}

/** `allInputPorts` for the other side. */
export function allOutputPorts(def: NodeDefinition): readonly ResolvedPort[] {
  return cacheOf(def).allOutputs
}

/** One input port by id, or undefined. */
export function findInputPort(
  def: NodeDefinition,
  params: ParamValues,
  portId: string,
): ResolvedPort | undefined {
  return inputPorts(def, params).find((p) => p.id === portId)
}

/**
 * The node's primary output port, without building the whole list to take its head.
 *
 * Three zustand selectors want it — the card's own value, the inspector's, the viewer overlay's
 * — and they re-run on every store publish, which during a run is several times a second per
 * mounted card. A first slot that is a plain port is already the answer; only a node whose very
 * first output is a repeated group pays for an expansion.
 */
export function firstOutputPort(
  def: NodeDefinition,
  params: ParamValues,
): ResolvedPort | undefined {
  const first = def.outputs?.[0]
  if (!first) return undefined
  return isPortGroup(first) ? outputPorts(def, params)[0] : first
}

/**
 * Whether this definition has any variadic ports at all.
 *
 * The guard every caller that only cares about the variadic case should ask first — edge
 * pruning above all, which would otherwise walk the edges of every node on every param change.
 */
export function hasPortGroups(def: NodeDefinition): boolean {
  return cacheOf(def).hasGroups
}
