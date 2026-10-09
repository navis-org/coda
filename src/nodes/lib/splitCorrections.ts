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
 */

import { CODE_AXON, CODE_DENDRITE, CODE_LINKER, perGeometry } from '../../core/values'
import type { SkeletonGeometry } from '../../core/values'
import type { Arbor } from './arborOps'
import { buildArbor, resolveRoot } from './arborOps'

/** The param the node stores them in, spelled once for the node and the editor. */
export const CORRECTIONS_PARAM = 'corrections'

/** Which side of the picked node is reassigned — away from the root, or everything else. */
export const CORRECTION_SCOPES = ['distal', 'proximal'] as const
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

/**
 * How far an anchor may be from its node and still be that node, in nanometres.
 *
 * Re-fetching the same reconstruction gives the same positions, so the slack is for a different
 * route to the same neuron, which re-samples the cable. 2 µm is a few node spacings of a traced
 * skeleton and well inside the gap between two neurites that run apart — past it an anchor is
 * more likely on the wrong branch than a moved copy of the right one.
 */
export const SNAP_NM = 2000

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
  if (!Array.isArray(raw)) return []
  const out: SplitCorrection[] = []
  for (const entry of raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(entry))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    // Typed as what it should be, then every field checked as though it were not.
    const { neuron, at, scope, to, root } = parsed as SplitCorrection
    if (typeof neuron !== 'string' || !neuron) continue
    if (!isPoint(at) || (root !== undefined && !isPoint(root))) continue
    if (!CORRECTION_SCOPES.includes(scope) || !CORRECTION_TARGETS.includes(to)) continue
    out.push({
      neuron,
      at: [at[0], at[1], at[2]],
      scope,
      to,
      ...(root ? { root: [root[0], root[1], root[2]] as const } : {}),
    })
  }
  return out
}

/** Three finite numbers. */
function isPoint(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
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
 * One known limit: built without heal bridges, so with `Heal fragmented skeletons` on, a correction
 * reaches only the fragment holding its own root; one anchored on another fragment is stale.
 */
export function splitArbor(skeleton: SkeletonGeometry, root?: number): Arbor {
  const at = root ?? resolveRoot(skeleton, 'soma').node
  const byRoot = arbors(skeleton)
  let arbor = byRoot.get(at)
  if (!arbor) byRoot.set(at, (arbor = buildArbor(skeleton, at)))
  return arbor
}

/** The nearest node to a point within `SNAP_NM`, or -1. */
export function snapToNode(skeleton: SkeletonGeometry, at: readonly number[]): number {
  const p = skeleton.positions
  let best = -1
  let bestD = SNAP_NM * SNAP_NM
  for (let i = 0; i < skeleton.parents.length; i++) {
    const dx = p[i * 3]! - at[0]!
    const dy = p[i * 3 + 1]! - at[1]!
    const dz = p[i * 3 + 2]! - at[2]!
    const d = dx * dx + dy * dy + dz * dz
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * One neuron's labels with its corrections applied, in order.
 *
 * Returns the labels it was given, untouched, when there is nothing to apply. A correction that
 * cannot be placed — no node within `SNAP_NM`, or a node the walk from the root never reaches
 * (another fragment of an unhealed forest), where "distal" has no meaning — is skipped and not
 * counted in `applied`, which is what the caller's stale count is the rest of.
 */
export function applyCorrections(
  skeleton: SkeletonGeometry,
  labels: Uint8Array,
  corrections: readonly SplitCorrection[],
): { labels: Uint8Array; applied: number } {
  if (corrections.length === 0) return { labels, applied: 0 }
  const out = labels.slice()
  let applied = 0
  for (const correction of corrections) {
    // Its own root, snapped like its anchor; a root that lands nowhere places nothing.
    const root = correction.root ? snapToNode(skeleton, correction.root) : undefined
    if (root === -1) continue
    const arbor = splitArbor(skeleton, root)
    const node = snapToNode(skeleton, correction.at)
    const from = node >= 0 ? arbor.tin[node]! : -1
    if (from < 0) continue
    const to = arbor.tout[node]!
    const code = CODE[correction.to]
    // The subtree is one contiguous run of the pre-order — `tin`/`tout`'s whole purpose — so
    // "everything else" is the two runs either side of it.
    const set = (a: number, b: number) => {
      for (let k = a; k < b; k++) out[arbor.order[k]!] = code
    }
    if (correction.scope === 'distal') set(from, to)
    else {
      set(0, from)
      set(to, arbor.order.length)
    }
    applied++
  }
  return { labels: out, applied }
}
