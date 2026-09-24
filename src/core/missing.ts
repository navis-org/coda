/**
 * The placeholder a node this build does not have loads as.
 *
 * `deserializeGraph` used to drop an unknown type with a warning, which lost work in silence the
 * moment anybody saved: open a file made with a newer build (or, once they exist, a pack this
 * build lacks), save it, and those cards and every wire into them were gone from the file. So an
 * unknown node now loads as a `core.missing` card that holds what the file said — its type, its
 * params and the ports its wires named — and every writer spells it back as the original.
 *
 * ## Why a registered placeholder rather than the original type left in place
 *
 * Over a hundred call sites ask `getNodeDef(node.type)`, and a node whose type answers `undefined`
 * would have to be handled correctly at every one of them. A placeholder that *is* a definition
 * needs no site to know about it: inference, the scheduler, the card, the inspector and the layout
 * all see an ordinary node with some ports and no params. What knows is small and named — the two
 * writers (`serializeGraph` and the clipboard's `fragmentBody`, through `documentNode`) and the
 * Zoo's `layoutDigest`, `ports.ts` (its ports come from its params), and — through
 * `unknownTypeOf` — inference (its error) and the two exporters (its comment).
 *
 * It is **not in the registry's list** (`getNodeDef` answers for it, `allNodeDefs` does not), so
 * the palette, the node guide, the assistant's catalogue and every registry sweep never meet it.
 *
 * ## Everything is in `params`, on purpose
 *
 * `params` is the one part of a node every path already carries — duplicate, paste, undo, a
 * workflow switch — so the placeholder cannot lose what it holds to a copy that rebuilds a node
 * field by field. The original params are kept as **JSON text** rather than spread in: they were
 * written by a build this one has never seen, so nothing here may assume they are `ParamValues`,
 * and a reserved key spread beside them is a key some future param could spell.
 *
 * Self-contained is also the fallback: a writer that forgot `documentNode` saves a `core.missing`
 * node, and `deserializeGraph` restores that to its original before anything else — so the
 * mistake costs a file that is uglier, never one that has lost the node.
 */

import type { NodeDefinition, ParamValues, ResolvedPort } from './node'
import { packOf } from './nodeType'
import { T } from './types'

export const MISSING_TYPE = 'core.missing'

/** A node's stored spelling, as far as the placeholder needs it: the parts nothing here can use. */
interface StoredNode {
  type: string
  params?: unknown
  captionOf?: string
}

/**
 * The placeholder's params for a stored node, with the port ids its wires name.
 *
 * `inputs` and `outputs` are the handles the file's edges use, in the order they first appear —
 * a placeholder has no declaration to read its ports from, so the wires are the declaration.
 */
export function placeholderParams(
  stored: StoredNode,
  inputs: readonly string[],
  outputs: readonly string[],
): ParamValues {
  const kept = {
    params: stored.params && typeof stored.params === 'object' ? stored.params : {},
    ...(typeof stored.captionOf === 'string' ? { captionOf: stored.captionOf } : {}),
  }
  return {
    type: stored.type,
    stored: JSON.stringify(kept),
    inputs: [...inputs],
    outputs: [...outputs],
  }
}

/** The type a placeholder stands in for, or undefined when the node is not one. */
export function missingTypeOf(node: { type: string; params?: unknown }): string | undefined {
  if (node.type !== MISSING_TYPE) return undefined
  const type = (node.params as Record<string, unknown> | undefined)?.['type']
  return typeof type === 'string' ? type : undefined
}

/**
 * The type a node has that this build cannot run: a placeholder's original, or a type nothing
 * registered. Undefined for every node that can run. The one question inference and both
 * exporters ask, so an unregistered type and a placeholder of one read the same everywhere.
 */
export function unknownTypeOf(
  node: { type: string; params?: unknown },
  def: NodeDefinition | undefined,
): string | undefined {
  if (!def) return node.type
  // A placeholder whose stored type was lost still cannot run: it names itself, rather than
  // passing for an ordinary node and failing in `evaluate` about a type called "undefined".
  return node.type === MISSING_TYPE ? (missingTypeOf(node) ?? MISSING_TYPE) : undefined
}

/**
 * A node as a document spells it: a placeholder turned back into the node it stands in for, and
 * anything else returned **by identity**.
 *
 * What the card lets somebody change on a placeholder — position, title, size, hints, collapsing,
 * muting — is read off the live node; the type, the params and a caption's target come from what
 * was stored. A placeholder whose stored text will not parse stays a placeholder, which still
 * loads: see the module note.
 */
export function documentNode<N extends { type: string; params?: unknown; captionOf?: string }>(
  node: N,
): N {
  const type = missingTypeOf(node)
  if (type === undefined) return node
  const text = (node.params as Record<string, unknown>)['stored']
  let kept: { params?: unknown; captionOf?: unknown }
  try {
    kept = typeof text === 'string' ? (JSON.parse(text) as typeof kept) : {}
  } catch {
    return node
  }
  const { captionOf: _captionOf, ...rest } = node
  return {
    ...rest,
    type,
    params: kept.params && typeof kept.params === 'object' ? kept.params : {},
    ...(typeof kept.captionOf === 'string' ? { captionOf: kept.captionOf } : {}),
  } as unknown as N
}

/** What the card, the run and the exporters say about a node this build does not have. */
export function missingMessage(type: string): string {
  const pack = packOf(type)
  const what = pack
    ? `"${type}" from the ${pack} pack, which this build of Coda does not have`
    : `"${type}", a node this build of Coda does not have`
  return `This workflow uses ${what}. Its settings and wires are kept and saved with the workflow.`
}

const NONE: readonly ResolvedPort[] = []

/*
 * Keyed by the id array itself, so a node's port list keeps its identity for as long as its params
 * do. The card and the selectors that read a node's ports re-run on every store publish, and a
 * fresh array each time is a new snapshot each time (invariant 7).
 */
const portLists = new WeakMap<readonly unknown[], readonly ResolvedPort[]>()

/**
 * A placeholder's ports on one side, from its params.
 *
 * `any` on both sides and never required: nothing can say what the node took or made, and a
 * placeholder never runs, so the socket only has to hold the wire.
 */
export function missingPorts(
  params: ParamValues,
  side: 'inputs' | 'outputs',
): readonly ResolvedPort[] {
  const ids = params[side]
  if (!Array.isArray(ids) || ids.length === 0) return NONE
  let ports = portLists.get(ids)
  if (!ports) {
    // A hand-edited file can put anything in the list; only a string names a port.
    ports = ids.flatMap((id): ResolvedPort[] =>
      typeof id === 'string'
        ? [
            {
              id,
              type: T.any(),
              anyKind: true,
              ...(side === 'inputs' ? { required: false } : {}),
            },
          ]
        : [],
    )
    portLists.set(ids, ports)
  }
  return ports
}

export const missingNodeDef: NodeDefinition = {
  type: MISSING_TYPE,
  label: 'Missing Node',
  category: 'utility',
  description: 'A node this build does not have, kept so the workflow saves back whole.',
  // Never offered, and never reached: inference reports it as an error, which blocks the run. The
  // cost only has to make sure nothing would schedule it automatically if that ever changed.
  cost: 'expensive',
  hidden: true,
  evaluate(ctx) {
    throw new Error(missingMessage(String(ctx.params['type'])))
  },
}
