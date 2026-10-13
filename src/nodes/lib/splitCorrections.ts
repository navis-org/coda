/**
 * Hand corrections to an axon/dendrite split: what one is, how it is stored, and how it is applied.
 *
 * A correction is **a subtree reassigned**: everything distal of a node (or everything else — its
 * proximal side) becomes axon, dendrite or linker. Your splitter's skeleton mode, and the one
 * gesture the editor offers. It labels *nodes*; the synapse column, Summary and the segregation
 * index all read node labels, so a correction reaches every output and no synapse can come to
 * disagree with its own skeleton — the deliberate departure from the splitter's synapse mode.
 *
 * Three rules, each the answer to a way this goes quietly wrong:
 *
 * - **Anchored by position, not by node index.** An index does not survive a re-fetch, a heal or
 *   another skeleton route; a position in nanometres does. At apply time each anchor snaps to the
 *   nearest node of its neuron within `SNAP_NM`, and one that lands nowhere is **stale**: counted
 *   and kept, never applied to whatever node happens to be closest.
 * - **Distal from the root it was made against, which it carries.** The same click is a different
 *   subtree from a different root, and the editor can re-root — so each correction records its
 *   root's position, snapped like its anchor, and is re-applied from that root whatever the editor
 *   is drawn from now. One without a root (stored before re-rooting existed) is measured from the
 *   default, the soma where labelled.
 * - **Absolute, so they compose with the thresholds.** "This subtree is axon" means the same after
 *   a threshold moves, so corrections are re-applied on top of whatever the automatic split now
 *   says — where the splitter discards them on a new ratio. Applied in order; a later one wins.
 *
 * Headless and pure: the node applies these after a memoised automatic split, so an edit is a
 * TypeScript pass over the labels rather than another trip through Python.
 *
 * The stroke half — reading (`readStrokes`), the scope words and painting (`paintSubtrees`) — is
 * shared with a compartment model's painted regions (`packs/biophys/regions.ts`).
 */

import { CODE_AXON, CODE_DENDRITE, CODE_LINKER, perGeometry } from '../../core/values'
import type { SkeletonGeometry } from '../../core/values'
import type { Arbor } from './arborOps'
import { buildArbor, resolveRoot } from './arborOps'
import { nearestNode } from '../../data/soma'
import { SNAP_NM, isPoint } from './anchors'

/** The param the node stores them in, spelled once for the node and the editor. */
export const CORRECTIONS_PARAM = 'corrections'

/** Which side of the picked node is reassigned — away from the root, or everything else. */
export const CORRECTION_SCOPES = ['distal', 'proximal'] as const

/** A scope as a menu and a list say it — both editors that paint subtrees. */
export const SCOPE_WORDS: Readonly<Record<CorrectionScope, string>> = {
  distal: 'Away from the root',
  proximal: 'Everything else',
}
export type CorrectionScope = (typeof CORRECTION_SCOPES)[number]

/** What a reassigned subtree becomes, in the order the editor offers them. */
export const CORRECTION_TARGETS = ['axon', 'dendrite', 'linker'] as const
export type CorrectionTarget = (typeof CORRECTION_TARGETS)[number]

export interface SplitCorrection {
  /** The neuron, as text (invariant 8) — the skeleton's `id`. */
  readonly neuron: string
  /** Where the picked node was, in the skeleton's nanometres. */
  readonly at: readonly [number, number, number]
  readonly scope: CorrectionScope
  readonly to: CorrectionTarget
  /**
   * Where the root was when the correction was made, in nanometres — what "distal" was measured
   * from. Absent means the default root (`splitArbor` with none given).
   */
  readonly root?: readonly [number, number, number]
}

const CODE: Readonly<Record<CorrectionTarget, number>> = {
  axon: CODE_AXON,
  dendrite: CODE_DENDRITE,
  linker: CODE_LINKER,
}

/** One stored entry. JSON in an `ids` param, the Heatmap selection's and `renames.ts`' shape. */
export function writeCorrection(correction: SplitCorrection): string {
  return JSON.stringify(correction)
}

/**
 * The stored list, with anything malformed dropped — a hand-edited file is the other way an entry
 * arrives, and one that cannot be read cannot be applied either. Silent, `validDashboard`'s rule.
 */
export function readCorrections(raw: unknown): SplitCorrection[] {
  return readStrokes(raw, (stroke, fields) => {
    const { to } = fields as Partial<SplitCorrection>
    return to && CORRECTION_TARGETS.includes(to) ? { ...stroke, to } : undefined
  })
}

/** What every stored subtree stroke has: whose, where, which side, and from what root. */
export type StoredStroke = Omit<SplitCorrection, 'to'>

/**
 * A list of strokes stored as one JSON object per entry — split corrections, a compartment model's
 * painted regions — with anything malformed dropped: the shared fields checked here, the caller's
 * own by `rest`, which answers undefined to drop the entry.
 */
export function readStrokes<T>(
  raw: unknown,
  rest: (stroke: StoredStroke, fields: Record<string, unknown>) => T | undefined,
): T[] {
  if (!Array.isArray(raw)) return []
  const out: T[] = []
  for (const entry of raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(entry))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    // Typed as what it should be, then every field checked as though it were not.
    const fields = parsed as Record<string, unknown>
    const { neuron, at, scope, root } = fields as Partial<StoredStroke>
    if (typeof neuron !== 'string' || !neuron) continue
    if (!isPoint(at) || (root !== undefined && !isPoint(root))) continue
    if (!scope || !CORRECTION_SCOPES.includes(scope)) continue
    const stroke: StoredStroke = {
      neuron,
      at: [at[0], at[1], at[2]],
      scope,
      ...(root ? { root: [root[0], root[1], root[2]] as const } : {}),
    }
    const item = rest(stroke, fields)
    if (item !== undefined) out.push(item)
  }
  return out
}

const arbors = perGeometry(() => new Map<number, Arbor>())

/**
 * The tree corrections are measured over, rooted at `root` — or, given none, at the soma where the
 * source labels one and the delivered root otherwise: the Neuron Dendrogram's default.
 *
 * The node and the editor both ask, and on every correction: a `cheap` node re-runs on each edit,
 * and the editor redraws on each new output. So it is cached per geometry (`perGeometry`, which
 * says why the key is the arrays) and then on the resolved root node. The default is resolved
 * afresh each time (one pass, cheap beside a build), so a relabelled soma over the same arrays is a
 * different key rather than a tree rooted on the old one.
 *
 * It walks the parents it is handed, so a forest reaches only the fragment holding the root: a
 * neuron healed to be split is handed over healed (`arborHeal.ts`) by both callers.
 */
export function splitArbor(skeleton: SkeletonGeometry, root?: number): Arbor {
  const at = root ?? resolveRoot(skeleton, 'soma').node
  const byRoot = arbors(skeleton)
  let arbor = byRoot.get(at)
  if (!arbor) byRoot.set(at, (arbor = buildArbor(skeleton, at)))
  return arbor
}

/**
 * `node` and everything distal of it labelled `code` — what "distal" means for a correction and for
 * a split by tag alike. A subtree is one contiguous run of the pre-order, `tin`/`tout`'s whole
 * purpose. A node the walk never reached is left alone.
 */
export function fillDistal(
  arbor: Arbor,
  node: number,
  code: number,
  out: { [node: number]: number },
): void {
  const from = arbor.tin[node]!
  if (from >= 0) fillRun(arbor, from, arbor.tout[node]!, code, out)
}

function fillRun(
  arbor: Arbor,
  from: number,
  to: number,
  code: number,
  out: { [node: number]: number },
): void {
  for (let k = from; k < to; k++) out[arbor.order[k]!] = code
}

/** The nearest node to a point within `SNAP_NM`, or -1. */
export function snapToNode(skeleton: SkeletonGeometry, at: readonly number[]): number {
  return nearestNode(skeleton.positions, at, SNAP_NM)
}

/** A subtree to paint: everything distal of `at` (or everything else), from `root`, as `code`. */
interface SubtreeStroke {
  readonly at: readonly number[]
  readonly scope: CorrectionScope
  /** What "distal" was measured from; absent is `splitArbor`'s default root. */
  readonly root?: readonly number[] | undefined
  readonly code: number
}

/**
 * Paint strokes onto per-node labels, in order, a later one over an earlier — a split's
 * corrections and a compartment model's painted regions alike. Each anchor and root snaps to a
 * node within `SNAP_NM`; a stroke that cannot be placed (no node there, or one the walk from its
 * root never reaches, where "distal" has no meaning) is skipped and not counted in the return,
 * which is what a caller's stale count is the rest of.
 */
export function paintSubtrees(
  skeleton: SkeletonGeometry,
  out: { [node: number]: number },
  strokes: readonly SubtreeStroke[],
): number {
  let applied = 0
  for (const stroke of strokes) {
    // Its own root, snapped like its anchor; a root that lands nowhere places nothing.
    const root = stroke.root ? snapToNode(skeleton, stroke.root) : undefined
    if (root === -1) continue
    const arbor = splitArbor(skeleton, root)
    const node = snapToNode(skeleton, stroke.at)
    const from = node >= 0 ? arbor.tin[node]! : -1
    if (from < 0) continue
    const to = arbor.tout[node]!
    if (stroke.scope === 'distal') fillDistal(arbor, node, stroke.code, out)
    else {
      // "Everything else" is the two runs of the pre-order either side of the subtree.
      fillRun(arbor, 0, from, stroke.code, out)
      fillRun(arbor, to, arbor.order.length, stroke.code, out)
    }
    applied++
  }
  return applied
}

/**
 * One neuron's labels with its corrections applied, in order (`paintSubtrees`). Returns the
 * labels it was given, untouched, when there is nothing to apply.
 */
export function applyCorrections(
  skeleton: SkeletonGeometry,
  labels: Uint8Array,
  corrections: readonly SplitCorrection[],
): { labels: Uint8Array; applied: number } {
  if (corrections.length === 0) return { labels, applied: 0 }
  const out = labels.slice()
  const applied = paintSubtrees(
    skeleton,
    out,
    corrections.map((c) => ({ at: c.at, scope: c.scope, root: c.root, code: CODE[c.to] })),
  )
  return { labels: out, applied }
}
